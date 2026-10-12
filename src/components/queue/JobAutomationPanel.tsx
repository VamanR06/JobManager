"use client";

import { useCallback, useEffect, useState } from "react";
import type { JobAutomationDetail } from "@/lib/automation";
import { ENGINE_LABELS, type ArtifactCheck, type ResumeArtifact, type ResumeEngineName } from "@/lib/workflow-types";
import { formatDateTime } from "@/lib/format";
import ApplicationForm from "./ApplicationForm";
import LatexEditor from "./LatexEditor";
import ReactMarkdown from "react-markdown";

const CHECK_ICON: Record<ArtifactCheck["status"], string> = { pass: "✓", fail: "✗", skipped: "–" };
const CHECK_CLS: Record<ArtifactCheck["status"], string> = {
  pass: "text-green-700 dark:text-green-400",
  fail: "text-red-600 dark:text-red-400",
  skipped: "text-zinc-400",
};

function ArtifactReview({ artifact, onChanged }: { artifact: ResumeArtifact; onChanged: () => void }) {
  const checks = JSON.parse(artifact.checks) as ArtifactCheck[];
  const failed = checks.filter((c) => c.status === "fail");
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState(false);
  const [reviseEngine, setReviseEngine] = useState<ResumeEngineName>(artifact.engine === "manual" ? "codex" : artifact.engine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject" | "revise") {
    let accept = false;
    if (action === "approve" && failed.length) {
      if (!confirm(`This version failed ${failed.length} check(s). Approve it anyway?`)) return;
      accept = true;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, feedback, accept_failed_checks: accept, engine: reviseEngine }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Action failed");
      setFeedback("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const file = (kind: string) => `/api/artifacts/${artifact.id}/file?kind=${kind}`;
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-semibold">Resume v{artifact.version}</span>
        <span className="rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
          {ENGINE_LABELS[artifact.engine]}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">{artifact.status.replace("_", " ")}</span>
        <span className="text-zinc-500">{formatDateTime(artifact.created_at)}</span>
        <span className="font-mono text-zinc-400" title={artifact.pdf_sha256}>pdf {artifact.pdf_sha256.slice(0, 10)}</span>
        <a href={`${file("pdf")}&download=1`} className="text-blue-600 hover:underline">PDF</a>
        <a href={file("tex")} target="_blank" className="text-blue-600 hover:underline">LaTeX</a>
        {artifact.report_path && <a href={file("report")} target="_blank" className="text-blue-600 hover:underline">Plugin report</a>}
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-blue-600 hover:underline">Edit LaTeX</button>
        )}
      </div>
      {editing ? (
        <LatexEditor artifactId={artifact.id} version={artifact.version} onClose={() => setEditing(false)} onSaved={onChanged} />
      ) : (
        <iframe src={file("pdf")} className="h-[36rem] w-full rounded border border-zinc-200 dark:border-zinc-800" />
      )}
      <ul className="space-y-0.5 text-xs">
        {checks.map((c) => (
          <li key={c.name} className={CHECK_CLS[c.status]}>
            {CHECK_ICON[c.status]} <span className="font-mono">{c.name}</span> — {c.detail}
          </li>
        ))}
      </ul>
      {artifact.summary && <p className="text-xs text-zinc-500">Plugin summary: {artifact.summary}</p>}
      {artifact.feedback && <p className="text-xs text-zinc-500">Requested changes: {artifact.feedback}</p>}
      {artifact.status === "pending_review" && (
        <div className="space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="What should change? (sent to Resume Builder for a revision)"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="flex gap-2">
            <button onClick={() => act("approve")} disabled={busy} className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
              Approve &amp; link to application
            </button>
            <button onClick={() => act("revise")} disabled={busy || !feedback.trim()} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Request revision
            </button>
            <select
              value={reviseEngine}
              onChange={(e) => setReviseEngine(e.target.value as ResumeEngineName)}
              className="rounded-md border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              aria-label="Engine for the revision"
            >
              <option value="codex">with Codex</option>
              <option value="claude">with Claude</option>
            </select>
            <button onClick={() => act("reject")} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950">
              Reject
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Expanded row: resume review, then the run history and event log. */
export default function JobAutomationPanel({ jobId, refreshKey }: { jobId: number; refreshKey: number }) {
  const [data, setData] = useState<JobAutomationDetail | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/queue/${jobId}`);
    if (res.ok) setData(await res.json());
  }, [jobId]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!data) return <p className="text-sm text-zinc-400">Loading…</p>;
  // Only the newest version is shown (e.g. your LaTeX edit, not the one it came from);
  // everything else, including an approved original, is under "Show all versions".
  const reviewable = data.artifacts.filter((a) => showAll || a.status === "pending_review" || a.status === "approved");
  const shown = showAll ? reviewable : reviewable.slice(0, 1);

  async function regenerate(engine: ResumeEngineName) {
    setError(null);
    const res = await fetch(`/api/queue/${jobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "regenerate", engine }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Could not queue");
    load();
  }

  return (
    <div className="space-y-4">
      <div className={shown.length > 1 ? "grid gap-4 lg:grid-cols-2" : ""}>
        {shown.map((a) => (
          <ArtifactReview key={a.id} artifact={a} onChanged={load} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-zinc-500">Generate a fresh version with</span>
        {(["codex", "claude"] as ResumeEngineName[]).map((e) => (
          <button key={e} onClick={() => regenerate(e)} className="rounded-md border border-zinc-300 px-2.5 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            {ENGINE_LABELS[e]}
          </button>
        ))}
        {data.artifacts.length > shown.length || showAll ? (
          <button onClick={() => setShowAll(!showAll)} className="text-zinc-500 hover:underline">
            {showAll ? "Show current only" : `Show all ${data.artifacts.length} versions`}
          </button>
        ) : null}
        {error && <span className="text-red-600">{error}</span>}
      </div>

      {data.description && (
        <details className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer select-none font-semibold">
            Job description
            <span className="ml-2 text-xs font-normal text-zinc-500">
              {data.description.captured_at ? `saved ${formatDateTime(data.description.captured_at)}` : ""}
              {data.description.source && (
                <>
                  {" · "}
                  <a href={data.description.source} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">original posting</a>
                </>
              )}
              {" · "}
              <a href={`/jobs/${jobId}`} className="text-blue-600 hover:underline">job page</a>
            </span>
          </summary>
          <div className="prose prose-sm prose-zinc mt-3 max-h-[32rem] max-w-none overflow-y-auto dark:prose-invert [&_a]:text-blue-600 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm">
            <ReactMarkdown>{data.description.markdown}</ReactMarkdown>
          </div>
        </details>
      )}

      <ApplicationForm
        jobId={jobId}
        fields={data.fields}
        canPrepare={data.can_prepare}
        hasApproved={data.artifacts.some((a) => a.status === "approved")}
        onChanged={load}
      />

      {data.runs.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-zinc-500">Codex runs</h4>
          <table className="w-full text-xs">
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="py-1 pr-2 font-mono">#{r.id}</td>
                  <td className="pr-2 whitespace-nowrap">{formatDateTime(r.started_at)}</td>
                  <td className="pr-2">{ENGINE_LABELS[r.engine]} · {r.purpose}</td>
                  <td className="pr-2 font-medium">{r.outcome ?? r.state}</td>
                  <td className="pr-2 font-mono text-zinc-400">{r.plugin_version?.split("+")[0] ?? ""}</td>
                  <td className="text-zinc-500">{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h4 className="mb-1 text-xs font-semibold text-zinc-500">Events</h4>
        <ul className="max-h-64 space-y-0.5 overflow-y-auto text-xs">
          {data.events.map((e) => (
            <li key={e.id} className="flex gap-2">
              <span className="shrink-0 text-zinc-400">{formatDateTime(e.created_at)}</span>
              <span className="shrink-0 font-mono">{e.type}</span>
              <span className="text-zinc-500">{e.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
