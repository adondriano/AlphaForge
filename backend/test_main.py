"""AlphaForge engine test suite.

Run with::

    cd backend && ALPHAFORGE_SEED=0 pytest -q
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("ALPHAFORGE_SEED", "0")

from fastapi.testclient import TestClient  # noqa: E402

import main as engine  # noqa: E402
from services.backtester import generate_bars, run_backtest  # noqa: E402
from services.python_analyzer import analyze_strategy  # noqa: E402
from services.risk import PropFirmShield  # noqa: E402
from services.validator import SAMPLE_SPEC, parse_manual_json  # noqa: E402

import json  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(engine.app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# health + settings
# ---------------------------------------------------------------------------
def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["engine"]["analyzer"] == "python-statistical"
    assert payload["risk"]["max_daily_drawdown_pct"] == 3.5
    assert payload["risk"]["max_total_drawdown_pct"] == 5.0


def test_settings_roundtrip(client):
    response = client.post("/api/settings", json={"MAX_DAILY_DRAWDOWN": 2.5})
    assert response.status_code == 200
    assert response.json()["settings"]["MAX_DAILY_DRAWDOWN"] == 2.5
    # restore
    client.post("/api/settings", json={"MAX_DAILY_DRAWDOWN": 3.5})


def test_settings_masks_secrets(client):
    client.post("/api/settings", json={"OPENAI_API_KEY": "sk-test-1234"})
    payload = client.get("/api/settings").json()
    assert payload["settings"]["OPENAI_API_KEY"].endswith("1234")
    assert not payload["settings"]["OPENAI_API_KEY"].startswith("sk-")
    client.post("/api/settings", json={"OPENAI_API_KEY": ""})


# ---------------------------------------------------------------------------
# validator
# ---------------------------------------------------------------------------
def test_validator_accepts_sample_spec():
    result = parse_manual_json(json.dumps(SAMPLE_SPEC))
    assert result.ok, result.errors
    assert result.spec.symbol == "XAUUSD"


def test_validator_rejects_bad_indicator():
    payload = dict(SAMPLE_SPEC)
    payload["entries"] = [{"indicator": "ichimoku_cloud"}]
    result = parse_manual_json(json.dumps(payload))
    assert not result.ok
    assert any("indicator" in e for e in result.errors)


def test_validator_reports_json_errors():
    result = parse_manual_json("{ not json ")
    assert not result.ok
    assert result.errors[0].startswith("Invalid JSON")


def test_validator_tolerates_fenced_blocks():
    result = parse_manual_json("```json\n" + json.dumps(SAMPLE_SPEC) + "\n```")
    assert result.ok


# ---------------------------------------------------------------------------
# backtest engine
# ---------------------------------------------------------------------------
def test_backtest_is_deterministic():
    spec = parse_manual_json(json.dumps(SAMPLE_SPEC)).spec
    bars = generate_bars("XAUUSD", "H1", 1200, 7)
    first = run_backtest(spec, bars, seed=7).metrics
    second = run_backtest(spec, bars, seed=7).metrics
    assert first == second
    assert first["total_trades"] > 0


def test_backtest_metrics_are_finite():
    spec = parse_manual_json(json.dumps(SAMPLE_SPEC)).spec
    metrics = run_backtest(spec, generate_bars("EURUSD", "M15", 1500, 3), seed=3).metrics
    for key, value in metrics.items():
        assert value == value, f"{key} is NaN"
    assert 0 <= metrics["win_rate"] <= 100
    assert metrics["max_drawdown_pct"] >= 0


# ---------------------------------------------------------------------------
# strategy lifecycle
# ---------------------------------------------------------------------------
def test_create_from_text_and_full_lifecycle(client):
    created = client.post("/api/strategies/create", json={
        "text": ("Buy XAUUSD on a 20 bar breakout during the London session with the 12 EMA "
                 "above the 26 EMA, 2 ATR stop and 2.5R target, risk 0.5% per trade."),
        "no_llm": True,
        "bars": 1200,
    })
    assert created.status_code == 200, created.text
    payload = created.json()
    strategy = payload["strategy"]
    assert strategy["symbol"] == "XAUUSD"
    assert strategy["source_type"] == "text"
    assert payload["optimization"]["version"] == 1
    assert payload["backtest"]["metrics"]["total_trades"] > 0

    strategy_id = strategy["id"]

    # --- lineage ---------------------------------------------------------
    lineage = client.get(f"/api/strategies/{strategy_id}/optimizations").json()
    assert lineage["count"] == 1
    assert lineage["active_id"] == strategy["active_optimization_id"]

    # --- backtest --------------------------------------------------------
    bt = client.post("/api/strategies/backtest",
                     json={"strategy_id": strategy_id, "bars": 1200}).json()
    assert bt["metrics"]["total_trades"] > 0
    assert bt["in_sample"]["total_trades"] + bt["out_of_sample"]["total_trades"] == \
        bt["metrics"]["total_trades"]

    # --- optimize --------------------------------------------------------
    optimized = client.post("/api/strategies/optimize", json={
        "strategy_id": strategy_id, "n_trials": 6, "objective": "prop_readiness",
        "bars": 1200, "apply": True,
    })
    assert optimized.status_code == 200, optimized.text
    optimization = optimized.json()["optimization"]
    assert optimization["version"] == 2
    assert optimization["is_active"] is True
    assert optimization["n_trials"] == 6

    lineage = client.get(f"/api/strategies/{strategy_id}/optimizations").json()
    assert lineage["count"] == 2

    # --- analyze (no-LLM fallback path) -----------------------------------
    analysis = client.post("/api/strategies/analyze",
                           json={"strategy_id": strategy_id, "no_llm": True, "bars": 1200}).json()
    assert analysis["engine"] == "python-statistical"
    assert 0 <= analysis["score"] <= 100
    assert analysis["verdict"] in {"healthy", "watch", "degraded", "critical"}
    assert isinstance(analysis["findings"], list)

    # --- rollback ---------------------------------------------------------
    baseline = next(o for o in lineage["optimizations"] if o["is_baseline"])
    rolled = client.post("/api/strategies/rollback", json={
        "strategy_id": strategy_id, "optimization_id": baseline["id"],
    })
    assert rolled.status_code == 200, rolled.text
    rolled_strategy = rolled.json()["strategy"]
    assert rolled_strategy["active_optimization_id"] == baseline["id"]
    for key, value in baseline["parameters"].items():
        assert abs(float(rolled_strategy["parameters"][key]) - float(value)) < 1e-6

    # --- autonomous toggle -------------------------------------------------
    toggled = client.post(f"/api/strategies/{strategy_id}/autonomous",
                          json={"enabled": True}).json()
    assert toggled["strategy"]["autonomous"] is True

    # --- delete ------------------------------------------------------------
    assert client.delete(f"/api/strategies/{strategy_id}").json()["deleted"] == strategy_id
    assert client.get(f"/api/strategies/{strategy_id}").status_code == 404


def test_create_from_manual_json(client):
    payload = dict(SAMPLE_SPEC)
    payload["name"] = "Manual JSON Strategy"
    created = client.post("/api/strategies/create",
                          json={"json_spec": payload, "bars": 900})
    assert created.status_code == 200, created.text
    assert created.json()["strategy"]["name"] == "Manual JSON Strategy"
    client.delete(f"/api/strategies/{created.json()['strategy']['id']}")


def test_create_rejects_invalid_json(client):
    response = client.post("/api/strategies/create", json={"json_spec": '{"entries": [{"indicator": "nope"}]}'})
    assert response.status_code == 422
    assert "errors" in response.json()["detail"]


def test_create_from_video_url(client):
    created = client.post("/api/strategies/create", json={
        "source_url": "https://www.youtube.com/watch?v=alphaforge-demo",
        "text": "12/26 EMA crossover on NAS100 H4 with a 2R target and 1% risk.",
        "no_llm": True,
        "bars": 900,
    })
    assert created.status_code == 200, created.text
    strategy = created.json()["strategy"]
    assert strategy["source_type"] == "youtube"
    client.delete(f"/api/strategies/{strategy['id']}")


# ---------------------------------------------------------------------------
# Prop-Firm Shield
# ---------------------------------------------------------------------------
def test_shield_blocks_on_daily_breach():
    shield = PropFirmShield(max_daily_drawdown_pct=3.5, max_total_drawdown_pct=5.0)
    decision = shield.evaluate(equity=9600, day_start_equity=10000, peak_equity=10000)
    assert not decision.allowed
    assert decision.code == "daily_drawdown_breach"
    assert decision.breach == "daily"


def test_shield_liquidates_on_total_breach():
    shield = PropFirmShield()
    decision = shield.evaluate(equity=9400, day_start_equity=10000, peak_equity=10000)
    assert not decision.allowed
    assert decision.action == "liquidate"
    assert decision.breach == "total"


def test_shield_reduces_size_near_the_limit():
    shield = PropFirmShield(risk_per_trade_pct=0.5)
    decision = shield.evaluate(equity=9900, day_start_equity=10000, peak_equity=10000,
                               requested_risk_pct=3.0, volume=1.0)
    assert decision.allowed
    assert decision.action == "reduce"
    assert decision.approved_risk_pct < 3.0
    assert decision.adjusted_volume < 1.0
    # a request inside the remaining headroom is left untouched
    untouched = shield.evaluate(equity=9900, day_start_equity=10000, peak_equity=10000,
                                requested_risk_pct=0.5, volume=1.0)
    assert untouched.action == "allow"
    assert untouched.adjusted_volume == 1.0


def test_shield_respects_concurrency():
    shield = PropFirmShield(max_concurrent_trades=2)
    decision = shield.evaluate(equity=10000, day_start_equity=10000, peak_equity=10000,
                               open_positions=2)
    assert not decision.allowed
    assert decision.code == "max_concurrent_trades"


def test_order_endpoint_logs_blocked_trade(client):
    client.post("/api/risk/reset", params={"equity": 10000})
    client.post("/api/settings", json={"MAX_DAILY_DRAWDOWN": 3.5})
    # force a breach by rewinding the equity through the account endpoint
    engine.ACCOUNT["equity"] = 9500.0
    response = client.post("/api/execution/order", json={
        "symbol": "XAUUSD", "side": "buy", "volume": 0.1, "price": 2650.0,
        "stop_loss": 2640.0, "take_profit": 2680.0, "mode": "paper",
    })
    assert response.status_code == 200
    payload = response.json()
    assert payload["allowed"] is False
    assert payload["trade"]["status"] == "blocked"
    assert payload["trade"]["blocked_reason"]
    engine.ACCOUNT["equity"] = 10000.0


# ---------------------------------------------------------------------------
# analyzer
# ---------------------------------------------------------------------------
def test_analyzer_flags_tiny_sample():
    report = analyze_strategy(metrics={"total_trades": 4, "win_rate": 60.0,
                                       "profit_factor": 1.4, "expectancy_r": 0.3})
    assert report["verdict"] in {"degraded", "critical"}
    assert any(f["id"] == "thin_sample" for f in report["findings"])


def test_analyzer_flags_drawdown_breach():
    report = analyze_strategy(
        metrics={"total_trades": 200, "win_rate": 45.0, "profit_factor": 1.5,
                 "expectancy_r": 0.3, "max_drawdown_pct": 12.0, "sharpe": 1.1,
                 "est_trades_per_week": 5.0},
        risk_profile={"max_daily_drawdown_pct": 3.5, "max_total_drawdown_pct": 5.0},
    )
    assert any(f["id"] == "dd_breach_total" for f in report["findings"])


def test_analyzer_detects_overfit():
    report = analyze_strategy(
        metrics={"total_trades": 150, "win_rate": 40.0, "profit_factor": 1.1,
                 "expectancy_r": 0.1, "sharpe": 0.4, "est_trades_per_week": 4.0},
        in_sample={"total_trades": 100, "profit_factor": 2.0, "sharpe": 2.0},
        out_of_sample={"total_trades": 50, "profit_factor": 0.7, "sharpe": -0.3},
    )
    assert any(f["id"] in {"overfit", "decay_walkforward"} for f in report["findings"])


def test_analyzer_detects_decay():
    trades = [{"r_multiple": 2.0 if i < 20 else -0.5} for i in range(40)]
    report = analyze_strategy(
        metrics={"total_trades": 40, "win_rate": 50.0, "profit_factor": 1.6,
                 "expectancy_r": 0.6, "sharpe": 1.2, "est_trades_per_week": 4.0},
        trades=trades,
    )
    assert report["decay"]["state"] == "decaying"
    assert any(f["id"] == "decay" for f in report["findings"])


# ---------------------------------------------------------------------------
# seed + listing
# ---------------------------------------------------------------------------
def test_seed_creates_demo_strategies(client):
    seeded = client.post("/api/seed", params={"force": True}).json()
    assert seeded["total"] == 3
    strategies = client.get("/api/strategies").json()["strategies"]
    assert len(strategies) == 3
    for strategy in strategies:
        assert strategy["total_trades"] > 0
        lineage = client.get(f"/api/strategies/{strategy['id']}/optimizations").json()
        assert lineage["count"] >= 3
        assert lineage["active_id"]


def test_paper_run_streams_shielded_trades(client):
    strategies = client.get("/api/strategies").json()["strategies"]
    strategy_id = strategies[0]["id"]
    client.post("/api/risk/reset", params={"equity": 10000})
    run = client.post("/api/execution/paper-run",
                      json={"strategy_id": strategy_id, "n_trades": 5, "bars": 1200}).json()
    assert run["summary"]["executed"] + run["summary"]["blocked"] == 5
    logs = client.get("/api/trade-logs", params={"strategy_id": strategy_id}).json()
    assert logs["count"] >= 1
