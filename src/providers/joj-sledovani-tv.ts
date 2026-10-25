/**
 * Ports `server.sledovanitv` (`API.java`, `Authenticator.java`, `SledovaniTV.java`) and
 * `drm_engine.sledovanitv` (`SledovaniTVDRMEngine.java`) into a single provider. Upstream
 * splits these into a "Server" (resolves `sledovanitv.cz` playback URLs to an HLS source) and
 * a separately-registered "DRMEngine" (builds the Widevine license request for that source);
 * this port's unified `resolve()` has both the freshly-authenticated session and the stream
 * URL in scope at once, so it attaches the license directly instead of round-tripping through
 * upstream's `Media.root(media).metadata().get("profileId"/"deviceId")` lookup (which, in the
 * upstream snapshot being ported, is never actually populated by `SledovaniTV.getMediaBuilders`
 * — a latent gap there). The session's real `profileId`/`deviceId` are used here instead.
 *
 * `server.sledovanitv` only resolves specific `sledovanitv.cz` playback URLs (record/event/
 * VOD-entry deep links); it has no catalog/search endpoint of its own, so its Catalogue lists
 * no Programs of its own (`programs()`/`releases()` are both empty). Static `config.catalog`
 * entries (whose `url` must be one of those deep links) are attached centrally as
 * `Provider.entries` and resolved through `resolve()` below.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { License, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { fetchResponse, fetchText, mediaType } from './common.ts';
import { AccountSession, SessionRejected, type SessionSource } from './account-session.ts';

const API_BASE = 'https://sledovanitv.cz/';
const USER_AGENT = 'okhttp/4.12.0';
const APP_LANG = 'cs';
const APP_VERSION = '2.81.147';
const APP_CAPABILITIES = 'vast,clientvast,webvtt,adaptive2';
const DEVICE_TYPE = 'androidportable';
const DEVICE_PRODUCT = 'Google:Pixel 8:shiba';
const DEVICE_SERIAL = '9f14d678c4ec4706';
const QUALITY = '40'; // MOBILE_WIFI_QUALITY_DEFAULT

const SLEDOVANITV_URI_RE =
  /^https?:\/\/sledovanitv\.(cz|sk)\/(?:home#(?:record(?:%3A|:)(?<recordId>\d+)|event(?:%3A|:)(?<eventId>[^%:]+(?:%3A|:).+))|vod\/play\?entryId=(?<entryId>\d+))$/;

interface Session {
  deviceId: string;
  profileId: string;
  sessionId: string;
}

type SledovaniAction = { kind: 'record' | 'event' | 'entry'; id: string };

function parseSledovaniUri(url: string): SledovaniAction | null {
  const match = SLEDOVANITV_URI_RE.exec(url);
  if (!match?.groups) return null;
  if (match.groups.recordId) return { kind: 'record', id: match.groups.recordId };
  if (match.groups.eventId) return { kind: 'event', id: decodeURIComponent(match.groups.eventId) };
  if (match.groups.entryId) return { kind: 'entry', id: match.groups.entryId };
  return null;
}

/** Ports `API#request`/`API#doRequest`: GET with the fixed `_nss` cookie plus `PHPSESSID`
 * when a session is active, redirects disabled, JSON-content-type enforced. */
async function apiRequest(
  path: string,
  query: Record<string, string>,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `${API_BASE}${path}?${new URLSearchParams(query).toString()}`;
  const cookies = ['_nss=1'];
  if (sessionId) cookies.push(`PHPSESSID=${sessionId}`);

  const response = await fetchResponse(url, signal, {
    headers: { 'User-Agent': USER_AGENT, Cookie: cookies.join('; ') },
    redirect: 'manual',
  });

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new Error(`sledovanitv: unexpected response from '${path}' (status ${response.status}, content-type '${contentType}')`);
  }

  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

/** Ports `API.Response#isSuccess`: HTTP 2xx and (missing or ===1) `status` field. */
function isSuccess(result: { status: number; data: Record<string, unknown> }): boolean {
  if (result.status < 200 || result.status >= 300) return false;
  const status = result.data.status;
  return status === undefined || status === 1;
}

/** Ports `API#error`: a `"not logged"` API error becomes a Session rejection that `resolve()`
 * retries once with a forced re-login, mirroring `SledovaniTV.getMedia`. */
function apiError(message: string, data: Record<string, unknown>): Error {
  const error = typeof data.error === 'string' ? data.error : 'Unknown error';
  if (error.toLowerCase() === 'not logged') return new SessionRejected(error);
  return new Error(message.includes('%s') ? message.replace('%s', error) : message);
}

