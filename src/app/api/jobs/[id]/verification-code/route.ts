import { NextRequest, NextResponse } from "next/server";
import { HarnessError, serverHarness } from "@/lib/apply/harness";
import { getJob } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

/**
 * Body: { code }. Types a verification code (emailed or texted by the job site)
 * into the application's browser tab, so the code goes from the person straight
 * to the site without passing through ChatGPT. Doesn't submit.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!getJob(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { code } = await req.json();
  const clean = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!/^[A-Za-z0-9-]{3,16}$/.test(clean)) return NextResponse.json({ error: "Enter the code as letters and numbers" }, { status: 400 });
  try {
    await serverHarness().enterCode(id, clean);
    console.log(`[browser] app ${id} verification code entered from the job page (${clean.length} chars)`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof HarnessError ? err.message : `Browser error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    console.error(`[browser] app ${id} verification code → ${message}`);
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
