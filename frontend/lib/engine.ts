/**
 * AlphaForge in-browser engine.
 *
 * A faithful TypeScript port of `backend/services/{backtester,optuna_optimizer,
 * python_analyzer,risk}.py`. It exists so the studio stays fully functional
 * when the Python engine is not reachable (offline dev, a fresh preview with no
 * `NEXT_PUBLIC_API_URL`, or a static deploy). `lib/api.ts` always prefers the
 * Python engine and only falls back to these functions.
 */

import type {
  AnalysisReport,
  BacktestResult,
  BacktestTrade,
  Finding,
  Metrics,
  OptimizeResult,
  Recommendation,
  RiskDecision,
  Strategy,
} from "./types";

export const TIMEFRAME_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
  W1: 10080,
};

const BASE_PRICE: Record<string, number> = {
  XAUUSD: 2650,
  EURUSD: 1.085,
  GBPUSD: 1.265,
  USDJPY: 152.4,
  US30Cash: 42500,
  NAS100: 20500,
  BTCUSD: 64000,
};

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ---------------------------------------------------------------------------
// deterministic PRNG (mulberry32) — same series for the same seed every time
// ---------------------------------------------------------------------------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function generateBars(
  symbol: string,
  timeframe: string,
  n = 3000,
  seed = 7,
): Bar[] {
  const minutes = TIMEFRAME_MINUTES[timeframe] ?? 60;
  const rand = mulberry32(seed);
  const base = BASE_PRICE[symbol] ?? 100;
  const barsPerDay = Math.max(1, 1440 / minutes);
  let price = base;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    const slow = Math.sin(i / (barsPerDay * 45));
    const fast = Math.sin(i / (barsPerDay * 7)) * 0.35;
    const drift = (slow * 0.9 + fast) * 0.00018;
    const cluster = 1 + 1.6 * Math.abs(Math.sin(i / (barsPerDay * 23)));
    const sigma = 0.0009 * cluster;
    const o = price;
    let high = price;
    let low = price;
    for (let s = 0; s < 4; s += 1) {
      const step = drift / 4 + (sigma / 2) * gauss(rand);
      price = Math.max(0.0001, price * (1 + step));
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    if (rand() < 0.0015) {
      const gap = sigma * 14 * (rand() < 0.5 ? 1 : -1);
      price = Math.max(0.0001, price * (1 + gap));
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    bars.push({ t: i, o, h: high, l: low, c: price, v: 1000 + 400 * cluster + rand() * 250 });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------
export function ema(values: number[], period: number): number[] {
  const p = Math.max(1, Math.round(period));
  const k = 2 / (p + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i += 1) {
    prev = i === 0 ? values[i] : (values[i] - prev) * k + prev;
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const p = Math.max(1, Math.round(period));
  const out: number[] = [];
  let running = 0;
  for (let i = 0; i < values.length; i += 1) {
    running += values[i];
    if (i >= p) running -= values[i - p];
    out.push(running / Math.min(i + 1, p));
  }
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  const p = Math.max(2, Math.round(period));
  const out = new Array(values.length).fill(50);
  if (values.length < 2) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= p) {
      gains += gain / p;
      losses += loss / p;
      if (i === p) out[i] = rsiFrom(gains, losses);
    } else {
      gains = (gains * (p - 1) + gain) / p;
      losses = (losses * (p - 1) + loss) / p;
      out[i] = rsiFrom(gains, losses);
    }
  }
  const warm = Math.min(p, values.length - 1);
  for (let i = 0; i <= warm; i += 1) out[i] = out[warm];
  return out;
}

function rsiFrom(gains: number, losses: number): number {
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function atr(bars: Bar[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) {
      trs.push(bars[i].h - bars[i].l);
    } else {
      const prevClose = bars[i - 1].c;
      trs.push(
        Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - prevClose),
          Math.abs(bars[i].l - prevClose),
        ),
      );
    }
  }
  return sma(trs, period);
}

