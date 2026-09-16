/**
 * Who on the GoStork team still has no second factor. During the grace period
 * this is the list that says how exposed we actually are.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface StaffRow {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  twoFactorEnabled: boolean;
  isDisabled: boolean;
  lastLoginAt: string | null;
}

interface Response {
  enforced: boolean;
  enforceAt: string | null;
  requiredRoles: string[];
  staff: StaffRow[];
  enrolled: number;
  total: number;
}

export function StaffTwoFactorCard() {
  const { data, isLoading } = useQuery<Response>({
    queryKey: ["/api/admin/security/two-factor"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/security/two-factor")).json(),
  });

  if (isLoading) {
    return (
      <div className="rounded-[var(--radius)] border bg-card p-4">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="rounded-[var(--radius)] border bg-card p-4 space-y-3" data-testid="card-staff-two-factor">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="t-section-title font-heading mr-auto">Team two-factor coverage</h2>
        <span className="t-helper font-ui" data-testid="text-2fa-coverage">
          {data.enrolled} of {data.total} enrolled
        </span>
      </div>
      <p className="t-helper">
        {data.enforced
          ? "Enrollment is required: a staff account without a second factor can no longer sign in."
          : data.enforceAt
            ? `Enrollment becomes mandatory on ${new Date(data.enforceAt).toLocaleDateString()}. Until then these accounts can still sign in with a password alone.`
            : "No cutoff date is set yet, so these accounts can still sign in with a password alone. Set TWO_FACTOR_ENFORCE_AT on the server to start enforcing."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="t-micro-label py-2 pr-3">Person</th>
              <th className="t-micro-label py-2 pr-3 hidden sm:table-cell">Roles</th>
              <th className="t-micro-label py-2 pr-3">Second factor</th>
              <th className="t-micro-label py-2 pr-3 hidden md:table-cell">Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {data.staff.map((u) => (
              <tr key={u.id} className="border-t border-border/60" data-testid={`row-staff-2fa-${u.id}`}>
                <td className="py-1.5 pr-3 break-all">
                  {u.name ? <span className="font-ui">{u.name}</span> : null}
                  <span className="t-helper block">{u.email}</span>
                </td>
                <td className="py-1.5 pr-3 t-helper hidden sm:table-cell">{u.roles.join(", ")}</td>
                <td className="py-1.5 pr-3">
                  <span
                    className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={u.twoFactorEnabled
                      ? { background: "hsl(var(--brand-success) / 0.15)", color: "hsl(var(--brand-success))" }
                      : { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }}
                  >
                    {u.twoFactorEnabled ? <><ShieldCheck className="w-3 h-3" /> On</> : <><ShieldAlert className="w-3 h-3" /> Not set up</>}
                  </span>
                </td>
                <td className="py-1.5 pr-3 t-helper hidden md:table-cell">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
