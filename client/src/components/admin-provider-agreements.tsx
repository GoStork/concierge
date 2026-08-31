/**
 * GoStork admin - send the Provider Service Agreement and track every send.
 * Rendered at the bottom of the admin Agreements tab (/account/documents).
 *
 * Send flow: pick a provider (anyone with a PROVIDER_ADMIN / BILLING_MANAGER
 * member - the people who can sign), then either send the DEFAULT contract
 * (the template configured at the top of this tab) or configure a CUSTOM
 * contract just for them (upload + PandaDoc field editor, reusing the shared
 * PandaDocTemplateEditor). GoStork signs first (referral-fee fields), the
 * provider second; the provider is emailed + tasked only after GoStork signs.
 *
 * Table: same design as the W-9 / Your Sponsorships tables - status pill,
 * reminder task action, signed-PDF download, superseded history rows muted.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Download, Send, BellRing, CheckCircle2, PenLine, Trash2, FileSignature, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { PandaDocTemplateEditor } from "@/components/pandadoc-template-editor";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface EligibleProvider {
  providerId: string;
  name: string;
  serviceTypes: string[];
}

interface AgreementRow {
  id: string;
  providerId: string;
  providerName: string;
  status: "DRAFT" | "AWAITING_GOSTORK" | "SENT" | "COMPLETED" | "ERROR";
  templateSource: "DEFAULT" | "CUSTOM";
  customTemplateUrl: string | null;
  customTemplateOriginalName: string | null;
  customPandaDocTemplateId: string | null;
  signerEmail: string | null;
  requestedAt: string | null;
  completedAt: string | null;
  supersededAt: string | null;
  guestOpenedAt: string | null;
  autoRemindCount: number;
  reminderOpen: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: "bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))]",
  SENT: "bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]",
  AWAITING_GOSTORK: "bg-accent/15 text-accent",
  DRAFT: "bg-muted text-muted-foreground",
  ERROR: "bg-destructive/15 text-destructive",
};

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: "Completed",
  SENT: "Awaiting provider signature",
  AWAITING_GOSTORK: "Your turn - fill fees & sign",
  DRAFT: "Draft - not sent",
  ERROR: "Error",
};

const STATUS_RANK: Record<string, number> = { AWAITING_GOSTORK: 0, DRAFT: 1, SENT: 2, ERROR: 3, COMPLETED: 4 };

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : null);

export function AdminProviderAgreements({ fixedProviderId }: { fixedProviderId?: string } = {}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { sortConfig, handleSort, sortData } = useTableSort();

  // Fixed mode: mounted on a specific provider's Agreements tab (admin edit
  // page) - the provider is preselected and locked, and the table shows only
  // that provider's contracts.
  const isFixed = !!fixedProviderId;
  const [selectedProviderId, setSelectedProviderId] = useState<string>(fixedProviderId || "");
  const [contractMode, setContractMode] = useState<"default" | "custom">("default");
  const [draft, setDraft] = useState<AgreementRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Sent contracts table: free-text search + status filter.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = useQuery<{ providers: EligibleProvider[]; agreements: AgreementRow[] }>({
    queryKey: ["/api/admin/provider-agreements"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/provider-agreements")).json(),
    // Signatures land via the PandaDoc webhook while the admin is looking at
    // this table - keep it live instead of waiting for a manual refresh.
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });

  const providers = data?.providers || [];
  const agreements = data?.agreements || [];

  // Celebrate signatures as they land: when a poll flips a row to COMPLETED,
  // toast it. The ref keeps the last seen status per row; first load seeds it
  // silently so returning to the tab doesn't re-toast old signatures.
  // ?agreement=<id> deep link (home-page "signed" notification): scroll the
  // row into view and flash-highlight it, then drop the param so refreshes
  // and back-navigation don't replay the scroll.
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    const target = searchParams.get("agreement");
    if (!target || scrolledRef.current || !agreements.some(a => a.id === target)) return;
    scrolledRef.current = true;
    setHighlightId(target);
    // Let the table paint first, then scroll.
    setTimeout(() => {
      document.querySelector(`[data-testid="agreement-row-${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    const params = new URLSearchParams(searchParams);
    params.delete("agreement");
    setSearchParams(params, { replace: true });
    const t = setTimeout(() => setHighlightId(null), 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agreements]);

  const prevStatuses = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const next = new Map(agreements.map(a => [a.id, a.status] as const));
    const prev = prevStatuses.current;
    if (prev) {
      for (const a of agreements) {
        const before = prev.get(a.id);
        if (before && before !== "COMPLETED" && a.status === "COMPLETED") {
          toast({ title: "Agreement signed", description: `${a.providerName} signed the GoStork agreement - the executed contract is ready to download.` });
        }
      }
    }
    prevStatuses.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const selectedProvider = providers.find(p => p.providerId === selectedProviderId) || null;
  // Keep the inline draft in sync with the server copy (e.g. after template
  // upload/sync the row's customPandaDocTemplateId changes server-side).
  const liveDraft = draft ? agreements.find(a => a.id === draft.id) || draft : null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/provider-agreements"] });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agreements.filter(a => {
      if (isFixed && a.providerId !== fixedProviderId) return false;
      if (statusFilter === "superseded" ? !a.supersededAt : (statusFilter !== "all" && (a.supersededAt || a.status !== statusFilter))) return false;
      if (!q) return true;
      return [a.providerName, a.signerEmail, a.customTemplateOriginalName, a.templateSource === "CUSTOM" ? "custom" : "default"]
        .some(v => (v || "").toLowerCase().includes(q));
    });
  }, [agreements, search, statusFilter]);

  const sorted = useMemo(() => sortData(filtered, (a, key) => {
    switch (key) {
      case "provider": return a.providerName;
      case "contract": return a.templateSource === "CUSTOM" ? "Custom" : "Default";
      case "status": return a.supersededAt ? 99 : (STATUS_RANK[a.status] ?? 50);
      case "sent": return a.requestedAt ? new Date(a.requestedAt).getTime() : null;
      case "signed": return a.completedAt ? new Date(a.completedAt).getTime() : null;
      default: return null;
    }
  }), [filtered, sortConfig]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      toast({ title: "Something went wrong", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const sendDefault = () => run("send-default", async () => {
    const res = await (await apiRequest("POST", "/api/admin/provider-agreements/send", { providerId: selectedProviderId })).json();
    toast({
      title: "Agreement sent",
      description: res?.status === "SENT"
        ? "The provider has been emailed a signing link - no GoStork signature needed on this template."
        : "Your signature is next: fill in the referral fees and sign, then the provider gets notified.",
    });
    refresh();
    if (res?.agreementId && res?.status !== "SENT") navigate(`/provider-agreement/${res.agreementId}`);
  });

  const startCustom = () => run("start-custom", async () => {
    const res = await (await apiRequest("POST", "/api/admin/provider-agreements/custom", { providerId: selectedProviderId })).json();
    setDraft(res.agreement);
    refresh();
  });

  const sendCustom = (id: string) => run(`send-custom-${id}`, async () => {
    const res = await (await apiRequest("POST", `/api/admin/provider-agreements/${id}/send`, {})).json();
    toast({
      title: "Custom agreement sent",
      description: res?.status === "SENT"
        ? "The provider has been emailed a signing link - no GoStork signature needed on this template."
        : "Your signature is next: fill in the referral fees and sign, then the provider gets notified.",
    });
    setDraft(null);
    refresh();
  });

  const discardDraft = (id: string) => run(`discard-${id}`, async () => {
    await apiRequest("DELETE", `/api/admin/provider-agreements/${id}/custom-template`);
    if (liveDraft?.id === id) setDraft(null);
    refresh();
  });

  const remind = (row: AgreementRow) => run(`remind-${row.id}`, async () => {
    await apiRequest("POST", `/api/admin/provider-agreements/${row.id}/remind`, {});
    toast({ title: "Reminder sent", description: `${row.providerName} got a fresh signing-link email, and "Sign your GoStork agreement" sits on their Home page.` });
    refresh();
  });

  const download = (row: AgreementRow) => run(`download-${row.id}`, async () => {
    const res = await fetch(`/api/provider-agreements/${row.id}/download`, { credentials: "include" });
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `GoStork Agreement - ${row.providerName}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  return (
    <div className="space-y-6">
      {/* ── Send card ── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-heading flex items-center gap-2">
            <FileSignature className="w-5 h-5 text-primary" /> {isFixed ? "GoStork Agreement" : "Send agreement to a provider"}
          </h2>
          <p className="t-helper mt-0.5">
            {isFixed
              ? "Send this provider the GoStork service agreement and track its signature. You fill the referral fees and sign first; they are emailed once your part is done."
              : "Providers with a team member who can sign (Provider Admin or Billing Manager). You fill the referral fees and sign first; they are emailed and tasked once your part is done."}
          </p>
        </div>
        <Card className="p-5 space-y-4">
          {isFixed && !isLoading && !selectedProvider && (
            <p className="text-sm rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.3)] bg-[hsl(var(--brand-warning)/0.08)] px-3 py-2">
              This provider has no team member who can sign yet - create their Provider Admin user (Team tab) first, then send the agreement.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-[minmax(240px,1fr)_auto] sm:items-end">
            {!isFixed && (
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={selectedProviderId} onValueChange={(v) => { setSelectedProviderId(v); setDraft(null); }}>
                <SelectTrigger data-testid="agreement-provider-select">
                  <SelectValue placeholder="Choose a provider..." />
                </SelectTrigger>
                <SelectContent>
                  {providers.map(p => (
                    <SelectItem key={p.providerId} value={p.providerId}>
                      {p.name}{p.serviceTypes.length ? ` - ${p.serviceTypes.join(", ")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            )}
            <div className="flex rounded-[var(--radius)] border overflow-hidden w-fit">
              {(["default", "custom"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setContractMode(mode); if (mode === "default") setDraft(null); }}
                  className={cn(
                    "px-4 py-2 text-sm font-ui transition-colors",
                    contractMode === mode ? "bg-primary text-primary-foreground" : "bg-card hover:bg-secondary",
                  )}
                  data-testid={`agreement-mode-${mode}`}
                >
                  {mode === "default" ? "Default contract" : "Custom for this provider"}
                </button>
              ))}
            </div>
          </div>

          {contractMode === "default" ? (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <p className="t-helper">
                Sends the default GoStork Provider Service Agreement template configured above.
              </p>
              <Button
                onClick={sendDefault}
                disabled={!selectedProviderId || (isFixed && !selectedProvider) || busy === "send-default"}
                data-testid="agreement-send-default"
              >
                {busy === "send-default" ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Send className="w-4 h-4 mr-1.5" />}
                Send default contract
              </Button>
            </div>
          ) : !liveDraft ? (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <p className="t-helper">
                Upload a modified contract just for {selectedProvider?.name || "this provider"}, assign the
                signature fields in PandaDoc, then send it to them alone.
              </p>
              <Button onClick={startCustom} disabled={!selectedProviderId || (isFixed && !selectedProvider) || busy === "start-custom"} data-testid="agreement-start-custom">
                {busy === "start-custom" ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <PenLine className="w-4 h-4 mr-1.5" />}
                Configure custom contract
              </Button>
            </div>
          ) : (
            <div className="space-y-4 border-t pt-4">
              <PandaDocTemplateEditor
                templateLabel={`Custom contract for ${selectedProvider?.name || liveDraft.providerName}`}
                description="Upload the modified contract (PDF or Word), then open the editor to assign the signature fields - keep the same roles as the default (Client for the provider, GoStork for you)."
                fieldInstructions="Drag signature and date fields onto the document and assign each to a role (Client = provider, GoStork = you). Click Save when done."
                containerId={`pandadoc-custom-agreement-${liveDraft.id}`}
                templateUrl={liveDraft.customTemplateUrl}
                pandaDocTemplateId={liveDraft.customPandaDocTemplateId}
                templateFilename={liveDraft.customTemplateOriginalName}
                saveTemplate={async ({ url, originalName }) => {
                  await apiRequest("PUT", `/api/admin/provider-agreements/${liveDraft.id}/custom-template`, { url, originalName });
                }}
                deleteTemplate={async () => {
                  await apiRequest("DELETE", `/api/admin/provider-agreements/${liveDraft.id}/custom-template`);
                  setDraft(null);
                }}
                syncEndpoint={`/api/admin/provider-agreements/${liveDraft.id}/sync-template`}
                editorSessionEndpoint={`/api/admin/provider-agreements/${liveDraft.id}/template-editor-session`}
                refreshRolesEndpoint={`/api/admin/provider-agreements/${liveDraft.id}/refresh-roles`}
                onAfterChange={refresh}
              />
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => discardDraft(liveDraft.id)} disabled={busy === `discard-${liveDraft.id}`}>
                  <Trash2 className="w-4 h-4 mr-1.5" /> Discard draft
                </Button>
                <Button
                  onClick={() => sendCustom(liveDraft.id)}
                  disabled={!liveDraft.customTemplateUrl || busy === `send-custom-${liveDraft.id}`}
                  data-testid="agreement-send-custom"
                >
                  {busy === `send-custom-${liveDraft.id}` ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Send className="w-4 h-4 mr-1.5" />}
                  Send custom contract
                </Button>
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* ── Tracking table ── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-heading">Sent GoStork Agreements</h2>
          <p className="t-helper mt-0.5">
            {isFixed
              ? "Every GoStork agreement sent to this provider - sign your part, nudge them, and download signed copies."
              : "Every GoStork agreement sent to a provider. Sign your part, nudge the ones still outstanding (a task on the provider's Home page), and download signed copies."}
          </p>
        </div>
        {!isFixed && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search provider, email, contract..."
              className="pl-9 bg-card"
              data-testid="agreements-search"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[220px] bg-card" data-testid="agreements-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="AWAITING_GOSTORK">Your turn - fill fees & sign</SelectItem>
              <SelectItem value="SENT">Awaiting provider signature</SelectItem>
              <SelectItem value="COMPLETED">Completed</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="ERROR">Error</SelectItem>
              <SelectItem value="superseded">Superseded</SelectItem>
            </SelectContent>
          </Select>
        </div>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading agreements...
          </div>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead label="Provider" sortKey="provider" currentSort={sortConfig} onSort={handleSort} />
                    <SortableTableHead label="Contract" sortKey="contract" currentSort={sortConfig} onSort={handleSort} />
                    <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} />
                    <SortableTableHead label="Sent" sortKey="sent" currentSort={sortConfig} onSort={handleSort} />
                    <SortableTableHead label="Signed" sortKey="signed" currentSort={sortConfig} onSort={handleSort} />
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((a) => {
                    const superseded = !!a.supersededAt;
                    const rowBusy = !!busy && busy.endsWith(a.id);
                    return (
                      <TableRow
                        key={a.id}
                        className={cn(
                          superseded && "opacity-60",
                          "transition-colors duration-700",
                          highlightId === a.id && "bg-accent/15",
                        )}
                        data-testid={`agreement-row-${a.id}`}
                      >
                        <TableCell>
                          <div className="font-medium">{a.providerName}</div>
                          {a.signerEmail && <div className="t-helper">{a.signerEmail}</div>}
                        </TableCell>
                        <TableCell className="text-sm" title={a.templateSource === "CUSTOM" ? (a.customTemplateOriginalName || undefined) : undefined}>
                          {a.templateSource === "CUSTOM" ? "Custom" : "Default"}
                        </TableCell>
                        <TableCell>
                          {superseded ? (
                            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap bg-muted text-muted-foreground">
                              Superseded{a.status === "COMPLETED" ? " (signed)" : ""}
                            </span>
                          ) : (
                            <>
                              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[a.status] || STATUS_STYLES.DRAFT}`}>
                                {STATUS_LABELS[a.status] || a.status}
                              </span>
                              {a.status === "SENT" && (
                                <div className="t-helper mt-1 whitespace-nowrap">
                                  {a.guestOpenedAt ? `Opened ${fmtDate(a.guestOpenedAt)}` : "Not opened yet"}
                                  {a.autoRemindCount > 0 ? ` · reminded ${a.autoRemindCount}x` : ""}
                                </div>
                              )}
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{fmtDate(a.requestedAt) || "-"}</TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {a.completedAt ? (
                            <span className="inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--brand-success))]" />
                              {fmtDate(a.completedAt)}
                            </span>
                          ) : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {!superseded && a.status === "AWAITING_GOSTORK" && (
                              <Button size="sm" onClick={() => navigate(`/provider-agreement/${a.id}`)} data-testid={`agreement-sign-${a.id}`}>
                                <PenLine className="w-3.5 h-3.5 mr-1" /> Fill & sign
                              </Button>
                            )}
                            {!superseded && a.status === "SENT" && (
                              <Button size="sm" variant="outline" onClick={() => remind(a)} disabled={rowBusy} data-testid={`agreement-remind-${a.id}`}>
                                {rowBusy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <BellRing className="w-3.5 h-3.5 mr-1" />}
                                {a.reminderOpen ? "Remind again" : "Send reminder"}
                              </Button>
                            )}
                            {!superseded && a.status === "DRAFT" && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => { setSelectedProviderId(a.providerId); setContractMode("custom"); setDraft(a); }} data-testid={`agreement-continue-${a.id}`}>
                                  <PenLine className="w-3.5 h-3.5 mr-1" /> Continue setup
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => discardDraft(a.id)} disabled={rowBusy}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                            {a.status === "COMPLETED" && (
                              <Button size="sm" variant="outline" onClick={() => download(a)} disabled={rowBusy} data-testid={`agreement-download-${a.id}`}>
                                {rowBusy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1" />}
                                Download
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!sorted.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">
                        {agreements.length
                          ? "No contracts match your search or filter."
                          : "No agreements sent yet. Pick a provider above to send the first one."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
