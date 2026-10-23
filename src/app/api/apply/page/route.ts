import { NextRequest, NextResponse } from "next/server";
import { pageInfo } from "@/lib/apply/page";

/** Body: { url }. Which tracked job this page (posting or application form) is, with its resume and cover letter. */
export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "A valid http(s) URL is required" }, { status: 400 });
  }
  return NextResponse.json(pageInfo(url));
}
