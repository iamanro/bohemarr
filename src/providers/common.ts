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

