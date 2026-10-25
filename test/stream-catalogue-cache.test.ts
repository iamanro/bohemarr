import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStreamCzProvider } from '../src/providers/czech-public-streamcz.ts';
import type { CatalogueQuery, Provider } from '../src/types.ts';

const API_URL = 'https://api.stream.cz/graphql';
const CATEGORIES_URL = 'https://www.stream.cz/videa/filmy';
const HOUR = 60 * 60 * 1000;

interface Program {
  id: string;
  name: string;
  urlName: string;
}
interface Category {
  id: string;
  name: string;
  urlName: string;
  kind?: 'movie';
  programs: Program[];
}

/** A fake Stream.cz: one page of programs per category, counting categories/programs requests. */
function streamcz(t: TestContext) {
  const categories: Category[] = [];
  let categoriesRequests = 0;
  let programsRequests = 0;
  let episodeRequests = 0;
  const episodes = new Map<string, Array<Program & { namePrefix: string }>>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const url = String(input instanceof Request ? input.url : input);
    if (url === CATEGORIES_URL) {
      categoriesRequests++;
      const navCategories = categories.filter(c => c.kind !== 'movie').map(c => ({ id: c.id, name: c.name, urlName: c.urlName }));
      const channel = categories.find(c => c.kind === 'movie');
      const state = {
        page: { navigationCategories: { data: navCategories } },
        fetchable: { tag: { channel: { data: channel ? { id: channel.id, name: channel.name, urlName: channel.urlName } : null } } },
      };
      return new Response(`<script>window.APP_SERVER_STATE = foo; data : ${JSON.stringify(state)};</script>`);
    }
    if (url === API_URL && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { variables: { id: string; last?: number } };
      if (body.variables.last !== undefined) {
        episodeRequests++;
        const edges = (episodes.get(body.variables.id) ?? []).map(node => ({ node }));
        return Response.json({
          data: {
            tagData: {
              allEpisodesConnection: {
                pageInfo: { startCursor: null, hasPreviousPage: false },
                edges,
              },
            },
          },
        });
      }
      programsRequests++;
      const category = categories.find(c => c.id === body.variables.id);
      const edges = (category?.programs ?? []).map(p => ({ node: { id: p.id, name: p.name, urlName: p.urlName } }));
      return Response.json({
        data: {
          childTagsData: { directTagsConnection: { totalCount: edges.length, pageInfo: { endCursor: null, hasNextPage: false }, edges } },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return {
    categories,
    episodes,
    get categoriesRequests() {
      return categoriesRequests;
    },
    get programsRequests() {
      return programsRequests;
    },
    get episodeRequests() {
      return episodeRequests;
    },
  };
}

async function list(provider: Provider, query: CatalogueQuery, signal = new AbortController().signal) {
  return Array.fromAsync(provider.catalogue.programs(query, signal));
}

test('different episode searches and a restart reuse the complete Stream episode listing until five minutes', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'shows',
    name: 'Shows',
    urlName: 'shows',
    programs: [{ id: 'love', name: 'Love Island', urlName: 'love-island' }],
  });
  site.episodes.set('love', [
    { id: 'e45', name: 'Episode 45', namePrefix: 'S4:E45', urlName: 'episode-45' },
    { id: 'e48', name: 'Episode 48', namePrefix: 'S4:E48', urlName: 'episode-48' },
  ]);
  using database = new DatabaseSync(':memory:');
  let now = 0;
  const timing = { now: () => now };
  const provider = createStreamCzProvider({}, database, timing)!;
  const [program] = await list(provider, { q: '', kind: 'tv' });
  const read = (source: Provider, episode: number) =>
    Array.fromAsync(source.catalogue.releases(program!, { q: '', kind: 'tv', season: 4, episode }, new AbortController().signal));
  const first = await read(provider, 45);
  assert.deepEqual(
    first.map(r => [r.episode, r.url]),
    [
      [48, 'https://www.stream.cz/love-island/episode-48'],
      [45, 'https://www.stream.cz/love-island/episode-45'],
    ],
  );
  site.episodes.get('love')!.push({ id: 'e49', name: 'Episode 49', namePrefix: 'S4:E49', urlName: 'episode-49' });
  now = 5 * 60 * 1000 - 1;
  const restarted = createStreamCzProvider({}, database, timing)!;
  assert.deepEqual(await read(restarted, 48), first);
  assert.equal(site.episodeRequests, 1, 'different episode and restart must not refetch the same programme');
  // Expired, and inserted after the start-up sweep, so only the next write can remove it.
  database.prepare('INSERT INTO stream_episode_cache VALUES (?, ?, ?)').run('gone', now - 10 * 60 * 1000, '[]');
  now++;
  const refreshed = await read(restarted, 49);
  assert.deepEqual(
    refreshed.map(r => r.episode),
    [49, 48, 45],
  );
  assert.equal(site.episodeRequests, 2);
  assert.equal(
    database.prepare("SELECT count(*) AS n FROM stream_episode_cache WHERE program_id = 'gone'").get()!.n,
    0,
    'the write swept the expired listing',
  );
});

test('a partially consumed Stream episode listing never hides later episodes', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'shows',
    name: 'Shows',
    urlName: 'shows',
    programs: [{ id: 'love', name: 'Love Island', urlName: 'love-island' }],
  });
  site.episodes.set('love', [
    { id: 'e45', name: 'Episode 45', namePrefix: 'S4:E45', urlName: 'episode-45' },
    { id: 'e48', name: 'Episode 48', namePrefix: 'S4:E48', urlName: 'episode-48' },
  ]);
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({}, database)!;
  const [program] = await list(provider, { q: '', kind: 'tv' });
  const episodes = () => provider.catalogue.releases(program!, { q: '' }, new AbortController().signal);
  for await (const _release of episodes()) break;
  assert.deepEqual(
    (await Array.fromAsync(episodes())).map(r => r.episode),
    [48, 45],
  );
  assert.equal(site.episodeRequests, 2);
});

