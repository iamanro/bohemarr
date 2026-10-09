// Headless TypeScript port of seven media-downloader Java plugins:
//  - media_engine.tvprimadoma  (TVPrimaDomaEngine)  - real program/episode catalog + OnNetwork embed
//  - media_engine.tvbarrandov  (TVBarrandovEngine)  - real program/episode catalog + auth + local video/YouTube delegation
//  - media_engine.tvautosalon  (TVAutosalonEngine)  - real program/season/episode catalog + OnNetwork embed
//  - server.rtvs               (STVRServer)          - URL resolver (stvr.sk archive JSON playlists)
//  - server.html5              (HTML5Server)         - generic <video>/<source> URL resolver
//  - server.direct             (DirectServer)        - raw file URL passthrough
//  - server.youtube            (YouTubeServer)       - YouTube adaptive-format resolver (see public-sites-youtube.ts)
//
// The three media_engine.* providers expose real upstream catalogs: `programs()` enumerates
// their program listings, `releases()` enumerates each program's episodes newest first. The
// four server.* providers have no upstream browse capability of their own; their Catalogue
// enumerates no Programs and instead resolves `q` given as a direct, host-validated URL via
// `releaseForUrl`. Static `config.catalog` entries are attached centrally by providers/index.ts.
import JSON5 from 'json5';
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Catalogue, CatalogueQuery, MediaKind, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { empty, fetchJson, fetchText, mediaType, normalize, releaseId } from './common.ts';
import { isYouTubeUrl, maybeTransformYouTubeUrl, resolveYouTube } from './public-sites-youtube.ts';
import { resolveOnNetworkEmbed } from './public-sites-onnetwork.ts';
import { authenticateBarrandov, fetchBarrandovDocument, parseBarrandovLocalSources } from './public-sites-barrandov.ts';

// ---------------------------------------------------------------------------
// Generic helpers shared across providers in this file
// ---------------------------------------------------------------------------

function absUrl(base: string, href: string): string {
  return new URL(href, base).toString();
}

function basenameNoExt(pathname: string): string {
  const base = pathname.split('/').filter(Boolean).pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

/** A media_engine.* program: an upstream program listing entry with its own page. */
interface ScrapedProgram { id: string; title: string; kind: 'tv'; url: string }

/**
 * Builds the synthetic Release a direct http(s) URL query names, for the four pure
 * URL-resolver providers (stvr, html5, direct, youtube): these have no upstream
 * browse/search capability and only resolve `q` as a URL naming their own host.
 */
async function urlResolverRelease(
  id: string,
  url: URL,
  query: CatalogueQuery,
  isCompatible: (url: string) => boolean,
  options: { normalizeUrl?: (url: string) => string; title?: (url: string) => string } = {},
): Promise<Release | undefined> {
  const original = url.toString();
  if (!isCompatible(original)) return undefined;
  const normalized = options.normalizeUrl ? options.normalizeUrl(original) : original;
  const parsed = new URL(normalized);
  const title = options.title ? options.title(normalized) : (basenameNoExt(parsed.pathname) || parsed.hostname);
  const kind: MediaKind = query.kind ?? 'movie';
  return { id: releaseId(id, normalized), provider: id, title, url: normalized, kind };
}

// ---------------------------------------------------------------------------
// media_engine.tvprimadoma
// ---------------------------------------------------------------------------

const URL_PRIMADOMA_PROGRAMS = 'https://primadoma.tv/porady';
const URL_PRIMADOMA_REFERER = 'https://primadoma.tv/';
const SELECTOR_PRIMADOMA_PROGRAMS = '.container .row .col > article > a';
const SELECTOR_PRIMADOMA_EPISODES_CONTAINERS = '.head + section > .container > .row';
const SELECTOR_PRIMADOMA_EPISODES = '.col > article > a';
const SELECTOR_PRIMADOMA_PAGINATION = '.pagination-desktop';
const REGEX_PRIMADOMA_EPISODE = /(?:\s*-\s*)?(?:(\d+)\.?\s*díl|díl\s+(\d+)\.?)\s*(?:,\s*|:\s*)?/iu;
const REGEX_PRIMADOMA_SEASON = /s[ée]rie\s+(\d+)\.?\s*-\s*/iu;

async function fetchPrimaDomaPrograms(signal: AbortSignal): Promise<ScrapedProgram[]> {
  const html = await fetchText(URL_PRIMADOMA_PROGRAMS, signal);
  const $ = cheerio.load(html);
  const programs: ScrapedProgram[] = [];

  $(SELECTOR_PRIMADOMA_PROGRAMS).each((_i, el) => {
    const $el = $(el);
    const title = $el.find('h3').first().text();
    const href = $el.attr('href');
    if (href && title) {
      const url = absUrl(URL_PRIMADOMA_PROGRAMS, href);
      programs.push({ id: url, title, kind: 'tv', url });
    }
  });

  return programs;
}

function parsePrimaDomaEpisodesList($: CheerioAPI, container: Cheerio<AnyNode>, program: ScrapedProgram): Release[] {
  const releases: Release[] = [];
  const regexProgramTitle = new RegExp(`^${RegExp.escape(program.title)}\\s+-\\s*`, 'iu');

  container.find(SELECTOR_PRIMADOMA_EPISODES).each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const titleEl = $el.find('h3').first();
    if (!href || titleEl.length === 0) return;

    let title = titleEl.text();
    let season: number | undefined;
    let episode: number | undefined;

    const seasonMatch = REGEX_PRIMADOMA_SEASON.exec(title);
    if (seasonMatch) {
      season = Number.parseInt(seasonMatch[1]!, 10);
      title = title.slice(0, seasonMatch.index) + title.slice(seasonMatch.index + seasonMatch[0].length);
    }

    const episodeMatch = REGEX_PRIMADOMA_EPISODE.exec(title);
    if (episodeMatch) {
      const numStr = episodeMatch[1] ?? episodeMatch[2];
      if (numStr) episode = Number.parseInt(numStr, 10);
      title = title.slice(0, episodeMatch.index) + title.slice(episodeMatch.index + episodeMatch[0].length);
    }

    const programTitleMatch = regexProgramTitle.exec(title);
    if (programTitleMatch) {
      title = (title.slice(0, programTitleMatch.index) + title.slice(programTitleMatch.index + programTitleMatch[0].length)).trim();
    }

    const url = absUrl(program.url, href);
    releases.push({
      id: releaseId('tvprimadoma', url), provider: 'tvprimadoma', title: title.trim() || program.title,
      url, kind: 'tv', series: program.title, season, episode,
    });
  });

  return releases;
}

