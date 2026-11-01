"use client";

/**
 * Live market panel.
 *
 * Prices come from whichever broker the user has connected in Settings. With
 * no broker it renders an explicit disconnected state — it never shows a
 * simulated price.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Radio, RefreshCw } from "lucide-react";

import * as api from "@/lib/api";
import { fmt } from "@/lib/format";
import type { BrokerCandle, BrokerQuote, BrokerStatus } from "@/lib/types";
import { useAlphaForge } from "./AlphaForgeProvider";
import { Spinner } from "./ui";

/**
 * Two seconds looked fine while the calls were being refused. Now that they
 * reach the broker, each tick is two name lookups on the engine plus two
 * round trips to a feed that throttles at 100–500 ms — and a serverless
 * resolver answers a burst like that with EBUSY. Five seconds is fast enough
 * for a live chart and a fifth of the pressure.
 */
const POLL_MS = 5000;
/** How far a failing feed backs off before giving the resolver a rest. */
const MAX_POLL_MS = 30_000;

interface Props {
  symbol: string;
  timeframe: string;
  status: BrokerStatus | null;
  onConnect?: () => void;
  compact?: boolean;
}

function CandleChart({ candles }: { candles: BrokerCandle[] }) {
  if (candles.length < 2) return null;
  const W = 320;
  const H = 88;
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const span = hi - lo || 1;
  const gap = W / candles.length;
  const barW = Math.max(1.5, gap * 0.62);
  const y = (v: number) => H - ((v - lo) / span) * (H - 8) - 4;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-20 w-full" role="img" aria-label="Recent candles">
      {candles.map((candle, i) => {
        const cx = i * gap + gap / 2;
        const up = candle.c >= candle.o;
        const colour = up ? "rgb(52,211,153)" : "rgb(248,113,113)";
        return (
          <g key={candle.t}>
            <line
              x1={cx}
              x2={cx}
              y1={y(candle.h)}
              y2={y(candle.l)}
              stroke={colour}
              strokeOpacity="0.6"
              strokeWidth="1"
            />
            <rect
              x={cx - barW / 2}
              y={y(Math.max(candle.o, candle.c))}
              width={barW}
              height={Math.max(1.2, Math.abs(y(candle.o) - y(candle.c)))}
              fill={colour}
              fillOpacity="0.85"
            />
          </g>
        );
      })}
    </svg>
  );
}

