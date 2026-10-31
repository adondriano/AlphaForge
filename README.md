# ⚡ AlphaForge

> **AI-Powered Quantitative Strategy Studio & Prop-Firm Execution Engine** — integrated with **Supabase**.

AlphaForge closes the gap between a qualitative trading idea and a risk-managed, machine-executable
system. Feed it a YouTube/TikTok tutorial, a plain-text description or a hand-written JSON spec; it
transpiles that into an executable strategy configuration, backtests it on a deterministic engine,
tunes the parameters with Bayesian optimisation, keeps every parameter set as an immutable version
you can roll back to, and routes every order through a hard Prop-Firm Shield.

```
Live deployment
  Frontend (Next.js 14)  →  https://alphaforge.vercel.app
  Engine   (FastAPI)     →  https://alphaforge-engine.vercel.app
```

---

## 🌟 Feature map

| Area | What ships |
| --- | --- |
| **Strategy Creator** | YouTube / TikTok / Facebook URL, free-form prose, or a paste-in JSON spec. Live schema validation with inline errors, plus a copy-paste LLM prompt template for the No-LLM workflow. |
| **Dual-engine transpiler** | Uses OpenAI / Ollama when a provider is configured; automatically falls back to a deterministic local statistical transpiler (no API key, no network). |
| **Backtest engine** | Event-driven, deterministic, seeded. EMA cross, Donchian breakout, RSI, MACD, Bollinger and VWAP primitives, ATR stops, R-multiple targets, session filters, spread + commission modelling, in-sample / out-of-sample split. |
| **ML optimiser** | **Optuna** TPE Bayesian search with a dependency-free random-search twin on the exact same objective, so it runs anywhere. Objective is scored in-sample; the untouched tail is used only for validation and reported with an `overfit_risk` flag. |
| **Parameter lineage** | Every optimisation run becomes an immutable version ("Git for strategies") with metric diffs vs the active set and one-click **Rollback / Apply**. |
| **On-demand analyst** | Deterministic Python statistical diagnostic engine — sample size, break-even win rate, profit factor, drawdown vs your caps, losing-streak survivability, walk-forward retention, expectancy decay, risk of ruin. An LLM is layered on top only when a provider exists. |
| **Prop-Firm Shield** | Hard middleware. 3.5 % daily / 5 % total drawdown caps, concurrency limits, automatic size reduction as headroom shrinks, and `blocked` audit rows — there is no override flag. |
| **Realtime** | Supabase Realtime streams `strategies`, `optimizations` and `trade_logs` into the dashboard; every open tab updates the moment a fill lands. |

---

## 🏗️ Architecture

```text
[ YT / TikTok / Text / JSON ]
              │
              ▼
   ┌──────────────────────────────┐
   │  Transpiler (LLM ▸ heuristic)│
   └──────────────┬───────────────┘
                  ▼
        Validated StrategySpec (JSON)
                  │
                  ▼
   ┌──────────────────────────────┐        ┌──────────────────────────┐
   │       ALPHAFORGE ENGINE      │◀──────▶│  Supabase Postgres       │
   │  1. Backtest (IS / OOS)      │        │  strategies              │
   │  2. Optuna optimiser         │        │  optimizations (lineage) │
   │  3. Shadow / paper trader    │        │  trade_logs   (realtime) │
   │  4. Statistical analyst      │        │  app_settings            │
   └──────────────┬───────────────┘        └──────────────────────────┘
                  ▼
        Prop-Firm Shield (hard middleware)
                  ▼
      Execution — MetaTrader 5 (Windows) ▸ shadow fill elsewhere
```

**Two runtimes, one codebase:**

* `backend/` — Python FastAPI engine (uvicorn locally, Vercel serverless function in prod).
* `frontend/` — Next.js 14 App Router UI.
* The frontend **also** contains a faithful TypeScript port of the engine (`frontend/lib/engine.ts`).
  It prefers the Python engine (`NEXT_PUBLIC_API_URL`) and transparently falls back to the
  in-browser port when the engine is not configured or unreachable — so the studio never dead-ends.

