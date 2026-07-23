import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { deleteRecording, getRecording } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  const recording = getRecording(id);
  if (recording) {
    const absPath = path.join(process.cwd(), "data", recording.file_path);
    fs.rmSync(absPath, { force: true });
    deleteRecording(id);
  }
  return NextResponse.json({ ok: true });
}
