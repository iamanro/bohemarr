import { episodeAirDate, normalize } from './providers/common.ts';
import type { CatalogueQuery, Program, Provider, Release, SearchQuery } from './types.ts';

/** Most Programs a text search expands, after exact-name ranking. */
const TEXT_SEARCH_PROGRAM_CAP = 40;
const URL_QUERY = /^https?:\/\/\S+$/i;

type CatalogueProvider = Pick<Provider, 'id' | 'catalogue' | 'entries'>;

/**
 * One page (`query.offset` .. `offset + limit`) of a provider's Releases matching `query`.
 *
 * - `programId`: expands exactly that bound Program; its failures propagate.
 * - http(s) URL `q`: only the Release the provider resolves for that URL (kind/season/episode still apply).
 * - otherwise static entries come first, then Programs:
 *   - text `q`: every listed Program whose title has all query words (or, if none does, any
 *     whole word of three letters or more), exact title matches first, at most 40, each
 *     contributing all its matching Releases;
 *   - empty `q`: Programs lazily in catalogue order, each contributing its newest matching Release.
 *
 * Releases are deduplicated by id before counting, and no Program is expanded once the page is
 * full. A failing Program is logged and skipped; the search fails only when it found nothing and
 * at least one Program failed. Aborting `signal` always rejects.
 */
