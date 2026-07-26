import { useState, useEffect, useMemo, useCallback } from "react";
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
import { Plus, Building2, Loader2, Pencil, Globe, Trash2, Search, MapPin, ArrowUp, ArrowDown, ArrowUpDown, Calendar, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ProviderWithRelations } from "@shared/schema";
import { getPhotoSrc } from "@/lib/profile-utils";
import ManageServicesDialog, { SERVICE_STATUS_STYLES as STATUS_STYLES } from "@/components/manage-services-dialog";
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

  const isClientSort = sortBy === "services_asc" || sortBy === "services_desc" || sortBy === "locations_asc" || sortBy === "locations_desc";

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
    if (!rows || !isClientSort) return rows;
    const sorted = [...rows];
    if (sortBy === "services_asc") {
      sorted.sort((a: any, b: any) => (a.services?.length || 0) - (b.services?.length || 0));
    } else if (sortBy === "services_desc") {
      sorted.sort((a: any, b: any) => (b.services?.length || 0) - (a.services?.length || 0));
    } else if (sortBy === "locations_asc") {
      sorted.sort((a: any, b: any) => (a.locations?.length || 0) - (b.locations?.length || 0));
    } else if (sortBy === "locations_desc") {
      sorted.sort((a: any, b: any) => (b.locations?.length || 0) - (a.locations?.length || 0));
    }
    return sorted;
  }, [rawProviders, sortBy, isClientSort, automationFilter]);

  const { data: providerTypes } = useQuery<any[]>({
    queryKey: ["/api/provider-types"],
  });

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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[280px]">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap"
                  onClick={() => setSortBy(sortBy === "alphabetical" ? "alphabetical_desc" : "alphabetical")}
                  data-testid="sort-header-name"
                >
                  Name
                  {sortBy === "alphabetical" ? <ArrowUp className="w-3.5 h-3.5" /> : sortBy === "alphabetical_desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              </TableHead>
              <TableHead className="hidden md:table-cell max-w-[180px]">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap"
                  onClick={() => setSortBy(sortBy === "website_asc" ? "website_desc" : "website_asc")}
                  data-testid="sort-header-website"
                >
                  Website
                  {sortBy === "website_asc" ? <ArrowUp className="w-3.5 h-3.5" /> : sortBy === "website_desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              </TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap"
                  onClick={() => setSortBy(sortBy === "services_asc" ? "services_desc" : "services_asc")}
                  data-testid="sort-header-services"
                >
                  Services
                  {sortBy === "services_asc" ? <ArrowUp className="w-3.5 h-3.5" /> : sortBy === "services_desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              </TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Automations</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap"
                  onClick={() => setSortBy(sortBy === "locations_asc" ? "locations_desc" : "locations_asc")}
                  data-testid="sort-header-locations"
                >
                  Locations
                  {sortBy === "locations_asc" ? <ArrowUp className="w-3.5 h-3.5" /> : sortBy === "locations_desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              </TableHead>
              <TableHead className="hidden xl:table-cell whitespace-nowrap">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap"
                  onClick={() => setSortBy(sortBy === "newest" ? "oldest" : "newest")}
                  data-testid="sort-header-created"
                >
                  Created
                  {sortBy === "newest" ? <ArrowDown className="w-3.5 h-3.5" /> : sortBy === "oldest" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              </TableHead>
              <TableHead className="hidden xl:table-cell whitespace-nowrap">
                <button
                  type="button"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer whitespace-nowrap"
                  onClick={() => setSortBy(sortBy === "updated_desc" ? "updated_asc" : "updated_desc")}
                  data-testid="sort-header-updated"
                >
                  Updated
                  {sortBy === "updated_desc" ? <ArrowDown className="w-3.5 h-3.5" /> : sortBy === "updated_asc" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                </TableCell>
              </TableRow>
            ) : providers && providers.length > 0 ? (
              providers.map((provider: any) => (
                <TableRow key={provider.id} data-testid={`row-provider-${provider.id}`} className="cursor-pointer" onClick={() => navigate(`/admin/providers/${provider.id}`)}>
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
                        <Badge key={s.id} className={`text-xs cursor-pointer ${STATUS_STYLES[s.status] || ""}`} onClick={() => setManageServicesProvider(provider)} data-testid={`badge-service-${s.id}`}>
                          {s.providerType?.name || "Service"}: {s.status?.replace("_", " ")}
                        </Badge>
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
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
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
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
