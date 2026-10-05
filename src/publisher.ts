import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { probeMedia } from './media/ffprobe.ts';
import { ProcessExitError, runProcess } from './media/process.ts';
import { normalizeLanguage } from './providers/common.ts';
import { infoHashOf } from './torrent.ts';
import type { Store } from './store.ts';
import type { Config, Provider, Release, VltavaConfig } from './types.ts';

/** Retries of a failing step wait 5 minutes, doubling up to 6 hours, and give up after this many attempts. */
const MAX_ATTEMPTS = 8;
const FIRST_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
/** How often a torrent rqbit is still checking is looked at again. */
const CHECK_POLL_MS = 30_000;
/** Hashing a large file takes a while; a stuck CLI must not block the queue forever. */
const CLI_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * One imported file on its way to Vltava: `Pending` until the `vltava` CLI uploaded it, `Uploaded`
 * until rqbit verified and seeds the personal .torrent, then `Seeding`; `Failed` when a step gave up.
 */
export interface Publication {
  id: string;
  kind: 'tv' | 'movie';
  /** The imported file, as Sonarr or Radarr reported it. */
  path: string;
  release: Release;
  providerName: string;
  title: string;
  year?: number;
  tmdbId: number;
  tvdbId?: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  airDate?: string;
  status: 'Pending' | 'Uploaded' | 'Seeding' | 'Failed';
  attempts: number;
  retryAt?: number;
  torrentId?: number;
  /** The personal .torrent the CLI downloaded after uploading. */
  torrentFile?: string;
  /** Uploaded, but Vltava still reports a naming problem a moderator or `vltava fix` must resolve. */
  namingFixRequired?: boolean;
  error: string;
  createdAt: number;
  updatedAt: number;
}

/** The part of a Sonarr or Radarr webhook payload the publisher reads. */
export interface ImportEvent {
  eventType?: string;
  downloadId?: string;
  series?: { title?: string; year?: number; tvdbId?: number; tmdbId?: number; imdbId?: string };
  episodes?: Array<{ seasonNumber?: number; episodeNumber?: number; title?: string; airDate?: string }>;
  episodeFile?: { path?: string };
  movie?: { title?: string; year?: number; tmdbId?: number; imdbId?: string };
  movieFile?: { path?: string };
}

export type ImportDecision =
  | { publish: Omit<Publication, 'status' | 'attempts' | 'error' | 'createdAt' | 'updatedAt'> }
  | { ignore: string };

/**
 * Whether an import is published: only files Bohemarr downloaded from an allowed provider, one
 * episode per file, with a TMDB ID, which is the only TV and movie identity Vltava accepts.
 */
export function decideImport(event: ImportEvent, store: Store, vltava: VltavaConfig, providers: Map<string, Provider>): ImportDecision {
  if (event.eventType !== 'Download') return { ignore: `event ${event.eventType ?? '(none)'}` };
  const release = event.downloadId ? store.jobRelease(event.downloadId.toLowerCase()) : undefined;
  if (!release) return { ignore: 'not downloaded by Bohemarr' };
  if (!vltava.providers.includes(release.provider)) return { ignore: `provider ${release.provider} is not in VLTAVA_PROVIDERS` };
  const providerName = providers.get(release.provider)?.name ?? release.provider;
  const tv = event.series !== undefined;
  const subject = tv ? event.series! : event.movie;
  const path = tv ? event.episodeFile?.path : event.movieFile?.path;
  if (!subject || !path) return { ignore: 'payload names no series or movie file' };
  if (!subject.tmdbId) return { ignore: `${subject.title ?? 'title'} has no TMDB ID` };
  const episodes = event.episodes ?? [];
  if (tv && episodes.length !== 1) return { ignore: `file holds ${episodes.length} episodes; only single episodes are published` };
  const episode = episodes[0];
  return { publish: {
    id: createHash('sha256').update(`${event.downloadId}\n${path}`).digest('hex').slice(0, 24),
    kind: tv ? 'tv' : 'movie', path, release, providerName,
    title: subject.title ?? release.series ?? release.title, year: subject.year || undefined,
    tmdbId: subject.tmdbId, tvdbId: tv ? event.series!.tvdbId || undefined : undefined, imdbId: subject.imdbId || undefined,
    season: episode?.seasonNumber, episode: episode?.episodeNumber, episodeTitle: episode?.title || undefined,
    airDate: episode?.airDate || undefined,
  } };
}

const LANGUAGES: Record<string, string> = { CZ: 'čeština', SK: 'slovenština', EN: 'angličtina' };

