# Connecting AlphaForge to your local MetaTrader 5

This is the full, start-to-finish procedure for getting live quotes and execution
out of your own MT5 terminal and into AlphaForge.

---

## 0. Read this first — why it can't "just connect"

The error you are seeing is:

> Engine says: The Python engine is unreachable. Start it locally (`uvicorn main:app --port 8000`) on the machine that has MetaTrader 5 installed.

That message is accurate, and the reason is architectural — not a bug:

```
┌───────────────────────────┐        HTTP         ┌──────────────────────┐   IPC   ┌──────────┐
│  AlphaForge dashboard     │ ──────────────────► │  Python engine       │ ◄─────► │  MT5     │
│  (browser / Vercel)       │                     │  (FastAPI, port 8000)│         │ terminal │
└───────────────────────────┘                     └──────────────────────┘         └──────────┘
        anywhere                                   MUST be on the same PC          Windows only
                                                   as the MT5 terminal
```

- `MetaTrader5` is a **Windows-only C extension**. It does not talk over TCP — it
  attaches to a terminal process **on the same machine** through local IPC.
- Your hosted dashboard runs on Vercel (Linux). It can never import
  `MetaTrader5`, and it can never reach the terminal on your PC.
- So the **Python engine must run on your Windows PC, next to MT5**. The dashboard
  then talks to that engine over HTTP.

"Connecting MT5" therefore means two separate things, and you must do both:

1. **Run the engine on the Windows machine that has MT5** (with `MetaTrader5` installed).
2. **Make the dashboard able to reach that engine** — either by running the
   dashboard locally too (Path A, simplest) or by tunnelling the engine out to a
   public HTTPS URL (Path B).

Everything else in AlphaForge — backtests, the optimizer, the analyst, lineage,
paper trading — works without any of this. Live price and real order routing do not.

**There are three ways to close the gap**, all documented below:

| Path | What runs where | Best for |
| --- | --- | --- |
| **A — everything local** (§3) | Engine *and* dashboard on the Windows PC | Simplest, most reliable, zero exposure |
| **B — tunnel** (§4) | Engine on the PC, hosted dashboard, linked by an HTTPS tunnel | Keeping the hosted UI with no new code |
| **C — bridge agent** (§5) | Engine stays on Vercel; only `bridge_agent.py` runs on the PC and relays over Supabase | Hosting the engine *and* getting live MT5 — no tunnel, no public URL |

---

## 1. What you need

| Requirement | Notes |
|---|---|
| Windows 10/11 PC | The MT5 desktop terminal. The web/mobile MT5 apps will **not** work. |
| MT5 terminal installed | Download it **from your broker** — a broker's terminal only lists that broker's servers. |
| A working MT5 login | A demo account is ideal for this. You need login, password and the exact server name. |
| 64-bit Python 3.9 – 3.12 | `MetaTrader5` ships no wheel for 3.13+. If `pip` says "no matching distribution", install Python 3.12. 32-bit Python will not work. |
| ~10 minutes | |

---

## 2. Prepare the MT5 terminal (do this before touching the engine)

These are the four things that make `initialize()` / `login()` fail if skipped.

1. **Open the terminal and log in manually at least once.**
   `MetaTrader5.initialize()` can start the terminal for you, but it cannot
   complete a first-time login. Log in yourself once so the account is cached.

2. **Enable Algo Trading.**
   - Click the **Algo Trading** button in the MT5 toolbar until it shows a
     **green** play triangle.
   - Also: `Tools → Options → Expert Advisors` → tick **Allow automated trading**.
   - Without this, quotes work but every order is rejected by the terminal.

3. **Add the symbols you trade to Market Watch.**
   Right-click in the *Market Watch* panel → `Symbols` → pick the group →
   double-click `XAUUSD`, `EURUSD`, etc. → OK.
   `symbol_info()` / `symbol_info_tick()` return nothing for a symbol that is not
   in Market Watch, so the live price panel stays blank for it.

4. **Write down your exact credentials.**
   In MT5: `Tools → Options → Server` tab shows the current server string, and the
   account number is in the *Navigator* panel under `Accounts` (or in the bottom
   right of the terminal). Copy them **verbatim** — `Broker-Demo` and
   `Broker-Demo 2` are different servers.

---

## 3. Path A — run everything on your PC (recommended)

This is the most reliable setup: dashboard and engine both on `localhost`, no
tunnels, no mixed-content rules, no public exposure.

### Step A1 — Install Python

Download **Python 3.12 (64-bit)** from <https://www.python.org/downloads/windows/>.

