"use client";

import { useState } from "react";
import { PROFILE_FIELDS, type ProfileFact } from "@/lib/workflow-types";
import { formatDateTime } from "@/lib/format";

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/** Facts the automation may use verbatim. Saving here is the confirmation. */
export default function ProfileEditor({ initial }: { initial: ProfileFact[] }) {
  const byKey = Object.fromEntries(initial.map((f) => [f.key, f]));
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, byKey[f.key]?.value ?? ""]))
  );
  const [facts, setFacts] = useState(byKey);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const list = (await res.json()) as ProfileFact[];
      setFacts(Object.fromEntries(list.map((f) => [f.key, f])));
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  const groups = [...new Set(PROFILE_FIELDS.map((f) => f.group))];
  const dirty = PROFILE_FIELDS.some((f) => (facts[f.key]?.value ?? "") !== values[f.key].trim());
  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-500">
        Only enter what you&apos;d stand behind on an application. The automation uses these values exactly and never
        guesses them from resume wording. Leave a field blank to have it ask you instead.
        Work authorization and future sponsorship are separate questions on purpose.
      </p>
      {groups.map((g) => (
        <fieldset key={g} className="space-y-2">
          <legend className="text-sm font-semibold">{g}</legend>
          {PROFILE_FIELDS.filter((f) => f.group === g).map((f) => (
            <label key={f.key} className="grid grid-cols-[16rem_1fr_9rem] items-center gap-3 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">{f.label}</span>
              <input value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className={inputCls} />
              <span className="text-xs text-zinc-400">
                {facts[f.key]?.verified_at ? `confirmed ${formatDateTime(facts[f.key].verified_at!)}` : ""}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || !dirty} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          Save
        </button>
        {saved && !dirty && <span className="text-sm text-green-700">Saved</span>}
      </div>
    </div>
  );
}
