import { load as loadHtml } from 'cheerio';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Catalogue, CatalogueQuery, MediaKind, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { at, bracketSubstring, fetchJson, fetchText, normalize, releaseId } from './common.ts';

// Ported from sune.app.mediadown.media_engine.streamcz.StreamCZEngine (Media Downloader).

const API_URL = 'https://api.stream.cz/graphql';
const REFERER = 'https://www.stream.cz/';
const CATEGORIES_URL = 'https://www.stream.cz/videa/filmy';
const BASE_URL = 'https://www.stream.cz/';
const REGEX_EPISODE = /^S(\d+):E(\d+)$/i;
/** How long a cached programme listing stays current before the next search re-discovers it. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Bound catalogue freshness tightly for newly published episodes. */
const EPISODE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CatalogNode { id: string; name: string; namePrefix: string | null; urlName: string; kind?: MediaKind }

/** A Stream.cz tag that lists episodes (a show or, for the `filmy` channel, individual movies). */
interface StreamCzProgram { id: string; title: string; kind: MediaKind; urlName: string }

/** Clock used by the cache; tests replace it to avoid real time. */
export interface StreamCzCacheTiming {
  now?: () => number;
}

/** The `query.kind` scopes a programme discovery walks and caches independently. */
type CacheScope = 'tv' | 'movie' | 'all';

/**
 * A persistent SQLite snapshot of Stream.cz's programme discovery (categories -> programs),
 * kept per `query.kind` scope so a warm search never re-walks the GraphQL catalogue tree.
 *
 * A scope is only ever replaced by a discovery that ran to completion: an aborted or failed walk
 * never publishes a partial snapshot; an expired snapshot is replaced only after a complete walk.
 * Complete non-empty episode listings have a separate five-minute snapshot per native program ID.
 * Playback resolution always stays live; neither snapshot contains CDN URLs or credentials.
 */
class StreamCzCache {
  private readonly selectMeta: StatementSync;
  private readonly upsertMeta: StatementSync;
  private readonly selectRows: StatementSync;
  private readonly deleteRows: StatementSync;
  private readonly insertRow: StatementSync;
  private readonly selectEpisodes: StatementSync;
  private readonly upsertEpisodes: StatementSync;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, options: StreamCzCacheTiming = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    db.exec(`CREATE TABLE IF NOT EXISTS stream_catalogue_cache (
        scope TEXT NOT NULL, program_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, url_name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stream_catalogue_cache_scope ON stream_catalogue_cache (scope);
      CREATE TABLE IF NOT EXISTS stream_catalogue_cache_meta (scope TEXT PRIMARY KEY, refreshed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stream_episode_cache (
        program_id TEXT PRIMARY KEY, refreshed_at INTEGER NOT NULL, payload TEXT NOT NULL
      );`);
    this.selectMeta = db.prepare('SELECT refreshed_at FROM stream_catalogue_cache_meta WHERE scope=?');
    this.upsertMeta = db.prepare(
      'INSERT INTO stream_catalogue_cache_meta (scope, refreshed_at) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET refreshed_at=excluded.refreshed_at');
    this.selectRows = db.prepare('SELECT program_id, title, kind, url_name FROM stream_catalogue_cache WHERE scope=? ORDER BY rowid');
    this.deleteRows = db.prepare('DELETE FROM stream_catalogue_cache WHERE scope=?');
    this.insertRow = db.prepare('INSERT INTO stream_catalogue_cache (scope, program_id, title, kind, url_name) VALUES (?, ?, ?, ?, ?)');
    this.selectEpisodes = db.prepare('SELECT refreshed_at, payload FROM stream_episode_cache WHERE program_id=?');
    this.upsertEpisodes = db.prepare(`INSERT INTO stream_episode_cache (program_id, refreshed_at, payload) VALUES (?, ?, ?)
      ON CONFLICT(program_id) DO UPDATE SET refreshed_at=excluded.refreshed_at, payload=excluded.payload`);
  }

  episodes(programId: string): CatalogNode[] | undefined {
    const row = this.selectEpisodes.get(programId);
    if (!row || this.now() - Number(row.refreshed_at) >= EPISODE_CACHE_TTL_MS) return undefined;
    return JSON.parse(String(row.payload)) as CatalogNode[];
  }

  saveEpisodes(programId: string, episodes: readonly CatalogNode[]): void {
    if (episodes.length) this.upsertEpisodes.run(programId, this.now(), JSON.stringify(episodes));
  }

  /** The scope's snapshot, or `undefined` when there is none or it is `CACHE_TTL_MS` or older. */
  read(scope: CacheScope): StreamCzProgram[] | undefined {
    const meta = this.selectMeta.get(scope);
    if (!meta) return undefined;
    if (this.now() - Number(meta.refreshed_at) >= CACHE_TTL_MS) return undefined;
    return this.selectRows.all(scope).map(row => ({
      id: String(row.program_id), title: String(row.title),
      kind: row.kind === 'movie' ? 'movie' as const : 'tv' as const, urlName: String(row.url_name),
    }));
  }

  /**
   * Replaces the scope's snapshot with `rows`, atomically. Only ever called with the result of a
   * discovery that was consumed to completion by its caller (see `streamCzPrograms`), so a
   * snapshot is never partial.
   */
  write(scope: CacheScope, rows: readonly StreamCzProgram[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteRows.run(scope);
      for (const row of rows) this.insertRow.run(scope, row.id, row.title, row.kind, row.urlName);
      this.upsertMeta.run(scope, String(this.now()));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function nodeFrom(source: unknown): CatalogNode | null {
  const id = at(source, 'id');
  const name = at(source, 'name');
  const urlName = at(source, 'urlName');
  if (typeof id !== 'string' || typeof name !== 'string' || typeof urlName !== 'string') return null;
  const namePrefix = at(source, 'namePrefix');
  return { id, name, urlName, namePrefix: typeof namePrefix === 'string' ? namePrefix : null };
}

async function graphqlRequest(query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const response = await fetchJson<Record<string, unknown>>(API_URL, signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: REFERER },
    body: JSON.stringify({ query, variables }),
  });
  if (Array.isArray(response.errors) && response.errors.length) throw new Error('Stream.cz rejected its catalog query');
  return response;
}