> ⚠️ On the installer's first screen tick **"Add python.exe to PATH"**.

Verify in a new **PowerShell** window:

```powershell
python --version
# Python 3.12.x
python -c "import struct; print(struct.calcsize('P')*8)"
# 64
```

If the second command prints `32`, you installed the 32-bit build — uninstall and
get the 64-bit one.

### Step A2 — Get the code

```powershell
git clone https://github.com/adondriano/AlphaForge.git
cd AlphaForge
```

(No Git? Download the ZIP from GitHub and extract it, then `cd` into the folder.)

### Step A3 — Create the virtual environment and install the engine

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
```

If PowerShell blocks the activate script:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\.venv\Scripts\Activate.ps1
```

You will see `(.venv)` at the start of your prompt. Every command below assumes
it is active.

### Step A4 — Install the MT5 bridge (the important bit)

```powershell
pip install MetaTrader5==5.0.45
```

Confirm it loads:

```powershell
python -c "import MetaTrader5 as m; print('MT5 package OK', m.__version__)"
```

> This is the single step that decides whether the engine can talk to your
> terminal. It is commented out in `backend/requirements-dev.txt` because it is
> Windows-only and would break `pip install` on Linux/macOS (and on Vercel).

### Step A5 — Start the engine

Stay in the `backend` folder with `(.venv)` active:

```powershell
uvicorn main:app --port 8000
```

Leave this window open. Expected tail:

```
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
INFO:     Application startup complete.
```

### Step A6 — Verify the engine before opening any browser

Open a **second** PowerShell window and run:

```powershell
curl http://localhost:8000/api/health
curl http://localhost:8000/api/mt5/status
```

- `/api/health` must return JSON with an `engine` block. If `curl` is missing, use
  `Invoke-WebRequest http://localhost:8000/api/health | Select-Object -Expand Content`.
- `/api/mt5/status` currently returns `"connected": false` with a reason of
  *"Not connected — running in shadow/paper mode."* — correct, you have not
  logged in yet. If instead it says *"MetaTrader5 is not installed in this
  runtime"*, go back to **Step A4**.

### Step A7 — Start the dashboard

In a **third** PowerShell window, from the repo root:

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>.

### Step A8 — Point the dashboard at the engine

1. Sign in (or browse as a guest — but you need a signed-in account to save
   settings and connect).
2. Go to **Settings**.
3. In the **Python engine** group, set:

   ```
   ENGINE_URL = http://localhost:8000
   ```

   Base URL only — **no `/api` suffix**.
4. Press **Save settings**.

The *Compute engine* status card should change to **"Python engine · online"**.
If it still says *unreachable*, see §6.

### Step A9 — Enter your MT5 credentials and connect

In **Settings → Execution · MetaTrader 5**:

| Field | Value | Required? |
|---|---|---|
| `MT5_PATH` | e.g. `C:\Program Files\MetaTrader 5\terminal.exe` | Optional — leave blank to let `initialize()` find the installed terminal |
| `MT5_LOGIN` | Your account number, e.g. `12345678` | Yes |
| `MT5_PASSWORD` | Your trading account password | Yes |
| `MT5_SERVER` | Exact server string, e.g. `Broker-Demo` | Yes |

`MT5_PASSWORD` is held in memory for the session only — it is never written to
`localStorage`, never sent to any LLM provider, and never leaves your machine
except to your own engine over `localhost`.

Then press **Save & connect**. On success:

- The status card flips to **MetaTrader 5 connected · live feed**
- Account number, server, balance and equity appear
- The banner at the top of the dashboard turns green

To get your `MT5_PATH`: in MT5, `File → Open Data Folder`, then go **up one
level** — `terminal.exe` sits next to the `MQL5` folder:

```powershell
Get-ChildItem "C:\Program Files" -Filter terminal.exe -Recurse -ErrorAction SilentlyContinue | Select-Object FullName
```

### Step A10 — Confirm live data

Open a strategy → the **Live market** panel shows bid/ask/spread and a real
timestamp. It polls every few seconds. Run a paper session and the fills now come
from the shield evaluating live prices.

---

## 4. Path B — keep using the hosted dashboard at `https://alphaforge-pied.vercel.app`

You can leave the dashboard in the cloud and only run the engine on your PC, but
there is one hard browser rule:

> A page served over **HTTPS** may not fetch **HTTP** resources (mixed content).
> The browser silently blocks them.

So the tunnel URL you paste into `ENGINE_URL` **must be `https://…`**. Both
Cloudflare Tunnel and ngrok give you HTTPS for free.

