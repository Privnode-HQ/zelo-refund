import type { Session } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getStoredAdminApiKey, setStoredAdminApiKey, clearStoredAdminApiKey } from '../lib/adminApiKey';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type AuthMode = 'supabase' | 'api_key';

type AuthContextValue = {
  mode: AuthMode;
  session: Session | null;
  bearerToken: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
  signInWithApiKey: (apiKey: string) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const mode: AuthMode = isSupabaseConfigured ? 'supabase' : 'api_key';
  const [session, setSession] = useState<Session | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    if (mode === 'api_key') {
      const stored = getStoredAdminApiKey();
      if (mounted) {
        setApiKey(stored);
        setLoading(false);
      }
      return () => {
        mounted = false;
      };
    }

    if (!supabase) {
      setSession(null);
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        setLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        setSession(null);
        setLoading(false);
      });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [mode]);

  const bearerToken = mode === 'supabase' ? session?.access_token ?? null : apiKey;

  const value = useMemo<AuthContextValue>(
    () => ({
      mode,
      session,
      bearerToken,
      loading,
      signOut: async () => {
        if (mode === 'supabase') {
          await supabase?.auth.signOut();
        } else {
          clearStoredAdminApiKey();
          setApiKey(null);
        }
      },
      signInWithApiKey: (nextApiKey: string) => {
        const trimmed = nextApiKey.trim();
        if (!trimmed) {
          throw new Error('请输入 API Key');
        }
        setStoredAdminApiKey(trimmed);
        setApiKey(trimmed);
      }
    }),
    [mode, session, bearerToken, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
};
