import { createWriteStream, existsSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { readFile, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { hash } from 'node:crypto';
import type { MediaSegment } from '../types.ts';
import { sleep } from './process.ts';

/** Transient failures are retried for about two minutes of growing waits (250ms * attempt^(4/3)). */
const SEGMENT_MAX_RETRY_ATTEMPTS = 20;
const SEGMENT_RETRY_BASE_MS = 250;

interface ResumeState { completed: number; bytes: number; segmentsHash: string; }

/** Writes `value` as JSON through a temporary file, so a crash never leaves a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value));
  await rename(tmpPath, path);
}

async function fetchSegmentWithRetry(url: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SEGMENT_MAX_RETRY_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch(url, { headers, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
    if (response?.ok) return response;
    if (response) {
      await response.body?.cancel().catch(() => {});
      lastError = new Error(`HTTP ${response.status} downloading segment`);
      // An expired link or a missing segment stays that way; only timeouts and rate limits pass.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw lastError;
    }
    if (attempt < SEGMENT_MAX_RETRY_ATTEMPTS) await sleep(SEGMENT_RETRY_BASE_MS * Math.pow(attempt + 1, 4 / 3), signal);
  }
  throw lastError instanceof Error ? lastError : new Error('Segment download failed');
}

/**
 * Fetches one `segment`, retrying transient failures. When `segment.range` is set, requests that
 * exact byte range and requires the server to honor it with a matching 206 - a 200 (server ignored
 * the range and would return the whole resource) or a mismatched `Content-Range` is a hard error,
 * never silently downloaded and spliced in as if it were the requested slice.
 */
async function fetchSegment(segment: MediaSegment, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<Response> {
  const range = segment.range;
  const requestHeaders = range ? { ...headers, Range: `bytes=${range.start}-${range.start + range.length - 1}` } : headers;
  const response = await fetchSegmentWithRetry(segment.url, requestHeaders, signal);
  if (!range) return response;
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Byte-range segment request to ${new URL(segment.url).hostname} was not honored (got ${response.status}, expected 206)`);
  }
  const contentRange = response.headers.get('content-range');
  if (!contentRange?.startsWith(`bytes ${range.start}-`)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Byte-range mismatch downloading ${new URL(segment.url).hostname}: requested start ${range.start}, server returned ${contentRange ?? 'no Content-Range'}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== range.length) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Byte-range length mismatch downloading ${new URL(segment.url).hostname}: expected ${range.length} bytes, server reports ${contentLength}`);
  }
  return response;
}

/**
 * Streams one segment's response body into `writeStream`, which stays open across segments,
 * calling `onChunk` once each chunk is written. Each write is awaited, so an aborted or failed read
 * never reports more bytes as written than were persisted, and no listener stays on the stream.
 */
async function writeSegmentBody(
  response: Response, writeStream: Writable, signal: AbortSignal, onChunk: (length: number) => void,
): Promise<void> {
  if (!response.body) throw new Error('Segment response has no body');
  const reader = response.body.getReader();
  const onAbort = (): void => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const buffer = Buffer.from(value);
      await new Promise<void>((resolve, reject) => writeStream.write(buffer, error => error ? reject(error) : resolve()));
      onChunk(buffer.length);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Downloads `segments` in order and concatenates their bytes into `outputPath` (a valid fragmented
 * MP4 when `segments` is `[initSegment, ...mediaSegments]`). Segments carrying a `range` (HLS
 * `EXT-X-BYTERANGE` / DASH byte-range indexing) are fetched with an exact HTTP `Range` request and
 * their received length is verified against `range.length`, so a server that ignores or misreports
 * the range fails loudly instead of splicing in wrong or extra bytes.
 *
 * When `resumeStatePath` is given, progress is checkpointed atomically after every fully-written
 * segment so a later call for the *same* `segments` (matched by a hash of each URL + range)
 * resumes from the last checkpoint instead of re-downloading or corrupting the file - the file is
 * truncated back to the checkpoint byte offset first to drop any partially written tail left by a
 * previous abort. A checkpoint whose recorded byte offset exceeds the actual file size (which
 * would otherwise zero-pad the file up to that offset on truncate) is treated as corrupt and the
 * track restarts from scratch instead.
 */
export async function downloadSegmentsConcat(
  segments: MediaSegment[], headers: Record<string, string> | undefined, outputPath: string, signal: AbortSignal,
  onBytes?: (bytes: number) => void, resumeStatePath?: string,
): Promise<void> {
  const segmentsHash = hash(
    'sha256',
    segments.map(segment => `${segment.url}|${segment.range?.start ?? ''}|${segment.range?.length ?? ''}`).join('\n'),
    'hex',
  );
  let startIndex = 0;
  let bytesWritten = 0;
  if (resumeStatePath && existsSync(resumeStatePath) && existsSync(outputPath)) {
    try {
      const state = JSON.parse(await readFile(resumeStatePath, 'utf8')) as ResumeState;
      if (state.segmentsHash === segmentsHash) {
        const actualSize = (await stat(outputPath)).size;
        const completedInRange = state.completed >= 0 && state.completed <= segments.length;
        if (completedInRange && state.bytes >= 0 && state.bytes <= actualSize) {
          startIndex = state.completed;
          await truncate(outputPath, state.bytes);
          bytesWritten = state.bytes;
        }
        // Otherwise the checkpoint is inconsistent with the actual file (would zero-pad on
        // truncate): fall through and restart this track from scratch below.
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (error instanceof SyntaxError || code === 'ENOENT') {
        // Corrupt or stale resume state: restart this track from scratch.
      } else {
        throw error;
      }
    }
  }

  const writeStream = createWriteStream(outputPath, { flags: startIndex > 0 ? 'r+' : 'w', start: bytesWritten });
  // Write errors reach writeSegmentBody() through each write's callback; this no-op listener only
  // keeps the stream's own 'error' event from crashing the process.
  writeStream.on('error', () => {});

  let failed = false;
  try {
    for (let index = startIndex; index < segments.length; index++) {
      signal.throwIfAborted();
      const segment = segments[index];
      if (!segment) continue;
      const response = await fetchSegment(segment, headers, signal);
      let segmentBytes = 0;
      await writeSegmentBody(response, writeStream, signal, length => {
        bytesWritten += length;
        segmentBytes += length;
        onBytes?.(length);
      });
      signal.throwIfAborted();
      const length = response.headers.get('content-length');
      if (length !== null && segmentBytes !== Number(length)) throw new Error('Incomplete segment body');
      if (segment.range && segmentBytes !== segment.range.length) {
        throw new Error(
          `Byte-range segment ${new URL(segment.url).hostname} delivered ${segmentBytes} bytes, expected exactly ${segment.range.length}`,
        );
      }
      if (resumeStatePath) {
        await writeJsonAtomic(resumeStatePath, { completed: index + 1, bytes: bytesWritten, segmentsHash } satisfies ResumeState);
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) {
      writeStream.destroy();
      await finished(writeStream).catch(() => {});
    } else {
      writeStream.end();
      await finished(writeStream);
    }
  }
  if (resumeStatePath) await unlink(resumeStatePath).catch(() => {});
}
