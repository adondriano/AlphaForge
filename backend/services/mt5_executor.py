"""MetaTrader 5 bridge.

``MetaTrader5`` is a Windows-only C extension that talks to a terminal installed
on the *same machine*, so it is imported lazily and every failure mode degrades
to a clearly-labelled shadow fill instead of crashing the engine — the studio has
to keep running on Linux/macOS servers (Vercel included).

When the terminal *is* available this module exposes the pieces the live panels
need: connect/login, account state, streaming quotes and OHLC candles.

Two ways to reach a terminal
----------------------------
1. **Local** — ``MetaTrader5`` is importable and a terminal runs on this very
   machine (the Windows desktop case).
2. **Relay** — this runtime cannot import ``MetaTrader5`` (Vercel, Linux,
   macOS), so calls are forwarded over Supabase to ``bridge_agent.py`` running
   on the user's Windows box. See ``services/mt5_relay.py``.

Local always wins when available. Relay is attempted before falling back to
shadow mode, and every relay response is tagged ``"via": "relay"`` so the UI can
say where the number actually came from.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

try:  # Windows + `pip install MetaTrader5` only
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # pragma: no cover
    mt5 = None  # type: ignore

from services.mt5_relay import QUOTE_FRESHNESS_SECONDS, relay


# AlphaForge timeframe code -> MetaTrader5 timeframe constant
TIMEFRAME_CODES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1")


def _timeframe(code: str) -> Any:
    """Map an AlphaForge timeframe string onto the mt5 constant."""
    if mt5 is None:
        return None
    return getattr(mt5, f"TIMEFRAME_{code}", mt5.TIMEFRAME_H1)


def _digits(symbol: str) -> int:
    try:
        info = mt5.symbol_info(symbol)
        return int(getattr(info, "digits", 5) or 5)
    except Exception:
        return 5


class MT5Bridge:
    """Thin wrapper that always answers, connected or not."""

    def __init__(self) -> None:
        self._initialised = False
        self._last_error: Optional[str] = None
        self._account: Dict[str, Any] = {}

    # ------------------------------------------------------------------
    # relay helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _relay_bridge() -> Optional[Dict[str, Any]]:
        """Most recently heartbeated bridge agent, or None when none is live."""
        if not relay.enabled:
            return None
        try:
            return relay.pick_bridge()
        except Exception:
            return None

    @staticmethod
    def _relay_snapshot(bridge: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": bridge.get("id"),
            "name": bridge.get("name") or bridge.get("id"),
            "last_seen": bridge.get("last_seen"),
            "age_seconds": bridge.get("_age_seconds"),
        }

    @staticmethod
    def _relay_offline_reason() -> str:
        if not relay.enabled:
            return (
                "MetaTrader5 is a Windows-only package and is not installed in "
                "this runtime. Run the Python engine locally on the machine that "
                "has MetaTrader 5, or start the bridge agent "
                "(`python bridge_agent.py`) on that machine and configure "
                "Supabase so the engine can relay to it. Orders are being filled "
                "in shadow mode here."
            )
        return (
            "MetaTrader5 is not available in this runtime and no bridge agent is "
            "online. Start `python bridge_agent.py` on the Windows machine that "
            "has MetaTrader 5 — it registers itself over Supabase and this engine "
            "will relay quotes and orders through it. Orders are being filled in "
            "shadow mode until then."
        )

    def _relay_command(
        self, kind: str, payload: Optional[Dict[str, Any]] = None, timeout: float = 30.0
    ) -> Optional[Dict[str, Any]]:
        """Run a command on the live bridge. Returns the result dict or None."""
        bridge = self._relay_bridge()
        if not bridge:
            return None
        outcome = relay.send_command(
            str(bridge.get("id")), kind, payload or {}, timeout_seconds=timeout
        )
        if not outcome.get("ok"):
            self._last_error = str(outcome.get("error"))
            return None
        result = outcome.get("result") or {}
        result.setdefault("via", "relay")
        result["relay"] = self._relay_snapshot(bridge)
        return result

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    def connect(self, path: str = "", login: str = "", password: str = "",
                server: str = "", timeout: int = 60000) -> Dict[str, Any]:
        """Launch (or attach to) the terminal and log in.

        ``MetaTrader5.initialize(path=...)`` starts the terminal executable when
        it is not already running, which is what the Settings tab's
        "Launch & Connect" button drives.
        """
        if mt5 is None:
            # No local terminal — ask the Windows-side agent to connect instead.
            # Credentials travel inside the command row, which is readable only
            # with the service-role key and is deleted by the agent once handled.
            relayed = self._relay_command(
                "connect",
                {"path": path, "login": login, "password": password, "server": server,
                 "timeout": timeout},
                timeout=90.0,
            )
            if relayed is not None:
                self._account = relayed.get("account") or {}
                return relayed
            return {
                "connected": False,
                "mode": "unavailable",
                "reason": self._last_error or self._relay_offline_reason(),
            }

        try:
            kwargs: Dict[str, Any] = {"timeout": timeout}
            if path:
                kwargs["path"] = path
            if login:
                kwargs["login"] = int(login)
            if password:
                kwargs["password"] = password
            if server:
                kwargs["server"] = server

            ok = mt5.initialize(**kwargs) if kwargs else mt5.initialize()
            if not ok:
                self._last_error = str(mt5.last_error())
                return {"connected": False, "mode": "shadow", "reason": self._last_error}

            self._initialised = True

            # If credentials were supplied, `initialize` may have attached to an
            # already-running terminal on a different account — log in explicitly.
            if login and password and server:
                authorised = mt5.login(int(login), password=password, server=server)
                if not authorised:
                    self._last_error = str(mt5.last_error())
                    return {
                        "connected": False,
                        "mode": "shadow",
                        "reason": f"Terminal started but login failed: {self._last_error}",
                    }

            info = mt5.account_info()
            self._account = {
                "login": getattr(info, "login", None),
                "server": getattr(info, "server", None),
                "balance": getattr(info, "balance", None),
                "equity": getattr(info, "equity", None),
                "margin": getattr(info, "margin", None),
                "free_margin": getattr(info, "margin_free", None),
                "currency": getattr(info, "currency", None),
                "leverage": getattr(info, "leverage", None),
                "name": getattr(info, "name", None),
                "broker": getattr(info, "company", None),
            }
            return {
                "connected": True,
                "mode": "live",
                "account": self._account,
                "terminal": self._terminal_info(),
            }
        except Exception as exc:
            self._last_error = str(exc)
            return {"connected": False, "mode": "shadow", "reason": self._last_error}

    def disconnect(self) -> Dict[str, Any]:
        """Shut the terminal connection down."""
        if mt5 is None:
            relayed = self._relay_command("disconnect", timeout=20.0)
            self._account = {}
            return relayed or {
                "connected": False,
                "mode": "unavailable",
                "reason": self._last_error or self._relay_offline_reason(),
            }
        if mt5 is not None and self._initialised:
            try:
                mt5.shutdown()
            except Exception as exc:  # pragma: no cover
                self._last_error = str(exc)
        self._initialised = False
        self._account = {}
        return {"connected": False, "mode": "shadow", "reason": "Disconnected."}

    # ------------------------------------------------------------------
    # state
    # ------------------------------------------------------------------
    def _terminal_info(self) -> Dict[str, Any]:
        try:
            terminal = mt5.terminal_info()
            return {
                "name": getattr(terminal, "name", None),
                "company": getattr(terminal, "company", None),
                "path": getattr(terminal, "path", None),
                "trade_allowed": getattr(terminal, "trade_allowed", None),
                "connected": getattr(terminal, "connected", None),
                "build": getattr(terminal, "build", None),
            }
        except Exception:
            return {}

    def status(self, settings: Any = None) -> Dict[str, Any]:
        if mt5 is None:
            # No local terminal — fall back to the Supabase-relayed agent.
            bridge = self._relay_bridge()
            if bridge:
                connected = bridge.get("status") == "connected"
                return {
                    "available": True,
                    "connected": connected,
                    "mode": "relay" if connected else "shadow",
                    "configured": bool(settings and getattr(settings, "has_mt5", False)),
                    "account": bridge.get("account") or {},
                    "terminal": bridge.get("terminal") or {},
                    "relay": self._relay_snapshot(bridge),
                    "reason": None if connected else (bridge.get("error") or "Bridge agent is online but the terminal is not connected."),
                }
            return {
                "available": False,
                "connected": False,
                "mode": "unavailable",
                "configured": bool(settings and getattr(settings, "has_mt5", False)),
                "reason": self._relay_offline_reason(),
            }
        if not self._initialised:
            return {
                "available": True,
                "connected": False,
                "mode": "shadow",
                "configured": bool(settings and getattr(settings, "has_mt5", False)),
                "reason": "Not connected — running in shadow/paper mode.",
            }
        try:
            info = mt5.account_info()
            return {
                "available": True,
                "connected": True,
                "mode": "live",
                "configured": True,
                "account": {
                    "login": getattr(info, "login", None),
                    "server": getattr(info, "server", None),
                    "balance": getattr(info, "balance", None),
                    "equity": getattr(info, "equity", None),
                    "margin": getattr(info, "margin", None),
                    "free_margin": getattr(info, "margin_free", None),
                    "currency": getattr(info, "currency", None),
                    "leverage": getattr(info, "leverage", None),
                    "name": getattr(info, "name", None),
                    "broker": getattr(info, "company", None),
                },
                "terminal": self._terminal_info(),
            }
        except Exception as exc:
            return {"available": True, "connected": False, "mode": "shadow", "reason": str(exc)}

    # ------------------------------------------------------------------
    # market data
    # ------------------------------------------------------------------
    def price(self, symbol: str) -> Dict[str, Any]:
        """Current quote for ``symbol``."""
        if mt5 is None or not self._initialised:
            relayed = self._relay_price(symbol)
            if relayed is not None:
                return relayed
            return {
                "available": False,
                "symbol": symbol,
                "reason": self._last_error or "No MetaTrader 5 terminal attached.",
            }
        try:
            mt5.symbol_select(symbol, True)
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                return {
                    "available": False,
                    "symbol": symbol,
                    "reason": f"Symbol {symbol} not found on this terminal "
                              f"(last error: {mt5.last_error()}).",
                }
            bid = float(getattr(tick, "bid", 0.0) or 0.0)
            ask = float(getattr(tick, "ask", 0.0) or 0.0)
            digits = _digits(symbol)
            return {
                "available": True,
                "symbol": symbol,
                "bid": round(bid, digits),
                "ask": round(ask, digits),
                "last": round(float(getattr(tick, "last", 0.0) or 0.0), digits),
                "spread": round(ask - bid, digits),
                "digits": digits,
                "volume": float(getattr(tick, "volume", 0.0) or 0.0),
                "time": int(getattr(tick, "time", 0) or 0),
                "server_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        except Exception as exc:
            return {"available": False, "symbol": symbol, "reason": str(exc)}

    def candles(self, symbol: str, timeframe: str = "H1", count: int = 120) -> Dict[str, Any]:
        """Recent OHLC candles, oldest first."""
        if mt5 is None or not self._initialised:
            relayed = self._relay_candles(symbol, timeframe, count)
            if relayed is not None:
                return relayed
            return {
                "available": False,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": [],
                "reason": self._last_error or "No MetaTrader 5 terminal attached.",
            }
        try:
            mt5.symbol_select(symbol, True)
            count = max(1, min(int(count), 1000))
            raw = mt5.copy_rates_from_pos(symbol, _timeframe(timeframe), 0, count)
            if raw is None:
                return {
                    "available": False,
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "candles": [],
                    "reason": f"No rates for {symbol} ({mt5.last_error()}).",
                }
            candles: List[Dict[str, Any]] = [
                {
                    "t": int(row["time"]),
                    "o": float(row["open"]),
                    "h": float(row["high"]),
                    "l": float(row["low"]),
                    "c": float(row["close"]),
                    "v": float(row.get("tick_volume", 0) or 0),
                }
                for row in raw
            ]
            last = candles[-1]["c"] if candles else 0.0
            first = candles[0]["c"] if candles else 0.0
            return {
                "available": True,
                "symbol": symbol,
                "timeframe": timeframe,
                "digits": _digits(symbol),
                "candles": candles,
                "change": round(last - first, 8),
                "change_pct": round(((last - first) / first) * 100, 4) if first else 0.0,
            }
        except Exception as exc:
            return {
                "available": False,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": [],
                "reason": str(exc),
            }

    def symbols(self, needle: str = "") -> Dict[str, Any]:
        """Symbols the terminal actually offers — powers the broker-aware picker."""
        if mt5 is None or not self._initialised:
            relayed = self._relay_symbols(needle)
            if relayed is not None:
                return relayed
            return {"available": False, "symbols": []}
        try:
            rows = mt5.symbols_get(needle or "*")
            names = sorted({str(getattr(row, "name", "")) for row in (rows or [])})
            return {"available": True, "symbols": [n for n in names if n][:500]}
        except Exception as exc:
            return {"available": False, "symbols": [], "reason": str(exc)}

    # ------------------------------------------------------------------
    # relay market data
    # ------------------------------------------------------------------
    def _relay_price(self, symbol: str) -> Optional[Dict[str, Any]]:
        """Cached tick if it is fresh, otherwise a command round-trip."""
        bridge = self._relay_bridge()
        if not bridge:
            return None
        row = relay.quote(str(bridge.get("id")), symbol)
        age = (row or {}).get("_age_seconds")
        if row and age is not None and age <= QUOTE_FRESHNESS_SECONDS:
            digits = int(row.get("digits") or 5)
            return {
                "available": True,
                "symbol": symbol,
                "bid": round(float(row.get("bid") or 0.0), digits),
                "ask": round(float(row.get("ask") or 0.0), digits),
                "last": round(float(row.get("last") or 0.0), digits),
                "spread": round(float(row.get("spread") or 0.0), digits),
                "digits": digits,
                "volume": float(row.get("volume") or 0.0),
                "time": int(row.get("tick_time") or 0),
                "server_time": row.get("updated_at"),
                "quote_age_seconds": age,
                "via": "relay",
                "relay": self._relay_snapshot(bridge),
            }
        return self._relay_command("price", {"symbol": symbol}, timeout=12.0)

    def _relay_candles(
        self, symbol: str, timeframe: str, count: int
    ) -> Optional[Dict[str, Any]]:
        bridge = self._relay_bridge()
        if not bridge:
            return None
        cached = relay.cached_candles(str(bridge.get("id")), symbol, timeframe)
        if cached and (cached.get("candles") or []):
            series = list(cached["candles"])[-max(1, count):]
            first = series[0]["c"] if series else 0.0
            last = series[-1]["c"] if series else 0.0
            return {
                "available": True,
                "symbol": symbol,
                "timeframe": timeframe,
                "digits": int(cached.get("digits") or 5),
                "candles": series,
                "change": round(last - first, 8),
                "change_pct": round(((last - first) / first) * 100, 4) if first else 0.0,
                "candle_age_seconds": cached.get("_age_seconds"),
                "via": "relay",
                "relay": self._relay_snapshot(bridge),
            }
        return self._relay_command(
            "candles", {"symbol": symbol, "timeframe": timeframe, "count": count},
            timeout=25.0,
        )

    def _relay_symbols(self, needle: str = "") -> Optional[Dict[str, Any]]:
        bridge = self._relay_bridge()
        if not bridge:
            return None
        cached = bridge.get("symbols") or []
        if cached:
            term = (needle or "").strip().lower()
            names = sorted({str(n) for n in cached if n})
            if term:
                names = [n for n in names if term in n.lower()]
            return {
                "available": True,
                "symbols": names[:500],
                "via": "relay",
                "relay": self._relay_snapshot(bridge),
            }
        return self._relay_command("symbols", {"needle": needle}, timeout=20.0)

    # ------------------------------------------------------------------
    # trading
    # ------------------------------------------------------------------
    def place_order(self, order: Dict[str, Any]) -> Dict[str, Any]:
        """Send an order. Falls back to a deterministic shadow fill."""
        if mt5 is None or not self._initialised:
            relayed = self._relay_command("place_order", dict(order), timeout=30.0)
            if relayed is not None:
                return relayed
            return {
                "executed": False,
                "mode": "shadow",
                "ticket": None,
                "price": order.get("price"),
                "volume": order.get("volume"),
                "reason": self._last_error or "Shadow fill — no MT5 terminal attached.",
                "filled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        try:
            symbol = order.get("symbol", "XAUUSD")
            mt5.symbol_select(symbol, True)
            tick = mt5.symbol_info_tick(symbol)
            price = float(tick.ask if order.get("side") == "buy" else tick.bid)
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": float(order.get("volume") or 0.01),
                "type": mt5.ORDER_TYPE_BUY if order.get("side") == "buy" else mt5.ORDER_TYPE_SELL,
                "price": price,
                "sl": float(order["stop_loss"]) if order.get("stop_loss") else 0.0,
                "tp": float(order["take_profit"]) if order.get("take_profit") else 0.0,
                "magic": 20261031,
                "comment": "alphaforge",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
            result = mt5.order_send(request)
            return {
                "executed": result.retcode == mt5.TRADE_RETCODE_DONE,
                "mode": "live",
                "ticket": getattr(result, "order", None),
                "price": price,
                "volume": request["volume"],
                "retcode": getattr(result, "retcode", None),
                "comment": getattr(result, "comment", ""),
            }
        except Exception as exc:
            return {"executed": False, "mode": "live", "error": str(exc)}


bridge = MT5Bridge()
