"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, type Status } from "@/lib/types";

interface ParsedPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  description_md: string;
}

export default function AddJobForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [initialStatus, setInitialStatus] = useState<Status | "">("applied");
  const [posting, setPosting] = useState<ParsedPosting | null>(null);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function fetchPosting() {
    if (!url) return;
    setFetching(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Fetch failed");
      setPosting(data);
      if (data.company && !company) setCompany(data.company);
      if (data.title && !title) setTitle(data.title);
      setNotice("Posting fetched — description will be saved with the job");
    } catch (err) {
      setPosting(null);
      setError(
        (err instanceof Error ? err.message : "Fetch failed") +
          " — you can still save the job and paste the description manually"
      );
    } finally {
      setFetching(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company,
          title,
          url: url || null,
          posting: posting?.description_md ? posting : undefined,
          initial_status: initialStatus || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      setUrl("");
      setCompany("");
      setTitle("");
      setPosting(null);
      setNotice(null);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        + Add application
      </button>
    );
  }

  const inputCls =
    "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">New application</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-zinc-500 hover:underline">
          Cancel
        </button>
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          placeholder="Paste posting URL (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={inputCls}
        />
        <button
          type="button"
          onClick={fetchPosting}
          disabled={!url || fetching}
          className="shrink-0 rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          placeholder="Company *"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
          className={inputCls}
        />
        <input
          placeholder="Role title *"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className={inputCls}
        />
        <select
          value={initialStatus}
          onChange={(e) => setInitialStatus(e.target.value as Status | "")}
          className={inputCls}
        >
          <option value="">No initial status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              Initial status: {s}
            </option>
          ))}
        </select>
      </div>

      {notice && <p className="text-xs text-green-600 dark:text-green-400">{notice}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save application"}
      </button>
    </form>
  );
}
