"""Postgres-constraint regression tests for the Supabase store.

``schema.sql`` puts three constraints on the lineage tables that the in-memory
fallback does not model:

* ``optimizations_strategy_version_key``      unique (strategy_id, version)
* ``optimizations_one_active_idx``            unique (strategy_id) where is_active
* ``strategies_active_optimization_id_fkey``  -> optimizations(id)

Promoting a new parameter version therefore has to clear ``is_active`` on its
siblings *before* it is inserted, otherwise PostgREST answers 409, the store
silently degrades to memory, and the caller writes a dangling
``active_optimization_id``. These tests run the store against
``tests/mock_postgrest.py``, which enforces exactly those constraints.
"""

from __future__ import annotations

import base64
import json
import threading
import uuid
from http.server import HTTPServer

import pytest

from services.store import Store
from tests.mock_postgrest import DB, Handler


def _fake_jwt(role: str = "service_role") -> str:
    def part(payload: dict) -> str:
        raw = json.dumps(payload, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    header = part({"alg": "HS256", "typ": "JWT"})
    body = part({
        "iss": "supabase",
        "ref": "alphaforgetest",
        "role": role,
        "iat": 1793419680,
        "exp": 2108995680,
    })
    return f"{header}.{body}.signature"


@pytest.fixture()
def pg_store():
    """A Store wired to an in-process PostgREST that enforces the real schema."""
    DB.clear()
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    store = Store()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    assert store.configure(url, _fake_jwt()) is True
    assert store.mode == "supabase"

    yield store

    server.shutdown()
    server.server_close()
    DB.clear()


def _strategy_row(**extra) -> dict:
    row = {
        "id": str(uuid.uuid4()),
        "name": "Constraint Probe",
        "symbol": "XAUUSD",
        "timeframe": "H1",
        "source_type": "text",
        "source_url": "",
        "description": "",
        "rules": {"entries": [], "exits": [], "filters": []},
        "parameters": {"fast_ema": 12.0, "slow_ema": 26.0},
        "risk_profile": {"risk_per_trade_pct": 0.5},
        "status": "draft",
        "autonomous": False,
        "win_rate": 0.0,
        "total_trades": 0,
        "net_return_pct": 0.0,
        "max_drawdown_pct": 0.0,
        "profit_factor": 0.0,
        "sharpe": 0.0,
        "expectancy_r": 0.0,
        "prop_readiness": 0.0,
        "est_trades_per_week": 0.0,
        "active_optimization_id": None,
    }
    row.update(extra)
    return row


# ---------------------------------------------------------------------------
def test_harness_enforces_one_active_index(pg_store):
    """Sanity check: the harness must reject a second active version."""
    strategy = pg_store.insert_strategy(_strategy_row())
    pg_store.insert_optimization({
        "strategy_id": strategy["id"], "version": 1, "label": "Baseline (v1)",
        "engine": "heuristic", "parameters": {}, "param_bounds": {},
        "metrics": {}, "n_trials": 0, "direction": "maximize",
        "objective_name": "sharpe", "is_active": True, "is_baseline": True,
        "notes": "seeded baseline",
    })
    with pytest.raises(Exception):
        # raw write, no sibling deactivation -> the unique index must fire
        pg_store._run(
            "optimizations",
            pg_store._client.table("optimizations").insert({
                "strategy_id": strategy["id"], "version": 2, "label": "Sharpe - v2",
                "engine": "random-search", "parameters": {}, "param_bounds": {},
                "metrics": {}, "n_trials": 10, "direction": "maximize",
                "objective_name": "sharpe", "is_active": True, "is_baseline": False,
                "notes": "second active version",
            }),
        )
    assert len(pg_store.list_optimizations(strategy["id"])) == 1


def test_promoting_a_new_version_clears_the_previous_active(pg_store):
    """The real regression: optimize -> apply must not violate the unique index."""
    strategy = pg_store.insert_strategy(_strategy_row())

    baseline = pg_store.insert_optimization({
        "strategy_id": strategy["id"], "version": 1, "label": "Baseline (v1)",
        "engine": "heuristic", "parameters": {"fast_ema": 12.0}, "param_bounds": {},
        "metrics": {"sharpe": 0.4}, "n_trials": 0, "direction": "maximize",
        "objective_name": "sharpe", "is_active": True, "is_baseline": True,
        "notes": "Seeded baseline parameter set.",
    })
    pg_store.set_active_optimization(strategy["id"], baseline["id"])
    pg_store.update_strategy(strategy["id"], {
        "active_optimization_id": baseline["id"], "status": "backtested",
    })

    promoted = pg_store.insert_optimization({
        "strategy_id": strategy["id"], "version": 2, "label": "Sharpe - v2",
        "engine": "random-search", "parameters": {"fast_ema": 18.0}, "param_bounds": {},
        "metrics": {"sharpe": 1.1}, "n_trials": 10, "direction": "maximize",
        "objective_name": "sharpe", "is_active": True, "is_baseline": False,
        "notes": "Sharpe ratio objective - 10 trials",
    })
    updated = pg_store.update_strategy(strategy["id"], {
        "parameters": {"fast_ema": 18.0},
        "active_optimization_id": promoted["id"],
        "status": "optimized",
        "sharpe": 1.1,
    })

    # no silent degradation to the in-memory store
    assert pg_store._last_error is None, pg_store._last_error
    assert pg_store.mode == "supabase"
    assert updated is not None and updated["status"] == "optimized"

    versions = pg_store.list_optimizations(strategy["id"])
    assert [v["version"] for v in versions] == [1, 2]
    assert [v["id"] for v in versions if v.get("is_active")] == [promoted["id"]]


def test_rollback_reactivates_an_older_version(pg_store):
    strategy = pg_store.insert_strategy(_strategy_row())
    v1 = pg_store.insert_optimization({
        "strategy_id": strategy["id"], "version": 1, "label": "Baseline (v1)",
        "engine": "heuristic", "parameters": {"fast_ema": 12.0}, "param_bounds": {},
        "metrics": {"sharpe": 0.4}, "n_trials": 0, "direction": "maximize",
        "objective_name": "sharpe", "is_active": True, "is_baseline": True,
        "notes": "",
    })
    pg_store.insert_optimization({
        "strategy_id": strategy["id"], "version": 2, "label": "Sharpe - v2",
        "engine": "random-search", "parameters": {"fast_ema": 18.0}, "param_bounds": {},
        "metrics": {"sharpe": 1.1}, "n_trials": 10, "direction": "maximize",
        "objective_name": "sharpe", "is_active": True, "is_baseline": False,
        "notes": "",
    })

    assert pg_store.set_active_optimization(strategy["id"], v1["id"]) is True
    assert pg_store._last_error is None, pg_store._last_error

    versions = pg_store.list_optimizations(strategy["id"])
    assert [v["id"] for v in versions if v.get("is_active")] == [v1["id"]]


def test_dangling_active_optimization_id_is_rejected(pg_store):
    """The strategies FK must hold: no pointing at a version that was never stored."""
    strategy = pg_store.insert_strategy(_strategy_row())
    with pytest.raises(Exception):
        pg_store._run(
            "strategies",
            pg_store._client.table("strategies")
            .update({"active_optimization_id": str(uuid.uuid4())})
            .eq("id", strategy["id"]),
        )
