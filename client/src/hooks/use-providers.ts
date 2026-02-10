import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { type InsertProvider, type Provider } from "@shared/schema";

export function useProviders(filters?: { type?: string }) {
  const queryKey = [api.providers.list.path, filters?.type].filter(Boolean);
  
  return useQuery({
    queryKey,
    queryFn: async () => {
      const url = buildUrl(api.providers.list.path);
      const searchParams = new URLSearchParams();
      if (filters?.type) searchParams.set("type", filters.type);
      
      const res = await fetch(`${url}?${searchParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch providers");
      return api.providers.list.responses[200].parse(await res.json());
    },
  });
}

export function useProvider(id: number) {
  return useQuery({
    queryKey: [api.providers.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.providers.get.path, { id });
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch provider");
      return api.providers.get.responses[200].parse(await res.json());
    },
    enabled: !!id,
  });
}

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: InsertProvider) => {
      const validated = api.providers.create.input.parse(data);
      const res = await fetch(api.providers.create.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create provider");
      return api.providers.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
    },
  });
}
