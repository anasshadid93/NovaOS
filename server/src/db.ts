import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     pw_hash TEXT NOT NULL,
     totp_secret TEXT NOT NULL,
     totp_last_step INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE credentials (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     public_key BLOB NOT NULL,
     counter INTEGER NOT NULL DEFAULT 0,
     transports TEXT,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     method TEXT NOT NULL,
     user_agent TEXT,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     user_id INTEGER,
     action TEXT NOT NULL,
     detail TEXT
   );
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE metrics_minute (
     ts INTEGER PRIMARY KEY,
     cpu REAL, mem_used REAL, mem_cache REAL, swap_used REAL,
     gpu REAL, gpu_mem REAL, temp_cpu REAL, temp_gpu REAL, load1 REAL
   );`,
  `ALTER TABLE sessions ADD COLUMN elevated_until INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE INDEX audit_ts ON audit(ts);`,
  `CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     app_id TEXT,
     params TEXT,
     status TEXT NOT NULL DEFAULT 'queued',
     progress TEXT,
     log TEXT NOT NULL DEFAULT '',
     error TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX tasks_status ON tasks(status, id);
   CREATE TABLE apps (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     icon TEXT,
     source TEXT NOT NULL,
     catalog TEXT NOT NULL,
     web_port INTEGER,
     web_path TEXT,
     ts_port INTEGER,
     images TEXT,
     prev_images TEXT,
     status TEXT NOT NULL,
     installed_at INTEGER NOT NULL,
     updated_at INTEGER
   );
   CREATE TABLE ports (
     port INTEGER PRIMARY KEY,
     app_id TEXT NOT NULL,
     service TEXT NOT NULL,
     target INTEGER NOT NULL,
     protocol TEXT NOT NULL DEFAULT 'tcp'
   );
   CREATE TABLE launcher (
     key TEXT PRIMARY KEY,
     position INTEGER NOT NULL,
     hidden INTEGER NOT NULL DEFAULT 0,
     opens INTEGER NOT NULL DEFAULT 0,
     last_opened_at INTEGER
   );`,
  `CREATE TABLE trash (
     id TEXT PRIMARY KEY,
     orig_path TEXT NOT NULL,
     name TEXT NOT NULL,
     is_dir INTEGER NOT NULL,
     size INTEGER NOT NULL DEFAULT 0,
     deleted_at INTEGER NOT NULL
   );`,
  `CREATE TABLE media_meta (
     path TEXT PRIMARY KEY,
     mtime REAL NOT NULL,
     taken INTEGER
   );`,
  // Desktop lock screen: a PIN per user, a locked flag per session.
  `ALTER TABLE users ADD COLUMN pin_hash TEXT;
   ALTER TABLE sessions ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE disk_health (
     disk TEXT NOT NULL,
     ts INTEGER NOT NULL,
     status TEXT NOT NULL,
     temperature REAL,
     counters TEXT NOT NULL
   );
   CREATE INDEX disk_health_disk ON disk_health(disk, ts);`,
  `CREATE TABLE audio_meta (
     path TEXT PRIMARY KEY,
     mtime REAL NOT NULL,
     title TEXT, artist TEXT, album TEXT, track INTEGER, duration INTEGER, cover INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE playlists (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     items TEXT NOT NULL DEFAULT '[]',
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE media_progress (
     path TEXT PRIMARY KEY,
     position REAL NOT NULL,
     duration REAL NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  `CREATE TABLE shares (
     id INTEGER PRIMARY KEY,
     token TEXT NOT NULL UNIQUE,
     path TEXT NOT NULL,
     is_dir INTEGER NOT NULL,
     password_hash TEXT,
     expires_at INTEGER,
     views INTEGER NOT NULL DEFAULT 0,
     downloads INTEGER NOT NULL DEFAULT 0,
     last_access INTEGER,
     created_by INTEGER,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE downloads (
     id INTEGER PRIMARY KEY,
     url TEXT NOT NULL,
     audio INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     progress TEXT,
     title TEXT,
     path TEXT,
     size INTEGER,
     share_url TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     finished_at INTEGER
   );`,
  `CREATE TABLE bot_actions (
     token TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     target TEXT NOT NULL,
     action TEXT NOT NULL,
     status TEXT NOT NULL,
     result TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
  `CREATE TABLE reminders (
     id INTEGER PRIMARY KEY,
     text TEXT NOT NULL,
     due_at INTEGER NOT NULL,
     repeat TEXT NOT NULL DEFAULT 'none',
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX reminders_due ON reminders(status, due_at);
   CREATE TABLE notes_bot (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     done_at INTEGER
   );
   CREATE TABLE price_alerts (
     id INTEGER PRIMARY KEY,
     asset TEXT NOT NULL,
     op TEXT NOT NULL,
     value REAL NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     fired_at INTEGER
   );`,
  `CREATE TABLE bot_memory (
     id INTEGER PRIMARY KEY,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // Telegram Business: the owner's private chats that he lets the bot see (bot/business.ts).
  `CREATE TABLE biz_connections (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     enabled INTEGER NOT NULL,
     can_reply INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE biz_chats (
     chat_id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     username TEXT,
     connection_id TEXT,
     last_in_at INTEGER,
     last_in_text TEXT,
     last_out_at INTEGER,
     waiting_since INTEGER,
     reminded_at INTEGER,
     muted INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE biz_messages (
     chat_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     from_me INTEGER NOT NULL,
     text TEXT NOT NULL,
     at INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (chat_id, message_id)
   );
   CREATE INDEX biz_messages_at ON biz_messages(at);`,
  `CREATE TABLE drops (
     id INTEGER PRIMARY KEY,
     token TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     dir TEXT NOT NULL,
     password_hash TEXT,
     expires_at INTEGER,
     max_bytes INTEGER NOT NULL,
     quota_bytes INTEGER NOT NULL,
     max_files INTEGER NOT NULL,
     allow_exec INTEGER NOT NULL DEFAULT 0,
     disabled INTEGER NOT NULL DEFAULT 0,
     files INTEGER NOT NULL DEFAULT 0,
     bytes INTEGER NOT NULL DEFAULT 0,
     last_upload INTEGER,
     created_by INTEGER,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE drop_files (
     id INTEGER PRIMARY KEY,
     drop_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     size INTEGER NOT NULL,
     ip TEXT,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE video_download_jobs (
     id INTEGER PRIMARY KEY,
     url TEXT NOT NULL,
     title TEXT NOT NULL,
     library TEXT NOT NULL,
     season INTEGER NOT NULL DEFAULT 1,
     quality TEXT NOT NULL,
     subtitles INTEGER NOT NULL DEFAULT 1,
     range_start INTEGER,
     range_end INTEGER,
     status TEXT NOT NULL DEFAULT 'queued',
     progress TEXT,
     output_dir TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX video_download_jobs_status ON video_download_jobs(status, id);
   CREATE TABLE video_download_items (
     id INTEGER PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES video_download_jobs(id) ON DELETE CASCADE,
     source_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     title TEXT NOT NULL,
     duration INTEGER,
     status TEXT NOT NULL DEFAULT 'queued',
     progress TEXT,
     path TEXT,
     size INTEGER,
     error TEXT,
     UNIQUE(job_id, source_id)
   );
   CREATE INDEX video_download_items_job ON video_download_items(job_id, position);`,
  `ALTER TABLE video_download_items ADD COLUMN source_position INTEGER;
   UPDATE video_download_items SET source_position = position WHERE source_position IS NULL;`,
  // Prices: tracked PC parts (RAM, SSD/HDD, GPUs) and their daily quotes per store.
  `CREATE TABLE price_products (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     store TEXT NOT NULL,
     ext_id TEXT NOT NULL,
     title TEXT NOT NULL,
     category TEXT NOT NULL,
     url TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'seed',
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     UNIQUE(store, ext_id)
   );
   CREATE TABLE price_points (
     product_id INTEGER NOT NULL REFERENCES price_products(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     price REAL,
     currency TEXT NOT NULL,
     in_stock INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY(product_id, at)
   );
   CREATE INDEX price_points_at ON price_points(product_id, at);`,
];

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path.join(config.dataDir, 'manar.db'));
  // busy_timeout: another writer (a backup, a maintenance script) makes a write wait instead of throwing "database is locked".
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function kvGet(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(key: string, value: string): void {
  getDb().prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function audit(userId: number | null, action: string, detail?: unknown): void {
  getDb()
    .prepare('INSERT INTO audit(ts, user_id, action, detail) VALUES(?, ?, ?, ?)')
    .run(Date.now(), userId, action, detail === undefined ? null : JSON.stringify(detail));
}
