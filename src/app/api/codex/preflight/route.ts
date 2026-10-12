import { NextRequest, NextResponse } from "next/server";
import { codexConfig } from "@/lib/codex/config";
import { preflight } from "@/lib/codex/preflight";

/** Setup diagnostics for one engine (?engine=codex|claude). Reports versions and blockers, never credentials. */
export async function GET(req: NextRequest) {
  const engine = req.nextUrl.searchParams.get("engine") === "claude" ? "claude" : "codex";
  const result = await preflight(codexConfig(), engine);
  return NextResponse.json({
    ...result,
    // File-level hashes are noise for the UI; the combined hash identifies the bundle.
    plugin: result.plugin ? { ...result.plugin, files: result.plugin.files.length } : null,
  });
}
