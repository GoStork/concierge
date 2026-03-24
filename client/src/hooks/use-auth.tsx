import { createContext, ReactNode, useContext, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { type User, type InsertUser } from "@shared/schema";
import { api } from "@shared/routes";
import { getQueryFn, queryClient, apiRequest } from "../lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAppDispatch } from "@/store";
import { setUser, clearUser } from "@/store/authSlice";

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
  const dispatch = useAppDispatch();
  
  const {
    data: user,
    error,
    isLoading,
  } = useQuery<User | null>({
    queryKey: [api.auth.me.path],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  useEffect(() => {
    if (user) {
      dispatch(setUser(user));
    } else if (!isLoading) {
      dispatch(clearUser());
    }
  }, [user, isLoading, dispatch]);

  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const res = await apiRequest("POST", api.auth.login.path, credentials);
      return await res.json();
    },
    onSuccess: (user: User) => {
      queryClient.setQueryData([api.auth.me.path], user);
      dispatch(setUser(user));
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
    },
    onError: () => {
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", api.auth.logout.path);
    },
    onSuccess: () => {
      queryClient.clear();
      dispatch(clearUser());
      // Flag so auth page skips autofill auto-login
      sessionStorage.setItem("just_logged_out", "1");
      window.location.replace("/");
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
