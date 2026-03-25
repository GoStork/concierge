import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Mail, ArrowLeft } from "lucide-react";

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError("Please enter your email address.");
      return;
    }
    setError("");
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Something went wrong");
      }

      navigate('/check-email', { state: { email: email.trim() } });
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md border-none shadow-2xl shadow-primary/5">
        <CardHeader className="space-y-2 text-center pb-4">
          <CardTitle className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">
            Reset your password
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Don't worry, just enter the email address you registered with and we will send you a link to reset your password.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 rounded-[var(--radius)]"
                data-testid="input-reset-email"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" data-testid="text-reset-error">{error}</p>
            )}
            <Button
              type="submit"
              className="w-full h-12 text-base font-ui shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all"
              disabled={isSubmitting}
              data-testid="button-reset-submit"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : "Reset"}
            </Button>
            <button
              type="button"
              onClick={() => navigate("/auth")}
              className="flex items-center gap-1 mx-auto text-sm text-muted-foreground hover:text-primary cursor-pointer transition-colors font-ui"
              data-testid="link-back-to-login"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Login
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
