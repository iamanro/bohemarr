/**
 * Ports the iPrima provider family, upstream:
 *  - `media_engine.iprima` (IPrimaEngine.java, IPrimaHelper.java, PrimaPlus.java)
 *  - `drm_engine.iprima` (IPrimaDRMEngine.java) — folded into `resolvePrimaPlus` below,
 *    since this project's `Provider.resolve` attaches DRM directly to `MediaSource.drm`
 *    instead of a separate DRM-engine registry.
 *
 * Supported sites (mirrors `IPrimaEngine.SUPPORTED_WEBS`):
 *  - `www.iprima.cz`  (Prima+, full catalog + programs/episodes/media, requires login)
 *  - `zoom.iprima.cz` (public programs/episodes/media)
 *  - `cnn.iprima.cz`  (public programs/episodes/media)
 *  - `fresh/zeny/cool.iprima.cz` (media-only, exactly like upstream `Features.MEDIA`)
 *
 * Prima+ access (program episode listing + playback) requires a real iPrima account;
 * this port never falls back to a bundled default account the way the upstream desktop
 * app does (`PrimaAuthenticator.Obf`). Without `providers.iprima.username`/`password`,
 * the provider still fully supports the public `zoom`/`cnn`/`fresh`/`zeny`/`cool` sites.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Catalogue, CatalogueQuery, License, MediaKind, MediaSource, Provider, ProviderConfig, Release, SeriesIdentity, ProgramMetadata } from '../types.ts';
import { isSeriesCandidate } from '../series-identity.ts';
import { fetchJson, fetchText, mediaType, releaseId } from './common.ts';
import { extractPlayIds, get, has, Nuxt, PrimaAuthError, PrimaMessageError, PrimaRpc } from './prima-common.ts';
import type { DatabaseSync } from 'node:sqlite';
import { PrimaAuthenticator } from './prima-auth.ts';
import { PrimaIndex, pageTitle } from './prima-index.ts';
import { SessionRejected } from './account-session.ts';

const PROVIDER_ID = 'iprima';
const REFERER = 'https://www.iprima.cz/';
const CNN_PROGRAMS_PAGE = 'https://cnn.iprima.cz/porady';
const AXDRM_LICENSE_URL = 'https://drm-widevine-licensing.axprod.net/AcquireLicense';

type Site = 'www' | 'zoom' | 'cnn' | 'fresh' | 'zeny' | 'cool';
const BROWSABLE_SITES: readonly Site[] = ['www', 'zoom', 'cnn'];

interface PrimaProgram {
  id: string;
  uri: string;
  title: string;
  kind: MediaKind;
  year?: number;
  site: Site;
  /** False for a Prima+ programme whose index title is still derived from its URL. */
  titled?: boolean;
}

interface PrimaEpisode {
  uri: string;
  title: string | null;
  season?: number;
  episode?: number;
}

/** `database` holds the Prima+ programme index (see `PrimaIndex`). */
export function createPrimaProviders(configs: Record<string, ProviderConfig>, database: DatabaseSync): Provider[] {
  const config = configs[PROVIDER_ID] ?? {};
  if (config.enabled === false) return [];

  const auth = new PrimaAuthenticator(config);
  const index = new PrimaIndex(database);

  const catalogue: Catalogue<PrimaProgram> = {
    concurrency: 4,
    programs: (_query: CatalogueQuery, signal: AbortSignal) => programs(auth, index, signal),
    program: (id: string, signal: AbortSignal) => boundProgram(id, signal),
    releases: (program: PrimaProgram, _query: CatalogueQuery, signal: AbortSignal) => releases(program, auth, signal),
  };

  return [{
    id: PROVIDER_ID,
    name: 'iPrima',
    catalogue,
    seriesCandidates: auth.hasCredentials() ? (identity, signal) => seriesCandidates(index, identity, signal) : undefined,
    resolve: (release: Release, signal: AbortSignal) => resolve(release, signal, auth),
    close: () => index.close(),
  }];
}

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

