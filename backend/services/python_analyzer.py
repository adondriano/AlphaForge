"""Rule-based statistical diagnostic engine (the no-LLM analyst).

This is the *default* analyst: it always runs, needs no API key, no network
round trip and no token spend. When an LLM key is configured the same payload
is enriched by :mod:`services.llm`, but the deterministic findings below stay
the source of truth for the score.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

SEVERITY_WEIGHT = {"critical": 26, "warning": 12, "info": 3}


def _f(fid: str, severity: str, title: str, detail: str, **extra: Any) -> Dict[str, Any]:
    finding = {
        "id": fid,
        "severity": severity,
        "title": title,
        "detail": detail,
    }
    finding.update(extra)
    return finding


def _r(title: str, detail: str, priority: str, action: str) -> Dict[str, Any]:
    return {"title": title, "detail": detail, "priority": priority, "action": action}


def analyze_strategy(
    *,
    metrics: Dict[str, float],
    in_sample: Optional[Dict[str, float]] = None,
    out_of_sample: Optional[Dict[str, float]] = None,
    trades: Optional[Sequence[Dict[str, Any]]] = None,
    risk_profile: Optional[Dict[str, Any]] = None,
    baseline_metrics: Optional[Dict[str, float]] = None,
    strategy_name: str = "Strategy",
) -> Dict[str, Any]:
    """Run every diagnostic rule and return a full analyst report."""
    risk = risk_profile or {}
    max_daily = float(risk.get("max_daily_drawdown_pct", 3.5) or 3.5)
    max_total = float(risk.get("max_total_drawdown_pct", 5.0) or 5.0)
    risk_per_trade = float(risk.get("risk_per_trade_pct", 0.5) or 0.5)
    rr = float(risk.get("rr_ratio", metrics.get("avg_win_r", 2.0) or 2.0))

    m = metrics or {}
    total_trades = int(m.get("total_trades", 0) or 0)
    win_rate = float(m.get("win_rate", 0.0) or 0.0)
    profit_factor = float(m.get("profit_factor", 0.0) or 0.0)
    max_dd = float(m.get("max_drawdown_pct", 0.0) or 0.0)
    max_daily_dd = float(m.get("max_daily_drawdown_pct", 0.0) or 0.0)
    expectancy = float(m.get("expectancy_r", 0.0) or 0.0)
    sharpe = float(m.get("sharpe", 0.0) or 0.0)
    streak = int(m.get("longest_losing_streak", 0) or 0)
    net_return = float(m.get("net_return_pct", 0.0) or 0.0)
    trades_per_week = float(m.get("est_trades_per_week", 0.0) or 0.0)

    findings: List[Dict[str, Any]] = []
    recommendations: List[Dict[str, Any]] = []

    # --- 1. statistical sample size ------------------------------------
    if total_trades == 0:
        findings.append(_f(
            "no_trades", "critical", "No trades generated",
            "The backtest produced zero trades in the sampled window, so every other "
            "statistic is meaningless. Widen the entry conditions or extend the history.",
            metric="total_trades", value=0, threshold=30,
        ))
    elif total_trades < 30:
        findings.append(_f(
            "thin_sample", "critical", "Sample too small to trust",
            f"Only {total_trades} trades observed. Below ~30 trades the confidence interval "
            "on win rate is wider than the edge itself.",
            metric="total_trades", value=total_trades, threshold=30,
        ))
    elif total_trades < 100:
        findings.append(_f(
            "modest_sample", "warning", "Modest sample size",
            f"{total_trades} trades is workable but thin — expect meaningful drift "
            "between backtest and live expectancy.",
            metric="total_trades", value=total_trades, threshold=100,
        ))

    # --- 2. win rate vs the break-even win rate -------------------------
    breakeven_wr = 100.0 / (1.0 + rr) if rr > 0 else 50.0
    if total_trades > 0:
        if win_rate < breakeven_wr - 5:
            findings.append(_f(
                "below_breakeven", "critical", "Win rate below break-even",
                f"Win rate {win_rate:.1f}% sits under the {breakeven_wr:.1f}% break-even line "
                f"for a {rr:.1f}R target. The edge is coming from payoff asymmetry — "
                "verify it survives slippage.",
                metric="win_rate", value=win_rate, threshold=breakeven_wr,
            ))
        elif win_rate < breakeven_wr + 4:
            findings.append(_f(
                "thin_edge", "warning", "Thin win-rate cushion",
                f"Win rate {win_rate:.1f}% is only marginally above the {breakeven_wr:.1f}% "
                "break-even. A small regime shift flips this strategy negative.",
                metric="win_rate", value=win_rate, threshold=breakeven_wr,
            ))

    # --- 3. profit factor ----------------------------------------------
    if total_trades > 0:
        if profit_factor < 1.0:
            findings.append(_f(
                "negative_edge", "critical", "Profit factor below 1.0",
                f"Profit factor {profit_factor:.2f} means gross losses exceed gross profits — "
                "the strategy destroys capital in this sample.",
                metric="profit_factor", value=profit_factor, threshold=1.2,
            ))
        elif profit_factor < 1.2:
            findings.append(_f(
                "weak_pf", "warning", "Weak profit factor",
                f"Profit factor {profit_factor:.2f} leaves almost no room for spread, "
                "commission and slippage.",
                metric="profit_factor", value=profit_factor, threshold=1.2,
            ))

    # --- 4. prop-firm drawdown envelope ---------------------------------
    if max_dd > max_total:
        findings.append(_f(
            "dd_breach_total", "critical", "Total drawdown breaches the prop-firm cap",
            f"Max drawdown {max_dd:.2f}% exceeds the {max_total:.2f}% total limit. "
            "This configuration would fail the challenge.",
            metric="max_drawdown_pct", value=max_dd, threshold=max_total,
        ))
    elif max_dd > max_total * 0.7:
        findings.append(_f(
            "dd_near_total", "warning", "Drawdown close to the total cap",
            f"Max drawdown {max_dd:.2f}% consumes {max_dd / max_total * 100:.0f}% of the "
            f"{max_total:.2f}% total limit.",
            metric="max_drawdown_pct", value=max_dd, threshold=max_total,
        ))

    if max_daily_dd > max_daily:
        findings.append(_f(
            "dd_breach_daily", "critical", "Daily drawdown breaches the prop-firm cap",
            f"Worst trading day lost {max_daily_dd:.2f}% against a {max_daily:.2f}% daily limit.",
            metric="max_daily_drawdown_pct", value=max_daily_dd, threshold=max_daily,
        ))
    elif max_daily_dd > max_daily * 0.7:
        findings.append(_f(
            "dd_near_daily", "warning", "Daily drawdown close to the cap",
            f"Worst day {max_daily_dd:.2f}% vs the {max_daily:.2f}% daily limit.",
            metric="max_daily_drawdown_pct", value=max_daily_dd, threshold=max_daily,
        ))

    # --- 5. losing streak vs the daily limit ----------------------------
    streak_dd = streak * risk_per_trade
    if streak_dd > max_daily:
        findings.append(_f(
            "streak_risk", "critical", "Losing streak alone can blow the daily limit",
            f"The longest losing streak was {streak} trades. At {risk_per_trade:.2f}% risk per "
            f"trade that is a {streak_dd:.2f}% drawdown — past the {max_daily:.2f}% daily cap.",
            metric="longest_losing_streak", value=streak, threshold=max_daily / max(risk_per_trade, 1e-9),
        ))
        recommendations.append(_r(
            "Cut risk per trade",
            f"Reduce risk per trade to at most {max_daily / max(streak, 1):.2f}% so a repeat of "
            f"the worst {streak}-trade streak stays inside the daily limit.",
            "high", "reduce_risk",
        ))
    elif streak_dd > max_daily * 0.6:
        findings.append(_f(
            "streak_risk_watch", "warning", "Losing streak eats most of the daily budget",
            f"A {streak}-trade streak at {risk_per_trade:.2f}% risk consumes "
            f"{streak_dd / max_daily * 100:.0f}% of the daily limit.",
            metric="longest_losing_streak", value=streak, threshold=max_daily / max(risk_per_trade, 1e-9),
        ))

    # --- 6. expectancy ---------------------------------------------------
    if total_trades > 0 and expectancy < 0.05:
        findings.append(_f(
            "low_expectancy", "critical", "Negative-to-flat expectancy",
            f"Expectancy {expectancy:.3f}R per trade is too small to outrun costs.",
            metric="expectancy_r", value=expectancy, threshold=0.05,
        ))
    elif total_trades > 0 and expectancy < 0.2:
        findings.append(_f(
            "thin_expectancy", "warning", "Thin expectancy",
            f"Expectancy {expectancy:.3f}R. Healthy systematic edges sit above ~0.25R.",
            metric="expectancy_r", value=expectancy, threshold=0.2,
        ))

    # --- 7. risk-adjusted return -----------------------------------------
    if total_trades > 20 and sharpe < 0.3:
        findings.append(_f(
            "low_sharpe", "warning", "Low risk-adjusted return",
            f"Sharpe {sharpe:.2f}. Returns are not compensated for their volatility.",
            metric="sharpe", value=sharpe, threshold=0.3,
        ))

    # --- 8. trade frequency ----------------------------------------------
    if total_trades > 0:
        if trades_per_week < 1:
            findings.append(_f(
                "too_rare", "warning", "Signal frequency too low",
                f"Estimated {trades_per_week:.2f} trades/week. Under ~1/week it takes years "
                "to accumulate a validated sample.",
                metric="est_trades_per_week", value=trades_per_week, threshold=1.0,
            ))
        elif trades_per_week > 40:
            findings.append(_f(
                "too_frequent", "info", "Very high trade frequency",
                f"Estimated {trades_per_week:.1f} trades/week — check that costs and "
                "prop-firm consistency rules are modelled.",
                metric="est_trades_per_week", value=trades_per_week, threshold=40.0,
            ))

    # --- 9. walk-forward / overfitting guard ------------------------------
    regime = {"trend": "unknown", "volatility": "unknown", "walk_forward": "n/a"}
    if in_sample and out_of_sample and int(in_sample.get("total_trades", 0) or 0) > 0:
        is_pf = float(in_sample.get("profit_factor", 0.0) or 0.0)
        oos_pf = float(out_of_sample.get("profit_factor", 0.0) or 0.0)
        is_sharpe = float(in_sample.get("sharpe", 0.0) or 0.0)
        oos_sharpe = float(out_of_sample.get("sharpe", 0.0) or 0.0)
        retention = (oos_pf / is_pf) if is_pf > 0 else 0.0
        regime["walk_forward"] = f"{retention * 100:.0f}% PF retention"
        if oos_pf < 1.0 and is_pf >= 1.2:
            findings.append(_f(
                "overfit", "critical", "Probable overfit — edge collapses out of sample",
                f"In-sample PF {is_pf:.2f} vs out-of-sample PF {oos_pf:.2f}. Parameters were "
                "likely fitted to noise.",
                metric="oos_profit_factor", value=oos_pf, threshold=1.0,
            ))
            recommendations.append(_r(
                "Re-optimise with wider bounds",
                "Re-run the optimiser with fewer free parameters and wider bounds, then "
                "re-validate on a fresh out-of-sample window.",
                "high", "reoptimize",
            ))
        elif retention < 0.6:
            findings.append(_f(
                "decay_walkforward", "warning", "Edge degrades out of sample",
                f"Only {retention * 100:.0f}% of in-sample profit factor survived "
                "(target ≥ 60%).",
                metric="oos_retention", value=round(retention, 3), threshold=0.6,
            ))
        if is_sharpe > 0 and oos_sharpe < is_sharpe * 0.4:
            findings.append(_f(
                "sharpe_decay", "warning", "Sharpe collapses out of sample",
                f"In-sample Sharpe {is_sharpe:.2f} → out-of-sample {oos_sharpe:.2f}.",
                metric="oos_sharpe", value=oos_sharpe, threshold=is_sharpe * 0.4,
            ))

    # --- 10. decay detection across the trade sequence ---------------------
    decay = {"recent_expectancy_r": None, "prior_expectancy_r": None, "ratio": None, "state": "unknown"}
    if trades:
        r_values = [float(t.get("r_multiple", 0.0) or 0.0) for t in trades]
        if len(r_values) >= 8:
            half = len(r_values) // 2
            prior = sum(r_values[:half]) / half
            recent = sum(r_values[half:]) / (len(r_values) - half)
            ratio = (recent / prior) if abs(prior) > 1e-9 else 0.0
            decay = {
                "recent_expectancy_r": round(recent, 3),
                "prior_expectancy_r": round(prior, 3),
                "ratio": round(ratio, 3),
                "state": "stable",
            }
            if prior > 0 and recent < prior * 0.5:
                decay["state"] = "decaying"
                findings.append(_f(
                    "decay", "warning", "Expectancy is decaying",
                    f"Recent expectancy {recent:.3f}R vs {prior:.3f}R in the first half "
                    "of the sample — classic strategy-decay signature.",
                    metric="decay_ratio", value=round(ratio, 3), threshold=0.5,
                ))
                recommendations.append(_r(
                    "Flag for regime review",
                    "Freeze autonomous trading for this strategy and re-optimise on the "
                    "most recent 30% of data before re-arming it.",
                    "high", "reoptimize",
                ))
            elif prior > 0 and recent > prior * 1.25:
                decay["state"] = "improving"
            # crude volatility regime read from the dispersion of R outcomes
            mean_r = sum(r_values) / len(r_values)
            var = sum((x - mean_r) ** 2 for x in r_values) / max(1, len(r_values) - 1)
            std_r = math.sqrt(var)
            regime["volatility"] = "high" if std_r > 1.6 else ("normal" if std_r > 0.7 else "low")
            regime["trend"] = (
                "trending" if win_rate < 55 and profit_factor > 1.3 else
                ("mean_reverting" if win_rate > 60 else "mixed")
            )

    # --- 11. comparison against the active baseline ------------------------
    if baseline_metrics and int(baseline_metrics.get("total_trades", 0) or 0) > 0:
        base_pf = float(baseline_metrics.get("profit_factor", 0.0) or 0.0)
        if base_pf > 0 and profit_factor < base_pf * 0.9:
            findings.append(_f(
                "regression_vs_baseline", "warning", "Regression vs the active parameter set",
                f"Profit factor {profit_factor:.2f} is below the active baseline {base_pf:.2f}.",
                metric="profit_factor", value=profit_factor, threshold=base_pf,
            ))
            recommendations.append(_r(
                "Roll back to the baseline version",
                "The lineage view can revert the active parameters to the last known-good "
                "optimisation in one click.",
                "medium", "rollback",
            ))

    # --- 12. risk of ruin --------------------------------------------------
    if total_trades > 10:
        p = win_rate / 100.0
        ruin_trades = None
        if 0 < p < 1 and risk_per_trade > 0:
            # probability that a streak of consecutive losses hits the total cap
            k = math.ceil(max_total / risk_per_trade)
            if k > 0:
                ruin_trades = k
                prob = ((1 - p) ** k) * max(1, total_trades - k + 1)
                if prob > 0.25:
                    findings.append(_f(
                        "ruin_risk", "critical", "Material risk of ruin",
                        f"At {risk_per_trade:.2f}% risk/trade a {k}-trade losing streak breaches "
                        f"the {max_total:.2f}% total cap; the modelled probability over this "
                        f"sample is {prob * 100:.0f}%.",
                        metric="ruin_probability", value=round(prob, 3), threshold=0.25,
                    ))

    # --- score + verdict ----------------------------------------------------
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    score = max(0, min(100, int(round(100 - penalty))))
    if any(f["severity"] == "critical" for f in findings):
        verdict = "critical"
    elif score >= 80:
        verdict = "healthy"
    elif score >= 55:
        verdict = "watch"
    else:
        verdict = "degraded"

    if not recommendations:
        if verdict in {"healthy", "watch"}:
            recommendations.append(_r(
                "Promote to shadow trading",
                "Statistics are inside the prop-firm envelope. Run shadow mode for one to two "
                "weeks before committing capital.",
                "low", "promote_shadow",
            ))
        else:
            recommendations.append(_r(
                "Re-optimise parameters",
                "Run the Optuna optimiser to search for a parameter set that clears the "
                "prop-firm drawdown caps.",
                "medium", "reoptimize",
            ))

    positives = []
    if profit_factor >= 1.3:
        positives.append(f"Profit factor {profit_factor:.2f} clears the 1.3 institutional bar.")
    if expectancy >= 0.25:
        positives.append(f"Expectancy {expectancy:.2f}R per trade is robust.")
    if max_dd <= max_total * 0.6 and total_trades > 0:
        positives.append(f"Drawdown {max_dd:.2f}% sits comfortably inside the {max_total:.2f}% cap.")
    if sharpe >= 1.0:
        positives.append(f"Sharpe {sharpe:.2f} indicates efficient risk-adjusted returns.")

    summary = (
        f"{strategy_name}: {verdict.upper()} ({score}/100). "
        f"{total_trades} trades · {win_rate:.1f}% win rate · PF {profit_factor:.2f} · "
        f"expectancy {expectancy:.2f}R · max DD {max_dd:.2f}% · net {net_return:.2f}%. "
        + ("No blocking issues found." if not findings else
           f"{sum(1 for f in findings if f['severity'] == 'critical')} critical, "
           f"{sum(1 for f in findings if f['severity'] == 'warning')} warnings.")
    )

    return {
        "engine": "python-statistical",
        "engine_label": "Python Statistical Diagnostic Engine",
        "score": score,
        "verdict": verdict,
        "summary": summary,
        "findings": findings,
        "recommendations": recommendations,
        "positives": positives,
        "regime": regime,
        "decay": decay,
        "breakeven_win_rate": round(breakeven_wr, 2),
        "thresholds": {
            "max_daily_drawdown_pct": max_daily,
            "max_total_drawdown_pct": max_total,
            "risk_per_trade_pct": risk_per_trade,
        },
    }
