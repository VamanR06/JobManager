import { mcpWriteEnabled, runWriteTool, ToolInputError, WRITE_TOOLS, type FileDownloader } from "./mcp-write";
import { getDocument, getJob, getPosting, listDocuments, listEvents, listJobs, pendingAfter } from "./queries";
import { STATUSES, statusLabel, type DocumentKind, type Status, type StatusEvent } from "./types";

/**
 * A minimal MCP server (Streamable HTTP, stateless, plain JSON responses — no
 * SSE) so ChatGPT (including scheduled tasks) and other MCP clients can read
 * the applications list. Served at /api/mcp/<token>; see auth.ts for the token.
 *
 * Read-only unless JOBMANAGER_MCP_WRITE=1, which adds the edit tools in
 * mcp-write.ts. There are no delete tools.
 */

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}
type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

/** Rows list_applications returns unless asked for more, and the most it will return. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const TOOLS = [
  {
    name: "list_applications",
    title: "List job applications",
    description:
      'Lists or searches tracked job applications, newest first. Filter by current `status` ("to_apply" = saved but not yet applied to) and/or search with `query` (matches company, title and posting URL; every word must match). With neither, lists everything. Each has id, company, title, current status, posting URL, location, when it was added and when it reached that status. To find a specific application, search with `query`, then call get_application with its id for full details.',
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES], description: "Current status to filter by. Omit for any status." },
        query: { type: "string", description: 'Search words, e.g. "stripe" or "google intern". Case-insensitive.' },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: "Max rows to return (newest first)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_application",
    title: "Get a job application",
    description:
      "Full details of one tracked application by id (from list_applications): company, title, posting URL, notes, current status, the posting (location and description), status history newest first (each with its id, OA scores and dates, interview rounds and dates, notes), and the resume and cover letter used.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Application id from list_applications." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_documents",
    title: "List resumes and cover letters",
    description:
      "Lists uploaded or generated resumes and cover letters, newest first, with id, name, version and how many applications use each. Search by name with `query`. Archived documents are left out unless include_archived is true.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["resume", "cover_letter"], description: "Omit for both." },
        query: { type: "string", description: "Words that must all appear in the document name. Case-insensitive." },
        include_archived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function tools() {
  return mcpWriteEnabled() ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
}

export interface ApplicationSummary {
  id: number;
  company: string;
  title: string;
  status: string;
  url: string | null;
  location: string | null;
  added_at: string;
  status_since: string | null;
}

/**
 * Applications, newest first, optionally narrowed to a current `status` and/or a
 * `query` whose every word must appear (case-insensitively) in the company,
 * title or posting URL.
 */
