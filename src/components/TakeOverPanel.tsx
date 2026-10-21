"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const KEYS: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Escape: "Escape", " ": "Space",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
};

type Input =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dy: number; x?: number; y?: number };

/**
 * Drive the application's tab in the server's browser yourself, e.g. to solve
 * a CAPTCHA: a live picture of the page (refreshed about once a second while
 * open); clicks, scrolling and typing on it go to the real page.
 */
export default function TakeOverPanel({ jobId }: { jobId: number }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 1280, h: 900 });
  const [pageUrl, setPageUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [text, setText] = useState("");
  const busy = useRef(false);
  const lastScroll = useRef(0);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`/api/jobs/${jobId}/takeover`, { cache: "no-store" });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "Couldn't load the page");
        return;
      }
      setError(null);
      setSize({ w: Number(res.headers.get("X-View-Width")) || 1280, h: Number(res.headers.get("X-View-Height")) || 900 });
      setPageUrl(decodeURI(res.headers.get("X-Page-Url") ?? ""));
      const url = URL.createObjectURL(await res.blob());
      setSrc((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } finally {
      busy.current = false;
    }
  }, [jobId]);

  useEffect(() => {
    if (!open) return;
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 1200);
    return () => clearInterval(t);
  }, [open, refresh]);

  async function send(input: Input) {
    setError(null);
    const res = await fetch(`/api/jobs/${jobId}/takeover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error ?? "Couldn't send that");
    else if (data.note) setNote(data.note);
    await refresh();
  }

  /** Where on the page (in its own pixels) a point on the picture is. */
  function pagePoint(e: { clientX: number; clientY: number; currentTarget: HTMLImageElement }) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) * size.w) / r.width), y: Math.round(((e.clientY - r.top) * size.h) / r.height) };
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-blue-600 hover:underline">
        Take over the browser (e.g. to solve a CAPTCHA)
      </button>
    );
  }

  const btn = "rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";
  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">Take over</span>
        <span className="truncate text-zinc-400" title={pageUrl}>{pageUrl}</span>
        <button onClick={() => setOpen(false)} className="ml-auto text-zinc-500 hover:underline">Close</button>
      </div>
      <p className="text-xs text-zinc-500">
        Click, scroll or type on the picture and it happens on the real page. Solve the CAPTCHA (or whatever needs a
        person), then tell ChatGPT to carry on.
      </p>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="The application page in the server's browser"
          tabIndex={0}
          className="w-full cursor-crosshair rounded border border-zinc-300 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700"
          onClick={(e) => {
            e.currentTarget.focus();
            send({ kind: "click", ...pagePoint(e) });
          }}
          onWheel={(e) => {
            const now = Date.now();
            if (now - lastScroll.current < 250) return;
            lastScroll.current = now;
            send({ kind: "scroll", dy: Math.sign(e.deltaY) * 400, ...pagePoint(e) });
          }}
          onKeyDown={(e) => {
            // Keys typed while the picture has focus go to the page.
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "Tab") {
              e.preventDefault();
              send({ kind: "key", key: e.shiftKey ? "Shift+Tab" : "Tab" });
            } else if (KEYS[e.key]) {
              e.preventDefault();
              send({ kind: "key", key: KEYS[e.key] });
            } else if (e.key.length === 1) {
              e.preventDefault();
              send({ kind: "type", text: e.key });
            }
          }}
        />
      ) : (
        <p className="text-sm text-zinc-400">Loading the page…</p>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text) send({ kind: "type", text }).then(() => setText(""));
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Text to type into the focused field"
          className="w-64 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button type="submit" disabled={!text} className={btn}>Type</button>
        {["Enter", "Tab", "Backspace", "Escape"].map((k) => (
          <button key={k} type="button" className={btn} onClick={() => send({ kind: "key", key: k })}>{k}</button>
        ))}
        <button type="button" className={btn} onClick={() => send({ kind: "scroll", dy: -400 })}>Scroll up</button>
        <button type="button" className={btn} onClick={() => send({ kind: "scroll", dy: 400 })}>Scroll down</button>
      </form>
      {note && <p className="text-xs text-green-700">{note}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
