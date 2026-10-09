import type { CheerioAPI } from 'cheerio';
import type { Catalogue, CatalogueQuery, MediaKind, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { bracketSubstring, cached, each, fetchText, PROGRAM_LIST_TTL_MS, releaseId } from './common.ts';
import { absUrl, parseJsObject, fetchDocument, loadHtml, playerTracks, readInlineObject } from './nova-markiza-utils.ts';
import { tracksToSources } from './nova-markiza-media.ts';
import { AccountSession, SessionRejected, type SessionSource } from './account-session.ts';

/**
 * Ported from `MarkizaVoyoEngine` (`media_engine.markizavoyo`) and its
 * `Authenticator`/`VoyoAccount` auth flow. VOYO is a paid subscription
 * service: browsing the public catalog needs no credentials, but every
 * playback resolution requires an authenticated `votoken` session cookie.
 */

const API_BASE = 'https://voyo.markiza.sk/api/v1/';
const REFERER = 'https://voyo.markiza.sk/';
const LOGIN_URL = 'https://voyo.markiza.sk/prihlasenie';
const REDIRECT_URL = 'https://voyo.markiza.sk/moj-profil';
const AGE_RESTRICTION_URL = 'https://voyo.markiza.sk/obrazovky-prehravaca/rodicovska-kontrola-profil';
const DRM_REFERER = 'https://media.cms.markiza.sk/';
const ITEMS_PER_PAGE = 64;

const CATEGORIES: Array<{ categoryId: string; pageId: number; kind: MediaKind }> = [
  { categoryId: 'voyo-4', pageId: 17, kind: 'tv' },    // TV_SHOWS
  { categoryId: 'voyo-3', pageId: 16, kind: 'tv' },    // TV_SERIES
  { categoryId: 'voyo-5', pageId: 18, kind: 'movie' }, // MOVIES
  { categoryId: 'voyo-7', pageId: 20, kind: 'tv' },    // KIDS
];

/** The provider's stable program URL doubles as `Program.id`. */
interface VoyoProgram { id: string; uri: string; title: string; programId: string; kind: MediaKind }
interface VoyoSeason { id: string; number?: number }

// ---------------------------------------------------------------- Auth ----

function extractVotoken(cookies: string | undefined): string | undefined {
  if (!cookies) return undefined;
  const match = /votoken=([^;]+)/.exec(cookies);
  return match?.[1] ?? (cookies.includes('=') ? undefined : cookies.trim() || undefined);
}

async function loginVoyo(username: string, password: string, signal: AbortSignal): Promise<string> {
  const $ = await fetchDocument(LOGIN_URL, signal);
  const argDo = $('input[type="hidden"][name="_do"]').attr('value');
  if (!argDo) throw new Error('markizavoyo: login form token (_do) not found on login page');

  const body = new URLSearchParams({ email: username, password, login: 'Prihlásiť', _do: argDo });
  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: { Referer: LOGIN_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });

  const location = response.headers.get('location');
  const landedOnProfile = (response.status === 302 || response.status === 303) && !!location
    && new URL(location, LOGIN_URL).toString() === REDIRECT_URL;
  if (!landedOnProfile) throw new Error('markizavoyo: incorrect credentials (login did not redirect to profile)');

  const votoken = response.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c?.startsWith('votoken='));
  if (!votoken) throw new Error('markizavoyo: login succeeded but the server did not issue a votoken cookie');
  return votoken.slice('votoken='.length);
}

function voyoSessionSource(config: ProviderConfig): SessionSource<string> {
  const votoken = extractVotoken(config.cookies);
  const username = config.username;
  const password = config.password;
  return {
    label: 'markizavoyo',
    ...(votoken ? { seed: { session: votoken } } : {}),
    ...(username && password ? { login: (signal: AbortSignal) => loginVoyo(username, password, signal).then(session => ({ session })) } : {}),
  };
}

