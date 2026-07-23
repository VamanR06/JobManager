"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Start/stop the native screen+audio recorder for an interview event. */
export default function RecorderControls({ eventId }: { eventId: number }) {
  const router = useRouter();
  // null = unknown (loading), number = active recording's event id, false = idle
  const [activeEventId, setActiveEventId] = useState<number | false | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/recordings/status")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.active) {
          startedAtRef.current = data.active.startedAt ?? Date.now();
          setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
          setActiveEventId(data.active.eventId ?? -1);
        } else {
          setActiveEventId(false);
        }
      })
      .catch(() => !cancelled && setActiveEventId(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeEventId !== eventId) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [activeEventId, eventId]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recordings/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start");
      startedAtRef.current = Date.now();
      setElapsed(0);
      setActiveEventId(eventId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recordings/stop", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to stop");
      setActiveEventId(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop");
    } finally {
      setBusy(false);
    }
  }

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2">
      {activeEventId === eventId ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            REC {fmt(elapsed)}
          </span>
          <button
            onClick={stop}
            disabled={busy}
            className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Stop recording
          </button>
        </>
      ) : (
        <button
          onClick={start}
          disabled={busy || activeEventId === null || (activeEventId !== false && activeEventId !== eventId)}
          className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        >
          ● Record interview
        </button>
      )}
      {activeEventId !== false && activeEventId !== null && activeEventId !== eventId && (
        <span className="text-xs text-zinc-400">another recording is running</span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
