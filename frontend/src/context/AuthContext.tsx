import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter, useSegments } from "expo-router";

import { api, clearToken, saveToken } from "@/src/lib/api";
import type { Business } from "@/src/lib/types";

type Me = { id: string; email: string; business_id: string; name?: string | null };

type AuthCtx = {
  user: Me | null;
  business: Business | null;
  loading: boolean;
  bootstrapping: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, businessName: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshBusiness: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [loading, setLoading] = useState(false);
  const segments = useSegments();
  const router = useRouter();

  const loadSession = useCallback(async () => {
    try {
      const me = await api.get<Me>("/auth/me");
      setUser(me);
      const biz = await api.get<Business>("/business/me");
      setBusiness(biz);
    } catch {
      setUser(null);
      setBusiness(null);
      await clearToken();
    }
  }, []);

  const refreshBusiness = useCallback(async () => {
    try {
      const biz = await api.get<Business>("/business/me");
      setBusiness(biz);
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    (async () => {
      await loadSession();
      setBootstrapping(false);
    })();
  }, [loadSession]);

  // Route guard
  useEffect(() => {
    if (bootstrapping) return;
    const inAuth = segments[0] === "(auth)";
    const inOnboarding = segments[0] === "onboarding";
    if (!user && !inAuth) {
      router.replace("/(auth)/sign-in");
    } else if (user && business && !business.onboarded && !inOnboarding) {
      router.replace("/onboarding");
    } else if (user && business?.onboarded && (inAuth || inOnboarding)) {
      router.replace("/(app)/dashboard");
    } else if (user && inAuth) {
      // fallback: user signed in but business not loaded yet
      router.replace("/(app)/dashboard");
    }
  }, [user, business, bootstrapping, segments, router]);

  const signIn = async (email: string, password: string) => {
    setLoading(true);
    try {
      const res = await api.post<{ access_token: string }>("/auth/login", { email, password });
      await saveToken(res.access_token);
      await loadSession();
    } finally {
      setLoading(false);
    }
  };

  const signUp = async (email: string, password: string, businessName: string) => {
    setLoading(true);
    try {
      const res = await api.post<{ access_token: string }>("/auth/register", {
        email,
        password,
        business_name: businessName,
      });
      await saveToken(res.access_token);
      await loadSession();
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    await clearToken();
    setUser(null);
    setBusiness(null);
    router.replace("/(auth)/sign-in");
  };

  return (
    <AuthContext.Provider value={{ user, business, loading, bootstrapping, signIn, signUp, signOut, refreshBusiness }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