### Step B1 — Do all of Path A, steps A1–A6

Get the engine running and answering on `http://localhost:8000` first. Do not
tunnel something you have not verified locally.

### Step B2 — Expose it over HTTPS

**Option 1 — Cloudflare quick tunnel** (no account needed):

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8000
```

**Option 2 — ngrok:**

```powershell
winget install ngrok.ngrok
ngrok http 8000
```

Either prints an HTTPS forwarding URL, e.g.
`https://alphaforge-something.trycloudflare.com` or `https://1a2b-3c4d.ngrok-free.app`.

Keep that window open — killing it kills the tunnel.

### Step B3 — Paste it into the hosted dashboard

1. Open <https://alphaforge-pied.vercel.app>, sign in, go to **Settings**.
2. **Python engine → `ENGINE_URL`** = the tunnel URL, e.g.

   ```
   https://alphaforge-something.trycloudflare.com
   ```

   No trailing slash, no `/api`.
3. **Save settings** → the *Compute engine* card should read **"Python engine · online"**.
4. Fill in the four MT5 fields (step A9) and press **Save & connect**.

### Step B4 — Re-paste when the URL changes

Free-tier tunnel URLs are **ephemeral** — restart the tunnel and you get a new
hostname. That is exactly why `ENGINE_URL` is a runtime setting rather than a
build-time env var: paste the new URL, press **Save settings**, reconnect.
No redeploy.

For a stable URL, use a **named** Cloudflare tunnel (it survives restarts).

### ⚠️ Security warning for Path B

The engine has **no authentication** and its CORS policy allows any origin
(`allow_origins=["*"]`). Publishing it on a public HTTPS URL means anyone who
learns that URL can call your engine — including `/api/mt5/*` endpoints against
your terminal.

Mitigations, in order of preference:

1. **Use Path A** (localhost only) whenever you can.
2. If you must tunnel, use a **named Cloudflare tunnel with a Cloudflare Access
   policy** in front of it.
3. Never share the URL, and shut the tunnel down when you are done.
4. Do **not** run the engine with `--host 0.0.0.0` — it is unnecessary for
   tunnelling (the tunnel client runs on your machine) and it additionally exposes
   the port to your whole LAN.

---

## 5. Path C — bridge agent (keep the engine on Vercel)

This is the answer to "the engine is on Vercel, MT5 is on my PC — bridge them".
You run one small Python process on the Windows machine and the hosted engine
drives your terminal through Supabase. No tunnel, no port forwarding, no public
URL, and it works behind CGNAT.

### How it works

```
Windows PC (yours)                      Supabase                    Vercel engine
┌───────────────────────┐   pushes    ┌───────────────┐   reads   ┌──────────────┐
│ bridge_agent.py       │  quotes ──► │ mt5_quotes    │ ────────► │ mt5_executor │
│  · imports MetaTrader5 │             │ mt5_candles   │           │  relay mode  │
│  · heartbeat every 5s  │             │ mt5_bridges   │           └──────┬───────┘
│  · answers commands    │ ◄── work ── │ mt5_commands  │ ◄────────────────┘
└───────────────────────┘             └───────────────┘
```

- The agent registers itself in `mt5_bridges` and refreshes `last_seen` every
  `ALPHAFORGE_HEARTBEAT_SECONDS` (default 5). A bridge with no heartbeat for 45s
  is treated as offline.
- It pushes a tick for every symbol in `ALPHAFORGE_QUOTE_SYMBOLS` on each poll,
  so `price` reads a cached row and feels instant. Missing or stale quotes fall
  back to a command round-trip.
- Connect, disconnect, candles, the symbol list and **orders** go through
  `mt5_commands`: the engine writes a row and waits; the agent claims it, runs it
  against MT5, writes the result back, and deletes the row. If nothing answers in
  time the engine shadow-fills, exactly as it does today.
- Every relayed response carries `"via": "relay"`, and the Settings panel shows a
  **via bridge · &lt;machine&gt;** badge, so you always know where a number came from.

### Step C1 — Do Path A steps A1–A4 on the Windows PC

Same Python setup: venv, `pip install -r requirements-dev.txt`, and
`pip install MetaTrader5==5.0.45`. You do **not** run `uvicorn` for this path —
the agent replaces the local engine.

