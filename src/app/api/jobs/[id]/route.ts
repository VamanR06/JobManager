import { NextRequest, NextResponse } from "next/server";
import { deleteJob, getJob, updateJob } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const job = getJob(Number((await params).id));
  return job ? NextResponse.json(job) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const body = await req.json();
  // Company and title can be renamed but never blanked.
  for (const field of ["company", "title"] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return NextResponse.json({ error: `${field} can't be empty` }, { status: 400 });
    }
    body[field] = body[field].trim();
  }
  const job = updateJob(Number((await params).id), body);
  return job ? NextResponse.json(job) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  deleteJob(Number((await params).id));
  return NextResponse.json({ ok: true });
}
