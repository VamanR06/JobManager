import { getDb } from "./db";
import { createEvent } from "./queries";
import type { WorkflowState } from "./workflow-types";

/**
 * Submission state for applying through ChatGPT (apply/harness.ts), kept on
 * jobs.workflow_state, with a log in workflow_events.
 */

export function logEvent(jobId: number, type: string, message = ""): void {
  getDb().prepare("INSERT INTO workflow_events (job_id, type, message) VALUES (?, ?, ?)").run(jobId, type, message.slice(0, 2000));
}

export function setWorkflow(jobId: number, state: WorkflowState | null, detail: string | null = null): void {
  getDb().prepare("UPDATE jobs SET workflow_state = ?, workflow_detail = ? WHERE id = ?").run(state, detail, jobId);
  logEvent(jobId, `state:${state ?? "manual"}`, detail ?? "");
}

/**
 * Records that the application was submitted: workflow → submitted, and an
 * "applied" entry in the recruiting timeline (unless the latest one already
 * is). Idempotent, so a confirmation and a button can't double-log.
 */
export function markSubmitted(jobId: number, evidence: { how: "confirmation_page" | "manual"; detail: string; receipt?: string | null }): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: string | null } | undefined;
    if (!row || row.workflow_state === "submitted") return false;
    const now = new Date().toISOString();
    db.prepare("UPDATE jobs SET workflow_state = 'submitted', submitted_at = ?, workflow_detail = ? WHERE id = ?").run(
      now,
      evidence.how === "manual" ? "Marked submitted by you" : `Submitted; the site confirmed it${evidence.receipt ? " (receipt screenshot saved)" : ""}`,
      jobId
    );
    const latest = db.prepare("SELECT status FROM status_events WHERE job_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1").get(jobId) as { status: string } | undefined;
    if (latest?.status !== "applied") createEvent({ job_id: jobId, status: "applied", occurred_at: now });
    db.prepare("INSERT INTO workflow_events (job_id, type, message) VALUES (?, ?, ?)").run(
      jobId, `submission:${evidence.how}`, [evidence.detail, evidence.receipt ? `receipt: ${evidence.receipt}` : ""].filter(Boolean).join(" | ").slice(0, 2000)
    );
    return true;
  }).immediate();
}
