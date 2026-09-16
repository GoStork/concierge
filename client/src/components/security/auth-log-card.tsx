/**
 * Sign-in activity: the authentication audit trail (OWASP A09).
 *
 * Before this, a failed login, a password reset, a role change and an admin
 * minting another admin all left no trace at all, so after an incident there
 * was nothing to read. Rows never contain credential material.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShieldAlert } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";

interface LogRow {
  id: string;
  event: string;
  userId: string | null;
  email: string | null;
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
  createdAt: string;
}

interface LogResponse {
  days: number;
  rows: LogRow[];
  summary: { event: string; count: number }[];
  topFailureIps: { ip: string; count: number }[];
}

const EVENT_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: "Signed in",
  LOGIN_FAILURE: "Failed sign-in",
  TWO_FACTOR_SUCCESS: "Second factor accepted",
  TWO_FACTOR_FAILURE: "Second factor rejected",
  TWO_FACTOR_ENABLED: "Two-factor turned on",
  TWO_FACTOR_DISABLED: "Two-factor turned off",
  RECOVERY_CODE_USED: "Recovery code used",
  PASSWORD_RESET_REQUESTED: "Password reset requested",
  PASSWORD_RESET_COMPLETED: "Password reset completed",
  ROLES_CHANGED: "Roles changed",
  USER_CREATED_BY_ADMIN: "Account created by admin",
  USER_DELETED_BY_ADMIN: "Account deleted by admin",
  USER_DISABLED: "Account disabled",
};

/** Failures and privilege changes are the two things worth spotting fast. */
function toneFor(event: string): { background: string; color: string } {
  if (event.endsWith("FAILURE")) {
    return { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" };
  }
  if (event === "ROLES_CHANGED" || event === "USER_DELETED_BY_ADMIN" || event === "USER_DISABLED" || event === "TWO_FACTOR_DISABLED") {
    return { background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" };
  }
  if (event.endsWith("SUCCESS") || event === "TWO_FACTOR_ENABLED") {
    return { background: "hsl(var(--brand-success) / 0.15)", color: "hsl(var(--brand-success))" };
  }
  return { background: "hsl(var(--secondary))", color: "hsl(var(--secondary-foreground))" };
}

export function AuthLogCard() {
  const [days, setDays] = useState("7");
  const [event, setEvent] = useState("ALL");
  const [email, setEmail] = useState("");

  const { data, isLoading } = useQuery<LogResponse>({
    queryKey: ["/api/admin/security/auth-log", days, event, email],
    queryFn: async () => {
      const p = new URLSearchParams({ days, limit: "200" });
      if (event !== "ALL") p.set("event", event);
      if (email.trim()) p.set("email", email.trim());
      return (await apiRequest("GET", `/api/admin/security/auth-log?${p.toString()}`)).json();
    },
  });

  return (
    <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3" data-testid="card-auth-log">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="t-section-title font-heading mr-auto">Sign-in activity</h2>
        <Input
          placeholder="Filter by email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-9 w-full sm:w-52"
          data-testid="input-auth-log-email"
        />
        <Select value={event} onValueChange={setEvent}>
          <SelectTrigger className="h-9 w-full sm:w-52" data-testid="select-auth-log-event">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All events</SelectItem>
            {Object.entries(EVENT_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="h-9 w-full sm:w-32" data-testid="select-auth-log-days">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 24h</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(data?.topFailureIps?.length ?? 0) > 0 && (
        <div className="rounded-[var(--radius)] bg-secondary p-3 space-y-1" data-testid="panel-failure-ips">
          <p className="t-micro-label flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> Most failed attempts by address
          </p>
          <div className="flex flex-wrap gap-2 t-helper font-ui">
            {data!.topFailureIps.map((f) => (
              <span key={f.ip}>{f.ip}: {f.count}</span>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (data?.rows?.length ?? 0) === 0 ? (
        <p className="t-helper py-2">Nothing recorded in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className="t-micro-label py-2 pr-3">When</th>
                <th className="t-micro-label py-2 pr-3">Event</th>
                <th className="t-micro-label py-2 pr-3">Account</th>
                <th className="t-micro-label py-2 pr-3 hidden sm:table-cell">Address</th>
                <th className="t-micro-label py-2 pr-3 hidden md:table-cell">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data!.rows.map((r) => {
                const tone = toneFor(r.event);
                return (
                  <tr key={r.id} className="border-t border-border/60" data-testid={`row-auth-log-${r.id}`}>
                    <td className="py-1.5 pr-3 whitespace-nowrap t-helper">
                      {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap" style={tone}>
                        {EVENT_LABELS[r.event] || r.event}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 font-ui break-all">{r.email || r.userId || "-"}</td>
                    <td className="py-1.5 pr-3 font-ui t-helper hidden sm:table-cell">{r.ip || "-"}</td>
                    <td className="py-1.5 pr-3 t-helper hidden md:table-cell">{r.detail || "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
