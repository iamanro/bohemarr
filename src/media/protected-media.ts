import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DownloadProgress, License, MediaSource } from '../types.ts';
import type { ProtectedTrack } from './mpd.ts';
import { parseManifest, selectVideoAndAudio } from './mpd.ts';
import { resolveHlsTracks } from './m3u8.ts';
import { obtainAndDecryptTrack } from './track-decrypt.ts';
import { ffmpegMux, type MuxInput } from './ffmpeg.ts';
import { validateMediaFile } from './ffprobe.ts';
import { runProcess } from './process.ts';

/** One Widevine content key: a key ID paired with the raw key bytes (hex), as returned by a CDM's license extraction step. */
export interface ContentKey { kid: string; key: string; }

/**
 * The only seam in the protected-media pipeline: a Content Decryption Module that turns a base64
 * PSSH into an opaque session + CDM challenge bytes, and later turns that session plus the raw
 * license server response into content keys. The provider's own license exchange (POSTing the
 * challenge to `License.url`/`License.headers`, or calling `License.exchange`) runs inside this
 * module, not inside the CDM: the CDM only ever sees challenge/response bytes.
 */
export interface Cdm {
  challenge(pssh: string, signal: AbortSignal): Promise<{ session: string; challenge: Uint8Array }>;
  keys(session: string, licenseResponse: Uint8Array, signal: AbortSignal): Promise<ContentKey[]>;
}

/** One Period's selected tracks, in document order; HLS always has exactly one. */
interface Period { video: ProtectedTrack; audio?: ProtectedTrack; }

/** Fetches one track into `workDir` and returns the path of its playable (clear) file. */
export type TrackFetcher = (
  track: ProtectedTrack, workDir: string, label: string, signal: AbortSignal, onBytes: (bytes: number) => void,
) => Promise<string>;

/** ffmpeg concat-demuxer list entries require `'` escaped as `'\''` inside single-quoted paths. */
function concatListEntry(path: string): string {
  return `file '${path.replace(/'/g, "'\\''")}'\n`;
}

/** Losslessly concatenates same-codec ordered fragments (one per DASH Period) via ffmpeg's concat demuxer, preserving timestamps/audio without re-encoding. */
export async function concatOrdered(config: Config, paths: string[], listPath: string, outputPath: string, signal: AbortSignal): Promise<string> {
  if (paths.length === 1) return paths[0]!;
  await writeFile(listPath, paths.map(concatListEntry).join(''));
  await runProcess(config.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath,
  ], signal);
  return outputPath;
}

async function resolvePeriods(source: MediaSource, signal: AbortSignal): Promise<Period[]> {
  if (source.type === 'hls') {
    const selection = await resolveHlsTracks(source.url, source.headers, source.height, source.audioLanguage, signal);
    if (selection.live) throw new Error('Live HLS streams are not supported for download');
    return [{ video: selection.video, audio: selection.audio }];
  }

  const response = await fetch(source.url, { headers: source.headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching DASH manifest`);
  const manifestText = await response.text();
  const manifest = parseManifest(manifestText, response.url);
  if (manifest.live) throw new Error('Live DASH streams are not supported for download');
  return selectVideoAndAudio(manifest, source.height, source.audioLanguage);
}

/**
 * Downloads a Widevine-protected HLS or DASH `source` (whichever `source.type`/`source.drm`
 * indicate): resolves the best <=`source.height` video rendition and its linked/compatible audio,
 * obtains content keys through `cdm` and the provider's own license exchange, and decrypts each
 * track before `muxPeriods` assembles them into a validated `<outputDir>/<safeTitle>.mkv`.
 */
export async function downloadProtectedMedia(
  config: Config, cdm: Cdm, source: MediaSource, outputDir: string, safeTitle: string,
  signal: AbortSignal, onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  if (!source.drm) throw new Error('Protected media source is missing DRM license information');
  const license: License = source.drm;
  const periods = await resolvePeriods(source, signal);
  return muxPeriods(config, source, periods, 'mkv', (track, workDir, label, trackSignal, onBytes) =>
    obtainAndDecryptTrack(config, cdm, license, track, source.headers, workDir, label, trackSignal, onBytes), outputDir, safeTitle, signal, onProgress);
}

/**
 * Fetches every Period's video and audio track with `fetchTrack`, concatenates the Periods, and
 * muxes them (plus any plain subtitle tracks from `source.subtitles`) into a validated
 * `<outputDir>/<safeTitle>.<extension>`, which is only then atomically renamed into place. Tracks
 * are fetched under a `.work` directory that is deliberately left in place on failure, so a later
 * resumed attempt can skip already-completed work.
 */
export async function muxPeriods(
  config: Config, source: MediaSource, periods: Period[], extension: 'mkv' | 'mp4', fetchTrack: TrackFetcher,
  outputDir: string, safeTitle: string, signal: AbortSignal, onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  if (!periods.length) throw new Error('Media source has no periods to download');
  if (periods.some(period => period.audio) && periods.some(period => !period.audio)) {
    throw new Error('Multi-period source has audio in some periods but not others: cannot concatenate without desyncing audio/video');
  }

  const workDir = join(outputDir, `.${safeTitle}.work`);
  await mkdir(workDir, { recursive: true });
  let bytes = 0;
  const reportBytes = (delta: number): void => {
    bytes += delta;
    onProgress({ bytes });
  };

  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  let totalDurationSeconds = 0;
  for (const [index, period] of periods.entries()) {
    const suffix = periods.length > 1 ? `-p${index}` : '';
    videoPaths.push(await fetchTrack(period.video, workDir, `video${suffix}`, signal, reportBytes));
    signal.throwIfAborted();
    if (period.audio) {
      audioPaths.push(await fetchTrack(period.audio, workDir, `audio${suffix}`, signal, reportBytes));
      signal.throwIfAborted();
    }
    totalDurationSeconds += period.video.durationSeconds || 0;
  }

  const videoPath = await concatOrdered(config, videoPaths, join(workDir, 'video.concat.txt'), join(workDir, 'video.concat.mp4'), signal);
  signal.throwIfAborted();
  const audioPath = audioPaths.length
    ? await concatOrdered(config, audioPaths, join(workDir, 'audio.concat.txt'), join(workDir, 'audio.concat.mp4'), signal)
    : undefined;
  signal.throwIfAborted();

  const inputs: MuxInput[] = [{ url: videoPath, kind: 'video' }];
  if (audioPath) inputs.push({ url: audioPath, kind: 'audio' });
  for (const subtitle of source.subtitles ?? []) inputs.push({ url: subtitle.url, headers: subtitle.headers, kind: 'subtitle', language: subtitle.language });

  const tempPath = join(outputDir, `.${safeTitle}.tmp.${extension}`);
  const finalPath = join(outputDir, `${safeTitle}.${extension}`);
  // The mux only copies tracks already downloaded, so its own byte count is not added on top.
  await ffmpegMux(config, inputs, tempPath, signal, progress => {
    onProgress({ bytes, progress: progress.progress });
  }, totalDurationSeconds || undefined);
  await validateMediaFile(config, tempPath, signal);
  await rename(tempPath, finalPath);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  return finalPath;
}
