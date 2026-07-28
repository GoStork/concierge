import { ShieldAlert } from "lucide-react";
import type { ContactScanResult } from "@shared/contact-guard";
import { contactGuardMessage } from "@shared/contact-guard";

/**
 * Inline notice shown when a message is held back for carrying contact details
 * or an off-platform link.
 *
 * Inline and not a toast or a dialog, for three reasons: modals are banned
 * app-wide (they do not translate to the native apps), a toast disappears
 * before the sender can actually fix the text, and the notice needs to sit
 * directly above the composer holding the message it is about.
 *
 * One component, both composers - the provider/admin ChatInputBar and the
 * parent's own textarea - so the wording and the styling cannot drift apart.
 */
export function ContactGuardNotice({
  scan,
  message,
  className = "",
}: {
  /** Result from detectContactInfo, client-side. */
  scan?: ContactScanResult | null;
  /** Server-supplied copy, when the 422 came back instead. Wins over `scan`. */
  message?: string | null;
  className?: string;
}) {
  const text = message || (scan ? contactGuardMessage(scan.kinds) : null);
  if (!text) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="contact-guard-notice"
      className={`flex items-start gap-2 rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.4)] bg-[hsl(var(--brand-warning)/0.08)] px-3 py-2.5 ${className}`}
    >
      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-[hsl(var(--brand-warning))]" />
      <p className="t-helper text-foreground/90 m-0">{text}</p>
    </div>
  );
}
