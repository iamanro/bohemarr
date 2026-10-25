import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PrimaIndex, type IndexedProgram } from '../src/providers/prima-index.ts';

const root = 'https://www.iprima.cz';
const signal = new AbortController().signal;
const HOUR = 60 * 60 * 1000;

interface Listing {
  uri: string;
  lastmod: string;
}

/** A fake iPrima: mutable sitemaps and page titles, counting sitemap and page requests. */
function iprima(t: TestContext) {
  const site = {
    series: [] as Listing[],
    movies: [] as Listing[],
    titles: new Map<string, string>(),
    sitemapRequests: 0,
    pageRequests: [] as string[],
  };
  const sitemap = (entries: Listing[]) =>
    `<urlset>${entries.map(e => `<url><loc>${e.uri}</loc><lastmod>${e.lastmod}</lastmod></url>`).join('')}</urlset>`;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${root}/sitemap-series.xml`) {
      site.sitemapRequests++;
      return new Response(sitemap(site.series));
    }
    if (url === `${root}/sitemap-movie.xml`) return new Response(sitemap(site.movies));
    site.pageRequests.push(url);
    const title = site.titles.get(url);
    if (title === undefined) return new Response('not found', { status: 404 });
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${'x'.repeat(100_000)}</body></html>`,
    );
  });
  return site;
}

async function list(index: PrimaIndex): Promise<IndexedProgram[]> {
  return Array.fromAsync(index.programs(signal));
}

test('the first listing reads the sitemaps; titles come from the pages in the background', async t => {
  const site = iprima(t);
  site.series.push({ uri: `${root}/serialy/ano-sefe`, lastmod: '2026-09-01T00:00:00+00:00' });
  site.movies.push({ uri: `${root}/filmy/tata-je-doma`, lastmod: '2026-09-20T00:00:00+00:00' });
  site.titles.set(`${root}/serialy/ano-sefe`, 'Ano, šéfe!  online ke zhlédnutí | prima+');
  site.titles.set(`${root}/filmy/tata-je-doma`, 'Táta je doma (2015) online – celý film ke zhlédnutí | prima+');
  using database = new DatabaseSync(':memory:');
  const index = new PrimaIndex(database, { pause: async () => {} });
  t.after(() => index.close());

  // Most recently changed first; names come from the URL until the page titles are read.
  assert.deepEqual(await list(index), [
    { uri: `${root}/filmy/tata-je-doma`, kind: 'movie', title: 'tata je doma', titled: false },
    { uri: `${root}/serialy/ano-sefe`, kind: 'tv', title: 'ano sefe', titled: false },
  ]);
  await index.idle();
  assert.deepEqual(
    (await list(index)).map(p => [p.title, p.titled]),
    [
      ['Táta je doma', true],
      ['Ano, šéfe!', true],
    ],
  );
});

test('page titles keep entities decoded and names that contain "online"', async t => {
  const site = iprima(t);
  site.series.push({ uri: `${root}/serialy/tom-a-jerry`, lastmod: '2026-09-02T00:00:00+00:00' });
  site.movies.push({ uri: `${root}/filmy/lov-online-predatoru`, lastmod: '2026-09-01T00:00:00+00:00' });
  site.titles.set(`${root}/serialy/tom-a-jerry`, 'Tom &amp; Jerry online ke zhlédnutí | prima+');
  site.titles.set(`${root}/filmy/lov-online-predatoru`, 'Lov online predátorů (2024) online – celý film ke zhlédnutí | prima+');
  using database = new DatabaseSync(':memory:');
  const index = new PrimaIndex(database, { pause: async () => {} });
  t.after(() => index.close());
  await list(index);
  await index.idle();
  assert.deepEqual(
    (await list(index)).map(p => p.title),
    ['Tom & Jerry', 'Lov online predátorů'],
  );
});

test('the index is served from SQLite until it is six hours old, then refreshed', async t => {
  const site = iprima(t);
  const first = { uri: `${root}/serialy/first`, lastmod: '2026-09-01T00:00:00+00:00' };
  site.series.push(first);
  site.titles.set(first.uri, 'First online ke zhlédnutí | prima+');
  let now = 0;
  using database = new DatabaseSync(':memory:');
  const index = new PrimaIndex(database, { now: () => now, pause: async () => {} });
  t.after(() => index.close());
  await list(index);
  await index.idle();

  // The programme is replaced upstream; within six hours the stored listing is still served.
  site.series.splice(0, 1, { uri: `${root}/serialy/second`, lastmod: '2026-09-02T00:00:00+00:00' });
  site.titles.set(`${root}/serialy/second`, 'Second online ke zhlédnutí | prima+');
  now = 6 * HOUR - 1;
  assert.deepEqual(
    (await list(index)).map(p => p.title),
    ['First'],
  );
  assert.equal(site.sitemapRequests, 1);

  // Once stale, the listing is still answered immediately while the refresh runs behind it.
  now = 6 * HOUR;
  assert.deepEqual(
    (await list(index)).map(p => p.title),
    ['First'],
  );
  await index.idle();
  assert.deepEqual(
    (await list(index)).map(p => p.title),
    ['Second'],
  );
  assert.equal(site.sitemapRequests, 2);
});

