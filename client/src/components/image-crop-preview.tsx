import { useState, useCallback } from "react";
import Cropper, { Area } from "react-easy-crop";
import { ZoomIn, ZoomOut, RotateCw, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImageCropPreviewProps {
  imageSrc: string;
  onCropComplete: (croppedBlob: Blob) => void;
  onCancel: () => void;
  aspect?: number;
  cropShape?: "rect" | "round";
}

async function getCroppedBlob(
  imageSrc: string,
  pixelCrop: Area,
  rotation: number = 0
): Promise<Blob> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const radians = (rotation * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const rotatedWidth = image.width * cos + image.height * sin;
  const rotatedHeight = image.width * sin + image.height * cos;

  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;

  ctx.translate(-pixelCrop.x, -pixelCrop.y);
  ctx.translate(rotatedWidth / 2, rotatedHeight / 2);
  ctx.rotate(radians);
  ctx.translate(-image.width / 2, -image.height / 2);
  ctx.drawImage(image, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob!),
      "image/jpeg",
      0.92
    );
  });
}

function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", reject);
    image.crossOrigin = "anonymous";
    image.src = url;
  });
}

export default function ImageCropPreview({
  imageSrc,
  onCropComplete,
  onCancel,
  aspect = 1,
  cropShape = "round",
}: ImageCropPreviewProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [saving, setSaving] = useState(false);

  const onCropCompleteCallback = useCallback(
    (_croppedArea: Area, croppedAreaPixels: Area) => {
      setCroppedAreaPixels(croppedAreaPixels);
    },
    []
  );

  const handleSave = async () => {
    if (!croppedAreaPixels) return;
    setSaving(true);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels, rotation);
      onCropComplete(blob);
    } catch (e) {
      console.error("Crop failed:", e);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col" data-testid="image-crop-preview">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          data-testid="btn-crop-cancel"
        >
          <X className="w-5 h-5 mr-1" />
          Cancel
        </Button>
        <span className="text-sm font-medium text-foreground">Adjust Photo</span>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          data-testid="btn-crop-save"
        >
          <Check className="w-4 h-4 mr-1" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {/* Crop area */}
      <div className="flex-1 relative bg-black">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={aspect}
          cropShape={cropShape}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onRotationChange={setRotation}
          onCropComplete={onCropCompleteCallback}
          showGrid={false}
        />
      </div>

      {/* Controls */}
      <div className="px-6 py-4 border-t border-border bg-background">
        <div className="flex items-center justify-center gap-6 max-w-sm mx-auto">
          <button
            type="button"
            onClick={() => setZoom(Math.max(1, zoom - 0.2))}
            className="p-2 rounded-full hover:bg-muted transition-colors"
            data-testid="btn-crop-zoom-out"
          >
            <ZoomOut className="w-5 h-5 text-muted-foreground" />
          </button>

          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-primary"
            data-testid="slider-crop-zoom"
          />

          <button
            type="button"
            onClick={() => setZoom(Math.min(3, zoom + 0.2))}
            className="p-2 rounded-full hover:bg-muted transition-colors"
            data-testid="btn-crop-zoom-in"
          >
            <ZoomIn className="w-5 h-5 text-muted-foreground" />
          </button>

          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="p-2 rounded-full hover:bg-muted transition-colors"
            data-testid="btn-crop-rotate"
          >
            <RotateCw className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}
