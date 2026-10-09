import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import type { Config } from '../src/types.ts';

const config: Config = {
  host: '127.0.0.1', port: 8787, apiKey: 'a'.repeat(64), publicUrl: 'http://localhost:8787',
  dataDir: '/unused', downloadsDir: '/unused', concurrency: 1,
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'https://example.test/wv/',
  categories: ['tv', 'movies'], providers: {}, arrs: [],
};

test('every endpoint but health and login needs the API key or the login cookie', async t => {
  const store = new Store(':memory:');
  const app = await createServer(config, store, new Queue(store, config, new Map(), async () => ''), new Map());
  t.after(async () => { await app.close(); store.close(); });

  for (const [method, url, headers] of [
    ['GET', '/api/v2/torrents/info', {}],
    ['GET', '/api/v2/torrents/info', { cookie: 'SID=wrong' }],
    ['GET', '/api/v2/torrents/info', { authorization: 'Bearer wrong' }],
    ['POST', '/api/v2/torrents/delete?hashes=all', {}],
    ['GET', '/api?t=caps', {}],
    ['GET', `/api?t=caps&apikey=${'b'.repeat(64)}`, {}],
    ['GET', '/v1/providers', {}],
    ['GET', '/API/v2/torrents/info', {}],
    ['GET', '/api/v2/../v1/providers', {}],
  ] as const) {
    const response = await app.inject({ method, url, headers });
    assert.ok([401, 403].includes(response.statusCode), `${method} ${url} ${JSON.stringify(headers)} answered ${response.statusCode}`);
  }

  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject(`/api?t=caps&apikey=${config.apiKey}`)).statusCode, 200);
  assert.equal((await app.inject({ url: '/api?t=caps', headers: { 'x-api-key': config.apiKey } })).statusCode, 200);

  const rejected = await app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: 'username=x&password=wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(rejected.body, 'Fails.');
  const login = await app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: `username=x&password=${config.apiKey}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = /SID=[^;]+/.exec(String(login.headers['set-cookie']))?.[0];
  assert.ok(cookie);
  const listed = await app.inject({ url: '/api/v2/torrents/info', headers: { cookie } });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), []);
  assert.equal((await app.inject({ url: '/api/v2/torrents/info', headers: { authorization: `Bearer ${config.apiKey}` } })).statusCode, 200);
});
