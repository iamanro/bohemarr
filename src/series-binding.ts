import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { searchCatalogue } from './catalogue.ts';
import { loadSeriesIdentity, selectProgram, type SelectionFailure } from './series-identity.ts';
import type { Provider, Release, SearchQuery, SeriesBinding, SeriesIdentity } from './types.ts';

/** Why a provider returns no Releases for a Series identity. */
export type UnboundReason = SelectionFailure | 'program-already-bound' | 'identity-already-bound';

export interface BindingSearch {
  releases: Release[];
  /** Set when the provider is metadata-backed but no Program of it is bound to the identity. */
  unbound?: UnboundReason;
}

export type IdentityLookup = (tvdbId: number, signal: AbortSignal) => Promise<SeriesIdentity>;

/** A stored Release's freshness expires at or after this age; six hours matches the Prima programme index. */
const SERIES_RELEASE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Series bindings: which Program of each metadata-backed provider is the series a TVDB identity
 * names. A binding is stored only when exactly one Program's own year/country metadata agrees,
 * and once stored it is never reassigned in either direction. Every Release this module returns
 * for a bound Program carries the canonical title and `tvdbId`; nothing else ever does.
 *
 * A bound Program's exact episode expansion (season, episode, no `airDate`) is additionally
 * cached for up to six hours per (provider, Program, identity, season, episode, offset, limit),
 * so a repeated exact episode search need not call the provider's catalogue again. Only Releases
 * an actual successful expansion returned are ever stored; misses, empty results and aborted or
 * failed expansions never populate or refresh the cache.
 */
export class SeriesBindings {
  private readonly lookupIdentity: IdentityLookup;
  /** Injectable wall clock, so tests can move time without waiting on it. */
  private readonly now: () => number;
  private readonly selectIdentityByTvdbId: StatementSync;
  private readonly insertBinding: StatementSync;
  private readonly selectBindingByIdentity: StatementSync;
  private readonly selectBindingByProgram: StatementSync;
  private readonly selectEpisodeCache: StatementSync;
  private readonly upsertEpisodeCache: StatementSync;

