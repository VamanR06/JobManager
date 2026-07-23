import { NextResponse } from "next/server";
import { stopRecording } from "@/lib/recorder";

export async function POST() {
  const recording = await stopRecording();
  if (!recording) {
    return NextResponse.json({ error: "No recording in progress" }, { status: 409 });
  }
  return NextResponse.json(recording);
}
