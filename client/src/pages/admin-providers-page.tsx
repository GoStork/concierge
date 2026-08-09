import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Building2, Loader2, Pencil, Globe, Trash2, Search, MapPin, ArrowUp, ArrowDown, ArrowUpDown, Calendar, ChevronDown, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ProviderWithRelations } from "@shared/schema";
import { getPhotoSrc } from "@/lib/profile-utils";
import ManageServicesDialog from "@/components/manage-services-dialog";
import { ServiceTag, serviceApprovalIcon } from "@/components/ui/service-tag";
import { LocationSearchInput } from "@/components/location-search-input";

type ProviderData = {
  id: string;
  name: string;
  about: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
  email: string | null;
  phone: string | null;
  yearFounded: number | null;
  services?: any[];
  locations?: any[];
  members?: any[];
};

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// Which automations are LIVE for a provider - mirrors the adoption logic on
// the admin Home dashboard (chat-router admin dashboard endpoint). Agreement
// automation counts when the provider set a mode themselves, or inherited
// the rollout flag.
const AUTOMATION_OPTIONS = [
  { value: "All", label: "All Automations" },
  { value: "cost_sheet", label: "Cost-sheet drafts" },
  { value: "invoice", label: "Invoice drafts" },
  { value: "agreement", label: "Agreement drafts" },
  { value: "all_on", label: "All automations on" },
  { value: "none", label: "No automations" },
] as const;

function providerAutomations(p: any): { cost_sheet: boolean; invoice: boolean; agreement: boolean } {
  const f = (p?.autoFeaturesEnabled as any) || {};
  const mode = p?.agreementAutomation;
  return {
    cost_sheet: f.autoCostSheetDraft === true,
    invoice: f.autoInvoiceDraft === true,
    agreement: mode === "approval" || mode === "auto_send" || (mode == null && f.autoAgreementDraft === true),
  };
}

// Setup columns: one per tab on the provider edit page. A green check means
// that tab has real content (server derives each flag from the tab's own data
// - see attachSetupStatus in providers.controller). Clicking a cell opens the
// provider straight on that tab, so an admin can fill the gap in one click.
const SETUP_COLUMNS = [
  { key: "team", label: "Team", tab: "users" },
  { key: "costs", label: "Costs", tab: "costs" },
  { key: "legalIdentity", label: "Legal Identity", tab: "legal-identity" },
  { key: "billing", label: "Billing", tab: "billing" },
  { key: "payouts", label: "Payouts", tab: "payouts" },
  { key: "autoReply", label: "Auto Reply", tab: "auto-replies" },
  { key: "sponsorship", label: "Sponsorship", tab: "sponsorship" },
] as const;

// Sort values for the columns the API cannot order by. Booleans sort as 1/0 so
// "configured first" is one click on any setup column.
const CLIENT_SORT_VALUE: Record<string, (p: any) => number> = {
  services: (p) => p.services?.length || 0,
  locations: (p) => p.locations?.length || 0,
  automations: (p) => Object.values(providerAutomations(p)).filter(Boolean).length,
  ...Object.fromEntries(
    SETUP_COLUMNS.map((c) => [`setup_${c.key}`, (p: any) => (p.setupStatus?.[c.key] ? 1 : 0)]),
  ),
};

/**
 * One header cell for this page's URL-param sort. Every column named the same
 * asc/desc pair and re-implemented the arrow logic inline; this is that markup
 * once. Clicking cycles asc -> desc -> asc on the column, and the active
 * direction is whichever of the two keys the URL currently holds.
 */
