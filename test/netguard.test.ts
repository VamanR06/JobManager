import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, isBlockedIp } from "../src/lib/netguard";

test("private, loopback, link-local and mapped addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "104.16.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("URLs are checked against every resolved address", async () => {
  const resolve = async (host: string) => (host === "rebind.test" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
  await assert.doesNotReject(assertPublicUrl("https://jobs.example.com/1", resolve));
  await assert.rejects(assertPublicUrl("https://rebind.test/", resolve), /private or local/);
  await assert.rejects(assertPublicUrl("http://localhost/api/jobs", resolve), /Local network/);
  await assert.rejects(assertPublicUrl("http://127.0.0.1/", resolve), /private or local/);
  await assert.rejects(assertPublicUrl("http://[::1]/", resolve), /private or local/);
  await assert.rejects(assertPublicUrl("https://jobs.example.com:8443/", resolve), /ports/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd", resolve), /http/);
  await assert.rejects(assertPublicUrl("http://printer.local/", resolve), /Local network/);
});
