import type { WorkflowState } from "@/lib/workflow-types";

const COLORS: Record<WorkflowState, string> = {
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  extracting: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  generating_resume: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  validating_resume: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  filling: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  needs_input: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ready_to_submit: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  submitting: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  submitted: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  submission_unknown: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  retry_wait: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
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

export default function WorkflowBadge({ state, paused }: { state: WorkflowState; paused?: boolean }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${COLORS[state]}`}>
      {paused ? "Paused · " : ""}
      {WORKFLOW_LABELS[state]}
    </span>
  );
}
