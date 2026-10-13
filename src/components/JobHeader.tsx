"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDocument, Job } from "@/lib/types";
import DocumentPicker from "./DocumentPicker";

/** Click to edit; Enter or blur saves, Escape cancels. Blank values aren't saved. */
function EditableText({ jobId, field, value }: { jobId: number; field: "company" | "title"; value: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // Escape unmounts the input, which can fire blur with the stale draft.
  const cancelled = useRef(false);

  async function save() {
    if (cancelled.current) return;
    const next = draft.trim();
    if (!next || next === value) {
      setDraft(value);
      setEditing(false);
      return;
    }
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: next }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Couldn't save");
      return;
    }
    setError(null);
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          cancelled.current = false;
          setDraft(value);
          setEditing(true);
        }}
        title={`Edit ${field}`}
        className="group text-left hover:underline hover:decoration-dotted"
      >
        {value}
        <span className="ml-2 text-xs font-normal text-zinc-400 opacity-0 group-hover:opacity-100">edit</span>
      </button>
    );
  }
  return (
    <span className="block">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(value);
            setError(null);
            setEditing(false);
          }
        }}
        aria-label={field}
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
      />
      {error && <span className="block text-xs font-normal text-red-500">{error}</span>}
    </span>
  );
}

interface Props {
  job: Job;
  resumes: AppDocument[];
  coverLetters: AppDocument[];
}

export default function JobHeader({ job, resumes, coverLetters }: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState(job.notes);

  async function saveNotes() {
    if (notes === job.notes) return;
    await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    router.refresh();
  }

  async function remove() {
    if (!confirm(`Delete ${job.company} — ${job.title} and all its history?`)) return;
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    router.push("/");
    router.refresh();
  }

  return (
    <header className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">
            <EditableText jobId={job.id} field="company" value={job.company} />
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            <EditableText jobId={job.id} field="title" value={job.title} />
          </p>
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              {job.url} ↗
            </a>
          )}
        </div>
        <button onClick={remove} className="shrink-0 text-xs text-zinc-400 hover:text-red-500">
          delete job
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DocumentPicker jobId={job.id} field="resume_id" label="Resume" options={resumes} value={job.resume_id} />
        <DocumentPicker
          jobId={job.id}
          field="cover_letter_id"
          label="Cover letter"
          options={coverLetters}
          value={job.cover_letter_id}
        />
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
        rows={2}
        placeholder="General notes (referral, contacts, deadlines…)"
        className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/50"
      />
    </header>
  );
}
