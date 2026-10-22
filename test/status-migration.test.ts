import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import Database from "better-sqlite3";
import { DATA_DIR, getDb, SCHEMA_VERSION } from "../src/lib/db";
import { createEvent, createJob, listJobs, updateJob } from "../src/lib/queries";
import { statusLabel, statusName } from "../src/lib/types";

// A v5 database as it existed before "to apply": old CHECK, an event with a recording.
const old = new Database(path.join(DATA_DIR, "app.db"));
old.exec(`
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
    notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- Added by migration 1, so every real v5 database has them.
    ats TEXT, ats_tenant TEXT, posting_id TEXT, posting_key TEXT, application_url TEXT,
    workflow_state TEXT, workflow_detail TEXT, paused INTEGER NOT NULL DEFAULT 0, submitted_at TEXT
  );
  CREATE TABLE status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('applied','oa','interview','pending','rejected','accepted')),
    interview_round INTEGER, oa_score TEXT,
    pre_notes TEXT NOT NULL DEFAULT '', post_notes TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status_event_id INTEGER NOT NULL REFERENCES status_events(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ended_at TEXT, duration_sec REAL,
    state TEXT NOT NULL DEFAULT 'recording' CHECK (state IN ('recording','done','failed'))
  );
  INSERT INTO jobs (company, title) VALUES ('Old Co', 'Engineer');
  INSERT INTO status_events (job_id, status, interview_round, pre_notes) VALUES (1, 'interview', 2, 'prep notes');
  INSERT INTO recordings (status_event_id, file_path, state) VALUES (1, 'recordings/1.mov', 'done');
`);
old.pragma("user_version = 5");
old.close();

test("migration 6 allows 'to apply' and keeps existing events and recordings", () => {
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const ev = db.prepare("SELECT status, interview_round, pre_notes FROM status_events WHERE id = 1").get();
  assert.deepEqual(ev, { status: "interview", interview_round: 2, pre_notes: "prep notes" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recordings").get() as { n: number }).n, 1, "recording survived");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "foreign keys back on");
  assert.deepEqual(db.pragma("foreign_key_check"), []);

  // Cascades still work through the rebuilt table.
  db.prepare("DELETE FROM status_events WHERE id = 1").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recordings").get() as { n: number }).n, 0);
});

test("'to apply' is a status jobs can have, and company/title can be renamed", () => {
  const job = createJob({ company: "acme-corp", title: "(title unknown)" });
  const ev = createEvent({ job_id: job.id, status: "to_apply" });
  const listed = listJobs().find((j) => j.id === job.id)!;
  assert.equal(listed.latest_event?.status, "to_apply");
  assert.equal(statusLabel(ev, null), "To apply");
  assert.equal(statusName("to_apply"), "to apply");

  const renamed = updateJob(job.id, { company: "Acme Corp" })!;
  assert.equal(renamed.company, "Acme Corp");
  assert.equal(renamed.title, "(title unknown)", "title untouched");
});
