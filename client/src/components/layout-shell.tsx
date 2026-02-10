import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { 
  LogOut, 
  Baby, 
  Stethoscope, 
  Shield, 
  Menu, 
  User, 
  LayoutDashboard,
  Search,
  Building2,
  Users
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const { user, logoutMutation } = useAuth();
  const [location] = useLocation();

  if (!user) return <>{children}</>;

  const isAdmin = user.tier === 'GOSTORK_ADMIN';
  const isProvider = user.tier === 'PROVIDER';
  const isParent = user.tier === 'INTENDED_PARENT';

  const NavLink = ({ href, icon: Icon, children }: any) => (
    <Link href={href} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
      location === href 
        ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20 font-medium' 
        : 'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground'
    }`}>
      <Icon className="w-5 h-5" />
      <span>{children}</span>
    </Link>
  );

  const navigation = [
    { 
      show: true, 
      href: '/dashboard', 
      icon: LayoutDashboard, 
      label: 'Dashboard' 
    },
    { 
      show: isParent, 
      href: '/marketplace', 
      icon: Search, 
      label: 'Marketplace' 
    },
    { 
      show: isAdmin, 
      href: '/admin/providers', 
      icon: Building2, 
      label: 'Manage Providers' 
    },
    { 
      show: isProvider, 
      href: '/provider/inventory', 
      icon: Baby, 
      label: 'My Inventory' 
    },
    { 
      show: isAdmin || (isProvider && user.role === 'ADMIN'), 
      href: '/users', 
      icon: Users, 
      label: 'Staff / Users' 
    },
  ];

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center text-white shadow-lg shadow-primary/30">
            <Baby className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-display font-bold text-xl text-primary">GoStork</h1>
            <p className="text-xs text-muted-foreground tracking-wider uppercase font-medium">Platform</p>
          </div>
        </div>

        <nav className="space-y-2">
          {navigation.filter(item => item.show).map((item) => (
            <NavLink key={item.href} href={item.href} icon={item.icon}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="mt-auto p-6 border-t border-border/50">
        <div className="flex items-center gap-3 mb-4 px-2">
          <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center text-accent">
            <User className="w-4 h-4" />
          </div>
          <div className="overflow-hidden">
            <p className="text-sm font-medium truncate">{user.username}</p>
            <p className="text-xs text-muted-foreground truncate capitalize">{user.role.replace('_', ' ').toLowerCase()}</p>
          </div>
        </div>
        <Button 
          variant="outline" 
          className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/5"
          onClick={() => logoutMutation.mutate()}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-72 bg-card border-r border-border/40 fixed inset-y-0 z-50">
        <SidebarContent />
      </aside>

      {/* Mobile Sidebar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-card border-b border-border/40 flex items-center px-4 z-40 justify-between">
         <div className="flex items-center gap-2">
          <Baby className="w-6 h-6 text-primary" />
          <span className="font-display font-bold text-lg text-primary">GoStork</span>
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon">
              <Menu className="w-6 h-6" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-80">
            <SidebarContent />
          </SheetContent>
        </Sheet>
      </div>

      <main className="flex-1 lg:ml-72 pt-16 lg:pt-0 min-h-screen transition-all duration-300">
        <div className="max-w-7xl mx-auto p-4 md:p-8 lg:p-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
          {children}
        </div>
      </main>
    </div>
  );
}
