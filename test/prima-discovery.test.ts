import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPrimaProviders } from '../src/providers/prima.ts';
import { searchCatalogue } from '../src/catalogue.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import { Store } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import type { SeriesIdentity } from '../src/types.ts';

const root = 'https://www.iprima.cz';
const czechUri = `${root}/serialy/ano-sefe`;
const foreignUri = `${root}/serialy/ano-sefe-s-gordonem-ramsaym`;
const identity: SeriesIdentity = { tvdbId: 252180, title: 'Ano, šéfe!', aliases: [], year: 2009, country: 'cze' };

function nuxtPage(title: Record<string, unknown>, field: 'title' | 'content' = 'title'): string {
  const table: unknown[] = [];
  function reference(value: unknown): number {
    const index = table.length;
    table.push(null);
    table[index] = Array.isArray(value) ? value.map(reference)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item)])) : value;
    return index;
  }
  reference({ data: { page: { [field]: title } } });
  return `<script id="__NUXT_DATA__">${JSON.stringify(table)}</script>`;
}

function sitemap(entries: Array<{ uri: string; lastmod: string }>): string {
  return `<urlset>${entries.map(({ uri, lastmod }) => `<url><loc>${uri}</loc><lastmod>${lastmod}</lastmod></url>`).join('')}</urlset>`;
}

/** `beforeRequest` sees every request; `init.headers` is set only on authenticated Prima+ requests. */
function catalogue(
  t: TestContext,
  beforeRequest?: (url: string, init?: RequestInit) => void,
  rpcResponse?: (request: { method: string; params: Record<string, unknown> }) => Response | undefined,
) {
  let logins = 0;
  // The foreign edition changed more recently, so the index lists it first.
  const programs = [
    { uri: foreignUri, title: 'Ano, šéfe s Gordonem Ramsaym USA', type: 'tv_series', id: 'foreign', year: 2007, countries: [{ label: 'USA' }], lastmod: '2026-09-28T00:00:00+00:00' },
    { uri: czechUri, title: 'Ano, šéfe!', type: 'tv_series', id: 'czech', year: 2009, countries: [{ label: 'ČR' }], lastmod: '2026-09-01T00:00:00+00:00' },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    beforeRequest?.(url, init);
    if (url === `${root}/sitemap-series.xml`) return new Response(sitemap(programs));
    if (url === `${root}/sitemap-movie.xml`) return new Response(sitemap([]));
    if (url === 'https://ucet.iprima.cz/api/session/create') {
      logins++;
      return Response.json({ sessionId: `session-${logins}`, accessToken: { value: `test-token-${logins}` } });
    }
    if (url === `${root}/profily`) {
      return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
        { state: 1 }, { profiles: 2 }, [3], { ulid: 4, name: 5 }, 'profile', 'Default',
      ])}</script><script>window.__NUXT__.config={public:{profileTokenSecret:'test-signing-key'}};</script>`);
    }
    if (url === 'https://gateway-api.prod.iprima.cz/json-rpc/') {
      const rpc = JSON.parse(String(init?.body));
      const override = rpcResponse?.(rpc);
      if (override) return override;
      if (rpc.method === 'vdm.frontend.season.list.hbbtv') {
        return Response.json({ result: { data: [{ id: `${rpc.params.id}-season`, seasonNumber: 1 }] } });
      }
      if (rpc.method === 'vdm.frontend.episodes.list.hbbtv') {
        const program = programs.find(p => `${p.id}-season` === rpc.params.id)!;
        return Response.json({ result: { data: { seasonNumber: 1, episodes: [{
          title: program.id === 'czech' ? 'Restaurant Hrádek (Litoměřice)' : 'US restaurant',
          additionals: { episodeNumber: 1, webUrl: `${program.uri}/season-1/episode-1` }, distribution: {},
        }] } } });
      }
      throw new Error(`Unexpected RPC ${rpc.method}`);
    }
    const program = programs.find(p => p.uri === url);
    if (program) return new Response(`<head><title>${program.title} online ke zhlédnutí | prima+</title></head>${nuxtPage({ ...program, type: 'series' })}`);
    if (url.startsWith('https://zoom.iprima.cz/snippet/') || url === 'https://cnn.iprima.cz/porady') return new Response('');
    throw new Error(`Unexpected request ${url}`);
  });
  const database = new DatabaseSync(':memory:');
  const provider = createPrimaProviders({ iprima: { enabled: true, username: 'test@example.invalid', password: 'test-password' } }, database)[0]!;
  t.after(async () => { await provider.close?.(); database.close(); });
  return provider;
}

test('Prima movie searches retain the real production year and exclude the sequel', async t => {
  const films = [
    { uri: `${root}/filmy/andel-pane`, title: 'Anděl Páně', id: 'original', year: 2005 },
    { uri: `${root}/filmy/andel-pane-2`, title: 'Anděl Páně 2', id: 'sequel', year: 2016 },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${root}/sitemap-series.xml`) return new Response(sitemap([]));
    if (url === `${root}/sitemap-movie.xml`) return new Response(sitemap(films.map(film => ({ uri: film.uri, lastmod: '2026-09-01T00:00:00+00:00' }))));
    const film = films.find(film => film.uri === url);
    if (film) return new Response(`<head><title>${film.title} online ke zhlédnutí | prima+</title></head>${nuxtPage({ id: film.id, title: film.title, type: 'movie', additionals: { year: film.year } }, 'content')}`);
    if (url.startsWith('https://zoom.iprima.cz/snippet/') || url === 'https://cnn.iprima.cz/porady') return new Response('');
    throw new Error(`Unexpected request ${url}`);
  });
  const database = new DatabaseSync(':memory:');
  const provider = createPrimaProviders({ iprima: { enabled: true, username: 'test@example.invalid', password: 'test-password' } }, database)[0]!;
  t.after(async () => { await provider.close?.(); database.close(); });
  const releases = await searchCatalogue(provider, { q: 'Anděl Páně 2005', kind: 'movie', limit: 10, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(release => ({ title: release.title, year: release.year, url: release.url })), [{ title: 'Anděl Páně', year: 2005, url: `${root}/filmy/andel-pane` }]);
});

