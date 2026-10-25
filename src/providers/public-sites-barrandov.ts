// Port of media_engine.tvbarrandov (TVBarrandovEngine): program/episode catalogue, premium-archive login, local video or YouTube delegation.
import JSON5 from 'json5';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Catalogue, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { at, bracketSubstring, cached, empty, fetchResponse, fetchText, mediaType, normalize, PROGRAM_LIST_TTL_MS, releaseId } from './common.ts';
import { isYouTubeUrl, resolveYouTube } from './public-sites-youtube.ts';
import { AccountSession, SessionRejected } from './account-session.ts';
import type { ScrapedProgram } from './public-sites.ts';

const URL_LOGIN = 'https://www.barrandov.tv/form/form-prihlaseni.php';
const URL_REFERER = 'https://www.barrandov.tv/prihlaseni.php';
const URL_REDIRECT = 'https://www.barrandov.tv/';

/** Returns the authenticated session cookie; a successful login redirects to the home page. */
async function authenticateBarrandov(username: string, password: string, signal: AbortSignal): Promise<string | undefined> {
  const body = new URLSearchParams({ presmerovani: URL_REDIRECT, login: username, heslo: password, prihlasit: '' });
  const response = await fetchResponse(URL_LOGIN, signal, {
    method: 'POST',
    headers: { Referer: URL_REFERER, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  const cookieHeader = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
  const succeeded = response.status >= 300 && response.status < 400 && response.headers.get('location') === URL_REDIRECT;
  await response.body?.cancel();
  return succeeded && cookieHeader ? cookieHeader : undefined;
}

/** Parses the local (non-embedded) Barrandov video sources. */
function parseBarrandovLocalSources(sourceElements: { src: string; res: string; type: string }[]): MediaSource[] {
  return sourceElements.map(el => ({
    url: el.src,
    type: el.type.includes('dash') ? 'dash' : el.type.includes('mpegurl') ? 'hls' : mediaType(el.src),
    height: el.res ? Number.parseInt(el.res, 10) : undefined,
  }));
}

async function fetchBarrandovDocument(url: string, cookie: string | undefined, signal: AbortSignal): Promise<{ finalUrl: string; body: string }> {
  const response = await fetchResponse(url, signal, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return { finalUrl: response.url, body: await response.text() };
}

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
      const url = new URL(href, URL_BARRANDOV_PROGRAMS).href;
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
    const url = new URL(href, program.url).href;
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

function firstNestedObject(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (nested && typeof nested === 'object') return nested;
    }
  }
  return undefined;
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
  const searchUrl = `https://www.youtube.com/c/TelevizeBarrandovOfficial/search?query=${encodeURIComponent(query)}`;
  // SOCS=CAI is YouTube's own answer to its EU consent page (as yt-dlp sends it); fetch keeps no cookies.
  const response = await fetchResponse(searchUrl, signal, { headers: { Cookie: 'SOCS=CAI' } });
  const body = await response.text();
  if (new URL(response.url).hostname === 'consent.youtube.com') return undefined; // still blocked by consent wall

  const marker = /var ytInitialData\s*=\s*\{/.exec(body);
  if (!marker) return undefined;

  const objectText = bracketSubstring(body, marker.index + marker[0].length - 1);
  if (!objectText) throw new Error('Barrandov: ytInitialData is not a complete object');
  const json = JSON5.parse<Record<string, unknown>>(objectText);

  const tabs = at(json, 'contents.twoColumnBrowseResultsRenderer.tabs');
  if (!Array.isArray(tabs) || tabs.length === 0) return undefined;

  const searchTabContent = at(firstNestedObject(tabs[tabs.length - 1]), 'content');
  const searchContent = at(firstNestedObject(searchTabContent), 'contents');
  if (!Array.isArray(searchContent)) return undefined;

  for (const searchItem of searchContent) {
    const itemData = at(firstNestedObject(searchItem), 'contents.0.videoRenderer') as Record<string, unknown> | undefined;
    if (!itemData) continue;

    const videoId = itemData.videoId;
    const title = at(itemData, 'title.runs.0.text');
    if (typeof videoId !== 'string' || typeof title !== 'string') continue;

    const titleLower = title.toLowerCase();
    if (titleLower.includes(programNameLower) && titleLower.includes(dateString)) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  }

  return undefined;
}

/** The login cookie for the premium archive, kept until the archive stops accepting it; none without credentials. */
function barrandovSession(config: ProviderConfig): AccountSession<string> | undefined {
  if (!config.username || !config.password) return undefined;
  const username = String(config.username);
  const password = String(config.password);
  return new AccountSession({
    label: 'tvbarrandov',
    async login(signal) {
      const cookie = await authenticateBarrandov(username, password, signal);
      if (!cookie) throw new Error('TVBarrandov: authentication failed (incorrect credentials)');
      return { session: cookie };
    },
  });
}

const isPremiumArchive = (url: string): boolean => new URL(url).pathname.startsWith('/premiovy-archiv');

async function resolveTvBarrandov(
  release: Release, session: AccountSession<string> | undefined, youtubeConfig: ProviderConfig, signal: AbortSignal,
): Promise<MediaSource[]> {
  let page = session ? undefined : await fetchBarrandovDocument(release.url, undefined, signal);
  if (session) {
    try {
      await session.run(async (cookie, runSignal) => {
        page = await fetchBarrandovDocument(release.url, cookie, runSignal);
        // A login that is sent to the premium archive's sales page has expired; it is renewed once.
        if (isPremiumArchive(page.finalUrl)) throw new SessionRejected('TVBarrandov: the login does not open the premium archive');
      }, signal);
    } catch (error) {
      if (!(error instanceof SessionRejected)) throw error;
    }
  }
  const { finalUrl, body } = page!;
  const $ = cheerio.load(body);

  let uriToProcess: string | undefined;
  if (isPremiumArchive(finalUrl)) {
    uriToProcess = await findBarrandovYouTubeFallback(release.url, signal);
  }

  const videoEl = $('.main video').first();
  if (!uriToProcess && videoEl.length > 0) {
    const sourceElements = videoEl.find('source').toArray()
      .map((el) => ({ src: $(el).attr('src') ?? '', res: $(el).attr('res') ?? '', type: $(el).attr('type') ?? '' }))
      .filter((s) => s.src)
      .map((s) => ({ ...s, src: new URL(s.src, release.url).href }));

    const sources = parseBarrandovLocalSources(sourceElements);
    if (sources.length > 0) return sources;
  }

  if (!uriToProcess) {
    const embedSrc = $('.video-responsive > iframe').first().attr('src');
    if (embedSrc) uriToProcess = new URL(embedSrc, release.url).href;
  }

  if (uriToProcess) {
    if (isYouTubeUrl(uriToProcess)) return resolveYouTube(uriToProcess, signal, youtubeConfig);
    throw new Error(`TVBarrandov: embedded video from unsupported host: ${new URL(uriToProcess).hostname} (only YouTube delegation is available in this provider bundle)`);
  }

  throw new Error('TVBarrandov: unable to find any playable video on the page');
}

export function createBarrandovProvider(config: ProviderConfig, youtube: ProviderConfig): Provider {
  const session = barrandovSession(config);
  const programs = cached(PROGRAM_LIST_TTL_MS, fetchBarrandovPrograms);
  const catalogue: Catalogue<ScrapedProgram> = {
    async *programs(query, signal) {
      if (query.kind === 'movie') return; // TV archive only
      yield* await programs(signal);
    },
    // These Releases carry neither season nor episode, so such a search would walk the whole archive for nothing.
    releases: (program, query, signal) => query.episode !== undefined || (query.season !== undefined && query.season < 1900)
      ? empty() : barrandovReleases(program, signal),
  };
  return { id: 'tvbarrandov', name: 'TV Barrandov', catalogue, resolve: (release, signal) => resolveTvBarrandov(release, session, youtube, signal) };
}
