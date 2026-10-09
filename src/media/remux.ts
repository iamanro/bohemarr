import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DownloadProgress, MediaSource } from '../types.ts';
import { ffmpegMux } from './ffmpeg.ts';
import type { MuxInput } from './ffmpeg.ts';
import { probeMedia, validateMediaFile } from './ffprobe.ts';
import { resolveHlsTracks } from './m3u8.ts';
import { parseManifest, selectVideoAndAudio } from './mpd.ts';
import { downloadSegmentsConcat } from './segment-download.ts';
import { muxPeriods } from './protected-media.ts';
import { bestStream, DEFAULT_AUDIO_LANGUAGE } from './metadata.ts';

/**
 * Downloads a clear (non-DRM) DASH `source` by explicitly selecting the best video/audio
 * Representation per Period (the same selection `inspectMediaSources` uses), rather than trusting
 * ffmpeg's own DASH demuxer to auto-pick a Representation - which is not guaranteed to be the
 * highest quality or requested-language one.
 */
async function downloadClearDash(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const response = await fetch(source.url, { headers: source.headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching DASH manifest`);
  const manifest = parseManifest(await response.text(), response.url);
  if (manifest.live) throw new Error('An ongoing DASH live stream cannot be imported');
  const periods = selectVideoAndAudio(manifest, undefined, source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE);
  return muxPeriods(config, source, periods, source.subtitles?.length ? 'mkv' : 'mp4', async (track, workDir, label, trackSignal, onBytes) => {
    const path = join(workDir, `${label}.mp4`);
    await downloadSegmentsConcat(track.initSegment ? [track.initSegment, ...track.mediaSegments] : track.mediaSegments, source.headers, path, trackSignal, onBytes);
    return path;
  }, outputDir, safeTitle, signal, onProgress);
}

/**
 * Downloads a clear (non-DRM) HLS `source` by feeding ffmpeg the explicitly-resolved best variant
 * and linked-audio-group playlist URLs (rather than the master playlist, whose default rendition
 * ffmpeg's own HLS demuxer would otherwise pick), so the requested/highest quality and language
 * are what's actually downloaded.
 */
async function downloadClearHls(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const selection = await resolveHlsTracks(source.url, source.headers, undefined, source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE, signal);
  if (selection.live) throw new Error('An ongoing HLS live stream cannot be imported');

  const inputs: MuxInput[] = [{ url: selection.videoPlaylistUrl, headers: source.headers, kind: 'video' }];
  if (selection.audioPlaylistUrl) inputs.push({ url: selection.audioPlaylistUrl, headers: source.headers, kind: 'audio' });
  for (const subtitle of source.subtitles ?? []) inputs.push({ url: subtitle.url, headers: subtitle.headers, kind: 'subtitle', language: subtitle.language });
  const ext = source.subtitles?.length ? 'mkv' : 'mp4';
  const tempPath = join(outputDir, `.${safeTitle}.tmp.${ext}`);
  const finalPath = join(outputDir, `${safeTitle}.${ext}`);
  await ffmpegMux(config, inputs, tempPath, signal, onProgress, selection.video.durationSeconds || undefined);
  await validateMediaFile(config, tempPath, signal);
  await rename(tempPath, finalPath);
  return finalPath;
}

/** Clear adaptive streams and separate file tracks share the same explicit stream-selection path. */
export async function downloadRemux(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  if (source.type === 'dash') return downloadClearDash(config, source, outputDir, safeTitle, signal, onProgress);
  if (source.type === 'hls') return downloadClearHls(config, source, outputDir, safeTitle, signal, onProgress);

  const media = await probeMedia(config, source.url, source.headers, signal);
  const video = media.streams.filter(stream => stream.codec_type === 'video' && (!source.height || (stream.height || 0) <= source.height))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(b.bit_rate || 0) - Number(a.bit_rate || 0))[0];
  if (!video) throw new Error('Source contains no video matching the requested quality');
  const inputs: MuxInput[] = [{ url: source.url, headers: source.headers, kind: 'video', streamIndex: video.index }];
  const preferredLanguage = source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE;
  if (source.audioUrl) {
    const audio = await probeMedia(config, source.audioUrl, source.headers, signal);
    const stream = bestStream(audio.streams, 'audio', preferredLanguage);
    if (!stream) throw new Error('Separate audio source contains no audio');
    inputs.push({ url: source.audioUrl, headers: source.headers, kind: 'audio', streamIndex: stream.index });
  } else {
    // No separate audio file: an embedded track still needs an explicit pick, since ffmpeg's own
    // default (first) audio stream is not necessarily the highest-bitrate or preferred-language one.
    const stream = bestStream(media.streams, 'audio', preferredLanguage);
    if (stream) inputs.push({ url: source.url, headers: source.headers, kind: 'audio', streamIndex: stream.index });
  }
  for (const subtitle of source.subtitles ?? []) {
    inputs.push({ url: subtitle.url, headers: subtitle.headers, kind: 'subtitle', language: subtitle.language });
  }
  const ext = source.subtitles?.length ? 'mkv' : 'mp4';
  const tempPath = join(outputDir, `.${safeTitle}.tmp.${ext}`);
  const finalPath = join(outputDir, `${safeTitle}.${ext}`);
  await ffmpegMux(config, inputs, tempPath, signal, onProgress, media.duration);
  await validateMediaFile(config, tempPath, signal);
  await rename(tempPath, finalPath);
  return finalPath;
}
