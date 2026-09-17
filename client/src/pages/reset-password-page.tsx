import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Eye, EyeOff, Check, X } from "lucide-react";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  // Family-account invitations reuse this page with ?invite=1: same token
  // mechanics, different words - the reader has never had a password here.
  const [searchParams] = useSearchParams();
  // First password vs reset, and for WHOM: the server says (validate-reset-
  // token returns invite + audience + orgName). The URL flag stays as the
  // first-paint hint for family invitations.
  const [serverInvite, setServerInvite] = useState<boolean | null>(null);
  const [audience, setAudience] = useState<"provider" | "family" | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const isInvite = serverInvite ?? (searchParams.get("invite") === "1");
  const isProviderInvite = isInvite && audience === "provider";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [error, setError] = useState("");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = isInvite ? "Set your password - GoStork" : "Reset your password - GoStork";
    return () => { document.title = prev; };
  }, [isInvite]);

  useEffect(() => {
    if (!token) {
      setIsValidating(false);
      return;
    }
    fetch(`/api/auth/validate-reset-token/${token}`)
      .then(async (res) => {
        setTokenValid(res.ok);
        if (res.ok) {
          try {
            const d = await res.json();
            if (d?.email) setAccountEmail(String(d.email));
            if (typeof d?.invite === "boolean") setServerInvite(d.invite);
            if (d?.audience === "provider" || d?.audience === "family") setAudience(d.audience);
            if (d?.orgName) setOrgName(String(d.orgName));
          } catch { /* optional */ }
        }
        setIsValidating(false);
      })
      .catch(() => {
        setTokenValid(false);
        setIsValidating(false);
      });
  }, [token]);

  // One rule, the same one signup enforces: 8 characters. The partner used
  // to meet four rules the owner never met, on the same account.
  const checks = useMemo(() => ({ length: password.length >= 8 }), [password]);
  const allChecksPassed = checks.length;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!allChecksPassed) {
      setError("Use at least 8 characters.");
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

      navigate("/auth", { state: isInvite ? { passwordSet: true, passwordSetAudience: audience, orgName, prefillEmail: accountEmail } : { passwordReset: true, prefillEmail: accountEmail } });
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
        <Card className="w-full max-w-md border border-border shadow-none">
          <CardHeader className="text-center pb-4">
            <CardTitle className="font-display text-2xl font-heading text-foreground" data-testid="text-page-title">
              {isInvite ? "This invitation link has expired" : "Invalid Reset Link"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="t-helper">
              {isInvite
                ? "Invitation links work for 7 days. Request a new one with the email address you were invited on and we will send a fresh invitation."
                : "This password reset link is invalid or has expired. Please request a new one."}
            </p>
            <Button
              onClick={() => navigate(isInvite ? "/forgot-password?invite=1" : "/forgot-password")}
              className="font-ui rounded-full h-11"
              data-testid="button-request-new"
            >
              {isInvite ? "Send me a new invitation" : "Request a new link"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md border border-border shadow-none">
        <CardHeader className="space-y-2 text-center pb-4">
          <CardTitle className="font-display t-page-title text-primary" data-testid="text-page-title">
            {isProviderInvite ? "Welcome to GoStork - set your password" : isInvite ? "Welcome - set your password" : "Reset your password"}
          </CardTitle>
          <p className="t-helper">
            {isProviderInvite
              ? `Your account${orgName ? ` for ${orgName}` : ""} is ready. Choose a password, then sign in - setup takes under an hour and you can do it in pieces.`
              : isInvite
              ? "You've been added to your family's account. Choose a password, then sign in to finish setting up."
              : "Please enter your new password."}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">{isInvite ? "Password" : "New password"}</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  placeholder={isInvite ? "At least 8 characters" : "New password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 rounded-[var(--radius)] pr-10"
                  data-testid="input-new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">{isInvite ? "Confirm password" : "Confirm new password"}</Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder={isInvite ? "Type it again" : "Confirm new password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-12 rounded-[var(--radius)] pr-10"
                  data-testid="input-confirm-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  aria-label={showConfirmPassword ? "Hide confirmation" : "Show confirmation"}
                  aria-pressed={showConfirmPassword}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="button-toggle-confirm-password"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <p className="t-helper flex items-center gap-1.5" data-testid="password-requirements">
              {checks.length ? <Check className="w-3.5 h-3.5 text-[hsl(var(--brand-success))]" aria-hidden="true" /> : <X className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />}
              At least 8 characters
            </p>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-reset-error">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full h-12 text-base font-ui rounded-full"
              disabled={isSubmitting || !allChecksPassed}
              data-testid="button-save-password"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {isInvite ? "Setting up..." : "Saving..."}
                </>
              ) : (isInvite ? "Set password and continue" : "Save new password")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
