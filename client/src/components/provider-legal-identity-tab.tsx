/**
 * Provider Legal Identity tab - shown at /account/legal-identity.
 *
 * Single source of truth for the "who is this business legally" answer
 * that powers receipt PDFs (Issued By + Tax ID footer), Stripe Connect
 * KYC (Custom path), and the W-9 itself. Fields auto-fill when the
 * provider's W-9 is signed in PandaDoc; manual edits always win.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, Building2, User as UserIcon, Sparkles, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-bar";
import { ProviderW9Section } from "./provider-w9-section";
import { W9TemplateConfig } from "./w9-template-config";
import { AdminW9Table } from "./admin-w9-table";
import { GostorkAgreementCard } from "./gostork-agreement-card";
import { AdminProviderAgreements } from "./admin-provider-agreements";
import { useAuth } from "@/hooks/use-auth";
import { ALL_COUNTRIES, POPULAR_COUNTRIES } from "@/lib/phone-countries";
import { isUsEntity, taxIdLabelFor, taxFormFor, TAX_FORM_LABELS, payoutRailFor } from "@shared/payout-countries";

interface LegalIdentityState {
  id: string;
  providerId: string;
  legalName: string | null;
  businessName: string | null;
  businessUrl: string | null;
  taxClassification: string | null;
  businessType: string | null;
  taxId: string | null;
  taxIdType: string | null;
  businessAddressLine1: string | null;
  businessAddressLine2: string | null;
  businessAddressCity: string | null;
  businessAddressState: string | null;
  businessAddressPostalCode: string | null;
  businessAddressCountry: string | null;
  source: "MANUAL" | "W9_AUTO_FILL" | "MIGRATED_FROM_BRAND_SETTINGS";
  /** Provider display name (Company tab) - used as the placeholder example. */
  companyName: string | null;
  lastW9SyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const TAX_CLASSIFICATIONS = [
  { value: "INDIVIDUAL_SOLE_PROPRIETOR", label: "Individual / Sole proprietor" },
  { value: "C_CORPORATION", label: "C Corporation" },
  { value: "S_CORPORATION", label: "S Corporation" },
  { value: "PARTNERSHIP", label: "Partnership" },
  { value: "TRUST_ESTATE", label: "Trust / Estate" },
  { value: "LLC", label: "LLC" },
  { value: "OTHER", label: "Other" },
];

interface ProviderLegalIdentityTabProps {
  /** Provider ID - admin mode passes a different provider's ID; provider mode reads from session. */
  providerId?: string;
  mode?: "provider" | "admin";
}