/** The Markdown description of a Publication. */
export function describe(publication: Publication): string {
  const { release } = publication;
  const episode = publication.kind === 'tv' && publication.season !== undefined && publication.episode !== undefined
    ? ` – S${String(publication.season).padStart(2, '0')}E${String(publication.episode).padStart(2, '0')}` : '';
  const year = publication.year ? ` (${publication.year})` : '';
  const lines = [`## ${publication.title}${year}${episode}${publication.episodeTitle ? ` – ${publication.episodeTitle}` : ''}`, ''];
  const facts = [
    `**Zdroj:** [${publication.providerName}](${release.url})`,
    `**Typ:** WEB-DL${release.height ? ` ${release.height}p` : ''}`,
  ];
  const language = normalizeLanguage(release.language);
  if (language) facts.push(`**Zvuk:** ${LANGUAGES[language] ?? language}`);
  if (publication.airDate) facts.push(`**Vysíláno:** ${publication.airDate}`);
  lines.push(...facts.map(fact => `- ${fact}`), '');
  const links = [`[TMDB](https://www.themoviedb.org/${publication.kind === 'tv' ? 'tv' : 'movie'}/${publication.tmdbId})`];
  if (publication.tvdbId) links.push(`[TVDB](https://thetvdb.com/dereferrer/series/${publication.tvdbId})`);
  if (publication.imdbId) links.push(`[IMDb](https://www.imdb.com/title/${publication.imdbId}/)`);
  lines.push(links.join(' · '), '', '_Nahráno automaticky z archivu poskytovatele._');
  return `${lines.join('\n')}\n`;
}

function resolutionSlug(height: number): string {
  for (const [minimum, slug] of [[2160, '2160p'], [1080, '1080p'], [720, '720p'], [576, '576p'], [480, '480p']] as const) {
    if (height >= minimum * 0.9) return slug;
  }
  return 'other';
}

/** Publishes imported Releases to Vltava with the `vltava` CLI and seeds them with a dedicated rqbit. */
export class Publisher {
  private readonly config: Config;
  private readonly vltava: VltavaConfig;
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly selectAll: StatementSync;
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(config: Config, vltava: VltavaConfig, database: DatabaseSync) {
    this.config = config;
    this.vltava = vltava;
    database.exec('CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.insert = database.prepare('INSERT INTO publications VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    this.select = database.prepare('SELECT payload FROM publications WHERE id=?');
    this.selectAll = database.prepare('SELECT payload FROM publications');
  }

  publication(id: string): Publication | undefined {
    const row = this.select.get(id);
    return row ? JSON.parse(String(row.payload)) as Publication : undefined;
  }

  publications(): Publication[] {
    return this.selectAll.all().map(row => JSON.parse(String(row.payload)) as Publication)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Queues a decided import; queueing the same import again returns the existing Publication. */
  add(decision: Extract<ImportDecision, { publish: unknown }>['publish']): Publication {
    const existing = this.publication(decision.id);
    if (existing) return existing;
    const now = Date.now();
    const publication: Publication = { ...decision, status: 'Pending', attempts: 0, error: '', createdAt: now, updatedAt: now };
    this.save(publication);
    this.wake();
    return publication;
  }

  /** Runs every due step, one Publication at a time; a step that is not due yet schedules the next run. */
  wake(): void {
    if (this.controller.signal.aborted) return;
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.wake();
      }
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const open = this.publications().filter(item => item.status === 'Pending' || item.status === 'Uploaded');
      const due = open.find(item => (item.retryAt ?? 0) <= now);
      if (!due) {
        const next = Math.min(...open.map(item => item.retryAt ?? now));
        if (Number.isFinite(next)) this.timer = setTimeout(() => this.wake(), Math.max(1000, next - now)).unref();
        return;
      }
      if (this.controller.signal.aborted) return;
      await this.step(due);
    }
  }

  private async step(publication: Publication): Promise<void> {
    const label = `${publication.title}${publication.episode !== undefined ? ` S${publication.season}E${publication.episode}` : ''}`;
    try {
      if (publication.status === 'Pending') {
        const uploaded = await this.upload(publication);
        this.save({ ...publication, ...uploaded, status: 'Uploaded', attempts: 0, retryAt: undefined, error: '' });
        console.log(`Vltava: uploaded ${label} as torrent #${uploaded.torrentId ?? '?'}${uploaded.namingFixRequired ? '; the naming still needs a fix' : ''}`);
      } else if (await this.seed(publication)) {
        this.save({ ...publication, status: 'Seeding', attempts: 0, retryAt: undefined, error: '' });
        console.log(`Vltava: seeding ${label}`);
      } else {
        // rqbit is still checking the files; that is progress, not a failed attempt.
        this.save({ ...publication, retryAt: Date.now() + CHECK_POLL_MS });
      }
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = publication.attempts + 1;
      const final = error instanceof PermanentError || attempts >= MAX_ATTEMPTS;
      const delay = Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
      this.save({ ...publication, attempts, error: message, ...(final ? { status: 'Failed', retryAt: undefined } : { retryAt: Date.now() + delay }) });
      console.error(`Vltava: ${final ? 'gave up on' : `retrying in ${Math.round(delay / 60_000)} min`} ${label}: ${message}`);
    }
  }

