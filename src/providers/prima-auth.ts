/**
 * Ports `PrimaAuthenticator.java`: Prima+ (the `www.iprima.cz` site) account login,
 * profile selection and login-session device identity, used to obtain the headers required
 * by the `vdm.frontend.*` RPC methods and the play-backend API for HD/DRM sources.
 *
 * Unlike the upstream desktop app, this port never falls back to a bundled default
 * account (`PrimaAuthenticator.Obf`) — Prima+ access is only attempted when the caller
 * supplies real `username`/`password` in the provider config.
 */
import { createHmac } from 'node:crypto';
import JSON5 from 'json5';
import type { ProviderConfig } from '../types.ts';
import { bracketSubstring, fetchText } from './common.ts';
import { base64url, get, Nuxt, PrimaAuthError, findByKey } from './prima-common.ts';
import { AccountSession, type SessionGrant, type SessionSource } from './account-session.ts';

const URL_SESSION_CREATE = 'https://ucet.iprima.cz/api/session/create';
const URL_PROFILE_PAGE = 'https://www.iprima.cz/profily';
const DEFAULT_DEVICE_NAME = 'Windows Chrome';
const REFERER = 'https://www.iprima.cz/';
const PROFILE_TOKEN_LIFETIME_MS = 45 * 60 * 1000;

/** A device-registering login, only needed while obtaining and resolving a profile. */
interface LoginSession {
  sessionId: string;
  accessToken: string;
  ssoToken: string;
}

interface Profile {
  id: string;
  name: string;
}

/** Everything `buildSessionHeaders` used to derive, kept for the life of the Account session. */
export interface PrimaAccountSession {
  sessionId: string;
  accessToken: string;
  deviceId: string;
  profileId: string;
  profileTokenSecret: string;
  profileSelectToken: string;
}

export interface PrimaSessionHeaders {
  [key: string]: string;
  Referer: string;
  'X-OTT-Access-Token': string;
  'X-OTT-CDN-Url-Type': string;
  'X-OTT-Device': string;
  'X-OTT-User-SubProfile': string;
  Cookie: string;
}

export class PrimaAuthenticator {
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly profileOverride: string | undefined;
  private readonly deviceIdOverride: string | undefined;
  private readonly now: () => number;
  private readonly session: AccountSession<PrimaAccountSession>;

  constructor(config: ProviderConfig, now: () => number = Date.now) {
    this.username = config.username;
    this.password = config.password;
    this.profileOverride = config.profile;
    this.deviceIdOverride = config.deviceId;
    this.now = now;

    const source: SessionSource<PrimaAccountSession> = {
      label: 'iprima',
      login: this.hasCredentials() ? (signal) => this.login(signal) : undefined,
      refresh: (session) => this.refresh(session),
    };
    this.session = new AccountSession(source, now);
  }

  hasCredentials(): boolean {
    return Boolean(this.username && this.password);
  }

