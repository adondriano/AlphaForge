"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  FlaskConical,
  Info,
  Lightbulb,
  PlayCircle,
  RotateCcw,
  Sparkles,
  Zap,
} from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import EquityChart, { EquityChartLegend } from "./EquityChart";
import LivePricePanel from "./LivePricePanel";
import OptimizationHistory from "./OptimizationHistory";
import { Badge, Modal, ProgressBar, Spinner, cx } from "./ui";
import { fmt, readinessTone } from "@/lib/format";
import { OBJECTIVES } from "@/lib/types";
import type { AnalysisReport, BacktestCurve } from "@/lib/types";

/** The in-browser engine returns a plain series; wrap it in the chart shape. */
function syntheticCurve(equity: number[]): BacktestCurve {
  let peak = equity[0] ?? 0;
  const drawdown = equity.map((value) => {
    peak = Math.max(peak, value);
    return peak ? ((peak - value) / peak) * 100 : 0;
  });
  return {
    equity,
    drawdown,
    initial_equity: equity[0] ?? 0,
    final_equity: equity[equity.length - 1] ?? 0,
    split_index: Math.floor(equity.length * 0.7),
    max_drawdown_pct: Math.max(...drawdown, 0),
    step: 1,
    bars: equity.length,
    trades: [],
  };
}

