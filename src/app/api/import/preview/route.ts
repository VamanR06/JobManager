import { NextRequest, NextResponse } from "next/server";
import { previewImport } from "@/lib/automation";

/** Classifies pasted links (new / duplicate / invalid / unsupported) without fetching anything. */
export async function POST(req: NextRequest) {
  const { text } = await req.json();
  if (typeof text !== "string") return NextResponse.json({ error: "text is required" }, { status: 400 });
  return NextResponse.json(previewImport(text.slice(0, 200_000)));
}
