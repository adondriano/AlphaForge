"use client";

import { ShieldAlert, ShieldCheck, RotateCcw, Activity } from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import { evaluateShield } from "@/lib/engine";
import { fmt } from "@/lib/format";
import { ProgressBar, cx } from "./ui";

export default function RiskPanel() {
  const { account, settings, resetAccount } = useAlphaForge();

  const decision = evaluateShield(
    {
      maxDailyDrawdownPct: settings.MAX_DAILY_DRAWDOWN,
      maxTotalDrawdownPct: settings.MAX_TOTAL_DRAWDOWN,
      riskPerTradePct: settings.RISK_PER_TRADE_PCT,
      maxConcurrentTrades: settings.MAX_CONCURRENT_TRADES,
    },
    {
      equity: account.equity,
      dayStartEquity: account.day_start_equity,
      peakEquity: account.peak_equity,
      requestedRiskPct: settings.RISK_PER_TRADE_PCT,
      volume: 0.01,
      openPositions: account.open_positions,
    },
  );

  const dailyUse = Math.min(100, (decision.daily_drawdown_pct / settings.MAX_DAILY_DRAWDOWN) * 100);
  const totalUse = Math.min(100, (decision.total_drawdown_pct / settings.MAX_TOTAL_DRAWDOWN) * 100);
  const halted = !decision.allowed;

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {halted ? (
            <ShieldAlert size={16} className="text-forge-rose" />
          ) : (
            <ShieldCheck size={16} className="text-forge-mint" />
          )}
          <span className="text-sm font-semibold text-white">Prop-Firm Shield</span>
        </div>
        <button
          className="btn-ghost px-2 py-1 text-[11px]"
          onClick={() => resetAccount(10000)}
          title="Reset the simulated account to $10,000"
        >
          <RotateCcw size={11} /> Reset account
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cell label="Equity" value={`$${fmt.money(account.equity)}`} />
        <Cell
          label="Day P&L"
          value={fmt.pct(((account.equity / (account.day_start_equity || 1)) - 1) * 100)}
          tone={
            account.equity >= account.day_start_equity ? "text-forge-mint" : "text-forge-rose"
          }
        />
        <Cell
          label="Total P&L"
          value={fmt.pct(((account.equity / (account.starting_equity || 1)) - 1) * 100)}
          tone={
            account.equity >= account.starting_equity ? "text-forge-mint" : "text-forge-rose"
          }
        />
        <Cell label="Peak equity" value={`$${fmt.money(account.peak_equity)}`} />
      </div>

      <div className="mt-4 space-y-3">
        <Gauge
          label="Daily drawdown"
          value={decision.daily_drawdown_pct}
          limit={settings.MAX_DAILY_DRAWDOWN}
          used={dailyUse}
        />
        <Gauge
          label="Total drawdown"
          value={decision.total_drawdown_pct}
          limit={settings.MAX_TOTAL_DRAWDOWN}
          used={totalUse}
        />
      </div>

      <div
        className={cx(
          "mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]",
          halted
            ? "border-forge-rose/30 bg-forge-rose/[0.07] text-forge-rose"
            : "border-forge-mint/25 bg-forge-mint/[0.06] text-forge-mint",
        )}
      >
        <Activity size={13} className="mt-0.5 shrink-0" />
        <span>{decision.reason}</span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-white/40">
        <div>
          Risk/trade{" "}
          <span className="tabular text-white/70">{fmt.pct(settings.RISK_PER_TRADE_PCT, 2)}</span>
        </div>
        <div>
          Max open <span className="tabular text-white/70">{settings.MAX_CONCURRENT_TRADES}</span>
        </div>
        <div>
          Approved size{" "}
          <span className="tabular text-white/70">{decision.adjusted_volume.toFixed(3)}</span>
        </div>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  tone = "text-white/90",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className={cx("tabular text-[15px] font-semibold", tone)}>{value}</div>
    </div>
  );
}

function Gauge({
  label,
  value,
  limit,
  used,
}: {
  label: string;
  value: number;
  limit: number;
  used: number;
}) {
  const tone = used >= 100 ? "rose" : used >= 70 ? "amber" : "mint";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="uppercase tracking-wider text-white/40">{label}</span>
        <span className="tabular text-white/60">
          {value.toFixed(2)}% / {limit.toFixed(2)}%
        </span>
      </div>
      <ProgressBar value={used} tone={tone} />
    </div>
  );
}
