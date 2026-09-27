/** Browser only. Shrink a picture: longest side ≤ max px, JPEG. Phone photos come down to a few hundred KB. */
export async function shrinkImage(file: File, max: number, quality: number): Promise<Blob> {
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

/** hex SHA-256 of a blob (for spotting the same receipt sent twice) */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
