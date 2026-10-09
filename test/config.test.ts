import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/types.ts';

/** Loads the configuration from `variables` and an optional config.json; `files` are written next to it first. */
async function load(variables: Record<string, string>, json?: object, files: Record<string, string> = {}): Promise<Config> {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'bohemarr-config-'));
  if (json) await writeFile(join(dir.path, 'config.json'), JSON.stringify(json));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir.path, name), content);
  const all = Object.fromEntries(Object.entries({ DATA_DIR: dir.path, DOWNLOADS_DIR: join(dir.path, 'downloads'), API_KEY: 'k'.repeat(32), ...variables })
    .map(([name, value]) => [name, value.replaceAll('$DIR', dir.path)]));
  const previous = Object.fromEntries(Object.keys(all).map(name => [name, process.env[name]]));
  Object.assign(process.env, all);
  try {
    return await loadConfig();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('PROVIDERS enables exactly the listed providers, which take their settings from the environment', async () => {
  const config = await load({ PROVIDERS: 'oneplay, ceskatelevize', ONEPLAY_USERNAME: 'me', ONEPLAY_PROFILE_PIN: '1234', CATEGORIES: 'tv,anime' });
  assert.deepEqual(config.providers.oneplay, { enabled: true, username: 'me', profilePin: '1234' });
  assert.equal(config.providers.ceskatelevize?.enabled, true);
  assert.equal(config.providers.youtube?.enabled, false);
  assert.deepEqual(config.categories, ['tv', 'anime']);
  await assert.rejects(load({ PROVIDERS: 'oneplay,netflix' }), /unknown providers: netflix/);
});

test('config.json holds only nested provider settings and names the variable for anything else', async () => {
  const catalog = [{ title: 'Film', kind: 'movie', url: 'https://example.test/film.mp4' }];
  const config = await load({ PROVIDERS: 'direct' }, { providers: { direct: { catalog, headers: { Referer: 'https://example.test/' } } } });
  assert.deepEqual(config.providers.direct, { catalog, headers: { Referer: 'https://example.test/' }, enabled: true });
  await assert.rejects(load({}, { concurrency: 4, sonarr: {}, providers: { oneplay: { enabled: true, password: 'x', profilePin: '1' } } }),
    error => ['concurrency (use CONCURRENCY)', 'sonarr (use SONARR_*)', 'providers.oneplay.enabled (use PROVIDERS)',
      'providers.oneplay.password (use ONEPLAY_PASSWORD)', 'providers.oneplay.profilePin (use ONEPLAY_PROFILE_PIN)']
      .every(part => (error as Error).message.includes(part)));
  await assert.rejects(load({}, { providers: { netflix: { catalog: [] } } }), /unknown provider netflix/);
});

test('a _FILE variable supplies a secret from a file, and setting both forms is rejected', async () => {
  const config = await load({ API_KEY: '', API_KEY_FILE: '$DIR/api-key-secret', ONEPLAY_PASSWORD_FILE: '$DIR/oneplay' },
    undefined, { 'api-key-secret': `${'s'.repeat(40)}\n`, oneplay: 'pass word\n' });
  assert.equal(config.apiKey, 's'.repeat(40));
  assert.equal(config.providers.oneplay?.password, 'pass word');
  await assert.rejects(load({ SONARR_API_KEY: 'a', SONARR_API_KEY_FILE: '$DIR/x' }), /Set either SONARR_API_KEY or SONARR_API_KEY_FILE/);
  await assert.rejects(load({ ONEPLAY_PASSWORD_FILE: '$DIR/missing' }), /ONEPLAY_PASSWORD_FILE: .*ENOENT/);
});

test('publishing to Vltava is off without its URL and token, and a partial setup stops the start', async () => {
  assert.equal((await load({})).vltava, undefined);
  const complete = { VLTAVA_URL: 'https://vltava.test/', VLTAVA_TOKEN: 't', VLTAVA_PROVIDERS: 'ceskatelevize', VLTAVA_OUT_DIR: '/data/vltava', VLTAVA_SEEDER_URL: 'http://vltava-seeder:3030/' };
  const config = await load(complete);
  assert.equal(config.vltava?.url, 'https://vltava.test');
  assert.deepEqual([config.vltava?.link, config.vltava?.seeder.url], ['hardlink', 'http://vltava-seeder:3030']);
  await assert.rejects(load({ VLTAVA_URL: 'https://vltava.test' }), /VLTAVA_URL and VLTAVA_TOKEN must be set together/);
  await assert.rejects(load({ ...complete, VLTAVA_PROVIDERS: '' }), /VLTAVA_PROVIDERS is required/);
  await assert.rejects(load({ ...complete, VLTAVA_PROVIDERS: 'ceskatelevize,netflix' }), /unknown providers: netflix/);
  await assert.rejects(load({ ...complete, VLTAVA_SEEDER_USERPASS: 'no-colon' }), /VLTAVA_SEEDER_USERPASS must be username:password/);
});

test('Sonarr and Radarr are configured only with both URL and API key, in a known category', async () => {
  const config = await load({ SONARR_URL: 'http://sonarr:8989/', SONARR_API_KEY: 's', RADARR_URL: '', RADARR_API_KEY: '', ARR_REMOVE_COMPLETED: 'false' });
  assert.deepEqual(config.arrs, [{ app: 'sonarr', url: 'http://sonarr:8989', apiKey: 's', category: 'tv', rootFolder: undefined, removeCompleted: false }]);
  await assert.rejects(load({ RADARR_URL: 'http://radarr:7878' }), /RADARR_URL and RADARR_API_KEY must be set together/);
  await assert.rejects(load({ SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: 's', SONARR_CATEGORY: 'series' }), /SONARR_CATEGORY/);
});
