"use client";

import { useState } from "react";
import Link from "next/link";
import type { AnswerRow } from "@/lib/apply/answers";

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

const SCOPES = [
  { scope: "global", title: "All applications" },
  { scope: "company", title: "One company" },
  { scope: "job", title: "One application" },
] as const;

/** The answer bank: answers to form questions that browser_autofill reuses. */
export default function AnswersEditor({ initial }: { initial: AnswerRow[] }) {
  const [rows, setRows] = useState(initial);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, method: string, body?: unknown) {
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Couldn't save");
      return false;
    }
    setRows(data as AnswerRow[]);
    return true;
  }

  async function save(id: number) {
    if (await send(`/api/answers/${id}`, "PATCH", { answer: drafts[id] })) {
      setDrafts(({ [id]: _, ...rest }) => rest);
    }
  }

  async function remove(r: AnswerRow) {
    if (!confirm(`Delete the saved answer to "${r.question_text}"?`)) return;
    await send(`/api/answers/${r.id}`, "DELETE");
  }

  async function add() {
    if (await send("/api/answers", "POST", { question, answer })) {
      setQuestion("");
      setAnswer("");
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-500">
        Answers to application questions, reused when forms are filled. A question with fixed choices needs an
        answer that matches one of them (e.g. &quot;Yes&quot;).
      </p>

      {SCOPES.map(({ scope, title }) => {
        const list = rows.filter((r) => r.scope === scope);
        if (!list.length) return null;
        return (
          <section key={scope} className="space-y-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {list.map((r) => {
              const draft = drafts[r.id];
              const dirty = draft !== undefined && draft.trim() !== r.answer;
              return (
                <div key={r.id} className="space-y-1 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{r.question_text}</span>
                    {r.scope === "company" && <span className="text-xs text-zinc-400">{r.company_key}</span>}
                    {r.scope === "job" && r.job_id && (
                      <Link href={`/jobs/${r.job_id}`} className="text-xs text-blue-600 hover:underline">
                        {r.job_label ?? `Application ${r.job_id}`}
                      </Link>
                    )}
                    {r.has_options && <span className="text-xs text-zinc-400">fixed choices</span>}
                  </div>
                  <div className="flex items-start gap-2">
                    <textarea
                      value={draft ?? r.answer}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })}
                      rows={Math.min(6, Math.max(1, Math.ceil((draft ?? r.answer).length / 80)))}
                      className={inputCls}
                    />
                    <button
                      onClick={() => save(r.id)}
                      disabled={!dirty || !draft?.trim()}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button onClick={() => remove(r)} className="px-1 py-1.5 text-xs text-red-600 hover:underline">
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
      {!rows.length && <p className="text-sm text-zinc-400">No saved answers yet.</p>}

      <section className="space-y-2 rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
        <h3 className="text-sm font-semibold">Add an answer for all applications</h3>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder='Question as forms ask it, e.g. "How did you hear about {company}?"'
          className={inputCls}
        />
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" rows={2} className={inputCls} />
        <div className="flex items-center gap-3">
          <button
            onClick={add}
            disabled={!question.trim() || !answer.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Add
          </button>
          <span className="text-xs text-zinc-400">Write {"{company}"} where the company&apos;s name goes.</span>
        </div>
      </section>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
