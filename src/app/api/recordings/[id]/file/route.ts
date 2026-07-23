import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { getRecording } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

/** Stream the .mov with HTTP Range support so <video> can seek. */
export async function GET(req: NextRequest, { params }: Params) {
  const recording = getRecording(Number((await params).id));
  if (!recording) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const absPath = path.join(process.cwd(), "data", recording.file_path);
  if (!fs.existsSync(absPath)) return NextResponse.json({ error: "File missing" }, { status: 404 });

  const { size } = fs.statSync(absPath);
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? parseInt(match[1], 10) : 0;
    const end = match?.[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
    if (start >= size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(absPath, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: {
        "Content-Type": "video/quicktime",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(absPath)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "video/quicktime",
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
    },
  });
}