function SortHeader({ label, asc, desc, sortBy, setSortBy, className, align = "left", testId }: {
  label: string;
  asc: string;
  desc: string;
  sortBy: string;
  setSortBy: (v: string) => void;
  className?: string;
  align?: "left" | "center" | "right";
  testId?: string;
}) {
  const active = sortBy === asc ? "asc" : sortBy === desc ? "desc" : null;
  const justify = align === "center" ? "justify-center" : align === "right" ? "justify-end" : "justify-start";
  return (
    <TableHead className={`whitespace-nowrap ${align === "center" ? "text-center" : align === "right" ? "text-right" : ""} ${className || ""}`}>
      <button
        type="button"
        className={`flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap w-full ${justify}`}
        onClick={() => setSortBy(active === "asc" ? desc : asc)}
        data-testid={testId}
      >
        {label}
        {active === "asc" ? <ArrowUp className="w-3.5 h-3.5" /> : active === "desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
    </TableHead>
  );
}

export default function AdminProvidersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [deleteProvider, setDeleteProvider] = useState<ProviderData | null>(null);
  const [manageServicesProvider, setManageServicesProvider] = useState<ProviderData | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get("q") || "";
  const locationSearch = searchParams.get("loc") || "";
  const providerType = searchParams.get("type") || "All";
  const statusFilter = searchParams.get("status") || "All";
  const automationFilter = searchParams.get("automation") || "All";
  const sortBy = searchParams.get("sort") || "newest";

  const updateParam = useCallback((key: string, value: string, defaultValue: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (!value || value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setSearchQuery = useCallback((v: string) => updateParam("q", v, ""), [updateParam]);
  const setLocationSearch = useCallback((v: string) => updateParam("loc", v, ""), [updateParam]);
  const setProviderType = useCallback((v: string) => updateParam("type", v, "All"), [updateParam]);
  const setStatusFilter = useCallback((v: string) => updateParam("status", v, "All"), [updateParam]);
  const setAutomationFilter = useCallback((v: string) => updateParam("automation", v, "All"), [updateParam]);
  const setSortBy = useCallback((v: string) => updateParam("sort", v, "newest"), [updateParam]);
  const hasActiveFilters = !!(searchQuery || locationSearch || providerType !== "All" || statusFilter !== "All" || automationFilter !== "All");
  const clearFilters = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ["q", "loc", "type", "status", "automation"].forEach(k => next.delete(k));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const debouncedSearch = useDebounce(searchQuery, 300);
  const debouncedLocation = useDebounce(locationSearch, 300);

  // Columns the server can order by go through the API (name/website/dates);
  // everything derived from the payload - counts, automation flags, the setup
  // checkmarks - sorts here. Client keys are always "<base>_asc" / "<base>_desc"
  // so one comparator covers all of them and the URL still round-trips.
  const clientSortBase = /_(asc|desc)$/.test(sortBy) ? sortBy.replace(/_(asc|desc)$/, "") : null;
  const isClientSort = !!clientSortBase && CLIENT_SORT_VALUE[clientSortBase] !== undefined;

  const serverSortBy = isClientSort ? "newest" : sortBy;

  const serverProviderUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (debouncedLocation) params.set("location", debouncedLocation);
    if (providerType !== "All") params.set("providerType", providerType);
    if (statusFilter !== "All") params.set("status", statusFilter);
    if (serverSortBy !== "newest") params.set("sortBy", serverSortBy);
    const qs = params.toString();
    return qs ? `${api.providers.list.path}?${qs}` : api.providers.list.path;
  }, [debouncedSearch, debouncedLocation, providerType, statusFilter, serverSortBy]);

  const { data: rawProviders, isLoading, isFetching } = useQuery<ProviderWithRelations[]>({
    queryKey: [api.providers.list.path, debouncedSearch, debouncedLocation, providerType, statusFilter, serverSortBy],
    queryFn: async () => {
      const res = await fetch(serverProviderUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch providers");
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const providers = useMemo(() => {
    let rows = rawProviders;
    if (rows && automationFilter !== "All") {
      rows = rows.filter((p: any) => {
        const a = providerAutomations(p);
        if (automationFilter === "all_on") return a.cost_sheet && a.invoice && a.agreement;
        if (automationFilter === "none") return !a.cost_sheet && !a.invoice && !a.agreement;
        return a[automationFilter as "cost_sheet" | "invoice" | "agreement"] === true;
      });
    }
    if (!rows || !isClientSort || !clientSortBase) return rows;
    const value = CLIENT_SORT_VALUE[clientSortBase];
    const dir = sortBy.endsWith("_desc") ? -1 : 1;
    return [...rows].sort((a: any, b: any) => (value(a) - value(b)) * dir);
  }, [rawProviders, sortBy, isClientSort, clientSortBase, automationFilter]);

  const { data: providerTypes } = useQuery<any[]>({
    queryKey: ["/api/provider-types"],
  });

  // Horizontal scroller with a pinned Actions column, same treatment the
  // parents table uses: the seven setup columns push the row past the viewport
  // on a laptop, and edit/delete have to stay reachable without scrolling back.
  // The scroll container is the Table's OWN wrapper - it clips first, so
  // overflow-x on the Card around it never gets a chance to scroll.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolledRight, setScrolledRight] = useState(false);
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScrolledRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, providers?.length]);
  // A hairline, not a drop shadow - matches the parents table.
  const pinR = scrolledRight ? { borderLeft: "1px solid hsl(var(--border))" } : undefined;

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/providers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      setDeleteProvider(null);
      toast({ title: "Provider deleted", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display t-page-title text-primary" data-testid="text-page-title">Providers</h1>
          <p className="text-muted-foreground">Manage clinics, agencies, and banks.</p>
        </div>
        <Button onClick={() => navigate("/admin/providers/new")} className="shrink-0" data-testid="button-add-provider">
          <Plus className="w-4 h-4 mr-2" /> Add Provider
        </Button>
      </div>

      <div className="flex items-center gap-3">
      <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide flex-1 min-w-0" data-testid="card-provider-filters">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search name, team email or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
            data-testid="input-admin-search"
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="filter-btn-location">
              <MapPin className="w-3 h-3" />
              {locationSearch || "Location"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            <div className="space-y-2">
              <span className="text-sm font-medium">Location</span>
              <LocationSearchInput
                value={locationSearch}
                onValueChange={setLocationSearch}
                onSelect={(commit) => setLocationSearch(commit)}
                placeholder="City or state..."
                autoFocus
                testId="input-admin-location"
              />
              {locationSearch && (
                <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setLocationSearch("")} data-testid="clear-admin-location">
                  Clear
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={providerType !== "All" ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="select-provider-type">
              {providerType === "All" ? "All Types" : providerType}
              <ChevronDown className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-2" align="start">
            <div className="space-y-1">
              {[{ value: "All", label: "All Types" }, ...(providerTypes || []).map((t: any) => ({ value: t.name, label: t.name }))].map((opt) => (
                <Button key={opt.value} variant={providerType === opt.value ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setProviderType(opt.value)} data-testid={`provider-type-${opt.value}`}>
                  {opt.label}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={statusFilter !== "All" ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="select-status-filter">
              {statusFilter === "All" ? "All Statuses" : statusFilter.replace("_", " ")}
              <ChevronDown className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-2" align="start">
            <div className="space-y-1">
              {[{ value: "All", label: "All Statuses" }, { value: "NEW", label: "New" }, { value: "IN_PROGRESS", label: "In Progress" }, { value: "APPROVED", label: "Approved" }, { value: "DECLINED", label: "Declined" }].map((opt) => (
                <Button key={opt.value} variant={statusFilter === opt.value ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setStatusFilter(opt.value)} data-testid={`status-${opt.value}`}>
                  {opt.label}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={automationFilter !== "All" ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="select-automation-filter">
              {AUTOMATION_OPTIONS.find((o) => o.value === automationFilter)?.label || "All Automations"}
              <ChevronDown className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-52 p-2" align="start">
            <div className="space-y-1">
              {AUTOMATION_OPTIONS.map((opt) => (
                <Button key={opt.value} variant={automationFilter === opt.value ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => setAutomationFilter(opt.value)} data-testid={`automation-${opt.value}`}>
                  {opt.label}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
        <ClearFiltersButton pill show={hasActiveFilters} onClick={clearFilters} testId="admin-providers-clear-filters" />
      </div>

      <div className={`bg-card rounded-[var(--radius)] border border-border/50 shadow-sm overflow-hidden transition-opacity ${isFetching && !isLoading ? "opacity-60" : ""}`}>
        <Table wrapperClassName="overflow-x-auto" wrapperRef={scroller} onWrapperScroll={measure}>
          <TableHeader>
            <TableRow>
              <SortHeader label="Name" asc="alphabetical" desc="alphabetical_desc" sortBy={sortBy} setSortBy={setSortBy} className="min-w-[280px]" testId="sort-header-name" />
              <SortHeader label="Website" asc="website_asc" desc="website_desc" sortBy={sortBy} setSortBy={setSortBy} className="hidden md:table-cell max-w-[180px]" testId="sort-header-website" />
              <SortHeader label="Services" asc="services_asc" desc="services_desc" sortBy={sortBy} setSortBy={setSortBy} className="hidden lg:table-cell" testId="sort-header-services" />
              <SortHeader label="Automations" asc="automations_asc" desc="automations_desc" sortBy={sortBy} setSortBy={setSortBy} className="hidden lg:table-cell" testId="sort-header-automations" />
              <SortHeader label="Locations" asc="locations_asc" desc="locations_desc" sortBy={sortBy} setSortBy={setSortBy} className="hidden lg:table-cell" testId="sort-header-locations" />
              <SortHeader label="Created" asc="oldest" desc="newest" sortBy={sortBy} setSortBy={setSortBy} className="hidden xl:table-cell" testId="sort-header-created" />
              <SortHeader label="Updated" asc="updated_asc" desc="updated_desc" sortBy={sortBy} setSortBy={setSortBy} className="hidden xl:table-cell" testId="sort-header-updated" />
              {SETUP_COLUMNS.map((c) => (
                <SortHeader
                  key={c.key}
                  label={c.label}
                  asc={`setup_${c.key}_asc`}
                  desc={`setup_${c.key}_desc`}
                  sortBy={sortBy}
                  setSortBy={setSortBy}
                  align="center"
                  className="hidden lg:table-cell"
                  testId={`sort-header-setup-${c.key}`}
                />
              ))}
              <TableHead className="text-right whitespace-nowrap sticky right-0 z-20 bg-muted" style={pinR}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={15} className="text-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                </TableCell>
              </TableRow>
            ) : providers && providers.length > 0 ? (
              providers.map((provider: any) => (
                <TableRow key={provider.id} data-testid={`row-provider-${provider.id}`} className="cursor-pointer bg-card" onClick={() => navigate(`/admin/providers/${provider.id}`)}>
                  <TableCell className="font-ui">
                    <div className="flex items-center gap-3">
                      {provider.logoUrl ? (
                        <img src={getPhotoSrc(provider.logoUrl) || provider.logoUrl} alt="" className="w-8 h-8 rounded-[var(--radius)] object-contain bg-background p-0.5 border" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="w-8 h-8 rounded-[var(--radius)] bg-primary/10 flex items-center justify-center text-primary">
                          <Building2 className="w-4 h-4" />
                        </div>
                      )}
                      <button type="button" className="text-left hover:text-primary hover:underline transition-colors cursor-pointer" onClick={(e) => { e.stopPropagation(); navigate(`/admin/providers/${provider.id}`); }} data-testid={`link-provider-name-${provider.id}`}>{provider.name}</button>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell max-w-[180px]" onClick={(e) => e.stopPropagation()}>
                    {provider.websiteUrl ? (
                      <a
                        href={provider.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-primary hover:underline truncate"
                        data-testid={`link-website-${provider.id}`}
                        title={provider.websiteUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                      >
                        <Globe className="w-3 h-3 shrink-0" />
                        <span className="truncate">{provider.websiteUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</span>
                      </a>
                    ) : (
                      <span className="t-helper">-</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1">
                      {provider.services?.map((s: any) => (
                        <ServiceTag
                          key={s.id}
                          service={s.providerType?.name || "Service"}
                          approved={serviceApprovalIcon(s.status)}
                          title={`${s.providerType?.name || "Service"}: ${(s.status || "").replace("_", " ")}`}
                          onClick={() => setManageServicesProvider(provider)}
                          testId={`badge-service-${s.id}`}
                        />
                      ))}
                      {(!provider.services || provider.services.length === 0) && (
                        <Button variant="ghost" size="sm" className="t-helper" onClick={() => setManageServicesProvider(provider)}>
                          + Add service
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {(() => {
                      const a = providerAutomations(provider);
                      const tags = [
                        a.cost_sheet && "Cost sheets",
                        a.invoice && "Invoices",
                        a.agreement && "Agreements",
                      ].filter(Boolean) as string[];
                      return tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1" data-testid={`automations-${provider.id}`}>
                          {tags.map((t) => (
                            <Badge key={t} className="text-xs bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))]/15">{t}</Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="t-helper">-</span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell whitespace-nowrap">
                    <span className="text-sm">{provider.locations?.length || 0} location(s)</span>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell whitespace-nowrap">
                    <span className="t-helper">{provider.createdAt ? new Date(provider.createdAt).toLocaleDateString() : "-"}</span>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell whitespace-nowrap">
                    <span className="t-helper">{provider.updatedAt ? new Date(provider.updatedAt).toLocaleDateString() : "-"}</span>
                  </TableCell>
                  {/* CheckCircle2, not a bare Check: the bare check is the in-chip
                      approval modifier (ServiceTag). A standalone "this is done"
                      cell mark is CheckCircle2 in brand-success - the same mark
                      the Billing and Payouts tables print for a received payout. */}
                  {SETUP_COLUMNS.map((c) => {
                    const done = !!provider.setupStatus?.[c.key];
                    return (
                      <TableCell
                        key={c.key}
                        className="hidden lg:table-cell text-center"
                        onClick={(e) => { e.stopPropagation(); navigate(`/admin/providers/${provider.id}?tab=${c.tab}`); }}
                        data-testid={`setup-${c.key}-${provider.id}`}
                      >
                        {done ? (
                          <CheckCircle2 className="w-4 h-4 mx-auto text-[hsl(var(--brand-success))]" aria-label={`${c.label} configured`} />
                        ) : (
                          <span className="t-helper">-</span>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right sticky right-0 z-10 bg-inherit" style={pinR} onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/admin/providers/${provider.id}`)}
                        data-testid={`button-edit-${provider.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteProvider(provider)}
                        data-testid={`button-delete-${provider.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={15} className="text-center text-muted-foreground py-8">
                  {debouncedSearch || debouncedLocation || providerType !== "All" || statusFilter !== "All"
                    ? "No providers match your filters."
                    : "No providers yet. Click \"Add Provider\" to get started."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!deleteProvider} onOpenChange={(open) => { if (!open) setDeleteProvider(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteProvider?.name}</strong>? This will permanently remove the provider and all associated data including staff accounts, services, locations, and any linked profiles. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteProvider(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteProvider && deleteMutation.mutate(deleteProvider.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManageServicesDialog
        provider={manageServicesProvider}
        open={!!manageServicesProvider}
        onOpenChange={(open) => { if (!open) setManageServicesProvider(null); }}
      />
    </div>
  );
}
