import type { Config, DownloadMedia } from '../types.ts';
import { downloadDirectFile } from './http-download.ts';
import { downloadRemux } from './remux.ts';
import { downloadProtectedMedia } from './protected-media.ts';
import { wvApiCdm } from './wv-api.ts';
import { inspectMediaSources } from './metadata.ts';

import { sanitizeFilename } from '../providers/common.ts';

/** Sonarr and Radarr import only media extensions; a link ending in `.php` or a version number gets `mp4`. */
function extensionFromUrl(url: string): string {
  const match = /\.(mp4|mkv|avi|mov|webm|ts|m4v)$/i.exec(new URL(url).pathname);
  return match?.[1]?.toLowerCase() ?? 'mp4';
}

/**
 * Builds the `DownloadMedia` function: inspects every alternative source's actual (never merely
 * hinted) quality via `inspectMediaSources`, picks the best one, and dispatches it to the
 * direct-file streamer, the clear HLS/DASH ffmpeg remuxer, or the encrypted HLS/DASH Widevine
 * pipeline (manifest parse -> WV license exchange -> mp4decrypt -> ffmpeg mux), always returning a
 * path inside `outputDir`.
 */
export function createMediaDownloader(config: Config): DownloadMedia {
  const cdm = wvApiCdm(config);
  return async (sources, outputDir, title, signal, onProgress) => {
    signal.throwIfAborted();
    if (!sources.length) throw new Error('No media sources provided');
    const { source } = await inspectMediaSources(config, sources, signal);
    const safeTitle = sanitizeFilename(title);

    if (source.type === 'file' && (source.audioUrl || source.subtitles?.length) && !source.drm) {
      return downloadRemux(config, source, outputDir, safeTitle, signal, onProgress);
    }

    if (source.type === 'file') {
      if (source.drm) throw new Error('DRM-protected direct file sources are not supported');
      const finalPath = `${outputDir}/${safeTitle}.${extensionFromUrl(source.url)}`;
      await downloadDirectFile(config, source, finalPath, signal, onProgress);
      return finalPath;
    }

    if (source.drm) {
      return downloadProtectedMedia(config, cdm, source, outputDir, safeTitle, signal, onProgress);
    }

    return downloadRemux(config, source, outputDir, safeTitle, signal, onProgress);
  };
}
