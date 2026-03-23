import { useState, useEffect, useCallback, useRef, useMemo, ReactNode, CSSProperties } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { BrandSettings, BRAND_DEFAULTS, applyBrandPreview, applyBrandToDocument } from "@/hooks/use-brand-settings";
import { deriveChatPalette, hslString } from "@/lib/chat-palette";
import { getPhotoSrc } from "@/lib/profile-utils";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Palette,
  Upload,
  Type,
  Save,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Image,
  Baby,
  Sun,
  Moon,
  Eye,
  Building2,
  Pencil,
  ZoomIn,
  ZoomOut,
  Wand2,
  X,
  Check,
  Move,
  Layers,
  TypeIcon,
  Frame,
  LayoutTemplate,
  Plus,
  Trash2,
  Sparkles,
  GripVertical,
  Home,
  Heart,
  MessageCircle,
  User,
  Users,
  Search as SearchIcon,
  CalendarDays,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, SpermIcon } from "@/components/icons/marketplace-icons";

const GOOGLE_FONTS = [
  "DM Sans",
  "Inter",
  "Lato",
  "Merriweather",
  "Montserrat",
  "Nunito",
  "Open Sans",
  "Oswald",
  "Playfair Display",
  "Poppins",
  "Raleway",
  "Roboto",
  "Roboto Slab",
  "Source Sans 3",
  "Work Sans",
  "Libre Baskerville",
  "Cormorant Garamond",
  "Crimson Text",
  "Lora",
  "PT Serif",
];

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return null;
  return {
    r: parseInt(match[1].slice(0, 2), 16),
    g: parseInt(match[1].slice(2, 4), 16),
    b: parseInt(match[1].slice(4, 6), 16),
  };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hex1: string, hex2: string): number {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  if (!c1 || !c2) return 0;
  const l1 = relativeLuminance(c1.r, c1.g, c1.b);
  const l2 = relativeLuminance(c2.r, c2.g, c2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function wcagLevel(ratio: number): { level: string; icon: typeof CheckCircle2; color: string } {
  if (ratio >= 7) return { level: "AAA", icon: CheckCircle2, color: "text-[hsl(var(--brand-success))]" };
  if (ratio >= 4.5) return { level: "AA", icon: CheckCircle2, color: "text-[hsl(var(--brand-success))]" };
  if (ratio >= 3) return { level: "AA Large", icon: AlertTriangle, color: "text-[hsl(var(--brand-warning))]" };
  return { level: "Fail", icon: XCircle, color: "text-destructive" };
}

const CHECKER_BG = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23e5e5e5'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23e5e5e5'/%3E%3Crect x='8' width='8' height='8' fill='%23fff'/%3E%3Crect y='8' width='8' height='8' fill='%23fff'/%3E%3C/svg%3E\")";
const CHECKER_BG_DARK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23333'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23333'/%3E%3Crect x='8' width='8' height='8' fill='%23222'/%3E%3Crect y='8' width='8' height='8' fill='%23222'/%3E%3C/svg%3E\")";

async function uploadCanvasAsFile(canvas: HTMLCanvasElement): Promise<string | null> {
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
  const formData = new FormData();
  formData.append("file", blob, "logo.png");
  try {
    const res = await fetch("/api/uploads", { method: "POST", credentials: "include", body: formData });
    if (res.ok) {
      const data = await res.json();
      return data.url;
    }
    return null;
  } catch {
    return null;
  }
}

function detectContentBounds(canvas: HTMLCanvasElement, includeWhiteDetection = false): { x: number; y: number; w: number; h: number } | null {
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

function makeWhiteTransparent(canvas: HTMLCanvasElement) {
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
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error("Failed")); return; }
      const formData = new FormData();
      formData.append("file", blob, "logo.png");
      const res = await fetch("/api/uploads", { method: "POST", credentials: "include", body: formData });
      if (!res.ok) { reject(new Error("Upload failed")); return; }
      const data = await res.json();
      resolve(data.url);
    }, "image/png");
  });
}

async function removeBackgroundViaApi(imageUrl: string): Promise<string> {
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
  const geminiUrl = data.url;
  return applyTransparencyAndUpload(geminiUrl);
}