export async function searchCatalogue(provider: CatalogueProvider, query: SearchQuery, signal: AbortSignal): Promise<Release[]> {
  signal.throwIfAborted();
  const page = new Page(provider.id, query.offset + query.limit);
  const { catalogue } = provider;
  // Radarr appends the production year; upstream title searches do not search year metadata.
  const text = query.q.trim();
  const movieYear = query.kind === 'movie' ? /\s+\(?(\d{4})\)?$/.exec(text) : null;
  const year = movieYear ? Number(movieYear[1]) : undefined;
  const hint: CatalogueQuery = { q: movieYear ? text.slice(0, movieYear.index) : text,
    kind: query.kind, season: query.season, episode: query.episode, airDate: query.airDate };
  const take = (release: Release, filter: CatalogueQuery = hint): void => {
    if (matches(release, filter, year)) page.add(release);
  };

  if (query.programId !== undefined) {
    if (!catalogue.program) throw new Error(`Provider ${provider.id} cannot expand a bound program`);
    const program = await catalogue.program(query.programId, signal);
    if (program) {
      for await (const release of catalogue.releases(program, hint, signal)) {
        take(release);
        if (page.full) break;
      }
    }
    return page.result(query.offset);
  }

  const q = hint.q;
  if (URL_QUERY.test(q)) {
    const release = await catalogue.releaseForUrl?.(new URL(q), hint, signal);
    if (release) take(release, { ...hint, q: '' });
    return page.result(query.offset);
  }

  for (const entry of provider.entries ?? []) {
    take(entry);
    if (page.full) return page.result(query.offset);
  }

  const words = normalize(q).split(' ').filter(Boolean);
  const browsing = words.length === 0;
  const programs = browsing
    ? kindFiltered(catalogue.programs(hint, signal), hint)
    : fromArray(await textCandidates(catalogue.programs(hint, signal), hint, words));
  // Browsing expands at most this many Programs, so a sparse catalogue cannot be crawled whole.
  const maxPrograms = browsing ? Math.max(page.needed, 20) * 2 : Infinity;

  const expand = async (program: Program, expansionSignal: AbortSignal): Promise<Release[]> => {
    const found: Release[] = [];
    for await (const release of catalogue.releases(program, hint, expansionSignal)) {
      if (!matches(release, hint, year)) continue;
      found.push(release);
      if (browsing || found.length >= page.needed) break;
    }
    return found;
  };

  const failures = await expandInOrder(programs, Math.max(1, catalogue.concurrency ?? 1), maxPrograms, expand, page, browsing, signal);
  if (!page.size && failures.length) {
    throw new AggregateError(failures.map(failure => failure.error), `${provider.id}: every program listing failed`);
  }
  for (const failure of failures) {
    console.error(`${provider.id}: program "${failure.program.title}" failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
  }
  return page.result(query.offset);
}

function matches(release: Release, query: CatalogueQuery, year: number | undefined): boolean {
  if (query.kind && release.kind !== query.kind) return false;
  if (year !== undefined && release.year !== year) return false;
  if (query.airDate && episodeAirDate(release) !== query.airDate) return false;
  if (query.season !== undefined && release.season !== query.season
      && !(query.season >= 1900 && episodeAirDate(release)?.startsWith(`${query.season}-`))) return false;
  if (query.episode !== undefined && release.episode !== query.episode) return false;
  const title = normalize(`${release.series ?? ''} ${release.title} ${release.year ?? ''}`);
  return normalize(query.q).split(' ').filter(Boolean).every(word => title.includes(word));
}

class Page {
  private readonly releases = new Map<string, Release>();
  private readonly providerId: string;
  readonly needed: number;

  constructor(providerId: string, needed: number) {
    this.providerId = providerId;
    this.needed = needed;
  }

  get size(): number { return this.releases.size; }
  get full(): boolean { return this.releases.size >= this.needed; }

  add(release: Release): void {
    if (release.provider !== this.providerId) {
      throw new Error(`Provider ${this.providerId} listed a release owned by ${release.provider}`);
    }
    if (!this.full && !this.releases.has(release.id)) this.releases.set(release.id, release);
  }

  result(offset: number): Release[] {
    return [...this.releases.values()].slice(offset, this.needed);
  }
}

async function textCandidates<P extends Program>(programs: AsyncIterable<P>, query: CatalogueQuery, words: string[]): Promise<P[]> {
  const listed = await Array.fromAsync(kindFiltered(programs, query), program => ({ program, title: normalize(program.title) }));
  const strong = listed.filter(({ title }) => words.every(word => title.includes(word)));
  // The fallback needs a whole word of three letters or more: "Grey's Anatomy" has the word "s".
  const weak = words.filter(word => word.length > 2);
  const pool = strong.length ? strong : listed.filter(({ title }) => title.split(' ').some(word => weak.includes(word)));
  const exact = words.join(' ');
  return [...pool.filter(({ title }) => title === exact), ...pool.filter(({ title }) => title !== exact)]
    .slice(0, TEXT_SEARCH_PROGRAM_CAP).map(({ program }) => program);
}

async function* kindFiltered<P extends Program>(programs: AsyncIterable<P>, query: CatalogueQuery): AsyncGenerator<P> {
  for await (const program of programs) {
    if (!query.kind || !program.kind || program.kind === query.kind) yield program;
  }
}

async function* fromArray<T>(values: T[]): AsyncGenerator<T> {
  yield* values;
}

type Settled = { ok: true; value: Release[] } | { ok: false; error: unknown };
interface Failure { program: Program; error: unknown }

/**
 * Expands up to `concurrency` Programs at a time and adds their Releases to `page` strictly in
 * catalogue order. Never starts a Program the page cannot use (while browsing, each Program adds
 * at most one Release), and cancels expansions still running once the page is full.
 */
async function expandInOrder(
  programs: AsyncIterable<Program>, concurrency: number, maxPrograms: number,
  expand: (program: Program, signal: AbortSignal) => Promise<Release[]>,
  page: Page, browsing: boolean, signal: AbortSignal,
): Promise<Failure[]> {
  const cancel = new AbortController();
  const expansionSignal = AbortSignal.any([signal, cancel.signal]);
  const iterator = programs[Symbol.asyncIterator]();
  const inFlight: Array<{ program: Program; result: Promise<Settled> }> = [];
  const failures: Failure[] = [];
  let started = 0;
  let exhausted = false;
  const wanted = (): boolean => browsing ? page.size + inFlight.length < page.needed : !page.full;

  try {
    for (;;) {
      while (!exhausted && inFlight.length < concurrency && started < maxPrograms && wanted()) {
        const next = await iterator.next();
        if (next.done) { exhausted = true; break; }
        const program = next.value;
        started++;
        inFlight.push({
          program,
          result: expand(program, expansionSignal).then(
            (value): Settled => ({ ok: true, value }),
            (error: unknown): Settled => ({ ok: false, error }),
          ),
        });
      }
      const head = inFlight.shift();
      if (!head) break;
      const settled = await head.result;
      signal.throwIfAborted();
      if (settled.ok) for (const release of settled.value) page.add(release);
      else failures.push({ program: head.program, error: settled.error });
      if (page.full) break;
    }
  } finally {
    cancel.abort();
    if (!exhausted) await iterator.return?.();
  }
  return failures;
}
