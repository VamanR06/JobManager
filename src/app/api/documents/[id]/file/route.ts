import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getDocument } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export async function GET(_req: NextRequest, { params }: Params) {
  const doc = getDocument(Number((await params).id));
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const absPath = path.join(process.cwd(), "data", doc.file_path);
  if (!fs.existsSync(absPath)) return NextResponse.json({ error: "File missing" }, { status: 404 });

  const ext = path.extname(doc.name).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  // PDFs/text render in the browser; everything else downloads with its original name.
  const disposition = [".pdf", ".txt", ".md"].includes(ext) ? "inline" : "attachment";
  return new NextResponse(new Uint8Array(fs.readFileSync(absPath)), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${disposition}; filename="${doc.name.replace(/"/g, "")}"`,
    },
  });
}
