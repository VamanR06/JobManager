"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, statusName, type Status } from "@/lib/types";
import { fromDatetimeLocal, toDatetimeLocal } from "@/lib/format";

const now = () => toDatetimeLocal(new Date().toISOString());

/** Dashboard-row status updater: pick a status; OA/interview show the same fields as the job page. */
export default function QuickStatus({ jobId, nextRound }: { jobId: number; nextRound: number }) {
  const router = useRouter();
  const [pendingStatus, setPendingStatus] = useState<Status | null>(null);
  const [round, setRound] = useState("");
  const [score, setScore] = useState("");
  const [oaSentAt, setOaSentAt] = useState("");
  const [oaSubmittedAt, setOaSubmittedAt] = useState("");
  const [oaDeadlineAt, setOaDeadlineAt] = useState("");
  const [oaLink, setOaLink] = useState("");
  const [interviewOfferedAt, setInterviewOfferedAt] = useState("");
  const [interviewHeldAt, setInterviewHeldAt] = useState("");
  const [interviewLink, setInterviewLink] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setPendingStatus(null);
    setRound("");
    setScore("");
    setOaSentAt("");
    setOaSubmittedAt("");
    setOaDeadlineAt("");
    setOaLink("");
    setInterviewOfferedAt("");
    setInterviewHeldAt("");
    setInterviewLink("");
  }

  async function save(status: Status) {
    setSaving(true);
    try {
      await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          status,
          interview_round: status === "interview" ? Number(round) || nextRound : undefined,
          oa_score: status === "oa" ? score || null : undefined,
          oa_sent_at: status === "oa" ? fromDatetimeLocal(oaSentAt) : undefined,
          oa_submitted_at: status === "oa" ? fromDatetimeLocal(oaSubmittedAt) : undefined,
          oa_deadline_at: status === "oa" ? fromDatetimeLocal(oaDeadlineAt) : undefined,
          oa_link: status === "oa" ? oaLink || null : undefined,
          interview_offered_at: status === "interview" ? fromDatetimeLocal(interviewOfferedAt) : undefined,
          interview_held_at: status === "interview" ? fromDatetimeLocal(interviewHeldAt) : undefined,
          interview_link: status === "interview" ? interviewLink || null : undefined,
        }),
      });
      reset();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function onPick(value: string) {
    if (!value) return;
    const status = value as Status;
    if (status === "oa") {
      setPendingStatus(status);
      setOaSentAt(now());
    } else if (status === "interview") {
      setPendingStatus(status);
      setRound(String(nextRound));
      setInterviewOfferedAt(now());
    } else {
      void save(status);
    }
  }

  const inputCls = "rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900";
  const labelCls = "flex flex-col gap-0.5 text-[10px] text-zinc-500";

  if (pendingStatus === "oa") {
    return (
      <div className="flex flex-wrap items-end gap-1.5 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
        <label className={labelCls}>
          Score
          <input value={score} onChange={(e) => setScore(e.target.value)} className={`${inputCls} w-16`} />
        </label>
        <label className={labelCls}>
          OA sent
          <input type="datetime-local" value={oaSentAt} onChange={(e) => setOaSentAt(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Submitted
          <input type="datetime-local" value={oaSubmittedAt} onChange={(e) => setOaSubmittedAt(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Deadline
          <input type="datetime-local" value={oaDeadlineAt} onChange={(e) => setOaDeadlineAt(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Link
          <input type="url" value={oaLink} onChange={(e) => setOaLink(e.target.value)} placeholder="https://…" className={`${inputCls} w-28`} />
        </label>
        <button onClick={() => void save("oa")} disabled={saving} className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50">
          ✓
        </button>
        <button onClick={reset} className="px-1 text-xs text-zinc-500">
          ✕
        </button>
      </div>
    );
  }

  if (pendingStatus === "interview") {
    return (
      <div className="flex flex-wrap items-end gap-1.5 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
        <label className={labelCls}>
          Round
          <input type="number" min={1} value={round} onChange={(e) => setRound(e.target.value)} className={`${inputCls} w-14`} />
        </label>
        <label className={labelCls}>
          Offered
          <input type="datetime-local" value={interviewOfferedAt} onChange={(e) => setInterviewOfferedAt(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Held
          <input type="datetime-local" value={interviewHeldAt} onChange={(e) => setInterviewHeldAt(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Meeting link
          <input type="url" value={interviewLink} onChange={(e) => setInterviewLink(e.target.value)} placeholder="https://…" className={`${inputCls} w-28`} />
        </label>
        <button onClick={() => void save("interview")} disabled={saving} className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50">
          ✓
        </button>
        <button onClick={reset} className="px-1 text-xs text-zinc-500">
          ✕
        </button>
      </div>
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
          {statusName(s)}
        </option>
      ))}
    </select>
  );
}
