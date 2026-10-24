import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { muxToFile } from '../src/media/ffmpeg.ts';
import type { Config } from '../src/types.ts';

test('a failed mux leaves no hidden temp file in the job directory', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-mux-'));
  // Stands in for ffmpeg: writes the output file (its last argument) and then fails.
  const ffmpeg = join(directory.path, 'ffmpeg');
  await writeFile(ffmpeg, '#!/bin/sh\nfor arg; do last=$arg; done\n: > "$last"\necho broken >&2\nexit 1\n');
  await chmod(ffmpeg, 0o755);
  const finalPath = join(directory.path, 'Movie.mp4');
  await assert.rejects(
    muxToFile({ ffmpeg, ffprobe: 'ffprobe' } as Config, [{ url: 'https://cdn.example/v.m3u8', kind: 'video' }], finalPath, AbortSignal.timeout(5000), () => {}),
    /exited with code 1/,
  );
  assert.deepEqual(await readdir(directory.path), ['ffmpeg'], 'neither .Movie.tmp.mp4 nor Movie.mp4 is left behind');
});