export function donchian(bars: Bar[], lookback = 20): [number[], number[]] {
  const lb = Math.max(2, Math.round(lookback));
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const start = Math.max(0, i - lb);
    let high = -Infinity;
    let low = Infinity;
    for (let j = start; j < i; j += 1) {
      if (bars[j].h > high) high = bars[j].h;
      if (bars[j].l < low) low = bars[j].l;
    }
    if (high === -Infinity) {
      high = bars[i]?.h ?? 0;
      low = bars[i]?.l ?? 0;
    }
    highs.push(high);
    lows.push(low);
  }
  return [highs, lows];
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function computeMetrics(
  trades: BacktestTrade[],
  equityCurve: number[],
  opts: {
    initialEquity?: number;
    timeframe?: string;
    bars?: number;
    maxDailyDdPct?: number;
    maxTotalDdPct?: number;
  } = {},
): Metrics {
  const initialEquity = opts.initialEquity ?? 10000;
  const timeframe = opts.timeframe ?? "H1";
  const maxDaily = opts.maxDailyDdPct ?? 3.5;
  const maxTotal = opts.maxTotalDdPct ?? 5.0;
  const n = trades.length;
  if (n === 0) {
    return {
      total_trades: 0,
      win_rate: 0,
      net_return_pct: 0,
      max_drawdown_pct: 0,
      max_daily_drawdown_pct: 0,
      profit_factor: 0,
      sharpe: 0,
      expectancy_r: 0,
      est_trades_per_week: 0,
      prop_readiness: 0,
      longest_losing_streak: 0,
      final_equity: initialEquity,
    };
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1] : initialEquity;
  const netReturnPct = (finalEquity / initialEquity - 1) * 100;

  let peak = equityCurve[0] ?? initialEquity;
  let maxDd = 0;
  for (const value of equityCurve.length ? equityCurve : [initialEquity]) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - value) / peak) * 100);
  }

  const minutes = TIMEFRAME_MINUTES[timeframe] ?? 60;
  const barsPerDay = Math.max(1, Math.round(1440 / minutes));
  let maxDailyDd = 0;
  for (let start = 0; start < equityCurve.length; start += barsPerDay) {
    const chunk = equityCurve.slice(start, start + barsPerDay);
    if (!chunk.length) continue;
    const dayStart = chunk[0];
    if (dayStart <= 0) continue;
    const worst = Math.min(...chunk);
    maxDailyDd = Math.max(maxDailyDd, ((dayStart - worst) / dayStart) * 100);
  }

  const rMultiples = trades.map((t) => t.r_multiple);
  const expectancy = rMultiples.reduce((a, b) => a + b, 0) / n;
  const avgWinR = wins.length ? wins.reduce((a, t) => a + t.r_multiple, 0) / wins.length : 0;
  const avgLossR = losses.length
    ? losses.reduce((a, t) => a + t.r_multiple, 0) / losses.length
    : 0;

  const pctReturns = trades.map((t) => t.pnl_pct);
  const meanR = pctReturns.reduce((a, b) => a + b, 0) / n;
  const variance =
    pctReturns.reduce((a, x) => a + (x - meanR) ** 2, 0) / Math.max(1, n - 1);
  const std = Math.sqrt(variance);
  const minutesTotal = (opts.bars ?? n) * minutes;
  const weeks = Math.max(minutesTotal / (60 * 24 * 7), 1e-9);
  const tradesPerWeek = n / weeks;
  const sharpe = std > 1e-12 ? (meanR / std) * Math.sqrt(Math.max(tradesPerWeek * 52, 1)) : 0;

  let streak = 0;
  let worstStreak = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      streak += 1;
      worstStreak = Math.max(worstStreak, streak);
    } else {
      streak = 0;
    }
  }

  const ddScore = clamp(1 - maxDd / Math.max(maxTotal, 1e-9), 0, 1);
  const dailyDdScore = clamp(1 - maxDailyDd / Math.max(maxDaily, 1e-9), 0, 1);
  const pfScore = clamp((profitFactor - 1) / 1.2, 0, 1);
  const expScore = clamp(expectancy / 0.45, 0, 1);
  const sampleScore = clamp(n / 120, 0, 1);
  const sharpeScore = clamp(sharpe / 2.2, 0, 1);
  const readiness =
    100 *
    (0.2 * ddScore +
      0.12 * dailyDdScore +
      0.2 * pfScore +
      0.2 * expScore +
      0.14 * sampleScore +
      0.14 * sharpeScore);

  return {
    total_trades: n,
    wins: wins.length,
    losses: losses.length,
    win_rate: round((wins.length / n) * 100, 2),
    net_return_pct: round(netReturnPct, 4),
    max_drawdown_pct: round(maxDd, 4),
    max_daily_drawdown_pct: round(maxDailyDd, 4),
    profit_factor: round(profitFactor, 4),
    sharpe: round(sharpe, 4),
    expectancy_r: round(expectancy, 4),
    avg_win_r: round(avgWinR, 4),
    avg_loss_r: round(avgLossR, 4),
    longest_losing_streak: worstStreak,
    est_trades_per_week: round(tradesPerWeek, 2),
    prop_readiness: round(readiness, 2),
    final_equity: round(finalEquity, 2),
    recovery_factor: round(maxDd > 0 ? netReturnPct / maxDd : 0, 4),
  };
}

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// ---------------------------------------------------------------------------
// backtest
// ---------------------------------------------------------------------------
export interface BacktestOptions {
  bars?: Bar[];
  barsCount?: number;
  seed?: number;
  split?: number;
  initialEquity?: number;
  maxDailyDdPct?: number;
  maxTotalDdPct?: number;
  commissionPct?: number;
  spreadPct?: number;
  parameters?: Record<string, number>;
}

interface OpenPosition {
  side: "long" | "short";
  entry: number;
  sl: number;
  tp: number;
  units: number;
  entryIndex: number;
  riskCapital: number;
}

