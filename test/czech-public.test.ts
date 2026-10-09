import test from 'node:test';
import assert from 'node:assert/strict';
import { createCeskaTelevizeProvider } from '../src/providers/czech-public-ceskatelevize.ts';
import { searchCatalogue } from '../src/catalogue.ts';

test('ČT movie searches use the production year, not the IDEC year or a sequel', async t => {
  const films = [
    { id: '1099641378', code: 'andel-pane', title: 'Anděl Páně', year: '2005', idec: '20455211500' },
    { id: '10792423524', code: 'andel-pane-2', title: 'Anděl Páně 2', year: '2016', idec: '21551313003' },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.ceskatelevize.cz/graphql/') {
      const request = JSON.parse(String(init?.body));
      if (request.operationName === 'SearchShows') {
        const items = films.filter(film => film.title.includes(request.variables.search));
        return Response.json({ data: { searchShows: { items, totalCount: items.length } } });
      }
      if (request.operationName === 'GetEpisodes') {
        const film = films.find(film => film.idec === request.variables.idec)!;
        return Response.json({ data: { episodesPreviewFind: { totalCount: 1, items: [{ id: film.idec, title: film.title, playable: true }] } } });
      }
    }
    const film = films.find(film => url === `https://www.ceskatelevize.cz/porady/${film.id}-${film.code}/`);
    if (film) return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { show: { idec: film.idec, year: film.year, seasons: [] } } } } })}</script>`);
    throw new Error(`Unexpected request: ${url}`);
  });
  const provider = createCeskaTelevizeProvider({ enabled: true })!;
  const releases = await searchCatalogue(provider, { q: 'Anděl Páně 2005', kind: 'movie', limit: 10, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(release => ({ title: release.title, year: release.year, url: release.url })), [{
    title: 'Anděl Páně', year: 2005,
    url: 'https://www.ceskatelevize.cz/porady/1099641378-andel-pane/20455211500/',
  }]);
});

test('each ČT episode plays its own IDEC, and episodes that cannot be played are not listed', async t => {
  const episodes = [
    { id: '21056214001', title: 'Díl 1', playable: true },
    { id: '21056214002', title: 'Díl 2', playable: false },
    { id: '21056214003', title: 'Díl 3', playable: true },
  ];
  const playlists: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.ceskatelevize.cz/graphql/') {
      const request = JSON.parse(String(init?.body));
      if (request.operationName === 'SearchShows') {
        return Response.json({ data: { searchShows: { items: [{ id: '1234', code: 'most', title: 'Most!' }], totalCount: 1 } } });
      }
      if (request.operationName === 'GetEpisodes') {
        assert.equal(request.variables.idec, '21056214000', 'episodes are listed by the show IDEC');
        const items = episodes.slice(request.variables.offset, request.variables.offset + request.variables.limit);
        return Response.json({ data: { episodesPreviewFind: { totalCount: episodes.length, items } } });
      }
    }
    if (url === 'https://www.ceskatelevize.cz/porady/1234-most/') {
      return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { show: { idec: '21056214000', seasons: [] } } } } })}</script>`);
    }
    if (url.startsWith('https://api.ceskatelevize.cz/video/v1/playlist-vod/v1/')) {
      playlists.push(/external\/(\d+)/.exec(url)![1]!);
      return Response.json({ streams: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const provider = createCeskaTelevizeProvider({ enabled: true })!;
  const releases = await searchCatalogue(provider, { q: 'Most', kind: 'tv', limit: 10, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(release => [release.title, release.episode]), [['Díl 3', 3], ['Díl 1', 1]]);
  for (const release of releases) await provider.resolve(release, new AbortController().signal);
  assert.deepEqual(playlists, ['21056214003', '21056214001']);

  // Without seasons upstream the show is one season: Sonarr's S01E03 is its third episode.
  const exact = await searchCatalogue(provider, { q: 'Most', kind: 'tv', season: 1, episode: 3, limit: 10, offset: 0 }, new AbortController().signal);
  assert.deepEqual(exact.map(release => [release.title, release.season, release.episode]), [['Díl 3', 1, 3]]);
  const whole = await searchCatalogue(provider, { q: 'Most', kind: 'tv', season: 1, limit: 10, offset: 0 }, new AbortController().signal);
  assert.deepEqual(whole.map(release => [release.title, release.season, release.episode]), [['Díl 3', 1, 3], ['Díl 1', 1, 1]]);
  assert.deepEqual(await searchCatalogue(provider, { q: 'Most', kind: 'tv', season: 2, episode: 1, limit: 10, offset: 0 }, new AbortController().signal), []);
});
