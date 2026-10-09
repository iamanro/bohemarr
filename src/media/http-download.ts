import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile, rename, stat, unlink } from 'node:fs/promises';
import type { Config, DownloadProgress, MediaSource } from '../types.ts';
import { validateMediaFile } from './ffprobe.ts';
import { writeJsonAtomic } from './segment-download.ts';

interface ResumeMeta { url: string; etag?: string; lastModified?: string; }

/** Parses a `Content-Range: bytes start-end/total` (or `.../*`) response header. */
function parseContentRange(headerValue: string | null): { start: number; end: number; total?: number } | undefined {
  if (!headerValue) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(headerValue);
  if (!match?.[1] || !match[2]) return undefined;
  const total = match[3];
  return { start: Number(match[1]), end: Number(match[2]), total: total === '*' ? undefined : Number(total) };
}

/** Parses a `Content-Range: bytes <asterisk>/total` header sent alongside a 416 response. */
function parseUnsatisfiableTotal(headerValue: string | null): number | undefined {
  const match = headerValue ? /^bytes \*\/(\d+)$/.exec(headerValue) : null;
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

/**
 * Streams a direct file `source` to `finalPath`, resuming from a previous partial `.part` file in
 * the same directory via HTTP `Range` + `If-Range` when the server's `ETag`/`Last-Modified` still
 * match (falls back to a full restart otherwise). Validates the completed file with ffprobe and
 * only then atomically renames it into place, so an aborted or failed attempt never produces a
 * "completed" output and always leaves a resumable, byte-accurate partial file behind.
 */
export async function downloadDirectFile(
  config: Config, source: MediaSource, finalPath: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  const partPath = `${finalPath}.part`;
  const metaPath = `${partPath}.meta.json`;
  let resumeFrom = 0;
  let resumeMeta: ResumeMeta | undefined;
  if (existsSync(partPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as ResumeMeta;
      if (meta.url === source.url) {
        resumeFrom = (await stat(partPath)).size;
        resumeMeta = meta;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (error instanceof SyntaxError || code === 'ENOENT') {
        // Corrupt/stale sidecar or a partial file that vanished mid-read: restart from scratch.
      } else {
        throw error;
      }
    }
  }

  const requestHeaders: Record<string, string> = { ...source.headers };
  if (resumeFrom > 0 && resumeMeta) {
    if (resumeMeta.etag && !resumeMeta.etag.startsWith('W/')) requestHeaders['If-Range'] = resumeMeta.etag;
    else if (resumeMeta.lastModified) requestHeaders['If-Range'] = resumeMeta.lastModified;
    else resumeFrom = 0; // No validator recorded: unsafe to trust the server not to have changed.
  } else {
    resumeFrom = 0;
  }
  if (resumeFrom > 0) requestHeaders.Range = `bytes=${resumeFrom}-`;

  const response = await fetch(source.url, { headers: requestHeaders, signal });
  const validator = requestHeaders['If-Range'];
  if (resumeFrom > 0 && (response.status === 206 || response.status === 416)) {
    const returned = validator?.startsWith('"') ? response.headers.get('etag') : response.headers.get('last-modified');
    if ((returned && returned !== validator) || (response.status === 416 && returned !== validator)) {
      await response.body?.cancel();
      throw new Error('Remote media changed while resuming the download');
    }
  }

  if (response.status === 416) {
    const provenTotal = parseUnsatisfiableTotal(response.headers.get('content-range'));
    await response.body?.cancel().catch(() => {});
    if (provenTotal === undefined || provenTotal !== resumeFrom) {
      throw new Error(
        `HTTP 416 downloading ${new URL(source.url).hostname}: local partial (${resumeFrom} bytes) is not proven to match the remote file`,
      );
    }
    await validateMediaFile(config, partPath, signal);
    await rename(partPath, finalPath);
    await unlink(metaPath).catch(() => {});
    return;
  }
  if (!response.ok && response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} downloading ${new URL(source.url).hostname}`);
  }
  if (!response.body) throw new Error('Download response has no body');

  let writeOffset = 0;
  let totalBytes: number | undefined;
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get('content-range'));
    if (!range || range.start !== resumeFrom || range.total === undefined
        || !Number.isSafeInteger(range.total) || range.end !== range.total - 1 || range.end < range.start) {
      // Server ignored or mismatched our Range request. The on-disk partial + meta are left
      // untouched so a later attempt can retry cleanly; writing here would corrupt the file.
      await response.body.cancel().catch(() => {});
      throw new Error(
        `Range mismatch downloading ${new URL(source.url).hostname}: requested ${resumeFrom}, server returned ${response.headers.get('content-range') ?? 'no Content-Range'}`,
      );
    }
    writeOffset = resumeFrom;
    totalBytes = range.total;
  } else {
    // 200: full content regardless of whether we asked to resume - restart from scratch.
    writeOffset = 0;
    const contentLength = response.headers.get('content-length');
    totalBytes = contentLength ? Number(contentLength) : undefined;
  }
  const resumed = writeOffset > 0;

  const meta: ResumeMeta = {
    url: source.url,
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
  await writeJsonAtomic(metaPath, meta);

  const writeStream = createWriteStream(partPath, { flags: resumed ? 'r+' : 'w', start: writeOffset });
  // pipeline() below surfaces write errors directly; this no-op listener only prevents an
  // uncaught 'error' event if the stream errors asynchronously (e.g. during its own close).
  writeStream.on('error', () => {});

  let bytes = writeOffset;
  const reader = response.body.getReader();
  const onAbort = (): void => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  async function* chunks(): AsyncGenerator<Buffer> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const buffer = Buffer.from(value);
      bytes += buffer.length;
      onProgress({ bytes, totalBytes, progress: totalBytes ? Math.min(100, (bytes / totalBytes) * 100) : undefined });
      yield buffer;
    }
  }
  let failed = false;
  try {
    await pipeline(chunks(), writeStream);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (failed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (totalBytes !== undefined && bytes !== totalBytes) {
    throw new Error(`Incomplete download of ${new URL(source.url).hostname}: got ${bytes} of ${totalBytes} bytes`);
  }

  await validateMediaFile(config, partPath, signal);
  await rename(partPath, finalPath);
  await unlink(metaPath).catch(() => {});
}
