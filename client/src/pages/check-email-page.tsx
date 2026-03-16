import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Mail } from "lucide-react";

export default function CheckEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const email = (location.state as any)?.email || "";

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="flex justify-center">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <Mail className="w-10 h-10 text-primary" />
          </div>
        </div>
        <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">
          Check your email
        </h1>
        <div className="space-y-2 text-muted-foreground">
          <p className="text-sm">
            An email has been sent to your email address{email ? `, ${email}` : ""}.
          </p>
          <p className="text-sm">
            Follow the directions in the email to reset your password and then sign in again.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate("/auth")}
          className="font-ui"
          data-testid="button-back-to-login"
        >
          Back to Login
        </Button>
      </div>
    </div>
  );
}
