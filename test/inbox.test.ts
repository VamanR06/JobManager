import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { generateInboxToken, hashPassword, INBOX_PATH, inboxAuthorized } from "../src/lib/auth";
import { importSharedText, linksInText } from "../src/lib/inbox";
import { proxy } from "../src/proxy";

const TOKEN = generateInboxToken();
process.env.JOBMANAGER_INBOX_TOKEN = TOKEN;

test("inbox token: bearer only, exact match, off when unset", () => {
  assert.equal(inboxAuthorized(`Bearer ${TOKEN}`), true);
  assert.equal(inboxAuthorized(`bearer   ${TOKEN} `), true);
  assert.equal(inboxAuthorized(TOKEN), false, "needs the Bearer scheme");
  assert.equal(inboxAuthorized(`Bearer ${TOKEN}x`), false);
  assert.equal(inboxAuthorized(`Bearer ${TOKEN.slice(1)}`), false);
  assert.equal(inboxAuthorized(null), false);
  assert.equal(inboxAuthorized(`Bearer ${TOKEN}`, null), false, "no token configured = inbox off");
  assert.match(TOKEN, /^[\w-]{43}$/);
});

test("only links are taken from shared text", () => {
  assert.deepEqual(
    linksInText("We're hiring! Apply: https://jobs.lever.co/acme/123 (closes Friday) #jobs"),
    ["https://jobs.lever.co/acme/123"]
  );
  assert.deepEqual(linksInText("no links here, just a caption"), []);
});

test("shared text imports job links and skips social posts", () => {
  const out = importSharedText("https://boards.greenhouse.io/inboxco/jobs/77");
  assert.equal(out.results[0].outcome, "created");
  assert.equal(out.message, "Added 1 job");

  assert.equal(importSharedText("https://boards.greenhouse.io/inboxco/jobs/77").results[0].outcome, "duplicate");

  const ig = importSharedText("https://www.instagram.com/p/AbC123/?igsh=xyz");
  assert.equal(ig.results[0].outcome, "unsupported");
  assert.match(ig.message, /^Skipped: Social post/);

  assert.equal(importSharedText("just words").message, "No link found in what was shared");
});

function req(headers: Record<string, string>, path = INBOX_PATH) {
  return new NextRequest(`https://jobs.example.com${path}`, { method: "POST", headers });
}

test("proxy lets the inbox through on its token alone", () => {
  process.env.JOBMANAGER_PASSWORD_HASH = hashPassword("pw-for-test");
  try {
    // No session cookie, foreign Host, cross-site: all fine with the token.
    const ok = proxy(req({ authorization: `Bearer ${TOKEN}`, host: "jobs.example.com", "sec-fetch-site": "cross-site" }));
    assert.equal(ok.headers.get("x-middleware-next"), "1");
    assert.equal(proxy(req({ host: "jobs.example.com" })).status, 401);
    assert.equal(proxy(req({ authorization: "Bearer wrong", host: "jobs.example.com" })).status, 401);
    // The token doesn't open any other route.
    assert.equal(proxy(req({ authorization: `Bearer ${TOKEN}`, host: "jobs.example.com" }, "/api/import")).status, 401);
  } finally {
    delete process.env.JOBMANAGER_PASSWORD_HASH;
  }
});
