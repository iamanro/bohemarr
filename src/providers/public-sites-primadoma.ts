// Port of media_engine.tvprimadoma (TVPrimaDomaEngine): program/episode catalogue + OnNetwork embed.
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Catalogue, MediaSource, Provider, Release } from '../types.ts';
import { cached, fetchText, PROGRAM_LIST_TTL_MS, releaseId } from './common.ts';
import { resolveOnNetworkEmbed } from './public-sites-onnetwork.ts';
import { resolveStreamCz } from './czech-public-streamcz.ts';
import type { ScrapedProgram } from './public-sites.ts';

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
      const url = new URL(href, URL_PRIMADOMA_PROGRAMS).href;
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

    const url = new URL(href, program.url).href;
    releases.push({
      id: releaseId('tvprimadoma', url),
      provider: 'tvprimadoma',
      title: title.trim() || program.title,
      url,
      kind: 'tv',
      series: program.title,
      season,
      episode,
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

  const urlBase = new URL(nextHref, program.url).href.replace(/\?page=\d+/, '?page=%PAGE%');
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
    if (iframeSrc?.startsWith('https://www.stream.cz')) return resolveStreamCz(iframeSrc, signal);
  }

  const scriptSrc = $('.container div > script').first().attr('src');
  if (!scriptSrc) throw new Error('TVPrimaDoma: unable to find embedding script on the episode page');

  return resolveOnNetworkEmbed(new URL(scriptSrc, release.url).href, URL_PRIMADOMA_REFERER, signal);
}

export function createPrimaDomaProvider(): Provider {
  const programs = cached(PROGRAM_LIST_TTL_MS, fetchPrimaDomaPrograms);
  const catalogue: Catalogue<ScrapedProgram> = {
    async *programs(query, signal) {
      if (query.kind === 'movie') return; // TV archive only
      yield* await programs(signal);
    },
    releases: (program, _query, signal) => primaDomaReleases(program, signal),
  };
  return { id: 'tvprimadoma', name: 'TV Prima Doma', catalogue, resolve: (release, signal) => resolveTvPrimaDoma(release, signal) };
}
