"use client";

import { useState } from "react";
import type { AppDocument } from "@/lib/types";

interface Props {
  document: AppDocument;
  /** Collapsed by default on the job page; open in the documents table. */
  defaultOpen?: boolean;
}

/** Inline preview of a generated resume. */
export default function ResumePreview({ document: doc, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const isPdf = doc.name.toLowerCase().endsWith(".pdf");
  const fileUrl = `/api/documents/${doc.id}/file`;

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
        <div className="border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
          {isPdf ? (
            <iframe
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
        </div>
      )}
    </section>
  );
}
