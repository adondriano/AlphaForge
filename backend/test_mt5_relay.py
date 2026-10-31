"""Tests for the MT5 Supabase relay.

The relay is the path that lets a hosted engine (no MetaTrader5 available)
drive a terminal on the user's Windows machine, so the failure modes matter:
a stale heartbeat must not be mistaken for a live agent, and a command that is
never answered must time out rather than hang or silently shadow-fill.
"""

from __future__ import annotations

import time

import pytest

from services import mt5_executor
from services.mt5_relay import Mt5Relay


# ---------------------------------------------------------------------------
# A tiny in-memory PostgREST so the relay can be exercised without a database.
# ---------------------------------------------------------------------------
class _Query:
    def __init__(self, table: "_Table") -> None:
        self.table = table
        self.filters: list = []
        self.mode = "select"
        self.payload: dict | None = None
        self.limit_n: int | None = None
        self.order_by: tuple | None = None

    def select(self, *_a, **_k):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def order(self, column, desc=False):
        self.order_by = (column, desc)
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def insert(self, payload):
        self.mode = "insert"
        self.payload = payload if isinstance(payload, list) else [payload]
        return self

    def update(self, payload):
        self.mode = "update"
        self.payload = payload
        return self

    def delete(self):
        self.mode = "delete"
        return self

    def execute(self):
        return self.table.execute(self)


class _Result:
    def __init__(self, data):
        self.data = data


def _matches(row: dict, filters) -> bool:
    return all(str(row.get(col)) == str(val) for col, val in filters)


class _Table:
    """Entry point of the chain: `.table(name).select(...).eq(...).execute()`."""

    def __init__(self, name: str, db: dict, hooks: dict) -> None:
        self.name = name
        self.db = db
        self.hooks = hooks

    # Every builder starts a fresh query and hands it straight back.
    def select(self, *_a, **_k):
        return _Query(self).select(*_a, **_k)

    def insert(self, payload):
        return _Query(self).insert(payload)

    def update(self, payload):
        return _Query(self).update(payload)

    def delete(self):
        return _Query(self).delete()

    def execute(self, query: _Query):
        rows = self.db.setdefault(self.name, [])
        if query.mode == "insert":
            for payload in query.payload or []:
                row = dict(payload)
                hook = self.hooks.get(self.name)
                if hook:
                    hook(row)
                rows.append(row)
            return _Result(list(query.payload or []))
        matched = [r for r in rows if _matches(r, query.filters)]
        if query.mode == "update":
            for row in matched:
                row.update(query.payload or {})
            return _Result(matched)
        if query.mode == "delete":
            for row in matched:
                rows.remove(row)
            return _Result(matched)
        if query.order_by:
            column, desc = query.order_by
            matched.sort(key=lambda r: str(r.get(column)), reverse=desc)
        if query.limit_n is not None:
            matched = matched[: query.limit_n]
        return _Result(matched)


class FakeSupabase:
    def __init__(self, rows=None, hooks=None) -> None:
        self.db: dict = rows or {}
        self.hooks: dict = hooks or {}

    def table(self, name: str) -> _Table:
        return _Table(name, self.db, self.hooks)


def _iso(offset_seconds: float = 0.0) -> str:
    return time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + offset_seconds)
    )


def make_relay(rows=None, hooks=None) -> Mt5Relay:
    relay = Mt5Relay()
    relay._client = FakeSupabase(rows, hooks)
    relay._url, relay._key = "https://example.supabase.co", "service-role"
    return relay


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------
def test_stale_heartbeat_is_not_a_live_bridge():
    relay = make_relay(
        {
            "mt5_bridges": [
                {"id": "fresh", "status": "connected", "last_seen": _iso(-2)},
                {"id": "stale", "status": "connected", "last_seen": _iso(-600)},
            ]
        }
    )
    assert [b["id"] for b in relay.active_bridges()] == ["fresh"]


