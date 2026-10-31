"""Broker provider contract.

AlphaForge used to talk to exactly one execution back end: MetaTrader 5, a
Windows-only C extension that can only reach a terminal running on the same
machine. That forced the bridge agent and the Supabase relay, and it meant the
hosted engine could never trade on its own.

Brokers that publish a real HTTP API do not have that problem, so this module
replaces the MT5 coupling with a small contract that any broker can implement:

    BrokerProvider
      ├── exness      signed REST (Ed25519) + WebSocket market data
      ├── oanda       v20 REST bearer token
      ├── capitalcom  session token (CST + X-SECURITY-TOKEN)
      ├── ig          session token (CST + X-SECURITY-TOKEN)
      └── ctrader     OAuth bearer token (IC Markets, Pepperstone, ...)

Rules every provider follows
----------------------------
* **Never invent a price.** When a call fails the provider returns
  ``available: False`` with a human ``reason``. The UI shows the disconnected
  state instead of a number.
* **Never raise.** An exception becomes a result dict, so one broker being down
  cannot take the studio offline.
* **Money-safe defaults.** ``place_order`` degrades to a shadow fill, and the
  caller can tell the difference via ``mode``.
"""

from __future__ import annotations

import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


def describe_exception(exc: BaseException) -> str:
    """Type, message and originating frame — enough to act on.

    Providers report failures as ``str(exc)``, which for anything that is not a
    deliberately-worded error yields a bare OS string like "[Errno 16] Device
    or resource busy": no class, no location, nothing to search for. Including
    the type and the last frame turns an opaque errno into a place to look.
    """
    name = type(exc).__name__
    detail = f"{name}: {exc}" if str(exc) else name

    frames = traceback.extract_tb(exc.__traceback__)
    if frames:
        frame = frames[-1]
        filename = frame.filename.rsplit("/", 1)[-1]
        cause = describe_exception(exc.__cause__) if exc.__cause__ else ""
        suffix = f" <- {cause}" if cause else ""
        detail += f" (at {filename}:{frame.lineno} in {frame.name}){suffix}"
    return detail

# AlphaForge's canonical timeframe ladder. Providers map these onto whatever
# granularity naming their own API uses, and drop the ones they cannot serve.
TIMEFRAME_CODES: Tuple[str, ...] = (
    "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1",
)

MODE_LIVE = "live"
MODE_SHADOW = "shadow"
MODE_UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class CredentialField:
    """One input rendered by the Settings tab for a provider.

    The form is generated from these descriptors, so adding a broker never
    means writing new React.
    """

    key: str
    label: str
    secret: bool = False
    placeholder: str = ""
    help: str = ""
    required: bool = True

    def describe(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "secret": self.secret,
            "placeholder": self.placeholder,
            "help": self.help,
            "required": self.required,
        }


# ---------------------------------------------------------------------------
# instrument classification — powers "this broker does not offer NAS100"
# ---------------------------------------------------------------------------
_INDEX_TOKENS = (
    "NAS100", "NASUSD", "NDX", "US30", "US500", "SPX", "SP500", "DJI",
    "GER30", "DE30", "DAX", "UK100", "FTSE", "FRA40", "CAC", "JPN225",
    "NIKKEI", "AUS200", "EUSTX50", "HK50", "HSI", "VIX", "DXY",
)
_METAL_TOKENS = ("XAUUSD", "XAGUSD", "XAUEUR", "GOLD", "SILVER", "XPTUSD", "XPDUSD")
_CRYPTO_TOKENS = (
    "BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD", "BCHUSD", "ADAUSD", "DOGUSD",
    "SOLUSD", "DOTUSD", "LINKUSD", "BNBUSD", "MATICUSD", "AVAXUSD",
)


def instrument_class(symbol: str) -> str:
    """Best-effort asset class for a symbol, used for capability warnings."""
    name = (symbol or "").upper().replace("_", "").replace("-", "").replace(".", "")
    if not name:
        return "unknown"
    for token in _INDEX_TOKENS:
        if name.startswith(token):
            return "index"
    for token in _METAL_TOKENS:
        if name.startswith(token):
            return "metal"
    for token in _CRYPTO_TOKENS:
        if name.startswith(token):
            return "crypto"
    if name.startswith("XAU") or name.startswith("XAG"):
        return "metal"
    # Six-letter pairs with a fiat-looking shape are forex.
    if len(name) == 6 and name.isalpha():
        return "forex"
    return "unknown"


# ---------------------------------------------------------------------------
# result builders — keep every provider's payload shape identical
# ---------------------------------------------------------------------------
def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def unavailable(reason: str, **extra: Any) -> Dict[str, Any]:
    """The universal failure envelope."""
    payload = {"available": False, "mode": MODE_UNAVAILABLE, "reason": reason}
    payload.update(extra)
    return payload


