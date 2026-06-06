import { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

interface SaveBarProps {
  visible: boolean;
  onSave: () => void;
  onDiscard: () => void;
  message?: ReactNode;
  saving?: boolean;
  saveDisabled?: boolean;
  discardDisabled?: boolean;
  saveLabel?: string;
  discardLabel?: string;
  position?: "sticky" | "fixed";
  className?: string;
  children?: ReactNode;
  extraActions?: ReactNode;
  testId?: string;
}

export function SaveBar({
  visible,
  onSave,
  onDiscard,
  message = "Unsaved changes",
  saving = false,
  saveDisabled = false,
  discardDisabled = false,
  saveLabel = "Save",
  discardLabel = "Discard",
  position = "sticky",
  className,
  children,
  extraActions,
  testId = "save-bar",
}: SaveBarProps) {
  if (!visible) return null;

  const positionClasses =
    position === "fixed"
      ? "fixed bottom-0 left-0 right-0 z-50"
      : "sticky bottom-0 -mx-4 z-20";

  return (
    <div
      className={cn(
        positionClasses,
        "px-4 py-3 bg-background/95 backdrop-blur border-t shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.06)] flex flex-col gap-2",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">{message}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={saving || discardDisabled}
            data-testid={`${testId}-discard`}
          >
            {discardLabel}
          </Button>
          {extraActions}
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving || saveDisabled}
            data-testid={`${testId}-save`}
          >
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {saveLabel}
          </Button>
        </div>
      </div>
      {children}
    </div>
  );
}
