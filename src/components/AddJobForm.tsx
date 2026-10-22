"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, statusName, type AppDocument, type DocumentKind, type Status } from "@/lib/types";
import { documentLabel, fromDatetimeLocal, toDatetimeLocal } from "@/lib/format";

interface JobRef {
  id: number;
  company: string;
  title: string;
  url: string | null;
}
interface Duplicates {
  error: string;
  same_posting: JobRef | null;
  similar: JobRef[];
}

interface ParsedPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  description_md: string;
}

interface Props {
  resumes: AppDocument[];
  coverLetters: AppDocument[];
}

/** Sentinel value for the "upload a new file" choice in the document dropdowns. */
const UPLOAD_OPTION = "__upload__";

export default function AddJobForm({ resumes: allResumes, coverLetters: allCoverLetters }: Props) {
  const router = useRouter();
  // Documents uploaded from inside this form, kept locally until router.refresh() brings them in via props.
  const [uploaded, setUploaded] = useState<AppDocument[]>([]);

  /** Active (non-archived) docs of a kind — new applications can't attach archived ones. */
  function options(fromProps: AppDocument[], kind: DocumentKind) {
    const extra = uploaded.filter((d) => d.kind === kind && !fromProps.some((p) => p.id === d.id));
    return [...fromProps, ...extra].filter((d) => !d.archived);
  }
  const resumes = options(allResumes, "resume");
  const coverLetters = options(allCoverLetters, "cover_letter");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [initialStatus, setInitialStatus] = useState<Status | "">("applied");
  const [when, setWhen] = useState("");
  const [resumeId, setResumeId] = useState("");
  const [coverLetterId, setCoverLetterId] = useState("");

  // Default the status date to now (set after mount to avoid hydration mismatch).
  useEffect(() => {
    setWhen(toDatetimeLocal(new Date().toISOString()));
  }, []);
  const [posting, setPosting] = useState<ParsedPosting | null>(null);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when saving found this job already tracked; the next save adds it anyway.
  const [dupes, setDupes] = useState<Duplicates | null>(null);
  useEffect(() => setDupes(null), [url, company, title]);
  const [notice, setNotice] = useState<string | null>(null);
  const resumeFileRef = useRef<HTMLInputElement>(null);
  const coverLetterFileRef = useRef<HTMLInputElement>(null);
  const [uploadingKind, setUploadingKind] = useState<DocumentKind | null>(null);

  /** Upload a picked file and select it in the matching dropdown. */
  async function uploadDocument(kind: DocumentKind, file: File | undefined) {
    if (!file) return;
    setUploadingKind(kind);
    setError(null);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      const res = await fetch("/api/documents", { method: "POST", body: form });
      const doc = await res.json();
      if (!res.ok) throw new Error(doc.error ?? "Upload failed");
      setUploaded((prev) => [...prev, doc as AppDocument]);
      setNotice(
        doc.duplicate
          ? `Identical to the existing ${documentLabel(doc)} — selected that instead of saving a copy.`
          : doc.version > 1
            ? `Saved as version ${doc.version} of ${doc.name}.`
            : null
      );
      if (kind === "resume") setResumeId(String(doc.id));
      else setCoverLetterId(String(doc.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingKind(null);
      if (resumeFileRef.current) resumeFileRef.current.value = "";
      if (coverLetterFileRef.current) coverLetterFileRef.current.value = "";
    }
  }

  /** Dropdown change: sentinels run an action instead of selecting a document. */
  function onDocumentChange(kind: DocumentKind, value: string) {
    if (value === UPLOAD_OPTION) {
      (kind === "resume" ? resumeFileRef : coverLetterFileRef).current?.click();
      return;
    }
    if (kind === "resume") setResumeId(value);
    else setCoverLetterId(value);
  }

  async function fetchPosting() {
    if (!url) return;
    setFetching(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Fetch failed");
      setPosting(data);
      if (data.company && !company) setCompany(data.company);
      if (data.title && !title) setTitle(data.title);
      setNotice("Posting fetched — description will be saved with the job");
    } catch (err) {
      setPosting(null);
      setError(
        (err instanceof Error ? err.message : "Fetch failed") +
          " — you can still save the job and paste the description manually"
      );
    } finally {
      setFetching(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company,
          title,
          url: url || null,
          posting: posting?.description_md ? posting : undefined,
          initial_status: initialStatus || undefined,
          occurred_at: fromDatetimeLocal(when),
          resume_id: resumeId ? Number(resumeId) : null,
          cover_letter_id: coverLetterId ? Number(coverLetterId) : null,
          allow_duplicate: dupes !== null,
        }),
      });
      if (res.status === 409) {
        const data = (await res.json()) as Duplicates;
        if (data.same_posting || data.similar?.length) {
          setDupes(data);
          return;
        }
        throw new Error(data.error ?? "Save failed");
      }
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      setDupes(null);
      setUrl("");
      setCompany("");
      setTitle("");
      setPosting(null);
      setNotice(null);
      setResumeId("");
      setCoverLetterId("");
      setUploaded([]);
      setWhen(toDatetimeLocal(new Date().toISOString()));
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        + Add application
      </button>
    );
  }

  const inputCls =
    "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <>
    <form onSubmit={submit} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">New application</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-zinc-500 hover:underline"
        >
          Cancel
        </button>
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          placeholder="Paste posting URL (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={inputCls}
        />
        <button
          type="button"
          onClick={fetchPosting}
          disabled={!url || fetching}
          className="shrink-0 rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          placeholder="Company *"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
          className={inputCls}
        />
        <input
          placeholder="Role title *"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className={inputCls}
        />
        <select
          value={initialStatus}
          onChange={(e) => setInitialStatus(e.target.value as Status | "")}
          className={inputCls}
        >
          <option value="">No initial status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              Initial status: {statusName(s)}
            </option>
          ))}
        </select>
      </div>

      {/* Kept outside the labels so clicking the label text doesn't open the file picker. */}
      <input
        ref={resumeFileRef}
        type="file"
        accept=".pdf,.doc,.docx,.txt,.md"
        onChange={(e) => void uploadDocument("resume", e.target.files?.[0])}
        className="hidden"
      />
      <input
        ref={coverLetterFileRef}
        type="file"
        accept=".pdf,.doc,.docx,.txt,.md"
        onChange={(e) => void uploadDocument("cover_letter", e.target.files?.[0])}
        className="hidden"
      />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs text-zinc-500">
          Date
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className="text-xs text-zinc-500">
          Resume used
          <select
            value={resumeId}
            onChange={(e) => onDocumentChange("resume", e.target.value)}
            disabled={uploadingKind === "resume"}
            className={`${inputCls} mt-1`}
          >
            <option value="">{uploadingKind === "resume" ? "Uploading…" : "— none —"}</option>
            <option value={UPLOAD_OPTION}>+ Upload new resume…</option>
            {resumes.map((d) => (
              <option key={d.id} value={d.id}>
                {documentLabel(d, resumes)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-zinc-500">
          Cover letter used
          <select
            value={coverLetterId}
            onChange={(e) => onDocumentChange("cover_letter", e.target.value)}
            disabled={uploadingKind === "cover_letter"}
            className={`${inputCls} mt-1`}
          >
            <option value="">{uploadingKind === "cover_letter" ? "Uploading…" : "— none —"}</option>
            {coverLetters.map((d) => (
              <option key={d.id} value={d.id}>
                {documentLabel(d, coverLetters)}
              </option>
            ))}
            <option value={UPLOAD_OPTION}>+ Upload new cover letter…</option>
          </select>
        </label>
      </div>

      {notice && <p className="text-xs text-green-600 dark:text-green-400">{notice}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {dupes && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">{dupes.error}:</p>
          <ul className="list-disc pl-5">
            {[...(dupes.same_posting ? [dupes.same_posting] : []), ...dupes.similar].map((j) => (
              <li key={j.id}>
                <a href={`/jobs/${j.id}`} target="_blank" rel="noreferrer" className="underline">
                  {j.company} — {j.title}
                </a>
                {j.url && <span className="ml-1 text-amber-700 dark:text-amber-400">({j.url.replace(/^https?:\/\//, "").slice(0, 60)})</span>}
              </li>
            ))}
          </ul>
          <p>
            {dupes.same_posting
              ? "It's the same posting. Add it again only if you really mean to track it twice."
              : "Possibly a separate posting (another location or req). Add it if so."}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${dupes ? "bg-amber-600 hover:bg-amber-700" : "bg-blue-600 hover:bg-blue-700"}`}
      >
        {saving ? "Saving…" : dupes ? "Add anyway" : "Save application"}
      </button>
    </form>
    </>
  );
}
