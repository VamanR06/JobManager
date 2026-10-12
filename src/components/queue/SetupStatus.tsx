"use client";

import { useEffect, useState } from "react";

interface Preflight {
  ok: boolean;
  checkedAt: string;
  cliVersion: string | null;
  loggedIn: boolean;
  plugin: { ref: string; version: string; skillDir: string; resourceHash: string; files: number } | null;
  tools: Record<string, string | null>;
  blockers: { code: string; message: string }[];
}

type Engine = "codex" | "claude";
const LABEL: Record<Engine, string> = { codex: "Codex", claude: "Claude" };

/**
 * Engine toggle plus readiness (CLI, login, plugin, LaTeX) for the selected
 * engine, so setup problems show up before a job hits them.
 */
export default function SetupStatus() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [data, setData] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function check(which: Engine) {
    setBusy(true);
    try {
      const res = await fetch(`/api/codex/preflight?engine=${which}`);
      setData(await res.json());
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: { resume_engine: Engine }) => {
        setEngine(s.resume_engine);
        check(s.resume_engine);
      });
  }, []);

  async function choose(next: Engine) {
    setEngine(next);
    setData(null);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume_engine: next }),
    });
    check(next);
  }

  return (
    <section className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Resume Builder</h2>
        <div className="inline-flex rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700" role="group" aria-label="Resume engine">
          {(["codex", "claude"] as Engine[]).map((e) => (
            <button
              key={e}
              onClick={() => engine !== e && choose(e)}
              className={`rounded px-2.5 py-1 ${engine === e ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}
            >
              {LABEL[e]}
            </button>
          ))}
        </div>
        {busy && <span className="text-zinc-400">checking…</span>}
        {data && !busy && (
          <span className={data.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
            {data.ok ? `Ready: new resumes use ${engine ? LABEL[engine] : ""}` : `${data.blockers.length} problem${data.blockers.length === 1 ? "" : "s"}`}
          </span>
        )}
        <button onClick={() => setOpen(!open)} className="ml-auto text-xs text-zinc-500 hover:underline">
          {open ? "Hide details" : "Details"}
        </button>
        <button onClick={() => engine && check(engine)} disabled={busy || !engine} className="text-xs text-blue-600 hover:underline disabled:opacity-50">
          Re-check
        </button>
      </div>
      {data && data.blockers.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-red-700 dark:text-red-400">
          {data.blockers.map((b, i) => (
            <li key={i}>{b.message}</li>
          ))}
        </ul>
      )}
      {open && data && (
        <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-zinc-500">{engine ? LABEL[engine] : ""} CLI</dt>
          <dd>{data.cliVersion ?? "not found"}</dd>
          <dt className="text-zinc-500">Login</dt>
          <dd>{data.loggedIn ? "logged in" : "not logged in"}</dd>
          <dt className="text-zinc-500">Plugin</dt>
          <dd className="break-all">{data.plugin ? `${data.plugin.ref} @ ${data.plugin.version}` : "—"}</dd>
          <dt className="text-zinc-500">Skill folder</dt>
          <dd className="break-all font-mono">{data.plugin?.skillDir ?? "—"}</dd>
          <dt className="text-zinc-500">Resource hash</dt>
          <dd className="font-mono">{data.plugin ? `${data.plugin.resourceHash.slice(0, 16)}… (${data.plugin.files} files)` : "—"}</dd>
          {Object.entries(data.tools).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="font-mono">{v ?? "missing"}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