def price_result(
    symbol: str,
    bid: float,
    ask: float,
    digits: int = 5,
    *,
    last: Optional[float] = None,
    volume: float = 0.0,
    when: Optional[int] = None,
    via: str = "broker",
) -> Dict[str, Any]:
    return {
        "available": True,
        "mode": MODE_LIVE,
        "symbol": symbol,
        "bid": round(float(bid), digits),
        "ask": round(float(ask), digits),
        "last": round(float(last if last is not None else bid), digits),
        "spread": round(float(ask) - float(bid), digits),
        "digits": int(digits),
        "volume": float(volume or 0.0),
        "time": int(when or 0),
        "server_time": now_iso(),
        "via": via,
    }


def candles_result(
    symbol: str,
    timeframe: str,
    candles: List[Dict[str, Any]],
    digits: int = 5,
    via: str = "broker",
) -> Dict[str, Any]:
    series = list(candles)
    first = float(series[0]["c"]) if series else 0.0
    last = float(series[-1]["c"]) if series else 0.0
    return {
        "available": True,
        "mode": MODE_LIVE,
        "symbol": symbol,
        "timeframe": timeframe,
        "digits": int(digits),
        "candles": series,
        "change": round(last - first, 8),
        "change_pct": round(((last - first) / first) * 100, 4) if first else 0.0,
        "via": via,
    }


def shadow_fill(order: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Deterministic paper fill used when no broker could take the order."""
    return {
        "executed": False,
        "mode": MODE_SHADOW,
        "ticket": None,
        "price": order.get("price"),
        "volume": order.get("volume"),
        "symbol": order.get("symbol"),
        "side": order.get("side"),
        "reason": reason,
        "filled_at": now_iso(),
    }


# ---------------------------------------------------------------------------
# the contract
# ---------------------------------------------------------------------------
class BrokerProvider:
    """Everything AlphaForge needs from a broker.

    Subclasses set the class attributes and override the methods they support.
    Anything not overridden answers "unavailable" with a clear reason rather
    than raising, which keeps the studio usable when a broker lags behind.
    """

    #: stable id stored in the database and sent by the UI
    id: str = ""
    #: name shown in the dropdown
    label: str = ""
    #: where the user goes to generate credentials
    docs_url: str = ""
    #: credential inputs the Settings tab should render
    fields: Tuple[CredentialField, ...] = ()
    #: asset classes this broker cannot serve, e.g. ("index", "stock")
    unsupported: Tuple[str, ...] = ()
    #: whether the provider can stream quotes
    supports_streaming: bool = True

    # -- credentials ------------------------------------------------------
    def missing_fields(self, creds: Dict[str, Any]) -> List[str]:
        missing: List[str] = []
        for field in self.fields:
            if not field.required:
                continue
            if not str(creds.get(field.key) or "").strip():
                missing.append(field.label)
        return missing

    def validate(self, creds: Dict[str, Any]) -> Optional[str]:
        """Return an error message when credentials are unusable, else None."""
        missing = self.missing_fields(creds)
        if missing:
            return f"Missing {', '.join(missing)}."
        return None

    def describe(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "docs_url": self.docs_url,
            "fields": [f.describe() for f in self.fields],
            "unsupported": list(self.unsupported),
            "supports_streaming": self.supports_streaming,
        }

    def warnings_for(self, symbol: str) -> List[str]:
        """Capability warnings for a symbol, e.g. index products on Exness."""
        if not symbol:
            return []
        kind = instrument_class(symbol)
        if kind in self.unsupported:
            pretty = "indices and stocks" if kind == "index" else f"{kind} instruments"
            return [
                f"{self.label} does not offer {pretty} through its API — "
                f"{symbol} will not trade. Pick a forex, metal or crypto symbol."
            ]
        return []

    # -- lifecycle --------------------------------------------------------
    def status(self, creds: Dict[str, Any]) -> Dict[str, Any]:
        return unavailable(f"{self.label} does not expose an account status call.")

    # -- market data ------------------------------------------------------
    def price(self, creds: Dict[str, Any], symbol: str) -> Dict[str, Any]:
        return unavailable(
            f"{self.label} has no live price call wired up yet.", symbol=symbol
        )

    def candles(
        self,
        creds: Dict[str, Any],
        symbol: str,
        timeframe: str = "H1",
        count: int = 120,
    ) -> Dict[str, Any]:
        return unavailable(
            f"{self.label} has no candle history call wired up yet.",
            symbol=symbol,
            timeframe=timeframe,
            candles=[],
        )

    def symbols(self, creds: Dict[str, Any], needle: str = "") -> Dict[str, Any]:
        return {"available": False, "symbols": [], "reason": "not supported"}

    # -- trading ----------------------------------------------------------
    def place_order(
        self, creds: Dict[str, Any], order: Dict[str, Any]
    ) -> Dict[str, Any]:
        return shadow_fill(
            order, f"{self.label} has no order routing wired up yet."
        )
