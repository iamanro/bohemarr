import { rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { runProcess } from './process.ts';
import { headerArgs, validateMediaFile } from './ffprobe.ts';
import type { Config, DownloadProgress } from '../types.ts';

export interface MuxInput {
  /** Remote URL or local file path. */
  url: string;
  headers?: Record<string, string>;
  kind: 'video' | 'audio' | 'subtitle';
  streamIndex?: number;
  language?: string;
}

interface ProgressAccumulator {
  bytes: number | undefined;
  outTimeMs: number | undefined;
}

function applyProgressLine(
  accumulator: ProgressAccumulator,
  line: string,
  onProgress: (progress: DownloadProgress) => void,
  durationSeconds: number | undefined,
): void {
  const separator = line.indexOf('=');
  if (separator < 0) return;
  const key = line.slice(0, separator);
  const value = line.slice(separator + 1);
  if (key === 'total_size') accumulator.bytes = Number(value);
  else if (key === 'out_time_ms') accumulator.outTimeMs = Number(value);
  else if (key === 'progress') {
    if (accumulator.bytes !== undefined && Number.isFinite(accumulator.bytes)) {
      const progress: DownloadProgress = { bytes: accumulator.bytes };
      if (durationSeconds && accumulator.outTimeMs !== undefined && Number.isFinite(accumulator.outTimeMs)) {
        progress.progress = Math.max(0, Math.min(100, (accumulator.outTimeMs / 1_000_000 / durationSeconds) * 100));
      }
      onProgress(progress);
    }
    accumulator.bytes = undefined;
    accumulator.outTimeMs = undefined;
  }
}

/**
 * Runs ffmpeg to remux/mux the given inputs (remote URLs for direct HLS/clear-DASH download, or
 * local decrypted track files for the encrypted-DASH/HLS final assembly step) into `outputPath`,
 * stream-copying video/audio and converting subtitles only when the container requires it.
 */
async function ffmpegMux(
  config: Config,
  inputs: MuxInput[],
  outputPath: string,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
  durationSeconds?: number,
): Promise<void> {
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error', '-xerror'];
  let videoIndex = -1;
  let audioIndex = -1;
  const subtitleIndexes: number[] = [];
  for (const [index, input] of inputs.entries()) {
    args.push(...headerArgs(input.headers), '-i', input.url);
    if (input.kind === 'video' && videoIndex < 0) videoIndex = index;
    if (input.kind === 'audio' && audioIndex < 0) audioIndex = index;
    if (input.kind === 'subtitle') subtitleIndexes.push(index);
  }
  if (videoIndex < 0 && audioIndex < 0) throw new Error('No video or audio input to mux');
  if (videoIndex >= 0) args.push('-map', `${videoIndex}:${inputs[videoIndex]!.streamIndex ?? 'v:0'}`);
  if (audioIndex >= 0) args.push('-map', `${audioIndex}:${inputs[audioIndex]!.streamIndex ?? 'a:0'}`);
  else if (videoIndex >= 0) args.push('-map', `${videoIndex}:a:0?`);
  for (const [index, subtitleIndex] of subtitleIndexes.entries()) {
    args.push('-map', `${subtitleIndex}:s:0`);
    const language = inputs[subtitleIndex]!.language;
    if (language) args.push(`-metadata:s:s:${index}`, `language=${language}`);
  }
  args.push('-c:v', 'copy', '-c:a', 'copy');
  const isMp4 = outputPath.toLowerCase().endsWith('.mp4');
  if (subtitleIndexes.length) args.push('-c:s', isMp4 ? 'mov_text' : 'copy');
  if (isMp4) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', outputPath);

  const accumulator: ProgressAccumulator = { bytes: undefined, outTimeMs: undefined };
  let buffer = '';
  await runProcess(config.ffmpeg, args, signal, chunk => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) applyProgressLine(accumulator, line, onProgress, durationSeconds);
    }
  });
}

/**
 * Muxes `inputs` into a hidden temp file beside `finalPath`, validates it with ffprobe and renames
 * it into place. A mux or validation failure removes the temp file; nothing resumes from it.
 */
export async function muxToFile(
  config: Config,
  inputs: MuxInput[],
  finalPath: string,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
  durationSeconds?: number,
): Promise<string> {
  const extension = extname(finalPath);
  const tempPath = join(dirname(finalPath), `.${basename(finalPath, extension)}.tmp${extension}`);
  try {
    await ffmpegMux(config, inputs, tempPath, signal, onProgress, durationSeconds);
    await validateMediaFile(config, tempPath, signal);
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return finalPath;
}
