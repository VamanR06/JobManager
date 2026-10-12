import { NextRequest, NextResponse } from "next/server";
import { listProfile, setProfileFacts } from "@/lib/automation";
import { PROFILE_FIELDS } from "@/lib/workflow-types";

const KEYS = new Set<string>(PROFILE_FIELDS.map((f) => f.key));

export async function GET() {
  return NextResponse.json(listProfile());
}

/** Body: { values: { key: value } }. Only known keys; blank removes a fact. */
export async function PUT(req: NextRequest) {
  const { values } = await req.json();
  if (!values || typeof values !== "object") return NextResponse.json({ error: "values is required" }, { status: 400 });
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (KEYS.has(k) && typeof v === "string") clean[k] = v.slice(0, 500);
  }
  setProfileFacts(clean);
  return NextResponse.json(listProfile());
}
