import type { CheerioAPI } from 'cheerio';
import type { Element as CheerioElement } from 'domhandler';
import type { Catalogue, CatalogueQuery, Provider, Release } from '../types.ts';
import { empty, fetchText, releaseId } from './common.ts';
import {
  absUrl, fetchDocument, fetchTextOrEmpty, fetchTextRetry, joinUrl, loadHtml,
  playerTracks, queryParams, readInlineObject, select,
} from './nova-markiza-utils.ts';
import { tracksToSources } from './nova-markiza-media.ts';

/**
 * Ported from `NovaPlusEngine` and `MarkizaPlusEngine` (`media_engine.novaplus`
 * / `media_engine.markizaplus`), which share an identical implementation and
 * only differ in URLs, CSS selectors and the "N. episode-word" regex. Both
 * sites list free ("not VOYO-exclusive") TV episode archives, no movies.
 */
export interface NovaArchiveSite {
  id: string;
  name: string;
  host: string;
  programsUrl: string;
  episodeListUrl: (contentId: string, offset: number) => string;
  selPrograms: string;
  programTitleSelector: string;
  selEpisodes: string;
  selEpisodesLoadMore: string;
  selPlayerIframe: string;
  iframeAttr: 'src' | 'data-src';
  selLabelVoyo: string;
  episodeNumberRegex: RegExp;
  episodePaths: string[];
  /** Only set for hosts with a matching upstream `drm_engine.*`. */
  drmReferer?: string;
  /** NovaPlus-only quirk: `content` query arg may appear with an empty/positional name. */
  contentParamFallback?: boolean;
}

/** The provider's stable program URL doubles as `Program.id`; this archive is TV-only. */
interface Program { id: string; uri: string; title: string; kind: 'tv' }

const PROGRAMS_TTL_MS = 10 * 60_000;

function contentIdFromLoadMore($: CheerioAPI, el: CheerioElement, base: string, fallbackToIndex0: boolean): string | undefined {
  const href = $(el).attr('data-href');
  if (!href) return undefined;
  const params = queryParams(href, base);
  return params.get('content') ?? (fallbackToIndex0 ? (params.get('0') ?? undefined) : undefined);
}

function hasEpisodeNumberInTitle($: CheerioAPI, el: CheerioElement, site: NovaArchiveSite): boolean {
  const title = $(el).find('.title > a').first().text();
  return site.episodeNumberRegex.test(title);
}

/**
 * Ported from `parseEpisodeList`: builds one `Release` per non-VOYO episode
 * item, extracting the episode number from the title (falling back to a
 * running position counter when `allowFallbackIndex`), stripping the program
 * title prefix, and folding in a `.content > .category` subheading.
 *
 * `items` is in page DOM order (newest first, confirmed by the site's own "latest episode"
 * placement); processing runs oldest-to-newest internally so the fallback index counts up from
 * the program's start, then the built releases are reversed back to newest-first before return.
 */
function parseEpisodeItems(
  $: CheerioAPI, items: CheerioElement[], program: Program, startIndex: number, site: NovaArchiveSite,
  allowFallbackIndex = true,
): { releases: Release[]; count: number } {
  const releases: Release[] = [];
  const programTitleRegex = new RegExp(`^${RegExp.escape(program.title)}(?:\\s+[-\u2013\u2014]|\\s*:)?\\s*`, 'iu');
  let index = startIndex;
  let count = items.length;

  for (let i = items.length - 1; i >= 0; i--) {
    const el = items[i];
    if (!el) continue;
    const $item = $(el);

    if ($item.find(site.selLabelVoyo).length > 0) { count--; continue; }

    const $link = $item.find('.title > a').first();
    const href = $link.attr('href');
    const uri = absUrl(program.uri, href);
    if (!uri) { count--; continue; }

    let title = $link.text().trim();
    let numEpisode: number | undefined;

    const numberMatch = site.episodeNumberRegex.exec(title);
    if (numberMatch?.[1]) {
      numEpisode = Number(numberMatch[1]);
      title = (title.slice(0, numberMatch.index) + title.slice(numberMatch.index + numberMatch[0].length)).trim();
    } else if (allowFallbackIndex) {
      numEpisode = index++;
    }

    const prefixMatch = programTitleRegex.exec(title);
    if (prefixMatch) title = title.slice(prefixMatch[0].length);

    const category = $item.find('.content > .category').first().text().trim();
    if (category && category.toLowerCase() !== program.title.toLowerCase()) {
      title = category + (title ? ` - ${title}` : '');
    }

    releases.push({
      id: releaseId(site.id, uri),
      provider: site.id,
      title: title || program.title,
      url: uri,
      kind: 'tv',
      series: program.title,
      episode: numEpisode && numEpisode > 0 ? numEpisode : undefined,
    });
  }

  return { releases: releases.reverse(), count };
}

