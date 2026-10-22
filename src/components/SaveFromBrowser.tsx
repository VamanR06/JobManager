"use client";

import { useCallback, useEffect, useState } from "react";
import { bookmarklet } from "@/lib/bookmarklet";

interface Posting {
  url: string;
  title: string | null;
  company: string | null;
  location: string | null;
  description_html?: string | null;
  description_text?: string | null;
}
interface JobRef {
  id: number;
  company: string;
  title: string;
  url: string | null;
}
type Result =
  | { outcome: "created" | "updated"; job_id: number }
  | { outcome: "duplicate"; same_posting: JobRef | null; similar: JobRef[] };

const inputCls = "w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/** Plain text of the description, for the preview. */
function previewText(p: Posting): string {
  if (p.description_text) return p.description_text;
  if (!p.description_html) return "";
  const div = document.createElement("div");
  div.innerHTML = p.description_html;
  return div.innerText || div.textContent || "";
}

/**
 * The /save page. Opened by the "Save to JobManager" bookmarklet with the
 * posting (read by the person's browser) in the URL fragment, which never
 * reaches the server. Without one, it shows how to install the bookmarklet.
 */
export default function SaveFromBrowser() {
  const [posting, setPosting] = useState<Posting | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  // React won't render javascript: URLs, so the bookmarklet's address is set on the element
  // itself, as soon as it exists. (It's only rendered after loading; setting it from the
  // load effect found no element and left the link pointing at "#", i.e. just /save.)
  const bookmarkRef = useCallback((el: HTMLAnchorElement | null) => {
    el?.setAttribute("href", bookmarklet(window.location.origin));
  }, []);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      try {
        const p = JSON.parse(decodeURIComponent(hash)) as Posting;
        if (p && typeof p.url === "string") setPosting(p);
        else setError("That link didn't contain a job posting.");
      } catch {
        setError("That link didn't contain a job posting.");
      }
    }
    setLoaded(true);
  }, []);

  async function save(opts: { job_id?: number; allow_duplicate?: boolean } = {}) {
    if (!posting) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/import/posting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posting, ...opts }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 409) throw new Error(data.error ?? "Couldn't save");
      setResult(data as Result);
      if (data.outcome === "created" || data.outcome === "updated") {
        // Don't resubmit on reload.
        history.replaceState(null, "", window.location.pathname);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const setup = (
    <section className="space-y-2 text-sm">
      <p>
        Some job sites (Workday in particular) refuse requests from the server JobManager runs on, so it can&apos;t
        read their postings itself. This bookmark reads the posting in <em>your</em> browser instead, from the page you
        already have open, and brings it here.
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          Drag this to your bookmarks bar:{" "}
          <a ref={bookmarkRef} href="#" onClick={(e) => e.preventDefault()} className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white">
            Save to JobManager
          </a>{" "}
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(bookmarklet(window.location.origin)).catch(() => {});
              setCopied(true);
            }}
            className="ml-1 text-xs text-blue-600 hover:underline"
          >
            {copied ? "Copied" : "Copy its code"}
          </button>
          <span className="ml-2 text-xs text-zinc-500">
            (can&apos;t drag, e.g. on a phone? Bookmark any page, then edit the bookmark and paste the code as its address)
          </span>
          <p className="text-xs text-zinc-500">
            If you already added it and clicking it just opens this page, delete that bookmark and drag this one again.
          </p>
        </li>
        <li>Open a job posting (any Workday job, or any site) and click the bookmark.</li>
        <li>This page opens with the posting. Check it and press Save.</li>
      </ol>
    </section>
  );

  if (!loaded) return null;
  if (!posting) {
    return (
      <div className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {setup}
      </div>
    );
  }

  if (result?.outcome === "created" || result?.outcome === "updated") {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-green-700 dark:text-green-400">
          {result.outcome === "created" ? "Saved as a new application (To apply)." : "Description and title filled in."}
        </p>
        <a href={`/jobs/${result.job_id}`} className="text-blue-600 hover:underline">Open the application →</a>
      </div>
    );
  }

  const text = previewText(posting);
  const field = (k: "company" | "title" | "location", label: string) => (
    <label className="block space-y-1 text-sm">
      <span className="text-zinc-500">{label}</span>
      <input value={posting[k] ?? ""} onChange={(e) => setPosting({ ...posting, [k]: e.target.value })} className={inputCls} />
    </label>
  );
  const dup = result?.outcome === "duplicate" ? result : null;

  return (
    <div className="space-y-4">
      <p className="truncate text-xs text-zinc-500" title={posting.url}>{posting.url}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("company", "Company")}
        {field("title", "Title")}
        {field("location", "Location")}
      </div>
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-200 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
        {text.slice(0, 4000) || "(no description found on the page)"}
      </div>
      <p className="text-xs text-zinc-400">{text.length.toLocaleString()} characters</p>

      {dup ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {dup.same_posting && (
            <div className="space-y-1">
              <p>
                You already track this posting:{" "}
                <a href={`/jobs/${dup.same_posting.id}`} className="underline">{dup.same_posting.company} — {dup.same_posting.title}</a>
              </p>
              <button disabled={busy} onClick={() => save({ job_id: dup.same_posting!.id })} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
                Fill in its description and title
              </button>
            </div>
          )}
          {dup.similar.length > 0 && (
            <div className="space-y-1">
              <p>Same company and title, another link:</p>
              <ul className="list-disc pl-5">
                {dup.similar.map((j) => (
                  <li key={j.id}>
                    <a href={`/jobs/${j.id}`} className="underline">{j.company} — {j.title}</a>{" "}
                    <button disabled={busy} onClick={() => save({ job_id: j.id })} className="ml-1 text-xs underline">fill in this one&apos;s description and title</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button disabled={busy} onClick={() => save({ allow_duplicate: true })} className="text-xs underline">Add as a new application anyway</button>
        </div>
      ) : (
        <button disabled={busy || !text.trim()} onClick={() => save()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {busy ? "Saving…" : "Save application"}
        </button>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
