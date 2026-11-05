"use client";

import {
  AlertTriangle,
  BellRing,
  Crosshair,
  Loader2,
  Radio,
  Send,
  ShieldAlert,
  Siren,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAlphaForge } from "./AlphaForgeProvider";
import {
  Badge,
  Card,
  Spinner,
  Toggle,
  cx,
} from "./ui";
import * as api from "@/lib/api";
import type { PropFirmPreset, WatchlistRow } from "@/lib/api";
import {
  DEFAULT_WEIGHTS,
  HEURISTIC_NOTICE,
  buildAlertPayload,
  levelsFromAtr,
  scoreConfidence,
} from "@/lib/confidence";
import type { ConfidenceResult, Direction } from "@/lib/confidence";
import type { Bar } from "@/lib/engine";

/* -------------------------------------------------------------------------- */
/* constants                                                                   */
/* -------------------------------------------------------------------------- */

const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4"] as const;
const HISTORY = 240;
const CANDLE_MS = 15_000;
const DEFAULT_THRESHOLD = 80;
const MAX_ALERTS = 25;

/** Two-step confirmation for the kill switch, in seconds. */
const KILL_HOLD_SECONDS = 3;

interface AlertRecord {
  id: string;
  symbol: string;
  direction: Direction;
  total: number;
  levels: ReturnType<typeof levelsFromAtr>;
  at: number;
}

const NO_MT5_REASON =
  "MetaTrader5 is a Windows-only package and the engine runs on Linux " +
  "serverless, and an MCP stdio bridge needs a 24/7 Windows host. Nothing " +
  "here can reach it.";

/* -------------------------------------------------------------------------- */
/* sound                                                                       */
/* -------------------------------------------------------------------------- */

