import { createEvent, getDocument, getEvent, getJob, updateEvent, updateJob } from "./queries";
import { STATUSES, type DocumentKind, type Status } from "./types";

/**
 * Write tools for the MCP server (mcp.ts). Off unless JOBMANAGER_MCP_WRITE=1,
 * because the MCP URL token is the only credential and these change data.
 * They edit applications and their status events; nothing deletes.
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
];

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

/** Runs a write tool; returns the id of the application it changed, or null for an unknown tool name. */
export function runWriteTool(name: string, args: Record<string, unknown>): number | null {
  switch (name) {
    case "update_application":
      return updateApplication(args);
    case "add_status_update":
      return addStatusUpdate(args);
    case "update_status_update":
      return updateStatusUpdate(args);
    default:
      return null;
  }
}
