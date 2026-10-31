"""AlphaForge MT5 bridge agent — run this on the Windows machine with MT5.

Why this exists
---------------
``MetaTrader5`` is a Windows-only C extension that attaches to a terminal on the
*same machine*. A hosted AlphaForge engine (Vercel, Linux, macOS) can therefore
never reach your terminal directly.

This agent is the missing half. It runs next to your terminal and relays over
Supabase:

    Vercel engine ──writes──► mt5_commands ──► this agent ──► MT5 terminal
    Vercel engine ◄──reads─── mt5_quotes   ◄── this agent ◄── MT5 terminal

Only this process ever imports ``MetaTrader5``.

Quick start
-----------
    cd backend
    pip install MetaTrader5==5.0.45 supabase python-dotenv
    set SUPABASE_URL=https://xxxx.supabase.co
    set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
    set MT5_LOGIN=12345678
    set MT5_PASSWORD=your-password
    set MT5_SERVER=Broker-Demo
    python bridge_agent.py

Then open AlphaForge → Settings → MetaTrader 5 bridge and press **Connect**.
The agent picks the command up within a second or two.

Credentials
-----------
The agent prefers its own environment variables. If ``MT5_LOGIN`` /
``MT5_PASSWORD`` / ``MT5_SERVER`` are not set here, it uses whatever the
Settings tab sent inside the connect command instead. Set them here if you can
— it keeps the password out of the database entirely.

Security
--------
* ``mt5_commands`` is service-role-only. Never grant anon or authenticated
  access to it: it carries order instructions and (when env vars are unset)
  your terminal password.
* Command rows are deleted by this agent as soon as they are answered.
* ``SUPABASE_SERVICE_ROLE_KEY`` bypasses row level security. Keep this script
  on a machine you control and never commit the key.
"""

from __future__ import annotations

import os
import platform
import socket
import sys
import time
import uuid
from typing import Any, Dict, List, Optional

BRIDGE_ID = os.getenv("ALPHAFORGE_BRIDGE_ID") or f"agent-{uuid.uuid4().hex[:12]}"
BRIDGE_NAME = os.getenv("ALPHAFORGE_BRIDGE_NAME") or socket.gethostname() or BRIDGE_ID

HEARTBEAT_SECONDS = float(os.getenv("ALPHAFORGE_HEARTBEAT_SECONDS", "5"))
POLL_SECONDS = float(os.getenv("ALPHAFORGE_POLL_SECONDS", "0.75"))
QUOTE_SYMBOLS = [
    s.strip()
    for s in (os.getenv("ALPHAFORGE_QUOTE_SYMBOLS", "XAUUSD,EURUSD,GBPUSD,USDJPY,NAS100")
              .split(","))
    if s.strip()
]
CANDLE_JOBS = [
    tuple(p.strip() for p in job.split(":"))
    for job in os.getenv("ALPHAFORGE_CANDLE_JOBS", "XAUUSD:H1:240").split(",")
    if job.strip()
]
CANDLE_REFRESH_SECONDS = float(os.getenv("ALPHAFORGE_CANDLE_REFRESH_SECONDS", "60"))

BRIDGES = "mt5_bridges"
QUOTES = "mt5_quotes"
CANDLES = "mt5_candles"
COMMANDS = "mt5_commands"


