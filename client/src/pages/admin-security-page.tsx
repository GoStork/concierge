/**
 * /admin/security - cyber-security settings.
 *
 * The first resident is the per-country verification policy, born from the
 * production bot-signup wave: scripted accounts triggering verification SMS
 * to premium ranges abroad, each one billed to GoStork. The page manages the
 * exceptions (the world is allowed by default - families come from 125
 * countries) and shows the verification attempt log, so a burst is visible
 * as a burst rather than as next month's Twilio bill.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { countryCodeToFlag } from "@/lib/country-flag";
import { formatPhoneDisplay } from "@/lib/phone-countries";

interface CountryRow {
  isoCode: string;
  name: string;
  callingCode: string;
  policy: "ALLOWED" | "WHATSAPP_ONLY" | "BLOCKED";
  reason: string | null;
  isException: boolean;
  sent7d: number;
  blocked7d: number;
}

const POLICY_LABELS: Record<CountryRow["policy"], string> = {
  ALLOWED: "Allowed",
  WHATSAPP_ONLY: "WhatsApp only",
  BLOCKED: "Blocked",
};

/** Policy is a status: green / amber / red, never the service palette. */
const POLICY_TONE: Record<CountryRow["policy"], string> = {
  ALLOWED: "hsl(var(--brand-success))",
  WHATSAPP_ONLY: "hsl(var(--brand-warning))",
  BLOCKED: "hsl(var(--destructive))",
};

const OUTCOME_LABELS: Record<string, string> = {
  sent: "Sent",
  blocked_country: "Blocked - country",
  blocked_rate: "Blocked - rate limit",
  blocked_voip: "Blocked - VoIP",
  invalid: "Invalid number",
  failed: "Send failed",
};

