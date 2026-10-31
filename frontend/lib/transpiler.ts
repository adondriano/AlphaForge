/**
 * No-LLM heuristic transpiler — TypeScript twin of `backend/services/llm.py`.
 *
 * Used when the Python engine is unreachable or when the creator modal is in
 * explicit No-LLM mode. It only claims to understand patterns the engine can
 * actually execute as primitives.
 */

import type { Rule, SourceType, StrategyRules } from "./types";

export const DEFAULT_PARAMETERS: Record<string, number> = {
  fast_ema: 12,
  slow_ema: 26,
  rsi_period: 14,
  rsi_lower: 32,
  rsi_upper: 68,
  atr_period: 14,
  atr_sl_mult: 2,
  rr_ratio: 2,
  breakout_lookback: 20,
  risk_per_trade_pct: 0.5,
  trend_filter_enabled: 1,
  min_signal_strength: 1,
};

const SYMBOL_HINTS: [RegExp, string][] = [
  [/(\bxauusd\b|\bgold\b|\bxau\/usd\b)/i, "XAUUSD"],
  [/(\beurusd\b|\beur\/usd\b|\beuro\b)/i, "EURUSD"],
  [/(\bgbpusd\b|\bgbp\/usd\b|\bcable\b)/i, "GBPUSD"],
  [/(\busdjpy\b|\busd\/jpy\b)/i, "USDJPY"],
  [/(\bus30\b|\bdow\b|\bdji\b)/i, "US30Cash"],
  [/(\bnasdaq\b|\bnas100\b|\bndx\b|\bus100\b)/i, "NAS100"],
  [/(\bbtc\b|\bbitcoin\b|\bbtcusd\b)/i, "BTCUSD"],
];

const TIMEFRAME_HINTS: [RegExp, string][] = [
  [/\b(m1|1\s*min(ute)?)\b/i, "M1"],
  [/\b(m5|5\s*min(ute)?)\b/i, "M5"],
  [/\b(m15|15\s*min(ute)?|15m)\b/i, "M15"],
  [/\b(m30|30\s*min(ute)?|30m)\b/i, "M30"],
  [/\b(h1|1\s*hour|hourly|1h)\b/i, "H1"],
  [/\b(h4|4\s*hour|4h)\b/i, "H4"],
  [/\b(d1|daily|1d)\b/i, "D1"],
  [/\b(weekly|w1)\b/i, "W1"],
];

const SESSION_HINTS: [RegExp, string][] = [
  [/\blondon[ /&-]*new ?york\b|\bldn[/-]?ny\b/i, "london_ny"],
  [/\blondon\b/i, "london"],
  [/\b(new ?york|ny\s*(session|open|kill ?zone))\b/i, "new_york"],
  [/\b(asian?|tokyo|sydney)\b/i, "asia"],
];

const SESSION_LABELS: Record<string, string> = {
  london: "London",
  new_york: "New York",
  london_ny: "London-NY",
  asia: "Asia",
  all_day: "Swing",
};

function firstMatch(patterns: [RegExp, string][], text: string, fallback: string): string {
  for (const [pattern, value] of patterns) {
    if (pattern.test(text)) return value;
  }
  return fallback;
}

function cleanForNumbers(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:m|h|d|w)\d+\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*%/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*r\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");
}

const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

function emaPeriods(text: string): number[] {
  const found: number[] = [];
  const patterns = [
    /(\d+)\s*[/&,-]\s*(\d+)\s*(?:ema|sma|ma|moving average)/gi,
    /(?:ema|sma|ma|moving average)s?\s*(\d+)\s*(?:[/&,]|and)?\s*(\d+)?/gi,
    /(\d+)\s*(?:ema|sma|ma|moving average)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      for (const group of match.slice(1)) {
        if (!group) continue;
        const value = Number(group);
        if (Number.isFinite(value) && inRange(value, 2, 400)) found.push(value);
      }
    }
    if (found.length >= 2) break;
  }
  return [...new Set(found)].sort((a, b) => a - b).slice(0, 2);
}

