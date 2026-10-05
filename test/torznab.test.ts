import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { Store } from '../src/store.ts';
import { Indexer } from '../src/indexer.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import type { Config, Provider, Release, SeriesIdentity } from '../src/types.ts';
import { fakeCatalogue } from './fake-catalogue.ts';

const identity: SeriesIdentity = { tvdbId: 12345, title: 'Show Name', aliases: [], year: 2020, country: 'US' };
const config: Config = {
  host: '127.0.0.1', port: 8787, apiKey: 'a'.repeat(64), publicUrl: 'http://localhost:8787',
  dataDir: '/unused', downloadsDir: '/unused', concurrency: 1,
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'https://example.test/wv/',
  categories: ['tv', 'movies'], providers: {}, arrs: [],
};

function indexer(lookups: number[] = []) {
  const store = new Store(':memory:');
  const provider: Provider = {
    id: 'oneplay', name: 'Oneplay', resolve: async () => [],
    seriesCandidates: async () => [{ id: 'src', title: 'Show Name', aliases: [], year: 2020, countries: ['US'] }],
    catalogue: fakeCatalogue(bound => bound === 'src' ? [{
      id: 'ep-1', provider: 'oneplay', title: 'Pilot', series: 'Provider Title', kind: 'tv', season: 1, episode: 1,
      url: 'https://oneplay.test/original/stream.mp4', programId: 'src',
    }] : []),
  };
  const bindings = new SeriesBindings(store.database, async tvdbId => { lookups.push(tvdbId); return identity; });
  return { store, provider, indexer: new Indexer(config, store, new Map([[provider.id, provider]]), bindings) };
}

test('a tvdbid search is advertised and answered with the canonical title, tvdbid attribute and original source URL', async () => {
  const { store, indexer: torznab } = indexer();
  using dispose = store;
  assert.match(torznab.capabilities(), /supportedParams="q,season,ep,tvdbid"/);
  const feed = await torznab.search({ t: 'tvsearch', q: '', tvdbid: '12345' }, new AbortController().signal);
  assert.match(feed, /<torznab:attr name="tvdbid" value="12345"\/>/);
  assert.match(feed, /<comments>https:\/\/oneplay\.test\/original\/stream\.mp4<\/comments>/);
  // The Task descriptor names the stamped Release.
  const stamped = torznab.parseTaskDescriptor(torznab.taskDescriptor('ep-1').content).release;
  assert.equal(stamped.tvdbId, 12345);
  assert.equal(stamped.series, 'Show Name');
});

test('Torznab publishes highest available video with Czech audio and an honest AV size estimate', async t => {
  let uhdAvailable = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const response = new Response(`<MPD type="static"><Period duration="PT8S">
      <AdaptationSet contentType="video"><SegmentTemplate media="v-$RepresentationID$-$Number$.m4s" duration="2"/>
        <Representation id="720" height="720" bandwidth="12000000"/>
        <Representation id="1080-low" height="1080" bandwidth="6000000"/>
        <Representation id="1080-high" height="1080" bandwidth="8000000"/>
        ${uhdAvailable ? '<Representation id="2160" height="2160" bandwidth="16000000"/>' : ''}
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="en"><Representation id="en" bandwidth="512000"><SegmentTemplate media="en-$Number$.m4s" duration="2"/></Representation></AdaptationSet>
      <AdaptationSet contentType="audio" lang="cs-CZ"><Representation id="cz" bandwidth="128000"><SegmentTemplate media="cz-$Number$.m4s" duration="2"/></Representation></AdaptationSet>
    </Period></MPD>`);
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  });
  const { store, provider, indexer: torznab } = indexer();
  using dispose = store;
  provider.resolve = async () => [{ url: 'https://cdn.example.test/master.mpd?token=private-only', type: 'dash', headers: { 'X-Stream-Token': 'private-only' } }];
  const params = { t: 'tvsearch', tvdbid: '12345', season: '1', ep: '1' };
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: name => name === 'torznab:attr' });
  const item = parser.parse(await torznab.search(params, new AbortController().signal)).rss.channel.item;
  assert.equal(item.title, 'Show Name S01E01 (CZ)[WEB-DL][1080p]');
  assert.equal(item.enclosure['@_length'], '8128000');
  assert.equal(item['torznab:attr'].find((attr: Record<string, string>) => attr['@_name'] === 'size')['@_value'], '8128000');
  assert.match(item.description, /estimated/i);
  const descriptor = torznab.taskDescriptor('ep-1');
  assert.equal(descriptor.name, 'Show Name S01E01 (CZ)[WEB-DL][1080p].torrent');
  assert.doesNotMatch(JSON.stringify(torznab.parseTaskDescriptor(descriptor.content)), /private-only|X-Stream-Token|master\.mpd/);

  // A durable episode URL can acquire a higher-quality rendition after the first search.
  uhdAvailable = true;
  const updated = parser.parse(await torznab.search(params, new AbortController().signal)).rss.channel.item;
  assert.equal(updated.title, 'Show Name S01E01 (CZ)[WEB-DL][2160p]');
  assert.equal(updated.enclosure['@_length'], '16128000');
});

