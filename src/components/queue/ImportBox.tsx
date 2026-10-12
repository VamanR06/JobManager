"use client";

import { useState } from "react";
import type { ImportPreviewItem, ImportResult } from "@/lib/automation";

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

const STATUS_STYLE: Record<ImportPreviewItem["status"], { label: string; cls: string }> = {
  new: { label: "New", cls: "text-green-700 dark:text-green-400" },
  duplicate: { label: "Already tracked", cls: "text-zinc-500" },
  repeated: { label: "Repeated in paste", cls: "text-zinc-500" },
  invalid: { label: "Invalid", cls: "text-red-600 dark:text-red-400" },
  unsupported: { label: "Unsupported", cls: "text-red-600 dark:text-red-400" },
};

/** Paste links → preview each one → import only the new ones. */
export default function ImportBox({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreviewItem[] | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runPreview() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Preview failed");
      setPreview(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  const fresh = preview?.filter((p) => p.status === "new") ?? [];

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: fresh.map((p) => p.input) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Import failed");
      setResults(await res.json());
      setPreview(null);
      setText("");
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const created = results?.filter((r) => r.outcome === "created").length ?? 0;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">Import job links</h2>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        rows={4}
        placeholder={"Paste one link per line\nhttps://boards.greenhouse.io/acme/jobs/4012345\nhttps://jobs.lever.co/acme/…"}
        className={`${inputCls} font-mono text-xs`}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={runPreview}
          disabled={busy || !text.trim()}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Preview
        </button>
        {preview && (
          <button
            onClick={runImport}
            disabled={busy || fresh.length === 0}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Import {fresh.length} new
          </button>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
        {results && (
          <span className="text-sm text-zinc-500">
            Imported {created}. Extraction runs in the worker (<code>npm run worker</code>).
          </span>
        )}
      </div>

      {preview && (
        <ul className="divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
          {preview.map((p, i) => (
            <li key={i} className="flex items-start gap-3 py-1.5">
              <span className={`w-28 shrink-0 font-medium ${STATUS_STYLE[p.status].cls}`}>{STATUS_STYLE[p.status].label}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{p.input}</span>
                {"message" in p && <span className="text-red-600 dark:text-red-400">{p.message}</span>}
                {p.status === "duplicate" && (
                  <a href={`/jobs/${p.existing_job_id}`} className="text-blue-600 hover:underline">
                    {p.existing_label}
                  </a>
                )}
                {p.status === "new" && (
                  <span className="text-zinc-500">
                    {p.ats ? `ATS: ${p.ats}` : "Generic page"}
                    {p.warning ? ` · ${p.warning}` : ""}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
