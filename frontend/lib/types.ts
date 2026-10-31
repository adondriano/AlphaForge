export type StrategyStatus =
  | "draft"
  | "backtested"
  | "optimized"
  | "shadow"
  | "paper"
  | "live"
  | "halted";

export type SourceType = "youtube" | "tiktok" | "text" | "json" | "manual";

export interface Rule {
  indicator: string;
  params?: Record<string, number | string>;
  direction?: "long" | "short" | "both";
  note?: string;
}

export interface RiskProfile {
  risk_per_trade_pct: number;
  rr_ratio: number;
  max_daily_drawdown_pct: number;
  max_total_drawdown_pct: number;
  max_concurrent_trades: number;
  session: string;
}

export interface StrategyRules {
  side: "long" | "short" | "both";
  entries: Rule[];
  exits: Rule[];
  filters: Rule[];
}

export interface Metrics {
  total_trades: number;
  wins?: number;
  losses?: number;
  win_rate: number;
  net_return_pct: number;
  max_drawdown_pct: number;
  max_daily_drawdown_pct?: number;
  profit_factor: number;
  sharpe: number;
  expectancy_r: number;
  est_trades_per_week: number;
  prop_readiness: number;
  longest_losing_streak?: number;
  avg_win_r?: number;
  avg_loss_r?: number;
  final_equity?: number;
  recovery_factor?: number;
}

export interface Strategy {
  id: string;
  name: string;
  symbol: string;
  timeframe: string;
  source_type: SourceType;
  source_url: string;
  description: string;
  rules: StrategyRules;
  parameters: Record<string, number>;
  risk_profile: RiskProfile;
  status: StrategyStatus;
  autonomous: boolean;
  /** Paper trading routes signals through the shield without sending orders. */
  paper_trading: boolean;
  /** Owning Supabase Auth account. Rows with no owner are shared read-only. */
  user_id?: string | null;
  win_rate: number;
  total_trades: number;
  net_return_pct: number;
  max_drawdown_pct: number;
  profit_factor: number;
  sharpe: number;
  expectancy_r: number;
  prop_readiness: number;
  est_trades_per_week: number;
  active_optimization_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Optimization {
  id: string;
  strategy_id: string;
  version: number;
  label: string;
  engine: string;
  parameters: Record<string, number>;
  param_bounds: Record<string, number[]>;
  metrics: Metrics;
  n_trials: number;
  direction: string;
  objective_name: string;
  is_active: boolean;
  is_baseline: boolean;
  notes: string;
  user_id?: string | null;
  created_at?: string;
}

export interface TradeLog {
  id: string;
  strategy_id: string | null;
  optimization_id?: string | null;
  mode: "shadow" | "paper" | "live";
  symbol: string;
  side: "buy" | "sell";
  entry_price: number;
  exit_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  volume: number;
  pnl?: number | null;
  pnl_pct?: number | null;
  r_multiple?: number | null;
  opened_at?: string;
  closed_at?: string | null;
  status: "open" | "closed" | "blocked";
  blocked_reason?: string | null;
  user_id?: string | null;
  day_pnl_pct?: number;
  total_pnl_pct?: number;
  equity_after?: number | null;
  meta?: Record<string, unknown>;
}

export interface BacktestTrade {
  id: number;
  side: "long" | "short";
  entry: number;
  exit: number;
  stop_loss: number;
  take_profit: number;
  units: number;
  pnl: number;
  pnl_pct: number;
  r_multiple: number;
  entry_index: number;
  exit_index: number;
  exit_reason: string;
  sample: "in" | "out";
}

/** Chart-ready series produced by the engine alongside the metrics. */
export interface BacktestCurve {
  /** Downsampled equity, one point per `step` bars. */
  equity: number[];
  /** Running drawdown in percent, same length as `equity`. */
  drawdown: number[];
  initial_equity: number;
  final_equity: number;
  /** Index where the in-sample split ends and out-of-sample begins. */
  split_index: number;
  max_drawdown_pct: number;
  step: number;
  bars: number;
  trades: {
    i: number;
    x: number;
    side: "long" | "short";
    pnl: number;
    r: number;
    reason: string;
    sample: "in" | "out";
  }[];
}

export interface BacktestResult {
  metrics: Metrics;
  in_sample: Metrics;
  out_of_sample: Metrics;
  equity_curve: number[];
  curve?: BacktestCurve;
  trades: BacktestTrade[];
  bars_used: number;
  seed: number | null;
  engine: string;
  trade_count?: number;
}

export interface OptimizeResult {
  engine: string;
  engine_label: string;
  objective: string;
  objective_label: string;
  n_trials: number;
  search_space: Record<string, number[]>;
  best_trial: number;
  best_parameters: Record<string, number>;
  best_score: number;
  baseline_parameters: Record<string, number>;
  baseline_score: number;
  improvement_pct: number;
  metrics: Metrics;
  in_sample: Metrics;
  out_of_sample: Metrics;
  overfit_risk: "low" | "medium" | "high";
  oos_retention: number;
  history: { trial: number; value: number; parameters: Record<string, number>; is_baseline?: boolean }[];
  equity_curve: number[];
  trades: BacktestTrade[];
}

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  metric?: string;
  value?: number;
  threshold?: number;
}

export interface Recommendation {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
  action: string;
}

