import { NextRequest, NextResponse } from "next/server";
import { deleteJob, getJob, updateJob } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const job = getJob(Number((await params).id));
  return job ? NextResponse.json(job) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const job = updateJob(Number((await params).id), await req.json());
  return job ? NextResponse.json(job) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  deleteJob(Number((await params).id));
  return NextResponse.json({ ok: true });
}