  /** Runs `vltava upload`, which plans the canonical tree, links it under its own directory, uploads it and saves the personal .torrent. */
  private async upload(publication: Publication): Promise<Pick<Publication, 'torrentId' | 'torrentFile' | 'namingFixRequired'>> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(CLI_TIMEOUT_MS)]);
    const outDir = join(this.vltava.outDir, publication.id);
    // Nothing seeds a Pending Publication yet, so a previous attempt's partial tree can go.
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const descriptionFile = join(this.vltava.outDir, `${publication.id}.md`);
    await writeFile(descriptionFile, describe(publication));
    const height = (await probeMedia(this.config, publication.path, undefined, signal)).streams
      .find(stream => stream.codec_type === 'video')?.height;
    const args = ['upload', publication.path, '--category', publication.kind === 'tv' ? 'tv' : 'movies',
      '--tmdb', String(publication.tmdbId), '--type', 'web-dl', '--out', outDir, '--link', this.vltava.link,
      '--description-file', descriptionFile, '--yes'];
    if (height) args.push('--resolution', resolutionSlug(height));
    if (publication.kind === 'tv') args.push('--season', String(publication.season), '--episode', String(publication.episode));
    if (this.vltava.group) args.push('--group', this.vltava.group);
    if (this.vltava.anonymous) args.push('--anonymous');
    let stdout: string;
    let namingFixRequired = false;
    try {
      stdout = await runProcess(this.vltava.cli, args, signal, undefined,
        { ...process.env, VLTAVA_URL: this.vltava.url, VLTAVA_TOKEN: this.vltava.token });
    } catch (error) {
      // Exit code 2: uploaded, but Vltava still reports a naming problem.
      if (!(error instanceof ProcessExitError) || error.exitCode !== 2) {
        if (error instanceof ProcessExitError && /duplicate_torrent/.test(error.stderr)) {
          throw new PermanentError('Vltava already has this torrent; a previous attempt uploaded it');
        }
        throw error;
      }
      stdout = error.stdout;
      namingFixRequired = true;
    } finally {
      await rm(descriptionFile, { force: true });
    }
    const torrents = (await readdir(outDir)).filter(name => name.endsWith('.torrent'));
    if (torrents.length !== 1) throw new PermanentError(`vltava upload left ${torrents.length} .torrent files in ${outDir}`);
    const id = /Created torrent #(\d+)/.exec(stdout)?.[1];
    return { torrentId: id ? Number(id) : undefined, torrentFile: join(outDir, torrents[0]!), namingFixRequired };
  }

  /**
   * Adds the personal .torrent to rqbit, seeding from the tree the CLI linked; adding a torrent rqbit
   * already has is harmless. True once rqbit verified every piece; false while it is still checking.
   */
  private async seed(publication: Publication): Promise<boolean> {
    const content = await readFile(publication.torrentFile!);
    const hash = infoHashOf(content);
    // overwrite=true lets rqbit use the files already in the tree instead of refusing to touch them.
    const query = new URLSearchParams({ is_url: 'false', overwrite: 'true', output_folder: join(this.vltava.outDir, publication.id) });
    await this.seeder(`torrents?${query}`, { method: 'POST', body: content });
    const stats: unknown = JSON.parse(await this.seeder(`torrents/${hash}/stats/v1`));
    if (!stats || typeof stats !== 'object' || !('state' in stats)) throw new Error('rqbit returned no torrent state');
    if (stats.state === 'initializing') return false;
    const error = 'error' in stats && typeof stats.error === 'string' ? stats.error : '';
    if (stats.state === 'error') throw new Error(`rqbit: ${error || 'torrent failed'}`);
    if (!('finished' in stats) || stats.finished !== true) {
      // Missing or different data: rqbit would download instead of seed, so it lets go of the torrent.
      await this.seeder(`torrents/${hash}/forget`, { method: 'POST' });
      throw new PermanentError(`the files in ${join(this.vltava.outDir, publication.id)} do not match the torrent`);
    }
    return true;
  }

  /** One rqbit HTTP API request. */
  private async seeder(path: string, init: RequestInit = {}): Promise<string> {
    const { url, userpass } = this.vltava.seeder;
    const response = await fetch(`${url}/${path}`, {
      ...init, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10 * 60_000)]),
      headers: userpass ? { Authorization: `Basic ${Buffer.from(userpass).toString('base64')}` } : {},
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`rqbit ${init.method ?? 'GET'} /${path.split('?')[0]}: HTTP ${response.status} ${text.trim().slice(0, 300)}`);
    return text;
  }

  private save(publication: Publication): void {
    this.insert.run(publication.id, JSON.stringify({ ...publication, updatedAt: Date.now() }));
  }

  /** Resolves once no step is running: every due step ran, and later ones wait for their retry time. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    this.controller.abort(new Error('Service stopping'));
    clearTimeout(this.timer);
    await this.idle();
  }
}

/** A failure that retrying cannot fix. */
class PermanentError extends Error {}
