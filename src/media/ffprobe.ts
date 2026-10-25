import { runProcess } from './process.ts';
import type { Config } from '../types.ts';

export function headerArgs(headers?: Record<string, string>): string[] {
  if (!headers || !Object.keys(headers).length) return [];
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || /[\r\n]/.test(value)) throw new Error('Invalid media request header');
  }
  const block = `${Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')}\r\n`;
  return ['-headers', block];
}

export interface ProbedStream {
  index: number;
  codec_type: string;
  height?: number;
  bit_rate?: string;
  tags?: { language?: string };
}
export interface MediaProbe {
  streams: ProbedStream[];
  duration?: number;
  size?: number;
}

export async function probeMedia(
  config: Config,
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<MediaProbe> {
  const stdout = await runProcess(
    config.ffprobe,
    [
      ...headerArgs(headers),
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=index,codec_type,height,bit_rate:stream_tags=language',
      '-of',
      'json',
      url,
    ],
    signal,
  );
  const parsed = JSON.parse(stdout) as { streams?: ProbedStream[]; format?: { duration?: string; size?: string } };
  if (!parsed.streams?.length) throw new Error('Media contains no streams');
  const duration = Number(parsed.format?.duration);
  const size = Number(parsed.format?.size);
  return {
    streams: parsed.streams,
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
  };
}

/** Final output must contain playable media, not just an empty or metadata-only container. */
export async function validateMediaFile(config: Config, path: string, signal: AbortSignal): Promise<void> {
  const media = await probeMedia(config, path, undefined, signal);
  if (!media.streams.some(stream => stream.codec_type === 'video' || stream.codec_type === 'audio')) {
    throw new Error('Produced file has no video or audio streams');
  }
  if (!media.size) throw new Error('Produced media file is empty');
}
