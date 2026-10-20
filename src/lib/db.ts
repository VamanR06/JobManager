import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { analyzeUrl } from "./urls";

// Overridable so tests and tools can point at a scratch copy of the database.
export const DATA_DIR = process.env.JOBMANAGER_DATA_DIR
  ? path.resolve(process.env.JOBMANAGER_DATA_DIR)
  : path.join(process.cwd(), "data");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
export const DOCUMENTS_DIR = path.join(DATA_DIR, "documents");
/** Immutable, hashed resume artifacts produced by the automation worker. */
export const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
/**
 * Private per-attempt directories for Codex runs. Deliberately outside this
 * repository, so Codex never treats the app repo (or its trust settings and
 * AGENTS.md) as the workspace of a resume job.
 */
export const WORK_DIR = process.env.JOBMANAGER_WORK_ROOT
  ? path.resolve(process.env.JOBMANAGER_WORK_ROOT)
  : process.env.JOBMANAGER_DATA_DIR
    ? path.join(DATA_DIR, "work")
    : path.join(os.homedir(), ".jobmanager", "work");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");

/**
 * Which process opened the DB. Only the web server ("web", the default) sweeps
 * orphaned generations/recordings on startup — the worker and CLI tools must not,
 * or they'd fail a generation the running server is still waiting on.
 */
const ROLE = process.env.JOBMANAGER_ROLE ?? "web";

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
  status TEXT NOT NULL CHECK (status IN ('to_apply','applied','oa','interview','pending','rejected','accepted')),
  interview_round INTEGER,
  oa_score TEXT,
  oa_sent_at TEXT,
  oa_submitted_at TEXT,
  oa_deadline_at TEXT,
  oa_link TEXT,
  interview_offered_at TEXT,
  interview_held_at TEXT,
  interview_link TEXT,
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

CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  input_md TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_generations_created ON generations(created_at DESC, id DESC);

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
  // The web server and the worker share this file; wait on locks rather than failing.
  db.pragma("busy_timeout = 5000");
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
  // Migration: archived flag — in-use documents are archived on "delete" so
  // applications always keep the exact file they were submitted with.
  const docCols = (db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((c) => c.name);
  if (!docCols.includes("archived")) {
    db.exec("ALTER TABLE documents ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  // Migration: milestone dates on OA/interview events (sent/submitted, offered/held).
  const evCols = (db.prepare("PRAGMA table_info(status_events)").all() as { name: string }[]).map((c) => c.name);
  for (const col of [
    "oa_sent_at", "oa_submitted_at", "oa_deadline_at", "oa_link",
    "interview_offered_at", "interview_held_at", "interview_link",
  ]) {
    if (!evCols.includes(col)) db.exec(`ALTER TABLE status_events ADD COLUMN ${col} TEXT`);
  }
  // Migration: mark documents produced by the resume generator, and remember
  // which posting they were tailored from.
  if (!docCols.includes("generated")) {
    db.exec("ALTER TABLE documents ADD COLUMN generated INTEGER NOT NULL DEFAULT 0");
  }
  if (!docCols.includes("source_job_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN source_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL");
  }
  // The ChatGPT conversation a generated resume came from, so it can be revised
  // in context rather than regenerated from scratch.
  if (!docCols.includes("thread_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN thread_id TEXT");
  }
  runVersionedMigrations(db);
  if (ROLE === "web") {
    // Sweep generations orphaned by a server restart mid-request.
    db.prepare("UPDATE generations SET state = 'failed', error = 'Interrupted by server restart' WHERE state = 'pending'").run();
    // Sweep recordings orphaned by a server restart mid-recording.
    db.prepare("UPDATE recordings SET state = 'failed' WHERE state = 'recording'").run();
  }
  return db;
}

// ---------- versioned migrations (PRAGMA user_version) ----------
//
// Everything above predates versioning and stays as idempotent column checks.
// New schema goes here as numbered, additive steps. Before applying any, the
// database is backed up with VACUUM INTO, which is SQLite-aware (it includes
// committed WAL content, unlike copying app.db alone).

const MIGRATIONS: { version: number; name: string; foreignKeysOff?: boolean; up: (db: Database.Database) => void }[] = [
  {
    version: 1,
    name: "application automation: import, queue, snapshots, Codex runs, artifacts, profile",
    up(db) {
      db.exec(`
        -- Workflow state is separate from recruiting outcomes (status_events).
        -- NULL workflow_state = a manually tracked job the automation never touched.
        ALTER TABLE jobs ADD COLUMN ats TEXT;
        ALTER TABLE jobs ADD COLUMN ats_tenant TEXT;
        ALTER TABLE jobs ADD COLUMN posting_id TEXT;
        ALTER TABLE jobs ADD COLUMN posting_key TEXT;
        ALTER TABLE jobs ADD COLUMN application_url TEXT;
        ALTER TABLE jobs ADD COLUMN workflow_state TEXT;
        ALTER TABLE jobs ADD COLUMN workflow_detail TEXT;
        ALTER TABLE jobs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN submitted_at TEXT;
        CREATE INDEX idx_jobs_posting_key ON jobs(posting_key);
        CREATE INDEX idx_jobs_workflow ON jobs(workflow_state);

        -- Dated, hashed copies of each extracted description.
        CREATE TABLE job_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          source_url TEXT NOT NULL,
          final_url TEXT,
          canonical_url TEXT,
          application_url TEXT,
          title TEXT,
          company TEXT,
          location TEXT,
          employment_type TEXT,
          posting_id TEXT,
          description_md TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          method TEXT NOT NULL,
          captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_job_snapshots_job ON job_snapshots(job_id, id);

        -- Durable queue. A task is claimed by setting a lease; an expired lease
        -- lets another worker reclaim it (except submission, which reconciles).
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          step TEXT NOT NULL,
          resource TEXT NOT NULL DEFAULT 'local',
          state TEXT NOT NULL DEFAULT 'queued'
            CHECK (state IN ('queued','running','blocked','done','failed','cancelled')),
          payload TEXT NOT NULL DEFAULT '{}',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          run_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          lease_owner TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        -- At most one live task per application.
        CREATE UNIQUE INDEX idx_tasks_one_active ON tasks(job_id) WHERE state IN ('queued','running','blocked');
        CREATE INDEX idx_tasks_claim ON tasks(state, run_after, id);

        CREATE TABLE workflow_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          type TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_workflow_events_job ON workflow_events(job_id, id);

        CREATE TABLE codex_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          purpose TEXT NOT NULL,
          work_dir TEXT NOT NULL,
          plugin_ref TEXT,
          plugin_version TEXT,
          plugin_resource_hash TEXT,
          cli_version TEXT,
          model TEXT,
          owner TEXT,
          pid INTEGER,
          proc_start TEXT,
          session_id TEXT,
          state TEXT NOT NULL DEFAULT 'starting'
            CHECK (state IN ('starting','running','exited','abandoned')),
          outcome TEXT,
          exit_code INTEGER,
          exit_signal TEXT,
          blockers TEXT NOT NULL DEFAULT '[]',
          evidence TEXT NOT NULL DEFAULT '{}',
          usage TEXT,
          event_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT
        );
        CREATE INDEX idx_codex_runs_job ON codex_runs(job_id, id);

        CREATE TABLE resume_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          codex_run_id INTEGER REFERENCES codex_runs(id) ON DELETE SET NULL,
          snapshot_id INTEGER REFERENCES job_snapshots(id) ON DELETE SET NULL,
          version INTEGER NOT NULL,
          pdf_path TEXT NOT NULL,
          tex_path TEXT NOT NULL,
          report_path TEXT,
          pdf_sha256 TEXT NOT NULL,
          tex_sha256 TEXT NOT NULL,
          page_count INTEGER,
          plugin_version TEXT,
          plugin_resource_hash TEXT,
          checks TEXT NOT NULL DEFAULT '[]',
          summary TEXT NOT NULL DEFAULT '',
          feedback TEXT,
          status TEXT NOT NULL DEFAULT 'pending_review'
            CHECK (status IN ('pending_review','approved','rejected','superseded')),
          document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (job_id, version)
        );

        -- User-confirmed facts only. Never inferred from resume wording.
        CREATE TABLE profile_facts (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          verified_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);
      // Backfill dedup keys so imports recognise applications added by hand.
      const rows = db.prepare("SELECT id, url FROM jobs WHERE url IS NOT NULL AND url != ''").all() as {
        id: number; url: string;
      }[];
      const set = db.prepare("UPDATE jobs SET posting_key = ?, ats = ?, ats_tenant = ?, posting_id = ? WHERE id = ?");
      for (const row of rows) {
        const info = analyzeUrl(row.url);
        if (info.ok) set.run(info.key, info.ats, info.tenant, info.postingId, row.id);
      }
    },
  },
  {
    version: 2,
    name: "resume engine choice (Codex or Claude Code) + app settings",
    up(db) {
      db.exec(`
        -- codex_runs keeps its name for compatibility; it now records runs of either CLI.
        ALTER TABLE codex_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex';
        ALTER TABLE resume_artifacts ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex';
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);
    },
  },
  {
    version: 3,
    name: "application forms: scanned fields and a scoped answer bank",
    up(db) {
      db.exec(`
        -- Reusable answers. Scope decides reuse: global (any job), company, or job only.
        -- question_norm has the company name replaced by {company} so global
        -- answers like "How did you hear about {company}?" carry over.
        CREATE TABLE answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question_norm TEXT NOT NULL,
          question_text TEXT NOT NULL,
          options_sig TEXT NOT NULL DEFAULT '',
          answer TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('global','company','job')),
          company_key TEXT,
          job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE UNIQUE INDEX idx_answers_unique
          ON answers(question_norm, options_sig, scope, COALESCE(company_key, ''), COALESCE(job_id, 0));

        -- The latest scan of a job's application form, one row per field, with
        -- how it was resolved and what the page showed on read-back.
        CREATE TABLE application_fields (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          field_key TEXT NOT NULL,
          label TEXT NOT NULL,
          kind TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 0,
          options TEXT NOT NULL DEFAULT '[]',
          category TEXT NOT NULL,
          answer TEXT,
          answer_source TEXT,
          status TEXT NOT NULL,
          note TEXT,
          readback TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (job_id, field_key)
        );
      `);
    },
  },
  {
    version: 4,
    name: "character limits on form fields (for drafted answers)",
    up(db) {
      db.exec("ALTER TABLE application_fields ADD COLUMN max_length INTEGER");
    },
  },
  {
    version: 5,
    name: "document versions: re-uploads under the same name become v2, v3, …",
    up(db) {
      db.exec(`
        ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        -- Lets an identical re-upload resolve to the existing version instead of a copy.
        ALTER TABLE documents ADD COLUMN content_sha256 TEXT;
        CREATE INDEX idx_documents_name ON documents(kind, name, version);

        -- Number existing same-name documents oldest-first.
        UPDATE documents SET version = (
          SELECT n FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY kind, name ORDER BY uploaded_at, id) AS n FROM documents
          ) ranked WHERE ranked.id = documents.id
        );
      `);
      const rows = db.prepare("SELECT id, file_path FROM documents").all() as { id: number; file_path: string }[];
      const set = db.prepare("UPDATE documents SET content_sha256 = ? WHERE id = ?");
      for (const row of rows) {
        try {
          const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(DATA_DIR, row.file_path))).digest("hex");
          set.run(hash, row.id);
        } catch {
          // Missing file: leave the hash NULL; it just won't match future uploads.
        }
      }
    },
  },
  {
    version: 6,
    name: "'to apply' status (rebuilds status_events to widen its CHECK)",
    // Dropping the old table with foreign keys on would cascade-delete recordings.
    foreignKeysOff: true,
    up(db) {
      const cols = [
        "id", "job_id", "status", "interview_round", "oa_score", "oa_sent_at", "oa_submitted_at", "oa_deadline_at",
        "oa_link", "interview_offered_at", "interview_held_at", "interview_link", "pre_notes", "post_notes",
        "occurred_at", "created_at",
      ].join(", ");
      db.exec(`
        CREATE TABLE status_events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('to_apply','applied','oa','interview','pending','rejected','accepted')),
          interview_round INTEGER,
          oa_score TEXT,
          oa_sent_at TEXT,
          oa_submitted_at TEXT,
          oa_deadline_at TEXT,
          oa_link TEXT,
          interview_offered_at TEXT,
          interview_held_at TEXT,
          interview_link TEXT,
          pre_notes TEXT NOT NULL DEFAULT '',
          post_notes TEXT NOT NULL DEFAULT '',
          occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO status_events_new (${cols}) SELECT ${cols} FROM status_events;
        DROP TABLE status_events;
        ALTER TABLE status_events_new RENAME TO status_events;
        CREATE INDEX idx_status_events_job ON status_events(job_id, occurred_at, id);
      `);
    },
  },
  {
    version: 7,
    name: "portal accounts for the ChatGPT browser tools (passwords encrypted with JOBMANAGER_VAULT_KEY)",
    up(db) {
      db.exec(`
        CREATE TABLE portal_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          host TEXT NOT NULL,
          email TEXT NOT NULL,
          secret_enc TEXT NOT NULL,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (host, email)
        );
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function runVersionedMigrations(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  // VACUUM INTO can't run inside a transaction, so back up first. A concurrent
  // process racing us just produces a second harmless backup.
  const hasData = (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n > 0;
  if (hasData) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(BACKUPS_DIR, `app-v${current}-${stamp}.db`);
    db.prepare("VACUUM INTO ?").run(target);
  }

  // Table rebuilds need foreign keys off, which SQLite only allows outside a
  // transaction; the references are re-checked before committing instead.
  const fkOff = MIGRATIONS.some((m) => m.version > current && m.foreignKeysOff);
  if (fkOff) db.pragma("foreign_keys = OFF");

  // IMMEDIATE takes the write lock up front, then re-reads the version so a
  // second process that waited on the lock doesn't re-apply the same steps.
  db.exec("BEGIN IMMEDIATE");
  try {
    const locked = db.pragma("user_version", { simple: true }) as number;
    for (const m of MIGRATIONS) {
      if (m.version <= locked) continue;
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    }
    if (fkOff) {
      const broken = db.pragma("foreign_key_check") as unknown[];
      if (broken.length) throw new Error(`Migration left ${broken.length} broken foreign key reference(s)`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    if (fkOff) db.pragma("foreign_keys = ON");
  }
}

export function getDb(): Database.Database {
  if (!globalForDb.__jobmanagerDb) globalForDb.__jobmanagerDb = open();
  return globalForDb.__jobmanagerDb;
}
