"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, type Status } from "@/lib/types";
import { fromDatetimeLocal } from "@/lib/format";

export default function AddEventForm({ jobId, nextRound }: { jobId: number; nextRound: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("applied");
  const [round, setRound] = useState(String(nextRound));
  const [score, setScore] = useState("");
  const [when, setWhen] = useState(""); // empty = now
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          status,
          interview_round: status === "interview" ? Number(round) || null : undefined,
          oa_score: status === "oa" ? score || null : undefined,
          occurred_at: fromDatetimeLocal(when),
        }),
      });
      setScore("");
      setWhen("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <select value={status} onChange={(e) => setStatus(e.target.value as Status)} className={inputCls}>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {status === "interview" && (
        <input
          type="number"
          min={1}
          value={round}
          onChange={(e) => setRound(e.target.value)}
          placeholder="Round"
          className={`${inputCls} w-24`}
        />
      )}
      {status === "oa" && (
        <input
          value={score}
          onChange={(e) => setScore(e.target.value)}
          placeholder="Score (optional)"
          className={`${inputCls} w-36`}
        />
      )}
      <input
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        title="Backdate (leave empty for now)"
        className={inputCls}
      />
      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Add update
      </button>
    </form>
  );
}
