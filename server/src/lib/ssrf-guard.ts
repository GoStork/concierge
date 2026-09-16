/**
 * SSRF guard (OWASP A01/A10).
 *
 * Any place the server fetches a URL that a user (or scraped content, or a DB
 * row a provider can write) influences must go through here. String-prefix
 * blocklists like `hostname.startsWith("10.")` are not enough: `127.1`,
 * `0177.0.0.1`, `2130706433`, `[::ffff:127.0.0.1]`, CGNAT `100.64/10`, and any
 * attacker-owned hostname with a private A record all walk straight past them.
 *
 * So we resolve the hostname and check every resolved address against the
 * reserved ranges, and we re-run that check on every redirect hop rather than
 * letting fetch follow blindly (a public URL that 302s to 169.254.169.254 is
 * the classic metadata-service bypass).
 */
import dns from "node:dns/promises";
import net from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved space. */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0) return true;                      // 0.0.0.0/8 "this host"
    if (a === 10) return true;                     // private
    if (a === 127) return true;                    // loopback
    if (a === 169 && b === 254) return true;       // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;       // private
    if (a === 192 && b === 0) return true;         // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                     // multicast + reserved + broadcast
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    // IPv4-mapped (::ffff:127.0.0.1) - judge it as the v4 address it carries.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80")) return true;     // link-local
    if (/^f[cd]/.test(lower)) return true;         // unique-local fc00::/7
    if (lower.startsWith("ff")) return true;       // multicast
    if (lower.startsWith("::ffff:")) return true;  // any other v4-mapped form
    return false;
  }
  return true; // not a literal IP
}

/**
 * Validates scheme + host and resolves DNS. Throws SsrfBlockedError when the
 * target is anything but a public http(s) endpoint. Returns the parsed URL.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Blocked scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError("Credentials in URL are not allowed");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new SsrfBlockedError("Missing host");

  // Literal IP: judge it directly, no DNS.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new SsrfBlockedError(`Blocked address: ${hostname}`);
    return parsed;
  }

  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal") ||
    lowerHost.endsWith(".home.arpa")
  ) {
    throw new SsrfBlockedError(`Blocked host: ${hostname}`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`Cannot resolve host: ${hostname}`);
  }
  if (!addresses.length) throw new SsrfBlockedError(`Cannot resolve host: ${hostname}`);
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      throw new SsrfBlockedError(`Host resolves to a non-public address: ${hostname}`);
    }
  }
  return parsed;
}

/**
 * fetch() with the SSRF check applied to the initial URL AND to every redirect
 * hop. Never pass `redirect: "follow"` yourself - that is the hole this closes.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const { maxRedirects = 3, ...rest } = init;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...rest, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError("Too many redirects");
}
