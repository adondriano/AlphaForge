"""Deterministic event-driven backtest engine (zero heavy dependencies).

The engine is intentionally dependency free: it runs on plain Python so it
works identically on a workstation with pandas/numpy installed and inside a
stripped down serverless function. When `numpy` is importable it is used for
the price path only — results are seeded and reproducible either way.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .validator import StrategySpec

try:  # optional speed-up, never required
    import numpy as _np  # type: ignore
except Exception:  # pragma: no cover - exercised only on minimal installs
    _np = None  # type: ignore

try:  # optional: richer equity-curve statistics when the quant stack is present
    import pandas as _pd  # type: ignore
except Exception:  # pragma: no cover
    _pd = None  # type: ignore

TIMEFRAME_MINUTES = {
    "M1": 1, "M5": 5, "M15": 15, "M30": 30,
    "H1": 60, "H4": 240, "D1": 1440, "W1": 10080,
}

BASE_PRICE = {  # rough 2026-era reference prices used for the synthetic series
    "XAUUSD": 2650.0, "EURUSD": 1.0850, "GBPUSD": 1.2650, "USDJPY": 152.40,
    "US30Cash": 42500.0, "NAS100": 20500.0, "BTCUSD": 64000.0,
}


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------
def generate_bars(symbol: str, timeframe: str, n: int = 3000, seed: int | None = 7) -> List[Dict[str, float]]:
    """Generate a reproducible OHLC series with trend regimes and volatility clustering.

    AlphaForge ships without a market-data vendor by default so that the studio
    is usable out of the box. Swap :func:`generate_bars` for a real feed
    (Dukascopy / MetaTrader 5 / your broker) and the rest of the pipeline is
    unchanged — it only ever consumes a list of OHLC dicts.
    """
    minutes = TIMEFRAME_MINUTES.get(timeframe.upper(), 60)
    rng = random.Random(seed if seed is not None else 7)
    base = BASE_PRICE.get(symbol.upper(), 100.0)
    pip = base * 0.0004  # tick size-ish

    bars_per_day = max(1.0, 1440.0 / minutes)
    price = base
    bars: List[Dict[str, float]] = []
    # Two slow regimes + one fast cycle: gives trend-following and mean-reverting
    # strategies something mutually exclusive to find.
    for i in range(n):
        slow = math.sin(i / (bars_per_day * 45.0))
        fast = math.sin(i / (bars_per_day * 7.0)) * 0.35
        # The deterministic component is deliberately weak: a series that is too
        # trendy produces backtests nobody would believe (PF > 3, Sharpe > 10).
        drift = (slow * 0.9 + fast) * 0.00018
        # volatility clustering (GARCH-flavoured): vol decays toward a floor
        cluster = 1.0 + 1.6 * abs(math.sin(i / (bars_per_day * 23.0)))
        sigma = 0.0009 * cluster
        o = price
        high = low = price
        steps = 4
        for _ in range(steps):
            step = drift / steps + sigma / math.sqrt(steps) * rng.gauss(0, 1)
            price = max(pip, price * (1.0 + step))
            high = max(high, price)
            low = min(low, price)
        if rng.random() < 0.0015:  # rare gap / news spike
            gap = sigma * 14 * (1 if rng.random() < 0.5 else -1)
            price = max(pip, price * (1.0 + gap))
            high = max(high, price)
            low = min(low, price)
        c = price
        bars.append({
            "t": i,
            "o": round(o, 6),
            "h": round(high, 6),
            "l": round(low, 6),
            "c": round(c, 6),
            "v": round(1000 + 400 * cluster + rng.random() * 250, 2),
        })
    return bars


# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------
def ema(values: Sequence[float], period: int) -> List[float]:
    period = max(1, int(period))
    k = 2.0 / (period + 1.0)
    out: List[float] = []
    prev = values[0] if values else 0.0
    for i, v in enumerate(values):
        prev = v if i == 0 else (v - prev) * k + prev
        out.append(prev)
    return out


def sma(values: Sequence[float], period: int) -> List[float]:
    period = max(1, int(period))
    out: List[float] = []
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= period:
            running -= values[i - period]
        out.append(running / min(i + 1, period))
    return out


def rsi(values: Sequence[float], period: int = 14) -> List[float]:
    period = max(2, int(period))
    out = [50.0] * len(values)
    if len(values) < 2:
        return out
    gains = losses = 0.0
    for i in range(1, len(values)):
        change = values[i] - values[i - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        if i <= period:
            gains += gain / period
            losses += loss / period
            if i == period:
                out[i] = _rsi_from(gains, losses)
        else:
            gains = (gains * (period - 1) + gain) / period
            losses = (losses * (period - 1) + loss) / period
            out[i] = _rsi_from(gains, losses)
    # backfill the warmup window
    for i in range(min(period, len(values))):
        out[i] = out[min(period, len(values) - 1)]
    return out


def _rsi_from(gains: float, losses: float) -> float:
    if losses == 0:
        return 100.0
    rs = gains / losses
    return 100.0 - (100.0 / (1.0 + rs))


def atr(bars: Sequence[Dict[str, float]], period: int = 14) -> List[float]:
    period = max(1, int(period))
    trs: List[float] = []
    for i, bar in enumerate(bars):
        if i == 0:
            trs.append(bar["h"] - bar["l"])
        else:
            prev_close = bars[i - 1]["c"]
            trs.append(max(
                bar["h"] - bar["l"],
                abs(bar["h"] - prev_close),
                abs(bar["l"] - prev_close),
            ))
    return sma(trs, period)


def donchian(bars: Sequence[Dict[str, float]], lookback: int = 20) -> tuple[List[float], List[float]]:
    lookback = max(2, int(lookback))
    highs: List[float] = []
    lows: List[float] = []
    for i in range(len(bars)):
        start = max(0, i - lookback)
        window = bars[start:i] or bars[:1]
        highs.append(max(b["h"] for b in window))
        lows.append(min(b["l"] for b in window))
    return highs, lows


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
@dataclass
class Trade:
    id: int
    side: str
    entry: float
    exit_price: float
    stop_loss: float
    take_profit: float
    units: float
    pnl: float
    pnl_pct: float
    r_multiple: float
    entry_index: int
    exit_index: int
    exit_reason: str
    sample: str  # "in" | "out"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "side": self.side,
            "entry": round(self.entry, 6),
            "exit": round(self.exit_price, 6),
            "stop_loss": round(self.stop_loss, 6),
            "take_profit": round(self.take_profit, 6),
            "units": round(self.units, 6),
            "pnl": round(self.pnl, 4),
            "pnl_pct": round(self.pnl_pct, 4),
            "r_multiple": round(self.r_multiple, 4),
            "entry_index": self.entry_index,
            "exit_index": self.exit_index,
            "exit_reason": self.exit_reason,
            "sample": self.sample,
        }


@dataclass
class BacktestResult:
    trades: List[Trade] = field(default_factory=list)
    equity_curve: List[float] = field(default_factory=list)
    metrics: Dict[str, float] = field(default_factory=dict)
    in_sample: Dict[str, float] = field(default_factory=dict)
    out_of_sample: Dict[str, float] = field(default_factory=dict)
    bars_used: int = 0
    seed: int | None = None
    engine: str = "alphaforge-core"

    def to_dict(self, include_trades: bool = True, trade_limit: int = 400) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "metrics": self.metrics,
            "in_sample": self.in_sample,
            "out_of_sample": self.out_of_sample,
            "bars_used": self.bars_used,
            "seed": self.seed,
            "engine": self.engine,
            "equity_curve": [round(x, 2) for x in self.equity_curve[:: max(1, len(self.equity_curve) // 240 or 1)]],
            "trade_count": len(self.trades),
        }
        if include_trades:
            payload["trades"] = [t.to_dict() for t in self.trades[:trade_limit]]
        return payload


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def compute_metrics(
    trades: Sequence[Trade],
    equity_curve: Sequence[float],
    *,
    initial_equity: float = 10_000.0,
    timeframe: str = "H1",
    bars: int = 0,
    max_daily_dd_pct: float = 3.5,
    max_total_dd_pct: float = 5.0,
) -> Dict[str, float]:
    n = len(trades)
    if n == 0:
        return {
            "total_trades": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
            "net_return_pct": 0.0, "max_drawdown_pct": 0.0, "max_daily_drawdown_pct": 0.0,
            "profit_factor": 0.0, "sharpe": 0.0, "expectancy_r": 0.0,
            "avg_win_r": 0.0, "avg_loss_r": 0.0, "longest_losing_streak": 0,
            "est_trades_per_week": 0.0, "prop_readiness": 0.0, "final_equity": initial_equity,
            "gross_profit": 0.0, "gross_loss": 0.0, "avg_trade_pct": 0.0, "recovery_factor": 0.0,
        }

    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl <= 0]
    gross_profit = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (99.0 if gross_profit > 0 else 0.0)

    final_equity = equity_curve[-1] if equity_curve else initial_equity
    net_return_pct = (final_equity / initial_equity - 1.0) * 100.0

    # drawdown — pandas when available, identical pure-Python maths otherwise
    peak = equity_curve[0] if equity_curve else initial_equity
    max_dd = 0.0
    if _pd is not None and len(equity_curve or []) > 1:
        series = _pd.Series([float(x) for x in equity_curve])
        running_peak = series.cummax()
        max_dd = float(((running_peak - series) / running_peak.replace(0, float("nan"))).max() * 100.0)
        if max_dd != max_dd:  # NaN guard
            max_dd = 0.0
    else:
        for value in equity_curve or [initial_equity]:
            peak = max(peak, value)
            if peak > 0:
                max_dd = max(max_dd, (peak - value) / peak * 100.0)

    # daily drawdown (bucket the equity curve into trading days)
    minutes = TIMEFRAME_MINUTES.get(timeframe.upper(), 60)
    bars_per_day = max(1, int(1440 / minutes))
    max_daily_dd = 0.0
    for start in range(0, len(equity_curve), bars_per_day):
        chunk = equity_curve[start:start + bars_per_day]
        if not chunk:
            continue
        day_start = chunk[0]
        if day_start <= 0:
            continue
        worst = min(chunk)
        max_daily_dd = max(max_daily_dd, (day_start - worst) / day_start * 100.0)

    r_multiples = [t.r_multiple for t in trades]
    expectancy_r = sum(r_multiples) / n
    avg_win_r = sum(t.r_multiple for t in wins) / len(wins) if wins else 0.0
    avg_loss_r = sum(t.r_multiple for t in losses) / len(losses) if losses else 0.0

    pct_returns = [t.pnl_pct for t in trades]
    mean_r = sum(pct_returns) / n
    var = sum((x - mean_r) ** 2 for x in pct_returns) / max(1, n - 1)
    std = math.sqrt(var)
    minutes_total = (bars or n) * minutes
    weeks = max(minutes_total / (60 * 24 * 7), 1e-9)
    trades_per_week = n / weeks
    trades_per_year = trades_per_week * 52.0
    sharpe = (mean_r / std * math.sqrt(max(trades_per_year, 1.0))) if std > 1e-12 else 0.0

    streak = worst_streak = 0
    for t in trades:
        if t.pnl <= 0:
            streak += 1
            worst_streak = max(worst_streak, streak)
        else:
            streak = 0

    # ---- Prop-Firm readiness -------------------------------------------
    dd_score = _clamp(1.0 - (max_dd / max(max_total_dd_pct, 1e-9)), 0.0, 1.0)
    daily_dd_score = _clamp(1.0 - (max_daily_dd / max(max_daily_dd_pct, 1e-9)), 0.0, 1.0)
    pf_score = _clamp((profit_factor - 1.0) / 1.2, 0.0, 1.0)
    exp_score = _clamp(expectancy_r / 0.45, 0.0, 1.0)
    sample_score = _clamp(n / 120.0, 0.0, 1.0)
    sharpe_score = _clamp(sharpe / 2.2, 0.0, 1.0)
    readiness = 100.0 * (
        0.20 * dd_score + 0.12 * daily_dd_score + 0.20 * pf_score +
        0.20 * exp_score + 0.14 * sample_score + 0.14 * sharpe_score
    )

    return {
        "total_trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / n * 100.0, 2),
        "net_return_pct": round(net_return_pct, 4),
        "max_drawdown_pct": round(max_dd, 4),
        "max_daily_drawdown_pct": round(max_daily_dd, 4),
        "profit_factor": round(profit_factor, 4),
        "sharpe": round(sharpe, 4),
        "expectancy_r": round(expectancy_r, 4),
        "avg_win_r": round(avg_win_r, 4),
        "avg_loss_r": round(avg_loss_r, 4),
        "longest_losing_streak": worst_streak,
        "est_trades_per_week": round(trades_per_week, 2),
        "prop_readiness": round(readiness, 2),
        "final_equity": round(final_equity, 2),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "avg_trade_pct": round(mean_r, 4),
        "recovery_factor": round((net_return_pct / max_dd) if max_dd > 0 else 0.0, 4),
    }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
def run_backtest(
    spec: StrategySpec,
    bars: Optional[List[Dict[str, float]]] = None,
    *,
    bars_count: int = 3000,
    seed: int | None = 7,
    initial_equity: float = 10_000.0,
    split: float = 0.7,
    max_daily_dd_pct: float = 3.5,
    max_total_dd_pct: float = 5.0,
    commission_pct: float = 0.004,
    spread_pct: float = 0.01,
    parameters: Optional[Dict[str, float]] = None,
) -> BacktestResult:
    """Execute the strategy over the bar series and return trades + metrics."""
    params = dict(spec.parameters or {})
    if parameters:
        params.update({k: float(v) for k, v in parameters.items() if _is_number(v)})

    if bars is None:
        bars = generate_bars(spec.symbol, spec.timeframe, bars_count, seed)
    if not bars:
        return BacktestResult(metrics=compute_metrics([], [], initial_equity=initial_equity))

    fast_period = max(2, int(params.get("fast_ema", 12)))
    slow_period = max(fast_period + 1, int(params.get("slow_ema", 26)))
    rsi_period = max(2, int(params.get("rsi_period", 14)))
    rsi_lower = float(params.get("rsi_lower", 32))
    rsi_upper = float(params.get("rsi_upper", 68))
    atr_period = max(2, int(params.get("atr_period", 14)))
    atr_mult = max(0.3, float(params.get("atr_sl_mult", 2.0)))
    rr = max(0.2, float(params.get("rr_ratio", 2.0)))
    lookback = max(3, int(params.get("breakout_lookback", 20)))
    risk_pct = max(0.01, float(params.get("risk_per_trade_pct", spec.risk.risk_per_trade_pct)))
    trend_filter = float(params.get("trend_filter_enabled", 1.0)) >= 0.5
    min_strength = max(1.0, float(params.get("min_signal_strength", 1.0)))

    closes = [b["c"] for b in bars]
    ema_fast = ema(closes, fast_period)
    ema_slow = ema(closes, slow_period)
    rsi_values = rsi(closes, rsi_period)
    atr_values = atr(bars, atr_period)
    don_hi, don_lo = donchian(bars, lookback)

    indicator_set = {r.indicator for r in (spec.entries + spec.filters)}
    use_breakout = "donchian_breakout" in indicator_set
    use_rsi = "rsi" in indicator_set
    use_ema = "ema_cross" in indicator_set or "ema_stack" in indicator_set or not indicator_set

    equity = initial_equity
    equity_curve: List[float] = []
    trades: List[Trade] = []
    open_trade: Optional[Dict[str, Any]] = None
    split_index = int(len(bars) * _clamp(split, 0.1, 1.0))
    trade_id = 0
    last_exit_index = -10_000

    for i in range(1, len(bars)):
        bar = bars[i]
        prev = bars[i - 1]

        # --- manage open position ---------------------------------------
        if open_trade is not None:
            exit_price = None
            reason = ""
            if open_trade["side"] == "long":
                if bar["l"] <= open_trade["sl"]:
                    exit_price, reason = open_trade["sl"], "stop_loss"
                elif bar["h"] >= open_trade["tp"]:
                    exit_price, reason = open_trade["tp"], "take_profit"
            else:
                if bar["h"] >= open_trade["sl"]:
                    exit_price, reason = open_trade["sl"], "stop_loss"
                elif bar["l"] <= open_trade["tp"]:
                    exit_price, reason = open_trade["tp"], "take_profit"

            if exit_price is None and open_trade.get("max_bars") and (i - open_trade["entry_index"]) >= open_trade["max_bars"]:
                exit_price, reason = bar["c"], "time_stop"

            if exit_price is None:
                # opposite signal closes the position early
                signal = _signal(
                    i, ema_fast, ema_slow, rsi_values, don_hi, don_lo, closes,
                    use_ema, use_rsi, use_breakout, trend_filter, rsi_lower, rsi_upper,
                )
                if signal and signal != open_trade["side"]:
                    exit_price, reason = bar["c"], "reverse_signal"

            if exit_price is not None:
                trade_id += 1
                trade = _close_trade(
                    trade_id, open_trade, exit_price, reason, equity,
                    initial_equity, commission_pct, spread_pct,
                    "in" if open_trade["entry_index"] < split_index else "out",
                )
                equity += trade.pnl
                trades.append(trade)
                equity_curve.append(equity)
                open_trade = None
                last_exit_index = i
                continue

        # --- look for a new entry ---------------------------------------
        if open_trade is None and i > max(slow_period, lookback, atr_period, rsi_period) + 2:
            if (i - last_exit_index) >= 1 and _in_session(bar, spec):
                signal = _signal(
                    i, ema_fast, ema_slow, rsi_values, don_hi, don_lo, closes,
                    use_ema, use_rsi, use_breakout, trend_filter, rsi_lower, rsi_upper,
                )
                if signal and _side_allowed(signal, spec.side) and _strength_ok(
                    i, signal, ema_fast, ema_slow, don_hi, don_lo, closes, min_strength
                ):
                    entry = bar["c"]
                    atr_value = atr_values[i] or (bar["h"] - bar["l"]) or entry * 0.001
                    stop_distance = max(atr_value * atr_mult, entry * 0.0002)
                    if signal == "long":
                        sl = entry - stop_distance
                        tp = entry + stop_distance * rr
                    else:
                        sl = entry + stop_distance
                        tp = entry - stop_distance * rr
                    risk_capital = equity * (risk_pct / 100.0)
                    units = risk_capital / stop_distance if stop_distance > 0 else 0.0
                    if units > 0:
                        open_trade = {
                            "side": signal,
                            "entry": entry,
                            "sl": sl,
                            "tp": tp,
                            "units": units,
                            "entry_index": i,
                            "risk_capital": risk_capital,
                            "max_bars": int(params.get("max_bars", 0)) or None,
                        }

        equity_curve.append(equity)

    # force-close any position still open on the last bar
    if open_trade is not None:
        trade_id += 1
        trade = _close_trade(
            trade_id, open_trade, bars[-1]["c"], "end_of_data", equity,
            initial_equity, commission_pct, spread_pct,
            "in" if open_trade["entry_index"] < split_index else "out",
        )
        equity += trade.pnl
        trades.append(trade)
        equity_curve.append(equity)

    if not equity_curve:
        equity_curve = [initial_equity]

    in_trades = [t for t in trades if t.sample == "in"]
    out_trades = [t for t in trades if t.sample == "out"]

    metrics = compute_metrics(
        trades, equity_curve, initial_equity=initial_equity,
        timeframe=spec.timeframe, bars=len(bars),
        max_daily_dd_pct=max_daily_dd_pct, max_total_dd_pct=max_total_dd_pct,
    )

    return BacktestResult(
        trades=trades,
        equity_curve=equity_curve,
        metrics=metrics,
        in_sample=compute_metrics(
            in_trades, _equity_from_trades(in_trades, initial_equity),
            initial_equity=initial_equity, timeframe=spec.timeframe, bars=max(1, split_index),
            max_daily_dd_pct=max_daily_dd_pct, max_total_dd_pct=max_total_dd_pct,
        ),
        out_of_sample=compute_metrics(
            out_trades, _equity_from_trades(out_trades, initial_equity),
            initial_equity=initial_equity, timeframe=spec.timeframe,
            bars=max(1, len(bars) - split_index),
            max_daily_dd_pct=max_daily_dd_pct, max_total_dd_pct=max_total_dd_pct,
        ),
        bars_used=len(bars),
        seed=seed,
    )


def _is_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _equity_from_trades(trades: Sequence[Trade], initial_equity: float) -> List[float]:
    curve = [initial_equity]
    for trade in trades:
        curve.append(curve[-1] + trade.pnl)
    return curve


def _signal(
    i: int,
    ema_fast: Sequence[float],
    ema_slow: Sequence[float],
    rsi_values: Sequence[float],
    don_hi: Sequence[float],
    don_lo: Sequence[float],
    closes: Sequence[float],
    use_ema: bool,
    use_rsi: bool,
    use_breakout: bool,
    trend_filter: bool,
    rsi_lower: float,
    rsi_upper: float,
) -> Optional[str]:
    """Combine the configured entry conditions into a single long/short call."""
    bullish = bearish = 0
    have_any = False

    if use_ema:
        have_any = True
        fast_now, slow_now = ema_fast[i], ema_slow[i]
        fast_prev, slow_prev = ema_fast[i - 1], ema_slow[i - 1]
        crossed_up = fast_prev <= slow_prev and fast_now > slow_now
        crossed_down = fast_prev >= slow_prev and fast_now < slow_now
        if crossed_up or fast_now > slow_now:
            bullish += 1
        if crossed_down or fast_now < slow_now:
            bearish += 1

    if use_breakout:
        have_any = True
        if closes[i] > don_hi[i - 1]:
            bullish += 1
        if closes[i] < don_lo[i - 1]:
            bearish += 1

    if use_rsi:
        have_any = True
        value = rsi_values[i]
        if value < rsi_lower:
            bullish += 1  # mean reversion: oversold is a long trigger
        if value > rsi_upper:
            bearish += 1

    if not have_any:
        bullish = bearish = 1

    if bullish > bearish:
        return "long"
    if bearish > bullish:
        return "short"

    # Tie-break with the prevailing trend when the trend filter is enabled.
    if trend_filter and ema_fast[i] != ema_slow[i]:
        return "long" if ema_fast[i] > ema_slow[i] else "short"
    return None


def _strength_ok(
    i: int,
    signal: str,
    ema_fast: Sequence[float],
    ema_slow: Sequence[float],
    don_hi: Sequence[float],
    don_lo: Sequence[float],
    closes: Sequence[float],
    min_strength: float,
) -> bool:
    """Require *min_strength* agreeing conditions before firing (1 = any)."""
    if min_strength <= 1.0:
        return True
    score = 0.0
    if ema_fast[i] > ema_slow[i]:
        score += 1
    if signal == "long" and closes[i] > don_lo[i]:
        score += 1
    if signal == "short" and closes[i] < don_hi[i]:
        score += 1
    return score >= min_strength


def _side_allowed(signal: str, side: str) -> bool:
    side = (side or "both").lower()
    return side == "both" or side == signal


def _in_session(bar: Dict[str, float], spec: StrategySpec) -> bool:
    """Session filter. 'london_ny' trades bars 6..21 UTC-everything else is all-day."""
    session = (spec.risk.session or "all_day").lower()
    if session in {"all_day", "all", "24/7", "any"}:
        return True
    minutes = TIMEFRAME_MINUTES.get(spec.timeframe.upper(), 60)
    hour = int((bar["t"] * minutes / 60.0) % 24)
    if session == "london_ny":
        return 7 <= hour <= 20
    if session == "london":
        return 7 <= hour <= 15
    if session == "new_york":
        return 13 <= hour <= 21
    if session == "asia":
        return hour >= 23 or hour <= 7
    return True


def _close_trade(
    trade_id: int,
    position: Dict[str, Any],
    exit_price: float,
    reason: str,
    equity_before: float,
    initial_equity: float,
    commission_pct: float,
    spread_pct: float,
    sample: str,
) -> Trade:
    side = position["side"]
    entry = position["entry"]
    units = position["units"]
    gross = (exit_price - entry) * units if side == "long" else (entry - exit_price) * units
    notional = (entry + exit_price) * units
    # round-turn cost: broker commission on both legs + the bid/ask spread
    commission = notional * (commission_pct / 100.0) / 2.0
    spread_cost = notional * (spread_pct / 100.0) / 2.0
    pnl = gross - commission - spread_cost
    risk_capital = position.get("risk_capital") or 1.0
    r_multiple = pnl / risk_capital
    pnl_pct = (pnl / equity_before * 100.0) if equity_before else 0.0
    return Trade(
        id=trade_id,
        side=side,
        entry=entry,
        exit_price=exit_price,
        stop_loss=position["sl"],
        take_profit=position["tp"],
        units=units,
        pnl=pnl,
        pnl_pct=pnl_pct,
        r_multiple=r_multiple,
        entry_index=position["entry_index"],
        exit_index=position.get("exit_index", position["entry_index"]),
        exit_reason=reason,
        sample=sample,
    )
