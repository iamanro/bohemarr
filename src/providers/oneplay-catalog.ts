import type { MediaKind, MediaSource, ProgramMetadata } from '../types.ts';
import { normalize, PlaybackBusy } from './common.ts';
import { at, playbackCapabilities, readErrorMessage, successData, EPISODE_LIST_MAX_ITEMS_PER_PAGE, PROGRAM_LIST_MAX_ITEMS_PER_PAGE } from './oneplay-protocol.ts';
import type { OneplayConnectionPool } from './oneplay-pool.ts';

/** Oneplay's result code when every concurrent stream the account's plan allows is in use. */
const MAX_CONCURRENT_STREAMS = 4091;

/** `OneplayDRMEngine`'s fixed Widevine proxy endpoint and required Referer. */
const DRM_LICENSE_URL = 'https://drm-proxy-widevine.cms.jyxo-tls.cz/AcquireLicense';
const DRM_REFERER = 'https://www.oneplay.cz/';

export interface OneplayProgram {
  readonly uri: string;
  readonly title: string;
  readonly kind: MediaKind;
}

export interface OneplayEpisode {
  readonly uri: string;
  readonly title: string | null;
  readonly season: number | undefined;
  readonly episodeNumber: number | undefined;
}

export type ProgramEpisodes =
  | { readonly kind: 'movie'; readonly title: string }
  | { readonly kind: 'episodes'; readonly title: string; readonly items: readonly OneplayEpisode[] };

// ---------------------------------------------------------------------------
// JSON item parsing (`Oneplay.StrategyBase.parseProgramItem/parseEpisodeItem`,
// `Oneplay.getMediaInfo`, `Oneplay.getSeasons/getDirectEpisodes`)
// ---------------------------------------------------------------------------

interface MediaInfo {
  readonly programName: string | null;
  readonly season: number;
  readonly episodeNumber: number;
  readonly title: string | null;
}

/** Strips redundant "X. díl"/"díl X"/"epizoda X" labels from an episode title, as upstream does. */
function stripEpisodeLabel(title: string, episodeNumber: number): string {
  const pattern = new RegExp(
    `(?:${episodeNumber}\\.?\\s*(?:d[ií]l|epizoda)|(?:d[ií]l|epizoda)\\s*${episodeNumber}\\.?)(?:\\s*[,-]\\s*)?`,
    'giu',
  );
  return title.replace(pattern, '');
}

/** `Oneplay.getMediaInfo`. */
function getMediaInfo(trackingData: unknown): MediaInfo {
  let title = at<string>(trackingData, 'title') ?? null;
  const type = at<string>(trackingData, 'type');
  let programName: string | null = null;
  let season = 0;
  let episodeNumber = 0;

  if (type === 'episode') {
    programName = at<string>(trackingData, 'parent.title') ?? null;
    season = Number.parseInt(at<string>(trackingData, 'season') ?? '0', 10) || 0;
    episodeNumber = Number.parseInt(at<string>(trackingData, 'episodeNumber') ?? '0', 10) || 0;
    if (episodeNumber > 0 && title) title = stripEpisodeLabel(title, episodeNumber);
  } else {
    programName = title;
    title = null;
  }

  return { programName, season, episodeNumber, title };
}

interface ParsedProgramItem {
  readonly uri: string;
  readonly title: string;
  readonly type: string | null;
}

/** `Oneplay.StrategyBase.parseProgramItem`. */
function parseProgramItem(item: unknown): ParsedProgramItem | null {
  const routeUrl = at<string>(item, 'action.route.url');
  const type = at<string>(item, 'tracking.type') ?? null;
  if (!routeUrl || type === 'collection') return null;
  return { uri: routeUrl, title: at<string>(item, 'title') ?? '', type };
}

function toProgram(item: unknown): OneplayProgram | null {
  const parsed = parseProgramItem(item);
  if (!parsed) return null;
  // Upstream carries this `type` opaquely on `Program`; the same field is re-derived
  // authoritatively via `app.init`'s `contentType` before any movie/episode branching below.
  return { uri: parsed.uri, title: parsed.title, kind: parsed.type === 'movie' ? 'movie' : 'tv' };
}