async function createPairing(
  username: string,
  password: string,
  signal: AbortSignal,
): Promise<{ deviceId: string; pairingPassword: string }> {
  const result = await apiRequest(
    'api/create-pairing',
    {
      type: DEVICE_TYPE,
      product: DEVICE_PRODUCT,
      serial: DEVICE_SERIAL,
      username,
      password,
      lang: APP_LANG,
      unit: 'default',
      checkLimit: '1',
    },
    undefined,
    signal,
  );
  if (!isSuccess(result)) throw apiError('Failed to create device pairing: %s', result.data);
  const pairingPassword = result.data.password;
  if (typeof pairingPassword !== 'string') throw new Error('sledovanitv: pairing response missing password');
  return { deviceId: String(result.data.deviceId ?? 0), pairingPassword };
}

async function deviceLogin(deviceId: string, pairingPassword: string, signal: AbortSignal): Promise<Session> {
  const result = await apiRequest(
    'api/device-login',
    { deviceId, password: pairingPassword, version: APP_VERSION, lang: APP_LANG, unit: 'default', capabilities: APP_CAPABILITIES },
    undefined,
    signal,
  );
  if (!isSuccess(result)) throw apiError('Failed to login: %s', result.data);
  const sessionId = result.data.PHPSESSID;
  if (typeof sessionId !== 'string') throw new Error('sledovanitv: login response missing PHPSESSID');
  return { deviceId, profileId: String(result.data.activeProfileId ?? 0), sessionId };
}

async function recordMediaSource(session: Session, recordId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await apiRequest(
    'api/record-timeshift',
    {
      format: 'm3u8',
      radioFormat: 'm3u8',
      recordId,
      drm: 'widevine',
      capabilities: APP_CAPABILITIES,
      quality: QUALITY,
      PHPSESSID: session.sessionId,
    },
    session.sessionId,
    signal,
  );
  if (!isSuccess(result)) throw apiError('Failed to fetch media source data: %s', result.data);
  return result.data;
}

async function eventMediaSource(session: Session, eventId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await apiRequest(
    'api/event-timeshift',
    {
      format: 'm3u8',
      radioFormat: 'm3u8',
      eventId,
      drm: 'widevine',
      capabilities: APP_CAPABILITIES,
      quality: QUALITY,
      overrun: '1',
      PHPSESSID: session.sessionId,
    },
    session.sessionId,
    signal,
  );
  if (!isSuccess(result)) throw apiError('Failed to fetch media source data: %s', result.data);
  return result.data;
}

async function entryMediaSource(session: Session, eventId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await apiRequest(
    'vod-api/get-event-stream',
    { format: 'm3u8', eventId, drm: '1', capabilities: APP_CAPABILITIES, quality: QUALITY, PHPSESSID: session.sessionId },
    session.sessionId,
    signal,
  );
  if (!isSuccess(result)) throw apiError('Failed to fetch media source data: %s', result.data);
  return result.data;
}

async function entryData(session: Session, entryId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await apiRequest(
    'vod-api/get-entry',
    { entryId, detail: 'events', PHPSESSID: session.sessionId },
    session.sessionId,
    signal,
  );
  if (!isSuccess(result)) throw apiError('Failed to fetch entry data: %s', result.data);
  return result.data;
}

/** Ports `Authenticator.java`'s fast-path/full-login split, adapted to the headless contract:
 * a pre-paired session can be supplied via `config.deviceId`/`config.profile`/`config.cookies`
 * (mirroring the persisted `SledovaniTVCredentials` deviceId/profileId/sessionId fields); it is
 * reused until an authenticated call reports the session invalid, at which point a fresh
 * `createPairing`+`deviceLogin` cycle runs from `config.username`/`config.password`. Unlike the
 * desktop app there is no on-disk credential store to persist a freshly obtained session back
 * into, so re-login happens in-memory for the lifetime of this process. */
/** The device a login paired, kept in the service database so a restart reuses it instead of pairing another. */
class StoredSession {
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;

