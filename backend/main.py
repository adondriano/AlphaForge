"""AlphaForge — FastAPI engine.

AI-Powered Quantitative Strategy Studio & Prop-Firm Execution Engine.

Endpoints (all under ``/api``)::

    GET    /api/health                        engine + integration capabilities
    GET    /api/strategies                    list strategies
    POST   /api/strategies/create             transpile + validate + persist
    POST   /api/strategies/backtest           run the backtest engine
    POST   /api/strategies/optimize           Optuna (or random) search → new version
    POST   /api/strategies/analyze            dual engine analyst
    GET    /api/strategies/{id}/optimizations parameter lineage
    POST   /api/strategies/rollback           revert to a stored version
    POST   /api/strategies/{id}/autonomous    autonomous toggle
    PATCH  /api/strategies/{id}/status        lifecycle status
    DELETE /api/strategies/{id}
    GET    /api/trade-logs
    POST   /api/execution/order               prop-firm shielded order entry
    POST   /api/execution/paper-run           shielded paper session (realtime feed)
    GET    /api/risk/status                   drawdown envelope state
    POST   /api/risk/reset
    GET/POST /api/settings
    POST   /api/seed                          (re)create the demo strategies
    WS     /ws/trades                         live execution stream

Run locally::

    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:  # `uvicorn main:app` from inside backend/
    from services import llm as llm_service
    from services import mt5_executor
    from services.backtester import generate_bars, run_backtest
    from services.optuna_optimizer import optimize as run_optimizer
    from services.python_analyzer import analyze_strategy
    from services.risk import shield_from
    from services.settings import DEFAULT_SETTINGS, Settings, SettingsUpdate, load_settings_from_env
    from services.store import store
    from services.validator import (
        DEFAULT_PARAMETERS,
        StrategySpec,
        _bounds_for,
        parse_manual_json,
    )
except ImportError:  # pragma: no cover - imported as part of a package
    from .services import llm as llm_service
    from .services import mt5_executor
    from .services.backtester import generate_bars, run_backtest
    from .services.optuna_optimizer import optimize as run_optimizer
    from .services.python_analyzer import analyze_strategy
    from .services.risk import shield_from
    from .services.settings import DEFAULT_SETTINGS, Settings, SettingsUpdate, load_settings_from_env
    from .services.store import store
    from .services.validator import (
        DEFAULT_PARAMETERS,
        StrategySpec,
        _bounds_for,
        parse_manual_json,
    )


# ---------------------------------------------------------------------------
# App state
# ---------------------------------------------------------------------------
_state: Dict[str, Any] = {
    "settings": Settings(**{**DEFAULT_SETTINGS, **load_settings_from_env()}),
}

_TRADE_LISTENERS: List[asyncio.Queue] = []
ACCOUNT: Dict[str, Any] = {
    "starting_equity": 10_000.0,
    "equity": 10_000.0,
    "day_start_equity": 10_000.0,
    "peak_equity": 10_000.0,
    "open_positions": 0,
    "day": time.strftime("%Y-%m-%d", time.gmtime()),
    "trades": 0,
    "blocked": 0,
}


def get_settings() -> Settings:
    return _state["settings"]


def _apply_settings_patch(patch: Dict[str, Any]) -> Settings:
    current = get_settings().model_dump()
    merged = {**current, **{k: v for k, v in patch.items() if v is not None}}
    settings = Settings(**merged)
    _state["settings"] = settings
    return settings


def _configure_store(settings: Settings) -> None:
    store.configure(settings.NEXT_PUBLIC_SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
    # The MT5 relay talks to the same project, but with the service-role key so
    # it can reach the (deliberately anon-denied) bridge tables.
    mt5_executor.relay.configure(
        settings.NEXT_PUBLIC_SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY
    )


def _roll_day() -> None:
    """Reset the daily baseline at UTC midnight (prop-firm day boundary)."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    if ACCOUNT["day"] != today:
        ACCOUNT["day"] = today
        ACCOUNT["day_start_equity"] = ACCOUNT["equity"]


def _shield():
    return shield_from(get_settings())


def _broadcast(event: Dict[str, Any]) -> None:
    for queue in list(_TRADE_LISTENERS):
        try:
            queue.put_nowait(event)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Mapping helpers
# ---------------------------------------------------------------------------
def spec_from_row(row: Dict[str, Any]) -> StrategySpec:
    rules = row.get("rules") or {}
    payload: Dict[str, Any] = {
        "name": row.get("name") or "Untitled Strategy",
        "symbol": row.get("symbol") or "XAUUSD",
        "timeframe": row.get("timeframe") or "H1",
        "description": row.get("description") or "",
        "source_type": row.get("source_type") or "text",
        "source_url": row.get("source_url") or "",
        "side": rules.get("side") or "both",
        "entries": rules.get("entries") or [],
        "exits": rules.get("exits") or [],
        "filters": rules.get("filters") or [],
        "parameters": {**DEFAULT_PARAMETERS, **(row.get("parameters") or {})},
        "risk": row.get("risk_profile") or {},
    }
    spec, errors = None, []
    try:
        spec = StrategySpec(**payload)
    except Exception as exc:
        errors = [str(exc)]
    if spec is None:
        # last-resort: never let a malformed row take the API down
        spec = StrategySpec(name=payload["name"], symbol=payload["symbol"],
                            timeframe=payload["timeframe"])
        if errors:
            spec.description = (spec.description + " [spec repair: " + errors[0][:200] + "]").strip()
    return spec


def row_from_spec(spec: StrategySpec) -> Dict[str, Any]:
    return {
        "name": spec.name,
        "symbol": spec.symbol,
        "timeframe": spec.timeframe,
        "description": spec.description,
        "source_type": spec.source_type,
        "source_url": spec.source_url,
        "rules": {
            "side": spec.side,
            "entries": [r.model_dump() for r in spec.entries],
            "exits": [r.model_dump() for r in spec.exits],
            "filters": [r.model_dump() for r in spec.filters],
        },
        "parameters": dict(spec.parameters),
        "risk_profile": spec.risk.model_dump(),
    }


def metrics_patch(metrics: Dict[str, float]) -> Dict[str, Any]:
    return {
        "win_rate": round(float(metrics.get("win_rate", 0.0) or 0.0), 4),
        "total_trades": int(metrics.get("total_trades", 0) or 0),
        "net_return_pct": round(float(metrics.get("net_return_pct", 0.0) or 0.0), 4),
        "max_drawdown_pct": round(float(metrics.get("max_drawdown_pct", 0.0) or 0.0), 4),
        "profit_factor": round(float(metrics.get("profit_factor", 0.0) or 0.0), 4),
        "sharpe": round(float(metrics.get("sharpe", 0.0) or 0.0), 4),
        "expectancy_r": round(float(metrics.get("expectancy_r", 0.0) or 0.0), 4),
        "prop_readiness": round(float(metrics.get("prop_readiness", 0.0) or 0.0), 2),
        "est_trades_per_week": round(float(metrics.get("est_trades_per_week", 0.0) or 0.0), 2),
    }