async function* programs(auth: PrimaAuthenticator, index: PrimaIndex, signal: AbortSignal): AsyncGenerator<PrimaProgram> {
  const sites: Site[] = auth.hasCredentials() ? [...BROWSABLE_SITES] : ['zoom', 'cnn'];
  for (const site of sites) yield* programsForSite(site, index, signal);
}

async function boundProgram(id: string, signal: AbortSignal): Promise<PrimaProgram | undefined> {
  const url = new URL(id);
  if (url.origin !== 'https://www.iprima.cz' || !url.pathname.startsWith('/serialy/')) {
    throw new Error('Invalid Prima+ series identity');
  }
  const title = await primaPlusTitle(url.href, signal);
  if (get<string>(title, 'type', '') !== 'series') return undefined;
  return { id: url.href, uri: url.href, title: get(title, 'title', '').trim(), kind: 'tv', site: 'www' };
}

async function* releases(program: PrimaProgram, auth: PrimaAuthenticator, signal: AbortSignal): AsyncGenerator<Release> {
  // Releases carry the real programme name, which Sonarr/Radarr parse; a URL-derived one would not match.
  let named = program;
  if (program.kind === 'movie' && program.site === 'www') {
    const title = await primaPlusTitle(program.uri, signal);
    const year = Number(get<unknown>(title, 'additionals.year', undefined));
    named = { ...program, title: get<string>(title, 'title', program.title).trim(),
      year: Number.isSafeInteger(year) && year > 0 ? year : undefined };
  } else if (program.titled === false) {
    named = { ...program, title: await pageTitle(program.uri, signal) ?? program.title };
  }
  for await (const episode of episodesForSite(named.site, named, auth, signal)) yield buildRelease(named, episode);
}

function buildRelease(program: PrimaProgram, episode: PrimaEpisode): Release {
  return {
    id: releaseId(PROVIDER_ID, episode.uri),
    provider: PROVIDER_ID,
    title: episode.title ?? program.title,
    url: episode.uri,
    kind: program.kind,
    year: program.year,
    series: program.kind === 'tv' ? program.title : undefined,
    programId: program.kind === 'tv' ? program.uri : undefined,
    season: episode.season,
    episode: episode.episode,
    data: { site: program.site },
  };
}

// ---------------------------------------------------------------------------------------------
// Program listing — ports `SnippetProgramObtainer` / `StaticProgramObtainer`; Prima+ uses PrimaIndex
// ---------------------------------------------------------------------------------------------

async function* programsForSite(site: Site, index: PrimaIndex, signal: AbortSignal): AsyncGenerator<PrimaProgram> {
  switch (site) {
    case 'www':
      for await (const program of index.programs(signal)) yield { ...program, id: program.uri, site: 'www' };
      return;
    case 'zoom': yield* zoomPrograms(signal); return;
    case 'cnn': yield* cnnPrograms(signal); return;
    default: return; // fresh/zeny/cool never exposed program listings upstream (Features.MEDIA only)
  }
}

async function* zoomPrograms(signal: AbortSignal): AsyncGenerator<PrimaProgram> {
  const limit = 100;

  for (let offset = 0; offset <= 20_000; offset += limit) {
    const url = `https://zoom.iprima.cz/snippet/programme/${limit}/${offset}/programme`;
    let html: string;
    try {
      html = await fetchText(url, signal);
    } catch {
      break; // Past the end of the list
    }
    if (!html.trim()) break;

    const $ = cheerio.load(html);
    const articles = $('article').toArray();
    if (articles.length === 0) break;

    for (const el of articles) {
      const $item = $(el);
      const srcset = $item.find('img[srcset]').attr('srcset');
      const isActive = Boolean(srcset) && srcset!.split(',').some((part) => !part.includes('fallback-image.jpg'));
      if (!isActive) continue;

      const link = $item.find('.card-small-heading a').first();
      const href = link.attr('href');
      if (!href) continue;

      const uri = new URL(href, url).href;
      yield { id: uri, uri, title: link.text().trim(), kind: 'tv', site: 'zoom' };
    }
  }
}

