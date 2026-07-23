import { listDocuments } from "@/lib/queries";
import DocumentsView from "@/components/DocumentsView";

export const dynamic = "force-dynamic";

export default function CoverLettersPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Cover Letters</h1>
      <DocumentsView kind="cover_letter" documents={listDocuments("cover_letter")} />
    </main>
  );
}
