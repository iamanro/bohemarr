import type { Config, MediaSource } from '../types.ts';
import { parseManifest, selectVideoAndAudio, type DashRepresentation, type ProtectedTrack } from './mpd.ts';
import { resolveHlsTracks } from './m3u8.ts';
import { probeMedia, type ProbedStream } from './ffprobe.ts';
import { normalizeLanguage } from '../providers/common.ts';

/** Bohemarr's catalogue is Czech-market: when a source offers multiple audio languages and the
 * caller hasn't pinned one via `MediaSource.audioLanguage`, Czech is preferred if present. */
export const DEFAULT_AUDIO_LANGUAGE = 'cs';

/** The result of inspecting a release's alternative `MediaSource`s: the best one (by actual
 * discovered video height, then bandwidth) plus honest, never-fabricated metadata about it.
 * `source` carries ephemeral, short-lived URLs/headers and MUST NEVER be persisted. */
export interface MediaMetadata {
  source: MediaSource;
  height?: number;
  size?: number;
  sizeEstimated?: boolean;
  language?: string;
}

interface Candidate {
  source: MediaSource;
  height?: number;
  rankBandwidth: number;
  size?: number;
  sizeEstimated?: boolean;
  language?: string;
}

/** Exact selected-track byte count when every segment (and the init segment, if any) carries an
 * explicit HTTP byte range within a single addressable file - never an estimate in that case. */
function exactTrackBytes(track: ProtectedTrack): number | undefined {
  if (track.initSegment && !track.initSegment.range) return undefined;
  if (!track.mediaSegments.length || track.mediaSegments.some(segment => !segment.range)) return undefined;
  let total = track.initSegment?.range?.length ?? 0;
  for (const segment of track.mediaSegments) total += segment.range!.length;
  return total;
}

/** A DASH track's byte count: exact when explicit byte ranges are available, otherwise a
 * `bandwidth * duration` estimate (the only option when segments are separately addressed files,
 * as is common for DASH `SegmentTemplate` - inspecting them all would mean fetching every one).
 * `undefined` (never `0`) when neither an exact range nor a usable bandwidth/duration exists, so a
 * track with genuinely unknown size can never silently contribute zero bytes to a total. */
function trackBytes(track: DashRepresentation): { bytes: number; estimated: boolean } | undefined {
  const exact = exactTrackBytes(track);
  if (exact !== undefined) return { bytes: exact, estimated: false };
  const duration = track.durationSeconds || 0;
  if (!track.bandwidth || !duration) return undefined;
  return { bytes: Math.round((track.bandwidth * duration) / 8), estimated: true };
}

/** Highest-bitrate stream in `streams`, preferring `codec_type === kind` and (for audio) a
 * language match (compared via `normalizeLanguage`, so ffprobe's `ces`/`cs-CZ`/... all count as a
 * match) against `preferredLanguage` when more than one candidate exists. */
export function bestStream(streams: ProbedStream[], kind: string, preferredLanguage?: string): ProbedStream | undefined {
  const candidates = streams.filter(stream => stream.codec_type === kind);
  const preferredNormalized = preferredLanguage ? normalizeLanguage(preferredLanguage) : undefined;
  const matching = preferredNormalized ? candidates.filter(stream => normalizeLanguage(stream.tags?.language) === preferredNormalized) : [];
  const pool = matching.length ? matching : candidates;
  return pool.reduce<ProbedStream | undefined>((best, current) => {
    if (!best) return current;
    if (kind === 'video') {
      const bestHeight = best.height ?? 0;
      const currentHeight = current.height ?? 0;
      if (currentHeight !== bestHeight) return currentHeight > bestHeight ? current : best;
    }
    return Number(current.bit_rate || 0) > Number(best.bit_rate || 0) ? current : best;
  }, undefined);
}

/** Strips query/hash (where signed provider URLs carry short-lived tokens) before a URL is ever logged. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * A `Content-Length` for `url` without downloading it: a `HEAD` request, or - only for servers
 * that don't implement `HEAD` (405/501) - a 1-byte ranged `GET` (its body is never consumed
 * beyond the ranged slice already sent). An error response's body length is never mistaken for
 * the media's size; abort/network errors propagate rather than being reported as "unknown".
 */
