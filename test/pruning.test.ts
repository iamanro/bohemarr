import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import { SeriesFeed } from '../src/series-feed.ts';
import { createStreamCzProvider } from '../src/providers/czech-public-streamcz.ts';
import type { Release } from '../src/types.ts';

const DAY = 24 * 60 * 60_000;
const release = (id: string): Release => ({ id, provider: 'direct', title: id, url: `https://example.test/${id}`, kind: 'movie' });

test('a search result not seen for 90 days is forgotten at the next start, a fresh one is kept', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-prune-'));
  const path = join(directory.path, 'bohemarr.sqlite');
  {
    using store = new Store(path);
    store.saveReleases([release('old'), release('fresh')]);
    store.database.prepare('UPDATE releases SET saved_at = ? WHERE id = ?').run(Date.now() - 91 * DAY, 'old');
  }
  using store = new Store(path);
  assert.equal(store.release('old'), undefined);
  assert.equal(store.release('fresh')?.id, 'fresh');
});

test('expired cache rows are removed when their module starts', () => {
  using db = new DatabaseSync(':memory:');
  const now = 1_000_000_000_000;
  const clock = () => now;
  const count = (table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

  const bindings = new SeriesBindings(
    db,
    async () => {
      throw new Error('offline');
    },
    clock,
  );
  db.prepare('INSERT INTO series_release_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'p',
    'prog',
    1,
    1,
    1,
    0,
    5,
    now - 7 * 60 * 60_000,
    '[]',
  );
  new SeriesFeed(db, bindings, new Map(), clock);
  db.prepare('INSERT INTO release_first_seen VALUES (?, ?)').run('stale', now - 91 * DAY);
  db.prepare('INSERT INTO release_first_seen VALUES (?, ?)').run('recent', now - DAY);
  createStreamCzProvider({}, db, { now: clock });
  db.prepare('INSERT INTO stream_episode_cache VALUES (?, ?, ?)').run('stale', now - 10 * 60_000, '[]');

  // The next start of each module sweeps what has expired.
  new SeriesBindings(
    db,
    async () => {
      throw new Error('offline');
    },
    clock,
  );
  new SeriesFeed(db, bindings, new Map(), clock);
  createStreamCzProvider({}, db, { now: clock });
  assert.equal(count('series_release_cache'), 0, 'a six-hour-old exact episode cache entry is gone');
  assert.deepEqual(
    db
      .prepare('SELECT release_id FROM release_first_seen')
      .all()
      .map(row => row.release_id),
    ['recent'],
  );
  assert.equal(count('stream_episode_cache'), 0, 'a ten-minute-old Stream.cz episode listing is gone');
});
