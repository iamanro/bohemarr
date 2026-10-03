import { createHmac, timingSafeEqual } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { Store } from './store.ts';
import { releaseTitle, normalizeLanguage, sanitizeFilename } from './providers/common.ts';
import { inspectMediaSources } from './media/metadata.ts';
import { MovieBindings } from './movie-binding.ts';
import type { BindingSearch, SeriesBindings } from './series-binding.ts';
import { SeriesFeed } from './series-feed.ts';
import type { Config, Provider, Release, SearchQuery } from './types.ts';

// Every result resolves playback metadata; clients can request subsequent pages with offset.
const MAX_PAGE_SIZE = 5;
const FEED_INSPECTION_TTL_MS = 6 * 60 * 60 * 1000;

export function xml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}

/** The Newznab interface: translates Newznab queries to provider searches and Releases to RSS items and Task descriptors. */
export class Indexer {
  private readonly config: Config;
  private readonly store: Store;
  private readonly providers: Map<string, Provider>;
  private readonly bindings: SeriesBindings;
  private readonly movieBindings: MovieBindings;
  private readonly feed: SeriesFeed;
  private readonly feedInspections = new Map<string, { at: number; metadata: Pick<Release, 'height' | 'size' | 'sizeEstimated' | 'language'> }>();

  constructor(config: Config, store: Store, providers: Map<string, Provider>, bindings: SeriesBindings) {
    this.config = config;
    this.store = store;
    this.providers = providers;
    this.bindings = bindings;
    this.movieBindings = new MovieBindings(store.database);
    this.feed = new SeriesFeed(store.database, bindings, providers);
  }

