import { randomUUID } from 'node:crypto';
import { load as loadHtml } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { Catalogue, CatalogueQuery, MediaKind, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { fetchJson, fetchText, mediaType, releaseId } from './common.ts';

// Ported from sune.app.mediadown.media_engine.ceskatelevize.CeskaTelevizeEngine and
// sune.app.mediadown.drm_engine.ceskatelevize.CeskaTelevizeDRMEngine (Media Downloader).

const GRAPHQL_URL = 'https://api.ceskatelevize.cz/graphql/';
const REFERER = 'https://www.ceskatelevize.cz/';
const PLAYER_REFERER = 'https://player.ceskatelevize.cz/';
const PROGRAM_BASE = 'https://www.ceskatelevize.cz/porady/';
const VOD_ENDPOINT = 'https://api.ceskatelevize.cz/video/v1/playlist-vod/v1/';
const CLIENT_VERSION = '0.37.1';
// Same fixed Widevine proxy access token used by the upstream CeskaTelevizeDRMEngine.
const LICENSE_URL = 'https://ivys-wvproxy.o2tv.cz/license?access_token=c3RlcGFuLWEtb25kcmEtanNvdS1wcm9zdGUtbmVqbGVwc2k=';
const WIDEVINE_SCHEME_URN = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const MAX_ITEMS_PER_PAGE = 40; // The API returns "400 Bad request" for limit above 40.

// The 13 top-level category IDs the upstream engine walks to enumerate all shows.
const CATEGORIES = [3947, 3976, 4003, 4124, 4029, 4068, 4106, 4079, 4055, 4093, 4118, 4142, 4191];

const QUERY_CATEGORY = `query GetCategoryById($limit: PaginationAmount!, $offset: Int!, $categoryId: String!, $order: OrderByDirection, $orderBy: CategoryOrderByType) {
  showFindByGenre(limit: $limit, offset: $offset, categoryId: $categoryId, order: $order, orderBy: $orderBy) {
    items { id slug title __typename }
    totalCount
    __typename
  }
}`;

const QUERY_EPISODES = `query GetEpisodes($idec: String!, $seasonId: String, $limit: PaginationAmount!, $offset: Int!, $orderBy: EpisodeOrderByType!) {
  episodesPreviewFind(idec: $idec, seasonId: $seasonId, limit: $limit, offset: $offset, orderBy: $orderBy) {
    totalCount
    items { id playable title __typename }
    __typename
  }
}`;

// searchShows resolves to ShowCard (code/id/title only — it has no slug field, unlike the Show
// type used by showFindByGenre), same shape the upstream engine's QUERY_SEARCH_SHOWS fragment uses.
const QUERY_SEARCH_SHOWS = `query SearchShows($limit: PaginationAmount!, $offset: Int!, $search: String!, $onlyPlayable: Boolean) {
  searchShows(limit: $limit, offset: $offset, keyword: $search, onlyPlayable: $onlyPlayable) {
    totalCount
    items { code id title __typename }
    __typename
  }
}`;

interface CtShow { id: string; slug: string; title: string; code?: string }
interface CtSearchedShow { id: string; code: string; title: string }
interface CtEpisodeItem { id: string; playable: boolean; title: string }

// Boundary helper for navigating loosely-typed JSON (NEXT_DATA blobs, GraphQL payloads) without
// scattering inline `as` shape assumptions through the traversal call sites.
function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function graphql<T>(operationName: string, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  return fetchJson<T>(GRAPHQL_URL, signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: REFERER },
    body: JSON.stringify({ operationName, query, variables }),
  });
}

async function getProgramsByCategory(categoryId: number, offset: number, limit: number, signal: AbortSignal) {
  const json = await graphql<{ data: { showFindByGenre: { items: CtShow[]; totalCount: number } } }>(
    'GetCategoryById', QUERY_CATEGORY,
    { categoryId: String(categoryId), limit, offset, order: 'asc', orderBy: 'alphabet' }, signal,
  );
  return json.data.showFindByGenre;
}

async function searchShows(text: string, offset: number, limit: number, signal: AbortSignal): Promise<{ items: CtShow[]; totalCount: number }> {
  const json = await graphql<{ data: { searchShows: { items: CtSearchedShow[]; totalCount: number } } }>(
    'SearchShows', QUERY_SEARCH_SHOWS, { limit, offset, search: text, onlyPlayable: false }, signal,
  );
  const { items, totalCount } = json.data.searchShows;
  // Show pages are served at porady/{id}-{code}/, mirroring the upstream FORMAT_SHOW_URL pattern.
  return { items: items.map(item => ({ id: item.id, slug: `${item.id}-${item.code}`, title: item.title, code: item.code })), totalCount };
}

