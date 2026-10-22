import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { handleMcpMessage, type McpDeps } from "../src/lib/mcp";

getDb();

async function call(name: string, args: Record<string, unknown>, deps?: McpDeps) {
  const r = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, deps)) as { result: any };
  return r.result;
}
async function withWrite(fn: () => Promise<void>) {
  process.env.JOBMANAGER_MCP_WRITE = "1";
  try {
    await fn();
  } finally {
    delete process.env.JOBMANAGER_MCP_WRITE;
  }
}
/** Stands in for fetching the posting page. */
const posting = (title: string, company: string) => async () => ({ title, company, location: "Remote", description_md: `Work on ${title}.` });

test("add_application saves a link as 'to apply' with the posting's details", async () => {
  await withWrite(async () => {
    const res = await call("add_application", { url: "https://boards.greenhouse.io/addco/jobs/5551?utm_source=chatgpt", notes: "from ChatGPT" }, { parse: posting("Backend Intern", "AddCo") });
    const out = res.structuredContent;
    assert.equal(out.added, true);
    assert.equal(out.application.company, "AddCo");
    assert.equal(out.application.title, "Backend Intern");
    assert.equal(out.application.url, "https://boards.greenhouse.io/addco/jobs/5551", "tracking params dropped");
    assert.match(out.application.status, /to apply/i);
    assert.equal(out.application.notes, "from ChatGPT");
    assert.match(out.application.posting.description_md, /Work on Backend Intern/);
  });
});

test("add_application doesn't add a posting twice", async () => {
  await withWrite(async () => {
    const first = (await call("add_application", { url: "https://boards.greenhouse.io/twice/jobs/6661" }, { parse: posting("ML Intern", "Twice") })).structuredContent;
    let fetched = false;
    const again = (await call("add_application", { url: "https://twice.com/careers?gh_jid=6661" }, {
      parse: async () => {
        fetched = true;
        throw new Error("x");
      },
    })).structuredContent;
    assert.equal(again.added, false);
    assert.equal(again.application.id, first.application.id);
    assert.match(again.note, /already tracked/);
    assert.equal(fetched, false, "no need to fetch a known posting");
  });
});

test("same company and title under another link needs allow_duplicate", async () => {
  await withWrite(async () => {
    const first = (await call("add_application", { url: "https://careers.simco.com/jobs/1" }, { parse: posting("Software Intern", "SimCo, Inc.") })).structuredContent;
    const maybe = (await call("add_application", { url: "https://careers.simco.com/jobs/2" }, { parse: posting("software intern", "SimCo") })).structuredContent;
    assert.equal(maybe.added, false);
    assert.equal(maybe.similar[0].id, first.application.id);
    assert.equal(maybe.application, undefined);
    const yes = (await call("add_application", { url: "https://careers.simco.com/jobs/2", allow_duplicate: true }, { parse: posting("software intern", "SimCo") })).structuredContent;
    assert.equal(yes.added, true);
    assert.notEqual(yes.application.id, first.application.id);
  });
});

test("an unreadable page is still saved, using the names ChatGPT passes", async () => {
  await withWrite(async () => {
    const fail = async () => {
      throw new Error("Could not extract posting content");
    };
    const named = (await call("add_application", { url: "https://jobs.example.org/role/77", company: "Example Org", title: "Data Intern" }, { parse: fail })).structuredContent;
    assert.equal(named.added, true);
    assert.equal(named.application.company, "Example Org");
    assert.match(named.note, /couldn't be read \(Could not extract posting content\)/);
    assert.doesNotMatch(named.note, /placeholders/);
    const bare = (await call("add_application", { url: "https://jobs.example.org/role/78" }, { parse: fail })).structuredContent;
    assert.equal(bare.application.title, "(title unknown)");
    assert.match(bare.note, /placeholders: fix them with update_application/);
  });
});

test("add_application is refused when writes are off, and for links it can't use", async () => {
  const off = await call("add_application", { url: "https://boards.greenhouse.io/x/jobs/1" });
  assert.equal(off.isError, true);
  await withWrite(async () => {
    for (const url of ["not a link", "http://localhost/jobs/1", "https://www.linkedin.com/feed/"]) {
      const res = await call("add_application", { url }, { parse: posting("x", "y") });
      assert.equal(res.isError, true, url);
      assert.match(res.content[0].text, /Can't save that link/);
    }
    assert.equal((await call("add_application", { url: "https://boards.greenhouse.io/x/jobs/1", extra: 1 })).isError, true);
  });
});