---

## 🗄️ Supabase schema

`backend/schema.sql` creates everything. Run it in the Supabase SQL editor, or:

```bash
supabase db execute --file backend/schema.sql
psql "$DATABASE_URL" -f backend/schema.sql
```

| Table | Purpose |
| --- | --- |
| `strategies` | One row per strategy: rules, live parameters, risk profile, denormalised aggregate metrics, `autonomous` flag, `active_optimization_id`. |
| `optimizations` | Immutable parameter versions. Unique `(strategy_id, version)` plus a partial unique index guaranteeing exactly one active version per strategy. |
| `trade_logs` | Shadow / paper / live executions with the full Prop-Firm Shield audit trail (`day_pnl_pct`, `total_pnl_pct`, `blocked_reason`). |
| `app_settings` | Single-row settings document persisted from the Settings tab. |

All four tables are added to the `supabase_realtime` publication with `REPLICA IDENTITY FULL`, and
row level security is enabled with single-tenant permissive policies (tighten these before exposing
the project to other users).

---

## 🚀 Quickstart

### 1. Clone & configure

```bash
git clone https://github.com/adondriano/AlphaForge.git
cd AlphaForge
cp .env.example .env.local      # frontend: frontend/.env.local
```

Minimum viable config — just Supabase (everything else has a local fallback):

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

### 2. Backend (Python engine)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt        # full quant stack (optuna / pandas / numpy)
python main.py                         # → http://localhost:8000/docs
```

A slim install also works — `pip install -r api/requirements.txt` gives you the API without
Optuna/pandas/numpy, and the services degrade to their pure-Python twins automatically.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                            # → http://localhost:3000
```

Set `NEXT_PUBLIC_API_URL=http://localhost:8000` to route compute to the Python engine. Leave it
blank to run entirely in the browser.

### 4. Tests

```bash
cd backend
ALPHAFORGE_SEED=0 pytest -q            # 24 tests: engine, API, validator, shield, analyzer
```

---

## ⚙️ Settings

Configurable from the **Settings** tab (persisted to Supabase `app_settings` and pushed to the
Python engine):

| Group | Keys |
| --- | --- |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Execution | `MT5_PATH`, `MT5_LOGIN`, `MT5_SERVER` |
| LLM | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_URL`, `OLLAMA_MODEL` |
| Prop-firm limits | `MAX_DAILY_DRAWDOWN` (3.5), `MAX_TOTAL_DRAWDOWN` (5.0), `RISK_PER_TRADE_PCT` (0.5), `MAX_CONCURRENT_TRADES` (2), `BEST_DAY_PROFIT_CAP_PCT`, `EMERGENCY_LIQUIDATE_ON_BREACH` |
| Engine | `DEFAULT_SYMBOL`, `DEFAULT_TIMEFRAME`, `BACKTEST_BARS`, `OPTIMIZER_TRIALS`, `AUTONOMOUS_DEFAULT` |

Resolution order: **Settings tab → environment variable → default**. Secrets are never written to
browser storage; they live in memory for the session and in server-side env vars in production.

---

## 🔌 API reference

Base: `http://localhost:8000` (or the deployed engine URL). Interactive docs at `/docs`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Engine + integration capabilities |
| `GET` | `/api/strategies` | List strategies |
| `POST` | `/api/strategies/create` | Transpile + validate + persist (`auto_backtest`) |
| `POST` | `/api/strategies/transpile` | Compute-only transpile (no writes) |
| `POST` | `/api/strategies/backtest` | Backtest a persisted strategy |
| `POST` | `/api/strategies/backtest/compute` | Backtest an ad-hoc spec |
| `POST` | `/api/strategies/optimize` | Optuna search → new persisted version |
| `POST` | `/api/strategies/optimize/compute` | Optuna search, no persistence |
| `POST` | `/api/strategies/analyze` | Dual-engine analyst on a persisted strategy |
| `POST` | `/api/strategies/analyze/compute` | Analyst on an ad-hoc spec |
| `GET` | `/api/strategies/{id}/optimizations` | Full parameter lineage |
| `POST` | `/api/strategies/rollback` | Revert active parameters to a stored version |
| `POST` | `/api/strategies/{id}/autonomous` | Arm / disarm autonomous execution |
| `PATCH` | `/api/strategies/{id}/status` | Lifecycle: draft → backtested → optimized → shadow → paper → live |
| `DELETE` | `/api/strategies/{id}` | Delete strategy + lineage + logs |
| `POST` | `/api/execution/order` | Shield-evaluated order entry |
| `POST` | `/api/execution/paper-run` | Replay a backtest tail through the shield, streaming logs |
| `GET` | `/api/trade-logs` | Execution history |
| `GET`/`POST` | `/api/settings` | Settings document (secrets redacted on read) |
| `GET`/`POST` | `/api/risk/status`, `/api/risk/reset` | Drawdown envelope state |
| `POST` | `/api/seed` | Recreate the three demo strategies |
| `WS` | `/ws/trades` | Live execution stream (companion to Supabase Realtime) |