function rsiInfo(text: string) {
  let period = 14;
  let match = /rsi\s*(?:period\s*)?(\d{1,3})/i.exec(text);
  if (!match) match = /(\d{1,3})\s*(?:period\s*)?rsi/i.exec(text);
  if (match) {
    const candidate = Number(match[1]);
    if (inRange(candidate, 2, 50)) period = candidate;
  }
  let lower = 30;
  let upper = 70;
  const oversold = /(?:below|under|beneath|<|oversold)\s*(\d{1,2})\b/i.exec(text);
  const overbought = /(?:above|over|>|overbought)\s*(\d{1,2})\b/i.exec(text);
  if (oversold && overbought) {
    const lo = Number(oversold[1]);
    const hi = Number(overbought[1]);
    if (lo < hi && inRange(lo, 5, 45) && inRange(hi, 55, 95)) {
      lower = lo;
      upper = hi;
    }
  }
  return { period, lower, upper };
}

function atrInfo(text: string) {
  let period = 14;
  let mult = 2;
  const multMatch = /(\d+(?:\.\d+)?)\s*(?:x|×|times)?\s*atr/i.exec(text);
  if (multMatch) {
    const candidate = Number(multMatch[1]);
    if (inRange(candidate, 0.5, 8)) mult = candidate;
  }
  const periodMatch = /atr\s*(\d{1,3})/i.exec(text);
  if (periodMatch) {
    const candidate = Number(periodMatch[1]);
    if (inRange(candidate, 2, 50)) period = candidate;
  }
  return { period, mult };
}

function breakoutLookback(text: string): number {
  let match = /(\d{1,3})\s*(?:bar|candle|period)?\s*(?:high|low|breakout|donchian)/i.exec(text);
  if (!match) match = /(?:breakout|donchian)\s*(?:of|at|on|over)?\s*(\d{1,3})/i.exec(text);
  if (match) {
    const candidate = Number(match[1]);
    if (inRange(candidate, 3, 200)) return candidate;
  }
  return 20;
}

function riskPerTrade(text: string): number {
  const match = /risk\D{0,16}?(\d+(?:\.\d+)?)\s*%/i.exec(text);
  if (match) return Math.max(0.05, Math.min(5, Number(match[1])));
  return 0.5;
}

function targetRr(text: string): number {
  let match = /(\d+(?:\.\d+)?)\s*r\s*(?:target|tp|multiple)?\b/i.exec(text);
  if (!match) match = /(?:target|tp)\s*(?:of|at)?\s*(\d+(?:\.\d+)?)\s*r\b/i.exec(text);
  if (match) {
    const candidate = Number(match[1]);
    if (inRange(candidate, 0.5, 10)) return candidate;
  }
  return 0;
}

export function detectSourceType(url: string): SourceType {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/facebook\.com|fb\.watch/i.test(url)) return "youtube";
  return "text";
}

export function composeName(
  symbol: string,
  timeframe: string,
  entries: Rule[],
  session: string,
  params: Record<string, number>,
): string {
  const prefix = SESSION_LABELS[session] ?? "Swing";
  const indicators = new Set(entries.map((e) => e.indicator));
  let pattern = "Price Action";
  if (indicators.has("donchian_breakout")) pattern = `Breakout ${Math.round(params.breakout_lookback ?? 20)}`;
  else if (indicators.has("bollinger_reversion")) pattern = "Bollinger Reversion";
  else if (indicators.has("macd")) pattern = "MACD Momentum";
  else if (indicators.has("rsi") && !indicators.has("ema_cross"))
    pattern = `RSI ${Math.round(params.rsi_period ?? 14)} Reversion`;
  else if (indicators.has("ema_cross") || indicators.has("ema_stack"))
    pattern = `EMA ${Math.round(params.fast_ema ?? 12)}/${Math.round(params.slow_ema ?? 26)}`;
  return `${prefix} ${pattern} — ${symbol} ${timeframe}`;
}

export interface TranspileResult {
  name: string;
  symbol: string;
  timeframe: string;
  description: string;
  source_type: SourceType;
  source_url: string;
  side: "long" | "short" | "both";
  rules: StrategyRules;
  parameters: Record<string, number>;
  risk_profile: {
    risk_per_trade_pct: number;
    rr_ratio: number;
    max_daily_drawdown_pct: number;
    max_total_drawdown_pct: number;
    max_concurrent_trades: number;
    session: string;
  };
}

