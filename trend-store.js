const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const STEP_SECONDS = 300;

class TrendStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trend_samples (
        cluster_key TEXT NOT NULL,
        sampled_at INTEGER NOT NULL,
        xpu_avg REAL,
        memory_avg REAL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (cluster_key, sampled_at)
      );
      CREATE TABLE IF NOT EXISTS trend_windows (
        cluster_key TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (cluster_key, start_at, end_at)
      );
      CREATE INDEX IF NOT EXISTS trend_samples_range ON trend_samples (cluster_key, sampled_at);
      CREATE TABLE IF NOT EXISTS lock_trend_days (
        scope_key TEXT NOT NULL,
        day_start_at INTEGER NOT NULL,
        total_cards INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, day_start_at)
      );
      CREATE TABLE IF NOT EXISTS lock_trend_samples (
        scope_key TEXT NOT NULL,
        sampled_at INTEGER NOT NULL,
        locked_cards INTEGER NOT NULL,
        PRIMARY KEY (scope_key, sampled_at)
      );
      CREATE INDEX IF NOT EXISTS lock_trend_samples_range ON lock_trend_samples (scope_key, sampled_at);
    `);
    this.upsertSample = this.db.prepare(`
      INSERT INTO trend_samples (cluster_key, sampled_at, xpu_avg, memory_avg, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cluster_key, sampled_at) DO UPDATE SET
        xpu_avg = excluded.xpu_avg,
        memory_avg = excluded.memory_avg,
        updated_at = excluded.updated_at
    `);
    this.upsertWindow = this.db.prepare(`
      INSERT INTO trend_windows (cluster_key, start_at, end_at, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cluster_key, start_at, end_at) DO UPDATE SET fetched_at = excluded.fetched_at
    `);
    this.readSamples = this.db.prepare(`
      SELECT sampled_at, xpu_avg, memory_avg
      FROM trend_samples
      WHERE cluster_key = ? AND sampled_at >= ? AND sampled_at <= ?
      ORDER BY sampled_at
    `);
    this.readWindows = this.db.prepare(`
      SELECT start_at, end_at FROM trend_windows
      WHERE cluster_key = ? AND end_at >= ? AND start_at <= ?
      ORDER BY start_at
    `);
    this.readLockDay = this.db.prepare(`
      SELECT day_start_at, total_cards FROM lock_trend_days WHERE scope_key = ? AND day_start_at = ?
    `);
    this.readLockSamples = this.db.prepare(`
      SELECT sampled_at, locked_cards FROM lock_trend_samples
      WHERE scope_key = ? AND sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at
    `);
    this.upsertLockDay = this.db.prepare(`
      INSERT INTO lock_trend_days (scope_key, day_start_at, total_cards, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key, day_start_at) DO UPDATE SET total_cards = excluded.total_cards, fetched_at = excluded.fetched_at
    `);
    this.upsertLockSample = this.db.prepare(`
      INSERT INTO lock_trend_samples (scope_key, sampled_at, locked_cards) VALUES (?, ?, ?)
      ON CONFLICT(scope_key, sampled_at) DO UPDATE SET locked_cards = excluded.locked_cards
    `);
  }

  missingWindows(clusterKey, startAt, endAt) {
    const windows = this.readWindows.all(clusterKey, startAt, endAt);
    const missing = [];
    let cursor = startAt;
    for (const window of windows) {
      if (window.start_at > cursor) missing.push([cursor, Math.min(endAt, window.start_at - STEP_SECONDS)]);
      cursor = Math.max(cursor, window.end_at + STEP_SECONDS);
    }
    if (cursor <= endAt) missing.push([cursor, endAt]);
    return mergeWindows(missing);
  }

  saveWindow(clusterKey, startAt, endAt, samples) {
    const updatedAt = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN');
    try {
      for (const sample of samples) this.upsertSample.run(clusterKey, sample.sampledAt, sample.xpu, sample.memory, updatedAt);
      this.upsertWindow.run(clusterKey, startAt, endAt, updatedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  readRange(clusterKey, startAt, endAt) {
    return this.readSamples.all(clusterKey, startAt, endAt);
  }

  hasLockDay(scopeKey, dayStartAt) {
    return this.readLockDay.get(scopeKey, dayStartAt);
  }

  saveLockDay(scopeKey, dayStartAt, totalCards, samples) {
    this.db.exec('BEGIN');
    try {
      this.upsertLockDay.run(scopeKey, dayStartAt, totalCards, Math.floor(Date.now() / 1000));
      for (const sample of samples) this.upsertLockSample.run(scopeKey, sample.sampledAt, sample.lockedCards);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  readLockRange(scopeKey, startAt, endAt) {
    return this.readLockSamples.all(scopeKey, startAt, endAt);
  }
}


function mergeWindows(windows) {
  return windows.filter(([start, end]) => start <= end).sort((a, b) => a[0] - b[0]).reduce((merged, [start, end]) => {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + STEP_SECONDS) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
    return merged;
  }, []);
}

module.exports = { TrendStore, STEP_SECONDS };
