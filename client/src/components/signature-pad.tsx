/**
 * Reusable native signature widget (Intended Parent Form acknowledgment,
 * and any future in-app signing surface - never fork this).
 *
 * Two inline modes (no dialogs): Draw (pointer-events canvas) and Type
 * (name rendered in a script font onto an offscreen canvas). Both export a
 * transparent PNG via toDataURL; onSign uploads it with uploadFile() and
 * receives the stored URL. Brand CSS variables only.
 */
import { useEffect, useRef, useState } from "react";
import { Eraser, Loader2, PenLine, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadFile } from "@/lib/image-utils";

export interface SignatureResult {
  signatureImageUrl: string;
  method: "drawn" | "typed";
}

const TYPED_FONT = '48px "Snell Roundhand", "Savoye LET", "Brush Script MT", "Segoe Script", cursive';

async function canvasToUploadedUrl(canvas: HTMLCanvasElement, fileName: string): Promise<string> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not export signature"))), "image/png"),
  );
  const file = new File([blob], fileName, { type: "image/png" });
  return uploadFile(file, fileName);
}

export function SignaturePad({
  typedNameDefault,
  disabled,
  onSign,
  upload,
}: {
  /** Prefill for the Type tab (usually the parent's full legal name). */
  typedNameDefault?: string;
  disabled?: boolean;
  /** Called with the uploaded signature image URL. May throw to surface an error. */
  onSign: (result: SignatureResult) => Promise<void> | void;
  /**
   * Override how the PNG leaves the browser. Default uploads via
   * POST /api/uploads (needs auth); guest surfaces pass a data-URL
   * passthrough and let their token endpoint store it server-side.
   */
  upload?: (canvas: HTMLCanvasElement, fileName: string) => Promise<string>;
}) {
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [hasInk, setHasInk] = useState(false);
  const [typedName, setTypedName] = useState(typedNameDefault || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setTypedName((prev) => prev || typedNameDefault || "");
  }, [typedNameDefault]);

  // Size the canvas to its rendered box (device-pixel aware) once mounted.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--foreground")
        ? `hsl(${getComputedStyle(document.documentElement).getPropertyValue("--foreground")})`
        : "#1f2937";
    }
  }, [mode]);

  const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    lastPoint.current = pointFrom(e);
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const ctx = e.currentTarget.getContext("2d");
    const p = pointFrom(e);
    if (ctx && lastPoint.current) {
      ctx.beginPath();
      ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      setHasInk(true);
    }
    lastPoint.current = p;
  };

  const endDraw = () => {
    drawing.current = false;
    lastPoint.current = null;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      let url: string;
      if (mode === "drawn") {
        const canvas = canvasRef.current;
        if (!canvas || !hasInk) throw new Error("Please draw your signature first");
        url = await (upload ? upload(canvas, `signature-${Date.now()}.png`) : canvasToUploadedUrl(canvas, `signature-${Date.now()}.png`));
      } else {
        const name = typedName.trim();
        if (!name) throw new Error("Please type your name first");
        const offscreen = document.createElement("canvas");
        offscreen.width = 640;
        offscreen.height = 160;
        const ctx = offscreen.getContext("2d");
        if (!ctx) throw new Error("Could not render signature");
        ctx.fillStyle = "#1f2937";
        ctx.font = TYPED_FONT;
        ctx.textBaseline = "middle";
        // Shrink to fit long names.
        let size = 48;
        while (size > 18 && ctx.measureText(name).width > 600) {
          size -= 2;
          ctx.font = TYPED_FONT.replace("48px", `${size}px`);
        }
        ctx.fillText(name, 20, 80);
        url = await (upload ? upload(offscreen, `signature-${Date.now()}.png`) : canvasToUploadedUrl(offscreen, `signature-${Date.now()}.png`));
      }
      await onSign({ signatureImageUrl: url, method: mode });
    } catch (e: any) {
      setError(e?.message || "Could not save your signature");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="signature-pad">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("drawn")}
          disabled={disabled}
          className={`px-3 py-1.5 rounded-full text-sm border font-ui transition-colors inline-flex items-center gap-1.5 ${
            mode === "drawn" ? "bg-primary text-primary-foreground border-primary" : "bg-background text-foreground border-border hover:border-primary/50"
          }`}
          data-testid="signature-mode-draw"
        >
          <PenLine className="w-3.5 h-3.5" /> Draw
        </button>
        <button
          type="button"
          onClick={() => setMode("typed")}
          disabled={disabled}
          className={`px-3 py-1.5 rounded-full text-sm border font-ui transition-colors inline-flex items-center gap-1.5 ${
            mode === "typed" ? "bg-primary text-primary-foreground border-primary" : "bg-background text-foreground border-border hover:border-primary/50"
          }`}
          data-testid="signature-mode-type"
        >
          <Type className="w-3.5 h-3.5" /> Type
        </button>
      </div>

      {mode === "drawn" ? (
        <div className="space-y-2">
          <div className="relative rounded-[var(--radius)] border-2 border-dashed border-border bg-secondary/30">
            <canvas
              ref={canvasRef}
              className="w-full h-36 touch-none cursor-crosshair"
              onPointerDown={startDraw}
              onPointerMove={moveDraw}
              onPointerUp={endDraw}
              onPointerLeave={endDraw}
              data-testid="signature-canvas"
            />
            {!hasInk && (
              <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
                Sign here with your mouse or finger
              </p>
            )}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={clearCanvas} disabled={disabled || !hasInk} data-testid="signature-clear">
            <Eraser className="w-3.5 h-3.5 mr-1.5" /> Clear
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder="Type your full legal name"
            disabled={disabled}
            data-testid="signature-typed-input"
          />
          {typedName.trim() && (
            <div className="rounded-[var(--radius)] border border-border bg-secondary/30 px-4 py-3">
              <p className="text-3xl" style={{ fontFamily: '"Snell Roundhand", "Savoye LET", "Brush Script MT", "Segoe Script", cursive' }}>
                {typedName}
              </p>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="button" onClick={submit} disabled={disabled || busy} data-testid="signature-submit">
        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PenLine className="w-4 h-4 mr-2" />}
        Sign
      </Button>
    </div>
  );
}
