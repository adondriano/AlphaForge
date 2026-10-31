"""cTrader Open API — the route to IC Markets, Pepperstone, FxPro and friends.

cTrader brokers do not hand out a simple API key. You register an app in
cTrader's developer portal, run the OAuth flow once, and end up with a bearer
token plus a numeric ``ctidTraderAccountId``. This provider takes those
directly, so the OAuth dance happens outside AlphaForge.

The host differs per broker and per environment (demo vs live), so ``base_url``
is a **required** field rather than a guess. If the host is wrong every call
fails with a clear reason instead of silently trading the wrong account.
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

DEFAULT_BASE = "https://api.spotware.com"

PERIOD = {
    "M1": "M1", "M5": "M5", "M15": "M15", "M30": "M30",
    "H1": "H1", "H4": "H4", "D1": "D1", "W1": "W1", "MN1": "MN1",
}


class CTraderProvider(BrokerProvider):
    id = "ctrader"
    label = "cTrader (IC Markets, Pepperstone, …)"
    docs_url = "https://help.ctrader.com/open-api/"
    unsupported = ()

    fields = (
        CredentialField(
            key="base_url",
            label="API Base URL",
            placeholder=DEFAULT_BASE,
            help=(
                "Your broker's cTrader Open API host. Confirm it in the "
                "cTrader developer portal — it differs per broker and per "
                "environment."
            ),
        ),
        CredentialField(
            key="access_token",
            label="Access Token",
            secret=True,
            placeholder="OAuth access token",
            help="Obtained by completing cTrader's OAuth flow for your app.",
        ),
        CredentialField(
            key="account_id",
            label="ctidTraderAccountId",
            placeholder="12345678",
            help="The numeric cTrader account id, not your login number.",
        ),
    )

    def _base(self, creds: Dict[str, Any]) -> str:
        return str(creds.get("base_url") or "").strip().rstrip("/") or DEFAULT_BASE

    def _root(self, creds: Dict[str, Any]) -> str:
        return f"{self._base(creds)}/connect/tradingaccounts/{creds['account_id']}"

    def _call(
        self,
        creds: Dict[str, Any],
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        timeout: float = 12.0,
    ) -> Any:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.request(
                method.upper(),
                f"{self._base(creds)}{path}",
                headers={
                    "Authorization": f"Bearer {str(creds.get('access_token') or '').strip()}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"cTrader {response.status_code} on {path}: {response.text[:200]}"
            )
        if not response.content:
            return {}
        return response.json()

    def _symbol_id(self, creds: Dict[str, Any], symbol: str) -> Optional[str]:
        data = self._call(creds, "GET", f"{self._root(creds)}/symbols")
        rows = data if isinstance(data, list) else (data.get("symbols") or [])
        wanted = symbol.upper().replace("_", "")
        for row in rows:
            name = str(row.get("symbolName") or row.get("name") or "").upper().replace("_", "")
            if name == wanted:
                return str(row.get("symbolId") or row.get("id") or "")
        return None

    # ------------------------------------------------------------------
    def status(self, creds: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": False, "reason": problem}
        try:
            data = self._call(creds, "GET", "/connect/tradingaccounts")
        except Exception as exc:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": True, "reason": str(exc)}

        rows = data if isinstance(data, list) else (data.get("tradingAccounts") or [])
        wanted = str(creds.get("account_id") or "")
        account = next(
            (r for r in rows if str(r.get("ctidTraderAccountId") or r.get("id")) == wanted),
            rows[0] if rows else {},
        )
        return {
            "available": True,
            "connected": True,
            "mode": MODE_LIVE,
            "configured": True,
            "provider": self.id,
            "account": {
                "login": account.get("ctidTraderAccountId") or wanted,
                "server": account.get("brokerName") or "cTrader",
                "balance": _num(account.get("balance")),
                "equity": _num(account.get("balance")),
                "margin": None,
                "free_margin": None,
                "currency": account.get("depositCurrency") or account.get("currency"),
                "leverage": _num(account.get("leverageInCents")) and None,
                "name": account.get("traderLogin"),
                "broker": account.get("brokerName") or "cTrader",
            },
            "via": "broker",
        }

    def price(self, creds: Dict[str, Any], symbol: str) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return unavailable(problem, symbol=symbol)
        try:
            symbol_id = self._symbol_id(creds, symbol)
            if not symbol_id:
                return unavailable(
                    f"cTrader account has no symbol named {symbol}.", symbol=symbol
                )
            data = self._call(
                creds, "GET", f"{self._root(creds)}/symbol/{symbol_id}/ticks?count=1"
            )
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol)

        rows = data if isinstance(data, list) else (data.get("ticks") or [])
        if not rows:
            return unavailable(f"No tick returned for {symbol}.", symbol=symbol)
        row = rows[0] if isinstance(rows[0], dict) else {}
        bid = _num(row.get("bid"))
        ask = _num(row.get("ask"))
        if bid is None and ask is None:
            return unavailable(f"Incomplete tick for {symbol}.", symbol=symbol)
        bid = float(bid if bid is not None else ask)
        ask = float(ask if ask is not None else bid)
        return price_result(symbol, bid, ask, 5, via="ctrader")

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
        try:
            symbol_id = self._symbol_id(creds, symbol)
            if not symbol_id:
                return unavailable(
                    f"cTrader account has no symbol named {symbol}.",
                    symbol=symbol, timeframe=timeframe, candles=[],
                )
            data = self._call(
                creds,
                "GET",
                f"{self._root(creds)}/symbol/{symbol_id}/trendbars"
                f"?period={PERIOD.get(timeframe.upper(), 'H1')}&count={max(1, min(int(count), 1000))}",
            )
        except Exception as exc:
            return unavailable(str(exc), symbol=symbol, timeframe=timeframe, candles=[])

        rows = data if isinstance(data, list) else (data.get("trendbars") or [])
        series: List[Dict[str, Any]] = []
        for row in rows:
            low = _num(row.get("low")) or 0.0
            high = _num(row.get("high")) or 0.0
            series.append({
                "t": int(row.get("timestamp") or 0),
                "o": float(_num(row.get("open")) or low),
                "h": float(high),
                "l": float(low),
                "c": float(_num(row.get("close")) or high),
                "v": float(row.get("volume") or 0.0),
            })
        if not series:
            return unavailable(
                f"cTrader returned no candles for {symbol}.",
                symbol=symbol, timeframe=timeframe, candles=[],
            )
        return candles_result(symbol, timeframe, series, 5, via="ctrader")

    def symbols(self, creds: Dict[str, Any], needle: str = "") -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return {"available": False, "symbols": [], "reason": problem}
        try:
            data = self._call(creds, "GET", f"{self._root(creds)}/symbols")
        except Exception as exc:
            return {"available": False, "symbols": [], "reason": str(exc)}
        rows = data if isinstance(data, list) else (data.get("symbols") or [])
        names = sorted({
            str(r.get("symbolName") or r.get("name") or "") for r in rows
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

        symbol = str(order.get("symbol") or "")
        side = str(order.get("side") or "").lower()
        try:
            symbol_id = self._symbol_id(creds, symbol)
            if not symbol_id:
                return shadow_fill(order, f"cTrader account has no symbol named {symbol}.")
            data = self._call(
                creds,
                "POST",
                f"{self._root(creds)}/orders",
                {
                    "symbolId": symbol_id,
                    "tradeSide": "SELL" if side in {"sell", "short"} else "BUY",
                    "orderType": "MARKET",
                    "volume": str(order.get("volume") or 0.01),
                    **({"stopLoss": str(order["stop_loss"])} if order.get("stop_loss") else {}),
                    **({"takeProfit": str(order["take_profit"])} if order.get("take_profit") else {}),
                },
                timeout=15.0,
            )
        except Exception as exc:
            return {**shadow_fill(order, str(exc)), "mode": "live"}

        blob = data if isinstance(data, dict) else {}
        return {
            "executed": True,
            "settled": False,
            "mode": MODE_LIVE,
            "ticket": blob.get("orderId") or blob.get("positionId"),
            "symbol": symbol,
            "side": side,
            "volume": order.get("volume"),
            "price": order.get("price"),
            "status": blob.get("status"),
            "note": "Accepted by cTrader; the fill arrives over the event stream.",
            "filled_at": now_iso(),
            "via": "broker",
        }


def _num(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
