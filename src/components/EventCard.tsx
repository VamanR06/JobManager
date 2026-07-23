"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { statusLabel, type Recording, type StatusEvent } from "@/lib/types";
import { formatDateTime, formatSeconds, fromDatetimeLocal, toDatetimeLocal } from "@/lib/format";
import StatusBadge from "./StatusBadge";
import RecorderControls from "./RecorderControls";

interface Props {
  event: StatusEvent;
  pendingAfter: StatusEvent | null;
  recordings: Recording[];
}

export default function EventCard({ event, pendingAfter, recordings }: Props) {
  const router = useRouter();
  const [preNotes, setPreNotes] = useState(event.pre_notes);
  const [postNotes, setPostNotes] = useState(event.post_notes);
  const [oaScore, setOaScore] = useState(event.oa_score ?? "");
  const [round, setRound] = useState(event.interview_round?.toString() ?? "");
  const [editingTime, setEditingTime] = useState(false);
  const [timeValue, setTimeValue] = useState(toDatetimeLocal(event.occurred_at));

  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    router.refresh();
  }

  async function remove() {
    if (!confirm("Delete this status event (and its recordings)?")) return;
    await fetch(`/api/events/${event.id}`, { method: "DELETE" });
    router.refresh();
  }

  const noteCls =
    "w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/50";
  const isInterview = event.status === "interview";
  const isOa = event.status === "oa";

  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={event.status} label={statusLabel(event, pendingAfter)} />
        {editingTime ? (
          <span className="inline-flex items-center gap-1">
            <input
              type="datetime-local"
              value={timeValue}
              onChange={(e) => setTimeValue(e.target.value)}
              className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              onClick={() => {
                setEditingTime(false);
                void patch({ occurred_at: fromDatetimeLocal(timeValue) });
              }}
              className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white"
            >
              ✓
            </button>
            <button onClick={() => setEditingTime(false)} className="px-1 text-xs text-zinc-500">
              ✕
            </button>
          </span>
        ) : (
          <button
            onClick={() => setEditingTime(true)}
            title="Edit timestamp"
            className="text-xs text-zinc-500 hover:underline"
          >
            {formatDateTime(event.occurred_at)}
          </button>
        )}
        <button onClick={remove} className="ml-auto text-xs text-zinc-400 hover:text-red-500">
          delete
        </button>
      </div>

      {isOa && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">Score:</span>
          <input
            value={oaScore}
            onChange={(e) => setOaScore(e.target.value)}
            onBlur={() => oaScore !== (event.oa_score ?? "") && void patch({ oa_score: oaScore || null })}
            placeholder="e.g. 3/4 or 270"
            className="w-32 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      )}

      {isInterview && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500">Round:</span>
            <input
              type="number"
              min={1}
              value={round}
              onChange={(e) => setRound(e.target.value)}
              onBlur={() =>
                round !== (event.interview_round?.toString() ?? "") &&
                void patch({ interview_round: round ? Number(round) : null })
              }
              className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="ml-auto">
              <RecorderControls eventId={event.id} />
            </span>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500">Pre-interview notes</p>
              <textarea
                value={preNotes}
                onChange={(e) => setPreNotes(e.target.value)}
                onBlur={() => preNotes !== event.pre_notes && void patch({ pre_notes: preNotes })}
                rows={4}
                placeholder="Prep, topics to review, questions to ask…"
                className={noteCls}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500">Post-interview notes</p>
              <textarea
                value={postNotes}
                onChange={(e) => setPostNotes(e.target.value)}
                onBlur={() => postNotes !== event.post_notes && void patch({ post_notes: postNotes })}
                rows={4}
                placeholder="How it went, questions asked, follow-ups…"
                className={noteCls}
              />
            </div>
          </div>
        </>
      )}

      {recordings.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500">Recordings</p>
          {recordings.map((rec) => (
            <div key={rec.id} className="space-y-1">
              {rec.state === "done" ? (
                <video
                  controls
                  preload="metadata"
                  src={`/api/recordings/${rec.id}/file`}
                  className="max-h-80 w-full rounded-lg border border-zinc-200 bg-black dark:border-zinc-800"
                />
              ) : (
                <p className="text-xs text-zinc-400">
                  {rec.state === "recording" ? "Recording in progress…" : "Recording failed"}
                </p>
              )}
              <div className="flex items-center gap-3 text-xs text-zinc-500">
                <span>{formatDateTime(rec.started_at)}</span>
                {rec.duration_sec != null && <span>{formatSeconds(rec.duration_sec)}</span>}
                <button
                  onClick={async () => {
                    if (!confirm("Delete this recording file?")) return;
                    await fetch(`/api/recordings/${rec.id}`, { method: "DELETE" });
                    router.refresh();
                  }}
                  className="text-zinc-400 hover:text-red-500"
                >
                  delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