async function headContentLength(url: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<number | undefined> {
  const parseLength = (value: string | null): number | undefined => {
    const length = Number(value);
    return value !== null && Number.isFinite(length) && length >= 0 ? length : undefined;
  };

  const head = await fetch(url, { method: 'HEAD', headers, signal });
  await head.body?.cancel().catch(() => {});
  if (head.ok) return parseLength(head.headers.get('content-length'));
  if (head.status !== 405 && head.status !== 501) return undefined;

  const ranged = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
  if (ranged.status === 206) {
    const match = /^bytes \d+-\d+\/(\d+)$/.exec(ranged.headers.get('content-range') ?? '');
    await ranged.body?.cancel().catch(() => {});
    return match?.[1] !== undefined ? parseLength(match[1]) : undefined;
  }
  // The server ignored the Range and sent the whole resource: its Content-Length is still the
  // real total size, and there's no need to actually read the (uncancelled) body to learn it.
  const length = ranged.ok ? parseLength(ranged.headers.get('content-length')) : undefined;
  await ranged.body?.cancel().catch(() => {});
  return length;
}

async function inspectDash(source: MediaSource, signal: AbortSignal): Promise<Candidate | undefined> {
  const response = await fetch(source.url, { headers: source.headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching DASH manifest`);
  const manifest = parseManifest(await response.text(), response.url);
  if (manifest.live) return undefined;
  const selections = selectVideoAndAudio(manifest, undefined, source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE);

  let height: number | undefined;
  let bandwidth = 0;
  let bytes = 0;
  let bytesKnown = true;
  let sizeEstimated = false;
  let language: string | undefined;
  for (const { video, audio } of selections) {
    if (video.height !== undefined) height = Math.max(height ?? 0, video.height);
    bandwidth = Math.max(bandwidth, video.bandwidth);
    const videoBytes = trackBytes(video);
    if (!videoBytes) bytesKnown = false;
    else { bytes += videoBytes.bytes; sizeEstimated ||= videoBytes.estimated; }
    if (audio) {
      language ??= audio.language;
      const audioBytes = trackBytes(audio);
      if (!audioBytes) bytesKnown = false;
      else { bytes += audioBytes.bytes; sizeEstimated ||= audioBytes.estimated; }
    }
  }
  const size = bytesKnown ? bytes : undefined;

  return {
    source: { ...source, height, bandwidth: bandwidth || undefined, audioLanguage: language },
    height, rankBandwidth: bandwidth,
    size, sizeEstimated: size !== undefined ? sizeEstimated : undefined, language,
  };
}

async function inspectHls(source: MediaSource, signal: AbortSignal): Promise<Candidate | undefined> {
  const selection = await resolveHlsTracks(source.url, source.headers, undefined, source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE, signal);
  if (selection.live) return undefined;
  const height = selection.video.height;
  const duration = selection.video.durationSeconds || 0;
  const language = selection.audio?.language;

  // Exact byte-ranged segments (common for CENC/fMP4-over-HLS) beat any bandwidth estimate.
  const videoExact = exactTrackBytes(selection.video);
  const audioExact = selection.audio ? exactTrackBytes(selection.audio) : 0;
  let size: number | undefined;
  let sizeEstimated: boolean | undefined;
  if (videoExact !== undefined && audioExact !== undefined) {
    size = videoExact + audioExact;
    sizeEstimated = false;
  } else {
    // `#EXT-X-STREAM-INF` BANDWIDTH is a combined AV rate (RFC 8216 4.3.4.2): the audio track is
    // already accounted for and must never be added again. AVERAGE-BANDWIDTH, when present, is a
    // truer estimator of the actual played-out size than the (worst-case) peak BANDWIDTH.
    const bandwidth = selection.video.averageBandwidth ?? selection.video.bandwidth;
    size = bandwidth && duration ? Math.round((bandwidth * duration) / 8) : undefined;
    sizeEstimated = size !== undefined ? true : undefined;
  }

  return {
    source: { ...source, height, bandwidth: selection.video.bandwidth, audioLanguage: language },
    height, rankBandwidth: selection.video.bandwidth ?? 0,
    size, sizeEstimated, language,
  };
}

async function inspectFile(config: Config, source: MediaSource, signal: AbortSignal): Promise<Candidate | undefined> {
  let height = source.height;
  let language = source.audioLanguage;
  let bandwidth: number | undefined;
  const videoLength = await headContentLength(source.url, source.headers, signal);

  // Only probe when something is actually still unknown: a source that already carries both a
  // height and a pinned/no-op-needed language never pays for an avoidable ffprobe round trip.
  if (height === undefined || (language === undefined && !source.audioUrl)) {
    const probe = await probeMedia(config, source.url, source.headers, signal);
    const video = bestStream(probe.streams, 'video');
    height ??= video?.height;
    const rate = Number(video?.bit_rate);
    if (Number.isFinite(rate) && rate > 0) bandwidth = rate;
    if (!source.audioUrl) {
      const audio = bestStream(probe.streams, 'audio', source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE);
      if (audio?.tags?.language) language = audio.tags.language;
    }
  }

  let audioLength: number | undefined;
  let audioSizeKnown = true;
  if (source.audioUrl) {
    audioLength = await headContentLength(source.audioUrl, source.headers, signal);
    audioSizeKnown = audioLength !== undefined;
    const audioProbe = await probeMedia(config, source.audioUrl, source.headers, signal);
    const audio = bestStream(audioProbe.streams, 'audio', source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE);
    if (audio?.tags?.language) language = audio.tags.language;
  }

  // A separate audio track whose own size is unknown must never let the combined AV size be
  // reported as if it were the (video-only) exact total.
  const size = videoLength !== undefined && audioSizeKnown ? videoLength + (audioLength ?? 0) : undefined;
  return {
    source: { ...source, height, audioLanguage: language },
    height, rankBandwidth: bandwidth ?? source.bandwidth ?? 0,
    size, sizeEstimated: size !== undefined ? false : undefined, language,
  };
}

async function inspectSource(config: Config, source: MediaSource, signal: AbortSignal): Promise<Candidate | undefined> {
  if (source.type === 'dash') return inspectDash(source, signal);
  if (source.type === 'hls') return inspectHls(source, signal);
  return inspectFile(config, source, signal);
}

/**
 * Inspects every alternative `sources` for a release using the existing DASH/HLS manifest parsers
 * and ffprobe (never a second manifest parser, never enumerating/HEAD-ing every segment) and
 * returns the single best one: highest actual discovered video height, then bandwidth. A source's
 * own possibly-stale `height`/`bandwidth` hint is never trusted over what's actually discovered,
 * so a larger, uninspected manifest always beats a tagged-low-quality alternative. Live sources
 * are rejected; direct files get an exact byte size from `Content-Length`, adaptive streams get an
 * honestly-labelled (`sizeEstimated: true`) `bandwidth * duration` estimate unless every selected
 * segment carries an explicit byte range. An alternative that fails to inspect is reported (with
 * its URL's query/hash redacted, since provider URLs are often signed) rather than silently
 * dropped behind whichever lower-quality alternative happened to succeed; the whole call only
 * fails if every alternative failed or was live. `source` on the result carries ephemeral
 * URLs/headers and the actually-resolved audio language, and must never be persisted.
 */
export async function inspectMediaSources(config: Config, sources: MediaSource[], signal: AbortSignal): Promise<MediaMetadata> {
  if (!sources.length) throw new Error('No media sources provided');
  const settled = await Promise.allSettled(sources.map(source => inspectSource(config, source, signal)));
  signal.throwIfAborted();

  const candidates: Candidate[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      if (result.value) candidates.push(result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`Media source alternative unusable (${redactUrl(sources[index]!.url)}): ${reason}`);
    }
  }

  if (!candidates.length) {
    const rejection = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejection) throw rejection.reason instanceof Error ? rejection.reason : new Error(String(rejection.reason));
    throw new Error('All media sources are live streams and cannot be downloaded');
  }

  const best = candidates.reduce((a, b) => {
    const heightA = a.height ?? -1;
    const heightB = b.height ?? -1;
    if (heightA !== heightB) return heightB > heightA ? b : a;
    return b.rankBandwidth > a.rankBandwidth ? b : a;
  });

  return { source: best.source, height: best.height, size: best.size, sizeEstimated: best.sizeEstimated, language: best.language };
}
