/**
 * JobManager automation worker. Runs next to the dashboard (`npm run worker`),
 * claims queued steps from SQLite, and runs them one at a time.
 *
 * Crash safety: every step holds a lease it renews by heartbeat. If this process
 * dies, the lease expires and the next worker resumes the step in a fresh work
 * directory; any Codex process it left behind is found and stopped first.
 */
import os from "os";
import crypto from "crypto";

process.env.JOBMANAGER_ROLE ??= "worker";

const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 20_000;
const IDLE_POLL_MS = 2_000;

/** Parallelism per resource (all workers combined); set in .env.local. */
const limit = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};
const LIMITS = {
  codex: limit("RESUME_CONCURRENCY", 2), // resume generations (Codex/Claude usage)
  browser: limit("FORM_CONCURRENCY", 2), // forms being filled, one tab each
  network: limit("FETCH_CONCURRENCY", 3), // posting fetches
};

async function main() {
  // Imported after JOBMANAGER_ROLE is set so the DB opens in worker mode.
  const { getDb } = await import("../src/lib/db");
  const queue = await import("../src/lib/queue");
  const { unfinishedCodexRuns, updateCodexRun } = await import("../src/lib/automation");
  const { isSameProcess, killGroup } = await import("../src/lib/codex/process");
  const steps = await import("../src/lib/steps");
  const { BrowserOwner } = await import("../src/lib/apply/browser");
  const { CONFIRM_SCRIPT } = await import("../src/lib/apply/confirm");
  const { markSubmitted } = await import("../src/lib/automation");
  const { ARTIFACTS_DIR, DATA_DIR } = await import("../src/lib/db");
  const fs = await import("fs");
  const path = await import("path");
  // One browser for the whole worker, opened on the first form to fill.
  const held: { browser: InstanceType<typeof BrowserOwner> | null } = { browser: null };
  const getBrowser = () => (held.browser ??= new BrowserOwner());

  const owner = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
  let stopping = false;
  /** Tasks this worker is running right now, by task id. */
  const running = new Map<number, AbortController>();
  const inflight = new Set<Promise<void>>();

  /**
   * Codex runs left "running" by a dead worker. The process runs in its own
   * group, so it may have survived. Stop it only when it's provably ours (pid +
   * start time match) and no live worker still holds the task's lease.
   */
  function reconcileOrphans() {
    const now = new Date().toISOString();
    for (const run of unfinishedCodexRuns()) {
      const task = run.task_id
        ? (getDb().prepare("SELECT state, lease_owner, lease_expires_at FROM tasks WHERE id = ?").get(run.task_id) as
            | { state: string; lease_owner: string | null; lease_expires_at: string | null }
            | undefined)
        : undefined;
      const liveElsewhere = task?.state === "running" && task.lease_owner !== owner && (task.lease_expires_at ?? "") > now;
      if (liveElsewhere || (run.task_id !== null && running.has(run.task_id))) continue;
      if (run.pid && isSameProcess(run.pid, run.proc_start)) {
        killGroup(run.pid, "SIGTERM");
        setTimeout(() => isSameProcess(run.pid!, run.proc_start) && killGroup(run.pid!, "SIGKILL"), 5_000);
      }
      updateCodexRun(run.id, {
        state: "abandoned", outcome: "abandoned", finished_at: now,
        error: "Worker stopped while this run was active; its partial output was discarded",
      });
      queue.logEvent(run.job_id, "codex:abandoned", `run ${run.id} was orphaned by a worker restart`);
    }
  }

  async function runTask(task: import("../src/lib/workflow-types").Task) {
    const controller = new AbortController();
    running.set(task.id, controller);
    let cancelRequested = false;
    let leaseLost = false;
    const beat = setInterval(() => {
      try {
        const hb = queue.heartbeat(task.id, owner, LEASE_MS);
        if (hb.cancelRequested && !cancelRequested) {
          cancelRequested = true;
          controller.abort("cancel");
        }
      } catch (err) {
        if (err instanceof queue.LeaseLostError) {
          leaseLost = true;
          controller.abort("lease-lost");
        }
      }
    }, HEARTBEAT_MS);

    const ctx = {
      owner,
      browser: getBrowser,
      signal: controller.signal,
      stopRequested: () => {
        if (controller.signal.aborted) return true;
        // Pause takes effect at the next boundary, like cancel, but keeps the step queued.
        const job = getDb().prepare("SELECT paused FROM jobs WHERE id = ?").get(task.job_id) as { paused: number } | undefined;
        return !job || job.paused === 1;
      },
    };

    console.log(`[worker] task ${task.id} (${task.step}) for job ${task.job_id}, attempt ${task.attempts}`);
    try {
      const result =
        task.step === "extract" ? await steps.runExtractStep(task, ctx)
        : task.step === "resume" ? await steps.runResumeStep(task, ctx)
        : task.step === "prepare" ? await steps.runPrepareStep(task, ctx)
        : (queue.failTask(task.id, owner, `Unknown step ${task.step}`, false), "done" as const);

      if (result === "interrupted" && !leaseLost) {
        if (cancelRequested || controller.signal.reason === "cancel") queue.cancelledTask(task.id, owner);
        else queue.releaseTask(task.id, owner); // shutdown or pause: resume later, no attempt charged
      }
    } catch (err) {
      if (err instanceof queue.LeaseLostError || leaseLost) {
        console.warn(`[worker] lost lease on task ${task.id}; another worker owns it now`);
      } else {
        console.error(`[worker] task ${task.id} crashed:`, err);
        try {
          queue.failTask(task.id, owner, `Worker error: ${err instanceof Error ? err.message : String(err)}`, true);
        } catch {
          // Lease already gone.
        }
      }
    } finally {
      clearInterval(beat);
      running.delete(task.id);
    }
  }

  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${sig}: finishing up (${running.size} running)`);
    for (const c of running.values()) c.abort("shutdown");
  };
  // A stray async error from the browser layer shouldn't stop every running step.
  // Steps catch their own errors; this only logs what escapes them.
  process.on("unhandledRejection", (err) => console.error("[worker] unhandled (kept running):", err));
  process.on("uncaughtException", (err) => console.error("[worker] uncaught (kept running):", err));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  /**
   * Watches filled tabs you're reviewing. When the site shows its confirmation
   * (and the form is gone), the job is marked submitted with a receipt
   * screenshot. Site warnings after a submit attempt are surfaced on the queue.
   */
  const warned = new Map<number, string>();
  const watcher = setInterval(async () => {
    if (!held.browser) return;
    for (const [jobId, page] of held.browser.openPages()) {
      const state = (getDb().prepare("SELECT workflow_state FROM jobs WHERE id = ?").get(jobId) as { workflow_state: string | null } | undefined)?.workflow_state;
      if (state !== "ready_to_submit" && state !== "needs_input") continue;
      let check: import("../src/lib/apply/confirm").ConfirmationCheck;
      try {
        check = (await page.evaluate(CONFIRM_SCRIPT)) as typeof check;
      } catch {
        continue; // navigating or closed
      }
      if (check.confirmed) {
        let receipt: string | null = null;
        try {
          const dir = path.join(ARTIFACTS_DIR, `job-${jobId}`);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, `receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
          await page.screenshot({ path: file, fullPage: true });
          receipt = path.relative(DATA_DIR, file);
        } catch {
          // a missing screenshot doesn't undo a confirmed submission
        }
        if (markSubmitted(jobId, { how: "confirmation_page", detail: `${page.url()} :: ${check.snippet ?? ""}`, receipt })) {
          console.log(`[worker] job ${jobId}: submission confirmed by the site`);
        }
      } else if (check.warning && warned.get(jobId) !== check.warning) {
        warned.set(jobId, check.warning);
        queue.logEvent(jobId, "submission:site_warning", check.warning);
        getDb().prepare("UPDATE jobs SET workflow_detail = ? WHERE id = ?").run(
          `The site showed a warning after submitting: "${check.warning.slice(0, 160)}". Check the browser window; you can retry there.`, jobId
        );
      }
    }
  }, 3_000);

  console.log(`[worker] started as ${owner} · parallel: ${LIMITS.codex} resumes, ${LIMITS.browser} forms, ${LIMITS.network} fetches`);
  reconcileOrphans();
  let lastReconcile = Date.now();
  const maxSlots = LIMITS.codex + LIMITS.browser + LIMITS.network;
  while (!stopping) {
    if (Date.now() - lastReconcile > 60_000) {
      reconcileOrphans();
      lastReconcile = Date.now();
    }
    // Fill free slots. The claim itself enforces each resource's limit atomically.
    while (!stopping && running.size < maxSlots) {
      const task = queue.claimTask(owner, LEASE_MS, undefined, LIMITS);
      if (!task) break;
      const p: Promise<void> = runTask(task).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    // Wake when any task finishes (to claim the next one) or after the idle poll.
    await Promise.race([new Promise((r) => setTimeout(r, IDLE_POLL_MS)), ...inflight]);
  }
  await Promise.allSettled([...inflight]);
  clearInterval(watcher);
  // Filled-in tabs close with the worker; the profile (and any logins) persist.
  await held.browser?.close();
  console.log("[worker] stopped");
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
