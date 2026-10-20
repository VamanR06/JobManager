"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkflowState } from "@/lib/workflow-types";

const LABELS: Record<WorkflowState, string> = {
  queued: "Queued",
  extracting: "Extracting",
  generating_resume: "Generating resume",
  validating_resume: "Validating resume",
  filling: "Filling form",
  needs_input: "Needs you",
  ready_to_submit: "Ready to submit",
  submitting: "Submitting",
  submitted: "Submitted",
  submission_unknown: "Submission unknown",
  retry_wait: "Retrying soon",
  failed: "Failed",
  cancelled: "Cancelled",
};

const tone = (s: WorkflowState) =>
  s === "submitted" || s === "ready_to_submit"
    ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
    : s === "submission_unknown" || s === "failed"
      ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
      : s === "needs_input"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";

type Action = "mark_submitted" | "not_submitted" | "clear";

/**
 * Job page strip for applying through ChatGPT: where the submission stands,
 * and the buttons for settling it by hand (e.g. after "submission unknown").
 */
export default function SubmissionBanner({ jobId, state, detail }: { jobId: number; state: WorkflowState; detail: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function act(action: Action) {
    setError(null);
    const res = await fetch(`/api/jobs/${jobId}/submission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Couldn't update");
    router.refresh();
  }

  const btn = "text-xs hover:underline";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
      <span className="text-zinc-500">Application</span>
      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tone(state)}`}>{LABELS[state]}</span>
      {detail && <span className="text-xs text-zinc-500">{detail}</span>}
      <span className="ml-auto flex gap-3">
        {state !== "submitted" && (
          <button className={`${btn} text-green-700 dark:text-green-400`} onClick={() => act("mark_submitted")} title="You submitted it and it wasn't recorded">
            I submitted it
          </button>
        )}
        {state === "submission_unknown" && (
          <button className={`${btn} text-blue-600`} onClick={() => act("not_submitted")} title="You checked the portal and your email: it didn't go through">
            It didn&apos;t go through
          </button>
        )}
        {state !== "submitted" && state !== "submitting" && state !== "submission_unknown" && (
          <button className={`${btn} text-zinc-500`} onClick={() => act("clear")} title="Hide this; the application stays tracked by hand">
            Dismiss
          </button>
        )}
      </span>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
