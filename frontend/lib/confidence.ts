/**
 * Rule-based confidence scoring.
 *
 * WHAT THIS IS: a transparent weighted sum over five factors that are all
 * genuinely computed from OHLC history. Every weight is visible and tunable,
 * and every factor reports the reasoning behind its score so an alert payload
 * can carry the whole breakdown.
 *
 * WHAT THIS IS NOT: a model. Nothing here was fit to data, there are no
 * coefficients learned from outcomes, and a score of 87 does not mean "87%
 * chance of profit". It means "these five things line up right now". Alerting
 * on it is a filter for attention, not a prediction.
 *
 * The brief asked for an orderbook-imbalance factor. There is none, because
 * the connected broker exposes no depth data — ticks carry bid, ask and a
 * timestamp and nothing else. Rather than invent a proxy and name it after
 * data we do not have, the factor was dropped and the weights redistributed.
 */

import { atr, ema, rsi } from "@/lib/engine";
import type { Bar } from "@/lib/engine";
import { macd } from "@/lib/indicators";

export type Direction = "buy" | "sell";

export interface ConfidenceFactor {
  id: string;
  label: string;
  /** 0..100. How strongly this factor supports the direction. */
  score: number;
  /** Share of the total. Weights across factors sum to 1. */
  weight: number;
  /** Plain-language reason, shown in the UI and sent in the alert. */
  detail: string;
}

export interface ConfidenceResult {
  /** 0..100 weighted total. */
  total: number;
  direction: Direction;
  factors: ConfidenceFactor[];
  /** Set when history is too short to compute a factor honestly. */
  incomplete: boolean;
  context: {
    atr: number | null;
    close: number | null;
  };
}

export interface ConfidenceWeights {
  trend: number;
  macd: number;
  rsi: number;
  candle: number;
  structure: number;
}

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  trend: 0.3,
  macd: 0.2,
  rsi: 0.15,
  candle: 0.15,
  structure: 0.2,
};

export const HEURISTIC_NOTICE =
  "Rule-based heuristic, not a trained model. A score is agreement between " +
  "indicators right now, not a probability of profit.";

/**
 * Direction of a higher timeframe, when one is available.
 * 1 bullish, -1 bearish, 0 flat/unknown.
 */
export type HigherTfBias = 1 | 0 | -1;

