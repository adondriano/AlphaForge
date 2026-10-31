"""Capital.com public REST API.

Capital.com issues a short-lived session instead of a long-lived token:
``POST /api/v1/session`` returns two headers (``CST`` and ``X-SECURITY-TOKEN``)
that every later call must repeat, and the session lapses after a few idle
minutes. Because the engine runs serverless and cannot hold session state, this
provider re-authenticates at the start of each call. Slower, but it cannot rot.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

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

DEMO = "https://demo-api-capital.backend-capital.com"
LIVE = "https://api-capital.backend-capital.com"

RESOLUTION = {
    "M1": "MINUTE", "M5": "MINUTE_5", "M15": "MINUTE_15", "M30": "MINUTE_30",
    "H1": "HOUR", "H4": "HOUR_4", "D1": "DAY", "W1": "WEEK", "MN1": "MONTH",
}


class CapitalComProvider(BrokerProvider):
    id = "capitalcom"
    label = "Capital.com"
    docs_url = "https://open-api.capital.com/"
    unsupported = ()

    fields = (
        CredentialField(
            key="identifier",
            label="Email / Identifier",
            placeholder="you@example.com",
            help="The email you log in with.",
        ),
        CredentialField(
            key="password",
            label="API Password",
            secret=True,
            placeholder="API password from Settings → API",
            help="Generate a dedicated API password in the Capital.com app.",
        ),
        CredentialField(
            key="api_key",
            label="API Key",
            secret=True,
            placeholder="Your Capital.com API key",
            help="From the Capital.com web platform → Settings → API.",
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
        """Open a session and return the two auth headers."""
        host = self._host(creds)
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            response = client.post(
                f"{host}/api/v1/session",
                headers={"X-CAP-API-KEY": str(creds.get("api_key") or "").strip(),
                         "Content-Type": "application/json"},
                json={
                    "identifier": str(creds.get("identifier") or "").strip(),
                    "password": str(creds.get("password") or ""),
                    "encryptedPassword": False,
                },
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Capital.com rejected the session ({response.status_code}): "
                f"{response.text[:200]}"
            )
        cst = response.headers.get("CST")
        token = response.headers.get("X-SECURITY-TOKEN")
        if not (cst and token):
            raise RuntimeError("Capital.com session response had no security token.")
        return {
            "CST": cst,
            "X-SECURITY-TOKEN": token,
            "X-CAP-API-KEY": str(creds.get("api_key") or "").strip(),
            "Content-Type": "application/json",
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
            raise RuntimeError(f"Capital.com {response.status_code}: {detail}")
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
            data = self._call(creds, "GET", "/api/v1/accounts")
        except Exception as exc:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": True, "reason": str(exc)}

        rows = data.get("accounts") or []
        account = rows[0] if rows else {}
        balance = account.get("balance") or {}
        return {
            "available": True,
            "connected": True,
            "mode": MODE_LIVE,
            "configured": True,
            "provider": self.id,
            "account": {
                "login": account.get("accountId") or account.get("accountName"),
                "server": "Capital.com",
                "balance": _num(balance.get("balance")),
                "equity": _num(balance.get("balance")),
                "margin": _num(balance.get("deposit")),
                "free_margin": _num(balance.get("available")),
                "currency": account.get("currency"),
                "leverage": None,
                "name": account.get("accountName"),
                "broker": "Capital.com",
            },
            "environment": "live" if self._host(creds) == LIVE else "demo",
            "via": "broker",
        }

    def price(self, creds: Dict[str, Any], symbol: str) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return unavailable(problem, symbol=symbol)
        try:
            data = self._call(creds, "GET", f"/api/v1/prices/{symbol.upper()}")
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol)

        snap = data.get("snapshot") or {}
        bid = _num(snap.get("bid"))
        ask = _num(snap.get("offer") or snap.get("ask"))
        if bid is None and ask is None:
            return unavailable(
                f"Capital.com has no price for {symbol.upper()}.", symbol=symbol
            )
        bid = float(bid if bid is not None else ask)
        ask = float(ask if ask is not None else bid)
        return price_result(symbol, bid, ask, _digits(bid), via="capitalcom")

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
        count = max(1, min(int(count), 1000))
        try:
            data = self._call(
                creds,
                "GET",
                f"/api/v1/prices/{symbol.upper()}"
                f"?resolution={resolution}&max={count}&pageSize=0",
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
                f"Capital.com returned no candles for {symbol.upper()}.",
                symbol=symbol, timeframe=timeframe, candles=[],
            )
        series.sort(key=lambda c: c["t"])
        return candles_result(
            symbol, timeframe, series, _digits(series[-1]["c"]), via="capitalcom"
        )

    def place_order(self, creds: Dict[str, Any], order: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return shadow_fill(order, problem)

        symbol = str(order.get("symbol") or "").upper()
        warning = self.warnings_for(symbol)
        if warning:
            return shadow_fill(order, warning[0])

        side = str(order.get("side") or "").lower()
        body: Dict[str, Any] = {
            "epic": symbol,
            "direction": "SELL" if side in {"sell", "short"} else "BUY",
            "size": float(order.get("volume") or 0.01),
        }
        if order.get("stop_loss"):
            body["stopLevel"] = float(order["stop_loss"])
        if order.get("take_profit"):
            body["profitLevel"] = float(order["take_profit"])

        try:
            data = self._call(creds, "POST", "/api/v1/positions", body, timeout=15.0)
        except Exception as exc:
            return {**shadow_fill(order, str(exc)), "mode": "live"}

        reference = data.get("dealReference")
        confirmed: Dict[str, Any] = {}
        if reference:
            try:
                confirmed = self._call(creds, "GET", f"/api/v1/confirms/{reference}")
            except Exception:
                confirmed = {}
        status = str(confirmed.get("status") or data.get("status") or "").upper()
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
    value = _num(blob.get(key) or blob.get("ask") or blob.get("lastTraded"))
    return float(value or 0.0)


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
