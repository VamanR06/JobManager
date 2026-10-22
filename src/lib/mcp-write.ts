import path from "path";
import { getDb } from "./db";
import { DOCUMENT_EXTENSIONS, saveUploadedDocument } from "./documents";
import { findDuplicates, type JobRef } from "./duplicates";
import { placeholderCompany, UNKNOWN_TITLE } from "./inbox";
import { safeFetchBytes } from "./netguard";
import { htmlToMarkdown, parsePostingUrl, type ParsedPosting } from "./parser";
import { createEvent, createJob, getDocument, getEvent, getJob, updateEvent, updateJob, upsertPosting } from "./queries";
import { analyzeUrl } from "./urls";
import { STATUSES, type DocumentKind, type Status } from "./types";

/**
 * Write tools for the MCP server (mcp.ts). Off unless JOBMANAGER_MCP_WRITE=1,
 * because the MCP URL token is the only credential and these change data.
 * They edit applications and their status events and upload resumes / cover
 * letters; nothing deletes.
 */

export function mcpWriteEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.JOBMANAGER_MCP_WRITE?.trim() ?? "");
}

/** A bad argument; reported back to the model as a tool error. */
export class ToolInputError extends Error {}

const DATE_DESC =
  'ISO 8601 with a timezone, e.g. "2026-10-14T15:00:00-04:00" or "2026-10-14T19:00:00Z". null clears it.';

/** Status event fields the tools can set, and how each is validated. */
const EVENT_FIELDS = {
  occurred_at: { kind: "date", desc: "When this status happened (defaults to now when adding). ISO 8601 with a timezone; can't be cleared." },
  interview_round: { kind: "round", desc: "Interview round number (1, 2, …), for interview events. null clears it." },
  interview_offered_at: { kind: "date", desc: `When the interview was offered. ${DATE_DESC}` },
  interview_held_at: { kind: "date", desc: `When the interview took place. ${DATE_DESC}` },
  interview_link: { kind: "nullableText", desc: "Link to the interview call. null clears it." },
  oa_score: { kind: "nullableText", desc: 'OA score as free text, e.g. "3/4" or "270/300". null clears it.' },
  oa_sent_at: { kind: "date", desc: `When the online assessment was sent. ${DATE_DESC}` },
  oa_submitted_at: { kind: "date", desc: `When the online assessment was submitted. ${DATE_DESC}` },
  oa_deadline_at: { kind: "date", desc: `Online assessment deadline. ${DATE_DESC}` },
  oa_link: { kind: "nullableText", desc: "Link to the online assessment. null clears it." },
  pre_notes: { kind: "text", desc: "Notes before the event (e.g. interview prep). Replaces the existing text." },
  post_notes: { kind: "text", desc: "Notes after the event (e.g. how it went). Replaces the existing text." },
} as const;
type EventField = keyof typeof EVENT_FIELDS;

function schemaFor(kind: (typeof EVENT_FIELDS)[EventField]["kind"], description: string) {
  switch (kind) {
    case "date":
    case "nullableText":
      return { type: ["string", "null"], description };
    case "round":
      return { type: ["integer", "null"], minimum: 1, description };
    case "text":
      return { type: "string", description };
  }
}

const EVENT_PROPS = Object.fromEntries(
  Object.entries(EVENT_FIELDS).map(([k, f]) => [k, schemaFor(f.kind, f.desc)])
);

const STATUS_PROP = {
  type: "string",
  enum: [...STATUSES],
  description:
    "to_apply (saved, not applied yet), applied, oa (online assessment), interview, pending (waiting to hear back after the previous step), rejected, accepted.",
};

const WRITE = { readOnlyHint: false, openWorldHint: false } as const;