export function ProviderLegalIdentityTab({ providerId, mode = "provider" }: ProviderLegalIdentityTabProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdminUser = !!(user as any)?.roles?.includes?.("GOSTORK_ADMIN");
  const isAdmin = mode === "admin" || isAdminUser;
  const effectiveProviderId = providerId || (user as any)?.providerId;

  // When a GoStork admin lands on /account/legal-identity (no explicit
  // providerId prop - that only comes from the admin provider edit page),
  // they're here to manage the GLOBAL W-9 PandaDoc template - the one
  // GoStork sends out to every provider for signature. No per-provider
  // identity form to render, just the template config. Admin users may
  // carry a providerId (the GoStork house provider row); that link must
  // NOT drop them into the per-provider identity form here.
  const isGlobalAdminView = isAdminUser && !providerId;

  const getUrl = mode === "admin" && providerId
    ? `/api/admin/providers/${providerId}/legal-identity`
    : `/api/provider/legal-identity`;
  const putUrl = getUrl;

  // W-9 status - same query key as ProviderW9Section (deduped by react-query).
  // Used to keep polling the identity row for a short window after the W-9
  // completes, because the PandaDoc webhook auto-fill lands ~1s after the
  // completion and a page loaded in between shows stale empty fields.
  const w9StatusUrl = isAdmin && effectiveProviderId
    ? `/api/admin/providers/${effectiveProviderId}/w9`
    : `/api/provider/w9`;
  const { data: w9Status } = useQuery<{ status: string; completedAt: string | null }>({
    queryKey: [w9StatusUrl],
    queryFn: async () => {
      const res = await fetch(w9StatusUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load W-9 status");
      return res.json();
    },
    enabled: !isGlobalAdminView && !!effectiveProviderId,
  });

  const { data: state, isLoading } = useQuery<LegalIdentityState>({
    queryKey: [getUrl],
    queryFn: async () => {
      const res = await fetch(getUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load legal identity");
      return res.json();
    },
    enabled: !isGlobalAdminView,
    // Poll while a freshly-completed W-9 hasn't been auto-filled into the
    // row yet (webhook race). Stops as soon as lastW9SyncAt catches up, and
    // never polls for completions older than 5 minutes - the manual "Sync
    // from W-9" button covers a genuinely missed webhook.
    refetchInterval: query => {
      if (w9Status?.status !== "COMPLETED" || !w9Status.completedAt) return false;
      const completedAt = new Date(w9Status.completedAt).getTime();
      if (Date.now() - completedAt > 5 * 60 * 1000) return false;
      const row = query.state.data;
      const syncedAt = row?.lastW9SyncAt ? new Date(row.lastW9SyncAt).getTime() : 0;
      return syncedAt >= completedAt ? false : 3000;
    },
  });

  // Form state - seeded from server, written back on save.
  const [legalName, setLegalName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessUrl, setBusinessUrl] = useState("");
  const [taxClassification, setTaxClassification] = useState("");
  const [taxId, setTaxId] = useState("");
  const [taxIdType, setTaxIdType] = useState<"ssn" | "ein" | "foreign">("ein");
  // Country of the legal entity. Drives everything below: which IRS form
  // (W-9 vs W-8BEN-E), how the tax ID is labelled/validated, the address
  // shape, and which payout rail the Payouts page offers.
  const [country, setCountry] = useState("US");
  const [addrLine1, setAddrLine1] = useState("");
  const [addrLine2, setAddrLine2] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrState, setAddrState] = useState("");
  const [addrPostal, setAddrPostal] = useState("");

  useEffect(() => {
    if (!state) return;
    setLegalName(state.legalName || "");
    setBusinessName(state.businessName || "");
    setBusinessUrl(state.businessUrl || "");
    setTaxClassification(state.taxClassification || "");
    setTaxId(state.taxId || "");
    const c = (state.businessAddressCountry || "US").toUpperCase();
    setCountry(c);
    setTaxIdType((state.taxIdType as "ssn" | "ein" | "foreign") || (c === "US" ? "ein" : "foreign"));
    setAddrLine1(state.businessAddressLine1 || "");
    setAddrLine2(state.businessAddressLine2 || "");
    setAddrCity(state.businessAddressCity || "");
    setAddrState(state.businessAddressState || "");
    setAddrPostal(state.businessAddressPostalCode || "");
  }, [state?.id, state?.lastW9SyncAt, state?.updatedAt]);

  // "I have a US entity" (Payouts page): tax machinery behaves as US - the
  // W-9 with the US entity's EIN - while the address stays the real one.
  const usPayoutEntity = !!(state as any)?.usPayoutEntity;
  const isUs = isUsEntity(country) || usPayoutEntity;
  const taxForm = TAX_FORM_LABELS[usPayoutEntity ? "W9" : taxFormFor(country)];
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!legalName.trim()) throw new Error("Legal name is required.");
      if (!businessName.trim()) throw new Error("Legal business name is required - it's used on receipts and Stripe Connect KYC. For LLCs/Corps, this usually matches the Legal name above.");
      if (!businessUrl.trim()) throw new Error("Business website URL is required - Stripe Connect won't accept payouts without it. Pre-filled from the Company tab if you've set one there.");
      const res = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          legalName: legalName.trim() || null,
          businessName: businessName.trim() || null,
          businessUrl: businessUrl.trim() || null,
          taxClassification: taxClassification || null,
          taxId: taxId.trim() || null,
          taxIdType: isUs ? taxIdType : "foreign",
          businessAddressLine1: addrLine1.trim() || null,
          businessAddressLine2: addrLine2.trim() || null,
          businessAddressCity: addrCity.trim() || null,
          businessAddressState: (isUs ? addrState.trim().toUpperCase() : addrState.trim()) || null,
          businessAddressPostalCode: addrPostal.trim() || null,
          businessAddressCountry: country,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [getUrl] });
    },
  });

  // Manual W-9 sync trigger. Sent with force=true: the user explicitly
  // clicked the button asking to pull values from the W-9, so this
  // OVERWRITES any existing field values that the W-9 has data for. The
  // automatic PandaDoc webhook path on the backend still uses force=false
  // so an admin's manual corrections don't get clobbered when a new W-9
  // is signed.
  const syncMutation = useMutation({
    mutationFn: async () => {
      const url = mode === "admin" && providerId
        ? `/api/admin/providers/${providerId}/legal-identity/sync-from-w9`
        : `/api/provider/legal-identity/sync-from-w9`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Sync failed");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [getUrl] }),
  });

  const confirm = useConfirm();
  const onSyncClick = async () => {
    const ok = await confirm({
      title: "Overwrite legal details from W-9?",
      message: "This replaces Legal Name, Business Name, Tax Classification, Tax ID, and Address with whatever's on the signed W-9. Manual edits will be lost.",
      confirmLabel: "Overwrite from W-9",
      tone: "warning",
    });
    if (ok) syncMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isW9AutoFilled = state?.source === "W9_AUTO_FILL";

  // ── Global-admin view: only the W-9 template config ─────────────────────
  // When a GoStork admin opens /account/legal-identity (their own user
  // page, no providerId), they're here to manage the global W-9 PandaDoc
  // template, NOT to edit their own legal identity (admins aren't
  // providers). Render just that.
  if (isGlobalAdminView) {
    return (
      <div className="space-y-6">
        <header>
          <h2 className="text-2xl font-heading">Tax forms (W-9 / W-8BEN-E)</h2>
          <p className="t-helper mt-1">
            GoStork-wide W-9 and W-8BEN-E template configuration and per-provider tracking. Per-provider
            legal details are edited on each provider's admin page
            (<code className="text-xs bg-muted px-1 rounded">/admin/providers/:id</code> → Legal tab).
          </p>
        </header>
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <div>
            <h3 className="font-semibold">W-9 PandaDoc template</h3>
            <p className="t-helper mt-0.5">
              Upload the master W-9 template that gets sent to every provider for signature.
              Configure the field IDs (Full_Name, Company_Name, RadioButtons1, Address,
              City_State_zipcode, SSN, EIN) so signed W-9s auto-fill into each provider's
              Legal tab.
            </p>
          </div>
          <W9TemplateConfig />
        </section>
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <div>
            <h3 className="font-semibold">W-8BEN-E PandaDoc template (non-US providers)</h3>
            <p className="t-helper mt-0.5">
              Foreign entities (Mexico, Colombia, Ukraine, Cyprus...) cannot sign a W-9 - US tax law
              has them certify foreign status on a W-8BEN-E instead. Upload that form here; a provider
              whose Legal tab country is not the US is sent this template automatically.
            </p>
          </div>
          <W9TemplateConfig formType="W8BENE" />
        </section>
        <AdminW9Table />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-heading">Legal</h2>
          <p className="t-helper mt-1">
            {isAdmin
              ? "This provider's legal name, tax ID, and address. Used on payment receipts, the W-9, and Stripe Connect KYC for payouts."
              : "Your business's legal name, tax ID, and address. Used on payment receipts, the W-9, and Stripe Connect KYC for payouts."}
            {isW9AutoFilled && state?.lastW9SyncAt && (
              <span className="block mt-1 text-xs" style={{ color: "hsl(var(--brand-success))" }}>
                <Sparkles className="w-3 h-3 inline mr-1" />
                Auto-filled from {isAdmin ? "the provider's" : "your"} signed W-9 on {new Date(state.lastW9SyncAt).toLocaleDateString()}.
                {isAdmin ? "" : " You can override any field below."}
              </span>
            )}
          </p>
        </div>
        {isUs && <Button
          variant="outline"
          size="sm"
          className="bg-card"
          disabled={syncMutation.isPending}
          onClick={onSyncClick}
          title="Overwrite fields with the values from the signed W-9"
        >
          {syncMutation.isPending
            ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
          Sync from W-9
        </Button>}
      </header>
      {syncMutation.isSuccess && (
        <p className="text-xs" style={{ color: "hsl(var(--brand-success))" }}>
          {(() => {
            const d = syncMutation.data as any;
            if (d?.status === "applied") return `Applied ${d.appliedFields?.length || 0} field(s) from W-9.`;
            if (d?.status === "noop") return `No changes - ${d.reason}.`;
            return "Sync complete.";
          })()}
        </p>
      )}
      {syncMutation.isError && (
        <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(syncMutation.error as Error).message}</p>
      )}

      {/* The GoStork Provider Service Agreement - FIRST on Legal: signing it
          is the journey's first task, ahead of the W-9. Provider self-view:
          sign while it waits on them, open/download/share once executed.
          Admin viewing a provider: the send + track table locked to this
          provider (the onboarding checklist's "Send provider agreement" step
          deep-links here). GoStork's own global send/track table stays on
          the admin Agreements tab. */}
      {!isAdmin && <div data-onb-anchor="gostork-agreement"><GostorkAgreementCard /></div>}
      {isAdmin && providerId && <AdminProviderAgreements fixedProviderId={providerId} />}

      {/* W-9 section - moved out of Billing tab. Self-contained component
          owns its own status query + send/fill/resubmit mutations. */}
      {effectiveProviderId && (
        <section className="space-y-3 rounded-xl border bg-card p-5" data-onb-anchor="w9-section">
          <div>
            <h3 className="font-semibold">{taxForm} Form</h3>
            <p className="t-helper mt-0.5">
              {isUs
                ? "Required by US tax law for any provider receiving payments. When you sign it via PandaDoc, the fields below auto-fill from the form."
                : "Required by US tax law for any NON-US business receiving payments from a US company (it certifies your foreign status - no US tax ID needed). Sign it via PandaDoc."}
            </p>
          </div>
          <ProviderW9Section providerId={effectiveProviderId} mode={isAdmin ? "admin" : "provider"} formType={usPayoutEntity ? "W9" : taxFormFor(country)} />
        </section>
      )}

      {/* Identity form */}
      <section className="space-y-4 rounded-xl border bg-card p-5" data-onb-anchor="business-identity">
        <div>
          <h3 className="font-semibold">Business identity</h3>
        </div>

        <Field
          label="Country of the legal entity"
          required
          hint={usPayoutEntity
            ? "You marked \"I have a US entity\" on the Payouts page, so tax forms and payouts follow the US path (W-9, EIN, Stripe) regardless of this country."
            : payoutRailFor(country) === "STRIPE"
            ? "Decides the tax form (W-9 for US, W-8BEN-E otherwise) and how you are paid. US entities are paid through Stripe."
            : "Decides the tax form (W-9 for US, W-8BEN-E otherwise) and how you are paid. Non-US entities are paid through GoStork's international payout partner."}
        >
          <select
            value={country}
            onChange={e => {
              const c = e.target.value;
              setCountry(c);
              if (c !== "US" && taxIdType !== "foreign") setTaxIdType("foreign");
              if (c === "US" && taxIdType === "foreign") setTaxIdType("ein");
            }}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm font-ui"
            data-testid="legal-country-select"
          >
            <optgroup label="Common">
              {POPULAR_COUNTRIES.map(c => <option key={c.isoCode} value={c.isoCode}>{c.flag} {c.name}</option>)}
            </optgroup>
            <optgroup label="All countries">
              {ALL_COUNTRIES.map(c => <option key={c.isoCode} value={c.isoCode}>{c.flag} {c.name}</option>)}
            </optgroup>
          </select>
        </Field>

        <Field
          label="Legal name"
          required
          hint="The name on your tax return - your business's legal name if entity-based, or your personal name if you're a sole proprietor / individual (W-9 Line 1)."
        >
          <Input value={legalName} onChange={e => setLegalName(e.target.value)} placeholder={`e.g. ${state?.companyName || "Eggceptional Fertility LLC"} or Jane Doe`} />
        </Field>

        <Field
          label="Legal business name"
          required
          hint="The business name GoStork displays on receipts and uses for Stripe Connect KYC. If you're a sole proprietor, this is your business / DBA name (W-9 Line 2). For LLCs or corporations, it usually matches your Legal name above."
        >
          <Input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder={`e.g. ${state?.companyName || "Eggceptional Fertility LLC"}`} />
        </Field>

        <Field
          label="Business website URL"
          required
          hint="Stripe Connect requires a public URL for your business. Pre-filled from the Website URL on the Company tab - override here if your legal-entity site differs from your marketing site."
        >
          <Input
            type="url"
            value={businessUrl}
            onChange={e => setBusinessUrl(e.target.value)}
            placeholder="https://example.com"
          />
        </Field>


        {isUs ? (
        <Field label="Federal tax classification" required hint="W-9 Line 3a.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TAX_CLASSIFICATIONS.map(opt => (
              <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="taxClassification"
                  value={opt.value}
                  checked={taxClassification === opt.value}
                  onChange={() => setTaxClassification(opt.value)}
                  className="accent-primary"
                />
                {opt.value === "INDIVIDUAL_SOLE_PROPRIETOR" ? <UserIcon className="w-3.5 h-3.5" /> : <Building2 className="w-3.5 h-3.5" />}
                {opt.label}
              </label>
            ))}
          </div>
        </Field>

        ) : (
        <Field label="Entity type" required hint="W-8BEN-E is for entities; an individual signs a W-8BEN instead.">
          <div className="flex gap-6">
            {[
              { value: "C_CORPORATION", label: "Company / organization" },
              { value: "INDIVIDUAL_SOLE_PROPRIETOR", label: "Individual" },
            ].map(opt => (
              <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="taxClassification"
                  value={opt.value}
                  checked={taxClassification === opt.value || (opt.value === "C_CORPORATION" && !!taxClassification && taxClassification !== "INDIVIDUAL_SOLE_PROPRIETOR")}
                  onChange={() => setTaxClassification(opt.value)}
                  className="accent-primary"
                />
                {opt.value === "INDIVIDUAL_SOLE_PROPRIETOR" ? <UserIcon className="w-3.5 h-3.5" /> : <Building2 className="w-3.5 h-3.5" />}
                {opt.label}
              </label>
            ))}
          </div>
        </Field>
        )}

        {isUs && (
        <Field label="Tax ID type" required>
          <div className="flex gap-6">
            {[
              { value: "ein", label: "EIN (Employer ID Number)" },
              { value: "ssn", label: "SSN (Social Security)" },
            ].map(opt => (
              <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="taxIdType"
                  value={opt.value}
                  checked={taxIdType === opt.value}
                  onChange={() => setTaxIdType(opt.value as "ein" | "ssn")}
                  className="accent-primary"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </Field>
        )}

        <Field
          label={isUs ? (taxIdType === "ssn" ? "SSN" : "EIN / Tax ID") : taxIdLabelFor(country)}
          required
          hint={isUs
            ? (taxIdType === "ssn" ? "9 digits" : "9 digits, with or without dash")
            : "Your local business tax identifier, exactly as registered. No US EIN is needed."}
        >
          <Input
            value={taxId}
            onChange={e => setTaxId(e.target.value)}
            placeholder={isUs ? (taxIdType === "ssn" ? "123-45-6789" : "12-3456789") : ""}
          />
        </Field>
      </section>

      {/* Address */}
      <section className="space-y-3 rounded-xl border bg-card p-5" data-onb-anchor="business-address">
        <h3 className="font-semibold">Business address</h3>
        <Field label="Street address" required hint={isUs ? "W-9 Line 5." : undefined}>
          <Input value={addrLine1} onChange={e => setAddrLine1(e.target.value)} />
        </Field>
        <Field label="Apt / suite / floor (optional)">
          <Input value={addrLine2} onChange={e => setAddrLine2(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="City" required><Input value={addrCity} onChange={e => setAddrCity(e.target.value)} /></Field>
          {isUs ? (
            <Field label="State" required hint="2-letter code"><Input value={addrState} onChange={e => setAddrState(e.target.value.toUpperCase())} maxLength={2} /></Field>
          ) : (
            <Field label="State / province / region"><Input value={addrState} onChange={e => setAddrState(e.target.value)} /></Field>
          )}
          <Field label={isUs ? "ZIP" : "Postal code"} required={isUs}><Input value={addrPostal} onChange={e => setAddrPostal(e.target.value)} /></Field>
        </div>
      </section>

      {saveMutation.isError && (
        <p className="text-sm" style={{ color: "hsl(var(--brand-error))" }}>
          {(saveMutation.error as Error).message}
        </p>
      )}
      {saveMutation.isSuccess && (
        <p className="text-sm flex items-center gap-1.5" style={{ color: "hsl(var(--brand-success))" }}>
          <CheckCircle2 className="w-4 h-4" />
          Saved
        </p>
      )}

      <Button
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
        style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
      >
        {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        Save Legal Details
      </Button>

    </div>
  );
}

function Field({
  label, required, hint, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span style={{ color: "hsl(var(--brand-error))" }} className="ml-0.5">*</span>}
      </Label>
      {children}
      {hint && <p className="t-helper">{hint}</p>}
    </div>
  );
}