export function listApplications(filter: { status?: Status; query?: string } = {}): ApplicationSummary[] {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return listJobs()
    .filter((j) => !filter.status || j.latest_event?.status === filter.status)
    .filter((j) => {
      if (!words.length) return true;
      const hay = `${j.company} ${j.title} ${j.url ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((j) => ({
      id: j.id,
      company: j.company,
      title: j.title,
      status: statusLabel(j.latest_event, j.pending_after),
      url: j.url,
      location: getPosting(j.id)?.location ?? null,
      added_at: j.created_at,
      status_since: j.latest_event?.occurred_at ?? null,
    }));
}

/** One application with its posting, status history and linked documents; null if no such id. */
export function getApplication(id: number) {
  const job = getJob(id);
  if (!job) return null;
  const events = listEvents(id);
  const posting = getPosting(id);
  const docRef = (docId: number | null) => {
    const doc = docId ? getDocument(docId) : null;
    return doc ? { id: doc.id, name: doc.name, version: doc.version } : null;
  };
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    notes: job.notes,
    added_at: job.created_at,
    status: statusLabel(events[0] ?? null, pendingAfter(events[0] ?? null)),
    resume: docRef(job.resume_id),
    cover_letter: docRef(job.cover_letter_id),
    posting: posting && {
      title: posting.title,
      company: posting.company,
      location: posting.location,
      description_md: posting.description_md,
      fetch_status: posting.fetch_status,
      fetched_at: posting.fetched_at,
    },
    history: events.map((e: StatusEvent) => {
      const { job_id: _job, created_at: _created, ...rest } = e;
      return { label: statusLabel(e, pendingAfter(e)), ...rest };
    }),
  };
}

export function searchDocuments(filter: { kind?: DocumentKind; query?: string; includeArchived?: boolean } = {}) {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const kinds: DocumentKind[] = filter.kind ? [filter.kind] : ["resume", "cover_letter"];
  return kinds
    .flatMap((k) => listDocuments(k))
    .filter((d) => filter.includeArchived || !d.archived)
    .filter((d) => words.every((w) => d.name.toLowerCase().includes(w)))
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at) || b.id - a.id)
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      version: d.version,
      archived: !!d.archived,
      generated: !!d.generated,
      uploaded_at: d.uploaded_at,
      used_by: d.used_by.length,
    }));
}

function limitArg(v: unknown): number {
  const limit = v === undefined ? DEFAULT_LIMIT : Number(v);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ToolInputError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

/** `{ total, count, truncated?, [key]: rows }` with rows capped at `limit`. */
function capped(key: string, rows: unknown[], limit: number) {
  const shown = rows.slice(0, limit);
  return result({
    total: rows.length,
    count: shown.length,
    ...(rows.length > limit && {
      truncated: `Showing the newest ${limit} of ${rows.length}. Narrow the search, or raise limit (max ${MAX_LIMIT}).`,
    }),
    [key]: shown,
  });
}

function result(data: Record<string, unknown>) {
  // Compact JSON: list results can run to hundreds of rows.
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

/** Injectable for tests. */
export interface McpDeps {
  download?: FileDownloader;
}

async function callTool(name: unknown, args: Record<string, unknown>, deps: McpDeps) {
  try {
    return await runTool(name, args, deps);
  } catch (err) {
    if (err instanceof ToolInputError) return toolError(err.message);
    throw err;
  }
}

async function runTool(name: unknown, args: Record<string, unknown>, deps: McpDeps) {
  switch (name) {
    case "list_applications": {
      const status = args.status as Status | undefined;
      if (status !== undefined && !STATUSES.includes(status)) {
        return toolError(`Unknown status "${String(status)}". Use one of: ${STATUSES.join(", ")}, or omit it for all.`);
      }
      if (args.query !== undefined && typeof args.query !== "string") return toolError("query must be a string.");
      const limit = limitArg(args.limit);
      return capped("applications", listApplications({ status, query: args.query as string | undefined }), limit);
    }
    case "get_application": {
      const id = Number(args.id);
      if (!Number.isInteger(id)) return toolError("id must be an integer application id from list_applications.");
      const application = getApplication(id);
      return application ? result(application) : toolError(`No application with id ${id}.`);
    }
    case "list_documents": {
      const kind = args.kind as DocumentKind | undefined;
      if (kind !== undefined && kind !== "resume" && kind !== "cover_letter") return toolError('kind must be "resume" or "cover_letter".');
      if (args.query !== undefined && typeof args.query !== "string") return toolError("query must be a string.");
      const limit = limitArg(args.limit);
      const docs = searchDocuments({ kind, query: args.query as string | undefined, includeArchived: args.include_archived === true });
      return capped("documents", docs, limit);
    }
  }
  if (typeof name === "string" && WRITE_TOOLS.some((t) => t.name === name)) {
    if (!mcpWriteEnabled()) return toolError("Editing is turned off on this server (JOBMANAGER_MCP_WRITE is not set).");
    const done = (await runWriteTool(name, args, deps.download))!;
    const application = done.applicationId !== null ? getApplication(done.applicationId) : null;
    if (!done.document) return result(application!);
    return result({ document: done.document, ...(application && { application }) });
  }
  throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
}

class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

async function dispatch(req: RpcRequest, deps: McpDeps): Promise<unknown> {
  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      return {
        protocolVersion: typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jobmanager", title: "JobManager", version: "1.0.0" },
        instructions: mcpWriteEnabled()
          ? "The user's job-application tracker. Find applications with list_applications (search with query), read one with get_application, edit with update_application, add_status_update and update_status_update, and save an attached resume or cover letter with upload_document. Confirm with the user before changing anything they didn't clearly ask for."
          : "Read-only access to the user's job-application tracker. Find applications with list_applications (search with query) and read one with get_application.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools() };
    case "tools/call":
      return callTool(req.params?.name, (req.params?.arguments as Record<string, unknown>) ?? {}, deps);
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

async function handleOne(msg: unknown, deps: McpDeps): Promise<RpcResponse | null> {
  const req = msg as RpcRequest;
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return { jsonrpc: "2.0", id: (req as RpcRequest)?.id ?? null, error: { code: -32600, message: "Invalid request" } };
  }
  // Notifications (no id) and responses get no reply.
  if (req.id === undefined) return null;
  try {
    return { jsonrpc: "2.0", id: req.id, result: await dispatch(req, deps) };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: "2.0", id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** One JSON-RPC message or a batch → the reply body, or null when nothing needs a reply (HTTP 202). */
export async function handleMcpMessage(body: unknown, deps: McpDeps = {}): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(body)) {
    const out: RpcResponse[] = [];
    for (const msg of body) {
      const r = await handleOne(msg, deps);
      if (r) out.push(r);
    }
    return out.length ? out : null;
  }
  return handleOne(body, deps);
}
