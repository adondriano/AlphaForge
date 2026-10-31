"""Vercel serverless entrypoint for the AlphaForge FastAPI engine.

Vercel's Python runtime imports this module and serves the ASGI ``app``.
Only lightweight dependencies are declared in ``api/requirements.txt`` so the
function bundle stays small — Optuna / pandas / numpy are imported lazily by
the services and fall back to their pure-Python twins when absent.
"""

import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from main import app  # noqa: E402

handler = app  # some Vercel builders look for `handler`
