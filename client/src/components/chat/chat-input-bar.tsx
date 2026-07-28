import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Send,
  Loader2,
  X,
  Shield,
  Headphones,
  Plus,
  Image as ImageIcon,
  Camera,
  Paperclip,
  CalendarDays,
  Receipt,
  FileSignature,
  DollarSign,
  HeartHandshake,
  Stethoscope,
} from "lucide-react";
import { ChatPlusDrawer, type ChatPlusAction } from "./chat-plus-drawer";
import { StagedFileChip } from "./staged-file-chip";
import { ContactGuardNotice } from "./contact-guard-notice";
import type { ContactScanResult } from "@shared/contact-guard";

export type PlusBuiltinTile =
  | "photo"
  | "camera"
  | "file"
  | "meeting"
  | "matchCall"
  | "doctorCall"
  | "costSheet"
  | "invoice"
  | "agreement";

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
  /** Optional callback when the Meeting tile is tapped. */
  onMeetingClick?: () => void;
  /** Phase 4: surrogacy Match Call tile - shares the parent's calendar with
   *  meetingSubtype MATCH_CALL so the post-call readiness + 24h hold fire. */
  onMatchCallClick?: () => void;
  /** Phase 4: IVF Doctor Call tile - meetingSubtype DOCTOR_CONSULTATION. */
  onDoctorCallClick?: () => void;
  /** Optional callback when the Send Cost Sheet tile is tapped. */
  onCostSheetClick?: () => void;
  /** Optional callback when the Send Invoice tile is tapped. */
  onInvoiceClick?: () => void;
  /** Optional callback when the Generate Agreement tile is tapped. */
  onAgreementClick?: () => void;
  /**
   * Optional inline panel rendered ABOVE the composer (e.g. the Cost
   * Sheet / Invoice / Agreement form, or a meeting picker). When set,
   * the + drawer auto-collapses.
   */
  inlinePanel?: ReactNode;
  /** Extra custom plus-drawer actions appended after the built-ins. */
  extraPlusActions?: ChatPlusAction[];
  /**
   * Contact guard. When supplied, runs BEFORE onSend and before the textarea is
   * cleared: a blocked message keeps the user's text so they can edit it, which
   * a server-only 422 could not do (handleSubmit clears on hand-off).
   *
   * Omitted by the admin monitor - GoStork staff sharing a support line is
   * legitimate.
   */
  validate?: (text: string) => ContactScanResult | null;
}

const PLUS_TILE_LABELS: Record<PlusBuiltinTile, string> = {
  photo: "Photo",
  camera: "Camera",
  file: "File",
  meeting: "Meeting",
  matchCall: "Match Call",
  doctorCall: "Doctor Call",
  costSheet: "Cost Sheet",
  invoice: "Invoice",
  agreement: "Agreement",
};

