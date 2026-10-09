import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadSegmentsConcat } from '../src/media/segment-download.ts';

test('aborting halfway through a segment never checkpoints that segment as complete', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-segments-'));
  let interruptFirst = true;
  await using server = createServer((request, response) => {
    const body = request.url === '/one' ? Buffer.from('abcdefgh') : Buffer.from('IJKLMNOP');
    response.writeHead(200, { 'Content-Length': body.length });
    if (request.url === '/one' && interruptFirst) {
      interruptFirst = false;
      response.write(body.subarray(0, 4));
      // The caller cancels on these first bytes. No timing-dependent completion races.
    } else response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const segments = [{ url: base + '/one' }, { url: base + '/two' }];
  const output = join(directory.path, 'track.mp4');
  const checkpoint = join(directory.path, 'checkpoint.json');
  const controller = new AbortController();
  try {
    await assert.rejects(downloadSegmentsConcat(segments, undefined, output, controller.signal, () => controller.abort(), checkpoint));
    await downloadSegmentsConcat(segments, undefined, output, AbortSignal.timeout(5000), undefined, checkpoint);
    assert.equal((await readFile(output)).toString(), 'abcdefghIJKLMNOP');
  } finally {
    server.closeAllConnections();
  }
});

test('byte-range segments must return precisely the requested bytes', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-range-'));
  const requests: string[] = [];
  await using server = createServer((request, response) => {
    requests.push(request.headers.range || '');
    const body = Buffer.from('abcdefgh');
    const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1]);
    response.writeHead(206, { 'Content-Length': 4, 'Content-Range': `bytes ${start}-${start + 3}/8` });
    response.end(body.subarray(start, start + 4));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/segments`;
  const output = join(directory.path, 'track.mp4');
  try {
    await downloadSegmentsConcat([{ url, range: { start: 4, length: 4 } }, { url, range: { start: 0, length: 4 } }], undefined, output, AbortSignal.timeout(5000));
    assert.equal((await readFile(output)).toString(), 'efghabcd');
    assert.deepEqual(requests, ['bytes=4-7', 'bytes=0-3']);
  } finally {
    server.closeAllConnections();
  }
});

test('a missing segment fails at once instead of being retried, while a server error is retried', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-missing-'));
  const requests: string[] = [];
  await using server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const flaky = request.url === '/flaky' && requests.filter(url => url === '/flaky').length === 1;
    response.writeHead(request.url === '/gone' ? 404 : flaky ? 503 : 200).end(request.url === '/flaky' ? 'ok' : '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await downloadSegmentsConcat([{ url: `${base}/flaky` }], undefined, join(directory.path, 'flaky.mp4'), AbortSignal.timeout(5000));
    assert.equal((await readFile(join(directory.path, 'flaky.mp4'))).toString(), 'ok');
    await assert.rejects(downloadSegmentsConcat([{ url: `${base}/gone` }], undefined, join(directory.path, 'gone.mp4'), AbortSignal.timeout(5000)), /HTTP 404/);
    assert.deepEqual(requests, ['/flaky', '/flaky', '/gone']);
  } finally {
    server.closeAllConnections();
  }
});
