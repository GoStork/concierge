import { useForm } from "react-hook-form";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, Baby, Loader2, CheckCircle2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useEffect, useRef, useCallback } from "react";
import { useCompanyName, useBrandSettings } from "@/hooks/use-brand-settings";

export default function AuthPage() {
  const { user, loginMutation } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const companyName = useCompanyName();
  const { data: brandSettings } = useBrandSettings();
  const autoLoginAttempted = useRef(false);
  const passwordReset = (location.state as any)?.passwordReset;
  const returnTo = (location.state as any)?.returnTo;

  useEffect(() => {
    if (user) {
      navigate(returnTo || "/dashboard", { replace: true });
    }
  }, [user, navigate, returnTo]);

  const loginForm = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onLogin = useCallback((data: any) => {
    loginMutation.mutate(data);
  }, [loginMutation]);

  useEffect(() => {
    if (autoLoginAttempted.current || user) return;
    // Skip autofill auto-login if the user just signed out
    const justLoggedOut = sessionStorage.getItem("just_logged_out");
    if (justLoggedOut) {
      sessionStorage.removeItem("just_logged_out");
      autoLoginAttempted.current = true;
      return;
    }
    const checkAutofill = () => {
      if (autoLoginAttempted.current) return;
      const emailEl = document.getElementById("email") as HTMLInputElement | null;
      const passEl = document.getElementById("password") as HTMLInputElement | null;
      if (emailEl?.value && passEl?.value) {
        autoLoginAttempted.current = true;
        loginForm.setValue("email", emailEl.value);
        loginForm.setValue("password", passEl.value);
        onLogin({ email: emailEl.value, password: passEl.value });
      }
    };
    const timers = [
      setTimeout(checkAutofill, 300),
      setTimeout(checkAutofill, 600),
      setTimeout(checkAutofill, 1200),
    ];
    return () => timers.forEach(clearTimeout);
  }, [user, loginForm, onLogin]);

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col bg-primary relative overflow-hidden p-12 text-primary-foreground">
        <div className="absolute top-0 right-0 w-96 h-96 bg-accent opacity-20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-white opacity-10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />
        
        <div className="relative z-10 flex-1 flex flex-col justify-between">
          <div className="flex items-center gap-3">
            {brandSettings?.logoWithNameUrl ? (
              <img src={getPhotoSrc(brandSettings.logoWithNameUrl) || brandSettings.logoWithNameUrl} alt={companyName} className="h-20 object-contain brightness-0 invert" data-testid="img-login-logo" />
            ) : brandSettings?.darkLogoWithNameUrl ? (
              <img src={getPhotoSrc(brandSettings.darkLogoWithNameUrl) || brandSettings.darkLogoWithNameUrl} alt={companyName} className="h-20 object-contain" data-testid="img-login-logo" />
            ) : brandSettings?.logoUrl || brandSettings?.darkLogoUrl ? (
              <>
                <img src={getPhotoSrc(brandSettings.logoUrl || brandSettings.darkLogoUrl) || (brandSettings.logoUrl || brandSettings.darkLogoUrl)!} alt="" className="w-20 h-20 rounded-[var(--radius)] object-contain" data-testid="img-login-logo" />
                <span className="font-display font-heading text-2xl tracking-wide">{companyName}</span>
              </>
            ) : (
              <>
                <div className="w-12 h-12 bg-white/10 backdrop-blur rounded-[var(--radius)] flex items-center justify-center">
                  <Baby className="w-7 h-7 text-white" />
                </div>
                <span className="font-display font-heading text-2xl tracking-wide">{companyName}</span>
              </>
            )}
          </div>

          <div className="max-w-md">
            <h1 className="font-display text-5xl font-heading leading-heading mb-6 text-primary-foreground">
              Your Journey to Parenthood Starts Here
            </h1>
            <p className="text-lg text-primary-foreground/80 leading-body">
              The most trusted marketplace connecting intended parents with fertility clinics, egg donor agencies, and surrogacy centers worldwide.
            </p>
          </div>

          <div className="flex items-center gap-4 text-sm opacity-60">
            <span>{companyName} Inc.</span>
            <span>Privacy Policy</span>
            <span>Terms of Service</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 bg-background">
        <Card className="w-full max-w-md border-none shadow-2xl shadow-primary/5">
          <CardHeader className="space-y-2 text-center pb-6">
            <CardTitle className="font-display text-3xl font-heading text-primary" data-testid="text-auth-title">
              Login
            </CardTitle>
          </CardHeader>
          <CardContent>
              <div className="space-y-4">
                {passwordReset && (
                  <div className="flex items-center gap-2 p-3 rounded-[var(--radius)] bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] text-sm" data-testid="text-password-reset-success">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Your password has been reset successfully. Please sign in with your new password.
                  </div>
                )}
                <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input 
                      id="email" 
                      type="email"
                      placeholder="Enter your email"
                      className="h-12 rounded-[var(--radius)]"
                      data-testid="input-email"
                      {...loginForm.register("email")} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input 
                      id="password" 
                      type="password" 
                      placeholder="Enter your password"
                      className="h-12 rounded-[var(--radius)]"
                      data-testid="input-password"
                      {...loginForm.register("password")} 
                    />
                  </div>
                  {loginMutation.isError && (
                    <div className="flex items-center gap-2 p-3 rounded-[var(--radius)] bg-destructive/10 border border-destructive/20 text-sm text-destructive" data-testid="text-login-error">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>Invalid email or password. Please try again.</span>
                    </div>
                  )}
                  <Button 
                    type="submit" 
                    className="w-full h-12 text-base font-ui shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all"
                    disabled={loginMutation.isPending}
                    data-testid="button-login"
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Signing In...
                      </>
                    ) : "Sign In"}
                  </Button>
                </form>
                <p className="text-center text-sm text-muted-foreground">
                  Forgot your password?{" "}
                  <button
                    type="button"
                    onClick={() => navigate('/forgot-password')}
                    className="text-primary hover:text-primary/80 cursor-pointer transition-colors font-ui"
                    data-testid="link-reset-password"
                  >
                    Reset Password
                  </button>
                </p>
                <p className="text-center text-sm text-muted-foreground">
                  Don't have an account?{" "}
                  <button
                    type="button"
                    onClick={() => navigate('/onboarding')}
                    className="text-primary hover:text-primary/80 cursor-pointer transition-colors font-ui"
                    data-testid="link-join-us"
                  >
                    Join us
                  </button>
                </p>
              </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