async function removeBackgroundFromFile(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  const uploadRes = await fetch("/api/uploads", {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  if (!uploadRes.ok) throw new Error("Failed to upload image");
  const { url: uploadedUrl } = await uploadRes.json();
  return removeBackgroundViaApi(uploadedUrl);
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

function LogoEditor({
  imageUrl,
  onSave,
  onCancel,
  onError,
  onAutoFixed,
  testId,
}: {
  imageUrl: string;
  onSave: (newUrl: string) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
  onAutoFixed: (newUrl: string) => void;
  testId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(100);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [saving, setSaving] = useState(false);
  const [autoFixing, setAutoFixing] = useState(false);
  const [trimWhite, setTrimWhite] = useState(false);
  const [removeWhiteBg, setRemoveWhiteBg] = useState(false);
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const fitScaleRef = useRef(1);

  useEffect(() => {
    const loadImage = (image: HTMLImageElement) => {
      const container = containerRef.current;
      const cw = container ? container.clientWidth : 500;
      const ch = 250;
      const fit = Math.min(cw / image.width, ch / image.height);
      fitScaleRef.current = fit;
      setZoom(100);
      setPanX(0);
      setPanY(0);
      setImg(image);
    };
    const isExternal = imageUrl.startsWith("http");
    const image = new window.Image();
    if (isExternal) {
      image.crossOrigin = "anonymous";
    }
    image.onload = () => loadImage(image);
    image.onerror = () => {
      if (isExternal) {
        const proxied = new window.Image();
        proxied.crossOrigin = "anonymous";
        proxied.onload = () => loadImage(proxied);
        proxied.onerror = () => onError("Failed to load image for editing");
        proxied.src = `/api/uploads/proxy?url=${encodeURIComponent(imageUrl)}`;
      } else {
        onError("Failed to load image for editing");
      }
    };
    image.src = isExternal ? `/api/uploads/proxy?url=${encodeURIComponent(imageUrl)}` : imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const resizeCanvas = () => {
      const w = container.clientWidth;
      const h = 250;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    resizeCanvas();
    const ro = new ResizeObserver(resizeCanvas);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    const scale = fitScaleRef.current * (zoom / 100);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const dx = (cw - drawW) / 2 + panX;
    const dy = (ch - drawH) / 2 + panY;

    ctx.drawImage(img, dx, dy, drawW, drawH);
  }, [img, zoom, panX, panY]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  const handlePointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPanX((p) => p + dx);
    setPanY((p) => p + dy);
  };

  const handlePointerUp = () => { isDragging.current = false; };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -5 : 5;
    setZoom((z) => Math.max(10, Math.min(500, z + delta)));
  };

  const constrainCanvas = (canvas: HTMLCanvasElement, maxDim: number = 800): HTMLCanvasElement => {
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
  };

  const loadNewImage = (newUrl: string) => {
    const newImage = new window.Image();
    newImage.onload = () => {
      const container = containerRef.current;
      const cw = container ? container.clientWidth : 500;
      const ch = 250;
      fitScaleRef.current = Math.min(cw / newImage.width, ch / newImage.height);
      setImg(newImage);
      setZoom(100);
      setPanX(0);
      setPanY(0);
    };
    newImage.src = newUrl;
  };

  const handleAutoFix = async () => {
    if (!img) return;
    setAutoFixing(true);
    try {
      const maxSrc = 1200;
      const srcScale = Math.min(1, maxSrc / Math.max(img.width, img.height));
      const srcW = Math.round(img.width * srcScale);
      const srcH = Math.round(img.height * srcScale);

      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = srcW;
      tempCanvas.height = srcH;
      const ctx = tempCanvas.getContext("2d");
      if (!ctx) { onError("Canvas not supported"); return; }
      ctx.drawImage(img, 0, 0, srcW, srcH);

      let imgHasAlpha = false;
      try {
        imgHasAlpha = hasTransparency(tempCanvas);
      } catch {
        imgHasAlpha = false;
      }
      const useWhiteTrim = trimWhite || !imgHasAlpha;

      let bounds;
      try {
        bounds = detectContentBounds(tempCanvas, useWhiteTrim);
      } catch {
        onError("Cannot process image — try re-uploading the logo first");
        return;
      }
      if (!bounds) {
        onError("Could not detect logo content — image may be blank");
        return;
      }

      const outCanvas = document.createElement("canvas");
      outCanvas.width = bounds.w;
      outCanvas.height = bounds.h;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) return;
      outCtx.drawImage(tempCanvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);

      const finalCanvas = constrainCanvas(outCanvas);
      if (removeWhiteBg) {
        makeWhiteTransparent(finalCanvas);
      }
      const newUrl = await uploadCanvasAsFile(finalCanvas);
      if (!newUrl) {
        onError("Failed to upload optimized logo");
        return;
      }
      onAutoFixed(newUrl);
      loadNewImage(newUrl);
    } catch (err) {
      onError("Failed to process logo — try re-uploading it first");
    } finally {
      setAutoFixing(false);
    }
  };

  const handleApply = async () => {
    if (!img) return;
    setSaving(true);
    try {
      const scale = zoom / 100;
      let outW = Math.round(img.width * scale);
      let outH = Math.round(img.height * scale);

      const maxDim = 1200;
      if (outW > maxDim || outH > maxDim) {
        const r = Math.min(maxDim / outW, maxDim / outH);
        outW = Math.round(outW * r);
        outH = Math.round(outH * r);
      }

      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = outW;
      fullCanvas.height = outH;
      const fullCtx = fullCanvas.getContext("2d");
      if (!fullCtx) return;
      fullCtx.drawImage(img, 0, 0, outW, outH);

      let finalCanvas = fullCanvas;
      try {
        const imgHasAlpha = hasTransparency(fullCanvas);
        const useWhiteTrim = trimWhite || !imgHasAlpha;
        const outBounds = detectContentBounds(fullCanvas, useWhiteTrim);

        if (outBounds && (outBounds.x > 0 || outBounds.y > 0 || outBounds.w < outW || outBounds.h < outH)) {
          const trimmedCanvas = document.createElement("canvas");
          trimmedCanvas.width = outBounds.w;
          trimmedCanvas.height = outBounds.h;
          const trimCtx = trimmedCanvas.getContext("2d");
          if (trimCtx) {
            trimCtx.drawImage(fullCanvas, outBounds.x, outBounds.y, outBounds.w, outBounds.h, 0, 0, outBounds.w, outBounds.h);
            finalCanvas = trimmedCanvas;
          }
        }
      } catch {
      }

      const constrained = constrainCanvas(finalCanvas);
      if (removeWhiteBg) {
        makeWhiteTransparent(constrained);
      }
      const newUrl = await uploadCanvasAsFile(constrained);
      if (!newUrl) {
        onError("Failed to upload edited logo");
        return;
      }
      onSave(newUrl);
    } catch {
      onError("Failed to process logo — try re-uploading it first");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" data-testid={`${testId}-editor`}>
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium flex items-center gap-1.5">
          <Move className="w-3.5 h-3.5" />
          Edit Logo
        </Label>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
            data-testid={`${testId}-cancel-edit`}
          >
            <X className="w-3.5 h-3.5 mr-1" />
            Cancel
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative border border-border rounded-xl overflow-hidden cursor-grab active:cursor-grabbing select-none touch-none"
        style={{
          height: 250,
          backgroundImage: CHECKER_BG,
          backgroundSize: "16px 16px",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          data-testid={`${testId}-canvas`}
        />
      </div>

      <div className="flex items-center gap-3">
        <ZoomOut className="w-4 h-4 text-muted-foreground shrink-0" />
        <Slider
          value={[zoom]}
          onValueChange={([v]) => setZoom(v)}
          min={10}
          max={500}
          step={5}
          className="flex-1"
          data-testid={`${testId}-zoom-slider`}
        />
        <ZoomIn className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground w-12 text-right">{zoom}%</span>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={trimWhite}
            onChange={(e) => setTrimWhite(e.target.checked)}
            className="rounded border-border"
            data-testid={`${testId}-trim-white`}
          />
          Trim white
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={removeWhiteBg}
            onChange={(e) => setRemoveWhiteBg(e.target.checked)}
            className="rounded border-border"
            data-testid={`${testId}-remove-white-bg`}
          />
          Remove white background
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-8 text-xs"
          onClick={handleAutoFix}
          disabled={autoFixing || saving}
          data-testid={`${testId}-auto-fix`}
        >
          {autoFixing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Wand2 className="w-3.5 h-3.5 mr-1.5" />}
          Auto Fix
        </Button>
        <Button
          size="sm"
          className="flex-1 h-8 text-xs"
          onClick={handleApply}
          disabled={saving || autoFixing}
          data-testid={`${testId}-apply-edit`}
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
          Apply
        </Button>
      </div>
    </div>
  );
}


function FileDropZone({
  label,
  currentUrl,
  onUpload,
  accept,
  testId,
  disabled,
  darkPreview,
}: {
  label: string;
  currentUrl: string | null;
  onUpload: (url: string) => void;
  accept: string;
  testId: string;
  disabled?: boolean;
  darkPreview?: boolean;
}) {
  const displayUrl = getPhotoSrc(currentUrl);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [makeTransparent, setMakeTransparent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFile = async (file: File) => {
    if (disabled) return;
    if (file.size > 16 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum size is 16MB", variant: "destructive" });
      return;
    }
    setUploading(true);
    const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
    try {
      if (makeTransparent && !isSvg) {
        const newUrl = await removeBackgroundFromFile(file);
        onUpload(newUrl);
        setEditing(true);
      } else {
        const formData = new FormData();
        formData.append("file", file, file.name);
        const res = await fetch("/api/uploads", {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          onUpload(data.url);
          setEditing(true);
        } else {
          toast({ title: "Upload failed", variant: "destructive" });
        }
      }
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  if (editing && displayUrl) {
    return (
      <div className="space-y-2">
        <Label className="text-sm font-medium">{label}</Label>
        <LogoEditor
          imageUrl={displayUrl}
          onSave={(newUrl) => {
            onUpload(newUrl);
            setEditing(false);
          }}
          onAutoFixed={(newUrl) => {
            onUpload(newUrl);
          }}
          onCancel={() => setEditing(false)}
          onError={(msg) => toast({ title: msg, variant: "destructive" })}
          testId={testId}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <div
        className={`relative border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
        } ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
        }`}
        onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        onClick={() => { if (!disabled) inputRef.current?.click(); }}
        data-testid={testId}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        {uploading ? (
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
        ) : displayUrl ? (
          <div className="flex flex-col items-center gap-3">
            <div
              className="rounded-lg p-1"
              style={{ backgroundImage: darkPreview ? CHECKER_BG_DARK : CHECKER_BG, backgroundSize: "16px 16px" }}
            >
              <img
                src={displayUrl}
                alt={label}
                className="max-h-16 max-w-[200px] object-contain"
                data-testid={`${testId}-preview`}
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Click or drag to replace</span>
              <button
                type="button"
                className="text-xs text-primary hover:text-primary/80 font-medium flex items-center gap-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                data-testid={`${testId}-edit-btn`}
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload className="w-8 h-8 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Drag & drop or click to upload
            </span>
            <span className="text-xs text-muted-foreground">SVG, PNG, JPG (max 16MB)</span>
          </div>
        )}
      </div>
      {!disabled && (
        <label
          className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={makeTransparent}
            onChange={(e) => setMakeTransparent(e.target.checked)}
            className="rounded border-border"
            data-testid={`${testId}-make-transparent`}
          />
          Remove background on upload
        </label>
      )}
    </div>
  );
}

function ColorInput({
  label,
  value,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <div className="relative">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-10 h-10 rounded-lg border border-border cursor-pointer p-0.5"
            disabled={disabled}
            data-testid={`${testId}-picker`}
          />
        </div>
        <Input
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v);
          }}
          className="w-28 font-mono text-sm uppercase"
          maxLength={7}
          disabled={disabled}
          data-testid={`${testId}-input`}
        />
        <div
          className="w-10 h-10 rounded-lg border border-border shrink-0"
          style={{ backgroundColor: value }}
        />
      </div>
    </div>
  );
}

function OptionalColorInput({
  label,
  value,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  value: string | null;
  onChange: (val: string | null) => void;
  testId: string;
  disabled?: boolean;
}) {
  const displayValue = value || "";
  const isSet = !!value && /^#[0-9a-fA-F]{6}$/.test(value);

  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <input
            type="color"
            value={isSet ? value! : "#888888"}
            onChange={(e) => onChange(e.target.value)}
            className={`w-8 h-8 rounded-md border border-border cursor-pointer p-0.5 ${!isSet ? "opacity-40" : ""}`}
            disabled={disabled}
            data-testid={`${testId}-picker`}
          />
        </div>
        <Input
          value={displayValue}
          onChange={(e) => {
            let v = e.target.value.trim();
            if (v === "") {
              onChange(null);
              return;
            }
            if (!v.startsWith("#")) {
              v = "#" + v;
            }
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
              onChange(v);
            }
          }}
          placeholder="Default"
          className="w-24 font-mono text-xs uppercase h-8"
          maxLength={7}
          disabled={disabled}
          data-testid={`${testId}-input`}
        />
        {isSet && !disabled && (
          <button
            type="button"
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={() => onChange(null)}
            title="Reset to default"
            data-testid={`${testId}-clear`}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface BrandTemplate {
  id: string;
  name: string;
  config: BrandSettings;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function TemplateManager({
  form,
  onLoadTemplate,
  onSelectedChange,
}: {
  form: BrandSettings;
  onLoadTemplate: (config: BrandSettings) => void;
  onSelectedChange?: (id: string) => void;
}) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [showNameInput, setShowNameInput] = useState(false);
  const [showRenameInput, setShowRenameInput] = useState(false);
  const [renameName, setRenameName] = useState("");

  const templatesQuery = useQuery<BrandTemplate[]>({
    queryKey: ["/api/brand/templates"],
    queryFn: async () => {
      const res = await fetch("/api/brand/templates", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const templates = templatesQuery.data || [];
  const selected = templates.find((t) => t.id === selectedId);

  const updateSelectedId = useCallback((id: string) => {
    setSelectedId(id);
    onSelectedChange?.(id);
  }, [onSelectedChange]);

  useEffect(() => {
    if (templates.length > 0 && !selectedId) {
      const active = templates.find((t) => t.isActive);
      if (active) {
        updateSelectedId(active.id);
      } else {
        const mostRecent = [...templates].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )[0];
        if (mostRecent) updateSelectedId(mostRecent.id);
      }
    }
  }, [templates, selectedId, updateSelectedId]);

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const { id, ...config } = form;
      const res = await apiRequest("POST", "/api/brand/templates", { name, config });
      return res.json();
    },
    onSuccess: (data: BrandTemplate) => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/templates"] });
      setSelectedId(data.id);
      setNewName("");
      setShowNameInput(false);
      toast({ title: `Template "${data.name}" saved`, variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to create template", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) return;
      const { id, ...config } = form;
      const res = await apiRequest("PUT", `/api/brand/templates/${selectedId}`, { config });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/templates"] });
      toast({ title: "Template updated", variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to update template", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) return;
      await apiRequest("DELETE", `/api/brand/templates/${selectedId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/templates"] });
      setSelectedId("");
      toast({ title: "Template deleted", variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to delete template", variant: "destructive" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!selectedId) return;
      const res = await apiRequest("PUT", `/api/brand/templates/${selectedId}`, { name });
      return res.json();
    },
    onSuccess: (data: BrandTemplate) => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/templates"] });
      setShowRenameInput(false);
      setRenameName("");
      toast({ title: `Template renamed to "${data.name}"`, variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to rename template", variant: "destructive" });
    },
  });

  const anyPending = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending || renameMutation.isPending;

  return (
    <Card className="rounded-2xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <LayoutTemplate className="w-5 h-5 text-primary" />
        <h2 className="font-display text-lg font-semibold">Brand Templates</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Save, preview, and switch between brand configurations. Selecting a template previews it — "Save Changes" applies it live and updates the template.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Label className="text-sm font-medium mb-1.5 block">Template</Label>
          <Select
            value={selectedId}
            onValueChange={(val) => {
              updateSelectedId(val);
              const tpl = templates.find((t) => t.id === val);
              if (tpl) {
                onLoadTemplate(tpl.config);
              }
            }}
          >
            <SelectTrigger data-testid="select-template">
              <SelectValue placeholder="Select a template…" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id} data-testid={`template-option-${t.id}`}>
                  <span className="flex items-center gap-2">
                    {t.name}
                    {t.isActive && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Active</Badge>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setShowNameInput(true)}
          disabled={anyPending}
          data-testid="button-save-new-template"
        >
          <Plus className="w-3.5 h-3.5" />
          Save as New
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => updateMutation.mutate()}
          disabled={!selectedId || anyPending}
          data-testid="button-update-template"
        >
          {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Update
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            setShowRenameInput(true);
            setRenameName(selected?.name || "");
          }}
          disabled={!selectedId || anyPending}
          data-testid="button-rename-template"
        >
          <Pencil className="w-3.5 h-3.5" />
          Rename
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
          onClick={() => {
            if (confirm(`Delete template "${selected?.name}"?`)) {
              deleteMutation.mutate();
            }
          }}
          disabled={!selectedId || !!selected?.isActive || anyPending}
          data-testid="button-delete-template"
        >
          {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          Delete
        </Button>

      </div>

      {showRenameInput && (
        <div className="flex items-end gap-2">
          <div className="flex-1 max-w-xs">
            <Label className="text-sm font-medium mb-1.5 block">Rename Template</Label>
            <Input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder="New template name"
              data-testid="input-rename-template"
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameName.trim()) renameMutation.mutate(renameName.trim());
                if (e.key === "Escape") setShowRenameInput(false);
              }}
            />
          </div>
          <Button
            size="sm"
            onClick={() => renameMutation.mutate(renameName.trim())}
            disabled={!renameName.trim() || renameMutation.isPending}
            data-testid="button-confirm-rename-template"
          >
            {renameMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRenameInput(false)}
            data-testid="button-cancel-rename-template"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {showNameInput && (
        <div className="flex items-end gap-2">
          <div className="flex-1 max-w-xs">
            <Label className="text-sm font-medium mb-1.5 block">Template Name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Dark Mode, Hinge Style…"
              data-testid="input-template-name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) createMutation.mutate(newName.trim());
              }}
            />
          </div>
          <Button
            size="sm"
            onClick={() => createMutation.mutate(newName.trim())}
            disabled={!newName.trim() || createMutation.isPending}
            data-testid="button-confirm-save-template"
          >
            {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setShowNameInput(false); setNewName(""); }}
            data-testid="button-cancel-save-template"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
    </Card>
  );
}

const NAV_PREVIEW_TABS: Array<{ icon: any; label: string }> = [
  { icon: EggDonorIcon, label: "Donors" },
  { icon: SurrogateIcon, label: "Surrogates" },
  { icon: IvfClinicIcon, label: "IVF" },
  { icon: SpermIcon, label: "Sperm" },
  { icon: MessageCircle, label: "Chat" },
  { icon: CalendarDays, label: "Meetings" },
  { icon: User, label: "Profile" },
];

function NavPreview({ form }: { form: BrandSettings }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const isIconOnly = (form.bottomNavStyle || "icon-label") === "icon-only";
  const activeColor = form.bottomNavActiveFgColor || form.primaryColor;
  const inactiveColor = form.bottomNavFgColor || form.primaryColor;

  return (
    <div className="pt-2">
      <Label className="text-xs text-muted-foreground mb-2 block">Preview</Label>
      <div
        className="relative overflow-hidden rounded-lg border"
        style={{
          background: 'repeating-conic-gradient(hsl(var(--muted)) 0% 25%, hsl(var(--background)) 0% 50%) 50% / 16px 16px',
        }}
      >
        <div
          className="absolute inset-x-0 top-0 h-1/2"
          style={{ background: 'linear-gradient(to bottom, hsl(var(--primary) / 0.15), transparent)' }}
        />
        <div
          className="px-3 py-3"
          style={{ backgroundColor: form.bottomNavSafeAreaColor || 'transparent' }}
        >
        <div
          className="overflow-hidden transition-all duration-300"
          style={{
            backgroundColor: form.bottomNavBgColor
              ? `color-mix(in srgb, ${form.bottomNavBgColor} ${form.bottomNavOpacity ?? 100}%, transparent)`
              : `color-mix(in srgb, hsl(var(--card)) ${form.bottomNavOpacity ?? 100}%, transparent)`,
            borderRadius: `${form.bottomNavRadius}rem`,
            backdropFilter: (() => {
              const blur = form.bottomNavBlur;
              if (!blur || blur === 'none') return 'none';
              const map: Record<string, string> = { sm: '4px', DEFAULT: '8px', md: '12px', lg: '16px', xl: '24px', '2xl': '40px', '3xl': '64px' };
              return `blur(${map[blur] || '16px'})`;
            })(),
            WebkitBackdropFilter: (() => {
              const blur = form.bottomNavBlur;
              if (!blur || blur === 'none') return 'none';
              const map: Record<string, string> = { sm: '4px', DEFAULT: '8px', md: '12px', lg: '16px', xl: '24px', '2xl': '40px', '3xl': '64px' };
              return `blur(${map[blur] || '16px'})`;
            })(),
            boxShadow: (() => {
              const s = form.bottomNavShadow;
              if (!s || s === 'none') return 'none';
              const map: Record<string, string> = {
                'shadow-sm': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
                'shadow': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
                'shadow-md': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
                'shadow-lg': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
                'shadow-xl': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
              };
              return map[s] || 'none';
            })(),
          }}
          data-testid="preview-bottom-nav"
        >
        <div className="flex items-stretch justify-around h-[68px] px-2">
          {NAV_PREVIEW_TABS.map((tab, idx) => {
            const isActive = idx === activeIdx;
            const color = isActive ? activeColor : inactiveColor;
            const iconSize = isIconOnly ? "w-7 h-7" : "w-5 h-5";
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.label}
                type="button"
                onClick={() => setActiveIdx(idx)}
                className="flex flex-col items-center justify-center flex-1 gap-0.5 transition-colors duration-200 cursor-pointer bg-transparent border-0 outline-none"
                style={{ color }}
                data-testid={`preview-nav-${tab.label.toLowerCase()}`}
              >
                <div className={`p-1 rounded-lg transition-colors duration-200 ${isActive && !form.bottomNavActiveFgColor ? 'bg-primary/10' : ''}`}>
                  <TabIcon className={iconSize} />
                </div>
                {!isIconOnly && <span className="text-[11px] font-medium">{tab.label}</span>}
              </button>
            );
          })}
        </div>
      </div>
      </div>
      </div>
    </div>
  );
}

const TAB_PREVIEW_TABS: Array<{ icon: any; label: string }> = [
  { icon: User, label: "My Account" },
  { icon: Building2, label: "Company" },
  { icon: Users, label: "Team" },
  { icon: CalendarDays, label: "Calendar" },
  { icon: Palette, label: "Branding" },
];

function TabPreview({ form }: { form: BrandSettings }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const activeColor = form.tabActiveColor || form.primaryColor;
  const inactiveColor = form.tabColor || form.primaryColor;
  const hoverColor = form.tabHoverColor || form.primaryColor;

  return (
    <div className="pt-2">
      <Label className="text-xs text-muted-foreground mb-2 block">Preview</Label>
      <div className="border rounded-lg overflow-hidden bg-card" data-testid="preview-tab-nav">
        <div className="border-b border-border/40">
          <nav className="flex">
            {TAB_PREVIEW_TABS.map((tab, idx) => {
              const isActive = idx === activeIdx;
              const TabIcon = tab.icon;
              return (
                <button
                  key={tab.label}
                  type="button"
                  onClick={() => setActiveIdx(idx)}
                  className="flex items-center justify-center gap-1.5 flex-1 whitespace-nowrap py-2.5 px-2 text-xs font-ui border-b-2 transition-colors duration-200 cursor-pointer bg-transparent outline-none"
                  style={{
                    color: isActive ? activeColor : inactiveColor,
                    borderBottomColor: isActive ? activeColor : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = hoverColor;
                      e.currentTarget.style.borderBottomColor = `color-mix(in srgb, ${hoverColor} 30%, transparent)`;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = inactiveColor;
                      e.currentTarget.style.borderBottomColor = 'transparent';
                    }
                  }}
                  data-testid={`preview-tab-${tab.label.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <TabIcon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <div className="h-10 flex items-center justify-center text-xs text-muted-foreground">
          {TAB_PREVIEW_TABS[activeIdx].label} content
        </div>
      </div>
    </div>
  );
}

function HeaderNavPreview({ form, previewMode, setPreviewMode }: { form: BrandSettings; previewMode: "light" | "dark"; setPreviewMode: (m: "light" | "dark") => void }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const navItems = ["Dashboard", "Marketplace", "Meetings"];
  const activeColor = form.tabActiveColor || form.primaryColor;
  const inactiveColor = form.tabColor || form.primaryColor;
  const hoverColor = form.tabHoverColor || form.secondaryColor;
  const isPill = (form.headerNavStyle || "pill") === "pill";

  const getNavStyle = (idx: number): CSSProperties => {
    const isActive = idx === activeIdx;
    const isHovered = idx === hoveredIdx;
    const base: CSSProperties = { fontFamily: `'${form.bodyFont}', sans-serif` };

    if (isPill) {
      if (isActive) {
        return { ...base, backgroundColor: activeColor, color: form.primaryForegroundColor || '#FFFFFF', borderRadius: '9999px' };
      }
      if (isHovered) {
        return { ...base, backgroundColor: hoverColor, color: form.secondaryForegroundColor || '#0A0A0A', borderRadius: '9999px' };
      }
      return { ...base, color: previewMode === "dark" ? '#aaa' : inactiveColor };
    }

    if (isActive) {
      return { ...base, color: activeColor, borderBottom: `2px solid ${activeColor}`, borderRadius: 0 };
    }
    if (isHovered) {
      return { ...base, color: hoverColor, borderBottom: `2px solid ${hoverColor}`, borderRadius: 0 };
    }
    return { ...base, color: previewMode === "dark" ? '#aaa' : inactiveColor, borderBottom: '2px solid transparent', borderRadius: 0 };
  };

  return (
    <div className="pt-2">
      <div className="flex items-center gap-2 mb-2">
        <Eye className="w-4 h-4 text-muted-foreground" />
        <Label className="text-xs text-muted-foreground">Header Preview</Label>
        <div className="flex items-center ml-auto gap-1 bg-secondary rounded-lg p-0.5">
          <button
            className={`px-3 py-1 rounded-md text-xs font-medium transition ${
              previewMode === "light" ? "bg-card shadow-sm" : "text-muted-foreground"
            }`}
            onClick={() => setPreviewMode("light")}
            data-testid="button-preview-light"
          >
            <Sun className="w-3 h-3 inline mr-1" />
            Light
          </button>
          <button
            className={`px-3 py-1 rounded-md text-xs font-medium transition ${
              previewMode === "dark" ? "bg-card shadow-sm" : "text-muted-foreground"
            }`}
            onClick={() => setPreviewMode("dark")}
            data-testid="button-preview-dark"
          >
            <Moon className="w-3 h-3 inline mr-1" />
            Dark
          </button>
        </div>
      </div>
      <div
        className={`rounded-xl border border-border/40 p-4 flex items-center gap-3 ${
          previewMode === "dark" ? "bg-foreground" : "bg-card"
        }`}
        data-testid="brand-header-preview"
      >
        {(previewMode === "dark" ? (form.darkLogoWithNameUrl || form.logoWithNameUrl) : form.logoWithNameUrl) ? (
          <img
            src={previewMode === "dark" ? (form.darkLogoWithNameUrl || form.logoWithNameUrl!) : form.logoWithNameUrl!}
            alt="Logo with name preview"
            className="h-9 max-w-[200px] object-contain"
            data-testid="preview-logo-with-name"
          />
        ) : (previewMode === "dark" && form.darkLogoUrl) || form.logoUrl ? (
          <div className="flex items-center gap-2.5">
            <img
              src={(previewMode === "dark" && form.darkLogoUrl) ? form.darkLogoUrl : (form.logoUrl || "")}
              alt="Logo preview"
              className="h-9 max-w-[140px] object-contain"
            />
            <h1
              className="font-bold text-lg leading-none"
              style={{
                fontFamily: `'${form.headingFont}', serif`,
                color: previewMode === "dark" ? "white" : form.primaryColor,
              }}
            >
              {form.companyName || "GoStork"}
            </h1>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white shadow-md"
              style={{ backgroundColor: form.primaryColor }}
            >
              <Baby className="w-5 h-5" />
            </div>
            <h1
              className="font-bold text-lg leading-none"
              style={{
                fontFamily: `'${form.headingFont}', serif`,
                color: previewMode === "dark" ? "white" : form.primaryColor,
              }}
            >
              {form.companyName || "GoStork"}
            </h1>
          </div>
        )}
        <div className="flex-1" />
        <div className="hidden sm:flex gap-1">
          {navItems.map((item, idx) => (
            <button
              key={item}
              type="button"
              onClick={() => setActiveIdx(idx)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="text-sm px-3 py-1.5 font-medium transition-all duration-200 cursor-pointer bg-transparent border-0 outline-none"
              style={getNavStyle(idx)}
              data-testid={`preview-header-${item.toLowerCase()}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


export function BrandSettingsForm({
  getEndpoint,
  putEndpoint,
  resetEndpoint,
  enabled = true,
  headerSlot,
  disableLivePreview,
  overrideAction,
  showTemplates = false,
}: {
  getEndpoint: string;
  putEndpoint: string;
  resetEndpoint: string;
  enabled?: boolean;
  headerSlot?: ReactNode;
  disableLivePreview?: boolean;
  overrideAction?: { label: string; onOverride: () => Promise<void> };
  showTemplates?: boolean;
}) {
  const { toast } = useToast();

  const settingsQuery = useQuery<BrandSettings>({
    queryKey: [getEndpoint],
    queryFn: async () => {
      const res = await fetch(getEndpoint, { credentials: "include" });
      if (!res.ok) return BRAND_DEFAULTS;
      return res.json();
    },
  });

  const [form, setForm] = useState<BrandSettings>(BRAND_DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [previewMode, setPreviewMode] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(settingsQuery.data);
    }
  }, [settingsQuery.data]);

  const updateField = useCallback(<K extends keyof BrandSettings>(key: K, value: BrandSettings[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      setDirty(true);
      if (!disableLivePreview) {
        applyBrandPreview(next);
      }
      return next;
    });
  }, [disableLivePreview]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (selectedTemplateId) {
        const { id, ...config } = form;
        await apiRequest("PUT", `/api/brand/templates/${selectedTemplateId}`, { config });
        await apiRequest("POST", `/api/brand/templates/${selectedTemplateId}/activate`);
      }
      const res = await apiRequest("PUT", putEndpoint, form);
      return res.json();
    },
    onSuccess: () => {
      applyBrandToDocument(form);
      queryClient.invalidateQueries({ queryKey: [getEndpoint] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/templates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/global"] });
      setDirty(false);
      toast({ title: "Brand settings saved", variant: "success" });
    },
    onError: () => {
      toast({ title: "Failed to save settings", variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", resetEndpoint);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [getEndpoint] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setForm({ ...BRAND_DEFAULTS, ...data });
      setDirty(false);
      if (!disableLivePreview) {
        applyBrandPreview(BRAND_DEFAULTS);
      }
      toast({ title: "Brand settings reset to defaults", variant: "success" });
    },
  });

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const whiteContrast = contrastRatio(form.primaryColor, "#FFFFFF");
  const blackContrast = contrastRatio(form.primaryColor, "#000000");
  const whiteWcag = wcagLevel(whiteContrast);
  const blackWcag = wcagLevel(blackContrast);
  const WhiteIcon = whiteWcag.icon;
  const BlackIcon = blackWcag.icon;

  const formDisabled = !enabled;

  return (
    <div className="space-y-6">
      {headerSlot}

      {showTemplates && (
        <TemplateManager
          form={form}
          onSelectedChange={setSelectedTemplateId}
          onLoadTemplate={(config) => {
            const merged = { ...BRAND_DEFAULTS, ...config };
            setForm(merged);
            setDirty(false);
            if (!disableLivePreview) {
              applyBrandPreview(merged);
            }
          }}
        />
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-sm text-muted-foreground" data-testid="text-brand-title">
          Manage your platform's visual identity — logo, colors, and typography.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            className="flex-1 sm:flex-none"
            onClick={() => {
              if (confirm("Reset all brand settings to defaults?")) {
                resetMutation.mutate();
              }
            }}
            disabled={formDisabled || resetMutation.isPending}
            data-testid="button-reset-brand"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset
          </Button>
          <Button
            className="flex-1 sm:flex-none"
            onClick={() => saveMutation.mutate()}
            disabled={formDisabled || !dirty || saveMutation.isPending}
            data-testid="button-save-brand"
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Save Changes
          </Button>
        </div>
      </div>

      <div className={`grid grid-cols-1 lg:grid-cols-3 gap-6 ${formDisabled ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="lg:col-span-2 space-y-6">
          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold">Identity</h2>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Company Name</Label>
              <Input
                placeholder="e.g. GoStork"
                value={form.companyName || ""}
                onChange={(e) => updateField("companyName", e.target.value || null)}
                disabled={formDisabled}
                data-testid="input-company-name"
              />
              <p className="text-xs text-muted-foreground">
                This name appears in the navigation header and throughout the platform
              </p>
            </div>
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Image className="w-5 h-5 text-primary" />
                <h2 className="font-display text-lg font-semibold">Logo & Assets</h2>
              </div>
              {overrideAction && enabled && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-primary underline"
                  data-testid="button-override-logos"
                  onClick={async () => {
                    await overrideAction.onOverride();
                    settingsQuery.refetch();
                  }}
                >
                  {overrideAction.label}
                </button>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">Logo with Name</Label>
              <p className="text-xs text-muted-foreground">
                Your primary logo — displayed in the navigation header on desktop. This is typically the full logo including your company name.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FileDropZone
                  label="Light Mode"
                  currentUrl={form.logoWithNameUrl}
                  onUpload={(url) => updateField("logoWithNameUrl", url)}
                  accept="image/svg+xml,image/png,image/jpeg,image/webp"
                  testId="upload-logo-with-name"
                  disabled={formDisabled}
                />
                <FileDropZone
                  label="Dark Mode"
                  currentUrl={form.darkLogoWithNameUrl}
                  onUpload={(url) => updateField("darkLogoWithNameUrl", url)}
                  accept="image/svg+xml,image/png,image/jpeg,image/webp"
                  testId="upload-dark-logo-with-name"
                  disabled={formDisabled}
                  darkPreview
                />
              </div>
            </div>

            {!form.logoWithNameUrl && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FileDropZone
                  label="Light Mode Logo"
                  currentUrl={form.logoUrl}
                  onUpload={(url) => updateField("logoUrl", url)}
                  accept="image/svg+xml,image/png,image/jpeg,image/webp"
                  testId="upload-primary-logo"
                  disabled={formDisabled}
                />
                <FileDropZone
                  label="Dark Mode Logo"
                  currentUrl={form.darkLogoUrl}
                  onUpload={(url) => updateField("darkLogoUrl", url)}
                  accept="image/svg+xml,image/png,image/jpeg,image/webp"
                  testId="upload-dark-logo"
                  disabled={formDisabled}
                  darkPreview
                />
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-sm font-medium">Icon-Only Logo (mobile fallback)</Label>
              <p className="text-xs text-muted-foreground">
                A compact icon version of your logo, used on mobile and tight spaces where the full logo doesn't fit.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FileDropZone
                  label="Icon Logo"
                  currentUrl={form.logoUrl}
                  onUpload={(url) => updateField("logoUrl", url)}
                  accept="image/svg+xml,image/png,image/jpeg,image/webp"
                  testId="upload-icon-logo"
                  disabled={formDisabled}
                />
                <FileDropZone
                  label="Favicon"
                  currentUrl={form.faviconUrl}
                  onUpload={(url) => updateField("faviconUrl", url)}
                  accept="image/svg+xml,image/png,image/x-icon,image/vnd.microsoft.icon"
                  testId="upload-favicon"
                  disabled={formDisabled}
                />
              </div>
            </div>

          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Palette className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold">Color System</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
              <ColorInput label="Primary" value={form.primaryColor} onChange={(v) => updateField("primaryColor", v)} testId="color-primary" disabled={formDisabled} />
              <ColorInput label="Secondary" value={form.secondaryColor} onChange={(v) => updateField("secondaryColor", v)} testId="color-secondary" disabled={formDisabled} />
              <ColorInput label="Accent" value={form.accentColor} onChange={(v) => updateField("accentColor", v)} testId="color-accent" disabled={formDisabled} />
              <ColorInput label="Success" value={form.successColor} onChange={(v) => updateField("successColor", v)} testId="color-success" disabled={formDisabled} />
              <ColorInput label="Warning" value={form.warningColor} onChange={(v) => updateField("warningColor", v)} testId="color-warning" disabled={formDisabled} />
              <ColorInput label="Error" value={form.errorColor} onChange={(v) => updateField("errorColor", v)} testId="color-error" disabled={formDisabled} />
            </div>

            <div className="border-t border-border/30 pt-4 space-y-3">
              <Label className="text-sm font-medium">WCAG Contrast — Primary Color</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-secondary/30">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-lg text-white shrink-0"
                    style={{ backgroundColor: form.primaryColor }}
                  >
                    Aa
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <WhiteIcon className={`w-4 h-4 ${whiteWcag.color}`} />
                      <span className={`text-sm font-semibold ${whiteWcag.color}`}>{whiteWcag.level}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">White text — {whiteContrast.toFixed(1)}:1</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-secondary/30">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-lg text-foreground shrink-0"
                    style={{ backgroundColor: form.primaryColor }}
                  >
                    Aa
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <BlackIcon className={`w-4 h-4 ${blackWcag.color}`} />
                      <span className={`text-sm font-semibold ${blackWcag.color}`}>{blackWcag.level}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">Black text — {blackContrast.toFixed(1)}:1</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold" data-testid="heading-chat-palette">Chat Participant Palette</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              These tints are automatically derived from your primary brand color and used in 3-way chat conversations.
            </p>
            {(() => {
              const palette = deriveChatPalette(form.primaryColor);
              return (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-secondary/30" data-testid="palette-ai">
                    <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: `${form.primaryColor}14`, border: `1px solid ${form.primaryColor}33` }}>
                      AI
                    </div>
                    <div>
                      <div className="text-sm font-semibold">AI Concierge</div>
                      <span className="text-[10px] text-muted-foreground">Primary · 8% tint</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-secondary/30" data-testid="palette-partner">
                    <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: palette.partnerBg, border: `1px solid ${palette.partnerBorder}` }}>
                      P
                    </div>
                    <div>
                      <div className="text-sm font-semibold">Partners</div>
                      <span className="text-[10px] text-muted-foreground">Hue +30° · 8% tint</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-secondary/30" data-testid="palette-expert">
                    <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: palette.expertBg, border: `1px solid ${palette.expertBorder}` }}>
                      E
                    </div>
                    <div>
                      <div className="text-sm font-semibold">Experts</div>
                      <span className="text-[10px] text-muted-foreground">Hue -30° · 8% tint</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Palette className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold" data-testid="heading-marketplace-action-colors">Marketplace Action Colors</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              These vibrant colors are used exclusively for the high-energy swipe actions in the marketplace to ensure clear visual feedback.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-6 gap-y-4">
              <OptionalColorInput label="Pass" value={form.swipePassColor} onChange={(v) => updateField("swipePassColor", v)} testId="color-swipe-pass" disabled={formDisabled} />
              <OptionalColorInput label="Save" value={form.swipeSaveColor} onChange={(v) => updateField("swipeSaveColor", v)} testId="color-swipe-save" disabled={formDisabled} />
              <OptionalColorInput label="Undo" value={form.swipeUndoColor} onChange={(v) => updateField("swipeUndoColor", v)} testId="color-swipe-undo" disabled={formDisabled} />
              <OptionalColorInput label="Chat" value={form.swipeChatColor} onChange={(v) => updateField("swipeChatColor", v)} testId="color-swipe-chat" disabled={formDisabled} />
              <OptionalColorInput label="Compare" value={form.swipeCompareColor} onChange={(v) => updateField("swipeCompareColor", v)} testId="color-swipe-compare" disabled={formDisabled} />
            </div>
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Type className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold" data-testid="heading-marketplace-sizing">Marketplace Sizing</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Control font sizes and layout dimensions on marketplace cards, filter labels, badges, and the filter drawer.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Card Title</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-card-title-size">{form.cardTitleSize ?? 24}px</span>
                </div>
                <Slider min={16} max={40} step={1} value={[form.cardTitleSize ?? 24]} onValueChange={([v]) => updateField("cardTitleSize", v)} disabled={formDisabled} data-testid="slider-card-title-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Card Overlay Text</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-card-overlay-size">{form.cardOverlaySize ?? 16}px</span>
                </div>
                <Slider min={12} max={28} step={1} value={[form.cardOverlaySize ?? 16]} onValueChange={([v]) => updateField("cardOverlaySize", v)} disabled={formDisabled} data-testid="slider-card-overlay-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Filter Labels</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-filter-label-size">{form.filterLabelSize ?? 18}px</span>
                </div>
                <Slider min={12} max={28} step={1} value={[form.filterLabelSize ?? 18]} onValueChange={([v]) => updateField("filterLabelSize", v)} disabled={formDisabled} data-testid="slider-filter-label-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Badge Text</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-badge-text-size">{form.badgeTextSize ?? 13}px</span>
                </div>
                <Slider min={10} max={22} step={1} value={[form.badgeTextSize ?? 13]} onValueChange={([v]) => updateField("badgeTextSize", v)} disabled={formDisabled} data-testid="slider-badge-text-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Drawer Min Height</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-drawer-min-height">{form.drawerMinHeight ?? 50}%</span>
                </div>
                <Slider min={30} max={80} step={5} value={[form.drawerMinHeight ?? 50]} onValueChange={([v]) => updateField("drawerMinHeight", v)} disabled={formDisabled} data-testid="slider-drawer-min-height" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Drawer Title</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-drawer-title-size">{form.drawerTitleSize ?? 24}px</span>
                </div>
                <Slider min={16} max={40} step={1} value={[form.drawerTitleSize ?? 24]} onValueChange={([v]) => updateField("drawerTitleSize", v)} disabled={formDisabled} data-testid="slider-drawer-title-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Drawer Body Text</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-drawer-body-size">{form.drawerBodySize ?? 16}px</span>
                </div>
                <Slider min={12} max={24} step={1} value={[form.drawerBodySize ?? 16]} onValueChange={([v]) => updateField("drawerBodySize", v)} disabled={formDisabled} data-testid="slider-drawer-body-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Drawer Handle Width</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-drawer-handle-width">{form.drawerHandleWidth ?? 60}px</span>
                </div>
                <Slider min={30} max={120} step={5} value={[form.drawerHandleWidth ?? 60]} onValueChange={([v]) => updateField("drawerHandleWidth", v)} disabled={formDisabled} data-testid="slider-drawer-handle-width" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Slider Value Text</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-slider-value-size">{form.sliderValueSize ?? 22}px</span>
                </div>
                <Slider min={14} max={36} step={1} value={[form.sliderValueSize ?? 22]} onValueChange={([v]) => updateField("sliderValueSize", v)} disabled={formDisabled} data-testid="slider-slider-value-size" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Slider Thumb Size</Label>
                  <span className="text-sm text-muted-foreground" data-testid="text-slider-thumb-size">{form.sliderThumbSize ?? 24}px</span>
                </div>
                <Slider min={16} max={40} step={1} value={[form.sliderThumbSize ?? 24]} onValueChange={([v]) => updateField("sliderThumbSize", v)} disabled={formDisabled} data-testid="slider-slider-thumb-size" />
              </div>
            </div>
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold" data-testid="heading-advanced-colors">Advanced Theme Colors</h2>
            </div>

            <p className="text-xs text-muted-foreground">
              Fine-tune individual UI color tokens. Leave empty to use default values derived from your primary theme colors.
            </p>

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-muted-foreground" />
                    <Label className="text-sm font-medium">Surfaces</Label>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
                    <OptionalColorInput label="Background" value={form.backgroundColor} onChange={(v) => updateField("backgroundColor", v)} testId="color-background" disabled={formDisabled} />
                    <OptionalColorInput label="Card" value={form.cardColor} onChange={(v) => updateField("cardColor", v)} testId="color-card" disabled={formDisabled} />
                    <OptionalColorInput label="Muted" value={form.mutedColor} onChange={(v) => updateField("mutedColor", v)} testId="color-muted" disabled={formDisabled} />
                    <OptionalColorInput label="Popover" value={form.popoverColor} onChange={(v) => updateField("popoverColor", v)} testId="color-popover" disabled={formDisabled} />
                    <OptionalColorInput label="Input" value={form.inputColor} onChange={(v) => updateField("inputColor", v)} testId="color-input" disabled={formDisabled} />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <TypeIcon className="w-4 h-4 text-muted-foreground" />
                    <Label className="text-sm font-medium">Text / Foregrounds</Label>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-3">
                    <OptionalColorInput label="Foreground" value={form.foregroundColor} onChange={(v) => updateField("foregroundColor", v)} testId="color-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Card Foreground" value={form.cardForegroundColor} onChange={(v) => updateField("cardForegroundColor", v)} testId="color-card-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Muted Foreground" value={form.mutedForegroundColor} onChange={(v) => updateField("mutedForegroundColor", v)} testId="color-muted-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Popover Foreground" value={form.popoverForegroundColor} onChange={(v) => updateField("popoverForegroundColor", v)} testId="color-popover-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Primary Foreground" value={form.primaryForegroundColor} onChange={(v) => updateField("primaryForegroundColor", v)} testId="color-primary-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Secondary Foreground" value={form.secondaryForegroundColor} onChange={(v) => updateField("secondaryForegroundColor", v)} testId="color-secondary-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Accent Foreground" value={form.accentForegroundColor} onChange={(v) => updateField("accentForegroundColor", v)} testId="color-accent-foreground" disabled={formDisabled} />
                    <OptionalColorInput label="Destructive Foreground" value={form.destructiveForegroundColor} onChange={(v) => updateField("destructiveForegroundColor", v)} testId="color-destructive-foreground" disabled={formDisabled} />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Frame className="w-4 h-4 text-muted-foreground" />
                    <Label className="text-sm font-medium">Borders</Label>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                    <OptionalColorInput label="Border" value={form.borderColor} onChange={(v) => updateField("borderColor", v)} testId="color-border" disabled={formDisabled} />
                    <OptionalColorInput label="Ring" value={form.ringColor} onChange={(v) => updateField("ringColor", v)} testId="color-ring" disabled={formDisabled} />
                  </div>
                </div>
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Type className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold">Typography</h2>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Font Families</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Heading Font</Label>
                  <Select value={form.headingFont} onValueChange={(v) => updateField("headingFont", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-heading-font">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GOOGLE_FONTS.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Body Font</Label>
                  <Select value={form.bodyFont} onValueChange={(v) => updateField("bodyFont", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-body-font">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GOOGLE_FONTS.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Size & Scale</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Base Font Size (px)</Label>
                  <Input
                    type="number"
                    min={10}
                    max={24}
                    value={form.baseFontSize}
                    onChange={(e) => updateField("baseFontSize", Number(e.target.value))}
                    disabled={formDisabled}
                    data-testid="input-base-font-size"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Small Text Size (px)</Label>
                  <Input
                    type="number"
                    min={10}
                    max={16}
                    value={form.smallTextSize}
                    onChange={(e) => updateField("smallTextSize", Number(e.target.value))}
                    disabled={formDisabled}
                    data-testid="input-small-text-size"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Type Scale Ratio</Label>
                  <Select value={String(form.typeScaleRatio)} onValueChange={(v) => updateField("typeScaleRatio", Number(v))} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-type-scale-ratio">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1.125">1.125 — Minor Second</SelectItem>
                      <SelectItem value="1.2">1.200 — Minor Third</SelectItem>
                      <SelectItem value="1.25">1.250 — Major Third</SelectItem>
                      <SelectItem value="1.333">1.333 — Perfect Fourth</SelectItem>
                      <SelectItem value="1.5">1.500 — Perfect Fifth</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Font Weights</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Body Weight</Label>
                  <Select value={form.baseBodyWeight} onValueChange={(v) => updateField("baseBodyWeight", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-body-weight">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="300">300 — Light</SelectItem>
                      <SelectItem value="400">400 — Regular</SelectItem>
                      <SelectItem value="500">500 — Medium</SelectItem>
                      <SelectItem value="600">600 — Semibold</SelectItem>
                      <SelectItem value="700">700 — Bold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Heading Weight</Label>
                  <Select value={form.headingWeight} onValueChange={(v) => updateField("headingWeight", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-heading-weight">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="400">400 — Regular</SelectItem>
                      <SelectItem value="500">500 — Medium</SelectItem>
                      <SelectItem value="600">600 — Semibold</SelectItem>
                      <SelectItem value="700">700 — Bold</SelectItem>
                      <SelectItem value="800">800 — Extra Bold</SelectItem>
                      <SelectItem value="900">900 — Black</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">UI / Button Weight</Label>
                  <Select value={form.uiButtonWeight} onValueChange={(v) => updateField("uiButtonWeight", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-ui-weight">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="400">400 — Regular</SelectItem>
                      <SelectItem value="500">500 — Medium</SelectItem>
                      <SelectItem value="600">600 — Semibold</SelectItem>
                      <SelectItem value="700">700 — Bold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Line Heights</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Base Line Height</Label>
                  <Input
                    type="number"
                    min={1}
                    max={3}
                    step={0.1}
                    value={form.lineHeight}
                    onChange={(e) => updateField("lineHeight", Number(e.target.value))}
                    disabled={formDisabled}
                    data-testid="input-line-height"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Body Line Height</Label>
                  <Input
                    type="number"
                    min={1}
                    max={2.5}
                    step={0.1}
                    value={form.bodyLineHeight}
                    onChange={(e) => updateField("bodyLineHeight", Number(e.target.value))}
                    disabled={formDisabled}
                    data-testid="input-body-line-height"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Heading Line Height</Label>
                  <Input
                    type="number"
                    min={0.9}
                    max={2}
                    step={0.1}
                    value={form.headingLineHeight}
                    onChange={(e) => updateField("headingLineHeight", Number(e.target.value))}
                    disabled={formDisabled}
                    data-testid="input-heading-line-height"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Spacing & Style</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Letter Spacing</Label>
                  <Select value={form.letterSpacing} onValueChange={(v) => updateField("letterSpacing", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-letter-spacing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tight">Tight</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="wide">Wide</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Button Text Case</Label>
                  <Select value={form.buttonTextCase} onValueChange={(v) => updateField("buttonTextCase", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-button-text-case">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="uppercase">UPPERCASE</SelectItem>
                      <SelectItem value="capitalize">Capitalize</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Link Decoration</Label>
                  <Select value={form.linkDecoration} onValueChange={(v) => updateField("linkDecoration", v)} disabled={formDisabled}>
                    <SelectTrigger data-testid="select-link-decoration">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hover">Underline on hover</SelectItem>
                      <SelectItem value="always">Always underline</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="border-t border-border/30 pt-4 space-y-3">
              <Label className="text-sm font-medium">Typography Preview</Label>
              <div className="p-4 rounded-xl border border-border/40 bg-secondary/10 space-y-3">
                <h2
                  className="text-2xl"
                  style={{
                    fontFamily: `'${form.headingFont}', serif`,
                    fontWeight: Number(form.headingWeight),
                    lineHeight: form.headingLineHeight,
                    letterSpacing: form.letterSpacing === "tight" ? "-0.025em" : form.letterSpacing === "wide" ? "0.025em" : "0em",
                  }}
                  data-testid="text-heading-preview"
                >
                  The Quick Brown Fox Jumps Over the Lazy Dog
                </h2>
                <p
                  className="text-muted-foreground"
                  style={{
                    fontFamily: `'${form.bodyFont}', sans-serif`,
                    fontSize: `${form.baseFontSize}px`,
                    fontWeight: Number(form.baseBodyWeight),
                    lineHeight: form.bodyLineHeight,
                  }}
                  data-testid="text-body-preview"
                >
                  GoStork is the leading fertility marketplace that connects intended parents with world-class providers. Our platform streamlines the discovery process with tools for comparison, scheduling, and comprehensive provider profiles.
                </p>
                <div className="flex items-center gap-3 pt-2">
                  <button
                    className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm transition-opacity hover:opacity-90"
                    style={{
                      fontWeight: Number(form.uiButtonWeight),
                      textTransform: form.buttonTextCase === "uppercase" ? "uppercase" : form.buttonTextCase === "capitalize" ? "capitalize" : "none",
                    }}
                    data-testid="preview-typography-button"
                  >
                    Button Preview
                  </button>
                  <a
                    href="#"
                    className="text-sm text-primary"
                    style={{
                      textDecoration: form.linkDecoration === "always" ? "underline" : "none",
                    }}
                    onClick={(e) => e.preventDefault()}
                    data-testid="preview-typography-link"
                  >
                    Link Preview
                  </a>
                </div>
              </div>
            </div>
          </Card>

          <Card className="rounded-2xl p-6 space-y-6">
            <div className="flex items-center gap-2">
              <Frame className="w-5 h-5 text-primary" />
              <h2 className="font-display text-lg font-semibold">Shape & Radius</h2>
            </div>

            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Top Header Navigation</h3>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Nav Link Style</Label>
                  <div className="flex gap-2">
                    {[
                      { value: "pill", label: "Pill" },
                      { value: "underline", label: "Underline" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => updateField("headerNavStyle", opt.value)}
                        disabled={formDisabled}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border-2 transition-all duration-200 ${
                          (form.headerNavStyle || "pill") === opt.value
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                        data-testid={`btn-header-style-${opt.value}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Inactive Link Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.tabColor || form.primaryColor}
                      onChange={(e) => updateField("tabColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-header-tab-color"
                    />
                    <Input
                      value={form.tabColor || ""}
                      placeholder="Default (primary)"
                      onChange={(e) => updateField("tabColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-header-tab-color-hex"
                    />
                    {form.tabColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("tabColor", null)} data-testid="btn-clear-header-tab-color">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Hover Link Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.tabHoverColor || form.secondaryColor}
                      onChange={(e) => updateField("tabHoverColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-header-tab-hover-color"
                    />
                    <Input
                      value={form.tabHoverColor || ""}
                      placeholder="Default (secondary)"
                      onChange={(e) => updateField("tabHoverColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-header-tab-hover-color-hex"
                    />
                    {form.tabHoverColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("tabHoverColor", null)} data-testid="btn-clear-header-tab-hover-color">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Active Link Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.tabActiveColor || form.primaryColor}
                      onChange={(e) => updateField("tabActiveColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-header-tab-active-color"
                    />
                    <Input
                      value={form.tabActiveColor || ""}
                      placeholder="Default (primary)"
                      onChange={(e) => updateField("tabActiveColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-header-tab-active-color-hex"
                    />
                    {form.tabActiveColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("tabActiveColor", null)} data-testid="btn-clear-header-tab-active-color">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <HeaderNavPreview form={form} previewMode={previewMode} setPreviewMode={setPreviewMode} />
              </div>

              <div className="border-t pt-6 space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Action Shape (Buttons & Tags)</h3>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Preset</Label>
                  <Select
                    value={
                      form.borderRadius === 0 ? "0" :
                      form.borderRadius === 0.5 ? "0.5" :
                      form.borderRadius === 0.75 ? "0.75" :
                      form.borderRadius === 2 ? "2" :
                      "custom"
                    }
                    onValueChange={(v) => {
                      if (v !== "custom") updateField("borderRadius", parseFloat(v));
                    }}
                    disabled={formDisabled}
                  >
                    <SelectTrigger data-testid="select-radius-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sharp / Square</SelectItem>
                      <SelectItem value="0.5">Classic</SelectItem>
                      <SelectItem value="0.75">Soft</SelectItem>
                      <SelectItem value="2">Pill</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Radius</Label>
                    <span className="text-sm text-muted-foreground" data-testid="text-radius-value">{form.borderRadius}rem</span>
                  </div>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[form.borderRadius]}
                    onValueChange={([v]) => updateField("borderRadius", Math.round(v * 10) / 10)}
                    disabled={formDisabled}
                    data-testid="slider-border-radius"
                  />
                </div>
              </div>

              <div className="border-t pt-6 space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Container Shape (Cards & Inputs)</h3>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Preset</Label>
                  <Select
                    value={
                      form.containerRadius === 0 ? "0" :
                      form.containerRadius === 0.5 ? "0.5" :
                      form.containerRadius === 0.75 ? "0.75" :
                      form.containerRadius === 2 ? "2" :
                      "custom"
                    }
                    onValueChange={(v) => {
                      if (v !== "custom") updateField("containerRadius", parseFloat(v));
                    }}
                    disabled={formDisabled}
                  >
                    <SelectTrigger data-testid="select-container-radius-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sharp / Square</SelectItem>
                      <SelectItem value="0.5">Classic</SelectItem>
                      <SelectItem value="0.75">Soft</SelectItem>
                      <SelectItem value="2">Pill</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Radius</Label>
                    <span className="text-sm text-muted-foreground" data-testid="text-container-radius-value">{form.containerRadius}rem</span>
                  </div>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[form.containerRadius]}
                    onValueChange={([v]) => updateField("containerRadius", Math.round(v * 10) / 10)}
                    disabled={formDisabled}
                    data-testid="slider-container-radius"
                  />
                </div>
              </div>

              <div className="border-t pt-6 space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Bottom App Navigation</h3>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Button Style</Label>
                  <Select
                    value={form.bottomNavStyle || "icon-label"}
                    onValueChange={(v) => updateField("bottomNavStyle", v)}
                    disabled={formDisabled}
                  >
                    <SelectTrigger data-testid="select-bottom-nav-style">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="icon-label">Icon + Label</SelectItem>
                      <SelectItem value="icon-only">Icon Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Bar Shape</Label>
                  <Select
                    value={
                      form.bottomNavRadius === 0 ? "0" :
                      form.bottomNavRadius === 0.5 ? "0.5" :
                      form.bottomNavRadius === 0.75 ? "0.75" :
                      form.bottomNavRadius === 2 ? "2" :
                      "custom"
                    }
                    onValueChange={(v) => {
                      if (v !== "custom") updateField("bottomNavRadius", parseFloat(v));
                    }}
                    disabled={formDisabled}
                  >
                    <SelectTrigger data-testid="select-bottom-nav-radius-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sharp / Square</SelectItem>
                      <SelectItem value="0.5">Classic</SelectItem>
                      <SelectItem value="0.75">Soft</SelectItem>
                      <SelectItem value="2">Pill</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Corner Radius</Label>
                    <span className="text-sm text-muted-foreground" data-testid="text-bottom-nav-radius-value">{form.bottomNavRadius}rem</span>
                  </div>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[form.bottomNavRadius]}
                    onValueChange={([v]) => updateField("bottomNavRadius", Math.round(v * 10) / 10)}
                    disabled={formDisabled}
                    data-testid="slider-bottom-nav-radius"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Shadow Effect</Label>
                  <Select
                    value={form.bottomNavShadow || "shadow-lg"}
                    onValueChange={(v) => updateField("bottomNavShadow", v)}
                    disabled={formDisabled}
                  >
                    <SelectTrigger data-testid="select-bottom-nav-shadow">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="shadow-sm">Small (Subtle)</SelectItem>
                      <SelectItem value="shadow-md">Medium</SelectItem>
                      <SelectItem value="shadow-lg">Large (Floating)</SelectItem>
                      <SelectItem value="shadow-xl">Extra Large (High Hover)</SelectItem>
                      <SelectItem value="shadow-2xl">Maximum Hover</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Background Opacity</Label>
                  <div className="flex items-center gap-3">
                    <Slider
                      min={0}
                      max={100}
                      step={1}
                      value={[form.bottomNavOpacity ?? 100]}
                      onValueChange={([v]) => updateField("bottomNavOpacity", v)}
                      disabled={formDisabled}
                      data-testid="slider-bottom-nav-opacity"
                    />
                    <span className="text-sm text-muted-foreground w-10 text-right" data-testid="text-bottom-nav-opacity-value">{form.bottomNavOpacity ?? 100}%</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Lower opacity for a frosted glass effect. Works best with blur enabled.</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Background Blur</Label>
                  <Select
                    value={form.bottomNavBlur || "none"}
                    onValueChange={(v) => updateField("bottomNavBlur", v)}
                    disabled={formDisabled}
                  >
                    <SelectTrigger data-testid="select-bottom-nav-blur">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="sm">Small</SelectItem>
                      <SelectItem value="md">Medium</SelectItem>
                      <SelectItem value="lg">Large</SelectItem>
                      <SelectItem value="xl">Extra Large</SelectItem>
                      <SelectItem value="2xl">Maximum</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground mt-1">Blurs content behind the navigation for a frosted glass look.</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Background Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.bottomNavBgColor || "#ffffff"}
                      onChange={(e) => updateField("bottomNavBgColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-bottom-nav-bg"
                    />
                    <Input
                      value={form.bottomNavBgColor || ""}
                      placeholder="Default (card)"
                      onChange={(e) => updateField("bottomNavBgColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-bottom-nav-bg-hex"
                    />
                    {form.bottomNavBgColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("bottomNavBgColor", null)} data-testid="btn-clear-bottom-nav-bg">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Safe Area Background</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.bottomNavSafeAreaColor || "#ffffff"}
                      onChange={(e) => updateField("bottomNavSafeAreaColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-bottom-nav-safe-area"
                    />
                    <Input
                      value={form.bottomNavSafeAreaColor || ""}
                      placeholder="Default (transparent)"
                      onChange={(e) => updateField("bottomNavSafeAreaColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-bottom-nav-safe-area-hex"
                    />
                    {form.bottomNavSafeAreaColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("bottomNavSafeAreaColor", null)} data-testid="btn-clear-bottom-nav-safe-area">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Color for the space behind the floating pill. Clear it to make it transparent.</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Inactive Icon Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.bottomNavFgColor || form.primaryColor}
                      onChange={(e) => updateField("bottomNavFgColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-bottom-nav-fg"
                    />
                    <Input
                      value={form.bottomNavFgColor || ""}
                      placeholder="Default (primary)"
                      onChange={(e) => updateField("bottomNavFgColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-bottom-nav-fg-hex"
                    />
                    {form.bottomNavFgColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("bottomNavFgColor", null)} data-testid="btn-clear-bottom-nav-fg">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Active Icon Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.bottomNavActiveFgColor || form.primaryColor}
                      onChange={(e) => updateField("bottomNavActiveFgColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-bottom-nav-active-fg"
                    />
                    <Input
                      value={form.bottomNavActiveFgColor || ""}
                      placeholder="Default (primary)"
                      onChange={(e) => updateField("bottomNavActiveFgColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-bottom-nav-active-fg-hex"
                    />
                    {form.bottomNavActiveFgColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("bottomNavActiveFgColor", null)} data-testid="btn-clear-bottom-nav-active-fg">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <NavPreview form={form} />
              </div>

              <div className="border-t pt-6 space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Tab Navigation Colors</h3>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Inactive Tab Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.tabColor || form.primaryColor}
                      onChange={(e) => updateField("tabColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-tab-color"
                    />
                    <Input
                      value={form.tabColor || ""}
                      placeholder="Default (primary)"
                      onChange={(e) => updateField("tabColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-tab-color-hex"
                    />
                    {form.tabColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("tabColor", null)} data-testid="btn-clear-tab-color">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Inactive Tab Hover Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.tabHoverColor || form.secondaryColor}
                      onChange={(e) => updateField("tabHoverColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-tab-hover-color"
                    />
                    <Input
                      value={form.tabHoverColor || ""}
                      placeholder="Default (secondary)"
                      onChange={(e) => updateField("tabHoverColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-tab-hover-color-hex"
                    />
                    {form.tabHoverColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("tabHoverColor", null)} data-testid="btn-clear-tab-hover-color">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Active Tab Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={form.tabActiveColor || form.primaryColor}
                      onChange={(e) => updateField("tabActiveColor", e.target.value)}
                      disabled={formDisabled}
                      className="w-8 h-8 rounded border cursor-pointer"
                      data-testid="input-tab-active-color"
                    />
                    <Input
                      value={form.tabActiveColor || ""}
                      placeholder="Default (primary)"
                      onChange={(e) => updateField("tabActiveColor", e.target.value || null)}
                      disabled={formDisabled}
                      className="flex-1"
                      data-testid="input-tab-active-color-hex"
                    />
                    {form.tabActiveColor && (
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => updateField("tabActiveColor", null)} data-testid="btn-clear-tab-active-color">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <TabPreview form={form} />
              </div>
            </div>
          </Card>

        </div>

        <div className="space-y-6">
          <Card className="rounded-2xl p-6 space-y-5 lg:sticky lg:top-20">
            <h3 className="font-display text-base font-semibold">Theme Preview</h3>

            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground">Buttons</Label>
              <Button className="w-full" data-testid="preview-primary-button">
                Primary Button
              </Button>
              <Button
                className="w-full"
                style={{ backgroundColor: form.accentColor, color: form.accentForegroundColor || "#0A0A0A" }}
                data-testid="preview-accent-button"
              >
                Accent Button
              </Button>
              <Button variant="outline" className="w-full" data-testid="preview-outline-button">
                Outline Button
              </Button>
              <Button variant="secondary" className="w-full" data-testid="preview-secondary-button">
                Secondary Button
              </Button>
            </div>

            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground">Input</Label>
              <Input
                placeholder="Type a message..."
                data-testid="preview-input"
              />
            </div>

            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground">Dropdown</Label>
              <Select data-testid="preview-select">
                <SelectTrigger data-testid="preview-select-trigger">
                  <SelectValue placeholder="Choose an option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="option-1">Option 1</SelectItem>
                  <SelectItem value="option-2">Option 2</SelectItem>
                  <SelectItem value="option-3">Option 3</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <Label className="text-xs text-muted-foreground">Badges</Label>
              <div className="flex gap-2 flex-wrap">
                <Badge data-testid="preview-badge-default">New York</Badge>
                <Badge variant="secondary" data-testid="preview-badge-secondary">Monogamy</Badge>
                <Badge variant="outline" data-testid="preview-badge-outline">6'0"</Badge>
                <Badge variant="destructive" data-testid="preview-badge-destructive">Urgent</Badge>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Alerts</Label>
              <div
                className="p-3 rounded-md text-sm flex items-center gap-2"
                style={{ backgroundColor: form.successColor + "15", color: form.successColor, border: `1px solid ${form.successColor}30` }}
                data-testid="preview-alert-success"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Success alert message
              </div>
              <div
                className="p-3 rounded-md text-sm flex items-center gap-2"
                style={{ backgroundColor: form.warningColor + "15", color: form.warningColor, border: `1px solid ${form.warningColor}30` }}
                data-testid="preview-alert-warning"
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Warning alert message
              </div>
              <div
                className="p-3 rounded-md text-sm flex items-center gap-2"
                style={{ backgroundColor: form.errorColor + "15", color: form.errorColor, border: `1px solid ${form.errorColor}30` }}
                data-testid="preview-alert-error"
              >
                <XCircle className="w-4 h-4 shrink-0" />
                Error alert message
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Sample Card</Label>
              <Card className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                    style={{ backgroundColor: form.primaryColor }}
                  >
                    EA
                  </div>
                  <div>
                    <p
                      className="text-sm font-heading"
                      style={{ fontFamily: `'${form.headingFont}', serif` }}
                    >
                      Sample Card
                    </p>
                    <p
                      className="text-xs text-muted-foreground"
                      style={{ fontFamily: `'${form.bodyFont}', sans-serif` }}
                    >
                      Subtitle text preview
                    </p>
                  </div>
                </div>
                <p
                  className="text-sm text-muted-foreground"
                  style={{ fontFamily: `'${form.bodyFont}', sans-serif`, lineHeight: form.lineHeight }}
                >
                  This card shows how your brand looks across various UI elements.
                </p>
              </Card>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function AdminBrandSettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes("GOSTORK_ADMIN");

  if (!isAdmin) return <Navigate to="/account" replace />;

  return (
    <BrandSettingsForm
      getEndpoint="/api/brand/global"
      putEndpoint="/api/brand/settings"
      resetEndpoint="/api/brand/reset"
      showTemplates
    />
  );
}
