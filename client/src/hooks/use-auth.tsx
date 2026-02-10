import { createContext, ReactNode, useContext } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { insertUserSchema, type User, type InsertUser } from "@shared/schema";
import { api } from "@shared/routes";
import { getQueryFn, queryClient, apiRequest } from "../lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  error: Error | null;
  loginMutation: any;
  logoutMutation: any;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  
  const {
    data: user,
    error,
    isLoading,
  } = useQuery<User | null>({
    queryKey: [api.auth.me.path],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const loginMutation = useMutation({
    mutationFn: async (credentials: Pick<InsertUser, "username" | "password">) => {
      const res = await apiRequest("POST", api.auth.login.path, credentials);
      return await res.json();
    },
    onSuccess: (user: User) => {
      queryClient.setQueryData([api.auth.me.path], user);
      toast({
        title: "Welcome back",
        description: `Logged in as ${user.username}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Login failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", api.auth.logout.path);
    },
    onSuccess: () => {
      queryClient.setQueryData([api.auth.me.path], null);
      toast({
        title: "Logged out",
        description: "See you next time",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Logout failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        isLoading,
        error,
        loginMutation,
        logoutMutation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