// The porady episode listing already surfaces the newest episodes on its first (unpaginated)
// page and each subsequent numbered page further back in time, so walking forward from page 1
// yields Releases newest first without needing to know the total episode count up front.
async function* primaDomaReleases(program: ScrapedProgram, signal: AbortSignal): AsyncGenerator<Release> {
  const html = await fetchText(program.url, signal);
  const $ = cheerio.load(html);

  for (const container of $(SELECTOR_PRIMADOMA_EPISODES_CONTAINERS).toArray()) {
    const $container = $(container);
    const headerText = $container.find('h2').first().text().toLowerCase();
    if (headerText.includes('nejsledovanější')) continue; // "most watched" duplicates other entries
    yield* parsePrimaDomaEpisodesList($, $container, program);
  }

  const pagination = $(SELECTOR_PRIMADOMA_PAGINATION).first();
  if (pagination.length === 0) return;

  const maxPage = Number.parseInt(pagination.children().last().prev().text(), 10);
  const nextHref = pagination.find('[aria-current]').first().next().find('a').first().attr('href');
  if (!nextHref || !Number.isFinite(maxPage)) return;

  const urlBase = absUrl(program.url, nextHref).replace(/\?page=\d+/, '?page=%PAGE%');
  for (let page = 2; page <= maxPage; page++) {
    const pageHtml = await fetchText(urlBase.replace('%PAGE%', String(page)), signal);
    const $page = cheerio.load(pageHtml);
    const container = $page(SELECTOR_PRIMADOMA_EPISODES_CONTAINERS).first();
    yield* parsePrimaDomaEpisodesList($page, container, program);
  }
}

async function resolveTvPrimaDoma(release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const html = await fetchText(release.url, signal);
  const $ = cheerio.load(html);

  const iframe = $('.container div > iframe').first();
  if (iframe.length > 0) {
    const iframeSrc = iframe.attr('src');
    if (iframeSrc?.startsWith('https://www.stream.cz')) {
      throw new Error('TVPrimaDoma: video is embedded from Stream.cz, which is outside this provider bundle (no Stream.cz provider available)');
    }
  }

  const scriptSrc = $('.container div > script').first().attr('src');
  if (!scriptSrc) throw new Error('TVPrimaDoma: unable to find embedding script on the episode page');

  return resolveOnNetworkEmbed(absUrl(release.url, scriptSrc), URL_PRIMADOMA_REFERER, signal);
}

