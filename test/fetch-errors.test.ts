import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchConnectError } from "../src/lib/netguard";
import { parsePostingUrl, type Fetcher } from "../src/lib/parser";

/** What Node's fetch throws when there's no HTTP response: TypeError("fetch failed") with the real reason as its cause. */
const nodeFailure = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });

test("a connection failure says which host and why, not just 'fetch failed'", () => {
  assert.equal(
    new FetchConnectError("micron.wd1.myworkdayjobs.com", nodeFailure("ECONNRESET"), 20).message,
    "Couldn't connect to micron.wd1.myworkdayjobs.com: the connection was cut off (often a firewall or bot protection refusing this network) (ECONNRESET)"
  );
  assert.match(new FetchConnectError("x.com", nodeFailure("ENOTFOUND"), 20).message, /doesn't resolve \(DNS\) \(ENOTFOUND\)/);
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.match(new FetchConnectError("x.com", timeout, 20).message, /no answer within 20s \(TIMEOUT\)/);
  assert.match(new FetchConnectError("x.com", nodeFailure("CERT_HAS_EXPIRED"), 20).message, /Couldn't connect to x\.com: CERT_HAS_EXPIRED$/, "unknown codes are passed through");
});

test("a Workday posting the server can't reach reports both attempts", async () => {
  const url = "https://micron.wd1.myworkdayjobs.com/en-US/External/job/Richardson-TX/Intern---Machine-Learning-Engineering_JR114750";
  const fetcher: Fetcher = async (u) => {
    throw new FetchConnectError(new URL(u).hostname, nodeFailure("ECONNRESET"), 20);
  };
  await assert.rejects(parsePostingUrl(url, fetcher), (err: Error) => {
    assert.match(err.message, /^Couldn't connect to micron\.wd1\.myworkdayjobs\.com: the connection was cut off/);
    assert.doesNotMatch(err.message, /Workday API:/, "the same reason isn't repeated");
    return true;
  });
  // Different reasons for the API and the page are both shown.
  let n = 0;
  const mixed: Fetcher = async (u) => {
    throw new FetchConnectError(new URL(u).hostname, nodeFailure(n++ === 0 ? "ETIMEDOUT" : "ECONNRESET"), 20);
  };
  await assert.rejects(parsePostingUrl(url, mixed), /cut off .*\(Workday API: Couldn't connect to micron\.wd1\.myworkdayjobs\.com: the connection timed out \(ETIMEDOUT\)\)/);
});