def log(message: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# MT5 (imported lazily so the module can be imported for tests on any OS)
# ---------------------------------------------------------------------------
def load_mt5() -> Any:
    try:
        import MetaTrader5 as mt5  # type: ignore

        return mt5
    except Exception as exc:
        log(f"MetaTrader5 could not be imported: {exc}")
        log("Install it with:  pip install MetaTrader5==5.0.45")
        log("It is a Windows-only package and needs 64-bit Python 3.9-3.12.")
        return None


class Agent:
    def __init__(self, client: Any, mt5: Any) -> None:
        self.client = client
        self.mt5 = mt5
        self.initialised = False
        self.last_candle_push = 0.0
        self._stop = False

    # ------------------------------------------------------------------
    # persistence helpers
    # ------------------------------------------------------------------
    def table(self, name: str) -> Any:
        return self.client.table(name)

    def upsert_bridge(self, status: str, error: Optional[str] = None) -> None:
        account: Dict[str, Any] = {}
        terminal: Dict[str, Any] = {}
        symbols: List[str] = []
        if self.initialised and self.mt5 is not None:
            try:
                info = self.mt5.account_info()
                account = {
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
            except Exception as exc:
                account = {"error": str(exc)}
            try:
                term = self.mt5.terminal_info()
                terminal = {
                    "name": getattr(term, "name", None),
                    "company": getattr(term, "company", None),
                    "path": getattr(term, "path", None),
                    "build": getattr(term, "build", None),
                    "trade_allowed": getattr(term, "trade_allowed", None),
                    "connected": getattr(term, "connected", None),
                }
            except Exception as exc:
                terminal = {"error": str(exc)}
            symbols = self.symbol_names()
        try:
            self.table(BRIDGES).upsert(
                {
                    "id": BRIDGE_ID,
                    "name": BRIDGE_NAME,
                    "status": status,
                    "last_seen": _now(),
                    "account": account,
                    "terminal": terminal,
                    "symbols": symbols,
                    "error": error,
                }
            ).execute()
        except Exception as exc:
            log(f"could not update bridge row: {exc}")

    # ------------------------------------------------------------------
    # MT5 operations
    # ------------------------------------------------------------------
    def connect(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.mt5 is None:
            return {"connected": False, "error": "MetaTrader5 is not importable here"}
        # Environment wins; the Settings tab is only a fallback.
        path = os.getenv("MT5_PATH") or payload.get("path") or ""
        login = os.getenv("MT5_LOGIN") or str(payload.get("login") or "")
        password = os.getenv("MT5_PASSWORD") or str(payload.get("password") or "")
        server = os.getenv("MT5_SERVER") or str(payload.get("server") or "")
        timeout = int(payload.get("timeout") or 60000)

        kwargs: Dict[str, Any] = {"timeout": timeout}
        if path:
            kwargs["path"] = path
        if login:
            try:
                kwargs["login"] = int(login)
            except ValueError:
                return {"connected": False, "error": f"MT5_LOGIN is not numeric: {login!r}"}
        if password:
            kwargs["password"] = password
        if server:
            kwargs["server"] = server

        try:
            ok = self.mt5.initialize(**kwargs) if kwargs else self.mt5.initialize()
        except Exception as exc:
            self.initialised = False
            return {"connected": False, "error": str(exc)}
        if not ok:
            self.initialised = False
            return {"connected": False, "error": str(self.mt5.last_error())}
        self.initialised = True

        if login and password and server:
            try:
                if not self.mt5.login(int(login), password=password, server=server):
                    self.initialised = False
                    return {
                        "connected": False,
                        "error": f"login failed: {self.mt5.last_error()}",
                    }
            except Exception as exc:
                self.initialised = False
                return {"connected": False, "error": str(exc)}

        return {"connected": True, "mode": "live"}

    def disconnect(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.mt5 is not None and self.initialised:
            try:
                self.mt5.shutdown()
            except Exception:
                pass
        self.initialised = False
        return {"connected": False}

    def symbol_names(self, needle: str = "") -> List[str]:
        if self.mt5 is None or not self.initialised:
            return []
        try:
            rows = self.mt5.symbols_get(needle or "*")
            names = sorted({str(getattr(r, "name", "")) for r in (rows or [])})
            return [n for n in names if n][:500]
        except Exception:
            return []

    def price(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        symbol = str(payload.get("symbol") or "XAUUSD")
        return self._read_tick(symbol)

    def _read_tick(self, symbol: str) -> Dict[str, Any]:
        if self.mt5 is None or not self.initialised:
            return {"available": False, "symbol": symbol, "reason": "terminal not connected"}
        try:
            self.mt5.symbol_select(symbol, True)
            tick = self.mt5.symbol_info_tick(symbol)
            if tick is None:
                return {
                    "available": False,
                    "symbol": symbol,
                    "reason": f"no tick for {symbol}: {self.mt5.last_error()}",
                }
            digits = 5
            try:
                digits = int(self.mt5.symbol_info(symbol).digits or 5)
            except Exception:
                pass
            bid = float(getattr(tick, "bid", 0.0) or 0.0)
            ask = float(getattr(tick, "ask", 0.0) or 0.0)
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
            }
        except Exception as exc:
            return {"available": False, "symbol": symbol, "reason": str(exc)}

    def candles(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        symbol = str(payload.get("symbol") or "XAUUSD")
        timeframe = str(payload.get("timeframe") or "H1").upper()
        count = max(1, min(int(payload.get("count") or 120), 1000))
        if self.mt5 is None or not self.initialised:
            return {
                "available": False,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": [],
                "reason": "terminal not connected",
            }
        try:
            self.mt5.symbol_select(symbol, True)
            const = getattr(self.mt5, f"TIMEFRAME_{timeframe}", self.mt5.TIMEFRAME_H1)
            raw = self.mt5.copy_rates_from_pos(symbol, const, 0, count)
            if raw is None:
                return {
                    "available": False,
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "candles": [],
                    "reason": f"no rates for {symbol}: {self.mt5.last_error()}",
                }
            series = [
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
            digits = 5
            try:
                digits = int(self.mt5.symbol_info(symbol).digits or 5)
            except Exception:
                pass
            return {
                "available": True,
                "symbol": symbol,
                "timeframe": timeframe,
                "digits": digits,
                "candles": series,
            }
        except Exception as exc:
            return {
                "available": False,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": [],
                "reason": str(exc),
            }

    def symbols(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {"available": self.initialised, "symbols": self.symbol_names(str(payload.get("needle") or ""))}

    def place_order(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.mt5 is None or not self.initialised:
            return {"executed": False, "mode": "shadow", "reason": "terminal not connected"}
        try:
            symbol = str(payload.get("symbol") or "XAUUSD")
            side = str(payload.get("side") or "buy").lower()
            volume = float(payload.get("volume") or 0.01)
            self.mt5.symbol_select(symbol, True)
            tick = self.mt5.symbol_info_tick(symbol)
            price = float(tick.ask if side == "buy" else tick.bid)
            request = {
                "action": self.mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": self.mt5.ORDER_TYPE_BUY if side == "buy" else self.mt5.ORDER_TYPE_SELL,
                "price": price,
                "sl": float(payload["stop_loss"]) if payload.get("stop_loss") else 0.0,
                "tp": float(payload["take_profit"]) if payload.get("take_profit") else 0.0,
                "magic": 20261031,
                "comment": "alphaforge",
                "type_time": self.mt5.ORDER_TIME_GTC,
                "type_filling": self.mt5.ORDER_FILLING_IOC,
            }
            result = self.mt5.order_send(request)
            return {
                "executed": result.retcode == self.mt5.TRADE_RETCODE_DONE,
                "mode": "live",
                "ticket": getattr(result, "order", None),
                "price": price,
                "volume": volume,
                "retcode": getattr(result, "retcode", None),
                "comment": getattr(result, "comment", ""),
            }
        except Exception as exc:
            return {"executed": False, "mode": "live", "error": str(exc)}

    # ------------------------------------------------------------------
    # pushing data up
    # ------------------------------------------------------------------
    def push_quotes(self) -> None:
        if not self.initialised:
            return
        rows = []
        for symbol in QUOTE_SYMBOLS:
            tick = self._read_tick(symbol)
            if not tick.get("available"):
                continue
            rows.append(
                {
                    "bridge_id": BRIDGE_ID,
                    "symbol": symbol,
                    "bid": tick["bid"],
                    "ask": tick["ask"],
                    "last": tick["last"],
                    "spread": tick["spread"],
                    "digits": tick["digits"],
                    "volume": tick["volume"],
                    "tick_time": tick["time"],
                    "updated_at": _now(),
                }
            )
        if not rows:
            return
        try:
            self.table(QUOTES).upsert(rows).execute()
        except Exception as exc:
            log(f"could not push quotes: {exc}")

    def push_candles(self, force: bool = False) -> None:
        if not self.initialised:
            return
        now = time.time()
        if not force and (now - self.last_candle_push) < CANDLE_REFRESH_SECONDS:
            return
        self.last_candle_push = now
        for job in CANDLE_JOBS:
            symbol = job[0] if len(job) > 0 else "XAUUSD"
            timeframe = (job[1] if len(job) > 1 else "H1").upper()
            count = int(job[2]) if len(job) > 2 and str(job[2]).isdigit() else 240
            result = self.candles({"symbol": symbol, "timeframe": timeframe, "count": count})
            if not result.get("available"):
                continue
            try:
                self.table(CANDLES).upsert(
                    {
                        "bridge_id": BRIDGE_ID,
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "digits": result.get("digits", 5),
                        "candles": result["candles"],
                        "updated_at": _now(),
                    }
                ).execute()
            except Exception as exc:
                log(f"could not push candles for {symbol} {timeframe}: {exc}")

    # ------------------------------------------------------------------
    # command loop
    # ------------------------------------------------------------------
    HANDLERS = {
        "connect": "connect",
        "disconnect": "disconnect",
        "status": None,
        "price": "price",
        "candles": "candles",
        "symbols": "symbols",
        "place_order": "place_order",
    }

    def handle(self, command: Dict[str, Any]) -> None:
        command_id = command.get("id")
        kind = str(command.get("kind") or "")
        payload = command.get("payload") or {}
        # Claim it so a second agent (or a retry) cannot run it twice.
        try:
            claimed = (
                self.table(COMMANDS)
                .update({"status": "processing", "claimed_at": _now()})
                .eq("id", command_id)
                .eq("status", "pending")
                .execute()
            )
            if not (getattr(claimed, "data", None) or []):
                return
        except Exception as exc:
            log(f"could not claim command {command_id}: {exc}")
            return

        log(f"command {kind} ({command_id})")
        try:
            if kind == "status":
                result: Dict[str, Any] = {
                    "connected": self.initialised,
                    "mode": "live" if self.initialised else "shadow",
                }
            else:
                method_name = self.HANDLERS.get(kind)
                if not method_name:
                    raise ValueError(f"unknown command kind: {kind}")
                result = getattr(self, method_name)(payload)
            if kind in ("connect", "disconnect"):
                self.upsert_bridge("connected" if self.initialised else "online")
                if self.initialised:
                    self.push_quotes()
                    self.push_candles(force=True)
            self.table(COMMANDS).update(
                {"status": "done", "result": result, "completed_at": _now()}
            ).eq("id", command_id).execute()
        except Exception as exc:
            log(f"command {kind} failed: {exc}")
            try:
                self.table(COMMANDS).update(
                    {"status": "error", "error": str(exc), "completed_at": _now()}
                ).eq("id", command_id).execute()
            except Exception:
                pass
        finally:
            # Delete the row: it can carry credentials and it is spent anyway.
            try:
                self.table(COMMANDS).delete().eq("id", command_id).execute()
            except Exception:
                pass

    def poll(self) -> None:
        try:
            response = (
                self.table(COMMANDS)
                .select("*")
                .eq("bridge_id", BRIDGE_ID)
                .eq("status", "pending")
                .order("created_at")
                .limit(10)
                .execute()
            )
            for command in getattr(response, "data", None) or []:
                if self._stop:
                    return
                self.handle(command)
        except Exception as exc:
            log(f"command poll failed: {exc}")

    # ------------------------------------------------------------------
    def run(self) -> None:
        log(f"bridge id     : {BRIDGE_ID}")
        log(f"bridge name   : {BRIDGE_NAME}")
        log(f"platform      : {platform.platform()}")
        log(f"quote symbols : {', '.join(QUOTE_SYMBOLS) or '(none)'}")
        log(f"candle jobs   : {', '.join(':'.join(j) for j in CANDLE_JOBS) or '(none)'}")

        auto = all(os.getenv(k) for k in ("MT5_LOGIN", "MT5_PASSWORD", "MT5_SERVER"))
        if auto:
            log("credentials found in the environment — connecting on startup")
            outcome = self.connect({})
            if outcome.get("connected"):
                log("connected to the terminal")
            else:
                log(f"startup connect failed: {outcome.get('error')}")
        else:
            log("no MT5_LOGIN/PASSWORD/SERVER in the environment — waiting for a")
            log("connect command from the AlphaForge Settings tab")

        last_heartbeat = 0.0
        while not self._stop:
            try:
                self.poll()
                self.push_quotes()
                self.push_candles()
                now = time.time()
                if (now - last_heartbeat) >= HEARTBEAT_SECONDS:
                    last_heartbeat = now
                    self.upsert_bridge("connected" if self.initialised else "online")
            except KeyboardInterrupt:
                break
            except Exception as exc:  # never let the loop die
                log(f"loop error: {exc}")
            time.sleep(POLL_SECONDS)

    def stop(self) -> None:
        self._stop = True
        try:
            self.upsert_bridge("offline")
        except Exception:
            pass


def main() -> int:
    url = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.", file=sys.stderr)
        print("Copy them from your Supabase project settings (service role key).", file=sys.stderr)
        return 2

    try:
        from supabase import create_client  # type: ignore
    except Exception:
        print("supabase-py is missing. Run:  pip install supabase", file=sys.stderr)
        return 2

    mt5 = load_mt5()
    if mt5 is None:
        return 2

    try:
        client = create_client(url, key)
    except Exception as exc:
        print(f"could not create the Supabase client: {exc}", file=sys.stderr)
        return 2

    agent = Agent(client, mt5)
    try:
        agent.run()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        agent.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
