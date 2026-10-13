import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { generateInboxToken, hashPassword, mcpAuthorized } from "../src/lib/auth";
import { handleMcpMessage } from "../src/lib/mcp";
import { createEvent, createJob } from "../src/lib/queries";
import { proxy } from "../src/proxy";
import { POST } from "../src/app/api/mcp/[[...token]]/route";

const TOKEN = generateInboxToken();
process.env.JOBMANAGER_MCP_TOKEN = TOKEN;

test("mcp token: in the path, or as a bearer on /api/mcp only", () => {
  assert.equal(mcpAuthorized(`/api/mcp/${TOKEN}`, null), true);
  assert.equal(mcpAuthorized(`/api/mcp/${TOKEN}/`, null), true);
  assert.equal(mcpAuthorized(`/api/mcp/${TOKEN}x`, null), false);
  assert.equal(mcpAuthorized("/api/mcp", `Bearer ${TOKEN}`), true);
  assert.equal(mcpAuthorized("/api/mcp", null), false);
  assert.equal(mcpAuthorized("/api/mcp/wrong", `Bearer ${TOKEN}`), false, "a wrong path token isn't rescued by the header");
  assert.equal(mcpAuthorized(`/api/mcp/${TOKEN}/extra`, null), false);
  assert.equal(mcpAuthorized("/api/mcp/%E0%A4%A", null), false, "bad escapes fail closed");
  assert.equal(mcpAuthorized(`/api/mcp/${TOKEN}`, null, null), false, "no token configured = off");
});

function rpc(method: string, params?: Record<string, unknown>, notify = false) {
  return handleMcpMessage({ jsonrpc: "2.0", ...(notify ? {} : { id: 1 }), method, params }) as { result?: any; error?: any } | null;
}

test("initialize, tools/list and notifications", () => {
  const init = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })!;
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  assert.equal(rpc("initialize", { protocolVersion: "1999-01-01" })!.result.protocolVersion, "2025-11-25");
  assert.equal(rpc("notifications/initialized", undefined, true), null);
  const tools = rpc("tools/list")!.result.tools;
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ["list_applications", "get_application", "list_documents"], "read-only by default");
  assert.ok(tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint));
  assert.equal(rpc("tools/delete_everything")!.error.code, -32601);
  assert.equal((handleMcpMessage({ nope: true }) as any).error.code, -32600);
});

const todo = createJob({ company: "Mcp Co", title: "SWE Intern", url: "https://jobs.example.com/1", notes: "referral from Sam" });
createEvent({ job_id: todo.id, status: "to_apply" });
const done = createJob({ company: "Done Co", title: "SWE" });
createEvent({ job_id: done.id, status: "to_apply", occurred_at: "2026-01-01T00:00:00.000Z" });
createEvent({ job_id: done.id, status: "applied", occurred_at: "2026-01-02T00:00:00.000Z" });
createEvent({ job_id: done.id, status: "pending", occurred_at: "2026-01-03T00:00:00.000Z" });

function call(name: string, args: Record<string, unknown>) {
  return rpc("tools/call", { name, arguments: args })!.result;
}
const idsOf = (res: any) => res.structuredContent.applications.map((a: { id: number }) => a.id);

test("list_applications returns everything without a filter, or only the given current status", () => {
  const all = call("list_applications", {});
  assert.ok(idsOf(all).includes(todo.id));
  assert.ok(idsOf(all).includes(done.id));
  assert.equal(JSON.parse(all.content[0].text).count, all.structuredContent.count);
  const row = all.structuredContent.applications.find((a: { id: number }) => a.id === todo.id);
  assert.equal(row.company, "Mcp Co");
  assert.equal(row.status, "To apply");
  assert.equal(row.url, "https://jobs.example.com/1");

  const toApply = call("list_applications", { status: "to_apply" });
  assert.ok(idsOf(toApply).includes(todo.id));
  assert.ok(!idsOf(toApply).includes(done.id), "moved on past to_apply");
  assert.ok(idsOf(call("list_applications", { status: "pending" })).includes(done.id));
  assert.equal(call("list_applications", { status: "bogus" }).isError, true);
});

test("list_applications searches company, title and URL, every word must match", () => {
  assert.deepEqual(idsOf(call("list_applications", { query: "mcp" })), [todo.id]);
  assert.deepEqual(idsOf(call("list_applications", { query: "  MCP   intern " })), [todo.id], "case and spacing don't matter");
  assert.deepEqual(idsOf(call("list_applications", { query: "jobs.example.com/1" })), [todo.id], "matches the URL");
  assert.deepEqual(idsOf(call("list_applications", { query: "mcp senior" })), [], "all words must match");
  assert.deepEqual(idsOf(call("list_applications", { query: "co", status: "to_apply" })), [todo.id], "combines with status");
  assert.equal(call("list_applications", { query: 5 }).isError, true);
});

test("list_applications caps rows and says when it did", () => {
  const one = call("list_applications", { limit: 1 }).structuredContent;
  assert.equal(one.count, 1);
  assert.equal(one.total, 2);
  assert.match(one.truncated, /newest 1 of 2/);
  assert.equal(call("list_applications", {}).structuredContent.truncated, undefined);
  assert.equal(call("list_applications", { limit: 0 }).isError, true);
  assert.equal(call("list_applications", { limit: 501 }).isError, true);
});

test("get_application returns one application with its history", () => {
  const app = call("get_application", { id: done.id }).structuredContent;
  assert.equal(app.company, "Done Co");
  assert.equal(app.status, "Pending — after Applied");
  assert.deepEqual(app.history.map((h: { label: string }) => h.label), ["Pending — after Applied", "Applied", "To apply"]);
  assert.equal(app.history[0].job_id, undefined);
  assert.equal(app.posting, null);

  assert.equal(call("get_application", { id: todo.id }).structuredContent.notes, "referral from Sam");
  assert.equal(call("get_application", { id: 999_999 }).isError, true);
  assert.equal(call("get_application", {}).isError, true);
});

function req(path: string, headers: Record<string, string> = {}, body?: string) {
  return new NextRequest(`https://jobs.example.com${path}`, {
    method: "POST",
    headers: { host: "jobs.example.com", "content-type": "application/json", ...headers },
    body,
  });
}

test("proxy lets /api/mcp/<token> through on its token alone, and nothing else", () => {
  process.env.JOBMANAGER_PASSWORD_HASH = hashPassword("pw-for-test");
  try {
    const ok = proxy(req(`/api/mcp/${TOKEN}`, { "sec-fetch-site": "cross-site" }));
    assert.equal(ok.headers.get("x-middleware-next"), "1");
    assert.equal(proxy(req("/api/mcp/wrong")).status, 401);
    assert.equal(proxy(req("/api/mcp")).status, 401);
    assert.equal(proxy(req("/api/jobs", { authorization: `Bearer ${TOKEN}` })).status, 401, "token opens nothing else");
  } finally {
    delete process.env.JOBMANAGER_PASSWORD_HASH;
  }
});

test("route speaks JSON-RPC over POST", async () => {
  const res = await POST(req(`/api/mcp/${TOKEN}`, {}, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, 7);
  const note = await POST(req(`/api/mcp/${TOKEN}`, {}, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })));
  assert.equal(note.status, 202);
  assert.equal((await POST(req(`/api/mcp/${TOKEN}`, {}, "{not json"))).status, 400);
  assert.equal((await POST(req("/api/mcp/wrong", {}, "{}"))).status, 401);
});
