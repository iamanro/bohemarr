import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { searchCatalogue } from './catalogue.ts';
import type { Provider, Release, SearchQuery } from './types.ts';

/** Looks up deployment-maintained TMDB movie bindings without requiring a TMDB API key. */
export class MovieBindings {
  private readonly selectProgram?: StatementSync;

  constructor(database: DatabaseSync) {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalogue_tmdb_mappings'").get();
    if (exists) {
      this.selectProgram = database.prepare(
        "SELECT source_id FROM catalogue_tmdb_mappings WHERE provider=? AND source_kind='movie' AND tmdb_kind='movie' AND tmdb_id=? AND status='matched' LIMIT 1",
      );
    }
  }

  /** Search the verified source Program for a Radarr TMDB movie ID, falling back to title search when unbound. */
  async search(provider: Provider, query: SearchQuery, tmdbId: number, signal: AbortSignal): Promise<Release[]> {
    const row = this.selectProgram?.get(provider.id, tmdbId);
    if (!row) return searchCatalogue(provider, query, signal);
    const programId = String(row.source_id);
    const entry = provider.entries?.find(release => release.kind === 'movie' && (release.programId ?? release.id) === programId);
    if (entry) return [entry];
    const releases = await searchCatalogue(provider, { ...query, q: '', programId }, signal);
    return releases.filter(release => release.kind === 'movie' && release.programId === programId);
  }
}
