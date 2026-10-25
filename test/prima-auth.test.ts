import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PrimaAuthenticator } from '../src/providers/prima-auth.ts';
import type { PrimaAccountSession, PrimaSessionHeaders } from '../src/providers/prima-auth.ts';
import { SessionRejected } from '../src/providers/account-session.ts';

const signingKey = 'test-profile-signing-key';
const profilePage = `<script id="__NUXT_DATA__">${JSON.stringify([
  { state: 1 },
  { profiles: 2 },
  [3],
  { ulid: 4, name: 5 },
  'test-profile',
  'Default',
])}</script><script>window.__NUXT__.config={public:{profileTokenSecret:'${signingKey}'}};</script>`;

// Model the account boundary: login registers a device session, authenticated pages
// carry signing data, and the retired device-registration API cannot be used.
function accountServer(t: TestContext) {
  const sessions = new Map<string, string>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://ucet.iprima.cz/api/session/create') {
      const sessionId = `registered-session-${sessions.size + 1}`;
      const token = `account-token-${sessions.size + 1}`;
      sessions.set(token, sessionId);
      return Response.json({ sessionId, accessToken: { value: token } });
    }
    if (url === 'https://www.iprima.cz/profily') {
      const cookie = new Headers(init?.headers).get('Cookie') ?? '';
      const value = cookie.match(/(?:^|;\s*)prima_sso_token=([^;]+)/)?.[1];
      if (!value) return new Response('<html>Sign in</html>');
      const session = JSON.parse(Buffer.from(value, 'base64').toString());
      if (sessions.get(session.accessToken.value) !== session.sessionId) return new Response('Unauthorized', { status: 401 });
      return new Response(profilePage);
    }
    if (url === 'https://gateway-api.prod.iprima.cz/json-rpc/') {
      const request = JSON.parse(String(init?.body));
      return request.method === 'user.user.session.list'
        ? Response.json({ result: { data: { total: 0, data: [] } } })
        : Response.json({ error: { code: -32601, message: `Method "${request.method}" does not exist.` } });
    }
    throw new Error(`Unexpected account request: ${url}`);
  });
  return sessions;
}

function authorizePlayback(headers: PrimaSessionHeaders, sessions: Map<string, string>, configuredDevice?: string): string {
  const token = headers.Cookie.slice('prima_profile_select_token='.length);
  const [header, payload, signature] = token.split('.');
  assert.equal(signature, createHmac('sha256', signingKey).update(`${header}.${payload}`).digest('base64url'));
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  const activeSession = sessions.get(headers['X-OTT-Access-Token']);
  assert.ok(activeSession, 'account access token must identify a registered session');
  assert.equal(claims.sessionId, activeSession, 'profile token must belong to this login');
  assert.equal(claims.profileId, 'test-profile');
  assert.equal(headers['X-OTT-Device'], configuredDevice ?? activeSession, 'playback must not use a missing or stale device');
  return activeSession;
}

test('Prima playback uses the current login device and authenticated profile configuration after relogin', async t => {
  const sessions = accountServer(t);
  const auth = new PrimaAuthenticator({ username: 'test@example.invalid', password: 'test-password' });
  const signal = new AbortController().signal;

  const first = authorizePlayback(await auth.run(async session => auth.headers(session), signal), sessions);

  let rejectedOnce = false;
  const second = authorizePlayback(
    await auth.run(async session => {
      if (!rejectedOnce) {
        rejectedOnce = true;
        throw new SessionRejected('expired');
      }
      return auth.headers(session);
    }, signal),
    sessions,
  );

  assert.notEqual(second, first, 'relogin must not reuse the previous device session');
});

test('Prima preserves an explicitly configured device while signing for the current login', async t => {
  const sessions = accountServer(t);
  const auth = new PrimaAuthenticator({ username: 'test@example.invalid', password: 'test-password', deviceId: 'configured-device' });
  const signal = new AbortController().signal;
  authorizePlayback(await auth.run(async session => auth.headers(session), signal), sessions, 'configured-device');
});

test('Prima rejects a login without the device session ID', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ accessToken: { value: 'test-token' } }));
  const auth = new PrimaAuthenticator({ username: 'test@example.invalid', password: 'test-password' });
  await assert.rejects(
    auth.run(async session => session, new AbortController().signal),
    /session ID/i,
  );
});

test('Prima re-signs the expiring profile-select token without logging in again', async t => {
  const sessions = accountServer(t);
  let now = 0;
  const auth = new PrimaAuthenticator({ username: 'test@example.invalid', password: 'test-password' }, () => now);
  const signal = new AbortController().signal;

  const first = await auth.run(async (session: PrimaAccountSession) => session, signal);
  assert.equal(sessions.size, 1);

  // 45 minutes minus the 30 s renew margin: still within the token's life, so no re-sign yet.
  now = 45 * 60 * 1000 - 30_000 - 1;
  const stillFresh = await auth.run(async (session: PrimaAccountSession) => session, signal);
  assert.equal(stillFresh.profileSelectToken, first.profileSelectToken);

  // Cross the renew margin: the token is re-signed, but no new login is made.
  now = 45 * 60 * 1000 - 30_000;
  const renewed = await auth.run(async (session: PrimaAccountSession) => session, signal);
  assert.equal(sessions.size, 1, 'renewal must not create a new device session');
  assert.equal(renewed.sessionId, first.sessionId);
  assert.equal(renewed.deviceId, first.deviceId);
  assert.notEqual(renewed.profileSelectToken, first.profileSelectToken);

  const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  const firstClaims = decode(first.profileSelectToken);
  const renewedClaims = decode(renewed.profileSelectToken);
  assert.equal(renewedClaims.sessionId, firstClaims.sessionId);
  assert.equal(renewedClaims.profileId, firstClaims.profileId);
  assert.ok(renewedClaims.exp > firstClaims.exp, 'the re-signed token must carry a later expiry');
});
