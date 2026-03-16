import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Eye, EyeOff, Check, X } from "lucide-react";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setIsValidating(false);
      return;
    }
    fetch(`/api/auth/validate-reset-token/${token}`)
      .then((res) => {
        setTokenValid(res.ok);
        setIsValidating(false);
      })
      .catch(() => {
        setTokenValid(false);
        setIsValidating(false);
      });
  }, [token]);

  const checks = useMemo(() => ({
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
  }), [password]);

  const allChecksPassed = checks.length && checks.uppercase && checks.lowercase && checks.number;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!allChecksPassed) {
      setError("Please meet all password requirements.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to reset password");
      }

      navigate("/auth", { state: { passwordReset: true } });
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isValidating) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!tokenValid) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <Card className="w-full max-w-md border-none shadow-2xl shadow-primary/5">
          <CardHeader className="text-center pb-4">
            <CardTitle className="font-display text-2xl font-heading text-destructive" data-testid="text-page-title">
              Invalid Reset Link
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              This password reset link is invalid or has expired. Please request a new one.
            </p>
            <Button
              onClick={() => navigate("/forgot-password")}
              className="font-ui"
              data-testid="button-request-new"
            >
              Request New Link
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md border-none shadow-2xl shadow-primary/5">
        <CardHeader className="space-y-2 text-center pb-4">
          <CardTitle className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">
            Reset your password
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Please enter your new password.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="New Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 rounded-lg pr-10"
                  data-testid="input-new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="Confirm New Password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-12 rounded-lg pr-10"
                  data-testid="input-confirm-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-toggle-confirm-password"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs" data-testid="password-requirements">
              {[
                { key: "length", label: "At least 8 characters", met: checks.length },
                { key: "uppercase", label: "At least 1 capital letter", met: checks.uppercase },
                { key: "lowercase", label: "At least 1 lowercase letter", met: checks.lowercase },
                { key: "number", label: "At least 1 number", met: checks.number },
              ].map((req) => (
                <div key={req.key} className="flex items-center gap-1.5">
                  {req.met ? (
                    <Check className="w-3.5 h-3.5 text-[hsl(var(--brand-success))]" />
                  ) : (
                    <X className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                  <span className={req.met ? "text-foreground" : "text-muted-foreground"}>
                    {req.label}
                  </span>
                </div>
              ))}
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-reset-error">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full h-12 text-base font-ui shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all"
              disabled={isSubmitting || !allChecksPassed}
              data-testid="button-save-password"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : "Save"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