// ---------------------------------------------------------------------------
// media_engine.tvbarrandov
// ---------------------------------------------------------------------------

const URL_BARRANDOV_PROGRAMS = 'https://www.barrandov.tv/porady/';
const SELECTOR_BARRANDOV_PROGRAMS = '.main > .section > .container > .grid > .col';
const SELECTOR_BARRANDOV_EPISODES = `${SELECTOR_BARRANDOV_PROGRAMS} > .show-box:not(.show-box--date)`;
const REGEX_BARRANDOV_EPISODE_URL = /\/video\/\d+((?:-[^-]+)+)-(\d{1,2})-(\d{1,2})-(\d{4})$/;

async function fetchBarrandovPrograms(signal: AbortSignal): Promise<ScrapedProgram[]> {
  const html = await fetchText(URL_BARRANDOV_PROGRAMS, signal);
  const $ = cheerio.load(html);
  const programs: ScrapedProgram[] = [];

  $(SELECTOR_BARRANDOV_PROGRAMS).each((_i, el) => {
    const $el = $(el);
    if ($el.find('.show-box').length === 0) return; // divider between highlighted/other shows
    const href = $el.find('a.show-box__container').first().attr('href');
    const title = $el.find('.show-box__title').first().text();
    if (href && title) {
      const url = absUrl(URL_BARRANDOV_PROGRAMS, href);
      programs.push({ id: url, title, kind: 'tv', url });
    }
  });

  return programs;
}

function maybeImproveBarrandovTitle(program: ScrapedProgram, url: string, title: string): string {
  const match = REGEX_BARRANDOV_EPISODE_URL.exec(new URL(url).pathname);
  if (!match) return title;

  const normalizedName = normalize(program.title).replace(/\s+/g, '-');
  let extractedName = match[1]!.replace(/^-/, '');
  if (normalizedName === extractedName) return title;

  extractedName = extractedName.replace(new RegExp(`^${RegExp.escape(normalizedName)}`), '').replace(/^-/, '').replace(/-/g, ' ');
  if (!extractedName) return title;

  const titlized = extractedName.replace(/\b\w/gu, (c) => c.toUpperCase());
  return `${titlized} (${title})`;
}

function parseBarrandovEpisodesPage($: CheerioAPI, program: ScrapedProgram): Release[] {
  const releases: Release[] = [];

  $(SELECTOR_BARRANDOV_EPISODES).each((_i, el) => {
    const $el = $(el);
    const href = $el.find('a.show-box__container').first().attr('href');
    const timestamp = $el.find('.show-box__timestamp').first().text();
    if (!href) return;
    const url = absUrl(program.url, href);
    const title = maybeImproveBarrandovTitle(program, url, timestamp);
    releases.push({ id: releaseId('tvbarrandov', url), provider: 'tvbarrandov', title, url, kind: 'tv', series: program.title });
  });

  return releases;
}

// The show's /video listing surfaces its newest episode on page 1 and older episodes on
// higher-numbered pages, so walking forward yields Releases newest first.
async function* barrandovReleases(program: ScrapedProgram, signal: AbortSignal): AsyncGenerator<Release> {
  const basePath = program.url.replace(/\/$/, '');
  const firstHtml = await fetchText(`${basePath}/video?page=1`, signal);
  const $ = cheerio.load(firstHtml);

  let lastPage = 1;
  const pagination = $('.pagination__pages').first();
  if (pagination.length > 0) {
    const pageNumbers = pagination.children().toArray()
      .map((el) => Number.parseInt($(el).text(), 10))
      .filter((n) => Number.isFinite(n));
    if (pageNumbers.length > 0) lastPage = Math.max(...pageNumbers);
  }

  yield* parseBarrandovEpisodesPage($, program);

  for (let page = 2; page <= lastPage; page++) {
    const pageHtml = await fetchText(`${basePath}/video?page=${page}`, signal);
    const $page = cheerio.load(pageHtml);
    yield* parseBarrandovEpisodesPage($page, program);
  }
}

// Finds the enclosing balanced-brace object starting at the '{' at or after fromIndex.
function bracketForward(text: string, open: string, close: string, fromIndex: number): string {
  const start = text.indexOf(open, fromIndex);
  if (start < 0) throw new Error(`Barrandov: unable to find opening '${open}'`);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`Barrandov: unmatched '${open}${close}' block`);
}