  capabilities(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><caps><server version="1.0" title="Bohemarr"/>
      <limits max="${MAX_PAGE_SIZE}" default="${MAX_PAGE_SIZE}"/><registration available="no" open="no"/>
      <searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep,tvdbid"/><movie-search available="yes" supportedParams="q,tmdbid"/></searching>
      <categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>`;
  }

  async search(params: Record<string, string>, signal: AbortSignal): Promise<string> {
    const integer = (name: string, fallback?: number): number | undefined => {
      if (params[name] === undefined || params[name] === '') return fallback;
      const result = Number(params[name]);
      if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ${name}`);
      return result;
    };
    const limit = Math.min(integer('limit', MAX_PAGE_SIZE)!, MAX_PAGE_SIZE);
    const offset = integer('offset', 0)!;
    if (offset > 10000) throw new Error('Search offset exceeds 10000');
    const categories = (params.cat || '').split(',').map(Number);
    const tv = categories.some(category => category >= 5000 && category < 6000);
    const movie = categories.some(category => category >= 2000 && category < 3000);
    const kind = params.t === 'tvsearch' ? 'tv' : params.t === 'movie' ? 'movie' : tv !== movie ? (tv ? 'tv' : 'movie') : undefined;
    const season = integer('season');
    const daily = params.ep?.match(/^(\d{2})\/(\d{2})$/);
    const airDate = daily && season !== undefined ? `${season}-${daily[1]}-${daily[2]}` : undefined;
    if (daily) {
      if (!airDate || season! < 1900) throw new Error('Invalid daily episode date');
      try {
        Temporal.PlainDate.from(airDate, { overflow: 'reject' });
      } catch {
        throw new Error('Invalid daily episode date');
      }
    }
    const query: SearchQuery = { q: params.q || '', kind, season: airDate ? undefined : season,
      episode: airDate ? undefined : integer('ep'), airDate, limit: offset + limit, offset: 0 };
    const enabled = [...this.providers.values()];
    if (!enabled.length) throw new Error('No providers are enabled');
    const tvdbId = integer('tvdbid');
    if (tvdbId !== undefined && (tvdbId === 0 || params.t !== 'tvsearch')) throw new Error('Invalid tvdbid');
    const tmdbId = integer('tmdbid');
    if (tmdbId !== undefined && (tmdbId === 0 || params.t !== 'movie')) throw new Error('Invalid tmdbid');
    const identity = tvdbId === undefined ? undefined : await this.bindings.identity(tvdbId, signal);
    if (identity) this.feed.watch(identity);
    if (kind === 'tv' && !query.q.trim() && !identity && tmdbId === undefined
        && query.season === undefined && query.episode === undefined && !airDate) {
      const watched = await this.feed.releases(signal);
      // Sonarr refuses to save an indexer whose RSS is empty, so an empty feed falls back to browsing.
      if (watched.length) return this.respond(watched, offset, limit, signal, true);
    }
    const results = await Promise.allSettled(enabled.map(provider => tmdbId === undefined
      ? this.bindings.search(provider, query, identity, signal)
      : this.movieBindings.search(provider, query, tmdbId, signal).then((releases): BindingSearch => ({ releases }))));
    signal.throwIfAborted();
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${enabled[index]!.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (failed.length === enabled.length) throw new Error(`All providers failed: ${failed.join('; ')}`);
    // A partial provider failure is visible to operators, not disguised as an empty successful provider.
    for (const error of failed) console.error(`Provider search failed: ${error}`);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.unbound) {
        console.error(`TVDB ${tvdbId} is unbound for ${enabled[index]!.id}: ${result.value.unbound}`);
      }
    });
    // Release ids are scoped by provider, and each provider's page is already deduplicated.
    const releases = results.flatMap(result => result.status === 'fulfilled' ? result.value.releases : []);
    const all = tmdbId === undefined ? releases : releases.map(release => ({ ...release, tmdbId }));
    all.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id));
    return this.respond(all, offset, limit, signal, false);
  }

  /**
   * One Newznab page of `all`. Feed pages reuse a Release's playback inspection for six hours,
   * because every RSS sync lists the same newest Releases again; searches always inspect anew.
   */
  private async respond(all: Release[], offset: number, limit: number, signal: AbortSignal, feed: boolean): Promise<string> {
    const page = all.slice(offset, offset + limit).map(release => ({ ...release }));
    const now = Date.now();
    for (const [id, inspection] of this.feedInspections) if (now - inspection.at >= FEED_INSPECTION_TTL_MS) this.feedInspections.delete(id);
    // Provider pages and manifests are inspected sequentially to avoid bursts at their CDNs.
    for (const release of page) {
      const inspected = feed ? this.feedInspections.get(release.id) : undefined;
      if (inspected) {
        Object.assign(release, inspected.metadata);
        continue;
      }
      await this.enrich(release, signal);
      if (feed && release.height !== undefined) {
        this.feedInspections.set(release.id, { at: now, metadata: { height: release.height, size: release.size, sizeEstimated: release.sizeEstimated, language: release.language } });
      }
    }
    signal.throwIfAborted();
    this.store.saveReleases(page);
    const items = page.map(release => this.item(release)).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Bohemarr</title><description>Source media download tasks</description><link>${xml(this.config.publicUrl)}</link><newznab:response offset="${offset}" total="${all.length}"/>${items}</channel></rss>`;
  }

  /** Inspects current source variants; durable release URLs can acquire better renditions later. */
  private async enrich(release: Release, signal: AbortSignal): Promise<void> {
    const provider = this.providers.get(release.provider);
    if (!provider) return;
    try {
      const sources = await provider.resolve(release, signal);
      signal.throwIfAborted();
      if (!sources.length) return;
      const metadata = await inspectMediaSources(this.config, sources, signal);
      release.height = metadata.height;
      release.size = metadata.size;
      release.sizeEstimated = metadata.sizeEstimated;
      release.language = normalizeLanguage(metadata.language);
    } catch (error) {
      if (signal.aborted) throw error;
      console.error(`Media metadata inspection failed for ${release.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private item(release: Release): string {
    const url = `${this.config.publicUrl}/newznab/api?t=get&id=${encodeURIComponent(release.id)}&apikey=${encodeURIComponent(this.config.apiKey)}`;
    const category = release.kind === 'movie' ? 2000 : 5000;
    const date = new Date(release.publishedAt || 0);
    const size = Number.isFinite(release.size) && release.size! >= 0 ? Math.floor(release.size!) : 0;
    const description = release.sizeEstimated ? `${release.title} (estimated size)` : release.title;
    return `<item><title>${xml(releaseTitle(release))}</title><guid isPermaLink="false">${xml(release.id)}</guid><link>${xml(url)}</link><comments>${xml(release.url)}</comments><pubDate>${xml(Number.isFinite(date.getTime()) ? date.toUTCString() : new Date(0).toUTCString())}</pubDate><category>${category}</category><description>${xml(description)}</description><enclosure url="${xml(url)}" length="${size}" type="application/x-nzb"/><newznab:attr name="category" value="${category}"/><newznab:attr name="size" value="${size}"/>${release.tvdbId === undefined ? '' : `<newznab:attr name="tvdbid" value="${release.tvdbId}"/>`}${release.tmdbId === undefined ? '' : `<newznab:attr name="tmdbid" value="${release.tmdbId}"/>`}${release.season === undefined ? '' : `<newznab:attr name="season" value="${release.season}"/>`}${release.episode === undefined ? '' : `<newznab:attr name="episode" value="${release.episode}"/>`}</item>`;
  }

  /** The signed Task descriptor (an NZB envelope) for a Release found by an earlier search. */
  taskDescriptor(id: string): { name: string; content: string } {
    const release = this.store.release(id);
    if (!release) throw new Error('Unknown release ID; search the indexer first');
    const signature = createHmac('sha256', this.config.apiKey).update(id).digest('hex');
    const name = releaseTitle(release);
    return {
      name: `${sanitizeFilename(name)}.nzb`,
      content: `<?xml version="1.0" encoding="UTF-8"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head><meta type="bohemarr-id">${xml(id)}</meta><meta type="bohemarr-signature">${signature}</meta></head><file poster="bohemarr" date="0" subject="${xml(name)}"><groups><group>bohemarr</group></groups><segments><segment bytes="0" number="1">${xml(id)}@bohemarr</segment></segments></file></nzb>`,
    };
  }

  /** The Release a Task descriptor from this instance names; rejects foreign or altered descriptors. */
  parseTaskDescriptor(content: string): Release {
    if (content.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('Invalid task descriptor');
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(content);
    const raw = parsed?.nzb?.head?.meta;
    const metas: Array<Record<string, string>> = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const id = metas.find(meta => meta['@_type'] === 'bohemarr-id')?.['#text'];
    const signature = metas.find(meta => meta['@_type'] === 'bohemarr-signature')?.['#text'];
    if (typeof id !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new Error('Only task descriptors from this Bohemarr instance are supported; this is not a Usenet client');
    }
    const expected = createHmac('sha256', this.config.apiKey).update(id).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) throw new Error('Invalid task descriptor signature');
    const release = this.store.release(id);
    if (!release) throw new Error('Release no longer exists');
    return release;
  }
}
