"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { QueueRow, WorkflowState } from "@/lib/workflow-types";
import { formatAgo } from "@/lib/format";
import ImportBox from "./ImportBox";
import JobAutomationPanel from "./JobAutomationPanel";
import SetupStatus from "./SetupStatus";
import WorkflowBadge from "./WorkflowBadge";

const FILTERS: { key: string; label: string; match: (s: WorkflowState) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "active", label: "In progress", match: (s) => ["queued", "extracting", "generating_resume", "validating_resume", "filling", "submitting", "retry_wait"].includes(s) },
  { key: "input", label: "Needs you", match: (s) => s === "needs_input" || s === "submission_unknown" || s === "ready_to_submit" },
  { key: "failed", label: "Failed", match: (s) => s === "failed" },
  { key: "done", label: "Done / cancelled", match: (s) => s === "submitted" || s === "cancelled" },
];

type Action = "pause" | "resume" | "cancel" | "retry" | "continue" | "mark_submitted";

export default function QueueView({ initial }: { initial: QueueRow[] }) {
  const [rows, setRows] = useState(initial);
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/queue");
    if (res.ok) setRows(await res.json());
    setTick((t) => t + 1);
  }, []);

  // Poll while anything is moving; the worker is a separate process.
  useEffect(() => {
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  async function act(jobId: number, action: Action) {
    setError(null);
    if (action === "cancel" && !confirm("Cancel automation for this application?")) return;
    if (action === "mark_submitted" && !confirm("Mark this application as submitted? It will be logged as Applied.")) return;
    const res = await fetch(`/api/queue/${jobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Action failed");
    refresh();
  }

  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = rows.filter((r) => active.match(r.workflow_state));
  const btn = "rounded px-2 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800";

  return (
    <div className="space-y-6">
      <SetupStatus />
      <ImportBox onImported={refresh} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => {
            const n = rows.filter((r) => f.match(r.workflow_state)).length;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3 py-1 text-xs ${filter === f.key ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
              >
                {f.label} ({n})
              </button>
            );
          })}
          {error && <span className="ml-3 text-sm text-red-600">{error}</span>}
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <tbody>
              {shown.map((r) => {
                const running = r.task_state === "running";
                const blocked = r.task_state === "blocked";
                const stopped = r.workflow_state === "failed" || r.workflow_state === "cancelled";
                return (
                  <Fragment key={r.job_id}>
                    <tr
                      className="cursor-pointer border-t border-zinc-100 align-top first:border-t-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      onClick={() => setExpanded(expanded === r.job_id ? null : r.job_id)}
                    >
                      <td className="px-3 py-2">
                        <Link href={`/jobs/${r.job_id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                          {r.company}
                        </Link>
                        <div className="text-xs text-zinc-500">{r.title}</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500">{r.ats ?? "web"}</td>
                      <td className="px-3 py-2">
                        <WorkflowBadge state={r.workflow_state} paused={r.paused === 1} />
                        {r.workflow_detail && <div className="mt-1 max-w-md text-xs text-zinc-500">{r.workflow_detail}</div>}
                        {r.latest_artifact_status === "pending_review" && (
                          <div className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">Resume ready to review ↓</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-zinc-400">{formatAgo(r.created_at)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {blocked && r.task_step === "extract" && (
                          <button className={`${btn} text-blue-600`} onClick={() => act(r.job_id, "continue")} title="Use the description saved on the job page">
                            Continue
                          </button>
                        )}
                        {(r.workflow_state === "ready_to_submit" || (r.workflow_state === "needs_input" && r.latest_artifact_status === "approved")) && (
                          <button className={`${btn} text-green-700 dark:text-green-400`} onClick={() => act(r.job_id, "mark_submitted")} title="Use this if you submitted it yourself and it wasn't detected">
                            I submitted it
                          </button>
                        )}
                        {(blocked || stopped || r.workflow_state === "retry_wait") && (
                          <button className={btn} onClick={() => act(r.job_id, "retry")}>Retry</button>
                        )}
                        {!stopped && (
                          <button className={btn} onClick={() => act(r.job_id, r.paused ? "resume" : "pause")}>
                            {r.paused ? "Resume" : "Pause"}
                          </button>
                        )}
                        {!stopped && (
                          <button className={`${btn} text-red-600`} onClick={() => act(r.job_id, "cancel")}>
                            {running ? "Stop" : "Cancel"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === r.job_id && (
                      <tr className="bg-zinc-50/50 dark:bg-zinc-900/50">
                        <td colSpan={5} className="px-3 py-3">
                          <JobAutomationPanel jobId={r.job_id} refreshKey={tick} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td className="px-3 py-8 text-center text-sm text-zinc-400">
                    {rows.length ? "Nothing in this filter." : "No automated applications yet. Paste links above."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