function firstNestedObject(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (nested && typeof nested === 'object') return nested;
    }
  }
  return undefined;
}

function getPathValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    return Array.isArray(acc) ? acc[Number(key)] : (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Port of the premium-archive fallback in TVBarrandovEngine#getMedia: some videos marked as
 * premium are actually publicly available on the official YouTube channel. Searches that
 * channel for a video whose title contains both the program name and the episode's date
 * (retrying with the day before, since some replays are posted a day late).
 */
async function findBarrandovYouTubeFallback(originalUrl: string, signal: AbortSignal): Promise<string | undefined> {
  const match = REGEX_BARRANDOV_EPISODE_URL.exec(new URL(originalUrl).pathname);
  if (!match) return undefined;

  const programName = match[1]!.slice(1).replace(/-/g, ' ').replace(/\b\w/gu, (c) => c.toUpperCase());
  const programNameLower = programName.toLowerCase();
  let date = new Date(Date.UTC(Number.parseInt(match[4]!, 10), Number.parseInt(match[3]!, 10) - 1, Number.parseInt(match[2]!, 10)));

  for (let attempt = 0; attempt < 2; attempt++) {
    const dateString = `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`;
    const found = await searchBarrandovYouTubeChannel(`${programName} ${dateString}`, programNameLower, dateString, signal);
    if (found) return found;
    date = new Date(date.getTime() - 86_400_000);
  }

  return undefined;
}

async function searchBarrandovYouTubeChannel(query: string, programNameLower: string, dateString: string, signal: AbortSignal): Promise<string | undefined> {
  const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  const searchUrl = `https://www.youtube.com/c/TelevizeBarrandovOfficial/search?query=${encodeURIComponent(query)}`;
  let response = await fetch(searchUrl, { signal: timeout() });
  let body = await response.text();

  if (new URL(response.url).hostname === 'consent.youtube.com') {
    const $consent = cheerio.load(body);
    const metaContent = $consent('noscript > meta').first().attr('content') ?? '';
    const consentUrlMatch = /url=([^;]+)/.exec(decodeURIComponent(metaContent));

    if (consentUrlMatch) {
      const consentUrl = decodeURIComponent(consentUrlMatch[1]!);
      const consentHtml = await fetchText(consentUrl, signal);
      const $consentPage = cheerio.load(consentHtml);
      const args: Record<string, string> = {};

      for (const form of $consentPage('.saveButtonContainer form').toArray()) {
        const $form = $consentPage(form);
        const localArgs: Record<string, string> = {};
        let eom = false;
        let valid = true;

        for (const input of $form.find('input[type="hidden"]').toArray()) {
          const name = $consentPage(input).attr('name') ?? '';
          const value = $consentPage(input).attr('value') ?? '';
          if (name === 'set_eom') {
            if (value !== 'true') { valid = false; break; }
            eom = true;
          }
          localArgs[name] = value;
        }

        if (valid && eom) { Object.assign(args, localArgs); break; }
      }

      await fetch('https://consent.youtube.com/save', {
        method: 'POST',
        headers: { Referer: consentUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(args).toString(),
        signal: timeout(),
      });

      response = await fetch(searchUrl, { signal: timeout() });
      body = await response.text();
    }

    if (new URL(response.url).hostname === 'consent.youtube.com') return undefined; // still blocked by consent wall
  }

  const marker = /var ytInitialData\s*=\s*\{/.exec(body);
  if (!marker) return undefined;

  const objectText = bracketForward(body, '{', '}', marker.index + marker[0].length - 1);
  const json = JSON5.parse<Record<string, unknown>>(objectText);

  const tabs = getPathValue(json, 'contents.twoColumnBrowseResultsRenderer.tabs');
  if (!Array.isArray(tabs) || tabs.length === 0) return undefined;

  const searchTabContent = getPathValue(firstNestedObject(tabs[tabs.length - 1]), 'content');
  const searchContent = getPathValue(firstNestedObject(searchTabContent), 'contents');
  if (!Array.isArray(searchContent)) return undefined;

  for (const searchItem of searchContent) {
    const itemData = getPathValue(firstNestedObject(searchItem), 'contents.0.videoRenderer') as Record<string, unknown> | undefined;
    if (!itemData) continue;

    const videoId = itemData.videoId;
    const title = getPathValue(itemData, 'title.runs.0.text');
    if (typeof videoId !== 'string' || typeof title !== 'string') continue;

    const titleLower = title.toLowerCase();
    if (titleLower.includes(programNameLower) && titleLower.includes(dateString)) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  }

  return undefined;
}

async function resolveTvBarrandov(release: Release, config: ProviderConfig, youtubeConfig: ProviderConfig, signal: AbortSignal): Promise<MediaSource[]> {
  let cookie: string | undefined;
  if (config.username && config.password) {
    cookie = await authenticateBarrandov(String(config.username), String(config.password), signal);
    if (!cookie) throw new Error('TVBarrandov: authentication failed (incorrect credentials)');
  }

  const { finalUrl, body } = await fetchBarrandovDocument(release.url, cookie, signal);
  const $ = cheerio.load(body);

  let uriToProcess: string | undefined;
  if (new URL(finalUrl).pathname.startsWith('/premiovy-archiv')) {
    uriToProcess = await findBarrandovYouTubeFallback(release.url, signal);
  }

  const videoEl = $('.main video').first();
  if (!uriToProcess && videoEl.length > 0) {
    const sourceElements = videoEl.find('source').toArray()
      .map((el) => ({ src: $(el).attr('src') ?? '', res: $(el).attr('res') ?? '', type: $(el).attr('type') ?? '' }))
      .filter((s) => s.src)
      .map((s) => ({ ...s, src: absUrl(release.url, s.src) }));

    const sources = parseBarrandovLocalSources(sourceElements);
    if (sources.length > 0) return sources;
  }

  if (!uriToProcess) {
    const embedSrc = $('.video-responsive > iframe').first().attr('src');
    if (embedSrc) uriToProcess = absUrl(release.url, embedSrc);
  }

  if (uriToProcess) {
    if (isYouTubeUrl(uriToProcess)) return resolveYouTube(uriToProcess, signal, youtubeConfig);
    throw new Error(`TVBarrandov: embedded video from unsupported host: ${new URL(uriToProcess).hostname} (only YouTube delegation is available in this provider bundle)`);
  }

  throw new Error('TVBarrandov: unable to find any playable video on the page');
}

// ---------------------------------------------------------------------------
// media_engine.tvautosalon
// ---------------------------------------------------------------------------

const URL_AUTOSALON_HOME = 'https://autosalon.tv/';
const SELECTOR_AUTOSALON_PROGRAMS = '#ms-navbar > .navbar-nav > .nav-item:first-child > .dropdown-menu > li.dropdown-header';
const SELECTOR_AUTOSALON_SEASONS = '#main .cards-container-seasons .card-season:not(.more-link)';
const SELECTOR_AUTOSALON_EPISODES = '#main .cards-container-episodes .card-episode-wrapper';
const SELECTOR_AUTOSALON_PAGE_ITEMS = '#main .pagination > .page-item';
const REGEX_AUTOSALON_SEASON = /^Sezóna\s+(\d+)$/iu;
const AUTOSALON_IGNORED_HREFS = ['/experti'];

function maybeFixAutosalonProgramName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.toLowerCase() === 'epizody autosalonu' || trimmed.toLowerCase() === 'epizody') return 'Autosalon';
  return trimmed;
}

async function fetchAutosalonPrograms(signal: AbortSignal): Promise<ScrapedProgram[]> {
  const html = await fetchText(URL_AUTOSALON_HOME, signal);
  const $ = cheerio.load(html);
  const programs: ScrapedProgram[] = [];

  $(SELECTOR_AUTOSALON_PROGRAMS).each((_i, header) => {
    const title = maybeFixAutosalonProgramName($(header).text());
    let el = $(header);
    for (;;) {
      const next = el.next();
      if (next.length === 0 || next.hasClass('dropdown-divider')) break;
      el = next;

      const href = el.find('a').first().attr('href');
      if (!href || AUTOSALON_IGNORED_HREFS.includes(href)) continue;
      if (el.text().trim().toLowerCase() !== 'epizody') continue;

      const url = absUrl(URL_AUTOSALON_HOME, href);
      programs.push({ id: url, title, kind: 'tv', url });
    }
  });

  return programs;
}

interface AutosalonSeason { url: string; title: string }

function parseAutosalonSeasonNumber(title: string): number | undefined {
  const match = REGEX_AUTOSALON_SEASON.exec(title);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

async function fetchAutosalonSeasons(program: ScrapedProgram, signal: AbortSignal): Promise<AutosalonSeason[]> {
  const html = await fetchText(program.url, signal);
  const $ = cheerio.load(html);
  const seasons: AutosalonSeason[] = [];

  $(SELECTOR_AUTOSALON_SEASONS).each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const title = $el.find('.title').first().text();
    if (href) seasons.push({ url: absUrl(program.url, href), title });
  });

  if (seasons.length === 0) seasons.push({ url: program.url, title: '' });
  return seasons;
}

