/**
 * First-name extraction for greetings ("Welcome back, X").
 *
 * The naive `name.split(" ")[0]` breaks on honorifics: a user named
 * "Dr. Kiltz" was greeted "Welcome back, Dr." with no name at all. When the
 * first token is an honorific, include the next token too ("Dr. Kiltz").
 */
const HONORIFIC = /^(dr|prof|mr|mrs|ms|rev|fr|sr)\.?$/i;

export function firstNameOf(fullName: string | null | undefined): string {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (HONORIFIC.test(parts[0]) && parts[1]) return `${parts[0]} ${parts[1]}`;
  return parts[0];
}

/** Greeting name for the logged-in user: firstName field, else derived from name. */
export function greetingNameOf(user: { firstName?: string | null; name?: string | null } | null | undefined, fallback = "there"): string {
  const explicit = (user?.firstName || "").trim();
  // An explicit firstName that is itself just an honorific ("Dr.") is as
  // useless as the split bug - fall through to the full name in that case.
  if (explicit && !HONORIFIC.test(explicit)) return explicit;
  return firstNameOf(user?.name) || explicit || fallback;
}
