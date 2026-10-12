"use client";

import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { DocumentKind, DocumentWithUsage } from "@/lib/types";
import { documentLabel, formatDateTime } from "@/lib/format";
import ResumePreview from "./ResumePreview";

const LABEL: Record<DocumentKind, string> = { resume: "resume", cover_letter: "cover letter" };

export default function DocumentsView({ kind, documents }: { kind: DocumentKind; documents: DocumentWithUsage[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Generated resume whose preview/revise panel is expanded below its row.
  const [previewId, setPreviewId] = useState<number | null>(null);

  const activeDocs = documents.filter((d) => !d.archived);
  const archivedDocs = documents.filter((d) => d.archived);
  // Same-name uploads are versions of one document: newest version first,
  // groups ordered by their most recent upload (documents arrive newest first).
  const groups = [...Map.groupBy(activeDocs, (d) => d.name).values()].map((v) =>
    [...v].sort((a, b) => b.version - a.version)
  );
  // Names whose older versions are expanded.
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set());
  function toggleHistory(name: string) {
    setExpandedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  const [notice, setNotice] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    const notices: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("kind", kind);
        form.set("file", file);
        const res = await fetch("/api/documents", { method: "POST", body: form });
        const doc = await res.json();
        if (!res.ok) throw new Error(doc.error ?? "Upload failed");
        if (doc.duplicate) notices.push(`${file.name} is identical to ${documentLabel(doc)} — kept the existing one.`);
        else if (doc.version > 1) notices.push(`${file.name} saved as version ${doc.version}.`);
      }
      setNotice(notices.length ? notices.join(" ") : null);
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
    const msg = doc.used_by.length
      ? `Archive "${doc.name}"? It's linked to ${doc.used_by.length} application(s), so the file is kept and those links stay exactly as submitted — it just can't be attached to new applications.`
      : `Delete "${doc.name}"? It isn't linked to any application, so the file will be removed permanently.`;
    if (!confirm(msg)) return;
    await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    router.refresh();
  }

  async function restore(doc: DocumentWithUsage) {
    await fetch(`/api/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    router.refresh();
  }

  /** One table row (+ its preview panel). Older versions render indented under the latest. */
  function renderRow(doc: DocumentWithUsage, versions: DocumentWithUsage[], isOlder: boolean) {
    return (
      <Fragment key={doc.id}>
        <tr className={`hover:bg-zinc-50 dark:hover:bg-zinc-900/50 ${isOlder ? "bg-zinc-50/50 text-zinc-500 dark:bg-zinc-900/30" : ""}`}>
          <td className={`px-4 py-2.5 ${isOlder ? "pl-10" : "font-medium"}`}>
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
              <span className="flex flex-wrap items-center gap-1.5">
                <a
                  href={`/api/documents/${doc.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {doc.name}
                </a>
                {versions.length > 1 && (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    v{doc.version}
                    {!isOlder && " · latest"}
                  </span>
                )}
                {!isOlder && versions.length > 1 && (
                  <button
                    onClick={() => toggleHistory(doc.name)}
                    className="text-xs font-normal text-zinc-400 hover:text-zinc-600 hover:underline dark:hover:text-zinc-300"
                  >
                    {expandedNames.has(doc.name) ? "▾" : "▸"} {versions.length - 1} older version
                    {versions.length > 2 ? "s" : ""}
                  </button>
                )}
                {doc.generated === 1 && (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                    generated
                  </span>
                )}
              </span>
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
            {doc.generated === 1 && (
              <button
                onClick={() => setPreviewId(previewId === doc.id ? null : doc.id)}
                className="mr-3 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                {previewId === doc.id ? "hide" : "preview"}
              </button>
            )}
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
              {doc.used_by.length > 0 ? "archive" : "delete"}
            </button>
          </td>
        </tr>
        {previewId === doc.id && (
          <tr>
            <td colSpan={4} className="px-4 pb-4">
              <ResumePreview document={doc} defaultOpen />
            </td>
          </tr>
        )}
      </Fragment>
    );
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
        <span className="text-xs text-zinc-400">
          PDF, Word, or text · re-uploading a file with the same name saves a new version — applications always keep the exact file they used
        </span>
      </div>
      {notice && <p className="text-xs text-green-600 dark:text-green-400">{notice}</p>}
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
            {groups.map((versions) => {
              const [latest, ...older] = versions;
              return (
                <Fragment key={latest.name}>
                  {renderRow(latest, versions, false)}
                  {expandedNames.has(latest.name) && older.map((doc) => renderRow(doc, versions, true))}
                </Fragment>
              );
            })}
            {activeDocs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-400">
                  No {LABEL[kind]}s uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {archivedDocs.length > 0 && (
        <div className="space-y-2">
          <button onClick={() => setShowArchived(!showArchived)} className="text-xs text-zinc-500 hover:underline">
            {showArchived ? "▾" : "▸"} Archived ({archivedDocs.length}) — kept because applications reference them
          </button>
          {showArchived && (
            <div className="overflow-x-auto rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {archivedDocs.map((doc) => (
                    <tr key={doc.id} className="text-zinc-500">
                      <td className="px-4 py-2.5">
                        <a
                          href={`/api/documents/${doc.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {documentLabel(doc, documents)}
                        </a>
                        <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                          archived
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{formatDateTime(doc.uploaded_at)}</td>
                      <td className="px-4 py-2.5">
                        <span className="flex flex-wrap gap-1.5">
                          {doc.used_by.map((job) => (
                            <Link
                              key={job.id}
                              href={`/jobs/${job.id}`}
                              className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                            >
                              {job.company} — {job.title}
                            </Link>
                          ))}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button onClick={() => void restore(doc)} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                          restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
