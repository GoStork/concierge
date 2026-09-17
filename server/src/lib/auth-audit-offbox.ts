/**
 * Off-box copy of the authentication audit trail (OWASP A09).
 *
 * The AuthAuditLog table lives in the same database the application can write
 * to, so whoever takes over the application can also rewrite its history. This
 * ships every event to Google Cloud Logging as it happens. The VM's service
 * account holds `logging.write` only: it can append entries but can neither
 * read nor delete them, so a compromised host cannot erase what it already
 * sent. Retention is set on the Cloud Logging bucket, not here.
 *
 * Enabled with AUTH_AUDIT_SINK=gcp (production host only). The dev Macs have no
 * metadata server, so it stays off there rather than timing out on every login.
 *
 * No SDK on purpose: two fetch calls against the metadata server and the
 * entries:write endpoint, so this adds no dependency to audit.
 */
const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const LOG_ID = "gostork-auth-audit";

let cachedToken: { value: string; expiresAt: number } | null = null;
let cachedProject: string | null = null;
let failureLoggedAt = 0;

export function offboxAuditEnabled(): boolean {
  return process.env.AUTH_AUDIT_SINK === "gcp";
}

async function metadata(path: string): Promise<Response> {
  const res = await fetch(`${METADATA}/${path}`, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`metadata ${path} -> ${res.status}`);
  return res;
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const body: any = await (await metadata("instance/service-accounts/default/token")).json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
  return cachedToken.value;
}

async function projectId(): Promise<string> {
  if (!cachedProject) cachedProject = (await (await metadata("project/project-id")).text()).trim();
  return cachedProject;
}

const FAILURE_EVENTS = new Set(["LOGIN_FAILURE", "TWO_FACTOR_FAILURE"]);
const PRIVILEGE_EVENTS = new Set([
  "ROLES_CHANGED",
  "USER_CREATED_BY_ADMIN",
  "USER_DELETED_BY_ADMIN",
  "USER_DISABLED",
  "TWO_FACTOR_DISABLED",
]);

/**
 * Sends one already-sanitised audit row. Never throws - the caller is someone's
 * login. A failure is logged (at most once a minute so an outage cannot flood
 * the journal) because a silently dead audit copy is worse than a noisy one.
 */
export async function shipAuthEventOffbox(row: Record<string, unknown>): Promise<void> {
  if (!offboxAuditEnabled()) return;
  try {
    const [token, project] = await Promise.all([accessToken(), projectId()]);
    const event = String(row.event);
    const res = await fetch("https://logging.googleapis.com/v2/entries:write", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        logName: `projects/${project}/logs/${LOG_ID}`,
        resource: { type: "global", labels: { project_id: project } },
        entries: [
          {
            severity: FAILURE_EVENTS.has(event) ? "WARNING" : PRIVILEGE_EVENTS.has(event) ? "NOTICE" : "INFO",
            labels: { event, host: process.env.APP_URL || "" },
            jsonPayload: row,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`entries:write -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e: any) {
    if (Date.now() - failureLoggedAt > 60_000) {
      failureLoggedAt = Date.now();
      console.error(`[auth-audit] OFF-BOX COPY FAILED - events are only in the database: ${e?.message}`);
    }
  }
}
