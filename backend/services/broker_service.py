"""Execution facade in front of the broker providers.

This is what the rest of AlphaForge talks to. It resolves whose credentials to
use, decrypts them for the duration of one call, and hands the work to a
provider. Nothing is cached between calls, because the engine is serverless:
a cached connection in one instance is invisible to the next one, and a
strategy that silently loses its broker is far worse than one that stops.

Two distinct offline states, deliberately different:

``shadow``
    No broker connection has been configured. Paper fills are expected and
    correct — this is the default studio experience.

``halted``
    A connection *exists* but is broken: credentials that no longer decrypt, a
    broker rejecting auth, a symbol the broker will not serve. Orders stop and
    say so. Falling back to a paper fill here would be indistinguishable from a
    working trade, which is exactly how a risk breach goes unnoticed.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from services import brokers
from services.broker_vault import vault
from services.brokers.base import (
    MODE_LIVE,
    MODE_SHADOW,
    MODE_UNAVAILABLE,
    shadow_fill,
)


class BrokerUnavailable(RuntimeError):
    """The connection could not be resolved. Never a reason to crash."""


class BrokerService:
    def __init__(self) -> None:
        self._last_error: Optional[str] = None

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    # ------------------------------------------------------------------
    # resolution
    # ------------------------------------------------------------------
    def resolve(
        self, connection_id: Optional[str], user_id: Optional[str]
    ) -> Tuple[Any, Dict[str, Any], Dict[str, Any]]:
        """Return ``(provider, credentials, row)`` or raise :class:`BrokerUnavailable`."""
        if not vault.enabled:
            raise BrokerUnavailable(
                "Supabase is not configured, so broker credentials have nowhere "
                "to live. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
            )
        if not user_id:
            raise BrokerUnavailable("Sign in to connect a broker.")

        row: Optional[Dict[str, Any]]
        if connection_id:
            row = vault.get(str(connection_id), user_id)
            if not row:
                raise BrokerUnavailable("That broker connection no longer exists.")
        else:
            rows = vault.list_for(user_id)
            if not rows:
                raise BrokerUnavailable("No broker connection configured yet.")
            row = vault.get(str(rows[0].get("id")), user_id)

        if not row:
            raise BrokerUnavailable("That broker connection no longer exists.")
        if row.get("error"):
            raise BrokerUnavailable(str(row["error"]))

        provider = brokers.get(row.get("provider"))
        if provider is None:
            raise BrokerUnavailable(
                f"Broker '{row.get('provider')}' is no longer supported."
            )
        creds = row.get("credentials")
        if not isinstance(creds, dict):
            raise BrokerUnavailable("Stored credentials could not be loaded.")
        return provider, creds, row

    # ------------------------------------------------------------------
    # offline envelopes
    # ------------------------------------------------------------------
    @staticmethod
    def _no_connection(reason: str) -> Dict[str, Any]:
        return {
            "available": False,
            "connected": False,
            "mode": MODE_SHADOW,
            "configured": False,
            "reason": reason,
        }

    @staticmethod
    def _halted(reason: str, **extra: Any) -> Dict[str, Any]:
        return {
            "available": False,
            "connected": False,
            "mode": "halted",
            "configured": True,
            "reason": reason,
            **extra,
        }

    # ------------------------------------------------------------------
    # calls
    # ------------------------------------------------------------------
    def status(
        self, connection_id: Optional[str] = None, user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            provider, creds, row = self.resolve(connection_id, user_id)
        except BrokerUnavailable as exc:
            self._last_error = str(exc)
            return self._no_connection(str(exc))

        try:
            result = provider.status(creds)
        except Exception as exc:
            self._last_error = str(exc)
            result = self._halted(f"{provider.label} status call failed: {exc}")
        result.setdefault("provider", provider.id)
        result["connection_id"] = row.get("id")
        result["warnings"] = self.warnings_for(provider, creds)
        vault.touch(
            str(row.get("id")),
            "connected" if result.get("connected") else "error",
            result.get("reason"),
        )
        return result

    def price(
        self,
        symbol: str,
        connection_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            provider, creds, row = self.resolve(connection_id, user_id)
        except BrokerUnavailable as exc:
            return {"available": False, "mode": MODE_UNAVAILABLE,
                    "symbol": symbol, "reason": str(exc)}
        try:
            result = provider.price(creds, symbol)
        except Exception as exc:
            result = {"available": False, "mode": MODE_UNAVAILABLE,
                      "symbol": symbol, "reason": str(exc)}
        result.setdefault("provider", provider.id)
        result.setdefault("warnings", self.warnings_for(provider, creds, symbol))
        return result

    def candles(
        self,
        symbol: str,
        timeframe: str = "H1",
        count: int = 120,
        connection_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            provider, creds, row = self.resolve(connection_id, user_id)
        except BrokerUnavailable as exc:
            return {"available": False, "mode": MODE_UNAVAILABLE, "symbol": symbol,
                    "timeframe": timeframe, "candles": [], "reason": str(exc)}
        try:
            result = provider.candles(creds, symbol, timeframe, count)
        except Exception as exc:
            result = {"available": False, "mode": MODE_UNAVAILABLE, "symbol": symbol,
                      "timeframe": timeframe, "candles": [], "reason": str(exc)}
        result.setdefault("provider", provider.id)
        return result

    def symbols(
        self,
        needle: str = "",
        connection_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            provider, creds, row = self.resolve(connection_id, user_id)
        except BrokerUnavailable as exc:
            return {"available": False, "symbols": [], "reason": str(exc)}
        try:
            result = provider.symbols(creds, needle)
        except Exception as exc:
            result = {"available": False, "symbols": [], "reason": str(exc)}
        result.setdefault("provider", provider.id)
        return result

    def place_order(
        self,
        order: Dict[str, Any],
        connection_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Route an order, or paper-fill it when no broker is configured.

        The distinction that matters: *no connection* shadows, *broken
        connection* halts. See the module docstring.
        """
        try:
            provider, creds, row = self.resolve(connection_id, user_id)
        except BrokerUnavailable as exc:
            # Nothing configured — paper trading is the intended behaviour.
            return shadow_fill(order, str(exc))

        try:
            result = provider.place_order(creds, order)
        except Exception as exc:
            return {**shadow_fill(order, f"{provider.label} rejected the order: {exc}"),
                    "mode": "halted"}

        # A connection exists, so a failure here is a fault, not an absence of
        # configuration. Downgrading it to a paper fill would make a broken
        # broker indistinguishable from a working one.
        if not result.get("executed"):
            result["mode"] = "halted"
            result.setdefault(
                "reason",
                f"{provider.label} did not accept the order. Trading is halted — "
                "no paper fill was substituted.",
            )
        result.setdefault("provider", provider.id)
        return result

    # ------------------------------------------------------------------
    def warnings_for(
        self, provider: Any, creds: Dict[str, Any], symbol: str = ""
    ) -> List[str]:
        """Capability warnings, e.g. indices on a broker that has none."""
        try:
            return provider.warnings_for(symbol) if symbol else []
        except Exception:
            return []

    def describe(self) -> Dict[str, Any]:
        """Everything the Settings tab needs to render the picker."""
        return {
            "providers": brokers.describe_all(),
            "vault_enabled": vault.enabled,
            "vault_error": vault.last_error,
        }


brokers_service = BrokerService()