export function heuristicTranspile(text: string, sourceUrl = ""): TranspileResult {
  const blob = `${text} ${sourceUrl}`.trim();
  const lowered = blob.toLowerCase();
  const symbol = firstMatch(SYMBOL_HINTS, lowered, "XAUUSD");
  const timeframe = firstMatch(TIMEFRAME_HINTS, lowered, "H1");
  const session = firstMatch(SESSION_HINTS, lowered, "all_day");
  const numericText = cleanForNumbers(blob);
  const riskPct = riskPerTrade(blob);

  const params: Record<string, number> = { ...DEFAULT_PARAMETERS };
  params.risk_per_trade_pct = riskPct;

  const entries: Rule[] = [];
  const filters: Rule[] = [];

  const emaNumbers = emaPeriods(numericText);
  if (emaNumbers.length >= 2) {
    params.fast_ema = emaNumbers[0];
    params.slow_ema = emaNumbers[1];
  } else if (emaNumbers.length === 1) {
    const only = emaNumbers[0];
    if (only >= 50) {
      params.fast_ema = Math.max(5, Math.round(only / 4));
      params.slow_ema = only;
    } else {
      params.fast_ema = only;
      params.slow_ema = Math.max(only * 2, 26);
    }
  }
  if (/\b(ema|sma|ma\b|moving average|cross ?over|golden cross|death cross)\b/i.test(lowered)) {
    entries.push({
      indicator: "ema_cross",
      params: { fast: params.fast_ema, slow: params.slow_ema },
      direction: "both",
      note: "Heuristic: moving-average crossover detected in the source text.",
    });
  }

  if (/\brsi\b/i.test(lowered)) {
    const info = rsiInfo(numericText);
    params.rsi_period = info.period;
    params.rsi_lower = info.lower;
    params.rsi_upper = info.upper;
    filters.push({
      indicator: "rsi",
      params: { period: info.period, lower: info.lower, upper: info.upper },
      note: "Heuristic: RSI thresholds parsed from the source text.",
    });
  }

  if (/(breakout|break out|donchian|\d+\s*(bar|candle)?\s*(high|low))/i.test(lowered)) {
    const lookback = breakoutLookback(numericText);
    params.breakout_lookback = lookback;
    entries.push({
      indicator: "donchian_breakout",
      params: { lookback },
      direction: "both",
      note: "Heuristic: breakout language detected in the source text.",
    });
  }

  if (/\bmacd\b/i.test(lowered)) entries.push({ indicator: "macd", params: {}, direction: "both" });
  if (/\b(bollinger|bbands)\b/i.test(lowered))
    entries.push({ indicator: "bollinger_reversion", params: {}, direction: "both" });
  if (/\bvwap\b/i.test(lowered)) filters.push({ indicator: "vwap", params: {} });

  const atrData = atrInfo(numericText);
  if (/\b(atr|average true range)\b/i.test(lowered)) {
    params.atr_period = atrData.period;
    params.atr_sl_mult = atrData.mult;
  }

  if (!entries.length) {
    entries.push({
      indicator: "ema_cross",
      params: { fast: params.fast_ema, slow: params.slow_ema },
      direction: "both",
      note: "Heuristic default: no recognised entry pattern — EMA cross assumed.",
    });
  }

  let rr = 2;
  const rrMatch = /(?:rr|r:r|risk[ /:-]*reward|reward[ /:-]*risk)\D{0,6}?(\d+(?:\.\d+)?)\s*[:\-x]?\s*(\d+(?:\.\d+)?)?/i.exec(lowered);
  if (rrMatch) {
    const first = Number(rrMatch[1]);
    const second = rrMatch[2] ? Number(rrMatch[2]) : first;
    rr = Math.max(0.5, Math.min(10, first ? second / first : second));
  } else {
    const ratioMatch = /\b(\d+(?:\.\d+)?)\s*[:\-]\s*(\d+(?:\.\d+)?)\b/.exec(lowered);
    if (ratioMatch) {
      const first = Number(ratioMatch[1]);
      const second = Number(ratioMatch[2]);
      const window = lowered
        .slice(Math.max(0, ratioMatch.index - 40), ratioMatch.index + ratioMatch[0].length + 40)
        .toLowerCase();
      const rewardFirst = window.includes("reward") && window.indexOf("reward") < (window.includes("risk") ? window.indexOf("risk") : Infinity);
      if (rewardFirst && first > 0) rr = first / second;
      else if (0 < first && first < second && second <= 20) rr = second / first;
    } else {
      rr = targetRr(blob) || 2;
    }
  }
  params.rr_ratio = rr;
  params.atr_sl_mult = Math.min(params.atr_sl_mult, 6);

  let side: "long" | "short" | "both" = "both";
  if (/\b(only long|longs? only|buy only|bullish only)\b/i.test(lowered)) side = "long";
  else if (/\b(only short|shorts? only|sell only|bearish only)\b/i.test(lowered)) side = "short";

  const description = text.trim().length > 480 ? `${text.trim().slice(0, 477)}...` : text.trim();

  return {
    name: composeName(symbol, timeframe, entries, session, params),
    symbol,
    timeframe,
    description,
    source_type: detectSourceType(sourceUrl),
    source_url: sourceUrl,
    side,
    rules: {
      side,
      entries,
      exits: [
        {
          indicator: "atr",
          params: { mult: params.atr_sl_mult, rr },
          direction: "both",
          note: "ATR stop with an R-multiple target.",
        },
      ],
      filters,
    },
    parameters: params,
    risk_profile: {
      risk_per_trade_pct: params.risk_per_trade_pct,
      rr_ratio: rr,
      max_daily_drawdown_pct: 3.5,
      max_total_drawdown_pct: 5,
      max_concurrent_trades: 2,
      session,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* JSON spec validation (mirrors services/validator.py)                       */
/* -------------------------------------------------------------------------- */

export const VALID_INDICATORS = [
  "ema_cross",
  "ema_stack",
  "rsi",
  "macd",
  "atr",
  "donchian_breakout",
  "bollinger_reversion",
  "vwap",
  "price_action",
];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  spec?: TranspileResult;
}

function normalizeRules(value: unknown): Rule[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) =>
    typeof item === "string"
      ? { indicator: item.toLowerCase().replace(/-/g, "_").split(/\s+/)[0] }
      : (item as Rule),
  );
}

