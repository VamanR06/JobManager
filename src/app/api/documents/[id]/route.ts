import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { deleteDocument, documentUsage, getDocument, renameDocument, setDocumentArchived } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

/** Rename (`{name}`) or archive/restore (`{archived: boolean}`). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  const body = await req.json();

  if (typeof body.archived === "boolean") {
    const doc = setDocumentArchived(id, body.archived);
    return doc ? NextResponse.json(doc) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (typeof body.name === "string" && body.name.trim()) {
    const doc = renameDocument(id, body.name.trim());
    return doc ? NextResponse.json(doc) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ error: "Expected {name} or {archived}" }, { status: 400 });
}

/**
 * Documents linked to applications are immutable snapshots: "deleting" one that's
 * in use only archives it (file and links preserved). Hard delete requires zero usage.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  const doc = getDocument(id);
  if (!doc) return NextResponse.json({ ok: true });

  if (documentUsage(id).length > 0) {
    setDocumentArchived(id, true);
    return NextResponse.json({ archived: true });
  }

  fs.rmSync(path.join(process.cwd(), "data", doc.file_path), { force: true });
  deleteDocument(id);
  return NextResponse.json({ deleted: true });
}
