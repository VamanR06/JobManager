"use client";

import { useEffect } from "react";

/**
 * Keeps the URL fragment through signing in. The server never sees a fragment,
 * so the sign-in redirect alone would drop it; but /save gets its posting from
 * there (the "Save to JobManager" bookmarklet), so it's added to `next` here.
 */
export default function KeepFragment({ inputId }: { inputId: string }) {
  useEffect(() => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (input && window.location.hash && !input.value.includes("#")) input.value += window.location.hash;
  }, [inputId]);
  return null;
}
