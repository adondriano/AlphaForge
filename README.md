# ⚡ AlphaForge

> **AI-Powered Quantitative Strategy Studio & Prop-Firm Execution Engine**

AlphaForge is an end-to-end algorithmic trading platform that bridges the gap between qualitative trading concepts and quantitative execution. It ingests video tutorials or plain-text strategy descriptions, transpiles them into executable quantitative code, optimizes parameters using Machine Learning (Bayesian Optimization), and manages paper and live execution wrapped in prop-firm risk envelopes (FTMO / The5ers).

---

## 🌟 Key Features

* **🎥 Video & Text Strategy Creator:** Turn YouTube, TikTok, or Facebook strategy tutorials and plain-text descriptions into machine-executable strategy configurations via LLM transpilation.
* **⚡ ML-Powered Parameter Optimization:** Utilizes **Optuna (Bayesian Optimization)** to fine-tune strategy hyper-parameters against historical data while minimizing overfitting.
* **📜 Parameter Lineage & Rollbacks:** Complete version control ("Git for Strategies") allowing you to inspect optimization histories, compare metric diffs, and rollback or fork parameter configurations in one click.
* **🧠 On-Demand LLM Diagnostic Analyst:** Human-in-the-loop AI review. Triggers post-hoc analysis on shadow and paper trading logs to detect market regime shifts and strategy decay.
* **🛡️ Prop-Firm Shield (Hard Middleware):** Automatic hard-stop protection layers designed for FTMO and The5ers rules—enforcing daily drawdown limits, total drawdown caps, and best-day profit limits.
* **📊 Command Center Dashboard:** Sleek Next.js interface providing real-time stats (Win Rate, Sharpe Ratio, Prop-Firm Readiness, Estimated Weekly Trades) across multiple strategies simultaneously.

---

## 🏗️ Architecture

```text
[ YT / TikTok / Text Strategy ] ──> [ LLM Strategy Parser ]
                                            │
                                            ▼
                           [ Structured Strategy Config (JSON) ]
                                            │
                                            ▼
                           ┌─────────────────────────────────┐
                           │       ALPHA FORGE ENGINE        │
                           │                                 │
                           │  1. Backtest (In/Out Sample)    │
                           │  2. Optuna ML Optimizer         │
                           │  3. Shadow / Paper Trader       │
                           │  4. On-Demand LLM Analyst       │
                           └─────────────────────────────────┘
                                            │
                                            ▼
                             [ Prop-Firm Risk Middleware ]
                                            │
                                            ▼
                       [ Live Execution (MT5 / cTrader / API) ]
```

---

## 🛠️ Tech Stack

* **Frontend:** Next.js (React), Tailwind CSS, Lucide Icons, Recharts / TradingView Lightweight Charts
* **Backend:** Python (FastAPI), Async WebSockets
* **Quantitative & ML:** `Optuna`, `vectorbt` / `Backtrader`, `Pandas`, `NumPy`
* **Database:** PostgreSQL (Strategy state & versioning), DuckDB / SQLite (High-speed trade logs)
* **LLM Orchestration:** OpenAI / OpenRouter API / Ollama
* **Execution Protocols:** MetaTrader 5 Python API, cTrader FIX API

---

## 🚀 Quickstart Guide

### Prerequisites
* **Node.js** (v18+)
* **Python** (v3.10+)
* **PostgreSQL**

### 1. Clone the Repository
```bash
git clone https://github.com/your-username/AlphaForge.git
cd AlphaForge
```

### 2. Backend Setup
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

### 3. Frontend Setup
```bash
cd ../frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to view the dashboard.

---

## 🛡️ Prop Firm Protection Layer Configuration

Define your firm caps in `config/risk_rules.json`:

```json
{
  "max_daily_drawdown_pct": 3.5,
  "max_total_drawdown_pct": 8.0,
  "best_day_profit_cap_pct": 35.0,
  "emergency_liquidate_on_breach": true
}
```

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.