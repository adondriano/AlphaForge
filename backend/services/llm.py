"""LLM orchestration — OpenAI / Ollama / fully local heuristic transpiler.

The "No-LLM Mode" toggle in the Strategy Creator maps directly onto
:func:`transpile`: when ``no_llm`` is true, or when no provider is configured,
the deterministic heuristic transpiler below runs instead. It is deliberately
conservative — it only claims to understand patterns it can express as engine
primitives, and it always returns a spec the validator accepts.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from .validator import DEFAULT_PARAMETERS, SAMPLE_SPEC

# ---------------------------------------------------------------------------
# Heuristic (no-LLM) transpiler
# ---------------------------------------------------------------------------
SYMBOL_HINTS = [
    (r"\b(xauusd|gold|xau/usd)\b", "XAUUSD"),
    (r"\b(eurusd|eur/usd|euro)\b", "EURUSD"),
    (r"\b(gbpusd|gbp/usd|cable)\b", "GBPUSD"),
    (r"\b(usdjpy|usd/jpy)\b", "USDJPY"),
    (r"\b(us30|dow|dji|wall street)\b", "US30Cash"),
    (r"\b(nasdaq|nas100|ndx|us100|nas/usd)\b", "NAS100"),
    (r"\b(btc|bitcoin|btcusd)\b", "BTCUSD"),
]

TIMEFRAME_HINTS = [
    (r"\b(m1|1\s*min(ute)?)\b", "M1"),
    (r"\b(m5|5\s*min(ute)?)\b", "M5"),
    (r"\b(m15|15\s*min(ute)?|15m)\b", "M15"),
    (r"\b(m30|30\s*min(ute)?|30m)\b", "M30"),
    (r"\b(h1|1\s*hour|hourly|1h)\b", "H1"),
    (r"\b(h4|4\s*hour|4h)\b", "H4"),
    (r"\b(d1|daily|1d|end of day)\b", "D1"),
    (r"\b(weekly|w1)\b", "W1"),
]

SESSION_HINTS = [
    (r"\b(london\s*(session|open|kill ?zone)?)\b", "london"),
    (r"\b(new ?york|ny\s*(session|open|kill ?zone))\b", "new_york"),
    (r"\b(london[ /&-]*new ?york|ldn[/-]?ny)\b", "london_ny"),
    (r"\b(asian?|tokyo|sydney)\b", "asia"),
]

_NAME_STOPWORDS = {
    "strategy", "the", "a", "an", "using", "with", "on", "for", "and", "my",
    "how", "to", "trade", "trading", "tutorial", "video", "system", "setup",
}


def _first_match(patterns: List[Tuple[str, Any]], text: str, default: Any) -> Any:
    for pattern, value in patterns:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return value
    return default


def _clean_for_numbers(text: str) -> str:
    """Strip tokens that are never indicator parameters (timeframes, %, R)."""
    cleaned = re.sub(r"https?://\S+", " ", text)
    cleaned = re.sub(r"\b(?:m|h|d|w)\d+\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b\d+(?:\.\d+)?\s*%", " ", cleaned)
    cleaned = re.sub(r"\b\d+(?:\.\d+)?\s*r\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b\d{1,2}:\d{2}\b", " ", cleaned)  # clock times
    return cleaned


def _in_range(value: float, low: float, high: float) -> bool:
    return low <= value <= high


def _ema_periods(text: str) -> List[float]:
    """Find moving-average periods: "12/26 EMA", "EMA 50 and 200", "50 & 200 MA"."""
    found: List[float] = []
    patterns = [
        r"(\d+)\s*[/&,]\s*(\d+)\s*(?:ema|sma|ma|moving average)",
        r"(?:ema|sma|ma|moving average)s?\s*(\d+)\s*(?:[/&,]|and)?\s*(\d+)?",
        r"(\d+)\s*(?:ema|sma|ma|moving average)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            for group in match.groups():
                if group:
                    try:
                        value = float(group)
                    except ValueError:
                        continue
                    if _in_range(value, 2, 400):
                        found.append(value)
        if len(found) >= 2:
            break
    deduped: List[float] = []
    for value in found:
        if value not in deduped:
            deduped.append(value)
    return sorted(deduped)[:2]


def _rsi_info(text: str) -> Dict[str, float]:
    """Extract the RSI period and its oversold / overbought thresholds."""
    period = 14.0
    match = re.search(r"rsi\s*(?:period\s*)?(\d{1,3})", text, flags=re.IGNORECASE)
    if not match:
        match = re.search(r"(\d{1,3})\s*(?:period\s*)?rsi", text, flags=re.IGNORECASE)
    if match:
        try:
            candidate = float(match.group(1))
            if _in_range(candidate, 2, 50):
                period = candidate
        except ValueError:
            pass

    lower, upper = 30.0, 70.0
    oversold = re.search(r"(?:below|under|beneath|<|oversold)\s*(\d{1,2})\b", text, flags=re.IGNORECASE)
    overbought = re.search(r"(?:above|over|>|overbought)\s*(\d{1,2})\b", text, flags=re.IGNORECASE)
    if oversold and overbought:
        try:
            candidate_lower = float(oversold.group(1))
            candidate_upper = float(overbought.group(1))
            if candidate_lower < candidate_upper and _in_range(candidate_lower, 5, 45) \
                    and _in_range(candidate_upper, 55, 95):
                lower, upper = candidate_lower, candidate_upper
        except ValueError:
            pass
    return {"period": period, "lower": lower, "upper": upper}


def _atr_info(text: str) -> Dict[str, float]:
    """Extract the ATR period and stop-loss multiple ("2 ATR", "1.5x ATR")."""
    period, mult = 14.0, 2.0
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:x|×|times)?\s*atr", text, flags=re.IGNORECASE)
    if match:
        try:
            candidate = float(match.group(1))
            if _in_range(candidate, 0.5, 8):
                mult = candidate
        except ValueError:
            pass
    match = re.search(r"atr\s*(\d{1,3})", text, flags=re.IGNORECASE)
    if match:
        try:
            candidate = float(match.group(1))
            if _in_range(candidate, 2, 50):
                period = candidate
        except ValueError:
            pass
    return {"period": period, "mult": mult}


def _breakout_lookback(text: str) -> float:
    match = re.search(r"(\d{1,3})\s*(?:bar|candle|period)?\s*(?:high|low|breakout|donchian)",
                      text, flags=re.IGNORECASE)
    if not match:
        match = re.search(r"(?:breakout|donchian)\s*(?:of|at|on|over)?\s*(\d{1,3})",
                          text, flags=re.IGNORECASE)
    if match:
        try:
            candidate = float(match.group(1))
            if _in_range(candidate, 3, 200):
                return candidate
        except ValueError:
            pass
    return 20.0


def _target_rr(text: str) -> float:
    """Parse an explicit R-multiple target: "2.5R target", "target 3R"."""
    match = re.search(r"(\d+(?:\.\d+)?)\s*r\s*(?:target|tp|multiple)?\b",
                      text, flags=re.IGNORECASE)
    if not match:
        match = re.search(r"(?:target|tp)\s*(?:of|at)?\s*(\d+(?:\.\d+)?)\s*r\b",
                          text, flags=re.IGNORECASE)
    if match:
        try:
            candidate = float(match.group(1))
            if _in_range(candidate, 0.5, 10):
                return candidate
        except ValueError:
            pass
    return 0.0


def _risk_per_trade(text: str) -> float:
    match = re.search(r"risk\D{0,16}?(\d+(?:\.\d+)?)\s*%", text, flags=re.IGNORECASE)
    if match:
        try:
            return max(0.05, min(5.0, float(match.group(1))))
        except ValueError:
            pass
    return 0.5


SESSION_LABELS = {
    "london": "London",
    "new_york": "New York",
    "london_ny": "London-NY",
    "asia": "Asia",
    "all_day": "Swing",
}


def _compose_name(symbol: str, timeframe: str, entries: List[Dict[str, Any]],
                  session: str, params: Dict[str, float]) -> str:
    """Human readable name built from what the transpiler actually understood."""
    prefix = SESSION_LABELS.get(session, "Swing")
    indicators = {e.get("indicator") for e in entries}
    if "donchian_breakout" in indicators:
        pattern = f"Breakout {int(params.get('breakout_lookback', 20))}"
    elif "bollinger_reversion" in indicators:
        pattern = "Bollinger Reversion"
    elif "macd" in indicators:
        pattern = "MACD Momentum"
    elif "rsi" in indicators and "ema_cross" not in indicators:
        pattern = f"RSI {int(params.get('rsi_period', 14))} Reversion"
    elif "ema_cross" in indicators or "ema_stack" in indicators:
        pattern = f"EMA {int(params.get('fast_ema', 12))}/{int(params.get('slow_ema', 26))}"
    elif "rsi" in indicators:
        pattern = f"RSI {int(params.get('rsi_period', 14))}"
    else:
        pattern = "Price Action"
    return f"{prefix} {pattern} - {symbol} {timeframe}"


def heuristic_transpile(
    text: str,
    *,
    source_url: str = "",
    source_type: str = "text",
) -> Dict[str, Any]:
    """Turn prose / a video title / a transcript into a validated StrategySpec dict."""
    blob = f"{text} {source_url}".strip()
    lowered = blob.lower()

    symbol = _first_match(SYMBOL_HINTS, lowered, "XAUUSD")
    timeframe = _first_match(TIMEFRAME_HINTS, lowered, "H1")
    session = _first_match(SESSION_HINTS, lowered, "all_day")
    numeric_text = _clean_for_numbers(blob)
    risk_pct = _risk_per_trade(blob)

    entries: List[Dict[str, Any]] = []
    filters: List[Dict[str, Any]] = []
    params: Dict[str, float] = dict(DEFAULT_PARAMETERS)
    params["risk_per_trade_pct"] = risk_pct

    # --- moving averages ---------------------------------------------------
    ema_numbers = _ema_periods(numeric_text)
    if len(ema_numbers) >= 2:
        params["fast_ema"] = float(ema_numbers[0])
        params["slow_ema"] = float(ema_numbers[1])
    elif len(ema_numbers) == 1:
        only = float(ema_numbers[0])
        if only >= 50:  # "200 EMA trend filter" → the 200 is the slow average
            params["fast_ema"] = float(max(5, round(only / 4)))
            params["slow_ema"] = only
        else:
            params["fast_ema"] = only
            params["slow_ema"] = float(max(only * 2, 26))
    mentions_ma = bool(re.search(
        r"\b(ema|sma|ma\b|moving average|cross ?over|golden cross|death cross)\b",
        lowered))
    if mentions_ma:
        entries.append({
            "indicator": "ema_cross",
            "params": {"fast": params["fast_ema"], "slow": params["slow_ema"]},
            "direction": "both",
            "note": "Heuristic: moving-average crossover detected in the source text.",
        })

    # --- RSI ---------------------------------------------------------------
    if re.search(r"\brsi\b", lowered):
        info = _rsi_info(numeric_text)
        params.update({
            "rsi_period": info["period"],
            "rsi_lower": info["lower"],
            "rsi_upper": info["upper"],
        })
        filters.append({
            "indicator": "rsi",
            "params": {"period": info["period"], "lower": info["lower"], "upper": info["upper"]},
            "note": "Heuristic: RSI thresholds parsed from the source text.",
        })

    # --- breakout ----------------------------------------------------------
    if re.search(r"(breakout|break out|donchian|\d+\s*(bar|candle)?\s*(high|low))", lowered):
        lookback = _breakout_lookback(numeric_text)
        params["breakout_lookback"] = lookback
        entries.append({
            "indicator": "donchian_breakout",
            "params": {"lookback": lookback},
            "direction": "both",
            "note": "Heuristic: breakout language detected in the source text.",
        })

    if re.search(r"\bmacd\b", lowered):
        entries.append({"indicator": "macd", "params": {}, "direction": "both",
                        "note": "Heuristic: MACD mentioned."})
    if re.search(r"\b(bollinger|bbands|bollinger bands)\b", lowered):
        entries.append({"indicator": "bollinger_reversion", "params": {}, "direction": "both",
                        "note": "Heuristic: Bollinger bands mentioned."})
    if re.search(r"\bvwap\b", lowered):
        filters.append({"indicator": "vwap", "params": {}, "note": "Heuristic: VWAP mentioned."})

    atr_info = _atr_info(numeric_text)
    if re.search(r"\b(atr|average true range)\b", lowered):
        params["atr_period"] = atr_info["period"]
        params["atr_sl_mult"] = atr_info["mult"]

    if not entries:
        entries.append({
            "indicator": "ema_cross",
            "params": {"fast": params["fast_ema"], "slow": params["slow_ema"]},
            "direction": "both",
            "note": "Heuristic default: no recognised entry pattern — EMA cross assumed.",
        })

    # --- risk:reward -------------------------------------------------------
    rr = 2.0
    rr_match = re.search(
        r"(?:rr|r:r|risk[ /:-]*reward|reward[ /:-]*risk)\D{0,6}?(\d+(?:\.\d+)?)\s*[:\-x]?\s*(\d+(?:\.\d+)?)?",
        lowered)
    if rr_match:
        try:
            first = float(rr_match.group(1))
            second = float(rr_match.group(2)) if rr_match.group(2) else first
            rr = max(0.5, min(10.0, second / first if first else second))
        except (TypeError, ValueError, ZeroDivisionError):
            rr = 2.0
    else:
        ratio_match = re.search(r"\b(\d+(?:\.\d+)?)\s*[:\-]\s*(\d+(?:\.\d+)?)\b", lowered)
        if ratio_match:
            try:
                first = float(ratio_match.group(1))
                second = float(ratio_match.group(2))
                window = lowered[max(0, ratio_match.start() - 40):ratio_match.end() + 40]
                reward_first = window.find("reward") != -1 and (
                    window.find("reward") < window.find("risk") if "risk" in window else True)
                if reward_first and first > 0:
                    rr = first / second
                elif 0 < first < second <= 20:
                    rr = second / first
            except (TypeError, ValueError, ZeroDivisionError):
                pass
        else:
            rr = _target_rr(blob) or 2.0
    params["rr_ratio"] = float(rr)
    params["atr_sl_mult"] = min(params["atr_sl_mult"], 6.0)

    # --- direction ---------------------------------------------------------
    side = "both"
    if re.search(r"\b(only long|longs? only|buy only|bullish only)\b", lowered):
        side = "long"
    elif re.search(r"\b(only short|shorts? only|sell only|bearish only)\b", lowered):
        side = "short"

    description = (text or "").strip()
    if len(description) > 480:
        description = description[:477].rstrip() + "..."

    name = _compose_name(symbol, timeframe, entries, session, params)
    description = (text or "").strip()
    if len(description) > 480:
        description = description[:477].rstrip() + "..."

    return {
        "name": name[:120],
        "symbol": symbol,
        "timeframe": timeframe,
        "description": description,
        "source_type": source_type,
        "source_url": source_url or "",
        "side": side,
        "entries": entries,
        "exits": [{"indicator": "atr", "params": {"mult": params["atr_sl_mult"], "rr": rr},
                   "direction": "both", "note": "ATR stop with an R-multiple target."}],
        "filters": filters,
        "parameters": params,
        "risk": {
            "risk_per_trade_pct": params["risk_per_trade_pct"],
            "rr_ratio": rr,
            "max_daily_drawdown_pct": 3.5,
            "max_total_drawdown_pct": 5.0,
            "max_concurrent_trades": 2,
            "session": session,
        },
    }


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are AlphaForge's strategy compiler. Convert the user's trading idea,
video transcript or description into a strict JSON strategy specification.

Reply with JSON ONLY — no markdown, no commentary. Use exactly this schema:
{
  "name": string,
  "symbol": "XAUUSD"|"EURUSD"|"GBPUSD"|"USDJPY"|"US30Cash"|"NAS100"|"BTCUSD"|<uppercase ticker>,
  "timeframe": "M1"|"M5"|"M15"|"M30"|"H1"|"H4"|"D1"|"W1",
  "description": string (max 480 chars),
  "side": "long"|"short"|"both",
  "entries": [{"indicator": "ema_cross"|"ema_stack"|"rsi"|"macd"|"atr"|"donchian_breakout"|"bollinger_reversion"|"vwap"|"price_action", "params": {...}, "direction": "long"|"short"|"both", "note": string}],
  "exits": [same shape],
  "filters": [same shape],
  "parameters": {numeric knobs: fast_ema, slow_ema, rsi_period, rsi_lower, rsi_upper, atr_period, atr_sl_mult, rr_ratio, breakout_lookback, risk_per_trade_pct},
  "risk": {"risk_per_trade_pct": number, "rr_ratio": number, "max_daily_drawdown_pct": number, "max_total_drawdown_pct": number, "max_concurrent_trades": int, "session": "london_ny"|"london"|"new_york"|"asia"|"all_day"}
}
Rules:
- Only use indicators from the allowed list.
- Every numeric parameter must be inside a sane range (periods 2..400).
- If the source is ambiguous, pick conservative defaults and explain them in "note" fields.
"""


