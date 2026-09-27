"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      // clipboard blocked — the link is shown on screen, so nothing else to do
    }
  }
  return (
    <button type="button" onClick={copy} className="btn line sm">{done ? "Copied ✓" : "Copy link"}</button>
  );
}