function parseAutosalonEpisodesPage($: CheerioAPI, program: ScrapedProgram, seasonTitle: string): Release[] {
  const releases: Release[] = [];
  const quotedProgramTitle = RegExp.escape(program.title);
  const regexSeasonInTitle = new RegExp(`^${quotedProgramTitle}\\s+(\\d+)\\s+-\\s+`, 'iu');
  const regexEpisode = new RegExp(`^${quotedProgramTitle}\\s+(\\d+)$|(?:,\\s+)?(\\d+)\\.\\s+d[íi]l(?:\\s+-|,)?`, 'iu');
  const regexTitle = new RegExp(`^${quotedProgramTitle}(?:\\s+\\d+\\s+-\\s+|\\s+-\\s+|,\\s+)`, 'iu');

  const baseSeason = parseAutosalonSeasonNumber(seasonTitle);

  $(SELECTOR_AUTOSALON_EPISODES).each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;

    const $title = $el.find('.title').first().clone();
    const $dateEl = $title.find('.float-right').first();
    const date = $dateEl.length > 0 ? $dateEl.text() : '';
    $dateEl.remove();
    let text = $title.text();

    let season = baseSeason;
    let episode: number | undefined;

    const seasonInTitleMatch = regexSeasonInTitle.exec(text);
    if (seasonInTitleMatch) {
      season = Number.parseInt(seasonInTitleMatch[1]!, 10);
      text = text.slice(0, seasonInTitleMatch.index) + text.slice(seasonInTitleMatch.index + seasonInTitleMatch[0].length);
    }

    const titleMatch = regexTitle.exec(text);
    if (titleMatch) text = text.slice(0, titleMatch.index) + text.slice(titleMatch.index + titleMatch[0].length);

    const episodeMatch = regexEpisode.exec(text);
    if (episodeMatch) {
      const numStr = episodeMatch[1] ?? episodeMatch[2];
      if (numStr) episode = Number.parseInt(numStr, 10);
      text = (text.slice(0, episodeMatch.index) + text.slice(episodeMatch.index + episodeMatch[0].length)).trim();
    }

    if (date) text = text ? `${text} (${date})` : date;

    const url = absUrl(program.url, href);
    releases.push({
      id: releaseId('tvautosalon', url), provider: 'tvautosalon', title: text || program.title,
      url, kind: 'tv', series: program.title, season, episode,
    });
  });

  return releases;
}