  constructor(db: DatabaseSync, lookupIdentity: IdentityLookup = loadSeriesIdentity, now: () => number = Date.now) {
    this.lookupIdentity = lookupIdentity;
    this.now = now;
    // Table and column names predate the Series binding vocabulary; existing databases keep them.
    // The UPDATE converts payloads stored before `source` became `program` (a no-op afterwards).
    db.exec(`CREATE TABLE IF NOT EXISTS series_mappings (
        provider TEXT NOT NULL, source_id TEXT NOT NULL, tvdb_id INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(provider, source_id), UNIQUE(provider, tvdb_id)
      );
      UPDATE series_mappings SET payload = json_remove(json_set(payload, '$.program', payload -> '$.source'), '$.source')
        WHERE json_type(payload, '$.source') IS NOT NULL;`);
    if (!db.prepare('PRAGMA table_info(series_mappings)').all().some(column => column.name === 'tmdb_id')) {
      db.exec('ALTER TABLE series_mappings ADD COLUMN tmdb_id INTEGER');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS series_mappings_tmdb ON series_mappings(tmdb_id);
      UPDATE series_mappings SET tmdb_id = json_extract(payload, '$.identity.tmdbId')
        WHERE tmdb_id IS NULL AND json_type(payload, '$.identity.tmdbId') = 'integer';`);
    this.selectIdentityByTvdbId = db.prepare('SELECT payload FROM series_mappings WHERE tvdb_id=? LIMIT 1');
    this.insertBinding = db.prepare('INSERT INTO series_mappings (provider, source_id, tvdb_id, payload, tmdb_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
    this.selectBindingByIdentity = db.prepare('SELECT payload FROM series_mappings WHERE provider=? AND tvdb_id=?');
    this.selectBindingByProgram = db.prepare('SELECT payload FROM series_mappings WHERE provider=? AND source_id=?');
    db.exec(`CREATE TABLE IF NOT EXISTS series_release_cache (
        provider TEXT NOT NULL, program_id TEXT NOT NULL, tvdb_id INTEGER NOT NULL,
        season INTEGER NOT NULL, episode INTEGER NOT NULL, offset INTEGER NOT NULL, limit_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(provider, program_id, tvdb_id, season, episode, offset, limit_count)
      );`);
    this.selectEpisodeCache = db.prepare(
      'SELECT created_at, payload FROM series_release_cache WHERE provider=? AND program_id=? AND tvdb_id=? AND season=? AND episode=? AND offset=? AND limit_count=?');
    this.upsertEpisodeCache = db.prepare(`INSERT INTO series_release_cache
        (provider, program_id, tvdb_id, season, episode, offset, limit_count, created_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, program_id, tvdb_id, season, episode, offset, limit_count)
        DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload`);
  }

  /** The Series identity for `tvdbId`: from any stored binding, else from TVDB metadata. */
  async identity(tvdbId: number, signal: AbortSignal): Promise<SeriesIdentity> {
    const row = this.selectIdentityByTvdbId.get(tvdbId);
    const identity = row ? parse(row.payload).identity : await this.lookupIdentity(tvdbId, signal);
    if (identity.tvdbId !== tvdbId) throw new Error('TVDB identity mismatch');
    return identity;
  }

  /**
   * One page of `provider`'s Releases for `query`.
   *
   * With an `identity` and a metadata-backed provider: binds a Program if none is bound yet, then
   * expands only the bound Program; unbound means no Releases. Otherwise: a plain catalogue
   * search (by the identity's title when given), where Releases of already-bound Programs are
   * stamped, and Releases stamped with a different identity are dropped.
   */
  async search(provider: Provider, query: SearchQuery, identity: SeriesIdentity | undefined, signal: AbortSignal): Promise<BindingSearch> {
    if (identity && provider.seriesCandidates) {
      const existing = this.byIdentity(provider.id, identity.tvdbId);
      if (!existing) signal.throwIfAborted(); // about to create a new binding: never bind past an abort
      const binding = existing ?? await this.bind(provider, identity, signal);
      if (typeof binding === 'string') return { releases: [], unbound: binding };
      const programId = binding.program.id;
      const exactEpisode = query.kind === 'tv' && typeof query.season === 'number' && Number.isInteger(query.season)
        && typeof query.episode === 'number' && Number.isInteger(query.episode) && query.airDate === undefined
        ? { season: query.season, episode: query.episode } : undefined;
      if (exactEpisode) {
        const cached = this.cachedEpisode(provider.id, programId, identity.tvdbId, exactEpisode.season, exactEpisode.episode, query.offset, query.limit);
        if (cached) {
          signal.throwIfAborted(); // never hand back a cached response past an abort
          return { releases: cached };
        }
      }
      const releases = (await searchCatalogue(provider, { ...query, q: '', programId }, signal))
        .filter(release => release.kind === 'tv' && release.programId === programId
          && (release.tvdbId === undefined || release.tvdbId === identity.tvdbId)).map(release => stamp(release, binding.identity));
      if (exactEpisode && releases.length > 0) {
        // The catalogue promise can resolve after the caller aborted; never write a cache snapshot past that point.
        signal.throwIfAborted();
        this.cacheEpisode(provider.id, programId, identity.tvdbId, exactEpisode.season, exactEpisode.episode, query.offset, query.limit, releases);
      }
      return { releases };
    }

    const releases = (await searchCatalogue(provider, identity ? { ...query, q: identity.title } : query, signal)).map(release => {
      const binding = release.kind === 'tv' && release.programId ? this.byProgram(provider.id, release.programId) : undefined;
      return binding ? stamp(release, binding.identity) : release;
    });
    return { releases: identity ? releases.filter(release => release.tvdbId === undefined || release.tvdbId === identity.tvdbId) : releases };
  }

  /**
   * The newest TV Releases of `identity` on `provider`, as `search` finds them, except that a
   * metadata-backed provider without a stored binding contributes nothing: only a TVDB search binds.
   */
  async recent(provider: Provider, identity: SeriesIdentity, limit: number, signal: AbortSignal): Promise<Release[]> {
    if (provider.seriesCandidates && !this.byIdentity(provider.id, identity.tvdbId)) return [];
    return (await this.search(provider, { q: '', kind: 'tv', limit, offset: 0 }, identity, signal)).releases;
  }

  private async bind(provider: Provider, identity: SeriesIdentity, signal: AbortSignal): Promise<SeriesBinding | UnboundReason> {
    const selection = selectProgram(identity, await provider.seriesCandidates!(identity, signal));
    if ('reason' in selection) return selection.reason;
    const binding: SeriesBinding = { provider: provider.id, program: selection.program, identity };
    this.insertBinding.run(provider.id, binding.program.id, identity.tvdbId, JSON.stringify(binding), identity.tmdbId ?? null);
    // The constraints refuse either reassignment; the stored row tells which one happened.
    const stored = this.byIdentity(provider.id, identity.tvdbId);
    if (stored?.program.id === binding.program.id) return stored;
    return stored ? 'identity-already-bound' : 'program-already-bound';
  }

  private byIdentity(provider: string, tvdbId: number): SeriesBinding | undefined {
    const row = this.selectBindingByIdentity.get(provider, tvdbId);
    return row ? parse(row.payload) : undefined;
  }

  private byProgram(provider: string, programId: string): SeriesBinding | undefined {
    const row = this.selectBindingByProgram.get(provider, programId);
    return row ? parse(row.payload) : undefined;
  }

  /** A fresh cached exact episode expansion, or `undefined` on a miss or an expired entry. */
  private cachedEpisode(
    provider: string, programId: string, tvdbId: number, season: number, episode: number, offset: number, limit: number,
  ): Release[] | undefined {
    const row = this.selectEpisodeCache.get(provider, programId, tvdbId, season, episode, offset, limit);
    if (!row || this.now() - Number(row.created_at) >= SERIES_RELEASE_CACHE_TTL_MS) return undefined;
    return JSON.parse(String(row.payload)) as Release[];
  }

  /** Stores a successful, non-empty exact episode expansion; called only after `searchCatalogue` resolves. */
  private cacheEpisode(
    provider: string, programId: string, tvdbId: number, season: number, episode: number, offset: number, limit: number, releases: Release[],
  ): void {
    this.upsertEpisodeCache.run(provider, programId, tvdbId, season, episode, offset, limit, this.now(), JSON.stringify(releases));
  }
}

function parse(payload: unknown): SeriesBinding {
  return JSON.parse(String(payload)) as SeriesBinding;
}

function stamp(release: Release, identity: SeriesIdentity): Release {
  return { ...release, series: identity.title, tvdbId: identity.tvdbId };
}
