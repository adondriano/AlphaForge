"use client";

import { ArrowDownLeft, ArrowUpRight, Ban, Radio } from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import { Badge, EmptyState, cx } from "./ui";
import { fmt } from "@/lib/format";

export default function TradeTicker({ limit = 14 }: { limit?: number }) {
  const { tradeLogs, strategies, storeMode, clearTrades } = useAlphaForge();
  const nameFor = (id: string | null) =>
    strategies.find((strategy) => strategy.id === id)?.name ?? "Unknown";

  return (
    <div className="panel flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio
            size={15}
            className={cx("animate-pulseline", storeMode === "supabase" ? "text-forge-mint" : "text-white/40")}
          />
          <span className="text-sm font-semibold text-white">Execution feed</span>
          <Badge tone={storeMode === "supabase" ? "mint" : "neutral"}>
            {storeMode === "supabase" ? "realtime" : "local"}
          </Badge>
        </div>
        {tradeLogs.length ? (
          <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => void clearTrades()}>
            Clear
          </button>
        ) : null}
      </div>

      {!tradeLogs.length ? (
        <EmptyState
          title="No executions yet"
          detail="Run a shielded paper session from a strategy's lineage view and fills stream in here over Supabase Realtime."
        />
      ) : (
        <div className="-mr-1 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
          {tradeLogs.slice(0, limit).map((trade) => {
            const blocked = trade.status === "blocked";
            const win = (trade.pnl ?? 0) > 0;
            return (
              <div
                key={trade.id}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg border px-2.5 py-2",
                  blocked
                    ? "border-forge-rose/25 bg-forge-rose/[0.05]"
                    : "border-white/[0.05] bg-white/[0.02]",
                )}
              >
                <span
                  className={cx(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-md",
                    blocked
                      ? "bg-forge-rose/15 text-forge-rose"
                      : trade.side === "buy"
                        ? "bg-forge-mint/15 text-forge-mint"
                        : "bg-forge-cyan/15 text-forge-cyan",
                  )}
                >
                  {blocked ? (
                    <Ban size={13} />
                  ) : trade.side === "buy" ? (
                    <ArrowUpRight size={13} />
                  ) : (
                    <ArrowDownLeft size={13} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12px]">
                    <span className="font-semibold text-white/85">{trade.symbol}</span>
                    <span className="text-white/30">·</span>
                    <span className="truncate text-white/45">{nameFor(trade.strategy_id)}</span>
                  </div>
                  <div className="truncate text-[11px] text-white/35">
                    {blocked ? trade.blocked_reason : `${trade.mode} · ${fmt.time(trade.opened_at)}`}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cx(
                      "tabular text-[13px] font-semibold",
                      blocked
                        ? "text-forge-rose"
                        : win
                          ? "text-forge-mint"
                          : "text-forge-rose/80",
                    )}
                  >
                    {blocked ? "BLOCKED" : `${(trade.pnl ?? 0) >= 0 ? "+" : ""}$${(trade.pnl ?? 0).toFixed(2)}`}
                  </div>
                  <div className="tabular text-[11px] text-white/35">
                    {blocked ? trade.mode : fmt.r(trade.r_multiple ?? 0)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