export default function AdminSecurityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  // "exceptions" first: the point of the page is what is NOT default.
  const [view, setView] = useState<"exceptions" | "all">("exceptions");

  const { data: countryData, isLoading } = useQuery<{ countries: CountryRow[] }>({
    queryKey: ["/api/admin/security/countries"],
    queryFn: async () => {
      const res = await fetch("/api/admin/security/countries", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const { data: attemptData } = useQuery<{
    attempts: { id: string; phoneMasked: string; isoCode: string | null; ip: string | null; outcome: string; channel: string | null; createdAt: string }[];
    last24h: Record<string, number>;
  }>({
    queryKey: ["/api/admin/security/attempts"],
    queryFn: async () => {
      const res = await fetch("/api/admin/security/attempts", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const setPolicy = useMutation({
    mutationFn: async ({ iso, policy, reason }: { iso: string; policy: string; reason: string | null }) => {
      const res = await fetch(`/api/admin/security/countries/${iso}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy, reason }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save");
      return res.json();
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/security/countries"] });
      toast({ title: `${v.iso}: ${POLICY_LABELS[v.policy as CountryRow["policy"]]}` });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const countries = countryData?.countries || [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return countries.filter((c) => {
      if (view === "exceptions" && !c.isException && !needle) return false;
      if (!needle) return true;
      return c.name.toLowerCase().includes(needle)
        || c.isoCode.toLowerCase() === needle
        || c.callingCode.includes(needle);
    });
  }, [countries, q, view]);

  const last24h = attemptData?.last24h || {};
  const blocked24h = (last24h.blocked_country || 0) + (last24h.blocked_rate || 0) + (last24h.blocked_voip || 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display t-page-title text-primary" data-testid="text-page-title">Security</h1>
        <p className="text-muted-foreground">
          Who can verify a phone number, and every attempt to. The world is allowed by
          default - a row here is an exception for one country.
        </p>
      </div>

      {/* The day at a glance. Blocked-today in warning tone when non-zero:
          that number IS the feature working. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Codes sent, 24h", value: last24h.sent || 0, tone: null },
          { label: "Blocked, 24h", value: blocked24h, tone: blocked24h > 0 ? "hsl(var(--brand-warning))" : null },
          { label: "Blocked countries", value: countries.filter((c) => c.policy === "BLOCKED").length, tone: null },
          { label: "WhatsApp-only countries", value: countries.filter((c) => c.policy === "WHATSAPP_ONLY").length, tone: null },
        ].map((s) => (
          <div key={s.label} className="rounded-[var(--radius)] border bg-card p-4">
            <p className="t-helper">{s.label}</p>
            <p className="text-2xl font-medium" style={s.tone ? { color: s.tone } : undefined}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="t-section-title font-heading mr-auto">Country policy</h2>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search country or +code"
              className="pl-8 w-56 bg-card"
              data-testid="input-security-country-search"
            />
          </div>
          <Select value={view} onValueChange={(v) => setView(v as "exceptions" | "all")}>
            <SelectTrigger className="w-auto gap-1.5 bg-card px-2.5" data-testid="select-security-view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exceptions">Exceptions only</SelectItem>
              <SelectItem value="all">All countries</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : shown.length === 0 ? (
          <p className="t-helper py-4">
            {view === "exceptions"
              ? "No exceptions - every country verifies normally. Search to add one."
              : "No country matches that search."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="t-micro-label py-2 pr-3">Country</th>
                  <th className="t-micro-label py-2 pr-3">Code</th>
                  <th className="t-micro-label py-2 pr-3">Policy</th>
                  <th className="t-micro-label py-2 pr-3 hidden md:table-cell">Reason</th>
                  <th className="t-micro-label py-2 pr-3 whitespace-nowrap hidden sm:table-cell">7d sent / blocked</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.isoCode} className="border-t border-border/60" data-testid={`security-country-${c.isoCode}`}>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className="mr-1.5">{countryCodeToFlag(c.isoCode)}</span>{c.name}
                    </td>
                    <td className="py-2 pr-3 font-ui text-muted-foreground">{c.callingCode}</td>
                    <td className="py-2 pr-3">
                      <Select
                        value={c.policy}
                        onValueChange={(policy) => setPolicy.mutate({
                          iso: c.isoCode,
                          policy,
                          // Keep the existing note when tightening; an explicit
                          // Allowed clears the exception, note and all.
                          reason: policy === "ALLOWED" ? null : c.reason,
                        })}
                      >
                        <SelectTrigger
                          className="w-auto gap-1.5 bg-card px-2.5 h-8"
                          style={{ color: POLICY_TONE[c.policy] }}
                          data-testid={`select-policy-${c.isoCode}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALLOWED">Allowed</SelectItem>
                          <SelectItem value="WHATSAPP_ONLY">WhatsApp only</SelectItem>
                          <SelectItem value="BLOCKED">Blocked</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="py-2 pr-3 t-helper max-w-[320px] truncate hidden md:table-cell" title={c.reason || undefined}>
                      {c.reason || "-"}
                    </td>
                    <td className="py-2 pr-3 font-ui tabular-nums hidden sm:table-cell">
                      {c.sent7d} / <span style={c.blocked7d ? { color: "hsl(var(--brand-warning))" } : undefined}>{c.blocked7d}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3">
        <h2 className="t-section-title font-heading">Verification attempts</h2>
        {(attemptData?.attempts?.length ?? 0) === 0 ? (
          <p className="t-helper py-2">
            No attempts recorded yet. Every send, block and failure will appear here as it happens.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="t-micro-label py-2 pr-3">When</th>
                  <th className="t-micro-label py-2 pr-3">Phone</th>
                  <th className="t-micro-label py-2 pr-3">Country</th>
                  <th className="t-micro-label py-2 pr-3">Outcome</th>
                  <th className="t-micro-label py-2 pr-3 hidden sm:table-cell">IP</th>
                </tr>
              </thead>
              <tbody>
                {attemptData!.attempts.map((a) => {
                  const blocked = a.outcome.startsWith("blocked");
                  return (
                    <tr key={a.id} className="border-t border-border/60">
                      <td className="py-1.5 pr-3 whitespace-nowrap t-helper">
                        {new Date(a.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </td>
                      <td className="py-1.5 pr-3 font-ui">{formatPhoneDisplay(a.phoneMasked) || a.phoneMasked}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {a.isoCode ? <>{countryCodeToFlag(a.isoCode)} {a.isoCode}</> : "-"}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span
                          className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
                          style={blocked
                            ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
                            : a.outcome === "sent"
                              ? { background: "hsl(var(--brand-success) / 0.15)", color: "hsl(var(--brand-success))" }
                              : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}
                        >
                          {blocked && <ShieldAlert className="w-3 h-3" />}
                          {OUTCOME_LABELS[a.outcome] || a.outcome}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 font-ui t-helper hidden sm:table-cell">{a.ip || "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