const QUERY_PROGRAMS = `query LoadTag($id: ID, $first: Int, $after: String) {
  childTagsData: tag(id: $id) {
    directTagsConnection(first: $first, after: $after, categories: [show, tag], mediaTypes: [video]) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges { node { id name urlName } }
    }
  }
}`;

// allEpisodesConnection has no orderBy argument; the connection order is upload order (oldest
// first). Relay's `last`/`before` args let newest-first browsing walk it backward, page by page,
// without first learning its length.
const QUERY_EPISODES = `query LoadTag($id: ID, $last: Int, $before: String) {
  tagData: tag(id: $id) {
    allEpisodesConnection(mediaTypes: [video], last: $last, before: $before) {
      pageInfo { startCursor hasPreviousPage }
      edges { node { id name namePrefix urlName } }
    }
  }
}`;

async function* paginateConnection(
  connectionPath: string, run: (cursor: string) => Promise<unknown>,
): AsyncGenerator<CatalogNode> {
  let cursor = '';
  for (;;) {
    const data = await run(cursor);
    const connection = at(data, connectionPath);
    const edges = at(connection, 'edges');
    const hasNextPage = at(connection, 'pageInfo.hasNextPage');
    if (!Array.isArray(edges) || typeof hasNextPage !== 'boolean') {
      throw new Error('Stream.cz returned an incomplete programme connection');
    }
    for (const edge of edges) {
      const node = nodeFrom(at(edge, 'node'));
      if (!node) throw new Error('Stream.cz returned an incomplete programme');
      yield node;
    }
    if (!hasNextPage) return;
    const endCursor = at(connection, 'pageInfo.endCursor');
    if (typeof endCursor !== 'string' || !endCursor || endCursor === cursor) {
      throw new Error('Stream.cz returned an invalid programme cursor');
    }
    cursor = endCursor;
  }
}

/** Same shape as `paginateConnection`, but walking a connection's `last`/`before` page backward. */
async function* paginateConnectionBackward(
  connectionPath: string, run: (cursor: string | null) => Promise<unknown>,
): AsyncGenerator<CatalogNode> {
  let cursor: string | null = null;
  for (;;) {
    const data = await run(cursor);
    const connection = at(data, connectionPath);
    const edges = at(connection, 'edges');
    const hasPreviousPage = at(connection, 'pageInfo.hasPreviousPage');
    if (!Array.isArray(edges) || typeof hasPreviousPage !== 'boolean') {
      throw new Error('Stream.cz returned an incomplete episode connection');
    }
    const nodes: CatalogNode[] = [];
    for (const edge of edges) {
      const node = nodeFrom(at(edge, 'node'));
      if (!node) throw new Error('Stream.cz returned an incomplete episode');
      nodes.push(node);
    }
    for (let i = nodes.length - 1; i >= 0; i--) yield nodes[i]!;
    if (!hasPreviousPage) return;
    const startCursor = at(connection, 'pageInfo.startCursor');
    if (typeof startCursor !== 'string' || !startCursor || startCursor === cursor) {
      throw new Error('Stream.cz returned an invalid episode cursor');
    }
    cursor = startCursor;
  }
}

function programsOf(categoryId: string, signal: AbortSignal): AsyncGenerator<CatalogNode> {
  return paginateConnection('data.childTagsData.directTagsConnection', cursor =>
    graphqlRequest(QUERY_PROGRAMS, { id: categoryId, first: 24, after: cursor || null }, signal));
}

