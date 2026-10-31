"""Bayesian parameter search (Optuna) with a dependency-free random-search twin.

Optuna is used when it is importable; otherwise the exact same objective is
driven by a seeded random search so the studio still works on installs that
cannot carry the scientific stack (e.g. serverless deployments).

Overfitting control
-------------------
The objective is scored **in-sample only** (the first ``split`` of the series).
The untouched tail is used purely for validation and is reported alongside the
result, together with an ``overfit_risk`` flag, so a beautiful in-sample curve
cannot quietly ship.
"""

from __future__ import annotations

import math
import random
from typing import Any, Callable, Dict, List, Optional, Sequence

from .backtester import run_backtest
from .validator import StrategySpec, _bounds_for

try:  # optional
    import optuna  # type: ignore
    from optuna.samplers import TPESampler  # type: ignore
    from optuna.logging import set_verbosity, WARNING as OPTUNA_WARNING  # type: ignore
except Exception:  # pragma: no cover
    optuna = None  # type: ignore
    TPESampler = None  # type: ignore

OBJECTIVES = {
    "sharpe": lambda m: float(m.get("sharpe", 0.0)),
    "expectancy": lambda m: float(m.get("expectancy_r", 0.0)),
    "profit_factor": lambda m: float(m.get("profit_factor", 0.0)),
    "prop_readiness": lambda m: float(m.get("prop_readiness", 0.0)) / 25.0,
    "net_return": lambda m: float(m.get("net_return_pct", 0.0)) / 5.0,
}

OBJECTIVE_LABELS = {
    "sharpe": "Sharpe ratio",
    "expectancy": "Expectancy (R)",
    "profit_factor": "Profit factor",
    "prop_readiness": "Prop-firm readiness",
    "net_return": "Net return %",
}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def make_objective(
    spec: StrategySpec,
    bars: List[Dict[str, float]],
    *,
    objective_name: str,
    split: float,
    seed: int,
    max_daily_dd_pct: float,
    max_total_dd_pct: float,
    initial_equity: float,
) -> Callable[[Dict[str, float]], Dict[str, Any]]:
    """Build the evaluation function shared by Optuna and the random search."""
    primary = OBJECTIVES.get(objective_name, OBJECTIVES["sharpe"])

    def evaluate(parameters: Dict[str, float]) -> Dict[str, Any]:
        result = run_backtest(
            spec,
            bars,
            seed=seed,
            split=split,
            initial_equity=initial_equity,
            max_daily_dd_pct=max_daily_dd_pct,
            max_total_dd_pct=max_total_dd_pct,
            parameters=parameters,
        )
        in_m = result.in_sample
        out_m = result.out_of_sample
        trades = int(in_m.get("total_trades", 0) or 0)

        score = primary(in_m)
        # --- regularisation: punish thin samples and drawdown breaches -----
        if trades < 10:
            score -= (10 - trades) * 0.35
        drawdown = float(in_m.get("max_drawdown_pct", 0.0) or 0.0)
        if drawdown > max_total_dd_pct:
            score -= (drawdown - max_total_dd_pct) * 1.5
        elif drawdown > max_total_dd_pct * 0.7:
            score -= (drawdown - max_total_dd_pct * 0.7) * 0.6
        daily_dd = float(in_m.get("max_daily_drawdown_pct", 0.0) or 0.0)
        if daily_dd > max_daily_dd_pct:
            score -= (daily_dd - max_daily_dd_pct) * 2.0
        if float(in_m.get("profit_factor", 0.0) or 0.0) < 1.0:
            score -= 1.5
        return {
            "score": score,
            "in_sample": in_m,
            "out_of_sample": out_m,
            "parameters": parameters,
            "trades": trades,
        }

    return evaluate