test('a changed lastmod re-reads only that title; unchanged pages are not requested again', async t => {
  const site = iprima(t);
  const renamed = { uri: `${root}/serialy/renamed`, lastmod: '2026-09-01T00:00:00+00:00' };
  const stable = { uri: `${root}/serialy/stable`, lastmod: '2026-08-01T00:00:00+00:00' };
  site.series.push(renamed, stable);
  site.titles.set(renamed.uri, 'Old name online ke zhlédnutí | prima+');
  site.titles.set(stable.uri, 'Stable online ke zhlédnutí | prima+');
  let now = 0;
  using database = new DatabaseSync(':memory:');
  const index = new PrimaIndex(database, { now: () => now, pause: async () => {} });
  t.after(() => index.close());
  await list(index);
  await index.idle();
  site.pageRequests.length = 0;

  renamed.lastmod = '2026-09-29T00:00:00+00:00';
  site.titles.set(renamed.uri, 'New name online ke zhlédnutí | prima+');
  now = 6 * HOUR;
  await list(index);
  await index.idle();
  assert.deepEqual(site.pageRequests, [renamed.uri]);
  assert.deepEqual(
    (await list(index)).map(p => p.title),
    ['New name', 'Stable'],
  );
});

test('the index survives a restart, and titles that could not be read are retried by the next process', async t => {
  const site = iprima(t);
  const missing = { uri: `${root}/serialy/flaky`, lastmod: '2026-09-01T00:00:00+00:00' };
  site.series.push(missing);
  using database = new DatabaseSync(':memory:');
  const first = new PrimaIndex(database, { pause: async () => {} });
  await list(first);
  await first.close();
  const restarted = new PrimaIndex(database, { pause: async () => {} });
  assert.deepEqual(
    (await list(restarted)).map(p => p.titled),
    [false],
  );
  await restarted.close(); // its background title pass must not outlive the database

  site.titles.set(missing.uri, 'Flaky online ke zhlédnutí | prima+');
  const second = new PrimaIndex(database, { pause: async () => {} });
  t.after(() => second.close());
  await list(second);
  await second.idle();
  assert.equal(site.sitemapRequests, 1, 'a fresh stored index is not re-fetched after a restart');
  assert.deepEqual(
    (await list(second)).map(p => p.title),
    ['Flaky'],
  );
});

test('titles are read one page at a time with a pause between pages, and a CDN refusal stops the pass', async t => {
  const site = iprima(t);
  for (const name of ['a', 'b', 'c']) {
    site.series.push({ uri: `${root}/serialy/${name}`, lastmod: `2026-09-0${name.charCodeAt(0) - 96}T00:00:00+00:00` });
    site.titles.set(`${root}/serialy/${name}`, `${name.toUpperCase()} online ke zhlédnutí | prima+`);
  }
  const events: string[] = [];
  const fetchMock = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/serialy/')) events.push(`GET ${url.slice(url.lastIndexOf('/') + 1)}`);
    // The CDN starts refusing after the first page.
    if (url.endsWith('/serialy/b')) return new Response('blocked', { status: 403 });
    return fetchMock(input);
  });
  using database = new DatabaseSync(':memory:');
  const index = new PrimaIndex(database, {
    pause: async ms => {
      events.push(`pause ${ms}`);
    },
  });
  t.after(() => index.close());
  await list(index);
  await index.idle();
  assert.deepEqual(events, ['GET c', 'pause 1000', 'GET b']);
  assert.deepEqual(
    (await list(index)).map(p => [p.title, p.titled]),
    [
      ['C', true],
      ['b', false],
      ['a', false],
    ],
  );
});

test('the first listing fails when iPrima lists no programmes, rather than serving an empty catalogue', async t => {
  iprima(t);
  using database = new DatabaseSync(':memory:');
  const index = new PrimaIndex(database, { pause: async () => {} });
  t.after(() => index.close());
  await assert.rejects(list(index), /list no programmes/);
});
