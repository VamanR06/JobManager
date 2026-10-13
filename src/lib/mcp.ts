import { getPosting, listJobs } from "./queries";
import { STATUSES, statusLabel, type Status } from "./types";

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
      'Lists tracked job applications whose current status matches `status` (default "to_apply": jobs saved but not yet applied to), newest first. Each has company, title, posting URL, location, when it was added and when it reached that status.',
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES], default: "to_apply", description: "Current status to filter by." },
      },
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

export function listApplications(status: Status): ApplicationSummary[] {
  return listJobs()
    .filter((j) => j.latest_event?.status === status)
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

function callTool(name: unknown, args: Record<string, unknown>) {
  if (name !== "list_applications") throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  const status = (args.status ?? "to_apply") as Status;
  if (!STATUSES.includes(status)) {
    return { content: [{ type: "text", text: `Unknown status "${String(args.status)}". Use one of: ${STATUSES.join(", ")}.` }], isError: true };
  }
  const applications = listApplications(status);
  return {
    content: [{ type: "text", text: JSON.stringify({ count: applications.length, applications }, null, 2) }],
    structuredContent: { count: applications.length, applications },
  };
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
