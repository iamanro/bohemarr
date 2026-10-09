import { hash } from 'node:crypto';
import type { MediaSource, Release } from '../types.ts';

export async function fetchText(url: string | URL, signal: AbortSignal, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.text();
}

export async function fetchJson<T = unknown>(url: string | URL, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
  return JSON.parse(await fetchText(url, signal, init)) as T;
}

/**
 * Playback the provider refuses only for now, such as when every concurrent stream of the account
 * is in use. A download hitting it waits and retries instead of failing, because Sonarr would
 * blocklist the only Release of the episode.
 */
export class PlaybackBusy extends Error {}

/**
 * Dotted-path getter over untrusted/unvalidated upstream JSON (`a.b.0.c`), mirroring the Java
 * `JSONCollection.getString`/`getCollection` accessors used throughout the ported clients.
 * Every call site names the expected type explicitly; the single cast here is the
 * boundary where we deliberately step from `unknown` into a caller-declared shape.
 */
export function at<T = unknown>(source: unknown, path: string): T | undefined {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

/** How long a provider's full Program list is reused; below Sonarr's 15-minute RSS interval. */
export const PROGRAM_LIST_TTL_MS = 10 * 60_000;
/** A shared load must not hang forever for every later caller. */
const SHARED_LOAD_TIMEOUT_MS = 110_000;

/**
 * Shares one `load` among all callers for `ttlMs`; a failed load is forgotten. The load runs on
 * its own deadline, so a caller that gives up neither cancels it for the others nor waits for it.
 */
export function cached<T>(ttlMs: number, load: (signal: AbortSignal) => Promise<T>): (signal: AbortSignal) => Promise<T> {
  let entry: { at: number; value: Promise<T> } | undefined;
  return async signal => {
    signal.throwIfAborted();
    if (!entry || Date.now() - entry.at >= ttlMs) {
      const current = { at: Date.now(), value: load(AbortSignal.timeout(SHARED_LOAD_TIMEOUT_MS)) };
      entry = current;
      current.value.catch(() => { if (entry === current) entry = undefined; });
    }
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([entry.value, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

/** The items of a list still being loaded, as the async iterable a Catalogue hands out. */
export async function* each<T>(items: Promise<readonly T[]>): AsyncGenerator<T> {
  yield* await items;
}

/** No Releases: for a Catalogue that knows a query cannot match without asking upstream. */
export async function* empty(): AsyncGenerator<never> {}

/**
 * Extracts a brace-balanced substring starting at the first occurrence of
 * `open` at or after `fromIndex`, honoring JS/​JSON string literals so that
 * braces inside strings are not counted. Mirrors `Utils.bracketSubstring`; `''` when the
 * opening bracket or its match is missing.
 */
export function bracketSubstring(text: string, fromIndex: number, open = '{', close = '}'): string {
  const start = text.indexOf(open, fromIndex);
  if (start < 0) return '';

  let depth = 0;
  let quote: string | null = null;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue; }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return '';
}

export function releaseId(provider: string, url: string): string {
  return hash('sha256', `${provider}\0${url}`, 'hex');
}

export function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function episodeAirDate(release: Release): string | undefined {
  if (release.kind !== 'tv') return undefined;
  const iso = (release.airDate || release.title).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const czech = !iso ? release.title.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/) : null;
  const value = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : czech ? `${czech[3]}-${czech[2]!.padStart(2, '0')}-${czech[1]!.padStart(2, '0')}` : undefined;
  if (!value) return undefined;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return value;
  } catch {
    return undefined;
  }
}

const LANGUAGE_CODES: Record<string, string> = {
  cs: 'CZ', ces: 'CZ', cze: 'CZ', cz: 'CZ',
  sk: 'SK', slk: 'SK', slo: 'SK',
};

/** Normalizes a known audio/subtitle language code to its release-title form; never invents one. */
export function normalizeLanguage(code: string | undefined): string | undefined {
  const language = code?.trim().toLowerCase();
  if (!language) return undefined;
  const separator = language.search(/[-_]/);
  const base = separator < 0 ? language : language.slice(0, separator);
  return LANGUAGE_CODES[base] ?? base.toUpperCase();
}

export function releaseTitle(release: Release): string {
  const name = release.kind === 'tv' ? release.series || release.title : release.title;
  const airDate = episodeAirDate(release);
  const episode = release.season !== undefined && release.episode !== undefined
    ? ` S${String(release.season).padStart(2, '0')}E${String(release.episode).padStart(2, '0')}`
    : airDate ? ` ${airDate.replaceAll('-', '.')}`
    : release.kind === 'tv' && release.episode !== undefined ? ` - ${String(release.episode).padStart(3, '0')}` : '';
  const year = !episode && release.year ? ` ${release.year}` : '';
  const audioLanguage = normalizeLanguage(release.language);
  const language = audioLanguage ? ` (${audioLanguage})` : '';
  const quality = release.height ? `[${release.height}p]` : '';
  return `${name}${episode}${year}${language}[WEB-DL]${quality}`;
}

export function sanitizeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.length && !/^\.+$/.test(cleaned) ? cleaned : 'download';
}

export function mediaType(url: string): MediaSource['type'] {
  const path = new URL(url).pathname.toLowerCase();
  return path.endsWith('.mpd') ? 'dash' : path.endsWith('.m3u8') ? 'hls' : 'file';
}

