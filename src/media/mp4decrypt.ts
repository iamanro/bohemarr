import { rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Config } from '../types.ts';
import { runProcess } from './process.ts';

/**
 * Decrypts `filePath` (a CENC-protected fragmented MP4: init + concatenated media segments) in
 * place using Bento4's `mp4decrypt`, mirroring `Decryptor.java`'s move-decrypt-replace sequence.
 * `kid` is either a hex key ID or, when the ID is unknown, the Bento4 track-number selector `"1"`.
 * Throws (leaving the original encrypted file untouched) on a non-zero exit code.
 */
export async function decryptTrack(config: Config, filePath: string, kid: string, key: string, signal: AbortSignal): Promise<void> {
  const dir = dirname(filePath);
  const token = randomBytes(8).toString('hex');
  const tempInput = join(dir, `${token}.enc.mp4`);
  const tempOutput = join(dir, `${token}.dec.mp4`);
  await rename(filePath, tempInput);
  try {
    await runProcess(config.mp4decrypt, ['--key', `${kid}:${key}`, tempInput, tempOutput], signal);
    // Bento4 may exit successfully for an unmatched/wrong key; metadata-only probing cannot detect it.
    await runProcess(config.ffmpeg, ['-v', 'error', '-xerror', '-i', tempOutput, '-t', '1', '-f', 'null', '-'], signal);
    await rename(tempOutput, filePath);
  } catch (error) {
    await rename(tempInput, filePath).catch(() => {});
    throw error;
  } finally {
    await unlink(tempInput).catch(() => {});
    await unlink(tempOutput).catch(() => {});
  }
}