export function validateSpecJson(raw: string): ValidationResult {
  const warnings: string[] = [];
  if (!raw || !raw.trim()) {
    return { ok: false, errors: ["Nothing to validate — paste a JSON spec first."], warnings };
  }
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  }
  text = text.replace(/[“”]/g, '"').replace(/[’]/g, "'");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`Invalid JSON: ${message}`], warnings };
  }
  if (typeof payload !== "object" || Array.isArray(payload) || payload === null) {
    return { ok: false, errors: ["Top level value must be a JSON object."], warnings };
  }

  const aliases: Record<string, string> = {
    strategy_name: "name",
    title: "name",
    ticker: "symbol",
    pair: "symbol",
    tf: "timeframe",
    interval: "timeframe",
    entry_rules: "entries",
    exit_rules: "exits",
    entry: "entries",
    exit: "exits",
    params: "parameters",
    risk_profile: "risk",
    url: "source_url",
  };
  for (const [oldKey, newKey] of Object.entries(aliases)) {
    if (oldKey in payload && !(newKey in payload)) {
      payload[newKey] = payload[oldKey];
      delete payload[oldKey];
    }
  }

  const errors: string[] = [];
  const symbol = String(payload.symbol ?? "XAUUSD").toUpperCase();
  const timeframe = String(payload.timeframe ?? "H1").toUpperCase();
  if (!["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"].includes(timeframe)) {
    errors.push(`timeframe: must be one of M1, M5, M15, M30, H1, H4, D1, W1 (got "${timeframe}")`);
  }
  const side = String(payload.side ?? "both").toLowerCase();
  if (!["long", "short", "both"].includes(side)) {
    errors.push(`side: must be long, short or both (got "${side}")`);
  }

  const entries = normalizeRules(payload.entries);
  const exits = normalizeRules(payload.exits);
  const filters = normalizeRules(payload.filters ?? []);

  for (const [group, list] of [
    ["entries", entries],
    ["exits", exits],
    ["filters", filters],
  ] as const) {
    list.forEach((rule, index) => {
      const indicator = String(rule?.indicator ?? "").toLowerCase();
      if (!VALID_INDICATORS.includes(indicator)) {
        errors.push(`${group}[${index}].indicator: unknown indicator "${rule?.indicator}". Valid: ${VALID_INDICATORS.join(", ")}`);
      }
    });
  }

  const rawParams = (payload.parameters ?? {}) as Record<string, unknown>;
  if (typeof rawParams !== "object" || Array.isArray(rawParams)) {
    errors.push("parameters: must be an object of numbers.");
  }
  const parameters: Record<string, number> = { ...DEFAULT_PARAMETERS };
  for (const [key, value] of Object.entries(rawParams ?? {})) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) parameters[key] = numeric;
    else warnings.push(`Ignored non-numeric parameter "${key}".`);
  }

  if (!entries.length) {
    warnings.push("No entry rules supplied — default EMA cross entry applied.");
    entries.push({ indicator: "ema_cross", params: { fast: 12, slow: 26 }, direction: "both" });
  }
  if (!exits.length) {
    warnings.push("No exit rules supplied — default ATR stop / R-multiple target applied.");
  }

  if (errors.length) return { ok: false, errors, warnings };

  const riskInput = (payload.risk ?? {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const finalExits = exits.length
    ? exits
    : [{ indicator: "atr", params: { mult: 2, rr: 2 }, direction: "both" as const }];

  return {
    ok: true,
    errors,
    warnings,
    spec: {
      name: String(payload.name ?? "Manual JSON Strategy").slice(0, 120),
      symbol,
      timeframe,
      description: String(payload.description ?? "").slice(0, 480),
      source_type: "json",
      source_url: String(payload.source_url ?? ""),
      side: side as "long" | "short" | "both",
      rules: {
        side: side as "long" | "short" | "both",
        entries,
        exits: finalExits,
        filters,
      },
      parameters,
      risk_profile: {
        risk_per_trade_pct: num(riskInput.risk_per_trade_pct, parameters.risk_per_trade_pct),
        rr_ratio: num(riskInput.rr_ratio, parameters.rr_ratio),
        max_daily_drawdown_pct: num(riskInput.max_daily_drawdown_pct, 3.5),
        max_total_drawdown_pct: num(riskInput.max_total_drawdown_pct, 5),
        max_concurrent_trades: num(riskInput.max_concurrent_trades, 2),
        session: String(riskInput.session ?? "all_day"),
      },
    },
  };
}

export const SAMPLE_SPEC = {
  name: "London Breakout — XAUUSD",
  symbol: "XAUUSD",
  timeframe: "H1",
  description: "Buys Donchian breakouts during the London session with an ATR stop.",
  side: "both",
  entries: [
    { indicator: "donchian_breakout", params: { lookback: 20 }, direction: "both" },
    { indicator: "ema_cross", params: { fast: 12, slow: 26 }, direction: "both" },
  ],
  exits: [{ indicator: "atr", params: { mult: 2, rr: 2.5 }, direction: "both" }],
  filters: [{ indicator: "rsi", params: { period: 14, lower: 25, upper: 75 } }],
  parameters: {
    fast_ema: 12,
    slow_ema: 26,
    rsi_period: 14,
    rsi_lower: 25,
    rsi_upper: 75,
    atr_period: 14,
    atr_sl_mult: 2,
    rr_ratio: 2.5,
    breakout_lookback: 20,
    risk_per_trade_pct: 0.5,
  },
  risk: {
    risk_per_trade_pct: 0.5,
    rr_ratio: 2.5,
    max_daily_drawdown_pct: 3.5,
    max_total_drawdown_pct: 5,
    max_concurrent_trades: 2,
    session: "london_ny",
  },
};

export const PROMPT_TEMPLATE = `You are AlphaForge's strategy compiler. Convert the description below into a
strict JSON strategy specification. Reply with JSON only.

REQUIRED SCHEMA
{
  "name": "string",
  "symbol": "XAUUSD",
  "timeframe": "H1",
  "description": "string",
  "side": "both",
  "entries": [
    {"indicator": "ema_cross", "params": {"fast": 12, "slow": 26}, "direction": "both", "note": ""}
  ],
  "exits": [
    {"indicator": "atr", "params": {"mult": 2.0, "rr": 2.5}, "direction": "both"}
  ],
  "filters": [
    {"indicator": "rsi", "params": {"period": 14, "lower": 25, "upper": 75}}
  ],
  "parameters": {
    "fast_ema": 12, "slow_ema": 26, "rsi_period": 14, "rsi_lower": 25, "rsi_upper": 75,
    "atr_period": 14, "atr_sl_mult": 2.0, "rr_ratio": 2.5, "breakout_lookback": 20,
    "risk_per_trade_pct": 0.5
  },
  "risk": {
    "risk_per_trade_pct": 0.5, "rr_ratio": 2.5, "max_daily_drawdown_pct": 3.5,
    "max_total_drawdown_pct": 5.0, "max_concurrent_trades": 2, "session": "london_ny"
  }
}

ALLOWED INDICATORS
ema_cross, ema_stack, rsi, macd, atr, donchian_breakout, bollinger_reversion, vwap, price_action

ALLOWED TIMEFRAMES
M1, M5, M15, M30, H1, H4, D1, W1

STRATEGY DESCRIPTION
"""
<<< PASTE YOUR STRATEGY, VIDEO TRANSCRIPT OR VIDEO TITLE HERE >>>
"""`;