export interface ConfidenceInput {
  bars: Bar[];
  direction: Direction;
  weights?: Partial<ConfidenceWeights>;
  /** Higher-timeframe trend, if the caller fetched it. */
  higherTf?: HigherTfBias;
  /** RSI/MACD periods. Defaults match the XAUUSD desk. */
  params?: { rsiPeriod?: number; fast?: number; slow?: number; signal?: number };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const pct = (n: number) => clamp(n, 0, 100);

/** EMA fast/slow relationship plus slope, 0..100 for the given direction. */
function trendFactor(closes: number[], direction: Direction): { score: number; detail: string } {
  if (closes.length < 30) {
    return { score: 0, detail: "Not enough history for a trend read." };
  }
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const i = closes.length - 1;
  const above = fast[i] > slow[i];
  const aligned = (direction === "buy" && above) || (direction === "sell" && !above);

  // Slope over the last 10 bars, normalised by price so it is comparable
  // across instruments.
  const back = Math.max(0, i - 10);
  const slope = (fast[i] - fast[back]) / (slow[i] || 1);
  const slopePct = Math.abs(slope) * 100;
  const strength = pct(slopePct * 60); // ~1.7% drift over 10 bars reads as full strength

  const score = aligned ? pct(45 + strength * 0.55) : pct(strength * 0.4);
  return {
    score,
    detail: aligned
      ? `EMA 12 ${above ? "above" : "below"} EMA 26, aligned with the ${direction}. Slope ${slope >= 0 ? "+" : ""}${slopePct.toFixed(2)}% over 10 bars.`
      : `EMA 12 is ${above ? "above" : "below"} EMA 26, against the ${direction}.`,
  };
}

function macdFactor(
  closes: number[],
  direction: Direction,
  params: { fast?: number; slow?: number; signal?: number },
): { score: number; detail: string } {
  const fast = params.fast ?? 12;
  const slow = params.slow ?? 26;
  const signal = params.signal ?? 9;
  const series = macd(closes, fast, slow, signal);
  const hist = series.histogram;
  if (!hist.length) return { score: 0, detail: "MACD unavailable at this history length." };

  const last = hist[hist.length - 1];
  const aligned = (direction === "buy" && last > 0) || (direction === "sell" && last < 0);

  // Recency: how many bars since the histogram flipped sign. A cross three
  // bars ago is more actionable than one thirty bars ago.
  let sinceCross = 0;
  for (let i = hist.length - 1; i > 0; i -= 1) {
    if (Math.sign(hist[i]) !== Math.sign(last)) break;
    sinceCross += 1;
  }
  const freshness = pct(100 - sinceCross * 8);
  const score = aligned ? pct(50 + freshness * 0.5) : pct(100 - freshness) * 0.35;
  return {
    score,
    detail: aligned
      ? `MACD histogram ${last > 0 ? "positive" : "negative"}, ${sinceCross} bar${sinceCross === 1 ? "" : "s"} since the cross.`
      : `MACD histogram is opposed to the ${direction}.`,
  };
}

function rsiFactor(
  closes: number[],
  direction: Direction,
  period: number,
): { score: number; detail: string } {
  const values = rsi(closes, period);
  if (!values.length) return { score: 0, detail: "RSI unavailable at this history length." };
  const last = values[values.length - 1];

  let score: number;
  let why: string;
  if (direction === "buy") {
    // Buying into oversold is the classic read; buying above 70 is chasing.
    if (last <= 35) {
      score = 100;
      why = `RSI ${last.toFixed(1)} is oversold.`;
    } else if (last <= 55) {
      score = pct(60 + (55 - last) * 2);
      why = `RSI ${last.toFixed(1)} is neutral-to-soft, room to run.`;
    } else if (last <= 70) {
      score = pct(Math.max(20, (70 - last) * 3));
      why = `RSI ${last.toFixed(1)} is getting extended for a long.`;
    } else {
      score = 10;
      why = `RSI ${last.toFixed(1)} is overbought — a long here is chasing.`;
    }
  } else {
    if (last >= 65) {
      score = 100;
      why = `RSI ${last.toFixed(1)} is overbought.`;
    } else if (last >= 45) {
      score = pct(60 + (last - 45) * 2);
      why = `RSI ${last.toFixed(1)} is neutral-to-firm, room to fall.`;
    } else if (last >= 30) {
      score = pct(Math.max(20, (last - 30) * 3));
      why = `RSI ${last.toFixed(1)} is getting washed out for a short.`;
    } else {
      score = 10;
      why = `RSI ${last.toFixed(1)} is oversold — a short here is chasing.`;
    }
  }
  return { score, detail: why };
}

/** Body-to-range ratio and where the bar closed inside its own range. */
function candleFactor(bars: Bar[], direction: Direction): { score: number; detail: string } {
  if (bars.length < 2) return { score: 0, detail: "No closed bar to read." };
  const bar = bars[bars.length - 1];
  const range = bar.h - bar.l;
  if (range <= 0) return { score: 0, detail: "The last bar has no range." };

  const body = Math.abs(bar.c - bar.o) / range;
  const closePos = (bar.c - bar.l) / range; // 0 = closed at the low, 1 = at the high
  const bullishBar = bar.c >= bar.o;
  const aligned = (direction === "buy" && bullishBar) || (direction === "sell" && !bullishBar);

  const conviction = direction === "buy" ? closePos : 1 - closePos;
  let score = pct(body * 45 + conviction * 55);
  if (!aligned) score = score * 0.5;

  return {
    score,
    detail:
      `${bullishBar ? "Bullish" : "Bearish"} bar, body ${(body * 100).toFixed(0)}% of range, ` +
      `closed ${(closePos * 100).toFixed(0)}% up the range${aligned ? "" : " — against the direction"}.`,
  };
}

/**
 * Distance from the last swing, in ATRs. A long right at a swing low is
 * supported by structure; one that has already run four ATRs is late.
 */
function structureFactor(
  bars: Bar[],
  direction: Direction,
): { score: number; detail: string; atr: number | null } {
  const lookback = Math.min(bars.length, 60);
  if (lookback < 20) {
    return { score: 0, detail: "Not enough history to place a swing.", atr: null };
  }
  const window = bars.slice(-lookback);
  const atrs = atr(window, 14);
  const atrValue = atrs[atrs.length - 1];
  if (!atrValue || atrValue <= 0) {
    return { score: 0, detail: "ATR unavailable.", atr: null };
  }

  const highs = window.map((b) => b.h);
  const lows = window.map((b) => b.l);
  const swingHigh = Math.max(...highs);
  const swingLow = Math.min(...lows);
  const close = window[window.length - 1].c;

  const distLow = (close - swingLow) / atrValue;
  const distHigh = (swingHigh - close) / atrValue;

  let score: number;
  let why: string;
  if (direction === "buy") {
    // Near the swing low: bouncing off support. Far above it: chasing.
    score = pct(100 - distLow * 22);
    why = `${distLow.toFixed(1)} ATR above the swing low — ${
      distLow < 1 ? "right at support" : distLow < 3 ? "reasonable" : "extended"
    }.`;
  } else {
    score = pct(100 - distHigh * 22);
    why = `${distHigh.toFixed(1)} ATR below the swing high — ${
      distHigh < 1 ? "right at resistance" : distHigh < 3 ? "reasonable" : "extended"
    }.`;
  }
  return { score, detail: why, atr: atrValue };
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const { bars, direction, higherTf } = input;
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights || {}) };
  const params = input.params || {};
  const closes = bars.map((b) => b.c);

  const trend = trendFactor(closes, direction);
  const macd_ = macdFactor(closes, direction, params);
  const rsi_ = rsiFactor(closes, direction, params.rsiPeriod ?? 14);
  const candle = candleFactor(bars, direction);
  const structure = structureFactor(bars, direction);

  // Multi-timeframe confluence: the higher timeframe agreeing is the single
  // strongest thing this score can know, so it is folded into the trend
  // factor rather than added as a sixth weight the user has to reason about.
  let trendScore = trend.score;
  let trendDetail = trend.detail;
  if (higherTf !== undefined && higherTf !== 0) {
    const agrees = (direction === "buy" && higherTf === 1) || (direction === "sell" && higherTf === -1);
    trendScore = agrees ? pct(trendScore + (100 - trendScore) * 0.4) : trendScore * 0.45;
    trendDetail += agrees
      ? ` Higher timeframe agrees.`
      : ` Higher timeframe is opposed — this is a counter-trend ${direction}.`;
  }

  const factors: ConfidenceFactor[] = [
    { id: "trend", label: "Trend alignment", score: trendScore, weight: weights.trend, detail: trendDetail },
    { id: "macd", label: "MACD agreement", score: macd_.score, weight: weights.macd, detail: macd_.detail },
    { id: "rsi", label: "RSI position", score: rsi_.score, weight: weights.rsi, detail: rsi_.detail },
    { id: "candle", label: "Candle structure", score: candle.score, weight: weights.candle, detail: candle.detail },
    { id: "structure", label: "S/R proximity", score: structure.score, weight: weights.structure, detail: structure.detail },
  ];

  const weightSum = factors.reduce((sum, f) => sum + f.weight, 0) || 1;
  const total = factors.reduce((sum, f) => sum + f.score * f.weight, 0) / weightSum;

  const incomplete = factors.some((f) => f.detail.includes("Not enough history") || f.detail.includes("unavailable"));

  return {
    total,
    direction,
    factors,
    incomplete,
    context: {
      atr: structure.atr,
      close: closes.length ? closes[closes.length - 1] : null,
    },
  };
}