export function runBacktest(strategy: Strategy, options: BacktestOptions = {}): BacktestResult {
  const params: Record<string, number> = { ...strategy.parameters, ...(options.parameters ?? {}) };
  const seed = options.seed ?? 7;
  const split = clamp(options.split ?? 0.7, 0.1, 1);
  const initialEquity = options.initialEquity ?? 10000;
  const commissionPct = options.commissionPct ?? 0.004;
  const spreadPct = options.spreadPct ?? 0.01;
  const maxDaily = options.maxDailyDdPct ?? 3.5;
  const maxTotal = options.maxTotalDdPct ?? 5.0;

  const bars =
    options.bars ??
    generateBars(strategy.symbol, strategy.timeframe, options.barsCount ?? 3000, seed);
  if (!bars.length) {
    return {
      metrics: computeMetrics([], [], { initialEquity }),
      in_sample: computeMetrics([], [], { initialEquity }),
      out_of_sample: computeMetrics([], [], { initialEquity }),
      equity_curve: [],
      trades: [],
      bars_used: 0,
      seed,
      engine: "alphaforge-js",
    };
  }

  const fastPeriod = Math.max(2, Math.round(params.fast_ema ?? 12));
  const slowPeriod = Math.max(fastPeriod + 1, Math.round(params.slow_ema ?? 26));
  const rsiPeriod = Math.max(2, Math.round(params.rsi_period ?? 14));
  const rsiLower = params.rsi_lower ?? 32;
  const rsiUpper = params.rsi_upper ?? 68;
  const atrPeriod = Math.max(2, Math.round(params.atr_period ?? 14));
  const atrMult = Math.max(0.3, params.atr_sl_mult ?? 2);
  const rr = Math.max(0.2, params.rr_ratio ?? 2);
  const lookback = Math.max(3, Math.round(params.breakout_lookback ?? 20));
  const riskPct = Math.max(0.01, params.risk_per_trade_pct ?? strategy.risk_profile?.risk_per_trade_pct ?? 0.5);
  const trendFilter = (params.trend_filter_enabled ?? 1) >= 0.5;
  const minStrength = Math.max(1, params.min_signal_strength ?? 1);

  const closes = bars.map((b) => b.c);
  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);
  const rsiValues = rsi(closes, rsiPeriod);
  const atrValues = atr(bars, atrPeriod);
  const [donHi, donLo] = donchian(bars, lookback);

  const rules = strategy.rules ?? { side: "both", entries: [], exits: [], filters: [] };
  const indicatorSet = new Set(
    [...(rules.entries ?? []), ...(rules.filters ?? [])].map((r) => r.indicator),
  );
  const useBreakout = indicatorSet.has("donchian_breakout");
  const useRsi = indicatorSet.has("rsi");
  const useEma =
    indicatorSet.has("ema_cross") || indicatorSet.has("ema_stack") || indicatorSet.size === 0;

  let equity = initialEquity;
  const equityCurve: number[] = [];
  const trades: BacktestTrade[] = [];
  let open: OpenPosition | null = null;
  const splitIndex = Math.floor(bars.length * split);
  let tradeId = 0;
  let lastExitIndex = -10000;
  const warmup = Math.max(slowPeriod, lookback, atrPeriod, rsiPeriod) + 2;

  const signalAt = (i: number): "long" | "short" | null => {
    let bullish = 0;
    let bearish = 0;
    let any = false;
    if (useEma) {
      any = true;
      const nowFast = emaFast[i];
      const nowSlow = emaSlow[i];
      const prevFast = emaFast[i - 1];
      const prevSlow = emaSlow[i - 1];
      const crossedUp = prevFast <= prevSlow && nowFast > nowSlow;
      const crossedDown = prevFast >= prevSlow && nowFast < nowSlow;
      if (crossedUp || nowFast > nowSlow) bullish += 1;
      if (crossedDown || nowFast < nowSlow) bearish += 1;
    }
    if (useBreakout) {
      any = true;
      if (closes[i] > donHi[i - 1]) bullish += 1;
      if (closes[i] < donLo[i - 1]) bearish += 1;
    }
    if (useRsi) {
      any = true;
      const value = rsiValues[i];
      if (value < rsiLower) bullish += 1;
      if (value > rsiUpper) bearish += 1;
    }
    if (!any) {
      bullish = 1;
      bearish = 1;
    }
    if (bullish > bearish) return "long";
    if (bearish > bullish) return "short";
    if (trendFilter && emaFast[i] !== emaSlow[i]) {
      return emaFast[i] > emaSlow[i] ? "long" : "short";
    }
    return null;
  };

  const strengthOk = (i: number, signal: string) => {
    if (minStrength <= 1) return true;
    let score = 0;
    if (emaFast[i] > emaSlow[i]) score += 1;
    if (signal === "long" && closes[i] > donLo[i]) score += 1;
    if (signal === "short" && closes[i] < donHi[i]) score += 1;
    return score >= minStrength;
  };

  const sideAllowed = (signal: string) => {
    const side = (rules.side ?? "both").toLowerCase();
    return side === "both" || side === signal;
  };

  const inSession = (bar: Bar) => {
    const session = (strategy.risk_profile?.session ?? "all_day").toLowerCase();
    if (["all_day", "all", "24/7", "any"].includes(session)) return true;
    const minutes = TIMEFRAME_MINUTES[strategy.timeframe] ?? 60;
    const hour = Math.floor(((bar.t * minutes) / 60) % 24);
    if (session === "london_ny") return hour >= 7 && hour <= 20;
    if (session === "london") return hour >= 7 && hour <= 15;
    if (session === "new_york") return hour >= 13 && hour <= 21;
    if (session === "asia") return hour >= 23 || hour <= 7;
    return true;
  };

  const closeTrade = (
    position: OpenPosition,
    exitPrice: number,
    reason: string,
    exitIndex: number,
  ): BacktestTrade => {
    const gross =
      position.side === "long"
        ? (exitPrice - position.entry) * position.units
        : (position.entry - exitPrice) * position.units;
    const notional = (position.entry + exitPrice) * position.units;
    const commission = (notional * commissionPct) / 100 / 2;
    const spreadCost = (notional * spreadPct) / 100 / 2;
    const pnl = gross - commission - spreadCost;
    tradeId += 1;
    return {
      id: tradeId,
      side: position.side,
      entry: position.entry,
      exit: exitPrice,
      stop_loss: position.sl,
      take_profit: position.tp,
      units: position.units,
      pnl,
      pnl_pct: equity > 0 ? (pnl / equity) * 100 : 0,
      r_multiple: pnl / (position.riskCapital || 1),
      entry_index: position.entryIndex,
      exit_index: exitIndex,
      exit_reason: reason,
      sample: position.entryIndex < splitIndex ? "in" : "out",
    };
  };

  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];

    if (open) {
      let exitPrice: number | null = null;
      let reason = "";
      if (open.side === "long") {
        if (bar.l <= open.sl) {
          exitPrice = open.sl;
          reason = "stop_loss";
        } else if (bar.h >= open.tp) {
          exitPrice = open.tp;
          reason = "take_profit";
        }
      } else if (bar.h >= open.sl) {
        exitPrice = open.sl;
        reason = "stop_loss";
      } else if (bar.l <= open.tp) {
        exitPrice = open.tp;
        reason = "take_profit";
      }

      if (exitPrice === null) {
        const signal = signalAt(i);
        if (signal && signal !== open.side) {
          exitPrice = bar.c;
          reason = "reverse_signal";
        }
      }

      if (exitPrice !== null) {
        const trade = closeTrade(open, exitPrice, reason, i);
        equity += trade.pnl;
        trades.push(trade);
        equityCurve.push(equity);
        open = null;
        lastExitIndex = i;
        continue;
      }
    }

    if (!open && i > warmup && i - lastExitIndex >= 1 && inSession(bar)) {
      const signal = signalAt(i);
      if (signal && sideAllowed(signal) && strengthOk(i, signal)) {
        const entry = bar.c;
        const atrValue = atrValues[i] || bar.h - bar.l || entry * 0.001;
        const stopDistance = Math.max(atrValue * atrMult, entry * 0.0002);
        const sl = signal === "long" ? entry - stopDistance : entry + stopDistance;
        const tp = signal === "long" ? entry + stopDistance * rr : entry - stopDistance * rr;
        const riskCapital = equity * (riskPct / 100);
        const units = stopDistance > 0 ? riskCapital / stopDistance : 0;
        if (units > 0) {
          open = { side: signal, entry, sl, tp, units, entryIndex: i, riskCapital };
        }
      }
    }

    equityCurve.push(equity);
  }

  if (open) {
    const trade = closeTrade(open, bars[bars.length - 1].c, "end_of_data", bars.length - 1);
    equity += trade.pnl;
    trades.push(trade);
    equityCurve.push(equity);
  }
  if (!equityCurve.length) equityCurve.push(initialEquity);

  const inTrades = trades.filter((t) => t.sample === "in");
  const outTrades = trades.filter((t) => t.sample === "out");
  const equityFrom = (list: BacktestTrade[]) => {
    const curve = [initialEquity];
    for (const t of list) curve.push(curve[curve.length - 1] + t.pnl);
    return curve;
  };

  return {
    metrics: computeMetrics(trades, equityCurve, {
      initialEquity,
      timeframe: strategy.timeframe,
      bars: bars.length,
      maxDailyDdPct: maxDaily,
      maxTotalDdPct: maxTotal,
    }),
    in_sample: computeMetrics(inTrades, equityFrom(inTrades), {
      initialEquity,
      timeframe: strategy.timeframe,
      bars: Math.max(1, splitIndex),
      maxDailyDdPct: maxDaily,
      maxTotalDdPct: maxTotal,
    }),
    out_of_sample: computeMetrics(outTrades, equityFrom(outTrades), {
      initialEquity,
      timeframe: strategy.timeframe,
      bars: Math.max(1, bars.length - splitIndex),
      maxDailyDdPct: maxDaily,
      maxTotalDdPct: maxTotal,
    }),
    equity_curve: equityCurve,
    trades,
    bars_used: bars.length,
    seed,
    engine: "alphaforge-js",
  };
}

