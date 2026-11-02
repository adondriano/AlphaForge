"use client";

/**
 * The XAUUSD desk: one instrument, watched properly.
 *
 * A live candle chart, RSI and MACD panes with editable parameters, and a
 * signal that only fires when both indicators agree on a *closed* candle.
 *
 * Two deliberate choices worth knowing about:
 *
 * - Signals are evaluated on closed bars, never on the forming one. Indicator
 *   values move around while a bar is open, so a tick-level trigger produces
 *   alerts that vanish again a second later.
 * - Only bars that close while you are watching generate alerts. History is
 *   replayed for the chart, not for the alert list — otherwise opening the tab
 *   would fire a burst of stale signals from the last few hundred bars.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Volume2,
  VolumeX,
} from "lucide-react";

import * as api from "@/lib/api";
import {
  DEFAULT_PARAMS,
  RULE_SETS,
  evaluateClosedBar,
  latestReading,
  macd,
  warmupBars,
  type Direction,
  type IndicatorParams,
  type RuleSetId,
  type SignalEvent,
} from "@/lib/indicators";
import { rsi } from "@/lib/engine";
import { fmt } from "@/lib/format";
import type { BrokerCandle, BrokerQuote } from "@/lib/types";
import { useAlphaForge } from "./AlphaForgeProvider";
import LiveChart from "./LiveChart";
import { MacdChart, RsiChart } from "./IndicatorChart";
import { Spinner } from "./ui";

const SYMBOL = "XAUUSD";
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

/** Price refresh. Fast enough to feel live without hammering the broker. */
const PRICE_MS = 3_000;
/** Candle refresh: how quickly a newly closed bar is noticed. */
const CANDLE_MS = 15_000;
/** Bars of history to chart and to warm the indicators up on. */
const HISTORY = 240;

const MAX_ALERTS = 40;

function chime(direction: Direction) {
  if (typeof window === "undefined") return;
  type WithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  const now = ctx.currentTime;
  const notes = direction === "buy" ? [660, 880] : [560, 380];
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + i * 0.13);
    gain.gain.setValueAtTime(0.0001, now + i * 0.13);
    gain.gain.exponentialRampToValueAtTime(0.22, now + i * 0.13 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + i * 0.13);
    osc.stop(now + i * 0.13 + 0.47);
  });
  // Let the last note finish before tearing the context down.
  window.setTimeout(() => void ctx.close(), 900);
}

