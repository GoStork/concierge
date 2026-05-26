import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export const SERVICE_STATUS_OPTIONS = ["NEW", "IN_PROGRESS", "APPROVED", "DECLINED"] as const;

export const SERVICE_STATUS_STYLES: Record<string, string> = {
  NEW: "bg-muted text-muted-foreground",
  IN_PROGRESS: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] dark:bg-[hsl(var(--brand-warning)/0.2)] dark:text-[hsl(var(--brand-warning))]",
  APPROVED: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] dark:bg-[hsl(var(--brand-success)/0.2)] dark:text-[hsl(var(--brand-success))]",
  DECLINED: "bg-destructive/15 text-destructive dark:bg-destructive/20 dark:text-destructive",
};

type ProviderForServices = {
  id: string;
  name: string;
  services?: any[];
};

interface ManageServicesDialogProps {
  provider: ProviderForServices | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ManageServicesDialog({ provider, open, onOpenChange }: ManageServicesDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [localServices, setLocalServices] = useState<any[]>(provider?.services || []);

  useEffect(() => {
    setLocalServices(provider?.services || []);
  }, [provider?.id, provider?.services]);

  const { data: providerTypes } = useQuery<any[]>({
    queryKey: ["/api/provider-types"],
  });

  const invalidateProviderQueries = () => {
    queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
    if (provider?.id) {
      queryClient.invalidateQueries({ queryKey: ["/api/providers", provider.id] });
    }
  };

  const updateServiceStatusMutation = useMutation({
    mutationFn: async ({ providerId, serviceId, status }: { providerId: string; serviceId: string; status: string }) => {
      const res = await apiRequest("PUT", `/api/providers/${providerId}/services/${serviceId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      invalidateProviderQueries();
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
    onSuccess: (newService: any) => {
      invalidateProviderQueries();
      setLocalServices((prev) => [...prev, newService]);
      toast({ title: "Service added", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const currentServiceTypeIds = new Set(localServices.map((s: any) => s.providerTypeId));
  const availableTypes = providerTypes?.filter((t: any) => !currentServiceTypeIds.has(t.id)) || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Services</DialogTitle>
          <DialogDescription>Manage service types and their approval status for {provider?.name}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {localServices.length > 0 ? (
            <div className="space-y-3">
              {localServices.map((service: any) => (
                <div key={service.id} className="flex items-center justify-between gap-3 p-3 border rounded-[var(--radius)]" data-testid={`service-row-${service.id}`}>
                  <span className="text-sm font-ui">{service.providerType?.name || "Service"}</span>
                  <Select
                    value={service.status}
                    onValueChange={(newStatus) => {
                      if (!provider) return;
                      updateServiceStatusMutation.mutate({
                        providerId: provider.id,
                        serviceId: service.id,
                        status: newStatus,
                      });
                      setLocalServices((prev) => prev.map((s: any) => (s.id === service.id ? { ...s, status: newStatus } : s)));
                    }}
                  >
                    <SelectTrigger className="w-[160px]" data-testid={`select-status-${service.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SERVICE_STATUS_OPTIONS.map((status) => (
                        <SelectItem key={status} value={status}>
                          <Badge className={`${SERVICE_STATUS_STYLES[status]} text-xs`}>
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

          {availableTypes.length > 0 && (
            <div className="border-t pt-4">
              <Label className="text-sm font-ui mb-2 block">Add Service Type</Label>
              <div className="flex flex-wrap gap-2">
                {availableTypes.map((type: any) => (
                  <Button
                    key={type.id}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!provider) return;
                      addServiceMutation.mutate({
                        providerId: provider.id,
                        providerTypeId: type.id,
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