  /** Runs `work` with a valid Prima+ Account session, sharing logins and retrying once on rejection. */
  async run<T>(work: (session: PrimaAccountSession, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (!this.hasCredentials()) {
      throw new PrimaAuthError('Prima+ requires providers.iprima.username/password to be configured');
    }
    return this.session.run(work, signal);
  }

  /** Builds the headers `vdm.frontend.*` and the play-backend API require, from a live session. */
  headers(session: PrimaAccountSession): PrimaSessionHeaders {
    return {
      Referer: REFERER,
      'X-OTT-Access-Token': session.accessToken,
      'X-OTT-CDN-Url-Type': 'WEB',
      'X-OTT-Device': session.deviceId,
      'X-OTT-User-SubProfile': session.profileId,
      Cookie: `prima_profile_select_token=${session.profileSelectToken}`,
    };
  }

  /** A full login plus profile resolution: one Account-session login registers one device. */
  private async login(signal: AbortSignal): Promise<SessionGrant<PrimaAccountSession>> {
    const login = await this.createLoginSession(signal);
    const html = await fetchText(URL_PROFILE_PAGE, signal, {
      headers: { Cookie: `prima_sso_token=${login.ssoToken}` },
    });
    const profile = this.resolveProfile(html);
    // Session creation already registers the web device. Never select another login
    // by its display name or call the retired user.device.slot.add endpoint.
    const deviceId = this.deviceIdOverride?.trim() || login.sessionId;
    const profileTokenSecret = this.profileTokenSecret(html);
    const { token, expiresAt } = this.signProfileSelectToken(profile.id, login.sessionId, profileTokenSecret);

    return {
      session: {
        sessionId: login.sessionId,
        accessToken: login.accessToken,
        deviceId,
        profileId: profile.id,
        profileTokenSecret,
        profileSelectToken: token,
      },
      expiresAt,
    };
  }

  /** Re-signs the profile-select token for the same login and profile; no new login or page fetch. */
  private async refresh(session: PrimaAccountSession): Promise<SessionGrant<PrimaAccountSession>> {
    const { token, expiresAt } = this.signProfileSelectToken(session.profileId, session.sessionId, session.profileTokenSecret);
    return { session: { ...session, profileSelectToken: token }, expiresAt };
  }

  private async createLoginSession(signal: AbortSignal): Promise<LoginSession> {
    const body = new URLSearchParams({
      deviceName: DEFAULT_DEVICE_NAME,
      email: this.username!,
      password: this.password!,
    }).toString();

    const response = await fetch(URL_SESSION_CREATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    });

    if (response.status !== 200) {
      throw new PrimaAuthError(`Incorrect iPrima account credentials (HTTP ${response.status})`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const sessionId = get<unknown>(json, 'sessionId', null);
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new PrimaAuthError('Prima+ login did not return a device session ID');
    const accessToken = get<unknown>(json, 'accessToken.value', null);
    if (typeof accessToken !== 'string' || !accessToken.trim()) throw new PrimaAuthError('Prima+ login did not return an access token');
    return {
      sessionId,
      accessToken,
      ssoToken: Buffer.from(JSON.stringify(json)).toString('base64'),
    };
  }

  private resolveProfile(html: string): Profile {
    const nuxt = Nuxt.extract(html);
    if (!nuxt) throw new PrimaAuthError('Unable to extract Prima+ profile information (Nuxt data missing)');

    const profilesNode = findByKey(nuxt.state(), 'profiles');
    const rawProfiles = Array.isArray(profilesNode) ? profilesNode : [];
    const profiles: Profile[] = rawProfiles.map((entry) => ({
      id: get(entry, 'ulid', ''),
      name: get(entry, 'name', ''),
    }));

    if (profiles.length === 0) throw new PrimaAuthError('No Prima+ profile found for this account');

    const wanted = this.profileOverride;
    if (!wanted || wanted.length === 0 || wanted.toLowerCase() === 'auto') return profiles[0]!;

    return profiles.find((p) => p.id.toLowerCase() === wanted.toLowerCase()) ?? profiles[0]!;
  }

  private profileTokenSecret(body: string): string {
    const marker = body.indexOf('__NUXT__.config');
    if (marker < 0) throw new PrimaAuthError('Unable to obtain Prima+ NUXT config (profileTokenSecret)');

    const braceStart = body.indexOf('{', marker);
    const objectText = bracketSubstring(body, braceStart);
    if (!objectText) throw new PrimaAuthError('Unable to read the Prima+ NUXT config');
    // The config is a JS object literal (unquoted keys, single-quoted strings), not strict JSON.
    const config = JSON5.parse<Record<string, unknown>>(objectText);
    const secret = get<string>(config, 'public.profileTokenSecret', '');
    if (!secret) throw new PrimaAuthError('Prima+ profileTokenSecret not found in NUXT config');
    return secret;
  }

  /** Ports `SessionData#profileSelectToken`: a self-signed HS256 JWT-like token. */
  private signProfileSelectToken(profileId: string, sessionId: string, secret: string): { token: string; expiresAt: number } {
    const expiresAt = this.now() + PROFILE_TOKEN_LIFETIME_MS;
    const header = base64url(JSON.stringify({ alg: 'HS256' }));
    const payload = base64url(JSON.stringify({ profileId, sessionId, exp: Math.floor(expiresAt / 1000) }));
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return { token: `${header}.${payload}.${signature}`, expiresAt };
  }
}
