import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    ['GET', '/v1/jobs', {}],
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

test('the settings API needs the API key, hides secrets and saves only settings Bohemarr can start with', async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'bohemarr-settings-'));
  const local = { ...config, dataDir: dir.path, downloadsDir: join(dir.path, 'downloads') };
  const saved = { DATA_DIR: process.env.DATA_DIR, DOWNLOADS_DIR: process.env.DOWNLOADS_DIR, API_KEY: process.env.API_KEY };
  Object.assign(process.env, { DATA_DIR: local.dataDir, DOWNLOADS_DIR: local.downloadsDir, API_KEY: config.apiKey });
  const store = new Store(':memory:');
  const app = await createServer(local, store, new Queue(store, local, new Map(), async () => ''), new Map());
  t.after(async () => {
    await app.close(); store.close();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const headers = { 'x-api-key': config.apiKey };

  assert.equal((await app.inject('/v1/settings')).statusCode, 401);
  assert.equal((await app.inject('/ui/../v1/settings')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/restart' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/settings', payload: { ONEPLAY_PASSWORD: 'x' } })).statusCode, 401);

  const save = (payload: object) => app.inject({ method: 'PUT', url: '/v1/settings', headers, payload });
  assert.match((await save({ FFMPEG: '/bin/sh' })).json().error, /FFMPEG cannot be set here/);
  assert.match((await save({ SONARR_URL: 'http://sonarr:8989' })).json().error, /SONARR_URL and SONARR_API_KEY must be set together/);
  assert.equal((await save({ SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: 'secret', ONEPLAY_USERNAME: 'me' })).statusCode, 200);
  assert.deepEqual(JSON.parse(await readFile(join(dir.path, 'settings.json'), 'utf8')), { SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: 'secret', ONEPLAY_USERNAME: 'me' });

  const { settings } = (await app.inject({ url: '/v1/settings', headers })).json();
  assert.deepEqual(settings.SONARR_API_KEY, { set: true, source: 'ui' });
  assert.deepEqual(settings.ONEPLAY_USERNAME, { value: 'me', set: true, source: 'ui' });
  assert.equal((await save({ ONEPLAY_USERNAME: null })).statusCode, 200);
  assert.equal(JSON.parse(await readFile(join(dir.path, 'settings.json'), 'utf8')).ONEPLAY_USERNAME, undefined);
});
