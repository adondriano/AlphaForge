"""MetaTrader 5 bridge.

``MetaTrader5`` is a Windows-only C extension that talks to a terminal installed
on the *same machine*, so it is imported lazily and every failure mode degrades
to a clearly-labelled shadow fill instead of crashing the engine — the studio has
to keep running on Linux/macOS servers (Vercel included).

When the terminal *is* available this module exposes the pieces the live panels
need: connect/login, account state, streaming quotes and OHLC candles.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

try:  # Windows + `pip install MetaTrader5` only
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # pragma: no cover
    mt5 = None  # type: ignore


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
            return {
                "connected": False,
                "mode": "unavailable",
                "reason": "MetaTrader5 is a Windows-only package and is not installed in "
                          "this runtime. Run the Python engine locally on the machine that "
                          "has MetaTrader 5 to enable live quotes and execution; orders are "
                          "being filled in shadow mode here.",
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
            return {
                "available": False,
                "connected": False,
                "mode": "unavailable",
                "configured": bool(settings and getattr(settings, "has_mt5", False)),
                "reason": "MetaTrader5 is not installed in this runtime. It is a Windows-only "
                          "terminal bridge — run the engine locally (uvicorn main:app) on the "
                          "machine that has MetaTrader 5 to stream live quotes.",
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
            return {
                "available": False,
                "symbol": symbol,
                "reason": "No MetaTrader 5 terminal attached.",
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
            return {
                "available": False,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": [],
                "reason": "No MetaTrader 5 terminal attached.",
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
            return {"available": False, "symbols": []}
        try:
            rows = mt5.symbols_get(needle or "*")
            names = sorted({str(getattr(row, "name", "")) for row in (rows or [])})
            return {"available": True, "symbols": [n for n in names if n][:500]}
        except Exception as exc:
            return {"available": False, "symbols": [], "reason": str(exc)}

    # ------------------------------------------------------------------
    # trading
    # ------------------------------------------------------------------
    def place_order(self, order: Dict[str, Any]) -> Dict[str, Any]:
        """Send an order. Falls back to a deterministic shadow fill."""
        if mt5 is None or not self._initialised:
            return {
                "executed": False,
                "mode": "shadow",
                "ticket": None,
                "price": order.get("price"),
                "volume": order.get("volume"),
                "reason": "Shadow fill — no MT5 terminal attached.",
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
