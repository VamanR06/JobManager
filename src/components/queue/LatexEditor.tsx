"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Edit a resume version's LaTeX and render it locally. Saving creates a new
 * version for review; the version you started from is never modified.
 */
export default function LatexEditor({
  artifactId, version, onClose, onSaved,
}: { artifactId: number; version: number; onClose: () => void; onSaved: () => void }) {
  const [tex, setTex] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<"render" | "save" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch(`/api/artifacts/${artifactId}/file?kind=tex`)
      .then((r) => r.text())
      .then((t) => {
        setTex(t);
        setOriginal(t);
      });
  }, [artifactId]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  async function call(action: "render" | "save") {
    if (tex === null) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/latex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, tex, note }),
      });
      const body = await res.json();
      if (!body.ok) {
        setErrors(body.errors ?? [body.error ?? "Failed"]);
        return;
      }
      setErrors([]);
      if (action === "render") {
        const bytes = Uint8Array.from(atob(body.pdf), (c) => c.charCodeAt(0));
        setPreview(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
        setPages(body.pages);
      } else {
        onSaved();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  /** Wraps the selection in a command, e.g. \textbf{…}. */
  function wrap(cmd: string) {
    const el = area.current;
    if (!el || tex === null) return;
    const { selectionStart: a, selectionEnd: b } = el;
    if (a === b) return;
    const next = `${tex.slice(0, a)}\\${cmd}{${tex.slice(a, b)}}${tex.slice(b)}`;
    setTex(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a, b + cmd.length + 3);
    });
  }

  if (tex === null) return <p className="text-sm text-zinc-400">Loading LaTeX…</p>;
  const changed = tex !== original;
  const btn = "rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

  return (
    <div className="space-y-2 rounded-lg border border-blue-200 p-3 dark:border-blue-900">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">Editing LaTeX of v{version}</span>
        <button className={`${btn} font-bold`} onClick={() => wrap("textbf")} title="Bold the selection">B</button>
        <button className={`${btn} italic`} onClick={() => wrap("textit")} title="Italicize the selection">I</button>
        <button className={btn} onClick={() => setTex(original)} disabled={!changed}>Undo all changes</button>
        <span className="text-zinc-500">⌘/Ctrl + Enter renders · compiled on this Mac, no AI tokens used</span>
        <button className={`${btn} ml-auto`} onClick={onClose}>Close</button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <textarea
          ref={area}
          value={tex}
          spellCheck={false}
          onChange={(e) => setTex(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              call("render");
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
              e.preventDefault();
              wrap("textbf");
            }
          }}
          className="h-[36rem] w-full resize-y rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs leading-5 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <div className="space-y-2">
          {preview ? (
            <iframe src={preview} className="h-[36rem] w-full rounded border border-zinc-200 dark:border-zinc-800" />
          ) : (
            <div className="flex h-[36rem] items-center justify-center rounded border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
              Press Render to preview
            </div>
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded bg-red-50 py-1.5 pl-6 pr-2 font-mono text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => call("render")} disabled={!!busy} className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900">
          {busy === "render" ? "Rendering…" : "Render"}
        </button>
        {pages !== null && (
          <span className={`text-xs ${pages === 1 ? "text-green-700 dark:text-green-400" : "text-red-600"}`}>
            {pages} page{pages === 1 ? "" : "s"}
          </span>
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What you changed (optional)"
          className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button onClick={() => call("save")} disabled={!!busy || !changed} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {busy === "save" ? "Saving…" : "Save as new version"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