async function getEpisodes(idec: string, offset: number, limit: number, seasonId: string | null, signal: AbortSignal) {
  const json = await graphql<{ data: { episodesPreviewFind: { items: CtEpisodeItem[]; totalCount: number } } }>(
    'GetEpisodes', QUERY_EPISODES, { idec, seasonId, limit, offset, orderBy: 'oldest' }, signal,
  );
  return json.data.episodesPreviewFind;
}

function programUrl(slug: string): string {
  return `${PROGRAM_BASE}${slug}/`;
}

function episodeUrl(programUri: string, id: string): string {
  return `${programUri}${id}/`;
}

interface ShowMetadata { idec: string; seasons: string[]; year?: number }

async function fetchShowMetadata(programUri: string, signal: AbortSignal): Promise<ShowMetadata | null> {
  const html = await fetchText(programUri, signal, { headers: { referer: REFERER } });
  const $ = loadHtml(html);
  const script = $('script#__NEXT_DATA__').first().html();
  if (!script) return null;
  const idecMatch = /"idec":"([^"]+)"/.exec(script);
  const idec = idecMatch?.[1];
  if (!idec) return null;
  let seasons: string[] = [];
  let year: number | undefined;
  try {
    const parsed: unknown = JSON.parse(script);
    const productionYear = Number(getPath(parsed, 'props.pageProps.data.show.year'));
    if (Number.isSafeInteger(productionYear) && productionYear > 0) year = productionYear;
    const seasonList = getPath(parsed, 'props.pageProps.data.show.seasons');
    if (Array.isArray(seasonList)) {
      seasons = seasonList
        .map(entry => {
          const id = getPath(entry, 'id');
          return typeof id === 'string' ? id : '';
        })
        .filter(Boolean);
    }
  } catch {
    // The seasons block is optional context; idec alone is enough to continue.
  }
  return { idec, seasons, year };
}

function buildEpisodeRelease(
  show: CtShow, meta: ShowMetadata, pUrl: string, item: CtEpisodeItem,
  season: number | undefined, episode: number | undefined, kind: MediaKind,
): Release {
  const url = episodeUrl(pUrl, item.id);
  return {
    id: releaseId('ceskatelevize', url), provider: 'ceskatelevize', title: item.title,
    url, kind, series: show.title, season, episode, year: kind === 'movie' ? meta.year : undefined, data: { idec: item.id },
  };
}

/**
 * The GraphQL API only offers oldest-first paging, so newest-first browsing walks pages from the
 * last one backward. `totalCount` (needed to locate the last page) is learned from a single cheap
 * probe request rather than by fetching and discarding a full page.
 */
async function* pagesNewestFirst(
  idec: string, seasonId: string | null, signal: AbortSignal,
): AsyncGenerator<{ item: CtEpisodeItem; index: number; total: number }> {
  const probe = await getEpisodes(idec, 0, 1, seasonId, signal);
  const total = probe.totalCount;
  if (total <= 0) return;
  const lastOffset = Math.floor((total - 1) / MAX_ITEMS_PER_PAGE) * MAX_ITEMS_PER_PAGE;
  for (let offset = lastOffset; offset >= 0; offset -= MAX_ITEMS_PER_PAGE) {
    const page = await getEpisodes(idec, offset, MAX_ITEMS_PER_PAGE, seasonId, signal);
    // An episode whose rights expired stays listed upstream; it keeps its number but is never offered.
    for (let i = page.items.length - 1; i >= 0; i--) if (page.items[i]!.playable) yield { item: page.items[i]!, index: offset + i + 1, total };
  }
}

