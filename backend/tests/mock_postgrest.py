"""Tiny PostgREST stand-in used to exercise the Supabase client path offline.

Not part of the product — it exists so the persistence layer can be tested in
environments (CI, sandboxes) with no outbound access to Supabase::

    python tests/mock_postgrest.py 8123
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
                    existing.update(row)
                    stored.append(existing)
                    continue
            rows.append(row)
            stored.append(row)
        if "return=representation" in prefer or True:
            self._send(stored, 201)
        else:
            self._send([], 201)

    def do_PATCH(self):
        table = self._table()
        rows = DB.setdefault(table, [])
        body = self._read_body() or {}
        query = parse_qs(urlparse(self.path).query)
        updated = []
        for row in rows:
            if _match(row, query):
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
