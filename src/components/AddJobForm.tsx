"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { STATUSES, type AppDocument, type DocumentKind, type Status } from "@/lib/types";
import { fromDatetimeLocal, toDatetimeLocal } from "@/lib/format";
import ResumePreview from "./ResumePreview";

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
/** Sentinel for "generate a resume with the Custom GPT" in the resume dropdown. */
const GENERATE_OPTION = "__generate__";

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
  const [notice, setNotice] = useState<string | null>(null);
  const resumeFileRef = useRef<HTMLInputElement>(null);
  const coverLetterFileRef = useRef<HTMLInputElement>(null);
  const [uploadingKind, setUploadingKind] = useState<DocumentKind | null>(null);
  // Resume-generation modal, opened from the resume dropdown.
  const [generateOpen, setGenerateOpen] = useState(false);
  const [genDescription, setGenDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // The resume produced in this modal, previewed in place before saving.
  const [generated, setGenerated] = useState<AppDocument | null>(null);

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
    if (value === GENERATE_OPTION) {
      // Reuse the fetched posting when there is one, so there's nothing to paste.
      setGenDescription(posting?.description_md ?? "");
      setGenError(null);
      // Keep any resume already generated in this form — reopening returns to
      // its preview rather than silently discarding it.
      setGenerateOpen(true);
      return;
    }
    if (kind === "resume") setResumeId(value);
    else setCoverLetterId(value);
  }

  /** Generate a resume from a description and select it in the dropdown. */
  async function generateResume() {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/generate-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The form's own Company field names the file — no need to ask twice.
        body: JSON.stringify({ description: genDescription, company: company.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Generation failed");
      const doc = body.document as AppDocument;
      setUploaded((prev) => [...prev, doc]);
      setResumeId(String(doc.id));
      // Keep the modal open on the result so it can be previewed and revised
      // before the application is saved.
      setGenerated(doc);
      setGenDescription("");
      if (body.warning) setNotice(body.warning);
      else setNotice(`Generated ${doc.name}`);
      router.refresh();
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
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
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      setUrl("");
      setCompany("");
      setTitle("");
      setPosting(null);
      setNotice(null);
      setResumeId("");
      setCoverLetterId("");
      setUploaded([]);
      setGenerated(null);
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
    {generateOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={() => !generating && setGenerateOpen(false)}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="max-h-[90vh] w-full max-w-2xl space-y-3 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {generated ? "Resume ready" : "Generate resume"}
            </h2>
            <button
              type="button"
              onClick={() => setGenerateOpen(false)}
              disabled={generating}
              className="text-sm text-zinc-500 hover:underline disabled:opacity-50"
            >
              {generated ? "Done" : "Cancel"}
            </button>
          </div>

          {generated ? (
            <>
              <p className="text-xs text-zinc-500">
                Saved as <span className="font-medium">{generated.name}</span> and selected below.
                Preview it and ask for changes, then close and save the application. You can reopen
                this from the resume dropdown at any point before saving.
              </p>
              <ResumePreview document={generated} defaultOpen />
              <button
                type="button"
                onClick={() => {
                  setGenerated(null);
                  setGenDescription(posting?.description_md ?? "");
                }}
                className="text-xs text-zinc-500 hover:underline"
              >
                Generate a different resume instead
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-500">
                Runs through your Resume Builder GPT in ChatGPT. Takes about a minute — the resume is
                saved and selected below.
                {company.trim() ? ` Will be named for ${company.trim()}.` : ""}
              </p>
              <textarea
                autoFocus
                value={genDescription}
                onChange={(e) => setGenDescription(e.target.value)}
                rows={12}
                placeholder="Paste the job description here…"
                className={inputCls}
              />
              {genError && <p className="text-xs text-red-600 dark:text-red-400">{genError}</p>}
              <button
                type="button"
                onClick={generateResume}
                disabled={generating || !genDescription.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {generating ? "Generating… (~1 min)" : "Generate resume"}
              </button>
            </>
          )}
        </div>
      </div>
    )}
    <form onSubmit={submit} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">New application</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={generating}
          className="text-sm text-zinc-500 hover:underline disabled:opacity-50"
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
              Initial status: {s}
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
            {resumes.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value={UPLOAD_OPTION}>+ Upload new resume…</option>
            <option value={GENERATE_OPTION}>
              {generated ? "✨ Preview / revise generated resume…" : "✨ Generate resume…"}
            </option>
          </select>
          {generated && (
            <button
              type="button"
              onClick={() => setGenerateOpen(true)}
              className="mt-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Preview / revise ↗
            </button>
          )}
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
                {d.name}
              </option>
            ))}
            <option value={UPLOAD_OPTION}>+ Upload new cover letter…</option>
          </select>
        </label>
      </div>

      {notice && <p className="text-xs text-green-600 dark:text-green-400">{notice}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save application"}
      </button>
    </form>
    </>
  );
}
