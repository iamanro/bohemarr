/**
 * Ports `media_engine.jojplay` (`JOJPlayEngine.java`): JOJ Play's Firebase Auth login
 * (`Authenticator`) and its Firestore-backed catalog/media resolution (`API`).
 *
 * Transport note: the upstream Java engine talks to Firestore through a reverse-engineered
 * copy of the internal `Listen` long-polling "channel" wire protocol (SPDY-style framing,
 * `gsessionid`/`SID`/`AID` bookkeeping) because, per its own comment, it "does not have a
 * valid OAuth2 token to access the REST API". That is no longer a real constraint: the
 * Firebase ID token obtained from `identitytoolkit/v3/relyingparty/verifyPassword` (the same
 * token the Java code feeds into the channel handshake) is accepted directly as a `Bearer`
 * credential by the documented Firestore REST v1 `:runQuery`/`:batchGet`/document-GET
 * endpoints (https://firebase.google.com/docs/firestore/use-rest-api). This module issues the
 * exact same `StructuredQuery` filters/orderings/limits as the Java `StructuredQuery.Builder`
 * calls, only over the supported REST transport instead of the undocumented channel framing.
 */
import type { CatalogueQuery, MediaSource, Program, Provider, Release } from '../types.ts';
import { cached, each, fetchJson, mediaType, PROGRAM_LIST_TTL_MS, releaseId } from './common.ts';
import { AccountSession, SessionRejected, type SessionSource } from './account-session.ts';

const APP_KEY = 'AIzaSyB02udgMkNLADkLJ_w5YNBMR2VR1WHfusI';
const TENANT_ID = 'XEpbY0V54AE34rFO7dB2-i9m04';

const PROJECT_ID = 'tivio-production';
const DATABASE = `projects/${PROJECT_ID}/databases/(default)`;
const DOCUMENTS_ROOT = `${DATABASE}/documents`;
const ORGANIZATION_ID = 'dEpbY0V54AE34rFO7dB2';
const REF_ORGANIZATION = `${DOCUMENTS_ROOT}/organizations/${ORGANIZATION_ID}`;
const TAG_MOVIE = `${REF_ORGANIZATION}/tags/ATpCZv0eXYImMvftr7x0`;

const URI_LOGIN = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${APP_KEY}`;
const URI_SOURCES = 'https://europe-west3-tivio-production.cloudfunctions.net/getSourceUrl';
const FIRESTORE_QUERY_URL = `https://firestore.googleapis.com/v1/${DOCUMENTS_ROOT}:runQuery`;
const RESOLVE_LANGUAGES = ['sk', 'cs', 'en'];

const PLAYER_PATH_RE = /^\/player\/([^/]+)$/;
const EPISODE_TITLE_RE = /^(\d+)\.?\s*(?:epizóda)?\s*/iu;

// ---------------------------------------------------------------------------------------
// Firestore REST value/document shapes (https://cloud.google.com/firestore/docs/reference/rest/v1/Value)
// ---------------------------------------------------------------------------------------

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  referenceValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

interface FirestoreDocument {
  name: string;
  fields?: Record<string, FirestoreValue>;
}

type FirestoreFilter =
  | { fieldFilter: { field: { fieldPath: string }; op: string; value: FirestoreValue } }
  | { compositeFilter: { op: 'AND'; filters: FirestoreFilter[] } };

interface StructuredQuery {
  from: Array<{ collectionId: string }>;
  where?: FirestoreFilter;
  orderBy?: Array<{ field: { fieldPath: string }; direction: 'ASCENDING' | 'DESCENDING' }>;
  limit?: number;
}

const sv = (value: string): FirestoreValue => ({ stringValue: value });
const rv = (ref: string): FirestoreValue => ({ referenceValue: ref });

/** Builds a single `fieldFilter` (EQUAL / ARRAY_CONTAINS / ARRAY_CONTAINS_ANY, ...), mirroring
 * the various `StructuredQuery.Where.Field*` subclasses used across the Java query builders. */