def _extract_json(raw: str) -> Optional[Dict[str, Any]]:
    """Pull the first JSON object out of an LLM reply (tolerates fences)."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    return None


def _call_openai(api_key: str, model: str, system: str, user: str, timeout: float = 45.0) -> Tuple[Optional[str], Optional[str]]:
    import httpx  # imported lazily so the minimal runtime stays tiny

    try:
        response = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model or "gpt-4o-mini",
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}],
                "temperature": 0.2,
                "response_format": {"type": "json_object"},
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
        return payload["choices"][0]["message"]["content"], None
    except Exception as exc:  # network, quota, auth — all degrade to fallback
        return None, str(exc)


def _call_ollama(base_url: str, model: str, system: str, user: str, timeout: float = 45.0) -> Tuple[Optional[str], Optional[str]]:
    import httpx

    try:
        response = httpx.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model or "llama3.1",
                "stream": False,
                "format": "json",
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}],
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
        content = (payload.get("message") or {}).get("content")
        return content, None
    except Exception as exc:
        return None, str(exc)


def transpile(
    text: str,
    *,
    source_url: str = "",
    source_type: str = "text",
    settings: Any = None,
    no_llm: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Return ``(spec_dict, meta)``. Never raises — falls back to the heuristic."""
    provider = "heuristic"
    model = None
    error = None

    if not no_llm and settings is not None:
        api_key = getattr(settings, "OPENAI_API_KEY", "") or ""
        ollama_url = getattr(settings, "ollama_reachable_url", "") or ""
        if api_key:
            provider = "openai"
            model = getattr(settings, "OPENAI_MODEL", "gpt-4o-mini")
            user_prompt = (
                f"Source URL: {source_url or 'n/a'}\n"
                f"Source type: {source_type}\n\n"
                f"--- BEGIN CONTENT ---\n{text[:12000]}\n--- END CONTENT ---"
            )
            content, error = _call_openai(api_key, model, SYSTEM_PROMPT, user_prompt)
            if content:
                parsed = _extract_json(content)
                if parsed:
                    parsed.setdefault("source_type", source_type)
                    parsed.setdefault("source_url", source_url or "")
                    return parsed, {"engine": "openai", "model": model, "error": None}
                error = "LLM returned no parseable JSON"
        elif ollama_url:
            provider = "ollama"
            model = getattr(settings, "OLLAMA_MODEL", "llama3.1")
            content, error = _call_ollama(ollama_url, model, SYSTEM_PROMPT, text[:12000])
            if content:
                parsed = _extract_json(content)
                if parsed:
                    parsed.setdefault("source_type", source_type)
                    parsed.setdefault("source_url", source_url or "")
                    return parsed, {"engine": "ollama", "model": model, "error": None}
                error = "Ollama returned no parseable JSON"

    spec = heuristic_transpile(text, source_url=source_url, source_type=source_type)
    return spec, {
        "engine": "heuristic",
        "model": None,
        "error": error,
        "requested_provider": provider,
        "note": ("No-LLM mode requested." if no_llm else
                 f"LLM unavailable ({error or 'no provider configured'}) — "
                 "local heuristic transpiler used."),
    }


