import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X, Maximize, Minimize } from "lucide-react";

interface InlineVideoOverlayProps {
  bookingId: string;
  onClose: () => void;
}

export function InlineVideoOverlay({ bookingId, onClose }: InlineVideoOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!overlayRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      overlayRef.current.requestFullscreen().catch(() => {});
    }
  };

  return (
    <div
      ref={overlayRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: "hsl(var(--background))",
      }}
      data-testid="inline-video-overlay"
    >
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10001, display: "flex", gap: 4 }}>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full bg-background/80 hover:bg-background border shadow-sm"
          onClick={toggleFullscreen}
          data-testid="button-fullscreen-video"
        >
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full bg-background/80 hover:bg-background border shadow-sm"
          onClick={onClose}
          data-testid="button-close-inline-video"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
      <iframe
        src={`/video/${bookingId}`}
        style={{ width: "100%", height: "100%", border: "none" }}
        allow="camera *; microphone *; autoplay *; display-capture *; fullscreen *"
        data-testid="inline-video-iframe"
      />
    </div>
  );
}
