import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import type { MediaKind } from '../types.ts';
import { fetchResponse, fetchText, untilAborted } from './common.ts';

const SITEMAPS: ReadonlyArray<{ url: string; kind: MediaKind }> = [
  { url: 'https://www.iprima.cz/sitemap-series.xml', kind: 'tv' },
  { url: 'https://www.iprima.cz/sitemap-movie.xml', kind: 'movie' },
];
/** How long a sitemap listing stays current before the next search refreshes it in the background. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
/** Gap between two title requests: 300 per five minutes leaves room for searches and playback. */
const TITLE_INTERVAL_MS = 1000;
/** The page `<title>` sits in the first few hundred bytes; stop reading well after it. */
const TITLE_READ_LIMIT = 16 * 1024;

/** Clock and wait used by the index; tests replace both to avoid real time. */
interface IndexTiming {
  now?: () => number;
  pause?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}

class PageStatusError extends Error {
  readonly status: number;

  constructor(status: number, uri: string) {
    super(`HTTP ${status} from ${uri}`);
    this.status = status;
  }
}

/** A Prima+ programme page listed by iPrima's sitemaps. */
export interface IndexedProgram {
  uri: string;
  kind: MediaKind;
  /** The page title, or a name derived from the URL until the page title is known. */
  title: string;
  /** False while `title` is only derived from the URL. */
  titled: boolean;
}

/**
 * The Prima+ catalogue, built from iPrima's own sitemaps and kept in SQLite.
 *
 * The first listing waits for the sitemaps; later listings serve the stored index and refresh it
 * in the background once it is older than six hours. Programme titles are read from the pages
 * (only their `<title>` element) in the background, one page per second, again whenever a page's
 * `lastmod` changes. A new installation therefore searches partly by URL-derived names for its first hour and a half.
 */
export class PrimaIndex {
  private readonly selectPrograms: StatementSync;
  private readonly selectUntitled: StatementSync;
  private readonly selectUris: StatementSync;
  private readonly upsertProgram: StatementSync;
  private readonly deleteProgram: StatementSync;
  private readonly updateTitle: StatementSync;
  private readonly selectRefreshedAt: StatementSync;
  private readonly upsertRefreshedAt: StatementSync;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly pause: (ms: number, signal: AbortSignal) => Promise<unknown>;
  private readonly lifetime = new AbortController();
  private refreshing: Promise<void> | undefined;
  private titling: Promise<void> | undefined;
  private resumed = false;

