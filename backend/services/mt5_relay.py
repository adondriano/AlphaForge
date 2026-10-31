"""Supabase relay for the Windows-side MT5 bridge agent.

Problem this solves
-------------------
``MetaTrader5`` is a Windows-only C extension that attaches to a terminal
process on the *same machine* over local IPC. A hosted engine (Vercel, any
Linux box) can neither import it nor reach the user's terminal — so live
quotes and real execution were impossible from the cloud.

The relay closes that gap through Supabase, which AlphaForge already depends
on. A small agent (``backend/bridge_agent.py``) runs on the Windows box next
to the terminal and:

* registers itself in ``mt5_bridges`` and refreshes ``last_seen`` (heartbeat),
* pushes ticks into ``mt5_quotes`` and OHLC into ``mt5_candles``,
* polls ``mt5_commands`` for work the engine needs done.

This module is the **engine side**. When no local MT5 is importable,
``MT5Bridge`` calls into it instead of returning "unavailable".

Latency and why reads are cached
--------------------------------
``price`` is polled by the live panel every few seconds, so it reads the
cached ``mt5_quotes`` row the agent pushes and only falls back to a command
round-trip when that row is missing or stale. Everything else (candles,
symbol list, connect, disconnect, orders) goes through a command round-trip
because correctness matters more than latency there.

Security
--------
``mt5_commands`` carries order instructions. It is created without any
anon/authenticated RLS policy whatsoever — only the service-role key (held by
the engine process and by the agent on the user's own PC) can read or write
it. Never add a permissive policy to that table.
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Dict, List, Optional

try:  # optional on minimal installs
    from supabase import create_client  # type: ignore
except Exception:  # pragma: no cover
    create_client = None  # type: ignore

BRIDGES = "mt5_bridges"
QUOTES = "mt5_quotes"
CANDLES = "mt5_candles"
COMMANDS = "mt5_commands"

#: A bridge that has not heartbeat within this window is considered gone.
DEFAULT_LIVENESS_SECONDS = 45.0

#: A pushed quote older than this is served but flagged; older than
#: ``DEFAULT_LIVENESS_SECONDS`` prompts a command round-trip.
QUOTE_FRESHNESS_SECONDS = 10.0


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_ts(value: Any) -> Optional[float]:
    """Parse a Postgres timestamptz string into an epoch float (UTC)."""
    if not value:
        return None
    from datetime import datetime, timezone

    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


class Mt5Relay:
    """Engine-side half of the bridge. Degrades to "no relay" everywhere."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._client: Any = None
        self._url = ""
        self._key = ""
        self._last_error: Optional[str] = None

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    def configure(self, url: str, key: str) -> bool:
        url = (url or "").strip()
        key = (key or "").strip()
        if not url or not key:
            self._client = None
            self._last_error = "no Supabase credentials configured"
            return False
        if create_client is None:
            self._client = None
            self._last_error = "supabase-py is not installed in this runtime"
            return False
        with self._lock:
            if url == self._url and key == self._key and self._client is not None:
                return True
            try:
                self._client = create_client(url, key)
                self._url, self._key = url, key
                self._last_error = None
                return True
            except Exception as exc:  # pragma: no cover
                self._client = None
                self._last_error = str(exc)
                return False

    @property
    def enabled(self) -> bool:
        return self._client is not None

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    def _table(self, name: str) -> Any:
        return self._client.table(name)

    # ------------------------------------------------------------------
    # discovery
    # ------------------------------------------------------------------
    def active_bridges(
        self, max_age_seconds: float = DEFAULT_LIVENESS_SECONDS
    ) -> List[Dict[str, Any]]:
        """Bridges that have heartbeated recently, newest first."""
        if not self.enabled:
            return []
        try:
            response = (
                self._table(BRIDGES)
                .select("*")
                .order("last_seen", desc=True)
                .limit(25)
                .execute()
            )
            rows = getattr(response, "data", None) or []
        except Exception as exc:
            self._last_error = str(exc)
            return []
        now = time.time()
        live: List[Dict[str, Any]] = []
        for row in rows:
            seen = _parse_ts(row.get("last_seen"))
            if seen is None or (now - seen) > max_age_seconds:
                continue
            row["_age_seconds"] = round(now - seen, 1)
            live.append(row)
        return live

    def pick_bridge(self) -> Optional[Dict[str, Any]]:
        """Most recently seen live bridge, preferring one already connected."""
        bridges = self.active_bridges()
        if not bridges:
            return None
        connected = [b for b in bridges if b.get("status") == "connected"]
        return (connected or bridges)[0]

    # ------------------------------------------------------------------
    # cached reads
    # ------------------------------------------------------------------
    def quote(self, bridge_id: str, symbol: str) -> Optional[Dict[str, Any]]:
        """Last tick pushed by the agent, or ``None`` when unknown."""
        if not self.enabled:
            return None
        try:
            response = (
                self._table(QUOTES)
                .select("*")
                .eq("bridge_id", bridge_id)
                .eq("symbol", symbol)
                .limit(1)
                .execute()
            )
            rows = getattr(response, "data", None) or []
        except Exception as exc:
            self._last_error = str(exc)
            return None
        if not rows:
            return None
        row = dict(rows[0])
        updated = _parse_ts(row.get("updated_at"))
        row["_age_seconds"] = round(time.time() - updated, 1) if updated else None
        return row

    def cached_candles(
        self, bridge_id: str, symbol: str, timeframe: str, max_age_seconds: float = 60.0
    ) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        try:
            response = (
                self._table(CANDLES)
                .select("*")
                .eq("bridge_id", bridge_id)
                .eq("symbol", symbol)
                .eq("timeframe", timeframe)
                .limit(1)
                .execute()
            )
            rows = getattr(response, "data", None) or []
        except Exception as exc:
            self._last_error = str(exc)
            return None
        if not rows:
            return None
        row = dict(rows[0])
        updated = _parse_ts(row.get("updated_at"))
        age = (time.time() - updated) if updated else None
        if age is None or age > max_age_seconds:
            return None
        row["_age_seconds"] = round(age, 1)
        return row

    # ------------------------------------------------------------------
    # command round-trip
    # ------------------------------------------------------------------
    def send_command(
        self,
        bridge_id: str,
        kind: str,
        payload: Optional[Dict[str, Any]] = None,
        timeout_seconds: float = 30.0,
        poll_seconds: float = 0.25,
    ) -> Dict[str, Any]:
        """Insert a command and wait for the agent to answer it.

        Returns ``{"ok": True, "result": ...}`` or
        ``{"ok": False, "error": "..."}``. Never raises.
        """
        if not self.enabled:
            return {"ok": False, "error": self._last_error or "relay is not configured"}
        command_id = str(uuid.uuid4())
        # created_at / expires_at are left to their Postgres defaults.
        row = {
            "id": command_id,
            "bridge_id": bridge_id,
            "kind": kind,
            "payload": payload or {},
            "status": "pending",
        }
        try:
            self._table(COMMANDS).insert(row).execute()
        except Exception as exc:
            self._last_error = str(exc)
            return {"ok": False, "error": f"could not queue command: {exc}"}

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            time.sleep(poll_seconds)
            try:
                response = (
                    self._table(COMMANDS)
                    .select("status,result,error")
                    .eq("id", command_id)
                    .limit(1)
                    .execute()
                )
                rows = getattr(response, "data", None) or []
            except Exception as exc:
                self._last_error = str(exc)
                continue
            if not rows:
                continue
            status = rows[0].get("status")
            if status == "done":
                return {"ok": True, "result": rows[0].get("result") or {}}
            if status in ("error", "expired"):
                return {
                    "ok": False,
                    "error": rows[0].get("error") or f"command {status}",
                }
        return {
            "ok": False,
            "error": f"the bridge agent did not answer within {timeout_seconds:.0f}s",
        }


relay = Mt5Relay()