for (const method of ['vdm.frontend.season.list.hbbtv', 'vdm.frontend.episodes.list.hbbtv']) {
  test(`Prima search renews a rejected account token during ${method}`, async t => {
    let expired = false;
    const provider = catalogue(t, undefined, request => {
      if (expired && request.method === method && request.params._accessToken === 'test-token-1') {
        return Response.json({ result: { error: { message: 'AccessToken is not valid.' } } });
      }
      return undefined;
    });
    const signal = new AbortController().signal;
    const query = { q: '', programId: czechUri, kind: 'tv' as const, season: 1, episode: 1, limit: 1, offset: 0 };
    await searchCatalogue(provider, query, signal);
    expired = true;
    const releases = await searchCatalogue(provider, query, signal);
    assert.deepEqual(releases.map(release => release.url), [`${czechUri}/season-1/episode-1`]);
  });
}

test('Prima search surfaces a repeatedly rejected token after one new login', async t => {
  let logins = 0;
  const provider = catalogue(t, url => {
    if (url === 'https://ucet.iprima.cz/api/session/create') logins++;
  }, () => Response.json({ result: { error: { message: 'AccessToken is not valid.' } } }));
  await assert.rejects(searchCatalogue(provider,
    { q: '', programId: czechUri, kind: 'tv', limit: 1, offset: 0 }, new AbortController().signal), /AccessToken is not valid/);
  assert.equal(logins, 2);
});

test('Prima search does not replace an account session for an unrelated RPC error', async t => {
  let logins = 0;
  const provider = catalogue(t, url => {
    if (url === 'https://ucet.iprima.cz/api/session/create') logins++;
  }, () => Response.json({ result: { error: { message: 'Programme is unavailable.' } } }));
  await assert.rejects(searchCatalogue(provider,
    { q: '', programId: czechUri, kind: 'tv', limit: 1, offset: 0 }, new AbortController().signal), /Programme is unavailable/);
  assert.equal(logins, 1);
});

