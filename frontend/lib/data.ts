"use client";

/**
 * Data layer — Supabase first, localStorage fallback.
 *
 * Every mutation returns the persisted row and emits an event that the UI
 * treats identically whether it came from Supabase Realtime or from local
 * storage, so the dashboard updates live in both modes.
 */

import { getSupabaseClient } from "./supabaseClient";
import type { Optimization, Strategy, TradeLog } from "./types";

export type RealtimeEvent =
  | { type: "strategies"; event: "INSERT" | "UPDATE" | "DELETE"; row: Strategy }
  | { type: "optimizations"; event: "INSERT" | "UPDATE" | "DELETE"; row: Optimization }
  | { type: "trade_logs"; event: "INSERT" | "UPDATE" | "DELETE"; row: TradeLog }
  | { type: "local"; event: "INSERT" | "UPDATE" | "DELETE"; row: unknown; table: string };

type Listener = (event: RealtimeEvent) => void;

const LS = {
  strategies: "alphaforge.strategies",
  optimizations: "alphaforge.optimizations",
  tradeLogs: "alphaforge.trade_logs",
};

function readLocal<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function writeLocal<T>(key: string, rows: T[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(rows));
  } catch {
    /* quota — keep going with in-memory data */
  }
}

export const newId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const num = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function toStrategy(row: Record<string, unknown>): Strategy {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? "Untitled Strategy"),
    symbol: String(row.symbol ?? "XAUUSD"),
    timeframe: String(row.timeframe ?? "H1"),
    source_type: (row.source_type as Strategy["source_type"]) ?? "text",
    source_url: String(row.source_url ?? ""),
    description: String(row.description ?? ""),
    rules: (row.rules as Strategy["rules"]) ?? { side: "both", entries: [], exits: [], filters: [] },
    parameters: (row.parameters as Record<string, number>) ?? {},
    risk_profile: (row.risk_profile as Strategy["risk_profile"]) ?? {
      risk_per_trade_pct: 0.5,
      rr_ratio: 2,
      max_daily_drawdown_pct: 3.5,
      max_total_drawdown_pct: 5,
      max_concurrent_trades: 2,
      session: "all_day",
    },
    status: (row.status as Strategy["status"]) ?? "draft",
    autonomous: Boolean(row.autonomous),
    win_rate: num(row.win_rate),
    total_trades: num(row.total_trades),
    net_return_pct: num(row.net_return_pct),
    max_drawdown_pct: num(row.max_drawdown_pct),
    profit_factor: num(row.profit_factor),
    sharpe: num(row.sharpe),
    expectancy_r: num(row.expectancy_r),
    prop_readiness: num(row.prop_readiness),
    est_trades_per_week: num(row.est_trades_per_week),
    active_optimization_id: (row.active_optimization_id as string) ?? null,
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  };
}

export function toOptimization(row: Record<string, unknown>): Optimization {
  return {
    id: String(row.id ?? ""),
    strategy_id: String(row.strategy_id ?? ""),
    version: num(row.version),
    label: String(row.label ?? ""),
    engine: String(row.engine ?? "optuna"),
    parameters: (row.parameters as Record<string, number>) ?? {},
    param_bounds: (row.param_bounds as Record<string, number[]>) ?? {},
    metrics: (row.metrics as Optimization["metrics"]) ?? ({} as Optimization["metrics"]),
    n_trials: num(row.n_trials),
    direction: String(row.direction ?? "maximize"),
    objective_name: String(row.objective_name ?? "sharpe"),
    is_active: Boolean(row.is_active),
    is_baseline: Boolean(row.is_baseline),
    notes: String(row.notes ?? ""),
    created_at: row.created_at as string | undefined,
  };
}

export function toTradeLog(row: Record<string, unknown>): TradeLog {
  return {
    id: String(row.id ?? ""),
    strategy_id: (row.strategy_id as string) ?? null,
    optimization_id: (row.optimization_id as string) ?? null,
    mode: (row.mode as TradeLog["mode"]) ?? "paper",
    symbol: String(row.symbol ?? ""),
    side: (row.side as TradeLog["side"]) ?? "buy",
    entry_price: num(row.entry_price),
    exit_price: row.exit_price === null || row.exit_price === undefined ? null : num(row.exit_price),
    stop_loss: row.stop_loss === null || row.stop_loss === undefined ? null : num(row.stop_loss),
    take_profit: row.take_profit === null || row.take_profit === undefined ? null : num(row.take_profit),
    volume: num(row.volume, 0.01),
    pnl: row.pnl === null || row.pnl === undefined ? null : num(row.pnl),
    pnl_pct: row.pnl_pct === null || row.pnl_pct === undefined ? null : num(row.pnl_pct),
    r_multiple: row.r_multiple === null || row.r_multiple === undefined ? null : num(row.r_multiple),
    opened_at: row.opened_at as string | undefined,
    closed_at: (row.closed_at as string) ?? null,
    status: (row.status as TradeLog["status"]) ?? "open",
    blocked_reason: (row.blocked_reason as string) ?? null,
    day_pnl_pct: num(row.day_pnl_pct),
    total_pnl_pct: num(row.total_pnl_pct),
    equity_after: row.equity_after === null || row.equity_after === undefined ? null : num(row.equity_after),
    meta: (row.meta as Record<string, unknown>) ?? {},
  };
}

