"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MAX_PHOTOS, PHOTO_BUCKET, photoUrl, thumbPath } from "@/lib/store";
import { removePhoto, setPhoto } from "@/app/actions";

/** Shrink a picture in the browser: longest side ≤ max px, JPEG. Keeps phone photos small (≈ 150–300 KB). */
async function shrink(file: File, max: number, quality: number): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  let w: number, h: number;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    source = bmp; w = bmp.width; h = bmp.height;
  } catch {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    source = img; w = img.naturalWidth; h = img.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize pictures");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read the picture"))), "image/jpeg", quality)
  );
}

/** Two photo slots for one product: shows what is there, lets the treasurer add / replace / remove. */
export function PhotoUploader({ productId, photos }: { productId: string; photos: string[] }) {
  const router = useRouter();
  const [list, setList] = useState<string[]>(photos);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  async function upload(index: number, file: File) {
    setMsg(null);
    setBusy(index);
    try {
      if (!file.type.startsWith("image/")) throw new Error("Choose a picture (JPEG, PNG or HEIC from the camera)");
      const [big, small] = await Promise.all([shrink(file, 1200, 0.85), shrink(file, 240, 0.8)]);
      const stamp = Date.now();
      const path = `${productId}/${stamp}-${index + 1}.jpg`;
      const supabase = createClient();
      const bucket = supabase.storage.from(PHOTO_BUCKET);
      const up1 = await bucket.upload(path, big, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
      if (up1.error) throw new Error(up1.error.message);
      const up2 = await bucket.upload(thumbPath(path), small, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
      if (up2.error) throw new Error(up2.error.message);
      const res = await setPhoto(productId, index, path);
      if ("error" in res) throw new Error(res.error);
      setList(res.photos);
      setMsg("Saved ✓");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
      const inp = inputs.current[index];
      if (inp) inp.value = "";
    }
  }

  async function remove(index: number) {
    setMsg(null);
    setBusy(index);
    try {
      const res = await removePhoto(productId, index);
      if ("error" in res) throw new Error(res.error);
      setList(res.photos);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not remove");
    } finally {
      setBusy(null);
    }
  }

  const slots = Array.from({ length: MAX_PHOTOS }, (_, i) => list[i] ?? null);
  return (
    <div className="photos">
      {slots.map((path, i) => {
        const canUse = i === 0 || !!list[0];   // the second slot opens once there is a first picture
        return (
          <div key={i} className="pslot">
            {path ? (
              <a href={photoUrl(path)} target="_blank" rel="noopener noreferrer" className="pthumb" title="Open full size">
                <img src={photoUrl(path, true)} alt={`Photo ${i + 1}`} width={72} height={72} loading="lazy" />
              </a>
            ) : (
              <div className="pthumb empty" aria-hidden="true">{i + 1}</div>
            )}
            <div className="pslot-actions">
              <label className={`btn line sm ${!canUse || busy !== null ? "disabled" : ""}`} style={{ cursor: canUse ? "pointer" : "default" }}>
                {busy === i ? "Uploading…" : path ? "Replace" : i === 0 ? "Add photo" : "Add 2nd"}
                <input
                  ref={(el) => { inputs.current[i] = el; }}
                  type="file" accept="image/*" style={{ display: "none" }}
                  disabled={!canUse || busy !== null}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(i, f); }}
                />
              </label>
              {path && <button type="button" className="btn quiet sm" disabled={busy !== null} onClick={() => void remove(i)}>Remove</button>}
            </div>
          </div>
        );
      })}
      {msg && <div className={`small ${msg === "Saved ✓" ? "muted" : "err-text"}`} style={{ alignSelf: "center" }}>{msg}</div>}
    </div>
  );
}
