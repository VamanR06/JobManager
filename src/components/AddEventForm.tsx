"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, statusName, type Status } from "@/lib/types";
import { fromDatetimeLocal, toDatetimeLocal } from "@/lib/format";

export default function AddEventForm({ jobId, nextRound }: { jobId: number; nextRound: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("applied");
  const [round, setRound] = useState(String(nextRound));
  const [score, setScore] = useState("");
  const [when, setWhen] = useState("");
  const [oaSentAt, setOaSentAt] = useState("");
  const [oaSubmittedAt, setOaSubmittedAt] = useState("");
  const [oaDeadlineAt, setOaDeadlineAt] = useState("");
  const [oaLink, setOaLink] = useState("");
  const [interviewOfferedAt, setInterviewOfferedAt] = useState("");
  const [interviewHeldAt, setInterviewHeldAt] = useState("");
  const [interviewLink, setInterviewLink] = useState("");
  const [saving, setSaving] = useState(false);

  const now = () => toDatetimeLocal(new Date().toISOString());

  // Default the date to now (set after mount to avoid hydration mismatch).
  useEffect(() => {
    setWhen(now());
  }, []);

  // When switching to OA/interview, default the "start" milestone to now; leave the "end" empty.
  useEffect(() => {
    if (status === "oa" && !oaSentAt) setOaSentAt(now());
    if (status === "interview" && !interviewOfferedAt) setInterviewOfferedAt(now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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
          oa_sent_at: status === "oa" ? fromDatetimeLocal(oaSentAt) : undefined,
          oa_submitted_at: status === "oa" ? fromDatetimeLocal(oaSubmittedAt) : undefined,
          oa_deadline_at: status === "oa" ? fromDatetimeLocal(oaDeadlineAt) : undefined,
          oa_link: status === "oa" ? oaLink || null : undefined,
          interview_offered_at: status === "interview" ? fromDatetimeLocal(interviewOfferedAt) : undefined,
          interview_held_at: status === "interview" ? fromDatetimeLocal(interviewHeldAt) : undefined,
          interview_link: status === "interview" ? interviewLink || null : undefined,
          occurred_at: fromDatetimeLocal(when),
        }),
      });
      setScore("");
      setWhen(now());
      setOaSentAt("");
      setOaSubmittedAt("");
      setOaDeadlineAt("");
      setOaLink("");
      setInterviewOfferedAt("");
      setInterviewHeldAt("");
      setInterviewLink("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";
  const labelCls = "flex flex-col gap-1 text-xs text-zinc-500";

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as Status)} className={inputCls}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusName(s)}
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
          title="When this happened (defaults to now)"
          className={inputCls}
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Add update
        </button>
      </div>

      {status === "oa" && (
        <div className="flex flex-wrap gap-3">
          <label className={labelCls}>
            OA sent to me
            <input
              type="datetime-local"
              value={oaSentAt}
              onChange={(e) => setOaSentAt(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            I submitted the OA
            <input
              type="datetime-local"
              value={oaSubmittedAt}
              onChange={(e) => setOaSubmittedAt(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Deadline (optional)
            <input
              type="datetime-local"
              value={oaDeadlineAt}
              onChange={(e) => setOaDeadlineAt(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            OA link
            <input
              type="url"
              value={oaLink}
              onChange={(e) => setOaLink(e.target.value)}
              placeholder="https://…"
              className={`${inputCls} w-56`}
            />
          </label>
        </div>
      )}

      {status === "interview" && (
        <div className="flex flex-wrap gap-3">
          <label className={labelCls}>
            Interview offered
            <input
              type="datetime-local"
              value={interviewOfferedAt}
              onChange={(e) => setInterviewOfferedAt(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Interview held
            <input
              type="datetime-local"
              value={interviewHeldAt}
              onChange={(e) => setInterviewHeldAt(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Meeting link
            <input
              type="url"
              value={interviewLink}
              onChange={(e) => setInterviewLink(e.target.value)}
              placeholder="https://…"
              className={`${inputCls} w-56`}
            />
          </label>
        </div>
      )}
    </form>
  );
}
