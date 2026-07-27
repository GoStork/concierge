import { useQuery } from "@tanstack/react-query";

/**
 * What the AI concierge is called, for this deployment.
 *
 * "Eva" is an internal name. Parents and providers see whichever persona is
 * configured - Ariel, Adam, or anything else an admin names - so any label that
 * says "Eva" is telling a parent about a colleague they have never met and will
 * never see anywhere else in the product.
 *
 * The name is the FIRST configured matchmaker (sortOrder), which is the one a
 * parent is given by default. Sessions that already carry their own
 * matchmakerName should keep using it - that is the persona this particular
 * parent is actually talking to - and pass it in as `preferred`.
 *
 * The fallback is deliberately generic rather than a guessed first name:
 * "your concierge" is true whatever the deployment is called, and inventing a
 * name would be worse than not using one.
 */

export const CONCIERGE_FALLBACK_NAME = "your concierge";

export function useConciergeName(preferred?: string | null): string {
  const { data } = useQuery<{ name?: string }[]>({
    queryKey: ["/api/brand/matchmakers"],
    queryFn: async () => {
      const res = await fetch("/api/brand/matchmakers", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    // The persona name changes about as often as the logo does.
    staleTime: 30 * 60_000,
  });

  const configured = (preferred || "").trim() || (data?.[0]?.name || "").trim();
  return configured || CONCIERGE_FALLBACK_NAME;
}
