"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDocument, Job } from "@/lib/types";
import DocumentPicker from "./DocumentPicker";

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
        <div>
          <h1 className="text-2xl font-bold">{job.company}</h1>
          <p className="text-zinc-600 dark:text-zinc-400">{job.title}</p>
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
