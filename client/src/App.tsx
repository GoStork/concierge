import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/use-auth";
import { LayoutShell } from "@/components/layout-shell";

import NotFound from "@/pages/not-found";
import AuthPage from "@/pages/auth-page";
import DashboardPage from "@/pages/dashboard-page";
import InventoryPage from "@/pages/inventory-page";
import MarketplacePage from "@/pages/marketplace-page";
import AdminProvidersPage from "@/pages/admin-providers-page";

function Router() {
  return (
    <LayoutShell>
      <Switch>
        <Route path="/" component={AuthPage} />
        <Route path="/login" component={AuthPage} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/provider/inventory" component={InventoryPage} />
        <Route path="/marketplace" component={MarketplacePage} />
        <Route path="/admin/providers" component={AdminProvidersPage} />
        <Route component={NotFound} />
      </Switch>
    </LayoutShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
