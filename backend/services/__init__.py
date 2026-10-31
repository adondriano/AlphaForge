"""AlphaForge service package.

Every module in here degrades gracefully: heavy/optional third party libraries
(``numpy``, ``pandas``, ``optuna``, ``supabase``, ``MetaTrader5``) are imported
defensively so the same code base runs on a laptop with the full quant stack
installed *and* inside a size constrained serverless function with only
``fastapi`` + ``pydantic`` available.
"""

__all__ = [
    "backtester",
    "llm",
    "mt5_executor",
    "optuna_optimizer",
    "python_analyzer",
    "risk",
    "settings",
    "store",
    "validator",
]
