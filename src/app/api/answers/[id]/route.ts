import { NextRequest, NextResponse } from "next/server";
import { deleteAnswer, listAnswers, updateAnswerText } from "@/lib/apply/answers";

type Params = { params: Promise<{ id: string }> };

/** Body: { answer }. Changes a saved answer's text. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  const { answer } = await req.json();
  if (typeof answer !== "string" || !answer.trim()) return NextResponse.json({ error: "answer can't be blank; delete it instead" }, { status: 400 });
  if (!updateAnswerText(id, answer.trim().slice(0, 5000))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(listAnswers());
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!deleteAnswer(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(listAnswers());
}
