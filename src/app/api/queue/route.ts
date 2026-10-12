import { NextResponse } from "next/server";
import { listQueue } from "@/lib/automation";

export async function GET() {
  return NextResponse.json(listQueue());
}
