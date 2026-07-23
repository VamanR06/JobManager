import type { Status } from "@/lib/types";

const COLORS: Record<Status, string> = {
  applied: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  oa: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  interview: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  accepted: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
};

export default function StatusBadge({ status, label }: { status: Status | null; label: string }) {
  const color = status ? COLORS[status] : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${color}`}>
      {label}
    </span>
  );
}