def test_pick_bridge_prefers_a_connected_one():
    relay = make_relay(
        {
            "mt5_bridges": [
                {"id": "idle", "status": "online", "last_seen": _iso(-1)},
                {"id": "ready", "status": "connected", "last_seen": _iso(-5)},
            ]
        }
    )
    assert relay.pick_bridge()["id"] == "ready"


def test_pick_bridge_returns_none_when_no_agent_is_online():
    relay = make_relay({"mt5_bridges": [{"id": "gone", "status": "offline", "last_seen": _iso(-900)}]})
    assert relay.pick_bridge() is None


def test_disabled_relay_reports_no_bridges():
    assert Mt5Relay().active_bridges() == []
    assert Mt5Relay().pick_bridge() is None


# ---------------------------------------------------------------------------
# cached reads
# ---------------------------------------------------------------------------
def test_quote_reads_the_pushed_tick_and_ages_it():
    relay = make_relay(
        {
            "mt5_quotes": [
                {"bridge_id": "b1", "symbol": "XAUUSD", "bid": 2000.0, "ask": 2000.4,
                 "last": 2000.2, "spread": 0.4, "digits": 2, "volume": 12.0,
                 "tick_time": 1, "updated_at": _iso(-1)}
            ]
        }
    )
    row = relay.quote("b1", "XAUUSD")
    assert row is not None
    assert row["bid"] == 2000.0
    assert row["_age_seconds"] >= 1.0


def test_quote_is_none_for_an_unknown_symbol():
    relay = make_relay({"mt5_quotes": []})
    assert relay.quote("b1", "NOPE") is None


# ---------------------------------------------------------------------------
# command round-trip
# ---------------------------------------------------------------------------
def test_send_command_returns_the_agent_result():
    def complete(row):
        row["status"] = "done"
        row["result"] = {"executed": True, "ticket": 42}

    relay = make_relay({}, {"mt5_commands": complete})
    outcome = relay.send_command("b1", "place_order", {"symbol": "XAUUSD"}, timeout_seconds=2)
    assert outcome["ok"] is True
    assert outcome["result"]["ticket"] == 42


def test_send_command_surfaces_agent_errors():
    def fail(row):
        row["status"] = "error"
        row["error"] = "invalid volume"

    relay = make_relay({}, {"mt5_commands": fail})
    outcome = relay.send_command("b1", "place_order", {}, timeout_seconds=2)
    assert outcome["ok"] is False
    assert "invalid volume" in outcome["error"]


def test_send_command_times_out_rather_than_hanging():
    relay = make_relay({})  # nothing ever answers
    started = time.time()
    outcome = relay.send_command("b1", "candles", {}, timeout_seconds=1, poll_seconds=0.2)
    assert outcome["ok"] is False
    assert "did not answer" in outcome["error"]
    assert time.time() - started < 5


def test_send_command_delegates_expiry_to_postgres():
    relay = make_relay({})
    relay.send_command("b1", "status", {}, timeout_seconds=0.4, poll_seconds=0.2)
    inserted = relay._client.db["mt5_commands"][0]
    # expires_at / created_at must be left to their column defaults.
    assert "expires_at" not in inserted
    assert inserted["kind"] == "status"
    assert inserted["status"] == "pending"


def test_disabled_relay_refuses_commands():
    outcome = Mt5Relay().send_command("b1", "status")
    assert outcome["ok"] is False


# ---------------------------------------------------------------------------
# MT5Bridge integration (mt5 is None on every non-Windows runtime)
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _reset_bridge():
    bridge = mt5_executor.bridge
    saved_relay = mt5_executor.relay
    saved_error = bridge._last_error
    yield
    mt5_executor.relay = saved_relay
    bridge._last_error = saved_error


def _install(relay: Mt5Relay):
    mt5_executor.relay = relay


def test_status_reports_relay_when_an_agent_is_connected():
    _install(
        make_relay(
            {
                "mt5_bridges": [
                    {
                        "id": "b1",
                        "name": "TRADING-PC",
                        "status": "connected",
                        "last_seen": _iso(-1),
                        "account": {"login": 1234, "server": "Broker-Demo"},
                        "terminal": {"company": "Broker"},
                    }
                ]
            }
        )
    )
    status = mt5_executor.bridge.status(None)
    assert status["available"] is True
    assert status["connected"] is True
    assert status["mode"] == "relay"
    assert status["account"]["login"] == 1234
    assert status["relay"]["name"] == "TRADING-PC"


