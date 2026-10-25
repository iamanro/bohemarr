import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { CatalogueQuery, MediaSource, Program, Provider, ProviderConfig, Release } from '../types.ts';
import { AccountSession, SessionRejected } from './account-session.ts';
import { at, empty, fetchResponse, fetchText, releaseId } from './common.ts';

/**
 * Webshare.cz and Přehraj.to: file hosts searched by file name. Every search hit is one Program
 * with one Release; the season, episode, year, resolution and language come from the file name.
 * Both work anonymously (slow links); an account gives full speed.
 */

interface FileProgram extends Program {
  release: Release;
}

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Bohemarr';

/** Builds the Release of one hosted file from its name. */
export function fileRelease(provider: string, url: string, name: string, query: CatalogueQuery, size?: number): Release {
  const base = name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
    .trim();
  const episode = /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(base) ?? /\b(\d{1,2})x(\d{2,3})\b/.exec(base);
  const year = /\b(?:19|20)\d{2}\b/.exec(base)?.[0];
  const height = /\b(4k|uhd)\b/i.test(base) ? 2160 : /\b(\d{3,4})p\b/i.exec(base)?.[1];
  const language = /\b(cz|cze|czech|sk|slo)\b/i.exec(base)?.[1];
  const kind = query.kind ?? (episode ? 'tv' : 'movie');
  return {
    id: releaseId(provider, url),
    provider,
    url,
    kind,
    title: base,
    ...(kind === 'tv' &&
      episode && { series: base.slice(0, episode.index).trim() || base, season: Number(episode[1]), episode: Number(episode[2]) }),
    ...(year && { year: Number(year) }),
    ...(height && { height: Number(height) }),
    ...(language && { language }),
    ...(size && { size }),
  };
}

/** The upstream search term: file names carry `S01E02`, so an episode search asks for it. */
function searchTerm(query: CatalogueQuery): string {
  const episode =
    query.season !== undefined && query.episode !== undefined
      ? ` S${String(query.season).padStart(2, '0')}E${String(query.episode).padStart(2, '0')}`
      : '';
  // ponytail: files named "1x02" are missed by an episode search; add a second query if that matters.
  return `${query.q.trim()}${episode}`;
}

function fileCatalogue(search: (term: string, query: CatalogueQuery, signal: AbortSignal) => Promise<Release[]>): Provider['catalogue'] {
  return {
    async *programs(query, signal) {
      if (!query.q.trim()) return yield* empty();
      for (const release of await search(searchTerm(query), query, signal)) {
        yield { id: release.url, title: release.title, kind: release.kind, release } satisfies FileProgram;
      }
    },
    async *releases(program) {
      yield (program as FileProgram).release;
    },
  };
}

/** Optional account: with credentials, work runs in the Account session; without, anonymously. */
function createSession(
  id: string,
  config: ProviderConfig | undefined,
  login: (username: string, password: string, signal: AbortSignal) => Promise<string>,
): AccountSession<string> | undefined {
  const { username, password } = config ?? {};
  return username && password
    ? new AccountSession<string>({ label: id, login: signal => login(username, password, signal).then(session => ({ session })) })
    : undefined;
}

// --------------------------------------------------------------------------------------- Webshare

const WEBSHARE_API = 'https://webshare.cz/api';
const webshareXml = new XMLParser({ parseTagValue: false, isArray: name => name === 'file' || name === 'stream' });

