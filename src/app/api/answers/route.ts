import { NextRequest, NextResponse } from "next/server";
import { addGlobalAnswer, listAnswers } from "@/lib/apply/answers";

/** Saved form answers (the answer bank browser_autofill uses). */
export async function GET() {
  return NextResponse.json(listAnswers());
}

/** Body: { question, answer }. Adds an answer used for every application. */
export async function POST(req: NextRequest) {
  const { question, answer } = await req.json();
  if (typeof question !== "string" || !question.trim() || typeof answer !== "string" || !answer.trim()) {
    return NextResponse.json({ error: "question and answer are required" }, { status: 400 });
  }
  addGlobalAnswer(question.slice(0, 1000), answer.trim().slice(0, 5000));
  return NextResponse.json(listAnswers());
}