async function* cnnPrograms(signal: AbortSignal): AsyncGenerator<PrimaProgram> {
  const html = await fetchText(CNN_PROGRAMS_PAGE, signal);
  const $ = cheerio.load(html);
  const selector = '.swiper-primary-programmes .molecule-programme-title > a, .programmes-list .molecule-programme-title > a';

  for (const el of $(selector).toArray()) {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) continue;
    const uri = new URL(href, CNN_PROGRAMS_PAGE).href;
    yield { id: uri, uri, title: $el.text().trim(), kind: 'tv', site: 'cnn' };
  }
}

// ---------------------------------------------------------------------------------------------
// Episode listing — ports `PrimaPlus.API` / `StaticEpisodeObtainer` / `SnippetEpisodeObtainer`
// ---------------------------------------------------------------------------------------------

async function* episodesForSite(
  site: Site, program: PrimaProgram, auth: PrimaAuthenticator, signal: AbortSignal,
): AsyncGenerator<PrimaEpisode> {
  switch (site) {
    case 'www': yield* primaPlusEpisodes(program, auth, signal); return;
    case 'zoom': yield* await zoomEpisodes(program, signal); return;
    case 'cnn': yield* cnnEpisodes(program, signal); return;
    default: return;
  }
}

async function primaPlusTitle(uri: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const nuxt = Nuxt.extract(await fetchText(uri, signal));
  for (const value of Object.values(nuxt?.data() ?? {})) {
    const title = get<Record<string, unknown> | null>(value, 'title', null);
    if (title && get<string>(title, 'id', '')) return title;
    const content = get<Record<string, unknown> | null>(value, 'content', null);
    if (content && get<string>(content, 'type', '') === 'movie' && get<string>(content, 'id', '')) return content;
  }
  throw new Error(`Unable to extract Prima+ program metadata for ${uri}`);
}

async function seriesCandidates(index: PrimaIndex, identity: SeriesIdentity, signal: AbortSignal): Promise<ProgramMetadata[]> {
  const candidates: ProgramMetadata[] = [];
  for await (const program of index.programs(signal)) {
    if (program.kind !== 'tv' || !isSeriesCandidate(program.title, identity)) continue;
    const title = await primaPlusTitle(program.uri, signal);
    if (get<string>(title, 'type', '') !== 'series') continue;
    const year = get<number>(title, 'year', 0);
    candidates.push({
      id: program.uri, title: get(title, 'title', '').trim(), aliases: [],
      year: Number.isSafeInteger(year) && year > 0 ? year : undefined,
      countries: get<unknown[]>(title, 'countries', []).map(country => get<string>(country, 'label', '')).filter(Boolean),
    });
  }
  return candidates;
}

async function* primaPlusEpisodes(program: PrimaProgram, auth: PrimaAuthenticator, signal: AbortSignal): AsyncGenerator<PrimaEpisode> {
  if (program.kind === 'movie') { yield { uri: program.uri, title: null }; return; }

  let programId: string;
  try {
    programId = await auth.run(async (session, signal) => {
      const headers = auth.headers(session);
      const html = await fetchText(program.uri, signal, { headers });
      const nuxt = Nuxt.extract(html);
      if (nuxt) {
        for (const value of Object.values(nuxt.data())) {
          const id = get<string>(value, 'title.id', '');
          if (id) return id;
        }
      }
      throw new SessionRejected(`Unable to extract Prima+ program id for ${program.uri}`);
    }, signal);
  } catch (error) {
    if (error instanceof SessionRejected) throw new Error(error.message);
    throw error;
  }

  // Each season's episodes already arrive newest-first (requested `ordering: desc`); sorting
  // seasons newest-first too, and fetching lazily, yields the whole Program newest-first without
  // fetching a season the caller never asks for.
  const seasons = (await auth.run(
    (session, signal) => listSeasons(programId, session.accessToken, signal), signal,
  )).sort((a, b) => b.number - a.number);
  for (const season of seasons) {
    yield* await auth.run(
      (session, signal) => listEpisodesForSeason(program, season.id, session.accessToken, signal), signal,
    );
  }
}