async function webshareApi(method: string, body: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const text = await fetchText(`${WEBSHARE_API}/${method}/`, signal, {
    method: 'POST',
    body: new URLSearchParams(body),
    headers: { Accept: 'text/xml; charset=UTF-8', 'User-Agent': USER_AGENT },
  });
  const response = at<Record<string, unknown>>(webshareXml.parse(text), 'response') ?? {};
  if (response.status !== 'OK')
    throw new Error(`webshare: ${method} failed: ${String(response.code ?? response.status)} ${String(response.message ?? '')}`.trim());
  return response;
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const md5 = (...parts: (string | Uint8Array)[]): Buffer =>
  Buffer.from(parts.reduce((hash, part) => hash.update(part), createHash('md5')).digest());

/** The traditional Unix `$1$` MD5 password hash, which Webshare's login protocol expects. */
export function md5crypt(password: string, salt: string): string {
  salt = salt
    .replace(/^\$1\$/, '')
    .split('$', 1)[0]!
    .slice(0, 8);
  const alternate = md5(password, salt, password);
  const context = createHash('md5').update(`${password}$1$${salt}`);
  for (let left = password.length; left > 0; left -= 16) context.update(alternate.subarray(0, Math.min(16, left)));
  for (let i = password.length; i; i >>= 1) context.update(i & 1 ? '\0' : password[0]!);
  let final: Uint8Array = context.digest();
  for (let i = 0; i < 1000; i++) {
    final = md5(i & 1 ? password : final, i % 3 ? salt : '', i % 7 ? password : '', i & 1 ? final : password);
  }
  const to64 = (value: number, count: number): string =>
    Array.from({ length: count }, (_, i) => ITOA64[(value >> (6 * i)) & 0x3f]).join('');
  let out = '';
  for (const [a, b, c] of [
    [0, 6, 12],
    [1, 7, 13],
    [2, 8, 14],
    [3, 9, 15],
    [4, 10, 5],
  ] as const) {
    out += to64((final[a]! << 16) | (final[b]! << 8) | final[c]!, 4);
  }
  return `$1$${salt}$${out}${to64(final[11]!, 2)}`;
}

async function loginWebshare(username: string, password: string, signal: AbortSignal): Promise<string> {
  const salt = String((await webshareApi('salt', { username_or_email: username }, signal)).salt);
  const hashed = createHash('sha1').update(md5crypt(password, salt)).digest('hex');
  const digest = md5(`${username}:Webshare:${hashed}`).toString('hex');
  const token = (await webshareApi('login', { username_or_email: username, password: hashed, digest, keep_logged_in: '1' }, signal)).token;
  if (typeof token !== 'string' || !token) throw new Error('webshare: login returned no token');
  return token;
}

async function searchWebshare(term: string, query: CatalogueQuery, signal: AbortSignal): Promise<Release[]> {
  const response = await webshareApi('search', { what: term, category: 'video', limit: '100', offset: '0' }, signal);
  return (at<Record<string, string>[]>(response, 'file') ?? [])
    .filter(file => file.ident && file.name && file.password !== '1')
    .map(file => fileRelease('webshare', `https://webshare.cz/#/file/${file.ident}`, file.name!, query, Number(file.size) || undefined));
}

function createWebshareProvider(config: ProviderConfig | undefined): Provider {
  const session = createSession('webshare', config, loginWebshare);
  const fileLink = async (ident: string, wst: string | undefined, signal: AbortSignal): Promise<MediaSource[]> => {
    try {
      const response = await webshareApi(
        'file_link',
        { ident, download_type: 'video_stream', force_https: '1', ...(wst && { wst }) },
        signal,
      );
      // Free links refuse Range requests, which ffprobe needs; file_info's height and language let the inspection skip it.
      const info = await webshareApi('file_info', { ident, ...(wst && { wst }) }, signal).catch(() => ({}));
      const height = Number(at(info, 'height'));
      const language = at<string>(info, 'audio.stream.0.language') ?? at<string>(info, 'audio.stream.language');
      return [
        {
          url: String(response.link),
          type: 'file',
          headers: { 'User-Agent': USER_AGENT },
          ...(height > 0 && { height }),
          ...(language && { audioLanguage: language }),
        },
      ];
    } catch (error) {
      // Only a refused token earns a new login; a timeout or a missing file does not.
      if (wst && /WST|token|login/i.test((error as Error).message)) throw new SessionRejected((error as Error).message);
      throw error;
    }
  };
  return {
    id: 'webshare',
    name: 'Webshare',
    catalogue: fileCatalogue(searchWebshare),
    resolve(release, signal) {
      const ident = new URL(release.url).hash.split('/')[2];
      if (!ident) throw new Error(`webshare: no file ident in ${release.url}`);
      return session ? session.run((wst, signal) => fileLink(ident, wst, signal), signal) : fileLink(ident, undefined, signal);
    },
  };
}

// -------------------------------------------------------------------------------------- Přehraj.to

const PREHRAJTO = 'https://prehrajto.cz';
const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

export function parsePrehrajtoSearch(html: string, query: CatalogueQuery): Release[] {
  const $ = cheerio.load(html);
  return $('a.video--link')
    .toArray()
    .flatMap(element => {
      const href = $(element).attr('href');
      const name = $(element).attr('title') || $(element).find('.video__title').text().trim();
      if (!href || !name) return [];
      const size = /([\d.,]+)\s*([KMGT]?B)/i.exec($(element).find('.video__tag--size').text());
      const bytes = size
        ? Math.round(Number.parseFloat(size[1]!.replace(',', '.')) * (SIZE_UNITS[size[2]!.toUpperCase()] ?? 1))
        : undefined;
      return [{ ...fileRelease('prehrajto', new URL(href, PREHRAJTO).href, name, query, bytes), ...(bytes && { sizeEstimated: true }) }];
    });
}

/** The player's `sources = [{ file: "…", label: '720p' }, …]` literal on a video page. */
export function parsePrehrajtoSources(html: string): MediaSource[] {
  const start = html.indexOf('sources = [');
  const literal = start < 0 ? '' : html.slice(start, html.indexOf('];', start));
  return Array.from(literal.matchAll(/file:\s*"([^"]+)"\s*,\s*label:\s*'(\d+)?/g), match => ({
    url: match[1]!,
    type: 'file' as const,
    ...(match[2] && { height: Number(match[2]) }),
    headers: { 'User-Agent': USER_AGENT },
  }));
}