function episodesOf(programId: string, signal: AbortSignal): AsyncGenerator<CatalogNode> {
  return paginateConnectionBackward('data.tagData.allEpisodesConnection', cursor =>
    graphqlRequest(QUERY_EPISODES, { id: programId, last: 20, before: cursor }, signal));
}

function appServerState(html: string): unknown {
  const $ = loadHtml(html);
  let result: unknown = null;
  $('script').each((_, el) => {
    if (result !== null) return;
    if ($(el).attr('src')) return;
    const content = $(el).html() ?? '';
    const markerIndex = content.indexOf('APP_SERVER_STATE = ');
    if (markerIndex < 0) return;
    const dataIndex = content.indexOf('data : ', markerIndex);
    if (dataIndex < 0) return;
    const braceIndex = content.indexOf('{', dataIndex);
    if (braceIndex < 0) return;
    const objectText = bracketSubstring(content, braceIndex);
    if (!objectText) return;
    try { result = JSON.parse(objectText); } catch { /* try the next inline script tag, if any */ }
  });
  return result;
}

async function categories(signal: AbortSignal): Promise<CatalogNode[]> {
  const html = await fetchText(CATEGORIES_URL, signal, { headers: { referer: REFERER } });
  const state = appServerState(html);
  if (!state) throw new Error('Stream.cz returned no catalogue state');
  const nodes: CatalogNode[] = [];
  const navCategories = at(state, 'page.navigationCategories.data');
  if (!Array.isArray(navCategories)) throw new Error('Stream.cz returned no catalogue navigation');
  for (const entry of navCategories) {
    const node = nodeFrom(entry);
    if (!node) throw new Error('Stream.cz returned an incomplete category');
    nodes.push(node);
  }
  const channel = nodeFrom(at(state, 'fetchable.tag.channel.data'));
  if (channel) nodes.push({ ...channel, kind: 'movie' }); // channel on the explicit /videa/filmy page
  return nodes;
}

function programUrl(program: StreamCzProgram): string {
  return new URL(program.urlName.replace(/^\/+/, ''), BASE_URL).toString();
}

function parseSeasonEpisode(namePrefix: string | null): { season?: number; episode?: number } {
  const match = namePrefix ? REGEX_EPISODE.exec(namePrefix) : null;
  if (!match) return {};
  const season = match[1];
  const episode = match[2];
  return season && episode ? { season: Number(season), episode: Number(episode) } : {};
}

function buildRelease(program: StreamCzProgram, episode: CatalogNode): Release {
  const base = programUrl(program).replace(/\/?$/, '/');
  const url = new URL(episode.urlName.replace(/^\/+/, ''), base).toString();
  const { season, episode: episodeNum } = parseSeasonEpisode(episode.namePrefix);
  const kind: MediaKind = season !== undefined && episodeNum !== undefined ? 'tv' : program.kind;
  return {
    id: releaseId('streamcz', url), provider: 'streamcz', title: episode.name,
    url, kind, series: program.title, season, episode: episodeNum,
  };
}

/**
 * Programs for `query.kind`, from `cache` when its scope is still fresh; otherwise the live
 * category -> program walk, cached once it runs to completion. A caller that stops early (an
 * abort, an error, or simply not exhausting the generator) never reaches `cache.write`, so an
 * interrupted discovery cannot corrupt a scope another caller is reading or refreshing.
 */
async function* streamCzPrograms(query: CatalogueQuery, signal: AbortSignal, cache: StreamCzCache): AsyncGenerator<StreamCzProgram> {
  signal.throwIfAborted();
  const scope = query.kind ?? 'all';
  const cached = cache.read(scope);
  if (cached) {
    for (const program of cached) {
      signal.throwIfAborted();
      yield program;
    }
    return;
  }
  const discovered: StreamCzProgram[] = [];
  for (const category of await categories(signal)) {
    const kind = category.kind ?? (normalize(category.name) === 'filmy' ? 'movie' : 'tv');
    if (query.kind && query.kind !== kind) continue;
    for await (const program of programsOf(category.id, signal)) {
      const entry: StreamCzProgram = { id: program.id, title: program.name, kind, urlName: program.urlName };
      discovered.push(entry);
      yield entry;
    }
  }
  signal.throwIfAborted();
  cache.write(scope, discovered);
}

async function* streamCzReleases(program: StreamCzProgram, signal: AbortSignal, cache: StreamCzCache): AsyncGenerator<Release> {
  signal.throwIfAborted();
  const cached = cache.episodes(program.id);
  if (cached) {
    for (const episode of cached) {
      signal.throwIfAborted();
      yield buildRelease(program, episode);
    }
    return;
  }
  const discovered: CatalogNode[] = [];
  for await (const episode of episodesOf(program.id, signal)) {
    signal.throwIfAborted();
    discovered.push(episode);
    yield buildRelease(program, episode);
  }
  signal.throwIfAborted();
  cache.saveEpisodes(program.id, discovered);
}

