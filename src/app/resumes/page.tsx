import { listDocuments } from "@/lib/queries";
import DocumentsView from "@/components/DocumentsView";

export const dynamic = "force-dynamic";

export default function ResumesPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Resumes</h1>
      <DocumentsView kind="resume" documents={listDocuments("resume")} />
    </main>
  );
}
