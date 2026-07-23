import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { deleteDocument, getDocument, renameDocument } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { name } = await req.json();
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const doc = renameDocument(Number((await params).id), name.trim());
  return doc ? NextResponse.json(doc) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  const doc = getDocument(id);
  if (doc) {
    fs.rmSync(path.join(process.cwd(), "data", doc.file_path), { force: true });
    deleteDocument(id); // job links are set NULL via FK
  }
  return NextResponse.json({ ok: true });
}
