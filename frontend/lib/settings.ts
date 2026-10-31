"use client";

import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export const SETTINGS_KEY = "alphaforge.settings";

/** Values that must never be persisted to localStorage or echoed back in full. */
export const SECRET_FIELDS: (keyof AppSettings)[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "MT5_PASSWORD",
];

export function loadSettings(): AppSettings {
  const base: AppSettings = { ...DEFAULT_SETTINGS };
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...base, ...parsed };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return base;
}

export function saveSettings(settings: AppSettings): AppSettings {
  if (typeof window === "undefined") return settings;
  try {
    // Secrets stay in memory for the session only; they are never written to
    // browser storage (they belong in server-side env vars).
    const safe = { ...settings };
    for (const field of SECRET_FIELDS) delete (safe as Record<string, unknown>)[field];
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(safe));
  } catch {
    /* ignore */
  }
  return settings;
}

export function hasLlmConfigured(settings: AppSettings): boolean {
  const ollama = (settings.OLLAMA_URL ?? "").trim();
  const isLocalOllama =
    !ollama || ollama === "http://localhost:11434" || ollama === "http://127.0.0.1:11434";
  return Boolean(settings.OPENAI_API_KEY) || !isLocalOllama;
}

export function llmProvider(settings: AppSettings): "openai" | "ollama" | "none" {
  if (settings.OPENAI_API_KEY) return "openai";
  const ollama = (settings.OLLAMA_URL ?? "").trim();
  if (ollama && ollama !== "http://localhost:11434" && ollama !== "http://127.0.0.1:11434") {
    return "ollama";
  }
  return "none";
}