test('movie searches advertise and return Radarr TMDB IDs', async () => {
  const store = new Store(':memory:');
  using dispose = store;
  store.database.exec(`CREATE TABLE catalogue_tmdb_mappings (
    provider TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
    tmdb_kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, status TEXT NOT NULL
  )`);
  store.database.prepare('INSERT INTO catalogue_tmdb_mappings VALUES (?, ?, ?, ?, ?, ?)')
    .run('direct', 'movie-source', 'movie', 'movie', 1032863, 'matched');
  const movie: Release = {
    id: 'movie-1', provider: 'direct', title: 'Film', kind: 'movie', year: 2026,
    url: 'https://direct.test/film.mp4', programId: 'movie-source',
  };
  const provider: Provider = {
    id: 'direct', name: 'Direct', resolve: async () => [],
    catalogue: fakeCatalogue(bound => bound === 'movie-source' ? [movie] : []),
  };
  const torznab = new Indexer(config, store, new Map([[provider.id, provider]]), new SeriesBindings(store.database));

  assert.match(torznab.capabilities(), /movie-search available="yes" supportedParams="q,tmdbid"/);
  const feed = await torznab.search({ t: 'movie', q: 'Wrong title', tmdbid: '1032863' }, new AbortController().signal);
  assert.match(feed, /<torznab:attr name="tmdbid" value="1032863"\/>/);
  for (const bad of ['0', '-5', '1.5', 'abc', '1e9999999']) {
    await assert.rejects(torznab.search({ t: 'movie', q: 'Film', tmdbid: bad }, new AbortController().signal));
  }
  await assert.rejects(torznab.search({ t: 'tvsearch', q: 'Film', tmdbid: '1032863' }, new AbortController().signal), /Invalid tmdbid/);
});

test('a TMDB movie binding selects a static catalogue entry', async () => {
  const store = new Store(':memory:');
  using dispose = store;
  store.database.exec(`CREATE TABLE catalogue_tmdb_mappings (
    provider TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
    tmdb_kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, status TEXT NOT NULL
  )`);
  store.database.prepare('INSERT INTO catalogue_tmdb_mappings VALUES (?, ?, ?, ?, ?, ?)')
    .run('direct', 'movie-1', 'movie', 'movie', 1032863, 'matched');
  const movie: Release = { id: 'movie-1', provider: 'direct', title: 'Mapped Film', kind: 'movie', url: 'https://direct.test/film.mp4' };
  const provider: Provider = {
    id: 'direct', name: 'Direct', entries: [movie], resolve: async () => [],
    catalogue: fakeCatalogue(() => [movie]),
  };
  const torznab = new Indexer(config, store, new Map([[provider.id, provider]]), new SeriesBindings(store.database));

  const feed = await torznab.search({ t: 'movie', q: 'Wrong title', tmdbid: '1032863' }, new AbortController().signal);
  assert.match(feed, /Mapped Film/);
});

test('invalid tvdbid values are rejected before any TVDB lookup', async () => {
  const lookups: number[] = [];
  const { store, indexer: torznab } = indexer(lookups);
  using dispose = store;
  for (const bad of ['0', '-5', '1.5', 'abc', '1e9999999']) {
    await assert.rejects(torznab.search({ t: 'tvsearch', q: '', tvdbid: bad }, new AbortController().signal));
  }
  await assert.rejects(torznab.search({ t: 'search', q: '', tvdbid: '12345' }, new AbortController().signal), /Invalid tvdbid/);
  assert.deepEqual(lookups, []);
});

