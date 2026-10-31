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
  BrokerCandle,
  BrokerCandleSeries,
  BrokerConnection,
  BrokerDescriptor,
  BrokerQuote,
  BrokerStatus,
  Metrics,
  OptimizeResult,
  Strategy,
} from "./types";

/**
 * Build-time engine location. `NEXT_PUBLIC_*` is baked into the bundle, so a
 * hosted deployment can only ever talk to the engine it was built with — which
 * is useless when the engine sits on your own Windows box next to MetaTrader 5.
 * `ENGINE_URL` (Settings tab) overrides it at runtime and is what makes the
 * local-terminal setup work without a redeploy.
 */
export const ENV_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

let runtimeUrl: string | null = null;
const urlListeners = new Set<(url: string) => void>();

export function apiUrl(): string {
  const override = (runtimeUrl ?? "").trim().replace(/\/+$/, "");
  return override || ENV_API_URL;
}

export function onApiUrl(listener: (url: string) => void): () => void {
  urlListeners.add(listener);
  return () => urlListeners.delete(listener);
}

/** Point the studio at a (possibly tunnelled) Python engine. Pass "" to reset. */
export function setApiUrl(next: string | null): string {
  setApiUrlSilent(next);
  void refreshEngineStatus();
  return apiUrl();
}

/** Same as `setApiUrl` but without triggering a health probe (startup path). */
export function setApiUrlSilent(next: string | null): void {
  const value = (next ?? "").trim().replace(/\/+$/, "");
  if (value === runtimeUrl) return;
  runtimeUrl = value;
  urlListeners.forEach((listener) => listener(apiUrl()));
}

export type EngineStatus = {
  mode: "python" | "local";
  reachable: boolean;
  label: string;
  detail?: string;
  integrations?: {
    supabase?: { mode?: string; reachable?: boolean };
    llm?: { provider?: string };
    optimizer?: string;
    brokers?: { providers?: string[]; vault_enabled?: boolean };
  };
};

