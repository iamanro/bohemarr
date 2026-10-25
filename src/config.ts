import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROVIDER_IDS } from './providers/ids.ts';
import type { ArrConfig, Config, ProviderConfig, VltavaConfig } from './types.ts';

/** Provider settings that hold a single string, set as `<PROVIDER>_<FIELD>`, e.g. `ONEPLAY_PROFILE_PIN`. */
const PROVIDER_FIELDS = [
  'username',
  'password',
  'profile',
  'profilePin',
  'accountId',
  'deviceId',
  'cookies',
  'client',
  'poToken',
  'visitorData',
  'playerId',
] as const;
/** Provider settings that are lists or objects, which only config.json can hold. */
const NESTED_PROVIDER_FIELDS = ['catalog', 'headers'];

/** Settings the web UI may store in `DATA_DIR/settings.json`; never paths or commands, which only the deployment sets. */
export const EDITABLE_SETTINGS: readonly string[] = [
  'PROVIDERS',
  'CATEGORIES',
  'CONCURRENCY',
  'REQUEST_RATE',
  'ARR_REMOVE_COMPLETED',
  'ARR_RENAME',
  'VLTAVA_TOKEN',
  ...['SONARR', 'RADARR'].flatMap(app => ['URL', 'API_KEY', 'CATEGORY', 'ROOT_FOLDER'].map(field => `${app}_${field}`)),
  ...PROVIDER_IDS.flatMap(id => PROVIDER_FIELDS.map(field => `${id.toUpperCase()}_${constantCase(field)}`)),
];
/** Values the UI shows only as set or unset. */
export const SECRET_SETTING = /PASSWORD|API_KEY|COOKIES|PIN|TOKEN/;

/** The settings saved from the web UI, used for every variable the environment leaves unset. */
let saved: Record<string, string> = {};

function settingsPath(dataDir: string): string {
  return resolve(dataDir, 'settings.json');
}