async function listSeasons(
  programId: string, accessToken: string, signal: AbortSignal,
): Promise<Array<{ id: string; number: number }>> {
  const result = await PrimaRpc.request(
    'vdm.frontend.season.list.hbbtv',
    { _accessToken: accessToken, id: programId, pager: { limit: 999, offset: 0 } },
    signal,
  );
  if (PrimaRpc.isError(result)) {
    throw new PrimaMessageError(get(result, 'error.message', 'Unable to list iPrima seasons'));
  }
  return get<unknown[]>(result, 'data', []).map((s) => ({
    id: get<string>(s, 'id', ''),
    number: get<number>(s, 'seasonNumber', 0),
  }));
}

async function listEpisodesForSeason(
  program: PrimaProgram, seasonId: string, accessToken: string, signal: AbortSignal,
): Promise<PrimaEpisode[]> {
  const result = await PrimaRpc.request(
    'vdm.frontend.episodes.list.hbbtv',
    {
      _accessToken: accessToken,
      id: seasonId,
      pager: { limit: 999, offset: 0 },
      ordering: { field: 'episodeNumber', direction: 'desc' },
    },
    signal,
  );
  if (PrimaRpc.isError(result)) {
    throw new PrimaMessageError(get(result, 'error.message', 'Unable to list iPrima episodes'));
  }

  const seasonNumber = get<number>(result, 'data.seasonNumber', 0);
  const nameOnlyRe = new RegExp(`Epizoda\\s+\\d+|^${escapeRegExp(program.title)}\\s+\\(\\d+\\)$`, 'i');
  const episodes: PrimaEpisode[] = [];

  for (const item of get<unknown[]>(result, 'data.episodes', [])) {
    if (has(item, 'distribution.upsell')) continue; // Not playable at the current account tier

    let title: string | null = get<string>(item, 'title', '');
    const webUrl = get<string | null>(item, 'additionals.webUrl', null);
    const episodeNumber = get<number>(item, 'additionals.episodeNumber', 0);
    const slug = get<string>(item, 'slug', '');
    const uri = webUrl ? webUrl : new URL(slug, program.uri).href;

    if (nameOnlyRe.test(title)) title = null;

    episodes.push({ uri, title, season: seasonNumber || undefined, episode: episodeNumber || undefined });
  }
  return episodes;
}

async function zoomEpisodes(program: PrimaProgram, signal: AbortSignal): Promise<PrimaEpisode[]> {
  const html = await fetchText(program.uri, signal);
  const $ = cheerio.load(html);
  const episodes: PrimaEpisode[] = [];

  for (const el of $('#episodes-video-holder > article').toArray()) {
    const link = $(el).find('a:not(.hover-zoom-img)').first();
    const href = link.attr('href');
    if (!href) continue;
    episodes.push({ uri: new URL(href, program.uri).href, title: link.text().trim() || null });
  }
  return episodes;
}

const CNN_SNIPPET_REF_RE = /new\s+InfiniteCarousel\([^,]+,\s*'\/snippet\/episode\/limit\/offset\/([^']+)',[^)]+\)/s;
const CNN_EPISODE_NAME_ONLY_RE = /^\d+\.\s+epizoda/i;
const CNN_DASH_PREFIX_RE = /^\s*-\s*/;
const CZECH_MONTH_NUMBERS: Record<string, number> = {
  ledna: 1, unora: 2, února: 2, brezna: 3, března: 3, dubna: 4, kvetna: 5, května: 5,
  cervna: 6, června: 6, cervence: 7, července: 7, srpna: 8, zari: 9, září: 9,
  rijna: 10, října: 10, listopadu: 11, prosince: 12,
};

