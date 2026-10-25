import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtempDisposable, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadDirectFile } from '../src/media/http-download.ts';
import type { Config } from '../src/types.ts';

const body = Buffer.from('abcdefgh');

/** A temp directory with a partial download of the first `partial` bytes of `body` and an ffprobe that approves anything. */
async function setup(handler: RequestListener, partial: Buffer) {
  const directory = await mkdtempDisposable(join(tmpdir(), 'md-direct-'));
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/movie.mp4`;
  const finalPath = join(directory.path, 'movie.mp4');
  await writeFile(`${finalPath}.part`, partial);
  await writeFile(`${finalPath}.part.meta.json`, JSON.stringify({ url, etag: '"v1"' }));
  const ffprobe = join(directory.path, 'ffprobe');
  await writeFile(ffprobe, '#!/bin/sh\necho \'{"streams":[{"index":0,"codec_type":"video"}],"format":{"size":"8"}}\'\n');
  await chmod(ffprobe, 0o755);
  const download = () => downloadDirectFile({ ffprobe } as Config, { url, type: 'file' }, finalPath, AbortSignal.timeout(5000), () => {});
  return {
    directory,
    server,
    seen,
    finalPath,
    download,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      server.close();
      await directory[Symbol.asyncDispose]();
    },
  };
}

test('a fully written partial file is completed on a 416 that carries no validator', async () => {
  await using t = await setup((request, response) => {
    if (request.headers.range) {
      // nginx and most CDNs answer 416 without ETag or Last-Modified.
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
    } else response.writeHead(200, { 'Content-Length': body.length, ETag: '"v1"' }).end(body);
  }, body);
  await t.download();
  assert.equal((await readFile(t.finalPath)).toString(), 'abcdefgh');
  await assert.rejects(stat(`${t.finalPath}.part`));
  assert.equal(t.seen.length, 1);
  assert.equal(t.seen[0]!.range, 'bytes=8-');
  assert.equal(t.seen[0]!['if-range'], '"v1"');
});

test('a resume honoured with 206 appends only the missing bytes', async () => {
  await using t = await setup(
    (request, response) => {
      const from = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
      response
        .writeHead(206, {
          'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}`,
          'Content-Length': body.length - from,
          ETag: '"v1"',
        })
        .end(body.subarray(from));
    },
    body.subarray(0, 4),
  );
  await t.download();
  assert.equal((await readFile(t.finalPath)).toString(), 'abcdefgh');
  assert.equal(t.seen[0]!.range, 'bytes=4-');
});

test('a server that ignores Range and answers 200 restarts the file instead of appending to it', async () => {
  await using t = await setup((_request, response) => {
    response.writeHead(200, { 'Content-Length': body.length, ETag: '"v2"' }).end(body);
  }, Buffer.from('XXXX'));
  await t.download();
  assert.equal((await readFile(t.finalPath)).toString(), 'abcdefgh');
});
