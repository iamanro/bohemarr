import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalogue } from '../src/catalogue.ts';
import type { Catalogue, Program, Release, SearchQuery } from '../src/types.ts';

const signal = new AbortController().signal;

function episode(program: string, n: number, overrides: Partial<Release> = {}): Release {
  return { id: `${program}-${n}`, provider: 'p', title: `Episode ${n}`, series: program, kind: 'tv', season: 1, episode: n, url: `https://p.test/${program}/${n}`, ...overrides };
}

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { q: '', limit: 10, offset: 0, ...overrides };
}

/** Programs by title; each Program's releases newest first. `expanded` records expansion order. */
function catalogue(listing: Record<string, Release[] | (() => AsyncIterable<Release>)>, extra: Partial<Catalogue> = {}) {
  const expanded: string[] = [];
  const value: Catalogue = {
    async *programs() { for (const title of Object.keys(listing)) yield { id: title, title }; },
    async *releases(program: Program) {
      expanded.push(program.id);
      const source = listing[program.id]!;
      yield* typeof source === 'function' ? source() : source;
    },
    ...extra,
  };
  return { value, expanded };
}

const search = (value: Catalogue, q: SearchQuery, entries?: Release[]) => searchCatalogue({ id: 'p', catalogue: value, entries }, q, signal);
const ids = (releases: Release[]) => releases.map(release => release.id);

test('movie searches separate the production year from title lookup and reject conflicting or unknown years', async () => {
  const films: Release[] = [
    { id: 'original', provider: 'p', kind: 'movie', title: 'Anděl Páně', year: 2005, url: 'https://p.test/original' },
    { id: 'sequel', provider: 'p', kind: 'movie', title: 'Anděl Páně 2', year: 2016, url: 'https://p.test/sequel' },
    { id: 'misleading-title', provider: 'p', kind: 'movie', title: 'Anděl Páně 2005', year: 2016, url: 'https://p.test/wrong-year' },
    { id: 'unknown-year', provider: 'p', kind: 'movie', title: 'Anděl Páně 2005', url: 'https://p.test/unknown-year' },
  ];
  const value: Catalogue = {
    async *programs(hint) {
      for (const film of films) if (film.title.includes(hint.q)) yield { id: film.id, title: film.title, kind: 'movie' };
    },
    async *releases(program) { yield films.find(film => film.id === program.id)!; },
  };
  for (const q of ['Anděl Páně 2005', 'Anděl Páně (2005)']) {
    assert.deepEqual(ids(await search(value, query({ q, kind: 'movie' }))), ['original']);
    assert.deepEqual(ids(await search(value, query({ q, kind: 'movie' }), films)), ['original']);
  }
});

test('duplicates are removed before the page is counted, so a page is never short', async () => {
  // Two Programs list the same Release (e.g. a special filed under both).
  const { value } = catalogue({
    'Show A': [episode('Show A', 2), episode('Show A', 1)],
    'Show B': [episode('Show A', 2, { series: 'Show B' }), episode('Show B', 1)],
  });
  assert.deepEqual(ids(await search(value, query({ q: 'show', limit: 3 }))), ['Show A-2', 'Show A-1', 'Show B-1']);
});

test('text search ranks exact Program names first, before paging', async () => {
  const { value, expanded } = catalogue({
    'Ano, šéfe! (USA)': [episode('Ano, šéfe! (USA)', 1)],
    'Ano, šéfe!': [episode('Ano, šéfe!', 1)],
  });
  assert.deepEqual(ids(await search(value, query({ q: 'Ano šéfe', limit: 1 }))), ['Ano, šéfe!-1']);
  assert.deepEqual(expanded, ['Ano, šéfe!']);
  assert.deepEqual(ids(await search(value, query({ q: 'Ano šéfe', limit: 1, offset: 1 }))), ['Ano, šéfe! (USA)-1']);
});

test('text search expands only Programs with every query word, else any word', async () => {
  const { value, expanded } = catalogue({
    Autosalon: [episode('Autosalon', 1, { title: 'Škoda Octavia' })],
    'Autosalon Extra': [episode('Autosalon Extra', 1)],
    Unrelated: [episode('Unrelated', 1)],
  });
  await search(value, query({ q: 'Autosalon Extra' }));
  assert.deepEqual(expanded, ['Autosalon Extra']);
  expanded.length = 0;
  // No Program title has both words: fall back to Programs with any word; releases still need all words.
  assert.deepEqual(ids(await search(value, query({ q: 'Autosalon Škoda' }))), ['Autosalon-1']);
  assert.deepEqual(expanded, ['Autosalon', 'Autosalon Extra']);
});

test('the any-word fallback ignores short words, so a foreign title expands no unrelated Program', async () => {
  const { value, expanded } = catalogue({ 'Ulice': [episode('Ulice', 1)], 'Specialisté': [episode('Specialisté', 1)], 'Most!': [episode('Most!', 1)] });
  assert.deepEqual(ids(await search(value, query({ q: "Grey's Anatomy" }))), []);
  assert.deepEqual(expanded, []);
});

