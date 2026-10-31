"""Tiny PostgREST stand-in used to exercise the Supabase client path offline.

Not part of the product — it exists so the persistence layer can be tested in
environments (CI, sandboxes) with no outbound access to Supabase::

    python tests/mock_postgrest.py 8123

It deliberately mirrors the constraints declared in ``schema.sql``:

* ``optimizations_strategy_version_key``  unique (strategy_id, version)
* ``optimizations_one_active_idx``        unique (strategy_id) where is_active
* ``strategies_active_optimization_id_fkey``  -> optimizations(id)

without them the in-process store and PostgREST behave identically and real
Postgres-only failures (unique/foreign-key violations) slip through the suite.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, unquote

DB: dict[str, list[dict]] = {}


def _match(row: dict, filters: dict[str, list[str]]) -> bool:
    for key, values in filters.items():
        if key in ("select", "order", "limit", "offset"):
            continue
        for raw in values:
            for op in ("neq.", "eq.", "gt.", "gte.", "lt.", "lte.", "in."):
                if raw.startswith(op):
                    column = key
                    target = raw[len(op):]
                    actual = row.get(column)
                    if op == "eq." and str(actual) != target:
                        return False
                    if op == "neq." and str(actual) == target:
                        return False
                    if op == "gt." and not (actual is not None and float(actual) > float(target)):
                        return False
                    if op == "gte." and not (actual is not None and float(actual) >= float(target)):
                        return False
                    if op == "lt." and not (actual is not None and float(actual) < float(target)):
                        return False
                    if op == "lte." and not (actual is not None and float(actual) <= float(target)):
                        return False
                    break
            else:
                if str(row.get(key)) != raw:
                    return False
    return True


def _pg_error(code: str, message: str, details: str) -> dict:
    return {"code": code, "details": details, "hint": None, "message": message}


def _check(table: str, candidate: dict, row_id: str | None = None) -> dict | None:
    """Return a Postgres-shaped error dict when ``candidate`` breaks a constraint."""
    rows = DB.setdefault(table, [])

    if table == "optimizations":
        for other in rows:
            if other.get("id") == (row_id or candidate.get("id")):
                continue
            if (
                candidate.get("version") is not None
                and other.get("strategy_id") == candidate.get("strategy_id")
                and str(other.get("version")) == str(candidate.get("version"))
            ):
                return _pg_error(
                    "23505",
                    'duplicate key value violates unique constraint "optimizations_strategy_version_key"',
                    "Key (strategy_id, version)=({0}, {1}) already exists.".format(
                        candidate.get("strategy_id"), candidate.get("version")
                    ),
                )
            if (
                candidate.get("is_active")
                and other.get("is_active")
                and other.get("strategy_id") == candidate.get("strategy_id")
            ):
                return _pg_error(
                    "23505",
                    'duplicate key value violates unique constraint "optimizations_one_active_idx"',
                    "Key (strategy_id)=({0}) already exists.".format(candidate.get("strategy_id")),
                )

    if table == "strategies":
        active = candidate.get("active_optimization_id")
        if active:
            known = {row.get("id") for row in DB.setdefault("optimizations", [])}
            if active not in known:
                return _pg_error(
                    "23503",
                    'insert or update on table "strategies" violates foreign key '
                    'constraint "strategies_active_optimization_id_fkey"',
                    "Key (active_optimization_id)=({0}) is not present in table "
                    '"optimizations".'.format(active),
                )
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _read_body(self) -> dict | list | None:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return None
        return json.loads(self.rfile.read(length).decode("utf-8") or "null")

    def _send(self, payload, status: int = 200):
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _table(self) -> str:
        path = urlparse(self.path).path
        match = re.match(r"^/rest/v1/([A-Za-z0-9_]+)", path)
        return match.group(1) if match else ""

    # ------------------------------------------------------------------
    def do_GET(self):
        table = self._table()
        rows = DB.setdefault(table, [])
        query = parse_qs(urlparse(self.path).query)
        filtered = [r for r in rows if _match(r, query)]
        order = query.get("order", [])
        if order:
            column, _, direction = order[0].partition(".")
            filtered.sort(key=lambda r: str(r.get(column)), reverse=direction.lower() == "desc")
        if "limit" in query:
            filtered = filtered[: int(query["limit"][0])]
        self._send(filtered)

    def do_POST(self):
        table = self._table()
        rows = DB.setdefault(table, [])
        body = self._read_body()
        prefer = self.headers.get("Prefer", "")
        new_rows = body if isinstance(body, list) else [body or {}]
        stored = []
        for row in new_rows:
            row = dict(row)
            row.setdefault("id", str(uuid.uuid4()))
            if "resolution=merge-duplicates" in prefer:
                existing = next((r for r in rows if r.get("id") == row.get("id")), None)
                if existing:
                    merged = {**existing, **row}
                    violation = _check(table, merged, existing.get("id"))
                    if violation:
                        self._send(violation, 409)
                        return
                    existing.update(row)
                    stored.append(existing)
                    continue
            violation = _check(table, row)
            if violation:
                self._send(violation, 409)
                return
            rows.append(row)
            stored.append(row)
        self._send(stored, 201)

    def do_PATCH(self):
        table = self._table()
        rows = DB.setdefault(table, [])
        body = self._read_body() or {}
        query = parse_qs(urlparse(self.path).query)
        updated = []
        for row in rows:
            if _match(row, query):
                merged = {**row, **body}
                violation = _check(table, merged, row.get("id"))
                if violation:
                    self._send(violation, 409)
                    return
                row.update(body)
                updated.append(row)
        self._send(updated)

    def do_DELETE(self):
        table = self._table()
        rows = DB.setdefault(table, [])
        query = parse_qs(urlparse(self.path).query)
        keep, removed = [], []
        for row in rows:
            (removed if _match(row, query) else keep).append(row)
        DB[table] = keep
        self._send(removed)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
