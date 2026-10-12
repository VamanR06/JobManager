import { NextRequest, NextResponse } from "next/server";
import { importUrls } from "@/lib/automation";

/** Creates applications for new links and queues them; duplicates are reported, not re-added. */
export async function POST(req: NextRequest) {
  const { urls } = await req.json();
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
    return NextResponse.json({ error: "urls must be an array of strings" }, { status: 400 });
  }
  if (urls.length > 200) return NextResponse.json({ error: "Import at most 200 links at a time" }, { status: 400 });
  return NextResponse.json(importUrls(urls), { status: 201 });
}