def public_strategy(row: Dict[str, Any]) -> Dict[str, Any]:
    """Shape a DB row for the frontend (parameters coerced to numbers)."""
    out = dict(row)
    out["parameters"] = {k: _num_or(v, 0.0) for k, v in (row.get("parameters") or {}).items()}
    out["risk_profile"] = row.get("risk_profile") or {}
    out["rules"] = row.get("rules") or {}
    for key in ("win_rate", "net_return_pct", "max_drawdown_pct", "profit_factor",
                "sharpe", "expectancy_r", "prop_readiness", "est_trades_per_week"):
        out[key] = _num_or(row.get(key), 0.0)
    out["total_trades"] = int(row.get("total_trades") or 0)
    out["autonomous"] = bool(row.get("autonomous"))
    return out


def _num_or(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _detect_source_type(url: str, explicit: str = "") -> str:
    if explicit:
        return explicit
    lowered = (url or "").lower()
    if "youtube.com" in lowered or "youtu.be" in lowered:
        return "youtube"
    if "tiktok.com" in lowered:
        return "tiktok"
    if "facebook.com" in lowered or "fb.watch" in lowered:
        return "youtube"
    return "text"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class CreateRequest(BaseModel):
    name: Optional[str] = None
    user_id: Optional[str] = None
    source_url: str = ""
    text: str = ""
    transcript: str = ""
    json_spec: Optional[Any] = None
    no_llm: bool = False
    source_type: Optional[str] = None
    symbol: Optional[str] = None
    timeframe: Optional[str] = None
    parameters: Optional[Dict[str, float]] = None
    bars: int = 2400
    seed: int = 7
    auto_backtest: bool = True


class TranspileRequest(BaseModel):
    """Compute-only transpile (no persistence) — the frontend owns storage."""

    text: str = ""
    source_url: str = ""
    transcript: str = ""
    no_llm: bool = True
    source_type: Optional[str] = None
    name: Optional[str] = None
    symbol: Optional[str] = None
    timeframe: Optional[str] = None


class ComputeBacktestRequest(BaseModel):
    spec: Dict[str, Any]
    bars: int = 3000
    seed: int = 7
    split: float = 0.7
    initial_equity: float = 10_000.0


class ComputeOptimizeRequest(BaseModel):
    spec: Dict[str, Any]
    n_trials: int = 40
    objective: str = "sharpe"
    param_bounds: Optional[Dict[str, List[float]]] = None
    seed: int = 7
    bars: int = 3000
    split: float = 0.7


class ComputeAnalyzeRequest(BaseModel):
    spec: Dict[str, Any]
    bars: int = 3000
    seed: int = 7
    split: float = 0.7
    no_llm: bool = True
    baseline_metrics: Optional[Dict[str, float]] = None


class BacktestRequest(BaseModel):
    strategy_id: Optional[str] = None
    spec: Optional[Dict[str, Any]] = None
    parameters: Optional[Dict[str, float]] = None
    bars: int = 3000
    seed: int = 7
    split: float = 0.7
    initial_equity: float = 10_000.0
    log_trades: bool = False


class OptimizeRequest(BaseModel):
    strategy_id: str
    user_id: Optional[str] = None
    n_trials: int = 40
    objective: str = "sharpe"
    param_bounds: Optional[Dict[str, List[float]]] = None
    seed: int = 7
    bars: int = 3000
    split: float = 0.7
    apply: bool = True
    label: Optional[str] = None


class AnalyzeRequest(BaseModel):
    strategy_id: str
    no_llm: bool = False
    bars: int = 3000
    seed: int = 7
    split: float = 0.7


class RollbackRequest(BaseModel):
    strategy_id: str
    optimization_id: str
    label: Optional[str] = None


class AutonomousRequest(BaseModel):
    enabled: bool


class StatusRequest(BaseModel):
    status: str


class OrderRequest(BaseModel):
    strategy_id: Optional[str] = None
    optimization_id: Optional[str] = None
    symbol: str = "XAUUSD"
    side: str = "buy"
    volume: float = 0.01
    price: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    mode: str = "paper"
    risk_pct: Optional[float] = None


class PaperRunRequest(BaseModel):
    strategy_id: str
    n_trades: int = 12
    mode: str = "paper"
    seed: int = 7
    bars: int = 1500


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    # Stored settings (Settings tab) sit between defaults and environment vars.
    try:
        stored = store.get_settings() if store.enabled else {}
    except Exception:
        stored = {}
    if stored:
        settings = _apply_settings_patch({k: v for k, v in stored.items() if v not in (None, "")})
    settings = _apply_settings_patch(load_settings_from_env())
    _configure_store(settings)
    if store.enabled:
        stored = store.get_settings() or {}
        if stored:
            settings = _apply_settings_patch(
                {k: v for k, v in stored.items()
                 if v not in (None, "") and k not in os.environ}
            )
    if os.getenv("ALPHAFORGE_SEED", "1") != "0":
        try:
            _seed_if_empty()
        except Exception as exc:  # seeding must never block boot
            print(f"[alphaforge] seed skipped: {exc}")
    print(f"[alphaforge] booted · store={store.mode} · llm={settings.llm_provider} · "
          f"optuna={'yes' if _has_optuna() else 'no'}")
    yield


def _has_optuna() -> bool:
    try:
        import optuna  # noqa: F401
        return True
    except Exception:
        return False


app = FastAPI(
    title="AlphaForge Engine",
    description="AI-Powered Quantitative Strategy Studio & Prop-Firm Execution Engine",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=r".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=86400,
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/")
def root() -> Dict[str, Any]:
    settings = get_settings()
    return {
        "service": "AlphaForge Engine",
        "version": "1.0.0",
        "docs": "/docs",
        "store": store.mode,
        "llm_provider": settings.llm_provider,
        "opts": {"optuna": _has_optuna()},
    }


@app.get("/api/health")
def health() -> Dict[str, Any]:
    settings = get_settings()
    _roll_day()
    return {
        "status": "ok",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "engine": {
            "backtest": "alphaforge-core",
            "optimizer": "optuna-tpe" if _has_optuna() else "random-search",
            "analyzer": "python-statistical",
        },
        "integrations": {
            "supabase": store.health(),
            "llm": {
                "provider": settings.llm_provider,
                "model": settings.OPENAI_MODEL if settings.OPENAI_API_KEY else
                         (settings.OLLAMA_MODEL if settings.ollama_reachable_url else None),
            },
            "mt5": mt5_executor.bridge.status(settings),
            "mt5_relay": {
                "enabled": mt5_executor.relay.enabled,
                "error": mt5_executor.relay.last_error,
                "bridges": [
                    {
                        "id": b.get("id"),
                        "name": b.get("name"),
                        "status": b.get("status"),
                        "age_seconds": b.get("_age_seconds"),
                    }
                    for b in mt5_executor.relay.active_bridges()
                ],
            },
        },
        "risk": {
            **_shield().to_dict(),
            "equity": ACCOUNT["equity"],
            "day_start_equity": ACCOUNT["day_start_equity"],
            "peak_equity": ACCOUNT["peak_equity"],
            "open_positions": ACCOUNT["open_positions"],
        },
    }


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------
@app.get("/api/strategies")
def list_strategies(refresh: bool = Query(False)) -> Dict[str, Any]:
    rows = store.list_strategies()
    return {
        "strategies": [public_strategy(r) for r in rows],
        "count": len(rows),
        "store": store.mode,
    }


@app.get("/api/strategies/{strategy_id}")
def get_strategy(strategy_id: str) -> Dict[str, Any]:
    row = store.get_strategy(strategy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return {"strategy": public_strategy(row)}


@app.post("/api/strategies/create")
def create_strategy(payload: CreateRequest) -> Dict[str, Any]:
    settings = get_settings()
    source_type = _detect_source_type(payload.source_url, payload.source_type or "")

    raw_text = (payload.transcript or payload.text or "").strip()
    if not raw_text and payload.source_url and not payload.json_spec:
        raw_text = f"Strategy described by the video at {payload.source_url}."
        note = ("Video URL supplied without a transcript — the engine used URL context only. "
                "Paste the transcript for a faithful transpile.")
    else:
        note = None

    meta: Dict[str, Any] = {"engine": "manual-json"}
    if payload.json_spec is not None:
        raw = payload.json_spec if isinstance(payload.json_spec, str) else _json_dumps(payload.json_spec)
        result = parse_manual_json(raw)
        if not result.ok:
            raise HTTPException(status_code=422, detail={"errors": result.errors,
                                                         "warnings": result.warnings})
        spec = result.spec
        meta = {"engine": "manual-json", "warnings": result.warnings}
        source_type = "json"
    else:
        if not raw_text:
            raise HTTPException(status_code=422, detail="Provide text, a video URL or a JSON spec.")
        spec_dict, meta = llm_service.transpile(
            raw_text, source_url=payload.source_url, source_type=source_type,
            settings=settings, no_llm=payload.no_llm,
        )
        if payload.name:
            spec_dict["name"] = payload.name
        if payload.symbol:
            spec_dict["symbol"] = payload.symbol
        if payload.timeframe:
            spec_dict["timeframe"] = payload.timeframe
        result = parse_manual_json(_json_dumps(spec_dict))
        if not result.ok:
            # Never lose the user's input: fall back to the heuristic transpiler.
            spec_dict, fallback_meta = llm_service.transpile(
                raw_text, source_url=payload.source_url, source_type=source_type,
                settings=None, no_llm=True,
            )
            if payload.name:
                spec_dict["name"] = payload.name
            result = parse_manual_json(_json_dumps(spec_dict))
            if not result.ok:
                raise HTTPException(status_code=422, detail={"errors": result.errors})
            meta = {**meta, "repaired_by": "heuristic", **fallback_meta}
        spec = result.spec
        meta["warnings"] = result.warnings

    if payload.parameters:
        merged = dict(spec.parameters)
        merged.update({k: float(v) for k, v in payload.parameters.items()})
        spec = spec.model_copy(update={"parameters": merged})

    # ---- persist ---------------------------------------------------------
    row_payload = row_from_spec(spec)
    row_payload.update({
        "status": "draft",
        "autonomous": bool(settings.AUTONOMOUS_DEFAULT),
        "user_id": payload.user_id,
        **metrics_patch({}),
    })
    row = store.insert_strategy(row_payload)

    backtest_report: Optional[Dict[str, Any]] = None
    if payload.auto_backtest:
        backtest_report = _run_and_persist(spec, row, seed=payload.seed, bars=payload.bars)
        row = store.get_strategy(row["id"]) or row

    # ---- baseline version (v1) -------------------------------------------
    optimization = store.insert_optimization({
        "strategy_id": row["id"],
        "version": 1,
        "label": "Baseline (v1)",
        "engine": meta.get("engine") or "manual-json",
        "parameters": dict(spec.parameters),
        "param_bounds": _bounds_for(dict(spec.parameters)),
        "metrics": (backtest_report or {}).get("metrics", {}),
        "n_trials": 0,
        "direction": "maximize",
        "objective_name": "sharpe",
        "is_active": True,
        "is_baseline": True,
        "user_id": payload.user_id,
        "notes": "Initial parameter set captured at creation.",
    })
    store.set_active_optimization(row["id"], optimization["id"])
    store.update_strategy(row["id"], {"active_optimization_id": optimization["id"]})
    row = store.get_strategy(row["id"]) or row

    return {
        "strategy": public_strategy(row),
        "optimization": optimization,
        "backtest": backtest_report,
        "meta": {**meta, "note": note},
    }


@app.post("/api/strategies/transpile")
def transpile(payload: TranspileRequest) -> Dict[str, Any]:
    """Turn a video URL / transcript / prose into a validated spec. No writes."""
    settings = get_settings()
    source_type = _detect_source_type(payload.source_url, payload.source_type or "")
    raw_text = (payload.transcript or payload.text or "").strip()
    if not raw_text:
        raise HTTPException(status_code=422, detail="Provide text or a transcript.")

    spec_dict, meta = llm_service.transpile(
        raw_text, source_url=payload.source_url, source_type=source_type,
        settings=settings, no_llm=payload.no_llm,
    )
    if payload.name:
        spec_dict["name"] = payload.name
    if payload.symbol:
        spec_dict["symbol"] = payload.symbol
    if payload.timeframe:
        spec_dict["timeframe"] = payload.timeframe

    result = parse_manual_json(_json_dumps(spec_dict))
    if not result.ok:
        spec_dict, fallback_meta = llm_service.transpile(
            raw_text, source_url=payload.source_url, source_type=source_type,
            settings=None, no_llm=True,
        )
        if payload.name:
            spec_dict["name"] = payload.name
        result = parse_manual_json(_json_dumps(spec_dict))
        if not result.ok:
            raise HTTPException(status_code=422, detail={"errors": result.errors})
        meta = {**meta, "repaired_by": "heuristic", **fallback_meta}

    spec = result.spec
    return {
        "spec": {
            "name": spec.name,
            "symbol": spec.symbol,
            "timeframe": spec.timeframe,
            "description": spec.description,
            "source_type": spec.source_type,
            "source_url": spec.source_url,
            "side": spec.side,
            "rules": {
                "side": spec.side,
                "entries": [r.model_dump() for r in spec.entries],
                "exits": [r.model_dump() for r in spec.exits],
                "filters": [r.model_dump() for r in spec.filters],
            },
            "parameters": dict(spec.parameters),
            "risk_profile": spec.risk.model_dump(),
        },
        "meta": {**meta, "warnings": result.warnings},
    }


@app.post("/api/strategies/backtest/compute")
def compute_backtest(payload: ComputeBacktestRequest) -> Dict[str, Any]:
    """Backtest an ad-hoc spec without touching the database."""
    settings = get_settings()
    result = parse_manual_json(_json_dumps(payload.spec))
    if not result.ok:
        raise HTTPException(status_code=422, detail={"errors": result.errors})
    report = run_backtest(
        result.spec,
        bars=None,
        bars_count=payload.bars,
        seed=payload.seed,
        split=payload.split,
        initial_equity=payload.initial_equity,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
    )
    result = report.to_dict(include_trades=True)
    result["curve"] = _curve(report, payload.split)
    return result


@app.post("/api/strategies/optimize/compute")
def compute_optimize(payload: ComputeOptimizeRequest) -> Dict[str, Any]:
    """Run the parameter search without persisting a version."""
    settings = get_settings()
    result = parse_manual_json(_json_dumps(payload.spec))
    if not result.ok:
        raise HTTPException(status_code=422, detail={"errors": result.errors})
    bars = generate_bars(result.spec.symbol, result.spec.timeframe, payload.bars, payload.seed)
    outcome = run_optimizer(
        result.spec,
        bars,
        n_trials=max(1, min(int(payload.n_trials or 40), 400)),
        objective=payload.objective or "sharpe",
        param_bounds=payload.param_bounds,
        seed=payload.seed,
        split=payload.split,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
        bars_count=payload.bars,
    )
    return {"optimization": {"version": None, "engine": outcome["engine"]}, "result": outcome}


@app.post("/api/strategies/analyze/compute")
def compute_analyze(payload: ComputeAnalyzeRequest) -> Dict[str, Any]:
    """Run the dual-engine analyst on an ad-hoc spec."""
    settings = get_settings()
    result = parse_manual_json(_json_dumps(payload.spec))
    if not result.ok:
        raise HTTPException(status_code=422, detail={"errors": result.errors})
    spec = result.spec
    report = run_backtest(
        spec,
        bars=None,
        bars_count=payload.bars,
        seed=payload.seed,
        split=payload.split,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
    )
    trades = [t.to_dict() for t in report.trades]
    analysis = analyze_strategy(
        metrics=report.metrics,
        in_sample=report.in_sample,
        out_of_sample=report.out_of_sample,
        trades=trades,
        risk_profile=spec.risk.model_dump(),
        baseline_metrics=payload.baseline_metrics,
        strategy_name=spec.name,
    )
    llm_report = llm_service.analyze(
        {**analysis, "strategy_name": spec.name}, settings=settings, no_llm=payload.no_llm
    )
    return {
        "strategy_name": spec.name,
        "engine": llm_report.get("engine") or analysis["engine"],
        "engine_label": (
            f"{llm_report['engine']} + {analysis['engine_label']}"
            if llm_report.get("engine") else analysis["engine_label"]
        ),
        "llm": llm_report,
        "metrics": report.metrics,
        "in_sample": report.in_sample,
        "out_of_sample": report.out_of_sample,
        "equity_curve": [
            round(x, 2) for x in report.equity_curve[:: max(1, len(report.equity_curve) // 240 or 1)]
        ],
        **{k: v for k, v in analysis.items() if k != "engine"},
    }


@app.post("/api/strategies/backtest")
def backtest(payload: BacktestRequest) -> Dict[str, Any]:
    settings = get_settings()
    row = None
    if payload.strategy_id:
        row = store.get_strategy(payload.strategy_id)
        if not row:
            raise HTTPException(status_code=404, detail="Strategy not found")
        spec = spec_from_row(row)
    elif payload.spec:
        result = parse_manual_json(_json_dumps(payload.spec))
        if not result.ok:
            raise HTTPException(status_code=422, detail={"errors": result.errors})
        spec = result.spec
    else:
        raise HTTPException(status_code=422, detail="Provide strategy_id or spec.")

    report = run_backtest(
        spec,
        bars=None,
        bars_count=payload.bars,
        seed=payload.seed,
        split=payload.split,
        initial_equity=payload.initial_equity,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
        parameters=payload.parameters,
    )
    result = report.to_dict(include_trades=True)
    result["curve"] = _curve(report, payload.split)

    if row is not None and not payload.parameters:
        store.update_strategy(row["id"], metrics_patch(report.metrics))
        result["strategy"] = public_strategy(store.get_strategy(row["id"]) or row)

    if payload.log_trades and row is not None:
        _log_backtest_trades(row, spec, report, mode="shadow", limit=25)

    result["strategy_id"] = (row or {}).get("id")
    return result


@app.post("/api/strategies/optimize")
def optimize_strategy(payload: OptimizeRequest) -> Dict[str, Any]:
    settings = get_settings()
    row = store.get_strategy(payload.strategy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    spec = spec_from_row(row)
    seed = payload.seed or 7

    bars = generate_bars(spec.symbol, spec.timeframe, payload.bars, seed)
    result = run_optimizer(
        spec,
        bars,
        n_trials=max(1, min(int(payload.n_trials or 40), 400)),
        objective=payload.objective or "sharpe",
        param_bounds=payload.param_bounds,
        seed=seed,
        split=payload.split,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
        bars_count=payload.bars,
    )

    version = store.next_version(payload.strategy_id)
    optimization = store.insert_optimization({
        "strategy_id": payload.strategy_id,
        "user_id": payload.user_id or row.get("user_id"),
        "version": version,
        "label": payload.label or f"{result['objective_label']} · v{version}",
        "engine": result["engine"],
        "parameters": result["best_parameters"],
        "param_bounds": result["search_space"],
        "metrics": result["metrics"],
        "n_trials": result["n_trials"],
        "direction": "maximize",
        "objective_name": payload.objective,
        "is_active": bool(payload.apply),
        "is_baseline": False,
        "notes": (
            f"{result['objective_label']} objective · {result['n_trials']} trials · "
            f"seed {seed} · in-sample score {result['best_score']} · "
            f"OOS retention {result['oos_retention']} · overfit risk {result['overfit_risk']}"
        ),
    })

    strategy_row = row
    if payload.apply:
        store.set_active_optimization(payload.strategy_id, optimization["id"])
        merged = dict(spec.parameters)
        merged.update(result["best_parameters"])
        store.update_strategy(payload.strategy_id, {
            "parameters": merged,
            "active_optimization_id": optimization["id"],
            "status": "optimized",
            **metrics_patch(result["metrics"]),
        })
        strategy_row = store.get_strategy(payload.strategy_id) or row

    return {
        "optimization": optimization,
        "result": result,
        "strategy": public_strategy(strategy_row),
    }


@app.get("/api/strategies/{strategy_id}/optimizations")
def list_optimizations(strategy_id: str) -> Dict[str, Any]:
    rows = store.list_optimizations(strategy_id)
    active = next((r for r in rows if r.get("is_active")), None)
    return {
        "optimizations": rows,
        "active_id": (active or {}).get("id"),
        "count": len(rows),
    }


@app.post("/api/strategies/rollback")
def rollback(payload: RollbackRequest) -> Dict[str, Any]:
    row = store.get_strategy(payload.strategy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    target = next(
        (o for o in store.list_optimizations(payload.strategy_id)
         if o.get("id") == payload.optimization_id),
        None,
    )
    if not target:
        raise HTTPException(status_code=404, detail="Optimization version not found")

    store.set_active_optimization(payload.strategy_id, payload.optimization_id)
    store.update_strategy(payload.strategy_id, {
        "parameters": {**(row.get("parameters") or {}), **(target.get("parameters") or {})},
        "active_optimization_id": payload.optimization_id,
        **metrics_patch(dict(target.get("metrics") or {})),
    })
    if payload.label:
        store.update_strategy(payload.strategy_id, {})  # touch updated_at
    updated = store.get_strategy(payload.strategy_id) or row
    _broadcast({
        "type": "rollback",
        "strategy_id": payload.strategy_id,
        "optimization_id": payload.optimization_id,
        "version": target.get("version"),
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    return {
        "strategy": public_strategy(updated),
        "optimization": target,
        "message": f"Active parameters rolled back to version {target.get('version')}.",
    }


@app.post("/api/strategies/{strategy_id}/rollback/{optimization_id}")
def rollback_path(strategy_id: str, optimization_id: str) -> Dict[str, Any]:
    return rollback(RollbackRequest(strategy_id=strategy_id, optimization_id=optimization_id))


@app.post("/api/strategies/{strategy_id}/autonomous")
def set_autonomous(strategy_id: str, payload: AutonomousRequest) -> Dict[str, Any]:
    row = store.get_strategy(strategy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    updated = store.update_strategy(strategy_id, {
        "autonomous": bool(payload.enabled),
        "status": "paper" if payload.enabled else (row.get("status") or "optimized"),
    })
    _broadcast({
        "type": "autonomous",
        "strategy_id": strategy_id,
        "enabled": bool(payload.enabled),
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    return {"strategy": public_strategy(updated or row)}


@app.patch("/api/strategies/{strategy_id}/status")
def set_status(strategy_id: str, payload: StatusRequest) -> Dict[str, Any]:
    allowed = {"draft", "backtested", "optimized", "shadow", "paper", "live", "halted"}
    status = (payload.status or "").lower()
    if status not in allowed:
        raise HTTPException(status_code=422, detail=f"status must be one of {sorted(allowed)}")
    updated = store.update_strategy(strategy_id, {"status": status})
    if not updated:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return {"strategy": public_strategy(updated)}


@app.delete("/api/strategies/{strategy_id}")
def delete_strategy(strategy_id: str) -> Dict[str, Any]:
    ok = store.delete_strategy(strategy_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return {"deleted": strategy_id}


# ---------------------------------------------------------------------------
# Analysis (dual engine)
# ---------------------------------------------------------------------------
@app.post("/api/strategies/analyze")
def analyze(payload: AnalyzeRequest) -> Dict[str, Any]:
    settings = get_settings()
    row = store.get_strategy(payload.strategy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    spec = spec_from_row(row)

    report = run_backtest(
        spec,
        bars=None,
        bars_count=payload.bars,
        seed=payload.seed,
        split=payload.split,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
    )
    trades = [t.to_dict() for t in report.trades]

    baseline_metrics = None
    baseline = next(
        (o for o in store.list_optimizations(payload.strategy_id) if o.get("is_baseline")),
        None,
    )
    if baseline and baseline.get("id") != row.get("active_optimization_id"):
        baseline_metrics = baseline.get("metrics") or {}
    elif baseline:
        baseline_metrics = None

    analysis = analyze_strategy(
        metrics=report.metrics,
        in_sample=report.in_sample,
        out_of_sample=report.out_of_sample,
        trades=trades,
        risk_profile=spec.risk.model_dump(),
        baseline_metrics=baseline_metrics,
        strategy_name=spec.name,
    )

    llm_report = llm_service.analyze(
        {**analysis, "strategy_name": spec.name},
        settings=settings,
        no_llm=payload.no_llm,
    )

    return {
        "strategy_id": payload.strategy_id,
        "strategy_name": spec.name,
        "engine": llm_report.get("engine") or analysis["engine"],
        "engine_label": (
            f"{llm_report['engine']} + {analysis['engine_label']}"
            if llm_report.get("engine") else analysis["engine_label"]
        ),
        "engines_used": [analysis["engine"]] + ([llm_report["engine"]] if llm_report.get("engine") else []),
        "llm": llm_report,
        "metrics": report.metrics,
        "in_sample": report.in_sample,
        "out_of_sample": report.out_of_sample,
        "equity_curve": [round(x, 2) for x in report.equity_curve[:: max(1, len(report.equity_curve) // 240 or 1)]],
        "trade_count": len(trades),
        **{k: v for k, v in analysis.items() if k != "engine"},
    }


# ---------------------------------------------------------------------------
# Execution + Prop-Firm Shield
# ---------------------------------------------------------------------------
@app.get("/api/risk/status")
def risk_status() -> Dict[str, Any]:
    _roll_day()
    shield = _shield()
    decision = shield.evaluate(
        equity=ACCOUNT["equity"],
        day_start_equity=ACCOUNT["day_start_equity"],
        peak_equity=ACCOUNT["peak_equity"],
        open_positions=ACCOUNT["open_positions"],
    )
    return {
        "account": {
            **ACCOUNT,
            "daily_drawdown_pct": decision.daily_drawdown_pct,
            "total_drawdown_pct": decision.total_drawdown_pct,
        },
        "shield": shield.to_dict(),
        "decision": decision.to_dict(),
    }


@app.post("/api/risk/reset")
def risk_reset(equity: float = 10_000.0) -> Dict[str, Any]:
    ACCOUNT.update({
        "starting_equity": float(equity),
        "equity": float(equity),
        "day_start_equity": float(equity),
        "peak_equity": float(equity),
        "open_positions": 0,
        "trades": 0,
        "blocked": 0,
        "day": time.strftime("%Y-%m-%d", time.gmtime()),
    })
    return risk_status()


@app.post("/api/execution/order")
def submit_order(payload: OrderRequest) -> Dict[str, Any]:
    """Every order funnels through the Prop-Firm Shield before touching a broker."""
    _roll_day()
    shield = _shield()
    settings = get_settings()

    decision = shield.evaluate(
        equity=ACCOUNT["equity"],
        day_start_equity=ACCOUNT["day_start_equity"],
        peak_equity=ACCOUNT["peak_equity"],
        requested_risk_pct=payload.risk_pct,
        volume=payload.volume,
        open_positions=ACCOUNT["open_positions"],
    )

    volume = decision.adjusted_volume if decision.allowed else 0.0
    execution = None
    if decision.allowed:
        execution = mt5_executor.bridge.place_order({
            "symbol": payload.symbol,
            "side": payload.side,
            "volume": volume,
            "price": payload.price,
            "stop_loss": payload.stop_loss,
            "take_profit": payload.take_profit,
        })

    log = store.insert_trade_log({
        "strategy_id": payload.strategy_id,
        "optimization_id": payload.optimization_id,
        "mode": payload.mode if decision.allowed else payload.mode,
        "symbol": payload.symbol,
        "side": payload.side,
        "entry_price": payload.price or 0.0,
        "stop_loss": payload.stop_loss or None,
        "take_profit": payload.take_profit or None,
        "volume": volume,
        "status": "open" if decision.allowed else "blocked",
        "blocked_reason": None if decision.allowed else decision.reason,
        "day_pnl_pct": -decision.daily_drawdown_pct,
        "total_pnl_pct": -decision.total_drawdown_pct,
        "equity_after": ACCOUNT["equity"],
        "meta": {
            "decision": decision.to_dict(),
            "execution": execution,
            "shield": shield.to_dict(),
            "settings_mode": settings.MT5_PATH and "mt5" or "shadow",
        },
    })

    if decision.allowed:
        ACCOUNT["trades"] += 1
        ACCOUNT["open_positions"] += 1
    else:
        ACCOUNT["blocked"] += 1

    _broadcast({"type": "order", "trade": log, "decision": decision.to_dict()})
    return {
        "allowed": decision.allowed,
        "decision": decision.to_dict(),
        "execution": execution,
        "trade": log,
    }


@app.post("/api/execution/paper-run")
def paper_run(payload: PaperRunRequest) -> Dict[str, Any]:
    """Replay the tail of a backtest through the shield and stream the results.

    This is what drives the live trade ticker: each simulated fill is written to
    ``trade_logs``, which Supabase broadcasts over Realtime to every open
    dashboard.
    """
    _roll_day()
    row = store.get_strategy(payload.strategy_id)
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    spec = spec_from_row(row)
    shield = _shield()

    report = run_backtest(
        spec, bars=None, bars_count=payload.bars, seed=payload.seed, split=0.5,
        max_daily_dd_pct=get_settings().MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=get_settings().MAX_TOTAL_DRAWDOWN,
    )
    trades = [t.to_dict() for t in report.trades][-max(1, int(payload.n_trades)):]

    executed, blocked = [], []
    for trade in trades:
        decision = shield.evaluate(
            equity=ACCOUNT["equity"],
            day_start_equity=ACCOUNT["day_start_equity"],
            peak_equity=ACCOUNT["peak_equity"],
            requested_risk_pct=float(spec.parameters.get("risk_per_trade_pct",
                                                         spec.risk.risk_per_trade_pct)),
            volume=0.01,
            open_positions=ACCOUNT["open_positions"],
        )
        pnl = float(trade["pnl"]) if decision.allowed else 0.0
        if decision.allowed:
            ACCOUNT["equity"] = round(ACCOUNT["equity"] + pnl, 4)
            ACCOUNT["peak_equity"] = max(ACCOUNT["peak_equity"], ACCOUNT["equity"])
            ACCOUNT["open_positions"] = max(0, ACCOUNT["open_positions"] + 1 - 1)
            ACCOUNT["trades"] += 1
        else:
            ACCOUNT["blocked"] += 1

        equity = ACCOUNT["equity"]
        day_pnl = (equity / ACCOUNT["day_start_equity"] - 1.0) * 100.0 if ACCOUNT["day_start_equity"] else 0.0
        total_pnl = (equity / ACCOUNT["starting_equity"] - 1.0) * 100.0 if ACCOUNT["starting_equity"] else 0.0

        log = store.insert_trade_log({
            "strategy_id": payload.strategy_id,
            "optimization_id": row.get("active_optimization_id"),
            "mode": payload.mode,
            "symbol": spec.symbol,
            "side": trade["side"],
            "entry_price": trade["entry"],
            "exit_price": trade["exit"],
            "stop_loss": trade["stop_loss"],
            "take_profit": trade["take_profit"],
            "volume": 0.01,
            "pnl": round(pnl, 4),
            "pnl_pct": round(trade["pnl_pct"], 4) if decision.allowed else 0.0,
            "r_multiple": round(trade["r_multiple"], 4) if decision.allowed else 0.0,
            "status": "closed" if decision.allowed else "blocked",
            "blocked_reason": None if decision.allowed else decision.reason,
            "closed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "day_pnl_pct": round(day_pnl, 4),
            "total_pnl_pct": round(total_pnl, 4),
            "equity_after": equity,
            "meta": {"exit_reason": trade["exit_reason"], "decision": decision.to_dict(),
                     "sample": trade["sample"]},
        })
        (executed if decision.allowed else blocked).append(log)
        _broadcast({"type": "trade", "trade": log, "decision": decision.to_dict()})

    store.update_strategy(payload.strategy_id, {"status": "paper"})
    return {
        "executed": executed,
        "blocked": blocked,
        "summary": {
            "executed": len(executed),
            "blocked": len(blocked),
            "equity": ACCOUNT["equity"],
            "peak_equity": ACCOUNT["peak_equity"],
            "day_pnl_pct": round((ACCOUNT["equity"] / ACCOUNT["day_start_equity"] - 1.0) * 100.0, 4),
            "total_pnl_pct": round((ACCOUNT["equity"] / ACCOUNT["starting_equity"] - 1.0) * 100.0, 4),
        },
        "shield": shield.to_dict(),
    }


@app.get("/api/trade-logs")
def trade_logs(strategy_id: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
    rows = store.list_trade_logs(strategy_id=strategy_id, limit=limit)
    rows = list(reversed(rows))  # newest first
    return {"trade_logs": rows, "count": len(rows), "store": store.mode}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@app.get("/api/settings")
def read_settings() -> Dict[str, Any]:
    settings = get_settings()
    return {
        "settings": settings.redacted(),
        "keys": list(DEFAULT_SETTINGS.keys()),
        "capabilities": {
            "supabase": store.mode,
            "llm_provider": settings.llm_provider,
            "optimizer": "optuna-tpe" if _has_optuna() else "random-search",
            "mt5": mt5_executor.bridge.status(settings),
        },
    }


@app.post("/api/settings")
def write_settings(payload: SettingsUpdate) -> Dict[str, Any]:
    patch = payload.model_dump(exclude_none=True)
    # Sentinels from the redacted GET must not overwrite real secrets.
    for key in ("SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"):
        value = patch.get(key)
        if isinstance(value, str) and value.startswith("••••"):
            patch.pop(key, None)
    if not patch:
        raise HTTPException(status_code=422, detail="No settings supplied")

    settings = _apply_settings_patch(patch)
    if "NEXT_PUBLIC_SUPABASE_URL" in patch or "SUPABASE_SERVICE_ROLE_KEY" in patch:
        _configure_store(settings)
    # Never write secrets back into a shared database when the store is remote.
    to_persist = {k: v for k, v in patch.items() if k not in
                  ("SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY")}
    if to_persist:
        store.save_settings(to_persist)
    _broadcast({"type": "settings", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return {
        "settings": settings.redacted(),
        "updated": sorted(patch.keys()),
        "store": store.mode,
    }


# ---------------------------------------------------------------------------
# Realtime websocket (companion to the Supabase Realtime channel)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# MetaTrader 5 bridge
# ---------------------------------------------------------------------------
class MT5ConnectRequest(BaseModel):
    """Blank fields fall back to the values saved in the Settings tab."""

    path: Optional[str] = None
    login: Optional[str] = None
    password: Optional[str] = None
    server: Optional[str] = None
    timeout: int = 60000


class ResetRequest(BaseModel):
    """Wipe the studio. ``scope='user'`` only touches rows owned by user_id."""

    user_id: Optional[str] = None
    scope: str = "user"
    reseed: bool = False


@app.get("/api/mt5/status")
def mt5_status() -> Dict[str, Any]:
    settings = get_settings()
    status = mt5_executor.bridge.status(settings)
    status["credentials"] = {
        "login": bool(settings.MT5_LOGIN),
        "password": bool(settings.MT5_PASSWORD),
        "server": bool(settings.MT5_SERVER),
        "path": bool(settings.MT5_PATH),
    }
    return status


@app.post("/api/mt5/connect")
def mt5_connect(payload: MT5ConnectRequest | None = None) -> Dict[str, Any]:
    """Launch the terminal (if needed) and log in."""
    settings = get_settings()
    body = payload or MT5ConnectRequest()
    outcome = mt5_executor.bridge.connect(
        path=body.path if body.path is not None else (settings.MT5_PATH or ""),
        login=body.login if body.login is not None else (settings.MT5_LOGIN or ""),
        password=body.password if body.password is not None else (settings.MT5_PASSWORD or ""),
        server=body.server if body.server is not None else (settings.MT5_SERVER or ""),
        timeout=body.timeout or 60000,
    )
    if outcome.get("connected"):
        outcome["status"] = mt5_executor.bridge.status(settings)
    return outcome


@app.post("/api/mt5/disconnect")
def mt5_disconnect() -> Dict[str, Any]:
    return {**mt5_executor.bridge.disconnect(), "status": mt5_executor.bridge.status(get_settings())}


@app.get("/api/mt5/price")
def mt5_price(symbol: str = Query("XAUUSD")) -> Dict[str, Any]:
    return mt5_executor.bridge.price(symbol)


@app.get("/api/mt5/candles")
def mt5_candles(
    symbol: str = Query("XAUUSD"),
    timeframe: str = Query("H1"),
    count: int = Query(120),
) -> Dict[str, Any]:
    return mt5_executor.bridge.candles(symbol, timeframe.upper(), count)


@app.get("/api/mt5/symbols")
def mt5_symbols(needle: str = Query("")) -> Dict[str, Any]:
    return mt5_executor.bridge.symbols(needle)


@app.post("/api/reset")
def reset_everything(payload: ResetRequest | None = None) -> Dict[str, Any]:
    """Delete strategies (cascading to optimizations + trade logs)."""
    body = payload or ResetRequest()
    removed = store.reset(user_id=body.user_id, scope=body.scope)
    if body.reseed:
        _seed_if_empty()
    return {"removed": removed, "total": len(store.list_strategies()), "store": store.mode}


@app.websocket("/ws/trades")
async def trades_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    _TRADE_LISTENERS.append(queue)
    try:
        await websocket.send_json({
            "type": "hello",
            "store": store.mode,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if queue in _TRADE_LISTENERS:
            _TRADE_LISTENERS.remove(queue)


# ---------------------------------------------------------------------------
# Demo data
# ---------------------------------------------------------------------------
DEMO_SEEDS = [
    {
        "text": ("London breakout on XAUUSD H1. Buy when price breaks the 20 bar high during the "
                 "London session, confirm with the 12 EMA above the 26 EMA, stop loss 2 ATR, "
                 "target 2.5R. Risk 0.5% per trade."),
        "source_url": "https://www.youtube.com/watch?v=alphaforge-london-breakout",
        "overrides": {"fast_ema": 12.0, "slow_ema": 26.0, "atr_sl_mult": 2.0, "rr_ratio": 2.5,
                      "breakout_lookback": 20.0, "risk_per_trade_pct": 0.5},
    },
    {
        "text": ("Mean reversion on EURUSD M15. Fade RSI extremes below 28 and above 72, "
                 "confirm with the 200 EMA trend filter, 1.5 ATR stop, 1.8R target. "
                 "Risk 0.4% per trade."),
        "source_url": "https://www.tiktok.com/@alphaforge/video/mean-reversion",
        "overrides": {"rsi_period": 14.0, "rsi_lower": 28.0, "rsi_upper": 72.0,
                      "atr_sl_mult": 1.5, "rr_ratio": 1.8, "risk_per_trade_pct": 0.4,
                      "fast_ema": 20.0, "slow_ema": 50.0},
    },
    {
        "text": ("NAS100 H4 trend following. Enter on a 50/200 EMA crossover with a 55 bar "
                 "Donchian breakout filter, 3 ATR stop, 3R target. Risk 0.75% per trade."),
        "source_url": "",
        "overrides": {"fast_ema": 50.0, "slow_ema": 200.0, "breakout_lookback": 55.0,
                      "atr_sl_mult": 3.0, "rr_ratio": 3.0, "risk_per_trade_pct": 0.75,
                      "min_signal_strength": 2.0},
    },
]


def _seed_if_empty() -> None:
    if store.list_strategies():
        return
    for seed in DEMO_SEEDS:
        _seed_one(seed)


def _seed_one(seed: Dict[str, Any]) -> None:
    settings = get_settings()
    spec_dict, meta = llm_service.transpile(
        seed["text"], source_url=seed.get("source_url", ""),
        source_type=_detect_source_type(seed.get("source_url", "")),
        settings=settings, no_llm=True,
    )
    params = dict(spec_dict.get("parameters") or {})
    params.update(seed.get("overrides") or {})
    spec_dict["parameters"] = params
    result = parse_manual_json(_json_dumps(spec_dict))
    if not result.ok:
        return
    spec = result.spec

    # Serverless runtimes can cold-start several instances at once, and each
    # one runs this at boot. Re-read the table right before writing so two
    # warmers do not plant two copies of the same demo strategy.
    for existing in store.list_strategies():
        if (existing.get("symbol") == spec.symbol
                and existing.get("timeframe") == spec.timeframe):
            return

    row = store.insert_strategy({
        **row_from_spec(spec),
        "status": "draft",
        "autonomous": False,
        **metrics_patch({}),
    })

    report = _run_and_persist(spec, row, seed=11, bars=2400)
    baseline = store.insert_optimization({
        "strategy_id": row["id"],
        "version": 1,
        "label": "Baseline (v1)",
        "engine": meta.get("engine", "heuristic"),
        "parameters": dict(spec.parameters),
        "param_bounds": _bounds_for(dict(spec.parameters)),
        "metrics": report["metrics"],
        "n_trials": 0,
        "direction": "maximize",
        "objective_name": "sharpe",
        "is_active": True,
        "is_baseline": True,
        "notes": "Seeded baseline parameter set.",
    })
    store.set_active_optimization(row["id"], baseline["id"])
    store.update_strategy(row["id"], {"active_optimization_id": baseline["id"], "status": "backtested"})

    # two optimisation generations so the lineage view has real diffs
    bars = generate_bars(spec.symbol, spec.timeframe, 2400, 11)
    current_spec = spec
    for generation, objective in enumerate(("sharpe", "prop_readiness"), start=2):
        outcome = run_optimizer(
            current_spec,
            bars,
            n_trials=10,
            objective=objective,
            seed=11 + generation,
            split=0.7,
            max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
            max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
            bars_count=2400,
        )
        version = store.next_version(row["id"])
        optimization = store.insert_optimization({
            "strategy_id": row["id"],
            "user_id": row.get("user_id"),
            "version": version,
            "label": f"{outcome['objective_label']} · v{version}",
            "engine": outcome["engine"],
            "parameters": outcome["best_parameters"],
            "param_bounds": outcome["search_space"],
            "metrics": outcome["metrics"],
            "n_trials": outcome["n_trials"],
            "direction": "maximize",
            "objective_name": objective,
            "is_active": generation == 2,
            "is_baseline": False,
            "notes": (f"{outcome['objective_label']} objective · {outcome['n_trials']} trials · "
                      f"OOS retention {outcome['oos_retention']} · "
                      f"overfit risk {outcome['overfit_risk']}"),
        })
        if generation == 2:
            merged = dict(spec.parameters)
            merged.update(outcome["best_parameters"])
            store.update_strategy(row["id"], {
                "parameters": merged,
                "active_optimization_id": optimization["id"],
                "status": "optimized",
                **metrics_patch(outcome["metrics"]),
            })
            current_spec = current_spec.model_copy(update={"parameters": merged})


@app.post("/api/seed")
def seed(force: bool = Query(False)) -> Dict[str, Any]:
    if force:
        for row in store.list_strategies():
            store.delete_strategy(row["id"])
    before = len(store.list_strategies())
    _seed_if_empty()
    after = len(store.list_strategies())
    return {"seeded": after - before, "total": after, "store": store.mode}


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------
def _run_and_persist(spec: StrategySpec, row: Dict[str, Any], *, seed: int, bars: int) -> Dict[str, Any]:
    settings = get_settings()
    report = run_backtest(
        spec,
        bars=None,
        bars_count=bars,
        seed=seed,
        split=0.7,
        max_daily_dd_pct=settings.MAX_DAILY_DRAWDOWN,
        max_total_dd_pct=settings.MAX_TOTAL_DRAWDOWN,
    )
    store.update_strategy(row["id"], {
        **metrics_patch(report.metrics),
        "status": "backtested" if (row.get("status") in (None, "draft")) else row.get("status"),
    })
    return report.to_dict(include_trades=False)


def _log_backtest_trades(row: Dict[str, Any], spec: StrategySpec, report: Any, *,
                         mode: str, limit: int = 25) -> None:
    for trade in report.trades[:limit]:
        store.insert_trade_log({
            "strategy_id": row["id"],
            "optimization_id": row.get("active_optimization_id"),
            "user_id": row.get("user_id"),
            "mode": mode,
            "symbol": spec.symbol,
            "side": trade.side,
            "entry_price": trade.entry,
            "exit_price": trade.exit_price,
            "stop_loss": trade.stop_loss,
            "take_profit": trade.take_profit,
            "volume": round(trade.units / 1000.0, 4) or 0.01,
            "pnl": round(trade.pnl, 4),
            "pnl_pct": round(trade.pnl_pct, 4),
            "r_multiple": round(trade.r_multiple, 4),
            "status": "closed",
            "closed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "meta": {"exit_reason": trade.exit_reason, "sample": trade.sample, "source": "backtest"},
        })


def _curve(report: Any, split: float = 0.7, points: int = 260) -> Dict[str, Any]:
    """Equity / drawdown series shaped for the dashboard charts.

    The raw curve has one point per bar; it is downsampled to ``points`` so a
    3 000-bar backtest still ships as a few kilobytes of JSON. Trade markers
    keep their bar indices so the chart can plot entries and exits.
    """
    raw = list(getattr(report, "equity_curve", []) or []) or [10_000.0]
    step = max(1, len(raw) // max(1, points) or 1)
    equity = raw[::step]
    if equity[-1] != raw[-1]:
        equity.append(raw[-1])

    peak = equity[0]
    drawdown: List[float] = []
    for value in equity:
        peak = max(peak, value)
        drawdown.append(round(((peak - value) / peak) * 100, 4) if peak else 0.0)

    trades = [
        {
            "i": int(t.entry_index),
            "x": int(t.exit_index),
            "side": t.side,
            "pnl": round(t.pnl, 2),
            "r": round(t.r_multiple, 3),
            "reason": t.exit_reason,
            "sample": t.sample,
        }
        for t in getattr(report, "trades", [])[:400]
    ]
    return {
        "equity": [round(x, 2) for x in equity],
        "drawdown": drawdown,
        "initial_equity": round(raw[0], 2),
        "final_equity": round(raw[-1], 2),
        "split_index": max(0, min(len(equity) - 1, int(len(equity) * (split or 0.7)))),
        "max_drawdown_pct": round(max(drawdown) if drawdown else 0.0, 4),
        "step": step,
        "bars": getattr(report, "bars_used", 0) or len(raw),
        "trades": trades,
    }


def _json_dumps(value: Any) -> str:
    import json

    return json.dumps(value, default=str)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