function streamCzCatalogue(cache: StreamCzCache): Catalogue<StreamCzProgram> {
  return {
    programs: (query, signal) => streamCzPrograms(query, signal, cache),
    releases: (program, _query, signal) => streamCzReleases(program, signal, cache),
  };
}

// --- Playback resolution (StreamCZEngine#getMedia) ---------------------------------------------

function parseQualityHeight(label: string): number | undefined {
  const match = /(\d+)p?/.exec(label);
  const digits = match?.[1];
  return digits ? Number(digits) : undefined;
}

function collectSubtitleSources(subtitleEntries: Array<{ language: string; srt?: string; webvtt?: string }>): MediaSource['subtitles'] {
  const out: NonNullable<MediaSource['subtitles']> = [];
  for (const entry of subtitleEntries) {
    if (entry.srt) out.push({ url: entry.srt, language: entry.language });
    if (entry.webvtt) out.push({ url: entry.webvtt, language: entry.language });
  }
  return out.length ? out : undefined;
}

async function resolveStreamCz(release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const html = await fetchText(release.url, signal, { headers: { referer: REFERER } });
  const state = appServerState(html);
  if (!state) return [];
  const videoData = at(state, 'fetchable.episode.videoDetail.data');
  const spl = at(videoData, 'spl');
  if (typeof spl !== 'string') return [];
  const splUrl = `${spl}spl2,3,VOD`.replace(/\|/g, '%7C');
  const splUri = new URL(splUrl);
  const json = await fetchJson<unknown>(splUri, signal);

  const subtitleEntries: Array<{ language: string; srt?: string; webvtt?: string }> = [];
  const rawSubtitles = at(json, 'data.subtitles');
  if (Array.isArray(rawSubtitles)) {
    for (const entry of rawSubtitles) {
      const language = at(entry, 'language');
      const srt = at(entry, 'urls.srt');
      const webvtt = at(entry, 'urls.webvtt');
      subtitleEntries.push({
        language: typeof language === 'string' ? language : 'unknown',
        srt: typeof srt === 'string' ? new URL(srt.replace(/\|/g, '%7C'), splUri).toString() : undefined,
        webvtt: typeof webvtt === 'string' ? new URL(webvtt.replace(/\|/g, '%7C'), splUri).toString() : undefined,
      });
    }
  }

  const sources: MediaSource[] = [];
  const mp4 = at(json, 'data.mp4');
  if (mp4 && typeof mp4 === 'object') {
    for (const [quality, item] of Object.entries(mp4)) {
      const itemUrl = at(item, 'url');
      if (typeof itemUrl !== 'string') continue;
      const url = new URL(itemUrl.replace(/\|/g, '%7C'), splUri).toString();
      const resolution = at(item, 'resolution');
      const resolutionHeight = Array.isArray(resolution) ? resolution[1] : undefined;
      const height = typeof resolutionHeight === 'number' ? resolutionHeight : parseQualityHeight(quality);
      const bandwidthValue = at(item, 'bandwidth');
      const bandwidth = typeof bandwidthValue === 'number' && bandwidthValue >= 0 ? bandwidthValue : undefined;
      const source: MediaSource = { url, type: 'file', height, bandwidth };
      const subtitles = collectSubtitleSources(subtitleEntries);
      if (subtitles) source.subtitles = subtitles;
      sources.push(source);
    }
  }
  const hlsUrl = at(json, 'pls.hls.url');
  if (typeof hlsUrl === 'string') {
    const url = new URL(hlsUrl.replace(/\|/g, '%7C'), splUri).toString();
    const source: MediaSource = { url, type: 'hls' };
    const subtitles = collectSubtitleSources(subtitleEntries);
    if (subtitles) source.subtitles = subtitles;
    sources.push(source);
  }
  return sources;
}

/**
 * Stream.cz is a fully public catalog with no login required for standard VOD playback, so the
 * provider is enabled unless explicitly disabled via config. Upstream has no dedicated text-search
 * endpoint, so browsing walks the same category → program → episode tree the site itself uses;
 * `database` holds a persistent snapshot of that walk (see `StreamCzCache`).
 */
export function createStreamCzProvider(config: ProviderConfig = {}, database: DatabaseSync, timing: StreamCzCacheTiming = {}): Provider | null {
  if (config.enabled === false) return null;
  return {
    id: 'streamcz',
    name: 'Stream.cz',
    catalogue: streamCzCatalogue(new StreamCzCache(database, timing)),
    async resolve(release, signal) { return resolveStreamCz(release, signal); },
  };
}
