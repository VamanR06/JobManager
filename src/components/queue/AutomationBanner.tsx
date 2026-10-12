"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { WorkflowState } from "@/lib/workflow-types";
import WorkflowBadge from "./WorkflowBadge";

/** Job page strip: where this application is in the queue, or a way to add it. */
export default function AutomationBanner({
  jobId, state, detail, paused,
}: { jobId: number; state: WorkflowState | null; detail: string | null; paused: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function automate() {
    setError(null);
    const res = await fetch(`/api/queue/${jobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "automate" }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Could not queue");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
      <span className="text-zinc-500">Automation</span>
      {state ? (
        <>
          <WorkflowBadge state={state} paused={paused} />
          {detail && <span className="text-xs text-zinc-500">{detail}</span>}
          <Link href="/queue" className="ml-auto text-xs text-blue-600 hover:underline">Open queue →</Link>
        </>
      ) : (
        <button onClick={automate} className="text-xs text-blue-600 hover:underline">
          Generate a tailored resume with Resume Builder (Codex)
        </button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
