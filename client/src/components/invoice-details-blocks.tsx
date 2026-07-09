/**
 * Shared expanded-row blocks for invoice tables.
 *
 * Used by the GoStork admin Billing Dashboard and the provider Invoices /
 * Payouts pages - one implementation so the "who is this parent" card and
 * the invoice metadata list never drift between the three tables. Actions
 * (mark as paid, copy payment link, open chat, ...) stay page-specific and
 * are rendered by the caller next to these blocks.
 */
import { Mail, Phone } from "lucide-react";

export function ParentInfoBlock({ parentUser }: { parentUser: any }) {
  const otherMembers = ((parentUser?.parentAccount?.members || []) as any[]).filter(
    (m: any) => m.id !== parentUser?.id,
  );
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Parent</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-muted-foreground">
        <span>Name</span>
        <span className="text-foreground">
          {[parentUser?.firstName, parentUser?.lastName].filter(Boolean).join(" ") || parentUser?.name || "-"}
        </span>
        <span>Email</span>
        <span>
          {parentUser?.email ? (
            <a href={`mailto:${parentUser.email}`} className="inline-flex items-center gap-1 underline text-foreground">
              <Mail className="w-3 h-3" />{parentUser.email}
            </a>
          ) : "-"}
        </span>
        <span>Phone</span>
        <span>
          {(parentUser?.mobileNumberDisplay || parentUser?.mobileNumber) ? (
            <a
              href={`tel:${parentUser.mobileNumber || parentUser.mobileNumberDisplay}`}
              className="inline-flex items-center gap-1 underline text-foreground"
            >
              <Phone className="w-3 h-3" />{parentUser.mobileNumberDisplay || parentUser.mobileNumber}
            </a>
          ) : "-"}
        </span>
        {parentUser?.createdAt && (
          <><span>Member since</span><span>{new Date(parentUser.createdAt).toLocaleDateString()}</span></>
        )}
        {otherMembers.length > 0 && (
          <>
            <span>Also on account</span>
            <span>{otherMembers.map((m: any) => m.name || m.email).join(", ")}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function InvoiceInfoBlock({ inv, showAdminFields = false }: { inv: any; showAdminFields?: boolean }) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Invoice Details</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-muted-foreground">
        <span>Invoice ID</span><span className="font-mono text-xs">{inv.id}</span>
        <span>Session ID</span><span className="font-mono text-xs">{inv.sessionId}</span>
        {inv.description && <><span>Description</span><span>{inv.description}</span></>}
        {inv.dueAt && !inv.paidAt && <><span>Due</span><span>{new Date(inv.dueAt).toLocaleString()}</span></>}
        {inv.paidAt && <><span>Paid At</span><span>{new Date(inv.paidAt).toLocaleString()}</span></>}
        {inv.payoutInitiatedAt && <><span>Payout Initiated</span><span>{new Date(inv.payoutInitiatedAt).toLocaleString()}</span></>}
        {inv.payoutCompletedAt && <><span>Payout Completed</span><span>{new Date(inv.payoutCompletedAt).toLocaleString()}</span></>}
        {showAdminFields && inv.manualOverride && <><span>Override</span><span className="text-orange-500">Manual</span></>}
        {showAdminFields && inv.adminNotes && <><span>Notes</span><span>{inv.adminNotes}</span></>}
      </div>
    </div>
  );
}