async function listPrograms(site: NovaArchiveSite, signal: AbortSignal): Promise<Program[]> {
  const $ = await fetchDocument(site.programsUrl, signal);
  const programs: Program[] = [];

  select($, site.selPrograms).each((_, el) => {
    const $el = $(el);
    const uri = absUrl(site.programsUrl, $el.attr('href'));
    const title = $el.find(site.programTitleSelector).first().text().trim();
    if (uri && title) programs.push({ id: uri, uri, title, kind: 'tv' });
  });

  return programs;
}

/** Ported from `parseEpisodesPage`'s binary-search branch for title-less episode numbering. */
async function walkNumberedByPosition(
  site: NovaArchiveSite, program: Program, contentId: string, startIndex: number, signal: AbortSignal,
): Promise<{ releases: Release[]; nextIndex: number }> {
  const step = 6;
  let lo = 0;
  let hi = step;
  const hiCap = 1 << 20; // defensive bound against a misbehaving/never-empty endpoint

  while (hi < hiCap) {
    const body = await fetchTextOrEmpty(site.episodeListUrl(contentId, hi), signal);
    if (body.trim() === '') break;
    hi *= 2;
  }

  while (hi - lo > step) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const $mid = loadHtml(await fetchTextOrEmpty(site.episodeListUrl(contentId, mid), signal));
    const allVoyo = select($mid, site.selEpisodes).length === select($mid, site.selLabelVoyo).length;
    if (allVoyo) hi = mid; else lo = mid;
  }

  // The fallback episode number counts up from the program's oldest episode, so chunks must be
  // walked oldest (offset=lo) to newest (offset=0) to compute it; each chunk's own releases are
  // already newest-first (see `parseEpisodeItems`), so reversing the chunk order afterwards
  // yields a globally newest-first list without re-fetching anything.
  const chunks: Release[][] = [];
  let index = startIndex;

  for (let offset = lo; offset >= -step; offset -= step) {
    const $page = loadHtml(await fetchTextRetry(site.episodeListUrl(contentId, offset), signal, 5));
    const { releases: pageReleases, count } = parseEpisodeItems($page, select($page, site.selEpisodes).toArray(), program, index, site);
    chunks.push(pageReleases);
    index += count;
  }

  return { releases: chunks.reverse().flat(), nextIndex: index };
}

/**
 * Ported from `parseEpisodesPage`/`extractEpisodes`: one program archive path's episodes,
 * newest first, fetched lazily page by page so a browsing caller can stop after the first item
 * (the topmost non-VOYO item on the base page — the same one the old `latestEpisode` fetch
 * returned) without paginating further.
 */