// ---------------------------------------------------------------------------
// optimizer
// ---------------------------------------------------------------------------
const INT_PARAMS = new Set([
  "fast_ema",
  "slow_ema",
  "rsi_period",
  "atr_period",
  "breakout_lookback",
  "max_bars",
]);

const isIntParam = (name: string) =>
  INT_PARAMS.has(name) || name.endsWith("_period") || name.endsWith("_lookback");

export const DEFAULT_BOUNDS: Record<string, number[]> = {
  fast_ema: [5, 40],
  slow_ema: [20, 120],
  rsi_period: [7, 28],
  rsi_lower: [15, 45],
  rsi_upper: [55, 85],
  atr_period: [7, 28],
  atr_sl_mult: [1, 4],
  rr_ratio: [1, 5],
  breakout_lookback: [10, 60],
  risk_per_trade_pct: [0.1, 2],
};

export function boundsFor(parameters: Record<string, number>): Record<string, number[]> {
  const bounds: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (DEFAULT_BOUNDS[key]) {
      bounds[key] = [...DEFAULT_BOUNDS[key]];
      continue;
    }
    if (key === "trend_filter_enabled" || key === "min_signal_strength") continue;
    if (value === 0) {
      bounds[key] = [0.1, 1];
      continue;
    }
    bounds[key] = [round(value * 0.4, 4), round(value * 1.6, 4)];
  }
  return bounds;
}

const OBJECTIVE_FNS: Record<string, (m: Metrics) => number> = {
  sharpe: (m) => m.sharpe,
  expectancy: (m) => m.expectancy_r,
  profit_factor: (m) => m.profit_factor,
  prop_readiness: (m) => m.prop_readiness / 25,
  net_return: (m) => m.net_return_pct / 5,
};

export const OBJECTIVE_LABELS: Record<string, string> = {
  sharpe: "Sharpe ratio",
  expectancy: "Expectancy (R)",
  profit_factor: "Profit factor",
  prop_readiness: "Prop-firm readiness",
  net_return: "Net return %",
};

