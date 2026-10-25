import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { hash } from 'node:crypto';
import { join } from 'node:path';
import type { Config, License, MediaSegment } from '../types.ts';
import type { ProtectedTrack } from './mpd.ts';
import type { Cdm, ContentKey } from './protected-media.ts';
import { fetchSegment } from './segment-download.ts';
import { findWidevinePsshBoxes } from './mp4-box.ts';
import { decryptTrack } from './mp4decrypt.ts';
import { downloadSegmentsConcat } from './segment-download.ts';
import { runProcess, sleep } from './process.ts';
import { fetchResponse } from '../providers/common.ts';

/** Matches `DecryptionKeyObtainer`'s `DEFAULT_KEYS_MAX_RETRY_ATTEMPTS`/`DEFAULT_WAIT_ON_RETRY_MS` (drm plugin defaults: 5 / 250ms). */
const KEY_MAX_RETRY_ATTEMPTS = 5;
const KEY_RETRY_BASE_MS = 250;

/** Prefers a provider-supplied PSSH, then the manifest's own ContentProtection/EXT-X-KEY PSSH, then scans the initialization segment as a last resort. */
async function resolveTrackPssh(
  license: License,
  track: ProtectedTrack,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (license.pssh?.length) return license.pssh[0] ?? '';
  if (track.pssh.length) return track.pssh[0] ?? '';
  if (!track.initSegment) throw new Error('Cannot locate a Widevine PSSH: track has no initialization segment');
  // Init segments are a few KB; the shared fetcher brings its retries and byte-range checks.
  const buffer = Buffer.from(await (await fetchSegment(track.initSegment, headers, signal)).arrayBuffer());
  const found = findWidevinePsshBoxes(buffer);
  if (!found.length) throw new Error('No Widevine PSSH found in the manifest or initialization segment');
  return found[0] ?? '';
}

/** Exact segment identity: signed URL rotation may force a restart, but equal durations/KIDs
 * must never cause a different quality or different asset to reuse an old decrypted track. */
function trackIdentity(license: License, track: ProtectedTrack): string {
  const psshHint = license.pssh?.[0] ?? track.pssh[0] ?? '';
  const payload = JSON.stringify({
    psshHint,
    keyId: track.keyId ?? '',
    durationSeconds: track.durationSeconds,
    init: track.initSegment,
    segments: track.mediaSegments,
  });
  return hash('sha256', payload, 'hex');
}

async function isAlreadyComplete(doneMarkerPath: string, outputPath: string, identity: string): Promise<boolean> {
  if (!existsSync(doneMarkerPath) || !existsSync(outputPath)) return false;
  try {
    const marker = await readFile(doneMarkerPath, 'utf8');
    return marker === identity;
  } catch {
    return false;
  }
}

