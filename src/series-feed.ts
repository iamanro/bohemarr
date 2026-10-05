import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SeriesBindings } from './series-binding.ts';
import type { Provider, Release, SeriesIdentity } from './types.ts';

/** Newest Releases listed per Watched series and provider, so a few missed syncs are still covered. */
const RELEASES_PER_SERIES = 5;
/** Below Sonarr's 15-minute default RSS interval: each sync gets a fresh listing, and its page requests share it. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
/** Below the server's 120-second Torznab deadline, so a slow listing fails visibly instead of being cut off. */
const BUILD_TIMEOUT_MS = 110_000;

/**
 * The RSS feed Sonarr's RSS sync reads: the newest Releases of every Watched series, newest first.
 *
 * A Series identity becomes watched the first time Sonarr searches it by TVDB ID and stays watched,
 * so a series returning after a long break is still noticed. The feed never creates a Series
 * binding: metadata-backed providers contribute only an already bound Program, other providers a
 * title search, exactly as a TVDB search would.
 *
 * A Release's `publishedAt` is the moment the feed first listed it, persisted so it never moves:
 * providers publish no reliable release dates, and Sonarr pages RSS until it reaches a date it
 * has already seen. One listing is shared for ten minutes; a failed listing is never cached.
 */
export class SeriesFeed {
  private readonly db: DatabaseSync;
  private readonly bindings: SeriesBindings;
  private readonly providers: Map<string, Provider>;
  private readonly now: () => number;
  private readonly upsertWatched: StatementSync;
  private readonly selectWatched: StatementSync;
  private readonly insertFirstSeen: StatementSync;
  private readonly selectFirstSeen: StatementSync;
  private snapshot?: { at: number; releases: Release[] };
  private building?: Promise<Release[]>;

  /** `bindings` must already have created its tables; series searched before this table existed become watched. */
  constructor(db: DatabaseSync, bindings: SeriesBindings, providers: Map<string, Provider>, now: () => number = Date.now) {
    this.db = db;
    this.bindings = bindings;
    this.providers = providers;
    this.now = now;
    const created = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='series_watch'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS series_watch (tvdb_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS release_first_seen (release_id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL);`);
    if (created) {
      // Exact episode cache entries exist only for bound series Sonarr has already searched by TVDB ID.
      db.exec(`INSERT OR IGNORE INTO series_watch (tvdb_id, payload)
        SELECT tvdb_id, payload -> '$.identity' FROM series_mappings
        WHERE tvdb_id IN (SELECT tvdb_id FROM series_release_cache) ORDER BY provider`);
    }
    this.upsertWatched = db.prepare('INSERT INTO series_watch VALUES (?, ?) ON CONFLICT(tvdb_id) DO UPDATE SET payload=excluded.payload');
    this.selectWatched = db.prepare('SELECT payload FROM series_watch ORDER BY tvdb_id');
    this.insertFirstSeen = db.prepare('INSERT OR IGNORE INTO release_first_seen VALUES (?, ?)');
    this.selectFirstSeen = db.prepare('SELECT first_seen_at FROM release_first_seen WHERE release_id=?');
  }

  /** Marks a Series identity Sonarr searched by TVDB ID as watched, refreshing its stored identity. */
  watch(identity: SeriesIdentity): void {
    this.upsertWatched.run(identity.tvdbId, JSON.stringify(identity));
  }

  /** The current listing, newest first; empty when nothing is watched or no watched series has Releases. */
  async releases(signal: AbortSignal): Promise<Release[]> {
    signal.throwIfAborted();
    if (this.snapshot && this.now() - this.snapshot.at < SNAPSHOT_TTL_MS) return this.snapshot.releases;
    // The build outlives an impatient client, so its successor can use the finished listing.
    this.building ??= this.build(AbortSignal.timeout(BUILD_TIMEOUT_MS))
      .then(releases => {
        this.snapshot = { at: this.now(), releases };
        return releases;
      })
      .finally(() => { this.building = undefined; });
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([this.building, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async build(signal: AbortSignal): Promise<Release[]> {
    const identities = this.selectWatched.all().map(row => JSON.parse(String(row.payload)) as SeriesIdentity);
    const providers = [...this.providers.values()];
    const listed = new Map<string, { release: Release; rank: number }>();
    const errors: unknown[] = [];
    // Series are listed one at a time to avoid bursts at the providers' CDNs.
    for (const identity of identities) {
      const results = await Promise.allSettled(providers.map(provider => this.bindings.recent(provider, identity, RELEASES_PER_SERIES, signal)));
      signal.throwIfAborted();
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          errors.push(result.reason);
          console.error(`RSS feed: ${providers[index]!.id} failed for TVDB ${identity.tvdbId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          return;
        }
        result.value.forEach((release, rank) => { if (!listed.has(release.id)) listed.set(release.id, { release, rank }); });
      });
    }
    if (errors.length && errors.length === identities.length * providers.length) {
      throw new AggregateError(errors, 'Every RSS feed listing failed');
    }
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of listed.keys()) this.insertFirstSeen.run(id, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return [...listed.values()]
      .map(({ release, rank }) => ({ release, rank, firstSeen: Number(this.selectFirstSeen.get(release.id)!.first_seen_at) }))
      // Releases first listed together keep their provider's newest-first order.
      .sort((a, b) => b.firstSeen - a.firstSeen || a.rank - b.rank || a.release.id.localeCompare(b.release.id))
      .map(({ release, firstSeen }) => ({ ...release, publishedAt: new Date(firstSeen).toISOString() }));
  }
}
