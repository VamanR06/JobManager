import { getDb } from "./db";
import type { Task, TaskResource, TaskStep, WorkflowState } from "./workflow-types";

/**
 * Durable task queue in SQLite. Every function is one short transaction; nothing
 * here waits on the network, a browser, or Codex. Workers claim a task by taking
 * a time-limited lease and must keep heartbeating to hold it.
 */

export class LeaseLostError extends Error {
  constructor(taskId: number) {
    super(`Lost the lease on task ${taskId}`);
    this.name = "LeaseLostError";
  }
}

const RESOURCE: Record<TaskStep, TaskResource> = {
  extract: "network",
  resume: "codex",
  prepare: "browser",
};

/** Codex runs spend usage quota, so they get fewer automatic retries. */
const DEFAULT_ATTEMPTS: Record<TaskStep, number> = { extract: 3, resume: 2, prepare: 2 };

/** Workflow state shown while a step runs. */
const RUNNING_STATE: Record<TaskStep, WorkflowState> = {
  extract: "extracting",
  resume: "generating_resume",
  prepare: "filling",
};

/**
 * Steps whose interruption may have had an external effect. An expired lease on
 * one of these never auto-retries; it goes to reconciliation instead.
 */
const UNSAFE_TO_REPLAY = new Set<string>(["submit"]);

const iso = (ms = Date.now()) => new Date(ms).toISOString();

// ---------- events + workflow state ----------

export function logEvent(jobId: number, type: string, message = "", taskId: number | null = null): void {
  getDb()
    .prepare("INSERT INTO workflow_events (job_id, task_id, type, message) VALUES (?, ?, ?, ?)")
    .run(jobId, taskId, type, message.slice(0, 2000));
}

export function setWorkflow(jobId: number, state: WorkflowState, detail: string | null = null, taskId: number | null = null): void {
  getDb().prepare("UPDATE jobs SET workflow_state = ?, workflow_detail = ? WHERE id = ?").run(state, detail, jobId);
  logEvent(jobId, `state:${state}`, detail ?? "", taskId);
}

// ---------- producing ----------

