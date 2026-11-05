# Prop-Firm Execution & Automation

The tab at `/propfirm`. A confidence scanner across a prop-firm instrument
universe, guardrails matched to your firm's published rules, and a kill switch
that closes positions that actually exist.

It needs a connected broker — both the scanner and the watchlist status read
from live broker data.

---

## The confidence score is a heuristic, not a model

This is the most important thing to understand about the tab.

The brief asked for a confidence score gated at 80%. There is no confidence
model in AlphaForge — there is a Python statistical analyzer and a random-search
optimizer, and strategies carry historical metrics, not per-signal confidence.
So the score is a **transparent weighted sum over five factors that are all
genuinely computed from OHLC history**:

| Factor | What it measures |
| --- | --- |
| Trend alignment | EMA 12 vs EMA 26, plus slope over 10 bars, plus higher-timeframe agreement |
| MACD agreement | Histogram sign and how many bars since the cross |
| RSI position | Where RSI sits relative to the direction |
| Candle structure | Body-to-range ratio and where the bar closed in its range |
| S/R proximity | Distance from the last swing, in ATRs |

Weights are visible and tunable in the UI. Every factor reports the reasoning
behind its score, and the whole breakdown goes into the alert payload.

**A score of 87 does not mean "87% chance of profit."** It means these five
things line up right now. Treat it as a filter for your attention, not a
prediction.

### The orderbook factor was dropped

The brief specified an orderbook-imbalance factor (`S_Book`, orderbook delta
> ±15%). It is not implemented, because **the broker exposes no depth data**.
The Exness Trader API has four tags — Historical Market Data, Trading, Server
Events and Configuration — and no depth/L2 endpoint anywhere in the spec. Ticks
carry `instrument`, `bid`, `ask` and `timestamp` and nothing else.

Rather than invent a proxy and name it after data we do not have, the factor
was removed and its weight redistributed. If a broker with real orderbook depth
is connected later, the factor can be added honestly.

---

## Watchlist

The universe covers forex majors and minors, indices (US30, US100, US500, GER40,
UK100), metals and energy (XAUUSD, XAGUSD, USOIL, UKOIL) and crypto (BTCUSD,
ETHUSD, SOLUSD).

Each symbol shows a live status against the connected broker:

- **green** — offered, tradable
- **red** — not offered by this broker
- **grey** — unknown, usually because no broker is connected

Symbols the broker does not offer are **marked, not hidden**. A watchlist that
silently drops indices looks like a bug when you know your firm offers them, and
the point is to show where the broker and the firm disagree. In practice indices
show as unsupported on Exness's current API.

USOIL and UKOIL are classed as **energy**, not metals — the brief grouped them
under metals, but the class drives the spread limit, so it stays correct.

### Spread limits

Maximum acceptable spread before an entry is blocked:

- Forex: **1.5 pips**
- Gold: **30 pips**

Both come from the brief. The caps for energy, indices and crypto are starting
defaults, not authoritative figures — tune them against real quotes. Crypto and
index spreads move with price, so a pip cap is the wrong unit and crypto uses
**basis points of the mid price** instead.

---

## Execution route

| Route | Status |
| --- | --- |
| Direct Broker API | **Active.** Orders go straight to the broker's REST API. |
| MT5 MCP | **Unavailable.** Not implemented. |

MT5 is not implemented for a structural reason, not a scheduling one: the
`MetaTrader5` package is **Windows-only**, the engine runs on **Linux**
serverless, and an MCP stdio bridge would need a 24/7 Windows host. The route
selector exists so an adapter can drop in later if that changes, but there is no
MT5 runtime code.

**Worth repeating:** prop firms are not MT5-only. FTMO supports MT4, MT5,
cTrader and DXtrade; The5%ers supports MT5, cTrader and TradingView. If MT5 was
the reason you expected to need this, that premise does not hold.

---

## Guardrails

Defaults are **3.5% daily / 5% total** — the project's standing caps, and
tighter than every firm preset here. Both are adjustable.

Fixed risk per trade: **0.5% / 1% / 2%**.

Selecting a firm loads its published limits and warns when your caps approach
them:

- Within 15% of the firm's limit — warns that a guardrail firing at the same
  point as the breach leaves no room to react
- Above the firm's limit — says plainly that the configuration cannot keep the
  account within its rules
- **Trailing** max-loss programs get a specific warning. A trailing limit
  follows your peak equity, so it can be breached on a day you finish flat, and
  a static total cap understates your real exposure.

### Presets

| Firm | Program | Daily | Max | Type | Daily reset |
| --- | --- | --- | --- | --- | --- |
| FTMO | 2-Step | 5% | 10% | static | 00:00 Europe/Prague |
| The5%ers | High Stakes | 5% | 10% | static | 00:00 Europe/London |
| Equity Edge | 2-Step Legacy | 5% | 10% | static | 22:00 London |
| Equity Edge | 1-Step Swift | 3% | 5% | **trailing** | 22:00 London |
| Equity Edge | Instant | 3% | 5% | **trailing** | 22:00 London |

Equity Edge's daily limit is measured from the **higher of balance or equity**
at reset, so it shrinks after a losing day. Every preset links to the firm's own
published rules — confirm against your contract before relying on it.

---

## Kill switch

**CLOSE ALL & DISABLE AUTO-TRADE** closes every open position in full and turns
auto-trading off. It takes two clicks within three seconds.

Two things it does by design:

**It refuses to guess.** The button is disabled when open positions cannot be
confirmed. An empty list is indistinguishable from "nothing open", so a broker
that fails to enumerate positions reports as a halt rather than as zero.

**It reports "accepted", not "filled".** Exness acknowledges close requests
first and settles asynchronously over server events. A success here means the
broker took the request. Confirm on your broker platform before assuming you are
flat.

---

## Alert webhooks

Signals that clear the threshold can be forwarded to a webhook — generic JSON,
Discord or Telegram.

Payload:

```json
{
  "event": "ALPHA_FORGE_SIGNAL",
  "symbol": "XAUUSD",
  "direction": "buy",
  "confidence": 84.2,
  "factors": {
    "technical_ta": 90,
    "rsi_position": 72,
    "trend_confluence": 88,
    "candle_structure": 80,
    "sr_proximity": 91
  },
  "levels": { "entry": 2774.4, "sl": 2762.1, "tp1": 2792.8, "tp2": 2811.2 },
  "timestamp": "2026-11-06T09:14:22.104Z"
}
```

Dispatch happens **server-side**, which keeps the webhook URL out of the page
source and sidesteps the CORS refusal a direct browser call to Discord would
hit. URLs pointing at private, loopback or link-local addresses are rejected —
otherwise the endpoint would be a server-side request forgery primitive aimed at
cloud metadata.

**Alerts only fire while this tab is open.** There is no server-side scanner
running when you are away; detection happens in the browser as candles arrive.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "No broker connected" | Connect one in Settings. Nothing on this tab works without candle history. |
| Score stuck at 0 | Fewer than ~40 bars returned. Try a higher timeframe or wait for history. |
| Symbols all grey | No broker connected, or the broker's instrument list could not be read. |
| Index symbols red | Expected — indices are not tradable through Exness's current API. |
| Kill switch disabled | Open positions could not be confirmed. It will not claim success it cannot prove. |
| Webhook test fails | Check the URL. Private and loopback addresses are refused by design. |
| Nothing alerts | Score has not cleared the threshold, or alerts are toggled off. |