def test_status_stays_unavailable_without_an_agent():
    _install(make_relay({"mt5_bridges": []}))
    status = mt5_executor.bridge.status(None)
    assert status["available"] is False
    assert status["mode"] == "unavailable"
    assert "bridge_agent.py" in status["reason"]


def test_price_uses_the_pushed_quote():
    _install(
        make_relay(
            {
                "mt5_bridges": [{"id": "b1", "status": "connected", "last_seen": _iso(-1)}],
                "mt5_quotes": [
                    {"bridge_id": "b1", "symbol": "XAUUSD", "bid": 1800.0, "ask": 1800.5,
                     "last": 1800.2, "spread": 0.5, "digits": 2, "volume": 3.0,
                     "tick_time": 99, "updated_at": _iso(-1)}
                ],
            }
        )
    )
    quote = mt5_executor.bridge.price("XAUUSD")
    assert quote["available"] is True
    assert quote["bid"] == 1800.0
    assert quote["ask"] == 1800.5
    assert quote["via"] == "relay"
    assert quote["relay"]["id"] == "b1"


def test_stale_quote_triggers_a_command_round_trip():
    def complete(row):
        row["status"] = "done"
        row["result"] = {"available": True, "symbol": "EURUSD", "bid": 1.1, "ask": 1.1002,
                         "last": 1.1001, "spread": 0.0002, "digits": 5, "volume": 0.0, "time": 7}

    _install(
        make_relay(
            {
                "mt5_bridges": [{"id": "b1", "status": "connected", "last_seen": _iso(-1)}],
                "mt5_quotes": [
                    {"bridge_id": "b1", "symbol": "EURUSD", "bid": 1.0, "ask": 1.0,
                     "last": 1.0, "spread": 0.0, "digits": 5, "volume": 0.0,
                     "tick_time": 1, "updated_at": _iso(-600)}
                ],
            },
            {"mt5_commands": complete},
        )
    )
    quote = mt5_executor.bridge.price("EURUSD")
    assert quote["available"] is True
    assert quote["bid"] == 1.1
    assert quote["via"] == "relay"


def test_place_order_relays_to_the_agent():
    seen = {}

    def complete(row):
        seen["kind"] = row["kind"]
        seen["payload"] = row["payload"]
        row["status"] = "done"
        row["result"] = {"executed": True, "mode": "live", "ticket": 7}

    _install(
        make_relay(
            {"mt5_bridges": [{"id": "b1", "status": "connected", "last_seen": _iso(-1)}]},
            {"mt5_commands": complete},
        )
    )
    outcome = mt5_executor.bridge.place_order({"symbol": "XAUUSD", "side": "buy", "volume": 0.02})
    assert outcome["executed"] is True
    assert outcome["ticket"] == 7
    assert seen["kind"] == "place_order"
    assert seen["payload"]["volume"] == 0.02


def test_place_order_shadow_fills_when_no_agent_is_online():
    _install(make_relay({"mt5_bridges": []}))
    result = mt5_executor.bridge.place_order({"symbol": "XAUUSD"})
    assert result["executed"] is False
    assert result["mode"] == "shadow"


def test_candles_fall_back_to_the_agent():
    def complete(row):
        row["status"] = "done"
        row["result"] = {
            "available": True,
            "symbol": "XAUUSD",
            "timeframe": "H1",
            "digits": 2,
            "candles": [{"t": 1, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 3.0}],
        }

    _install(
        make_relay(
            {"mt5_bridges": [{"id": "b1", "status": "connected", "last_seen": _iso(-1)}]},
            {"mt5_commands": complete},
        )
    )
    series = mt5_executor.bridge.candles("XAUUSD", "H1", 10)
    assert series["available"] is True
    assert series["candles"][0]["c"] == 1.5
    assert series["via"] == "relay"
