"use client";

import { useRouter } from "next/navigation";
import type { AppDocument } from "@/lib/types";

interface Props {
  jobId: number;
  field: "resume_id" | "cover_letter_id";
  label: string;
  options: AppDocument[];
  value: number | null;
}

/** Dropdown linking a resume/cover letter to a job, with a view link when set. */
export default function DocumentPicker({ jobId, field, label, options, value }: Props) {
  const router = useRouter();
  // Archived documents can't be newly attached, but stay visible if already linked.
  const visible = options.filter((doc) => !doc.archived || doc.id === value);

  async function save(newValue: string) {
    await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: newValue ? Number(newValue) : null }),
    });
    router.refresh();
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-zinc-500">{label}:</span>
      <select
        value={value ?? ""}
        onChange={(e) => void save(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">— none —</option>
        {visible.map((doc) => (
          <option key={doc.id} value={doc.id}>
            {doc.name}
            {doc.archived ? " (archived)" : ""}
          </option>
        ))}
      </select>
      {value != null && (
        <a
          href={`/api/documents/${value}/file`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          view ↗
        </a>
      )}
    </label>
  );
}