---

## 🛡️ Prop-Firm Shield

Every order — autonomous loop, manual trigger, optimiser re-arm — passes through
`services/risk.py::PropFirmShield.evaluate`. The decision ladder:

1. **Total drawdown ≥ cap** → `liquidate`, trading halted.
2. **Daily drawdown ≥ cap** → `block` until the next UTC day.
3. **Requested risk > remaining headroom** → `reduce` (size scaled to 80 % of headroom).
4. **Open positions ≥ `MAX_CONCURRENT_TRADES`** → `block`.
5. Otherwise `allow`.

Blocked orders are still written to `trade_logs` with `status='blocked'` and the reason, so the
audit trail is complete. There is deliberately no override flag.

---

## 📁 Layout

```text
AlphaForge
├── frontend/
│   ├── app/                    Command Center · Strategy Studio · Settings
│   ├── components/             Nav, StrategyCard, StrategyCreatorModal,
│   │                           StrategyDetailModal, OptimizationHistory,
│   │                           SettingsTab, RiskPanel, TradeTicker, ui
│   └── lib/                    supabaseClient · engine · transpiler · api · data
├── backend/
│   ├── main.py                 FastAPI app — all REST + WebSocket routes
│   ├── schema.sql              Supabase schema, RLS, realtime publication
│   ├── requirements.txt        full local quant stack
│   ├── api/                    Vercel serverless entrypoint (slim requirements)
│   ├── services/               backtester · optuna_optimizer · python_analyzer
│   │                           validator · risk · llm · mt5_executor · store
│   └── tests/                  mock_postgrest (offline client test harness)
├── .env.example
└── vercel.json
```

---

## 🚢 Deployment (Vercel)

Two projects, one repository:

| Project | Root directory | Framework | Env |
| --- | --- | --- | --- |
| `alphaforge` | `frontend` | Next.js | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` |
| `alphaforge-engine` | `backend` | Other (Python) | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, risk limits |

The Python engine is served from `backend/api/index.py` with its own slim
`backend/api/requirements.txt`, keeping the serverless bundle far below the size limit.

---

## ⚠️ Disclaimer

AlphaForge ships with a **synthetic, seeded market series** so the studio is usable out of the box.
Swap `services/backtester.generate_bars` for a real feed (Dukascopy, MetaTrader 5, your broker) and
the rest of the pipeline is unchanged. Backtested statistics are not a promise of future
performance — always validate in shadow and paper modes before risking capital.

---

## 📜 License

MIT — see [LICENSE](LICENSE).