let status: EngineStatus = {
  mode: apiUrl() ? "python" : "local",
  reachable: false,
  label: apiUrl() ? "Python engine · checking" : "In-browser engine",
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
  if (!apiUrl()) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl()}${path}`, {
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
  if (!apiUrl()) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl()}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Broker credential endpoints are authenticated: they refuse to trust a
 * user id from the body because these keys move real money. The caller's
 * Supabase JWT rides along in the Authorization header instead.
 */
/**
 * Status line plus the server's own `detail`.
 *
 * Throwing only `${response.status} ${response.statusText}` produced messages
 * like "401 Unauthorized", which tell the user nothing and — worse — look
 * identical whether the broker rejected credentials or our own engine refused
 * the session token.
 */
async function authErrorMessage(response: Response): Promise<string> {
  let detail = "";
  try {
    const payload: unknown = await response.json();
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<
      string,
      unknown
    >;
    const candidate = record.detail ?? record.message ?? record.error;
    detail =
      typeof candidate === "string"
        ? candidate
        : candidate
          ? JSON.stringify(candidate).slice(0, 200)
          : "";
  } catch {
    /* empty or non-JSON body — the status line is all we have */
  }
  const head = `${response.status} ${response.statusText}`;
  return detail ? `${head} — ${detail}` : head;
}

async function getAuth<T>(path: string, token: string, timeoutMs = 8000): Promise<T> {
  if (!apiUrl()) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await authErrorMessage(response));
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function requestAuth<T>(
  path: string,
  body: unknown,
  token: string,
  timeoutMs = 20000,
): Promise<T> {
  if (!apiUrl()) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await authErrorMessage(response));
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function deleteAuth<T>(path: string, token: string, timeoutMs = 15000): Promise<T> {
  if (!apiUrl()) throw new Error("no api url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl()}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await authErrorMessage(response));
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshEngineStatus(): Promise<EngineStatus> {
  if (!apiUrl()) {
    setStatus({
      mode: "local",
      reachable: false,
      label: "In-browser engine",
      detail:
        "No Python engine configured — set Engine URL in Settings (or NEXT_PUBLIC_API_URL at build time). The TypeScript engine is running in your browser until then.",
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
      detail: `Python engine unreachable at ${apiUrl()} — using the local TypeScript engine.`,
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
  if (apiUrl()) {
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
  if (apiUrl()) {
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
  if (apiUrl()) {
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
  if (apiUrl()) {
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
  if (!apiUrl()) return false;
  try {
    await request("/api/settings", settings, 8000);
    return true;
  } catch {
    return false;
  }
}

export async function fetchSettings(): Promise<Partial<AppSettings> | null> {
  if (!apiUrl()) return null;
  try {
    return await get<{ settings: Partial<AppSettings> }>("/api/settings", 8000).then(
      (payload) => payload.settings ?? null,
    );
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Broker connections                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Returned whenever the engine cannot be reached. The UI renders an explicit
 * disconnected state from this — it must never invent a price.
 */
export const BROKER_UNAVAILABLE: BrokerStatus = {
  available: false,
  connected: false,
  mode: "unavailable",
  configured: false,
  reason: apiUrl()
    ? "The Python engine is unreachable, so no broker connection can be checked."
    : "No Python engine configured. Set Engine URL in Settings to connect a broker.",
};

/** The catalogue of providers and the credential fields each one needs. */
export async function brokerCatalogue(): Promise<{
  providers: BrokerDescriptor[];
  vault_enabled: boolean;
  vault_error?: string | null;
}> {
  if (!apiUrl()) return { providers: [], vault_enabled: false };
  try {
    return await get<{
      providers: BrokerDescriptor[];
      vault_enabled: boolean;
      vault_error?: string | null;
    }>("/api/brokers", 8000);
  } catch {
    return { providers: [], vault_enabled: false };
  }
}

export async function brokerStatus(
  token?: string,
  connectionId?: string,
): Promise<BrokerStatus> {
  if (!apiUrl()) return BROKER_UNAVAILABLE;
  const query = connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : "";
  // A status check is a live probe of the broker. On a cold serverless
  // instance that is a cold start plus two HTTPS round trips, which can take
  // far longer than a browser waits before deciding the page is broken — and
  // timing out here silently reports "disconnected" while the engine goes on
  // to record "connected". Wait long enough to find out.
  try {
    if (token) return await getAuth<BrokerStatus>(`/api/broker/status${query}`, token, 30000);
    return await get<BrokerStatus>(`/api/broker/status${query}`, 30000);
  } catch {
    return { ...BROKER_UNAVAILABLE, reason: "The engine did not respond in time." };
  }
}

export async function listBrokerConnections(
  token: string,
): Promise<{ connections: BrokerConnection[]; reason?: string }> {
  if (!apiUrl()) return { connections: [], reason: BROKER_UNAVAILABLE.reason };
  try {
    return await getAuth<{ connections: BrokerConnection[]; reason?: string }>(
      "/api/broker/connections",
      token,
    );
  } catch {
    return { connections: [], reason: BROKER_UNAVAILABLE.reason };
  }
}

export async function saveBrokerConnection(
  token: string,
  payload: {
    provider: string;
    credentials: Record<string, string>;
    label?: string;
    connection_id?: string;
  },
): Promise<{
  connection: BrokerConnection;
  status: BrokerStatus;
  error?: string;
  authFailed?: boolean;
}> {
  if (!apiUrl()) {
    return { connection: {} as BrokerConnection, status: BROKER_UNAVAILABLE };
  }
  try {
    return await requestAuth<{ connection: BrokerConnection; status: BrokerStatus }>(
      "/api/broker/connections",
      payload,
      token,
      20000,
    );
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // A 401/403 here is the engine refusing our session token, not the broker
    // rejecting credentials. Callers must not report it as "could not reach
    // <broker>", or the user re-checks API keys that were never transmitted.
    const status = Number.parseInt(message, 10);
    const authFailed = status === 401 || status === 403;
    return {
      connection: {} as BrokerConnection,
      status: { ...BROKER_UNAVAILABLE, reason: message },
      error: message,
      authFailed,
    };
  }
}

export async function deleteBrokerConnection(
  token: string,
  connectionId: string,
): Promise<boolean> {
  if (!apiUrl()) return false;
  try {
    const outcome = await deleteAuth<{ deleted: boolean }>(
      `/api/broker/connections/${encodeURIComponent(connectionId)}`,
      token,
    );
    return outcome.deleted ?? false;
  } catch {
    return false;
  }
}

export async function brokerPrice(symbol: string, connectionId?: string): Promise<BrokerQuote> {
  if (!apiUrl()) return { available: false, symbol, reason: BROKER_UNAVAILABLE.reason };
  const query = `?symbol=${encodeURIComponent(symbol)}${
    connectionId ? `&connection_id=${encodeURIComponent(connectionId)}` : ""
  }`;
  try {
    return await get<BrokerQuote>(`/api/broker/price${query}`, 8000);
  } catch {
    return { available: false, symbol, reason: BROKER_UNAVAILABLE.reason };
  }
}

export async function brokerCandles(
  symbol: string,
  timeframe = "H1",
  count = 120,
  connectionId?: string,
): Promise<BrokerCandleSeries> {
  const empty = {
    available: false,
    symbol,
    timeframe,
    candles: [] as BrokerCandle[],
    reason: BROKER_UNAVAILABLE.reason,
  };
  if (!apiUrl()) return empty;
  const query =
    `?symbol=${encodeURIComponent(symbol)}` +
    `&timeframe=${encodeURIComponent(timeframe)}&count=${count}` +
    (connectionId ? `&connection_id=${encodeURIComponent(connectionId)}` : "");
  try {
    return await get<BrokerCandleSeries>(`/api/broker/candles${query}`, 10000);
  } catch {
    return empty;
  }
}

export async function brokerSymbols(needle = "", connectionId?: string): Promise<string[]> {
  if (!apiUrl()) return [];
  const query = `?needle=${encodeURIComponent(needle)}${
    connectionId ? `&connection_id=${encodeURIComponent(connectionId)}` : ""
  }`;
  try {
    const outcome = await get<{ available: boolean; symbols: string[] }>(
      `/api/broker/symbols${query}`,
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
  if (!apiUrl()) return false;
  try {
    await request<{ removed: number }>("/api/reset", { user_id, scope: "user" }, 30000);
    return true;
  } catch {
    return false;
  }
}
