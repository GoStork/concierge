import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Baby, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { insertUserSchema } from "@shared/schema";

// Extend schema for client-side registration with password confirmation
const registerSchema = insertUserSchema.extend({
  confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export default function AuthPage() {
  const { user, loginMutation } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user) {
      setLocation("/dashboard");
    }
  }, [user, setLocation]);

  const loginForm = useForm({
    defaultValues: {
      username: "",
      password: "",
    },
  });

  const onLogin = (data: any) => {
    loginMutation.mutate(data);
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left Panel - Hero/Brand */}
      <div className="hidden lg:flex flex-col bg-primary relative overflow-hidden p-12 text-white">
        {/* Abstract Background Shapes */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-accent opacity-20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-white opacity-10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />
        
        <div className="relative z-10 flex-1 flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-white/10 backdrop-blur rounded-xl flex items-center justify-center">
              <Baby className="w-7 h-7 text-white" />
            </div>
            <span className="font-display font-bold text-2xl tracking-wide">GoStork</span>
          </div>

          <div className="max-w-md">
            <h1 className="font-display text-5xl font-bold leading-tight mb-6">
              Your Journey to Parenthood Starts Here
            </h1>
            <p className="text-lg text-primary-foreground/80 leading-relaxed">
              The most trusted marketplace connecting intended parents with fertility clinics, egg donor agencies, and surrogacy centers worldwide.
            </p>
          </div>

          <div className="flex items-center gap-4 text-sm opacity-60">
            <span>© 2024 GoStork Inc.</span>
            <span>•</span>
            <span>Privacy Policy</span>
            <span>•</span>
            <span>Terms of Service</span>
          </div>
        </div>
      </div>

      {/* Right Panel - Auth Forms */}
      <div className="flex items-center justify-center p-6 bg-background">
        <Card className="w-full max-w-md border-none shadow-2xl shadow-primary/5">
          <CardHeader className="space-y-4 text-center pb-8">
            <CardTitle className="font-display text-3xl font-bold text-primary">Welcome Back</CardTitle>
            <CardDescription className="text-base">
              Sign in to manage your fertility journey
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="login" className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-8 p-1 bg-secondary/50">
                <TabsTrigger value="login" className="rounded-md font-medium">Login</TabsTrigger>
                <TabsTrigger value="register" className="rounded-md font-medium">Create Account</TabsTrigger>
              </TabsList>

              <TabsContent value="login" className="space-y-4">
                <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input 
                      id="username" 
                      placeholder="Enter your username"
                      className="h-12 rounded-lg bg-secondary/20 border-border/50 focus:border-primary/50 focus:ring-primary/10"
                      {...loginForm.register("username")} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input 
                      id="password" 
                      type="password" 
                      placeholder="••••••••"
                      className="h-12 rounded-lg bg-secondary/20 border-border/50 focus:border-primary/50 focus:ring-primary/10"
                      {...loginForm.register("password")} 
                    />
                  </div>
                  <Button 
                    type="submit" 
                    className="w-full h-12 text-base font-semibold shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all"
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Signing In...
                      </>
                    ) : "Sign In"}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="register">
                <div className="text-center py-8 text-muted-foreground bg-secondary/20 rounded-xl border border-dashed border-border">
                  <p className="mb-2">Registration is invite-only for this demo.</p>
                  <p className="text-sm">Please use the admin credentials provided.</p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
