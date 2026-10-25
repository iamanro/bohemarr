import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectMediaSources } from '../src/media/metadata.ts';
import type { Config } from '../src/types.ts';

test('a direct file ffprobe cannot read remotely is offered when its size is known, and fails when nothing is known', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-unprobed-'));
  const ffprobe = join(directory.path, 'ffprobe');
  await writeFile(ffprobe, '#!/bin/sh\necho "Input/output error" >&2\nexit 1\n');
  await chmod(ffprobe, 0o755);
  await using server = createServer((request, response) => {
    if (request.url === '/unknown.avi') return void response.writeHead(403).end(); // neither size nor content readable
    if (request.method === 'HEAD') return void response.writeHead(200, { 'Content-Length': 734003235 }).end();
    response.writeHead(302, { Location: '/error' }).end(); // ranged reads are refused, as on a free file host
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/Matrix.avi`;
  try {
    const metadata = await inspectMediaSources({ ffprobe } as Config, [{ url, type: 'file' }], AbortSignal.timeout(5000));
    assert.equal(metadata.source.url, url);
    assert.deepEqual([metadata.size, metadata.sizeEstimated, metadata.height], [734003235, false, undefined]);
    const unknown = url.replace('Matrix.avi', 'unknown.avi');
    await assert.rejects(
      inspectMediaSources({ ffprobe } as Config, [{ url: unknown, type: 'file' }], AbortSignal.timeout(5000)),
      /Input\/output error/,
    );
  } finally {
    server.closeAllConnections();
  }
});