/**
 * Stop and targets derived from ATR, with the R:R that results.
 *
 * Two ATRs is a conventional stop for swing entries; tp1 at 1.5R and tp2 at
 * 3R give a first target that can move to break-even. These are starting
 * numbers, not an optimised exit rule.
 */
export function levelsFromAtr(
  direction: Direction,
  entry: number,
  atrValue: number | null,
): { entry: number; sl: number; tp1: number; tp2: number; rr: number } | null {
  if (!atrValue || atrValue <= 0 || !entry) return null;
  const risk = atrValue * 2;
  const sl = direction === "buy" ? entry - risk : entry + risk;
  const tp1 = direction === "buy" ? entry + risk * 1.5 : entry - risk * 1.5;
  const tp2 = direction === "buy" ? entry + risk * 3 : entry - risk * 3;
  return {
    entry: Number(entry.toFixed(5)),
    sl: Number(sl.toFixed(5)),
    tp1: Number(tp1.toFixed(5)),
    tp2: Number(tp2.toFixed(5)),
    rr: 1.5,
  };
}

/** The exact payload shape the alert dispatcher emits. */
export function buildAlertPayload(
  result: ConfidenceResult,
  symbol: string,
  levels: ReturnType<typeof levelsFromAtr>,
): Record<string, unknown> {
  const byId = Object.fromEntries(result.factors.map((f) => [f.id, f]));
  return {
    event: "ALPHA_FORGE_SIGNAL",
    symbol,
    direction: result.direction,
    confidence: Number(result.total.toFixed(1)),
    factors: {
      technical_ta: Number((byId.macd?.score ?? 0).toFixed(1)),
      rsi_position: Number((byId.rsi?.score ?? 0).toFixed(1)),
      trend_confluence: Number((byId.trend?.score ?? 0).toFixed(1)),
      candle_structure: Number((byId.candle?.score ?? 0).toFixed(1)),
      sr_proximity: Number((byId.structure?.score ?? 0).toFixed(1)),
    },
    levels: levels
      ? { entry: levels.entry, sl: levels.sl, tp1: levels.tp1, tp2: levels.tp2 }
      : null,
    timestamp: new Date().toISOString(),
  };
}
