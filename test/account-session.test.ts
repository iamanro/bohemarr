import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountSession, SessionRejected, type SessionGrant, type SessionSource } from '../src/providers/account-session.ts';

const signal = new AbortController().signal;
const echo = async (session: string) => session;

/** A source whose logins return `login-1`, `login-2`, …; `gate` holds each login until resolved. */
function source(overrides: Partial<SessionSource<string>> = {}, gate?: Promise<void>) {
  const calls = { login: 0, refresh: 0, loginSignals: [] as AbortSignal[] };
  const value: SessionSource<string> = {
    label: 'provider',
    async login(loginSignal) {
      calls.loginSignals.push(loginSignal);
      const n = ++calls.login;
      await gate;
      loginSignal.throwIfAborted();
      return { session: `login-${n}` };
    },
    ...overrides,
  };
  return { value, calls };
}

test('concurrent callers share one login', async () => {
  const gate = Promise.withResolvers<void>();
  const { value, calls } = source({}, gate.promise);
  const account = new AccountSession(value);
  const both = Promise.all([account.run(echo, signal), account.run(echo, signal)]);
  gate.resolve();
  assert.deepEqual(await both, ['login-1', 'login-1']);
  assert.equal(calls.login, 1);
  assert.equal(await account.run(echo, signal), 'login-1');
});

test('a rejected session is replaced by one new login and the work retried once', async () => {
  const { value, calls } = source();
  const account = new AccountSession(value);
  const seen: string[] = [];
  const result = await account.run(async session => {
    seen.push(session);
    if (session === 'login-1') throw new SessionRejected('expired');
    return session;
  }, signal);
  assert.equal(result, 'login-2');
  assert.deepEqual(seen, ['login-1', 'login-2']);
  // A second rejection is not retried again.
  await assert.rejects(
    account.run(async () => {
      throw new SessionRejected('still refused');
    }, signal),
    /still refused/,
  );
  assert.equal(calls.login, 3);
});

test('other failures neither discard the session nor retry', async () => {
  const { value, calls } = source();
  const account = new AccountSession(value);
  let attempts = 0;
  await assert.rejects(
    account.run(async () => {
      attempts++;
      throw new Error('HTTP 500');
    }, signal),
    /HTTP 500/,
  );
  assert.equal(attempts, 1);
  assert.equal(await account.run(echo, signal), 'login-1');
  assert.equal(calls.login, 1);
});

test('a failed login is not cached', async () => {
  let fail = true;
  const account = new AccountSession<string>({
    label: 'provider',
    async login() {
      if (fail) throw new Error('wrong password');
      return { session: 'ok' };
    },
  });
  await assert.rejects(account.run(echo, signal), /wrong password/);
  fail = false;
  assert.equal(await account.run(echo, signal), 'ok');
});

test('a session is renewed before it expires, by refresh when the source offers one', async () => {
  let now = 0;
  const refreshed: string[] = [];
  const { value, calls } = source({
    async login() {
      calls.login++;
      return { session: `login-${calls.login}`, expiresAt: 100_000 };
    },
    async refresh(session) {
      refreshed.push(session);
      return { session: `${session}+refreshed`, expiresAt: now + 100_000 };
    },
  });
  const account = new AccountSession(value, () => now);
  assert.equal(await account.run(echo, signal), 'login-1');
  now = 69_999;
  assert.equal(await account.run(echo, signal), 'login-1');
  now = 70_000; // within 30 s of expiry
  assert.equal(await account.run(echo, signal), 'login-1+refreshed');
  assert.deepEqual(refreshed, ['login-1']);
  assert.equal(calls.login, 1);
});

test('an expiring session without refresh is replaced by a login', async () => {
  let now = 0;
  let logins = 0;
  const account = new AccountSession<string>(
    {
      label: 'provider',
      async login() {
        logins++;
        return { session: `login-${logins}`, expiresAt: now + 60_000 };
      },
    },
    () => now,
  );
  assert.equal(await account.run(echo, signal), 'login-1');
  now = 30_000;
  assert.equal(await account.run(echo, signal), 'login-2');
});

test('a rejection is never answered with a refresh of the rejected session', async () => {
  const { value, calls } = source({
    async refresh() {
      calls.refresh++;
      return { session: 'refreshed' };
    },
    seed: { session: 'seeded', expiresAt: 0 },
  });
  const account = new AccountSession(value, () => 1_000_000);
  const result = await account.run(async session => {
    if (session !== 'login-1') throw new SessionRejected('refused');
    return session;
  }, signal);
  assert.equal(result, 'login-1');
  assert.equal(calls.refresh, 1, 'the expired seed was refreshed once; the rejected refresh was replaced by a login');
});

test('a rejection while a refresh of the same session is in flight is answered by a login, not by that refresh', async () => {
  let now = 0;
  const refreshGate = Promise.withResolvers<void>();
  const { value, calls } = source({
    async login() {
      calls.login++;
      return { session: `login-${calls.login}`, expiresAt: now + 100_000 };
    },
    async refresh(session) {
      await refreshGate.promise;
      return { session: `${session}+refreshed`, expiresAt: now + 100_000 };
    },
  });
  const account = new AccountSession(value, () => now);
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = account.run(async session => {
    holding.resolve();
    await release.promise;
    if (session === 'login-1') throw new SessionRejected('refused');
    return session;
  }, signal);
  await holding.promise;
  now = 80_000; // login-1 is now expiring, so the next caller starts a refresh of it
  const refreshed = account.run(echo, signal);
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  refreshGate.resolve();
  assert.equal(await first, 'login-2', 'the rejected caller waits for a new login, not for the refresh');
  assert.equal(await refreshed, 'login-1+refreshed');
  assert.equal(calls.login, 2);
});

test('a configured session is used without logging in; once rejected it needs credentials', async () => {
  const seeded: SessionGrant<string> = { session: 'configured' };
  const withCredentials = source({ seed: seeded });
  const account = new AccountSession(withCredentials.value);
  assert.equal(await account.run(echo, signal), 'configured');
  assert.equal(withCredentials.calls.login, 0);

  const withoutCredentials = new AccountSession<string>({ label: 'markizavoyo', seed: seeded });
  await assert.rejects(
    withoutCredentials.run(async () => {
      throw new SessionRejected('player_not_logged_in');
    }, signal),
    /markizavoyo: the configured session is no longer accepted and no username\/password is configured/,
  );
  await assert.rejects(new AccountSession<string>({ label: 'jojplay' }).run(echo, signal), /jojplay: no username\/password is configured/);
});

test('one caller aborting does not abort a login others still wait for', async () => {
  const gate = Promise.withResolvers<void>();
  const { value, calls } = source({}, gate.promise);
  const account = new AccountSession(value);
  const leaving = new AbortController();
  const left = account.run(echo, leaving.signal);
  const staying = account.run(echo, signal);
  leaving.abort();
  await assert.rejects(left, { name: 'AbortError' });
  gate.resolve();
  assert.equal(await staying, 'login-1');
  assert.equal(calls.loginSignals[0]!.aborted, false);
});

test('a login every waiter abandoned is aborted and the next caller logs in afresh', async () => {
  const gate = Promise.withResolvers<void>();
  const { value, calls } = source({}, gate.promise);
  const account = new AccountSession(value);
  const leaving = new AbortController();
  const left = account.run(echo, leaving.signal);
  leaving.abort();
  await assert.rejects(left, { name: 'AbortError' });
  assert.equal(calls.loginSignals[0]!.aborted, true);
  gate.resolve();
  assert.equal(await account.run(echo, signal), 'login-2');
});
