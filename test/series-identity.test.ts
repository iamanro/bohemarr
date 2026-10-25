import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadSeriesIdentity, isSeriesCandidate, selectProgram, type ProgramSelection } from '../src/series-identity.ts';
import type { SeriesIdentity, ProgramMetadata } from '../src/types.ts';

/** The selected Program id, or why none was selected. */
const outcome = (selection: ProgramSelection): string => 'program' in selection ? selection.program.id : selection.reason;

const loveIslandIdentity: SeriesIdentity = {
  tvdbId: 410707,
  title: 'Love Island Czech Republic & Slovakia',
  aliases: ['Love Island Česko & Slovensko'],
  year: 2021,
  country: 'cze',
};

function czechLoveIsland(): ProgramMetadata {
  return {
    id: 'https://www.oneplay.cz/porad/4789-love-island',
    title: 'Love Island',
    aliases: [],
    year: 2021,
    countries: ['Česká republika'],
  };
}

test('loadSeriesIdentity parses a real Skyhook payload', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    assert.equal(String(input), 'https://skyhook.sonarr.tv/v1/tvdb/shows/en/410707');
    return Response.json({
      tvdbId: 410707,
      title: 'Love Island Czech Republic & Slovakia',
      firstAired: '2021-09-19',
      originalCountry: 'cze',
      alternativeTitles: [{ title: 'Love Island Česko & Slovensko' }, { title: '' }, { title: 'Love Island Czech Republic & Slovakia' }],
    });
  });
  const identity = await loadSeriesIdentity(410707, new AbortController().signal);
  assert.deepEqual(identity, {
    tvdbId: 410707,
    title: 'Love Island Czech Republic & Slovakia',
    aliases: ['Love Island Česko & Slovensko'],
    year: 2021,
    country: 'cze',
  });
});

test('loadSeriesIdentity rejects a non-OK status with a clear error', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 404 }));
  await assert.rejects(
    loadSeriesIdentity(1, new AbortController().signal),
    /status 404/,
  );
});

test('loadSeriesIdentity rejects malformed JSON', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not json', { status: 200 }));
  await assert.rejects(loadSeriesIdentity(1, new AbortController().signal), /malformed metadata/);
});

test('loadSeriesIdentity rejects a response whose id does not match the request', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tvdbId: 999, title: 'Other Show' }));
  await assert.rejects(loadSeriesIdentity(1, new AbortController().signal), /mismatched metadata/);
});

test('loadSeriesIdentity rejects a response missing a usable title', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tvdbId: 1, title: '   ' }));
  await assert.rejects(loadSeriesIdentity(1, new AbortController().signal), /missing title/);
});

test('loadSeriesIdentity tolerates absent optional metadata', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tvdbId: 1, title: 'Some Show' }));
  const identity = await loadSeriesIdentity(1, new AbortController().signal);
  assert.deepEqual(identity, { tvdbId: 1, title: 'Some Show', aliases: [], year: undefined, country: undefined });
});

test('verified TVmaze names bind a Czech programme to its English TVDB identity', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.includes('skyhook.sonarr.tv')) return Response.json({ tvdbId: 441247, title: 'Extractors', firstAired: '2023-10-27', originalCountry: 'cze', tmdbId: 215097, tvMazeId: 72176 });
    if (url.endsWith('/akas')) return Response.json([{ name: 'Extractors' }, { name: 'Vyprošťovači' }]);
    return Response.json({ id: 72176, name: 'Extraktoři', externals: { thetvdb: 441247 } });
  });
  const identity = await loadSeriesIdentity(441247, new AbortController().signal);
  const programme = { id: 'https://www.oneplay.cz/porad/9486-extraktori', title: 'Extraktoři', aliases: [], year: 2023, countries: ['Česká republika'] };
  assert.equal(outcome(selectProgram(identity, [programme])), programme.id);
  assert.equal(identity.title, 'Extractors');
  assert.equal(identity.tmdbId, 215097);
  assert.deepEqual(identity.aliases, ['Extraktoři', 'Vyprošťovači'], 'the TVmaze name and its akas, without the TVDB title');
});

test('TVmaze aliases cannot attach a different TVDB identity', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => String(input).includes('skyhook.sonarr.tv')
    ? Response.json({ tvdbId: 441247, title: 'Extractors', tvMazeId: 72176 })
    : Response.json({ id: 72176, name: 'Unrelated show', externals: { thetvdb: 999999 } }));
  await assert.rejects(loadSeriesIdentity(441247, new AbortController().signal), /Mismatched TVmaze/);
});