/** Sends the CDM challenge to the provider's license server (or its custom exchange callback) and returns the raw response bytes. */
async function exchangeLicense(license: License, challenge: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  if (license.exchange) return license.exchange(challenge, signal);
  const response = await fetchResponse(license.url, signal, {
    method: 'POST',
    headers: { ...license.headers, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(challenge),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from license server ${new URL(license.url).hostname}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function obtainContentKeysOnce(cdm: Cdm, license: License, pssh: string, signal: AbortSignal): Promise<ContentKey[]> {
  const { session, challenge } = await cdm.challenge(pssh, signal);
  const licenseResponse = await exchangeLicense(license, challenge, signal);
  return cdm.keys(session, licenseResponse, signal);
}

/**
 * Full CDM challenge -> provider license exchange -> CDM key extraction flow, retried with
 * `DecryptionKeyObtainer`'s exact exponential backoff (`waitOnRetryMs * attempt^(4/3)`) when the
 * license server returns no keys.
 */
async function obtainContentKeys(cdm: Cdm, license: License, pssh: string, signal: AbortSignal): Promise<ContentKey[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= KEY_MAX_RETRY_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    try {
      const keys = await obtainContentKeysOnce(cdm, license, pssh, signal);
      if (keys.length) return keys;
    } catch (error) {
      lastError = error;
    }
    if (attempt < KEY_MAX_RETRY_ATTEMPTS) await sleep(KEY_RETRY_BASE_MS * Math.pow(attempt + 1, 4 / 3), signal);
  }
  throw lastError instanceof Error ? lastError : new Error('No Widevine content keys were returned');
}

/**
 * Mirrors `DecryptionKeyObtainer.correctDecryptionKey`: if a key ID is known, pick the matching
 * candidate; otherwise brute-force each candidate against a small test file via ffmpeg's
 * `-decryption_key` flag and keep the first one that decodes cleanly, defaulting the mp4decrypt
 * selector to Bento4's track-number form `"1"` since the real key ID is unknown.
 */
async function selectDecryptionKey(
  config: Config,
  testFilePath: string,
  keys: ContentKey[],
  keyId: string | undefined,
  signal: AbortSignal,
): Promise<{ kid: string; key: string }> {
  if (keyId) {
    const match = keys.find(key => key.kid.replace(/-/g, '').toLowerCase() === keyId.replace(/-/g, '').toLowerCase());
    if (match) return { kid: match.kid, key: match.key };
  }
  for (const candidate of keys) {
    try {
      await runProcess(
        config.ffmpeg,
        ['-y', '-hide_banner', '-loglevel', 'error', '-xerror', '-decryption_key', candidate.key, '-i', testFilePath, '-f', 'null', '-'],
        signal,
      );
      return { kid: '1', key: candidate.key };
    } catch {
      // Wrong key for this track; try the next candidate.
    }
  }
  throw new Error('None of the returned Widevine keys could decrypt a test segment');
}

/**
 * Obtains the correct content key for `track` (CDM challenge -> provider license exchange -> CDM
 * key extraction, falling back to ffmpeg trial-decryption when the key ID is unknown), downloads
 * all of its segments into `workDir` (resumable across process restarts), and decrypts the result
 * in place. Returns the path to the decrypted file.
 */
export async function obtainAndDecryptTrack(
  config: Config,
  cdm: Cdm,
  license: License,
  track: ProtectedTrack,
  headers: Record<string, string> | undefined,
  workDir: string,
  label: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<string> {
  if (!track.mediaSegments.length) throw new Error(`${label} track has no media segments`);
  const outputPath = join(workDir, `${label}.mp4`);
  const doneMarkerPath = join(workDir, `${label}.done`);
  const identity = trackIdentity(license, track);
  if (await isAlreadyComplete(doneMarkerPath, outputPath, identity)) return outputPath;

  const pssh = await resolveTrackPssh(license, track, headers, signal);
  const keys = await obtainContentKeys(cdm, license, pssh, signal);
  if (!keys.length) throw new Error(`No Widevine content keys were returned for the ${label} track`);

  const segments: MediaSegment[] = track.initSegment ? [track.initSegment, ...track.mediaSegments] : track.mediaSegments;
  const firstKey = keys[0];
  let selected: { kid: string; key: string };
  if (keys.length === 1 && track.keyId && firstKey) {
    selected = { kid: track.keyId, key: firstKey.key };
  } else {
    const testPath = join(workDir, `${label}.test.mp4`);
    await downloadSegmentsConcat(segments.slice(0, Math.min(2, segments.length)), headers, testPath, signal);
    selected = await selectDecryptionKey(config, testPath, keys, track.keyId, signal);
  }

  const resumeStatePath = join(workDir, `${label}.state.json`);
  await downloadSegmentsConcat(segments, headers, outputPath, signal, onBytes, resumeStatePath);
  await decryptTrack(config, outputPath, selected.kid, selected.key, signal);
  await writeFile(doneMarkerPath, identity);
  return outputPath;
}
