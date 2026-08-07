import { listDocuments, listGenerations } from "@/lib/queries";
import GenerateView from "@/components/GenerateView";

export const dynamic = "force-dynamic";

export default function GeneratePage() {
  // Generated resumes are previewable/revisable straight from the history table.
  const resumes = listDocuments("resume").filter((d) => d.generated === 1);
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Generate</h1>
      <GenerateView generations={listGenerations()} resumes={resumes} />
    </main>
  );
}
