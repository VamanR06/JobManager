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
export default function SubmissionBanner({
  jobId, state, detail, tabOpen = false,
}: { jobId: number; state: WorkflowState | null; detail: string | null; tabOpen?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /** Types the site's verification code into the application's browser tab (not via ChatGPT). */
  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCodeNote(null);
    setSending(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/verification-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) setError((await res.json()).error ?? "Couldn't enter the code");
      else {
        setCode("");
        setCodeNote("Entered. Now tell ChatGPT to submit again.");
      }
    } finally {
      setSending(false);
    }
  }

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
      {state ? (
        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tone(state)}`}>{LABELS[state]}</span>
      ) : (
        <span className="text-xs text-zinc-500">Open in ChatGPT&apos;s browser</span>
      )}
      {state && detail && <span className="text-xs text-zinc-500">{detail}</span>}
      {state && <span className="ml-auto flex gap-3">
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
      </span>}
      {(tabOpen || state === "needs_input" || state === "ready_to_submit") && (
        <form onSubmit={sendCode} className="flex w-full flex-wrap items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <label htmlFor={`code-${jobId}`} className="text-xs text-zinc-500">
            Verification code from the site&apos;s email
          </label>
          <input
            id={`code-${jobId}`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            className="w-40 rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={sending || !code.trim()}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {sending ? "Entering…" : "Enter in form"}
          </button>
          {codeNote && <span className="text-xs text-green-700">{codeNote}</span>}
        </form>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