async function* iterateShowEpisodes(show: CtShow, query: CatalogueQuery, signal: AbortSignal): AsyncGenerator<Release> {
  const pUrl = programUrl(show.slug);
  const meta = await fetchShowMetadata(pUrl, signal);
  if (!meta) return;
  const hasSeasons = meta.seasons.length > 0;

  if (query.season !== undefined) {
    if (!hasSeasons) return;
    const seasonId = meta.seasons[query.season - 1];
    if (!seasonId) return;
    if (query.episode !== undefined) {
      const page = await getEpisodes(meta.idec, query.episode - 1, 1, seasonId, signal);
      const item = page.items[0];
      if (item?.playable) yield buildEpisodeRelease(show, meta, pUrl, item, query.season, query.episode, 'tv');
      return;
    }
    for await (const { item, index } of pagesNewestFirst(meta.idec, seasonId, signal)) {
      yield buildEpisodeRelease(show, meta, pUrl, item, query.season, index, 'tv');
    }
    return;
  }

  if (query.episode !== undefined) {
    const page = await getEpisodes(meta.idec, query.episode - 1, 1, null, signal);
    const item = page.items[0];
    if (item?.playable) yield buildEpisodeRelease(show, meta, pUrl, item, undefined, query.episode, hasSeasons ? 'tv' : 'movie');
    return;
  }

  if (!hasSeasons) {
    for await (const { item, index, total } of pagesNewestFirst(meta.idec, null, signal)) {
      const kind: MediaKind = total <= 1 ? 'movie' : 'tv';
      yield buildEpisodeRelease(show, meta, pUrl, item, undefined, kind === 'tv' ? index : undefined, kind);
    }
    return;
  }

  const visited = new Set<string>();
  for (let seasonIndex = meta.seasons.length - 1; seasonIndex >= 0; seasonIndex--) {
    const seasonId = meta.seasons[seasonIndex] as string;
    for await (const { item, index } of pagesNewestFirst(meta.idec, seasonId, signal)) {
      const release = buildEpisodeRelease(show, meta, pUrl, item, seasonIndex + 1, index, 'tv');
      visited.add(release.url);
      yield release;
    }
  }
  for await (const { item } of pagesNewestFirst(meta.idec, null, signal)) {
    if (!visited.has(episodeUrl(pUrl, item.id))) yield buildEpisodeRelease(show, meta, pUrl, item, undefined, undefined, 'tv');
  }
}

async function* iterateShows(query: CatalogueQuery, signal: AbortSignal): AsyncGenerator<CtShow> {
  const q = query.q.trim();
  if (q) {
    const pageSize = 20;
    let offset = 0, total = -1;
    do {
      const page = await searchShows(q, offset, pageSize, signal);
      if (total < 0) total = page.totalCount;
      for (const show of page.items) yield show;
      offset += pageSize;
    } while (offset < total);
    return;
  }
  for (const categoryId of CATEGORIES) {
    let offset = 0, total = -1;
    do {
      const page = await getProgramsByCategory(categoryId, offset, MAX_ITEMS_PER_PAGE, signal);
      if (total < 0) total = page.totalCount;
      for (const show of page.items) yield show;
      offset += MAX_ITEMS_PER_PAGE;
    } while (offset < total);
  }
}

const ceskaTelevizeCatalogue: Catalogue<CtShow> = {
  programs: (query, signal) => iterateShows(query, signal),
  releases: (show, query, signal) => iterateShowEpisodes(show, query, signal),
};

// --- Playback resolution (VOD.* in the upstream engine) ---------------------------------------

interface ExternalSource { kind: 'external'; idec: string; deviceId: string; origin: string; client: string }
interface InternalSource { kind: 'internal'; versionId: string; sessionId: string; origin: string; client: string }
interface BonusSource { kind: 'bonus'; value: string; deviceId: string; origin: string; client: string }
type SourceInfo = ExternalSource | InternalSource | BonusSource;

function sourceInfoPath(info: SourceInfo): string {
  const common = `canPlayDrm=true&quality=web&streamType=dash&origin=${encodeURIComponent(info.origin)}&client=${encodeURIComponent(info.client)}&clientVersion=${CLIENT_VERSION}`;
  switch (info.kind) {
    case 'external':
      return `stream-data/media/external/${encodeURIComponent(info.idec)}?${common}&deviceId=${encodeURIComponent(info.deviceId)}`;
    case 'internal':
      return `stream-data/version/${encodeURIComponent(info.versionId)}?${common}&sessionId=${encodeURIComponent(info.sessionId)}`;
    case 'bonus':
      return `stream-data/bonus/BO-${encodeURIComponent(info.value)}?${common}&deviceId=${encodeURIComponent(info.deviceId)}`;
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // The MPD manifest is fetched from the remote CDN; keep standard entity decoding (`&amp;` etc.)
  // but bound entity expansion against XXE/billion-laughs-style DoS from an untrusted response.
  processEntities: { maxEntitySize: 10_000, maxExpansionDepth: 10_000, maxTotalExpansions: 1000, maxExpandedLength: 100_000, maxEntityCount: 1000 },
});

