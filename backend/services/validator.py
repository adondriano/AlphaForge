"""Strategy specification schema + manual-JSON validator.

The Strategy Creator modal can produce a strategy from three different inputs:

* a video URL (YouTube / TikTok),
* free-form prose,
* a hand written JSON spec ("No-LLM mode").

Whatever the source, everything funnels through :class:`StrategySpec` so the
rest of the engine can rely on a single, validated shape.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field, ValidationError, field_validator

VALID_INDICATORS = {
    "ema_cross",
    "ema_stack",
    "rsi",
    "macd",
    "atr",
    "donchian_breakout",
    "bollinger_reversion",
    "vwap",
    "price_action",
}

VALID_TIMEFRAMES = {"M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"}
VALID_SIDES = {"long", "short", "both"}
VALID_SOURCE_TYPES = {"youtube", "tiktok", "text", "json", "manual"}


class Rule(BaseModel):
    """A single entry / exit / filter condition."""

    indicator: str
    params: Dict[str, Any] = Field(default_factory=dict)
    direction: str = "both"
    note: str = ""

    @field_validator("indicator")
    @classmethod
    def _check_indicator(cls, v: str) -> str:
        key = (v or "").strip().lower()
        if key not in VALID_INDICATORS:
            raise ValueError(
                f"unknown indicator '{v}'. Valid: {', '.join(sorted(VALID_INDICATORS))}"
            )
        return key

    @field_validator("direction")
    @classmethod
    def _check_direction(cls, v: str) -> str:
        key = (v or "both").strip().lower()
        if key not in VALID_SIDES:
            raise ValueError(f"direction must be one of {sorted(VALID_SIDES)}")
        return key


class RiskProfile(BaseModel):
    """Per-strategy risk envelope. Defaults mirror FTMO-style challenge rules."""

    risk_per_trade_pct: float = Field(default=0.5, gt=0, le=10)
    rr_ratio: float = Field(default=2.0, gt=0, le=20)
    max_daily_drawdown_pct: float = Field(default=3.5, gt=0, le=100)
    max_total_drawdown_pct: float = Field(default=5.0, gt=0, le=100)
    max_concurrent_trades: int = Field(default=2, ge=1, le=50)
    session: str = "london_ny"

    @field_validator("risk_per_trade_pct", "rr_ratio", "max_daily_drawdown_pct",
                     "max_total_drawdown_pct", mode="before")
    @classmethod
    def _coerce_number(cls, v: Any) -> Any:
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                return v
        return v


class StrategySpec(BaseModel):
    """The canonical, engine-executable form of a strategy."""

    name: str = Field(default="Untitled Strategy", min_length=1, max_length=120)
    symbol: str = Field(default="XAUUSD", min_length=1, max_length=24)
    timeframe: str = Field(default="H1")
    description: str = ""
    source_type: str = "text"
    source_url: str = ""
    side: str = "both"
    entries: List[Rule] = Field(default_factory=list)
    exits: List[Rule] = Field(default_factory=list)
    filters: List[Rule] = Field(default_factory=list)
    parameters: Dict[str, float] = Field(default_factory=dict)
    risk: RiskProfile = Field(default_factory=RiskProfile)

    @field_validator("timeframe")
    @classmethod
    def _check_tf(cls, v: str) -> str:
        key = (v or "H1").strip().upper()
        if key not in VALID_TIMEFRAMES:
            raise ValueError(f"timeframe must be one of {sorted(VALID_TIMEFRAMES)}")
        return key

    @field_validator("source_type")
    @classmethod
    def _check_source(cls, v: str) -> str:
        key = (v or "text").strip().lower()
        if key not in VALID_SOURCE_TYPES:
            raise ValueError(f"source_type must be one of {sorted(VALID_SOURCE_TYPES)}")
        return key

    @field_validator("side")
    @classmethod
    def _check_side(cls, v: str) -> str:
        key = (v or "both").strip().lower()
        if key not in VALID_SIDES:
            raise ValueError(f"side must be one of {sorted(VALID_SIDES)}")
        return key

    @field_validator("symbol")
    @classmethod
    def _upper_symbol(cls, v: str) -> str:
        return (v or "").strip().upper()

    model_config = {"extra": "ignore"}


# ---------------------------------------------------------------------------
# Default parameter space (the knobs Optuna is allowed to tune)
# ---------------------------------------------------------------------------
DEFAULT_PARAMETERS: Dict[str, float] = {
    "fast_ema": 12.0,
    "slow_ema": 26.0,
    "rsi_period": 14.0,
    "rsi_lower": 32.0,
    "rsi_upper": 68.0,
    "atr_period": 14.0,
    "atr_sl_mult": 2.0,
    "rr_ratio": 2.0,
    "breakout_lookback": 20.0,
    "risk_per_trade_pct": 0.5,
    "trend_filter_enabled": 1.0,
    "min_signal_strength": 1.0,
}

DEFAULT_BOUNDS: Dict[str, List[float]] = {
    "fast_ema": [5.0, 40.0],
    "slow_ema": [20.0, 120.0],
    "rsi_period": [7.0, 28.0],
    "rsi_lower": [15.0, 45.0],
    "rsi_upper": [55.0, 85.0],
    "atr_period": [7.0, 28.0],
    "atr_sl_mult": [1.0, 4.0],
    "rr_ratio": [1.0, 5.0],
    "breakout_lookback": [10.0, 60.0],
    "risk_per_trade_pct": [0.1, 2.0],
}


def _bounds_for(parameters: Dict[str, float]) -> Dict[str, List[float]]:
    """Build a search space around the current parameters (±60%, clamped)."""
    bounds: Dict[str, List[float]] = {}
    for key, value in parameters.items():
        if key in DEFAULT_BOUNDS:
            bounds[key] = list(DEFAULT_BOUNDS[key])
            continue
        if key in {"trend_filter_enabled", "min_signal_strength"}:
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        if value == 0:
            bounds[key] = [0.1, 1.0]
            continue
        low, high = value * 0.4, value * 1.6
        if low > high:
            low, high = high, low
        if low == high:
            high = low + 1.0
        bounds[key] = [round(low, 4), round(high, 4)]
    return bounds


# ---------------------------------------------------------------------------
# Manual JSON validation
# ---------------------------------------------------------------------------
class ValidationResult(BaseModel):
    ok: bool
    spec: Optional[StrategySpec] = None
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


def parse_manual_json(raw: str) -> ValidationResult:
    """Parse + validate a hand written strategy JSON document.

    Returns a :class:`ValidationResult`. Never raises — the frontend renders
    ``errors`` inline in the paste box.
    """
    warnings: List[str] = []
    if raw is None or not str(raw).strip():
        return ValidationResult(ok=False, errors=["Nothing to validate — paste a JSON spec first."])

    text = str(raw).strip()
    # Tolerate fenced code blocks and smart quotes.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"```$", "", text).strip()
    text = text.replace("“", '"').replace("”", '"').replace("’", "'")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        return ValidationResult(
            ok=False,
            errors=[f"Invalid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})"],
        )

    if not isinstance(payload, dict):
        return ValidationResult(ok=False, errors=["Top level value must be a JSON object."])

    payload = dict(payload)

    # Accept a few friendly aliases so hand-written specs are forgiving.
    aliases = {
        "strategy_name": "name",
        "title": "name",
        "ticker": "symbol",
        "pair": "symbol",
        "tf": "timeframe",
        "interval": "timeframe",
        "entry_rules": "entries",
        "exit_rules": "exits",
        "entry": "entries",
        "exit": "exits",
        "params": "parameters",
        "risk_profile": "risk",
        "url": "source_url",
    }
    for old, new in aliases.items():
        if old in payload and new not in payload:
            payload[new] = payload.pop(old)

    # Normalise rules given as bare strings, e.g. "ema_cross 12/26"
    for key in ("entries", "exits", "filters"):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, dict):
            value = [value]
        if not isinstance(value, list):
            return ValidationResult(ok=False, errors=[f"'{key}' must be an array of rule objects."])
        normalised = []
        for item in value:
            if isinstance(item, str):
                parts = item.lower().replace("-", "_").split()
                normalised.append({"indicator": parts[0] if parts else "price_action"})
            else:
                normalised.append(item)
        payload[key] = normalised

    if not payload.get("entries"):
        warnings.append(
            "No entry rules supplied — engine will fall back to the default EMA cross entry."
        )
        payload["entries"] = [
            {"indicator": "ema_cross", "params": {"fast": 12, "slow": 26}, "direction": "both"}
        ]
    if not payload.get("exits"):
        payload["exits"] = [
            {"indicator": "atr", "params": {"mult": 2.0, "rr": 2.0}, "direction": "both"}
        ]
        warnings.append("No exit rules supplied — default ATR stop / R-multiple target applied.")

    # Merge parameters into rule params so the optimiser and the runner agree.
    params = payload.get("parameters") or {}
    if not isinstance(params, dict):
        return ValidationResult(ok=False, errors=["'parameters' must be an object of numbers."])
    clean_params: Dict[str, float] = {}
    for key, value in params.items():
        try:
            clean_params[str(key)] = float(value)
        except (TypeError, ValueError):
            warnings.append(f"Ignored non-numeric parameter '{key}'.")
    payload["parameters"] = {**DEFAULT_PARAMETERS, **clean_params}

    try:
        spec = StrategySpec(**payload)
    except ValidationError as exc:
        errors = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", [])) or "root"
            errors.append(f"{loc}: {err.get('msg')}")
        return ValidationResult(ok=False, errors=errors, warnings=warnings)

    return ValidationResult(ok=True, spec=spec, errors=[], warnings=warnings)


def spec_from_dict(payload: Dict[str, Any]) -> Tuple[Optional[StrategySpec], List[str]]:
    """Validate an already-decoded mapping (used by the LLM + heuristic paths)."""
    result = parse_manual_json(json.dumps(payload))
    return result.spec, result.errors


SAMPLE_SPEC: Dict[str, Any] = {
    "name": "London Breakout — XAUUSD",
    "symbol": "XAUUSD",
    "timeframe": "H1",
    "description": "Buys Donchian breakouts during the London session with an ATR stop.",
    "side": "both",
    "entries": [
        {"indicator": "donchian_breakout", "params": {"lookback": 20}, "direction": "both"},
        {"indicator": "ema_cross", "params": {"fast": 12, "slow": 26}, "direction": "both"},
    ],
    "exits": [{"indicator": "atr", "params": {"mult": 2.0, "rr": 2.5}, "direction": "both"}],
    "filters": [{"indicator": "rsi", "params": {"period": 14, "lower": 25, "upper": 75}}],
    "parameters": {
        "fast_ema": 12,
        "slow_ema": 26,
        "rsi_period": 14,
        "rsi_lower": 25,
        "rsi_upper": 75,
        "atr_period": 14,
        "atr_sl_mult": 2.0,
        "rr_ratio": 2.5,
        "breakout_lookback": 20,
        "risk_per_trade_pct": 0.5,
    },
    "risk": {
        "risk_per_trade_pct": 0.5,
        "rr_ratio": 2.5,
        "max_daily_drawdown_pct": 3.5,
        "max_total_drawdown_pct": 5.0,
        "max_concurrent_trades": 2,
        "session": "london_ny",
    },
}
