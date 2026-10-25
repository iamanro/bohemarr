import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchResponse, setRequestRate } from '../src/providers/common.ts';

test('requests to one host are spaced by the rate, while another host goes at once', async t => {
  const started: Array<[string, number]> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    started.push([new URL(String(input)).hostname, Date.now()]);
    return new Response('');
  });
  setRequestRate(20); // 50 ms apart
  try {
    const signal = AbortSignal.timeout(5000);
    const begin = Date.now();
    await Promise.all([
      fetchResponse('https://a.example/1', signal),
      fetchResponse('https://a.example/2', signal),
      fetchResponse('https://a.example/3', signal),
      fetchResponse('https://b.example/1', signal),
    ]);
    const a = started
      .filter(([host]) => host === 'a.example')
      .map(([, at]) => at - begin)
      .sort((x, y) => x - y);
    assert.ok(a[2]! >= 95, `third request to a.example waited two slots, got ${a[2]} ms`);
    assert.ok(started.find(([host]) => host === 'b.example')![1] - begin < 40, 'b.example did not wait for a.example');
    // A fresh host whose next slot is taken just now, so the aborted caller is certain to be waiting.
    void fetchResponse('https://c.example/1', signal);
    const aborted = fetchResponse('https://c.example/2', AbortSignal.abort(new Error('cancelled')));
    await assert.rejects(aborted, /cancelled/, 'a caller aborted while waiting for its slot stops waiting');
  } finally {
    setRequestRate(Infinity); // the module default: no limit
  }
});

test('the request deadline covers the response headers, not a body that keeps streaming', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { setRequestTimeout, fetchText } = await import('../src/providers/common.ts');
  await using server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.write('first ');
    setTimeout(() => response.end('second'), 150); // the body outlives a 50 ms deadline
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/slow`;
  setRequestTimeout(50);
  try {
    const response = await fetchResponse(url, AbortSignal.timeout(5000));
    assert.equal(await response.text(), 'first second', 'a download is not cut off by the header deadline');
    await assert.rejects(fetchText(url, AbortSignal.timeout(5000)), 'a text fetch still has to finish within the deadline');
  } finally {
    setRequestTimeout(45_000);
    server.closeAllConnections();
  }
});