test('an aborted final episode yield cannot publish a snapshot or cross programme identities', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'shows',
    name: 'Shows',
    urlName: 'shows',
    programs: [
      { id: 'first', name: 'First Show', urlName: 'first-show' },
      { id: 'second', name: 'Second Show', urlName: 'second-show' },
    ],
  });
  site.episodes.set('first', [{ id: 'one', name: 'First', namePrefix: 'S4:E45', urlName: 'one' }]);
  site.episodes.set('second', [{ id: 'two', name: 'Second', namePrefix: 'S4:E48', urlName: 'two' }]);
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({}, database)!;
  const [first, second] = await list(provider, { q: '', kind: 'tv' });
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const _release of provider.catalogue.releases(first!, { q: '' }, controller.signal)) {
      controller.abort(new Error('cancel final yield'));
    }
  }, /cancel final yield/);
  const read = (program: NonNullable<typeof first>) =>
    Array.fromAsync(provider.catalogue.releases(program, { q: '' }, new AbortController().signal));
  assert.deepEqual(
    (await read(first!)).map(r => [r.series, r.episode]),
    [['First Show', 45]],
  );
  assert.deepEqual(
    (await read(second!)).map(r => [r.series, r.episode]),
    [['Second Show', 48]],
  );
  assert.equal(site.episodeRequests, 3);
  await assert.rejects(Array.fromAsync(provider.catalogue.releases(first!, { q: '' }, controller.signal)), /cancel final yield/);
});

