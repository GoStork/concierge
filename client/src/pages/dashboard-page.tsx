import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Stethoscope, Users, Building2, Search, ArrowRight, Activity, Calendar, Bot, Video } from "lucide-react";
import { Link } from "react-router-dom";
import { hasProviderRole } from "@shared/roles";
import { useCompanyName } from "@/hooks/use-brand-settings";

type DashboardStats = {
  providers: number;
  parents: number;
  parentsThisWeek: number;
  scrapers: {
    activeScrapers: number;
    totalDonorProfiles: number;
  };
  video: {
    totalBookings: number;
    completedCalls: number;
    upcomingCalls: number;
    activeRooms: number;
  };
};

export default function DashboardPage() {
  const { user } = useAuth();
  const companyName = useCompanyName();

  if (!user) return null;

  const roles = (user as any).roles || [];
  const isAdmin = roles.includes('GOSTORK_ADMIN');
  const isProvider = hasProviderRole(roles);
  const isParent = roles.includes('PARENT');

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["/api/admin/dashboard-stats"],
    queryFn: async () => {
      const res = await fetch("/api/admin/dashboard-stats", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: isAdmin,
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl md:text-4xl font-heading text-primary mb-2" data-testid="text-greeting">
            Hello, {user.name || user.email}
          </h1>
          <p className="text-muted-foreground text-lg">
            Welcome to your {companyName} command center.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm bg-secondary/50 px-4 py-2 rounded-full text-primary font-ui">
          <Calendar className="w-4 h-4" />
          <span>{new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isParent && (
          <Card className="col-span-1 md:col-span-2 lg:col-span-2 bg-gradient-to-br from-primary to-primary/90 text-primary-foreground border-none shadow-xl shadow-primary/20 relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 group-hover:opacity-10 transition-opacity duration-500" />
            <CardHeader>
              <CardTitle className="text-2xl font-display text-primary-foreground">Find Your Perfect Match</CardTitle>
              <CardDescription className="text-primary-foreground/80 text-base">
                Browse thousands of egg donors and surrogates from top-rated agencies.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/marketplace">
                <Button variant="secondary" size="lg" className="font-ui gap-2" data-testid="button-browse-marketplace">
                  <Search className="w-4 h-4" />
                  Browse Marketplace
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {isProvider && (
           <Card className="hover:border-primary/50 transition-colors duration-300" data-testid="card-provider-services">
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-ui">Provider Services</CardTitle>
              <Stethoscope className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-heading text-primary" data-testid="text-services-count">--</div>
              <p className="text-xs text-muted-foreground mt-1">
                View and manage your services
              </p>
              <Link to="/provider/services">
                <Button variant="ghost" className="px-0 mt-4 h-auto text-primary font-ui flex items-center gap-1" data-testid="link-manage-services">
                  Manage Services <ArrowRight className="w-3 h-3" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {isAdmin && (
          <>
            <Card className="hover:border-primary/50 transition-colors duration-300" data-testid="card-active-providers">
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-ui">Active Providers</CardTitle>
                <Building2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-heading text-primary" data-testid="text-providers-count">
                  {stats ? stats.providers.toLocaleString() : "--"}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Registered on platform
                </p>
                <Link to="/admin/providers">
                  <Button variant="ghost" className="px-0 mt-4 h-auto text-primary font-ui flex items-center gap-1" data-testid="link-manage-providers">
                    Manage Providers <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="hover:border-primary/50 transition-colors duration-300" data-testid="card-total-parents">
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-ui">Total Parents</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-heading text-primary" data-testid="text-parents-count">
                  {stats ? stats.parents.toLocaleString() : "--"}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats ? `+${stats.parentsThisWeek} this week` : "Loading..."}
                </p>
                <Link to="/users">
                  <Button variant="ghost" className="px-0 mt-4 h-auto text-primary font-ui flex items-center gap-1" data-testid="link-view-parents">
                    View Parents <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="hover:border-primary/50 transition-colors duration-300" data-testid="card-scrapers">
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-ui">Scrapers</CardTitle>
                <Bot className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-heading text-primary" data-testid="text-scrapers-profiles">
                  {stats ? stats.scrapers.totalDonorProfiles.toLocaleString() : "--"}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats ? `${stats.scrapers.activeScrapers} active scraper${stats.scrapers.activeScrapers !== 1 ? "s" : ""}` : "Loading..."}
                </p>
                <Link to="/admin/scrapers">
                  <Button variant="ghost" className="px-0 mt-4 h-auto text-primary font-ui flex items-center gap-1" data-testid="link-view-scrapers">
                    View Scrapers <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="hover:border-primary/50 transition-colors duration-300" data-testid="card-video-conferences">
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-ui">Video Conferences</CardTitle>
                <Video className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-heading text-primary" data-testid="text-video-total">
                  {stats ? stats.video.totalBookings.toLocaleString() : "--"}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats ? (
                    <>
                      {stats.video.completedCalls} completed · {stats.video.upcomingCalls} upcoming
                    </>
                  ) : "Loading..."}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {stats ? `${stats.video.activeRooms} active room${stats.video.activeRooms !== 1 ? "s" : ""}` : ""}
                </p>
                <Link to="/calendar">
                  <Button variant="ghost" className="px-0 mt-3 h-auto text-primary font-ui flex items-center gap-1" data-testid="link-view-appointments">
                    View Appointments <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </>
        )}

        <Card className="col-span-1 border-dashed border-2" data-testid="card-system-status">
          <CardHeader>
            <CardTitle className="text-lg font-ui text-muted-foreground flex items-center gap-2">
              <Activity className="w-5 h-5" />
              System Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-[hsl(var(--brand-success))] animate-pulse" />
              <span className="text-sm font-ui">All Systems Operational</span>
            </div>
            <p className="text-xs text-muted-foreground">Last checked: Just now</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
