import type { MediaSource } from '../types.ts';
import { fetchResponse, mediaType } from './common.ts';

const URL_LOGIN = 'https://www.barrandov.tv/form/form-prihlaseni.php';
const URL_REFERER = 'https://www.barrandov.tv/prihlaseni.php';
const URL_REDIRECT = 'https://www.barrandov.tv/';

/** Returns the authenticated session cookie; a successful login redirects to the home page. */
export async function authenticateBarrandov(username: string, password: string, signal: AbortSignal): Promise<string | undefined> {
  const body = new URLSearchParams({ presmerovani: URL_REDIRECT, login: username, heslo: password, prihlasit: '' });
  const response = await fetchResponse(URL_LOGIN, signal, {
    method: 'POST',
    headers: { Referer: URL_REFERER, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  const cookieHeader = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
  const succeeded = response.status >= 300 && response.status < 400 && response.headers.get('location') === URL_REDIRECT;
  await response.body?.cancel();
  return succeeded && cookieHeader ? cookieHeader : undefined;
}

/** Parses the local (non-embedded) Barrandov video sources. */
export function parseBarrandovLocalSources(sourceElements: { src: string; res: string; type: string }[]): MediaSource[] {
  return sourceElements.map(el => ({
    url: el.src,
    type: el.type.includes('dash') ? 'dash' : el.type.includes('mpegurl') ? 'hls' : mediaType(el.src),
    height: el.res ? Number.parseInt(el.res, 10) : undefined,
  }));
}

export async function fetchBarrandovDocument(url: string, cookie: string | undefined, signal: AbortSignal): Promise<{ finalUrl: string; body: string }> {
  const response = await fetchResponse(url, signal, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return { finalUrl: response.url, body: await response.text() };
}
