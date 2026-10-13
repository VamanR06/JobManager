import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { hashPassword } from "../src/lib/auth";
import { proxy } from "../src/proxy";

const get = (path: string, host = "jobs.example.com") => proxy(new NextRequest(`https://${host}${path}`, { headers: { host } }));

test("every proxy response tells search engines not to index", () => {
  const local = get("/", "evil.example"); // local mode, foreign host → 403
  assert.equal(local.status, 403);
  assert.match(local.headers.get("x-robots-tag") ?? "", /noindex/);

  process.env.JOBMANAGER_PASSWORD_HASH = hashPassword("pw-for-test");
  try {
    for (const res of [get("/"), get("/login"), get("/robots.txt"), get("/api/jobs")]) {
      assert.match(res.headers.get("x-robots-tag") ?? "", /noindex, nofollow/);
    }
  } finally {
    delete process.env.JOBMANAGER_PASSWORD_HASH;
  }
});