test('a fresh Stream.cz programme snapshot is served from SQLite without a catalogue request', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'cat-serialy',
    name: 'Seriály',
    urlName: 'serialy',
    programs: [{ id: 'p1', name: 'Ano, šéfe!', urlName: 'ano-sefe' }],
  });
  using database = new DatabaseSync(':memory:');
  let now = 0;
  const provider = createStreamCzProvider({ enabled: true }, database, { now: () => now })!;

  const first = await list(provider, { q: '' });
  assert.deepEqual(first, [{ id: 'p1', title: 'Ano, šéfe!', kind: 'tv', urlName: 'ano-sefe' }]);
  assert.equal(site.categoriesRequests, 1);
  assert.equal(site.programsRequests, 1);

  // Upstream changes, but within six hours the stored snapshot for the same scope is still served.
  site.categories[0]!.programs.push({ id: 'p2', name: 'New Show', urlName: 'new-show' });
  now = 6 * HOUR - 1;
  const second = await list(provider, { q: '' });
  assert.deepEqual(second, first);
  assert.equal(site.categoriesRequests, 1);
  assert.equal(site.programsRequests, 1);
});

test('a snapshot older than six hours is rediscovered', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'cat-serialy',
    name: 'Seriály',
    urlName: 'serialy',
    programs: [{ id: 'p1', name: 'First', urlName: 'first' }],
  });
  using database = new DatabaseSync(':memory:');
  let now = 0;
  const provider = createStreamCzProvider({ enabled: true }, database, { now: () => now })!;
  await list(provider, { q: '' });

  site.categories[0]!.programs[0] = { id: 'p1', name: 'Renamed', urlName: 'first' };
  now = 6 * HOUR;
  const refreshed = await list(provider, { q: '' });
  assert.deepEqual(refreshed, [{ id: 'p1', title: 'Renamed', kind: 'tv', urlName: 'first' }]);
  assert.equal(site.categoriesRequests, 2);
  assert.equal(site.programsRequests, 2);
});

test('the snapshot survives a restart on the same database', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'cat-serialy',
    name: 'Seriály',
    urlName: 'serialy',
    programs: [{ id: 'p1', name: 'First', urlName: 'first' }],
  });
  using database = new DatabaseSync(':memory:');
  const first = createStreamCzProvider({ enabled: true }, database)!;
  await list(first, { q: '' });
  assert.equal(site.categoriesRequests, 1);

  // A new provider instance (as after a process restart) on the same database reuses the snapshot.
  const restarted = createStreamCzProvider({ enabled: true }, database)!;
  const results = await list(restarted, { q: '' });
  assert.deepEqual(results, [{ id: 'p1', title: 'First', kind: 'tv', urlName: 'first' }]);
  assert.equal(site.categoriesRequests, 1);
});

test('an aborted discovery never publishes a partial snapshot', async t => {
  const site = streamcz(t);
  site.categories.push(
    { id: 'cat-serialy', name: 'Seriály', urlName: 'serialy', programs: [{ id: 'p1', name: 'First', urlName: 'first' }] },
    { id: 'cat-druhy', name: 'Druhý', urlName: 'druhy', programs: [{ id: 'p2', name: 'Second', urlName: 'second' }] },
  );
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({ enabled: true }, database)!;
  const controller = new AbortController();

  const partial: unknown[] = [];
  // Aborted on the last programme: the walk is otherwise complete, so only the abort check keeps it from being cached.
  await assert.rejects(async () => {
    for await (const program of provider.catalogue.programs({ q: '' }, controller.signal)) {
      partial.push(program);
      if ((program as { id: string }).id === 'p2') controller.abort(new Error('caller stopped'));
    }
  }, /caller stopped/);
  assert.equal(partial.length, 2);

  // Nothing was cached: a fresh, unaborted call re-discovers everything, including what was seen before the abort.
  const complete = await list(provider, { q: '' });
  assert.deepEqual(complete.map(p => p.id).sort(), ['p1', 'p2']);
  assert.equal(site.categoriesRequests, 2);
});

test('a caller that stops early without aborting never caches a partial snapshot', async t => {
  const site = streamcz(t);
  site.categories.push(
    { id: 'cat-serialy', name: 'Seriály', urlName: 'serialy', programs: [{ id: 'p1', name: 'First', urlName: 'first' }] },
    { id: 'cat-druhy', name: 'Druhý', urlName: 'druhy', programs: [{ id: 'p2', name: 'Second', urlName: 'second' }] },
  );
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({ enabled: true }, database)!;

  for await (const _program of provider.catalogue.programs({ q: '' }, new AbortController().signal)) break;

  const complete = await list(provider, { q: '' });
  assert.deepEqual(complete.map(p => p.id).sort(), ['p1', 'p2']);
  assert.equal(site.categoriesRequests, 2);
});