  constructor(db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS sledovanitv_session (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
    this.select = db.prepare('SELECT payload FROM sledovanitv_session WHERE id = 1');
    this.upsert = db.prepare('INSERT INTO sledovanitv_session VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  }

  read(): Session | undefined {
    const row = this.select.get();
    return row ? (JSON.parse(String(row.payload)) as Session) : undefined;
  }

  write(session: Session): void {
    this.upsert.run(JSON.stringify(session));
  }
}

function sledovaniSessionSource(config: ProviderConfig, stored: StoredSession | undefined): SessionSource<Session> {
  const username = typeof config.username === 'string' ? config.username : undefined;
  const password = typeof config.password === 'string' ? config.password : undefined;
  const deviceId = typeof config.deviceId === 'string' ? config.deviceId : undefined;
  const profileId = typeof config.profile === 'string' ? config.profile : undefined;
  const sessionId = typeof config.cookies === 'string' ? config.cookies : undefined;
  // A session configured by hand wins over the one a previous run paired.
  const seed = deviceId && profileId && sessionId ? { deviceId, profileId, sessionId } : stored?.read();
  return {
    label: 'sledovanitv',
    ...(seed ? { seed: { session: seed } } : {}),
    ...(username && password
      ? {
          async login(signal: AbortSignal) {
            const pairing = await createPairing(username, password, signal);
            const session = await deviceLogin(pairing.deviceId, pairing.pairingPassword, signal);
            stored?.write(session);
            return { session };
          },
        }
      : {}),
  };
}

function sledovaniHasCredentials(config: ProviderConfig): boolean {
  const deviceId = typeof config.deviceId === 'string' ? config.deviceId : undefined;
  const profileId = typeof config.profile === 'string' ? config.profile : undefined;
  const sessionId = typeof config.cookies === 'string' ? config.cookies : undefined;
  return Boolean((deviceId && profileId && sessionId) || (config.username && config.password));
}

const WIDEVINE_KEYFORMAT = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const DATA_BASE64_PREFIX = 'data:text/plain;base64,';

function parseAttributeList(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const value = m[2] !== undefined ? m[2] : m[3];
    if (value !== undefined) attrs[m[1] as string] = value;
  }
  return attrs;
}

/** Ports the Widevine branch of `M3U.M3UFile#mediaProtectionOf`: reads the base64 PSSH out of
 * an `#EXT-X-KEY` tag's `data:` URI. SledovaniTV always requests `format=m3u8`, so only HLS
 * needs handling (no DASH/MPD `ContentProtection` parsing here). */
async function extractWidevinePssh(manifestUrl: string, signal: AbortSignal): Promise<string[]> {
  let text: string;
  try {
    text = await fetchText(manifestUrl, signal);
  } catch {
    return [];
  }
  const pssh: string[] = [];
  const re = /#EXT-X-KEY:([^\r\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = parseAttributeList(m[1] as string);
    const uri = attrs.URI;
    if (attrs.KEYFORMAT === WIDEVINE_KEYFORMAT && uri?.startsWith(DATA_BASE64_PREFIX)) {
      pssh.push(uri.slice(DATA_BASE64_PREFIX.length));
    }
  }
  return pssh;
}

/** Ports `SledovaniTVDRMResolver#de(long[])`: a Fisher-Yates shuffle + per-byte rotation over
 * six packed `long` constants, decoding the Widevine proxy password baked into the Java
 * plugin. Uses `BigInt` to reproduce Java's 64-bit two's-complement `+`/`*`/`>>`/`>>>` exactly
 * (`wrap64`/`u64` below), since the LCG step (`s = (s*p+q) & t`) genuinely needs 64-bit
 * multiply overflow semantics. */
function wrap64(x: bigint): bigint {
  return BigInt.asIntN(64, x);
}
function u64(x: bigint): bigint {
  return BigInt.asUintN(64, x);
}

function deobfuscateLicensePassword(a: readonly bigint[]): string {
  const p = a[0] as bigint;
  const q = a[1] as bigint;
  const y = 0xffn;
  const z = wrap64(~y | y);
  const t = wrap64(u64(z) >> 32n);
  const c = Number(wrap64((a[a.length - 1] as bigint) & t) & 0xffffffffn);
  const b = new Uint8Array(c);

  for (let d = 0; d < c; d++) {
    const long = a[d >> 3] as bigint;
    const shift = BigInt(0x38 - ((d & 0x7) << 3));
    b[d] = Number(wrap64(u64(long) >> shift) & 0xffn);
  }

  const m = 0xff;
  const u = (b[16] as number) & m;
  const v = (b[17] as number) & m;
  const w = (b[18] as number) & m;
  const o = ~(1 << 5) & 0x37;
  const n = b.length - o;

  let e = 0n;
  for (const idx of [19, 20, 21, 22]) e = (e << 8n) | BigInt((b[idx] as number) & 0xff);
  e = wrap64(e);

  for (let i = 1; i < n; ++i) {
    let s = wrap64((e ^ BigInt(n)) & z);
    for (let k = n - 1; k >= i; --k) s = wrap64((s * p + q) & t);
    const j = Number(wrap64(u64(s) >> 1n) % BigInt(i + 1));
    const ixj = i ^ j;
    const fMask = (ixj | -ixj) >>> 31 ? 0xff : 0;
    const oi = o + i;
    const oj = o + j;
    const swap = ((b[oi] as number) ^ (b[oj] as number)) & fMask;
    b[oi] = (b[oi] as number) ^ swap;
    b[oj] = (b[oj] as number) ^ swap;
  }

  for (let i = 0; i < n; ++i) {
    const oi = o + i;
    let x = (((b[oi] as number) & m) - ((i ^ w) & m)) & m;
    const rot = (i + v) & 7;
    x = ((x >>> rot) | (x << (8 - rot))) & m;
    b[oi] = (x ^ ((u + i * 31) & m)) & 0xff;
  }

  return Buffer.from(b.slice(o, o + n)).toString('utf8');
}

const LICENSE_PASSWORD = deobfuscateLicensePassword([
  0x19660dn,
  0x3c6ef35fn,
  0x5c06bd1601abc49en,
  0xe27b269cb54276cfn,
  0x9b2a1bb63733ed6n,
  0x405d34000000002bn,
]);
const LICENSE_URL_BASE = 'https://drm.srv.czcloud.i.mtvreg.com/license/prod/widevine';

/** Ports `SledovaniTV.getMedia` (URI dispatch + one forced-reauth retry on `AuthenticationException`)
 * and `SledovaniTVDRMResolver#createRequest` (Widevine license URL). */
async function sledovaniResolve(account: AccountSession<Session>, release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const action = parseSledovaniUri(release.url);
  if (!action) throw new Error(`sledovanitv: unsupported release URL '${release.url}'`);

  const fetchStreamUrl = async (session: Session): Promise<string> => {
    if (action.kind === 'record') {
      const data = await recordMediaSource(session, action.id, signal);
      if (typeof data.url !== 'string') throw new Error('sledovanitv: record response missing stream URL');
      return data.url;
    }
    if (action.kind === 'event') {
      const data = await eventMediaSource(session, action.id, signal);
      if (typeof data.url !== 'string') throw new Error('sledovanitv: event response missing stream URL');
      return data.url;
    }
    const entry = await entryData(session, action.id, signal);
    const events = Array.isArray(entry.events) ? (entry.events as Array<{ id?: unknown }>) : [];
    const eventId = String(events[0]?.id ?? '0');
    if (events.length === 0 || eventId === '0') throw new Error('sledovanitv: no entry events');
    const data = await entryMediaSource(session, eventId, signal);
    const stream = data.stream as { url?: unknown } | undefined;
    if (typeof stream?.url !== 'string') throw new Error('sledovanitv: entry response missing stream URL');
    return stream.url;
  };

  let session!: Session;
  const streamUrl = await account.run(async activeSession => {
    session = activeSession;
    return fetchStreamUrl(activeSession);
  }, signal);

  const pssh = await extractWidevinePssh(streamUrl, signal);
  const streamUrlB64 = Buffer.from(streamUrl, 'utf8').toString('base64url');
  const license: License = {
    url: `${LICENSE_URL_BASE}?login=${session.profileId}&password=${LICENSE_PASSWORD}&device=${session.deviceId}&streamURL=${streamUrlB64}`,
    headers: { Referer: `https://${new URL(release.url).host}/` },
    ...(pssh.length > 0 ? { pssh } : {}),
  };

  return [{ url: streamUrl, type: mediaType(streamUrl), drm: license }];
}

/**
 * Creates the `sledovanitv` provider, or `null` when neither a reusable device session
 * (`config.deviceId`+`config.profile`+`config.cookies`) nor `config.username`/`config.password`
 * are configured — SledovaniTV requires an authenticated device for every stream/license
 * request, so per the shared contract the provider is omitted entirely without credentials.
 */
/** `database` keeps the paired device across restarts; without it (tests) the session lives in memory. */
export function createSledovaniTvProvider(config: ProviderConfig, database?: DatabaseSync): Provider | null {
  if (!sledovaniHasCredentials(config)) return null;
  const account = new AccountSession(sledovaniSessionSource(config, database && new StoredSession(database)));
  return {
    id: 'sledovanitv',
    name: 'SledovaniTV',
    catalogue: {
      async *programs() {},
      async *releases() {},
    },
    resolve: (release, signal) => sledovaniResolve(account, release, signal),
  };
}