### Step C2 — Install the agent's extra dependency

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
pip install supabase
```

### Step C3 — Point the agent at your Supabase project

```powershell
$env:SUPABASE_URL              = "https://klapzqwpspehrefeacxg.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<your service role key>"
$env:MT5_LOGIN                 = "12345678"
$env:MT5_PASSWORD              = "your-terminal-password"
$env:MT5_SERVER                = "Broker-Demo"
```

The service-role key comes from **Supabase → Project Settings → API keys**. It
bypasses row level security, which is required here because the bridge tables
deliberately deny the anon key. Keep it out of source control.

Optional tuning:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALPHAFORGE_BRIDGE_ID` | `agent-<random>` | Stable id; set it if you want a recognisable one |
| `ALPHAFORGE_BRIDGE_NAME` | your hostname | Shown in the **via bridge** badge |
| `ALPHAFORGE_HEARTBEAT_SECONDS` | `5` | How often the agent re-registers |
| `ALPHAFORGE_QUOTE_SYMBOLS` | `XAUUSD,EURUSD,GBPUSD,USDJPY,NAS100` | Symbols pushed every poll |
| `ALPHAFORGE_CANDLE_JOBS` | `XAUUSD:H1:240` | `symbol:timeframe:count`, comma separated |
| `ALPHAFORGE_POLL_SECONDS` | `0.75` | Command/quote loop interval |

### Step C4 — Start it

```powershell
python bridge_agent.py
```

You should see:

```
[12:41:03] bridge id     : agent-9f3c1b2a4d55
[12:41:03] bridge name   : TRADING-PC
[12:41:03] quote symbols : XAUUSD, EURUSD, GBPUSD, USDJPY, NAS100
[12:41:03] credentials found in the environment — connecting on startup
[12:41:05] connected to the terminal
```

Leave the window open.

### Step C5 — Connect from the dashboard

1. Open the hosted dashboard, sign in, **Settings → MetaTrader 5 bridge**.
2. Press **Save & connect**. The engine forwards the connect command to your
   agent. (If you set the env vars above, the agent already connected at startup
   and this just refreshes the status.)
3. The panel flips to **connected** with a **via bridge · TRADING-PC** badge, and
   account / server / balance / equity appear.

You can leave `ENGINE_URL` blank for this path — the hosted engine does the
relaying.

### Checking on it

- **Is the agent alive?** Supabase → Table Editor → `mt5_bridges`; `last_seen`
  should be advancing every few seconds.
- **Is a command stuck?** Table Editor → `mt5_commands`; any row lingering for
  more than a few seconds means no agent is claiming it.

### Security notes specific to Path C

- `mt5_commands` carries order instructions and — **if you did not set the env
  vars** — your terminal password. It is created with **no anon and no
  authenticated RLS policy whatsoever**, so only the service-role key can read or
  write it. Never add a permissive policy to that table.
- The agent deletes each command row as soon as it is answered.
- The service-role key lives in exactly two places you control: the Vercel
  engine's env vars and this agent's environment. Treat both as production
  secrets.
- Nothing is exposed publicly — no inbound port, no public URL. This is strictly
  safer than Path B.

---

## 6. Setting it up permanently (optional)

### Run the engine as a startup task

Create `start-alphaforge-engine.bat`:

```bat
@echo off
cd /d "%~dp0backend"
call .venv\Scripts\activate.bat
uvicorn main:app --port 8000
pause
```

Press `Win+R` → `shell:startup` → drop a shortcut to it there. The engine then
starts with Windows. Note you still have to log into MT5 yourself first, or start
the terminal from `MT5_PATH`.

### Pin `ENGINE_URL` at build time instead

