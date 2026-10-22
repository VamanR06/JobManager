"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import type { Posting } from "@/lib/types";
import { formatDateTime } from "@/lib/format";

export default function PostingSection({ jobId, posting, hasUrl }: { jobId: number; posting: Posting | null; hasUrl: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(posting?.description_md ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refetch() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/posting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refetch" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Fetch failed");
      setOpen(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveManual() {
    setBusy(true);
    try {
      await fetch(`/api/jobs/${jobId}/posting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description_md: draft,
          title: posting?.title ?? null,
          company: posting?.company ?? null,
          location: posting?.location ?? null,
        }),
      });
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const hasContent = !!posting?.description_md;

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="text-sm font-semibold">
          {open ? "▾" : "▸"} Job description
        </button>
        {posting && (
          <span className="text-xs text-zinc-400">
            {posting.fetch_status === "failed" && !hasContent
              ? "fetch failed"
              : `${posting.source === "manual" ? "manual" : "fetched"} · ${formatDateTime(posting.fetched_at)}`}
            {posting.location ? ` · ${posting.location}` : ""}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {hasUrl && (
            <button
              onClick={refetch}
              disabled={busy}
              className="text-xs text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              {busy ? "Fetching…" : "Re-fetch"}
            </button>
          )}
          <button
            onClick={() => {
              setDraft(posting?.description_md ?? "");
              setEditing(true);
              setOpen(true);
            }}
            className="text-xs text-zinc-500 hover:underline"
          >
            Edit manually
          </button>
        </span>
      </div>
      {error && <p className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {error && (
        <p className="px-4 pb-2 text-xs text-zinc-500">
          Some sites (Workday) refuse the server. Open the posting in your browser and click your{" "}
          <a href="/save" className="text-blue-600 hover:underline">Save to JobManager</a> bookmark: it can fill in this
          description.
        </p>
      )}

      {open && (
        <div className="border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={14}
                placeholder="Paste the job description here (markdown or plain text)…"
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900"
              />
              <div className="flex gap-2">
                <button
                  onClick={saveManual}
                  disabled={busy}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Save
                </button>
                <button onClick={() => setEditing(false)} className="text-sm text-zinc-500 hover:underline">
                  Cancel
                </button>
              </div>
            </div>
          ) : hasContent ? (
            <div className="prose prose-sm prose-zinc max-w-none dark:prose-invert [&_a]:text-blue-600 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm">
              <ReactMarkdown>{posting!.description_md}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              No description saved{hasUrl ? " — try Re-fetch, or paste it with Edit manually." : " — add it with Edit manually."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
