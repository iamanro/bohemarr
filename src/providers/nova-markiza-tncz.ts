import type { CheerioAPI } from 'cheerio';
import type { Catalogue, CatalogueQuery, Provider, Release } from '../types.ts';
import { cached, empty, fetchText, PROGRAM_LIST_TTL_MS, releaseId } from './common.ts';
import { absUrl, fetchDocument, loadHtml, playerTracks, queryParams, readInlineObject } from './nova-markiza-utils.ts';
import { tracksToSources } from './nova-markiza-media.ts';

/** Ported from `TNCZEngine` (`media_engine.tncz`). No upstream `drm_engine.tncz` was ever registered. */

const URL_PROGRAMS = 'https://tn.nova.cz/videa';
const SEL_PROGRAMS = '.c-article-carousel .swiper-slide > a';
const SEL_EPISODES = '.c-article-wrapper .c-article .title > a';
const SEL_EPISODES_LOAD_MORE = '.load-more > button';
const SEL_PLAYER_IFRAME = 'iframe[data-video-id]';
const TXT_PLAYER_CONFIG_BEGIN = 'player:';
const REGEX_SHOW_ID = /"show":"(\d+)"/;
const REGEX_MAYBE_DATE = /\p{L}+\s+\d+\.\s+\p{L}+/u;
const REGEX_DATE = /^(\d+)\.\s+(\d+)\.\s+\d+$/;

const CZECH_WEEKDAYS: Record<string, true> = {
  'pondělí': true, 'úterý': true, 'středa': true, 'čtvrtek': true, 'pátek': true, 'sobota': true, 'neděle': true,
};
const CZECH_MONTHS_GENITIVE: Record<string, number> = {
  ledna: 1, února: 2, března: 3, dubna: 4, května: 5, června: 6,
  července: 7, srpna: 8, září: 9, října: 10, listopadu: 11, prosince: 12,
};

/** The provider's stable program URL doubles as `Program.id`; TN.cz is TV-only. */
interface Program { id: string; uri: string; title: string; kind: 'tv' }

/** Parses a Czech "<weekday> <day>. <month>" textual date (e.g. "středa 3. září"), matching `DATE_FORMATTER_CZECH`. */
function parseCzechWeekdayDate(text: string): { day: number; month: number } | null {
  const m = /^(\p{L}+)\s+(\d+)\.\s+(\p{L}+)$/u.exec(text.trim());
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const month = CZECH_MONTHS_GENITIVE[m[3].toLowerCase()];
  if (!CZECH_WEEKDAYS[m[1].toLowerCase()] || !month) return null;
  return { day: Number(m[2]), month };
}

/** Ported from `parseEpisodeList`. */
function parseEpisodes($: CheerioAPI, program: Program): Release[] {
  const releases: Release[] = [];
  const regexProgramTitle = new RegExp(`${RegExp.escape(program.title)}(?:\\s+[-\u2013\u2014]\\s*|:\\s*|\\s+)`, 'iu');
  const regexEpisodeTitle = new RegExp(
    `(?:\\s+[-\u2013\u2014]\\s*)?${RegExp.escape(program.title)}\\s+\\((\\d+)\\)\\s+[-\u2013\u2014]\\s*`, 'iu',
  );

  for (const el of $(SEL_EPISODES).toArray()) {
    const $el = $(el);
    const uri = absUrl(program.uri, $el.attr('href'));
    if (!uri) continue;
    let title = $el.text();
    let numEpisode = 0;

    const epMatch = regexEpisodeTitle.exec(title);
    if (epMatch?.[1]) {
      numEpisode = Number(epMatch[1]);
      title = title.slice(0, epMatch.index) + title.slice(epMatch.index + epMatch[0].length);
    }

    const progMatch = regexProgramTitle.exec(title);
    if (progMatch) title = title.slice(0, progMatch.index) + title.slice(progMatch.index + progMatch[0].length);

    const dateTime = $el.parent().parent().find('.article-info > time').first().text();
    if (dateTime) {
      const textContent = dateTime.replace(/,.*$/, '').trim();
      const maybeDateMatch = REGEX_MAYBE_DATE.exec(title);

      if (maybeDateMatch) {
        const parsed = parseCzechWeekdayDate(maybeDateMatch[0]);
        const numDateMatch = REGEX_DATE.exec(textContent);

        if (parsed && numDateMatch?.[1] && numDateMatch[2]
            && Number(numDateMatch[1]) === parsed.day && Number(numDateMatch[2]) === parsed.month) {
          title = title.slice(0, maybeDateMatch.index) + title.slice(maybeDateMatch.index + maybeDateMatch[0].length);
        }
      }

      title = textContent + (title.trim() ? ` - ${title.trim()}` : '');
    }

    releases.push({
      id: releaseId('tncz', uri), provider: 'tncz', title: title.trim(), url: uri,
      kind: 'tv', series: program.title, episode: numEpisode > 0 ? numEpisode : undefined,
    });
  }

  return releases;
}

