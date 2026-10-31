"""Prop-Firm Shield — hard middleware for daily / total drawdown enforcement.

Every order, from every code path (autonomous loop, manual trigger, Optimizer
re-arm), must pass through :meth:`PropFirmShield.evaluate`. There is no
"override" flag by design: if a breach is detected the order is rejected and
recorded in ``trade_logs`` with ``status = 'blocked'`` so the audit trail is
complete.

Defaults follow the strictest common challenge rules:
    * 3.5% max daily drawdown
    * 5.0% max total drawdown
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional

MAX_DAILY_DRAWDOWN_PCT = 3.5
MAX_TOTAL_DRAWDOWN_PCT = 5.0


@dataclass
class RiskDecision:
    allowed: bool
    code: str
    reason: str
    daily_drawdown_pct: float
    total_drawdown_pct: float
    daily_limit_pct: float
    total_limit_pct: float
    daily_headroom_pct: float
    total_headroom_pct: float
    approved_risk_pct: float
    requested_risk_pct: float
    adjusted_volume: float
    requested_volume: float
    action: str  # "allow" | "reduce" | "block" | "liquidate"
    breach: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class PropFirmShield:
    """Stateless evaluator: feed it account state, get an allow/reduce/block."""

    def __init__(
        self,
        max_daily_drawdown_pct: float = MAX_DAILY_DRAWDOWN_PCT,
        max_total_drawdown_pct: float = MAX_TOTAL_DRAWDOWN_PCT,
        risk_per_trade_pct: float = 0.5,
        max_concurrent_trades: int = 2,
        best_day_profit_cap_pct: float = 35.0,
        emergency_liquidate_on_breach: bool = True,
    ) -> None:
        self.max_daily_dd = float(max_daily_drawdown_pct or MAX_DAILY_DRAWDOWN_PCT)
        self.max_total_dd = float(max_total_drawdown_pct or MAX_TOTAL_DRAWDOWN_PCT)
        self.risk_per_trade_pct = float(risk_per_trade_pct or 0.5)
        self.max_concurrent_trades = int(max_concurrent_trades or 2)
        self.best_day_profit_cap_pct = float(best_day_profit_cap_pct or 35.0)
        self.emergency_liquidate_on_breach = bool(emergency_liquidate_on_breach)

    # ------------------------------------------------------------------
    @staticmethod
    def drawdown_pct(reference: float, current: float) -> float:
        """Loss measured against a reference equity (day-start or peak)."""
        if not reference or reference <= 0:
            return 0.0
        return max(0.0, (reference - current) / reference * 100.0)

    def evaluate(
        self,
        *,
        equity: float,
        day_start_equity: float,
        peak_equity: float,
        requested_risk_pct: Optional[float] = None,
        volume: float = 0.01,
        open_positions: int = 0,
    ) -> RiskDecision:
        equity = float(equity or 0.0)
        day_start = float(day_start_equity or equity or 1.0)
        peak = float(peak_equity or max(equity, day_start) or 1.0)

        daily_dd = self.drawdown_pct(day_start, equity)
        total_dd = self.drawdown_pct(peak, equity)
        daily_headroom = max(0.0, self.max_daily_dd - daily_dd)
        total_headroom = max(0.0, self.max_total_dd - total_dd)

        requested_risk = float(requested_risk_pct if requested_risk_pct is not None
                               else self.risk_per_trade_pct)
        approved_risk = requested_risk
        action = "allow"
        code = "ok"
        reason = "Inside the prop-firm envelope."

        # ---- hard stop 1: total drawdown --------------------------------
        if total_dd >= self.max_total_dd:
            return RiskDecision(
                allowed=False, code="total_drawdown_breach", action="liquidate",
                reason=(f"Total drawdown {total_dd:.2f}% has reached the "
                        f"{self.max_total_dd:.2f}% hard cap. Trading is halted."),
                daily_drawdown_pct=round(daily_dd, 4),
                total_drawdown_pct=round(total_dd, 4),
                daily_limit_pct=self.max_daily_dd,
                total_limit_pct=self.max_total_dd,
                daily_headroom_pct=round(daily_headroom, 4),
                total_headroom_pct=round(total_headroom, 4),
                approved_risk_pct=0.0,
                requested_risk_pct=round(requested_risk, 4),
                adjusted_volume=0.0,
                requested_volume=round(float(volume or 0.0), 6),
                breach="total",
            )

        # ---- hard stop 2: daily drawdown --------------------------------
        if daily_dd >= self.max_daily_dd:
            return RiskDecision(
                allowed=False, code="daily_drawdown_breach",
                action="block",
                reason=(f"Daily drawdown {daily_dd:.2f}% has reached the "
                        f"{self.max_daily_dd:.2f}% hard cap. No new entries until the "
                        "next trading day."),
                daily_drawdown_pct=round(daily_dd, 4),
                total_drawdown_pct=round(total_dd, 4),
                daily_limit_pct=self.max_daily_dd,
                total_limit_pct=self.max_total_dd,
                daily_headroom_pct=round(daily_headroom, 4),
                total_headroom_pct=round(total_headroom, 4),
                approved_risk_pct=0.0,
                requested_risk_pct=round(requested_risk, 4),
                adjusted_volume=0.0,
                requested_volume=round(float(volume or 0.0), 6),
                breach="daily",
            )

        # ---- soft stop: scale risk down as headroom shrinks -------------
        safe_risk = min(daily_headroom, total_headroom)
        if requested_risk > safe_risk:
            approved_risk = max(0.0, safe_risk * 0.8)
            action = "reduce"
            code = "risk_reduced"
            reason = (f"Requested {requested_risk:.2f}% risk exceeds the remaining "
                      f"{safe_risk:.2f}% headroom; size reduced to {approved_risk:.2f}%.")

        # ---- concurrency -------------------------------------------------
        if open_positions >= self.max_concurrent_trades:
            return RiskDecision(
                allowed=False, code="max_concurrent_trades", action="block",
                reason=(f"{open_positions} positions are already open and the limit is "
                        f"{self.max_concurrent_trades}."),
                daily_drawdown_pct=round(daily_dd, 4),
                total_drawdown_pct=round(total_dd, 4),
                daily_limit_pct=self.max_daily_dd,
                total_limit_pct=self.max_total_dd,
                daily_headroom_pct=round(daily_headroom, 4),
                total_headroom_pct=round(total_headroom, 4),
                approved_risk_pct=0.0,
                requested_risk_pct=round(requested_risk, 4),
                adjusted_volume=0.0,
                requested_volume=round(float(volume or 0.0), 6),
                breach="concurrency",
            )

        scale = (approved_risk / requested_risk) if requested_risk > 0 else 1.0
        adjusted_volume = round(float(volume or 0.0) * scale, 6)
        if approved_risk <= 0.0001:
            return RiskDecision(
                allowed=False, code="no_risk_headroom", action="block",
                reason="No drawdown headroom left for a new position.",
                daily_drawdown_pct=round(daily_dd, 4),
                total_drawdown_pct=round(total_dd, 4),
                daily_limit_pct=self.max_daily_dd,
                total_limit_pct=self.max_total_dd,
                daily_headroom_pct=round(daily_headroom, 4),
                total_headroom_pct=round(total_headroom, 4),
                approved_risk_pct=0.0,
                requested_risk_pct=round(requested_risk, 4),
                adjusted_volume=0.0,
                requested_volume=round(float(volume or 0.0), 6),
                breach="headroom",
            )

        return RiskDecision(
            allowed=True, code=code, action=action, reason=reason,
            daily_drawdown_pct=round(daily_dd, 4),
            total_drawdown_pct=round(total_dd, 4),
            daily_limit_pct=self.max_daily_dd,
            total_limit_pct=self.max_total_dd,
            daily_headroom_pct=round(daily_headroom, 4),
            total_headroom_pct=round(total_headroom, 4),
            approved_risk_pct=round(approved_risk, 4),
            requested_risk_pct=round(requested_risk, 4),
            adjusted_volume=adjusted_volume,
            requested_volume=round(float(volume or 0.0), 6),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "max_daily_drawdown_pct": self.max_daily_dd,
            "max_total_drawdown_pct": self.max_total_dd,
            "risk_per_trade_pct": self.risk_per_trade_pct,
            "max_concurrent_trades": self.max_concurrent_trades,
            "best_day_profit_cap_pct": self.best_day_profit_cap_pct,
            "emergency_liquidate_on_breach": self.emergency_liquidate_on_breach,
        }


def shield_from(settings: Any) -> PropFirmShield:
    """Build a shield from the runtime :class:`~services.settings.Settings`."""
    getter = settings.get if isinstance(settings, dict) else getattr
    try:
        daily = float(getter(settings, "MAX_DAILY_DRAWDOWN"))
    except Exception:
        daily = MAX_DAILY_DRAWDOWN_PCT
    try:
        total = float(getter(settings, "MAX_TOTAL_DRAWDOWN"))
    except Exception:
        total = MAX_TOTAL_DRAWDOWN_PCT
    try:
        risk = float(getter(settings, "RISK_PER_TRADE_PCT"))
    except Exception:
        risk = 0.5
    try:
        concurrent = int(getter(settings, "MAX_CONCURRENT_TRADES"))
    except Exception:
        concurrent = 2
    try:
        best_day = float(getter(settings, "BEST_DAY_PROFIT_CAP_PCT"))
    except Exception:
        best_day = 35.0
    try:
        liquidate = bool(getter(settings, "EMERGENCY_LIQUIDATE_ON_BREACH"))
    except Exception:
        liquidate = True

    if total < daily:  # never allow an incoherent envelope
        total = max(daily * 1.2, daily)
    return PropFirmShield(
        max_daily_drawdown_pct=daily,
        max_total_drawdown_pct=total,
        risk_per_trade_pct=risk,
        max_concurrent_trades=concurrent,
        best_day_profit_cap_pct=best_day,
        emergency_liquidate_on_breach=liquidate,
    )
