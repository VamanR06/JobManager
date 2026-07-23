import { NextRequest, NextResponse } from "next/server";
import { parsePostingUrl } from "@/lib/parser";

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "A valid http(s) URL is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await parsePostingUrl(url));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Parse failed" },
      { status: 422 }
    );
  }
}
