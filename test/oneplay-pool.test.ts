import test from 'node:test';
import assert from 'node:assert/strict';
import { OneplayConnectionPool } from '../src/providers/oneplay-pool.ts';
import type { OneplayConnection } from '../src/providers/oneplay-connection.ts';
import type { Device } from '../src/providers/oneplay-protocol.ts';

const device = { type: 'test', appVersion: '1', manufacturer: 'test', os: 'test' } as Device;

/** A connection that opens instantly and records what the pool does to it. */
function fakeConnections() {
  const log: string[] = [];
  const connect = (clientId: string): OneplayConnection => {
    let open = false;
    const connection = {
      clientId,
      async open() {
        open = true;
        log.push('open');
        return connection;
      },
      isOpen: () => open,
      close() {
        open = false;
        log.push('close');
      },
      authenticate(token: unknown) {
        log.push(`auth:${String(token)}`);
      },
    };
    return connection as unknown as OneplayConnection;
  };
  return { connect, log };
}

test('an aborted waiter leaves the queue, and the slot it waited for goes to the next caller', async () => {
  const { connect } = fakeConnections();
  const pool = new OneplayConnectionPool(1, device, connect);
  const holder = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const first = pool.withConnection(AbortSignal.timeout(5000), () => {
    entered.resolve();
    return holder.promise;
  });
  await entered.promise; // the first caller holds the only slot before anyone queues
  const waiter = new AbortController();
  const second = pool.withConnection(waiter.signal, async () => 'second');
  const rejected = assert.rejects(second, /gave up/); // attached before the abort, so no rejection goes unhandled
  waiter.abort(new Error('gave up'));
  await rejected;
  const third = pool.withConnection(AbortSignal.timeout(5000), async () => 'third');
  holder.resolve();
  await first;
  assert.equal(await third, 'third', 'the release wakes the live waiter, not the aborted one');
  await pool.close();
});

test('closing the pool rejects queued callers instead of leaving them hanging', async () => {
  const { connect, log } = fakeConnections();
  const pool = new OneplayConnectionPool(1, device, connect);
  const holder = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const first = pool.withConnection(AbortSignal.timeout(5000), () => {
    entered.resolve();
    return holder.promise;
  });
  await entered.promise; // the first caller holds the only slot before anyone queues
  const queued = pool.withConnection(AbortSignal.timeout(5000), async () => 'never');
  const rejected = assert.rejects(queued, /not active/);
  await pool.close();
  await rejected;
  holder.resolve();
  await first;
  assert.ok(log.includes('close'), 'open connections are torn down');
});

test('a failing caller releases its slot, the connection is reused, and authentication reaches it', async () => {
  const { connect, log } = fakeConnections();
  const pool = new OneplayConnectionPool(1, device, connect);
  const signal = AbortSignal.timeout(5000);
  await assert.rejects(
    pool.withConnection(signal, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  pool.authenticate('token' as never);
  assert.equal(await pool.withConnection(signal, async () => 'ok'), 'ok');
  assert.deepEqual(log, ['open', 'auth:token'], 'one connection opened, authenticated in place, no reopen');
  await pool.close();
});