export interface AnalysisReport {
  engine: string;
  engine_label: string;
  score: number;
  verdict: "healthy" | "watch" | "degraded" | "critical";
  summary: string;
  findings: Finding[];
  recommendations: Recommendation[];
  positives: string[];
  regime: { trend: string; volatility: string; walk_forward: string };
  decay: {
    recent_expectancy_r: number | null;
    prior_expectancy_r: number | null;
    ratio: number | null;
    state: string;
  };
  breakeven_win_rate: number;
  thresholds: {
    max_daily_drawdown_pct: number;
    max_total_drawdown_pct: number;
    risk_per_trade_pct: number;
  };
  metrics: Metrics;
  in_sample: Metrics;
  out_of_sample: Metrics;
  equity_curve: number[];
  llm?: { engine: string | null; model?: string | null; sections?: LlmSections | null; error?: string | null } | null;
}

export interface LlmSections {
  headline: string;
  narrative: string;
  verdict: string;
  risks: string[];
  actions: string[];
  confidence: number;
}

export interface RiskDecision {
  allowed: boolean;
  code: string;
  reason: string;
  action: "allow" | "reduce" | "block" | "liquidate";
  daily_drawdown_pct: number;
  total_drawdown_pct: number;
  daily_limit_pct: number;
  total_limit_pct: number;
  daily_headroom_pct: number;
  total_headroom_pct: number;
  approved_risk_pct: number;
  requested_risk_pct: number;
  adjusted_volume: number;
  requested_volume: number;
  breach?: string | null;
}

export type Mt5Mode = "live" | "shadow" | "unavailable";

export interface Mt5Status {
  available: boolean;
  connected: boolean;
  mode: Mt5Mode;
  configured: boolean;
  reason?: string;
  account?: {
    login?: number | null;
    server?: string | null;
    balance?: number | null;
    equity?: number | null;
    margin?: number | null;
    free_margin?: number | null;
    currency?: string | null;
    leverage?: number | null;
    name?: string | null;
    broker?: string | null;
  } | null;
  terminal?: {
    name?: string | null;
    company?: string | null;
    path?: string | null;
    build?: number | null;
    trade_allowed?: boolean | null;
    connected?: boolean | null;
  } | null;
  credentials?: {
    login: boolean;
    password: boolean;
    server: boolean;
    path: boolean;
  } | null;
}

export interface Mt5Quote {
  available: boolean;
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  spread?: number;
  digits?: number;
  volume?: number;
  time?: number;
  server_time?: string;
  reason?: string;
}

export interface Mt5Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Mt5CandleSeries {
  available: boolean;
  symbol: string;
  timeframe: string;
  digits?: number;
  candles: Mt5Candle[];
  change?: number;
  change_pct?: number;
  reason?: string;
}

/** Live snapshot of one strategy's paper-trading session. */
export interface PaperStats {
  strategy_id: string;
  running: boolean;
  trades: number;
  wins: number;
  losses: number;
  blocked: number;
  open: number;
  net_pnl: number;
  net_pnl_pct: number;
  equity: number;
  peak_equity: number;
  day_pnl_pct: number;
  total_pnl_pct: number;
  daily_drawdown_pct: number;
  total_drawdown_pct: number;
  expectancy_r: number;
  last_signal: string | null;
  last_update: string | null;
  parameters: Record<string, number>;
  recent: TradeLog[];
}

export interface AppSettings {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MT5_PATH: string;
  MT5_LOGIN: string;
  MT5_PASSWORD: string;
  MT5_SERVER: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OLLAMA_URL: string;
  OLLAMA_MODEL: string;
  MAX_DAILY_DRAWDOWN: number;
  MAX_TOTAL_DRAWDOWN: number;
  RISK_PER_TRADE_PCT: number;
  MAX_CONCURRENT_TRADES: number;
  BEST_DAY_PROFIT_CAP_PCT: number;
  EMERGENCY_LIQUIDATE_ON_BREACH: boolean;
  DEFAULT_SYMBOL: string;
  DEFAULT_TIMEFRAME: string;
  BACKTEST_BARS: number;
  OPTIMIZER_TRIALS: number;
  AUTONOMOUS_DEFAULT: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  MT5_PATH: "",
  MT5_LOGIN: "",
  MT5_PASSWORD: "",
  MT5_SERVER: "",
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "gpt-4o-mini",
  OLLAMA_URL: "http://localhost:11434",
  OLLAMA_MODEL: "llama3.1",
  MAX_DAILY_DRAWDOWN: 3.5,
  MAX_TOTAL_DRAWDOWN: 5.0,
  RISK_PER_TRADE_PCT: 0.5,
  MAX_CONCURRENT_TRADES: 2,
  BEST_DAY_PROFIT_CAP_PCT: 35.0,
  EMERGENCY_LIQUIDATE_ON_BREACH: true,
  DEFAULT_SYMBOL: "XAUUSD",
  DEFAULT_TIMEFRAME: "H1",
  BACKTEST_BARS: 3000,
  OPTIMIZER_TRIALS: 40,
  AUTONOMOUS_DEFAULT: false,
};

export const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"] as const;
export const SYMBOLS = [
  "XAUUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "US30Cash",
  "NAS100",
  "BTCUSD",
] as const;
export const OBJECTIVES = [
  { value: "sharpe", label: "Sharpe ratio" },
  { value: "expectancy", label: "Expectancy (R)" },
  { value: "profit_factor", label: "Profit factor" },
  { value: "prop_readiness", label: "Prop-firm readiness" },
  { value: "net_return", label: "Net return %" },
] as const;
