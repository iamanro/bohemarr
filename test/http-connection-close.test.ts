import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
// Loaded as in the service: provider dependencies may install their own HTTP stack as fetch's dispatcher.
import '../src/providers/index.ts';

test('a response whose connection closes before its body is read still arrives whole (nodejs/undici#5360)', async () => {
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
