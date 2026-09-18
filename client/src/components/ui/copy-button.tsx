import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";

export function CopyButton({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      // 24px box (was 20), a name, and an announcement when it worked.
      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
      data-testid={testId}
      title="Copy to clipboard"
      aria-label={copied ? "Copied" : `Copy ${value}`}
    >
      {copied ? <Check className="w-3 h-3 text-primary" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
    </button>
  );
}