export async function readSettings(dataDir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(settingsPath(dataDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeSettings(dataDir: string, settings: Record<string, string>): Promise<void> {
  const file = settingsPath(dataDir);
  await writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/** Where a setting comes from: the environment (which the UI cannot override) or the UI's settings file. */
export function settingSource(name: string): 'env' | 'ui' | undefined {
  if (process.env[name] || process.env[`${name}_FILE`]) return 'env';
  return saved[name] ? 'ui' : undefined;
}

/** `profilePin` → `PROFILE_PIN`. */
function constantCase(name: string): string {
  return name.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase();
}

/**
 * A setting from the environment variable `name`, or from the file `name_FILE` names (e.g. a Docker
 * secret), without its trailing line break. An empty value counts as unset, as Compose passes unset
 * `.env` entries as empty strings.
 */
export function env(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file && process.env[name]) throw new Error(`Set either ${name} or ${name}_FILE, not both`);
  if (file) {
    try {
      return readFileSync(file, 'utf8').replace(/\r?\n$/, '') || undefined;
    } catch (error) {
      throw new Error(`${name}_FILE: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return process.env[name] || saved[name] || undefined;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  if (['true', '1'].includes(value)) return true;
  if (['false', '0'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Publishing to Vltava: enabled by VLTAVA_URL and VLTAVA_TOKEN, which need everything else the
 * publisher uses, so a half-configured publisher fails at startup instead of on the first import.
 */
function vltavaConfig(): VltavaConfig | undefined {
  const url = env('VLTAVA_URL')?.replace(/\/+$/, '');
  const token = env('VLTAVA_TOKEN');
  if (!url && !token) return undefined;
  if (!url || !token) throw new Error('VLTAVA_URL and VLTAVA_TOKEN must be set together');
  if (!/^https?:\/\//.test(url)) throw new Error('VLTAVA_URL must be an HTTP(S) URL');
  const required = (name: string): string => {
    const value = env(name);
    if (!value) throw new Error(`${name} is required when VLTAVA_URL is set`);
    return value;
  };
  const providers = list(required('VLTAVA_PROVIDERS'));
  const unknown = providers.filter(id => !(PROVIDER_IDS as readonly string[]).includes(id));
  if (unknown.length) throw new Error(`VLTAVA_PROVIDERS names unknown providers: ${unknown.join(', ')}`);
  const link = env('VLTAVA_LINK') ?? 'hardlink';
  if (!['hardlink', 'symlink', 'copy'].includes(link)) throw new Error('VLTAVA_LINK must be hardlink, symlink or copy');
  const group = env('VLTAVA_GROUP');
  if (group !== undefined && !/^[A-Za-z0-9]+$/.test(group)) throw new Error('VLTAVA_GROUP may contain only letters and digits');
  const seederUrl = required('VLTAVA_SEEDER_URL').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(seederUrl)) throw new Error('VLTAVA_SEEDER_URL must be an HTTP(S) URL');
  const userpass = env('VLTAVA_SEEDER_USERPASS');
  if (userpass !== undefined && !userpass.includes(':')) throw new Error('VLTAVA_SEEDER_USERPASS must be username:password');
  return {
    url,
    token,
    providers,
    outDir: resolve(required('VLTAVA_OUT_DIR')),
    link: link as VltavaConfig['link'],
    group,
    anonymous: boolean('VLTAVA_ANONYMOUS', false),
    cli: env('VLTAVA_CLI') ?? 'vltava',
    seeder: { url: seederUrl, userpass },
  };
}

function list(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * The nested provider settings of config.json. Every other setting is an environment variable; a
 * config.json that still holds one is rejected with the variable to use instead.
 */
async function readNestedProviders(file: string, required: boolean): Promise<Record<string, ProviderConfig>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return {};
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must be a JSON object`);
  const misplaced: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (key !== 'providers')
      misplaced.push(
        `${key} (use ${key === 'sonarr' || key === 'radarr' ? `${key.toUpperCase()}_*` : key === 'removeCompleted' ? 'ARR_REMOVE_COMPLETED' : constantCase(key)})`,
      );
  }
  const providers = (parsed as Record<string, unknown>).providers ?? {};
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error(`${file}: providers must be an object`);
  for (const [id, settings] of Object.entries(providers)) {
    if (!(PROVIDER_IDS as readonly string[]).includes(id))
      throw new Error(`${file}: unknown provider ${id}; known: ${PROVIDER_IDS.join(', ')}`);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${file}: providers.${id} must be an object`);
    for (const key of Object.keys(settings)) {
      if (NESTED_PROVIDER_FIELDS.includes(key)) continue;
      misplaced.push(`providers.${id}.${key} (use ${key === 'enabled' ? 'PROVIDERS' : `${id.toUpperCase()}_${constantCase(key)}`})`);
    }
  }
  if (misplaced.length) {
    throw new Error(
      `${file} holds only providers.<id>.${NESTED_PROVIDER_FIELDS.join(' and providers.<id>.')}; move these settings to environment variables: ${misplaced.join(', ')}`,
    );
  }
  return providers as Record<string, ProviderConfig>;
}

/** Loads the configuration; `settings` replaces the saved UI settings, e.g. to validate them before saving. */
export async function loadConfig(settings?: Record<string, string>): Promise<Config> {
  const dataDir = resolve(env('DATA_DIR') || './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const previous = saved;
  saved = Object.fromEntries(
    Object.entries(settings ?? (await readSettings(dataDir))).filter(([name]) => EDITABLE_SETTINGS.includes(name)),
  );
  try {
    return await readConfig(dataDir);
  } catch (error) {
    saved = previous;
    throw error;
  }
}

async function readConfig(dataDir: string): Promise<Config> {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = env(name);
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return result;
  };
  let apiKey = env('API_KEY') || '';
  if (!apiKey) {
    const keyFile = `${dataDir}/api-key`;
    try {
      apiKey = (await readFile(keyFile, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      apiKey = randomBytes(32).toString('hex');
      await writeFile(keyFile, `${apiKey}\n`, { mode: 0o600, flag: 'wx' });
    }
  }
  if (apiKey.length < 32) throw new Error('API_KEY must contain at least 32 characters');
  const port = integer('PORT', 8787, 1, 65535);
  const publicUrl = (env('PUBLIC_URL') || `http://localhost:${port}`).replace(/\/$/, '');
  const parsedUrl = new URL(publicUrl);
  if (
    !['http:', 'https:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    parsedUrl.pathname !== '/'
  ) {
    throw new Error('PUBLIC_URL must be an HTTP(S) origin without path, credentials, query or fragment');
  }
  const downloadsDir = resolve(env('DOWNLOADS_DIR') || './downloads');
  const categories = list(env('CATEGORIES') || 'tv,movies');
  if (!categories.length || categories.some(value => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error('CATEGORIES must contain safe, non-empty directory names');
  }
  const configFile = env('CONFIG_FILE');
  const providers = await readNestedProviders(configFile || `${dataDir}/config.json`, configFile !== undefined);
  // PROVIDERS lists exactly the enabled providers. Without it, each provider decides: public
  // providers are enabled, and account providers are enabled once their credentials are set.
  const enabled = env('PROVIDERS');
  if (enabled) {
    const ids = list(enabled);
    const unknown = ids.filter(id => !(PROVIDER_IDS as readonly string[]).includes(id));
    if (unknown.length) throw new Error(`PROVIDERS names unknown providers: ${unknown.join(', ')}; known: ${PROVIDER_IDS.join(', ')}`);
    for (const id of PROVIDER_IDS) providers[id] = { ...providers[id], enabled: ids.includes(id) };
  }
  for (const id of PROVIDER_IDS) {
    for (const field of PROVIDER_FIELDS) {
      const value = env(`${id.toUpperCase()}_${constantCase(field)}`);
      if (value) providers[id] = { ...providers[id], [field]: value };
    }
  }
  const removeCompleted = boolean('ARR_REMOVE_COMPLETED', true);
  const arrs = (['sonarr', 'radarr'] as const).flatMap((app): ArrConfig[] => {
    const prefix = app.toUpperCase();
    const url = env(`${prefix}_URL`)?.replace(/\/+$/, '');
    const key = env(`${prefix}_API_KEY`);
    if (!url && !key) return [];
    if (!url || !key) throw new Error(`${prefix}_URL and ${prefix}_API_KEY must be set together`);
    if (!/^https?:\/\//.test(url)) throw new Error(`${prefix}_URL must be an HTTP(S) URL`);
    const category = env(`${prefix}_CATEGORY`) ?? (app === 'sonarr' ? 'tv' : 'movies');
    if (!categories.includes(category)) throw new Error(`${prefix}_CATEGORY must be one of the categories: ${category}`);
    return [
      { app, url, apiKey: key, category, rootFolder: env(`${prefix}_ROOT_FOLDER`), removeCompleted, rename: boolean('ARR_RENAME', false) },
    ];
  });
  const vltava = vltavaConfig();
  await Promise.all(categories.map(category => mkdir(resolve(downloadsDir, category), { recursive: true })));
  return {
    host: env('HOST') || '127.0.0.1',
    port,
    apiKey,
    publicUrl,
    dataDir,
    downloadsDir,
    concurrency: integer('CONCURRENCY', 2, 1, 32),
    requestRate: integer('REQUEST_RATE', 10, 1, 100),
    ffmpeg: env('FFMPEG') || 'ffmpeg',
    ffprobe: env('FFPROBE') || 'ffprobe',
    mp4decrypt: env('MP4DECRYPT') || 'mp4decrypt',
    wvApiUrl: env('WV_API_URL') || 'https://wv.api.md.sune.app/v1/',
    categories,
    providers,
    arrs,
    vltava,
  };
}