test('RSS lists the newest Releases of series Sonarr searched by TVDB ID, dated when first listed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-03T18:00:00Z') });
  const store = new Store(':memory:');
  using dispose = store;
  const episode = (number: number): Release => ({
    id: `ep-${number}`, provider: 'oneplay', title: `Episode ${number}`, series: 'Provider Title', kind: 'tv',
    season: 1, episode: number, url: `https://oneplay.test/ep-${number}`, programId: 'src',
  });
  let published = [episode(2), episode(1)];
  const browsed: Release = { id: 'other', provider: 'oneplay', title: 'Other', series: 'Unrelated', kind: 'tv', season: 1, episode: 1, url: 'https://oneplay.test/other' };
  const provider: Provider = {
    id: 'oneplay', name: 'Oneplay', resolve: async () => [],
    seriesCandidates: async () => [{ id: 'src', title: 'Show Name', aliases: [], year: 2020, countries: ['US'] }],
    catalogue: fakeCatalogue(bound => bound === 'src' ? published : [browsed]),
  };
  const torznab = new Indexer(config, store, new Map([[provider.id, provider]]), new SeriesBindings(store.database, async () => identity));
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: name => name === 'item' || name === 'torznab:attr' });
  const rss = async (offset = 0) => (parser.parse(await torznab.search({ t: 'tvsearch', cat: '5000', extended: '1', offset: String(offset) }, new AbortController().signal)).rss.channel.item ?? [])
    .map((item: Record<string, any>) => ({ title: item.title, pubDate: item.pubDate,
      tvdbId: item['torznab:attr'].find((attr: Record<string, string>) => attr['@_name'] === 'tvdbid')?.['@_value'] }));

  // Nothing is watched yet: the feed is the catalogue browse page, so Sonarr can still save the indexer.
  assert.deepEqual((await rss()).map((item: { title: string }) => item.title), ['Unrelated S01E01[WEB-DL]']);

  await torznab.search({ t: 'tvsearch', tvdbid: '12345', season: '1', ep: '1' }, new AbortController().signal);
  t.mock.timers.tick(11 * 60 * 1000);
  const first = await rss();
  assert.deepEqual(first, [
    { title: 'Show Name S01E02[WEB-DL]', pubDate: 'Sat, 03 Oct 2026 18:11:00 GMT', tvdbId: '12345' },
    { title: 'Show Name S01E01[WEB-DL]', pubDate: 'Sat, 03 Oct 2026 18:11:00 GMT', tvdbId: '12345' },
  ]);
  // The Task descriptor of an RSS item names the stamped Release, as Sonarr's grab requires.
  assert.equal(torznab.parseTaskDescriptor(torznab.taskDescriptor('ep-2').content).release.tvdbId, 12345);

  // A newly available episode leads the next listing; earlier Releases keep their first-listed date.
  published = [episode(3), ...published];
  t.mock.timers.tick(5 * 60 * 1000);
  assert.equal((await rss()).length, 2, 'one listing serves a whole RSS sync');
  t.mock.timers.tick(6 * 60 * 1000);
  assert.deepEqual((await rss()).map((item: { title: string; pubDate: string }) => [item.title, item.pubDate]), [
    ['Show Name S01E03[WEB-DL]', 'Sat, 03 Oct 2026 18:22:00 GMT'],
    ['Show Name S01E02[WEB-DL]', 'Sat, 03 Oct 2026 18:11:00 GMT'],
    ['Show Name S01E01[WEB-DL]', 'Sat, 03 Oct 2026 18:11:00 GMT'],
  ]);
});

test('series searched by TVDB ID before the RSS feed existed are watched after the upgrade', async () => {
  const store = new Store(':memory:');
  using dispose = store;
  const { provider } = indexer();
  const bindings = new SeriesBindings(store.database, async () => identity);
  await bindings.search(provider, { q: '', kind: 'tv', season: 1, episode: 1, limit: 5, offset: 0 }, identity, new AbortController().signal);
  const torznab = new Indexer(config, store, new Map([[provider.id, provider]]), bindings);
  const feed = await torznab.search({ t: 'tvsearch', cat: '5000' }, new AbortController().signal);
  assert.match(feed, /<title>Show Name S01E01\[WEB-DL\]<\/title>/);
  assert.match(feed, /<torznab:attr name="tvdbid" value="12345"\/>/);
});
