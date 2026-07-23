import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DOCUMENTS_DIR } from "@/lib/db";
import { createDocument, listDocuments } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind");
  if (kind !== "resume" && kind !== "cover_letter") {
    return NextResponse.json({ error: "kind must be 'resume' or 'cover_letter'" }, { status: 400 });
  }
  return NextResponse.json(listDocuments(kind));
}

/** Multipart upload: fields `kind` + `file`. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const kind = form.get("kind");
  const file = form.get("file");
  if (kind !== "resume" && kind !== "cover_letter") {
    return NextResponse.json({ error: "kind must be 'resume' or 'cover_letter'" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const safeName = file.name.replace(/[^\w.\-() ]+/g, "_");
  const filename = `${Date.now()}-${safeName}`;
  fs.writeFileSync(path.join(DOCUMENTS_DIR, filename), Buffer.from(await file.arrayBuffer()));

  const doc = createDocument(kind, file.name, path.join("documents", filename));
  return NextResponse.json(doc, { status: 201 });
}
