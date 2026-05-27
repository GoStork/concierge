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
import { ProviderW9Section } from "./provider-w9-section";
import { useAuth } from "@/hooks/use-auth";

interface LegalIdentityState {
  id: string;
  providerId: string;
  legalName: string | null;
  businessName: string | null;
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
  const isAdmin = mode === "admin";
  const effectiveProviderId = providerId || (user as any)?.providerId;

  const getUrl = isAdmin
    ? `/api/admin/providers/${providerId}/legal-identity`
    : `/api/provider/legal-identity`;
  const putUrl = getUrl;

  const { data: state, isLoading } = useQuery<LegalIdentityState>({
    queryKey: [getUrl],
    queryFn: async () => {
      const res = await fetch(getUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load legal identity");
      return res.json();
    },
  });

  // Form state - seeded from server, written back on save.
  const [legalName, setLegalName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [taxClassification, setTaxClassification] = useState("");
  const [taxId, setTaxId] = useState("");
  const [taxIdType, setTaxIdType] = useState<"ssn" | "ein">("ein");
  const [addrLine1, setAddrLine1] = useState("");
  const [addrLine2, setAddrLine2] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrState, setAddrState] = useState("");
  const [addrPostal, setAddrPostal] = useState("");

  useEffect(() => {
    if (!state) return;
    setLegalName(state.legalName || "");
    setBusinessName(state.businessName || "");
    setTaxClassification(state.taxClassification || "");
    setTaxId(state.taxId || "");
    setTaxIdType((state.taxIdType as "ssn" | "ein") || "ein");
    setAddrLine1(state.businessAddressLine1 || "");
    setAddrLine2(state.businessAddressLine2 || "");
    setAddrCity(state.businessAddressCity || "");
    setAddrState(state.businessAddressState || "");
    setAddrPostal(state.businessAddressPostalCode || "");
  }, [state?.id, state?.lastW9SyncAt, state?.updatedAt]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          legalName: legalName.trim() || null,
          businessName: businessName.trim() || null,
          taxClassification: taxClassification || null,
          taxId: taxId.trim() || null,
          taxIdType,
          businessAddressLine1: addrLine1.trim() || null,
          businessAddressLine2: addrLine2.trim() || null,
          businessAddressCity: addrCity.trim() || null,
          businessAddressState: addrState.trim().toUpperCase() || null,
          businessAddressPostalCode: addrPostal.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [getUrl] });
    },
  });

  // Manual W-9 sync trigger - used when the W-9 is signed but the
  // PandaDoc webhook didn't fire (test mode, missed event, etc.).
  const syncMutation = useMutation({
    mutationFn: async () => {
      const url = isAdmin
        ? `/api/admin/providers/${providerId}/legal-identity/sync-from-w9`
        : `/api/provider/legal-identity/sync-from-w9`;
      const res = await fetch(url, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Sync failed");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [getUrl] }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isW9AutoFilled = state?.source === "W9_AUTO_FILL";

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-heading">Legal Identity</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Your business's legal name, tax ID, and address. Used on payment receipts, the W-9, and Stripe Connect KYC for payouts.
            {isW9AutoFilled && state?.lastW9SyncAt && (
              <span className="block mt-1 text-xs" style={{ color: "hsl(var(--brand-success))" }}>
                <Sparkles className="w-3 h-3 inline mr-1" />
                Auto-filled from your signed W-9 on {new Date(state.lastW9SyncAt).toLocaleDateString()}.
                You can override any field below.
              </span>
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={syncMutation.isPending}
          onClick={() => syncMutation.mutate()}
          title="Re-read field values from your signed W-9 (only fills fields that are still empty)"
        >
          {syncMutation.isPending
            ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
          Sync from W-9
        </Button>
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

      {/* W-9 section - moved out of Billing tab. Self-contained component
          owns its own status query + send/fill/resubmit mutations. */}
      {effectiveProviderId && (
        <section className="space-y-3 rounded-xl border bg-secondary/30 p-5">
          <div>
            <h3 className="font-semibold">W-9 Form</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Required by US tax law for any provider receiving payments. When you sign it via PandaDoc,
              the fields below auto-fill from the form.
            </p>
          </div>
          <ProviderW9Section providerId={effectiveProviderId} mode={mode} />
        </section>
      )}

      {/* Identity form */}
      <section className="space-y-4">
        <div>
          <h3 className="font-semibold">Business identity</h3>
        </div>

        <Field label="Legal business name" required hint="The name on your tax return (W-9 Line 1).">
          <Input value={legalName} onChange={e => setLegalName(e.target.value)} placeholder="e.g. Eggceptional Fertility LLC" />
        </Field>

        <Field label="Business / DBA name (optional)" hint="If different from your legal name (W-9 Line 2).">
          <Input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="e.g. Eggceptional" />
        </Field>

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

        <Field label={taxIdType === "ssn" ? "SSN" : "EIN / Tax ID"} required hint={taxIdType === "ssn" ? "9 digits" : "9 digits, with or without dash"}>
          <Input
            value={taxId}
            onChange={e => setTaxId(e.target.value)}
            placeholder={taxIdType === "ssn" ? "123-45-6789" : "12-3456789"}
          />
        </Field>
      </section>

      {/* Address */}
      <section className="space-y-3">
        <h3 className="font-semibold">Business address</h3>
        <Field label="Street address" required hint="W-9 Line 5.">
          <Input value={addrLine1} onChange={e => setAddrLine1(e.target.value)} />
        </Field>
        <Field label="Apt / suite / floor (optional)">
          <Input value={addrLine2} onChange={e => setAddrLine2(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="City" required><Input value={addrCity} onChange={e => setAddrCity(e.target.value)} /></Field>
          <Field label="State" required hint="2-letter code"><Input value={addrState} onChange={e => setAddrState(e.target.value.toUpperCase())} maxLength={2} /></Field>
          <Field label="ZIP" required><Input value={addrPostal} onChange={e => setAddrPostal(e.target.value)} /></Field>
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
        Save Legal Identity
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
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