async function* cnnEpisodes(program: PrimaProgram, signal: AbortSignal): AsyncGenerator<PrimaEpisode> {
  const programHtml = await fetchText(program.uri, signal);
  const match = CNN_SNIPPET_REF_RE.exec(programHtml);
  if (!match) return;

  const programId = match[1]!;
  const host = new URL(program.uri).host;
  const limit = 64;
  const snippetUrl = (offset: number) => `https://${host}/snippet/episode/${limit}/${offset}/${programId}`;

  const contentLengthAt = async (offset: number): Promise<number> => {
    try {
      return (await fetchText(snippetUrl(offset), signal)).trim().length;
    } catch {
      return 0;
    }
  };

  // Upstream uses HEAD + Content-Length for this probe; a plain GET is used here for
  // portability, trading a little bandwidth for not depending on HEAD support.
  let lo = 0;
  let hi = limit;
  while ((await contentLengthAt(hi)) > 0) { lo = hi; hi *= 2; }
  while (hi - lo > limit) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if ((await contentLengthAt(mid)) <= 0) hi = mid; else lo = mid;
  }

  // Offset 0 is the newest page. Untitled episodes are numbered from the oldest one, so every page
  // is read oldest first, and the episodes are handed out newest first once all are numbered.
  const indexes = new Map<number, number>();
  const episodes: PrimaEpisode[] = [];
  for (let offset = lo; offset >= 0; offset -= limit) {
    const html = await fetchText(snippetUrl(offset), signal);
    const $ = cheerio.load(html);
    for (const el of $('article.molecule-video').toArray().reverse()) episodes.push(parseCnnEpisodeItem($, el, program, indexes));
  }
  yield* episodes.reverse();
}

function parseCnnEpisodeItem(
  $: cheerio.CheerioAPI, el: AnyNode, program: PrimaProgram, indexes: Map<number, number>,
): PrimaEpisode {
  const $item = $(el);
  const link = $item.find('h3 > a').first();
  const uri = new URL(link.attr('href') ?? '', program.uri).href;
  let title = link.text().trim();

  let dateString: string | null = null;
  let numSeason = 0;
  let numEpisode = 0;

  const dateEl = $item.find('h3 + div > span').first();
  if (dateEl.length > 0) {
    dateString = dateEl.text().trim();
    numSeason = parseCzechDateYear(dateString) ?? 0;
  }

  const quotedTitle = quoteIgnoringPunctuation(program.title);
  const titleWithNumberRe = new RegExp(`${quotedTitle}\\s+\\((\\d+\\.?)\\)`, 'iu');
  const subheadingRe = new RegExp(
    `^${quotedTitle}(?:\\s+\\(?(?:\\d{1,2}\\.\\s*\\d{1,2}\\.\\s*\\d{4}(?:\\s+\\d{2}:\\d{2})?|\\d+\\.?)\\)?)?$`, 'iu',
  );

  let match = titleWithNumberRe.exec(title);
  if (match) { numEpisode = parseInt(match[1]!, 10); title = ''; }

  const subheading = $item.find('p + h3').first();
  if (subheading.length > 0) {
    const prefix = subheading.prev().text();
    if ((match = titleWithNumberRe.exec(prefix))) {
      numEpisode = parseInt(match[1]!, 10);
    } else if (!subheadingRe.test(prefix)) {
      title = prefix + (title === '' || prefix.endsWith(title) ? '' : ` - ${title}`);
    }
  }

  if (numEpisode === 0) {
    const next = (indexes.get(numSeason) ?? 1) + 1;
    numEpisode = next - 1;
    indexes.set(numSeason, next);
  } else if (numSeason !== 0) {
    const current = indexes.get(numSeason);
    indexes.set(numSeason, (current === undefined ? numEpisode : Math.max(numEpisode, current)) + 1);
  }

  if (subheadingRe.test(title)) title = '';
  if (dateString) title += (title === '' ? '' : ' - ') + dateString;

  const nameOnlyMatch = CNN_EPISODE_NAME_ONLY_RE.exec(title);
  if (nameOnlyMatch) {
    const end = nameOnlyMatch.index + nameOnlyMatch[0].length;
    title = end === title.length ? '' : title.slice(end);
  }

  const dashMatch = CNN_DASH_PREFIX_RE.exec(title);
  if (dashMatch) title = title.slice(dashMatch[0].length);

  title = title.trim();
  return { uri, title: title === '' ? null : title, season: numSeason || undefined, episode: numEpisode || undefined };
}

