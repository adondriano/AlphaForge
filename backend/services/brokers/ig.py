"""IG Group REST API.

Like Capital.com, IG is session based: ``POST /session`` returns ``CST`` and
``X-SECURITY-TOKEN``, and every call repeats them plus a ``Version`` header.
The engine re-authenticates per call so a serverless cold start can never be
holding a dead session.

IG identifies instruments by **epic** (``CS.D.XAUUSD.TODAY.IPO``) rather than a
ticker, so the symbol AlphaForge asks for is passed straight through as the
epic. Use ``GET /symbols`` (wired to the markets search) to discover the epics
your account can actually trade.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from .base import (
    MODE_LIVE,
    BrokerProvider,
    CredentialField,
    candles_result,
    now_iso,
    price_result,
    shadow_fill,
    unavailable,
)

DEMO = "https://demo-api.ig.com/gateway/deal"
LIVE = "https://api.ig.com/gateway/deal"

RESOLUTION = {
    "M1": "MINUTE", "M5": "MINUTE_5", "M15": "MINUTE_15", "M30": "MINUTE_30",
    "H1": "HOUR", "H4": "HOUR_4", "D1": "DAY", "W1": "WEEK", "MN1": "MONTH",
}


class IGProvider(BrokerProvider):
    id = "ig"
    label = "IG"
    docs_url = "https://labs.ig.com/rest-trading-api-reference"
    unsupported = ()

    fields = (
        CredentialField(
            key="identifier",
            label="Username",
            placeholder="your-ig-username",
            help="Your IG login, not your email.",
        ),
        CredentialField(
            key="password",
            label="Password",
            secret=True,
            placeholder="Your IG password",
            help="Stored encrypted.",
        ),
        CredentialField(
            key="api_key",
            label="API Key",
            secret=True,
            placeholder="From My Account → Settings → API keys",
            help="IG issues the key against your account; it is shown on the API page.",
        ),
        CredentialField(
            key="live",
            label="Environment",
            placeholder="demo",
            help="Type `live` to trade real money. Anything else uses the demo host.",
            required=False,
        ),
    )

    def _host(self, creds: Dict[str, Any]) -> str:
        raw = str(creds.get("live") or "").strip().lower()
        return LIVE if raw in {"live", "true", "1", "yes"} else DEMO

    def _session(self, creds: Dict[str, Any]) -> Dict[str, str]:
        host = self._host(creds)
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            response = client.post(
                f"{host}/session",
                headers={
                    "X-IG-API-KEY": str(creds.get("api_key") or "").strip(),
                    "Version": "2",
                    "Content-Type": "application/json",
                },
                json={
                    "identifier": str(creds.get("identifier") or "").strip(),
                    "password": str(creds.get("password") or ""),
                },
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"IG rejected the session ({response.status_code}): {response.text[:200]}"
            )
        cst = response.headers.get("CST")
        token = response.headers.get("X-SECURITY-TOKEN")
        if not (cst and token):
            raise RuntimeError("IG session response had no security token.")
        return {
            "CST": cst,
            "X-SECURITY-TOKEN": token,
            "X-IG-API-KEY": str(creds.get("api_key") or "").strip(),
            "Version": "2",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _call(
        self,
        creds: Dict[str, Any],
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        timeout: float = 12.0,
    ) -> Dict[str, Any]:
        headers = self._session(creds)
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.request(
                method.upper(), f"{self._host(creds)}{path}", headers=headers, json=body
            )
        if response.status_code >= 400:
            detail = ""
            try:
                blob = response.json()
                detail = blob.get("errorCode") or blob.get("message") or ""
            except ValueError:
                detail = response.text[:200]
            raise RuntimeError(f"IG {response.status_code}: {detail}")
        if not response.content:
            return {}
        return response.json()

    # ------------------------------------------------------------------
    def status(self, creds: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": False, "reason": problem}
        try:
            data = self._call(creds, "GET", "/accounts")
        except Exception as exc:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": True, "reason": str(exc)}

        rows = data.get("accounts") or []
        account = next((r for r in rows if r.get("preferred")), rows[0] if rows else {})
        balance = account.get("balance") or {}
        return {
            "available": True,
            "connected": True,
            "mode": MODE_LIVE,
            "configured": True,
            "provider": self.id,
            "account": {
                "login": account.get("accountId"),
                "server": "IG",
                "balance": _num(balance.get("balance")),
                "equity": _num(balance.get("balance")),
                "margin": _num(balance.get("deposit")),
                "free_margin": _num(balance.get("available")),
                "currency": account.get("currency"),
                "leverage": None,
                "name": account.get("accountName"),
                "broker": "IG",
            },
            "environment": "live" if self._host(creds) == LIVE else "demo",
            "via": "broker",
        }

    def price(self, creds: Dict[str, Any], symbol: str) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return unavailable(problem, symbol=symbol)
        try:
            data = self._call(creds, "GET", f"/markets/{symbol}")
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol)

        snap = data.get("snapshot") or {}
        bid = _num(snap.get("bid"))
        ask = _num(snap.get("offer"))
        if bid is None and ask is None:
            return unavailable(f"IG has no price for epic {symbol}.", symbol=symbol)
        bid = float(bid if bid is not None else ask)
        ask = float(ask if ask is not None else bid)
        return price_result(symbol, bid, ask, _digits(bid), via="ig")

    def candles(
        self,
        creds: Dict[str, Any],
        symbol: str,
        timeframe: str = "H1",
        count: int = 120,
    ) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return unavailable(problem, symbol=symbol, timeframe=timeframe, candles=[])
        resolution = RESOLUTION.get(timeframe.upper(), "HOUR")
        count = max(1, min(int(count), 500))
        try:
            data = self._call(
                creds, "GET", f"/prices/{symbol}/{resolution}/{count}"
            )
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol, timeframe=timeframe, candles=[])

        series: List[Dict[str, Any]] = []
        for row in data.get("prices") or []:
            series.append({
                "t": _epoch(row.get("snapshotTimeUTC") or row.get("snapshotTime")),
                "o": _side(row.get("openPrice"), "bid"),
                "h": _side(row.get("highPrice"), "bid"),
                "l": _side(row.get("lowPrice"), "bid"),
                "c": _side(row.get("closePrice"), "bid"),
                "v": _num(row.get("lastTradedVolume")) or 0.0,
            })
        if not series:
            return unavailable(
                f"IG returned no candles for {symbol}.",
                symbol=symbol, timeframe=timeframe, candles=[],
            )
        series.sort(key=lambda c: c["t"])
        return candles_result(symbol, timeframe, series, _digits(series[-1]["c"]), via="ig")

    def symbols(self, creds: Dict[str, Any], needle: str = "") -> Dict[str, Any]:
        """IG needs a full epic, so surface a search rather than a plain list."""
        problem = self.validate(creds)
        if problem:
            return {"available": False, "symbols": [], "reason": problem}
        term = (needle or "").strip()
        if not term:
            return {
                "available": True,
                "symbols": [],
                "note": "IG identifies instruments by epic. Type part of a name "
                        "(e.g. gold) to search.",
            }
        try:
            data = self._call(creds, "GET", f"/markets?searchTerm={term}")
        except Exception as exc:
            return {"available": False, "symbols": [], "reason": str(exc)}
        rows = data.get("markets") or []
        return {
            "available": True,
            "symbols": [str(r.get("epic") or "") for r in rows if r.get("epic")][:100],
            "via": "broker",
        }

    def place_order(self, creds: Dict[str, Any], order: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return shadow_fill(order, problem)

        symbol = str(order.get("symbol") or "")
        side = str(order.get("side") or "").lower()
        body: Dict[str, Any] = {
            "epic": symbol,
            "expiry": "-",
            "direction": "SELL" if side in {"sell", "short"} else "BUY",
            "size": float(order.get("volume") or 0.01),
            "orderType": "MARKET",
            "currencyCode": str(order.get("currency") or "USD"),
            "forceOpen": True,
            "guaranteedStop": False,
            "timeInForce": "FILL_OR_KILL",
        }
        if order.get("stop_loss"):
            body["stopLevel"] = float(order["stop_loss"])
        if order.get("take_profit"):
            body["limitLevel"] = float(order["take_profit"])

        try:
            data = self._call(creds, "POST", "/positions/otc", body, timeout=15.0)
        except Exception as exc:
            return {**shadow_fill(order, str(exc)), "mode": "live"}

        reference = data.get("dealReference")
        confirmed: Dict[str, Any] = {}
        if reference:
            try:
                confirmed = self._call(creds, "GET", f"/confirms/{reference}")
            except Exception:
                confirmed = {}
        status = str(confirmed.get("status") or "").upper()
        return {
            "executed": status not in {"REJECTED", "UNKNOWN"} and bool(reference),
            "settled": status == "ACCEPTED",
            "mode": MODE_LIVE,
            "ticket": confirmed.get("dealId") or reference,
            "symbol": symbol,
            "side": side,
            "volume": order.get("volume"),
            "price": _num(confirmed.get("level")) or order.get("price"),
            "status": status or None,
            "reason": confirmed.get("reason"),
            "note": "Awaiting confirmation." if status != "ACCEPTED" else None,
            "filled_at": now_iso(),
            "via": "broker",
        }


def _side(price: Any, key: str) -> float:
    blob = price if isinstance(price, dict) else {}
    return float(_num(blob.get(key) or blob.get("ask") or blob.get("lastTraded")) or 0.0)


def _num(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _digits(price: float) -> int:
    if not price:
        return 5
    if price > 1000:
        return 2
    if price > 50:
        return 3
    return 5


def _epoch(value: Any) -> int:
    text = str(value or "")
    if not text:
        return 0
    try:
        from datetime import datetime

        head = text.replace("Z", "").split(".")[0]
        return int(datetime.strptime(head, "%Y-%m-%dT%H:%M:%S").timestamp())
    except Exception:
        return 0
