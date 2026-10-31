"use client";

/**
 * Supabase Auth.
 *
 * AlphaForge is shared publicly: anonymous visitors can browse every strategy
 * (the RLS read policy is open) but only a signed-in owner may create, optimise,
 * trade or change settings. `requireAccount()` is the single gate the UI calls
 * before any mutating action.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { getSupabaseClient } from "./supabaseClient";

export interface AuthState {
  ready: boolean;
  session: Session | null;
  user: User | null;
  /** True when there is a Supabase client but nobody is signed in. */
  isGuest: boolean;
  /** Sign-up succeeded but the project requires an email confirmation first. */
  awaitingConfirmation: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signUp: (email: string, password: string) => Promise<{ ok: boolean; error?: string; needsConfirmation?: boolean }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}

function friendlyError(error: { message?: string } | null | undefined): string {
  const message = (error?.message ?? "").toLowerCase();
  if (message.includes("invalid login credentials")) {
    return "That email and password combination was not recognised.";
  }
  if (message.includes("email not confirmed")) {
    return "Your email address has not been confirmed yet — check your inbox.";
  }
  if (message.includes("user already registered")) {
    return "An account with that email already exists. Try signing in instead.";
  }
  if (message.includes("password should be at least")) {
    return "Passwords need to be at least 6 characters.";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "Could not reach Supabase. Check the URL and anon key in Settings.";
  }
  return error?.message ?? "Something went wrong. Please try again.";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let active = true;
    const client = getSupabaseClient();
    setConfigured(Boolean(client));
    if (!client) {
      setReady(true);
      return () => {
        active = false;
      };
    }

    client.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setReady(true);
    });

    const { data: subscription } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      if (next) setAwaitingConfirmation(false);
    });

    return () => {
      active = false;
      subscription?.subscription?.unsubscribe?.();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const client = getSupabaseClient();
    if (!client) return { ok: false, error: "Supabase is not configured." };
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: friendlyError(error) };
    return { ok: true };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const client = getSupabaseClient();
    if (!client) return { ok: false, error: "Supabase is not configured." };
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) return { ok: false, error: friendlyError(error) };
    // With email confirmation ON Supabase returns a user but no session.
    const needsConfirmation = !data.session;
    setAwaitingConfirmation(needsConfirmation);
    return { ok: true, needsConfirmation };
  }, []);

  const signOut = useCallback(async () => {
    const client = getSupabaseClient();
    if (client) await client.auth.signOut();
    setSession(null);
    setAwaitingConfirmation(false);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      isGuest: !session?.user,
      awaitingConfirmation,
      configured,
      signIn,
      signUp,
      signOut,
    }),
    [ready, session, awaitingConfirmation, configured, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
