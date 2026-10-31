"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  Percent,
  Plus,
  Search,
  Target,
  TrendingUp,
} from "lucide-react";

import { useAlphaForge } from "@/components/AlphaForgeProvider";
import RiskPanel from "@/components/RiskPanel";
import StrategyCard from "@/components/StrategyCard";
import StrategyCreatorModal from "@/components/StrategyCreatorModal";
import StrategyDetailModal from "@/components/StrategyDetailModal";
import TradeTicker from "@/components/TradeTicker";
import { EmptyState, Spinner, Stat, Toggle, cx } from "@/components/ui";
import { fmt, readinessTone } from "@/lib/format";
import type { Strategy } from "@/lib/types";

export default function DashboardPage() {
  const {
    ready,
    strategies,
    optimizations,
    runBacktest,
    runOptimize,
    runAnalyze,
    toggleAutonomous,
    notify,
  } = useAlphaForge();

  const [creatorOpen, setCreatorOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyAll, setBusyAll] = useState(false);

  const totals = useMemo(() => {
    const weightedWin = strategies.reduce(
      (sum, strategy) => sum + strategy.win_rate * strategy.total_trades,
      0,
    );
    const totalTrades = strategies.reduce((sum, strategy) => sum + strategy.total_trades, 0);
    const backtestCount = strategies.filter((strategy) => strategy.total_trades > 0).length;
    const optimizationCount = Object.values(optimizations).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    const readiness = strategies.length
      ? strategies.reduce((sum, strategy) => sum + strategy.prop_readiness, 0) / strategies.length
      : 0;
    const tradesPerWeek = strategies.reduce(
      (sum, strategy) => sum + strategy.est_trades_per_week,
      0,
    );
    const autonomousCount = strategies.filter((strategy) => strategy.autonomous).length;
    return {
      winRate: totalTrades ? weightedWin / totalTrades : 0,
      totalTrades,
      backtestCount,
      optimizationCount,
      readiness,
      tradesPerWeek,
      autonomousCount,
    };
  }, [strategies, optimizations]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return strategies;
    return strategies.filter((strategy) =>
      [strategy.name, strategy.symbol, strategy.timeframe, strategy.status]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [strategies, query]);

  const armAll = async (enabled: boolean) => {
    setBusyAll(true);
    try {
      for (const strategy of strategies) {
        if (strategy.autonomous !== enabled) await toggleAutonomous(strategy, enabled);
      }
      notify({
        kind: "info",
        title: enabled ? "All strategies armed" : "All strategies disarmed",
        detail: enabled
          ? "Every strategy will route signals through the Prop-Firm Shield."
          : "Signals are logged but not executed.",
      });
    } finally {
      setBusyAll(false);
    }
  };

  const optimizeStrategy = async (strategy: Strategy) => {
    await runOptimize(strategy, { objective: "prop_readiness", nTrials: 20, bars: 2400 });
  };

  const analyzeStrategy = async (strategy: Strategy) => {
    const report = await runAnalyze(strategy, false);
    if (report) {
      notify({
        kind: report.verdict === "healthy" ? "success" : "info",
        title: `${strategy.name} · ${report.verdict} (${report.score}/100)`,
        detail: report.summary.split("·").slice(-3).join("·").trim(),
      });
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Stat
          label="Win rate"
          value={fmt.pct(totals.winRate)}
          hint="trade-weighted across strategies"
          tone="cyan"
          icon={<Target size={14} />}
        />
        <Stat
          label="Total trades"
          value={fmt.int(totals.totalTrades)}
          hint={`${strategies.length} strategies tracked`}
          icon={<Activity size={14} />}
        />
        <Stat
          label="Backtest count"
          value={fmt.int(totals.backtestCount)}
          hint={`${totals.optimizationCount} parameter versions`}
          tone="violet"
          icon={<BarChart3 size={14} />}
        />
        <Stat
          label="Prop-firm readiness"
          value={fmt.pct(totals.readiness, 0)}
          hint="average across strategies"
          tone={readinessTone(totals.readiness)}
          icon={<Percent size={14} />}
        />
        <Stat
          label="Est. trades / wk"
          value={fmt.num(totals.tradesPerWeek)}
          hint="forward frequency estimate"
          tone="amber"
          icon={<TrendingUp size={14} />}
        />
        <div className="panel flex flex-col justify-between p-4">
          <div className="flex items-start justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
              Autonomous
            </span>
            <Bot
              size={14}
              className={totals.autonomousCount ? "text-forge-mint" : "text-white/30"}
            />
          </div>
          <div className="mt-2 flex items-end justify-between">
            <div>
              <div className="tabular text-2xl font-semibold text-white">
                {totals.autonomousCount}
                <span className="text-base text-white/35">/{strategies.length}</span>
              </div>
              <div className="text-[11px] text-white/40">armed for execution</div>
            </div>
            <Toggle
              checked={totals.autonomousCount > 0 && totals.autonomousCount === strategies.length}
              disabled={busyAll || !strategies.length}
              onChange={(value) => void armAll(value)}
              label="Arm every strategy"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        <RiskPanel />
        <TradeTicker />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-white">Strategy fleet</h2>
        <div className="relative ml-auto w-full max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
          />
          <input
            className="input pl-9"
            placeholder="Filter by name, symbol or status"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="btn-primary" onClick={() => setCreatorOpen(true)}>
          <Plus size={15} /> New strategy
        </button>
      </div>

      {!ready ? (
        <div className="panel flex items-center justify-center gap-2 py-16 text-sm text-white/45">
          <Spinner /> Loading the forge…
        </div>
      ) : !filtered.length ? (
        <EmptyState
          title={strategies.length ? "No strategies match that filter" : "No strategies yet"}
          detail={
            strategies.length
              ? "Try a different search term."
              : "Forge your first strategy from a YouTube/TikTok tutorial, a plain-text description, or a hand written JSON spec."
          }
          action={
            <button className="btn-primary" onClick={() => setCreatorOpen(true)}>
              <Plus size={15} /> New strategy
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((strategy) => (
            <StrategyCard
              key={strategy.id}
              strategy={strategy}
              versionCount={(optimizations[strategy.id] ?? []).length}
              onOpen={() => setDetailId(strategy.id)}
              onBacktest={() => runBacktest(strategy.id, { bars: 2400 })}
              onOptimize={() => optimizeStrategy(strategy)}
              onAnalyze={() => analyzeStrategy(strategy)}
            />
          ))}
        </div>
      )}

      <StrategyCreatorModal open={creatorOpen} onClose={() => setCreatorOpen(false)} />
      <StrategyDetailModal
        open={Boolean(detailId)}
        strategyId={detailId}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}
