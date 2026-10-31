"use client";

/**
 * Engine client.
 *
 * Prefers the Python FastAPI engine (`NEXT_PUBLIC_API_URL`). If it is not
 * configured or unreachable, every call transparently falls back to the
 * in-browser engine in `lib/engine.ts`, so the studio never dead-ends.
 */

import { analyzeStrategy, generateBars, optimize, runBacktest, type Bar } from "./engine";
import { heuristicTranspile, type TranspileResult } from "./transpiler";
import type {
  AnalysisReport,
  AppSettings,
  BacktestResult,
  Mt5CandleSeries,
  Mt5Quote,
  Mt5Status,
  Metrics,
  OptimizeResult,
  Strategy,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export type EngineStatus = {
  mode: "python" | "local";
  reachable: boolean;
  label: string;
  detail?: string;
  integrations?: {
    supabase?: { mode?: string; reachable?: boolean };
    llm?: { provider?: string };
    optimizer?: string;
    mt5?: { mode?: string; connected?: boolean };
  };
};

let status: EngineStatus = {
  mode: API_URL ? "python" : "local",
  reachable: false,
  label: API_URL ? "Python engine · checking" : "In-browser engine",
};

const statusListeners = new Set<(status: EngineStatus) => void>();

export function getEngineStatus(): EngineStatus {
  return status;
}

export function onEngineStatus(listener: (status: EngineStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function setStatus(next: EngineStatus) {
  status = next;
  statusListeners.forEach((listener) => listener(status));
}

async function request<T>(path: string, body: unknown, timeoutMs = 20000): Promise<T> {
  if (!API_URL) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function get<T>(path: string, timeoutMs = 8000): Promise<T> {
  if (!API_URL) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_URL}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshEngineStatus(): Promise<EngineStatus> {
  if (!API_URL) {
    setStatus({
      mode: "local",
      reachable: false,
      label: "In-browser engine",
      detail: "NEXT_PUBLIC_API_URL is not set — the TypeScript engine is running in your browser.",
    });
    return status;
  }
  try {
    const health = await get<{
      engine: { backtest: string; optimizer: string; analyzer: string };
      integrations: EngineStatus["integrations"];
    }>("/api/health", 6000);
    setStatus({
      mode: "python",
      reachable: true,
      label: "Python engine · online",
      detail: `FastAPI · ${health.engine.optimizer} · ${health.engine.analyzer}`,
      integrations: health.integrations,
    });
  } catch (error) {
    setStatus({
      mode: "local",
      reachable: false,
      label: "In-browser engine",
      detail: `Python engine unreachable at ${API_URL} — using the local TypeScript engine.`,
    });
  }
  return status;
}

/* -------------------------------------------------------------------------- */
/* strategy transpilation                                                      */
/* -------------------------------------------------------------------------- */

export interface TranspileResponse {
  spec: TranspileResult;
  meta: {
    engine: string;
    model?: string | null;
    error?: string | null;
    note?: string | null;
    warnings?: string[];
  };
}

export async function transpile(input: {
  text: string;
  sourceUrl?: string;
  transcript?: string;
  noLlm: boolean;
  name?: string;
  symbol?: string;
  timeframe?: string;
}): Promise<TranspileResponse> {
  const text = input.transcript?.trim() ? input.transcript : input.text;
  if (API_URL) {
    try {
      const response = await request<{
        spec: TranspileResult;
        meta: TranspileResponse["meta"];
      }>("/api/strategies/transpile", {
        text,
        source_url: input.sourceUrl ?? "",
        no_llm: input.noLlm,
        name: input.name,
        symbol: input.symbol,
        timeframe: input.timeframe,
      });
      return response;
    } catch {
      /* fall through to the local transpiler */
    }
  }
  const spec = heuristicTranspile(text, input.sourceUrl);
  if (input.name) spec.name = input.name;
  if (input.symbol) spec.symbol = input.symbol;
  if (input.timeframe) spec.timeframe = input.timeframe;
  return {
    spec,
    meta: {
      engine: "heuristic",
      note: input.noLlm
        ? "No-LLM mode: local heuristic transpiler."
        : "No LLM provider reachable — local heuristic transpiler used.",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* backtest / optimize / analyze                                               */
/* -------------------------------------------------------------------------- */

export interface BacktestOptions {
  bars?: number;
  seed?: number;
  split?: number;
  parameters?: Record<string, number>;
  maxDailyDdPct?: number;
  maxTotalDdPct?: number;
}

export async function backtest(
  strategy: Strategy,
  options: BacktestOptions = {},
): Promise<BacktestResult> {
  if (API_URL) {
    try {
      const response = await request<BacktestResult>(
        "/api/strategies/backtest",
        {
          spec: {
            name: strategy.name,
            symbol: strategy.symbol,
            timeframe: strategy.timeframe,
            description: strategy.description,
            source_type: strategy.source_type,
            source_url: strategy.source_url,
            side: strategy.rules?.side ?? "both",
            entries: strategy.rules?.entries ?? [],
            exits: strategy.rules?.exits ?? [],
            filters: strategy.rules?.filters ?? [],
            parameters: { ...strategy.parameters, ...(options.parameters ?? {}) },
            risk: strategy.risk_profile,
          },
          bars: options.bars ?? 3000,
          seed: options.seed ?? 7,
          split: options.split ?? 0.7,
        },
        30000,
      );
      return response;
    } catch {
      /* fall through */
    }
  }
  const bars: Bar[] = generateBars(
    strategy.symbol,
    strategy.timeframe,
    options.bars ?? 3000,
    options.seed ?? 7,
  );
  return runBacktest(strategy, {
    bars,
    seed: options.seed ?? 7,
    split: options.split ?? 0.7,
    parameters: options.parameters,
    maxDailyDdPct: options.maxDailyDdPct,
    maxTotalDdPct: options.maxTotalDdPct,
  });
}

export interface OptimizeOptions {
  nTrials?: number;
  objective?: string;
  bars?: number;
  seed?: number;
  split?: number;
  bounds?: Record<string, number[]>;
  maxDailyDdPct?: number;
  maxTotalDdPct?: number;
}

export async function optimizeStrategy(
  strategy: Strategy,
  options: OptimizeOptions = {},
): Promise<OptimizeResult> {
  if (API_URL) {
    try {
      const response = await request<{
        optimization: { version: number; engine: string };
        result: OptimizeResult;
      }>(
        "/api/strategies/optimize/compute",
        {
          spec: {
            name: strategy.name,
            symbol: strategy.symbol,
            timeframe: strategy.timeframe,
            side: strategy.rules?.side ?? "both",
            entries: strategy.rules?.entries ?? [],
            exits: strategy.rules?.exits ?? [],
            filters: strategy.rules?.filters ?? [],
            parameters: strategy.parameters,
            risk: strategy.risk_profile,
          },
          n_trials: options.nTrials ?? 40,
          objective: options.objective ?? "sharpe",
          seed: options.seed ?? 7,
          bars: options.bars ?? 3000,
          split: options.split ?? 0.7,
          param_bounds: options.bounds,
        },
        120000,
      );
      return { ...response.result, n_trials: options.nTrials ?? 40 };
    } catch {
      /* fall through */
    }
  }
  const bars = generateBars(
    strategy.symbol,
    strategy.timeframe,
    options.bars ?? 3000,
    options.seed ?? 7,
  );
  return optimize(strategy, {
    bars,
    nTrials: options.nTrials ?? 40,
    objective: options.objective ?? "sharpe",
    bounds: options.bounds,
    seed: options.seed ?? 7,
    split: options.split ?? 0.7,
    maxDailyDdPct: options.maxDailyDdPct,
    maxTotalDdPct: options.maxTotalDdPct,
  });
}

export interface AnalyzeOptions {
  bars?: number;
  seed?: number;
  split?: number;
  noLlm: boolean;
  baselineMetrics?: Metrics | null;
  maxDailyDdPct?: number;
  maxTotalDdPct?: number;
}

export async function analyze(
  strategy: Strategy,
  options: AnalyzeOptions,
): Promise<AnalysisReport> {
  if (API_URL) {
    try {
      const response = await request<AnalysisReport>(
        "/api/strategies/analyze/compute",
        {
          spec: {
            name: strategy.name,
            symbol: strategy.symbol,
            timeframe: strategy.timeframe,
            side: strategy.rules?.side ?? "both",
            entries: strategy.rules?.entries ?? [],
            exits: strategy.rules?.exits ?? [],
            filters: strategy.rules?.filters ?? [],
            parameters: strategy.parameters,
            risk: strategy.risk_profile,
          },
          bars: options.bars ?? 3000,
          seed: options.seed ?? 7,
          split: options.split ?? 0.7,
          no_llm: options.noLlm,
          baseline_metrics: options.baselineMetrics ?? null,
        },
        30000,
      );
      return response;
    } catch {
      /* fall through */
    }
  }
  const bars = generateBars(
    strategy.symbol,
    strategy.timeframe,
    options.bars ?? 3000,
    options.seed ?? 7,
  );
  const result = runBacktest(strategy, {
    bars,
    seed: options.seed ?? 7,
    split: options.split ?? 0.7,
    maxDailyDdPct: options.maxDailyDdPct,
    maxTotalDdPct: options.maxTotalDdPct,
  });
  return analyzeStrategy({
    strategyName: strategy.name,
    metrics: result.metrics,
    inSample: result.in_sample,
    outOfSample: result.out_of_sample,
    trades: result.trades,
    riskProfile: strategy.risk_profile,
    baselineMetrics: options.baselineMetrics ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* settings                                                                    */
/* -------------------------------------------------------------------------- */

export async function pushSettings(settings: AppSettings): Promise<boolean> {
  if (!API_URL) return false;
  try {
    await request("/api/settings", settings, 8000);
    return true;
  } catch {
    return false;
  }
}

export async function fetchSettings(): Promise<Partial<AppSettings> | null> {
  if (!API_URL) return null;
  try {
    return await get<{ settings: Partial<AppSettings> }>("/api/settings", 8000).then(
      (payload) => payload.settings ?? null,
    );
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* MetaTrader 5 bridge                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Returned whenever the engine cannot be reached. The UI renders an explicit
 * "connect MT5" state from this — it must never invent a price.
 */
export const MT5_UNAVAILABLE: Mt5Status = {
  available: false,
  connected: false,
  mode: "unavailable",
  configured: false,
  reason:
    API_URL
      ? "The Python engine is unreachable. Start it locally (`uvicorn main:app --port 8000`) on the machine that has MetaTrader 5 installed."
      : "NEXT_PUBLIC_API_URL is not set. Live quotes require the local Python engine running beside MetaTrader 5 — MetaTrader 5 cannot be reached from a hosted deployment.",
};

export interface Mt5Credentials {
  path?: string;
  login?: string;
  password?: string;
  server?: string;
  timeout?: number;
}

export async function mt5Status(): Promise<Mt5Status> {
  if (!API_URL) return MT5_UNAVAILABLE;
  try {
    return await get<Mt5Status>("/api/mt5/status", 8000);
  } catch {
    return MT5_UNAVAILABLE;
  }
}

/** Launch the terminal (if needed) and log in. Blank fields use saved settings. */
export async function mt5Connect(
  credentials: Mt5Credentials = {},
): Promise<Mt5Status & { reason?: string }> {
  if (!API_URL) return MT5_UNAVAILABLE;
  const outcome = await request<{ connected: boolean; reason?: string; status?: Mt5Status }>(
    "/api/mt5/connect",
    credentials,
    90000,
  );
  return outcome.status ?? { ...(outcome as Mt5Status) };
}

export async function mt5Disconnect(): Promise<Mt5Status> {
  if (!API_URL) return MT5_UNAVAILABLE;
  try {
    const outcome = await request<{ status?: Mt5Status }>("/api/mt5/disconnect", {}, 15000);
    return outcome.status ?? MT5_UNAVAILABLE;
  } catch {
    return MT5_UNAVAILABLE;
  }
}

export async function mt5Price(symbol: string): Promise<Mt5Quote> {
  if (!API_URL) {
    return { available: false, symbol, reason: MT5_UNAVAILABLE.reason };
  }
  try {
    return await get<Mt5Quote>(`/api/mt5/price?symbol=${encodeURIComponent(symbol)}`, 8000);
  } catch {
    return { available: false, symbol, reason: MT5_UNAVAILABLE.reason };
  }
}

export async function mt5Candles(
  symbol: string,
  timeframe = "H1",
  count = 120,
): Promise<Mt5CandleSeries> {
  if (!API_URL) {
    return {
      available: false,
      symbol,
      timeframe,
      candles: [],
      reason: MT5_UNAVAILABLE.reason,
    };
  }
  try {
    return await get<Mt5CandleSeries>(
      `/api/mt5/candles?symbol=${encodeURIComponent(symbol)}` +
        `&timeframe=${encodeURIComponent(timeframe)}&count=${count}`,
      10000,
    );
  } catch {
    return {
      available: false,
      symbol,
      timeframe,
      candles: [],
      reason: MT5_UNAVAILABLE.reason,
    };
  }
}

export async function mt5Symbols(needle = ""): Promise<string[]> {
  if (!API_URL) return [];
  try {
    const outcome = await get<{ available: boolean; symbols: string[] }>(
      `/api/mt5/symbols?needle=${encodeURIComponent(needle)}`,
      8000,
    );
    return outcome.symbols ?? [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* reset                                                                       */
/* -------------------------------------------------------------------------- */

export async function resetEngine(user_id?: string | null): Promise<boolean> {
  if (!API_URL) return false;
  try {
    await request<{ removed: number }>("/api/reset", { user_id, scope: "user" }, 30000);
    return true;
  } catch {
    return false;
  }
}