async function bypassAgeRestriction(token: string, signal: AbortSignal): Promise<boolean> {
  const body = new URLSearchParams({
    birth_day: '1', birth_month: '1', birth_year: '2000', save: 'Uložiť', _do: 'content232-userAgeForm-form-submit',
  });
  const response = await fetch(AGE_RESTRICTION_URL, {
    method: 'POST',
    headers: { Cookie: `votoken=${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  return response.status === 200;
}

interface VoyoError { success: boolean; event?: string; type?: string }

/** Ported from `checkForError`: VOYO renders an error page (body.error) with an embedded `klebetnica({...})` payload. */
function checkForError($: CheerioAPI): VoyoError {
  const bodyClass = $('body').first().attr('class') ?? '';
  if (!bodyClass.split(/\s+/).includes('error')) return { success: true };

  for (const el of $('script:not([src])').toArray()) {
    const content = $(el).html() ?? '';
    const idx = content.indexOf('klebetnica(');
    if (idx < 0) continue;
    const data = parseJsObject(bracketSubstring(content, idx)) as { event?: string; data?: { type?: string } } | null;
    return { success: false, event: data?.event, type: data?.data?.type };
  }

  return { success: false };
}

/** Ported from `API#getMedia`'s auth/retry/age-bypass loop around the embed document fetch. */
async function fetchEmbedDocument(embedUri: string, session: AccountSession<string>, signal: AbortSignal): Promise<CheerioAPI> {
  return session.run(async (token, signal) => {
    const $ = loadHtml(await fetchText(embedUri, signal, { headers: { Cookie: `votoken=${token}` } }));
    const error = checkForError($);
    if (error.success) return $;

    if (error.type === 'player_not_logged_in') throw new SessionRejected(`markizavoyo: playback denied (${error.type})`);
    // Logged in, but the subscription does not cover this title: the session itself is fine.
    if (error.type === 'player_logged_in_no_access') throw new Error(`markizavoyo: playback denied (${error.type})`);

    if (error.type === 'player_parental_profile_age_required') {
      if (await bypassAgeRestriction(token, signal)) {
        const retryDoc = loadHtml(await fetchText(embedUri, signal, { headers: { Cookie: `votoken=${token}` } }));
        if (checkForError(retryDoc).success) return retryDoc;
      }
      throw new Error(`markizavoyo: playback denied (${error.type})`);
    }

    throw new Error(`markizavoyo: playback error (${error.type ?? error.event ?? 'unknown'})`);
  }, signal);
}

// ------------------------------------------------------------ Catalog ----

async function apiRequest(action: string, args: Record<string, string | number>, signal: AbortSignal): Promise<string> {
  const url = new URL(action, API_BASE);
  for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  return fetchText(url, signal, { headers: { Referer: REFERER, 'X-Requested-With': 'XMLHttpRequest' } });
}

/** Ported from `parsePrograms`/`listPrograms`: one paginated `.row > .i` catalog page. */
async function listProgramsPage(
  category: (typeof CATEGORIES)[number], page: number, signal: AbortSignal,
): Promise<{ programs: VoyoProgram[]; hasMore: boolean }> {
  const html = await apiRequest('shows/genres', {
    category: category.categoryId, pageId: category.pageId, sort: 'title__asc', limit: ITEMS_PER_PAGE, page,
  }, signal);

  const $ = loadHtml(html);
  const programs: VoyoProgram[] = [];

  $('.row > .i').each((_, el) => {
    const $el = $(el);
    const $link = $el.find('.title > a').first();
    const uri = absUrl(API_BASE, $link.attr('href'));
    const title = $link.text().trim();
    const programId = ($el.find('.c-video-box').first().attr('data-resource') ?? '').replace(/^show\./, '');
    if (uri && title && programId) programs.push({ id: uri, uri, title, programId, kind: category.kind });
  });

  const nav = $('.c-pagination').first();
  if (nav.length === 0) return { programs, hasMore: false };
  const lastItem = nav.find('li:last-child > *').first();
  return { programs, hasMore: !lastItem.hasClass('-disabled') };
}

/** Lazily walks a category's program pages, so callers can stop once they have enough matches. */
async function* iterateCategoryPrograms(
  category: (typeof CATEGORIES)[number], signal: AbortSignal,
): AsyncGenerator<VoyoProgram> {
  for (let page = 1; ; page++) {
    const { programs, hasMore } = await listProgramsPage(category, page, signal);
    yield* programs;
    if (!hasMore) break;
  }
}

async function* iteratePrograms(
  categories: readonly (typeof CATEGORIES)[number][], signal: AbortSignal,
): AsyncGenerator<VoyoProgram> {
  for (const category of categories) yield* iterateCategoryPrograms(category, signal);
}

async function programDetail(program: VoyoProgram, signal: AbortSignal): Promise<CheerioAPI> {
  const raw = await apiRequest('page/detail-url', { 'layout_parts[]': '40-10', url: program.uri }, signal);
  const json = JSON.parse(raw) as { data?: { redirect?: { url?: string }; content?: Record<string, string> } };
  const redirectUrl = json.data?.redirect?.url;
  if (redirectUrl) return fetchDocument(redirectUrl, signal);
  return loadHtml(json.data?.content?.['40-10'] ?? '');
}

/** Ported from `getSeasons`. */
function programSeasons($: CheerioAPI): VoyoSeason[] {
  const seasons: VoyoSeason[] = [];

  for (const el of $('#episodesDropdown + .dropdown-menu .dropdown-item').toArray()) {
    const $el = $(el);
    const id = $el.attr('data-season-id');
    if (!id) continue;
    const textNode = $el.contents().toArray().find(node => node.type === 'text');
    const numberMatch = /\d+/.exec(textNode ? $(textNode).text() : $el.text());
    seasons.push({ id, number: numberMatch ? Number(numberMatch[0]) : undefined });
  }

  return seasons;
}

/**
 * Ported from `listEpisodes`/`parseEpisodes`: one season's `article` pages via `show/content`.
 * The upstream only orders pages ascending, and each page's own episode numbering depends on
 * every earlier page in the season, so a season must be walked oldest-page-first as before; the
 * buffered pages (almost always just one, since `ITEMS_PER_PAGE` covers most seasons whole) are
 * then emitted newest-page-first, each page's own items reversed to newest-first too.
 */
async function* listEpisodesInSeason(program: VoyoProgram, season: VoyoSeason, signal: AbortSignal): AsyncGenerator<Release> {
  const path = new URL(program.uri).pathname;
  const pages: Release[][] = [];

  for (let offset = 0; ; offset += ITEMS_PER_PAGE) {
    const html = await apiRequest('show/content', {
      showId: program.programId, type: 'episodes', season: season.id,
      orderDirection: 'asc', offset, count: ITEMS_PER_PAGE, url: path,
    }, signal);
    if (!html.trim()) break;

    const $ = loadHtml(html);
    const items = $('article').toArray();
    let counter = offset + 1;
    const pageReleases: Release[] = [];

    for (const el of items) {
      const $el = $(el);
      const $link = $el.find('.title > a').first();
      const uri = absUrl(program.uri, $link.attr('href'));
      if (!uri) continue;
      const numEpisode = counter++;
      let title = $link.text().trim();
      if (title.toLowerCase() === `${numEpisode}. díl`.toLowerCase()) title = '';

      pageReleases.push({
        id: releaseId('markizavoyo', uri), provider: 'markizavoyo', title, url: uri,
        kind: 'tv', series: program.title, season: season.number, episode: numEpisode,
        data: { programId: program.programId, seasonId: season.id },
      });
    }

    pages.push(pageReleases);
    if ($('.load-more').length === 0) break;
  }

  for (let i = pages.length - 1; i >= 0; i--) yield* pages[i]!.toReversed();
}

/**
 * Ported from `API#getEpisodes`: movie (single entry) vs. series (seasons/episodes), newest
 * first. `programSeasons` lists seasons in ascending (oldest-first) dropdown order, so the most
 * recent season is walked first; each season's episodes are newest-first in turn.
 */
async function* listEpisodesForProgram(program: VoyoProgram, signal: AbortSignal): AsyncGenerator<Release> {
  const detail = await programDetail(program, signal);

  if (detail('.listing').length === 0) {
    const uri = `${program.uri}#player-fullscreen`;
    const title = detail('h1.title').first().text().trim();
    yield {
      id: releaseId('markizavoyo', uri), provider: 'markizavoyo', title: title || program.title, url: uri,
      kind: 'movie', data: { programId: program.programId },
    };
    return;
  }

  const seasons = programSeasons(detail);
  for (let i = seasons.length - 1; i >= 0; i--) yield* listEpisodesInSeason(program, seasons[i]!, signal);
}

async function resolveMedia(release: Release, session: AccountSession<string>, signal: AbortSignal): Promise<MediaSource[]> {
  const $ = await fetchDocument(release.url, signal);
  const iframe = $('.js-detail-player .iframe-wrap iframe').first();
  if (iframe.length === 0) return [];

  const embedUri = absUrl(release.url, iframe.attr('src'));
  if (!embedUri) return [];

  const embedDoc = await fetchEmbedDocument(embedUri, session, signal);

  let settings: unknown = null;
  for (const el of embedDoc('script:not([src])').toArray()) {
    const result = readInlineObject(embedDoc(el).html() ?? '', 'player:');
    if (result) { settings = result; break; }
  }
  if (!settings) return [];

  return tracksToSources(playerTracks(settings), DRM_REFERER);
}

// ---------------------------------------------------------------- Provider

export function markizaVoyoCredentialsPresent(config: ProviderConfig): boolean {
  return !!(config.cookies && extractVotoken(config.cookies)) || !!(config.username && config.password);
}

export function createMarkizaVoyoProvider(config: ProviderConfig): Provider {
  const session = new AccountSession(voyoSessionSource(config));
  // A text search lists every program anyway, so it reuses one full listing for ten minutes.
  const allPrograms = cached(PROGRAM_LIST_TTL_MS, signal => Array.fromAsync(iteratePrograms(CATEGORIES, signal)));

  const catalogue: Catalogue<VoyoProgram> = {
    // A category's `kind` is fixed, so a requested kind skips whole categories upstream instead
    // of fetching every category page just to discard the wrong-kind programs afterwards.
    programs: (query: CatalogueQuery, signal: AbortSignal) => query.q.trim()
      ? each(allPrograms(signal))
      : iteratePrograms(query.kind ? CATEGORIES.filter(c => c.kind === query.kind) : CATEGORIES, signal),
    releases: (program: VoyoProgram, _query: CatalogueQuery, signal: AbortSignal) => listEpisodesForProgram(program, signal),
  };

  return {
    id: 'markizavoyo',
    name: 'VOYO',
    catalogue,
    async resolve(release: Release, signal: AbortSignal): Promise<MediaSource[]> {
      return resolveMedia(release, session, signal);
    },
  } satisfies Provider;
}
