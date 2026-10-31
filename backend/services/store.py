"""Persistence layer — Supabase first, in-memory fallback always available.

AlphaForge must stay usable when no credentials are configured (local dev,
CI, a fresh Vercel preview). Every method therefore has a fully functional
in-memory twin; the API surface is identical either way.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

try:  # optional on minimal installs
    from supabase import Client, create_client  # type: ignore
except Exception:  # pragma: no cover
    Client = None  # type: ignore
    create_client = None  # type: ignore

STRATEGIES = "strategies"
OPTIMIZATIONS = "optimizations"
TRADE_LOGS = "trade_logs"
APP_SETTINGS = "app_settings"

SETTINGS_ID = "default"

_STATE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".local_state.json")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_id() -> str:
    return str(uuid.uuid4())


class Store:
    """Thread-safe CRUD wrapper over Supabase Postgres."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._client: Any = None
        self._url: str = ""
        self._key: str = ""
        self._last_error: Optional[str] = None
        self._memory: Dict[str, List[Dict[str, Any]]] = {
            STRATEGIES: [],
            OPTIMIZATIONS: [],
            TRADE_LOGS: [],
        }
        self._settings: Dict[str, Any] = {}
        self._load_local_state()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    def configure(self, url: str, key: str) -> bool:
        """(Re)create the Supabase client. Returns True when connected."""
        url = (url or "").strip()
        key = (key or "").strip()
        if not url or not key:
            self._client = None
            self._last_error = None
            return False
        if create_client is None:
            self._client = None
            self._last_error = "supabase-py is not installed in this runtime"
            return False
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

    @property
    def mode(self) -> str:
        return "supabase" if self.enabled else "memory"

    def health(self) -> Dict[str, Any]:
        detail: Dict[str, Any] = {
            "mode": self.mode,
            "url": self._url or None,
            "error": self._last_error,
        }
        if self.enabled:
            try:
                response = self._client.table(STRATEGIES).select("id", count="exact").limit(1).execute()
                detail["reachable"] = True
                detail["strategies"] = getattr(response, "count", None)
            except Exception as exc:
                detail["reachable"] = False
                detail["error"] = str(exc)
        else:
            detail["reachable"] = False
            detail["counts"] = {k: len(v) for k, v in self._memory.items()}
        return detail

    # ------------------------------------------------------------------
    # generic helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _maybe_select(builder: Any) -> Any:
        """Ask for the inserted/upserted row back.

        postgrest < 0.16 exposes ``.select()`` after ``insert()``; 0.16+ returns
        the representation by default and the builder has no ``select``. Support
        both so the pin in requirements.txt can float.
        """
        try:
            return builder.select("*")
        except AttributeError:
            return builder

    def _remote(self, table: str, build: Any, fallback: Any) -> Any:
        """Run ``build()`` against Supabase; degrade to ``fallback()`` on any error."""
        try:
            return self._run(table, build())
        except Exception as exc:  # network, schema, permission — never 500 the API
            self._last_error = f"{table}: {exc}"
            return fallback()

    def _run(self, table: str, builder: Any) -> List[Dict[str, Any]]:
        """Execute a Supabase query, never raising."""
        try:
            response = builder.execute()
        except Exception as exc:
            self._last_error = f"{table}: {exc}"
            raise RuntimeError(self._last_error) from exc
        data = getattr(response, "data", None)
        if data is None and isinstance(response, (list, tuple)):
            data = list(response)
        return data or []

    # ------------------------------------------------------------------
    # strategies
    # ------------------------------------------------------------------
    def list_strategies(self) -> List[Dict[str, Any]]:
        if not self.enabled:
            with self._lock:
                return [dict(row) for row in self._memory[STRATEGIES]]
        rows = self._remote(
            STRATEGIES,
            lambda: self._client.table(STRATEGIES).select("*").order("created_at", desc=False),
            lambda: [dict(r) for r in self._memory[STRATEGIES]],
        )
        return rows

    def get_strategy(self, strategy_id: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            with self._lock:
                for row in self._memory[STRATEGIES]:
                    if row.get("id") == strategy_id:
                        return dict(row)
            return None
        rows = self._remote(
            STRATEGIES,
            lambda: self._client.table(STRATEGIES).select("*").eq("id", strategy_id).limit(1),
            lambda: None,
        )
        if rows is None and not self.enabled:
            with self._lock:
                for row in self._memory[STRATEGIES]:
                    if row.get("id") == strategy_id:
                        return dict(row)
            return None
        return rows[0] if rows else None

    def insert_strategy(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        row = {**payload}
        row.setdefault("id", _new_id())
        row.setdefault("created_at", _now())
        row.setdefault("updated_at", _now())
        if not self.enabled:
            with self._lock:
                self._memory[STRATEGIES].append(dict(row))
                self._save_local_state()
            return dict(row)
        def build():
            return self._maybe_select(self._client.table(STRATEGIES).insert(row))

        def fallback():
            with self._lock:
                self._memory[STRATEGIES].append(dict(row))
            return dict(row)

        rows = self._remote(STRATEGIES, build, fallback)
        return rows[0] if isinstance(rows, list) and rows else (rows if isinstance(rows, dict) else row)

    def update_strategy(self, strategy_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        patch = {**patch, "updated_at": _now()}
        if not self.enabled:
            with self._lock:
                for row in self._memory[STRATEGIES]:
                    if row.get("id") == strategy_id:
                        row.update(patch)
                        self._save_local_state()
                        return dict(row)
            return None
        def build():
            builder = self._client.table(STRATEGIES).update(patch).eq("id", strategy_id)
            try:
                builder = builder.select("*")
            except AttributeError:
                pass
            return builder

        rows = self._remote(STRATEGIES, build, lambda: [])
        return rows[0] if isinstance(rows, list) and rows else None

    def delete_strategy(self, strategy_id: str) -> bool:
        if not self.enabled:
            with self._lock:
                before = len(self._memory[STRATEGIES])
                self._memory[STRATEGIES] = [
                    r for r in self._memory[STRATEGIES] if r.get("id") != strategy_id
                ]
                self._memory[OPTIMIZATIONS] = [
                    r for r in self._memory[OPTIMIZATIONS] if r.get("strategy_id") != strategy_id
                ]
                self._memory[TRADE_LOGS] = [
                    r for r in self._memory[TRADE_LOGS] if r.get("strategy_id") != strategy_id
                ]
                self._save_local_state()
                return len(self._memory[STRATEGIES]) < before
        def build():
            return self._client.table(STRATEGIES).delete().eq("id", strategy_id)

        self._remote(STRATEGIES, build, lambda: [])
        return True

    # ------------------------------------------------------------------
    # optimizations (parameter lineage)
    # ------------------------------------------------------------------
    def list_optimizations(self, strategy_id: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self.enabled:
            with self._lock:
                rows = [dict(r) for r in self._memory[OPTIMIZATIONS]]
            if strategy_id:
                rows = [r for r in rows if r.get("strategy_id") == strategy_id]
            return sorted(rows, key=lambda r: r.get("version") or 0)
        def build():
            query = self._client.table(OPTIMIZATIONS).select("*")
            if strategy_id:
                query = query.eq("strategy_id", strategy_id)
            return query.order("version", desc=False)

        def fallback():
            with self._lock:
                rows = [dict(r) for r in self._memory[OPTIMIZATIONS]]
            if strategy_id:
                rows = [r for r in rows if r.get("strategy_id") == strategy_id]
            return rows

        rows = self._remote(OPTIMIZATIONS, build, fallback)
        return rows

    def next_version(self, strategy_id: str) -> int:
        existing = self.list_optimizations(strategy_id)
        return max([int(r.get("version") or 0) for r in existing] or [0]) + 1

    def insert_optimization(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        row = {**payload}
        row.setdefault("id", _new_id())
        row.setdefault("created_at", _now())
        if not self.enabled:
            with self._lock:
                self._memory[OPTIMIZATIONS].append(dict(row))
                self._save_local_state()
            return dict(row)
        def build():
            return self._maybe_select(self._client.table(OPTIMIZATIONS).insert(row))

        def fallback():
            with self._lock:
                self._memory[OPTIMIZATIONS].append(dict(row))
            return dict(row)

        rows = self._remote(OPTIMIZATIONS, build, fallback)
        return rows[0] if isinstance(rows, list) and rows else (rows if isinstance(rows, dict) else row)

    def set_active_optimization(self, strategy_id: str, optimization_id: str) -> bool:
        """Flip exactly one version to active (the unique index enforces it in PG)."""
        if not self.enabled:
            with self._lock:
                for row in self._memory[OPTIMIZATIONS]:
                    if row.get("strategy_id") == strategy_id:
                        row["is_active"] = row.get("id") == optimization_id
                self._save_local_state()
            return True
        def build():
            self._run(
                OPTIMIZATIONS,
                self._client.table(OPTIMIZATIONS)
                .update({"is_active": False})
                .eq("strategy_id", strategy_id)
                .neq("id", optimization_id),
            )
            return (self._client.table(OPTIMIZATIONS)
                    .update({"is_active": True})
                    .eq("id", optimization_id))

        def fallback():
            with self._lock:
                for row in self._memory[OPTIMIZATIONS]:
                    if row.get("strategy_id") == strategy_id:
                        row["is_active"] = row.get("id") == optimization_id
                return True

        return bool(self._remote(OPTIMIZATIONS, build, fallback))

    # ------------------------------------------------------------------
    # trade logs
    # ------------------------------------------------------------------
    def insert_trade_log(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        row = {**payload}
        row.setdefault("id", _new_id())
        row.setdefault("opened_at", _now())
        if not self.enabled:
            with self._lock:
                self._memory[TRADE_LOGS].append(dict(row))
                if len(self._memory[TRADE_LOGS]) > 2000:
                    self._memory[TRADE_LOGS] = self._memory[TRADE_LOGS][-2000:]
                self._save_local_state()
            return dict(row)
        def build():
            return self._maybe_select(self._client.table(TRADE_LOGS).insert(row))

        def fallback():
            with self._lock:
                self._memory[TRADE_LOGS].append(dict(row))
            return dict(row)

        rows = self._remote(TRADE_LOGS, build, fallback)
        return rows[0] if isinstance(rows, list) and rows else (rows if isinstance(rows, dict) else row)

    def list_trade_logs(self, strategy_id: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit or 200), 1000))
        if not self.enabled:
            with self._lock:
                rows = [dict(r) for r in self._memory[TRADE_LOGS]]
            if strategy_id:
                rows = [r for r in rows if r.get("strategy_id") == strategy_id]
            rows.sort(key=lambda r: r.get("opened_at") or "")
            return rows[-limit:]
        def build():
            query = self._client.table(TRADE_LOGS).select("*")
            if strategy_id:
                query = query.eq("strategy_id", strategy_id)
            return query.order("opened_at", desc=True).limit(limit)

        def fallback():
            with self._lock:
                rows = [dict(r) for r in self._memory[TRADE_LOGS]]
            if strategy_id:
                rows = [r for r in rows if r.get("strategy_id") == strategy_id]
            rows.sort(key=lambda r: r.get("opened_at") or "")
            return rows[-limit:]

        rows = self._remote(TRADE_LOGS, build, fallback)
        return rows

    # ------------------------------------------------------------------
    # settings
    # ------------------------------------------------------------------
    def get_settings(self) -> Dict[str, Any]:
        if not self.enabled:
            with self._lock:
                return dict(self._settings)
        rows = self._remote(
            APP_SETTINGS,
            lambda: self._client.table(APP_SETTINGS).select("settings").eq("id", SETTINGS_ID).limit(1),
            lambda: [],
        )
        if rows:
            return (rows[0] or {}).get("settings") or {}
        with self._lock:
            return dict(self._settings)

    def save_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            merged = {**self._settings, **(patch or {})}
            self._settings = merged
        if not self.enabled:
            self._save_local_state()
            return dict(merged)
        def build():
            return self._maybe_select(
                self._client.table(APP_SETTINGS)
                .upsert({"id": SETTINGS_ID, "settings": merged, "updated_at": _now()})
            )

        rows = self._remote(APP_SETTINGS, build, lambda: [])
        if isinstance(rows, list) and rows:
            return (rows[0] or {}).get("settings") or dict(merged)
        return dict(merged)

    # ------------------------------------------------------------------
    # local fallback persistence (dev convenience only)
    # ------------------------------------------------------------------
    def _save_local_state(self) -> None:
        if self.enabled:
            return
        try:
            with open(_STATE_FILE, "w", encoding="utf-8") as handle:
                json.dump({"tables": self._memory, "settings": self._settings}, handle)
        except Exception:
            pass

    def _load_local_state(self) -> None:
        try:
            with open(_STATE_FILE, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            tables = payload.get("tables") or {}
            for name, rows in tables.items():
                if name in self._memory and isinstance(rows, list):
                    self._memory[name] = rows
            self._settings = payload.get("settings") or {}
        except Exception:
            pass


# module level singleton shared by the whole process
store = Store()
