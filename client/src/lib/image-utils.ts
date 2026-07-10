// Shared image-upload / canvas helpers used by the unified <ImageUploader />.
// Lifted out of admin-brand-settings-page.tsx so every upload site shares one
// implementation (avatars, logos, onboarding images, company logo, team photos).

export const CHECKER_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23e5e5e5'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23e5e5e5'/%3E%3Crect x='8' width='8' height='8' fill='%23fff'/%3E%3Crect y='8' width='8' height='8' fill='%23fff'/%3E%3C/svg%3E\")";

export const CHECKER_BG_DARK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23333'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23333'/%3E%3Crect x='8' width='8' height='8' fill='%23222'/%3E%3Crect y='8' width='8' height='8' fill='%23222'/%3E%3C/svg%3E\")";

/** POST a raw File/Blob to /api/uploads and return the stored URL (or throw). */
export async function uploadFile(file: File | Blob, filename?: string): Promise<string> {
  const formData = new FormData();
  const name = filename || (file instanceof File ? file.name : "upload");
  formData.append("file", file, name);
  const res = await fetch("/api/uploads", { method: "POST", credentials: "include", body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: "Upload failed" }));
    throw new Error(err.message || "Upload failed");
  }
  const data = await res.json();
  return data.url as string;
}

/** Serialize a canvas to PNG and upload it. Returns the URL or null on failure. */
export async function uploadCanvasAsFile(canvas: HTMLCanvasElement): Promise<string | null> {
  let blob: Blob | null = null;
  try {
    blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
  } catch {
    blob = null;
  }
  if (!blob) {
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const arr = dataUrl.split(",");
      const bstr = atob(arr[1]);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      blob = new Blob([u8], { type: "image/png" });
    } catch {
      return null;
    }
  }
  if (!blob) return null;
  try {
    return await uploadFile(blob, "logo.png");
  } catch {
    return null;
  }
}

export function detectContentBounds(
  canvas: HTMLCanvasElement,
  includeWhiteDetection = false,
): { x: number; y: number; w: number; h: number } | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      let isEmpty = a < 10;
      if (includeWhiteDetection && !isEmpty) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        isEmpty = a > 240 && r > 240 && g > 240 && b > 240;
      }
      if (!isEmpty) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return null;
  const padding = Math.max(2, Math.round(Math.max(maxX - minX, maxY - minY) * 0.04));
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function makeWhiteTransparent(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const getPixel = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const corners = [
    getPixel(0, 0), getPixel(w - 1, 0),
    getPixel(0, h - 1), getPixel(w - 1, h - 1),
    getPixel(Math.floor(w / 2), 0),
    getPixel(Math.floor(w / 2), h - 1),
    getPixel(0, Math.floor(h / 2)),
    getPixel(w - 1, Math.floor(h / 2)),
  ];
  const bgR = Math.round(corners.reduce((s, c) => s + c[0], 0) / corners.length);
  const bgG = Math.round(corners.reduce((s, c) => s + c[1], 0) / corners.length);
  const bgB = Math.round(corners.reduce((s, c) => s + c[2], 0) / corners.length);
  const hardCut = 30;
  const softEdge = 60;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const dist = Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2);
    if (dist < hardCut) {
      d[i + 3] = 0;
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
    } else if (dist < softEdge) {
      const t = (dist - hardCut) / (softEdge - hardCut);
      d[i + 3] = Math.round(t * t * 255);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

export function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

export function constrainCanvas(canvas: HTMLCanvasElement, maxDim = 800): HTMLCanvasElement {
  const { width, height } = canvas;
  if (width <= maxDim && height <= maxDim) return canvas;
  const ratio = Math.min(maxDim / width, maxDim / height);
  const newW = Math.round(width * ratio);
  const newH = Math.round(height * ratio);
  const out = document.createElement("canvas");
  out.width = newW;
  out.height = newH;
  const ctx = out.getContext("2d");
  if (ctx) ctx.drawImage(canvas, 0, 0, newW, newH);
  return out;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

async function applyTransparencyAndUpload(imageUrl: string): Promise<string> {
  const img = await loadImageElement(imageUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0);
  if (!hasTransparency(canvas)) {
    makeWhiteTransparent(canvas);
  }
  const url = await uploadCanvasAsFile(canvas);
  if (!url) throw new Error("Upload failed");
  return url;
}

/** Server-side (Gemini) background removal, then a transparency cleanup pass. */
export async function removeBackgroundViaApi(imageUrl: string): Promise<string> {
  const resp = await fetch("/api/uploads/remove-background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ imageUrl }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: "Failed to remove background" }));
    throw new Error(err.message || "Failed to remove background");
  }
  const data = await resp.json();
  return applyTransparencyAndUpload(data.url);
}

/** Upload a file, then run server-side background removal on it. */
export async function removeBackgroundFromFile(file: File): Promise<string> {
  const uploadedUrl = await uploadFile(file);
  return removeBackgroundViaApi(uploadedUrl);
}

/**
 * Resolve a URL that is safe to draw onto a canvas without tainting it.
 * Local (same-origin) URLs are returned as-is; our own GCS bucket is private,
 * so its URLs must go through the authenticated /api/uploads/gcs endpoint
 * (an anonymous proxy fetch gets AccessDenied); other external URLs are routed
 * through the image proxy so canvas.toBlob() won't throw a security error.
 */
export function proxiedForCanvas(url: string): string {
  if (!url.startsWith("http")) return url;
  if (/storage\.googleapis\.com\/gostork/i.test(url)) {
    const match = url.match(/storage\.googleapis\.com\/[^/]+\/(.+)/);
    if (match) return `/api/uploads/gcs?path=${encodeURIComponent(match[1])}`;
  }
  return `/api/uploads/proxy?url=${encodeURIComponent(url)}`;
}
