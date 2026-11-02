# The XAUUSD desk

**Settings → nav → XAUUSD Desk.** One instrument, watched properly: a live
candle chart, RSI and MACD underneath it, tunable parameters, and an alert that
fires only when both indicators agree.

Everything on this page is real broker data. If no broker is connected, the desk
says so and shows nothing — it never simulates a price.

## What's on the page

| Area | What it does |
| --- | --- |
| Header | Live mid, bid and ask, updating every 3 seconds |
| Timeframes | M1, M5, M15, M30, H1, H4, D1 — all published by Exness |
| Candle chart | Broker candle history; the newest bar extends with every tick |
| RSI pane | Line with oversold / overbought bands |
| MACD pane | Histogram plus the MACD and signal lines |
| Signal | Toggle, sound toggle, latest signal, and a log of past ones |
| Parameters | Every MACD and RSI input, plus two switchable rule sets |
| Your strategies | Every strategy you own that targets XAUUSD |

## Signal rules

Two rule sets, switchable. All parameters are editable either way.

**MACD cross + RSI 30/70** (default) — buy when MACD crosses above its signal
line while RSI is at or below *oversold*; sell on the mirror image. Fires early
and relatively often.

**MACD zero-line + RSI 50** — buy when MACD crosses above zero with RSI above
50; sell when it crosses below zero with RSI below 50. Trend-following: fewer
signals, later entry.

Both require **agreement on the same bar**. A MACD cross on its own does not
alert, and neither does RSI reaching an extreme.

### Why signals wait for a closed bar

Indicator values move continuously while a bar is still forming. Evaluating on
every tick produces alerts that appear and then vanish seconds later as the
price oscillates. The desk evaluates the bar that has *just closed*, so a signal
cannot be taken back.

The trade-off is latency: on M1 that is up to a minute behind the raw tick. On
M15 up to fifteen minutes. That is deliberate, not a bug.

### Why a cross fires once, not repeatedly

Only the *transition* triggers an alert, never the state. A trend that stays
bullish for twenty bars alerts once, on the bar it turned, rather than twenty
times.

## Alert behaviour

An alert raises an on-screen banner, adds a row to the signal log, and — if you
switch it on — plays a short chime (two rising notes for buy, two falling for
sell). Sound requires a click on the toggle first, because browsers block audio
until you interact with the page.

The **signals on/off** toggle is separate from sound. Turning signals off keeps
the indicators updating and keeps the log, but stops new alerts.

Browser notifications are not used, so no permission prompt appears.

## Live updates and broker limits

The desk polls the price every 3 seconds and refreshes candle history every 15.
Each price call opens a short-lived WebSocket to the broker to read one tick.

Exness rate-limits both *concurrent* connections and the *rate of new*
connections per account, rejecting excess handshakes with HTTP 429. At the
default cadence the desk stays well inside that budget. If the feed does start
refusing, the desk backs off automatically — doubling the interval up to 30
seconds — rather than hammering harder.

If you plan to leave the desk open for long stretches, prefer a higher
timeframe: the chart and indicators need fewer refreshes to stay meaningful, and
you put less load on the broker connection.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "No broker connected" | Add credentials in **Settings → Broker connection**. The desk shows nothing without one |
| Chart empty, price updating | Candle history failed while the tick stream is healthy. The reason appears in place of the chart |
| No signal for a long time | Expected. Both indicators must agree on a *closed* bar. Check the current MACD/RSI read-out under the signal heading |
| Signals seem too rare | Try the **MACD cross + RSI 30/70** rule with a shorter RSI period, or a lower timeframe |
| Signals seem too frequent | Switch to **MACD zero-line + RSI 50**, or move to a higher timeframe |
| No sound | Click the sound toggle once — browsers block audio until you interact with the page |
| My XAUUSD strategy is missing | The list filters on the strategy's `symbol` field. It must be exactly `XAUUSD` (slashes and case are ignored) |
