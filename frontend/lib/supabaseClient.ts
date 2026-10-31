"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL_KEY = "alphaforge.supabase.url";
export const SUPABASE_ANON_KEY = "alphaforge.supabase.anon";

/** Compile-time defaults (Vercel / .env.local). */
export const ENV_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const ENV_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function readStoredConfig(): SupabaseConfig {
  if (typeof window === "undefined") return { url: "", anonKey: "" };
  try {
    return {
      url: window.localStorage.getItem(SUPABASE_URL_KEY) ?? "",
      anonKey: window.localStorage.getItem(SUPABASE_ANON_KEY) ?? "",
    };
  } catch {
    return { url: "", anonKey: "" };
  }
}

export function writeStoredConfig(config: SupabaseConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SUPABASE_URL_KEY, config.url ?? "");
    window.localStorage.setItem(SUPABASE_ANON_KEY, config.anonKey ?? "");
  } catch {
    /* storage disabled — runtime config only */
  }
}

/** Settings-tab values win over build-time env so the app is configurable live. */
export function resolveConfig(override?: Partial<SupabaseConfig>): SupabaseConfig {
  const stored = readStoredConfig();
  return {
    url: override?.url ?? (stored.url || ENV_URL),
    anonKey: override?.anonKey ?? (stored.anonKey || ENV_ANON),
  };
}

let cached: SupabaseClient | null = null;
let cachedKey = "";

export function getSupabaseClient(): SupabaseClient | null {
  const { url, anonKey } = resolveConfig();
  if (!url || !anonKey) return null;
  const signature = `${url}|${anonKey}`;
  if (cached && cachedKey === signature) return cached;
  try {
    cached = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    cachedKey = signature;
    return cached;
  } catch {
    return null;
  }
}

export function resetSupabaseClient() {
  cached = null;
  cachedKey = "";
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = resolveConfig();
  return Boolean(url && anonKey);
}
