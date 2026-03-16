import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface AdminReportLayoutProps {
  breadcrumbs: BreadcrumbItem[];
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function AdminReportLayout({ breadcrumbs, title, subtitle, actions, children }: AdminReportLayoutProps) {
  const navigate = useNavigate();

  return (
    <div className="space-y-6" data-testid="admin-report-layout">
      <nav className="flex items-center gap-1 text-sm flex-wrap" data-testid="breadcrumb-nav">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            {crumb.href ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-primary transition-colors cursor-pointer"
                onClick={() => navigate(crumb.href!)}
                data-testid={`breadcrumb-link-${i}`}
              >
                {crumb.label}
              </button>
            ) : (
              <span className="text-foreground font-ui" data-testid={`breadcrumb-current-${i}`}>
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading" data-testid="report-title">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground mt-1" data-testid="report-subtitle">{subtitle}</p>
          )}
        </div>
        {actions && <div className="shrink-0" data-testid="report-actions">{actions}</div>}
      </div>

      {children}
    </div>
  );
}
