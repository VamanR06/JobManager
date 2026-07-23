import { NextRequest, NextResponse } from "next/server";
import { getEvent } from "@/lib/queries";
import { startRecording } from "@/lib/recorder";

export async function POST(req: NextRequest) {
  const { event_id } = await req.json();
  if (!getEvent(Number(event_id))) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(startRecording(Number(event_id)), { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start recording" },
      { status: 409 }
    );
  }
}
