"use client";

import { useState } from "react";
import { Plus, Search } from "lucide-react";

import { useAlphaForge } from "@/components/AlphaForgeProvider";
import StrategyCard from "@/components/StrategyCard";
import StrategyCreatorModal from "@/components/StrategyCreatorModal";
import StrategyDetailModal from "@/components/StrategyDetailModal";
import { EmptyState, Spinner } from "@/components/ui";

export default function StudioPage() {
  const { ready, strategies, optimizations, runBacktest, runOptimize, runAnalyze } =
    useAlphaForge();
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filtered = strategies.filter((strategy) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [strategy.name, strategy.symbol, strategy.timeframe, strategy.source_type]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Strategy Studio</h1>
          <p className="text-[12px] text-white/45">
            Transpile ideas, backtest them, then search the parameter space. Every run is stored as
            an immutable version you can roll back to.
          </p>
        </div>
        <div className="relative ml-auto w-full max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
          />
          <input
            className="input pl-9"
            placeholder="Search strategies"
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
          <Spinner /> Loading strategies…
        </div>
      ) : !filtered.length ? (
        <EmptyState
          title={strategies.length ? "No matches" : "The studio is empty"}
          detail={
            strategies.length
              ? "Try a different search term."
              : "Paste a video URL, a description, or a JSON spec to get started."
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
              onOptimize={() =>
                runOptimize(strategy, { objective: "prop_readiness", nTrials: 20, bars: 2400 })
              }
              onAnalyze={() => runAnalyze(strategy, false)}
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
