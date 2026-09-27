"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RECEIPTS_BUCKET } from "@/lib/claims";
import { sha256Hex, shrinkImage } from "@/lib/shrink-image";
import { finishReceiptClaim, startReceiptClaim } from "@/app/actions";

const MAX_FILES = 4;
const MAX_PDF = 15 * 1024 * 1024;

/** Upload a receipt from the phone: pictures are shrunk in the browser, PDFs go as they are. */
export function ReceiptUploader() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const purposeInput = useRef<HTMLTextAreaElement>(null);

  async function send() {
    const files = Array.from(fileInput.current?.files ?? []);
    const purpose = purposeInput.current?.value ?? "";
    setMsg(null);
    if (files.length === 0) { setMsg("Choose a picture or PDF of the receipt first."); return; }
    if (files.length > MAX_FILES) { setMsg(`Up to ${MAX_FILES} files per receipt.`); return; }
    setBusy(true);
    try {
      const start = await startReceiptClaim(purpose);
      if ("error" in start) throw new Error(start.error);
      const supabase = createClient();
      const bucket = supabase.storage.from(RECEIPTS_BUCKET);
      const stored: { path: string; filename: string; content_type: string; bytes: number; sha256: string }[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let blob: Blob;
        let contentType: string;
        let ext: string;
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
          if (f.size > MAX_PDF) throw new Error(`${f.name} is larger than 15 MB`);
          blob = f; contentType = "application/pdf"; ext = "pdf";
        } else if (f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name)) {
          blob = await shrinkImage(f, 1600, 0.85); contentType = "image/jpeg"; ext = "jpg";
        } else {
          throw new Error(`${f.name}: choose a picture or a PDF`);
        }
        const path = `${start.claimId}/${i + 1}-receipt.${ext}`;
        const up = await bucket.upload(path, blob, { contentType, upsert: false });
        if (up.error) throw new Error(up.error.message);
        stored.push({ path, filename: f.name, content_type: contentType, bytes: blob.size, sha256: await sha256Hex(blob) });
      }
      const done = await finishReceiptClaim(start.claimId, stored);
      if ("error" in done) throw new Error(done.error);
      if (fileInput.current) fileInput.current.value = "";
      if (purposeInput.current) purposeInput.current.value = "";
      setCount(0);
      router.push("/me/receipts?ok=receipt_sent");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not send the receipt");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="small" style={{ margin: 0 }}>What was it for?
        <textarea ref={purposeInput} rows={2} placeholder="e.g. 10 brushes for the Tuesday class — 345 kr" />
      </label>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label className={`btn line sm ${busy ? "disabled" : ""}`} style={{ cursor: "pointer" }}>
          {count > 0 ? `${count} file${count === 1 ? "" : "s"} chosen` : "Choose picture or PDF"}
          <input ref={fileInput} type="file" accept="image/*,application/pdf" multiple style={{ display: "none" }} disabled={busy}
                 onChange={(e) => { setCount(e.target.files?.length ?? 0); setMsg(null); }} />
        </label>
        <button type="button" className="btn ink sm" disabled={busy} onClick={() => void send()}>{busy ? "Sending…" : "Send to the treasurer"}</button>
      </div>
      {msg && <div className="small err-text">{msg}</div>}
    </div>
  );
}
