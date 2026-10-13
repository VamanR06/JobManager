import { getDocument, getJob, getPosting, listEvents, listJobs, pendingAfter } from "./queries";
import { STATUSES, statusLabel, type Status, type StatusEvent } from "./types";

/**
 * A minimal, read-only MCP server (Streamable HTTP, stateless, plain JSON
 * responses — no SSE) so ChatGPT scheduled tasks and other MCP clients can read
 * the applications list. Served at /api/mcp/<token>; see auth.ts for the token.
 *
 * Deliberately no write tools: nothing here changes data.
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

const TOOLS = [
  {
    name: "list_applications",
    title: "List job applications",
    description:
      'Lists tracked job applications, newest first: all of them, or only those whose current status matches `status` ("to_apply" = saved but not yet applied to). Each has id, company, title, current status, posting URL, location, when it was added and when it reached that status. Use get_application with an id for full details.',
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES], description: "Current status to filter by. Omit for all applications." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_application",
    title: "Get a job application",
    description:
      "Full details of one tracked application by id (from list_applications): company, title, posting URL, notes, current status, the posting (location and description), status history newest first (OA scores and dates, interview rounds and dates, notes), and the names of the resume and cover letter used.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Application id from list_applications." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

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

/** Every application, or only those whose current status is `status`. */
export function listApplications(status?: Status): ApplicationSummary[] {
  return listJobs()
    .filter((j) => !status || j.latest_event?.status === status)
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
  const docName = (docId: number | null) => (docId ? getDocument(docId)?.name ?? null : null);
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    notes: job.notes,
    added_at: job.created_at,
    status: statusLabel(events[0] ?? null, pendingAfter(events[0] ?? null)),
    resume: docName(job.resume_id),
    cover_letter: docName(job.cover_letter_id),
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

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function callTool(name: unknown, args: Record<string, unknown>) {
  switch (name) {
    case "list_applications": {
      const status = args.status as Status | undefined;
      if (status !== undefined && !STATUSES.includes(status)) {
        return toolError(`Unknown status "${String(status)}". Use one of: ${STATUSES.join(", ")}, or omit it for all.`);
      }
      const applications = listApplications(status);
      return result({ count: applications.length, applications });
    }
    case "get_application": {
      const id = Number(args.id);
      if (!Number.isInteger(id)) return toolError("id must be an integer application id from list_applications.");
      const application = getApplication(id);
      return application ? result(application) : toolError(`No application with id ${id}.`);
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  }
}

class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function dispatch(req: RpcRequest): unknown {
  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      return {
        protocolVersion: typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jobmanager", title: "JobManager", version: "1.0.0" },
        instructions: "Read-only access to the user's job-application tracker. Use list_applications to see jobs by status.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(req.params?.name, (req.params?.arguments as Record<string, unknown>) ?? {});
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

function handleOne(msg: unknown): RpcResponse | null {
  const req = msg as RpcRequest;
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return { jsonrpc: "2.0", id: (req as RpcRequest)?.id ?? null, error: { code: -32600, message: "Invalid request" } };
  }
  // Notifications (no id) and responses get no reply.
  if (req.id === undefined) return null;
  try {
    return { jsonrpc: "2.0", id: req.id, result: dispatch(req) };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: "2.0", id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** One JSON-RPC message or a batch → the reply body, or null when nothing needs a reply (HTTP 202). */
export function handleMcpMessage(body: unknown): RpcResponse | RpcResponse[] | null {
  if (Array.isArray(body)) {
    const out = body.map(handleOne).filter((r): r is RpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleOne(body);
}
