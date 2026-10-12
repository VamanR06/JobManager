import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionToken,
  hashPassword,
  safeNextPath,
  SESSION_TTL_MS,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/auth";

test("password hash round-trips and rejects wrong passwords", () => {
  const hash = hashPassword("correct horse");
  assert.match(hash, /^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/);
  assert.ok(!hash.includes("$"), "no $ — Next's env loader would expand it");
  assert.equal(verifyPassword("correct horse", hash), true);
  assert.equal(verifyPassword("correct horsE", hash), false);
  assert.equal(verifyPassword("", hash), false);
  assert.notEqual(hashPassword("correct horse"), hash, "salted");
});

test("malformed stored hashes fail closed", () => {
  for (const bad of ["", "plaintext", "scrypt:1:2:3", "bcrypt:1:1:1:abc:def", "scrypt:x:8:1:abc:def"]) {
    assert.equal(verifyPassword("anything", bad), false, bad);
  }
});

test("session tokens are bound to the hash and expire", () => {
  const hash = hashPassword("pw-one-123");
  const now = Date.now();
  const token = createSessionToken(hash, now);
  assert.equal(verifySessionToken(token, hash, now), true);
  assert.equal(verifySessionToken(token, hashPassword("pw-two-123"), now), false, "password change signs out");
  assert.equal(verifySessionToken(token, hash, now + SESSION_TTL_MS + 1), false, "expired");
  const [, sig] = token.split(".");
  assert.equal(verifySessionToken(`${now + SESSION_TTL_MS * 10}.${sig}`, hash, now), false, "tampered expiry");
  assert.equal(verifySessionToken(undefined, hash, now), false);
  assert.equal(verifySessionToken("garbage", hash, now), false);
});

test("next paths stay on this site", () => {
  assert.equal(safeNextPath("/jobs/3?tab=x"), "/jobs/3?tab=x");
  assert.equal(safeNextPath("//evil.com"), "/");
  assert.equal(safeNextPath("/\\evil.com"), "/");
  assert.equal(safeNextPath("https://evil.com"), "/");
  assert.equal(safeNextPath(null), "/");
});
