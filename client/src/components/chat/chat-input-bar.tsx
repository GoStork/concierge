import { useState, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Loader2, Paperclip, FileText, X, Shield, Headphones } from "lucide-react";

interface ChatInputBarProps {
  onSend: (text: string, files: File[]) => void;
  isLoading: boolean;
  brandColor: string;
  placeholder?: string;
  /** Shown above the input - e.g. whisper disclaimer or "Sending as Expert" */
  senderLabel?: ReactNode;
  enableFileUpload?: boolean;
  /** External control of uploading state (for file uploads that happen outside this component) */
  isUploading?: boolean;
  testIdPrefix?: string;
}

/**
 * Shared chat input bar used by provider chat and admin concierge monitor.
 * Supports file staging with previews, paperclip attach button,
 * text input with Enter-to-send, and send button with loading state.
 */
export function ChatInputBar({
  onSend,
  isLoading,
  brandColor,
  placeholder = "Type a message...",
  senderLabel,
  enableFileUpload = false,
  isUploading = false,
  testIdPrefix = "provider",
}: ChatInputBarProps) {
  const [text, setText] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    if ((!text.trim() && stagedFiles.length === 0) || isLoading || isUploading) return;
    onSend(text.trim(), stagedFiles);
    setText("");
    setStagedFiles([]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = "";
    setStagedFiles((prev) => [...prev, ...Array.from(files)]);
  };

  const removeStagedFile = (index: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const busy = isLoading || isUploading;

  return (
    <div className="border-t px-4 py-3 bg-background shrink-0" data-testid={`${testIdPrefix}-reply-area`}>
      {senderLabel}

      {stagedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {stagedFiles.map((file, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius)] border bg-muted/50 text-xs">
              <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: brandColor }} />
              <span className="truncate max-w-[140px]">{file.name}</span>
              <button onClick={() => removeStagedFile(i)} className="ml-0.5 hover:text-destructive">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        {enableFileUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,application/pdf,.doc,.docx,.txt"
              multiple
              capture={undefined}
              onChange={handleFileSelect}
              data-testid={`input-${testIdPrefix}-file`}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 p-0 shrink-0 rounded-full"
              style={{ color: brandColor }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              data-testid={`btn-${testIdPrefix}-attach`}
            >
              {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </Button>
          </>
        )}
        <Input
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={busy}
          className="flex-1 !text-base font-ui rounded-full"
          data-testid={`input-${testIdPrefix}-message`}
        />
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={(!text.trim() && stagedFiles.length === 0) || busy}
          className="h-10 w-10 p-0 rounded-full text-primary-foreground shrink-0"
          style={{ backgroundColor: brandColor }}
          data-testid={`btn-send-${testIdPrefix}-message`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Pre-built sender label for the whisper (anonymous Q&A) disclaimer.
 */
export function WhisperDisclaimer() {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
      <Shield className="w-3 h-3" />
      <span>Your answer will be relayed to the parent by the AI concierge</span>
    </div>
  );
}

/**
 * Pre-built sender label for admin expert mode.
 */
export function ExpertSenderLabel({ adminName }: { adminName: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
      <Headphones className="w-3 h-3" />
      <span>Sending as <strong className="text-foreground">GoStork Expert</strong> - {adminName}</span>
    </div>
  );
}
