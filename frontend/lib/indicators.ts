/**
 * Indicator maths and signal rules for the trading desk.
 *
 * Deliberately separate from lib/engine.ts: the engine's indicators feed
 * deterministic backtests, whereas these are recomputed on every tick with
 * user-editable parameters, so they must stay cheap and pure.
 *
 * Everything here is a pure function over a close series. No fetching, no
 * state, no randomness — the same closes and parameters always produce the
 * same signal, which is what makes an alert list trustworthy.
 */

import { ema, rsi } from "./engine";

export interface MacdSeries {
  macd: number[];
  signal: number[];
  /** macd - signal. Plotted as the histogram. */
  histogram: number[];
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdSeries {
  const fastPeriod = Math.max(1, Math.round(fast));
  const slowPeriod = Math.max(2, Math.round(slow));

  const fastLine = ema(values, fastPeriod);
  const slowLine = ema(values, slowPeriod);

  const macdLine: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    macdLine.push((fastLine[i] ?? 0) - (slowLine[i] ?? 0));
  }
  const signalLine = ema(macdLine, Math.max(1, Math.round(signalPeriod)));
  const histogram = macdLine.map((v, i) => v - (signalLine[i] ?? 0));
  return { macd: macdLine, signal: signalLine, histogram };
}

// ---------------------------------------------------------------------------
// rule sets
// ---------------------------------------------------------------------------

export type RuleSetId = "classic" | "trend";
export type Direction = "buy" | "sell";

export interface IndicatorParams {
  /** MACD fast EMA length. */
  macdFast: number;
  /** MACD slow EMA length. */
  macdSlow: number;
  /** MACD signal EMA length. */
  macdSignal: number;
  /** RSI look-back period. */
  rsiPeriod: number;
  /** RSI below this is oversold. */
  rsiOversold: number;
  /** RSI above this is overbought. */
  rsiOverbought: number;
}

export const DEFAULT_PARAMS: IndicatorParams = {
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
};

export const RULE_SETS: Record<
  RuleSetId,
  { id: RuleSetId; label: string; blurb: string }
> = {
  classic: {
    id: "classic",
    label: "MACD cross + RSI 30/70",
    blurb:
      "Buy when MACD crosses above its signal line while RSI is oversold. Sell on the mirror image. Fires early and often.",
  },
  trend: {
    id: "trend",
    label: "MACD zero-line + RSI 50",
    blurb:
      "Buy when MACD crosses above zero with RSI above 50. Trend-following: fewer signals, later entry.",
  },
};

export interface SignalEvent {
  id: string;
  direction: Direction;
  /** Epoch seconds of the candle that closed and confirmed the signal. */
  at: number;
  price: number;
  rule: RuleSetId;
  macd: number;
  signal: number;
  rsi: number;
}

export interface Reading {
  macd: number;
  signal: number;
  histogram: number;
  rsi: number;
  /** Which way the pair is leaning right now, regardless of a confirmed cross. */
  bias: Direction | "flat";
}

/**
 * Evaluate the closed bar at `index` against its predecessor.
 *
 * Only a *cross* fires, never a state, so a trend that stays bullish for many
 * bars alerts once instead of on every bar — the whole reason signals are
 * evaluated on closed candles.
 */
export function evaluateClosedBar(
  closes: number[],
  times: number[],
  params: IndicatorParams,
  rule: RuleSetId,
  index: number,
): SignalEvent | null {
  if (index < 1 || index >= closes.length) return null;

  const macdSeries = macd(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const rsiSeries = rsi(closes, params.rsiPeriod);

  const prevMacd = macdSeries.macd[index - 1];
  const nowMacd = macdSeries.macd[index];
  const prevSignal = macdSeries.signal[index - 1];
  const nowSignal = macdSeries.signal[index];
  const nowRsi = rsiSeries[index];
  if ([prevMacd, nowMacd, prevSignal, nowSignal, nowRsi].some((v) => v == null)) {
    return null;
  }

  let direction: Direction | null = null;

  if (rule === "classic") {
    const crossedUp = prevMacd <= prevSignal && nowMacd > nowSignal;
    const crossedDown = prevMacd >= prevSignal && nowMacd < nowSignal;
    if (crossedUp && nowRsi <= params.rsiOversold) direction = "buy";
    else if (crossedDown && nowRsi >= params.rsiOverbought) direction = "sell";
  } else {
    const crossedUp = prevMacd <= 0 && nowMacd > 0;
    const crossedDown = prevMacd >= 0 && nowMacd < 0;
    if (crossedUp && nowRsi > 50) direction = "buy";
    else if (crossedDown && nowRsi < 50) direction = "sell";
  }

  if (!direction) return null;

  return {
    id: `${times[index]}-${direction}-${rule}`,
    direction,
    at: times[index],
    price: closes[index],
    rule,
    macd: nowMacd,
    signal: nowSignal,
    rsi: nowRsi,
  };
}

/** The latest indicator values, for the live read-out. */
export function latestReading(
  closes: number[],
  params: IndicatorParams,
): Reading | null {
  if (closes.length === 0) return null;
  const macdSeries = macd(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const rsiSeries = rsi(closes, params.rsiPeriod);
  const i = closes.length - 1;
  const value = macdSeries.macd[i];
  const signal = macdSeries.signal[i];
  if (value == null || signal == null) return null;
  return {
    macd: value,
    signal,
    histogram: value - signal,
    rsi: rsiSeries[i] ?? 50,
    bias: value > signal ? "buy" : value < signal ? "sell" : "flat",
  };
}

/** How many bars an indicator needs before its output means anything. */
export function warmupBars(params: IndicatorParams): number {
  return Math.max(params.macdSlow + params.macdSignal, params.rsiPeriod) + 2;
}
