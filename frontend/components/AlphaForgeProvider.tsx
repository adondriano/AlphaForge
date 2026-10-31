"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import * as api from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dataStore, newId, setCurrentUserId } from "@/lib/data";
import { evaluateShield } from "@/lib/engine";
import { getSupabaseClient, isSupabaseConfigured, resetSupabaseClient } from "@/lib/supabaseClient";
import { loadSettings, saveSettings } from "@/lib/settings";
import type {
  AnalysisReport,
  AppSettings,
  BacktestCurve,
  BacktestResult,
  Metrics,
  Mt5Status,
  Optimization,
  OptimizeResult,
  PaperStats,
  Strategy,
  TradeLog,
} from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import type { TranspileResult } from "@/lib/transpiler";

export interface Toast {
  id: string;
  kind: "success" | "error" | "info";
  title: string;
  detail?: string;
}

export interface PaperResult {
  executed: number;
  blocked: number;
  equity: number;
  day_pnl_pct: number;
  total_pnl_pct: number;
}

interface AccountState {
  starting_equity: number;
  equity: number;
  day_start_equity: number;
  peak_equity: number;
  open_positions: number;
}

interface AlphaForgeContextValue {
  ready: boolean;
  strategies: Strategy[];
  optimizations: Record<string, Optimization[]>;
  tradeLogs: TradeLog[];
  settings: AppSettings;
  account: AccountState;
  engineStatus: api.EngineStatus;
  storeMode: "supabase" | "local";
  toasts: Toast[];

  mt5Status: Mt5Status | null;
  mt5Busy: boolean;
  paperStats: Record<string, PaperStats>;
  paperBusy: Record<string, boolean>;
  /** Equity series from the most recent backtest of each strategy. */
  lastCurves: Record<string, BacktestCurve>;

  /** Signed in and therefore allowed to mutate data. */
  canEdit: boolean;
  requireAccount: (action: string) => boolean;

  notify: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;

  refresh: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;

  createStrategy: (input: {
    spec: TranspileResult;
    engine: string;
  }) => Promise<Strategy | null>;
  runBacktest: (strategyId: string, options?: api.BacktestOptions) => Promise<BacktestResult | null>;
  runOptimize: (
    strategy: Strategy,
    options: api.OptimizeOptions,
  ) => Promise<{ optimization: Optimization; result: OptimizeResult } | null>;
  runAnalyze: (strategy: Strategy, noLlm: boolean) => Promise<AnalysisReport | null>;
  rollback: (strategy: Strategy, optimization: Optimization) => Promise<void>;
  toggleAutonomous: (strategy: Strategy, enabled: boolean) => Promise<void>;
  togglePaperTrading: (strategy: Strategy, enabled: boolean) => Promise<void>;
  resetPaperSession: (strategy: Strategy) => Promise<void>;
  setStatus: (strategy: Strategy, status: Strategy["status"]) => Promise<void>;
  removeStrategy: (strategy: Strategy) => Promise<void>;
  runPaperSession: (strategy: Strategy, nTrades?: number) => Promise<PaperResult | null>;
  resetAccount: (equity?: number) => void;
  clearTrades: () => Promise<void>;

  refreshMt5: () => Promise<Mt5Status>;
  connectMt5: (credentials?: api.Mt5Credentials) => Promise<boolean>;
  disconnectMt5: () => Promise<void>;

  resetEverything: (options?: { reseed?: boolean }) => Promise<void>;
}

const AlphaForgeContext = createContext<AlphaForgeContextValue | null>(null);

export function useAlphaForge(): AlphaForgeContextValue {
  const context = useContext(AlphaForgeContext);
  if (!context) throw new Error("useAlphaForge must be used inside AlphaForgeProvider");
  return context;
}

const metricPatch = (metrics: Metrics) => ({
  win_rate: round(metrics.win_rate ?? 0),
  total_trades: metrics.total_trades ?? 0,
  net_return_pct: round(metrics.net_return_pct ?? 0),
  max_drawdown_pct: round(metrics.max_drawdown_pct ?? 0),
  profit_factor: round(metrics.profit_factor ?? 0),
  sharpe: round(metrics.sharpe ?? 0),
  expectancy_r: round(metrics.expectancy_r ?? 0),
  prop_readiness: round(metrics.prop_readiness ?? 0),
  est_trades_per_week: round(metrics.est_trades_per_week ?? 0),
});

const round = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** How often each armed paper session takes its next signal. */
const PAPER_TICK_MS = 5000;
const PAPER_START_EQUITY = 10_000;

const emptyPaperStats = (strategy: Strategy, running = false): PaperStats => ({
  strategy_id: strategy.id,
  running,
  trades: 0,
  wins: 0,
  losses: 0,
  blocked: 0,
  open: 0,
  net_pnl: 0,
  net_pnl_pct: 0,
  equity: PAPER_START_EQUITY,
  peak_equity: PAPER_START_EQUITY,
  day_pnl_pct: 0,
  total_pnl_pct: 0,
  daily_drawdown_pct: 0,
  total_drawdown_pct: 0,
  expectancy_r: 0,
  last_signal: null,
  last_update: null,
  parameters: strategy.parameters ?? {},
  recent: [],
});

