"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, type Status } from "@/lib/types";

/** Dashboard-row status updater: pick a status; OA/interview ask for score/round inline. */
export default function QuickStatus({ jobId, nextRound }: { jobId: number; nextRound: number }) {
  const router = useRouter();
  const [pendingStatus, setPendingStatus] = useState<Status | null>(null);
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(status: Status, extraValue?: string) {
    setSaving(true);
    try {
      await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          status,
          oa_score: status === "oa" && extraValue ? extraValue : undefined,
          interview_round: status === "interview" ? Number(extraValue) || nextRound : undefined,
        }),
      });
      setPendingStatus(null);
      setExtra("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function onPick(value: string) {
    if (!value) return;
    const status = value as Status;
    if (status === "oa" || status === "interview") {
      setPendingStatus(status);
      setExtra(status === "interview" ? String(nextRound) : "");
    } else {
      void save(status);
    }
  }

  if (pendingStatus) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save(pendingStatus, extra)}
          placeholder={pendingStatus === "oa" ? "Score" : "Round"}
          className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          onClick={() => void save(pendingStatus, extra)}
          disabled={saving}
          className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
        >
          ✓
        </button>
        <button onClick={() => setPendingStatus(null)} className="px-1 text-xs text-zinc-500">
          ✕
        </button>
      </span>
    );
  }

  return (
    <select
      value=""
      onChange={(e) => onPick(e.target.value)}
      disabled={saving}
      className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
    >
      <option value="">Update…</option>
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
