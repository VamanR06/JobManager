"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { DocumentKind, DocumentWithUsage } from "@/lib/types";
import { formatDateTime } from "@/lib/format";

const LABEL: Record<DocumentKind, string> = { resume: "resume", cover_letter: "cover letter" };

export default function DocumentsView({ kind, documents }: { kind: DocumentKind; documents: DocumentWithUsage[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("kind", kind);
        form.set("file", file);
        const res = await fetch("/api/documents", { method: "POST", body: form });
        if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveRename(id: number) {
    await fetch(`/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameValue }),
    });
    setRenamingId(null);
    router.refresh();
  }

  async function remove(doc: DocumentWithUsage) {
    const usage = doc.used_by.length ? ` It's linked to ${doc.used_by.length} application(s) — they'll be unlinked.` : "";
    if (!confirm(`Delete "${doc.name}"?${usage}`)) return;
    await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.txt,.md"
          onChange={(e) => void upload(e.target.files)}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : `+ Upload ${LABEL[kind]}`}
        </button>
        <span className="text-xs text-zinc-400">PDF, Word, or text</span>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Uploaded</th>
              <th className="px-4 py-2.5">Used by</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {documents.map((doc) => (
              <tr key={doc.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                <td className="px-4 py-2.5 font-medium">
                  {renamingId === doc.id ? (
                    <span className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void saveRename(doc.id)}
                        className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                      <button onClick={() => void saveRename(doc.id)} className="text-xs text-blue-600">✓</button>
                      <button onClick={() => setRenamingId(null)} className="text-xs text-zinc-400">✕</button>
                    </span>
                  ) : (
                    <a
                      href={`/api/documents/${doc.id}/file`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {doc.name}
                    </a>
                  )}
                </td>
                <td className="px-4 py-2.5 text-zinc-500">{formatDateTime(doc.uploaded_at)}</td>
                <td className="px-4 py-2.5">
                  {doc.used_by.length === 0 ? (
                    <span className="text-zinc-400">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      {doc.used_by.map((job) => (
                        <Link
                          key={job.id}
                          href={`/jobs/${job.id}`}
                          className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                        >
                          {job.company} — {job.title}
                        </Link>
                      ))}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <button
                    onClick={() => {
                      setRenamingId(doc.id);
                      setRenameValue(doc.name);
                    }}
                    className="mr-3 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  >
                    rename
                  </button>
                  <button onClick={() => void remove(doc)} className="text-xs text-zinc-400 hover:text-red-500">
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-400">
                  No {LABEL[kind]}s uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