export default function LivePricePanel({ symbol, timeframe, status, onConnect, compact }: Props) {
  const { brokerToken } = useAlphaForge();
  const [quote, setQuote] = useState<BrokerQuote | null>(null);
  const [candles, setCandles] = useState<BrokerCandle[]>([]);
  const [changePct, setChangePct] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against a slow tick piling requests on top of itself. */
  const inFlight = useRef(false);
  /** Whether a quote has ever landed, so a first-tick blip is not fatal. */
  const hasQuote = useRef(false);

  const connected = Boolean(status?.connected);
  const unavailable = !status || status.mode === "unavailable" || !status.available;

  const poll = useCallback(
    async (initial = false): Promise<boolean> => {
      if (!connected || inFlight.current) return false;
      inFlight.current = true;
      if (initial) setLoading(true);
      let ok = false;
      try {
        // The engine reads credentials per account, so price and candle calls
        // are authenticated. Sending them bare made the panel report "the
        // engine received no session token" to someone who was signed in.
        const token = await brokerToken();
        const [nextQuote, nextCandles] = await Promise.all([
          api.brokerPrice(symbol, undefined, token),
          api.brokerCandles(symbol, timeframe, 60, undefined, token),
        ]);
        if (nextQuote.available) {
          setQuote(nextQuote);
          hasQuote.current = true;
          setError(null);
          ok = true;
        } else if (!nextQuote.available && nextQuote.reason && !hasQuote.current) {
          setError(nextQuote.reason);
        }
        if (nextCandles.available) {
          setCandles(nextCandles.candles ?? []);
          setChangePct(nextCandles.change_pct ?? null);
          ok = true;
        }
      } catch {
        /* keep the last good tick on a transient failure */
      } finally {
        inFlight.current = false;
        if (initial) setLoading(false);
      }
      return ok;
    },
    [brokerToken, connected, symbol, timeframe],
  );

  useEffect(() => {
    if (!connected) {
      setQuote(null);
      setCandles([]);
      setChangePct(null);
      hasQuote.current = false;
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    // Self-scheduling rather than a fixed interval: a feed that keeps failing
    // backs off instead of hammering the engine's resolver at full rate.
    let cancelled = false;
    let delay = POLL_MS;
    const tick = async (initial: boolean) => {
      const ok = await poll(initial);
      if (cancelled) return;
      delay = ok ? POLL_MS : Math.min(delay * 2, MAX_POLL_MS);
      timer.current = setTimeout(() => void tick(false), delay);
    };
    void tick(true);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, symbol, timeframe]);

  /* --------------------------- disconnected state -------------------------- */
  if (!connected) {
    const reason =
      status?.reason ??
      "Connect a broker in Settings to stream real prices. No broker is connected, so no price is shown — AlphaForge never invents one.";

    if (compact) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-white/10 px-3 py-2 text-[11px] text-white/40">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
          <span>No broker connected — no live price</span>
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg border border-amber-400/20 bg-amber-400/10 p-1.5">
            <AlertTriangle className="h-4 w-4 text-amber-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <Radio className="h-3.5 w-3.5" />
              {symbol} · live price unavailable
            </div>
            <p className="mt-1 text-xs leading-relaxed text-white/45">{reason}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-white/30">
              Run <code className="rounded bg-white/5 px-1 py-0.5">cd backend &amp;&amp; uvicorn main:app --port 8000</code>{" "}
              on your trading machine, then press <em>Launch &amp; Connect</em> in Settings.
            </p>
            {onConnect ? (
              <button
                type="button"
                onClick={onConnect}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-teal-400/25 bg-teal-400/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition hover:bg-teal-400/20"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry connection
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  /* ----------------------------- connected --------------------------------- */
  const mid = quote ? ((quote.bid ?? 0) + (quote.ask ?? 0)) / 2 : null;
  const digits = quote?.digits ?? 5;
  const rising = (changePct ?? 0) >= 0;

  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-mint-400/20 bg-mint-400/[0.06] px-3 py-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-mint-400" />
        </span>
        <span className="text-xs font-medium text-white/80">{symbol}</span>
        <span className="font-mono text-sm font-semibold text-white">
          {mid ? mid.toFixed(digits) : "—"}
        </span>
        {changePct !== null ? (
          <span
            className={`flex items-center gap-0.5 text-[11px] ${
              rising ? "text-mint-300" : "text-rose-300"
            }`}
          >
            {rising ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {fmt.signed(changePct, 2)}%
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-mint-400" />
            </span>
            live · {symbol} · {timeframe}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold text-white">
              {mid ? mid.toFixed(digits) : "—"}
            </span>
            {changePct !== null ? (
              <span
                className={`flex items-center gap-0.5 text-sm ${
                  rising ? "text-mint-300" : "text-rose-300"
                }`}
              >
                {rising ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                {fmt.signed(changePct, 2)}%
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-white/45">
            <span>
              bid <span className="text-white/75">{(quote?.bid ?? 0).toFixed(digits)}</span>
            </span>
            <span>
              ask <span className="text-white/75">{(quote?.ask ?? 0).toFixed(digits)}</span>
            </span>
            <span>
              spread{" "}
              <span className="text-white/75">
                {((quote?.spread ?? 0) * (digits >= 3 ? 10 : 1)).toFixed(1)} pt
              </span>
            </span>
            {status?.account?.server ? (
              <span className="text-white/35">{status.account.server}</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {loading && !quote ? <Spinner className="h-4 w-4" /> : null}
          <button
            type="button"
            onClick={() => void poll(true)}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/50 transition hover:border-white/20 hover:text-white/80"
          >
            <Activity className="h-3 w-3" />
            refresh
          </button>
          {quote?.server_time ? (
            <span className="text-[10px] text-white/25">
              {new Date(quote.server_time).toUTCString().slice(17, 25)} UTC
            </span>
          ) : null}
        </div>
      </div>

      {error && !quote ? (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/80">
          {error}
        </p>
      ) : null}

      <div className="mt-3">
        <CandleChart candles={candles} />
      </div>
    </div>
  );
}