/**
 * Shared chat input bar used by parent, provider, and admin chat views.
 *
 * Layout: optional senderLabel - optional inlinePanel - staged-files row -
 * + button (opens drawer) - textarea - send button. The + button toggles
 * an inline drawer above the input with a brand-styled grid of action
 * tiles. Tiles include built-ins (Photo/Camera/File/Meeting/Cost Sheet/
 * Invoice/Agreement) plus any extras passed in.
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
  onMeetingClick,
  onMatchCallClick,
  onDoctorCallClick,
  onCostSheetClick,
  onInvoiceClick,
  onAgreementClick,
  inlinePanel,
  extraPlusActions,
  validate,
}: ChatInputBarProps) {
  const [text, setText] = useState("");
  const [guardScan, setGuardScan] = useState<ContactScanResult | null>(null);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // When an inline panel opens (e.g. cost sheet form), collapse the + drawer.
  useEffect(() => {
    if (inlinePanel) setPlusOpen(false);
  }, [inlinePanel]);

  const handleSubmit = () => {
    if ((!text.trim() && stagedFiles.length === 0) || isLoading || isUploading) return;
    // Must run before onSend AND before setText(""), or a blocked message is
    // gone from the box by the time the user is told why it was blocked.
    const blocked = validate?.(text.trim());
    if (blocked?.blocked) {
      setGuardScan(blocked);
      return;
    }
    setGuardScan(null);
    onSend(text.trim(), stagedFiles);
    setText("");
    setStagedFiles([]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Snapshot to array BEFORE clearing value - Safari/Chrome invalidate FileList on value reset
    const fileArray = Array.from(files);
    e.target.value = "";
    setStagedFiles((prev) => [...prev, ...fileArray]);
    setPlusOpen(false);
  };

  const removeStagedFile = (index: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const busy = isLoading || isUploading;
  // Camera tile only works on devices that honor <input capture> (mobile).
  // Desktop browsers ignore it and fall back to a file picker, so hide the
  // tile there - matches iMessage/WhatsApp which only show Camera on mobile.
  const isTouchDevice =
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches;

  const builtinActions: ChatPlusAction[] = [];
  if (enableFileUpload) {
    builtinActions.push({
      id: "photo",
      label: PLUS_TILE_LABELS.photo,
      icon: ImageIcon,
      onClick: () => photoInputRef.current?.click(),
      disabled: busy,
      testId: `btn-${testIdPrefix}-attach-photo`,
    });
    if (isTouchDevice) {
      builtinActions.push({
        id: "camera",
        label: PLUS_TILE_LABELS.camera,
        icon: Camera,
        onClick: () => cameraInputRef.current?.click(),
        disabled: busy,
        testId: `btn-${testIdPrefix}-attach-camera`,
      });
    }
    builtinActions.push({
      id: "file",
      label: PLUS_TILE_LABELS.file,
      icon: Paperclip,
      onClick: () => fileInputRef.current?.click(),
      disabled: busy,
      testId: `btn-${testIdPrefix}-attach-file`,
    });
  }
  if (onMeetingClick) {
    builtinActions.push({
      id: "meeting",
      label: PLUS_TILE_LABELS.meeting,
      icon: CalendarDays,
      onClick: () => {
        setPlusOpen(false);
        onMeetingClick();
      },
      disabled: busy,
      testId: `btn-${testIdPrefix}-meeting`,
    });
  }
  if (onMatchCallClick) {
    builtinActions.push({
      id: "matchCall",
      label: PLUS_TILE_LABELS.matchCall,
      icon: HeartHandshake,
      onClick: () => {
        setPlusOpen(false);
        onMatchCallClick();
      },
      disabled: busy,
      testId: `btn-${testIdPrefix}-match-call`,
    });
  }
  if (onDoctorCallClick) {
    builtinActions.push({
      id: "doctorCall",
      label: PLUS_TILE_LABELS.doctorCall,
      icon: Stethoscope,
      onClick: () => {
        setPlusOpen(false);
        onDoctorCallClick();
      },
      disabled: busy,
      testId: `btn-${testIdPrefix}-doctor-call`,
    });
  }
  if (onCostSheetClick) {
    builtinActions.push({
      id: "costSheet",
      label: PLUS_TILE_LABELS.costSheet,
      icon: Receipt,
      onClick: () => {
        setPlusOpen(false);
        onCostSheetClick();
      },
      disabled: busy,
      testId: `btn-${testIdPrefix}-cost-sheet`,
    });
  }
  if (onInvoiceClick) {
    builtinActions.push({
      id: "invoice",
      label: PLUS_TILE_LABELS.invoice,
      icon: DollarSign,
      onClick: () => {
        setPlusOpen(false);
        onInvoiceClick();
      },
      disabled: busy,
      testId: `btn-${testIdPrefix}-invoice`,
    });
  }
  if (onAgreementClick) {
    builtinActions.push({
      id: "agreement",
      label: PLUS_TILE_LABELS.agreement,
      icon: FileSignature,
      onClick: () => {
        setPlusOpen(false);
        onAgreementClick();
      },
      disabled: busy,
      testId: `btn-${testIdPrefix}-agreement`,
    });
  }
  const allActions: ChatPlusAction[] = [...builtinActions, ...(extraPlusActions || [])];
  const hasPlus = allActions.length > 0;

  return (
    <div className="border-t px-4 py-3 bg-background relative flex flex-col min-h-0" data-testid={`${testIdPrefix}-reply-area`}>
      {hasPlus && (
        <div className="absolute left-3 bottom-full mb-2 z-40 pointer-events-none">
          <div className={plusOpen && !inlinePanel ? "pointer-events-auto" : ""}>
            <ChatPlusDrawer open={plusOpen && !inlinePanel} actions={allActions} brandColor={brandColor} onDismiss={() => setPlusOpen(false)} />
          </div>
        </div>
      )}

      {senderLabel}

      {guardScan && <ContactGuardNotice scan={guardScan} className="mb-2" />}

      {inlinePanel && (
        <div
          className="mb-2 rounded-[var(--radius)] border bg-card p-3 min-h-0 overflow-y-auto overscroll-contain"
          data-testid={`${testIdPrefix}-inline-panel`}
        >
          {inlinePanel}
        </div>
      )}

      {stagedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {stagedFiles.map((file, i) => (
            <StagedFileChip
              key={i}
              file={file}
              onRemove={() => removeStagedFile(i)}
            />
          ))}
        </div>
      )}

      {enableFileUpload && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="application/pdf,.doc,.docx,.txt,.csv,.xlsx"
            multiple
            onChange={handleFileSelect}
            data-testid={`input-${testIdPrefix}-file`}
          />
          <input
            ref={photoInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            data-testid={`input-${testIdPrefix}-photo`}
          />
          <input
            ref={cameraInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            capture="environment"
            onChange={handleFileSelect}
            data-testid={`input-${testIdPrefix}-camera`}
          />
        </>
      )}

      <div className="flex items-center gap-2">
        {hasPlus && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-10 w-10 p-0 shrink-0 rounded-full border"
            style={{
              color: plusOpen ? "white" : brandColor,
              backgroundColor: plusOpen ? brandColor : `${brandColor}14`,
              borderColor: plusOpen ? brandColor : `${brandColor}40`,
            }}
            onMouseEnter={(e) => {
              if (!plusOpen) e.currentTarget.style.backgroundColor = `${brandColor}26`;
            }}
            onMouseLeave={(e) => {
              if (!plusOpen) e.currentTarget.style.backgroundColor = `${brandColor}14`;
            }}
            onClick={() => setPlusOpen((v) => !v)}
            disabled={busy}
            aria-label={plusOpen ? "Close actions" : "More actions"}
            data-plus-toggle="true"
            data-testid={`btn-${testIdPrefix}-plus`}
          >
            <Plus
              className="w-5 h-5 transition-transform duration-200"
              strokeWidth={2.5}
              style={{ transform: plusOpen ? "rotate(45deg)" : "rotate(0deg)" }}
            />
          </Button>
        )}
        {isUploading && (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        )}
        <Input
          placeholder={placeholder}
          value={text}
          onChange={(e) => { setText(e.target.value); if (guardScan) setGuardScan(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={busy}
          className="flex-1 !text-base font-ui rounded-full border-input shadow-sm"
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
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" strokeWidth={2.25} />}
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
    <div className="t-helper flex items-center gap-1.5 mb-2">
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
    <div className="t-helper flex items-center gap-1.5 mb-2">
      <Headphones className="w-3 h-3" />
      <span>Sending as <strong className="text-foreground">GoStork Expert</strong> - {adminName}</span>
    </div>
  );
}
