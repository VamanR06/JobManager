"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDocument } from "@/lib/types";

interface Props {
  document: AppDocument;
  /** Collapsed by default on the job page; open right after generating. */
  defaultOpen?: boolean;
}

/**
 * Preview of a generated resume with a message box for revisions.
 *
 * A revision continues the same ChatGPT conversation and overwrites the file in
 * place, so whatever links to this resume keeps pointing at the current version.
 */
export default function ResumePreview({ document: doc, defaultOpen = false }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  // Bumped after a revision to bust the iframe's cache — the URL is unchanged.
  const [version, setVersion] = useState(0);

  const isPdf = doc.name.toLowerCase().endsWith(".pdf");
  const fileUrl = `/api/documents/${doc.id}/file?v=${version}`;

  async function revise() {
    setBusy(true);
    setError(null);
    setReply(null);
    try {
      const res = await fetch("/api/generate-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revise_document_id: doc.id, message }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Revision failed");
      setReply(body.warning ?? body.reply ?? "Updated.");
      setMessage("");
      setVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revision failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="text-sm font-semibold">
          {open ? "▾" : "▸"} Generated resume
        </button>
        <span className="truncate text-xs text-zinc-400">{doc.name}</span>
        <span className="ml-auto flex gap-3">
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            Open ↗
          </a>
        </span>
      </div>

      {open && (
        <div className="space-y-3 border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
          {isPdf ? (
            <iframe
              key={version}
              src={fileUrl}
              title={doc.name}
              className="h-[600px] w-full rounded-lg border border-zinc-200 dark:border-zinc-800"
            />
          ) : (
            <p className="text-sm text-zinc-400">
              No PDF preview — this resume was saved as {doc.name.split(".").pop()?.toUpperCase()}.{" "}
              <a href={fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                Open it
              </a>
              .
            </p>
          )}

          {doc.thread_id ? (
            <div className="space-y-2">
              <label className="block text-xs text-zinc-500">
                Ask for changes
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="e.g. Move the projects section above experience, and shorten the first bullet."
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={revise}
                  disabled={busy || !message.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? "Revising… (~1 min)" : "Send revision"}
                </button>
                <span className="text-xs text-zinc-400">
                  Continues the same ChatGPT conversation and replaces this file.
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">
              This resume has no linked conversation, so it can&apos;t be revised. Generate a new one
              to enable revisions.
            </p>
          )}

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {reply && <p className="text-xs text-zinc-500">{reply}</p>}
        </div>
      )}
    </section>
  );
}
