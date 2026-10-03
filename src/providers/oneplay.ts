import type {
  Catalogue, CatalogueQuery, MediaSource, Program, Provider, ProviderConfig, Release, SeriesIdentity, ProgramMetadata,
} from '../types.ts';
import { releaseId } from './common.ts';
import { isSeriesCandidate } from '../series-identity.ts';
import { type OneplayCredentials, OneplaySession } from './oneplay-auth.ts';
import {
  fetchAllPrograms,
  fetchEpisodesForProgram,
  fetchSeriesMetadata,
  resolveMediaSources,
  type OneplayEpisode,
  type OneplayProgram,
  type ProgramEpisodes,
} from './oneplay-catalog.ts';
import { OneplayConnectionPool } from './oneplay-pool.ts';
import { CONNECTION_POOL_CAPACITY, webDevice } from './oneplay-protocol.ts';

const PROVIDER_ID = 'oneplay';
const PROVIDER_NAME = 'Oneplay';

/** A catalogue Program: the upstream carousel tile, identified by its page URI. A bound Program
 * carries the listing its lookup already fetched, so expanding it needs no second request. */
type OneplayCatalogueProgram = OneplayProgram & Program & { listing?: ProgramEpisodes };

function readConfigString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toProgramRelease(program: OneplayProgram): Release {
  return {
    id: releaseId(PROVIDER_ID, program.uri),
    provider: PROVIDER_ID,
    title: program.title,
    url: program.uri,
    kind: program.kind,
  };
}

function toEpisodeRelease(program: OneplayProgram, episode: OneplayEpisode): Release {
  return {
    id: releaseId(PROVIDER_ID, episode.uri),
    provider: PROVIDER_ID,
    title: episode.title || program.title,
    url: episode.uri,
    kind: 'tv',
    series: program.title,
    programId: program.uri,
    season: episode.season,
    episode: episode.episodeNumber,
  };
}

/**
 * `Oneplay.getPrograms` has no free-text search endpoint upstream: the CMS only exposes one
 * browsable "oneplay" catalogue carousel (title-asc), so `q` is ignored and `searchCatalogue`
 * applies the title pre-filter itself once every Program below has been listed.
 */
async function* catalogueProgramsOf(pool: OneplayConnectionPool, signal: AbortSignal): AsyncGenerator<OneplayCatalogueProgram> {
  for (const program of await fetchAllPrograms(pool, signal)) yield { ...program, id: program.uri };
}

/**
 * `Oneplay.StrategyBase.getEpisodes`: a program page is never itself a Release, even when it
 * turns out to hold a single movie, so every Program (TV or movie) is expanded through here.
 *
 * `fetchEpisodesForProgram` lists every season, ordered newest episode first by season and
 * episode number.
 */
async function* catalogueReleasesOf(
  pool: OneplayConnectionPool,
  session: OneplaySession,
  program: OneplayCatalogueProgram,
  signal: AbortSignal,
): AsyncGenerator<Release> {
  let result = program.listing;
  if (!result) {
    await session.ensureAuthenticated(true, signal);
    result = await fetchEpisodesForProgram(pool, program.uri, signal);
  }
  if (result.kind === 'movie') {
    yield { ...toProgramRelease(program), title: result.title || program.title, kind: 'movie' };
    return;
  }
  for (const episode of result.items) yield toEpisodeRelease(program, episode);
}

/**
 * A verified program identity replaces catalogue title guessing entirely: the bound page URI is
 * looked up directly, so a localized/ambiguous display title can never reselect another program.
 * `undefined` signals the bound identity is no longer a series (its page now holds a movie).
 */
async function lookupBoundProgram(
  pool: OneplayConnectionPool,
  session: OneplaySession,
  id: string,
  signal: AbortSignal,
): Promise<OneplayCatalogueProgram | undefined> {
  await session.ensureAuthenticated(true, signal);
  const result = await fetchEpisodesForProgram(pool, id, signal);
  if (result.kind === 'movie') return undefined;
  return { id, uri: id, title: result.title, kind: 'tv', listing: result };
}

function createOneplayCatalogue(pool: OneplayConnectionPool, session: OneplaySession): Catalogue<OneplayCatalogueProgram> {
  return {
    programs: (_query: CatalogueQuery, signal: AbortSignal) => catalogueProgramsOf(pool, signal),
    program: (id, signal) => lookupBoundProgram(pool, session, id, signal),
    releases: (program, _query: CatalogueQuery, signal: AbortSignal) => catalogueReleasesOf(pool, session, program, signal),
  };
}

/**
 * Offers every catalogue program whose title is name-plausible for the requested identity, each
 * carrying its own upstream country/year metadata. Plausibility only widens the candidate set;
 * the Series binding module decides from that metadata.
 */
async function seriesCandidates(
  pool: OneplayConnectionPool,
  session: OneplaySession,
  identity: SeriesIdentity,
  signal: AbortSignal,
): Promise<ProgramMetadata[]> {
  const programs = (await fetchAllPrograms(pool, signal))
    .filter(program => program.kind === 'tv' && isSeriesCandidate(program.title, identity));
  if (!programs.length) return [];

  await session.ensureAuthenticated(true, signal);
  const candidates: ProgramMetadata[] = [];
  for (const program of programs) {
    signal.throwIfAborted();
    const metadata = await fetchSeriesMetadata(pool, program, signal);
    if (metadata) candidates.push(metadata);
  }
  return candidates;
}

/** `Oneplay.StrategyBase.getMedia`: playback always requires the full (profile-selected) auth level. */
async function resolve(
  pool: OneplayConnectionPool,
  session: OneplaySession,
  release: Release,
  signal: AbortSignal,
): Promise<MediaSource[]> {
  await session.ensureAuthenticated(true, signal);
  return resolveMediaSources(pool, release.url, signal);
}

/**
 * Ported from `sune.app.mediadown.media_engine.novavoyo` (`Oneplay`, `Authenticator`, `Connection`,
 * `ConnectionPool`, `Device`, `Context`, `WS`) and `sune.app.mediadown.drm_engine.novavoyo`
 * (`OneplayDRMEngine`), collapsed into a single headless `Provider`.
 *
 * Browsing the catalogue works unauthenticated upstream, but listing episodes and resolving
 * playback both require a logged-in, profile-selected session, so this factory only enables the
 * provider when `username`/`password` credentials are configured — otherwise it can never fulfil
 * its actual contract (episodes/resolve would always fail with a login error).
 *
 * There is no equivalent of the upstream `CredentialsManager` on-disk cache here: every process
 * lifetime performs its own fresh login the first time authentication is required, then reuses
 * that in-memory session (see `OneplaySession`) for the remainder of the process.
 */
export function createOneplayProviders(configs: Record<string, ProviderConfig>): Provider[] {
  const config = configs[PROVIDER_ID];
  if (!config || config.enabled === false) return [];

  const email = readConfigString(config.username);
  const password = readConfigString(config.password);
  if (!email || !password) return [];

  const credentials: OneplayCredentials = {
    email,
    password,
    accountId: readConfigString(config.accountId),
    profileId: readConfigString(config.profile),
    profilePin: readConfigString(config.profilePin),
  };

  const pool = new OneplayConnectionPool(CONNECTION_POOL_CAPACITY, webDevice());
  const session = new OneplaySession(pool, credentials, credentials.accountId ?? null);

  const provider: Provider = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    catalogue: createOneplayCatalogue(pool, session),
    seriesCandidates: (identity, signal) => seriesCandidates(pool, session, identity, signal),
    resolve: (release, signal) => resolve(pool, session, release, signal),
    close: () => pool.close(),
  };

  return [provider];
}
