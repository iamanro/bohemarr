import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import type { Job, Release } from './types.ts';

const DATABASE_FILE = 'bohemarr.sqlite';
/** The file name used before the project was named Bohemarr. */
const LEGACY_DATABASE_FILE = 'media-downloader.sqlite';

/**
 * The SQLite database path inside `dataDir`. A database left by an installation from before the
 * rename (with its WAL/SHM companions) is moved into place once, so queue history and Series
 * bindings survive the upgrade.
 */
export async function databasePath(dataDir: string): Promise<string> {
  const path = join(dataDir, DATABASE_FILE);
  const legacy = join(dataDir, LEGACY_DATABASE_FILE);
  if (!existsSync(path) && existsSync(legacy)) {
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(legacy + suffix)) await rename(legacy + suffix, path + suffix);
    }
    await rename(legacy, path);
  }
  return path;
}

/** Ordered one-time rewrites of stored payloads; `settings.schema_version` counts those applied. */
const MIGRATIONS: readonly string[] = [
  // `sourceSeriesId` became `programId`.
  `UPDATE releases SET payload = json_remove(json_set(payload, '$.programId', payload -> '$.sourceSeriesId'), '$.sourceSeriesId')
     WHERE json_type(payload, '$.sourceSeriesId') IS NOT NULL;
   UPDATE jobs SET payload = json_remove(json_set(payload, '$.release.programId', payload -> '$.release.sourceSeriesId'), '$.release.sourceSeriesId')
     WHERE json_type(payload, '$.release.sourceSeriesId') IS NOT NULL;`,
  // The SABnzbd interface gave way to qBittorrent's, which has neither a global pause nor job priorities:
  // a global pause becomes a pause of each job it held back, and priorities are dropped.
  `UPDATE jobs SET payload = json_set(payload, '$.status', 'Paused')
     WHERE (SELECT value FROM settings WHERE key = 'paused') = 'true'
       AND payload ->> '$.status' IN ('Queued', 'Downloading') AND coalesce(payload ->> '$.priority', 0) <> 2;
   UPDATE jobs SET payload = json_remove(payload, '$.priority');
   DELETE FROM settings WHERE key = 'paused';`,
  // Imports can outlive their Job (Sonarr and Radarr remove completed downloads), so each Job's Release is kept.
  `INSERT OR IGNORE INTO job_releases SELECT id, payload -> '$.release' FROM jobs;`,
];

export class Store {
  private readonly db: DatabaseSync;
  private readonly insertRelease: StatementSync;
  private readonly selectRelease: StatementSync;
  private readonly selectJobs: StatementSync;
  private readonly selectJob: StatementSync;
  private readonly insertJob: StatementSync;
  private readonly deleteJob: StatementSync;
  private readonly insertJobRelease: StatementSync;
  private readonly selectJobRelease: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_releases (job_id TEXT PRIMARY KEY, release TEXT NOT NULL);`);
    this.migrate();
    this.insertRelease = this.db.prepare('INSERT INTO releases VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    this.selectRelease = this.db.prepare('SELECT payload FROM releases WHERE id=?');
    this.selectJobs = this.db.prepare('SELECT payload FROM jobs');
    this.selectJob = this.db.prepare('SELECT payload FROM jobs WHERE id=?');
    this.insertJob = this.db.prepare('INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    this.deleteJob = this.db.prepare('DELETE FROM jobs WHERE id=?');
    this.insertJobRelease = this.db.prepare('INSERT OR IGNORE INTO job_releases VALUES (?, ?)');
    this.selectJobRelease = this.db.prepare('SELECT release FROM job_releases WHERE job_id=?');
  }

  /** The shared connection, for modules that own their own tables (e.g. Series bindings). */
  get database(): DatabaseSync {
    return this.db;
  }

  private migrate(): void {
    const applied = Number(this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value ?? 0);
    for (let version = applied; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.prepare("INSERT INTO settings VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(version + 1));
      });
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveReleases(releases: Release[]): void {
    this.transaction(() => {
      for (const release of releases) this.insertRelease.run(release.id, JSON.stringify(release));
    });
  }

  release(id: string): Release | undefined {
    const row = this.selectRelease.get(id);
    return row ? JSON.parse(String(row.payload)) as Release : undefined;
  }

  jobs(): Job[] {
    return this.selectJobs.all().map(row => JSON.parse(String(row.payload)) as Job)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  job(id: string): Job | undefined {
    const row = this.selectJob.get(id);
    return row ? JSON.parse(String(row.payload)) as Job : undefined;
  }

  saveJob(job: Job): void {
    this.insertJob.run(job.id, JSON.stringify(job));
    this.insertJobRelease.run(job.id, JSON.stringify(job.release));
  }

  /** The Release a Job downloaded, also after the Job itself was removed. */
  jobRelease(id: string): Release | undefined {
    const row = this.selectJobRelease.get(id);
    return row ? JSON.parse(String(row.release)) as Release : undefined;
  }

  updateJob(id: string, update: Partial<Job>): Job | undefined {
    const job = this.job(id);
    if (!job) return undefined;
    const updated = { ...job, ...update, id, updatedAt: Date.now() };
    this.saveJob(updated);
    return updated;
  }

  removeJob(id: string): void {
    this.deleteJob.run(id);
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    if (this.db.isOpen) this.db.close();
  }
}
