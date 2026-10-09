import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Store } from '../src/store.ts';
import { Publisher, decideImport } from '../src/publisher.ts';
import type { ImportEvent, Publication } from '../src/publisher.ts';
import { encode, infoHashOf } from '../src/torrent.ts';
import type { Config, Job, Provider, Release, VltavaConfig } from '../src/types.ts';
import { fakeCatalogue } from './fake-catalogue.ts';

const execFileAsync = promisify(execFile);

const release: Release = {
  id: 'ct-episode', provider: 'ceskatelevize', title: 'Pilot', series: 'Případy', kind: 'tv', season: 1, episode: 2,
  url: 'https://www.ceskatelevize.cz/porady/1/', language: 'cs', height: 720,
};
const provider: Provider = { id: 'ceskatelevize', name: 'Česká televize', catalogue: fakeCatalogue(() => []), resolve: async () => [] };
const providers = new Map([[provider.id, provider]]);
const vltava: VltavaConfig = {
  url: 'http://vltava.test', token: 'vltava_secret', providers: ['ceskatelevize'], outDir: '/unused', link: 'hardlink',
  anonymous: false, cli: 'vltava', seeder: { url: 'http://rqbit.test' },
};

function job(id: string, jobRelease: Release): Job {
  return { id, release: jobRelease, category: 'tv', status: 'Completed', bytes: 0, totalBytes: 0, progress: 100, storage: '', error: '', createdAt: 0, updatedAt: 0 };
}

function sonarrImport(downloadId: string, path: string, overrides: Partial<ImportEvent> = {}): ImportEvent {
  return {
    eventType: 'Download', downloadId: downloadId.toUpperCase(),
    series: { title: 'Případy 1. oddělení', year: 2014, tvdbId: 281708, tmdbId: 61178, imdbId: 'tt3505782' },
    episodes: [{ seasonNumber: 1, episodeNumber: 2, title: 'Pilot', airDate: '2014-01-06' }],
    episodeFile: { path }, ...overrides,
  };
}

test('only single-episode imports of Bohemarr downloads from listed providers with a TMDB ID are published', () => {
  using store = new Store(':memory:');
  store.saveJob(job('a'.repeat(40), release));
  store.saveJob(job('b'.repeat(40), { ...release, id: 'oneplay-episode', provider: 'oneplay' }));
  // Sonarr may remove the completed download before it reports the import.
  store.removeJob('a'.repeat(40));
  const path = '/data/tvshows/Případy/Season 01/S01E02.mp4';
  const decision = decideImport(sonarrImport('a'.repeat(40), path), store, vltava, providers);
  assert.ok('publish' in decision);
  assert.equal(decision.publish.tmdbId, 61178);
  assert.deepEqual([decision.publish.season, decision.publish.episode, decision.publish.providerName], [1, 2, 'Česká televize']);
  const again = decideImport(sonarrImport('a'.repeat(40), path), store, vltava, providers);
  assert.equal('publish' in again && again.publish.id, decision.publish.id);

  const ignored = (event: ImportEvent): string => {
    const result = decideImport(event, store, vltava, providers);
    return 'ignore' in result ? result.ignore : 'published';
  };
  assert.match(ignored({ eventType: 'Test' }), /event Test/);
  assert.match(ignored(sonarrImport('c'.repeat(40), path)), /not downloaded by Bohemarr/);
  assert.match(ignored(sonarrImport('b'.repeat(40), path)), /oneplay is not in VLTAVA_PROVIDERS/);
  assert.match(ignored(sonarrImport('a'.repeat(40), path, { episodes: [{ seasonNumber: 1, episodeNumber: 2 }, { seasonNumber: 1, episodeNumber: 3 }] })), /2 episodes/);
  assert.match(ignored(sonarrImport('a'.repeat(40), path, { series: { title: 'Případy', tmdbId: 0 } })), /no TMDB ID/);
});

/**
 * A stand-in `vltava` executable: it records its arguments, environment and description, writes the
 * personal .torrent into --out like the real CLI, prints its line and exits with the code in `exit-code`.
 */
