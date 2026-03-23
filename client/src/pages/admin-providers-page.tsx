import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAppSelector, useAppDispatch } from "@/store";
import { setAdminProvidersFilter } from "@/store/uiSlice";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Building2, Loader2, Pencil, Globe, Trash2, Search, MapPin, ArrowUp, ArrowDown, ArrowUpDown, Calendar, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ProviderWithRelations } from "@shared/schema";
import { getPhotoSrc } from "@/lib/profile-utils";

const STATUS_OPTIONS = ["NEW", "IN_PROGRESS", "APPROVED", "DECLINED"] as const;

const STATUS_STYLES: Record<string, string> = {
  NEW: "bg-muted text-muted-foreground",
  IN_PROGRESS: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] dark:bg-[hsl(var(--brand-warning)/0.2)] dark:text-[hsl(var(--brand-warning))]",
  APPROVED: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] dark:bg-[hsl(var(--brand-success)/0.2)] dark:text-[hsl(var(--brand-success))]",
  DECLINED: "bg-destructive/15 text-destructive dark:bg-destructive/20 dark:text-destructive",
};

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

export default function AdminProvidersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [deleteProvider, setDeleteProvider] = useState<ProviderData | null>(null);
  const [manageServicesProvider, setManageServicesProvider] = useState<ProviderData | null>(null);

  const dispatch = useAppDispatch();
  const { searchQuery, locationSearch, providerType, statusFilter, sortBy } = useAppSelector(
    (state) => state.ui.adminProvidersFilters
  );

  const setSearchQuery = useCallback((v: string) => dispatch(setAdminProvidersFilter({ searchQuery: v })), [dispatch]);
  const setLocationSearch = useCallback((v: string) => dispatch(setAdminProvidersFilter({ locationSearch: v })), [dispatch]);
  const setProviderType = useCallback((v: string) => dispatch(setAdminProvidersFilter({ providerType: v })), [dispatch]);
  const setStatusFilter = useCallback((v: string) => dispatch(setAdminProvidersFilter({ statusFilter: v })), [dispatch]);
  const setSortBy = useCallback((v: string) => dispatch(setAdminProvidersFilter({ sortBy: v })), [dispatch]);

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
    if (!rawProviders || !isClientSort) return rawProviders;
    const sorted = [...rawProviders];
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
  }, [rawProviders, sortBy, isClientSort]);

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

  const updateServiceStatusMutation = useMutation({
    mutationFn: async ({ providerId, serviceId, status }: { providerId: string; serviceId: string; status: string }) => {
      const res = await apiRequest("PUT", `/api/providers/${providerId}/services/${serviceId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      toast({ title: "Service status updated", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const addServiceMutation = useMutation({
    mutationFn: async ({ providerId, providerTypeId }: { providerId: string; providerTypeId: string }) => {
      const res = await apiRequest("POST", `/api/providers/${providerId}/services`, { providerTypeId, status: "NEW" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
      toast({ title: "Service added", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const currentServiceTypeIds = new Set(manageServicesProvider?.services?.map((s: any) => s.providerTypeId) || []);
  const availableTypesForProvider = providerTypes?.filter((t: any) => !currentServiceTypeIds.has(t.id)) || [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">Providers</h1>
          <p className="text-muted-foreground">Manage clinics, agencies, and banks.</p>
        </div>
        <Button onClick={() => navigate("/admin/providers/new")} className="shrink-0" data-testid="button-add-provider">
          <Plus className="w-4 h-4 mr-2" /> Add Provider
        </Button>
      </div>

      <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide" data-testid="card-provider-filters">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search provider name..."
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
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="City or state..."
                  value={locationSearch}
                  onChange={(e) => setLocationSearch(e.target.value)}
                  data-testid="input-admin-location"
                />
              </div>
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
              {[{ value: "All", label: "All Types" }, { value: "IVF Clinic", label: "IVF Clinic" }, { value: "Surrogacy Agency", label: "Surrogacy Agency" }, { value: "Egg Donor Agency", label: "Egg Donor Agency" }].map((opt) => (
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
      </div>

      <div className={`bg-card rounded-xl border border-border/50 shadow-sm overflow-hidden transition-opacity ${isFetching && !isLoading ? "opacity-60" : ""}`}>
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
                        <img src={getPhotoSrc(provider.logoUrl) || provider.logoUrl} alt="" className="w-8 h-8 rounded-lg object-contain bg-background p-0.5 border" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
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
                      <span className="text-muted-foreground text-sm">-</span>
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
                        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setManageServicesProvider(provider)}>
                          + Add service
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell whitespace-nowrap">
                    <span className="text-sm">{provider.locations?.length || 0} location(s)</span>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell whitespace-nowrap">
                    <span className="text-sm text-muted-foreground">{provider.createdAt ? new Date(provider.createdAt).toLocaleDateString() : "-"}</span>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell whitespace-nowrap">
                    <span className="text-sm text-muted-foreground">{provider.updatedAt ? new Date(provider.updatedAt).toLocaleDateString() : "-"}</span>
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

      <Dialog open={!!manageServicesProvider} onOpenChange={(open) => { if (!open) setManageServicesProvider(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Services</DialogTitle>
            <DialogDescription>Manage service types and their approval status for {manageServicesProvider?.name}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {manageServicesProvider?.services && manageServicesProvider.services.length > 0 ? (
              <div className="space-y-3">
                {manageServicesProvider.services.map((service: any) => (
                  <div key={service.id} className="flex items-center justify-between gap-3 p-3 border rounded-lg" data-testid={`service-row-${service.id}`}>
                    <span className="text-sm font-ui">{service.providerType?.name || "Service"}</span>
                    <Select
                      value={service.status}
                      onValueChange={(newStatus) => {
                        updateServiceStatusMutation.mutate({
                          providerId: manageServicesProvider.id,
                          serviceId: service.id,
                          status: newStatus,
                        });
                        setManageServicesProvider({
                          ...manageServicesProvider,
                          services: manageServicesProvider.services!.map((s: any) =>
                            s.id === service.id ? { ...s, status: newStatus } : s
                          ),
                        });
                      }}
                    >
                      <SelectTrigger className="w-[160px]" data-testid={`select-status-${service.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map(status => (
                          <SelectItem key={status} value={status}>
                            <Badge className={`${STATUS_STYLES[status]} text-xs`}>
                              {status.replace("_", " ")}
                            </Badge>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">No services registered yet.</p>
            )}

            {availableTypesForProvider.length > 0 && (
              <div className="border-t pt-4">
                <Label className="text-sm font-ui mb-2 block">Add Service Type</Label>
                <div className="flex flex-wrap gap-2">
                  {availableTypesForProvider.map((type: any) => (
                    <Button
                      key={type.id}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        addServiceMutation.mutate({
                          providerId: manageServicesProvider!.id,
                          providerTypeId: type.id,
                        }, {
                          onSuccess: () => {
                            setManageServicesProvider(null);
                          },
                        });
                      }}
                      disabled={addServiceMutation.isPending}
                      data-testid={`button-add-service-${type.id}`}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      {type.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManageServicesProvider(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
