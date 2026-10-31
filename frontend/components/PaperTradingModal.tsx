"use client";

/**
 * Paper-trading console.
 *
 * A paper session replays the strategy's signals through the real Prop-Firm
 * Shield without sending an order anywhere: every fill, every block and the
 * resulting drawdown envelope are logged to `trade_logs` exactly as a live run
 * would be.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Clock,
  DollarSign,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import { fmt } from "@/lib/format";
import type { PaperStats, Strategy, TradeLog } from "@/lib/types";
import { Badge, Modal, ProgressBar, Spinner, Stat, Toggle, cx } from "./ui";

interface Props {
  strategy: Strategy;
  stats: PaperStats | null;
  busy: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onResetSession: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-white/40">{label}</span>
      <span className="font-mono text-xs text-white/85">{value}</span>
    </div>
  );
}

export default function PaperTradingModal({
  strategy,
  stats,
  busy,
  onClose,
  onToggle,
  onResetSession,
}: Props) {
  const [tab, setTab] = useState<"overview" | "parameters" | "fills">("overview");
  const running = Boolean(stats?.running);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const recent = useMemo(() => (stats?.recent ?? []).slice(0, 40), [stats]);
  const parameters = stats?.parameters ?? strategy.parameters ?? {};

  const netTone = (stats?.net_pnl ?? 0) >= 0 ? "text-mint-300" : "text-rose-300";
  const dailyUsed = stats?.daily_drawdown_pct ?? 0;
  const totalUsed = stats?.total_drawdown_pct ?? 0;

  return (
    <Modal open onClose={onClose} title={`Paper trading · ${strategy.name}`} width="max-w-3xl">
      <div className="space-y-4">
        {/* ------------------------------ header ------------------------------ */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center gap-3">
            <div
              className={cx(
                "rounded-lg border p-2",
                running
                  ? "border-mint-400/25 bg-mint-400/10"
                  : "border-white/10 bg-white/[0.03]",
              )}
            >
              {running ? (
                <Activity className="h-4 w-4 animate-pulse text-mint-300" />
              ) : (
                <Pause className="h-4 w-4 text-white/40" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  {running ? "Session running" : "Session stopped"}
                </span>
                <Badge tone={running ? "mint" : "neutral"}>
                  {strategy.symbol} · {strategy.timeframe}
                </Badge>
                {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
              </div>
              <p className="mt-0.5 text-[11px] text-white/45">
                Signals replay through the Prop-Firm Shield — nothing is sent to a broker.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Toggle
              checked={running}
              onChange={onToggle}
              label={running ? "Paper ON" : "Paper OFF"}
            />
            <button
              type="button"
              onClick={onResetSession}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-white/55 transition hover:border-white/25 hover:text-white/85"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset session
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 p-1.5 text-white/45 transition hover:text-white/80"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ------------------------------ tabs ------------------------------- */}
        <div className="flex gap-1 border-b border-white/8">
          {(["overview", "parameters", "fills"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cx(
                "relative px-3 py-2 text-xs font-medium capitalize transition",
                tab === key
                  ? "text-white after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-teal-400"
                  : "text-white/40 hover:text-white/70",
              )}
            >
              {key}
              {key === "fills" && recent.length ? (
                <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60">
                  {recent.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* ---------------------------- overview ----------------------------- */}
        {tab === "overview" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Net P&L" value={`${fmt.signed(stats?.net_pnl ?? 0, 0)}`} tone={running ? "mint" : "neutral"} />
              <Stat label="Return" value={fmt.pct(stats?.net_pnl_pct ?? 0, 2)} />
              <Stat label="Trades" value={fmt.int(stats?.trades ?? 0)} />
              <Stat
                label="Win rate"
                value={
                  stats?.trades
                    ? fmt.pct(((stats.wins ?? 0) / stats.trades) * 100, 0)
                    : "—"
                }
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
                <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Prop-Firm Shield
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/45">Daily drawdown</span>
                      <span className="font-mono text-white/80">
                        {dailyUsed.toFixed(2)}% / 3.50%
                      </span>
                    </div>
                    <ProgressBar
                      value={(dailyUsed / 3.5) * 100}
                      tone={dailyUsed / 3.5 > 0.7 ? "rose" : dailyUsed / 3.5 > 0.4 ? "amber" : "mint"}
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/45">Total drawdown</span>
                      <span className="font-mono text-white/80">
                        {totalUsed.toFixed(2)}% / 5.00%
                      </span>
                    </div>
                    <ProgressBar
                      value={(totalUsed / 5) * 100}
                      tone={totalUsed / 5 > 0.7 ? "rose" : totalUsed / 5 > 0.4 ? "amber" : "mint"}
                    />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
                    <div className="text-white/40">Blocked</div>
                    <div className="font-mono text-amber-200">{fmt.int(stats?.blocked ?? 0)}</div>
                  </div>
                  <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
                    <div className="text-white/40">Open</div>
                    <div className="font-mono text-white/85">{fmt.int(stats?.open ?? 0)}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
                <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
                  <DollarSign className="h-3.5 w-3.5" />
                  Account
                </div>
                <Row label="Equity" value={fmt.money(stats?.equity ?? 10000)} />
                <Row label="Peak equity" value={fmt.money(stats?.peak_equity ?? 10000)} />
                <Row label="Day P&L" value={fmt.pct(stats?.day_pnl_pct ?? 0, 2)} />
                <Row label="Total P&L" value={fmt.pct(stats?.total_pnl_pct ?? 0, 2)} />
                <Row label="Expectancy" value={fmt.r(stats?.expectancy_r ?? 0)} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-[11px] text-white/45">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                last signal: {stats?.last_signal ?? "—"}
              </span>
              <span className="ml-auto">updated {fmt.time(stats?.last_update)}</span>
            </div>
          </div>
        ) : null}

        {/* --------------------------- parameters ---------------------------- */}
        {tab === "parameters" ? (
          <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-white/40">
              Parameters in use ({Object.keys(parameters).length})
            </div>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {Object.entries(parameters).map(([key, value]) => (
                <Row key={key} label={key} value={String(value)} />
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-white/35">
              These are the live parameters from the active version. Roll back or apply another
              version in the lineage view and the next signal adopts it immediately.
            </p>
          </div>
        ) : null}

        {/* ------------------------------ fills ------------------------------ */}
        {tab === "fills" ? (
          <div className="overflow-hidden rounded-xl border border-white/8">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
                <tr>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Exit</th>
                  <th className="px-3 py-2">R</th>
                  <th className="px-3 py-2">P&L</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((log: TradeLog) => (
                  <tr key={log.id} className="border-t border-white/5">
                    <td className="px-3 py-1.5 text-white/45">{fmt.time(log.closed_at ?? log.opened_at)}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className={cx(
                          "font-medium",
                          log.side === "buy" ? "text-mint-300" : "text-rose-300",
                        )}
                      >
                        {log.side === "buy" ? "LONG" : "SHORT"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-white/70">{fmt.num(log.entry_price, 4)}</td>
                    <td className="px-3 py-1.5 font-mono text-white/70">{fmt.num(log.exit_price ?? 0, 4)}</td>
                    <td className="px-3 py-1.5 font-mono text-white/70">{fmt.r(log.r_multiple ?? 0)}</td>
                    <td
                      className={cx(
                        "px-3 py-1.5 font-mono",
                        (log.pnl ?? 0) >= 0 ? "text-mint-300" : "text-rose-300",
                      )}
                    >
                      {fmt.signed(log.pnl ?? 0, 2)}
                    </td>
                    <td className="px-3 py-1.5">
                      {log.status === "blocked" ? (
                        <Badge tone="amber" title={log.blocked_reason ?? undefined}>
                          blocked
                        </Badge>
                      ) : (
                        <Badge tone="mint">filled</Badge>
                      )}
                    </td>
                  </tr>
                ))}
                {!recent.length ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-white/35">
                      No fills yet. Start the session and trades appear here in realtime.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {!running ? (
          <div className="flex items-start gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-[11px] text-white/40">
            {stats?.trades ? <TrendingDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>
              The session is paused. Flip <em>Paper ON</em> to resume replaying signals through the
              shield; stats are preserved between pauses.
            </span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
