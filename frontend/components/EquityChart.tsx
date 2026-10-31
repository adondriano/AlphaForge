"use client";

/**
 * Backtest equity / drawdown chart.
 *
 * Hand-rolled SVG on purpose: the series are small (the engine downsamples to
 * ~260 points) and this keeps a charting dependency out of the bundle while
 * giving exact control over the in-sample / out-of-sample split marker, the
 * prop-firm drawdown band and the per-trade markers.
 */

import { useMemo, useState } from "react";

import { fmt } from "@/lib/format";
import type { BacktestCurve } from "@/lib/types";

const W = 720;
const H = 260;
const PAD = { top: 14, right: 14, bottom: 24, left: 52 };
const PLOT_W = W - PAD.left - PAD.right;
/** How much of the plot height the drawdown strip occupies underneath equity. */
const DD_SHARE = 0.28;

interface Props {
  curve: BacktestCurve;
  /** Drawdown limit in percent — drawn as a hard prop-firm breach line. */
  drawdownLimitPct?: number;
  height?: number;
  showTrades?: boolean;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const errors = [1, 2, 2.5, 5, 10].map((m) => ({
    m,
    err: Math.abs((span / (step * m)) - count),
  }));
  const chosen = step * errors.sort((a, b) => a.err - b.err)[0].m;
  const start = Math.ceil(min / chosen) * chosen;
  const ticks: number[] = [];
  for (let v = start; v <= max + chosen * 0.001; v += chosen) ticks.push(v);
  return ticks;
}

