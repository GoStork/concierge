import { useAuth } from "@/hooks/use-auth";
import { Navigate } from "react-router-dom";
import { UserCog } from "lucide-react";

export default function LeadsPage() {
  const { user } = useAuth();
  const roles = (user as any)?.roles || [];
  const isAdmin = roles.includes('GOSTORK_ADMIN');

  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-8">
        <UserCog className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-display font-heading text-primary" data-testid="text-page-title">Leads</h1>
          <p className="text-muted-foreground" data-testid="text-page-description">Manage and track leads.</p>
        </div>
      </div>
      <div className="bg-card rounded-xl border border-border/40 p-12 text-center text-muted-foreground" data-testid="leads-placeholder">
        <p>Leads management coming soon.</p>
      </div>
    </div>
  );
}
