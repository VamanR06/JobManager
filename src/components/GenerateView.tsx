"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDocument, GenerationWithRefs } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import ResumePreview from "./ResumePreview";

interface Props {
  generations: GenerationWithRefs[];
  /** Generated resumes, so past runs can be reopened for revision. */
  resumes: AppDocument[];
}

/** Paste any job description and run it through the Resume Builder GPT. */
export default function GenerateView({ generations, resumes }: Props) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<AppDocument | null>(null);
  // The panel sits above the history table, so bring it into view when opened
  // from a row further down the page.
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result) previewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [result]);

  async function generate() {
    setBusy(true);
    setError(null);
    setWarning(null);
    setResult(null);
    try {
      const res = await fetch("/api/generate-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, company: company.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Generation failed");
      if (body.warning) setWarning(body.warning);
      setResult(body.document as AppDocument);
      setDescription("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <p className="text-sm text-zinc-500">
          Paste a job description below. It runs through your Resume Builder GPT in ChatGPT and the
          result is saved as a resume. Takes about a minute — keep the gateway running.
        </p>
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company (optional — used to name the file)"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={12}
          placeholder="Paste the job description here…"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={generate}
            disabled={busy || !description.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Generating… (~1 min)" : "Generate resume"}
          </button>
        </div>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        {warning && <p className="text-xs text-amber-600 dark:text-amber-400">{warning}</p>}
      </section>

      {result && (
        <div ref={previewRef}>
          <ResumePreview document={result} defaultOpen />
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recent generations</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">For</th>
                <th className="px-4 py-2.5">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {generations.map((gen) => (
                <tr key={gen.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-2.5 text-zinc-500">{formatDateTime(gen.created_at)}</td>
                  <td className="px-4 py-2.5">
                    {gen.job_id && gen.company ? (
                      <a
                        href={`/jobs/${gen.job_id}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {gen.company} — {gen.title}
                      </a>
                    ) : (
                      <span className="text-zinc-400">Pasted description</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {gen.state === "failed" ? (
                      <span className="text-red-600 dark:text-red-400">{gen.error ?? "Failed"}</span>
                    ) : gen.document_id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <a
                          href={`/api/documents/${gen.document_id}/file`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {gen.document_name} ↗
                        </a>
                        {resumes.some((r) => r.id === gen.document_id) && (
                          <button
                            onClick={() =>
                              setResult(
                                result?.id === gen.document_id
                                  ? null
                                  : resumes.find((r) => r.id === gen.document_id) ?? null
                              )
                            }
                            className="text-xs text-zinc-500 hover:underline"
                          >
                            {result?.id === gen.document_id ? "hide" : "preview / revise"}
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="text-zinc-400">{gen.state}</span>
                    )}
                  </td>
                </tr>
              ))}
              {generations.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-400">
                    Nothing generated yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