async function detectDrm(mpdUrl: string, signal: AbortSignal): Promise<{ pssh: string[] } | null> {
  let text: string;
  try {
    text = await fetchText(mpdUrl, signal);
  } catch {
    return null;
  }
  if (!text.toLowerCase().includes(WIDEVINE_SCHEME_URN)) return null;
  let doc: unknown;
  try {
    doc = xmlParser.parse(text);
  } catch {
    return { pssh: [] };
  }
  const pssh: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const entry of node) walk(entry); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (String(obj['@_schemeIdUri'] ?? '').toLowerCase() === WIDEVINE_SCHEME_URN) {
      const value = obj['cenc:pssh'];
      if (typeof value === 'string') pssh.push(value);
      else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') pssh.push(entry);
    }
    for (const key of Object.keys(obj)) if (key !== '@_schemeIdUri') walk(obj[key]);
  };
  walk(doc);
  return { pssh };
}

async function buildMediaSource(streamUrl: string, subtitles: Map<string, string[]>, signal: AbortSignal): Promise<MediaSource> {
  let finalUrl = streamUrl;
  let contentType: string | null = null;
  try {
    const head = await fetch(streamUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (head.url) finalUrl = head.url;
    contentType = head.headers.get('content-type');
  } catch {
    // Fall back to the un-redirected stream URL if the HEAD probe fails.
  }
  // CT's signed CDN/token URLs carry no .mpd/.m3u8 suffix (they resolve via query params), so the
  // extension-based mediaType() helper misclassifies them; prefer the real Content-Type when known.
  const type = contentType?.includes('dash+xml') ? 'dash'
    : contentType?.includes('mpegurl') ? 'hls'
    : mediaType(finalUrl);
  const subs: NonNullable<MediaSource['subtitles']> = [];
  for (const [language, urls] of subtitles) {
    const vtt = urls.find(u => u.toLowerCase().endsWith('.vtt'));
    if (vtt) subs.push({ url: vtt, language });
  }
  const source: MediaSource = { url: finalUrl, type };
  if (subs.length) source.subtitles = subs;
  if (type === 'dash') {
    const drm = await detectDrm(finalUrl, signal);
    if (drm) source.drm = { url: LICENSE_URL, headers: { referer: PLAYER_REFERER }, ...(drm.pssh.length ? { pssh: drm.pssh } : {}) };
  }
  return source;
}

interface PlaylistStreamItem { url?: unknown; subtitles?: unknown }
interface PlaylistResponse { error?: unknown; message?: unknown; streams?: PlaylistStreamItem[] }

async function fetchPlaylist(info: SourceInfo, signal: AbortSignal): Promise<MediaSource[]> {
  const url = new URL(sourceInfoPath(info), VOD_ENDPOINT).toString();
  const json = await fetchJson<PlaylistResponse>(url, signal);
  if (json.error || json.message) return [];
  const sources: MediaSource[] = [];
  for (const item of json.streams ?? []) {
    if (typeof item.url !== 'string') continue;
    const subtitles = new Map<string, string[]>();
    if (Array.isArray(item.subtitles)) {
      for (const sub of item.subtitles) {
        const language = getPath(sub, 'language');
        const files = getPath(sub, 'files');
        const urls: string[] = [];
        if (Array.isArray(files)) {
          for (const file of files) {
            const fileUrl = getPath(file, 'url');
            if (typeof fileUrl === 'string') urls.push(new URL(fileUrl, url).toString());
          }
        }
        subtitles.set(typeof language === 'string' ? language : 'unknown', urls);
      }
    }
    sources.push(await buildMediaSource(new URL(item.url, url).toString(), subtitles, signal));
  }
  return sources;
}

// --- Subsite discovery for raw ceskatelevize.cz URLs (CT.* implementations) -------------------

async function discoverSourceInfos(pageUrl: string, signal: AbortSignal): Promise<SourceInfo[]> {
  const parsed = new URL(pageUrl);
  const sub = parsed.hostname.toLowerCase().split('.')[0] ?? '';
  const html = await fetchText(pageUrl, signal, { headers: { referer: REFERER } });
  const $ = loadHtml(html);

  if (sub === 'www') {
    const script = $('script#__NEXT_DATA__').first().html();
    if (!script) return [];
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(script); } catch { return []; }
    const deviceId = randomUUID();
    const infos: SourceInfo[] = [];
    for (const candidatePath of ['props.pageProps.data.mediaMeta', 'props.pageProps.data.show']) {
      const idec = getPath(parsedJson, `${candidatePath}.idec`);
      if (typeof idec === 'string') infos.push({ kind: 'external', idec, deviceId, origin: 'ivysilani', client: 'iVysilaniWeb' });
    }
    return infos;
  }

  if (sub === 'ct24' || sub === 'sport') {
    const script = $('script#__NEXT_DATA__').first().html();
    if (!script) return [];
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(script); } catch { return []; }
    const versionId = getPath(parsedJson, 'props.pageProps.videoModel.origin.versionId');
    if (typeof versionId !== 'string') return [];
    const origin = sub === 'ct24' ? 'ct24' : 'sport';
    const client = sub === 'ct24' ? 'CT24Web' : 'SportWeb';
    return [{ kind: 'internal', versionId, sessionId: randomUUID(), origin, client }];
  }

  if (sub === 'art') {
    const deviceId = randomUUID();
    const infos: SourceInfo[] = [];
    $('.popup-video').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      let query: URLSearchParams;
      try { query = new URL(href, pageUrl).searchParams; } catch { return; }
      const bonus = query.get('bonus');
      const idecParam = query.get('IDEC');
      if (bonus) infos.push({ kind: 'bonus', value: bonus, deviceId, origin: 'artzona', client: 'ArtWeb' });
      else if (idecParam) infos.push({ kind: 'external', idec: idecParam.replace(/[ /]/g, ''), deviceId, origin: 'artzona', client: 'ArtWeb' });
    });
    return infos;
  }

  if (sub === 'edu') {
    const deviceId = randomUUID();
    const infos: SourceInfo[] = [];
    $('.video-player').each((_, el) => {
      const idec = $(el).attr('data-idec');
      if (idec) infos.push({ kind: 'external', idec, deviceId, origin: 'edu', client: 'EduWeb' });
    });
    return infos;
  }

  if (sub === 'decko') {
    const deviceId = randomUUID();
    const videoMatch = /^https?:\/\/decko\.ceskatelevize\.cz\/video\/([^/]+)\/?$/i.exec(pageUrl);
    if (videoMatch) {
      const infos: SourceInfo[] = [];
      $('.media-player-plain__video').each((_, el) => {
        const raw = $(el).attr('data-player-query');
        if (!raw) return;
        const cleaned = raw.replace(/[ /]/g, '');
        const params = new URLSearchParams(cleaned.startsWith('?') ? cleaned.slice(1) : cleaned);
        const idec = params.get('IDEC');
        if (idec) infos.push({ kind: 'external', idec, deviceId, origin: 'decko', client: 'DeckoWeb' });
      });
      return infos;
    }
    const showCodeMatch = /^https?:\/\/decko\.ceskatelevize\.cz\/([^/]+)\/?$/i.exec(pageUrl);
    if (!showCodeMatch) return [];
    const showCode = showCodeMatch[1] as string;
    const found = await searchShows(showCode, 0, 100, signal);
    const show = found.items.find(item => item.code === showCode);
    if (!show) return [];
    const pUrl = programUrl(show.slug);
    const meta = await fetchShowMetadata(pUrl, signal);
    if (!meta) return [];
    const infos: SourceInfo[] = [];
    const seasonIds: Array<string | null> = [...meta.seasons, null];
    for (const seasonId of seasonIds) {
      let offset = 0, total = -1;
      do {
        const page = await getEpisodes(meta.idec, offset, MAX_ITEMS_PER_PAGE, seasonId, signal);
        if (total < 0) total = page.totalCount;
        for (const item of page.items) infos.push(...await discoverSourceInfos(episodeUrl(pUrl, item.id), signal));
        offset += MAX_ITEMS_PER_PAGE;
      } while (offset < total);
    }
    return infos;
  }

  return [];
}

async function resolveCeskaTelevize(release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const idec = release.data?.idec;
  if (typeof idec === 'string') {
    const info: ExternalSource = { kind: 'external', idec, deviceId: randomUUID(), origin: 'ivysilani', client: 'iVysilaniWeb' };
    return fetchPlaylist(info, signal);
  }
  const infos = await discoverSourceInfos(release.url, signal);
  const sources: MediaSource[] = [];
  for (const info of infos) sources.push(...await fetchPlaylist(info, signal));
  return sources;
}

/**
 * Česká televize is a fully public catalog (no login required for standard-definition VOD
 * playback), so the provider is enabled unless explicitly disabled via config.
 */
export function createCeskaTelevizeProvider(config: ProviderConfig = {}): Provider | null {
  if (config.enabled === false) return null;
  return {
    id: 'ceskatelevize',
    name: 'Česká televize',
    catalogue: ceskaTelevizeCatalogue,
    async resolve(release, signal) { return resolveCeskaTelevize(release, signal); },
  };
}
