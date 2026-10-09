import { createHmac } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Queue } from './queue.ts';
import { Indexer } from './indexer.ts';
import { releaseTitle } from './providers/common.ts';
import type { Config, Job } from './types.ts';

/** qBittorrent 4.6: Sonarr and Radarr of every supported version understand its paused states. */
const WEB_API_VERSION = '2.9.3';
const APP_VERSION = 'v4.6.7';
/** qBittorrent's ETA for an unknown remaining time. */
const UNKNOWN_ETA = 8640000;

export interface QBittorrentResponse {
  code?: number;
  /** Plain text, or a value sent as JSON. */
  body: string | object;
}

/** The `SID` cookie value a successful login issues; derived from the API key, so it survives restarts. */
export function sessionId(config: Config): string {
  return createHmac('sha256', config.apiKey).update('qbittorrent-session').digest('hex');
}

/** The qBittorrent Web API v2 subset Sonarr and Radarr use, backed by the Job queue. */
export class QBittorrent {
  private readonly config: Config;
  private readonly queue: Queue;
  private readonly indexer: Indexer;

  constructor(config: Config, queue: Queue, indexer: Indexer) {
    this.config = config;
    this.queue = queue;
    this.indexer = indexer;
  }

  /** Handles `/api/v2/<endpoint>` for an authenticated client; `torrents` are uploaded .torrent files. */
  async handle(endpoint: string, params: Record<string, string>, torrents: Buffer[] = []): Promise<QBittorrentResponse> {
    const store = this.queue.store;
    switch (endpoint) {
      case 'app/webapiVersion': return { body: WEB_API_VERSION };
      case 'app/version': return { body: APP_VERSION };
      case 'app/preferences': return { body: {
        save_path: this.config.downloadsDir,
        // Nothing is seeded; each torrent carries its own reached ratio limit instead (see `torrent`).
        max_ratio_enabled: false, max_ratio: -1, max_seeding_time_enabled: false, max_seeding_time: -1,
        max_inactive_seeding_time_enabled: false, max_inactive_seeding_time: -1, max_ratio_act: 0,
        queueing_enabled: false, dht: false,
      } };
      case 'torrents/categories': return { body: Object.fromEntries(this.config.categories.map(category =>
        [category, { name: category, savePath: resolve(this.config.downloadsDir, category) }])) };
      case 'torrents/createCategory':
        if (this.config.categories.includes(params.category || '')) return { body: '' };
        return { code: 409, body: `Add the category to "categories" in the Bohemarr configuration: ${params.category || '(missing)'}` };
      case 'torrents/info': {
        const hashes = this.hashes(params.hashes);
        const jobs = store.jobs()
          .filter(job => params.category === undefined || job.category === params.category)
          .filter(job => !hashes || hashes.has(job.id));
        return { body: jobs.map(job => this.torrent(job)) };
      }
      case 'torrents/properties': {
        const job = store.job((params.hash || '').toLowerCase());
        if (!job) return { code: 404, body: 'Not Found' };
        return { body: { hash: job.id, save_path: dirname(job.storage), seeding_time: 0, total_size: job.totalBytes,
          addition_date: seconds(job.createdAt), completion_date: job.status === 'Completed' ? seconds(job.finishedAt!) : -1 } };
      }
      case 'torrents/add': {
        if (!torrents.length) return { code: 415, body: 'Upload a task torrent from this Bohemarr instance; URLs and magnet links are not supported' };
        const paused = params.paused === 'true' || params.stopped === 'true';
        // Parse every upload before queueing any, so a rejected file adds nothing.
        const tasks = torrents.map(content => this.indexer.parseTaskDescriptor(content));
        for (const { release, infoHash } of tasks) {
          this.queue.add(infoHash, release, params.category || (release.kind === 'movie' ? 'movies' : 'tv'), paused);
        }
        return { body: 'Ok.' };
      }
      case 'torrents/delete':
        for (const job of this.select(params.hashes)) await this.queue.remove(job.id, params.deleteFiles === 'true');
        return { body: '' };
      case 'torrents/pause':
      case 'torrents/stop':
        for (const job of this.select(params.hashes)) await this.queue.pause(job.id);
        return { body: '' };
      case 'torrents/resume':
      case 'torrents/start':
        for (const job of this.select(params.hashes)) if (job.status === 'Paused') this.queue.resume(job.id);
        return { body: '' };
      case 'torrents/topPrio':
        // qBittorrent's answer while torrent queueing is disabled, which Sonarr and Radarr accept.
        return { code: 409, body: 'Torrent queueing must be enabled' };
      default:
        return { code: 404, body: 'Not Found' };
    }
  }

  /** The `|`-separated hashes of a request, or undefined for `all` or none. */
  private hashes(value: string | undefined): Set<string> | undefined {
    if (value === undefined || value === 'all') return undefined;
    return new Set(value.split('|').map(hash => hash.toLowerCase()));
  }

  /** The Jobs a hashes parameter names; unknown hashes are ignored, as qBittorrent does. */
  private select(value: string | undefined): Job[] {
    if (value === undefined) return [];
    const hashes = this.hashes(value);
    return this.queue.store.jobs().filter(job => !hashes || hashes.has(job.id));
  }

  private torrent(job: Job): object {
    const completed = job.status === 'Completed';
    const size = completed ? job.bytes : job.totalBytes;
    const progress = completed ? 1 : Math.max(0, Math.min(0.99, job.progress / 100));
    return {
      hash: job.id, name: releaseTitle(job.release), category: job.category,
      state: { Queued: 'queuedDL', Downloading: 'downloading', Paused: 'pausedDL', Completed: 'pausedUP', Failed: 'error' }[job.status],
      size, total_size: size, progress, amount_left: Math.max(0, Math.round(size * (1 - progress))),
      dlspeed: 0, upspeed: 0, eta: completed ? 0 : UNKNOWN_ETA,
      // A completed Job is a finished torrent in its own folder below the category save path.
      save_path: dirname(job.storage), content_path: job.storage,
      // Nothing is seeded, so the seeding goal is reached on completion. Sonarr and Radarr then move and
      // remove a completed download when "Remove Completed" is enabled, and copy or hardlink it otherwise.
      ratio: 0, ratio_limit: 0, seeding_time: 0, seeding_time_limit: -2, inactive_seeding_time_limit: -2,
      added_on: seconds(job.createdAt), completion_on: completed ? seconds(job.finishedAt!) : -1,
      last_activity: seconds(job.updatedAt),
    };
  }
}

function seconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}