test('text search expands at most 40 Programs', async () => {
  const listing = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`Show ${i}`, [] as Release[]]));
  const { value, expanded } = catalogue(listing);
  await search(value, query({ q: 'show' }));
  assert.equal(expanded.length, 40);
});

test('browsing returns each Program\'s newest matching Release and stops once the page is full', async () => {
  const { value, expanded } = catalogue({
    A: [episode('A', 3), episode('A', 2)],
    B: [episode('B', 9, { season: 2 }), episode('B', 1)],
    C: () => { throw new Error('must not be expanded'); },
  });
  assert.deepEqual(ids(await search(value, query({ limit: 2 }))), ['A-3', 'B-9']);
  assert.deepEqual(expanded, ['A', 'B']);
  assert.deepEqual(ids(await search(value, query({ limit: 2, season: 1 }))), ['A-3', 'B-1']);
});

test('browsing skips Programs whose known kind cannot match', async () => {
  const { value, expanded } = catalogue({}, {
    async *programs() { yield { id: 'film', title: 'Film', kind: 'movie' }; yield { id: 'show', title: 'Show', kind: 'tv' }; },
    async *releases(program: Program) { expanded.push(program.id); yield episode(program.id, 1); },
  });
  await search(value, query({ kind: 'tv' }));
  assert.deepEqual(expanded, ['show']);
});

test('concurrent expansion keeps catalogue order and never overshoots the page', async () => {
  let inFlight = 0;
  let peak = 0;
  // A finishes only after B has finished, so completion order is the reverse of catalogue order.
  const aMayFinish = Promise.withResolvers<void>();
  const tracked = (program: string, before: () => Promise<void> | void) => async function* () {
    inFlight++; peak = Math.max(peak, inFlight);
    await before();
    inFlight--;
    yield episode(program, 1);
  };
  const { value, expanded } = catalogue({
    A: tracked('A', () => aMayFinish.promise),
    B: tracked('B', () => aMayFinish.resolve()),
    C: tracked('C', () => {}),
    D: tracked('D', () => {}),
  }, { concurrency: 2 });
  assert.deepEqual(ids(await search(value, query({ limit: 2 }))), ['A-1', 'B-1']);
  assert.equal(peak, 2);
  assert.deepEqual(expanded, ['A', 'B']);
});

test('a failing Program is skipped; the search fails only when nothing was found', async () => {
  const broken = () => { throw new Error('upstream 500'); };
  const partial = catalogue({ A: broken, B: [episode('B', 1)] });
  assert.deepEqual(ids(await search(partial.value, query())), ['B-1']);
  const all = catalogue({ A: broken, B: broken });
  await assert.rejects(search(all.value, query()), AggregateError);
  const none = catalogue({ A: [], B: [] });
  assert.deepEqual(await search(none.value, query()), []);
});

test('abort rejects instead of returning a partial page', async () => {
  const controller = new AbortController();
  const { value } = catalogue({ A: async function* () { controller.abort(); yield episode('A', 1); }, B: [episode('B', 1)] });
  await assert.rejects(searchCatalogue({ id: 'p', catalogue: value }, query(), controller.signal), { name: 'AbortError' });
});

test('static entries come first and count toward the page', async () => {
  const entry: Release = { id: 'entry', provider: 'p', title: 'Configured', series: 'Configured', kind: 'tv', season: 1, episode: 1, url: 'https://p.test/entry' };
  const { value, expanded } = catalogue({ A: [episode('A', 1)] });
  assert.deepEqual(ids(await search(value, query({ limit: 1 }), [entry])), ['entry']);
  assert.deepEqual(expanded, []);
});

test('a URL query only consults releaseForUrl and still applies kind/season filters', async () => {
  const { value, expanded } = catalogue({ A: [episode('A', 1)] }, {
    async releaseForUrl(url: URL, hint) { return { id: 'u', provider: 'p', title: 'Clip', url: url.href, kind: hint.kind ?? 'movie' }; },
  });
  assert.deepEqual(ids(await search(value, query({ q: 'https://p.test/clip' }))), ['u']);
  assert.deepEqual(await search(value, query({ q: 'https://p.test/clip', season: 1 })), []);
  assert.deepEqual(expanded, []);
  assert.deepEqual(await search(catalogue({ A: [episode('A', 1)] }).value, query({ q: 'https://p.test/clip' })), []);
});

test('a bound Program expands only that Program', async () => {
  const { value, expanded } = catalogue({ A: [episode('A', 2), episode('A', 1)], B: [episode('B', 1)] }, {
    async program(id: string) { return id === 'missing' ? undefined : { id, title: id }; },
  });
  assert.deepEqual(ids(await search(value, query({ programId: 'A', episode: 1 }))), ['A-1']);
  assert.deepEqual(expanded, ['A']);
  assert.deepEqual(await search(value, query({ programId: 'missing' })), []);
  await assert.rejects(search(catalogue({}).value, query({ programId: 'A' })), /cannot expand a bound program/);
});

test('a Release owned by another provider is rejected', async () => {
  const { value } = catalogue({ A: [episode('A', 1, { provider: 'other' })] });
  await assert.rejects(search(value, query()), /owned by other/);
});