  constructor(db: DatabaseSync, options: IndexTiming = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.pause = options.pause ?? ((ms, signal) => delay(ms, undefined, { signal }));
    db.exec(`CREATE TABLE IF NOT EXISTS prima_programs (
        uri TEXT PRIMARY KEY, kind TEXT NOT NULL, lastmod TEXT NOT NULL, title TEXT, title_lastmod TEXT
      );
      CREATE TABLE IF NOT EXISTS prima_index (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.selectPrograms = db.prepare('SELECT uri, kind, title FROM prima_programs ORDER BY lastmod DESC, uri');
    this.selectUntitled = db.prepare(
      'SELECT uri, lastmod FROM prima_programs WHERE title_lastmod IS NOT lastmod ORDER BY lastmod DESC, uri LIMIT ?',
    );
    this.selectUris = db.prepare('SELECT uri FROM prima_programs');
    this.upsertProgram = db.prepare(`INSERT INTO prima_programs (uri, kind, lastmod) VALUES (?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET kind=excluded.kind, lastmod=excluded.lastmod`);
    this.deleteProgram = db.prepare('DELETE FROM prima_programs WHERE uri=?');
    this.updateTitle = db.prepare('UPDATE prima_programs SET title=?, title_lastmod=? WHERE uri=? AND lastmod=?');
    this.selectRefreshedAt = db.prepare("SELECT value FROM prima_index WHERE key='refreshed_at'");
    this.upsertRefreshedAt = db.prepare(
      "INSERT INTO prima_index VALUES ('refreshed_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
  }

  /** Programmes, most recently changed first. */
  async *programs(signal: AbortSignal): AsyncGenerator<IndexedProgram> {
    const refreshedAt = this.selectRefreshedAt.get()?.value;
    // The first refresh runs on the index's own lifetime: an impatient first caller must not cancel it for the others.
    if (refreshedAt === undefined) await untilAborted(this.refresh(this.lifetime.signal), signal);
    else if (this.now() - Number(refreshedAt) >= REFRESH_AFTER_MS) void this.refresh(this.lifetime.signal).catch(logFailure);
    // Titles left over from an earlier run are completed once per process; a refresh starts another pass.
    if (!this.resumed) {
      this.resumed = true;
      this.startTitling();
    }
    // Read all rows first: background title updates write to the table while callers consume lazily.
    for (const row of this.selectPrograms.all()) {
      signal.throwIfAborted();
      const uri = String(row.uri);
      const titled = row.title !== null;
      yield { uri, kind: row.kind === 'movie' ? 'movie' : 'tv', title: titled ? String(row.title) : titleFromUri(uri), titled };
    }
  }

  /** Resolves once no sitemap refresh or title pass is running. */
  async idle(): Promise<void> {
    while (this.refreshing || this.titling) {
      await Promise.allSettled([this.refreshing, this.titling]);
    }
  }

  /** Stops background work and waits for it to wind down; the stored index stays for the next start. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Prima+ index closed'));
    await this.idle();
  }

  /** Replaces the listing with the current sitemaps; concurrent callers share one refresh. */
  private refresh(signal: AbortSignal): Promise<void> {
    this.refreshing ??= this.fetchSitemaps(AbortSignal.any([signal, this.lifetime.signal])).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async fetchSitemaps(signal: AbortSignal): Promise<void> {
    const listed = new Map<string, { kind: MediaKind; lastmod: string }>();
    for (const { url, kind } of SITEMAPS) {
      for (const entry of await sitemapEntries(url, signal)) listed.set(entry.uri, { kind, lastmod: entry.lastmod });
    }
    if (!listed.size) throw new Error('iPrima sitemaps list no programmes');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.selectUris.all()) {
        const uri = String(row.uri);
        if (!listed.has(uri)) this.deleteProgram.run(uri);
      }
      for (const [uri, { kind, lastmod }] of listed) this.upsertProgram.run(uri, kind, lastmod);
      this.upsertRefreshedAt.run(String(this.now()));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.startTitling();
  }

  /** Reads missing or outdated titles in the background until none is left. */
  private startTitling(): void {
    this.titling ??= this.fillTitles(this.lifetime.signal)
      .catch(logFailure)
      .finally(() => {
        this.titling = undefined;
      });
  }

  /**
   * One page at a time, `TITLE_INTERVAL_MS` apart: iPrima's CDN blocks the client's address for
   * every page, playback included, once it sees roughly a thousand requests within minutes.
   */
  private async fillTitles(signal: AbortSignal): Promise<void> {
    // Rows leave the query once titled; rows that failed stay in it and are skipped by this pass.
    const failed = new Set<string>();
    const next = (): { uri: string; lastmod: string } | undefined => {
      for (const row of this.selectUntitled.all(failed.size + 1)) {
        const uri = String(row.uri);
        if (!failed.has(uri)) return { uri, lastmod: String(row.lastmod) };
      }
      return undefined;
    };
    for (let row = next(), first = true; row; row = next(), first = false) {
      if (!first) await this.pause(TITLE_INTERVAL_MS, signal);
      try {
        const title = await pageTitle(row.uri, signal);
        // A page without a recognisable title keeps its URL-derived name until it changes.
        this.updateTitle.run(title ?? null, row.lastmod, row.uri, row.lastmod);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PageStatusError && (error.status === 403 || error.status === 429)) {
          console.error(
            `iprima: iPrima refused a page (HTTP ${error.status}); reading programme titles stops until the next index refresh`,
          );
          return;
        }
        failed.add(row.uri);
        if (failed.size === 1)
          console.error(`iprima: reading the title of ${row.uri} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.size)
      console.error(`iprima: ${failed.size} programme titles could not be read; they are retried after the next index refresh`);
  }
}

function logFailure(error: unknown): void {
  if (error instanceof Error && (error.message === 'Prima+ index closed' || error.name === 'AbortError')) return;
  console.error(`iprima: updating the programme index failed: ${error instanceof Error ? error.message : String(error)}`);
}

async function sitemapEntries(url: string, signal: AbortSignal): Promise<Array<{ uri: string; lastmod: string }>> {
  const parsed = new XMLParser({ parseTagValue: false, trimValues: true, processEntities: { maxEntityCount: 1000 } }).parse(
    await fetchText(url, signal),
  ) as { urlset?: { url?: unknown } };
  const urls = parsed.urlset?.url;
  const entries = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return entries.flatMap(entry => {
    const { loc, lastmod } = (entry ?? {}) as { loc?: unknown; lastmod?: unknown };
    return typeof loc === 'string' && loc.startsWith('https://www.iprima.cz/')
      ? [{ uri: loc, lastmod: typeof lastmod === 'string' ? lastmod : '' }]
      : [];
  });
}

/**
 * The programme name from the page `<title>`, e.g. `Ano, šéfe!  online ke zhlédnutí | prima+`
 * or `Táta je doma (2015) online – celý film ke zhlédnutí | prima+`. Only the page head is read.
 */
export async function pageTitle(uri: string, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetchResponse(uri, signal);
  if (!response.ok || !response.body) throw new PageStatusError(response.status, uri);
  const decoder = new TextDecoder();
  let head = '';
  const reader = response.body.getReader();
  try {
    while (head.length < TITLE_READ_LIMIT && !head.includes('</title>')) {
      const { done, value } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return parseTitle(cheerio.load(head)('title').first().text());
}

function parseTitle(documentTitle: string): string | undefined {
  // Anchored on the whole suffix, so names that contain "online" themselves survive.
  const match = /^(.+?)\s+(?:\(\d{4}\)\s+)?online\s+(?:–\s+celý film\s+)?ke zhlédnutí\s*\|\s*prima\+$/iu.exec(
    documentTitle.replace(/\s+/g, ' ').trim(),
  );
  return match?.[1]?.trim() || undefined;
}

/** A searchable name from the URL slug, e.g. `/serialy/ano-sefe` -> `ano sefe`. */
function titleFromUri(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname.split('/').filter(Boolean).at(-1) ?? uri).replaceAll('-', ' ');
}
