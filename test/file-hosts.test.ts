import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFileHostProviders,
  fileRelease,
  md5crypt,
  parsePrehrajtoSearch,
  parsePrehrajtoSources,
} from '../src/providers/file-hosts.ts';
import { searchCatalogue } from '../src/catalogue.ts';

const signal = new AbortController().signal;

test('md5crypt matches `openssl passwd -1`', () => {
  assert.equal(md5crypt('password', 'saltsalt'), '$1$saltsalt$qjXMvbEw8oaL.CzflDtaK/');
  assert.equal(md5crypt('hunter2', 'Ab3/x.Yz'), '$1$Ab3/x.Yz$.85bgPrVOJy38k276M3uv1');
});

test('a file name yields the episode, year, resolution and language of its Release', () => {
  const release = fileRelease('webshare', 'https://webshare.cz/#/file/abc', 'Most.S01E03.CZ.1080p.WEB-DL.mkv', { q: 'Most' }, 123);
  assert.deepEqual(release, {
    ...release,
    title: 'Most S01E03 CZ 1080p WEB-DL',
    series: 'Most',
    kind: 'tv',
    season: 1,
    episode: 3,
    height: 1080,
    language: 'CZ',
    size: 123,
  });
  assert.equal(fileRelease('webshare', 'u', 'Matrix (1999) 4K.mkv', { q: '' }).kind, 'movie');
  assert.equal(fileRelease('webshare', 'u', 'Matrix (1999) 4K.mkv', { q: '' }).height, 2160);
  assert.equal(fileRelease('webshare', 'u', 'Matrix (1999) 4K.mkv', { q: '' }).year, 1999);
});

test('Webshare: an episode search asks upstream for S01E03 and resolves anonymously without a token', async t => {
  const bodies: URLSearchParams[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push(init!.body as URLSearchParams);
    if (String(input) === 'https://webshare.cz/api/search/') {
      return new Response(
        '<response><status>OK</status><file><ident>a1</ident><name>Most.S01E03.mkv</name><size>10</size><password>0</password></file><file><ident>a2</ident><name>Most.S01E04.mkv</name><size>10</size><password>0</password></file></response>',
      );
    }
    if (String(input) === 'https://webshare.cz/api/file_link/')
      return new Response('<response><status>OK</status><link>https://dl.wsfiles.cz/x/Most.mkv</link></response>');
    if (String(input) === 'https://webshare.cz/api/file_info/')
      return new Response(
        '<response><status>OK</status><height>1080</height><audio><stream><language>CZE</language></stream></audio></response>',
      );
    throw new Error(`unexpected fetch: ${input}`);
  });
  const provider = createFileHostProviders({}).find(provider => provider.id === 'webshare')!;
  const releases = await searchCatalogue(provider, { q: 'Most', kind: 'tv', season: 1, episode: 3, limit: 10, offset: 0 }, signal);
  assert.equal(bodies[0]!.get('what'), 'Most S01E03');
  assert.deepEqual(
    releases.map(release => [release.url, release.episode]),
    [['https://webshare.cz/#/file/a1', 3]],
  );
  const sources = await provider.resolve(releases[0]!, signal);
  assert.equal(sources[0]!.url, 'https://dl.wsfiles.cz/x/Most.mkv');
  assert.deepEqual(
    [sources[0]!.height, sources[0]!.audioLanguage],
    [1080, 'CZE'],
    'file_info spares the inspection an ffprobe the free link cannot serve',
  );
  assert.equal(bodies[1]!.get('ident'), 'a1');
  assert.equal(bodies[1]!.has('wst'), false);
});

test('Přehraj.to: search hits carry the file size, and the player sources are read from the page', () => {
  const html = `<a class="video video--small video--link" href="/matrix-1999/85e1" title="Matrix (1999)">
    <div class="video__tag video__tag--size">2.68 GB</div><h3 class="video__title">Matrix (1999)</h3></a>`;
  const [release] = parsePrehrajtoSearch(html, { q: 'matrix', kind: 'movie' });
  assert.deepEqual(
    [release!.url, release!.year, release!.size, release!.sizeEstimated],
    ['https://prehrajto.cz/matrix-1999/85e1', 1999, 2877628088, true],
  );
  const sources = parsePrehrajtoSources(
    `var sources = [ { file: "https://cdn/a.mp4?x=1", label: '720p' } , { file: "https://cdn/b.mp4", label: '1080p' } ]; var tracks = [ { file: "https://cdn/sub.vtt", label: 'cs' } ];`,
  );
  assert.deepEqual(
    sources.map(source => [source.url, source.height]),
    [
      ['https://cdn/a.mp4?x=1', 720],
      ['https://cdn/b.mp4', 1080],
    ],
  );
});