async function loginPrehrajto(username: string, password: string, signal: AbortSignal): Promise<string> {
  // ponytail: the Nette form's success is inferred from a redirect with cookies; unverified against a real account.
  const response = await fetchResponse(`${PREHRAJTO}/?frm=loginDialog-login-loginForm`, signal, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: username,
      password,
      remember_login: 'on',
      _submit: 'Přihlásit se',
      _do: 'loginDialog-login-loginForm-submit',
    }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map(value => value.split(';', 1)[0])
    .join('; ');
  await response.body?.cancel();
  if (response.status < 300 || response.status >= 400 || !cookie)
    throw new Error('prehrajto: incorrect credentials (login did not redirect with a session cookie)');
  return cookie;
}

function createPrehrajtoProvider(config: ProviderConfig | undefined): Provider {
  const session = createSession('prehrajto', config, loginPrehrajto);
  const page = (url: string, cookie: string | undefined, signal: AbortSignal): Promise<string> =>
    fetchText(url, signal, { headers: { 'User-Agent': USER_AGENT, ...(cookie && { Cookie: cookie }) } });
  const withSession = <T>(work: (cookie: string | undefined, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> =>
    session ? session.run(work, signal) : work(undefined, signal);
  return {
    id: 'prehrajto',
    name: 'Přehraj.to',
    catalogue: fileCatalogue((term, query, signal) =>
      withSession(
        async (cookie, signal) =>
          parsePrehrajtoSearch(await page(`${PREHRAJTO}/hledej/${encodeURIComponent(term)}`, cookie, signal), query),
        signal,
      ),
    ),
    resolve: (release, signal) =>
      withSession(async (cookie, signal) => {
        const sources = parsePrehrajtoSources(await page(release.url, cookie, signal));
        if (!sources.length) throw new Error(`prehrajto: no video sources on ${release.url}`);
        return sources;
      }, signal),
  };
}

export function createFileHostProviders(configs: Record<string, ProviderConfig>): Provider[] {
  const providers: Provider[] = [];
  if (configs['webshare']?.enabled !== false) providers.push(createWebshareProvider(configs['webshare']));
  if (configs['prehrajto']?.enabled !== false) providers.push(createPrehrajtoProvider(configs['prehrajto']));
  return providers;
}
