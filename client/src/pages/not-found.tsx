import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center space-y-6 max-w-md">
        <div className="w-20 h-20 bg-destructive/10 text-destructive rounded-full flex items-center justify-center mx-auto mb-6">
          <AlertTriangle className="w-10 h-10" />
        </div>
        <h1 className="font-display text-4xl font-bold text-primary">Page Not Found</h1>
        <p className="text-muted-foreground text-lg">
          The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.
        </p>
        <div className="pt-4">
          <Link href="/dashboard">
            <Button size="lg" className="font-semibold shadow-lg shadow-primary/20">
              Return to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
