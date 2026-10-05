import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import { Indexer } from '../src/indexer.ts';
import { QBittorrent } from '../src/qbittorrent.ts';
import { encode } from '../src/torrent.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import { createProviders } from '../src/providers/index.ts';
import { PlaybackBusy } from '../src/providers/common.ts';
import { fakeCatalogue } from './fake-catalogue.ts';
import type { Config, Provider, Release } from '../src/types.ts';

const release: Release = { id: 'episode-one', provider: 'direct', title: 'Example', series: 'Example', kind: 'tv', season: 1, episode: 1, url: 'https://example.test/video.mp4' };

async function fixture() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'md-lifecycle-'));
  const config: Config = {
    host: '127.0.0.1', port: 8787, apiKey: 'a'.repeat(64), publicUrl: 'http://localhost:8787',
    dataDir: dir.path, downloadsDir: join(dir.path, 'downloads'), concurrency: 1,
    ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'https://example.test/wv/',
    categories: ['tv', 'movies'], providers: {}, arrs: [],
  };
  const store = new Store(join(dir.path, 'state.sqlite'));
  const provider: Provider = { id: 'direct', name: 'Direct', catalogue: fakeCatalogue(() => [release]), resolve: async () => [{ url: release.url, type: 'file', height: 1080, audioLanguage: 'cs' }] };
  const providers = new Map([[provider.id, provider]]);
  return { dir, root: dir.path, config, store, providers };
}

test('pause wins against a late downloader completion and cancellation removes files after the worker stops', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  const entered = Promise.withResolvers<void>();
  await using queue = new Queue(f.store, f.config, f.providers, async (_sources, directory, _title, signal, progress) => {
    entered.resolve();
    await once(signal, 'abort');
    const file = join(directory, 'late.mp4');
    await writeFile(file, 'late result');
    progress({ bytes: 11, progress: 100 });
    return file;
  });
  const job = queue.add('job-one', release, 'tv');
  await entered.promise;
  await queue.pause(job.id);
  assert.equal(f.store.job(job.id)?.status, 'Paused');
  assert.notEqual(f.store.job(job.id)?.progress, 100);
  await queue.remove(job.id, true);
  assert.equal(f.store.job(job.id), undefined);
  await assert.rejects(access(job.storage), { code: 'ENOENT' });
});

test('removal accepts a persisted old release folder but never deletes a sibling job', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = new Queue(f.store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
  const oldJob = queue.add('old-job', release, 'tv', true);
  const oldFolder = join(f.config.downloadsDir, 'tv', oldJob.id, 'Example S01E01 WEB-DL-direct');
  await mkdir(oldFolder, { recursive: true });
  await writeFile(join(oldFolder, 'episode.mp4'), 'previous release');
  f.store.updateJob(oldJob.id, { storage: oldFolder });
  await queue.remove(oldJob.id, true);
  await assert.rejects(access(oldFolder), { code: 'ENOENT' });

  const unsafeJob = queue.add('unsafe-job', release, 'tv', true);
  const sibling = join(f.config.downloadsDir, 'tv', `${unsafeJob.id}-sibling`, 'keep');
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, 'episode.mp4'), 'keep this job');
  f.store.updateJob(unsafeJob.id, { storage: sibling });
  await assert.rejects(queue.remove(unsafeJob.id, true), /outside this job/);
  assert.equal(await readFile(join(sibling, 'episode.mp4'), 'utf8'), 'keep this job');
});

