import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DOCUMENTS_DIR } from "./db";
import { createDocument, findDocumentByContent, setDocumentArchived } from "./queries";
import type { AppDocument, DocumentKind } from "./types";

/** File types the upload forms accept. */
export const DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".txt", ".md"];

/**
 * Stores an uploaded resume or cover letter. Re-uploading the exact same file
 * under the same name reuses that version (restoring it if archived) instead of
 * piling up identical copies; same name with different content becomes the next
 * version of that name.
 */
export function saveUploadedDocument(kind: DocumentKind, name: string, bytes: Buffer): { doc: AppDocument; duplicate: boolean } {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const existing = findDocumentByContent(kind, name, sha256);
  if (existing) {
    return { doc: existing.archived ? setDocumentArchived(existing.id, false)! : existing, duplicate: true };
  }
  const safeName = name.replace(/[^\w.\-() ]+/g, "_");
  const filename = `${Date.now()}-${safeName}`;
  fs.writeFileSync(path.join(DOCUMENTS_DIR, filename), bytes);
  return { doc: createDocument(kind, name, path.join("documents", filename), undefined, sha256), duplicate: false };
}