const FAKE_CLI = `#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const dir = dirname(process.argv[1]);
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, token: process.env.VLTAVA_TOKEN, url: process.env.VLTAVA_URL,
  description: readFileSync(value('--description-file'), 'utf8') }) + '\\n');
const code = Number(readFileSync(join(dir, 'exit-code'), 'utf8'));
if (code === 1) { process.stderr.write(readFileSync(join(dir, 'stderr'), 'utf8')); process.exit(1); }
writeFileSync(join(value('--out'), 'Případy (2014) - S01E02.torrent'), readFileSync(join(dir, 'personal.torrent')));
console.log('Created torrent #42: Případy (2014) - S01E02');
process.exit(code);
`;

async function fixture() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'bohemarr-publisher-'));
  const cli = join(dir.path, 'vltava');
  await writeFile(cli, FAKE_CLI);
  await chmod(cli, 0o755);
  const personal = encode({ info: { length: 1, name: Buffer.from('S01E02.mp4'), 'piece length': 16384, pieces: Buffer.alloc(20), private: 1 } });
  await writeFile(join(dir.path, 'personal.torrent'), personal);
  const media = join(dir.path, 'S01E02.mp4');
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=5:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', media]);

  // A stand-in rqbit behind basic auth: it keeps what was added and reports `seederState` for it.
  const added: Array<{ hash: string; outputFolder: string | null; overwrite: string | null }> = [];
  const forgotten: string[] = [];
  const seeder = { state: 'live', finished: true, error: null as string | null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://rqbit');
    if (request.headers.authorization !== `Basic ${Buffer.from('seeder:secret').toString('base64')}`) return response.writeHead(401).end();
    if (request.method === 'POST' && url.pathname === '/torrents') {
      const body = Buffer.from(await new Response(Readable.toWeb(request)).arrayBuffer());
      const hash = infoHashOf(body);
      if (!added.some(torrent => torrent.hash === hash)) {
        added.push({ hash, outputFolder: url.searchParams.get('output_folder'), overwrite: url.searchParams.get('overwrite') });
      }
      return response.end(JSON.stringify({ id: 0 }));
    }
    const stats = /^\/torrents\/([0-9a-f]{40})\/stats\/v1$/.exec(url.pathname);
    if (stats && added.some(torrent => torrent.hash === stats[1])) {
      return response.end(JSON.stringify({ state: seeder.state, finished: seeder.finished, error: seeder.error, progress_bytes: 0, total_bytes: 1 }));
    }
    const forget = /^\/torrents\/([0-9a-f]{40})\/forget$/.exec(url.pathname);
    if (request.method === 'POST' && forget) {
      forgotten.push(forget[1]!);
      return response.end('{}');
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address: AddressInfo | string | null = server.address();
  assert.ok(address && typeof address === 'object');
  const publishing: VltavaConfig = { ...vltava, cli, outDir: join(dir.path, 'out'), group: 'BOHEMARR',
    seeder: { url: `http://127.0.0.1:${address.port}`, userpass: 'seeder:secret' } };
  const config: Config = {
    host: '127.0.0.1', port: 0, apiKey: 'k'.repeat(32), publicUrl: 'http://127.0.0.1', dataDir: dir.path, downloadsDir: dir.path,
    concurrency: 1, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'http://unused.invalid',
    categories: ['tv'], providers: {}, arrs: [], vltava: publishing,
  };
  const store = new Store(':memory:');
  store.saveJob(job('a'.repeat(40), release));
  const decision = decideImport(sonarrImport('a'.repeat(40), media), store, publishing, providers);
  assert.ok('publish' in decision);
  const publisher = new Publisher(config, publishing, store.database);
  const calls = async () => (await readFile(join(dir.path, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const outcome = async (exitCode: number, stderr = '') => {
    await writeFile(join(dir.path, 'exit-code'), String(exitCode));
    await writeFile(join(dir.path, 'stderr'), stderr);
    const { id } = publisher.add(decision.publish);
    await publisher.idle();
    const current: Publication | undefined = publisher.publication(id);
    assert.ok(current);
    return current;
  };
  return {
    dir, store, publisher, calls, outcome, added, forgotten, seeder, personal,
    async [Symbol.asyncDispose]() {
      await publisher.close();
      store.close();
      server.close();
      await dir[Symbol.asyncDispose]();
    },
  };
}

test('an uploaded import is seeded from its canonical tree, with the token kept out of the arguments', async () => {
  await using f = await fixture();
  const published = await f.outcome(0);
  assert.equal(published.status, 'Seeding');
  assert.equal(published.torrentId, 42);
  assert.equal(published.namingFixRequired, false);
  assert.deepEqual(f.added, [{ hash: infoHashOf(f.personal), outputFolder: join(f.dir.path, 'out', published.id), overwrite: 'true' }]);
  const [call] = await f.calls();
  assert.equal(call.token, 'vltava_secret');
  assert.ok(!call.args.includes('vltava_secret'));
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  assert.deepEqual([flag('--category'), flag('--tmdb'), flag('--season'), flag('--episode'), flag('--resolution'), flag('--type'), flag('--group')],
    ['tv', '61178', '1', '2', '720p', 'web-dl', 'BOHEMARR']);
  assert.match(call.description, /\[TMDB\]\(https:\/\/www\.themoviedb\.org\/tv\/61178\)/);
  assert.match(call.description, /\[Česká televize\]\(https:\/\/www\.ceskatelevize\.cz\/porady\/1\/\)/);
});

test('a naming problem after upload still seeds, and only failures before upload are retried', async t => {
  await t.test('exit 2: uploaded with a naming problem', async () => {
    await using f = await fixture();
    const published = await f.outcome(2);
    assert.equal(published.status, 'Seeding');
    assert.equal(published.namingFixRequired, true);
  });
  await t.test('duplicate torrent: gives up at once', async () => {
    await using f = await fixture();
    const failed = await f.outcome(1, 'Error: POST /torrents: 409 duplicate_torrent');
    assert.equal(failed.status, 'Failed');
    assert.match(failed.error, /already has this torrent/);
    assert.deepEqual(f.added, []);
  });
  await t.test('other failure: retried after five minutes', async () => {
    await using f = await fixture();
    const before = Date.now();
    const pending = await f.outcome(1, 'Error: POST /naming/plan: 503 provider_unavailable');
    assert.equal(pending.status, 'Pending');
    assert.equal(pending.attempts, 1);
    assert.match(pending.error, /provider_unavailable/);
    assert.ok(pending.retryAt! - before >= 5 * 60_000 - 1000);
  });
});

test('seeding waits while rqbit checks the files and lets go of a torrent whose files do not match', async t => {
  await t.test('still checking: looked at again in 30 seconds, not counted as a failure', async () => {
    await using f = await fixture();
    f.seeder.state = 'initializing';
    const before = Date.now();
    const checking = await f.outcome(0);
    assert.equal(checking.status, 'Uploaded');
    assert.equal(checking.attempts, 0);
    assert.ok(checking.retryAt! - before >= 29_000 && checking.retryAt! - before <= 31_000);
  });
  await t.test('files do not match: forgotten, and not retried', async () => {
    await using f = await fixture();
    f.seeder.finished = false;
    const failed = await f.outcome(0);
    assert.equal(failed.status, 'Failed');
    assert.match(failed.error, /do not match the torrent/);
    assert.deepEqual(f.forgotten, [infoHashOf(f.personal)]);
  });
  await t.test('rqbit error: retried', async () => {
    await using f = await fixture();
    f.seeder.state = 'error';
    f.seeder.error = 'Permission denied (os error 13)';
    const pending = await f.outcome(0);
    assert.equal(pending.status, 'Uploaded');
    assert.equal(pending.attempts, 1);
    assert.match(pending.error, /Permission denied/);
  });
});