function parseCzechDateYear(text: string): number | null {
  const m = /^(\d{1,2})\.\s*([\p{L}]+)\s+(\d{4})\s+(\d{2}):(\d{2})$/u.exec(text.trim());
  if (!m) return null;
  if (!(m[2]!.toLowerCase() in CZECH_MONTH_NUMBERS)) return null;
  return Number(m[3]);
}

function quoteIgnoringPunctuation(text: string): string {
  const punctuationRe = /[^\p{L}\s]/gu;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = punctuationRe.exec(text))) {
    out += escapeRegExp(text.slice(last, match.index));
    out += `${escapeRegExp(match[0])}?`;
    last = match.index + match[0].length;
  }
  out += escapeRegExp(text.slice(last));
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------
// Resolve — ports `DefaultMediaObtainer` and `PrimaPlus.API#getMedia` + `IPrimaDRMEngine`
// ---------------------------------------------------------------------------------------------

function subdomainOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const dot = parsed.hostname.indexOf('.');
  if (dot < 0) return null;
  const rest = parsed.hostname.slice(dot + 1);
  if (rest.toLowerCase() !== 'iprima.cz') return null;
  return parsed.hostname.slice(0, dot);
}

async function resolve(release: Release, signal: AbortSignal, auth: PrimaAuthenticator): Promise<MediaSource[]> {
  const subdomain = subdomainOf(release.url);
  if (!subdomain) throw new Error(`${release.url} is not an iprima.cz URL`);

  switch (subdomain.toLowerCase()) {
    case 'www': return resolvePrimaPlus(release, signal, auth);
    case 'zoom':
    case 'cnn':
    case 'fresh':
    case 'zeny':
    case 'cool':
      return resolveDefault(release, signal, auth);
    default:
      throw new Error(`Unsupported iPrima subdomain '${subdomain}' in ${release.url}`);
  }
}

function extractInlineScripts(html: string): string[] {
  const $ = cheerio.load(html);
  return $('script:not([src])').toArray().map((el) => $(el).html() ?? '');
}

function collectStreamInfos(data: unknown): unknown[] {
  if (Array.isArray(data)) return data.flatMap((c) => get<unknown[]>(c, 'streamInfos', []));
  return get<unknown[]>(data, 'streamInfos', []);
}

/** Ports `IPrimaHelper.DefaultMediaObtainer`, used by zoom/cnn/fresh/zeny/cool. */
async function resolveDefault(release: Release, signal: AbortSignal, auth: PrimaAuthenticator): Promise<MediaSource[]> {
  const build = async (headers: Record<string, string>, signal: AbortSignal): Promise<MediaSource[]> => {
    const html = await fetchText(release.url, signal, { headers });
    const playIds = extractPlayIds(html, extractInlineScripts(html));
    if (playIds.length === 0) throw new Error(`No playable stream found for ${release.url}`);

    const sources: MediaSource[] = [];
    for (const playId of playIds) {
      const data = await fetchJson<unknown>(
        `https://api.play-backend.iprima.cz/api/v1/products/play/ids-${playId}`, signal, { headers },
      );
      for (const streamInfo of collectStreamInfos(data)) {
        const url = get<string>(streamInfo, 'url', '');
        if (!url) continue;
        const type = get<string>(streamInfo, 'type', '').toLowerCase();
        sources.push({ url, type: type === 'dash' || type === 'hls' ? type : mediaType(url), headers: { Referer: REFERER } });
      }
    }

    if (sources.length === 0) throw new Error(`iPrima returned no stream URLs for ${release.url}`);
    return sources;
  };

  if (!auth.hasCredentials()) return build({ Referer: REFERER }, signal);
  return auth.run((session, signal) => build(auth.headers(session), signal), signal);
}

