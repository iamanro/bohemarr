import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkizaVoyoProvider } from '../src/providers/nova-markiza-voyo.ts';
import { createSledovaniTvProvider } from '../src/providers/joj-sledovani-tv.ts';
import { createJojPlayProvider } from '../src/providers/joj-sledovani-firestore.ts';
import type { Release } from '../src/types.ts';

const signal = new AbortController().signal;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });
}

// ------------------------------------------------------------------------- VOYO

test('VOYO: a configured votoken refused with player_not_logged_in logs in exactly once and retries with the new votoken', async (t: TestContext) => {
  const releaseUrl = 'https://voyo.markiza.sk/program/epizoda-1';
  const embedUrl = 'https://media.cms.markiza.sk/embed/xyz';
  let logins = 0;
  const embedCookies: string[] = [];

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url === releaseUrl) {
      return new Response(`<div class="js-detail-player"><div class="iframe-wrap"><iframe src="${embedUrl}"></iframe></div></div>`);
    }
    if (url === embedUrl) {
      embedCookies.push(headers.Cookie ?? '');
      if (headers.Cookie === 'votoken=old-token') {
        return new Response('<body class="error"><script>klebetnica({event:"e",data:{type:"player_not_logged_in"}});</script></body>');
      }
      return new Response('<script>player:{lib:{source:{sources:[{type:"video/mp4",src:"https://cdn.example/movie.mp4"}]}}}</script>');
    }
    if (url === 'https://voyo.markiza.sk/prihlasenie' && (!init || init.method === undefined)) {
      return new Response('<input type="hidden" name="_do" value="signInForm-submit">');
    }
    if (url === 'https://voyo.markiza.sk/prihlasenie' && init?.method === 'POST') {
      logins++;
      return new Response(null, {
        status: 302,
        headers: [
          ['location', 'https://voyo.markiza.sk/moj-profil'],
          ['set-cookie', 'votoken=new-token; Path=/'],
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const provider = createMarkizaVoyoProvider({ cookies: 'votoken=old-token', username: 'user@example.invalid', password: 'pw' });
  const release: Release = { id: 'r1', provider: 'markizavoyo', title: 'Episode 1', url: releaseUrl, kind: 'tv' };

  const sources = await provider.resolve(release, signal);
  assert.deepEqual(sources, [{ url: 'https://cdn.example/movie.mp4', type: 'file' }]);
  assert.equal(logins, 1, 'exactly one login after the rejection');
  assert.deepEqual(embedCookies, ['votoken=old-token', 'votoken=new-token'], 'the retry uses the newly issued votoken');
});

test('VOYO: a title outside the subscription fails alone and keeps the configured votoken', async (t: TestContext) => {
  const embedCookies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const page = /^https:\/\/voyo\.markiza\.sk\/program\/(\w+)$/.exec(url);
    if (page) return new Response(`<div class="js-detail-player"><div class="iframe-wrap"><iframe src="https://media.cms.markiza.sk/embed/${page[1]}"></iframe></div></div>`);
    if (url === 'https://media.cms.markiza.sk/embed/premium') {
      embedCookies.push(((init?.headers ?? {}) as Record<string, string>).Cookie ?? '');
      return new Response('<body class="error"><script>klebetnica({event:"e",data:{type:"player_logged_in_no_access"}});</script></body>');
    }
    if (url === 'https://media.cms.markiza.sk/embed/free') {
      embedCookies.push(((init?.headers ?? {}) as Record<string, string>).Cookie ?? '');
      return new Response('<script>player:{lib:{source:{sources:[{type:"video/mp4",src:"https://cdn.example/free.mp4"}]}}}</script>');
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const provider = createMarkizaVoyoProvider({ cookies: 'votoken=my-token' });
  const release = (name: string): Release => ({ id: name, provider: 'markizavoyo', title: name, url: `https://voyo.markiza.sk/program/${name}`, kind: 'tv' });
  await assert.rejects(provider.resolve(release('premium'), signal), /player_logged_in_no_access/);
  assert.deepEqual(await provider.resolve(release('free'), signal), [{ url: 'https://cdn.example/free.mp4', type: 'file' }]);
  assert.deepEqual(embedCookies, ['votoken=my-token', 'votoken=my-token']);
});

// ------------------------------------------------------------------------- SLEDOVANITV

test('SledovaniTV: two concurrent resolutions with credentials create exactly one device pairing', async (t: TestContext) => {
  let pairings = 0;
  let deviceLogins = 0;

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://sledovanitv.cz/api/create-pairing')) {
      pairings++;
      return json({ password: 'pairing-pass', deviceId: '42' });
    }
    if (url.startsWith('https://sledovanitv.cz/api/device-login')) {
      deviceLogins++;
      return json({ PHPSESSID: 'sess-1', activeProfileId: '7' });
    }
    if (url.startsWith('https://sledovanitv.cz/api/record-timeshift')) {
      const recordId = new URL(url).searchParams.get('recordId');
      return json({ url: `https://cdn.example/stream-${recordId}.m3u8` });
    }
    return new Response('not found', { status: 404 });
  });

  const provider = createSledovaniTvProvider({ username: 'user@example.invalid', password: 'pw' });
  assert.ok(provider);

  const release1: Release = { id: 'r1', provider: 'sledovanitv', title: 'Show 1', url: 'https://sledovanitv.cz/home#record:1', kind: 'tv' };
  const release2: Release = { id: 'r2', provider: 'sledovanitv', title: 'Show 2', url: 'https://sledovanitv.cz/home#record:2', kind: 'tv' };

  const [sources1, sources2] = await Promise.all([provider.resolve(release1, signal), provider.resolve(release2, signal)]);
  assert.equal(sources1[0]?.url, 'https://cdn.example/stream-1.m3u8');
  assert.equal(sources2[0]?.url, 'https://cdn.example/stream-2.m3u8');
  assert.equal(pairings, 1, 'exactly one device pairing for two concurrent resolutions');
  assert.equal(deviceLogins, 1, 'exactly one device login for two concurrent resolutions');
});

// ------------------------------------------------------------------------- JOJ PLAY

test('JOJ Play: an anonymous source request that succeeds never attaches a bearer token', async (t: TestContext) => {
  let logins = 0;
  const sourceRequests: Array<{ hasAuth: boolean }> = [];

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url.startsWith('https://www.googleapis.com/identitytoolkit/')) {
      logins++;
      return json({ idToken: 'id-token-1', expiresIn: '3600' });
    }
    if (url === 'https://firestore.googleapis.com/v1/projects/tivio-production/databases/(default)/documents:runQuery') {
      return json([{ document: { name: 'projects/tivio-production/databases/(default)/documents/videos/vid1' } }]);
    }
    if (url === 'https://europe-west3-tivio-production.cloudfunctions.net/getSourceUrl') {
      sourceRequests.push({ hasAuth: 'Authorization' in headers });
      return json({ result: { url: 'https://cdn.example/movie.mp4' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const provider = createJojPlayProvider('user@example.invalid', 'pw');
  const release: Release = { id: 'r1', provider: 'jojplay', title: 'Movie', url: 'https://play.joj.sk/player/slug1', kind: 'movie' };

  const sources = await provider.resolve(release, signal);
  assert.deepEqual(sources, [{ url: 'https://cdn.example/movie.mp4', type: 'file' }]);
  assert.equal(logins, 1, 'a login is only needed for the Firestore document lookup');
  assert.deepEqual(sourceRequests, [{ hasAuth: false }], 'the getSourceUrl request that succeeded carried no bearer token');
});
