import SaveFromBrowser from "@/components/SaveFromBrowser";

export const dynamic = "force-dynamic";

/** Where the "Save to JobManager" bookmarklet lands; without a posting it explains how to set the bookmarklet up. */
export default function SavePage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Save a job from your browser</h1>
      <SaveFromBrowser />
    </main>
  );
}