async function listPrograms(signal: AbortSignal): Promise<Program[]> {
  const $ = await fetchDocument(URL_PROGRAMS, signal);
  const programs: Program[] = [];

  $(SEL_PROGRAMS).each((_, el) => {
    const $el = $(el);
    const uri = absUrl(URL_PROGRAMS, $el.attr('href'));
    const title = $el.find('.title').first().text().trim();
    if (uri && title) programs.push({ id: uri, uri, title, kind: 'tv' });
  });

  return programs;
}

/**
 * Ported from `getEpisodes`: static page episodes, then `api/v1/episodes/more` pagination.
 * `parseEpisodes` already returns each page newest-first, and later pages are strictly older,
 * so yielding page by page as fetched stays globally newest-first and lets a browsing caller
 * stop after the first item without paginating further.
 */
async function* listEpisodes(program: Program, signal: AbortSignal): AsyncGenerator<Release> {
  let $ = await fetchDocument(program.uri, signal);
  yield* parseEpisodes($, program);

  const loadMore = $(SEL_EPISODES_LOAD_MORE).first();
  if (loadMore.length === 0) return;

  const params = queryParams(loadMore.attr('data-href') ?? '', program.uri);
  const channel = params.get('channel');
  const content = params.get('content');
  const filter = params.get('filter');
  if (!channel || !content || !filter) return;

  const showMatch = REGEX_SHOW_ID.exec(filter);
  if (!showMatch?.[1]) return;
  const show = showMatch[1];
  const limit = 20;

  for (let page = 2; ; page++) {
    const url = `https://tn.nova.cz/api/v1/episodes/more?channel=${channel}&limit=${limit}&page=${page}`
      + `&filter=%7B%22show%22%3A%22${show}%22%7D&content=${content}`;
    $ = loadHtml(await fetchText(url, signal));
    yield* parseEpisodes($, program);
    if ($(SEL_EPISODES_LOAD_MORE).length === 0) break;
  }
}

async function resolveMedia(release: Release, signal: AbortSignal) {
  const $ = await fetchDocument(release.url, signal);
  const iframe = $(SEL_PLAYER_IFRAME).first();
  if (iframe.length === 0) return [];

  const iframeUrl = absUrl(release.url, iframe.attr('src'));
  if (!iframeUrl) return [];

  const content = await fetchText(iframeUrl, signal);
  if (!content) return [];

  const config = readInlineObject(content, TXT_PLAYER_CONFIG_BEGIN);
  if (!config) return [];

  return tracksToSources(playerTracks(config), undefined);
}

export function createTNCZProvider(): Provider {
  const cachedPrograms = cached(PROGRAM_LIST_TTL_MS, listPrograms);

  const catalogue: Catalogue<Program> = {
    async *programs(query: CatalogueQuery, signal: AbortSignal) {
      if (query.kind === 'movie') return;
      yield* await cachedPrograms(signal);
    },
    // These Releases never carry a season, so a season search would walk the whole archive for nothing.
    releases: (program: Program, query: CatalogueQuery, signal: AbortSignal) =>
      query.season !== undefined && query.season < 1900 ? empty() : listEpisodes(program, signal),
  };

  return {
    id: 'tncz',
    name: 'TV Nova News',
    catalogue,
    async resolve(release: Release, signal: AbortSignal) {
      return resolveMedia(release, signal);
    },
  } satisfies Provider;
}
