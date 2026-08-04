"use client";

import { useEffect, useRef, useState } from "react";
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

const AUTOSAVE_DELAY = 600;

export default function EventCard({ event, pendingAfter, recordings }: Props) {
  const router = useRouter();
  const [preNotes, setPreNotes] = useState(event.pre_notes);
  const [postNotes, setPostNotes] = useState(event.post_notes);
  const [oaScore, setOaScore] = useState(event.oa_score ?? "");
  const [oaLink, setOaLink] = useState(event.oa_link ?? "");
  const [interviewLink, setInterviewLink] = useState(event.interview_link ?? "");
  const [round, setRound] = useState(event.interview_round?.toString() ?? "");
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Send whatever's pending right now. Uses keepalive so the request still lands
   * even if the browser is mid-unload (refresh/close) — otherwise a debounced
   * save queued right before a refresh never gets a chance to fire.
   */
  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const fields = pending.current;
    if (Object.keys(fields).length === 0) return;
    pending.current = {};
    fetch(`/api/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
      keepalive: true,
    }).then(() => router.refresh());
  }

  /** Queue `field` to save a short pause after the user stops typing. */
  function autosave(field: string, value: unknown) {
    pending.current[field] = value;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush();
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    }, AUTOSAVE_DELAY);
  }

  // Flush on tab close/refresh and on unmount, so nothing typed is ever lost.
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Milestone date: saves immediately on change (a single discrete pick, no debounce needed).
  const dateField = (field: keyof StatusEvent, label: string) => {
    const current = event[field] as string | null;
    return (
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        {label}
        <input
          type="datetime-local"
          defaultValue={current ? toDatetimeLocal(current) : ""}
          onChange={(e) => void patch({ [field]: fromDatetimeLocal(e.target.value) })}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </label>
    );
  };

  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={event.status} label={statusLabel(event, pendingAfter)} />
        <label className="text-xs text-zinc-500">
          <input
            type="datetime-local"
            defaultValue={toDatetimeLocal(event.occurred_at)}
            onChange={(e) => void patch({ occurred_at: fromDatetimeLocal(e.target.value) })}
            className="rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-zinc-300 dark:hover:border-zinc-700"
          />
        </label>
        {saved && <span className="text-xs text-green-600 dark:text-green-400">saved</span>}
        <button onClick={remove} className="ml-auto text-xs text-zinc-400 hover:text-red-500">
          delete
        </button>
      </div>

      {isOa && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500">Score:</span>
            <input
              value={oaScore}
              onChange={(e) => {
                setOaScore(e.target.value);
                autosave("oa_score", e.target.value || null);
              }}
              onBlur={flush}
              placeholder="e.g. 3/4 or 270"
              className="w-32 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {dateField("oa_sent_at", "OA sent to me")}
            {dateField("oa_submitted_at", "I submitted the OA")}
            {dateField("oa_deadline_at", "Deadline (optional)")}
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              OA link
              <input
                type="url"
                value={oaLink}
                onChange={(e) => {
                  setOaLink(e.target.value);
                  autosave("oa_link", e.target.value || null);
                }}
                onBlur={flush}
                placeholder="https://…"
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>
          {event.oa_link && (
            <a href={event.oa_link} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
              Open OA ↗
            </a>
          )}
        </div>
      )}

      {isInterview && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500">Round:</span>
            <input
              type="number"
              min={1}
              value={round}
              onChange={(e) => {
                setRound(e.target.value);
                autosave("interview_round", e.target.value ? Number(e.target.value) : null);
              }}
              onBlur={flush}
              className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="ml-auto">
              <RecorderControls eventId={event.id} />
            </span>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {dateField("interview_offered_at", "Interview offered")}
            {dateField("interview_held_at", "Interview held")}
            <label className="flex flex-col gap-1 text-xs text-zinc-500 sm:col-span-2">
              Meeting link
              <input
                type="url"
                value={interviewLink}
                onChange={(e) => {
                  setInterviewLink(e.target.value);
                  autosave("interview_link", e.target.value || null);
                }}
                onBlur={flush}
                placeholder="https://…"
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>
          {event.interview_link && (
            <a href={event.interview_link} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
              Join meeting ↗
            </a>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500">Pre-interview notes</p>
              <textarea
                value={preNotes}
                onChange={(e) => {
                  setPreNotes(e.target.value);
                  autosave("pre_notes", e.target.value);
                }}
                onBlur={flush}
                rows={4}
                placeholder="Prep, topics to review, questions to ask…"
                className={noteCls}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500">Post-interview notes</p>
              <textarea
                value={postNotes}
                onChange={(e) => {
                  setPostNotes(e.target.value);
                  autosave("post_notes", e.target.value);
                }}
                onBlur={flush}
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
