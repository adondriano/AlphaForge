"use client";

import { ArrowDownRight, ArrowUpRight, Check, GitBranch, History, Minus, RotateCcw } from "lucide-react";

import type { Metrics, Optimization } from "@/lib/types";
import { fmt } from "@/lib/format";
import { Badge, Spinner, cx } from "./ui";
import { useState } from "react";

const DIFF_METRICS: {
  key: keyof Metrics;
  label: string;
  format: (value: number) => string;
  higherIsBetter: boolean;
}[] = [
  { key: "win_rate", label: "Win rate", format: (v) => fmt.pct(v, 1), higherIsBetter: true },
  { key: "profit_factor", label: "Profit factor", format: (v) => fmt.num(v), higherIsBetter: true },
  { key: "expectancy_r", label: "Expectancy", format: (v) => fmt.r(v), higherIsBetter: true },
  { key: "net_return_pct", label: "Net return", format: (v) => fmt.pct(v), higherIsBetter: true },
  { key: "max_drawdown_pct", label: "Max DD", format: (v) => fmt.pct(v), higherIsBetter: false },
  { key: "sharpe", label: "Sharpe", format: (v) => fmt.num(v), higherIsBetter: true },
  { key: "prop_readiness", label: "Readiness", format: (v) => fmt.pct(v, 0), higherIsBetter: true },
];

export default function OptimizationHistory({
  versions,
  activeId,
  onRollback,
  busyId,
}: {
  versions: Optimization[];
  activeId: string | null;
  onRollback: (optimization: Optimization) => void | Promise<void>;
  busyId?: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const active = versions.find((version) => version.id === activeId) ?? null;

  if (!versions.length) {
    return (
      <div className="panel flex items-center gap-2 px-4 py-6 text-sm text-white/40">
        <History size={14} /> No parameter versions yet — run an optimisation to create one.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {[...versions]
        .sort((a, b) => b.version - a.version)
        .map((version) => {
          const isActive = version.id === activeId;
          const isOpen = expanded === version.id;
          return (
            <div
              key={version.id}
              className={cx(
                "panel px-3 py-2.5 transition",
                isActive && "border-forge-amber/35 bg-forge-amber/[0.04]",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular inline-flex items-center gap-1.5 text-[13px] font-semibold text-white">
                  <GitBranch size={13} className="text-white/40" />
                  v{version.version}
                </span>
                <span className="truncate text-[12px] text-white/55">{version.label}</span>
                {version.is_baseline ? <Badge tone="neutral">baseline</Badge> : null}
                {isActive ? <Badge tone="amber">active</Badge> : null}
                <Badge tone="cyan">{version.engine}</Badge>
                {version.n_trials ? <Badge tone="violet">{version.n_trials} trials</Badge> : null}

                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    className="btn-ghost px-2 py-1 text-[11px]"
                    onClick={() => setExpanded(isOpen ? null : version.id)}
                  >
                    {isOpen ? "Hide diff" : "Diff"}
                  </button>
                  {isActive ? (
                    <span className="chip border-forge-mint/25 bg-forge-mint/10 text-forge-mint">
                      <Check size={11} /> applied
                    </span>
                  ) : (
                    <button
                      className="btn-ghost px-2 py-1 text-[11px]"
                      disabled={busyId === version.id}
                      onClick={() => void onRollback(version)}
                    >
                      {busyId === version.id ? <Spinner /> : <RotateCcw size={11} />}
                      Rollback
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {DIFF_METRICS.map((metric) => {
                  const value = Number(version.metrics?.[metric.key] ?? 0);
                  const base = active && !isActive ? Number(active.metrics?.[metric.key] ?? 0) : null;
                  const delta = base === null ? null : value - base;
                  const better = delta === null ? null : delta * (metric.higherIsBetter ? 1 : -1) > 0.0001;
                  const worse = delta === null ? null : delta * (metric.higherIsBetter ? 1 : -1) < -0.0001;
                  return (
                    <div key={String(metric.key)}>
                      <div className="text-[10px] uppercase tracking-wider text-white/35">
                        {metric.label}
                      </div>
                      <div className="tabular text-[13px] font-semibold text-white/90">
                        {metric.format(value)}
                      </div>
                      {delta !== null && Math.abs(delta) > 1e-9 ? (
                        <div
                          className={cx(
                            "flex items-center gap-0.5 text-[10px]",
                            better ? "text-forge-mint" : worse ? "text-forge-rose" : "text-white/35",
                          )}
                        >
                          {better ? (
                            <ArrowUpRight size={10} />
                          ) : worse ? (
                            <ArrowDownRight size={10} />
                          ) : (
                            <Minus size={10} />
                          )}
                          {metric.format(Math.abs(delta))}
                        </div>
                      ) : (
                        <div className="text-[10px] text-white/20">
                          {isActive ? "current" : "—"}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {isOpen ? (
                <div className="mt-3 grid gap-3 border-t border-white/[0.06] pt-3 lg:grid-cols-2">
                  <div>
                    <div className="label">Parameters</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {Object.entries(version.parameters ?? {}).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between rounded border border-white/[0.05] bg-ink-950/50 px-2 py-1 text-[11px]"
                        >
                          <span className="text-white/45">{key}</span>
                          <span className="tabular font-mono text-white/80">
                            {typeof value === "number" ? value.toFixed(value % 1 === 0 ? 0 : 3) : value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="label">Notes</div>
                    <p className="rounded border border-white/[0.05] bg-ink-950/50 px-2 py-1.5 text-[11px] leading-relaxed text-white/50">
                      {version.notes || "—"}
                    </p>
                    <div className="mt-2 text-[11px] text-white/30">
                      Objective: {version.objective_name} · committed{" "}
                      {version.created_at ? new Date(version.created_at).toLocaleString() : "—"}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
    </div>
  );
}