function filterOp(field: string, op: string, value: FirestoreValue): FirestoreFilter {
  return { fieldFilter: { field: { fieldPath: field }, op, value } };
}
function and(...filters: FirestoreFilter[]): FirestoreFilter {
  return { compositeFilter: { op: 'AND', filters } };
}
const byName = { field: { fieldPath: '__name__' }, direction: 'ASCENDING' as const };

/** Ports `API.resolveFieldValue`: unwraps a plain string field or a translated-map field,
 * preferring sk/cs/en in that order, falling back to the first available translation. */
function resolveFieldValue(field: FirestoreValue | undefined): string | null {
  if (!field) return null;
  if (typeof field.stringValue === 'string') return field.stringValue;
  const fields = field.mapValue?.fields;
  if (!fields) return null;
  for (const lang of RESOLVE_LANGUAGES) {
    const value = fields[lang]?.stringValue;
    if (typeof value === 'string') return value;
  }
  for (const key of Object.keys(fields)) {
    const value = fields[key]?.stringValue;
    if (typeof value === 'string') return value;
  }
  return null;
}

function docSlug(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

async function runQuery(query: StructuredQuery, idToken: string, signal: AbortSignal): Promise<FirestoreDocument[]> {
  const rows = await fetchJson<Array<{ document?: FirestoreDocument }>>(FIRESTORE_QUERY_URL, signal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ structuredQuery: query }),
  });
  const docs: FirestoreDocument[] = [];
  for (const row of Array.isArray(rows) ? rows : []) if (row.document) docs.push(row.document);
  return docs;
}

