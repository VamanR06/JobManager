"use client";

import { useEffect, useState } from "react";
import type { AnswerScope, ApplicationField, FieldCategory } from "@/lib/workflow-types";

const STATUS: Record<string, { label: string; cls: string }> = {
  filled: { label: "Filled", cls: "text-green-700 dark:text-green-400" },
  resolved: { label: "Ready", cls: "text-zinc-600 dark:text-zinc-300" },
  unknown: { label: "Needs you", cls: "text-amber-700 dark:text-amber-400" },
  skipped: { label: "Left blank", cls: "text-zinc-400" },
  mismatch: { label: "Check it", cls: "text-red-600 dark:text-red-400" },
  unsupported: { label: "Do it yourself", cls: "text-red-600 dark:text-red-400" },
};

const CATEGORY: Record<FieldCategory, string> = {
  fact: "profile fact", eligibility: "eligibility", demographic: "voluntary", attestation: "attestation",
  narrative: "written answer", file: "upload", other: "question",
};

/** Narratives and attestations default to this job only; everything else is reusable. */
const defaultScope = (c: FieldCategory): AnswerScope => (c === "narrative" || c === "attestation" ? "job" : "global");

const inputCls = "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export default function ApplicationForm({
  jobId, fields, canPrepare, hasApproved, onChanged,
}: { jobId: number; fields: ApplicationField[]; canPrepare: boolean; hasApproved: boolean; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, { answer: string; scope: AnswerScope }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [engine, setEngine] = useState<"codex" | "claude">("codex");
  const [drafting, setDrafting] = useState<string | "all" | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchReport, setMatchReport] = useState<{
    matched: { label: string; value: string; reason: string }[];
    suggested: { field_key: string; label: string; value: string; reason: string }[];
    rejected: { label: string; why: string }[];
    unmatched: string[];
    refilling: boolean;
    seconds: number;
  } | null>(null);
  const [draftInfo, setDraftInfo] = useState<Record<string, { unknown_facts: string[]; over_limit?: boolean }>>({});

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((s) => setEngine(s.resume_engine === "claude" ? "claude" : "codex")).catch(() => {});
  }, []);

  /** Lets the chosen engine map leftover questions onto your own facts; accepted ones are saved and filled. */
  async function aiMatch() {
    setMatching(true);
    setError(null);
    setMatchReport(null);
    try {
      const res = await fetch(`/api/queue/${jobId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Matching failed");
      setMatchReport(body);
      // Implied answers are pre-selected for you to confirm with Save; nothing is saved for them yet.
      const byKey = new Map(fields.map((f) => [f.field_key, f]));
      for (const sug of body.suggested as { field_key: string; value: string }[]) {
        const f = byKey.get(sug.field_key);
        if (f) set(f, { answer: sug.value, scope: "job" });
      }
      if (body.matched.length) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Matching failed");
    } finally {
      setMatching(false);
    }
  }

  /** Asks the chosen engine for drafts; they land in the answer boxes for editing. */
  async function requestDraft(keys: string[] | null) {
    setDrafting(keys && keys.length === 1 ? keys[0] : "all");
    setError(null);
    try {
      const res = await fetch(`/api/queue/${jobId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine, field_keys: keys ?? undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Drafting failed");
      const byKey = new Map(fields.map((f) => [f.field_key, f]));
      for (const d of body.drafts as { field_key: string; answer: string; unknown_facts: string[]; over_limit?: boolean }[]) {
        const f = byKey.get(d.field_key);
        if (f) set(f, { answer: d.answer });
      }
      setDraftInfo((prev) => ({
        ...prev,
        ...Object.fromEntries((body.drafts as { field_key: string; unknown_facts: string[]; over_limit?: boolean }[])
          .map((d) => [d.field_key, { unknown_facts: d.unknown_facts, over_limit: d.over_limit }])),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drafting failed");
    } finally {
      setDrafting(null);
    }
  }

  async function post(body: object) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/queue/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      setDrafts({});
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!canPrepare) return null;
  if (!fields.length) {
    return (
      <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
        <span className="font-semibold">Application form</span>
        {hasApproved ? (
          <button onClick={() => post({ action: "prepare" })} disabled={busy} className="ml-3 rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
            Prepare application
          </button>
        ) : (
          <span className="ml-3 text-zinc-500">Approve a resume and the form will be filled in the JobManager browser.</span>
        )}
        {error && <span className="ml-3 text-red-600">{error}</span>}
      </div>
    );
  }

  const unknown = fields.filter((f) => f.status === "unknown");
  const shown = showAll ? fields : fields.filter((f) => f.status !== "skipped" || f.required);
  const set = (f: ApplicationField, patch: Partial<{ answer: string; scope: AnswerScope }>) =>
    setDrafts((d) => ({ ...d, [f.field_key]: { answer: d[f.field_key]?.answer ?? "", scope: d[f.field_key]?.scope ?? defaultScope(f.category), ...patch } }));
  // Save whatever you've answered so far; the rest stays open for later.
  const answeredCount = Object.values(drafts).filter((d) => d.answer?.trim()).length;
  const ready = answeredCount > 0;
  const editable = (f: ApplicationField) => f.status === "unknown" || f.status === "mismatch";
  const draftable = (f: ApplicationField) =>
    f.status === "unknown" && (f.category === "narrative" || f.category === "other") && (f.kind === "text" || f.kind === "textarea");
  const draftableCount = fields.filter(draftable).length;
  const matchableCount = fields.filter(
    (f) => f.status === "unknown" && !["narrative", "attestation", "demographic", "file"].includes(f.category)
  ).length;

  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">Application form</span>
        <span className="text-xs text-zinc-500">
          {fields.filter((f) => f.status === "filled").length} filled · {unknown.length} need you · never submitted automatically
        </span>
        <button onClick={() => setShowAll(!showAll)} className="text-xs text-zinc-500 hover:underline">
          {showAll ? "Hide blank optional fields" : "Show all fields"}
        </button>
        <button onClick={() => post({ action: "prepare" })} disabled={busy || !hasApproved} className="ml-auto text-xs text-blue-600 hover:underline disabled:opacity-50">
          Re-scan and fill again
        </button>
      </div>
      {matchableCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs dark:bg-zinc-900">
          <button
            onClick={aiMatch}
            disabled={matching || !!drafting}
            className="rounded-md bg-teal-600 px-2.5 py-1 font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {matching ? "Matching… (about 15–60 s)" : `🔎 AI-match ${matchableCount} leftover question${matchableCount === 1 ? "" : "s"}`}
          </button>
          <span className="text-zinc-500">
            Maps them onto your Profile and saved answers ({engine === "claude" ? "Claude" : "Codex"}). It can only pick options or reuse your values as-is.
          </span>
        </div>
      )}
      {matchReport && (
        <div className="space-y-1 rounded-md border border-teal-200 px-2 py-1.5 text-xs dark:border-teal-900">
          <div className="font-medium">
            AI match ({matchReport.seconds}s): {matchReport.matched.length} matched{matchReport.refilling ? ", refilling the form" : ""}
            {matchReport.suggested.length ? `, ${matchReport.suggested.length} suggested for you to confirm` : ""}
            {matchReport.unmatched.length ? `, ${matchReport.unmatched.length} still need you` : ""}
          </div>
          {matchReport.matched.map((m, i) => (
            <div key={i} className="text-teal-800 dark:text-teal-300">
              ✓ {m.label} → <b>{m.value}</b> <span className="text-zinc-500">({m.reason})</span>
            </div>
          ))}
          {matchReport.suggested.map((m, i) => (
            <div key={`s${i}`} className="text-amber-700 dark:text-amber-400">
              ? {m.label} → <b>{m.value}</b> <span className="text-zinc-500">(implied: {m.reason}). Pre-selected below; press Save to use it</span>
            </div>
          ))}
          {matchReport.rejected.map((m, i) => (
            <div key={i} className="text-red-600">✗ {m.label}: rejected, {m.why}</div>
          ))}
        </div>
      )}
      {draftableCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs dark:bg-zinc-900">
          <button
            onClick={() => requestDraft(null)}
            disabled={!!drafting}
            className="rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {drafting === "all" ? "Drafting… (about 1–3 min)" : `✨ Draft ${draftableCount} written answer${draftableCount === 1 ? "" : "s"} with AI`}
          </button>
          <select value={engine} onChange={(e) => setEngine(e.target.value as "codex" | "claude")} disabled={!!drafting}
            className="rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900" aria-label="Engine for drafts">
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
          <span className="text-zinc-500">Uses only your content bank, STAR stories, this job&apos;s approved resume and the posting. Review before saving.</span>
        </div>
      )}
      <table className="w-full text-xs">
        <tbody>
          {shown.map((f) => {
            const opts = JSON.parse(f.options) as string[];
            const st = STATUS[f.status] ?? STATUS.resolved;
            const draft = drafts[f.field_key];
            return (
              <tr key={f.field_key} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                <td className="w-2/5 py-1.5 pr-2">
                  {f.label}
                  {f.required ? <span className="text-red-500"> *</span> : null}
                  <div className="text-zinc-400">{CATEGORY[f.category]}</div>
                </td>
                <td className={`w-20 py-1.5 pr-2 font-medium ${st.cls}`}>{st.label}</td>
                <td className="py-1.5">
                  {editable(f) ? (
                    <div className="space-y-1">
                      {f.status === "mismatch" && (
                        <div className="text-red-600">
                          Page shows “{f.readback ?? ""}” instead of “{f.answer ?? ""}”. Fix it in the browser, or pick the right answer here.
                        </div>
                      )}
                      {f.category === "attestation" && !opts.length || (f.category === "attestation" && f.kind === "checkbox" && opts.length <= 1) ? (
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={draft?.answer === "yes"} onChange={(e) => set(f, { answer: e.target.checked ? "yes" : "" })} />
                          I confirm this for this application
                        </label>
                      ) : f.kind === "checkbox" && opts.length > 1 ? (
                        <div className="space-y-0.5">
                          {opts.map((o) => {
                            const chosen = (draft?.answer ?? "").split(/\s*;\s*/).filter(Boolean);
                            return (
                              <label key={o} className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={chosen.includes(o)}
                                  onChange={(e) => set(f, { answer: (e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o)).join("; ") })}
                                />
                                {o}
                              </label>
                            );
                          })}
                        </div>
                      ) : opts.length ? (
                        <select value={draft?.answer ?? ""} onChange={(e) => set(f, { answer: e.target.value })} className={inputCls}>
                          <option value="">Choose…</option>
                          {opts.map((o) => <option key={o}>{o}</option>)}
                        </select>
                      ) : f.category === "narrative" || f.kind === "textarea" ? (
                        <textarea rows={3} value={draft?.answer ?? ""} onChange={(e) => set(f, { answer: e.target.value })} className={inputCls} />
                      ) : (
                        <input value={draft?.answer ?? ""} onChange={(e) => set(f, { answer: e.target.value })} className={inputCls} />
                      )}
                      {f.category !== "attestation" && (
                        <select value={draft?.scope ?? defaultScope(f.category)} onChange={(e) => set(f, { scope: e.target.value as AnswerScope })} className="rounded border border-zinc-300 bg-white px-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                          <option value="global">Reuse for all applications</option>
                          <option value="company">Reuse for this company</option>
                          <option value="job">This application only</option>
                        </select>
                      )}
                      {draftable(f) && (
                        <button onClick={() => requestDraft([f.field_key])} disabled={!!drafting} className="text-violet-600 hover:underline disabled:opacity-50">
                          {drafting === f.field_key ? "Drafting…" : draftInfo[f.field_key] ? "Redraft with AI" : "✨ Draft with AI"}
                        </button>
                      )}
                      {f.max_length && (
                        <span className={`ml-2 ${(draft?.answer.length ?? 0) > f.max_length ? "text-red-600" : "text-zinc-400"}`}>
                          {draft?.answer.length ?? 0}/{f.max_length}
                        </span>
                      )}
                      {draftInfo[f.field_key]?.unknown_facts.length ? (
                        <div className="rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          Add or check (not in your evidence): {draftInfo[f.field_key].unknown_facts.join("; ")}
                        </div>
                      ) : null}
                      {f.note && <div className="text-zinc-400">{f.note}</div>}
                    </div>
                  ) : (
                    <div>
                      <span>{f.readback ?? f.answer ?? ""}</span>
                      {f.answer_source && <span className="text-zinc-400"> · {f.answer_source}</span>}
                      {f.note && <div className={f.status === "mismatch" || f.status === "unsupported" ? "text-red-600" : "text-zinc-400"}>{f.note}</div>}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {fields.some(editable) && (
        <button
          onClick={() => post({ action: "answers", answers: Object.entries(drafts).filter(([, d]) => d.answer?.trim()).map(([field_key, d]) => ({ field_key, ...d })) })}
          disabled={busy || !ready}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {answeredCount ? `Save ${answeredCount} answer${answeredCount === 1 ? "" : "s"} and fill the form` : "Answer any question above to fill it in"}
        </button>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
