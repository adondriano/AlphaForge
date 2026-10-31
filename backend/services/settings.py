"""Application settings (mirrors the Settings tab in the frontend).

Settings are resolved in this order:

1. values explicitly posted to ``POST /api/settings`` (persisted to Supabase
   ``app_settings`` when a Supabase client is available, otherwise in memory),
2. process environment variables,
3. the defaults below.
"""

from __future__ import annotations

import os
from typing import Any, Dict

from pydantic import BaseModel, Field

DEFAULT_SETTINGS: Dict[str, Any] = {
    # ---- Engine location (frontend only; harmless here) ------------------
    "ENGINE_URL": "",
    # ---- Supabase -------------------------------------------------------
    "NEXT_PUBLIC_SUPABASE_URL": "",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "",
    "SUPABASE_SERVICE_ROLE_KEY": "",
    # ---- Execution ------------------------------------------------------
    "MT5_PATH": "",
    "MT5_LOGIN": "",
    "MT5_PASSWORD": "",
    "MT5_SERVER": "",
    # ---- LLM orchestration ----------------------------------------------
    "OPENAI_API_KEY": "",
    "OPENAI_MODEL": "gpt-4o-mini",
    "OLLAMA_URL": "http://localhost:11434",
    "OLLAMA_MODEL": "llama3.1",
    # ---- Prop firm risk envelope ----------------------------------------
    "MAX_DAILY_DRAWDOWN": 3.5,
    "MAX_TOTAL_DRAWDOWN": 5.0,
    "RISK_PER_TRADE_PCT": 0.5,
    "MAX_CONCURRENT_TRADES": 2,
    "BEST_DAY_PROFIT_CAP_PCT": 35.0,
    "EMERGENCY_LIQUIDATE_ON_BREACH": True,
    # ---- Engine ---------------------------------------------------------
    "DEFAULT_SYMBOL": "XAUUSD",
    "DEFAULT_TIMEFRAME": "H1",
    "BACKTEST_BARS": 3000,
    "OPTIMIZER_TRIALS": 40,
    "AUTONOMOUS_DEFAULT": False,
}

SECRET_KEYS = {"SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "MT5_PASSWORD"}


class SettingsUpdate(BaseModel):
    """Partial settings patch. ``null`` values are ignored (not cleared)."""

    ENGINE_URL: str | None = None
    NEXT_PUBLIC_SUPABASE_URL: str | None = None
    NEXT_PUBLIC_SUPABASE_ANON_KEY: str | None = None
    SUPABASE_SERVICE_ROLE_KEY: str | None = None
    MT5_PATH: str | None = None
    MT5_LOGIN: str | None = None
    MT5_PASSWORD: str | None = None
    MT5_SERVER: str | None = None
    OPENAI_API_KEY: str | None = None
    OPENAI_MODEL: str | None = None
    OLLAMA_URL: str | None = None
    OLLAMA_MODEL: str | None = None
    MAX_DAILY_DRAWDOWN: float | None = None
    MAX_TOTAL_DRAWDOWN: float | None = None
    RISK_PER_TRADE_PCT: float | None = None
    MAX_CONCURRENT_TRADES: int | None = None
    BEST_DAY_PROFIT_CAP_PCT: float | None = None
    EMERGENCY_LIQUIDATE_ON_BREACH: bool | None = None
    DEFAULT_SYMBOL: str | None = None
    DEFAULT_TIMEFRAME: str | None = None
    BACKTEST_BARS: int | None = None
    OPTIMIZER_TRIALS: int | None = None
    AUTONOMOUS_DEFAULT: bool | None = None

    model_config = {"extra": "allow"}


class Settings(BaseModel):
    """Runtime view of every knob AlphaForge exposes."""

    ENGINE_URL: str = ""
    NEXT_PUBLIC_SUPABASE_URL: str = ""
    NEXT_PUBLIC_SUPABASE_ANON_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    MT5_PATH: str = ""
    MT5_LOGIN: str = ""
    MT5_PASSWORD: str = ""
    MT5_SERVER: str = ""
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    OLLAMA_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "llama3.1"
    MAX_DAILY_DRAWDOWN: float = Field(default=3.5, ge=0.1, le=100.0)
    MAX_TOTAL_DRAWDOWN: float = Field(default=5.0, ge=0.1, le=100.0)
    RISK_PER_TRADE_PCT: float = Field(default=0.5, ge=0.01, le=10.0)
    MAX_CONCURRENT_TRADES: int = Field(default=2, ge=1, le=50)
    BEST_DAY_PROFIT_CAP_PCT: float = 35.0
    EMERGENCY_LIQUIDATE_ON_BREACH: bool = True
    DEFAULT_SYMBOL: str = "XAUUSD"
    DEFAULT_TIMEFRAME: str = "H1"
    BACKTEST_BARS: int = 3000
    OPTIMIZER_TRIALS: int = 40
    AUTONOMOUS_DEFAULT: bool = False

    # -- derived helpers -------------------------------------------------
    @property
    def has_supabase(self) -> bool:
        return bool(self.NEXT_PUBLIC_SUPABASE_URL and self.SUPABASE_SERVICE_ROLE_KEY)

    @property
    def has_llm(self) -> bool:
        return bool(self.OPENAI_API_KEY or self.ollama_reachable_url)

    @property
    def ollama_reachable_url(self) -> str:
        url = (self.OLLAMA_URL or "").strip()
        # A blank URL or the default localhost guess does not count as
        # "an LLM is configured" for the purposes of the dual engine switch.
        if not url or url in {"http://localhost:11434", "http://127.0.0.1:11434"}:
            return ""
        return url

    @property
    def has_mt5(self) -> bool:
        """Credentials present. MT5_PATH is optional — ``initialize()`` finds
        the installed terminal on its own when it is blank."""
        return bool(self.MT5_LOGIN and self.MT5_PASSWORD and self.MT5_SERVER)

    @property
    def llm_provider(self) -> str:
        if self.OPENAI_API_KEY:
            return "openai"
        if self.ollama_reachable_url:
            return "ollama"
        return "none"

    def redacted(self) -> Dict[str, Any]:
        """Settings safe to return over the wire (secrets masked)."""
        data = self.model_dump()
        for key in SECRET_KEYS:
            if data.get(key):
                data[key] = "••••••••" + str(data[key])[-4:]
        return data


def load_settings_from_env() -> Dict[str, Any]:
    """Pull any AlphaForge setting that is present in the process environment."""
    found: Dict[str, Any] = {}
    for key, default in DEFAULT_SETTINGS.items():
        raw = os.getenv(key)
        if raw is None or raw == "":
            continue
        if isinstance(default, bool):
            found[key] = raw.strip().lower() in {"1", "true", "yes", "on"}
        elif isinstance(default, int):
            try:
                found[key] = int(raw)
            except ValueError:
                continue
        elif isinstance(default, float):
            try:
                found[key] = float(raw)
            except ValueError:
                continue
        else:
            found[key] = raw
    return found
