import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/lib/db";
import { saveUploadedDocument } from "../src/lib/documents";
import { documentText } from "../src/lib/resume-experience";

// A PDF resume is readable on a Node without the Node 22+ built-ins pdf.js uses (this file runs in its own
// process, so removing them here doesn't touch the other tests). Before, pdf.js failed to load with
// "Iterator is not defined" and every PDF came back unreadable.

const g = globalThis as Record<string, unknown>;
delete g.Iterator;
delete (process as unknown as Record<string, unknown>).getBuiltinModule;
delete (URL as unknown as Record<string, unknown>).parse;

/** A one-page PDF showing `line`, with a correct xref table. */
function tinyPdf(line: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("a PDF resume reads without Node 22's built-ins", async () => {
  getDb();
  assert.equal(typeof g.Iterator, "undefined");
  const { doc } = saveUploadedDocument("resume", "Old_Node_Resume.pdf", tinyPdf("Software Engineer Intern at Acme"));
  const read = await documentText(doc);
  assert.ok("text" in read, "error" in read ? read.error : "");
  assert.match(read.text, /Software Engineer Intern at Acme/);
});