export function AlphaForgeProvider({ children }: { children: ReactNode }) {
  const { user, isGuest, ready: authReady } = useAuth();

  const [ready, setReady] = useState(false);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [optimizations, setOptimizations] = useState<Record<string, Optimization[]>>({});
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<AccountState>({
    starting_equity: 10000,
    equity: 10000,
    day_start_equity: 10000,
    peak_equity: 10000,
    open_positions: 0,
  });
  const [engineStatus, setEngineStatus] = useState<api.EngineStatus>(api.getEngineStatus());
  const [storeMode, setStoreMode] = useState<"supabase" | "local">("local");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [mt5Status, setMt5Status] = useState<Mt5Status | null>(null);
  const [mt5Busy, setMt5Busy] = useState(false);
  const [paperBusy, setPaperBusy] = useState<Record<string, boolean>>({});
  const [paperStats, setPaperStats] = useState<Record<string, PaperStats>>({});
  const [lastCurves, setLastCurves] = useState<Record<string, BacktestCurve>>({});

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const accountRef = useRef(account);
  accountRef.current = account;
  const strategiesRef = useRef<Strategy[]>(strategies);
  strategiesRef.current = strategies;
  const optimizationsRef = useRef(optimizations);
  optimizationsRef.current = optimizations;

  const demoAttempted = useRef(false);
  const seededUsers = useRef<Set<string>>(new Set());
  const paperQueues = useRef<Record<string, { trades: BacktestResult["trades"]; index: number }>>(
    {},
  );
  const paperStatsRef = useRef<Record<string, PaperStats>>({});
  const paperRunning = useRef(false);

  /* ------------------------------------------------------------------ */
  /* toasts                                                              */
  /* ------------------------------------------------------------------ */
  const notify = useCallback((toast: Omit<Toast, "id">) => {
    const id = newId();
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  /* ------------------------------------------------------------------ */
  /* account gate — guests may read, only owners may write               */
  /* ------------------------------------------------------------------ */
  const canEdit = !isGuest;

  const requireAccount = useCallback(
    (action: string) => {
      if (canEdit) return true;
      notify({
        kind: "info",
        title: "Sign in to continue",
        detail: `${action} requires an account — visitors have read-only access.`,
      });
      return false;
    },
    [canEdit, notify],
  );

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  const refresh = useCallback(async () => {
    const [strategyRows, logs] = await Promise.all([
      dataStore.listStrategies(),
      dataStore.listTradeLogs(undefined, 120),
    ]);
    setStrategies(strategyRows);
    setTradeLogs(logs);

    const grouped: Record<string, Optimization[]> = {};
    const results = await Promise.all(
      strategyRows.map((strategy) => dataStore.listOptimizations(strategy.id)),
    );
    strategyRows.forEach((strategy, index) => {
      grouped[strategy.id] = results[index] ?? [];
    });
    setOptimizations(grouped);
    setStoreMode(dataStore.mode);
  }, []);

  // Keep the persistence layer aware of who is signed in so every insert is
  // stamped with the owner id (row-level security enforces it server-side).
  useEffect(() => {
    setCurrentUserId(user?.id ?? null);
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = loadSettings();
      if (!cancelled) setSettings(stored);
      dataStore.ensureChannel();
      await refresh();
      const status = await api.refreshEngineStatus();
      if (!cancelled) setEngineStatus(status);
      const mt5 = await api.mt5Status();
      if (!cancelled) setMt5Status(mt5);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Switching accounts re-scopes everything: clear local mirrors and reload.
  useEffect(() => {
    if (!authReady) return;
    setOptimizations({});
    setTradeLogs([]);
    setPaperStats({});
    paperStatsRef.current = {};
    paperQueues.current = {};
    demoAttempted.current = false;
    void refresh();
  }, [authReady, user?.id, refresh]);

  // Realtime: mirror remote changes into local state.
  useEffect(() => {
    const unsubscribe = dataStore.subscribe((event) => {
      if (event.type === "strategies" || (event.type === "local" && event.table === "strategies")) {
        const row = event.row as Strategy;
        setStrategies((current) => {
          const index = current.findIndex((item) => item.id === row.id);
          if (event.event === "DELETE") return current.filter((item) => item.id !== row.id);
          if (index >= 0) {
            const next = [...current];
            next[index] = row;
            return next;
          }
          return [...current, row];
        });
      }
      if (
        event.type === "optimizations" ||
        (event.type === "local" && event.table === "optimizations")
      ) {
        const row = event.row as Optimization;
        setOptimizations((current) => {
          const list = current[row.strategy_id] ?? [];
          const index = list.findIndex((item) => item.id === row.id);
          const nextList =
            index >= 0
              ? list.map((item) => (item.id === row.id ? row : item))
              : [...list, row].sort((a, b) => a.version - b.version);
          return { ...current, [row.strategy_id]: nextList };
        });
      }
      if (event.type === "trade_logs" || (event.type === "local" && event.table === "trade_logs")) {
        const row = event.row as TradeLog;
        setTradeLogs((current) => [row, ...current.filter((item) => item.id !== row.id)].slice(0, 200));
      }
    });
    return unsubscribe;
  }, []);

  /* ------------------------------------------------------------------ */
  /* MetaTrader 5                                                        */
  /* ------------------------------------------------------------------ */
  const refreshMt5 = useCallback(async () => {
    const status = await api.mt5Status();
    setMt5Status(status);
    return status;
  }, []);

  const connectMt5 = useCallback(
    async (credentials?: api.Mt5Credentials) => {
      setMt5Busy(true);
      try {
        const status = await api.mt5Connect(credentials ?? {});
        setMt5Status(status);
        if (status.connected) {
          notify({
            kind: "success",
            title: "MetaTrader 5 connected",
            detail: status.account?.server
              ? `Account ${status.account.login ?? "—"} on ${status.account.server}`
              : "Live quotes and execution are now available.",
          });
        } else {
          notify({
            kind: "error",
            title: "Could not connect to MetaTrader 5",
            detail: status.reason ?? "Unknown error from the terminal bridge.",
          });
        }
        return Boolean(status.connected);
      } catch (error) {
        notify({
          kind: "error",
          title: "Could not reach the engine",
          detail: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        setMt5Busy(false);
      }
    },
    [notify],
  );

  const disconnectMt5 = useCallback(async () => {
    setMt5Busy(true);
    try {
      setMt5Status(await api.mt5Disconnect());
      notify({ kind: "info", title: "MetaTrader 5 disconnected" });
    } finally {
      setMt5Busy(false);
    }
  }, [notify]);

  /* ------------------------------------------------------------------ */
  /* settings                                                            */
  /* ------------------------------------------------------------------ */
  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!requireAccount("Changing settings")) return;
      const next = saveSettings({ ...settingsRef.current, ...patch });
      setSettings(next);
      const supabaseChanged =
        patch.NEXT_PUBLIC_SUPABASE_URL !== undefined ||
        patch.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined;
      if (supabaseChanged) {
        resetSupabaseClient();
        setStoreMode(isSupabaseConfigured() ? "supabase" : "local");
        dataStore.resetChannel();
        dataStore.ensureChannel();
        await refresh();
      }
      await api.pushSettings(next);
      setEngineStatus(await api.refreshEngineStatus());
      // Credentials may have changed — the bridge status depends on them.
      setMt5Status(await api.mt5Status());
    },
    [refresh, requireAccount],
  );

  /* ------------------------------------------------------------------ */
  /* strategies                                                          */
  /* ------------------------------------------------------------------ */
  const createStrategy = useCallback(
    async (input: { spec: TranspileResult; engine: string }) => {
      if (!requireAccount("Creating a strategy")) return null;
      const { spec } = input;
      const currentSettings = settingsRef.current;
      const bars = Math.min(currentSettings.BACKTEST_BARS || 3000, 2400);
      const seed = 7;

      const draft: Strategy = {
        id: newId(),
        name: spec.name,
        symbol: spec.symbol,
        timeframe: spec.timeframe,
        source_type: spec.source_type,
        source_url: spec.source_url,
        description: spec.description,
        rules: spec.rules,
        parameters: spec.parameters,
        risk_profile: {
          ...spec.risk_profile,
          max_daily_drawdown_pct: currentSettings.MAX_DAILY_DRAWDOWN,
          max_total_drawdown_pct: currentSettings.MAX_TOTAL_DRAWDOWN,
        },
        status: "draft",
        autonomous: currentSettings.AUTONOMOUS_DEFAULT,
        paper_trading: false,
        user_id: user?.id ?? null,
        win_rate: 0,
        total_trades: 0,
        net_return_pct: 0,
        max_drawdown_pct: 0,
        profit_factor: 0,
        sharpe: 0,
        expectancy_r: 0,
        prop_readiness: 0,
        est_trades_per_week: 0,
        active_optimization_id: null,
      };

      let metrics: Metrics | null = null;
      let curve: BacktestCurve | null = null;
      try {
        const report = await api.backtest(draft, {
          bars,
          seed,
          maxDailyDdPct: currentSettings.MAX_DAILY_DRAWDOWN,
          maxTotalDdPct: currentSettings.MAX_TOTAL_DRAWDOWN,
        });
        metrics = report.metrics;
        curve = report.curve ?? null;
      } catch {
        metrics = null;
      }

      const row: Record<string, unknown> = {
        id: draft.id,
        name: draft.name,
        symbol: draft.symbol,
        timeframe: draft.timeframe,
        source_type: draft.source_type,
        source_url: draft.source_url,
        description: draft.description,
        rules: draft.rules,
        parameters: draft.parameters,
        risk_profile: draft.risk_profile,
        status: metrics ? "backtested" : "draft",
        autonomous: draft.autonomous,
        paper_trading: false,
        ...(metrics ? metricPatch(metrics) : {}),
      };

      const created = await dataStore.insertStrategy(row);
      if (curve) setLastCurves((current) => ({ ...current, [created.id]: curve! }));
      const baseline = await dataStore.insertOptimization({
        strategy_id: created.id,
        version: 1,
        label: "Baseline (v1)",
        engine: input.engine || "heuristic",
        parameters: created.parameters,
        param_bounds: {},
        metrics: metrics ?? {},
        n_trials: 0,
        direction: "maximize",
        objective_name: "sharpe",
        is_active: true,
        is_baseline: true,
        notes: "Initial parameter set captured at creation.",
      });
      await dataStore.updateStrategy(created.id, { active_optimization_id: baseline.id });
      await refresh();

      notify({
        kind: "success",
        title: `${created.name} forged`,
        detail: metrics
          ? `${metrics.total_trades} trades · PF ${metrics.profit_factor.toFixed(2)} · readiness ${metrics.prop_readiness.toFixed(0)}%`
          : "Saved — run a backtest to score it.",
      });
      return created;
    },
    [notify, refresh, requireAccount, user],
  );

  const runBacktest = useCallback(
    async (strategyId: string, options: api.BacktestOptions = {}) => {
      const strategy = strategiesRef.current.find((item) => item.id === strategyId);
      if (!strategy) return null;
      const currentSettings = settingsRef.current;
      const report = await api.backtest(strategy, {
        bars: options.bars ?? currentSettings.BACKTEST_BARS,
        seed: options.seed ?? 7,
        maxDailyDdPct: currentSettings.MAX_DAILY_DRAWDOWN,
        maxTotalDdPct: currentSettings.MAX_TOTAL_DRAWDOWN,
        ...options,
      });
      if (report.curve) {
        setLastCurves((current) => ({ ...current, [strategyId]: report.curve! }));
      }
      // Persisting metrics requires ownership; the chart still renders for guests.
      if (requireAccount("Saving backtest results")) {
        await dataStore.updateStrategy(strategyId, {
          ...metricPatch(report.metrics),
          status: strategy.status === "draft" ? "backtested" : strategy.status,
        });
        await refresh();
      }
      return report;
    },
    [refresh, requireAccount],
  );

  const runOptimize = useCallback(
    async (strategy: Strategy, options: api.OptimizeOptions) => {
      if (!requireAccount("Running an optimization")) return null;
      const currentSettings = settingsRef.current;
      const result = await api.optimizeStrategy(strategy, {
        nTrials: options.nTrials ?? currentSettings.OPTIMIZER_TRIALS,
        objective: options.objective ?? "sharpe",
        bars: options.bars ?? currentSettings.BACKTEST_BARS,
        maxDailyDdPct: currentSettings.MAX_DAILY_DRAWDOWN,
        maxTotalDdPct: currentSettings.MAX_TOTAL_DRAWDOWN,
        ...options,
      });
      const existing = optimizationsRef.current[strategy.id] ?? [];
      const version = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1;
      const optimization = await dataStore.insertOptimization({
        strategy_id: strategy.id,
        version,
        label: `${result.objective_label} · v${version}`,
        engine: result.engine,
        parameters: result.best_parameters,
        param_bounds: result.search_space,
        metrics: result.metrics,
        n_trials: result.n_trials,
        direction: "maximize",
        objective_name: result.objective,
        is_active: true,
        is_baseline: false,
        notes: `${result.objective_label} objective · ${result.n_trials} trials · OOS retention ${result.oos_retention} · overfit risk ${result.overfit_risk}`,
      });
      await dataStore.setActiveOptimization(strategy.id, optimization.id);
      await dataStore.updateStrategy(strategy.id, {
        parameters: { ...strategy.parameters, ...result.best_parameters },
        active_optimization_id: optimization.id,
        status: "optimized",
        ...metricPatch(result.metrics),
      });
      await refresh();
      notify({
        kind: "success",
        title: `v${version} committed for ${strategy.name}`,
        detail: `${result.improvement_pct >= 0 ? "+" : ""}${result.improvement_pct.toFixed(1)}% objective vs baseline · overfit risk ${result.overfit_risk}`,
      });
      return { optimization, result };
    },
    [notify, refresh, requireAccount],
  );

  const runAnalyze = useCallback(
    async (strategy: Strategy, noLlm: boolean) => {
      const currentSettings = settingsRef.current;
      const baseline = (optimizationsRef.current[strategy.id] ?? []).find((item) => item.is_baseline);
      const active = (optimizationsRef.current[strategy.id] ?? []).find((item) => item.is_active);
      return api.analyze(strategy, {
        bars: currentSettings.BACKTEST_BARS,
        noLlm,
        baselineMetrics:
          baseline && baseline.id !== active?.id ? baseline.metrics : null,
        maxDailyDdPct: currentSettings.MAX_DAILY_DRAWDOWN,
        maxTotalDdPct: currentSettings.MAX_TOTAL_DRAWDOWN,
      });
    },
    [],
  );

  const rollback = useCallback(
    async (strategy: Strategy, optimization: Optimization) => {
      if (!requireAccount("Rolling back")) return;
      await dataStore.setActiveOptimization(strategy.id, optimization.id);
      await dataStore.updateStrategy(strategy.id, {
        parameters: { ...strategy.parameters, ...optimization.parameters },
        active_optimization_id: optimization.id,
        ...metricPatch(optimization.metrics ?? ({} as Metrics)),
      });
      await refresh();
      notify({
        kind: "info",
        title: `Rolled back to v${optimization.version}`,
        detail: `${strategy.name} is now running the parameters from ${optimization.label}.`,
      });
    },
    [notify, refresh, requireAccount],
  );

  const toggleAutonomous = useCallback(
    async (strategy: Strategy, enabled: boolean) => {
      if (!requireAccount("Arming autonomous execution")) return;
      await dataStore.updateStrategy(strategy.id, {
        autonomous: enabled,
        status: enabled ? "paper" : strategy.status,
      });
      await refresh();
      notify({
        kind: "info",
        title: `${strategy.name} · autonomous ${enabled ? "armed" : "disarmed"}`,
        detail: enabled
          ? "The strategy will execute through the Prop-Firm Shield on every signal."
          : "Signals are logged but not routed to execution.",
      });
    },
    [notify, refresh, requireAccount],
  );

  const setStrategyStatus = useCallback(
    async (strategy: Strategy, status: Strategy["status"]) => {
      if (!requireAccount("Changing strategy status")) return;
      await dataStore.updateStrategy(strategy.id, { status });
      await refresh();
    },
    [refresh, requireAccount],
  );

  const removeStrategy = useCallback(
    async (strategy: Strategy) => {
      if (!requireAccount("Deleting a strategy")) return;
      await dataStore.deleteStrategy(strategy.id);
      setPaperStats((current) => {
        const next = { ...current };
        delete next[strategy.id];
        return next;
      });
      delete paperStatsRef.current[strategy.id];
      delete paperQueues.current[strategy.id];
      await refresh();
      notify({ kind: "info", title: `${strategy.name} deleted` });
    },
    [notify, refresh, requireAccount],
  );

  /* ------------------------------------------------------------------ */
  /* paper trading                                                       */
  /* ------------------------------------------------------------------ */
  const commitStats = useCallback(
    (strategyId: string, next: PaperStats, log?: TradeLog) => {
      paperStatsRef.current[strategyId] = next;
      setPaperStats((current) => ({ ...current, [strategyId]: next }));
      if (log) setTradeLogs((current) => [log, ...current.filter((i) => i.id !== log.id)].slice(0, 200));
    },
    [],
  );

  const paperTick = useCallback(async () => {
    if (paperRunning.current) return;
    paperRunning.current = true;
    try {
      const armed = strategiesRef.current.filter((item) => item.paper_trading);
      for (const strategy of armed) {
        const currentSettings = settingsRef.current;
        const shieldConfig = {
          maxDailyDrawdownPct: currentSettings.MAX_DAILY_DRAWDOWN,
          maxTotalDrawdownPct: currentSettings.MAX_TOTAL_DRAWDOWN,
          riskPerTradePct:
            strategy.risk_profile?.risk_per_trade_pct ?? currentSettings.RISK_PER_TRADE_PCT,
          maxConcurrentTrades: currentSettings.MAX_CONCURRENT_TRADES,
        };

        // Replay buffer: one backtest gives a deterministic signal queue that
        // the session walks through, so a tick is one trade rather than a
        // full re-simulation every few seconds.
        let queue = paperQueues.current[strategy.id];
        if (!queue || queue.index >= queue.trades.length) {
          const report = await api.backtest(strategy, {
            bars: 900,
            seed: Date.now() % 100000,
            split: 0.5,
            maxDailyDdPct: currentSettings.MAX_DAILY_DRAWDOWN,
            maxTotalDdPct: currentSettings.MAX_TOTAL_DRAWDOWN,
          });
          queue = { trades: report.trades ?? [], index: 0 };
          paperQueues.current[strategy.id] = queue;
        }
        const trade = queue.trades[queue.index];
        if (!trade) continue;
        queue.index += 1;

        const stats = paperStatsRef.current[strategy.id] ?? emptyPaperStats(strategy, true);
        const dayStart = accountRef.current.day_start_equity;
        const decision = evaluateShield(shieldConfig, {
          equity: stats.equity,
          dayStartEquity: dayStart,
          peakEquity: stats.peak_equity,
          requestedRiskPct: shieldConfig.riskPerTradePct,
          volume: 0.01,
          openPositions: 0,
        });

        const allowed = decision.allowed;
        const pnl = allowed ? trade.pnl : 0;
        const equity = stats.equity + pnl;
        const peak = Math.max(stats.peak_equity, equity);

        const log = await dataStore.insertTradeLog({
          strategy_id: strategy.id,
          optimization_id: strategy.active_optimization_id,
          mode: "paper",
          symbol: strategy.symbol,
          side: trade.side,
          entry_price: trade.entry,
          exit_price: trade.exit,
          stop_loss: trade.stop_loss,
          take_profit: trade.take_profit,
          volume: 0.01,
          pnl: round(pnl, 4),
          pnl_pct: allowed ? round(trade.pnl_pct, 4) : 0,
          r_multiple: allowed ? round(trade.r_multiple, 4) : 0,
          status: allowed ? "closed" : "blocked",
          blocked_reason: allowed ? null : decision.reason,
          closed_at: new Date().toISOString(),
          day_pnl_pct: round(((equity - dayStart) / (dayStart || 1)) * 100, 4),
          total_pnl_pct: round(
            ((equity - accountRef.current.starting_equity) /
              (accountRef.current.starting_equity || 1)) *
              100,
            4,
          ),
          equity_after: round(equity, 4),
          meta: { exit_reason: trade.exit_reason, decision, source: "paper-loop" },
        });

        const trades = stats.trades + 1;
        const wins = stats.wins + (allowed && pnl > 0 ? 1 : 0);
        const losses = stats.losses + (allowed && pnl <= 0 ? 1 : 0);
        commitStats(
          strategy.id,
          {
            ...stats,
            running: true,
            trades,
            wins,
            losses,
            blocked: stats.blocked + (allowed ? 0 : 1),
            net_pnl: stats.net_pnl + pnl,
            net_pnl_pct: ((stats.net_pnl + pnl) / PAPER_START_EQUITY) * 100,
            equity,
            peak_equity: peak,
            day_pnl_pct: round(((equity - dayStart) / (dayStart || 1)) * 100, 4),
            total_pnl_pct: round(((equity - PAPER_START_EQUITY) / PAPER_START_EQUITY) * 100, 4),
            daily_drawdown_pct: round(((peak - equity) / (peak || 1)) * 100, 4),
            total_drawdown_pct: round(((peak - equity) / (peak || 1)) * 100, 4),
            expectancy_r: trades ? (stats.expectancy_r * (trades - 1) + (allowed ? trade.r_multiple : 0)) / trades : 0,
            last_signal: `${trade.side.toUpperCase()} ${strategy.symbol} · ${trade.exit_reason}`,
            last_update: new Date().toISOString(),
            parameters: strategy.parameters ?? {},
            recent: [log, ...stats.recent].slice(0, 40),
          },
          log,
        );
      }
    } catch {
      /* a failed tick must not kill the loop */
    } finally {
      paperRunning.current = false;
    }
  }, [commitStats]);

  // Drive every armed paper session off a single interval.
  const armedCount = strategies.filter((item) => item.paper_trading).length;
  useEffect(() => {
    if (!armedCount || !canEdit) return;
    const timer = setInterval(() => void paperTick(), PAPER_TICK_MS);
    return () => clearInterval(timer);
  }, [armedCount, canEdit, paperTick]);

  const togglePaperTrading = useCallback(
    async (strategy: Strategy, enabled: boolean) => {
      if (!requireAccount("Paper trading")) return;
      setPaperBusy((current) => ({ ...current, [strategy.id]: true }));
      try {
        await dataStore.updateStrategy(strategy.id, {
          paper_trading: enabled,
          status: enabled ? "paper" : strategy.status,
        });
      } finally {
        setPaperBusy((current) => ({ ...current, [strategy.id]: false }));
      }
      if (enabled) {
        delete paperQueues.current[strategy.id];
        commitStats(
          strategy.id,
          paperStatsRef.current[strategy.id] ?? emptyPaperStats(strategy, true),
        );
        void paperTick();
        notify({
          kind: "success",
          title: `${strategy.name} · paper session started`,
          detail: "Signals are replayed through the Prop-Firm Shield. Open the paper console to watch fills.",
        });
      } else {
        const stats = paperStatsRef.current[strategy.id];
        if (stats) commitStats(strategy.id, { ...stats, running: false });
        notify({ kind: "info", title: `${strategy.name} · paper session paused` });
      }
      await refresh();
    },
    [commitStats, notify, paperTick, refresh, requireAccount],
  );

  const resetPaperSession = useCallback(
    async (strategy: Strategy) => {
      if (!requireAccount("Resetting the paper session")) return;
      delete paperQueues.current[strategy.id];
      commitStats(strategy.id, emptyPaperStats(strategy, Boolean(strategy.paper_trading)));
      notify({ kind: "info", title: "Paper session reset" });
    },
    [commitStats, notify, requireAccount],
  );

  /* ------------------------------------------------------------------ */
  /* execution                                                           */
  /* ------------------------------------------------------------------ */
  const runPaperSession = useCallback(
    async (strategy: Strategy, nTrades = 10) => {
      if (!requireAccount("Running a paper session")) return null;
      const currentSettings = settingsRef.current;
      const shieldConfig = {
        maxDailyDrawdownPct: currentSettings.MAX_DAILY_DRAWDOWN,
        maxTotalDrawdownPct: currentSettings.MAX_TOTAL_DRAWDOWN,
        riskPerTradePct: strategy.risk_profile?.risk_per_trade_pct ?? currentSettings.RISK_PER_TRADE_PCT,
        maxConcurrentTrades: currentSettings.MAX_CONCURRENT_TRADES,
      };
      const report = await api.backtest(strategy, {
        bars: 1500,
        seed: 7,
        split: 0.5,
        maxDailyDdPct: currentSettings.MAX_DAILY_DRAWDOWN,
        maxTotalDdPct: currentSettings.MAX_TOTAL_DRAWDOWN,
      });
      const trades = report.trades.slice(-Math.max(1, nTrades));

      let equity = accountRef.current.equity;
      const dayStart = accountRef.current.day_start_equity;
      let peak = accountRef.current.peak_equity;
      let executed = 0;
      let blocked = 0;

      for (const trade of trades) {
        const decision = evaluateShield(shieldConfig, {
          equity,
          dayStartEquity: dayStart,
          peakEquity: peak,
          requestedRiskPct: shieldConfig.riskPerTradePct,
          volume: 0.01,
          openPositions: 0,
        });
        const pnl = decision.allowed ? trade.pnl : 0;
        if (decision.allowed) {
          equity += pnl;
          peak = Math.max(peak, equity);
          executed += 1;
        } else {
          blocked += 1;
        }
        await dataStore.insertTradeLog({
          strategy_id: strategy.id,
          optimization_id: strategy.active_optimization_id,
          mode: "paper",
          symbol: strategy.symbol,
          side: trade.side,
          entry_price: trade.entry,
          exit_price: trade.exit,
          stop_loss: trade.stop_loss,
          take_profit: trade.take_profit,
          volume: 0.01,
          pnl: round(pnl, 4),
          pnl_pct: decision.allowed ? round(trade.pnl_pct, 4) : 0,
          r_multiple: decision.allowed ? round(trade.r_multiple, 4) : 0,
          status: decision.allowed ? "closed" : "blocked",
          blocked_reason: decision.allowed ? null : decision.reason,
          closed_at: new Date().toISOString(),
          day_pnl_pct: round(((equity - dayStart) / (dayStart || 1)) * 100, 4),
          total_pnl_pct: round(
            ((equity - accountRef.current.starting_equity) /
              (accountRef.current.starting_equity || 1)) *
              100,
            4,
          ),
          equity_after: round(equity, 4),
          meta: { exit_reason: trade.exit_reason, decision },
        });
      }

      setAccount((current) => ({
        ...current,
        equity,
        peak_equity: peak,
      }));
      await dataStore.updateStrategy(strategy.id, { status: "paper" });
      await refresh();
      notify({
        kind: blocked > 0 ? "info" : "success",
        title: `Paper session complete · ${strategy.name}`,
        detail: `${executed} filled · ${blocked} blocked by the Prop-Firm Shield`,
      });
      return {
        executed,
        blocked,
        equity,
        day_pnl_pct: round(((equity - dayStart) / (dayStart || 1)) * 100, 4),
        total_pnl_pct: round(
          ((equity - accountRef.current.starting_equity) /
            (accountRef.current.starting_equity || 1)) *
            100,
          4,
        ),
      };
    },
    [notify, refresh, requireAccount],
  );

  const resetAccount = useCallback((equity = 10000) => {
    setAccount({
      starting_equity: equity,
      equity,
      day_start_equity: equity,
      peak_equity: equity,
      open_positions: 0,
    });
  }, []);

  const clearTrades = useCallback(async () => {
    await dataStore.clearTradeLogs();
    setTradeLogs([]);
    await refresh();
  }, [refresh]);

  /* ------------------------------------------------------------------ */
  /* fresh start                                                         */
  /* ------------------------------------------------------------------ */
  const resetEverything = useCallback(
    async (options: { reseed?: boolean } = {}) => {
      if (!requireAccount("Resetting the studio")) return;
      await api.resetEngine(user?.id ?? null);
      await dataStore.resetAll();
      setStrategies([]);
      setOptimizations({});
      setTradeLogs([]);
      setPaperStats({});
      setLastCurves({});
      paperStatsRef.current = {};
      paperQueues.current = {};
      resetAccount(10000);
      demoAttempted.current = !options.reseed;
      if (options.reseed) {
        seededUsers.current.delete(user?.id ?? "");
      }
      await refresh();
      notify({
        kind: "info",
        title: "Studio reset",
        detail: options.reseed
          ? "All of your data was cleared — demo strategies are being regenerated."
          : "All of your strategies, parameter versions and trade logs were deleted.",
      });
    },
    [notify, refresh, requireAccount, resetAccount, user],
  );

  /* ------------------------------------------------------------------ */
  /* first-run demo data (per account)                                   */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!ready || !authReady) return;
    if (isGuest) return; // guests cannot write, so never try to seed for them
    const owner = user?.id;
    if (!owner || seededUsers.current.has(owner)) return;
    if (demoAttempted.current) return;
    // Only seed when this account owns nothing — legacy unowned rows are public
    // demo data that every visitor sees, and they must not block a new account
    // from getting its own copy.
    if (strategies.some((strategy) => strategy.user_id === owner)) {
      seededUsers.current.add(owner);
      return;
    }
    demoAttempted.current = true;
    seededUsers.current.add(owner);
    (async () => {
      const seeds = [
        {
          text: "London breakout on XAUUSD H1. Buy when price breaks the 20 bar high during the London session, confirm with the 12 EMA above the 26 EMA, stop loss 2 ATR, target 2.5R. Risk 0.5% per trade.",
          sourceUrl: "https://www.youtube.com/watch?v=alphaforge-london-breakout",
          overrides: { fast_ema: 12, slow_ema: 26, atr_sl_mult: 2, rr_ratio: 2.5, breakout_lookback: 20, risk_per_trade_pct: 0.5 } as Record<string, number>,
        },
        {
          text: "Mean reversion on EURUSD M15. Fade RSI extremes below 28 and above 72, confirm with the 200 EMA trend filter, 1.5 ATR stop, 1.8R target. Risk 0.4% per trade.",
          sourceUrl: "https://www.tiktok.com/@alphaforge/video/mean-reversion",
          overrides: { rsi_period: 14, rsi_lower: 28, rsi_upper: 72, atr_sl_mult: 1.5, rr_ratio: 1.8, risk_per_trade_pct: 0.4, fast_ema: 50, slow_ema: 200 } as Record<string, number>,
        },
        {
          text: "NAS100 H4 trend following. Enter on a 50/200 EMA crossover with a 55 bar Donchian breakout filter, 3 ATR stop, 3R target. Risk 0.75% per trade.",
          sourceUrl: "",
          overrides: { fast_ema: 50, slow_ema: 200, breakout_lookback: 55, atr_sl_mult: 3, rr_ratio: 3, risk_per_trade_pct: 0.75, min_signal_strength: 2 } as Record<string, number>,
        },
      ];
      const created: Strategy[] = [];
      for (const seed of seeds) {
        try {
          const response = await api.transpile({
            text: seed.text,
            sourceUrl: seed.sourceUrl,
            noLlm: true,
          });
          const spec: TranspileResult = {
            ...response.spec,
            parameters: { ...response.spec.parameters, ...seed.overrides },
          };
          const strategy = await createStrategy({ spec, engine: response.meta.engine });
          if (strategy) created.push(strategy);
        } catch {
          /* never block the UI */
        }
      }
      // give each seeded strategy one optimised generation so lineage has diffs
      for (const strategy of created) {
        try {
          await runOptimize(strategy, { nTrials: 10, objective: "prop_readiness", bars: 1800 });
        } catch {
          /* ignore */
        }
      }
      if (created.length) {
        notify({
          kind: "info",
          title: "Demo strategies loaded",
          detail: `${created.length} strategies with baseline + optimised parameter versions.`,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authReady, isGuest, strategies, user?.id]);

  const value = useMemo<AlphaForgeContextValue>(
    () => ({
      ready,
      strategies,
      optimizations,
      tradeLogs,
      settings,
      account,
      engineStatus,
      storeMode: getSupabaseClient() ? "supabase" : storeMode,
      toasts,
      mt5Status,
      mt5Busy,
      paperStats,
      paperBusy,
      lastCurves,
      canEdit,
      requireAccount,
      notify,
      dismissToast,
      refresh,
      updateSettings,
      createStrategy,
      runBacktest,
      runOptimize,
      runAnalyze,
      rollback,
      toggleAutonomous,
      togglePaperTrading,
      resetPaperSession,
      setStatus: setStrategyStatus,
      removeStrategy,
      runPaperSession,
      resetAccount,
      clearTrades,
      refreshMt5,
      connectMt5,
      disconnectMt5,
      resetEverything,
    }),
    [
      ready,
      strategies,
      optimizations,
      tradeLogs,
      settings,
      account,
      engineStatus,
      storeMode,
      toasts,
      mt5Status,
      mt5Busy,
      paperStats,
      paperBusy,
      lastCurves,
      canEdit,
      requireAccount,
      notify,
      dismissToast,
      refresh,
      updateSettings,
      createStrategy,
      runBacktest,
      runOptimize,
      runAnalyze,
      rollback,
      toggleAutonomous,
      togglePaperTrading,
      resetPaperSession,
      setStrategyStatus,
      removeStrategy,
      runPaperSession,
      resetAccount,
      clearTrades,
      refreshMt5,
      connectMt5,
      disconnectMt5,
      resetEverything,
    ],
  );

  return <AlphaForgeContext.Provider value={value}>{children}</AlphaForgeContext.Provider>;
}
