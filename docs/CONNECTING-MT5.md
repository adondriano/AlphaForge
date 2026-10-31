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

## 5. Setting it up permanently (optional)

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

## 6. Troubleshooting

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

## 7. Quick reference

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
#      Execution · MetaTrader 5 → PATH / LOGIN / PASSWORD / SERVER
#      Save & connect
```

---

## 8. Still stuck?

Collect these four things and they will pinpoint the problem immediately:

```powershell
python --version
python -c "import MetaTrader5 as m; print(m.__version__)"
curl http://localhost:8000/api/health
curl http://localhost:8000/api/mt5/status
```

Together they answer: is Python 64-bit and supported, is the bridge importable, is
the engine up, and is the terminal attached.
