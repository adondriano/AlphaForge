"use client";

import { useState } from "react";
import {
  Activity,
  BarChart3,
  Brain,
  FileText,
  Gauge,
  LineChart,
  Sparkles,
  Target,
  Trash2,
  TrendingDown,
  Youtube,
} from "lucide-react";

import type { Strategy } from "@/lib/types";
import { fmt, readinessTone, statusTone } from "@/lib/format";
import { Badge, ProgressBar, Spinner, Toggle, cx } from "./ui";
import { useAlphaForge } from "./AlphaForgeProvider";

export default function StrategyCard({
  strategy,
  versionCount,
  onOpen,
  onBacktest,
  onOptimize,
  onAnalyze,
  onOpenPaper,
}: {
  strategy: Strategy;
  versionCount: number;
  onOpen: () => void;
  onBacktest: () => unknown;
  onOptimize: () => unknown;
  onAnalyze: () => unknown;
  onOpenPaper?: () => void;
}) {
  const { toggleAutonomous, togglePaperTrading, removeStrategy } = useAlphaForge();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => unknown) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const tone = readinessTone(strategy.prop_readiness);

  return (
    <div className="panel panel-hover flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            onClick={onOpen}
            className="block max-w-full truncate text-left text-[15px] font-semibold text-white hover:text-forge-amber"
            title={strategy.name}
          >
            {strategy.name}
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{strategy.symbol}</Badge>
            <Badge tone="neutral">{strategy.timeframe}</Badge>
            <Badge tone={statusTone(strategy.status)}>{strategy.status}</Badge>
            {strategy.source_type === "youtube" ? (
              <Badge tone="rose">
                <Youtube size={11} /> video
              </Badge>
            ) : null}
            {strategy.source_type === "tiktok" ? <Badge tone="cyan">tiktok</Badge> : null}
            <Badge tone="violet">v{versionCount} versions</Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/35">Autonomous</div>
            <div className="mt-1 flex justify-end">
              <Toggle
                checked={strategy.autonomous}
                onChange={(value) => void toggleAutonomous(strategy, value)}
                label={`Autonomous trading for ${strategy.name}`}
              />
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/35">Paper</div>
            <div className="mt-1 flex justify-end">
              <Toggle
                checked={Boolean(strategy.paper_trading)}
                onChange={(value) => void togglePaperTrading(strategy, value)}
                label={`Paper trading for ${strategy.name}`}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <Metric
          icon={<Target size={13} />}
          label="Win rate"
          value={fmt.pct(strategy.win_rate)}
        />
        <Metric
          icon={<BarChart3 size={13} />}
          label="Profit factor"
          value={fmt.num(strategy.profit_factor)}
          tone={strategy.profit_factor >= 1.3 ? "mint" : strategy.profit_factor >= 1 ? "amber" : "rose"}
        />
        <Metric
          icon={<Activity size={13} />}
          label="Expectancy"
          value={fmt.r(strategy.expectancy_r)}
          tone={strategy.expectancy_r >= 0.25 ? "mint" : strategy.expectancy_r > 0 ? "amber" : "rose"}
        />
        <Metric
          icon={<TrendingDown size={13} />}
          label="Max DD"
          value={fmt.pct(strategy.max_drawdown_pct)}
          tone={strategy.max_drawdown_pct <= 5 ? "mint" : "rose"}
        />
        <Metric
          icon={<LineChart size={13} />}
          label="Net return"
          value={fmt.pct(strategy.net_return_pct)}
          tone={strategy.net_return_pct >= 0 ? "mint" : "rose"}
        />
        <Metric
          icon={<Gauge size={13} />}
          label="Trades / week"
          value={fmt.num(strategy.est_trades_per_week)}
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="uppercase tracking-wider text-white/40">Prop-firm readiness</span>
          <span
            className={cx(
              "tabular font-semibold",
              tone === "mint" ? "text-forge-mint" : tone === "amber" ? "text-forge-amber" : "text-forge-rose",
            )}
          >
            {fmt.pct(strategy.prop_readiness, 0)}
          </span>
        </div>
        <ProgressBar value={strategy.prop_readiness} tone={tone} />
        <div className="mt-1.5 text-[11px] text-white/35">
          {fmt.int(strategy.total_trades)} trades · Sharpe {fmt.num(strategy.sharpe)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.05] pt-3">
        <button
          className="btn-ghost px-2.5 py-1.5 text-[12px]"
          onClick={() => run("backtest", onBacktest)}
          disabled={busy !== null}
        >
          {busy === "backtest" ? <Spinner /> : <BarChart3 size={13} />}
          Backtest
        </button>
        <button
          className="btn-ghost px-2.5 py-1.5 text-[12px]"
          onClick={() => run("optimize", onOptimize)}
          disabled={busy !== null}
        >
          {busy === "optimize" ? <Spinner /> : <Sparkles size={13} />}
          Optimize
        </button>
        <button
          className="btn-ghost px-2.5 py-1.5 text-[12px]"
          onClick={() => run("analyze", onAnalyze)}
          disabled={busy !== null}
        >
          {busy === "analyze" ? <Spinner /> : <Brain size={13} />}
          Analyze
        </button>
        {onOpenPaper ? (
          <button
            className="btn-ghost px-2.5 py-1.5 text-[12px]"
            onClick={onOpenPaper}
            title="Open the paper-trading console"
          >
            <FileText size={13} />
            Paper
          </button>
        ) : null}
        <button className="btn-ghost ml-auto px-2.5 py-1.5 text-[12px]" onClick={onOpen}>
          Lineage
        </button>
        <button
          className="btn-ghost px-2 py-1.5 text-[12px] text-forge-rose/80 hover:text-forge-rose"
          onClick={() => void removeStrategy(strategy)}
          aria-label={`Delete ${strategy.name}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "mint" | "amber" | "rose";
}) {
  const accent = {
    neutral: "text-white",
    mint: "text-forge-mint",
    amber: "text-forge-amber",
    rose: "text-forge-rose",
  }[tone];
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/35">
        {icon}
        {label}
      </div>
      <div className={cx("tabular text-[15px] font-semibold", accent)}>{value}</div>
    </div>
  );
}
