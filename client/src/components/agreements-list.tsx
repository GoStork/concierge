import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, FileSignature } from "lucide-react";
import { useNavigate } from "react-router-dom";

// Shared agreement status badge + row list. Used by the provider Documents
// tab, the provider Billing > Agreements tab, and the parent Billing >
// Agreements tab - one renderer so status colors and row layout never drift.

export function agreementStatusBadge(status: string) {
  switch (status) {
    case "SIGNED":
      return (
        <Badge className="bg-[hsl(var(--brand-success)/0.15)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)] border">
          Signed
        </Badge>
      );
    case "SENT":
      return (
        <Badge variant="outline" className="text-[hsl(var(--foreground)/0.7)]">
          Sent - Awaiting Signature
        </Badge>
      );
    case "REJECTED":
      return (
        <Badge className="bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)] border">
          Rejected
        </Badge>
      );
    case "EXPIRED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Expired
        </Badge>
      );
    case "CREATED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Created - Not Sent
        </Badge>
      );
    case "ERROR":
      return (
        <Badge className="bg-destructive/10 text-destructive border-destructive/30 border">
          Error
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export interface AgreementListItem {
  id: string;
  status: string;
  documentType: string;
  createdAt: string;
  signedAt?: string | null;
  /** Who/what the row is about: the parent's name (provider view) or the provider's name (parent view). */
  title: string;
  /** Optional signer progress, e.g. "1/2 signed" - shown next to the status badge. */
  progressLabel?: string | null;
}

export function AgreementRows({
  items,
  emptyText = "No agreements yet.",
  isLoading = false,
}: {
  items: AgreementListItem[];
  emptyText?: string;
  isLoading?: boolean;
}) {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-12 bg-muted rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="py-10 text-center space-y-2">
        <FileSignature className="w-8 h-8 mx-auto text-muted-foreground/50" />
        <p className="t-helper">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {items.map(item => (
        <div key={item.id} className="flex items-center gap-4 py-3" data-testid={`agreement-row-${item.id}`}>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.title}</p>
            <p className="t-helper">
              {item.documentType} - {new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {item.signedAt && ` - Signed ${new Date(item.signedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
            </p>
          </div>
          {item.progressLabel && (
            <span className="text-xs font-medium shrink-0" style={{ color: "hsl(var(--brand-warning))" }}>
              {item.progressLabel}
            </span>
          )}
          <div className="shrink-0">{agreementStatusBadge(item.status)}</div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => navigate(`/agreements/${item.id}`)}
            aria-label="Open agreement"
          >
            <ExternalLink className="w-4 h-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
