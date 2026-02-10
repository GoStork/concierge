import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Baby, Users, Building2, Search, ArrowRight, Activity, Calendar } from "lucide-react";
import { Link } from "wouter";

export default function DashboardPage() {
  const { user } = useAuth();

  if (!user) return null;

  const isAdmin = user.tier === 'GOSTORK_ADMIN';
  const isProvider = user.tier === 'PROVIDER';
  const isParent = user.tier === 'INTENDED_PARENT';

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl md:text-4xl font-bold text-primary mb-2">
            Hello, {user.firstName || user.username}
          </h1>
          <p className="text-muted-foreground text-lg">
            Welcome to your GoStork command center.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm bg-secondary/50 px-4 py-2 rounded-full text-primary font-medium">
          <Calendar className="w-4 h-4" />
          <span>{new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Quick Stats / Actions Cards */}
        {isParent && (
          <Card className="col-span-1 md:col-span-2 lg:col-span-2 bg-gradient-to-br from-primary to-primary/90 text-primary-foreground border-none shadow-xl shadow-primary/20 relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 group-hover:opacity-10 transition-opacity duration-500" />
            <CardHeader>
              <CardTitle className="text-2xl font-display text-white">Find Your Perfect Match</CardTitle>
              <CardDescription className="text-primary-foreground/80 text-base">
                Browse thousands of egg donors and surrogates from top-rated agencies.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/marketplace">
                <Button variant="secondary" size="lg" className="font-semibold gap-2">
                  <Search className="w-4 h-4" />
                  Browse Marketplace
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {isProvider && (
           <Card className="hover:border-primary/50 transition-colors duration-300">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Inventory</CardTitle>
              <Baby className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">124</div>
              <p className="text-xs text-muted-foreground mt-1">
                +12% from last month
              </p>
              <Link href="/provider/inventory">
                <Button variant="link" className="px-0 mt-4 h-auto text-primary font-semibold flex items-center gap-1">
                  Manage Inventory <ArrowRight className="w-3 h-3" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {isAdmin && (
          <>
            <Card className="hover:border-primary/50 transition-colors duration-300">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Active Providers</CardTitle>
                <Building2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">48</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Across 12 countries
                </p>
                <Link href="/admin/providers">
                  <Button variant="link" className="px-0 mt-4 h-auto text-primary font-semibold flex items-center gap-1">
                    Manage Providers <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="hover:border-primary/50 transition-colors duration-300">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Users</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">2,350</div>
                <p className="text-xs text-muted-foreground mt-1">
                  +180 this week
                </p>
                <Link href="/users">
                  <Button variant="link" className="px-0 mt-4 h-auto text-primary font-semibold flex items-center gap-1">
                    View Users <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </>
        )}

        <Card className="col-span-1 border-dashed border-2 bg-secondary/10">
          <CardHeader>
            <CardTitle className="text-lg font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="w-5 h-5" />
              System Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium">All Systems Operational</span>
            </div>
            <p className="text-xs text-muted-foreground">Last checked: Just now</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
