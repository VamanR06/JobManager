import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { ARTIFACTS_DIR } from "@/lib/db";

type Params = { params: Promise<{ id: string; name: string }> };

/**
 * A screenshot or submission receipt the ChatGPT browser tools saved for an
 * application. Behind the normal sign-in like every page (they show personal
 * details); ChatGPT hands the person this link.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id, name } = await params;
  if (!/^\d+$/.test(id) || !/^(screenshot|receipt)-[\w-]+\.png$/.test(name)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const file = path.join(ARTIFACTS_DIR, `job-${id}`, name);
  if (!fs.existsSync(file)) return NextResponse.json({ error: "Not found (only the latest 20 screenshots are kept)" }, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: { "Content-Type": "image/png", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, max-age=86400" },
  });
}
