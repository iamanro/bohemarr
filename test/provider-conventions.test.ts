import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSledovaniTvProvider } from '../src/providers/joj-sledovani-tv.ts';
import { OneplaySession } from '../src/providers/oneplay-auth.ts';
import type { OneplayConnectionPool } from '../src/providers/oneplay-pool.ts';
import type { Release } from '../src/types.ts';

const signal = AbortSignal.timeout(10_000);
const json = (body: unknown): Response => Response.json(body);

test('SledovaniTV: the device a login paired is reused from the database after a restart', async t => {
  let pairings = 0;
  const sessions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://sledovanitv.cz/api/create-pairing')) { pairings++; return json({ password: 'pairing-pass', deviceId: '42' }); }
    if (url.startsWith('https://sledovanitv.cz/api/device-login')) return json({ PHPSESSID: 'sess-1', activeProfileId: '7' });
    if (url.startsWith('https://sledovanitv.cz/api/record-timeshift')) {
      sessions.push(new URL(url).searchParams.get('PHPSESSID') ?? '');
      return json({ url: 'https://cdn.example/stream.m3u8' });
    }
    return new Response('not found', { status: 404 });
  });
  using database = new DatabaseSync(':memory:');
  const release: Release = { id: 'r1', provider: 'sledovanitv', title: 'Show', url: 'https://sledovanitv.cz/home#record:1', kind: 'tv' };
  const config = { username: 'user@example.invalid', password: 'pw' };
  await createSledovaniTvProvider(config, database)!.resolve(release, signal);
  // A second provider on the same database stands for the process after a restart.
  await createSledovaniTvProvider(config, database)!.resolve(release, signal);
  assert.equal(pairings, 1, 'the restart pairs no second device');
  assert.deepEqual(sessions, ['sess-1', 'sess-1'], 'the stored session is used as is');
});

test('Oneplay: a token verified within the last minute is not probed again', async () => {
  const commands: string[] = [];
  let token: unknown = 'token';
  const pool = {
    isAuthenticated: () => token !== null,
    authenticate: (value: unknown) => { token = value; },
    withConnection: async (_signal: AbortSignal, fn: (connection: unknown) => Promise<unknown>) =>
      fn({ request: async (command: string) => { commands.push(command); return { command, status: 'Ok', data: {} }; } }),
  } as unknown as OneplayConnectionPool;
  const session = new OneplaySession(pool, { email: 'e', password: 'p', accountId: undefined, profileId: undefined, profilePin: undefined });
  await Promise.all([session.ensureAuthenticated(signal), session.ensureAuthenticated(signal)]); // concurrent first callers
  await session.ensureAuthenticated(signal);
  await Promise.all([session.ensureAuthenticated(signal), session.ensureAuthenticated(signal)]);
  assert.deepEqual(commands, ['setting.display'], 'one probe serves every call within the minute');
});
