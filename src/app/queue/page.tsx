import { listQueue } from "@/lib/automation";
import QueueView from "@/components/queue/QueueView";

export const dynamic = "force-dynamic";

export default function QueuePage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Queue</h1>
      <QueueView initial={listQueue()} />
    </main>
  );
}