// A season's episode listing surfaces its newest episode on page 1 and older episodes on
// higher-numbered pages, so walking forward within a season yields Releases newest first.
async function* autosalonSeasonReleases(program: ScrapedProgram, season: AutosalonSeason, signal: AbortSignal): AsyncGenerator<Release> {
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const pageUrl = page === 1 ? season.url : absUrl(season.url, `${new URL(season.url).pathname.replace(/\/$/, '')}/${page}`);
    const html = await fetchText(pageUrl, signal);
    const $ = cheerio.load(html);

    yield* parseAutosalonEpisodesPage($, program, season.title);

    const pageItems = $(SELECTOR_AUTOSALON_PAGE_ITEMS);
    hasMore = pageItems.length > 0 && !pageItems.last().hasClass('disabled');
    if (hasMore) page++;
  }
}

// The program page lists seasons in no guaranteed order, so seasons are walked highest season
// number first (newest first); a season with an unparseable number is only walked when it is
// the program's sole season (sound: it cannot be soundly excluded by a season number we lack).
async function* autosalonReleases(program: ScrapedProgram, query: CatalogueQuery, signal: AbortSignal): AsyncGenerator<Release> {
  const seasons = await fetchAutosalonSeasons(program, signal);
  const ordered = [...seasons].sort((a, b) => (parseAutosalonSeasonNumber(b.title) ?? -1) - (parseAutosalonSeasonNumber(a.title) ?? -1));
  const seasonsToWalk = query.season === undefined ? ordered : ordered.filter((season) => {
    const seasonNumber = parseAutosalonSeasonNumber(season.title);
    return seasonNumber !== undefined ? seasonNumber === query.season : ordered.length === 1;
  });

  for (const season of seasonsToWalk) {
    yield* autosalonSeasonReleases(program, season, signal);
  }
}

