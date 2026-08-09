import { cn } from "@/lib/utils";
import { Check, Clock, X } from "lucide-react";

/**
 * THE service tag. One hue per service line, platform-wide - every table
 * cell, ladder label, profile chip and filter that names a service renders
 * through this component, so the identity can never drift again. The hues
 * live in index.css (--service-*); green/amber/red stay reserved for STATUS
 * (approved / warning / canceled), which is why approval renders as a small
 * check INSIDE the tag rather than dyeing the whole chip green.
 *
 * Accepts raw strings from anywhere in the product ("egg_donation",
 * "Egg Donor Agency", "EGG DONATION", "Fertility Clinic", ...) - the
 * normalizer maps them all onto five canonical keys. Unknown strings render
 * as a neutral chip rather than throwing, so a new service degrades
 * gracefully until it is added here.
 */

export type ServiceKey =
  | "surrogacy" | "egg_donation" | "sperm_donation" | "ivf" | "legal";

const CANON: Record<ServiceKey, { label: string; cssVar: string }> = {
  surrogacy:      { label: "Surrogacy",      cssVar: "--service-surrogacy" },
  egg_donation:   { label: "Egg Donation",   cssVar: "--service-egg-donation" },
  sperm_donation: { label: "Sperm Donation", cssVar: "--service-sperm-donation" },
  ivf:            { label: "IVF",            cssVar: "--service-ivf" },
  legal:          { label: "Legal",          cssVar: "--service-legal" },
};

/** Raw product strings -> canonical service key. Case/format insensitive. */
export function normalizeServiceKey(raw: string | null | undefined): ServiceKey | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (s.includes("surrogate") || s.includes("surrogacy")) return "surrogacy";
  // Banks are NOT their own service: a sperm bank is sperm donation, an egg
  // bank is egg donation (frozen is a sub-type, not a category). So "Egg
  // Bank" deliberately falls through to egg donation here - the opposite of
  // the original rule, which gave banks a separate "Donor Bank" identity the
  // family never actually shops for.
  if (s.includes("egg")) return "egg_donation";
  if (s.includes("sperm")) return "sperm_donation";
  if (s.includes("ivf") || s.includes("clinic") || s.includes("doctor") || s.includes("fertility")) return "ivf";
  if (s.includes("legal") || s.includes("law")) return "legal";
  return null;
}

export function ServiceTag({
  service,
  label,
  size = "sm",
  approved,
  className,
  title,
  onClick,
  testId,
}: {
  /** Any raw service string the product holds - normalized internally. */
  service: string | null | undefined;
  /** Override the display text (e.g. spell out "IVF Clinic"). */
  label?: string;
  /** sm = table/ladder density; md = profile/header density. */
  size?: "sm" | "md";
  /** true = green check inside the tag; "pending" = amber clock; "declined" = red X. */
  approved?: boolean | "pending" | "declined";
  className?: string;
  title?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const key = normalizeServiceKey(service);
  const meta = key ? CANON[key] : null;
  const text = label ?? meta?.label ?? String(service ?? "");
  if (!text) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wide whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
        !meta && "bg-secondary text-foreground/70",
        onClick && "cursor-pointer hover:opacity-80 transition-opacity",
        className,
      )}
      style={meta ? {
        background: `hsl(var(${meta.cssVar}) / 0.13)`,
        color: `hsl(var(${meta.cssVar}))`,
      } : undefined}
      title={title}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      data-testid={testId}
    >
      {text}
      {approved === true && <Check className="w-3 h-3" style={{ color: "hsl(var(--brand-success))" }} aria-label="Approved" />}
      {approved === "pending" && <Clock className="w-3 h-3" style={{ color: "hsl(var(--brand-warning))" }} aria-label="Pending" />}
      {approved === "declined" && <X className="w-3 h-3" style={{ color: "hsl(var(--destructive))" }} aria-label="Declined" />}
    </span>
  );
}

/**
 * The quiet variant: a 6px dot in the service color, for text-adjacent spots
 * where a full pill is too loud (dropdown menus, dense filter legends).
 * Renders nothing for unknown services rather than a mystery-colored dot.
 */
export function ServiceDot({ service, className }: { service: string | null | undefined; className?: string }) {
  const key = normalizeServiceKey(service);
  if (!key) return null;
  return (
    <span
      className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", className)}
      style={{ background: `hsl(var(${CANON[key].cssVar}))` }}
      aria-hidden
    />
  );
}

/**
 * The service filter's options, in the enum vocabulary the tables filter on.
 * Kept beside CANON so a new service shows up in the filters automatically.
 */
export const SERVICE_FILTER_OPTIONS: [string, string][] = [
  ["SURROGACY", "Surrogacy"],
  ["EGG_DONATION", "Egg Donation"],
  ["SPERM_DONATION", "Sperm Donation"],
  ["IVF_CLINIC", "IVF Clinic"],
];

/** Map a ProviderService status enum onto the tag's approval icon. */
export function serviceApprovalIcon(status: string | null | undefined): boolean | "pending" | "declined" | undefined {
  if (status === "APPROVED") return true;
  if (status === "IN_PROGRESS") return "pending";
  if (status === "DECLINED") return "declined";
  return undefined;   // NEW: the bare tag, no state icon yet
}
