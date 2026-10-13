import { NextRequest, NextResponse } from "next/server";
import { mcpAuthorized, mcpToken } from "@/lib/auth";
import { handleMcpMessage } from "@/lib/mcp";

/**
 * Read-only MCP endpoint (Streamable HTTP, JSON responses only) at
 * /api/mcp/<token>, or /api/mcp with `Authorization: Bearer <token>`.
 */
export async function POST(req: NextRequest) {
  // The proxy already checked this; checked again so the route is safe on its own.
  if (!mcpToken()) return NextResponse.json({ error: "MCP is off (JOBMANAGER_MCP_TOKEN not set)" }, { status: 404 });
  if (!mcpAuthorized(req.nextUrl.pathname, req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Bad MCP token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const reply = await handleMcpMessage(body);
  return reply ? NextResponse.json(reply) : new NextResponse(null, { status: 202 });
}

/** No server-initiated stream and no sessions to end. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

export const DELETE = GET;
