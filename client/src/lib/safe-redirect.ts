/**
 * Same-origin check for any path we are about to navigate to (OWASP A01).
 *
 * `value.startsWith("/")` is the check everyone writes and it is not enough:
 *   //evil.com        - protocol-relative, the browser goes to evil.com
 *   /\evil.com        - backslash variant, same outcome in several browsers
 *   /%5Cevil.com      - the encoded form of the above
 * All three start with "/". This is the same class of bug as the React Router
 * advisory (open redirect via backslash in <Link> and useNavigate), so fixing
 * the library alone would not have fixed our own call sites.
 *
 * Returns a path safe to hand to navigate(), or null. Resolving against the
 * current origin and then INSISTING the result is still that origin is what
 * makes it safe - not pattern matching on the input.
 */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // A backslash is never legitimate in one of our paths, and browsers
  // normalise it to a forward slash, which is what makes //evil and /\evil
  // equivalent. Reject rather than try to repair.
  if (decoded.includes("\\")) return null;
  if (!decoded.startsWith("/")) return null;
  // "//host" is protocol-relative: it leaves the site despite the leading "/".
  if (decoded.startsWith("//")) return null;
  try {
    const url = new URL(decoded, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