function alarm(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // Three quick pulses: distinct enough to cut through, unlike the desk's
    // single chime, because this fires on a threshold breach.
    [0, 0.18, 0.36].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + offset;
      osc.type = "triangle";
      osc.frequency.setValueAtTime(i === 1 ? 990 : 740, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.16);
    });
    window.setTimeout(() => void ctx.close(), 900);
  } catch {
    /* audio is a nicety, never a failure path */
  }
}

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function PropFirmDesk() {
  const { brokerToken, notify, brokerStatus, canEdit } = useAlphaForge();

  const connected = Boolean(brokerStatus?.connected);

  /* -- catalogue ---------------------------------------------------------- */
  const [firms, setFirms] = useState<PropFirmPreset[]>([]);
  const [fallbackUniverse, setFallbackUniverse] = useState<WatchlistRow[]>([]);
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [brokerNote, setBrokerNote] = useState<string | null>(null);

  /* -- scanner ------------------------------------------------------------ */
  const [symbol, setSymbol] = useState("XAUUSD");
  const [timeframe, setTimeframe] = useState<string>("H1");
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [soundOn, setSoundOn] = useState(true);
  const [alertsOn, setAlertsOn] = useState(true);
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS });
  const [result, setResult] = useState<ConfidenceResult | null>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);

  /* -- automation --------------------------------------------------------- */
  const [firmId, setFirmId] = useState<string>("");
  const [autoTrade, setAutoTrade] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [dailyCap, setDailyCap] = useState(3.5);
  const [totalCap, setTotalCap] = useState(5);
  const [fixedRisk, setFixedRisk] = useState(1);

  /* -- webhook ------------------------------------------------------------ */
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKind, setWebhookKind] = useState("generic");
  const [chatId, setChatId] = useState("");
  const [sending, setSending] = useState(false);

  /* -- kill switch -------------------------------------------------------- */
  const [positions, setPositions] = useState<
    Array<{ position_id: string; instrument: string; side: string; volume: number | null }>
  >([]);
  const [positionsMode, setPositionsMode] = useState<string | undefined>();
  const [positionsProblem, setPositionsProblem] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [killArm, setKillArm] = useState(0);

  const evaluatedT = useRef<number | null>(null);
  const killTimer = useRef<number | null>(null);

  /* ------------------------------ catalogue ------------------------------ */

  useEffect(() => {
    let alive = true;
    (async () => {
      const describe = await api.propDescribe();
      if (!alive) return;
      if (describe) {
        setFirms(describe.firms);
        setFallbackUniverse(describe.universe);
        if (describe.firms.length) setFirmId(describe.firms[0].id);
      }
      setCatalogueLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshWatchlist = useCallback(async () => {
    const token = await brokerToken();
    const list = await api.propWatchlist(token);
    if (list?.rows) {
      setRows(list.rows);
      setBrokerNote(list.broker_note);
    } else {
      setRows([]);
    }
  }, [brokerToken]);

  useEffect(() => {
    void refreshWatchlist();
  }, [refreshWatchlist, connected]);

  /* ------------------------------ scanner -------------------------------- */

  const selected = useMemo(
    () => (rows.length ? rows : fallbackUniverse).find((r) => r.symbol === symbol) ?? null,
    [rows, fallbackUniverse, symbol],
  );

  const loadCandles = useCallback(async (): Promise<Bar[]> => {
    if (!connected) return [];
    const token = await brokerToken();
    const series = await api.brokerCandles(symbol, timeframe, HISTORY, undefined, token);
    if (!series.available || series.candles.length < 30) {
      if (series.reason) setProblem(series.reason);
      return [];
    }
    setProblem(null);
    return series.candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
  }, [brokerToken, connected, symbol, timeframe]);

  const evaluate = useCallback(
    (nextBars: Bar[], allowAlert: boolean) => {
      if (nextBars.length < 40) return;
      // Both directions are scored; whichever clears the threshold fires.
      const buy = scoreConfidence({ bars: nextBars, direction: "buy", weights });
      const sell = scoreConfidence({ bars: nextBars, direction: "sell", weights });
      const best = buy.total >= sell.total ? buy : sell;
      setResult(best);

      if (!allowAlert || !alertsOn || best.incomplete) return;
      if (best.total < threshold) return;

      const levels = levelsFromAtr(best.direction, best.context.close ?? 0, best.context.atr);
      setAlerts((prev) =>
        [
          {
            id: `${best.direction}-${nextBars[nextBars.length - 1].t}`,
            symbol,
            direction: best.direction,
            total: best.total,
            levels,
            at: Date.now(),
          },
          ...prev,
        ].slice(0, MAX_ALERTS),
      );
      if (soundOn) alarm();
      notify({
        kind: "info",
        title: `${symbol} ${best.direction.toUpperCase()} · ${best.total.toFixed(0)}% confidence`,
        detail: levels ? `Entry ${levels.entry} · SL ${levels.sl} · TP1 ${levels.tp1}` : undefined,
      });
    },
    [alertsOn, notify, soundOn, symbol, threshold, weights],
  );

  /* --------------------------- polling loop ------------------------------ */

  useEffect(() => {
    if (!connected) {
      setBars([]);
      setResult(null);
      evaluatedT.current = null;
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: number;

    const tick = async (initial: boolean) => {
      if (cancelled) return;
      setLoading(true);
      const next = await loadCandles();
      if (cancelled) return;
      setLoading(false);
      if (next.length) {
        setBars(next);
        const lastT = next[next.length - 1].t;
        // Past bars are charted but never alerted on, and a symbol or
        // timeframe change re-arms without replaying history.
        if (initial || evaluatedT.current === null) {
          evaluatedT.current = lastT;
          evaluate(next, false);
        } else if (lastT !== evaluatedT.current) {
          evaluatedT.current = lastT;
          evaluate(next, true);
        }
      }
      timer = window.setTimeout(() => void tick(false), CANDLE_MS);
    };

    evaluatedT.current = null;
    void tick(true);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connected, evaluate, loadCandles]);

  // Re-arm when the instrument or timeframe changes so the new series does not
  // immediately replay its whole history as alerts.
  useEffect(() => {
    evaluatedT.current = null;
  }, [symbol, timeframe]);

  /* ------------------------------ positions ------------------------------ */

  const refreshPositions = useCallback(async () => {
    const token = await brokerToken();
    const snap = await api.brokerPositions(undefined, token);
    if (!snap) {
      setPositions([]);
      setPositionsProblem("Could not reach the engine.");
      return;
    }
    setPositions(snap.positions ?? []);
    setPositionsMode(snap.mode);
    setPositionsProblem(snap.available ? null : snap.reason ?? "Positions unavailable.");
  }, [brokerToken]);

  useEffect(() => {
    void refreshPositions();
  }, [refreshPositions, connected]);

  const closeAll = useCallback(async () => {
    setClosing(true);
    const token = await brokerToken();
    let ok = 0;
    const failures: string[] = [];
    for (const position of positions) {
      const outcome = await api.closePosition(position.position_id, undefined, token);
      if (outcome.closed) ok += 1;
      else failures.push(`${position.instrument}: ${outcome.reason ?? "not closed"}`);
    }
    setClosing(false);
    setKillArm(0);
    setAutoTrade(false);
    await refreshPositions();
    notify({
      kind: failures.length ? "error" : "success",
      title: failures.length ? `Closed ${ok}, ${failures.length} failed` : `Closed ${ok} position(s)`,
      detail: failures.length
        ? `${failures.join("; ")}. Auto-trade was disabled; verify on your broker platform before assuming flat.`
        : "Auto-trade disabled. Exness settles asynchronously — confirm on the platform.",
    });
  }, [brokerToken, notify, positions, refreshPositions]);

  useEffect(
    () => () => {
      if (killTimer.current) window.clearTimeout(killTimer.current);
    },
    [],
  );

  const armKill = () => {
    if (killArm === 0) {
      setKillArm(1);
      killTimer.current = window.setTimeout(() => setKillArm(0), KILL_HOLD_SECONDS * 1000);
    } else {
      void closeAll();
    }
  };

  /* ------------------------------ derived -------------------------------- */

  const firm = firms.find((f) => f.id === firmId) ?? null;

  const guardrailWarnings = useMemo(() => {
    if (!firm) return [];
    const out: string[] = [];
    if (dailyCap >= firm.daily_loss_pct * 0.85)
      out.push(
        `Daily cap ${dailyCap}% is within 15% of ${firm.firm}'s ${firm.daily_loss_pct}% limit.`,
      );
    if (totalCap >= firm.max_loss_pct * 0.85)
      out.push(
        `Total cap ${totalCap}% is within 15% of ${firm.firm}'s ${firm.max_loss_pct}% maximum.`,
      );
    if (dailyCap > firm.daily_loss_pct)
      out.push(`Daily cap ${dailyCap}% EXCEEDS ${firm.firm}'s ${firm.daily_loss_pct}% limit.`);
    if (totalCap > firm.max_loss_pct)
      out.push(`Total cap ${totalCap}% EXCEEDS ${firm.firm}'s ${firm.max_loss_pct}% maximum.`);
    if (firm.max_loss_type === "trailing")
      out.push(
        `${firm.firm} ${firm.program} uses a TRAILING maximum loss, so it follows your highest equity — a static total cap understates your exposure.`,
      );
    return out;
  }, [dailyCap, firm, totalCap]);

  const grouped = useMemo(() => {
    const source = rows.length ? rows : fallbackUniverse;
    const map = new Map<string, WatchlistRow[]>();
    for (const row of source) {
      const list = map.get(row.group) ?? [];
      list.push(row);
      map.set(row.group, list);
    }
    return [...map.entries()];
  }, [rows, fallbackUniverse]);

  const tradableCount = (rows.length ? rows : fallbackUniverse).filter(
    (r) => r.status === "tradable",
  ).length;

  const sendTest = async () => {
    setSending(true);
    const payload = result
      ? buildAlertPayload(
          result,
          symbol,
          levelsFromAtr(result.direction, result.context.close ?? 0, result.context.atr),
        )
      : { event: "ALPHA_FORGE_SIGNAL", symbol, direction: "buy", confidence: 0, timestamp: new Date().toISOString() };
    const outcome = await api.dispatchAlert(webhookUrl, webhookKind, payload, chatId || undefined);
    setSending(false);
    notify({
      kind: outcome.sent ? "success" : "error",
      title: outcome.sent ? "Webhook delivered" : "Webhook failed",
      detail: outcome.reason ?? (outcome.sent ? `HTTP ${outcome.status_code}` : undefined),
    });
  };

  /* ------------------------------- render -------------------------------- */

  if (!connected) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <h3 className="text-sm font-semibold text-white">No broker connected</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-white/55">
              The scanner needs candle history, and the watchlist needs a broker
              to check availability against. Connect one in Settings and both
              come alive.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const levels = result ? levelsFromAtr(result.direction, result.context.close ?? 0, result.context.atr) : null;
  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-5">
      {/* ------------------------- alert engine ------------------------- */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <BellRing className="h-4 w-4 text-amber-300" />
          <h2 className="text-sm font-semibold text-white">Threshold &amp; alert engine</h2>
          <span className="ml-auto flex items-center gap-3">
            <Toggle checked={alertsOn} onChange={setAlertsOn} label="Alerts" />
            <Toggle checked={soundOn} onChange={setSoundOn} label="Sound" />
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-white/40">Symbol</span>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[13px] text-white outline-none focus:border-amber-300/40"
            >
              {(rows.length ? rows : fallbackUniverse).map((r) => (
                <option key={r.symbol} value={r.symbol}>
                  {r.symbol}
                  {r.status === "unsupported" ? " (unsupported)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-white/40">Timeframe</span>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[13px] text-white outline-none focus:border-amber-300/40"
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-white/40">
              Threshold · {threshold}%
            </span>
            <input
              type="range"
              min={50}
              max={95}
              step={1}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="mt-3 w-full accent-amber-300"
            />
          </label>
          <div className="flex items-end">
            <div className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-white/40">Score</div>
              <div
                className={cx(
                  "text-xl font-semibold tabular-nums",
                  (result?.total ?? 0) >= threshold ? "text-emerald-300" : "text-white/70",
                )}
              >
                {result ? `${result.total.toFixed(0)}%` : "—"}
              </div>
            </div>
          </div>
        </div>

        {selected?.status === "unsupported" && (
          <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-[12px] text-amber-200">
            {symbol} is not offered by the connected broker, so it will scan but
            cannot be traded. {selected.status_detail}
          </p>
        )}

        {result && (
          <div className="mt-4 space-y-2">
            {result.factors.map((f) => (
              <div key={f.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-white/80">{f.label}</span>
                    <span className="text-[11px] text-white/35">
                      weight {(f.weight * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-white/45">{f.detail}</p>
                </div>
                <div className="flex w-40 items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={cx(
                        "h-full rounded-full",
                        f.score >= 70 ? "bg-emerald-400" : f.score >= 40 ? "bg-amber-300" : "bg-white/30",
                      )}
                      style={{ width: `${f.score}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-[11px] tabular-nums text-white/60">
                    {f.score.toFixed(0)}
                  </span>
                </div>
              </div>
            ))}

            {levels && (
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-black/30 p-3 sm:grid-cols-5">
                {[
                  ["Direction", result.direction.toUpperCase()],
                  ["Entry", levels.entry],
                  ["Stop", levels.sl],
                  ["TP1", levels.tp1],
                  ["TP2", levels.tp2],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
                    <div className="text-[13px] font-medium tabular-nums text-white/85">{value}</div>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-white/35">{HEURISTIC_NOTICE}</p>
          </div>
        )}

        {problem && (
          <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-[12px] text-amber-200">
            {problem}
          </p>
        )}
        {loading && !result && (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-white/45">
            <Spinner /> Loading candles…
          </p>
        )}
      </Card>

      {/* --------------------------- weights --------------------------- */}
      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold text-white">Factor weights</h2>
        <p className="mb-3 text-[11px] text-white/45">
          These are the whole model — there is nothing hidden behind them.
          Current sum {(weightSum * 100).toFixed(0)}%; scores are normalised by
          the sum, so they do not have to equal 100.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(Object.keys(weights) as Array<keyof typeof weights>).map((key) => (
            <label key={key} className="block">
              <span className="text-[11px] uppercase tracking-wide text-white/40">
                {key} · {(weights[key] * 100).toFixed(0)}%
              </span>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.05}
                value={weights[key]}
                onChange={(e) => setWeights((w) => ({ ...w, [key]: Number(e.target.value) }))}
                className="mt-2 w-full accent-amber-300"
              />
            </label>
          ))}
        </div>
      </Card>

      {/* -------------------------- watchlist -------------------------- */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Crosshair className="h-4 w-4 text-sky-300" />
          <h2 className="text-sm font-semibold text-white">Prop-firm watchlist</h2>
          <Badge tone={connected ? "mint" : "neutral"}>
            {tradableCount} tradable / {(rows.length ? rows : fallbackUniverse).length}
          </Badge>
          <button
            type="button"
            onClick={() => void refreshWatchlist()}
            className="ml-auto rounded-lg border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/5"
          >
            Refresh
          </button>
        </div>

        {catalogueLoading ? (
          <p className="flex items-center gap-2 text-[12px] text-white/45">
            <Spinner /> Loading universe…
          </p>
        ) : (
          <div className="space-y-4">
            {grouped.map(([group, list]) => (
              <div key={group}>
                <div className="mb-1.5 text-[11px] uppercase tracking-wide text-white/35">
                  {group}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((row) => (
                    <button
                      key={row.symbol}
                      type="button"
                      onClick={() => setSymbol(row.symbol)}
                      title={`${row.status_detail} · max spread ${row.spread_limit.unit === "bps" ? `${row.spread_limit.bps} bps` : `${row.spread_limit.pips} pips`}`}
                      className={cx(
                        "rounded-md border px-2 py-1 text-[11px] transition",
                        row.symbol === symbol
                          ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
                          : "border-white/10 bg-black/30 text-white/60 hover:bg-white/5",
                        row.status === "unsupported" && "opacity-50",
                      )}
                    >
                      {row.symbol}
                      <span
                        className={cx(
                          "ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle",
                          row.status === "tradable"
                            ? "bg-emerald-400"
                            : row.status === "unsupported"
                              ? "bg-rose-400"
                              : "bg-white/30",
                        )}
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {brokerNote && (
          <p className="mt-3 text-[11px] text-amber-200/80">{brokerNote}</p>
        )}
      </Card>

      {/* -------------------------- automation -------------------------- */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Zap className="h-4 w-4 text-violet-300" />
          <h2 className="text-sm font-semibold text-white">Automation &amp; guardrails</h2>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-white/40">
                Execution route
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-300/5 px-3 py-2">
                  <Radio className="h-4 w-4 text-emerald-300" />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-emerald-200">
                      Direct Broker API
                    </div>
                    <div className="text-[11px] text-white/45">Active. Orders go straight to the broker&apos;s REST API.</div>
                  </div>
                </div>
                <div
                  className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 opacity-60"
                  title={NO_MT5_REASON}
                >
                  <Radio className="mt-0.5 h-4 w-4 text-white/40" />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-white/60">
                      MT5 MCP <span className="text-white/35">· unavailable</span>
                    </div>
                    <div className="text-[11px] leading-relaxed text-white/40">{NO_MT5_REASON}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <Toggle checked={liveMode} onChange={setLiveMode} label={liveMode ? "Live" : "Paper"} />
              <Toggle
                checked={autoTrade}
                onChange={(next) => {
                  if (next && !canEdit) {
                    notify({ kind: "error", title: "Read-only", detail: "Sign in to trade." });
                    return;
                  }
                  setAutoTrade(next);
                }}
                label="Auto-trade"
              />
              <span className="text-[11px] text-white/35">
                fires at ≥{threshold}%
              </span>
            </div>

            {liveMode && (
              <p className="rounded-lg border border-rose-300/30 bg-rose-300/5 px-3 py-2 text-[12px] text-rose-200">
                Live mode sends real orders. Paper is the default for a reason —
                leave this off until you have watched the scanner fire.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-white/40">Prop firm</span>
              <select
                value={firmId}
                onChange={(e) => setFirmId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none focus:border-amber-300/40"
              >
                {firms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.firm} · {f.program}
                  </option>
                ))}
              </select>
            </label>

            {firm && (
              <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] leading-relaxed text-white/50">
                {firm.note}
                <span className="mt-1 block text-white/30">
                  Daily resets {firm.daily_reset} {firm.daily_reset_tz}. Platforms:{" "}
                  {firm.platforms.join(", ")}.
                </span>
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-white/40">
                  Daily loss cap · {dailyCap}%
                </span>
                <input
                  type="range"
                  min={0.5}
                  max={10}
                  step={0.5}
                  value={dailyCap}
                  onChange={(e) => setDailyCap(Number(e.target.value))}
                  className="mt-2 w-full accent-amber-300"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-white/40">
                  Total loss cap · {totalCap}%
                </span>
                <input
                  type="range"
                  min={1}
                  max={15}
                  step={0.5}
                  value={totalCap}
                  onChange={(e) => setTotalCap(Number(e.target.value))}
                  className="mt-2 w-full accent-amber-300"
                />
              </label>
            </div>

            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-white/40">
                Fixed risk per trade
              </div>
              <div className="flex gap-2">
                {[0.5, 1, 2].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setFixedRisk(pct)}
                    className={cx(
                      "rounded-lg border px-3 py-1.5 text-[12px] transition",
                      fixedRisk === pct
                        ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
                        : "border-white/10 bg-black/30 text-white/60 hover:bg-white/5",
                    )}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            {guardrailWarnings.map((warning) => (
              <p
                key={warning}
                className="flex items-start gap-2 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {warning}
              </p>
            ))}
          </div>
        </div>
      </Card>

      {/* --------------------------- webhook --------------------------- */}
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Send className="h-4 w-4 text-sky-300" />
          <h2 className="text-sm font-semibold text-white">Alert webhook</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="text-[11px] uppercase tracking-wide text-white/40">Webhook URL</span>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none placeholder:text-white/25 focus:border-amber-300/40"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-white/40">Format</span>
            <select
              value={webhookKind}
              onChange={(e) => setWebhookKind(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none focus:border-amber-300/40"
            >
              <option value="generic">Generic JSON</option>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              disabled={!webhookUrl || sending}
              onClick={() => void sendTest()}
              className="w-full rounded-lg border border-sky-300/40 bg-sky-300/10 px-3 py-1.5 text-[12px] text-sky-200 transition hover:bg-sky-300/20 disabled:opacity-40"
            >
              {sending ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> : "Send test"}
            </button>
          </div>
        </div>
        {webhookKind === "telegram" && (
          <label className="mt-3 block sm:max-w-xs">
            <span className="text-[11px] uppercase tracking-wide text-white/40">
              Chat ID (Telegram)
            </span>
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none placeholder:text-white/25 focus:border-amber-300/40"
            />
          </label>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-white/35">
          Dispatched from the engine, not the browser, so the URL never lands in
          page source and Discord&apos;s CORS rules do not block it. Alerts only
          fire while this tab is open — there is no server-side scanner running
          when you are away.
        </p>
      </Card>

      {/* ------------------------- kill switch ------------------------- */}
      <Card className="border-rose-300/25 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Siren className="h-4 w-4 text-rose-300" />
          <h2 className="text-sm font-semibold text-white">Kill switch</h2>
          <button
            type="button"
            onClick={() => void refreshPositions()}
            className="ml-auto rounded-lg border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/5"
          >
            Refresh
          </button>
        </div>

        {positionsProblem && (
          <p className="mb-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-[12px] leading-relaxed text-amber-200">
            {positionsProblem}
            {positionsMode === "halted" &&
              " Open positions could not be confirmed, so CLOSE ALL is disabled — it cannot prove it flattened the account."}
          </p>
        )}

        {positions.length > 0 && (
          <div className="mb-3 overflow-hidden rounded-lg border border-white/10">
            <table className="w-full text-[12px]">
              <thead className="bg-white/5 text-left text-[11px] uppercase tracking-wide text-white/40">
                <tr>
                  <th className="px-3 py-1.5">Instrument</th>
                  <th className="px-3 py-1.5">Side</th>
                  <th className="px-3 py-1.5">Volume</th>
                  <th className="px-3 py-1.5">Open</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.position_id} className="border-t border-white/5">
                    <td className="px-3 py-1.5 text-white/80">{p.instrument}</td>
                    <td
                      className={cx(
                        "px-3 py-1.5",
                        p.side === "buy" ? "text-emerald-300" : "text-rose-300",
                      )}
                    >
                      {p.side.toUpperCase()}
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-white/70">{p.volume ?? "—"}</td>
                    <td className="px-3 py-1.5 text-white/40">{p.position_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {positions.length === 0 && !positionsProblem && (
          <p className="mb-3 text-[12px] text-white/45">No open positions reported.</p>
        )}

        <button
          type="button"
          disabled={closing || positions.length === 0 || positionsMode === "halted"}
          onClick={armKill}
          onDoubleClick={() => void closeAll()}
          className={cx(
            "w-full rounded-lg border px-4 py-2.5 text-[13px] font-semibold transition disabled:opacity-40",
            killArm === 1
              ? "border-rose-400 bg-rose-500/30 text-white"
              : "border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20",
          )}
        >
          {closing ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Closing…
            </span>
          ) : killArm === 1 ? (
            `Click again within ${KILL_HOLD_SECONDS}s to confirm CLOSE ALL`
          ) : (
            "CLOSE ALL & DISABLE AUTO-TRADE"
          )}
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          Closes every position in full and turns auto-trade off. Exness
          acknowledges first and settles asynchronously, so a success here means
          accepted, not filled — confirm on your broker platform before assuming
          you are flat.
        </p>
      </Card>

      {/* --------------------------- alert log -------------------------- */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-white">Recent alerts</h2>
        {alerts.length === 0 ? (
          <p className="text-[12px] text-white/45">
            Nothing has cleared {threshold}% since this page opened.
          </p>
        ) : (
          <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-[12px]"
              >
                <span className="text-white/40">
                  {new Date(a.at).toLocaleTimeString()}
                </span>
                <span className="font-medium text-white/85">{a.symbol}</span>
                <span
                  className={cx(
                    "font-semibold",
                    a.direction === "buy" ? "text-emerald-300" : "text-rose-300",
                  )}
                >
                  {a.direction.toUpperCase()}
                </span>
                <span className="tabular-nums text-white/60">{a.total.toFixed(0)}%</span>
                {a.levels && (
                  <span className="text-white/40">
                    {a.levels.entry} → {a.levels.tp1} / SL {a.levels.sl}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
