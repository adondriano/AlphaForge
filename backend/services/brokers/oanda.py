"""OANDA v20 REST API.

OANDA is the best-documented retail forex API in existence and the reason this
provider is the simplest one in the package: a single bearer token, predictable
JSON, candle history back to 2005.

Two environment hosts — practice (`api-fxpractice`) and live (`api-fxtrade`) —
selected by the `live` credential field.

Symbol naming differs from AlphaForge's: OANDA separates the pair with an
underscore (`XAU_USD`), so symbols are translated on the way in and back on the
way out.
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

PRACTICE = "https://api-fxpractice.oanda.com"
LIVE = "https://api-fxtrade.oanda.com"

# AlphaForge timeframe -> OANDA granularity
GRANULARITY = {
    "M1": "M1", "M5": "M5", "M15": "M15", "M30": "M30",
    "H1": "H1", "H4": "H4", "D1": "D", "W1": "W", "MN1": "M",
}


def to_oanda(symbol: str) -> str:
    """``XAUUSD`` -> ``XAU_USD``. Anything non-pair-like passes through."""
    name = (symbol or "").upper().replace("-", "").replace("/", "")
    if len(name) == 6 and name.isalpha():
        return f"{name[:3]}_{name[3:]}"
    return name


def from_oanda(symbol: str) -> str:
    return (symbol or "").upper().replace("_", "")


class OandaProvider(BrokerProvider):
    id = "oanda"
    label = "OANDA"
    docs_url = "https://developer.oanda.com/rest-live-v20/introduction/"
    # OANDA retail CFDs do carry indices, but not single stocks on every entity.
    unsupported = ("stock",)

    fields = (
        CredentialField(
            key="account_id",
            label="Account ID",
            placeholder="101-001-1234567-001",
            help="Found in OANDA → Manage API Access.",
        ),
        CredentialField(
            key="token",
            label="API Token",
            secret=True,
            placeholder="Bearer token from Manage API Access",
            help="A personal access token. Stored encrypted.",
        ),
        CredentialField(
            key="live",
            label="Environment",
            placeholder="practice",
            help="Type `live` to trade real money. Anything else uses the practice host.",
            required=False,
        ),
    )

    @property
    def _host_note(self) -> str:
        return "Live host selected — orders use real money."

    def _host(self, creds: Dict[str, Any]) -> str:
        raw = str(creds.get("live") or "").strip().lower()
        return LIVE if raw in {"live", "true", "1", "yes"} else PRACTICE

    def _headers(self, creds: Dict[str, Any]) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {str(creds.get('token') or '').strip()}",
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
        url = f"{self._host(creds)}{path}"
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.request(
                method.upper(), url, headers=self._headers(creds), json=body
            )
        if response.status_code >= 400:
            detail = ""
            try:
                blob = response.json()
                detail = blob.get("errorMessage") or blob.get("message") or ""
            except ValueError:
                detail = response.text[:200]
            raise RuntimeError(f"OANDA {response.status_code}: {detail or response.reason_phrase}")
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
            data = self._call(creds, "GET", f"/v3/accounts/{creds['account_id']}/summary")
        except Exception as exc:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": True, "reason": str(exc)}

        account = data.get("account") or {}
        return {
            "available": True,
            "connected": True,
            "mode": MODE_LIVE,
            "configured": True,
            "provider": self.id,
            "account": {
                "login": account.get("id"),
                "server": "OANDA",
                "balance": _num(account.get("balance")),
                "equity": _num(account.get("NAV")),
                "margin": _num(account.get("marginUsed")),
                "free_margin": _num(account.get("marginAvailable")),
                "currency": account.get("currency"),
                "leverage": _num(account.get("marginRate")),
                "name": account.get("alias"),
                "broker": "OANDA",
            },
            "environment": "live" if self._host(creds) == LIVE else "practice",
            "via": "broker",
        }

    def price(self, creds: Dict[str, Any], symbol: str) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return unavailable(problem, symbol=symbol)
        instrument = to_oanda(symbol)
        try:
            data = self._call(
                creds,
                "GET",
                f"/v3/accounts/{creds['account_id']}/pricing"
                f"?instruments={instrument}",
            )
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol)

        rows = data.get("prices") or []
        if not rows:
            return unavailable(f"OANDA returned no price for {instrument}.", symbol=symbol)

        row = rows[0]
        bids = row.get("bids") or [{}]
        asks = row.get("asks") or [{}]
        bid = float(bids[0].get("price") or 0.0)
        ask = float(asks[0].get("price") or 0.0)
        return price_result(
            symbol, bid, ask, _digits(bid), last=ask,
            when=_epoch(row.get("time")), via="oanda",
        )

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
        instrument = to_oanda(symbol)
        granularity = GRANULARITY.get(timeframe.upper(), "H1")
        count = max(1, min(int(count), 5000))
        try:
            data = self._call(
                creds,
                "GET",
                f"/v3/accounts/{creds['account_id']}/instruments/{instrument}/candles"
                f"?count={count}&granularity={granularity}&price=M",
            )
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol, timeframe=timeframe, candles=[])

        series: List[Dict[str, Any]] = []
        for row in data.get("candles") or []:
            if not row.get("complete"):
                # The in-progress candle moves; include it last but unbroken.
                mid = row.get("mid") or {}
                if not mid:
                    continue
            else:
                mid = row.get("mid") or {}
            series.append({
                "t": _epoch(row.get("time")),
                "o": float(mid.get("o") or 0.0),
                "h": float(mid.get("h") or 0.0),
                "l": float(mid.get("l") or 0.0),
                "c": float(mid.get("c") or 0.0),
                "v": float(row.get("volume") or 0.0),
            })
        if not series:
            return unavailable(
                f"OANDA returned no candles for {instrument}.",
                symbol=symbol, timeframe=timeframe, candles=[],
            )
        return candles_result(symbol, timeframe, series, _digits(series[-1]["c"]), via="oanda")

    def symbols(self, creds: Dict[str, Any], needle: str = "") -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return {"available": False, "symbols": [], "reason": problem}
        try:
            data = self._call(
                creds, "GET", f"/v3/accounts/{creds['account_id']}/instruments"
            )
        except Exception as exc:
            return {"available": False, "symbols": [], "reason": str(exc)}

        names = sorted({
            from_oanda(str(row.get("name") or "")) for row in (data.get("instruments") or [])
        })
        names = [n for n in names if n]
        term = (needle or "").strip().lower()
        if term:
            names = [n for n in names if term in n.lower()]
        return {"available": True, "symbols": names[:500], "via": "broker"}

    def place_order(self, creds: Dict[str, Any], order: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return shadow_fill(order, problem)

        symbol = str(order.get("symbol") or "").upper()
        warning = self.warnings_for(symbol)
        if warning:
            return shadow_fill(order, warning[0])

        side = str(order.get("side") or "").lower()
        units = _units(float(order.get("volume") or 0.01), side)
        body = {
            "order": {
                "type": "MARKET",
                "instrument": to_oanda(symbol),
                "units": units,
                "timeInForce": "FOK",
                "positionFill": "DEFAULT",
            }
        }
        if order.get("stop_loss"):
            body["order"]["stopLossOnFill"] = {
                "price": _fmt(float(order["stop_loss"]), symbol)
            }
        if order.get("take_profit"):
            body["order"]["takeProfitOnFill"] = {
                "price": _fmt(float(order["take_profit"]), symbol)
            }

        try:
            data = self._call(
                creds, "POST", f"/v3/accounts/{creds['account_id']}/orders",
                body, timeout=15.0,
            )
        except Exception as exc:
            return {**shadow_fill(order, str(exc)), "mode": "live"}

        fill = data.get("orderFillTransaction") or {}
        created = data.get("orderCreateTransaction") or {}
        price = _num((fill.get("price") or created.get("price")))
        return {
            "executed": bool(fill),
            "settled": bool(fill),
            "mode": MODE_LIVE,
            "ticket": fill.get("orderID") or created.get("id"),
            "trade_id": fill.get("tradeOpened", {}).get("tradeID") if fill else None,
            "symbol": symbol,
            "side": "buy" if units.startswith("") and not units.startswith("-") else "sell",
            "volume": order.get("volume"),
            "price": price if price is not None else order.get("price"),
            "pl": _num(fill.get("pl")),
            "note": "Rejected by OANDA." if not fill else None,
            "filled_at": fill.get("time") or now_iso(),
            "via": "broker",
        }


def _units(volume: float, side: str) -> str:
    """OANDA encodes direction in the sign of `units`."""
    scaled = int(volume * 100) if volume < 1000 else int(volume)
    scaled = max(1, scaled)
    return str(-scaled) if side in {"sell", "short"} else str(scaled)


def _fmt(price: float, symbol: str) -> str:
    return f"{price:.{_digits(price)}f}"


def _digits(price: float) -> int:
    """5 digits for JPY-ish and most pairs, 2 for metals, 3 otherwise."""
    if price is None:
        return 5
    if price > 1000:
        return 2
    if price > 50:
        return 3
    return 5


def _num(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _epoch(value: Any) -> int:
    """OANDA returns RFC3339 with nanoseconds; keep whole seconds."""
    text = str(value or "")
    if not text:
        return 0
    try:
        from datetime import datetime

        head = text.split(".")[0].replace("Z", "")
        return int(datetime.strptime(head, "%Y-%m-%dT%H:%M:%S").timestamp())
    except Exception:
        return 0