async function getDocument(ref: string, idToken: string, signal: AbortSignal): Promise<FirestoreDocument | null> {
  try {
    return await fetchJson<FirestoreDocument>(`https://firestore.googleapis.com/v1/${ref}`, signal, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch (err) {
    if (err instanceof Error && /^HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

/** Ports `API.tvShows`. */
async function queryTvShows(idToken: string, signal: AbortSignal): Promise<FirestoreDocument[]> {
  return runQuery(
    {
      from: [{ collectionId: 'contents' }],
      where: and(
        filterOp('organizationRef', 'EQUAL', rv(REF_ORGANIZATION)),
        filterOp('publishedStatus', 'EQUAL', sv('PUBLISHED')),
        filterOp('type', 'EQUAL', sv('SERIES')),
      ),
      orderBy: [byName],
    },
    idToken,
    signal,
  );
}

/** Ports `API.movies`, including the client-side episode-like/contentType filtering that
 * the Java mapper performs after the Firestore query (season/episode fields present, or a
 * `contentType` other than `FILM`, are excluded). */
async function queryMovies(idToken: string, signal: AbortSignal): Promise<FirestoreDocument[]> {
  const docs = await runQuery(
    {
      from: [{ collectionId: 'videos' }],
      where: and(
        filterOp('tags', 'ARRAY_CONTAINS', rv(TAG_MOVIE)),
        filterOp('publishedStatus', 'EQUAL', sv('PUBLISHED')),
        filterOp('transcodingStatus', 'EQUAL', sv('ENCODING_DONE')),
        filterOp('processingStatus', 'EQUAL', sv('DONE')),
      ),
      orderBy: [byName],
    },
    idToken,
    signal,
  );
  return docs.filter((doc) => {
    const fields = doc.fields ?? {};
    if (fields.seasonNumber || fields.episodeNumber) return false;
    return (fields.contentType?.stringValue ?? 'FILM') === 'FILM';
  });
}

/** Ports `API.seasonEpisodes`, ordered by `episodeNumber` DESCENDING (rather than upstream's
 * ASCENDING + client-side reverse) so a season's episodes come back newest-first directly,
 * matching the Catalogue contract without buffering the whole page before yielding. */
async function querySeasonEpisodes(
  tagSeriesRef: string,
  seasonNumber: number,
  idToken: string,
  signal: AbortSignal,
): Promise<FirestoreDocument[]> {
  return runQuery(
    {
      from: [{ collectionId: 'videos' }],
      where: and(
        filterOp('tags', 'ARRAY_CONTAINS_ANY', { arrayValue: { values: [rv(tagSeriesRef)] } }),
        filterOp('publishedStatus', 'EQUAL', sv('PUBLISHED')),
        filterOp('transcodingStatus', 'EQUAL', sv('ENCODING_DONE')),
        filterOp('seasonNumber', 'EQUAL', { integerValue: String(seasonNumber) }),
      ),
      orderBy: [{ field: { fieldPath: 'episodeNumber' }, direction: 'DESCENDING' }, byName],
    },
    idToken,
    signal,
  );
}

/** Ports `API.documentOfSlug`. */
async function queryDocumentOfSlug(slug: string, idToken: string, signal: AbortSignal): Promise<FirestoreDocument | null> {
  const docs = await runQuery(
    {
      from: [{ collectionId: 'videos' }],
      where: filterOp('urlName.sk', 'ARRAY_CONTAINS', sv(slug)),
      orderBy: [byName],
      limit: 2,
    },
    idToken,
    signal,
  );
  return docs[0] ?? null;
}

/** Ports `API.seasons`: reads the `AVAILABLE_SEASONS` entry out of a series document's
 * `metadata` array and returns the season numbers in the order Firestore returned them. */
function extractSeasons(doc: FirestoreDocument): number[] {
  const metadata = doc.fields?.metadata?.arrayValue?.values ?? [];
  const seasons: number[] = [];
  for (const item of metadata) {
    if (item.mapValue?.fields?.type?.stringValue !== 'AVAILABLE_SEASONS') continue;
    const values = item.mapValue?.fields?.value?.arrayValue?.values ?? [];
    for (const season of values) {
      const raw = season.mapValue?.fields?.seasonNumber?.integerValue;
      if (raw !== undefined) seasons.push(Number(raw));
    }
  }
  return seasons;
}

function stripEpisodeTitlePrefix(title: string, numEpisode: number): string {
  const match = EPISODE_TITLE_RE.exec(title);
  if (match?.[1] !== undefined && Number(match[1]) === numEpisode) return title.slice(match[0].length);
  return title;
}

function playerUrl(slug: string): string {
  return `https://play.joj.sk/player/${slug}`;
}

function movieToRelease(doc: FirestoreDocument): Release | null {
  const title = resolveFieldValue(doc.fields?.name)?.trim();
  if (!title) return null;
  const url = playerUrl(docSlug(doc.name));
  return { id: releaseId('jojplay', url), provider: 'jojplay', title, url, kind: 'movie' };
}

function episodeToRelease(seriesTitle: string, seasonNumber: number, doc: FirestoreDocument): Release | null {
  const rawTitle = resolveFieldValue(doc.fields?.name)?.trim();
  if (!rawTitle) return null;
  const numEpisode = Number(doc.fields?.episodeNumber?.integerValue ?? '0');
  const title = stripEpisodeTitlePrefix(rawTitle, numEpisode);
  const url = playerUrl(docSlug(doc.name));
  return {
    id: releaseId('jojplay', url),
    provider: 'jojplay',
    title,
    series: seriesTitle,
    season: seasonNumber,
    episode: numEpisode,
    kind: 'tv',
    url,
  };
}

function sourceUrlRequestBody(videoId: string): string {
  return JSON.stringify({
    data: {
      id: videoId,
      documentType: 'video',
      capabilities: [
        { codec: 'h264', protocol: 'dash', encryption: 'none' },
        { codec: 'h264', protocol: 'hls', encryption: 'none' },
      ],
    },
  });
}

/** Builds the Account session source that performs the Firebase Auth login. */
function jojSessionSource(username: string, password: string): SessionSource<string> {
  return {
    label: 'jojplay',
    async login(signal) {
      const body = JSON.stringify({ tenantId: TENANT_ID, email: username, password, returnSecureToken: true });
      const json = await fetchJson<{ idToken?: string; expiresIn?: string; error?: { message?: string } }>(URI_LOGIN, signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://play.joj.sk/' },
        body,
      });
      if (!json.idToken) {
        throw new Error(`jojplay: login failed${json.error?.message ? ` (${json.error.message})` : ''}`);
      }
      const expiresIn = Number(json.expiresIn);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('jojplay: login returned an invalid token lifetime');
      return { session: json.idToken, expiresAt: Date.now() + expiresIn * 1000 };
    },
  };
}

/** One `getSourceUrl` cloud-function call; `null` means it demands a logged-in user and none
 * was attached yet, while a bearer-attached request answering the same way is a session rejection. */
async function requestSourceUrl(videoId: string, idToken: string | undefined, signal: AbortSignal): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Referer: 'https://play.joj.sk/' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;

  const response = await fetch(URI_SOURCES, {
    method: 'POST',
    headers,
    body: sourceUrlRequestBody(videoId),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(URI_SOURCES).hostname}`);

  const json = (await response.json()) as { error?: { message?: string; status?: string }; result?: { url?: string } };
  if (json.error) {
    if (json.error.message === 'User is not logged in') {
      if (idToken) throw new SessionRejected(`jojplay: ${json.error.status ?? json.error.message ?? 'source error'}`);
      return null;
    }
    throw new Error(`jojplay: ${json.error.status ?? json.error.message ?? 'source error'}`);
  }
  if (json.result?.url) return json.result.url;
  throw new Error('jojplay: no source URL returned');
}

/** Ports the `getSourceUrl` cloud-function call loop in `API.getMedia`: request without
 * auth first, and only obtain (and attach) an Account session once the function reports the
 * video requires a logged-in user. */
async function fetchSourceUrl(videoId: string, session: AccountSession<string>, signal: AbortSignal): Promise<string> {
  const anon = await requestSourceUrl(videoId, undefined, signal);
  if (anon !== null) return anon;
  return session.run(async (idToken, signal) => {
    const url = await requestSourceUrl(videoId, idToken, signal);
    if (url === null) throw new Error('jojplay: no source URL returned');
    return url;
  }, signal);
}

/** A JOJ Play Program: either a movie (its single `Release` built straight from the `videos`
 * document) or a series (its episode lists fetched season-by-season, newest season first, as
 * `releases()` is consumed). `id` is the Firestore document slug of the movie/series document,
 * which is stable across requests; JOJ Play never binds Programs via `programId`, so no
 * further identity constraint applies. */
type JojProgram =
  | (Program & { kind: 'movie'; doc: FirestoreDocument })
  | (Program & { kind: 'tv'; tagSeriesRef: string; seasons: number[] });

async function* jojMoviePrograms(idToken: string, signal: AbortSignal): AsyncGenerator<JojProgram> {
  for (const doc of await queryMovies(idToken, signal)) {
    const title = resolveFieldValue(doc.fields?.name)?.trim();
    if (!title) continue;
    yield { id: docSlug(doc.name), title, kind: 'movie', doc };
  }
}

async function* jojSeriesPrograms(idToken: string, signal: AbortSignal): AsyncGenerator<JojProgram> {
  for (const seriesDoc of await queryTvShows(idToken, signal)) {
    const title = resolveFieldValue(seriesDoc.fields?.name)?.trim();
    if (!title) continue;
    const tagSeriesRef = seriesDoc.fields?.originalSeriesTagRef?.referenceValue;
    if (!tagSeriesRef) continue;
    // Newest season first; `extractSeasons` reads Firestore's stored (ascending) order.
    const seasons = extractSeasons(seriesDoc).toReversed();
    yield { id: docSlug(seriesDoc.name), title, kind: 'tv', tagSeriesRef, seasons };
  }
}

/** Ports `API.getPrograms`: movies then series, in that order, each kind's Firestore query
 * skipped entirely when `query.kind` already rules it out. */
async function* jojPrograms(session: AccountSession<string>, query: CatalogueQuery, signal: AbortSignal): AsyncGenerator<JojProgram> {
  const idToken = await session.run(async token => token, signal);
  if (!query.kind || query.kind === 'movie') yield* jojMoviePrograms(idToken, signal);
  if (!query.kind || query.kind === 'tv') yield* jojSeriesPrograms(idToken, signal);
}

/** Ports `API.getEpisodes`: a movie Program yields its single Release; a series Program yields
 * its seasons newest-first (narrowed to `query.season` when given), each season's episodes
 * already newest-first from `querySeasonEpisodes`'s Firestore ordering. */
async function* jojReleases(session: AccountSession<string>, program: JojProgram, query: CatalogueQuery, signal: AbortSignal): AsyncGenerator<Release> {
  if (program.kind === 'movie') {
    const release = movieToRelease(program.doc);
    if (release) yield release;
    return;
  }
  const idToken = await session.run(async token => token, signal);
  const seasons = query.season === undefined ? program.seasons : program.seasons.filter((season) => season === query.season);
  for (const season of seasons) {
    for (const doc of await querySeasonEpisodes(program.tagSeriesRef, season, idToken, signal)) {
      const release = episodeToRelease(program.title, season, doc);
      if (release) yield release;
    }
  }
}

/** Ports `API.getMedia`: resolves a `/player/{slug}` release URL back to a Firestore video
 * document (by `urlName.sk`, falling back to treating the slug as a raw video ID), then
 * requests a playable source URL from the `getSourceUrl` cloud function. JOJ Play always
 * requests `encryption: "none"` capabilities, so no DRM is attached (matches upstream). */
async function jojResolve(session: AccountSession<string>, release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const path = new URL(release.url).pathname;
  const match = PLAYER_PATH_RE.exec(path);
  const slug = match?.[1];
  if (!slug) throw new Error(`jojplay: unsupported release URL '${release.url}'`);

  const idToken = await session.run(async token => token, signal);
  let document = await queryDocumentOfSlug(slug, idToken, signal);
  if (!document) document = await getDocument(`${DOCUMENTS_ROOT}/videos/${slug}`, idToken, signal);
  if (!document) throw new Error(`jojplay: unable to obtain media information for '${release.url}'`);

  const videoId = docSlug(document.name);
  const sourceUrl = await fetchSourceUrl(videoId, session, signal);
  return [{ url: sourceUrl, type: mediaType(sourceUrl) }];
}

/**
 * Creates the `jojplay` provider. JOJ Play requires an account for every catalog/playback
 * request (the Java engine calls `Authenticator.idToken()`, which triggers a login, before
 * even listing programs), so per the shared contract this provider is only returned when
 * `config.username`/`config.password` are both present.
 */
export function createJojPlayProvider(username: string, password: string): Provider {
  const session = new AccountSession(jojSessionSource(username, password));
  // A text search lists every program anyway, so it reuses one full listing for ten minutes.
  const allPrograms = cached(PROGRAM_LIST_TTL_MS, signal => Array.fromAsync(jojPrograms(session, { q: '' }, signal)));
  return {
    id: 'jojplay',
    name: 'JOJ Play',
    catalogue: {
      programs: (query, signal) => query.q.trim() ? each(allPrograms(signal)) : jojPrograms(session, query, signal),
      releases: (program, query, signal) => jojReleases(session, program as JojProgram, query, signal),
    },
    resolve: (release, signal) => jojResolve(session, release, signal),
  };
}
