/** "Jul 23, 2026, 1:45 AM" */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact elapsed duration between two instants: "6d 4h", "3h 12m", "45m", "<1m" */
export function formatElapsed(fromIso: string, toIso: string): string {
  const ms = Math.abs(new Date(toIso).getTime() - new Date(fromIso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** "3 days ago" style, coarse. */
export function formatAgo(iso: string): string {
  return `${formatElapsed(iso, new Date().toISOString())} ago`;
}

/** Seconds → "12:34" or "1:02:34" */
export function formatSeconds(total: number): string {
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** ISO string → value acceptable to <input type="datetime-local"> in local time. */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (local time) → ISO string; empty → null. */
export function fromDatetimeLocal(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}
