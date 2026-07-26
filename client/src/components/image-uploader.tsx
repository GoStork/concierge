import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
import {
  Camera, Trash2, Pencil, Upload, Loader2, ZoomIn, ZoomOut, Wand2, X, Check, Move,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { SaveBar } from "@/components/ui/save-bar";
import { useToast } from "@/hooks/use-toast";
import { getPhotoSrc } from "@/lib/profile-utils";
import ImageCropPreview from "@/components/image-crop-preview";
import {
  CHECKER_BG, CHECKER_BG_DARK, uploadFile, uploadCanvasAsFile, detectContentBounds,
  makeWhiteTransparent, hasTransparency, constrainCanvas, removeBackgroundFromFile,
  proxiedForCanvas,
} from "@/lib/image-utils";

/* ------------------------------------------------------------------ *
 * Full-screen logo editor (canvas pan/zoom, trim-white, remove-bg,    *
 * Auto Fix). Same full-screen chrome + SaveBar as the avatar cropper. *
 * ------------------------------------------------------------------ */
function LogoEditorOverlay({
  imageUrl,
  onSave,
  onCancel,
  testId,
}: {
  imageUrl: string;
  onSave: (newUrl: string) => void;
  onCancel: () => void;
  testId: string;
}) {
  const { toast } = useToast();
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

  const onError = useCallback((msg: string) => toast({ title: msg, variant: "destructive" }), [toast]);

  const fitImage = useCallback((image: HTMLImageElement) => {
    const container = containerRef.current;
    const cw = container ? container.clientWidth : 500;
    const ch = container ? container.clientHeight : 400;
    fitScaleRef.current = Math.min(cw / image.width, ch / image.height);
    setZoom(100);
    setPanX(0);
    setPanY(0);
    setImg(image);
  }, []);

  useEffect(() => {
    const isExternal = imageUrl.startsWith("http");
    const image = new window.Image();
    if (isExternal) image.crossOrigin = "anonymous";
    image.onload = () => fitImage(image);
    image.onerror = () => {
      if (isExternal) {
        const proxied = new window.Image();
        proxied.crossOrigin = "anonymous";
        proxied.onload = () => fitImage(proxied);
        proxied.onerror = () => onError("Failed to load image for editing");
        proxied.src = proxiedForCanvas(imageUrl);
      } else {
        onError("Failed to load image for editing");
      }
    };
    image.src = isExternal ? proxiedForCanvas(imageUrl) : imageUrl;
  }, [imageUrl, fitImage, onError]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const resizeCanvas = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        if (img) fitScaleRef.current = Math.min(w / img.width, h / img.height);
      }
    };
    resizeCanvas();
    const ro = new ResizeObserver(resizeCanvas);
    ro.observe(container);
    return () => ro.disconnect();
  }, [img]);

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
    const delta = e.deltaY > 0 ? -5 : 5;
    setZoom((z) => Math.max(10, Math.min(500, z + delta)));
  };

  const loadNewImage = (newUrl: string) => {
    const newImage = new window.Image();
    newImage.onload = () => fitImage(newImage);
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
      try { imgHasAlpha = hasTransparency(tempCanvas); } catch { imgHasAlpha = false; }
      const useWhiteTrim = trimWhite || !imgHasAlpha;

      let bounds;
      try { bounds = detectContentBounds(tempCanvas, useWhiteTrim); }
      catch { onError("Cannot process image - try re-uploading the logo first"); return; }
      if (!bounds) { onError("Could not detect logo content - image may be blank"); return; }

      const outCanvas = document.createElement("canvas");
      outCanvas.width = bounds.w;
      outCanvas.height = bounds.h;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) return;
      outCtx.drawImage(tempCanvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);

      const finalCanvas = constrainCanvas(outCanvas);
      if (removeWhiteBg) makeWhiteTransparent(finalCanvas);
      const newUrl = await uploadCanvasAsFile(finalCanvas);
      if (!newUrl) { onError("Failed to upload optimized logo"); return; }
      loadNewImage(newUrl);
    } catch {
      onError("Failed to process logo - try re-uploading it first");
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
      } catch { /* leave finalCanvas as the full draw */ }

      const constrained = constrainCanvas(finalCanvas);
      if (removeWhiteBg) makeWhiteTransparent(constrained);
      const newUrl = await uploadCanvasAsFile(constrained);
      if (!newUrl) { onError("Failed to upload edited logo"); return; }
      onSave(newUrl);
    } catch {
      onError("Failed to process logo - try re-uploading it first");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col" data-testid={`${testId}-editor`}>
      <div className="flex items-center justify-center px-4 py-3 border-b border-border relative">
        <button
          type="button"
          onClick={onCancel}
          className="absolute left-3 p-1.5 rounded-full hover:bg-muted transition-colors"
          aria-label="Close"
          data-testid={`${testId}-cancel-edit`}
        >
          <X className="w-5 h-5 text-muted-foreground" />
        </button>
        <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
          <Move className="w-4 h-4" /> Edit Logo
        </span>
      </div>

      <div
        ref={containerRef}
        className="flex-1 relative cursor-grab active:cursor-grabbing select-none touch-none"
        style={{ backgroundImage: CHECKER_BG, backgroundSize: "16px 16px" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <canvas ref={canvasRef} className="w-full h-full" data-testid={`${testId}-canvas`} />
      </div>

      <div className="px-6 py-4 border-t border-border bg-background space-y-3">
        <div className="flex items-center gap-3 max-w-lg mx-auto w-full">
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
          <span className="t-helper w-12 text-right">{zoom}%</span>
        </div>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <label className="t-helper flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={trimWhite}
              onChange={(e) => setTrimWhite(e.target.checked)}
              className="rounded border-border"
              data-testid={`${testId}-trim-white`}
            />
            Trim white
          </label>
          <label className="t-helper flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={removeWhiteBg}
              onChange={(e) => setRemoveWhiteBg(e.target.checked)}
              className="rounded border-border"
              data-testid={`${testId}-remove-white-bg`}
            />
            Remove white background
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={handleAutoFix}
            disabled={autoFixing || saving}
            data-testid={`${testId}-auto-fix`}
          >
            {autoFixing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Wand2 className="w-3.5 h-3.5 mr-1.5" />}
            Auto Fix
          </Button>
        </div>
      </div>

      <SaveBar
        visible
        testId={`${testId}-save-bar`}
        message="Pan, zoom, and clean up the logo"
        discardLabel="Cancel"
        saveLabel="Apply"
        saving={saving}
        saveDisabled={!img || autoFixing}
        onDiscard={onCancel}
        onSave={handleApply}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Unified uploader: one component, two triggers, two editors.         *
 * ------------------------------------------------------------------ */
type EditorMode = "avatar" | "logo";
type TriggerVariant = "avatar" | "dropzone";

export interface ImageUploaderProps {
  value: string | null;
  onChange: (url: string | null) => void;
  /** Which full-screen editor opens. Default "avatar". */
  mode?: EditorMode;
  /** Resting presentation. Defaults: avatar mode -> "avatar", logo mode -> "dropzone". */
  variant?: TriggerVariant;
  testId: string;
  disabled?: boolean;
  label?: string;
  /** avatar variant */
  size?: number;
  shape?: "round" | "rect";
  fallback?: ReactNode;
  /** dropzone variant */
  accept?: string;
  darkPreview?: boolean;
  /** logo mode: show the "Remove background on upload" checkbox. Default true for logo. */
  allowRemoveBgOnUpload?: boolean;
}

type EditorState =
  | { kind: "avatar"; src: string }
  | { kind: "logo"; url: string }
  | null;

// SVGs are vector; the canvas logo editor can't meaningfully edit them and some
// fail to rasterize, so we skip the editor for them.
const isSvgUrl = (u: string | null) => !!u && /\.svg($|\?)/i.test(u);

export default function ImageUploader({
  value,
  onChange,
  mode = "avatar",
  variant,
  testId,
  disabled,
  label,
  size = 96,
  shape = "round",
  fallback,
  accept = "image/jpeg,image/png,image/webp,image/gif,image/svg+xml",
  darkPreview,
  allowRemoveBgOnUpload,
}: ImageUploaderProps) {
  const { toast } = useToast();
  const resolvedVariant: TriggerVariant = variant ?? (mode === "logo" ? "dropzone" : "avatar");
  const showRemoveBg = (allowRemoveBgOnUpload ?? mode === "logo");

  const inputRef = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [makeTransparent, setMakeTransparent] = useState(false);

  const displayUrl = getPhotoSrc(value);

  /** Handle a freshly-picked file. */
  const handleFile = async (file: File) => {
    if (disabled) return;
    if (file.size > 16 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum size is 16MB", variant: "destructive" });
      return;
    }
    const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");

    if (mode === "avatar") {
      // Read to a data URL and open the cropper. Nothing is committed until the
      // user hits Save in the cropper, so Cancel leaves the old photo intact.
      const reader = new FileReader();
      reader.onload = () => setEditor({ kind: "avatar", src: reader.result as string });
      reader.readAsDataURL(file);
      return;
    }

    // logo mode.
    if (isSvg) {
      // SVGs can't be canvas-edited; upload and commit directly.
      setUploading(true);
      try {
        const url = await uploadFile(file);
        onChange(url);
      } catch (err: any) {
        toast({ title: "Upload failed", description: err?.message, variant: "destructive" });
      } finally {
        setUploading(false);
      }
      return;
    }
    if (makeTransparent) {
      // Needs a round-trip to the background-removal API; open the editor on the
      // result but DON'T commit until Apply.
      setUploading(true);
      try {
        const url = await removeBackgroundFromFile(file);
        setEditor({ kind: "logo", url });
      } catch (err: any) {
        toast({ title: "Upload failed", description: err?.message, variant: "destructive" });
      } finally {
        setUploading(false);
      }
      return;
    }
    // Common case: upload the file so the canvas can load it via the proven
    // (proxied) path, open the editor, but commit to the field only on Apply -
    // so Cancel leaves the existing logo untouched.
    setUploading(true);
    try {
      const url = await uploadFile(file);
      setEditor({ kind: "logo", url });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  // Close the editor, releasing any object URL created for a local preview.
  const closeEditor = () => {
    setEditor((prev) => {
      if (prev?.kind === "logo" && prev.url.startsWith("blob:")) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  /** Open the editor on the EXISTING image. */
  const editExisting = () => {
    if (!value) return;
    if (mode === "avatar") {
      const src = proxiedForCanvas(displayUrl || value);
      setEditor({ kind: "avatar", src });
    } else {
      if (isSvgUrl(value)) return; // vector logos aren't canvas-editable
      setEditor({ kind: "logo", url: value });
    }
  };

  /** Avatar cropper finished -> upload the blob and publish the URL. */
  const handleCropComplete = async (blob: Blob) => {
    closeEditor();
    setUploading(true);
    try {
      const url = await uploadFile(blob, "photo.jpg");
      onChange(url);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const pickFile = () => { if (!disabled) inputRef.current?.click(); };

  const editorOverlay = editor && (
    editor.kind === "avatar" ? (
      <ImageCropPreview
        imageSrc={editor.src}
        onCropComplete={handleCropComplete}
        onCancel={closeEditor}
        aspect={1}
        cropShape={shape === "rect" ? "rect" : "round"}
      />
    ) : (
      <LogoEditorOverlay
        imageUrl={editor.url}
        onSave={(url) => { onChange(url); closeEditor(); }}
        onCancel={closeEditor}
        testId={testId}
      />
    )
  );

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      className="hidden"
      disabled={disabled}
      data-testid={`${testId}-input`}
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
        e.target.value = "";
      }}
    />
  );

  /* ---------------------------- avatar trigger ---------------------------- */
  if (resolvedVariant === "avatar") {
    const radius = shape === "rect" ? "var(--radius)" : "9999px";
    return (
      <>
        {editorOverlay}
        <div className="flex flex-col items-center gap-2">
          <div className="relative group" style={{ width: size, height: size }} data-testid={testId}>
            {displayUrl ? (
              <img
                src={displayUrl}
                alt={label || "Image"}
                className="w-full h-full object-cover border-2 border-border/40"
                style={{ borderRadius: radius }}
                referrerPolicy="no-referrer"
                data-testid={`${testId}-img`}
              />
            ) : (
              <div
                className="w-full h-full bg-primary/10 flex items-center justify-center border-2 border-border/40 overflow-hidden"
                style={{ borderRadius: radius }}
                data-testid={`${testId}-placeholder`}
              >
                {fallback ?? <Camera className="text-primary" style={{ width: size * 0.35, height: size * 0.35 }} />}
              </div>
            )}
            {hiddenInput}
            {!disabled && (
              <div
                className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-0.5"
                style={{ borderRadius: radius }}
              >
                {uploading ? (
                  <Loader2 className="w-5 h-5 text-white animate-spin" />
                ) : (
                  <>
                    {displayUrl && (
                      <button
                        type="button"
                        onClick={editExisting}
                        className="p-1 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                        data-testid={`${testId}-edit`}
                        title="Edit photo"
                      >
                        <Pencil className="w-4 h-4 text-white" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={pickFile}
                      className="p-1.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                      data-testid={`${testId}-upload`}
                      title={displayUrl ? "Replace photo" : "Upload photo"}
                    >
                      <Camera className="w-4 h-4 text-white" />
                    </button>
                    {displayUrl && (
                      <button
                        type="button"
                        onClick={() => onChange(null)}
                        className="p-1 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                        data-testid={`${testId}-delete`}
                        title="Remove photo"
                      >
                        <Trash2 className="w-4 h-4 text-white" />
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          {label && <p className="t-helper">{label}</p>}
        </div>
      </>
    );
  }

  /* --------------------------- dropzone trigger --------------------------- */
  return (
    <>
      {editorOverlay}
      <div className="space-y-2">
        {label && <Label >{label}</Label>}
        <div
          className={`relative border-2 border-dashed rounded-[var(--radius)] p-6 text-center transition-colors ${
            disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
          } ${dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
          onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (disabled) return;
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
          }}
          onClick={pickFile}
          data-testid={testId}
        >
          {hiddenInput}
          {uploading ? (
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          ) : displayUrl ? (
            <div className="flex flex-col items-center gap-3">
              <div
                className="rounded-[var(--radius)] p-1"
                style={{ backgroundImage: darkPreview ? CHECKER_BG_DARK : CHECKER_BG, backgroundSize: "16px 16px" }}
              >
                <img
                  src={displayUrl}
                  alt={label || "Image"}
                  className="max-h-16 max-w-[200px] object-contain"
                  referrerPolicy="no-referrer"
                  data-testid={`${testId}-preview`}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="t-helper">Click or drag to replace</span>
                {mode === "logo" && !isSvgUrl(value) && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:text-primary/80 font-medium flex items-center gap-1"
                    onClick={(e) => { e.stopPropagation(); editExisting(); }}
                    data-testid={`${testId}-edit`}
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                )}
                <button
                  type="button"
                  className="t-helper hover:text-destructive flex items-center gap-1"
                  onClick={(e) => { e.stopPropagation(); onChange(null); }}
                  data-testid={`${testId}-delete`}
                >
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-8 h-8 text-muted-foreground" />
              <span className="t-helper">Drag &amp; drop or click to upload</span>
              <span className="t-helper">SVG, PNG, JPG (max 16MB)</span>
            </div>
          )}
        </div>
        {!disabled && showRemoveBg && (
          <label
            className="t-helper flex items-center gap-1.5 cursor-pointer select-none"
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
    </>
  );
}