test('the same programme id under different kinds is cached as distinct rows, not collapsed', async t => {
  const site = streamcz(t);
  site.categories.push(
    { id: 'cat-serialy', name: 'Seriály', urlName: 'serialy', programs: [{ id: 'shared', name: 'Shared (show)', urlName: 'shared-show' }] },
    {
      id: 'cat-filmy',
      name: 'Filmy',
      urlName: 'filmy',
      kind: 'movie',
      programs: [{ id: 'shared', name: 'Shared (movie)', urlName: 'shared-movie' }],
    },
  );
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({ enabled: true }, database)!;

  const all = await list(provider, { q: '' });
  assert.deepEqual(all.map(p => [p.id, p.kind]).sort(), [
    ['shared', 'movie'],
    ['shared', 'tv'],
  ]);

  // 'tv' and 'movie' scopes are cached and served independently of the 'all' scope.
  const tv = await list(provider, { q: '', kind: 'tv' });
  assert.deepEqual(
    tv.map(p => [p.id, p.kind]),
    [['shared', 'tv']],
  );
  const movies = await list(provider, { q: '', kind: 'movie' });
  assert.deepEqual(
    movies.map(p => [p.id, p.kind]),
    [['shared', 'movie']],
  );
  assert.equal(site.categoriesRequests, 3);
});

test('an authoritative empty programme list for a scope is cached, not treated as a miss', async t => {
  const site = streamcz(t);
  site.categories.push({ id: 'cat-filmy', name: 'Filmy', urlName: 'filmy', kind: 'movie', programs: [] });
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({ enabled: true }, database)!;

  const first = await list(provider, { q: '', kind: 'tv' });
  assert.deepEqual(first, []);
  assert.equal(site.categoriesRequests, 1);

  const second = await list(provider, { q: '', kind: 'tv' });
  assert.deepEqual(second, []);
  assert.equal(site.categoriesRequests, 1);
});

test('cached programmes stop when the consumer cancels between yields', async t => {
  const site = streamcz(t);
  site.categories.push({
    id: 'shows',
    name: 'Shows',
    urlName: 'shows',
    programs: [
      { id: 'first', name: 'First', urlName: 'first' },
      { id: 'second', name: 'Second', urlName: 'second' },
    ],
  });
  using database = new DatabaseSync(':memory:');
  const provider = createStreamCzProvider({}, database)!;
  await list(provider, { q: '', kind: 'tv' });
  const controller = new AbortController();
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const program of provider.catalogue.programs({ q: '', kind: 'tv' }, controller.signal)) {
      seen.push(program.id);
      controller.abort(new Error('cancel cached search'));
    }
  }, /cancel cached search/);
  assert.deepEqual(seen, ['first']);
});

for (const failure of ['missing-state', 'incomplete-connection'] as const) {
  test(`${failure} cannot poison the catalogue cache with an empty snapshot`, async t => {
    const site = streamcz(t);
    site.categories.push({ id: 'shows', name: 'Shows', urlName: 'shows', programs: [{ id: 'first', name: 'First', urlName: 'first' }] });
    const upstream = globalThis.fetch;
    let broken = true;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (broken && failure === 'missing-state' && url === CATEGORIES_URL) return new Response('<html>Unavailable</html>');
      if (broken && failure === 'incomplete-connection' && url === API_URL) return Response.json({ data: {} });
      return upstream(input, init);
    });
    using database = new DatabaseSync(':memory:');
    const provider = createStreamCzProvider({}, database)!;
    await assert.rejects(list(provider, { q: '', kind: 'tv' }), /Stream.cz returned/);
    broken = false;
    assert.deepEqual(await list(provider, { q: '', kind: 'tv' }), [{ id: 'first', title: 'First', kind: 'tv', urlName: 'first' }]);
  });
}
