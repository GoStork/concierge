/**
 * Pushing the blocked-country list to Cloudflare, so /admin/security is the
 * one place the block lives.
 *
 * Our own gate stops the OTP - a blocked-country phone number never receives
 * a code, so the account can never finish signup. Cloudflare blocks one layer
 * earlier and on a different key: the visitor's IP location, at the edge,
 * before a request reaches the app at all. The two are complementary (a bot
 * in Ethiopia with a US SIM passes our gate but not Cloudflare's; an
 * Ethiopian number bought from a US VPS passes Cloudflare but not ours), so
 * an admin decision on the Security page feeds both.
 *
 * Mechanics: one WAF custom rule in the zone's http_request_firewall_custom
 * ruleset, found by its description marker and PATCHed in place - never a
 * wholesale replace of the entrypoint, which would wipe rules a human made in
 * the dashboard. The zone already carried a hand-made country-block rule from
 * the old platform's fraud fight; rather than stacking a second rule beside
 * it (free plan allows 5), the first sync ADOPTS it - the existing rule is
 * recognised by its shape (action "block" + a country-in-set expression),
 * PATCHed with our list and renamed to the marker, and is ours from then on.
 * Its country list was imported into SecurityCountryPolicy first, so adoption
 * never narrows what the edge blocks. Requires:
 *
 *   CLOUDFLARE_API_TOKEN  a token scoped to Zone > WAF > Edit (Zone Firewall
 *                         Services Edit on older token UIs)
 *   CLOUDFLARE_ZONE_ID    the zone id from the domain's overview page
 *
 * With either missing, sync reports "not configured" and does nothing - the
 * in-app gate keeps working regardless.
 */
import { prisma } from "./db";

const RULE_MARKER = "GoStork blocked countries - managed by /admin/security";
const API = "https://api.cloudflare.com/client/v4";

interface SyncResult {
  ok: boolean;
  configured: boolean;
  message: string;
  blockedCount?: number;
  ruleId?: string;
}

function creds(): { token: string; zoneId: string } | null {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  return token && zoneId ? { token, zoneId } : null;
}

async function cf(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const err = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${err}`);
  }
  return body;
}

/**
 * Our rule, by marker - or, failing that, the hand-made country-block rule
 * the sync will adopt. A candidate must both BLOCK and match on country so a
 * managed-challenge rule or anything else a human added is never touched.
 */
function findOurRule(rules: any[]): { rule: any; adopted: boolean } | null {
  const marked = rules.find((r: any) => r.description === RULE_MARKER);
  if (marked) return { rule: marked, adopted: false };
  const candidate = rules.find(
    (r: any) => r.action === "block" && /ip\.(src|geoip)\.country in \{/.test(String(r.expression || "")),
  );
  return candidate ? { rule: candidate, adopted: true } : null;
}

export async function cloudflareSyncStatus(): Promise<SyncResult> {
  const c = creds();
  if (!c) {
    return {
      ok: false,
      configured: false,
      message: "Not connected. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID to sync the block list to the edge.",
    };
  }
  try {
    const entry = await cf(
      `/zones/${c.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
      c.token,
    );
    const found = findOurRule(entry?.result?.rules || []);
    if (!found) return { ok: true, configured: true, message: "Connected. No edge rule yet - run a sync." };
    const m = String(found.rule.expression || "").match(/"[A-Z]{2}"/g);
    return {
      ok: true,
      configured: true,
      message: found.adopted
        ? `Connected. Found the existing country-block rule (${m?.length ?? 0} countries) - the next sync takes it over.`
        : `Edge rule active, blocking ${m?.length ?? 0} countries.`,
      blockedCount: m?.length ?? 0,
      ruleId: found.rule.id,
    };
  } catch (e: any) {
    return { ok: false, configured: true, message: e?.message || "Could not reach Cloudflare" };
  }
}

export async function syncBlockedCountriesToCloudflare(): Promise<SyncResult> {
  const c = creds();
  if (!c) {
    return {
      ok: false,
      configured: false,
      message: "Not connected. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID to sync the block list to the edge.",
    };
  }

  const blocked = await prisma.securityCountryPolicy.findMany({
    where: { policy: "BLOCKED" },
    select: { isoCode: true },
    orderBy: { isoCode: "asc" },
  });
  const codes = blocked.map((b) => b.isoCode.toUpperCase());

  try {
    const entry = await cf(
      `/zones/${c.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
      c.token,
    );
    const rulesetId = entry?.result?.id;
    const found = findOurRule(entry?.result?.rules || []);

    // No blocked countries: disable our rule rather than deleting it, so the
    // history of its existence survives in the dashboard.
    if (codes.length === 0) {
      if (found) {
        await cf(`/zones/${c.zoneId}/rulesets/${rulesetId}/rules/${found.rule.id}`, c.token, {
          method: "PATCH",
          body: JSON.stringify({ ...ruleBody([]), enabled: false }),
        });
      }
      return { ok: true, configured: true, message: "No blocked countries - edge rule disabled.", blockedCount: 0 };
    }

    if (found) {
      // PATCHing with ruleBody rewrites the description to our marker, so an
      // adopted hand-made rule becomes the managed rule from this moment on.
      await cf(`/zones/${c.zoneId}/rulesets/${rulesetId}/rules/${found.rule.id}`, c.token, {
        method: "PATCH",
        body: JSON.stringify(ruleBody(codes)),
      });
      return {
        ok: true,
        configured: true,
        message: found.adopted
          ? `Adopted the existing country-block rule - now managed here, blocking ${codes.length} countries.`
          : `Edge rule updated - blocking ${codes.length} countries.`,
        blockedCount: codes.length,
        ruleId: found.rule.id,
      };
    }

    const created = await cf(`/zones/${c.zoneId}/rulesets/${rulesetId}/rules`, c.token, {
      method: "POST",
      body: JSON.stringify(ruleBody(codes)),
    });
    const newRule = (created?.result?.rules || []).find((r: any) => r.description === RULE_MARKER);
    return { ok: true, configured: true, message: `Edge rule created - blocking ${codes.length} countries.`, blockedCount: codes.length, ruleId: newRule?.id };
  } catch (e: any) {
    return { ok: false, configured: true, message: e?.message || "Sync failed" };
  }
}

function ruleBody(codes: string[]) {
  return {
    description: RULE_MARKER,
    // ip.src.country is the visitor's GeoIP country at the edge.
    expression: codes.length
      ? `(ip.src.country in {${codes.map((c) => `"${c}"`).join(" ")}})`
      : `(ip.src.country in {"XX"})`,
    action: "block",
    enabled: codes.length > 0,
  };
}