export const WRITE_TOOLS = [
  {
    name: "update_application",
    title: "Update a job application",
    description:
      "Changes fields on one application (id from list_applications). Only the fields you pass change. Use append_notes to add to the general notes without losing what's there; notes replaces them entirely. Set resume_id / cover_letter_id from list_documents, or null to unlink. Returns the updated application.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Application id." },
        company: { type: "string", description: "Company name (can't be blank)." },
        title: { type: "string", description: "Job title (can't be blank)." },
        url: { type: ["string", "null"], description: "Posting URL. null clears it." },
        notes: { type: "string", description: "Replaces the general notes entirely." },
        append_notes: { type: "string", description: "Text added to the end of the general notes on a new paragraph." },
        resume_id: { type: ["integer", "null"], description: "Resume document id from list_documents; null unlinks." },
        cover_letter_id: { type: ["integer", "null"], description: "Cover letter document id from list_documents; null unlinks." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "add_status_update",
    title: "Add a status update",
    description:
      "Records a new status on an application's timeline (e.g. it moved to an OA, an interview, or was rejected). The newest status by occurred_at becomes the application's current status. Fill in the fields that apply: OA fields for oa, interview fields for interview. Returns the updated application.",
    inputSchema: {
      type: "object",
      properties: { application_id: { type: "integer", description: "Application id." }, status: STATUS_PROP, ...EVENT_PROPS },
      required: ["application_id", "status"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "update_status_update",
    title: "Edit a status update",
    description:
      "Edits one existing status event (its id is in get_application's history[].id). Only the fields you pass change; null clears a field. Use this to fill in an OA score, interview date, notes, or to fix a status or timestamp. Returns the updated application.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Status event id (history[].id)." }, status: STATUS_PROP, ...EVENT_PROPS },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "upload_document",
    title: "Upload a resume or cover letter",
    description:
      "Saves a file the user attached in the chat (PDF, Word, text or Markdown) as a resume or cover letter in their document library. A file with the same name as an existing one is stored as its next version; an identical re-upload is reused. Pass application_id to also link it to that application. Returns the saved document (and the updated application when linked).",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "object",
          description: "The attached file.",
          properties: {
            download_url: { type: "string" },
            file_id: { type: "string" },
            mime_type: { type: "string" },
            file_name: { type: "string" },
          },
          required: ["download_url", "file_id"],
        },
        kind: { type: "string", enum: ["resume", "cover_letter"], default: "resume" },
        name: {
          type: "string",
          description: 'Name to save it under, e.g. "Resume - Stripe.pdf". Defaults to the attached file\'s name. Reusing an existing name makes a new version of it.',
        },
        application_id: { type: "integer", description: "Also link it to this application as its resume / cover letter." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
    // ChatGPT Apps SDK: this argument is a file from the conversation, sent as { download_url, file_id, … }.
    _meta: { "openai/fileParams": ["file"] },
  },
  {
    name: "add_application",
    title: "Save a job posting",
    description:
      "Adds a job posting link to the tracker with status 'to apply', like the user's share sheet: fetches the posting (title, company, location, description) and checks for duplicates first. If the posting is already tracked, nothing is added and the existing application is returned (added: false). If the same company and title is tracked under another link, nothing is added and the matches come back in similar; call again with allow_duplicate: true only if the user confirms it's a separate posting. Pass company/title when the page can't be read or the user named them. For Workday links (the server's network is blocked there) read the posting yourself and pass description, company, title and location. Returns added and the application (with its id for upload_document, update_application or browser_open).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Link to the job posting (an ATS page like Greenhouse/Lever/Ashby/Workday, or the employer's careers page)." },
        company: { type: "string", description: "Company name, if the user gave it or the page doesn't say. Otherwise taken from the posting." },
        title: { type: "string", description: "Job title, if the user gave it or the page doesn't say." },
        notes: { type: "string", description: "Notes to start the application with." },
        description: {
          type: "string",
          description: "The posting's full job description, if you've read the page yourself. Pass it for sites the server can't reach (Workday blocks it): then the server doesn't fetch the page. Copy it faithfully; don't summarise.",
        },
        location: { type: "string", description: "The job's location, with description." },
        allow_duplicate: { type: "boolean", default: false, description: "Add even though the same company + title is already tracked under another link (only after the user confirms)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/** Downloads an attached file's bytes; swappable in tests. */
export type FileDownloader = (url: string) => Promise<{ ok: boolean; status: number; bytes: Buffer }>;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const defaultDownloader: FileDownloader = (url) =>
  safeFetchBytes(url, { accept: "*/*", timeoutMs: 30_000, maxBytes: MAX_UPLOAD_BYTES });

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

function rejectUnknown(args: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolInputError(`Unknown field(s): ${extra.join(", ")}. Allowed: ${allowed.join(", ")}.`);
}

function intArg(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolInputError(`${name} must be an integer.`);
  return v;
}

/** ISO 8601 with an explicit timezone → the stored UTC form; ambiguous local times are refused. */
function dateArg(v: string, name: string): string {
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(v) || Number.isNaN(d.getTime())) {
    throw new ToolInputError(`${name} must be an ISO 8601 date-time with a timezone, e.g. "2026-10-14T15:00:00-04:00".`);
  }
  return d.toISOString();
}

function statusArg(v: unknown): Status {
  if (typeof v !== "string" || !STATUSES.includes(v as Status)) {
    throw new ToolInputError(`status must be one of: ${STATUSES.join(", ")}.`);
  }
  return v as Status;
}

/** The event fields present in `args`, validated and in stored form. */
function eventFields(args: Record<string, unknown>): Partial<Record<EventField, string | number | null>> {
  const out: Partial<Record<EventField, string | number | null>> = {};
  for (const [name, { kind }] of Object.entries(EVENT_FIELDS) as [EventField, (typeof EVENT_FIELDS)[EventField]][]) {
    const v = args[name];
    if (v === undefined) continue;
    if (v === null) {
      if (name === "occurred_at") throw new ToolInputError("occurred_at can't be cleared.");
      out[name] = kind === "text" ? "" : null;
      continue;
    }
    switch (kind) {
      case "date":
        if (typeof v !== "string") throw new ToolInputError(`${name} must be a string or null.`);
        out[name] = dateArg(v, name);
        break;
      case "round":
        if (intArg(v, name) < 1) throw new ToolInputError(`${name} must be 1 or more.`);
        out[name] = v as number;
        break;
      case "nullableText":
        if (typeof v !== "string") throw new ToolInputError(`${name} must be a string or null.`);
        out[name] = v.trim() || null;
        break;
      case "text":
        if (typeof v !== "string") throw new ToolInputError(`${name} must be a string.`);
        out[name] = v;
        break;
    }
  }
  return out;
}

function documentArg(v: unknown, kind: DocumentKind, name: string): number | null {
  if (v === null) return null;
  const doc = getDocument(intArg(v, name));
  if (!doc || doc.kind !== kind) throw new ToolInputError(`${name} ${String(v)} isn't a ${kind.replace("_", " ")}; see list_documents.`);
  return doc.id;
}

function updateApplication(args: Record<string, unknown>): number {
  rejectUnknown(args, Object.keys(WRITE_TOOLS[0].inputSchema.properties));
  const job = getJob(intArg(args.id, "id"));
  if (!job) throw new ToolInputError(`No application with id ${String(args.id)}.`);
  if (args.notes !== undefined && args.append_notes !== undefined) {
    throw new ToolInputError("Pass notes (replace) or append_notes (add), not both.");
  }
  const input: Parameters<typeof updateJob>[1] = {};
  for (const field of ["company", "title"] as const) {
    if (args[field] === undefined) continue;
    if (typeof args[field] !== "string" || !(args[field] as string).trim()) throw new ToolInputError(`${field} can't be blank.`);
    input[field] = (args[field] as string).trim();
  }
  if (args.url !== undefined) {
    if (args.url !== null && typeof args.url !== "string") throw new ToolInputError("url must be a string or null.");
    input.url = (args.url as string | null)?.trim() || null;
  }
  if (args.notes !== undefined) {
    if (typeof args.notes !== "string") throw new ToolInputError("notes must be a string.");
    input.notes = args.notes;
  }
  if (args.append_notes !== undefined) {
    if (typeof args.append_notes !== "string" || !args.append_notes.trim()) throw new ToolInputError("append_notes must be non-empty text.");
    input.notes = job.notes.trim() ? `${job.notes.trimEnd()}\n\n${args.append_notes.trim()}` : args.append_notes.trim();
  }
  if (args.resume_id !== undefined) input.resume_id = documentArg(args.resume_id, "resume", "resume_id");
  if (args.cover_letter_id !== undefined) input.cover_letter_id = documentArg(args.cover_letter_id, "cover_letter", "cover_letter_id");
  if (!Object.keys(input).length) throw new ToolInputError("Nothing to change: pass at least one field besides id.");
  updateJob(job.id, input);
  return job.id;
}

function addStatusUpdate(args: Record<string, unknown>): number {
  rejectUnknown(args, ["application_id", "status", ...Object.keys(EVENT_FIELDS)]);
  const job = getJob(intArg(args.application_id, "application_id"));
  if (!job) throw new ToolInputError(`No application with id ${String(args.application_id)}.`);
  const status = statusArg(args.status);
  const fields = eventFields(args) as Parameters<typeof createEvent>[0];
  createEvent({ ...fields, job_id: job.id, status });
  return job.id;
}

function updateStatusUpdate(args: Record<string, unknown>): number {
  rejectUnknown(args, ["id", "status", ...Object.keys(EVENT_FIELDS)]);
  const event = getEvent(intArg(args.id, "id"));
  if (!event) throw new ToolInputError(`No status event with id ${String(args.id)}; ids are in get_application's history.`);
  const input = eventFields(args) as Parameters<typeof updateEvent>[1];
  if (args.status !== undefined) input.status = statusArg(args.status);
  if (!Object.keys(input).length) throw new ToolInputError("Nothing to change: pass at least one field besides id.");
  updateEvent(event.id, input);
  return event.job_id;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A supported extension from the name, else from the attachment's name, else from its MIME type. */
function documentName(given: string | null, file: Record<string, unknown>, kind: DocumentKind): { name: string; ext: string } {
  const base = given ?? text(file.file_name) ?? (kind === "resume" ? "Resume" : "Cover letter");
  const extOf = (n: string | null) => (n ? path.extname(n).toLowerCase() : "");
  const own = extOf(base);
  if (DOCUMENT_EXTENSIONS.includes(own)) return { name: base, ext: own };
  const fromFile = extOf(text(file.file_name));
  const fromMime = MIME_EXTENSIONS[(text(file.mime_type) ?? "").split(";")[0].toLowerCase()] ?? "";
  const ext = DOCUMENT_EXTENSIONS.includes(fromFile) ? fromFile : fromMime;
  if (!ext) throw new ToolInputError(`Only ${DOCUMENT_EXTENSIONS.join(", ")} files can be saved as documents.`);
  return { name: `${base}${ext}`, ext };
}

async function uploadDocument(args: Record<string, unknown>, download: FileDownloader): Promise<WriteResult> {
  rejectUnknown(args, ["file", "kind", "name", "application_id"]);
  const file = args.file as Record<string, unknown> | undefined;
  const url = file && typeof file === "object" ? text(file.download_url) : null;
  if (!file || !url) throw new ToolInputError("file must be a file attached in the chat (with a download_url).");
  if (!/^https:\/\//i.test(url)) throw new ToolInputError("The file's download_url must be https.");
  const kind = (args.kind ?? "resume") as DocumentKind;
  if (kind !== "resume" && kind !== "cover_letter") throw new ToolInputError('kind must be "resume" or "cover_letter".');
  if (args.name !== undefined && !text(args.name)) throw new ToolInputError("name can't be blank.");
  const job = args.application_id === undefined ? null : getJob(intArg(args.application_id, "application_id"));
  if (args.application_id !== undefined && !job) throw new ToolInputError(`No application with id ${String(args.application_id)}.`);
  const { name, ext } = documentName(text(args.name), file, kind);

  let res: Awaited<ReturnType<FileDownloader>>;
  try {
    res = await download(url);
  } catch (err) {
    const why = err instanceof Error && err.message === "Response too large" ? `it's over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` : err instanceof Error ? err.message : String(err);
    throw new ToolInputError(`Couldn't download the file: ${why}.`);
  }
  if (!res.ok) throw new ToolInputError(`Couldn't download the file: HTTP ${res.status}. The link may have expired; attach it again.`);
  if (!res.bytes.length) throw new ToolInputError("The downloaded file is empty.");
  const head = res.bytes.subarray(0, 4).toString("latin1");
  if (ext === ".pdf" && head !== "%PDF") throw new ToolInputError("That file isn't a valid PDF.");
  if (ext === ".docx" && !head.startsWith("PK")) throw new ToolInputError("That file isn't a valid .docx.");

  const { doc, duplicate } = saveUploadedDocument(kind, name, res.bytes);
  if (job) updateJob(job.id, kind === "resume" ? { resume_id: doc.id } : { cover_letter_id: doc.id });
  return {
    applicationId: job?.id ?? null,
    document: { id: doc.id, kind: doc.kind, name: doc.name, version: doc.version, duplicate },
  };
}

export interface WriteResult {
  /** The application that changed (or was linked), to return its updated state. */
  applicationId: number | null;
  /** Extra fields for the tool result (add_application: added, similar, note). */
  extra?: Record<string, unknown>;
  /** Set by upload_document. */
  document?: { id: number; kind: DocumentKind; name: string; version: number; duplicate: boolean };
}

/** Fetches and reads a posting page; swappable in tests. */
export type PostingParser = (url: string) => Promise<ParsedPosting>;

const ref = (j: JobRef) => ({ id: j.id, company: j.company, title: j.title, url: j.url });
const ALREADY = "This posting is already tracked; here it is. Nothing was added.";

/** add_application: the share sheet's path (fetch the posting, check duplicates, save as 'to apply'). */
async function addApplication(args: Record<string, unknown>, parse: PostingParser): Promise<WriteResult> {
  rejectUnknown(args, ["url", "company", "title", "notes", "description", "location", "allow_duplicate"]);
  if (typeof args.url !== "string" || !args.url.trim()) throw new ToolInputError("url must be the posting's link.");
  const info = analyzeUrl(args.url);
  if (!info.ok) throw new ToolInputError(`Can't save that link: ${info.message}.`);
  for (const k of ["company", "title", "notes", "description", "location"] as const) {
    if (args[k] !== undefined && typeof args[k] !== "string") throw new ToolInputError(`${k} must be text.`);
  }
  if (args.allow_duplicate !== undefined && typeof args.allow_duplicate !== "boolean") throw new ToolInputError("allow_duplicate must be true or false.");

  const tracked = findDuplicates({ url: info.normalized }).same_posting;
  if (tracked) return { applicationId: tracked.id, extra: { added: false, note: ALREADY } };

  let parsed: ParsedPosting | null = null;
  let fetchError: string | null = null;
  const given = text(args.description);
  if (given) {
    // Read by ChatGPT itself; the page isn't fetched (some sites refuse the server).
    if (given.length < 50) throw new ToolInputError("description is too short to be the posting's description; pass the full text.");
    const md = /<\/?(p|div|ul|li|br|h\d|strong|b)\b/i.test(given) ? htmlToMarkdown(given) : given;
    parsed = { title: text(args.title), company: text(args.company), location: text(args.location), description_md: md.slice(0, 200_000) };
  } else {
    try {
      parsed = await parse(info.normalized);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
  }
  const company = text(args.company) ?? (parsed?.company?.trim() || placeholderCompany(info));
  const title = text(args.title) ?? (parsed?.title?.trim() || UNKNOWN_TITLE);

  if (args.allow_duplicate !== true) {
    const similar = findDuplicates({ company, title }).similar;
    if (similar.length) {
      return {
        applicationId: null,
        extra: {
          added: false,
          similar: similar.map(ref),
          note: `"${company} — ${title}" is already tracked under a different link. Ask the user whether this is a separate posting (another location or req); if so, call add_application again with allow_duplicate: true.`,
        },
      };
    }
  }

  // The fetch awaited, so the same-posting check is repeated inside the insert.
  return getDb().transaction((): WriteResult => {
    const again = findDuplicates({ url: info.normalized }).same_posting;
    if (again) return { applicationId: again.id, extra: { added: false, note: ALREADY } };
    const job = createJob({ company, title, url: info.normalized, notes: text(args.notes) ?? "" });
    upsertPosting(
      parsed
        ? { job_id: job.id, ...parsed, source: "parsed", fetch_status: "ok" }
        : { job_id: job.id, description_md: "", source: "parsed", fetch_status: "failed" }
    );
    createEvent({ job_id: job.id, status: "to_apply" });
    const guessed = title === UNKNOWN_TITLE || company === placeholderCompany(info);
    return {
      applicationId: job.id,
      extra: {
        added: true,
        ...(fetchError && {
          note: `Saved, but the posting couldn't be read (${fetchError}), so its description is empty${guessed ? " and the company/title are placeholders: fix them with update_application" : ""}. To fill it in, the user can click their Save to JobManager bookmark on that posting (it offers to fill in this application) or paste the description on the job page.`,
        }),
      },
    };
  }).immediate();
}

/** Runs a write tool, or returns null for an unknown tool name. */
export async function runWriteTool(
  name: string, args: Record<string, unknown>, download = defaultDownloader, parse: PostingParser = parsePostingUrl
): Promise<WriteResult | null> {
  switch (name) {
    case "update_application":
      return { applicationId: updateApplication(args) };
    case "add_status_update":
      return { applicationId: addStatusUpdate(args) };
    case "update_status_update":
      return { applicationId: updateStatusUpdate(args) };
    case "upload_document":
      return uploadDocument(args, download);
    case "add_application":
      return addApplication(args, parse);
    default:
      return null;
  }
}