test('Prima exact show match is not hidden by a larger foreign edition before pagination', async t => {
  const provider = catalogue(t);
  const releases = await searchCatalogue(provider, { q: 'Ano, šéfe!', kind: 'tv', limit: 1, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(r => r.url), [`${czechUri}/season-1/episode-1`]);
  const next = await searchCatalogue(provider, { q: 'Ano, šéfe!', kind: 'tv', limit: 1, offset: 1 }, new AbortController().signal);
  assert.deepEqual(next.map(r => r.url), [`${foreignUri}/season-1/episode-1`]);
});

test('Prima browse returns a full requested page without waiting for unrelated programmes', async t => {
  const controller = new AbortController();
  const provider = catalogue(t, (url, init) => {
    if (url === czechUri && init?.headers) {
      controller.abort(new Error('Request deadline exceeded while loading the next programme'));
      controller.signal.throwIfAborted();
    }
  });
  const releases = await searchCatalogue(provider, { q: '', kind: 'tv', limit: 1, offset: 0 }, controller.signal);
  assert.deepEqual(releases.map(r => r.url), [`${foreignUri}/season-1/episode-1`]);
});

test('Prima browse retains a partial final batch and applies the requested offset in catalogue order', async t => {
  const provider = catalogue(t);
  const signal = new AbortController().signal;
  const all = await searchCatalogue(provider, { q: '', kind: 'tv', limit: 10, offset: 0 }, signal);
  assert.deepEqual(all.map(r => r.url), [`${foreignUri}/season-1/episode-1`, `${czechUri}/season-1/episode-1`]);
  const page = await searchCatalogue(provider, { q: '', kind: 'tv', limit: 1, offset: 1 }, signal);
  assert.deepEqual(page.map(r => r.url), [`${czechUri}/season-1/episode-1`]);
});

test('Prima binds a TVDB series by programme year and Czech origin, then expands the bound programme only', async t => {
  const provider = catalogue(t);
  const signal = new AbortController().signal;
  const query = { q: '', kind: 'tv' as const, season: 1, episode: 1, limit: 20, offset: 0 };
  using store = new Store(':memory:');
  const bindings = new SeriesBindings(store.database);
  const costaRica = await bindings.search(provider, query, { ...identity, tvdbId: identity.tvdbId + 1, country: 'CRI' }, signal);
  assert.deepEqual(costaRica, { releases: [], unbound: 'country-mismatch' }, 'ČR is not ISO CR (Costa Rica)');

  const { releases, unbound } = await bindings.search(provider, query, identity, signal);
  assert.equal(unbound, undefined);
  assert.deepEqual(releases.map(r => ({ url: r.url, program: r.programId, season: r.season, episode: r.episode, tvdbId: r.tvdbId })), [
    { url: `${czechUri}/season-1/episode-1`, program: czechUri, season: 1, episode: 1, tvdbId: identity.tvdbId },
  ]);
});

test('CNN Prima lists a programme newest first, although offset 0 is read last', async t => {
  const page = (dates: string[]) => dates.map(date =>
    `<article class="molecule-video"><h3><a href="/videa/${date.replaceAll('. ', '-')}">Byznys</a></h3><div><span>${date}</span></div></article>`).join('');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${root}/sitemap-series.xml` || url === `${root}/sitemap-movie.xml`) return new Response(sitemap([]));
    if (url.startsWith('https://zoom.iprima.cz/snippet/')) return new Response('');
    if (url === 'https://cnn.iprima.cz/porady') return new Response('<div class="programmes-list"><div class="molecule-programme-title"><a href="/porady/byznys">Byznys</a></div></div>');
    if (url === 'https://cnn.iprima.cz/porady/byznys') return new Response(`<script>new InfiniteCarousel(el, '/snippet/episode/limit/offset/77', {})</script>`);
    // Offset 0 holds the newest episodes, each page newest first.
    if (url === 'https://cnn.iprima.cz/snippet/episode/64/0/77') return new Response(page(['19. 12. 2024', '12. 12. 2024']));
    if (url === 'https://cnn.iprima.cz/snippet/episode/64/64/77') return new Response(page(['15. 3. 2023', '8. 3. 2023']));
    if (url.startsWith('https://cnn.iprima.cz/snippet/episode/64/')) return new Response('');
    throw new Error(`Unexpected request ${url}`);
  });
  const database = new DatabaseSync(':memory:');
  const provider = createPrimaProviders({ iprima: { enabled: true } }, database)[0]!;
  t.after(async () => { await provider.close?.(); database.close(); });
  const releases = await searchCatalogue(provider, { q: 'Byznys', kind: 'tv', limit: 2, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(release => release.url), ['https://cnn.iprima.cz/videa/19-12-2024', 'https://cnn.iprima.cz/videa/12-12-2024']);
});