async function resolveTvAutosalon(release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const html = await fetchText(release.url, signal);
  const $ = cheerio.load(html);

  // The site now injects the OnNetwork embed script via client-side JS (document.createElement)
  // instead of rendering a static <script> tag server-side; the URL is still present verbatim
  // as a string literal inside an inline <script> body, under the non-Seznam-referrer branch.
  const scriptSrc = $('#video > script').first().attr('src')
    ?? /default:\s*src\s*=\s*"(https:\/\/video\.onnetwork\.tv\/embed\.php\?[^"]+)"/.exec(html)?.[1];
  if (!scriptSrc) throw new Error('TVAutosalon: unable to find embedding script on the episode page');

  const referer = `${new URL(release.url).origin}/`;
  return resolveOnNetworkEmbed(absUrl(release.url, scriptSrc), referer, signal);
}

// ---------------------------------------------------------------------------
// server.rtvs (STVR)
// ---------------------------------------------------------------------------

const REGEX_STVR_URI = /^https?:\/\/(?:www\.)?stvr\.sk\/((?:radio|televizia)\/archiv|deti\/(?:rozhlas|televizia))\/\d+\/\d+\/?$/;

async function resolveStvr(url: string, signal: AbortSignal): Promise<MediaSource[]> {
  const match = REGEX_STVR_URI.exec(url);
  if (!match) throw new Error('STVR: unsupported URL (expected /(radio|televizia)/archiv/ or /deti/(rozhlas|televizia)/)');

  const html = await fetchText(url, signal);
  const $ = cheerio.load(html);

  let mediaKind: 'audio' | 'video';
  let endpoint: string;
  switch (match[1]) {
    case 'televizia/archiv':
    case 'deti/televizia':
      mediaKind = 'video'; endpoint = 'archive5f'; break;
    case 'radio/archiv':
    case 'deti/rozhlas':
      mediaKind = 'audio'; endpoint = 'audio5f'; break;
    default:
      throw new Error('STVR: unsupported URL');
  }

  const iframe = $(`iframe[id^="player_${mediaKind}_"]`).first();
  if (iframe.length === 0) throw new Error('STVR: unable to find the player iframe on the page');
  const numericId = (iframe.attr('id') ?? '').split('_').pop();
  if (!numericId) throw new Error('STVR: unable to parse the player id');

  const playlistUrl = `https://www.stvr.sk/json/${endpoint}.json?id=${numericId}&=&b=chrome&p=win&f=0&d=1`;
  const payload = await fetchJson<Record<string, unknown>>(playlistUrl, signal);
  const playlist = (mediaKind === 'audio'
    ? (payload.playlist as Record<string, unknown>[] | undefined)?.[0]
    : payload.clip) as { sources?: { type: string; src: string }[] } | undefined;
  if (!playlist?.sources) throw new Error('STVR: playlist response is missing sources');

  const sources: MediaSource[] = [];
  for (const source of playlist.sources) {
    const formatString = source.type.toLowerCase();
    if (mediaKind === 'audio') {
      sources.push({ url: source.src, type: 'file' });
    } else {
      if (formatString.includes('dash')) continue; // matches upstream: DASH sources time out, HLS is always also present
      sources.push({ url: source.src, type: formatString.includes('mpegurl') ? 'hls' : mediaType(source.src) });
    }
  }

  if (sources.length === 0) throw new Error('STVR: no playable sources in playlist response');
  return sources;
}

// ---------------------------------------------------------------------------
// server.html5
// ---------------------------------------------------------------------------