interface ParsedEpisodeItem {
  readonly uri: string;
  readonly info: MediaInfo;
}

/** `Oneplay.StrategyBase.parseEpisodeItem`. */
function parseEpisodeItem(item: unknown): ParsedEpisodeItem | null {
  const routeUrl = at<string>(item, 'action.route.url');
  if (!routeUrl) return null;
  return { uri: routeUrl, info: getMediaInfo(at(item, 'tracking')) };
}

/** `Oneplay.parseCarouselData`: extract + parse `carousel.tiles`, dropping unparseable items. */
function parseCarouselTiles<T>(data: unknown, parser: (item: unknown) => T | null): T[] {
  const tiles = at<unknown[]>(data, 'carousel.tiles') ?? [];
  const parsed: T[] = [];
  for (const tile of tiles) {
    const result = parser(tile);
    if (result) parsed.push(result);
  }
  return parsed;
}

/** `Oneplay.blocksFindCarousels`: layout blocks nest arbitrarily deep; walk them recursively. */
function findCarousels(blocks: readonly unknown[]): unknown[] {
  const direct = blocks.flatMap((block) => at<unknown[]>(block, 'carousels') ?? []);
  const nested = blocks.flatMap((block) => findCarousels(at<unknown[]>(block, 'layout.blocks') ?? []));
  return [...direct, ...nested];
}

interface SeasonInfo {
  readonly seasonId: string;
  readonly carouselId: string;
}

/** `Oneplay.findSeasons` + `Oneplay.getSeasons`. */
function getSeasons(contentData: unknown): SeasonInfo[] {
  const blocks = at<unknown[]>(contentData, 'layout.blocks');
  if (!blocks) return [];

  const seasons: SeasonInfo[] = [];
  for (const carousel of findCarousels(blocks)) {
    if (at<unknown[]>(carousel, 'criteria') === undefined) continue;
    const carouselId = at<string>(carousel, 'id');
    if (!carouselId) continue;

    const criteriaList = at<unknown[]>(carousel, 'criteria') ?? [];
    for (const criterion of criteriaList) {
      if (at<string>(criterion, 'template') !== 'showSeason') continue;
      for (const item of at<unknown[]>(criterion, 'items') ?? []) {
        const seasonId = at<string>(item, 'criteria');
        if (seasonId) seasons.push({ seasonId, carouselId });
      }
    }
  }
  return seasons;
}

interface DirectEpisode {
  readonly uri: string;
  readonly title: string;
}