test('restart recovers interrupted work without losing a per-job pause', async () => {
  const f = await fixture();
  await using dir = f.dir;
  let store = f.store;
  let queue = new Queue(store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
  try {
    const queued = queue.add('job-one', release, 'tv', true);
    const paused = queue.add('job-two', { ...release, id: 'episode-two', episode: 2 }, 'tv', true);
    store.updateJob(queued.id, { status: 'Downloading', bytes: 123 });
    // Deliberate restart: close and reopen the Store to prove recovery from persisted state.
    await queue.close(); store.close();
    store = new Store(join(f.root, 'state.sqlite'));
    queue = new Queue(store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
    assert.equal(store.job(queued.id)?.status, 'Queued');
    assert.equal(store.job(queued.id)?.bytes, 123);
    assert.equal(store.job(paused.id)?.status, 'Paused');
  } finally {
    await queue.close(); store.close();
  }
});

test('authenticated task descriptor identity cannot be changed to another persisted source', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  f.store.saveReleases([release, { ...release, id: 'other-id', url: 'https://other.test/private' }]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  f.store.saveReleases([{ ...release, id: 'episode-two' }]);
  const descriptor = indexer.taskDescriptor(release.id);
  assert.equal(indexer.parseTaskDescriptor(descriptor.content).release.id, release.id);
  const swapped = Buffer.from(descriptor.content.toString('latin1').replaceAll(release.id, 'episode-two'), 'latin1');
  assert.throws(() => indexer.parseTaskDescriptor(swapped), /signature/);
  const foreign = encode({ info: { length: 1, name: Buffer.from('x'), 'piece length': 16384, pieces: Buffer.alloc(20) } });
  assert.throws(() => indexer.parseTaskDescriptor(foreign), /not a BitTorrent client/);
  assert.throws(() => indexer.parseTaskDescriptor(Buffer.concat([descriptor.content, Buffer.from('e')])), /Invalid torrent/);
});

test('Sonarr daily queries select the air date without inventing a season-zero episode', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Source unavailable', { status: 404 }));
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  const today: Release = { ...release, id: 'daily', title: '28. 9. 2026', season: undefined, episode: undefined };
  const yesterday: Release = { ...today, id: 'yesterday', title: '27. 9. 2026' };
  const provider = f.providers.get('direct')!;
  provider.catalogue = fakeCatalogue(() => [today, yesterday]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  const feed = await indexer.search({ t: 'tvsearch', q: 'Example', season: '2026', ep: '09/28' }, new AbortController().signal);
  assert.match(feed, /<guid isPermaLink="false">daily<\/guid>/);
  assert.doesNotMatch(feed, /2026\.09\.27|S00E00/);
  assert.equal(f.store.release('yesterday'), undefined);
  await assert.rejects(indexer.search({ t: 'tvsearch', season: '2026', ep: '02/30' }, new AbortController().signal), /Invalid daily/);
});

test('movie task names use the movie title rather than their source collection', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  f.store.saveReleases([{ ...release, id: 'movie', kind: 'movie', title: 'Actual Film', series: 'Film Collection', season: undefined, episode: undefined, year: 2008 }]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  const name = indexer.taskDescriptor('movie').name;
  assert.match(name, /^Actual Film 2008\b/);
  assert.doesNotMatch(name, /Film Collection/);
});

test('Radarr title-and-year queries distinguish films with the same title', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Source unavailable', { status: 404 }));
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  const movie: Release = { id: 'original-film', provider: 'direct', kind: 'movie', title: 'Example Film', year: 2008, url: 'https://example.test/original.mp4' };
  const remake: Release = { ...movie, id: 'remade-film', year: 2024, url: 'https://example.test/remake.mp4' };
  const providers = createProviders({ ...f.config, providers: { direct: { enabled: true, catalog: [movie, remake] } } }, f.store.database);
  t.mock.method(providers.get('direct')!, 'resolve', async (item: Release) => [{ url: item.url, type: 'file', height: 1080, audioLanguage: 'cs' }]);
  const indexer = new Indexer(f.config, f.store, new Map([['direct', providers.get('direct')!]]), new SeriesBindings(f.store.database));
  const xml = await indexer.search({ t: 'search', cat: '2000', q: 'Example Film 2008' }, new AbortController().signal);
  assert.match(xml, /<comments>https:\/\/example\.test\/original\.mp4<\/comments>/);
  assert.doesNotMatch(xml, /remake\.mp4/);
});

test('re-adding a task torrent keeps its info hash as download ID and requeues it only after failure', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = new Queue(f.store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
  f.store.saveReleases([release]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  const qbittorrent = new QBittorrent(f.config, queue, indexer);
  const { content, infoHash } = indexer.taskDescriptor(release.id);
  await assert.rejects(qbittorrent.handle('torrents/add', { category: '../escape' }, [content]), /Unknown category/);
  assert.equal(f.store.jobs().length, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await qbittorrent.handle('torrents/add', { category: 'tv', paused: 'true' }, [content])).body, 'Ok.');
  }
  assert.deepEqual(f.store.jobs().map(job => [job.id, job.status]), [[infoHash, 'Paused']]);
  const listed = (await qbittorrent.handle('torrents/info', { category: 'tv' })).body as Array<Record<string, unknown>>;
  assert.deepEqual(listed.map(torrent => [torrent.hash, torrent.state]), [[infoHash, 'pausedDL']]);
  assert.deepEqual((await qbittorrent.handle('torrents/info', { category: 'movies' })).body, []);

  f.store.updateJob(infoHash, { status: 'Failed', error: 'gone' });
  assert.equal(((await qbittorrent.handle('torrents/info', {})).body as Array<Record<string, unknown>>)[0]!.state, 'error');
  await qbittorrent.handle('torrents/add', { category: 'tv', paused: 'true' }, [content]);
  assert.match(f.store.job(infoHash)?.status ?? '', /^(Queued|Downloading)$/);
});

