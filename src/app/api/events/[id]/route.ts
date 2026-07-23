import { NextRequest, NextResponse } from "next/server";
import { deleteEvent, updateEvent } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const event = updateEvent(Number((await params).id), await req.json());
  return event ? NextResponse.json(event) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  deleteEvent(Number((await params).id));
  return NextResponse.json({ ok: true });
}
