import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { type InsertInventoryItem, type InventoryItem } from "@shared/schema";

export function useInventory(filters?: { providerId?: number; type?: string }) {
  const queryKey = [api.inventory.list.path, filters?.providerId, filters?.type].filter(Boolean);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const url = buildUrl(api.inventory.list.path);
      const searchParams = new URLSearchParams();
      if (filters?.providerId) searchParams.set("providerId", filters.providerId.toString());
      if (filters?.type) searchParams.set("type", filters.type);
      
      const res = await fetch(`${url}?${searchParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch inventory");
      return api.inventory.list.responses[200].parse(await res.json());
    },
  });
}

export function useCreateInventory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: InsertInventoryItem) => {
      const validated = api.inventory.create.input.parse(data);
      const res = await fetch(api.inventory.create.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create inventory item");
      return api.inventory.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.inventory.list.path] });
    },
  });
}

export function useUpdateInventory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertInventoryItem>) => {
      const validated = api.inventory.update.input.parse(updates);
      const url = buildUrl(api.inventory.update.path, { id });
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update inventory item");
      return api.inventory.update.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.inventory.list.path] });
    },
  });
}
