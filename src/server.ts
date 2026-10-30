import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { arrStatus } from './arr-setup.ts';
import { EDITABLE_SETTINGS, SECRET_SETTING, env, loadConfig, readSettings, settingSource, writeSettings } from './config.ts';
import { PROVIDER_IDS } from './providers/ids.ts';
import { releaseTitle } from './providers/common.ts';
import { Indexer, xml } from './indexer.ts';
import { QBittorrent, sessionId, type QBittorrentResponse } from './qbittorrent.ts';
import { SeriesBindings } from './series-binding.ts';
import { decideImport } from './publisher.ts';
import type { ImportEvent, Publisher } from './publisher.ts';
import type { Queue } from './queue.ts';
import type { Store } from './store.ts';
import type { Config, Provider } from './types.ts';

export async function createServer(config: Config, store: Store, queue: Queue, providers: Map<string, Provider>, publisher?: Publisher) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1, fields: 20 } });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  const indexer = new Indexer(config, store, providers, new SeriesBindings(store.database));
  const qbittorrent = new QBittorrent(config, queue, indexer);
  const session = sessionId(config);
  // The web UI's static files hold no secrets; it calls /v1/* with the API key.
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../web/dist', import.meta.url)), prefix: '/ui/' });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/api/v2/auth/login' || path === '/') return;
    if (request.routeOptions.url?.startsWith('/ui/')) return;
    if (path?.startsWith('/api/v2/')) {
      // qBittorrent clients authenticate with a session cookie or, in newer versions, a bearer API key.
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
      const cookie = /(?:^|;\s*)SID=([^;]*)/.exec(request.headers.cookie || '')?.[1];
      if (!(bearer !== undefined && matches(bearer, config.apiKey)) && !(cookie !== undefined && matches(cookie, session))) {
        await reply.code(403).type('text/plain; charset=utf-8').send('Forbidden');
      }
      return;
    }
    const query = request.query as Record<string, unknown>;
    const provided = query.apikey ?? request.headers['x-api-key'];
    if (!matches(typeof provided === 'string' ? provided : '', config.apiKey)) {
      await reply.code(401).send({ status: false, error: 'Invalid API key' });
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/', async (_request, reply) => reply.redirect('/ui/'));
  app.get('/v1/settings', async () => ({
    publicUrl: config.publicUrl,
    categories: config.categories,
    providerIds: PROVIDER_IDS,
    enabled: [...providers.keys()],
    vltava: Boolean(config.vltava),
    arrs: Object.fromEntries(arrStatus),
    settings: Object.fromEntries(
      EDITABLE_SETTINGS.map(name => {
        const value = env(name);
        return [name, { value: SECRET_SETTING.test(name) ? undefined : value, set: value !== undefined, source: settingSource(name) }];
      }),
    ),
  }));
  // The UI controls Jobs through the qBittorrent API; this adds what that API cannot carry, such as the failure reason.
  app.get('/v1/jobs', async () =>
    store.jobs().map(job => ({
      id: job.id,
      title: releaseTitle(job.release),
      provider: job.release.provider,
      category: job.category,
      status: job.status,
      progress: job.progress,
      bytes: job.bytes,
      totalBytes: job.totalBytes,
      error: job.error,
      createdAt: job.createdAt,
    })),
  );
  // Saved settings apply at the next start; a set that would stop Bohemarr from starting is refused.
  app.put('/v1/settings', async (request, reply) => {
    const changes = request.body;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return reply.code(400).send({ error: 'Expected an object' });
    const next = await readSettings(config.dataDir);
    for (const [name, value] of Object.entries(changes)) {
      if (!EDITABLE_SETTINGS.includes(name)) return reply.code(400).send({ error: `${name} cannot be set here` });
      if (value !== null && typeof value !== 'string') return reply.code(400).send({ error: `${name} must be a string` });
      if (value) next[name] = value.trim();
      else delete next[name];
    }
    try {
      await loadConfig(next);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    await writeSettings(config.dataDir, next);
    return { saved: true };
  });
  // Docker's restart policy starts Bohemarr again with the saved settings.
  app.post('/v1/restart', async (_request, reply) => {
    reply.raw.once('finish', () => process.kill(process.pid, 'SIGTERM'));
    return { restarting: true };
  });
  app.get('/v1/providers', async () => [...providers.values()].map(provider => ({ id: provider.id, name: provider.name })));
  // Manual search in the UI: a Torznab query, answered as JSON.
  app.get('/v1/search', async (request, reply) => {
    const params = stringParams(request.query);
    try {
      const { page, total } = await whileOpen(reply, signal => indexer.find({ ...params, t: params.t || 'search' }, signal));
      return {
        total,
        releases: page.map(release => ({
          id: release.id,
          title: releaseTitle(release),
          provider: release.provider,
          kind: release.kind,
          url: release.url,
          publishedAt: release.publishedAt,
          size: release.size,
          sizeEstimated: release.sizeEstimated,
          height: release.height,
        })),
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // Downloads a Release found by a search, as a Job with the ID Sonarr's or Radarr's grab of it would have.
  app.post('/v1/jobs', async (request, reply) => {
    const { release: id = '', category } = stringParams(request.body);
    const release = store.release(id);
    if (!release) return reply.code(404).send({ error: 'Unknown release; search again' });
    try {
      const job = queue.add(indexer.taskDescriptor(id).infoHash, release, category || (release.kind === 'movie' ? 'movies' : 'tv'));
      return { id: job.id, status: job.status };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api', async (request, reply) => {
    const params = stringParams(request.query);
    reply.type('application/xml; charset=utf-8');
    try {
      if (params.t === 'caps') return indexer.capabilities();
      if (params.t === 'get') {
        const descriptor = indexer.taskDescriptor(params.id || '');
        reply
          .type('application/x-bittorrent')
          .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`);
        return descriptor.content;
      }
      if (!['search', 'tvsearch', 'movie'].includes(params.t || '')) throw new Error('Unsupported Torznab function');
      return await whileOpen(reply, signal => indexer.search(params, signal));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.type('application/xml; charset=utf-8');
      return `<error code="900" description="${xml(message)}"/>`;
    }
  });
  if (publisher && config.vltava) {
    const vltava = config.vltava;
    // Sonarr's and Radarr's Webhook connection: an imported file Bohemarr downloaded is queued for Vltava.
    app.post('/hooks/arr', async request => {
      const decision = decideImport((request.body ?? {}) as ImportEvent, store, vltava, providers);
      if ('ignore' in decision) return { status: 'ignored', reason: decision.ignore };
      const publication = publisher.add(decision.publish);
      return { status: publication.status, id: publication.id };
    });
  }
  app.post('/api/v2/auth/login', async (request, reply) => {
    const { password } = stringParams(request.body);
    reply.type('text/plain; charset=utf-8');
    // The username is not checked; the password is the API key. qBittorrent answers a bad login with 200 "Fails.".
    if (!matches(password || '', config.apiKey)) return 'Fails.';
    reply.header('Set-Cookie', `SID=${session}; HttpOnly; SameSite=Strict; Path=/`);
    return 'Ok.';
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/api/v2/*',
    handler: async (request, reply) => {
      const params = { ...stringParams(request.body), ...stringParams(request.query) };
      const torrents: Buffer[] = [];
      let response: QBittorrentResponse;
      try {
        if (request.isMultipart()) {
          for await (const part of request.parts()) {
            if (part.type === 'file') {
              if (part.fieldname !== 'torrents') throw new Error('Expected upload field torrents');
              try {
                torrents.push(await part.toBuffer());
              } catch (error) {
                if (error instanceof app.multipartErrors.RequestFileTooLargeError)
                  throw new Error('Torrent file too large', { cause: error });
                throw error;
              }
            } else if (typeof part.value === 'string') params[part.fieldname] = part.value;
          }
        }
        response = await qbittorrent.handle((request.params as { '*': string })['*'], params, torrents);
      } catch (error) {
        response = { code: 400, body: error instanceof Error ? error.message : String(error) };
      }
      reply.code(response.code ?? 200);
      if (typeof response.body === 'string') reply.type('text/plain; charset=utf-8');
      return response.body;
    },
  });
  return app;
}

/** Runs `task` with a signal that aborts when the client disconnects or after 120 seconds. */
async function whileOpen<T>(reply: FastifyReply, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', onClose);
  try {
    return await task(AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
  } finally {
    reply.raw.removeListener('close', onClose);
  }
}

function stringParams(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function matches(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
