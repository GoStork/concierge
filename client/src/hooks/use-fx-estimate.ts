/**
 * "You receive approx. X MXN" for non-USD providers. Invoices are USD;
 * payouts land in the provider's local currency at the payout partner's
 * rate - this is a display estimate from a cached public feed
 * (/api/fx/usd-rates). Returns null for USD or when no rate is known, so
 * callers render nothing rather than a wrong number.
 */
import { useQuery } from "@tanstack/react-query";

export function useUsdRates(enabled = true) {
  return useQuery<{ rates: Record<string, number>; asOf: string | null }>({
    queryKey: ["/api/fx/usd-rates"],
    queryFn: async () => {
      const res = await fetch("/api/fx/usd-rates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load FX rates");
      return res.json();
    },
    enabled,
    staleTime: 60 * 60 * 1000,
  });
}

export function formatLocalEstimate(usdCents: number, currency: string | null | undefined, rates: Record<string, number> | undefined): string | null {
  const cur = (currency || "USD").toUpperCase();
  if (cur === "USD" || !rates?.[cur]) return null;
  const amount = (usdCents / 100) * rates[cur];
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString()} ${cur}`;
  }
}

/** One-liner used next to any USD provider amount: "≈ MX$81 (estimate)". */
export function useLocalEstimate(usdCents: number | null | undefined, currency: string | null | undefined): string | null {
  const cur = (currency || "USD").toUpperCase();
  const { data } = useUsdRates(cur !== "USD" && usdCents != null);
  if (usdCents == null) return null;
  const s = formatLocalEstimate(usdCents, cur, data?.rates);
  return s ? `≈ ${s} (estimate)` : null;
}
