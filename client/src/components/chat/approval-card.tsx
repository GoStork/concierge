import { type ReactNode } from "react";
import { Check, X, Pencil, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoneyCents } from "@/lib/format-money";

// Reusable provider-side approval card. Phase 2 uses it for cost sheet
// auto-drafts; Phase 3 will reuse for invoice drafts; Phase 4 for
// agreement drafts. Pure brand variables, no hardcoded colors.

export interface ApprovalCardLineItem {
  label: string;
  amountCents: number;
  editable?: boolean;
  source?: string;
  // Zero-amount items covered by the package price - rendered as
  // "Included" (mirrors the donor-profile Costs section).
  includedInPackage?: boolean;
  // Items the cost sheet marks as NOT covered - rendered grayed under a
  // "Not included" divider, never counted in the total.
  excluded?: boolean;
}

export interface ApprovalCardAttachOption {
  fileName: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface ApprovalCardMetadata {
  label: string;
  value: string;
}

export interface ApprovalCardProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  amountCents?: number;
  lineItems?: ApprovalCardLineItem[];
  notes?: string | null;
  metadata?: ApprovalCardMetadata[];
  status: "pending" | "approved" | "rejected";
  resolvedLabel?: string;
  onApprove?: () => void;
  onEdit?: () => void;
  onReject?: () => void;
  isSubmitting?: boolean;
  testId: string;
  // Optional "attach original document" checkbox shown above the action
  // buttons while pending (cost-sheet PDF attach, Phase 2).
  attachOption?: ApprovalCardAttachOption;
}

export function ApprovalCard({
  title,
  subtitle,
  icon,
  amountCents,
  lineItems,
  notes,
  metadata,
  status,
  resolvedLabel,
  onApprove,
  onEdit,
  onReject,
  isSubmitting,
  testId,
  attachOption,
}: ApprovalCardProps) {
  const isPending = status === "pending";
  const isApproved = status === "approved";
  const includedItems = (lineItems || []).filter(li => !li.excluded);
  const excludedItems = (lineItems || []).filter(li => li.excluded);

  return (
    <Card
      className="border-border bg-card text-card-foreground max-w-2xl"
      data-testid={testId}
    >
      <CardHeader className="bg-secondary/40 rounded-t-[var(--radius)] px-4 py-3 border-b border-border">
        <div className="flex items-start gap-3">
          {icon && (
            <div className="flex-shrink-0 mt-0.5 text-foreground">{icon}</div>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm" style={{ fontFamily: "var(--font-display)" }}>
              {title}
            </div>
            {subtitle && (
              <div className="t-helper mt-0.5">{subtitle}</div>
            )}
          </div>
          {!isPending && (
            <span
              className={
                isApproved
                  ? "text-xs font-medium text-[hsl(var(--brand-success))] bg-[hsl(var(--brand-success))]/10 px-2 py-0.5 rounded-full whitespace-nowrap"
                  : "text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full whitespace-nowrap"
              }
            >
              {resolvedLabel || (isApproved ? "Sent" : "Dismissed")}
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="px-4 py-3 space-y-3">
        {typeof amountCents === "number" && amountCents > 0 && (
          <div className="text-2xl font-semibold text-foreground" style={{ fontFamily: "var(--font-display)" }}>
            {formatMoneyCents(amountCents)}
          </div>
        )}

        {includedItems.length > 0 && (
          <div className="space-y-1 text-sm">
            {includedItems.map((li, idx) => (
              <div key={idx} className="flex justify-between gap-3">
                <span className="text-foreground">{li.label}</span>
                {li.includedInPackage ? (
                  <span className="text-muted-foreground">Included</span>
                ) : (
                  <span className="text-foreground tabular-nums">{formatMoneyCents(li.amountCents || 0)}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Excluded items - shown for transparency (what the price does
            NOT cover), grayed, never in the total. Mirrors the donor
            profile's Costs section. */}
        {excludedItems.length > 0 && (
          <div className="border-t border-border pt-2">
            <p className="t-micro-label mb-1">Not included</p>
            <div className="space-y-1 text-sm">
              {excludedItems.map((li, idx) => (
                <div key={idx} className="flex justify-between gap-3 text-muted-foreground/70">
                  <span>{li.label}</span>
                  <span className="tabular-nums">{formatMoneyCents(li.amountCents || 0)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Attach-original-document checkbox (pending only). */}
        {isPending && attachOption && (
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none border-t border-border pt-2">
            <input
              type="checkbox"
              checked={attachOption.checked}
              onChange={e => attachOption.onChange(e.target.checked)}
              className="accent-[hsl(var(--primary))]"
              data-testid={`${testId}-attach-file`}
            />
            Attach original cost sheet ({attachOption.fileName})
          </label>
        )}

        {notes && (
          <div className="t-helper bg-muted/40 rounded-[var(--radius)] px-3 py-2 whitespace-pre-wrap">
            {notes}
          </div>
        )}

        {Array.isArray(metadata) && metadata.length > 0 && (
          <div className="border-t border-border pt-2 space-y-0.5">
            {metadata.map((m, idx) => (
              <div key={idx} className="t-helper flex justify-between gap-3">
                <span>{m.label}</span>
                <span>{m.value}</span>
              </div>
            ))}
          </div>
        )}

        {isPending && (
          <div className="flex flex-wrap gap-2 pt-1">
            {onApprove && (
              <Button
                type="button"
                size="sm"
                onClick={onApprove}
                disabled={isSubmitting}
                className="gap-1.5"
                data-testid={`${testId}-approve`}
              >
                {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Approve & Send
              </Button>
            )}
            {onEdit && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onEdit}
                disabled={isSubmitting}
                className="gap-1.5"
                data-testid={`${testId}-edit`}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            )}
            {onReject && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onReject}
                disabled={isSubmitting}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                data-testid={`${testId}-reject`}
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