test('a completed job is a finished torrent whose seeding goal is reached, in a folder below its save path', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = new Queue(f.store, f.config, f.providers, async (_sources, directory) => {
    const file = join(directory, 'episode.mp4');
    await writeFile(file, 'media');
    return file;
  });
  const qbittorrent = new QBittorrent(f.config, queue, new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database)));
  const job = queue.add('a'.repeat(40), release, 'tv');
  while (f.store.job(job.id)?.status !== 'Completed') await new Promise(resolve => setImmediate(resolve));
  const [torrent] = (await qbittorrent.handle('torrents/info', { category: 'tv' })).body as Array<Record<string, unknown>>;
  assert.equal(torrent!.state, 'pausedUP');
  assert.equal(torrent!.progress, 1);
  assert.equal(torrent!.size, 5);
  assert.equal(torrent!.content_path, job.storage);
  assert.notEqual(torrent!.save_path, torrent!.content_path);
  assert.ok((torrent!.ratio as number) >= (torrent!.ratio_limit as number));
  await qbittorrent.handle('torrents/delete', { hashes: job.id.toUpperCase(), deleteFiles: 'true' });
  assert.equal(f.store.job(job.id), undefined);
  await assert.rejects(access(job.storage), { code: 'ENOENT' });
});

test('an upgrade turns a global pause into a pause of each job it held back and drops priorities', async () => {
  const f = await fixture();
  await using dir = f.dir;
  f.store.close();
  const path = join(f.root, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE releases (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('schema_version', '1'), ('paused', 'true');`);
  const insert = legacy.prepare('INSERT INTO jobs VALUES (?, ?)');
  for (const [id, status, priority] of [['held', 'Queued', 0], ['forced', 'Downloading', 2], ['done', 'Completed', 0]] as const) {
    insert.run(id, JSON.stringify({ id, release, category: 'tv', status, priority, bytes: 0, totalBytes: 0, progress: 0, storage: '', error: '', createdAt: 0, updatedAt: 0 }));
  }
  legacy.close();
  using store = new Store(path);
  assert.deepEqual(store.jobs().map(job => [job.id, job.status, 'priority' in job]).sort(),
    [['done', 'Completed', false], ['forced', 'Downloading', false], ['held', 'Paused', false]]);
  assert.equal(store.database.prepare("SELECT value FROM settings WHERE key='paused'").get(), undefined);
});

test('busy playback keeps the job queued and retries it, failing only after twelve hours', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  let busy = true;
  let attempts = 0;
  f.providers.get('direct')!.resolve = async () => {
    attempts++;
    if (busy) throw new PlaybackBusy('Oneplay: Dosažen max. počet současných sledování');
    return [{ url: release.url, type: 'file' }];
  };
  await using queue = new Queue(f.store, f.config, f.providers, async (_sources, directory) => {
    const file = join(directory, 'episode.mp4');
    await writeFile(file, 'media');
    return file;
  });
  const turn = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    return promise;
  };
  // Waits for the attempt to finish, plus one turn so the worker has also scheduled its retry.
  const settled = async (id: string, attempt: number) => {
    while (attempts < attempt || f.store.job(id)?.status === 'Downloading') await turn();
    await turn();
    return f.store.job(id)!;
  };

  const job = queue.add('job-one', release, 'tv');
  let state = await settled(job.id, 1);
  assert.equal(state.status, 'Queued', 'Sonarr must not see a failure it would blocklist');
  assert.match(state.error, /současných sledování/);
  t.mock.timers.tick(4 * 60 * 1000);
  assert.equal(attempts, 1, 'no retry before five minutes');
  t.mock.timers.tick(60 * 1000);
  assert.equal((await settled(job.id, 2)).status, 'Queued');
  busy = false;
  t.mock.timers.tick(5 * 60 * 1000);
  state = await settled(job.id, 3);
  assert.equal(state.status, 'Completed');

  busy = true;
  const first = attempts + 1;
  const stuck = queue.add('job-two', { ...release, id: 'episode-two', episode: 2 }, 'tv');
  await settled(stuck.id, first);
  for (let minutes = 5; minutes < 12 * 60; minutes += 5) {
    t.mock.timers.tick(5 * 60 * 1000);
    assert.equal((await settled(stuck.id, first + minutes / 5)).status, 'Queued');
  }
  t.mock.timers.tick(5 * 60 * 1000);
  state = await settled(stuck.id, first + 12 * 12);
  assert.equal(state.status, 'Failed');
  assert.match(state.error, /současných sledování/);
});
