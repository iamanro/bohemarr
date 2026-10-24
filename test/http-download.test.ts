import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtempDisposable, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadDirectFile } from '../src/media/http-download.ts';
import type { Config } from '../src/types.ts';

test('a fully written partial file is completed on a 416 that carries no validator', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-direct-'));
  const body = Buffer.from('abcdefgh');
  const seen: IncomingHttpHeaders[] = [];
  await using server = createServer((request, response) => {
    seen.push(request.headers);
    if (request.headers.range) {
      // nginx and most CDNs answer 416 without ETag or Last-Modified.
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
    } else response.writeHead(200, { 'Content-Length': body.length, ETag: '"v1"' }).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/movie.mp4`;
  const finalPath = join(directory.path, 'movie.mp4');
  await writeFile(`${finalPath}.part`, body);
  await writeFile(`${finalPath}.part.meta.json`, JSON.stringify({ url, etag: '"v1"' }));
  const ffprobe = join(directory.path, 'ffprobe');
  await writeFile(ffprobe, '#!/bin/sh\necho \'{"streams":[{"index":0,"codec_type":"video"}],"format":{"size":"8"}}\'\n');
  await chmod(ffprobe, 0o755);
  try {
    await downloadDirectFile({ ffprobe } as Config, { url, type: 'file' }, finalPath, AbortSignal.timeout(5000), () => {});
    assert.equal((await readFile(finalPath)).toString(), 'abcdefgh');
    await assert.rejects(stat(`${finalPath}.part`));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.range, 'bytes=8-');
    assert.equal(seen[0]!['if-range'], '"v1"');
  } finally {
    server.closeAllConnections();
  }
});