/** Adds a step for a job. Returns the existing live task instead if the job already has one. */
export function enqueue(
  jobId: number,
  step: TaskStep,
  opts: { payload?: unknown; maxAttempts?: number; delayMs?: number } = {}
): Task {
  const db = getDb();
  return db.transaction(() => {
    const live = db
      .prepare("SELECT * FROM tasks WHERE job_id = ? AND state IN ('queued','running','blocked')")
      .get(jobId) as Task | undefined;
    if (live) return live;
    const res = db
      .prepare(
        `INSERT INTO tasks (job_id, step, resource, payload, max_attempts, run_after)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        jobId, step, RESOURCE[step], JSON.stringify(opts.payload ?? {}), opts.maxAttempts ?? DEFAULT_ATTEMPTS[step],
        iso(Date.now() + (opts.delayMs ?? 0))
      );
    setWorkflow(jobId, "queued", `Waiting to run: ${step}`, Number(res.lastInsertRowid));
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(res.lastInsertRowid) as Task;
  }).immediate();
}

// ---------- consuming ----------

/**
 * Expired leases: ordinary preparation steps go back to the queue (the next
 * attempt starts in a fresh work directory); steps that touch an employer's
 * site go to reconciliation and are never replayed automatically.
 */
function recoverExpired(now: string): void {
  const db = getDb();
  const expired = db
    .prepare("SELECT * FROM tasks WHERE state = 'running' AND lease_expires_at < ?")
    .all(now) as Task[];
  for (const t of expired) {
    if (UNSAFE_TO_REPLAY.has(t.step)) {
      db.prepare(
        "UPDATE tasks SET state = 'blocked', lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?"
      ).run("Worker stopped mid-submission; outcome unknown", now, t.id);
      setWorkflow(t.job_id, "submission_unknown", "The worker stopped during submission. Check the portal before doing anything else.", t.id);
    } else if (t.cancel_requested) {
      db.prepare("UPDATE tasks SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(now, t.id);
    } else if (t.attempts >= t.max_attempts) {
      db.prepare(
        "UPDATE tasks SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?"
      ).run("Worker stopped repeatedly during this step", now, t.id);
      setWorkflow(t.job_id, "failed", `The ${t.step} step was interrupted ${t.attempts} times`, t.id);
    } else {
      db.prepare(
        // run_after is left as-is so interrupted work keeps its place in line.
        "UPDATE tasks SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?"
      ).run("Worker stopped mid-step; resuming", now, t.id);
      setWorkflow(t.job_id, "queued", `Resuming ${t.step} after an interrupted attempt`, t.id);
    }
  }
}

/** How many tasks of each resource may run at once, across all workers. */
export type ResourceLimits = Partial<Record<TaskResource, number>>;

/**
 * Atomically claims the next runnable task. A task is skipped while its job is
 * paused, and while its resource is at its limit (default 1) counting live
 * leases from every worker, so limits hold across processes and the same task
 * is never claimed twice.
 */
export function claimTask(owner: string, leaseMs: number, resources?: TaskResource[], limits: ResourceLimits = {}): Task | null {
  const db = getDb();
  return db.transaction(() => {
    const now = iso();
    recoverExpired(now);
    const resourceFilter = resources?.length
      ? `AND t.resource IN (${resources.map(() => "?").join(",")})`
      : "";
    const cap = (r: TaskResource) => Math.max(1, Math.floor(limits[r] ?? 1));
    const task = db
      .prepare(
        `UPDATE tasks SET state = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
           attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT t.id FROM tasks t JOIN jobs j ON j.id = t.job_id
           WHERE t.state = 'queued' AND t.run_after <= ? AND j.paused = 0 AND t.cancel_requested = 0
             ${resourceFilter}
             AND (
               SELECT COUNT(*) FROM tasks r WHERE r.state = 'running' AND r.resource = t.resource AND r.lease_expires_at > ?
             ) < CASE t.resource WHEN 'codex' THEN ? WHEN 'browser' THEN ? ELSE ? END
           ORDER BY t.run_after, t.id LIMIT 1
         )
         RETURNING *`
      )
      .get(
        owner, iso(Date.now() + leaseMs), now, now, now, ...(resources ?? []), now,
        cap("codex"), cap("browser"), cap("network")
      ) as Task | undefined;
    if (!task) return null;
    setWorkflow(task.job_id, RUNNING_STATE[task.step], `Attempt ${task.attempts} of ${task.max_attempts}`, task.id);
    return task;
  }).immediate();
}

/** Extends the lease. Throws LeaseLostError if another worker took over. */
export function heartbeat(taskId: number, owner: string, leaseMs: number): { cancelRequested: boolean; paused: boolean } {
  const row = getDb()
    .prepare(
      `UPDATE tasks SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND state = 'running'
       RETURNING cancel_requested, (SELECT paused FROM jobs WHERE jobs.id = tasks.job_id) AS paused`
    )
    .get(iso(Date.now() + leaseMs), iso(), iso(), taskId, owner) as { cancel_requested: number; paused: number } | undefined;
  if (!row) throw new LeaseLostError(taskId);
  return { cancelRequested: row.cancel_requested === 1, paused: row.paused === 1 };
}

function finish(
  taskId: number,
  owner: string,
  set: string,
  args: unknown[]
): Task {
  const row = getDb()
    .prepare(`UPDATE tasks SET ${set}, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND state = 'running' RETURNING *`)
    .get(...args, iso(), taskId, owner) as Task | undefined;
  if (!row) throw new LeaseLostError(taskId);
  return row;
}

/** Marks the task done and optionally queues the job's next step, in one transaction. */
export function completeTask(
  taskId: number,
  owner: string,
  next?: { step: TaskStep; payload?: unknown },
  final?: { state: WorkflowState; detail: string }
): void {
  const db = getDb();
  db.transaction(() => {
    const task = finish(taskId, owner, "state = 'done', last_error = NULL", []);
    if (next) enqueue(task.job_id, next.step, { payload: next.payload });
    else if (final) setWorkflow(task.job_id, final.state, final.detail, taskId);
  }).immediate();
}

const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000);

/** A failed attempt: retried with backoff while attempts remain, unless not retryable. */
export function failTask(taskId: number, owner: string, error: string, retryable: boolean): void {
  const db = getDb();
  db.transaction(() => {
    const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
    if (!current) throw new LeaseLostError(taskId);
    if (retryable && current.attempts < current.max_attempts) {
      const when = iso(Date.now() + backoffMs(current.attempts));
      finish(taskId, owner, "state = 'queued', run_after = ?, last_error = ?", [when, error]);
      setWorkflow(current.job_id, "retry_wait", `${error} (retrying at ${when})`, taskId);
    } else {
      finish(taskId, owner, "state = 'failed', last_error = ?", [error]);
      setWorkflow(current.job_id, "failed", error, taskId);
    }
  }).immediate();
}

/** Parks the task until the user supplies something. Holds no transaction or lease while waiting. */
export function blockTask(taskId: number, owner: string, reason: string): void {
  const db = getDb();
  db.transaction(() => {
    const task = finish(taskId, owner, "state = 'blocked', last_error = ?", [reason]);
    setWorkflow(task.job_id, "needs_input", reason, taskId);
  }).immediate();
}

export function cancelledTask(taskId: number, owner: string): void {
  const db = getDb();
  db.transaction(() => {
    const task = finish(taskId, owner, "state = 'cancelled'", []);
    setWorkflow(task.job_id, "cancelled", "Cancelled by user", taskId);
  }).immediate();
}

/** Hands a task back on graceful shutdown without charging it an attempt. */
export function releaseTask(taskId: number, owner: string): void {
  const db = getDb();
  db.transaction(() => {
    const task = finish(taskId, owner, "state = 'queued', attempts = MAX(attempts - 1, 0), run_after = ?", [iso()]);
    setWorkflow(task.job_id, "queued", `Worker shut down; ${task.step} will resume`, taskId);
  }).immediate();
}

// ---------- user controls ----------

export function latestTask(jobId: number): Task | null {
  return (getDb().prepare("SELECT * FROM tasks WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as Task | undefined) ?? null;
}

export function pauseJob(jobId: number, paused: boolean): void {
  getDb().prepare("UPDATE jobs SET paused = ? WHERE id = ?").run(paused ? 1 : 0, jobId);
  logEvent(jobId, paused ? "paused" : "resumed", paused ? "No new steps will start until resumed" : "");
}

/** Queued/blocked work stops now; a running step is asked to stop at its next boundary. */
export function cancelJob(jobId: number): void {
  const db = getDb();
  db.transaction(() => {
    const now = iso();
    db.prepare("UPDATE tasks SET state = 'cancelled', updated_at = ? WHERE job_id = ? AND state IN ('queued','blocked')").run(now, jobId);
    const running = db
      .prepare("UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE job_id = ? AND state = 'running' RETURNING id")
      .all(now, jobId);
    setWorkflow(
      jobId, "cancelled",
      running.length ? "Cancel requested; the running step will stop at its next checkpoint" : "Cancelled by user"
    );
  }).immediate();
}

/**
 * Re-runs a job from a given step (default: the step that last stopped).
 * Refuses while a step is running, and never re-runs anything after a
 * possibly-submitted state — those need reconciliation, not a retry.
 */
export function retryJob(jobId: number, step?: TaskStep, payload?: unknown): Task {
  const db = getDb();
  return db.transaction(() => {
    const job = db.prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: WorkflowState | null } | undefined;
    if (!job) throw new Error("Job not found");
    if (job.workflow_state && ["submitting", "submitted", "submission_unknown"].includes(job.workflow_state)) {
      throw new Error("This application may already have been submitted; it can't be retried automatically");
    }
    const last = latestTask(jobId);
    if (last?.state === "running") throw new Error("A step is still running; cancel it first");
    if (last && (last.state === "queued" || last.state === "blocked")) {
      if (step && step !== last.step) {
        db.prepare("UPDATE tasks SET state = 'cancelled', updated_at = ? WHERE id = ?").run(iso(), last.id);
      } else {
        db.prepare(
          "UPDATE tasks SET state = 'queued', attempts = 0, run_after = ?, payload = ?, updated_at = ? WHERE id = ?"
        ).run(iso(), JSON.stringify(payload ?? JSON.parse(last.payload)), iso(), last.id);
        setWorkflow(jobId, "queued", `Retrying ${last.step}`, last.id);
        return db.prepare("SELECT * FROM tasks WHERE id = ?").get(last.id) as Task;
      }
    }
    const target = step ?? last?.step ?? "extract";
    return enqueue(jobId, target, { payload });
  }).immediate();
}
