import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { getDb, SCHEMA_VERSION } from "../src/lib/db";
import { importUrls, previewImport } from "../src/lib/automation";
import { createJob, listJobs } from "../src/lib/queries";
import {
  blockTask, cancelJob, claimTask, completeTask, enqueue, failTask, heartbeat, LeaseLostError, pauseJob, retryJob,
} from "../src/lib/queue";
import type { Task } from "../src/lib/workflow-types";

const db = getDb();
const job = (id: number) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
const task = (id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task;
const expire = (id: number) => db.prepare("UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
const clearQueue = () => db.exec("UPDATE tasks SET state = 'done' WHERE state IN ('queued','running','blocked')");

test("migrations are versioned and existing tables keep working", () => {
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const j = createJob({ company: "Legacy Co", title: "Manual entry" });
  assert.equal(job(j.id).workflow_state, null, "manual jobs stay out of the automation");
  assert.ok(listJobs().some((x) => x.id === j.id));
});

test("equivalent links never create duplicate applications or tasks", () => {
  const first = importUrls(["https://boards.greenhouse.io/acme/jobs/111", "https://acme.com/careers?gh_jid=111"]);
  assert.deepEqual(first.map((r) => r.outcome), ["created", "duplicate"]);
  const again = importUrls(["https://job-boards.greenhouse.io/acme/jobs/111?utm_source=x"]);
  assert.equal(again[0].outcome, "duplicate");
  assert.equal(again[0].job_id, first[0].job_id);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?").get(first[0].job_id) as { n: number }).n;
  assert.equal(n, 1);
  // A manual job with the same link is recognised too.
  const manual = createJob({ company: "Beta", title: "SWE", url: "https://jobs.lever.co/beta/0f6a1a5e-2c3b-4d5e-8f90-1234567890ab" });
  db.prepare("UPDATE jobs SET posting_key = 'lever:0f6a1a5e-2c3b-4d5e-8f90-1234567890ab' WHERE id = ?").run(manual.id);
  const p = previewImport("https://jobs.lever.co/beta/0f6a1a5e-2c3b-4d5e-8f90-1234567890ab/apply\nnot-a-url");
  assert.equal(p[0].status, "duplicate");
  assert.equal(p[1].status, "invalid");
  // enqueue never adds a second live task for the same job.
  const t1 = enqueue(first[0].job_id!, "resume");
  assert.equal(t1.step, "extract");
  clearQueue();
});

test("claim, heartbeat, complete chains the next step", () => {
  const [r] = importUrls(["https://example.com/jobs/chain"]);
  const t = claimTask("w1", 60_000)!;
  assert.equal(t.job_id, r.job_id);
  assert.equal(job(t.job_id).workflow_state, "extracting");
  assert.deepEqual(heartbeat(t.id, "w1", 60_000), { cancelRequested: false, paused: false });
  assert.throws(() => heartbeat(t.id, "intruder", 60_000), LeaseLostError);
  assert.throws(() => completeTask(t.id, "intruder"), LeaseLostError);
  completeTask(t.id, "w1", { step: "resume" });
  const next = db.prepare("SELECT * FROM tasks WHERE job_id = ? AND state = 'queued'").get(t.job_id) as Task;
  assert.equal(next.step, "resume");
  clearQueue();
});

test("an expired preparation lease resumes; an expired submission lease goes to reconciliation", () => {
  const [a] = importUrls(["https://example.com/jobs/expire-a"]);
  const t = claimTask("dead-worker", 60_000)!;
  expire(t.id);
  const again = claimTask("new-worker", 60_000)!;
  assert.equal(again.id, t.id, "same task resumes");
  assert.equal(again.attempts, 2);
  clearQueue();

  const s = createJob({ company: "Sub", title: "Mit", url: "https://example.com/jobs/sub" });
  db.prepare(
    "INSERT INTO tasks (job_id, step, resource, state, attempts, lease_owner, lease_expires_at) VALUES (?, 'submit', 'browser', 'running', 1, 'dead', '2000-01-01T00:00:00.000Z')"
  ).run(s.id);
  assert.equal(claimTask("new-worker", 60_000), null, "submission is never replayed");
  assert.equal(job(s.id).workflow_state, "submission_unknown");
  assert.throws(() => retryJob(s.id), /already have been submitted/);
  void a;
  clearQueue();
});

test("a browser task can't be claimed while another browser lease is live", () => {
  const a = createJob({ company: "B1", title: "t" });
  const b = createJob({ company: "B2", title: "t" });
  db.prepare("INSERT INTO tasks (job_id, step, resource) VALUES (?, 'fill', 'browser'), (?, 'fill', 'browser')").run(a.id, b.id);
  const first = claimTask("w1", 60_000)!;
  assert.equal(first.resource, "browser");
  assert.equal(claimTask("w2", 60_000), null);
  expire(first.id);
  const second = claimTask("w2", 60_000);
  assert.equal(second?.id, first.id, "the expired lease is reclaimed before any other browser task");
  clearQueue();
});

test("pause holds the next step; cancel stops queued work and flags running work", () => {
  const [r] = importUrls(["https://example.com/jobs/pause"]);
  pauseJob(r.job_id!, true);
  assert.equal(claimTask("w", 60_000), null);
  pauseJob(r.job_id!, false);
  const t = claimTask("w", 60_000)!;
  pauseJob(r.job_id!, true);
  assert.equal(heartbeat(t.id, "w", 60_000).paused, true);
  pauseJob(r.job_id!, false);
  cancelJob(r.job_id!);
  assert.equal(heartbeat(t.id, "w", 60_000).cancelRequested, true);
  assert.equal(job(r.job_id!).workflow_state, "cancelled");

  const [q] = importUrls(["https://example.com/jobs/cancel-queued"]);
  cancelJob(q.job_id!);
  assert.equal(claimTask("w", 60_000)?.job_id === q.job_id, false);
  clearQueue();
});

test("failures back off, then fail; blocked tasks wait for the user; retry re-queues", () => {
  const [r] = importUrls(["https://example.com/jobs/fail"]);
  let t = claimTask("w", 60_000)!;
  failTask(t.id, "w", "HTTP 503", true);
  assert.equal(task(t.id).state, "queued");
  assert.equal(job(r.job_id!).workflow_state, "retry_wait");
  assert.ok(task(t.id).run_after > new Date().toISOString());
  db.prepare("UPDATE tasks SET run_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(t.id);
  t = claimTask("w", 60_000)!;
  failTask(t.id, "w", "HTTP 404", false);
  assert.equal(task(t.id).state, "failed");
  retryJob(r.job_id!);
  t = claimTask("w", 60_000)!;
  blockTask(t.id, "w", "Paste the description");
  assert.equal(job(r.job_id!).workflow_state, "needs_input");
  assert.equal(claimTask("w", 60_000), null, "blocked tasks hold no lease and are not claimable");
  retryJob(r.job_id!, "resume", { feedback: "x" });
  assert.equal((db.prepare("SELECT step FROM tasks WHERE job_id = ? AND state = 'queued'").get(r.job_id!) as Task).step, "resume");
  clearQueue();
});

test("two worker processes never claim the same task", async () => {
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) ids.push(importUrls([`https://example.com/jobs/race-${i}`])[0].job_id!);
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const script = path.join(__dirname, "fixtures", "claimer.ts");
  const runOne = (owner: string) =>
    new Promise<number[]>((resolve, reject) => {
      const p = spawn(tsx, [script, owner, "network"], { env: process.env });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => process.stderr.write(d));
      p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`claimer exited ${code}`))));
    });
  const [a, b] = await Promise.all([runOne("A"), runOne("B")]);
  const all = [...a, ...b];
  assert.equal(new Set(all).size, all.length, "no task claimed twice");
  const expected = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE job_id IN (${ids.join(",")})`).get() as { n: number };
  assert.equal(all.length, expected.n, "every task claimed exactly once");
});

test("resource limits: several resume runs at once when allowed, never more than the limit", () => {
  clearQueue();
  const ids = [1, 2, 3].map((i) => createJob({ company: `Par${i}`, title: "t" }).id);
  for (const id of ids) db.prepare("INSERT INTO tasks (job_id, step, resource) VALUES (?, 'resume', 'codex')").run(id);
  const limits = { codex: 2, browser: 1, network: 3 };
  const a = claimTask("w1", 60_000, undefined, limits);
  const b = claimTask("w2", 60_000, undefined, limits);
  assert.ok(a && b && a.id !== b.id, "two resume runs in parallel");
  assert.equal(claimTask("w3", 60_000, undefined, limits), null, "the third waits for a slot");
  completeTask(a!.id, "w1");
  assert.ok(claimTask("w3", 60_000, undefined, limits), "a freed slot is taken");
  clearQueue();
  // Without limits the old one-at-a-time behaviour holds.
  const c = createJob({ company: "Solo1", title: "t" }).id, d = createJob({ company: "Solo2", title: "t" }).id;
  db.prepare("INSERT INTO tasks (job_id, step, resource) VALUES (?, 'resume', 'codex'), (?, 'resume', 'codex')").run(c, d);
  assert.ok(claimTask("w1", 60_000));
  assert.equal(claimTask("w2", 60_000), null);
  clearQueue();
});
