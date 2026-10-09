import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
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
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/api/v2/auth/login') return;
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
  app.get('/v1/providers', async () => [...providers.values()].map(provider => ({ id: provider.id, name: provider.name })));
  app.get('/api', async (request, reply) => {
    const params = stringParams(request.query);
    reply.type('application/xml; charset=utf-8');
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);
    try {
      if (params.t === 'caps') return indexer.capabilities();
      if (params.t === 'get') {
        const descriptor = indexer.taskDescriptor(params.id || '');
        reply.type('application/x-bittorrent').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`);
        return descriptor.content;
      }
      if (!['search', 'tvsearch', 'movie'].includes(params.t || '')) throw new Error('Unsupported Torznab function');
      return await indexer.search(params, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.type('application/xml; charset=utf-8');
      return `<error code="900" description="${xml(message)}"/>`;
    } finally {
      reply.raw.removeListener('close', onClose);
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
    method: ['GET', 'POST'], url: '/api/v2/*',
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
                if (error instanceof app.multipartErrors.RequestFileTooLargeError) throw new Error('Torrent file too large');
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

function stringParams(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function matches(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
