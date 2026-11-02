import { NextRequest, NextResponse } from "next/server";
import { listExperiences, parseExperiences, setExperiences } from "@/lib/experience";

export async function GET() {
  return NextResponse.json(listExperiences());
}

/** Body: { experiences: [...] }, most recent first. Replaces the whole list. */
export async function PUT(req: NextRequest) {
  const { experiences } = await req.json();
  const parsed = parseExperiences(experiences);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  return NextResponse.json(setExperiences(parsed));
}
