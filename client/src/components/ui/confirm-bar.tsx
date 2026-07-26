import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

type ConfirmTone = "default" | "destructive" | "warning";

interface ConfirmOptions {
  title?: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

interface OpenState extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OpenState | null>(null);
  const [closing, setClosing] = useState(false);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setClosing(false);
      setState({ ...opts, resolve });
    });
  }, []);

  const finish = useCallback((value: boolean) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setClosing(true);
    setTimeout(() => {
      setState(null);
      setClosing(false);
      r?.(value);
    }, 180);
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, finish]);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state ? (
        <ConfirmBar
          {...state}
          closing={closing}
          onConfirm={() => finish(true)}
          onCancel={() => finish(false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx.confirm;
}

interface ConfirmBarProps extends ConfirmOptions {
  onConfirm: () => void;
  onCancel: () => void;
  closing: boolean;
}

function ConfirmBar({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
  closing,
}: ConfirmBarProps) {
  const iconColor =
    tone === "destructive"
      ? "text-destructive"
      : tone === "warning"
        ? "text-[hsl(var(--brand-warning))]"
        : "text-primary";

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-150",
          closing ? "opacity-0" : "opacity-100",
        )}
        onClick={onCancel}
        data-testid="confirm-bar-backdrop"
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-50 px-4 py-4 bg-background/95 backdrop-blur border-t shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.12)]",
          "transition-transform duration-200 ease-out",
          closing ? "translate-y-full" : "translate-y-0",
        )}
        data-testid="confirm-bar"
        role="alertdialog"
        aria-modal="true"
      >
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <AlertTriangle className={cn("w-5 h-5 mt-0.5 shrink-0", iconColor)} />
            <div className="min-w-0">
              {title ? (
                <div className="font-medium text-foreground">{title}</div>
              ) : null}
              <div className="t-helper">{message}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 justify-end shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              data-testid="confirm-bar-cancel"
            >
              {cancelLabel}
            </Button>
            <Button
              size="sm"
              variant={tone === "destructive" ? "destructive" : "default"}
              onClick={onConfirm}
              data-testid="confirm-bar-confirm"
              autoFocus
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export function ConfirmBarLoading() {
  return (
    <div className="flex items-center justify-center py-2">
      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
  );
}
