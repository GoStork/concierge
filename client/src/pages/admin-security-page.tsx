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
import { Cloud, Loader2, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  const { data: cf } = useQuery<{ ok: boolean; configured: boolean; message: string; blockedCount?: number }>({
    queryKey: ["/api/admin/security/cloudflare"],
    queryFn: async () => {
      const res = await fetch("/api/admin/security/cloudflare", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });
  const cfSync = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/security/cloudflare/sync", { method: "POST", credentials: "include" });
      return res.json();
    },
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/security/cloudflare"] });
      toast({ title: d.ok ? "Cloudflare synced" : "Sync failed", description: d.message, variant: d.ok ? undefined : "destructive" });
    },
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

  // Email allowlist - canonicals that may create unlimited aliases (test inboxes).
  const { data: allowData } = useQuery<{ allowlist: { canonicalEmail: string; note: string | null; createdAt: string }[] }>({
    queryKey: ["/api/admin/security/email-allowlist"],
    queryFn: async () => (await fetch("/api/admin/security/email-allowlist", { credentials: "include" })).json(),
  });
  const [newAllowEmail, setNewAllowEmail] = useState("");
  const addAllow = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch("/api/admin/security/email-allowlist", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/admin/security/email-allowlist"] }); setNewAllowEmail(""); },
    onError: (e: any) => toast({ title: "Could not add", description: e.message, variant: "destructive" }),
  });
  const removeAllow = useMutation({
    mutationFn: async (canonical: string) => {
      await fetch(`/api/admin/security/email-allowlist/${encodeURIComponent(canonical)}`, { method: "DELETE", credentials: "include" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/security/email-allowlist"] }),
  });

  // Per-IP signup cap: above this, a new signup is quarantined for review.
  const { data: settings } = useQuery<{ ipSignupCapPerDay: number }>({
    queryKey: ["/api/admin/security/settings"],
    queryFn: async () => (await fetch("/api/admin/security/settings", { credentials: "include" })).json(),
  });
  const [capDraft, setCapDraft] = useState<string>("");
  const saveCap = useMutation({
    mutationFn: async (cap: number) => {
      const res = await fetch("/api/admin/security/settings", {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ipSignupCapPerDay: cap }),
      });
      return res.json();
    },
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["/api/admin/security/settings"] }); toast({ title: `IP signup cap set to ${d.ipSignupCapPerDay}/day` }); },
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

      {/* The edge. Our gate stops the OTP; Cloudflare stops the visit. A
          block decided on this page is pushed there automatically - this card
          is the edge's own account of itself. */}
      <div className="rounded-[var(--radius)] border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Cloud className="w-5 h-5 shrink-0" style={{ color: cf?.ok ? "hsl(var(--brand-success))" : "hsl(var(--brand-warning))" }} />
          <div className="min-w-0 mr-auto">
            <p className="text-sm font-medium">Cloudflare edge blocking</p>
            <p className="t-helper">{cf?.message || "Checking..."}</p>
          </div>
          {cf?.configured && (
            <Button size="sm" variant="outline" className="bg-card" disabled={cfSync.isPending} onClick={() => cfSync.mutate()} data-testid="btn-cloudflare-sync">
              {cfSync.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Sync now
            </Button>
          )}
        </div>
      </div>

      {/* Signup protection: per-IP cap + the alias/test-inbox allowlist. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3">
          <h2 className="t-section-title font-heading">Signup rate</h2>
          <p className="t-helper">
            More than this many new accounts from one IP in a day gets the extra ones
            flagged for review (not blocked). A household makes 1-2; a script makes dozens.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              className="w-24 bg-card"
              value={capDraft !== "" ? capDraft : String(settings?.ipSignupCapPerDay ?? 5)}
              onChange={(e) => setCapDraft(e.target.value)}
              data-testid="input-ip-signup-cap"
            />
            <span className="t-helper">accounts / IP / day</span>
            <Button
              size="sm"
              variant="outline"
              className="bg-card ml-auto"
              disabled={saveCap.isPending || capDraft === "" || Number(capDraft) === settings?.ipSignupCapPerDay}
              onClick={() => saveCap.mutate(Math.max(1, parseInt(capDraft, 10) || 5))}
              data-testid="btn-save-ip-cap"
            >
              {saveCap.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>

        <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3">
          <h2 className="t-section-title font-heading">Email allowlist</h2>
          <p className="t-helper">
            Addresses here may create unlimited aliases (<code>+tag</code>, dots) - for staff
            test inboxes. Everyone else gets one account per mailbox; disposable domains are refused.
          </p>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (newAllowEmail.trim()) addAllow.mutate(newAllowEmail.trim()); }}
          >
            <Input
              type="email"
              placeholder="name@gmail.com"
              className="bg-card"
              value={newAllowEmail}
              onChange={(e) => setNewAllowEmail(e.target.value)}
              data-testid="input-allowlist-email"
            />
            <Button size="sm" type="submit" variant="outline" className="bg-card shrink-0" disabled={addAllow.isPending || !newAllowEmail.trim()} data-testid="btn-add-allowlist">
              {addAllow.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}
            </Button>
          </form>
          <div className="space-y-1.5">
            {(allowData?.allowlist || []).length === 0 ? (
              <p className="t-helper">No allowlisted addresses.</p>
            ) : (
              (allowData?.allowlist || []).map((a) => (
                <div key={a.canonicalEmail} className="flex items-center gap-2 text-sm rounded-md bg-secondary px-2.5 py-1.5">
                  <span className="font-mono text-xs mr-auto truncate" title={a.note || undefined}>{a.canonicalEmail}</span>
                  <button
                    type="button"
                    className="t-helper hover:text-destructive transition-colors"
                    onClick={() => removeAllow.mutate(a.canonicalEmail)}
                    data-testid={`btn-remove-allowlist-${a.canonicalEmail}`}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
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
