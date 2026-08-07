import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DOCUMENTS_DIR } from "@/lib/db";
import { generateResume } from "@/lib/gateway";
import {
  createDocument, createGeneration, finishGeneration, getDocument, getJob, getPosting,
  setDocumentThread, updateJob,
} from "@/lib/queries";

/** Browser automation is slow; keep Next from cutting the request short. */
export const maxDuration = 300;

/** Mirrors the upload route's sanitiser so filenames stay predictable on disk. */
function safe(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, "_");
}

/** Whose resume this is — used to build `<Name>_Resume_<Company>`. */
const OWNER = process.env.RESUME_NAME ?? "Resume";

/**
 * `<Name>_Resume_<Company>`, e.g. `Vaman_Rajagopal_Resume_Roblox`.
 * Spaces become underscores so the name survives download managers intact.
 */
function resumeBaseName(company: string | null): string {
  const owner = safe(OWNER).replace(/\s+/g, "_");
  const suffix = company ? `_${safe(company).replace(/\s+/g, "_")}` : "";
  return `${owner}_Resume${suffix}`;
}

/**
 * Generates a resume from a job description, either a saved posting (`job_id`)
 * or pasted text (`description`), and stores the result as a resume document.
 */
export async function POST(req: NextRequest) {
  const { job_id, description, company, revise_document_id, message } = await req.json();

  const jobId = typeof job_id === "number" ? job_id : null;
  let input = typeof description === "string" ? description.trim() : "";
  let job = null;

  // Revision: continue the resume's own conversation and overwrite its file.
  const reviseId = typeof revise_document_id === "number" ? revise_document_id : null;
  const existing = reviseId !== null ? getDocument(reviseId) : null;
  if (reviseId !== null) {
    if (!existing) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    if (!existing.thread_id) {
      return NextResponse.json(
        { error: "This resume has no linked conversation, so it can't be revised" },
        { status: 400 }
      );
    }
    input = typeof message === "string" ? message.trim() : "";
    if (!input) return NextResponse.json({ error: "A revision message is required" }, { status: 400 });
  }

  if (reviseId === null && jobId !== null) {
    job = getJob(jobId);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (!input) input = getPosting(jobId)?.description_md?.trim() ?? "";
    if (!input) {
      return NextResponse.json(
        { error: "This job has no saved description — fetch or paste one first" },
        { status: 400 }
      );
    }
  } else if (reviseId === null && !input) {
    return NextResponse.json({ error: "A job description is required" }, { status: 400 });
  }

  if (existing?.source_job_id != null) job = getJob(existing.source_job_id);

  // Created before any file write: DOCUMENTS_DIR is only mkdir'd inside db.ts's open().
  const generation = createGeneration(job?.id ?? jobId, input);

  let result;
  try {
    result = await generateResume(input, existing?.thread_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    finishGeneration(generation.id, { state: "failed", error: message });
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const hasPdf = result.file !== null;
  // The file route derives MIME from the document name, so the extension must be right.
  const ext = hasPdf ? path.extname(result.file!.filename) || ".pdf" : ".md";
  const contents = hasPdf
    ? Buffer.from(result.file!.b64, "base64")
    : Buffer.from(result.text, "utf8");

  // A revision overwrites the file in place, keeping the same document row —
  // so anything already linked to this resume follows the new version.
  if (existing) {
    try {
      fs.writeFileSync(path.join(process.cwd(), "data", existing.file_path), contents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the revised file";
      finishGeneration(generation.id, { state: "failed", response_text: result.text, error: msg });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    // The thread can advance (or be recreated) across a revision.
    const updated = setDocumentThread(existing.id, result.threadId ?? existing.thread_id);
    finishGeneration(generation.id, {
      state: "done",
      document_id: existing.id,
      response_text: result.text,
    });
    return NextResponse.json({
      document: updated,
      reply: result.text,
      warning: hasPdf ? null : "No PDF came back — the file was not replaced with a document.",
    });
  }

  const displayName = `${resumeBaseName(
    job?.company ?? (typeof company === "string" ? company : null)
  )}${ext}`;
  const filename = `${Date.now()}-${safe(displayName)}`;

  try {
    fs.writeFileSync(path.join(DOCUMENTS_DIR, filename), contents);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save the generated file";
    finishGeneration(generation.id, { state: "failed", response_text: result.text, error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const doc = createDocument("resume", displayName, path.join("documents", filename), {
    generated: true,
    source_job_id: jobId,
    thread_id: result.threadId,
  });

  // Attach it to the job so the resume slot reflects what was actually sent.
  if (jobId !== null) updateJob(jobId, { resume_id: doc.id });

  finishGeneration(generation.id, {
    state: "done",
    document_id: doc.id,
    response_text: result.text,
  });

  return NextResponse.json(
    {
      document: doc,
      reply: result.text,
      // The GPT replied without producing a file — the text was saved instead.
      warning: hasPdf ? null : "No PDF came back, so the reply was saved as Markdown.",
    },
    { status: 201 }
  );
}
