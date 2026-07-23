import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
export const DOCUMENTS_DIR = path.join(DATA_DIR, "documents");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('applied','oa','interview','pending','rejected','accepted')),
  interview_round INTEGER,
  oa_score TEXT,
  pre_notes TEXT NOT NULL DEFAULT '',
  post_notes TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_status_events_job ON status_events(job_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_event_id INTEGER NOT NULL REFERENCES status_events(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  duration_sec REAL,
  state TEXT NOT NULL DEFAULT 'recording' CHECK (state IN ('recording','done','failed'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('resume','cover_letter')),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS postings (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  title TEXT,
  company TEXT,
  location TEXT,
  description_md TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'parsed' CHECK (source IN ('parsed','manual')),
  fetch_status TEXT NOT NULL DEFAULT 'ok' CHECK (fetch_status IN ('ok','failed')),
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// Singleton across Next.js hot reloads (dev server re-evaluates modules).
const globalForDb = globalThis as unknown as { __jobmanagerDb?: Database.Database };

function open(): Database.Database {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "app.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Migration: resume/cover-letter links on jobs (added after initial release).
  const jobCols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
  if (!jobCols.includes("resume_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN resume_id INTEGER REFERENCES documents(id) ON DELETE SET NULL");
  }
  if (!jobCols.includes("cover_letter_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN cover_letter_id INTEGER REFERENCES documents(id) ON DELETE SET NULL");
  }
  // Sweep recordings orphaned by a server restart mid-recording.
  db.prepare("UPDATE recordings SET state = 'failed' WHERE state = 'recording'").run();
  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb.__jobmanagerDb) globalForDb.__jobmanagerDb = open();
  return globalForDb.__jobmanagerDb;
}