def optimize(
    spec: StrategySpec,
    bars: Optional[List[Dict[str, float]]] = None,
    *,
    n_trials: int = 40,
    objective: str = "sharpe",
    param_bounds: Optional[Dict[str, List[float]]] = None,
    seed: int = 7,
    split: float = 0.7,
    initial_equity: float = 10_000.0,
    max_daily_dd_pct: float = 3.5,
    max_total_dd_pct: float = 5.0,
    bars_count: int = 3000,
    progress: Optional[Callable[[int, int, float], None]] = None,
) -> Dict[str, Any]:
    """Search the parameter space and return the best version + full history."""
    from .backtester import generate_bars  # local import avoids a cycle at import time

    if bars is None:
        bars = generate_bars(spec.symbol, spec.timeframe, bars_count, seed)

    space = param_bounds or _bounds_for(spec.parameters or {})
    space = {k: v for k, v in space.items() if isinstance(v, (list, tuple)) and len(v) == 2}
    if not space:
        space = _bounds_for(spec.parameters or {})

    base_params = {k: float(v) for k, v in (spec.parameters or {}).items() if _num(v)}
    evaluate = make_objective(
        spec, bars, objective_name=objective, split=split, seed=seed,
        max_daily_dd_pct=max_daily_dd_pct, max_total_dd_pct=max_total_dd_pct,
        initial_equity=initial_equity,
    )

    baseline = evaluate(base_params)
    history: List[Dict[str, Any]] = []
    best = dict(baseline)
    best["trial"] = 0
    history.append({
        "trial": 0,
        "value": round(baseline["score"], 5),
        "parameters": {k: round(v, 5) for k, v in base_params.items()},
        "is_baseline": True,
    })

    engine = "random-search"
    if optuna is not None:
        engine = "optuna-tpe"
        try:
            set_verbosity(OPTUNA_WARNING)
        except Exception:
            pass
    else:
        engine = "random-search"

    def record(trial_no: int, params: Dict[str, float]) -> None:
        nonlocal best
        outcome = evaluate(params)
        value = outcome["score"]
        history.append({
            "trial": trial_no,
            "value": round(value, 5),
            "parameters": {k: round(v, 5) for k, v in params.items()},
            "is_baseline": False,
        })
        if value > best["score"]:
            best = dict(outcome)
            best["trial"] = trial_no
        if progress:
            progress(trial_no, n_trials, value)

    if optuna is not None:
        def _optuna_objective(trial: "optuna.Trial") -> float:
            params = dict(base_params)
            for name, (low, high) in space.items():
                low, high = float(low), float(high)
                if low > high:
                    low, high = high, low
                current = float(params.get(name, (low + high) / 2.0))
                if _is_int_like(name):
                    params[name] = float(trial.suggest_int(
                        name, int(round(low)), int(round(high)),
                    ))
                else:
                    params[name] = float(trial.suggest_float(name, low, high))
                del current
            record(trial.number + 1, params)
            return float(history[-1]["value"])

        sampler = TPESampler(seed=seed, n_startup_trials=min(8, max(1, n_trials // 3)))
        study = optuna.create_study(direction="maximize", sampler=sampler)
        study.optimize(_optuna_objective, n_trials=max(1, int(n_trials)), show_progress_bar=False)
    else:
        rng = random.Random(seed)
        for trial_no in range(1, max(1, int(n_trials)) + 1):
            params = dict(base_params)
            for name, (low, high) in space.items():
                low, high = float(low), float(high)
                if low > high:
                    low, high = high, low
                value = rng.uniform(low, high)
                params[name] = float(round(value)) if _is_int_like(name) else round(value, 5)
            record(trial_no, params)

    best_params = {k: float(v) for k, v in best["parameters"].items()}

    # final untouched-tail validation of the winning parameter set
    final = run_backtest(
        spec, bars, seed=seed, split=split, initial_equity=initial_equity,
        max_daily_dd_pct=max_daily_dd_pct, max_total_dd_pct=max_total_dd_pct,
        parameters=best_params,
    )

    is_pf = float(best["in_sample"].get("profit_factor", 0.0) or 0.0)
    oos_pf = float(final.out_of_sample.get("profit_factor", 0.0) or 0.0)
    retention = (oos_pf / is_pf) if is_pf > 0 else 0.0
    overfit_risk = "high" if (is_pf >= 1.2 and oos_pf < 1.0) else (
        "medium" if retention < 0.6 else "low"
    )

    improvement = 0.0
    base_value = baseline["score"]
    if abs(base_value) > 1e-9:
        improvement = (best["score"] - base_value) / abs(base_value) * 100.0

    return {
        "engine": engine,
        "engine_label": "Optuna · TPE Bayesian search" if engine == "optuna-tpe"
                        else "Built-in random search (Optuna unavailable)",
        "objective": objective,
        "objective_label": OBJECTIVE_LABELS.get(objective, objective),
        "n_trials": int(max(1, n_trials)),
        "seed": seed,
        "split": split,
        "search_space": {k: [float(v[0]), float(v[1])] for k, v in space.items()},
        "best_trial": best.get("trial", 0),
        "best_parameters": {k: round(v, 5) for k, v in best_params.items()},
        "best_score": round(float(best["score"]), 5),
        "baseline_parameters": {k: round(v, 5) for k, v in base_params.items()},
        "baseline_score": round(float(base_value), 5),
        "improvement_pct": round(improvement, 2),
        "metrics": final.metrics,
        "in_sample": final.in_sample,
        "out_of_sample": final.out_of_sample,
        "baseline_metrics": final.metrics if best.get("trial", 0) == 0 else baseline["in_sample"],
        "overfit_risk": overfit_risk,
        "oos_retention": round(retention, 3),
        "history": history,
        "equity_curve": [round(x, 2) for x in final.equity_curve[:: max(1, len(final.equity_curve) // 240 or 1)]],
        "trades": [t.to_dict() for t in final.trades[:200]],
    }


_INT_PARAMS = {
    "fast_ema", "slow_ema", "rsi_period", "atr_period", "breakout_lookback",
    "max_bars", "ema_period", "lookback", "period",
}


def _is_int_like(name: str) -> bool:
    return name in _INT_PARAMS or name.endswith("_period") or name.endswith("_lookback")


def _num(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False
