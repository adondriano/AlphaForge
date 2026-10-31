"""Broker provider registry.

Add a broker by dropping a module in this package and listing its class in
``_PROVIDER_CLASSES``. The Settings tab, the API and the execution engine all
discover it from here — there is no second place to update.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .base import (  # noqa: F401  (re-exported for callers)
    MODE_LIVE,
    MODE_SHADOW,
    MODE_UNAVAILABLE,
    TIMEFRAME_CODES,
    BrokerProvider,
    CredentialField,
    instrument_class,
)
from .capitalcom import CapitalComProvider
from .ctrader import CTraderProvider
from .exness import ExnessProvider
from .ig import IGProvider
from .oanda import OandaProvider

_PROVIDER_CLASSES = (
    ExnessProvider,
    OandaProvider,
    CapitalComProvider,
    IGProvider,
    CTraderProvider,
)

_PROVIDERS: Dict[str, BrokerProvider] = {}
for _cls in _PROVIDER_CLASSES:
    _instance = _cls()
    _PROVIDERS[_instance.id] = _instance


def get(provider_id: Optional[str]) -> Optional[BrokerProvider]:
    """Look a provider up by id. Unknown ids answer ``None``."""
    if not provider_id:
        return None
    return _PROVIDERS.get(str(provider_id).strip().lower())


def all_providers() -> List[BrokerProvider]:
    return list(_PROVIDERS.values())


def describe_all() -> List[Dict[str, Any]]:
    """Everything the Settings tab needs to render the picker."""
    return [provider.describe() for provider in _PROVIDERS.values()]


def ids() -> List[str]:
    return list(_PROVIDERS.keys())


__all__ = [
    "BrokerProvider",
    "CredentialField",
    "TIMEFRAME_CODES",
    "MODE_LIVE",
    "MODE_SHADOW",
    "MODE_UNAVAILABLE",
    "instrument_class",
    "get",
    "all_providers",
    "describe_all",
    "ids",
]