If you self-host the frontend and never need to change the engine location, set
`NEXT_PUBLIC_API_URL` and leave `ENGINE_URL` blank. On Vercel:
*Project → Settings → Environment Variables*. Remember that `NEXT_PUBLIC_*` is
baked in at **build** time, so changing it requires a redeploy — which is why
`ENGINE_URL` exists for the hosted case.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **"The Python engine is unreachable"** | Engine not running, wrong `ENGINE_URL`, or a firewall block | Verify with `curl http://localhost:8000/api/health` on the PC. Check `ENGINE_URL` has no trailing slash and no `/api`. |
| **"No Python engine configured"** | `ENGINE_URL` and `NEXT_PUBLIC_API_URL` are both empty | Set `ENGINE_URL` in Settings (§A8). |
| **"MetaTrader5 is not installed in this runtime"** | `pip install MetaTrader5` was skipped, **or** you are hitting the *hosted* engine at `alphaforge-engine.vercel.app` rather than your own | Step A4. And confirm `ENGINE_URL` points at your PC, not the Vercel engine. |
| **"Terminal started but login failed"** | Wrong login / password / server triple | Re-copy all three from the terminal. The server string must match exactly. |
| **`initialize()` fails / IPC timeout** | Wrong `MT5_PATH`, terminal not installed, or 32-bit Python | Leave `MT5_PATH` blank first. Confirm `struct.calcsize('P')*8 == 64`. |
| **`pip install MetaTrader5` → "no matching distribution"** | Python too new (3.13+) or 32-bit | Install 64-bit Python 3.12 and recreate the venv. |
| **Tunnel URL loads in the browser but the dashboard says "unreachable"** | Mixed content — `http://` tunnel from the `https://` dashboard | Use the `https://` form of the tunnel URL. |
| **Connect button spins for 90s then fails** | `initialize(timeout=60000)` was waiting for the terminal to boot | Log into MT5 manually once, leave it open, then connect. |
| **Connected, but the live price panel is blank for my symbol** | Symbol is not in Market Watch | Add it: right-click Market Watch → Symbols (§2.3). |
| **Connected, but paper fills never execute / orders rejected** | Algo Trading is disabled | Green Algo Trading button in the MT5 toolbar + `Tools → Options → Expert Advisors`. |
| **Green in Settings, red banner on the dashboard** | Stale status | Press **Refresh status** in the MT5 bridge panel. |
| **Path C: "no bridge agent is online"** | Agent not running, or its heartbeat is older than 45s | Start `python bridge_agent.py`; confirm `mt5_bridges.last_seen` is advancing. |
| **Path C: agent runs but status stays "online", not "connected"** | Terminal login failed | Read `mt5_bridges.error`; re-check `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER`. |
| **Path C: connected but no price** | Symbol missing from `ALPHAFORGE_QUOTE_SYMBOLS`, or not in Market Watch | Add it in both places (§2.3 and the table in step C3). |
| **Path C: commands pile up in `mt5_commands`** | No agent polling for that `bridge_id` | The agent only claims rows matching its own `ALPHAFORGE_BRIDGE_ID`; check the id in its startup log. |
| **Path C: orders shadow-fill instead of executing** | Algo Trading off, or the command timed out at 30s | Green Algo Trading button in MT5; watch the agent window for the error. |

### Manual endpoint checks

Run these from the PC running the engine:

```powershell
curl http://localhost:8000/api/health          # engine + integration status
curl http://localhost:8000/api/mt5/status      # bridge + account state
curl "http://localhost:8000/api/mt5/price?symbol=XAUUSD"
curl "http://localhost:8000/api/mt5/candles?symbol=XAUUSD&timeframe=H1&count=120"
curl "http://localhost:8000/api/mt5/symbols"
```

`/api/health` reports which integrations the engine could reach (`supabase`,
`llm`, `optimizer`, `mt5`) — it is the fastest way to see the whole picture at once.

---

## 8. Quick reference

```powershell
# --- on the Windows PC, once -------------------------------------------
cd AlphaForge\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
pip install MetaTrader5==5.0.45

# --- every session ------------------------------------------------------
# 1. open MT5 and log in manually; enable Algo Trading
# 2. start the engine
cd AlphaForge\backend
.\.venv\Scripts\Activate.ps1
uvicorn main:app --port 8000

# 3. verify
curl http://localhost:8000/api/health
curl http://localhost:8000/api/mt5/status

# 4. dashboard → Settings
#      Python engine → ENGINE_URL = http://localhost:8000      (Path A)
#                                or https://<tunnel-host>      (Path B)
#                                or leave blank                (Path C)
#      Execution · MetaTrader 5 → PATH / LOGIN / PASSWORD / SERVER
#      Save & connect

# --- Path C: bridge agent instead of a local engine -------------------------
cd AlphaForge\backend
.\.venv\Scripts\Activate.ps1
pip install MetaTrader5==5.0.45 supabase
$env:SUPABASE_URL              = "https://<project>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"
$env:MT5_LOGIN                 = "12345678"
$env:MT5_PASSWORD              = "your-terminal-password"
$env:MT5_SERVER                = "Broker-Demo"
python bridge_agent.py
```

---

## 9. Still stuck?

Collect these four things and they will pinpoint the problem immediately:

```powershell
python --version
python -c "import MetaTrader5 as m; print(m.__version__)"
curl http://localhost:8000/api/health
curl http://localhost:8000/api/mt5/status
```

Together they answer: is Python 64-bit and supported, is the bridge importable, is
the engine up, and is the terminal attached.