export default function XauusdDesk() {
  const { brokerToken, notify, strategies, brokerStatus } = useAlphaForge();

  const [timeframe, setTimeframe] = useState("M15");
  const [params, setParams] = useState<IndicatorParams>(DEFAULT_PARAMS);
  const [rule, setRule] = useState<RuleSetId>("classic");
  const [signalsOn, setSignalsOn] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [showParams, setShowParams] = useState(false);

  const [quote, setQuote] = useState<BrokerQuote | null>(null);
  const [candles, setCandles] = useState<BrokerCandle[]>([]);
  const [alerts, setAlerts] = useState<SignalEvent[]>([]);
  const [live, setLive] = useState<SignalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * The bar already evaluated. Initialised on the first history load so past
   * bars are charted but never alerted on.
   */
  const evaluatedT = useRef<number | null>(null);
  const inFlight = useRef(false);

  const connected = Boolean(brokerStatus?.connected);

  /* ------------------------------ data ---------------------------------- */

  const loadCandles = useCallback(async (): Promise<boolean> => {
    if (!connected) return false;
    const token = await brokerToken();
    const series = await api.brokerCandles(SYMBOL, timeframe, HISTORY, undefined, token);
    if (!series.available || series.candles.length < 2) {
      if (series.reason) setProblem(series.reason);
      return false;
    }
    setProblem(null);
    setCandles(series.candles);
    return true;
  }, [brokerToken, connected, timeframe]);

  const loadPrice = useCallback(async (): Promise<boolean> => {
    if (!connected) return false;
    const token = await brokerToken();
    const next = await api.brokerPrice(SYMBOL, undefined, token);
    if (!next.available) {
      if (next.reason) setProblem(next.reason);
      return false;
    }
    setQuote(next);
    return true;
  }, [brokerToken, connected]);

  /* --------------------------- polling loop ------------------------------ */

  useEffect(() => {
    if (!connected) {
      setQuote(null);
      setCandles([]);
      evaluatedT.current = null;
      setLoading(false);
      return;
    }
    let cancelled = false;
    let delay = PRICE_MS;
    let sinceCandles = 0;

    const tick = async (initial: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (initial) setLoading(true);
      let ok = false;
      try {
        sinceCandles += delay;
        if (initial || sinceCandles >= CANDLE_MS) {
          sinceCandles = 0;
          ok = await loadCandles();
        }
        ok = (await loadPrice()) || ok;
      } catch {
        /* keep the last good values on a transient failure */
      } finally {
        inFlight.current = false;
        if (initial) setLoading(false);
        if (cancelled) return;
        // Back off when the feed is failing; a broker that is rate-limiting us
        // must not be polled harder for the sin of rate-limiting us.
        delay = ok ? PRICE_MS : Math.min(delay * 2, 30_000);
        timer = setTimeout(() => void tick(false), delay);
      }
    };

    let timer = setTimeout(() => void tick(false), delay);
    void tick(true);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected, loadCandles, loadPrice]);

  // Reset the evaluated marker when the timeframe changes: bars mean something
  // different now, so the old marker is meaningless.
  useEffect(() => {
    evaluatedT.current = null;
    setCandles([]);
  }, [timeframe]);

  /* ------------------------- derived indicator data ---------------------- */

  /**
   * The forming bar is excluded from signal maths. Its close moves with every
   * tick, so including it would make the confirmed signal unstable.
   */
  const closed = useMemo(() => candles.slice(0, -1), [candles]);
  const closes = useMemo(() => candles.map((c) => c.c), [candles]);
  const times = useMemo(() => candles.map((c) => c.t), [candles]);

  const macdSeries = useMemo(
    () => macd(closes, params.macdFast, params.macdSlow, params.macdSignal),
    [closes, params.macdFast, params.macdSlow, params.macdSignal],
  );
  const rsiSeries = useMemo(
    () => rsi(closes, params.rsiPeriod),
    [closes, params.rsiPeriod],
  );
  const reading = useMemo(() => latestReading(closes, params), [closes, params]);

  const warm = warmupBars(params);
  const enoughData = candles.length > warm + 2;

  /* ------------------------------ signals -------------------------------- */

  useEffect(() => {
    if (!signalsOn || !enoughData || closed.length < 2) return;

    const barIndex = closed.length - 1;
    const barT = times[barIndex];

    // First sight of history: record where we are and stay quiet.
    if (evaluatedT.current === null) {
      evaluatedT.current = barT;
      return;
    }
    if (barT === evaluatedT.current) return;
    evaluatedT.current = barT;

    const event = evaluateClosedBar(closes, times, params, rule, barIndex);
    if (!event) return;

    setAlerts((prev) => [event, ...prev].slice(0, MAX_ALERTS));
    setLive(event);
    if (soundOn) chime(event.direction);
    notify({
      kind: event.direction === "buy" ? "success" : "error",
      title: `${event.direction === "buy" ? "BUY" : "SELL"} — MACD + RSI agree`,
      detail:
        `${SYMBOL} ${timeframe} @ ${event.price.toFixed(2)} · ` +
        `MACD ${event.macd.toFixed(2)} vs signal ${event.signal.toFixed(2)} · ` +
        `RSI ${event.rsi.toFixed(1)}`,
    });
  }, [
    signalsOn, enoughData, closed, closes, times, params, rule,
    soundOn, notify, timeframe,
  ]);

  /* ------------------------------ render --------------------------------- */

  const xauStrategies = useMemo(
    () =>
      strategies.filter(
        (s) => (s.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "") === SYMBOL,
      ),
    [strategies],
  );

  // A quote without a usable two-sided price is not a price. Treating a
  // missing bid as 0 would render 0.00 as if it were the market.
  const bid = quote?.bid ?? 0;
  const ask = quote?.ask ?? 0;
  const hasPrice = bid > 0 && ask > 0;
  const mid = hasPrice ? (bid + ask) / 2 : null;
  const digits = quote?.digits ?? 2;

  if (!connected) {
    return (
      <div className="panel p-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg border border-amber-400/20 bg-amber-400/10 p-1.5">
            <AlertTriangle className="h-4 w-4 text-amber-300" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white/85">
              No broker connected
            </div>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-white/45">
              The desk streams real {SYMBOL} prices, so it needs a live
              connection. Add your broker API credentials in{" "}
              <span className="text-white/70">Settings → Broker connection</span>{" "}
              to switch it on. Nothing is simulated here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------- header -------------------------- */}
      <div className="panel flex flex-wrap items-end justify-between gap-4 p-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-mint-400" />
            </span>
            {SYMBOL} · live
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-mono text-3xl font-semibold text-white">
              {mid ? mid.toFixed(digits) : loading ? "" : "—"}
            </span>
            {loading && !mid ? <Spinner className="h-4 w-4" /> : null}
            {hasPrice ? (
              <span className="font-mono text-[11px] text-white/40">
                bid {bid.toFixed(digits)} · ask {ask.toFixed(digits)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                tf === timeframe
                  ? "bg-mint-400/15 text-mint-200"
                  : "text-white/40 hover:bg-white/5 hover:text-white/75"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------- alerts -------------------------- */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-forge-violet" />
            <span className="text-sm font-semibold text-white">Signal</span>
            <span className="text-[11px] text-white/40">
              {RULE_SETS[rule].label}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSignalsOn((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                signalsOn
                  ? "border-mint-400/25 bg-mint-400/10 text-mint-200"
                  : "border-white/10 text-white/45 hover:text-white/70"
              }`}
            >
              {signalsOn ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              signals {signalsOn ? "on" : "off"}
            </button>
            <button
              type="button"
              onClick={() => setSoundOn((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                soundOn
                  ? "border-mint-400/25 bg-mint-400/10 text-mint-200"
                  : "border-white/10 text-white/45 hover:text-white/70"
              }`}
            >
              {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              sound {soundOn ? "on" : "off"}
            </button>
          </div>
        </div>

        {!signalsOn ? (
          <p className="mt-3 text-[11px] text-white/35">
            Alerts are paused. The indicators keep updating, and the log keeps
            anything already recorded.
          </p>
        ) : live ? (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
              live.direction === "buy"
                ? "border-mint-400/25 bg-mint-400/[0.07] text-mint-200"
                : "border-rose-400/25 bg-rose-400/[0.07] text-rose-200"
            }`}
          >
            <span className="font-semibold">
              {live.direction === "buy" ? "BUY" : "SELL"}
            </span>{" "}
            — MACD and RSI agree on the closed {timeframe} bar at{" "}
            <span className="font-mono">{live.price.toFixed(digits)}</span>
            {" · RSI "}
            <span className="font-mono">{live.rsi.toFixed(1)}</span>
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-white/35">
            Watching for a bar to close with both indicators in agreement.
            {reading
              ? ` Currently MACD ${reading.macd.toFixed(2)} vs signal ${reading.signal.toFixed(2)}, RSI ${reading.rsi.toFixed(1)}.`
              : ""}
          </p>
        )}

        {alerts.length > 0 ? (
          <div className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-white/[0.06]">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-[#0b0d15] text-white/35">
                <tr>
                  <th className="px-3 py-1.5 font-medium">time (UTC)</th>
                  <th className="px-3 py-1.5 font-medium">signal</th>
                  <th className="px-3 py-1.5 font-medium">price</th>
                  <th className="px-3 py-1.5 font-medium">RSI</th>
                  <th className="px-3 py-1.5 font-medium">rule</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-t border-white/[0.04]">
                    <td className="px-3 py-1.5 font-mono text-white/50">
                      {new Date(a.at * 1000).toISOString().slice(5, 16).replace("T", " ")}
                    </td>
                    <td
                      className={`px-3 py-1.5 font-semibold ${
                        a.direction === "buy" ? "text-mint-300" : "text-rose-300"
                      }`}
                    >
                      {a.direction === "buy" ? "BUY" : "SELL"}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-white/75">
                      {a.price.toFixed(digits)}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-white/60">
                      {a.rsi.toFixed(1)}
                    </td>
                    <td className="px-3 py-1.5 text-white/40">{a.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ------------------------------- chart --------------------------- */}
      <div className="panel p-4">
        {candles.length > 1 ? (
          <>
            <LiveChart
              candles={candles}
              timeframe={timeframe}
              livePrice={mid}
              digits={digits}
              height={340}
            />
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/35">
                <span className="text-violet-300/80">RSI</span>
                <span className="text-white/20">{params.rsiPeriod}</span>
              </div>
              <RsiChart
                values={rsiSeries}
                oversold={params.rsiOversold}
                overbought={params.rsiOverbought}
              />
            </div>
            <div className="mt-1 border-t border-white/[0.06] pt-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/35">
                <span className="text-blue-300/80">MACD</span>
                <span className="text-white/20">
                  {params.macdFast}/{params.macdSlow}/{params.macdSignal}
                </span>
                <span className="ml-auto flex items-center gap-3 text-[10px] normal-case tracking-normal">
                  <span className="text-blue-300/70">macd</span>
                  <span className="text-amber-300/70">signal</span>
                </span>
              </div>
              <MacdChart
                histogram={macdSeries.histogram}
                macd={macdSeries.macd}
                signal={macdSeries.signal}
              />
            </div>
          </>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-white/10 px-4 text-center text-[11px] leading-relaxed text-white/35">
            {loading
              ? `Loading ${SYMBOL} ${timeframe} history…`
              : problem ?? "No candle history returned for this symbol."}
          </div>
        )}
      </div>

      {/* ----------------------------- parameters ------------------------ */}
      <div className="panel p-4">
        <button
          type="button"
          onClick={() => setShowParams((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          {showParams ? (
            <ChevronDown className="h-4 w-4 text-white/40" />
          ) : (
            <ChevronRight className="h-4 w-4 text-white/40" />
          )}
          <span className="text-sm font-semibold text-white">Indicator parameters</span>
          <span className="text-[11px] text-white/35">
            MACD {params.macdFast}/{params.macdSlow}/{params.macdSignal} · RSI{" "}
            {params.rsiPeriod} ({params.rsiOversold}/{params.rsiOverbought})
          </span>
        </button>

        {showParams ? (
          <div className="mt-4 space-y-4">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wider text-white/35">
                rule set
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(RULE_SETS) as RuleSetId[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRule(id)}
                    className={`rounded-lg border p-2.5 text-left transition ${
                      rule === id
                        ? "border-mint-400/25 bg-mint-400/[0.07]"
                        : "border-white/10 hover:border-white/20"
                    }`}
                  >
                    <div
                      className={`text-xs font-semibold ${
                        rule === id ? "text-mint-200" : "text-white/75"
                      }`}
                    >
                      {RULE_SETS[id].label}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-white/40">
                      {RULE_SETS[id].blurb}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <NumberFields
              params={params}
              onChange={setParams}
              fields={[
                { key: "macdFast", label: "MACD fast", min: 2, max: 100 },
                { key: "macdSlow", label: "MACD slow", min: 3, max: 200 },
                { key: "macdSignal", label: "MACD signal", min: 2, max: 100 },
                { key: "rsiPeriod", label: "RSI period", min: 2, max: 100 },
                { key: "rsiOversold", label: "RSI oversold", min: 1, max: 49 },
                { key: "rsiOverbought", label: "RSI overbought", min: 51, max: 99 },
              ]}
            />

            <button
              type="button"
              onClick={() => setParams(DEFAULT_PARAMS)}
              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-white/50 transition hover:border-white/20 hover:text-white/80"
            >
              reset to defaults
            </button>
          </div>
        ) : null}
      </div>

      {/* ----------------------------- strategies ------------------------- */}
      <div className="panel p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-white">
            Your {SYMBOL} strategies
          </span>
          <span className="text-[11px] text-white/35">
            {xauStrategies.length} of {strategies.length}
          </span>
        </div>

        {xauStrategies.length === 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-white/35">
            No strategy targets {SYMBOL} yet. Create one in the Strategy Studio
            with <span className="text-white/60">symbol: XAUUSD</span> and it
            will appear here.
          </p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {xauStrategies.map((s) => (
              <div
                key={s.id}
                className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-white/85">
                    {s.name}
                  </span>
                  <span className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/45">
                    {s.timeframe}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
                  <span className="text-white/40">
                    win{" "}
                    <span className="text-white/75">
                      {fmt.pct(s.win_rate * 100, 0)}
                    </span>
                  </span>
                  <span className="text-white/40">
                    ret{" "}
                    <span
                      className={
                        s.net_return_pct >= 0 ? "text-mint-300" : "text-rose-300"
                      }
                    >
                      {fmt.signed(s.net_return_pct, 1)}%
                    </span>
                  </span>
                  <span className="text-white/40">
                    dd{" "}
                    <span className="text-white/75">
                      {fmt.pct(s.max_drawdown_pct, 1)}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

interface Field {
  key: keyof IndicatorParams;
  label: string;
  min: number;
  max: number;
}

function NumberFields({
  params,
  onChange,
  fields,
}: {
  params: IndicatorParams;
  onChange: (next: IndicatorParams) => void;
  fields: Field[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {fields.map((field) => (
        <label key={field.key} className="block">
          <span className="mb-1 block text-[11px] text-white/45">{field.label}</span>
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={params[field.key]}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (!Number.isFinite(raw)) return;
              const clamped = Math.min(field.max, Math.max(field.min, Math.round(raw)));
              onChange({ ...params, [field.key]: clamped });
            }}
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs text-white outline-none transition focus:border-mint-400/40"
          />
        </label>
      ))}
    </div>
  );
}