/** Ports `PrimaPlus.API#getMedia` + `IPrimaDRMEngine` (AxDRM Widevine license for DASH). */
async function resolvePrimaPlus(release: Release, signal: AbortSignal, auth: PrimaAuthenticator): Promise<MediaSource[]> {
  if (!auth.hasCredentials()) {
    throw new PrimaAuthError('Resolving Prima+ (www.iprima.cz) media requires providers.iprima.username/password');
  }

  let configData: unknown;
  try {
    configData = await auth.run(async (session, signal) => {
      const headers = auth.headers(session);
      const html = await fetchText(release.url, signal, { headers });
      const nuxt = Nuxt.extract(html);
      if (!nuxt) throw new Error(`Unable to extract Prima+ media information for ${release.url}`);

      let nuxtData: Record<string, unknown> | null = null;
      for (const value of Object.values(nuxt.data())) {
        if (has(value, 'playId') || has(value, 'content')) { nuxtData = value as Record<string, unknown>; break; }
      }
      if (!nuxtData) throw new Error(`Unable to extract Prima+ media information for ${release.url}`);
      if (has(nuxtData, 'content')) nuxtData = get(nuxtData, 'content', {} as Record<string, unknown>);

      const playId = get<string | null>(nuxtData, 'playId', null);
      if (!playId) throw new Error(`Unable to extract Prima+ play ID for ${release.url}`);

      const data = await fetchJson<unknown>(
        `https://api.play-backend.iprima.cz/api/v1/products/play/ids-${playId}`, signal, { headers },
      );

      const errorInfo = Array.isArray(data)
        ? data.map((c) => get(c, 'errorResult', null)).find((e) => e) ?? null
        : get(data, 'errorResult', null);
      if (errorInfo) throw new SessionRejected(`iPrima playback error: ${get(errorInfo, 'errorCode', 'unknown')}`);

      return data;
    }, signal);
  } catch (error) {
    if (error instanceof SessionRejected) throw new PrimaMessageError(error.message);
    throw error;
  }

  const items = Array.isArray(configData) ? configData : [configData];
  const subtitles: NonNullable<MediaSource['subtitles']> = [];

  for (const item of items) {
    for (const subInfo of get<unknown[]>(item, 'subInfos', [])) {
      const url = get<string>(subInfo, 'url', '');
      if (!url) continue;
      subtitles.push({ url, language: get<string>(subInfo, 'lang.key', '') });
    }
  }

  const sources: MediaSource[] = [];

  for (const item of items) {
    for (const streamInfo of get<unknown[]>(item, 'streamInfos', [])) {
      const url = get<string>(streamInfo, 'url', '');
      if (!url) continue;
      const type = get<string>(streamInfo, 'type', '').toLowerCase();
      let drm: License | undefined;

      if (has(streamInfo, 'drmInfo')) {
        if (type !== 'dash') continue; // Widevine over HLS is not supported, matching upstream
        const modular = get<unknown[]>(streamInfo, 'drmInfo.modularDrmInfos', []);
        const widevine = modular.find((m) => get<string>(m, 'keySystem', '') === 'com.widevine.alpha');
        const token = widevine ? get<string | null>(widevine, 'token', null) : null;
        if (token) {
          drm = { url: AXDRM_LICENSE_URL, headers: { Referer: REFERER, 'X-AxDRM-Message': token } };
        }
      }

      sources.push({
        url,
        type: type === 'dash' || type === 'hls' ? type : mediaType(url),
        headers: { Referer: REFERER },
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        drm,
      });
    }
  }

  if (sources.length === 0) throw new Error(`iPrima returned no stream URLs for ${release.url}`);
  return sources;
}