/** `Oneplay.getDirectEpisodes`: shows without a season carousel expose a flat episode/EPG list. */
function getDirectEpisodes(contentData: unknown): DirectEpisode[] {
  const blocks = at<unknown[]>(contentData, 'layout.blocks');
  if (!blocks) return [];

  const carousel = findCarousels(blocks).find((candidate) => {
    const tiles = at<unknown[]>(candidate, 'tiles') ?? [];
    return tiles.every(
      (tile) => at<string>(tile, 'action.call') === 'content.play' || at<string>(tile, 'action.schema') === 'NoAppAction',
    );
  });
  if (!carousel) return [];

  const episodes: DirectEpisode[] = [];
  for (const tile of at<unknown[]>(carousel, 'tiles') ?? []) {
    if (at<string>(tile, 'action.schema') === 'NoAppAction') continue;
    const uri = at<string>(tile, 'action.route.url');
    if (!uri) continue;

    let title = at<string>(tile, 'action.route.title') ?? '';
    const fragments = at<unknown[]>(tile, 'additionalFragments');
    if (fragments && at<string>(fragments[0], 'template') === 'epgItem') {
      const dateTimeLabel = at<string>(fragments[0], 'labels.1.name');
      if (dateTimeLabel) title = `${title} (${dateTimeLabel})`;
    }
    episodes.push({ uri, title });
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// Network calls (`Oneplay.getProgramInfo/getContentData/getPlayPayload`)
// ---------------------------------------------------------------------------

interface ProgramInfo {
  readonly programId: string;
  readonly type: string | null;
  readonly title: string | null;
}

/** `Oneplay.getProgramInfo`. */
async function fetchProgramInfo(pool: OneplayConnectionPool, uri: string, signal: AbortSignal): Promise<ProgramInfo | null> {
  const data = await pool.withConnection(signal, async (connection) => {
    const response = await connection.request(
      'app.init',
      { payload: { reason: 'start', route: { url: uri } }, customData: { requireStartAction: true } },
      signal,
    );
    return successData(response);
  });

  const programId = at<string>(data, 'startAction.params.payload.contentId');
  if (!programId) return null;
  return {
    programId,
    type: at<string>(data, 'startAction.params.contentType') ?? null,
    title: at<string>(data, 'startAction.route.title') ?? null,
  };
}

/**
 * The program detail page carries its own labelled metadata table ("Země původu:", "Rok:",
 * "Původní název:") alongside the localized display title. Those labelled values are the only
 * upstream evidence that distinguishes same-named national editions from each other, so they are
 * read verbatim: no value is inferred from the title.
 */
function parseSeriesMetadata(contentData: unknown, uri: string, title: string): ProgramMetadata {
  const lists = (at<unknown[]>(contentData, 'layout.blocks') ?? [])
    .flatMap(block => at<unknown[]>(block, 'additionalContentData.lists') ?? []).flat();
  const values = (label: string): string[] => lists
    .filter(entry => normalize(at<string>(entry, 'label.name') ?? '') === normalize(label))
    .flatMap(entry => at<unknown[]>(entry, 'valueList') ?? [])
    .flatMap(value => { const name = at<string>(value, 'name'); return name ? [name] : []; });

  // "Rok:" is either a single production year or a still-running range; the first year is the one
  // comparable with an authoritative first-aired date.
  const years = values('Rok:').flatMap(value => [...value.matchAll(/\b(\d{4})\b/g)].map(match => Number(match[1])));
  const aliases = values('Původní název:').filter(alias => alias !== title);

  return {
    id: uri,
    title,
    aliases,
    year: years.length ? Math.min(...years) : undefined,
    countries: values('Země původu:'),
  };
}

/** `Oneplay.getContentData`. */
async function fetchContentData(pool: OneplayConnectionPool, contentId: string, signal: AbortSignal): Promise<unknown> {
  return pool.withConnection(signal, async (connection) => {
    const response = await connection.request(
      'page.content.display',
      { payload: { contentId }, customData: { shouldBeInModal: true }, playbackCapabilities: playbackCapabilities() },
      signal,
    );
    return successData(response);
  });
}

interface PlayPayload {
  readonly payload: Record<string, unknown> | null;
  readonly isUpsell: boolean;
}

/** `Oneplay.getPlayPayload`: walks the `app.init` start-action chain down to a playable payload. */
async function fetchPlayPayload(pool: OneplayConnectionPool, uri: string, signal: AbortSignal): Promise<PlayPayload | null> {
  return pool.withConnection(signal, async (connection) => {
    const initData = successData(
      await connection.request(
        'app.init',
        { payload: { reason: 'start', route: { url: uri } }, customData: { requireStartAction: true } },
        signal,
      ),
    );

    let startAction: unknown = at(initData, 'startAction');
    for (;;) {
      const callPayload = at<Record<string, unknown>>(startAction, 'params.payload');
      if (!callPayload) return null;

      const call = at<string>(startAction, 'call');
      if (call === 'content.play') return { payload: callPayload, isUpsell: false };

      if (call === 'page.content.display') {
        const displayData = successData(await connection.request('page.content.display', { payload: callPayload }, signal));
        const blocks = at<unknown[]>(displayData, 'layout.blocks');
        if (!blocks) return null;
        const mainBlock = blocks.map((block) => at(block, 'mainAction.action')).find((action) => action != null);
        if (!mainBlock) return null;
        startAction = mainBlock;
        continue;
      }

      if (call === 'user.upsell.preview') return { payload: null, isUpsell: true };
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Public catalog operations
// ---------------------------------------------------------------------------

/** `Oneplay.SerialStrategy.getPrograms`: pages through the full "oneplay" catalogue, title-asc. */
export async function fetchAllPrograms(pool: OneplayConnectionPool, signal: AbortSignal): Promise<OneplayProgram[]> {
  const itemsPerPage = PROGRAM_LIST_MAX_ITEMS_PER_PAGE;
  const filterCriterias = `filter:${Buffer.from(JSON.stringify({ catalogue: 'oneplay' })).toString('base64')}`;
  const paging: Record<string, unknown> = { count: itemsPerPage, position: 1 };
  const payload: Record<string, unknown> = {
    carouselId: 'page:25;carousel:277',
    criteria: { filterCriterias, sortOption: 'title-asc' },
    paging,
  };

  const requestPage = async (): Promise<unknown> =>
    pool.withConnection(signal, async (connection) => successData(await connection.request('carousel.display', { payload }, signal)));

  const programs: OneplayProgram[] = [];
  let data = await requestPage();
  programs.push(...parseCarouselTiles(data, toProgram));

  const maxPage = at<number>(data, 'carousel.paging.pageCount') ?? 1;
  for (let page = 2; page <= maxPage; page++) {
    paging.position = (page - 1) * itemsPerPage + 1;
    data = await requestPage();
    programs.push(...parseCarouselTiles(data, toProgram));
  }

  return programs;
}

/**
 * Reads the labelled country/year metadata of a single program page, which is what makes an
 * automatic binding to an authoritative series identity verifiable rather than name-guessed.
 */
export async function fetchSeriesMetadata(
  pool: OneplayConnectionPool,
  program: OneplayProgram,
  signal: AbortSignal,
): Promise<ProgramMetadata | undefined> {
  const programInfo = await fetchProgramInfo(pool, program.uri, signal);
  if (!programInfo || programInfo.type === 'movie') return undefined;
  const contentData = await fetchContentData(pool, programInfo.programId, signal);
  return parseSeriesMetadata(contentData, program.uri, programInfo.title || program.title);
}

/**
 * `Oneplay.StrategyBase.getEpisodes` + `SerialStrategy.getEpisodes`: resolves a program page URI
 * to either a single movie or the full list of episodes across every season carousel, ordered by
 * season and episode number, newest first (shows with no season carousel keep whatever flat order
 * the upstream CMS gives, since no page/season information exists there to reorder by).
 */
export async function fetchEpisodesForProgram(
  pool: OneplayConnectionPool,
  programUri: string,
  signal: AbortSignal,
): Promise<ProgramEpisodes> {
  const programInfo = await fetchProgramInfo(pool, programUri, signal);
  if (!programInfo) throw new Error('Oneplay program not found');
  if (programInfo.type === 'movie') return { kind: 'movie', title: programInfo.title ?? '' };

  const contentData = await fetchContentData(pool, programInfo.programId, signal);
  const seasons = getSeasons(contentData);

  if (seasons.length === 0) {
    const items = getDirectEpisodes(contentData).map(
      (direct): OneplayEpisode => ({ uri: direct.uri, title: direct.title, season: undefined, episodeNumber: undefined }),
    );
    return { kind: 'episodes', title: programInfo.title ?? '', items };
  }

  const itemsPerPage = EPISODE_LIST_MAX_ITEMS_PER_PAGE;
  const items: OneplayEpisode[] = [];

  for (const season of seasons) {
    const paging: Record<string, unknown> = { count: itemsPerPage, position: 1 };
    const payload: Record<string, unknown> = {
      carouselId: season.carouselId,
      criteria: { filterCriterias: season.seasonId, sortOption: 'DESC' },
      paging,
    };

    let position = 1;
    let hasNext: boolean;
    do {
      paging.position = position;
      const data = await pool.withConnection(signal, async (connection) =>
        successData(await connection.request('carousel.display', { payload }, signal)),
      );
      for (const parsed of parseCarouselTiles(data, parseEpisodeItem)) {
        items.push({
          uri: parsed.uri,
          title: parsed.info.title,
          season: parsed.info.season > 0 ? parsed.info.season : undefined,
          episodeNumber: parsed.info.episodeNumber > 0 ? parsed.info.episodeNumber : undefined,
        });
      }
      hasNext = at<boolean>(data, 'carousel.paging.next') ?? false;
      position += itemsPerPage;
    } while (hasNext);
  }

  // Season tabs come oldest-first for some programs and newest-first for others (Love Island), so
  // the numbers decide; the stable sort keeps upstream order for ties and puts unnumbered items last.
  items.sort((a, b) => (b.season ?? -1) - (a.season ?? -1) || (b.episodeNumber ?? -1) - (a.episodeNumber ?? -1));
  return { kind: 'episodes', title: programInfo.title ?? '', items };
}

function findWidevineToken(drmInfos: readonly unknown[] | undefined): string | undefined {
  if (!drmInfos) return undefined;
  let token: string | undefined;
  for (const info of drmInfos) {
    if (at<string>(info, 'schema') === 'WidevineAcquisition') token = at<string>(info, 'drmAuthorization.value');
  }
  return token;
}

interface SubtitleTrack {
  readonly url: string;
  readonly language: string;
}

function parseSubtitles(rawSubtitles: readonly unknown[] | undefined): SubtitleTrack[] {
  if (!rawSubtitles) return [];
  const tracks: SubtitleTrack[] = [];
  for (const raw of rawSubtitles) {
    if (at<string>(raw, 'location.schema') !== 'ExternalTrackLocation') continue;
    const url = at<string>(raw, 'location.url');
    if (!url) continue;
    tracks.push({ url, language: at<string>(raw, 'language.code') ?? 'unknown' });
  }
  return tracks;
}

/**
 * `Oneplay.StrategyBase.getMedia` + `OneplayDRMEngine.createResolver`: resolves a playable page
 * URI to concrete DASH/HLS sources, attaching Widevine license info where the stream is DRM-gated.
 */
export async function resolveMediaSources(pool: OneplayConnectionPool, uri: string, signal: AbortSignal): Promise<MediaSource[]> {
  const playPayload = await fetchPlayPayload(pool, uri, signal);
  if (!playPayload) throw new Error('Failed to obtain Oneplay play criteria');
  if (playPayload.isUpsell || !playPayload.payload) {
    throw new Error('This content is not accessible, it requires a higher plan.');
  }
  const payload = playPayload.payload;

  const data = await pool.withConnection(signal, async (connection) => {
    const response = await connection.request('content.play', { payload, playbackCapabilities: playbackCapabilities() }, signal);
    // 4091 (all concurrent streams in use) is ignored elsewhere, but here it is why no stream is returned.
    if (response.status !== 'Ok' && Number(at(response.data, 'result.code')) === MAX_CONCURRENT_STREAMS) {
      throw new PlaybackBusy(`Oneplay: ${readErrorMessage(response.data)}`);
    }
    return successData(response);
  });

  const streams = at<unknown[]>(data, 'media.stream.assets') ?? [];
  const sources: MediaSource[] = [];

  for (const stream of streams) {
    const protocol = (at<string>(stream, 'protocol') ?? '').toLowerCase();
    if (protocol !== 'dash' && protocol !== 'hls') continue;
    const url = at<string>(stream, 'src');
    if (!url) continue;

    const source: MediaSource = { url, type: protocol === 'dash' ? 'dash' : 'hls' };

    const drmToken = findWidevineToken(at<unknown[]>(stream, 'drm'));
    if (drmToken) source.drm = { url: DRM_LICENSE_URL, headers: { Referer: DRM_REFERER, 'X-AxDRM-Message': drmToken } };

    const subtitles = parseSubtitles(at<unknown[]>(stream, 'subtitles'));
    if (subtitles.length > 0) source.subtitles = subtitles;

    sources.push(source);
  }

  return sources;
}