test('isSeriesCandidate accepts token-boundary prefixes and rejects substring-inside-word matches', () => {
  assert.ok(isSeriesCandidate('Love Island', loveIslandIdentity));
  assert.ok(isSeriesCandidate('Love Island (Austrálie)', loveIslandIdentity));
  assert.ok(isSeriesCandidate('Love Island After', loveIslandIdentity));
  assert.ok(isSeriesCandidate('Love Island Česko & Slovensko', loveIslandIdentity));
  assert.ok(!isSeriesCandidate('Loveisland Extra', loveIslandIdentity));
  assert.ok(!isSeriesCandidate('Islanders', loveIslandIdentity));
  assert.ok(!isSeriesCandidate('Love Islanders', loveIslandIdentity), 'the identity name ends inside a word of the title');
  assert.ok(!isSeriesCandidate('Totally Unrelated Show', loveIslandIdentity));
});

test('selectProgram matches the real Czech/Slovak candidate against national spinoffs', () => {
  const candidates: ProgramMetadata[] = [
    czechLoveIsland(),
    { id: 'au', title: 'Love Island (Austrálie)', aliases: [], year: 2021, countries: ['Austrálie'] },
    { id: 'gb', title: 'Love Island (Velká Británie)', aliases: [], year: 2019, countries: ['Velká Británie'] },
    { id: 'usa', title: 'Love Island USA', aliases: [], year: 2021, countries: ['USA'] },
    { id: 'after', title: 'Love Island After', aliases: [], year: 2021, countries: ['Česká republika'] },
    { id: 'krb', title: 'Love Island krb', aliases: [], year: 2021, countries: ['Česká republika'] },
  ];
  assert.equal(outcome(selectProgram(loveIslandIdentity, candidates)), 'https://www.oneplay.cz/porad/4789-love-island');
});

test('selectProgram never merges spin-off suffixes that are not recognized country qualifiers', () => {
  const candidates: ProgramMetadata[] = [
    { id: 'after', title: 'Love Island After', aliases: [], year: 2021, countries: ['Česká republika'] },
    { id: 'krb', title: 'Love Island krb', aliases: [], year: 2021, countries: ['Česká republika'] },
  ];
  assert.equal(outcome(selectProgram(loveIslandIdentity, candidates)), 'no-candidate');
});

test('selectProgram resolves a real UK national-variant country synonym not in the bundled locale data', () => {
  const identity: SeriesIdentity = { tvdbId: 1, title: 'Love Island', aliases: [], year: 2019, country: 'GB' };
  const candidates: ProgramMetadata[] = [
    { id: 'gb', title: 'Love Island (Velká Británie)', aliases: [], year: 2019, countries: ['Velká Británie'] },
  ];
  assert.equal(outcome(selectProgram(identity, candidates)), 'gb');
});

test('selectProgram leaves an unresolved year conflict (season-specific UK metadata) unbound', () => {
  const identity: SeriesIdentity = { tvdbId: 1, title: 'Love Island', aliases: [], year: 2019, country: 'cze' };
  assert.equal(outcome(selectProgram(identity, [czechLoveIsland()])), 'year-mismatch');
});

test('selectProgram leaves missing identity evidence (no year, no country) unbound', () => {
  const noYear: SeriesIdentity = { tvdbId: 1, title: 'Love Island', aliases: [], country: 'cze' };
  const noCountry: SeriesIdentity = { tvdbId: 1, title: 'Love Island', aliases: [], year: 2021 };
  assert.equal(outcome(selectProgram(noYear, [czechLoveIsland()])), 'identity-incomplete');
  assert.equal(outcome(selectProgram(noCountry, [czechLoveIsland()])), 'identity-incomplete');
});

test('selectProgram leaves an unrecognized candidate country unbound rather than guessing', () => {
  const candidates: ProgramMetadata[] = [
    { id: 'x', title: 'Love Island', aliases: [], year: 2021, countries: ['Narnia'] },
  ];
  assert.equal(outcome(selectProgram(loveIslandIdentity, candidates)), 'country-mismatch');
});

test('selectProgram stays unbound when multiple distinct Programs are equally eligible', () => {
  const candidates: ProgramMetadata[] = [
    czechLoveIsland(),
    { id: 'duplicate-listing', title: 'Love Island', aliases: [], year: 2021, countries: ['Česká republika'] },
  ];
  assert.equal(outcome(selectProgram(loveIslandIdentity, candidates)), 'ambiguous');
});

test('selectProgram dedupes consistent duplicate records for the same Program id', () => {
  assert.equal(outcome(selectProgram(loveIslandIdentity, [czechLoveIsland(), czechLoveIsland()])), czechLoveIsland().id);
});

test('selectProgram refuses conflicting duplicate records for the same Program id', () => {
  const first = czechLoveIsland();
  const conflicting: ProgramMetadata = { ...first, year: 2020 };
  assert.equal(outcome(selectProgram(loveIslandIdentity, [first, conflicting])), 'ambiguous');
});

test('selectProgram matches via an alias in a different alphabet/accent form', () => {
  const identity: SeriesIdentity = {
    tvdbId: 1,
    title: 'Some International Title',
    aliases: ['Love Island Česko & Slovensko'],
    year: 2021,
    country: 'cze',
  };
  const candidates: ProgramMetadata[] = [czechLoveIsland()];
  assert.equal(outcome(selectProgram(identity, candidates)), czechLoveIsland().id);
});
