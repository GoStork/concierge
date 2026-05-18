import { Lock } from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon?: React.ReactNode }> = {
  AWAITING_PAYMENT: { label: "Awaiting Payment", color: "hsl(var(--brand-warning))", bg: "hsl(var(--brand-warning) / 0.1)"  },
  AUTHORIZED:       { label: "Funds Held",        color: "hsl(var(--brand-warning))", bg: "hsl(var(--brand-warning) / 0.1)", icon: <Lock className="w-3 h-3" /> },
  PAID:             { label: "Paid",              color: "hsl(var(--brand-success))", bg: "hsl(var(--brand-success) / 0.1)" },
  CLEARANCE_FAILED: { label: "Clearance Failed",  color: "hsl(var(--brand-error))",   bg: "hsl(var(--brand-error) / 0.1)"  },
  EXPIRED:          { label: "Expired",           color: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted) / 0.5)"      },
  CANCELLED:        { label: "Cancelled",         color: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted) / 0.5)"      },
  REFUNDED:         { label: "Refunded",          color: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted) / 0.5)"      },
};

interface InvoiceStatusBadgeProps {
  status: string;
  className?: string;
}

export function InvoiceStatusBadge({ status, className = "" }: InvoiceStatusBadgeProps) {
  const config = STATUS_CONFIG[status] || { label: status, color: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted) / 0.5)" };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${className}`}
      style={{ color: config.color, background: config.bg }}
    >
      {config.icon}
      {config.label}
    </span>
  );
}
