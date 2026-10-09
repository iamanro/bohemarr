import JSON5 from 'json5';
import * as cheerio from 'cheerio';
import type { Element as CheerioElement } from 'domhandler';
import { bracketSubstring, fetchText } from './common.ts';

/**
 * `CheerioAPI`'s call signature only resolves to `Cheerio<Element>` when the
 * selector argument is a string *literal* (matching its `SelectorType`
 * template); selectors held in `string`-typed config fields fall back to
 * `Cheerio<AnyNode>`. This re-instantiates the generic explicitly, since
 * CSS tag/class/attribute selectors always yield element nodes in practice.
 */
export function select($: cheerio.CheerioAPI, selector: string): cheerio.Cheerio<CheerioElement> {
  return $<CheerioElement, string>(selector);
}

/**
 * Resolves an (possibly relative) href/src attribute against a base URL,
 * mirroring jsoup's `Element#absUrl`.
 */
export function absUrl(base: string, href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** Loads an HTML document with cheerio, matching `HTML.parse`/`HTML.from`. */
export function loadHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}

export async function fetchDocument(url: string | URL, signal: AbortSignal, init: RequestInit = {}): Promise<cheerio.CheerioAPI> {
  return loadHtml(await fetchText(url, signal, init));
}

/** Parse source data as literals only; never execute scripts supplied by a media site. */
export function parseJsObject(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) return null;
  return JSON5.parse(trimmed);
}

/**
 * Locates a `<marker>{...}` occurrence in `content` (e.g. the inline
 * `player:{...}` player-config object embedded in an HTML/JS payload) and
 * evaluates the balanced object literal following it.
 */
export function readInlineObject(content: string, marker: string): unknown {
  const index = content.indexOf(marker);
  if (index < 0) return null;
  const source = bracketSubstring(content, index + marker.length);
  if (!source) return null;
  return parseJsObject(source);
}

export interface PlayerTrack {
  type?: string;
  src?: string;
  contentProtection?: { token?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Digs `lib.source.sources` out of a decoded JW Player-style config object. */
export function playerTracks(config: unknown): PlayerTrack[] {
  if (!config || typeof config !== 'object') return [];
  const lib = (config as Record<string, unknown>)['lib'];
  if (!lib || typeof lib !== 'object') return [];
  const source = (lib as Record<string, unknown>)['source'];
  if (!source || typeof source !== 'object') return [];
  const sources = (source as Record<string, unknown>)['sources'];
  return Array.isArray(sources) ? (sources as PlayerTrack[]) : [];
}

/** GET with bounded retries, matching `Request.of(uri).retry(n).GET()`. */
export async function fetchTextRetry(url: string | URL, signal: AbortSignal, retries: number): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchText(url, signal);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Parses the query string of a URL/href into a plain lookup map. */
export function queryParams(hrefOrQuery: string, base = 'https://placeholder.invalid/'): URLSearchParams {
  try {
    return new URL(hrefOrQuery, base).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Concatenates a program page URL with a relative sub-path using plain
 * string concatenation (a single separating slash), mirroring
 * `Net.uriConcat` as used by the archive engines (NOT `new URL(path, base)`
 * relative resolution, which would instead replace the program's last path
 * segment).
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** A missing pagination page ends the catalog; authentication and network failures do not. */
export async function fetchTextOrEmpty(url: string | URL, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) });
  if (response.status === 404) return '';
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.text();
}
