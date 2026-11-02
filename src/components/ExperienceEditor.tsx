"use client";

import { useState } from "react";
import type { WorkExperience, WorkExperienceInput } from "@/lib/workflow-types";

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const smallBtn =
  "rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800";

const blank: WorkExperienceInput = {
  title: "", company: "", location: "", start_month: null, end_month: null, current: false, description: "",
};

const strip = ({ id: _, ...rest }: WorkExperience): WorkExperienceInput => rest;

/** Jobs for Work Experience sections (Workday's My Experience): entry 1 is the first job here, and so on. */
export default function ExperienceEditor({ initial }: { initial: WorkExperience[] }) {
  const [saved, setSaved] = useState(initial.map(strip));
  const [list, setList] = useState(initial.map(strip));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dirty = JSON.stringify(list) !== JSON.stringify(saved);
  const update = (i: number, patch: Partial<WorkExperienceInput>) => {
    setDone(false);
    setList(list.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  };
  const move = (i: number, by: number) => {
    const next = [...list];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setList(next);
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/experience", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experiences: list }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't save");
        return;
      }
      const clean = (data as WorkExperience[]).map(strip);
      setSaved(clean);
      setList(clean);
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">
        Most recent first, as on your resume. Autofill puts the first job in Work Experience 1, the second in Work
        Experience 2, and so on, and adds entries on forms like Workday&apos;s until there&apos;s one per job here.
      </p>
      {list.map((e, i) => (
        <fieldset key={i} className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Work Experience {i + 1}</span>
            <span className="flex-1" />
            <button type="button" className={smallBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
            <button type="button" className={smallBtn} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            <button type="button" className={smallBtn} onClick={() => setList(list.filter((_, j) => j !== i))}>Remove</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">Job title</span>
              <input value={e.title} onChange={(ev) => update(i, { title: ev.target.value })} className={inputCls} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">Company</span>
              <input value={e.company} onChange={(ev) => update(i, { company: ev.target.value })} className={inputCls} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">Location</span>
              <input value={e.location} placeholder="Ann Arbor, MI" onChange={(ev) => update(i, { location: ev.target.value })} className={inputCls} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">From</span>
                <input type="month" placeholder="YYYY-MM" value={e.start_month ?? ""} onChange={(ev) => update(i, { start_month: ev.target.value || null })} className={inputCls} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">To</span>
                <input type="month" placeholder="YYYY-MM" value={e.current ? "" : e.end_month ?? ""} disabled={e.current} onChange={(ev) => update(i, { end_month: ev.target.value || null })} className={`${inputCls} disabled:opacity-40`} />
              </label>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={e.current} onChange={(ev) => update(i, { current: ev.target.checked, end_month: ev.target.checked ? null : e.end_month })} />
            I currently work here
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Role description</span>
            <textarea rows={4} value={e.description} onChange={(ev) => update(i, { description: ev.target.value })} className={inputCls} />
          </label>
        </fieldset>
      ))}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setList([...list, { ...blank }])} className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Add a job
        </button>
        <button onClick={save} disabled={busy || !dirty} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          Save
        </button>
        {done && !dirty && <span className="text-sm text-green-700">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