async function resolveHtml5(url: string, config: ProviderConfig, signal: AbortSignal): Promise<MediaSource[]> {
  const html = await fetchText(url, signal, { headers: config.headers });
  const $ = cheerio.load(html);
  const sources: MediaSource[] = [];

  $('video').each((_i, video) => {
    const $video = $(video);
    const directSrc = $video.attr('src');
    if (directSrc) {
      const sourceUrl = absUrl(url, directSrc);
      sources.push({ url: sourceUrl, type: mediaType(sourceUrl), headers: config.headers });
    }

    $video.find('source').each((_j, sourceEl) => {
      const src = $(sourceEl).attr('src');
      if (!src) return;
      const sourceUrl = absUrl(url, src);
      const mime = $(sourceEl).attr('type') ?? '';
      const type = mime.includes('mpegurl') ? 'hls' : mime.includes('dash') ? 'dash' : mediaType(sourceUrl);
      sources.push({ url: sourceUrl, type, headers: config.headers });
    });
  });

  if (sources.length === 0) throw new Error('HTML5: no <video>/<source> elements found on the page');
  return sources;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createPublicSiteProviders(configs: Record<string, ProviderConfig>): Provider[] {
  const providers: Provider[] = [];

  const primadoma = configs.tvprimadoma ?? {};
  if (primadoma.enabled !== false) {
    const catalogue: Catalogue<ScrapedProgram> = {
      async *programs(_query, signal) {
        for (const program of await fetchPrimaDomaPrograms(signal)) yield program;
      },
      releases: (program, _query, signal) => primaDomaReleases(program, signal),
    };
    providers.push({
      id: 'tvprimadoma',
      name: 'TV Prima Doma',
      catalogue,
      resolve: (release, signal) => resolveTvPrimaDoma(release, signal),
    });
  }

  const barrandov = configs.tvbarrandov ?? {};
  if (barrandov.enabled !== false) {
    const catalogue: Catalogue<ScrapedProgram> = {
      async *programs(_query, signal) {
        for (const program of await fetchBarrandovPrograms(signal)) yield program;
      },
      // These Releases carry neither season nor episode, so such a search would walk the whole archive for nothing.
      releases: (program, query, signal) => query.episode !== undefined || (query.season !== undefined && query.season < 1900)
        ? empty() : barrandovReleases(program, signal),
    };
    providers.push({
      id: 'tvbarrandov',
      name: 'TV Barrandov',
      catalogue,
      resolve: (release, signal) => resolveTvBarrandov(release, barrandov, configs.youtube ?? {}, signal),
    });
  }

  const autosalon = configs.tvautosalon ?? {};
  if (autosalon.enabled !== false) {
    const catalogue: Catalogue<ScrapedProgram> = {
      async *programs(_query, signal) {
        for (const program of await fetchAutosalonPrograms(signal)) yield program;
      },
      releases: (program, query, signal) => autosalonReleases(program, query, signal),
    };
    providers.push({
      id: 'tvautosalon',
      name: 'TV Autosalon',
      catalogue,
      resolve: (release, signal) => resolveTvAutosalon(release, signal),
    });
  }

  const stvr = configs.stvr ?? {};
  if (stvr.enabled !== false) {
    const catalogue: Catalogue = {
      async *programs() {},
      async *releases() {},
      releaseForUrl: (url, query) => urlResolverRelease('stvr', url, query, (candidate) => REGEX_STVR_URI.test(candidate)),
    };
    providers.push({
      id: 'stvr',
      name: 'STVR (RTVS)',
      catalogue,
      resolve: (release, signal) => resolveStvr(release.url, signal),
    });
  }

  const html5 = configs.html5 ?? {};
  if (html5.enabled !== false) {
    const catalogue: Catalogue = {
      async *programs() {},
      async *releases() {},
      releaseForUrl: (url, query) => urlResolverRelease('html5', url, query, (candidate) => /^https?:\/\//i.test(candidate)),
    };
    providers.push({
      id: 'html5',
      name: 'HTML5',
      catalogue,
      resolve: (release, signal) => resolveHtml5(release.url, html5, signal),
    });
  }

  const direct = configs.direct ?? {};
  if (direct.enabled !== false) {
    const catalogue: Catalogue = {
      async *programs() {},
      async *releases() {},
      releaseForUrl: (url, query) => urlResolverRelease('direct', url, query, (candidate) => /^https?:\/\//i.test(candidate)),
    };
    providers.push({
      id: 'direct',
      name: 'Direct',
      catalogue,
      resolve: (release) => Promise.resolve([{ url: release.url, type: mediaType(release.url), headers: direct.headers } satisfies MediaSource]),
    });
  }

  const youtube = configs.youtube ?? {};
  if (youtube.enabled !== false) {
    const catalogue: Catalogue = {
      async *programs() {},
      async *releases() {},
      releaseForUrl: (url, query) => urlResolverRelease('youtube', url, query, isYouTubeUrl, {
        normalizeUrl: maybeTransformYouTubeUrl,
        title: (u) => new URL(u).searchParams.get('v') ?? 'YouTube video',
      }),
    };
    providers.push({
      id: 'youtube',
      name: 'YouTube',
      catalogue,
      resolve: (release, signal) => resolveYouTube(release.url, signal, youtube),
    });
  }

  return providers;
}