export default function StrategyDetailModal({
  open,
  strategyId,
  onClose,
}: {
  open: boolean;
  strategyId: string | null;
  onClose: () => void;
}) {
  const {
    strategies,
    optimizations,
    runBacktest,
    runOptimize,
    runAnalyze,
    rollback,
    runPaperSession,
    settings,
    engineStatus,
    lastCurves,
    mt5Status,
    connectMt5,
    mt5Busy,
  } = useAlphaForge();

  const strategy = strategies.find((item) => item.id === strategyId) ?? null;
  const versions = strategy ? optimizations[strategy.id] ?? [] : [];

  const [curve, setCurve] = useState<BacktestCurve | null>(null);
  const [loadingCurve, setLoadingCurve] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [objective, setObjective] = useState("prop_readiness");
  const [trials, setTrials] = useState(Math.min(settings.OPTIMIZER_TRIALS || 40, 40));
  const [noLlm, setNoLlm] = useState(false);

  useEffect(() => {
    if (!open || !strategy) return;
    setAnalysis(null);
    // Reuse the curve from the last run if we already have one for this id.
    if (lastCurves[strategy.id]) setCurve(lastCurves[strategy.id]);
    setLoadingCurve(true);
    runBacktest(strategy.id, { bars: 2000 })
      .then((report) => {
        if (report?.curve) setCurve(report.curve);
        else if (report?.equity_curve?.length) setCurve(syntheticCurve(report.equity_curve));
      })
      .catch(() => undefined)
      .finally(() => setLoadingCurve(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, strategy?.id]);

  const verdictTone = useMemo(() => {
    if (!analysis) return "neutral";
    if (analysis.verdict === "healthy") return "mint";
    if (analysis.verdict === "watch") return "amber";
    return "rose";
  }, [analysis]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate">{strategy?.name ?? "Strategy"}</span>
          {strategy ? (
            <>
              <Badge tone="neutral">{strategy.symbol}</Badge>
              <Badge tone="neutral">{strategy.timeframe}</Badge>
              <Badge tone="amber">{strategy.status}</Badge>
            </>
          ) : null}
        </div>
      }
    >
      {!strategy ? (
        <div className="py-10 text-center text-sm text-white/45">Strategy not found.</div>
      ) : (
        <div className="space-y-5">
          {/* ------------------------------------------------ metrics */}
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="panel p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-white/40">
                  Equity &amp; drawdown · last backtest
                </span>
                {loadingCurve ? <Spinner /> : null}
              </div>
              {curve ? (
                <>
                  <EquityChart
                    curve={curve}
                    drawdownLimitPct={settings.MAX_TOTAL_DRAWDOWN}
                    height={240}
                  />
                  <EquityChartLegend curve={curve} />
                </>
              ) : (
                <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-white/40">
                  {loadingCurve ? "Running backtest…" : "No backtest run yet."}
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniMetric label="Win rate" value={fmt.pct(strategy.win_rate)} />
                <MiniMetric label="Profit factor" value={fmt.num(strategy.profit_factor)} />
                <MiniMetric label="Expectancy" value={fmt.r(strategy.expectancy_r)} />
                <MiniMetric label="Max drawdown" value={fmt.pct(strategy.max_drawdown_pct)} />
                <MiniMetric label="Net return" value={fmt.pct(strategy.net_return_pct)} />
                <MiniMetric label="Sharpe" value={fmt.num(strategy.sharpe)} />
                <MiniMetric label="Trades" value={fmt.int(strategy.total_trades)} />
                <MiniMetric label="Trades / wk" value={fmt.num(strategy.est_trades_per_week)} />
              </div>
            </div>

            <div className="panel space-y-3 p-4">
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-white/40">
                  Prop-firm readiness
                </div>
                <div
                  className={cx(
                    "tabular text-3xl font-semibold",
                    readinessTone(strategy.prop_readiness) === "mint"
                      ? "text-forge-mint"
                      : readinessTone(strategy.prop_readiness) === "amber"
                        ? "text-forge-amber"
                        : "text-forge-rose",
                  )}
                >
                  {fmt.pct(strategy.prop_readiness, 0)}
                </div>
                <div className="mt-2">
                  <ProgressBar
                    value={strategy.prop_readiness}
                    tone={readinessTone(strategy.prop_readiness)}
                  />
                </div>
              </div>

              <div className="space-y-1.5 border-t border-white/[0.06] pt-3 text-[12px]">
                <Row label="Risk per trade" value={fmt.pct(strategy.risk_profile?.risk_per_trade_pct ?? 0.5, 2)} />
                <Row label="R multiple" value={fmt.num(strategy.risk_profile?.rr_ratio ?? 2, 1)} />
                <Row label="Session" value={strategy.risk_profile?.session ?? "all_day"} />
                <Row
                  label="Daily DD cap"
                  value={fmt.pct(strategy.risk_profile?.max_daily_drawdown_pct ?? 3.5, 2)}
                />
                <Row
                  label="Total DD cap"
                  value={fmt.pct(strategy.risk_profile?.max_total_drawdown_pct ?? 5, 2)}
                />
              </div>

              <button
                className="btn-ghost w-full text-[12px]"
                onClick={async () => {
                  const result = await runPaperSession(strategy, 8);
                  if (result) {
                    const report = await runBacktest(strategy.id, { bars: 2000 });
                    if (report?.curve) setCurve(report.curve);
                  }
                }}
              >
                <PlayCircle size={14} /> Run shielded paper session
              </button>
            </div>
          </div>

          {/* ------------------------------------------------ live market */}
          <LivePricePanel
            symbol={strategy.symbol}
            timeframe={strategy.timeframe}
            status={mt5Status}
            onConnect={mt5Busy ? undefined : () => void connectMt5()}
          />

          {/* ------------------------------------------------ analyzer */}
          <div className="panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Brain size={15} className="text-forge-violet" />
                <span className="text-sm font-semibold text-white">On-demand Analyst</span>
                <Badge tone="neutral">
                  {engineStatus.mode === "python"
                    ? "Python diagnostic engine"
                    : "In-browser diagnostic engine"}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-white/50">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-forge-cyan"
                    checked={noLlm}
                    onChange={(event) => setNoLlm(event.target.checked)}
                  />
                  No-LLM mode
                </label>
                <button
                  className="btn-primary px-3 py-1.5 text-[12px]"
                  disabled={analyzing}
                  onClick={async () => {
                    setAnalyzing(true);
                    try {
                      setAnalysis(await runAnalyze(strategy, noLlm));
                    } finally {
                      setAnalyzing(false);
                    }
                  }}
                >
                  {analyzing ? <Spinner /> : <Brain size={14} />}
                  Analyze
                </button>
              </div>
            </div>

            {!analysis ? (
              <p className="text-[12px] leading-relaxed text-white/40">
                Runs the deterministic statistical diagnostic engine over the current parameters:
                sample size, break-even win rate, profit factor, drawdown vs your prop-firm caps,
                losing-streak survivability, walk-forward retention and expectancy decay. An LLM is
                layered on top only when a provider is configured and No-LLM mode is off.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    className={cx(
                      "tabular text-2xl font-bold",
                      verdictTone === "mint"
                        ? "text-forge-mint"
                        : verdictTone === "amber"
                          ? "text-forge-amber"
                          : "text-forge-rose",
                    )}
                  >
                    {analysis.score}/100
                  </div>
                  <Badge tone={verdictTone === "neutral" ? "neutral" : verdictTone}>
                    {analysis.verdict}
                  </Badge>
                  <span className="text-[12px] text-white/45">{analysis.engine_label}</span>
                </div>
                <p className="text-[12px] leading-relaxed text-white/60">{analysis.summary}</p>

                {analysis.positives.length ? (
                  <ul className="space-y-1">
                    {analysis.positives.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-[12px] text-forge-mint">
                        <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="grid gap-2 lg:grid-cols-2">
                  {analysis.findings.map((finding) => (
                    <div
                      key={finding.id}
                      className={cx(
                        "rounded-lg border px-3 py-2",
                        finding.severity === "critical"
                          ? "border-forge-rose/25 bg-forge-rose/[0.06]"
                          : finding.severity === "warning"
                            ? "border-forge-amber/25 bg-forge-amber/[0.06]"
                            : "border-white/[0.07] bg-white/[0.02]",
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-white">
                        {finding.severity === "critical" ? (
                          <AlertTriangle size={12} className="text-forge-rose" />
                        ) : finding.severity === "warning" ? (
                          <AlertTriangle size={12} className="text-forge-amber" />
                        ) : (
                          <Info size={12} className="text-forge-cyan" />
                        )}
                        {finding.title}
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-white/50">
                        {finding.detail}
                      </p>
                    </div>
                  ))}
                  {!analysis.findings.length ? (
                    <div className="rounded-lg border border-forge-mint/25 bg-forge-mint/[0.06] px-3 py-2 text-[12px] text-forge-mint">
                      No findings — every diagnostic rule passed.
                    </div>
                  ) : null}
                </div>

                <div className="rounded-lg border border-white/[0.06] bg-ink-950/50 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-white">
                    <Lightbulb size={13} className="text-forge-amber" /> Recommendations
                  </div>
                  <ul className="space-y-1.5">
                    {analysis.recommendations.map((item) => (
                      <li key={item.title} className="text-[12px] text-white/60">
                        <span className="font-semibold text-white/80">{item.title} — </span>
                        {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="grid gap-2 text-[11px] text-white/45 sm:grid-cols-3">
                  <div>
                    Regime: <span className="text-white/70">{analysis.regime.trend}</span> · vol{" "}
                    <span className="text-white/70">{analysis.regime.volatility}</span>
                  </div>
                  <div>
                    Walk-forward:{" "}
                    <span className="text-white/70">{analysis.regime.walk_forward}</span>
                  </div>
                  <div>
                    Decay: <span className="text-white/70">{analysis.decay.state}</span>
                    {analysis.decay.ratio !== null ? ` (${analysis.decay.ratio}×)` : ""}
                  </div>
                </div>

                {analysis.llm?.sections ? (
                  <div className="rounded-lg border border-forge-violet/25 bg-forge-violet/[0.06] p-3">
                    <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-forge-violet">
                      <Zap size={13} /> {analysis.llm.engine} · {analysis.llm.sections.headline}
                    </div>
                    <p className="whitespace-pre-line text-[12px] leading-relaxed text-white/60">
                      {analysis.llm.sections.narrative}
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* ------------------------------------------------ lineage */}
          <div className="panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FlaskConical size={15} className="text-forge-cyan" />
                <span className="text-sm font-semibold text-white">Parameter lineage</span>
                <span className="text-[11px] text-white/35">
                  Git for strategies · {versions.length} version(s)
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-auto py-1.5 text-[12px]"
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                >
                  {OBJECTIVES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-[11px] text-white/45">
                  trials
                  <input
                    type="range"
                    min={5}
                    max={120}
                    step={5}
                    value={trials}
                    onChange={(event) => setTrials(Number(event.target.value))}
                    className="w-24"
                  />
                  <span className="tabular w-7 text-white/70">{trials}</span>
                </label>
                <button
                  className="btn-primary px-3 py-1.5 text-[12px]"
                  disabled={optimizing}
                  onClick={async () => {
                    setOptimizing(true);
                    try {
                      await runOptimize(strategy, { objective, nTrials: trials, bars: 2400 });
                      const report = await runBacktest(strategy.id, { bars: 2000 });
                      if (report?.curve) setCurve(report.curve);
                    } finally {
                      setOptimizing(false);
                    }
                  }}
                >
                  {optimizing ? <Spinner /> : <Sparkles size={14} />}
                  Optimize
                </button>
              </div>
            </div>

            <OptimizationHistory
              versions={versions}
              activeId={strategy.active_optimization_id}
              busyId={busyVersion}
              onRollback={async (version) => {
                setBusyVersion(version.id);
                try {
                  await rollback(strategy, version);
                  const report = await runBacktest(strategy.id, { bars: 2000 });
                  if (report?.curve) setCurve(report.curve);
                  setAnalysis(null);
                } finally {
                  setBusyVersion(null);
                }
              }}
            />
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/35">
              <RotateCcw size={11} /> Rolling back restores the stored parameters and metrics for
              that version and re-points the strategy at it.
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className="tabular text-[14px] font-semibold text-white/90">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/40">{label}</span>
      <span className="tabular font-medium text-white/80">{value}</span>
    </div>
  );
}
