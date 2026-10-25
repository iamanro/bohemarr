import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
// A canary for the runtime, not for this repository's code: Bohemarr downloads through Bun's fetch, and the image
// builds on the floating oven/bun:1.4 tag. Loaded as in the service, in case a dependency ever replaces fetch.
import '../src/providers/index.ts';

test("the runtime's fetch delivers a whole body whose connection closed before it was read (nodejs/undici#5360)", async () => {
  // 64 KiB is the body high-water mark: the parser pauses with the socket drained, then FIN arrives.
  const body = Buffer.alloc(64 * 1024, 0x61);
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      socket.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    // A slow consumer, such as a download waiting on its disk writes, has not read the body yet.
    await delay(200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  } finally {
    server.close();
  }
});