export function optimize(
  strategy: Strategy,
  options: {
    bars?: Bar[];
    nTrials?: number;
    objective?: string;
    bounds?: Record<string, number[]>;
    seed?: number;
    split?: number;
    barsCount?: number;
    maxDailyDdPct?: number;
    maxTotalDdPct?: number;
  } = {},
): OptimizeResult {
  const seed = options.seed ?? 7;
  const nTrials = Math.max(1, options.nTrials ?? 40);
  const objective = options.objective ?? "sharpe";
  const split = options.split ?? 0.7;
  const maxDaily = options.maxDailyDdPct ?? 3.5;
  const maxTotal = options.maxTotalDdPct ?? 5.0;
  const bars =
    options.bars ??
    generateBars(strategy.symbol, strategy.timeframe, options.barsCount ?? 3000, seed);

  const space = options.bounds ?? boundsFor(strategy.parameters ?? {});
  const baseParams: Record<string, number> = { ...(strategy.parameters ?? {}) };
  const primary = OBJECTIVE_FNS[objective] ?? OBJECTIVE_FNS.sharpe;

  const evaluate = (parameters: Record<string, number>) => {
    const result = runBacktest(strategy, {
      bars,
      seed,
      split,
      maxDailyDdPct: maxDaily,
      maxTotalDdPct: maxTotal,
      parameters,
    });
    const inSample = result.in_sample;
    let score = primary(inSample);
    const tradeCount = inSample.total_trades ?? 0;
    if (tradeCount < 10) score -= (10 - tradeCount) * 0.35;
    const dd = inSample.max_drawdown_pct ?? 0;
    if (dd > maxTotal) score -= (dd - maxTotal) * 1.5;
    else if (dd > maxTotal * 0.7) score -= (dd - maxTotal * 0.7) * 0.6;
    const dailyDd = inSample.max_daily_drawdown_pct ?? 0;
    if (dailyDd > maxDaily) score -= (dailyDd - maxDaily) * 2;
    if ((inSample.profit_factor ?? 0) < 1) score -= 1.5;
    return { score, inSample, outOfSample: result.out_of_sample, parameters };
  };

  const baseline = evaluate(baseParams);
  const history: OptimizeResult["history"] = [
    { trial: 0, value: round(baseline.score, 5), parameters: { ...baseParams }, is_baseline: true },
  ];
  let best = { ...baseline, trial: 0 };
  const rand = mulberry32(seed + 7919);

  for (let trial = 1; trial <= nTrials; trial += 1) {
    const candidate: Record<string, number> = { ...baseParams };
    for (const [name, rawRange] of Object.entries(space)) {
      let [low, high] = rawRange;
      if (low > high) [low, high] = [high, low];
      const value = low + rand() * (high - low);
      candidate[name] = isIntParam(name) ? Math.round(value) : round(value, 5);
    }
    const outcome = evaluate(candidate);
    history.push({ trial, value: round(outcome.score, 5), parameters: { ...candidate } });
    if (outcome.score > best.score) best = { ...outcome, trial };
  }

  const final = runBacktest(strategy, {
    bars,
    seed,
    split,
    maxDailyDdPct: maxDaily,
    maxTotalDdPct: maxTotal,
    parameters: best.parameters,
  });
  const isPf = best.inSample.profit_factor ?? 0;
  const oosPf = final.out_of_sample.profit_factor ?? 0;
  const retention = isPf > 0 ? oosPf / isPf : 0;
  const overfitRisk: OptimizeResult["overfit_risk"] =
    isPf >= 1.2 && oosPf < 1 ? "high" : retention < 0.6 ? "medium" : "low";

  return {
    engine: "random-search-js",
    engine_label: "In-browser random search",
    objective,
    objective_label: OBJECTIVE_LABELS[objective] ?? objective,
    n_trials: nTrials,
    search_space: space,
    best_trial: best.trial,
    best_parameters: { ...best.parameters },
    best_score: round(best.score, 5),
    baseline_parameters: { ...baseParams },
    baseline_score: round(baseline.score, 5),
    improvement_pct:
      Math.abs(baseline.score) > 1e-9
        ? round(((best.score - baseline.score) / Math.abs(baseline.score)) * 100, 2)
        : 0,
    metrics: final.metrics,
    in_sample: final.in_sample,
    out_of_sample: final.out_of_sample,
    overfit_risk: overfitRisk,
    oos_retention: round(retention, 3),
    history,
    equity_curve: final.equity_curve.filter(
      (_, i) => i % Math.max(1, Math.floor(final.equity_curve.length / 240) || 1) === 0,
    ),
    trades: final.trades.slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// diagnostic analyst (deterministic twin of services/python_analyzer.py)
// ---------------------------------------------------------------------------
const SEVERITY_WEIGHT: Record<string, number> = { critical: 26, warning: 12, info: 3 };

export function analyzeStrategy(input: {
  strategyName: string;
  metrics: Metrics;
  inSample?: Metrics;
  outOfSample?: Metrics;
  trades?: BacktestTrade[];
  riskProfile?: {
    risk_per_trade_pct: number;
    rr_ratio: number;
    max_daily_drawdown_pct: number;
    max_total_drawdown_pct: number;
  };
  baselineMetrics?: Metrics | null;
}): AnalysisReport {
  const metrics = input.metrics ?? ({} as Metrics);
  const risk = input.riskProfile ?? {
    risk_per_trade_pct: 0.5,
    rr_ratio: 2,
    max_daily_drawdown_pct: 3.5,
    max_total_drawdown_pct: 5,
  };
  const maxDaily = risk.max_daily_drawdown_pct || 3.5;
  const maxTotal = risk.max_total_drawdown_pct || 5;
  const riskPerTrade = risk.risk_per_trade_pct || 0.5;
  const rr = risk.rr_ratio || 2;

  const totalTrades = metrics.total_trades ?? 0;
  const winRate = metrics.win_rate ?? 0;
  const profitFactor = metrics.profit_factor ?? 0;
  const maxDd = metrics.max_drawdown_pct ?? 0;
  const maxDailyDd = metrics.max_daily_drawdown_pct ?? 0;
  const expectancy = metrics.expectancy_r ?? 0;
  const sharpe = metrics.sharpe ?? 0;
  const streak = metrics.longest_losing_streak ?? 0;
  const tradesPerWeek = metrics.est_trades_per_week ?? 0;

  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  if (totalTrades === 0) {
    findings.push({
      id: "no_trades",
      severity: "critical",
      title: "No trades generated",
      detail:
        "The backtest produced zero trades in the sampled window, so every other statistic is meaningless. Widen the entry conditions or extend the history.",
      metric: "total_trades",
      value: 0,
      threshold: 30,
    });
  } else if (totalTrades < 30) {
    findings.push({
      id: "thin_sample",
      severity: "critical",
      title: "Sample too small to trust",
      detail: `Only ${totalTrades} trades observed. Below ~30 trades the confidence interval on win rate is wider than the edge itself.`,
      metric: "total_trades",
      value: totalTrades,
      threshold: 30,
    });
  } else if (totalTrades < 100) {
    findings.push({
      id: "modest_sample",
      severity: "warning",
      title: "Modest sample size",
      detail: `${totalTrades} trades is workable but thin — expect meaningful drift between backtest and live expectancy.`,
      metric: "total_trades",
      value: totalTrades,
      threshold: 100,
    });
  }

  const breakeven = 100 / (1 + rr);
  if (totalTrades > 0) {
    if (winRate < breakeven - 5) {
      findings.push({
        id: "below_breakeven",
        severity: "critical",
        title: "Win rate below break-even",
        detail: `Win rate ${winRate.toFixed(1)}% sits under the ${breakeven.toFixed(1)}% break-even line for a ${rr.toFixed(1)}R target.`,
        metric: "win_rate",
        value: winRate,
        threshold: breakeven,
      });
    } else if (winRate < breakeven + 4) {
      findings.push({
        id: "thin_edge",
        severity: "warning",
        title: "Thin win-rate cushion",
        detail: `Win rate ${winRate.toFixed(1)}% is only marginally above the ${breakeven.toFixed(1)}% break-even.`,
        metric: "win_rate",
        value: winRate,
        threshold: breakeven,
      });
    }
    if (profitFactor < 1) {
      findings.push({
        id: "negative_edge",
        severity: "critical",
        title: "Profit factor below 1.0",
        detail: `Profit factor ${profitFactor.toFixed(2)} means gross losses exceed gross profits.`,
        metric: "profit_factor",
        value: profitFactor,
        threshold: 1.2,
      });
    } else if (profitFactor < 1.2) {
      findings.push({
        id: "weak_pf",
        severity: "warning",
        title: "Weak profit factor",
        detail: `Profit factor ${profitFactor.toFixed(2)} leaves almost no room for spread, commission and slippage.`,
        metric: "profit_factor",
        value: profitFactor,
        threshold: 1.2,
      });
    }
  }

  if (maxDd > maxTotal) {
    findings.push({
      id: "dd_breach_total",
      severity: "critical",
      title: "Total drawdown breaches the prop-firm cap",
      detail: `Max drawdown ${maxDd.toFixed(2)}% exceeds the ${maxTotal.toFixed(2)}% total limit. This configuration would fail the challenge.`,
      metric: "max_drawdown_pct",
      value: maxDd,
      threshold: maxTotal,
    });
  } else if (maxDd > maxTotal * 0.7) {
    findings.push({
      id: "dd_near_total",
      severity: "warning",
      title: "Drawdown close to the total cap",
      detail: `Max drawdown ${maxDd.toFixed(2)}% consumes ${((maxDd / maxTotal) * 100).toFixed(0)}% of the ${maxTotal.toFixed(2)}% total limit.`,
      metric: "max_drawdown_pct",
      value: maxDd,
      threshold: maxTotal,
    });
  }

  if (maxDailyDd > maxDaily) {
    findings.push({
      id: "dd_breach_daily",
      severity: "critical",
      title: "Daily drawdown breaches the prop-firm cap",
      detail: `Worst trading day lost ${maxDailyDd.toFixed(2)}% against a ${maxDaily.toFixed(2)}% daily limit.`,
      metric: "max_daily_drawdown_pct",
      value: maxDailyDd,
      threshold: maxDaily,
    });
  } else if (maxDailyDd > maxDaily * 0.7) {
    findings.push({
      id: "dd_near_daily",
      severity: "warning",
      title: "Daily drawdown close to the cap",
      detail: `Worst day ${maxDailyDd.toFixed(2)}% vs the ${maxDaily.toFixed(2)}% daily limit.`,
      metric: "max_daily_drawdown_pct",
      value: maxDailyDd,
      threshold: maxDaily,
    });
  }

  const streakDd = streak * riskPerTrade;
  if (streakDd > maxDaily) {
    findings.push({
      id: "streak_risk",
      severity: "critical",
      title: "Losing streak alone can blow the daily limit",
      detail: `The longest losing streak was ${streak} trades. At ${riskPerTrade.toFixed(2)}% risk per trade that is a ${streakDd.toFixed(2)}% drawdown — past the ${maxDaily.toFixed(2)}% daily cap.`,
      metric: "longest_losing_streak",
      value: streak,
      threshold: maxDaily / Math.max(riskPerTrade, 1e-9),
    });
    recommendations.push({
      title: "Cut risk per trade",
      detail: `Reduce risk per trade to at most ${(maxDaily / Math.max(streak, 1)).toFixed(2)}% so a repeat of the worst ${streak}-trade streak stays inside the daily limit.`,
      priority: "high",
      action: "reduce_risk",
    });
  } else if (streakDd > maxDaily * 0.6) {
    findings.push({
      id: "streak_risk_watch",
      severity: "warning",
      title: "Losing streak eats most of the daily budget",
      detail: `A ${streak}-trade streak at ${riskPerTrade.toFixed(2)}% risk consumes ${((streakDd / maxDaily) * 100).toFixed(0)}% of the daily limit.`,
      metric: "longest_losing_streak",
      value: streak,
      threshold: maxDaily / Math.max(riskPerTrade, 1e-9),
    });
  }

  if (totalTrades > 0 && expectancy < 0.05) {
    findings.push({
      id: "low_expectancy",
      severity: "critical",
      title: "Negative-to-flat expectancy",
      detail: `Expectancy ${expectancy.toFixed(3)}R per trade is too small to outrun costs.`,
      metric: "expectancy_r",
      value: expectancy,
      threshold: 0.05,
    });
  } else if (totalTrades > 0 && expectancy < 0.2) {
    findings.push({
      id: "thin_expectancy",
      severity: "warning",
      title: "Thin expectancy",
      detail: `Expectancy ${expectancy.toFixed(3)}R. Healthy systematic edges sit above ~0.25R.`,
      metric: "expectancy_r",
      value: expectancy,
      threshold: 0.2,
    });
  }

  if (totalTrades > 20 && sharpe < 0.3) {
    findings.push({
      id: "low_sharpe",
      severity: "warning",
      title: "Low risk-adjusted return",
      detail: `Sharpe ${sharpe.toFixed(2)}. Returns are not compensated for their volatility.`,
      metric: "sharpe",
      value: sharpe,
      threshold: 0.3,
    });
  }

  if (totalTrades > 0 && tradesPerWeek < 1) {
    findings.push({
      id: "too_rare",
      severity: "warning",
      title: "Signal frequency too low",
      detail: `Estimated ${tradesPerWeek.toFixed(2)} trades/week. Under ~1/week it takes years to accumulate a validated sample.`,
      metric: "est_trades_per_week",
      value: tradesPerWeek,
      threshold: 1,
    });
  }

  const regime = { trend: "unknown", volatility: "unknown", walk_forward: "n/a" };
  if (input.inSample && input.outOfSample && (input.inSample.total_trades ?? 0) > 0) {
    const isPf = input.inSample.profit_factor ?? 0;
    const oosPf = input.outOfSample.profit_factor ?? 0;
    const isSharpe = input.inSample.sharpe ?? 0;
    const oosSharpe = input.outOfSample.sharpe ?? 0;
    const retention = isPf > 0 ? oosPf / isPf : 0;
    regime.walk_forward = `${Math.round(retention * 100)}% PF retention`;
    if (oosPf < 1 && isPf >= 1.2) {
      findings.push({
        id: "overfit",
        severity: "critical",
        title: "Probable overfit — edge collapses out of sample",
        detail: `In-sample PF ${isPf.toFixed(2)} vs out-of-sample PF ${oosPf.toFixed(2)}. Parameters were likely fitted to noise.`,
        metric: "oos_profit_factor",
        value: oosPf,
        threshold: 1,
      });
      recommendations.push({
        title: "Re-optimise with wider bounds",
        detail:
          "Re-run the optimiser with fewer free parameters and wider bounds, then re-validate on a fresh out-of-sample window.",
        priority: "high",
        action: "reoptimize",
      });
    } else if (retention < 0.6) {
      findings.push({
        id: "decay_walkforward",
        severity: "warning",
        title: "Edge degrades out of sample",
        detail: `Only ${Math.round(retention * 100)}% of in-sample profit factor survived (target ≥ 60%).`,
        metric: "oos_retention",
        value: round(retention, 3),
        threshold: 0.6,
      });
    }
    if (isSharpe > 0 && oosSharpe < isSharpe * 0.4) {
      findings.push({
        id: "sharpe_decay",
        severity: "warning",
        title: "Sharpe collapses out of sample",
        detail: `In-sample Sharpe ${isSharpe.toFixed(2)} → out-of-sample ${oosSharpe.toFixed(2)}.`,
        metric: "oos_sharpe",
        value: oosSharpe,
        threshold: isSharpe * 0.4,
      });
    }
  }

  const decay: AnalysisReport["decay"] = {
    recent_expectancy_r: null,
    prior_expectancy_r: null,
    ratio: null,
    state: "unknown",
  };
  if (input.trades && input.trades.length >= 8) {
    const rValues = input.trades.map((t) => t.r_multiple);
    const half = Math.floor(rValues.length / 2);
    const prior = rValues.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const recent =
      rValues.slice(half).reduce((a, b) => a + b, 0) / (rValues.length - half);
    const ratio = Math.abs(prior) > 1e-9 ? recent / prior : 0;
    decay.recent_expectancy_r = round(recent, 3);
    decay.prior_expectancy_r = round(prior, 3);
    decay.ratio = round(ratio, 3);
    decay.state = "stable";
    if (prior > 0 && recent < prior * 0.5) {
      decay.state = "decaying";
      findings.push({
        id: "decay",
        severity: "warning",
        title: "Expectancy is decaying",
        detail: `Recent expectancy ${recent.toFixed(3)}R vs ${prior.toFixed(3)}R in the first half of the sample — classic strategy-decay signature.`,
        metric: "decay_ratio",
        value: round(ratio, 3),
        threshold: 0.5,
      });
      recommendations.push({
        title: "Flag for regime review",
        detail:
          "Freeze autonomous trading for this strategy and re-optimise on the most recent 30% of data before re-arming it.",
        priority: "high",
        action: "reoptimize",
      });
    } else if (prior > 0 && recent > prior * 1.25) {
      decay.state = "improving";
    }
    const mean = rValues.reduce((a, b) => a + b, 0) / rValues.length;
    const variance = rValues.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, rValues.length - 1);
    const stdR = Math.sqrt(variance);
    regime.volatility = stdR > 1.6 ? "high" : stdR > 0.7 ? "normal" : "low";
    regime.trend =
      winRate < 55 && profitFactor > 1.3
        ? "trending"
        : winRate > 60
          ? "mean_reverting"
          : "mixed";
  }

  if (input.baselineMetrics && (input.baselineMetrics.total_trades ?? 0) > 0) {
    const basePf = input.baselineMetrics.profit_factor ?? 0;
    if (basePf > 0 && profitFactor < basePf * 0.9) {
      findings.push({
        id: "regression_vs_baseline",
        severity: "warning",
        title: "Regression vs the active parameter set",
        detail: `Profit factor ${profitFactor.toFixed(2)} is below the active baseline ${basePf.toFixed(2)}.`,
        metric: "profit_factor",
        value: profitFactor,
        threshold: basePf,
      });
      recommendations.push({
        title: "Roll back to the baseline version",
        detail:
          "The lineage view can revert the active parameters to the last known-good optimisation in one click.",
        priority: "medium",
        action: "rollback",
      });
    }
  }

  if (totalTrades > 10 && winRate > 0 && winRate < 100 && riskPerTrade > 0) {
    const k = Math.ceil(maxTotal / riskPerTrade);
    const p = winRate / 100;
    const prob = (1 - p) ** k * Math.max(1, totalTrades - k + 1);
    if (prob > 0.25) {
      findings.push({
        id: "ruin_risk",
        severity: "critical",
        title: "Material risk of ruin",
        detail: `At ${riskPerTrade.toFixed(2)}% risk/trade a ${k}-trade losing streak breaches the ${maxTotal.toFixed(2)}% total cap; the modelled probability over this sample is ${Math.round(prob * 100)}%.`,
        metric: "ruin_probability",
        value: round(prob, 3),
        threshold: 0.25,
      });
    }
  }

  const penalty = findings.reduce((a, f) => a + (SEVERITY_WEIGHT[f.severity] ?? 0), 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const verdict: AnalysisReport["verdict"] = findings.some((f) => f.severity === "critical")
    ? "critical"
    : score >= 80
      ? "healthy"
      : score >= 55
        ? "watch"
        : "degraded";

  if (!recommendations.length) {
    if (verdict === "healthy" || verdict === "watch") {
      recommendations.push({
        title: "Promote to shadow trading",
        detail:
          "Statistics are inside the prop-firm envelope. Run shadow mode for one to two weeks before committing capital.",
        priority: "low",
        action: "promote_shadow",
      });
    } else {
      recommendations.push({
        title: "Re-optimise parameters",
        detail:
          "Run the optimiser to search for a parameter set that clears the prop-firm drawdown caps.",
        priority: "medium",
        action: "reoptimize",
      });
    }
  }

  const positives: string[] = [];
  if (profitFactor >= 1.3) positives.push(`Profit factor ${profitFactor.toFixed(2)} clears the 1.3 institutional bar.`);
  if (expectancy >= 0.25) positives.push(`Expectancy ${expectancy.toFixed(2)}R per trade is robust.`);
  if (maxDd <= maxTotal * 0.6 && totalTrades > 0)
    positives.push(`Drawdown ${maxDd.toFixed(2)}% sits comfortably inside the ${maxTotal.toFixed(2)}% cap.`);
  if (sharpe >= 1) positives.push(`Sharpe ${sharpe.toFixed(2)} indicates efficient risk-adjusted returns.`);

  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  return {
    engine: "python-statistical",
    engine_label: "Python Statistical Diagnostic Engine",
    score,
    verdict,
    summary: `${input.strategyName}: ${verdict.toUpperCase()} (${score}/100). ${totalTrades} trades · ${winRate.toFixed(1)}% win rate · PF ${profitFactor.toFixed(2)} · expectancy ${expectancy.toFixed(2)}R · max DD ${maxDd.toFixed(2)}% · net ${(metrics.net_return_pct ?? 0).toFixed(2)}%. ${
      findings.length ? `${criticalCount} critical, ${warningCount} warnings.` : "No blocking issues found."
    }`,
    findings,
    recommendations,
    positives,
    regime,
    decay,
    breakeven_win_rate: round(breakeven, 2),
    thresholds: {
      max_daily_drawdown_pct: maxDaily,
      max_total_drawdown_pct: maxTotal,
      risk_per_trade_pct: riskPerTrade,
    },
    metrics,
    in_sample: input.inSample ?? metrics,
    out_of_sample: input.outOfSample ?? metrics,
    equity_curve: [],
    llm: null,
  };
}

// ---------------------------------------------------------------------------
// Prop-Firm Shield
// ---------------------------------------------------------------------------
export interface ShieldConfig {
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  riskPerTradePct: number;
  maxConcurrentTrades: number;
}

export function evaluateShield(
  config: ShieldConfig,
  state: {
    equity: number;
    dayStartEquity: number;
    peakEquity: number;
    requestedRiskPct?: number;
    volume?: number;
    openPositions?: number;
  },
): RiskDecision {
  const equity = state.equity || 0;
  const dayStart = state.dayStartEquity || equity || 1;
  const peak = state.peakEquity || Math.max(equity, dayStart) || 1;
  const drawdownPct = (reference: number, current: number) =>
    reference > 0 ? Math.max(0, ((reference - current) / reference) * 100) : 0;

  const dailyDd = drawdownPct(dayStart, equity);
  const totalDd = drawdownPct(peak, equity);
  const dailyHeadroom = Math.max(0, config.maxDailyDrawdownPct - dailyDd);
  const totalHeadroom = Math.max(0, config.maxTotalDrawdownPct - totalDd);
  const requestedRisk = state.requestedRiskPct ?? config.riskPerTradePct;
  const requestedVolume = state.volume ?? 0.01;
  const base = {
    daily_drawdown_pct: round(dailyDd, 4),
    total_drawdown_pct: round(totalDd, 4),
    daily_limit_pct: config.maxDailyDrawdownPct,
    total_limit_pct: config.maxTotalDrawdownPct,
    daily_headroom_pct: round(dailyHeadroom, 4),
    total_headroom_pct: round(totalHeadroom, 4),
    requested_risk_pct: round(requestedRisk, 4),
    requested_volume: round(requestedVolume, 6),
  };

  if (totalDd >= config.maxTotalDrawdownPct) {
    return {
      ...base,
      allowed: false,
      code: "total_drawdown_breach",
      action: "liquidate",
      reason: `Total drawdown ${totalDd.toFixed(2)}% has reached the ${config.maxTotalDrawdownPct.toFixed(2)}% hard cap. Trading is halted.`,
      approved_risk_pct: 0,
      adjusted_volume: 0,
      breach: "total",
    };
  }
  if (dailyDd >= config.maxDailyDrawdownPct) {
    return {
      ...base,
      allowed: false,
      code: "daily_drawdown_breach",
      action: "block",
      reason: `Daily drawdown ${dailyDd.toFixed(2)}% has reached the ${config.maxDailyDrawdownPct.toFixed(2)}% hard cap. No new entries until the next trading day.`,
      approved_risk_pct: 0,
      adjusted_volume: 0,
      breach: "daily",
    };
  }
  const safeRisk = Math.min(dailyHeadroom, totalHeadroom);
  let approvedRisk = requestedRisk;
  let action: RiskDecision["action"] = "allow";
  let code = "ok";
  let reason = "Inside the prop-firm envelope.";
  if (requestedRisk > safeRisk) {
    approvedRisk = Math.max(0, safeRisk * 0.8);
    action = "reduce";
    code = "risk_reduced";
    reason = `Requested ${requestedRisk.toFixed(2)}% risk exceeds the remaining ${safeRisk.toFixed(2)}% headroom; size reduced to ${approvedRisk.toFixed(2)}%.`;
  }
  if ((state.openPositions ?? 0) >= config.maxConcurrentTrades) {
    return {
      ...base,
      allowed: false,
      code: "max_concurrent_trades",
      action: "block",
      reason: `${state.openPositions} positions are already open and the limit is ${config.maxConcurrentTrades}.`,
      approved_risk_pct: 0,
      adjusted_volume: 0,
      breach: "concurrency",
    };
  }
  const scale = requestedRisk > 0 ? approvedRisk / requestedRisk : 1;
  if (approvedRisk <= 0.0001) {
    return {
      ...base,
      allowed: false,
      code: "no_risk_headroom",
      action: "block",
      reason: "No drawdown headroom left for a new position.",
      approved_risk_pct: 0,
      adjusted_volume: 0,
      breach: "headroom",
    };
  }
  return {
    ...base,
    allowed: true,
    code,
    action,
    reason,
    approved_risk_pct: round(approvedRisk, 4),
    adjusted_volume: round(requestedVolume * scale, 6),
    breach: null,
  };
}
