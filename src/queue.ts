import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Store } from './store.ts';
import { PlaybackBusy, releaseTitle, sanitizeFilename } from './providers/common.ts';
import type { Config, DownloadMedia, Job, Provider, Release } from './types.ts';

/** How long a job whose playback is busy waits before trying again. */
const BUSY_RETRY_MS = 5 * 60 * 1000;
/** A job whose playback stays busy this long fails, so it is not queued indefinitely. */
const BUSY_GIVE_UP_MS = 12 * 60 * 60 * 1000;

export class Queue {
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private retryTimer?: NodeJS.Timeout;
  private stopping = false;
  readonly store: Store;
  private readonly config: Config;
  private readonly providers: Map<string, Provider>;
  private readonly download: DownloadMedia;

  constructor(store: Store, config: Config, providers: Map<string, Provider>, download: DownloadMedia) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.download = download;
    for (const job of store.jobs()) {
      if (job.status === 'Downloading') store.updateJob(job.id, { status: 'Queued', error: '' });
    }
  }

  /**
   * Adds the Job `id` (a Task descriptor's info hash). Adding an existing Job again returns it, and
   * requeues it when it failed, as re-adding a known torrent to a BitTorrent client keeps that torrent.
   */
  add(id: string, release: Release, category: string, paused = false): Job {
    const existing = this.store.job(id);
    if (existing) return existing.status === 'Failed' ? this.retry(id) : existing;
    if (!this.config.categories.includes(category)) throw new Error(`Unknown category: ${category}`);
    if (!this.providers.has(release.provider)) throw new Error(`Provider is not enabled: ${release.provider}`);
    const now = Date.now();
    const job: Job = {
      id, release, category, status: paused ? 'Paused' : 'Queued', bytes: 0, totalBytes: release.size || 0,
      progress: 0, storage: resolve(this.config.downloadsDir, category, id, sanitizeFilename(releaseTitle(release))), error: '', createdAt: now, updatedAt: now,
    };
    this.store.saveJob(job);
    this.wake();
    return job;
  }

  wake(): void {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    const now = Date.now();
    let nextRetry = Infinity;
    for (const job of this.store.jobs()) {
      if (this.active.size >= this.config.concurrency) break;
      if (job.status !== 'Queued' || this.active.has(job.id)) continue;
      if (job.retryAt !== undefined && job.retryAt > now) {
        nextRetry = Math.min(nextRetry, job.retryAt);
        continue;
      }
      const controller = new AbortController();
      this.store.updateJob(job.id, { status: 'Downloading', error: '', retryAt: undefined });
      const task = this.run(job, controller.signal).finally(() => {
        this.active.delete(job.id);
        this.wake();
      });
      this.active.set(job.id, { controller, task });
    }
    if (nextRetry !== Infinity) this.retryTimer = setTimeout(() => this.wake(), nextRetry - now).unref();
  }

  private async run(job: Job, signal: AbortSignal): Promise<void> {
    try {
      const provider = this.providers.get(job.release.provider);
      if (!provider) throw new Error(`Provider is not enabled: ${job.release.provider}`);
      const sources = await provider.resolve(job.release, signal);
      signal.throwIfAborted();
      if (!sources.length) throw new Error('Provider returned no playable media');
      await mkdir(job.storage, { recursive: true });
      let lastUpdate = 0;
      const file = await this.download(sources, job.storage, releaseTitle(job.release), signal, progress => {
        if (Date.now() - lastUpdate < 500 || this.store.job(job.id)?.status !== 'Downloading') return;
        lastUpdate = Date.now();
        const update: Partial<Job> = { bytes: progress.bytes };
        if (progress.totalBytes !== undefined) update.totalBytes = progress.totalBytes;
        if (progress.progress !== undefined) update.progress = Math.max(0, Math.min(99, progress.progress));
        this.store.updateJob(job.id, update);
      });
      signal.throwIfAborted();
      const child = relative(job.storage, file);
      if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Downloader returned a path outside its job directory');
      if (this.store.job(job.id)?.status === 'Downloading') {
        const result = await stat(file);
        if (!result.isFile() || result.size === 0) throw new Error('Downloader produced no media file');
        this.store.updateJob(job.id, { status: 'Completed', progress: 100, bytes: result.size, totalBytes: result.size, error: '', finishedAt: Date.now() });
      }
    } catch (error) {
      const current = this.store.job(job.id);
      if (!signal.aborted && current?.status === 'Downloading') {
        const message = error instanceof Error ? error.message : String(error);
        const now = Date.now();
        const busySince = current.busySince ?? now;
        if (error instanceof PlaybackBusy && now - busySince < BUSY_GIVE_UP_MS) {
          // Still Queued for Sonarr, so it neither fails the download nor blocklists the Release.
          this.store.updateJob(job.id, { status: 'Queued', error: message, retryAt: now + BUSY_RETRY_MS, busySince });
        } else {
          this.store.updateJob(job.id, { status: 'Failed', error: message, finishedAt: now });
        }
      }
    }
  }

  async pause(id: string): Promise<void> {
    const job = this.requireJob(id);
    if (!['Queued', 'Downloading'].includes(job.status)) return;
    this.store.updateJob(id, { status: 'Paused' });
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error('Download paused'));
      await active.task;
    }
  }

  resume(id: string): void {
    const job = this.requireJob(id);
    if (job.status !== 'Paused') throw new Error('Only a paused job can be resumed');
    this.store.updateJob(id, { status: 'Queued' });
    this.wake();
  }

  retry(id: string): Job {
    const job = this.requireJob(id);
    if (job.status !== 'Failed') throw new Error('Only a failed job can be retried');
    const updated = this.store.updateJob(id, { status: 'Queued', error: '', progress: 0, finishedAt: undefined, retryAt: undefined, busySince: undefined })!;
    this.wake();
    return updated;
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const job = this.requireJob(id);
    this.store.updateJob(id, { status: 'Paused' });
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error('Download removed'));
      await active.task;
    }
    if (deleteFiles) {
      const expected = resolve(this.config.downloadsDir, job.category, job.id);
      const child = relative(expected, job.storage);
      if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('Refusing to remove a directory outside this job');
      await rm(expected, { recursive: true, force: true });
    }
    this.store.removeJob(id);
    this.wake();
  }

  private requireJob(id: string): Job {
    const job = this.store.job(id);
    if (!job) throw new Error('Unknown download ID');
    return job;
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    for (const [id, active] of this.active) {
      if (this.store.job(id)?.status === 'Downloading') this.store.updateJob(id, { status: 'Queued' });
      active.controller.abort(new Error('Service stopping'));
    }
    await Promise.all([...this.active.values()].map(active => active.task));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
