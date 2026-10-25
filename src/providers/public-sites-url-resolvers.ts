// The four URL-resolver providers (server.rtvs, server.html5, server.direct, server.youtube): no catalogue of their own,
// they answer only a query that is a URL on their host. Static `config.catalog` entries are attached by providers/index.ts.
import * as cheerio from 'cheerio';
import type { Catalogue, CatalogueQuery, MediaKind, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { fetchJson, fetchText, mediaType, releaseId } from './common.ts';
import { isYouTubeUrl, maybeTransformYouTubeUrl, resolveYouTube } from './public-sites-youtube.ts';

function basenameNoExt(pathname: string): string {
  const base = pathname.split('/').filter(Boolean).pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Builds the synthetic Release a direct http(s) URL query names, for the four pure
 * URL-resolver providers (stvr, html5, direct, youtube): these have no upstream
 * browse/search capability and only resolve `q` as a URL naming their own host.
 */
export async function urlResolverRelease(
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
  const title = options.title ? options.title(normalized) : basenameNoExt(parsed.pathname) || parsed.hostname;
  const kind: MediaKind = query.kind ?? 'movie';
  return { id: releaseId(id, normalized), provider: id, title, url: normalized, kind };
}

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
      mediaKind = 'video';
      endpoint = 'archive5f';
      break;
    case 'radio/archiv':
    case 'deti/rozhlas':
      mediaKind = 'audio';
      endpoint = 'audio5f';
      break;
    default:
      throw new Error('STVR: unsupported URL');
  }

  const iframe = $(`iframe[id^="player_${mediaKind}_"]`).first();
  if (iframe.length === 0) throw new Error('STVR: unable to find the player iframe on the page');
  const numericId = (iframe.attr('id') ?? '').split('_').pop();
  if (!numericId) throw new Error('STVR: unable to parse the player id');

  const playlistUrl = `https://www.stvr.sk/json/${endpoint}.json?id=${numericId}&=&b=chrome&p=win&f=0&d=1`;
  const payload = await fetchJson<Record<string, unknown>>(playlistUrl, signal);
  const playlist = (mediaKind === 'audio' ? (payload.playlist as Record<string, unknown>[] | undefined)?.[0] : payload.clip) as
    { sources?: { type: string; src: string }[] } | undefined;
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

async function resolveHtml5(url: string, config: ProviderConfig, signal: AbortSignal): Promise<MediaSource[]> {
  const html = await fetchText(url, signal, { headers: config.headers });
  const $ = cheerio.load(html);
  const sources: MediaSource[] = [];

  $('video').each((_i, video) => {
    const $video = $(video);
    const directSrc = $video.attr('src');
    if (directSrc) {
      const sourceUrl = new URL(directSrc, url).href;
      sources.push({ url: sourceUrl, type: mediaType(sourceUrl), headers: config.headers });
    }

    $video.find('source').each((_j, sourceEl) => {
      const src = $(sourceEl).attr('src');
      if (!src) return;
      const sourceUrl = new URL(src, url).href;
      const mime = $(sourceEl).attr('type') ?? '';
      const type = mime.includes('mpegurl') ? 'hls' : mime.includes('dash') ? 'dash' : mediaType(sourceUrl);
      sources.push({ url: sourceUrl, type, headers: config.headers });
    });
  });

  if (sources.length === 0) throw new Error('HTML5: no <video>/<source> elements found on the page');
  return sources;
}

/** A Catalogue that lists nothing and resolves only a URL naming the provider's own host. */
function urlCatalogue(id: string, isCompatible: (url: string) => boolean, options?: Parameters<typeof urlResolverRelease>[4]): Catalogue {
  return {
    async *programs() {},
    async *releases() {},
    releaseForUrl: (url, query) => urlResolverRelease(id, url, query, isCompatible, options),
  };
}

const ANY_HTTP = (candidate: string): boolean => /^https?:\/\//i.test(candidate);

export function createStvrProvider(): Provider {
  return {
    id: 'stvr',
    name: 'STVR (RTVS)',
    catalogue: urlCatalogue('stvr', candidate => REGEX_STVR_URI.test(candidate)),
    resolve: (release, signal) => resolveStvr(release.url, signal),
  };
}

export function createHtml5Provider(config: ProviderConfig): Provider {
  return {
    id: 'html5',
    name: 'HTML5',
    catalogue: urlCatalogue('html5', ANY_HTTP),
    resolve: (release, signal) => resolveHtml5(release.url, config, signal),
  };
}

export function createDirectProvider(config: ProviderConfig): Provider {
  return {
    id: 'direct',
    name: 'Direct',
    catalogue: urlCatalogue('direct', ANY_HTTP),
    resolve: release =>
      Promise.resolve([{ url: release.url, type: mediaType(release.url), headers: config.headers } satisfies MediaSource]),
  };
}

export function createYouTubeProvider(config: ProviderConfig): Provider {
  const catalogue = urlCatalogue('youtube', isYouTubeUrl, {
    normalizeUrl: maybeTransformYouTubeUrl,
    title: u => new URL(u).searchParams.get('v') ?? 'YouTube video',
  });
  return { id: 'youtube', name: 'YouTube', catalogue, resolve: (release, signal) => resolveYouTube(release.url, signal, config) };
}
