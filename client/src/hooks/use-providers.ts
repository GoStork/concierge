import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { type InsertProvider, type ProviderWithRelations } from "@shared/schema";

export function useProviders() {
  return useQuery<ProviderWithRelations[]>({
    queryKey: [api.providers.list.path],
    queryFn: async () => {
      const res = await fetch(api.providers.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch providers");
      return res.json();
    },
  });
}

export function useProvider(id: string) {
  return useQuery<ProviderWithRelations>({
    queryKey: [api.providers.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.providers.get.path, { id });
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch provider");
      return res.json();
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
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.providers.list.path] });
    },
  });
}