ANALYST_SYSTEM_PROMPT = """You are AlphaForge's senior quant analyst. You receive deterministic
statistics from a backtest plus a list of rule-based findings. Write a concise,
blunt review for a trader risking prop-firm capital.

Reply with JSON ONLY using this schema:
{
  "headline": string (max 140 chars),
  "narrative": string (2-4 short paragraphs, max 900 chars),
  "verdict": "healthy"|"watch"|"degraded"|"critical",
  "risks": [string],
  "actions": [string],
  "confidence": number (0-1)
}
Be specific and numeric. No hedging, no flattery, no markdown.
"""


def analyze(
    payload: Dict[str, Any],
    *,
    settings: Any = None,
    no_llm: bool = False,
) -> Dict[str, Any]:
    """Optional LLM enrichment layered on top of the deterministic report."""
    if no_llm or settings is None:
        return {"engine": None, "error": None, "sections": None}

    api_key = getattr(settings, "OPENAI_API_KEY", "") or ""
    ollama_url = getattr(settings, "ollama_reachable_url", "") or ""
    if not api_key and not ollama_url:
        return {
            "engine": None,
            "error": None,
            "sections": None,
            "note": "No LLM provider configured — deterministic engine only.",
        }

    user_prompt = json.dumps({
        "strategy": payload.get("strategy_name"),
        "metrics": payload.get("metrics"),
        "in_sample": payload.get("in_sample"),
        "out_of_sample": payload.get("out_of_sample"),
        "rule_findings": payload.get("findings"),
        "rule_score": payload.get("score"),
        "regime": payload.get("regime"),
        "decay": payload.get("decay"),
        "prop_limits": payload.get("thresholds"),
    }, default=str)[:12000]

    if api_key:
        content, error = _call_openai(
            api_key, getattr(settings, "OPENAI_MODEL", "gpt-4o-mini"),
            ANALYST_SYSTEM_PROMPT, user_prompt,
        )
        engine, model = "openai", getattr(settings, "OPENAI_MODEL", "gpt-4o-mini")
    else:
        content, error = _call_ollama(
            ollama_url, getattr(settings, "OLLAMA_MODEL", "llama3.1"),
            ANALYST_SYSTEM_PROMPT, user_prompt,
        )
        engine, model = "ollama", getattr(settings, "OLLAMA_MODEL", "llama3.1")

    if not content:
        return {"engine": None, "error": error, "sections": None}
    parsed = _extract_json(content)
    if not parsed:
        return {"engine": None, "error": "LLM returned no parseable JSON", "sections": None}
    return {"engine": engine, "model": model, "error": None, "sections": parsed}


def sample_spec() -> Dict[str, Any]:
    """The JSON template shown in the Strategy Creator's No-LLM helper."""
    return json.loads(json.dumps(SAMPLE_SPEC))


PROMPT_TEMPLATE = """You are AlphaForge's strategy compiler. Convert the description below into a
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
\"\"\"
<<< PASTE YOUR STRATEGY, VIDEO TRANSCRIPT OR VIDEO TITLE HERE >>>
\"\"\"
"""