async function* extractEpisodesForPath(
  site: NovaArchiveSite, program: Program, uriPath: string, indexState: { value: number }, signal: AbortSignal,
): AsyncGenerator<Release> {
  const uri = joinUrl(program.uri, uriPath);
  let html: string;
  try {
    html = await fetchText(uri, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return; // Non-200: path probably does not exist for this program, ignore (matches upstream)
  }

  const $ = loadHtml(html);
  const items = select($, site.selEpisodes).toArray();
  const loadMoreEl = select($, site.selEpisodesLoadMore).first();
  const hasLoadMore = loadMoreEl.length > 0;

  if (items.length > 0 && hasLoadMore && items[0] && !hasEpisodeNumberInTitle($, items[0], site)) {
    const contentId = contentIdFromLoadMore($, loadMoreEl.get(0) as CheerioElement, uri, !!site.contentParamFallback);
    if (!contentId) { yield* parseEpisodeItems($, items, program, indexState.value, site).releases; return; }

    // Title-less numbering needs the full oldest→newest walk before anything can be numbered
    // (see `walkNumberedByPosition`), so this branch cannot yield before that walk completes.
    const { releases, nextIndex } = await walkNumberedByPosition(site, program, contentId, indexState.value, signal);
    indexState.value = nextIndex;
    yield* releases;
    return;
  }

  // Episodes here are numbered in their titles; one without a number gets none, not its position.
  yield* parseEpisodeItems($, items, program, 0, site, false).releases;
  if (!hasLoadMore) return;

  const contentId = contentIdFromLoadMore($, loadMoreEl.get(0) as CheerioElement, uri, !!site.contentParamFallback);
  const pageSize = items.length;
  if (!contentId || pageSize === 0) return;

  // Each subsequent load-more page is strictly older than the last, and is itself newest-first
  // internally, so paginating forward and yielding per page stays globally newest-first.
  for (let offset = 0; ; offset += pageSize) {
    const $page = loadHtml(await fetchTextRetry(site.episodeListUrl(contentId, offset), signal, 5));
    const { releases: pageReleases, count } = parseEpisodeItems($page, select($page, site.selEpisodes).toArray(), program, 0, site, false);
    yield* pageReleases;
    if (count === 0) break;
  }
}

async function* programReleases(site: NovaArchiveSite, program: Program, signal: AbortSignal): AsyncGenerator<Release> {
  const indexState = { value: 1 };
  for (const path of site.episodePaths) yield* extractEpisodesForPath(site, program, path, indexState, signal);
}

async function resolveMedia(site: NovaArchiveSite, release: Release, signal: AbortSignal) {
  const $ = await fetchDocument(release.url, signal);
  const iframe = select($, site.selPlayerIframe).first();
  if (iframe.length === 0) return [];

  const iframeUrl = absUrl(release.url, iframe.attr(site.iframeAttr));
  if (!iframeUrl) return [];

  const content = await fetchText(iframeUrl, signal);
  if (!content) return [];

  const config = readInlineObject(content, 'player:');
  if (!config) return []; // Media unavailable (licensing/removed), matches upstream's Dialog.showInfo path

  return tracksToSources(playerTracks(config), site.drmReferer);
}

export function createNovaArchiveProvider(site: NovaArchiveSite): Provider {
  let cache: { programs: Program[]; at: number } | null = null;

  async function cachedPrograms(signal: AbortSignal): Promise<Program[]> {
    if (cache && Date.now() - cache.at < PROGRAMS_TTL_MS) return cache.programs;
    const programs = await listPrograms(site, signal);
    cache = { programs, at: Date.now() };
    return programs;
  }

  const catalogue: Catalogue<Program> = {
    async *programs(query: CatalogueQuery, signal: AbortSignal) {
      if (query.kind === 'movie') return; // Archive is TV-only upstream, no invented movie catalog
      yield* await cachedPrograms(signal);
    },
    // These Releases never carry a season, so a season search would walk the whole archive for nothing.
    releases: (program: Program, query: CatalogueQuery, signal: AbortSignal) =>
      query.season !== undefined && query.season < 1900 ? empty() : programReleases(site, program, signal),
  };

  return {
    id: site.id,
    name: site.name,
    catalogue,
    async resolve(release: Release, signal: AbortSignal) {
      return resolveMedia(site, release, signal);
    },
  } satisfies Provider;
}
