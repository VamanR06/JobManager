import { NextResponse } from "next/server";
import { activeRecording } from "@/lib/recorder";

export async function GET() {
  return NextResponse.json({ active: activeRecording() });
}
