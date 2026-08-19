/**
 * USD -> local currency rates for the "you receive approx." estimate shown
 * to non-USD providers.
 *
 * Invoices are always USD (GoStork is a US platform and parents pay in USD);
 * Stripe / the international payout partner convert at payout time at THEIR
 * rate. So this is an ESTIMATE for display only - never used to compute an
 * amount that moves money, which is why a free public rate feed is fine
 * here. Cached in-process for 12h; a feed failure returns the stale cache
 * or an empty map (the UI then simply omits the estimate).
 */
import { Controller, Get, Logger } from "@nestjs/common";

const FEED_URL = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 12 * 60 * 60 * 1000;

let cache: { rates: Record<string, number>; fetchedAt: number; date: string | null } | null = null;
let inflight: Promise<void> | null = null;

export async function getUsdRates(): Promise<{ rates: Record<string, number>; asOf: string | null }> {
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  if (!fresh) {
    if (!inflight) {
      inflight = (async () => {
        try {
          const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) throw new Error(`rate feed ${res.status}`);
          const body: any = await res.json();
          if (body?.result !== "success" || !body?.rates) throw new Error("rate feed: unexpected body");
          cache = { rates: body.rates, fetchedAt: Date.now(), date: body.time_last_update_utc || null };
        } catch (e: any) {
          Logger.warn(`[fx] USD rate refresh failed: ${e?.message} - ${cache ? "serving stale cache" : "no rates available"}`, "FxController");
          if (cache) cache.fetchedAt = Date.now() - TTL_MS + 10 * 60 * 1000; // retry in 10 min
        } finally {
          inflight = null;
        }
      })();
    }
    await inflight;
  }
  return { rates: cache?.rates || {}, asOf: cache?.date || null };
}

/** cents USD -> minor units of `currency`, or null when no rate. */
export async function estimateInCurrency(usdCents: number, currency: string): Promise<{ amount: number; currency: string; rate: number } | null> {
  const cur = (currency || "USD").toUpperCase();
  if (cur === "USD") return { amount: usdCents, currency: "USD", rate: 1 };
  const { rates } = await getUsdRates();
  const rate = rates[cur];
  if (!rate) return null;
  return { amount: Math.round(usdCents * rate), currency: cur, rate };
}

@Controller()
export class FxController {
  /** Public, cached: the UI only needs the rate for one currency at a time. */
  @Get("api/fx/usd-rates")
  async usdRates() {
    return getUsdRates();
  }
}
