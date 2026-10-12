import { NextRequest, NextResponse } from "next/server";
import { defaultResumeEngine, setSetting } from "@/lib/automation";

export async function GET() {
  return NextResponse.json({ resume_engine: defaultResumeEngine() });
}

/** Body: { resume_engine: "codex" | "claude" } — the engine new resume runs use. */
export async function PUT(req: NextRequest) {
  const { resume_engine } = await req.json();
  if (resume_engine !== "codex" && resume_engine !== "claude") {
    return NextResponse.json({ error: "resume_engine must be codex or claude" }, { status: 400 });
  }
  setSetting("resume_engine", resume_engine);
  return NextResponse.json({ resume_engine });
}
