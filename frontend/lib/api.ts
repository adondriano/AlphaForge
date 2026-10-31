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