class DataStore {
  private listeners = new Set<Listener>();
  private channel: ReturnType<NonNullable<ReturnType<typeof getSupabaseClient>>["channel"]> | null = null;
  private channelKey = "";

  get mode(): "supabase" | "local" {
    return getSupabaseClient() ? "supabase" : "local";
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensureChannel();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: RealtimeEvent) {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        /* a broken listener must not break the stream */
      }
    });
  }

  /** Attach the Realtime channel once the Supabase client is available. */
  ensureChannel() {
    const client = getSupabaseClient();
    if (!client) return;
    const signature = this.channelKey || "alphaforge";
    if (this.channel) return;
    const channel = client.channel(signature);
    for (const table of ["strategies", "optimizations", "trade_logs"] as const) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload: Record<string, unknown>) => {
          const eventType = String(payload.eventType ?? "INSERT").toUpperCase() as
            | "INSERT"
            | "UPDATE"
            | "DELETE";
          const row = (payload.new ?? payload.old ?? {}) as Record<string, unknown>;
          if (table === "strategies") {
            this.emit({ type: "strategies", event: eventType, row: toStrategy(row) });
          } else if (table === "optimizations") {
            this.emit({ type: "optimizations", event: eventType, row: toOptimization(row) });
          } else {
            this.emit({ type: "trade_logs", event: eventType, row: toTradeLog(row) });
          }
        },
      );
    }
    channel.subscribe();
    this.channel = channel;
    this.channelKey = signature;
  }

  resetChannel() {
    try {
      const client = getSupabaseClient();
      if (client && this.channel) client.removeChannel(this.channel);
    } catch {
      /* ignore */
    }
    this.channel = null;
    this.channelKey = "";
  }

  /* ------------------------------------------------------------------ */
  /* strategies                                                          */
  /* ------------------------------------------------------------------ */
  async listStrategies(): Promise<Strategy[]> {
    const client = getSupabaseClient();
    if (client) {
      const { data, error } = await client
        .from("strategies")
        .select("*")
        .order("created_at", { ascending: true });
      if (!error && data) return data.map((row) => toStrategy(row as Record<string, unknown>));
    }
    return readLocal<Record<string, unknown>>(LS.strategies).map(toStrategy);
  }

  async insertStrategy(row: Record<string, unknown>): Promise<Strategy> {
    const client = getSupabaseClient();
    const payload = { ...row, id: row.id ?? newId() };
    if (client) {
      const { data, error } = await client.from("strategies").insert(payload).select().single();
      if (!error && data) {
        const strategy = toStrategy(data as Record<string, unknown>);
        this.emit({ type: "strategies", event: "INSERT", row: strategy });
        return strategy;
      }
    }
    const rows = readLocal<Record<string, unknown>>(LS.strategies);
    const stored = { ...payload, created_at: new Date().toISOString() };
    rows.push(stored);
    writeLocal(LS.strategies, rows);
    const strategy = toStrategy(stored);
    this.emit({ type: "local", event: "INSERT", row: strategy, table: "strategies" });
    return strategy;
  }

  async updateStrategy(id: string, patch: Record<string, unknown>): Promise<void> {
    const client = getSupabaseClient();
    if (client) {
      const { error } = await client
        .from("strategies")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (!error) return;
    }
    const rows = readLocal<Record<string, unknown>>(LS.strategies);
    const index = rows.findIndex((row) => String(row.id) === id);
    if (index >= 0) {
      rows[index] = { ...rows[index], ...patch, updated_at: new Date().toISOString() };
      writeLocal(LS.strategies, rows);
    }
  }

  async deleteStrategy(id: string): Promise<void> {
    const client = getSupabaseClient();
    if (client) {
      const { error } = await client.from("strategies").delete().eq("id", id);
      if (!error) return;
    }
    writeLocal(
      LS.strategies,
      readLocal<Record<string, unknown>>(LS.strategies).filter((row) => String(row.id) !== id),
    );
    writeLocal(
      LS.optimizations,
      readLocal<Record<string, unknown>>(LS.optimizations).filter(
        (row) => String(row.strategy_id) !== id,
      ),
    );
  }

  /* ------------------------------------------------------------------ */
  /* optimizations                                                       */
  /* ------------------------------------------------------------------ */
  async listOptimizations(strategyId?: string): Promise<Optimization[]> {
    const client = getSupabaseClient();
    if (client) {
      let query = client.from("optimizations").select("*").order("version", { ascending: true });
      if (strategyId) query = query.eq("strategy_id", strategyId);
      const { data, error } = await query;
      if (!error && data) return data.map((row) => toOptimization(row as Record<string, unknown>));
    }
    const rows = readLocal<Record<string, unknown>>(LS.optimizations)
      .map(toOptimization)
      .filter((row) => (strategyId ? row.strategy_id === strategyId : true));
    return rows.sort((a, b) => a.version - b.version);
  }

  async insertOptimization(row: Record<string, unknown>): Promise<Optimization> {
    const payload = {
      ...row,
      id: row.id ?? newId(),
      created_at: row.created_at ?? new Date().toISOString(),
    };
    const client = getSupabaseClient();
    if (client) {
      const { data, error } = await client.from("optimizations").insert(payload).select().single();
      if (!error && data) {
        const optimization = toOptimization(data as Record<string, unknown>);
        this.emit({ type: "optimizations", event: "INSERT", row: optimization });
        return optimization;
      }
    }
    const rows = readLocal<Record<string, unknown>>(LS.optimizations);
    rows.push(payload);
    writeLocal(LS.optimizations, rows);
    const optimization = toOptimization(payload);
    this.emit({ type: "local", event: "INSERT", row: optimization, table: "optimizations" });
    return optimization;
  }

  async setActiveOptimization(strategyId: string, optimizationId: string): Promise<void> {
    const client = getSupabaseClient();
    if (client) {
      await client
        .from("optimizations")
        .update({ is_active: false })
        .eq("strategy_id", strategyId)
        .neq("id", optimizationId);
      await client.from("optimizations").update({ is_active: true }).eq("id", optimizationId);
      return;
    }
    const rows = readLocal<Record<string, unknown>>(LS.optimizations);
    for (const row of rows) {
      if (String(row.strategy_id) === strategyId) row.is_active = String(row.id) === optimizationId;
    }
    writeLocal(LS.optimizations, rows);
  }

  /* ------------------------------------------------------------------ */
  /* trade logs                                                          */
  /* ------------------------------------------------------------------ */
  async listTradeLogs(strategyId?: string, limit = 120): Promise<TradeLog[]> {
    const client = getSupabaseClient();
    if (client) {
      let query = client.from("trade_logs").select("*").order("opened_at", { ascending: false }).limit(limit);
      if (strategyId) query = query.eq("strategy_id", strategyId);
      const { data, error } = await query;
      if (!error && data) return data.map((row) => toTradeLog(row as Record<string, unknown>));
    }
    const rows = readLocal<Record<string, unknown>>(LS.tradeLogs)
      .map(toTradeLog)
      .filter((row) => (strategyId ? row.strategy_id === strategyId : true))
      .sort((a, b) => String(b.opened_at ?? "").localeCompare(String(a.opened_at ?? "")));
    return rows.slice(0, limit);
  }

  async insertTradeLog(row: Record<string, unknown>): Promise<TradeLog> {
    const payload = {
      ...row,
      id: row.id ?? newId(),
      opened_at: row.opened_at ?? new Date().toISOString(),
    };
    const client = getSupabaseClient();
    if (client) {
      const { data, error } = await client.from("trade_logs").insert(payload).select().single();
      if (!error && data) {
        const log = toTradeLog(data as Record<string, unknown>);
        this.emit({ type: "trade_logs", event: "INSERT", row: log });
        return log;
      }
    }
    const rows = readLocal<Record<string, unknown>>(LS.tradeLogs);
    rows.push(payload);
    if (rows.length > 500) rows.splice(0, rows.length - 500);
    writeLocal(LS.tradeLogs, rows);
    const log = toTradeLog(payload);
    this.emit({ type: "local", event: "INSERT", row: log, table: "trade_logs" });
    return log;
  }

  async clearTradeLogs(): Promise<void> {
    const client = getSupabaseClient();
    if (client) {
      await client.from("trade_logs").delete().gt("opened_at", "1970-01-01");
      return;
    }
    writeLocal(LS.tradeLogs, []);
  }

  async countTradeLogs(): Promise<number> {
    const client = getSupabaseClient();
    if (client) {
      const { count, error } = await client
        .from("trade_logs")
        .select("*", { count: "exact", head: true });
      if (!error && typeof count === "number") return count;
    }
    return readLocal<Record<string, unknown>>(LS.tradeLogs).length;
  }
}

export const dataStore = new DataStore();