export default function EquityChart({
  curve,
  drawdownLimitPct,
  height = H,
  showTrades = true,
}: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const equity = curve.equity ?? [];
  const drawdown = curve.drawdown ?? [];

  const geometry = useMemo(() => {
    if (!equity.length) return null;

    const ddHeight = (height - PAD.top - PAD.bottom) * DD_SHARE;
    const eqHeight = height - PAD.top - PAD.bottom - ddHeight - 10;
    const eqTop = PAD.top;
    const ddTop = PAD.top + eqHeight + 10;

    const values = equity;
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Always keep the starting balance visible so gains/losses read honestly.
    const lo = Math.min(min, curve.initial_equity ?? min);
    const hi = Math.max(max, curve.initial_equity ?? max);
    const padY = (hi - lo) * 0.08 || Math.max(1, hi * 0.01);
    const yLo = lo - padY;
    const yHi = hi + padY;

    const ddMax = Math.max(...drawdown, drawdownLimitPct ?? 0, 0.5) * 1.05;

    const xAt = (i: number) =>
      PAD.left + (equity.length === 1 ? PLOT_W / 2 : (i / (equity.length - 1)) * PLOT_W);
    const yEq = (v: number) => eqTop + eqHeight - ((v - yLo) / (yHi - yLo || 1)) * eqHeight;
    const yDd = (v: number) => ddTop + (v / (ddMax || 1)) * ddHeight;

    const line = equity.map((v, i) => `${xAt(i).toFixed(2)},${yEq(v).toFixed(2)}`).join(" ");
    const area =
      `${PAD.left},${(eqTop + eqHeight).toFixed(2)} ` +
      line +
      ` ${(PAD.left + PLOT_W).toFixed(2)},${(eqTop + eqHeight).toFixed(2)}`;

    const ddLine = drawdown
      .map((v, i) => `${xAt(i).toFixed(2)},${yDd(v).toFixed(2)}`)
      .join(" ");
    const ddArea =
      `${PAD.left},${ddTop.toFixed(2)} ` +
      ddLine +
      ` ${(PAD.left + PLOT_W).toFixed(2)},${ddTop.toFixed(2)}`;

    const step = curve.step || 1;
    const markers = (curve.trades ?? [])
      .map((trade) => {
        const i = Math.round(trade.i / step);
        if (i < 0 || i >= equity.length) return null;
        return { x: xAt(i), y: yEq(equity[i]), win: trade.pnl > 0, trade };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    return {
      line,
      area,
      ddLine,
      ddArea,
      markers,
      xAt,
      yEq,
      yLo,
      yHi,
      eqTop,
      eqHeight,
      ddTop,
      ddHeight,
      ddMax,
      splitX: xAt(Math.max(0, Math.min(equity.length - 1, curve.split_index ?? 0))),
      baselineY: yEq(curve.initial_equity ?? equity[0]),
      ticks: niceTicks(yLo, yHi),
    };
  }, [equity, drawdown, height, curve.initial_equity, curve.split_index, curve.step, curve.trades, drawdownLimitPct]);

  if (!geometry) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-white/40">
        Run a backtest to plot the equity curve.
      </div>
    );
  }

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const plotRatio = (ratio * W - PAD.left) / PLOT_W;
    const index = Math.round(plotRatio * (equity.length - 1));
    const clamped = Math.max(0, Math.min(equity.length - 1, index));
    setHover({
      index: clamped,
      x: (geometry.xAt(clamped) / W) * rect.width,
      y: (geometry.yEq(equity[clamped]) / H) * rect.height,
    });
  };

  const hovered = hover
    ? {
        equity: equity[hover.index],
        drawdown: drawdown[hover.index] ?? 0,
        bar: Math.round(hover.index * (curve.step || 1)),
      }
    : null;

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-auto w-full select-none"
        style={{ maxHeight: height + 40 }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Backtest equity curve and drawdown"
      >
        <defs>
          <linearGradient id="af-equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(45,212,191)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="rgb(45,212,191)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="af-dd-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(244,63,94)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(244,63,94)" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* y grid + labels */}
        {geometry.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={geometry.yEq(tick)}
              y2={geometry.yEq(tick)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={geometry.yEq(tick) + 3.5}
              textAnchor="end"
              className="fill-white/40"
              style={{ fontSize: 10 }}
            >
              {fmt.compact(tick)}
            </text>
          </g>
        ))}

        {/* starting-balance baseline */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={geometry.baselineY}
          y2={geometry.baselineY}
          stroke="rgba(255,255,255,0.25)"
          strokeDasharray="4 4"
        />

        {/* in-sample / out-of-sample split */}
        <line
          x1={geometry.splitX}
          x2={geometry.splitX}
          y1={PAD.top}
          y2={geometry.ddTop + geometry.ddHeight}
          stroke="rgba(129,140,248,0.55)"
          strokeDasharray="3 3"
        />
        <text
          x={geometry.splitX + 4}
          y={PAD.top + 10}
          className="fill-indigo-300/70"
          style={{ fontSize: 9 }}
        >
          OOS →
        </text>

        {/* equity */}
        <polygon points={geometry.area} fill="url(#af-equity-fill)" />
        <polyline
          points={geometry.line}
          fill="none"
          stroke="rgb(45,212,191)"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />

        {/* trade markers */}
        {showTrades &&
          geometry.markers.map((marker, i) => (
            <circle
              key={i}
              cx={marker.x}
              cy={marker.y}
              r="2.4"
              fill={marker.win ? "rgb(52,211,153)" : "rgb(248,113,113)"}
              fillOpacity="0.85"
            />
          ))}

        {/* drawdown strip */}
        <polygon points={geometry.ddArea} fill="url(#af-dd-fill)" />
        <polyline
          points={geometry.ddLine}
          fill="none"
          stroke="rgb(244,63,94)"
          strokeWidth="1"
          strokeOpacity="0.8"
        />
        {drawdownLimitPct ? (
          <g>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={geometry.ddTop + (drawdownLimitPct / (geometry.ddMax || 1)) * geometry.ddHeight}
              y2={geometry.ddTop + (drawdownLimitPct / (geometry.ddMax || 1)) * geometry.ddHeight}
              stroke="rgb(244,63,94)"
              strokeDasharray="2 3"
              strokeOpacity="0.7"
            />
            <text
              x={PAD.left + PLOT_W - 2}
              y={geometry.ddTop + (drawdownLimitPct / (geometry.ddMax || 1)) * geometry.ddHeight - 3}
              textAnchor="end"
              className="fill-rose-300/70"
              style={{ fontSize: 9 }}
            >
              {fmt.pct(drawdownLimitPct)} cap
            </text>
          </g>
        ) : null}

        {/* x axis */}
        <text x={PAD.left} y={H - 6} className="fill-white/30" style={{ fontSize: 9 }}>
          bar 0
        </text>
        <text
          x={PAD.left + PLOT_W}
          y={H - 6}
          textAnchor="end"
          className="fill-white/30"
          style={{ fontSize: 9 }}
        >
          bar {curve.bars ?? equity.length}
        </text>

        {/* crosshair */}
        {hover ? (
          <g>
            <line
              x1={geometry.xAt(hover.index)}
              x2={geometry.xAt(hover.index)}
              y1={PAD.top}
              y2={geometry.ddTop + geometry.ddHeight}
              stroke="rgba(255,255,255,0.35)"
              strokeWidth="1"
            />
            <circle
              cx={geometry.xAt(hover.index)}
              cy={geometry.yEq(equity[hover.index])}
              r="3.5"
              fill="rgb(45,212,191)"
              stroke="rgb(6,7,12)"
              strokeWidth="1.5"
            />
          </g>
        ) : null}
      </svg>

      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-[#0b0d15]/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur"
          style={{ left: hover!.x, top: Math.max(0, hover!.y - 8) }}
        >
          <div className="font-semibold text-white">{fmt.money(hovered.equity)}</div>
          <div className="text-white/50">bar {hovered.bar}</div>
          <div className="text-rose-300">-{hovered.drawdown.toFixed(2)}% dd</div>
        </div>
      ) : null}
    </div>
  );
}

/** Small legend + summary row that sits under the chart. */
export function EquityChartLegend({ curve }: { curve: BacktestCurve }) {
  const wins = (curve.trades ?? []).filter((t) => t.pnl > 0).length;
  const total = (curve.trades ?? []).length;
  const change = curve.final_equity - curve.initial_equity;
  const changePct = curve.initial_equity
    ? (change / curve.initial_equity) * 100
    : 0;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/45">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 bg-teal-300" /> equity
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 bg-indigo-300/70" /> out-of-sample split
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> winner
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-red-400" /> loser
      </span>
      <span className="ml-auto">
        {total} trades · {wins}W / {total - wins}L ·{" "}
        <span className={change >= 0 ? "text-mint-300" : "text-rose-300"}>
          {fmt.signed(changePct, 2)}%
        </span>{" "}
        · max dd {curve.max_drawdown_pct.toFixed(2)}%
      </span>
    </div>
  );
}
