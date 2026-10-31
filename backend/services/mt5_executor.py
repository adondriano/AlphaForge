"""MetaTrader 5 bridge.

``MetaTrader5`` is a Windows-only C extension, so it is imported lazily and
every failure mode degrades to a clearly-labelled shadow fill instead of
crashing the engine — the studio has to keep running on Linux/macOS servers.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

try:  # Windows + `pip install MetaTrader5` only
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # pragma: no cover
    mt5 = None  # type: ignore


class MT5Bridge:
    """Thin wrapper that always answers, connected or not."""

    def __init__(self) -> None:
        self._initialised = False
        self._last_error: Optional[str] = None

    # ------------------------------------------------------------------
    def connect(self, path: str = "", login: str = "", password: str = "",
                server: str = "") -> Dict[str, Any]:
        if mt5 is None:
            return {
                "connected": False,
                "mode": "shadow",
                "reason": "MetaTrader5 package is not available on this host "
                          "(Windows-only terminal bridge). Orders are filled in shadow mode.",
            }
        try:
            kwargs: Dict[str, Any] = {}
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
            info = mt5.account_info()
            return {
                "connected": True,
                "mode": "live",
                "account": {
                    "login": getattr(info, "login", None),
                    "server": getattr(info, "server", None),
                    "balance": getattr(info, "balance", None),
                    "equity": getattr(info, "equity", None),
                    "currency": getattr(info, "currency", None),
                    "leverage": getattr(info, "leverage", None),
                },
            }
        except Exception as exc:
            self._last_error = str(exc)
            return {"connected": False, "mode": "shadow", "reason": self._last_error}

    # ------------------------------------------------------------------
    def status(self, settings: Any = None) -> Dict[str, Any]:
        if mt5 is None or not self._initialised:
            return {
                "available": mt5 is not None,
                "connected": False,
                "mode": "shadow",
                "configured": bool(settings and (getattr(settings, "has_mt5", False))),
                "reason": "Not connected — running in shadow/paper mode." if mt5 is not None
                          else "MetaTrader5 is not installed in this runtime.",
            }
        try:
            info = mt5.account_info()
            terminal = mt5.terminal_info()
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
                    "currency": getattr(info, "currency", None),
                },
                "terminal": {
                    "name": getattr(terminal, "name", None),
                    "trade_allowed": getattr(terminal, "trade_allowed", None),
                },
            }
        except Exception as exc:
            return {"available": True, "connected": False, "mode": "shadow", "reason": str(exc)}

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
