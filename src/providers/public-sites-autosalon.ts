// Port of media_engine.tvautosalon (TVAutosalonEngine): program/season/episode catalogue + OnNetwork embed.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Catalogue, CatalogueQuery, MediaSource, Provider, Release } from '../types.ts';
import { cached, fetchText, PROGRAM_LIST_TTL_MS, releaseId } from './common.ts';
import { resolveOnNetworkEmbed } from './public-sites-onnetwork.ts';
import type { ScrapedProgram } from './public-sites.ts';

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

      const url = new URL(href, URL_AUTOSALON_HOME).href;
      programs.push({ id: url, title, kind: 'tv', url });
    }
  });

  return programs;
}

interface AutosalonSeason {
  url: string;
  title: string;
}

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
    if (href) seasons.push({ url: new URL(href, program.url).href, title });
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

    const url = new URL(href, program.url).href;
    releases.push({
      id: releaseId('tvautosalon', url),
      provider: 'tvautosalon',
      title: text || program.title,
      url,
      kind: 'tv',
      series: program.title,
      season,
      episode,
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
    const pageUrl = page === 1 ? season.url : new URL(`${new URL(season.url).pathname.replace(/\/$/, '')}/${page}`, season.url).href;
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
  const seasonsToWalk =
    query.season === undefined
      ? ordered
      : ordered.filter(season => {
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
  const scriptSrc =
    $('#video > script').first().attr('src') ??
    /default:\s*src\s*=\s*"(https:\/\/video\.onnetwork\.tv\/embed\.php\?[^"]+)"/.exec(html)?.[1];
  if (!scriptSrc) throw new Error('TVAutosalon: unable to find embedding script on the episode page');

  const referer = `${new URL(release.url).origin}/`;
  return resolveOnNetworkEmbed(new URL(scriptSrc, release.url).href, referer, signal);
}

export function createAutosalonProvider(): Provider {
  const programs = cached(PROGRAM_LIST_TTL_MS, fetchAutosalonPrograms);
  const catalogue: Catalogue<ScrapedProgram> = {
    async *programs(query, signal) {
      if (query.kind === 'movie') return; // TV archive only
      yield* await programs(signal);
    },
    releases: (program, query, signal) => autosalonReleases(program, query, signal),
  };
  return { id: 'tvautosalon', name: 'TV Autosalon', catalogue, resolve: (release, signal) => resolveTvAutosalon(release, signal) };
}
