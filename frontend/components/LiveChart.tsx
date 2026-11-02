"use client";

/**
 * Live candlestick chart.
 *
 * Hand-rolled SVG like EquityChart: the series is short (a few hundred bars),
 * and this keeps a charting dependency out of the bundle while giving exact
 * control over the live last-price marker.
 *
 * Bars come from broker candle history. The newest bar is re-extended on every
 * quote so the right edge moves between history refreshes — the last close is
 * always the latest price the broker actually sent.
 */

import { useMemo, useState, type MouseEvent } from "react";

import type { BrokerCandle } from "@/lib/types";

const W = 760;
const H = 300;
const PAD = { top: 12, right: 58, bottom: 24, left: 8 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
/** How much of the plot height the volume strip occupies at the bottom. */
const VOL_SHARE = 0.16;

const UP = "rgb(52,211,153)";
const DOWN = "rgb(248,113,113)";

interface Props {
  candles: BrokerCandle[];
  timeframe: string;
  /** Current mid price, used to extend the newest bar and draw the marker. */
  livePrice?: number | null;
  digits?: number;
  height?: number;
}

interface Hover {
  index: number;
  x: number;
  y: number;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rough = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ??
    10 * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) {
    ticks.push(v);
  }
  return ticks;
}

/** Axis labels are UTC: server times are UTC and mixing zones misleads. */
function stamp(seconds: number, spanSeconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const d = new Date(seconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (spanSeconds > 3 * 86_400) {
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;
  }
  return `${hh}:${mm}`;
}

function fullStamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = new Date(seconds * 1000);
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export default function LiveChart({
  candles,
  timeframe,
  livePrice,
  digits = 5,
  height = 300,
}: Props) {
  const [hover, setHover] = useState<Hover | null>(null);

  /**
   * The newest bar is rebuilt from the live price so the chart keeps moving
   * between history polls. Only the last bar is touched — history is never
   * rewritten from a single quote.
   */
  const series = useMemo(() => {
    if (candles.length === 0) return [];
    const bars = candles.map((c) => ({ ...c }));
    if (livePrice && livePrice > 0) {
      const last = bars[bars.length - 1];
      last.c = livePrice;
      last.h = Math.max(last.h, livePrice);
      last.l = Math.min(last.l, livePrice);
    }
    return bars;
  }, [candles, livePrice]);

  const geometry = useMemo(() => {
    if (series.length === 0) return null;
    let hi = -Infinity;
    let lo = Infinity;
    let maxVol = 0;
    for (const c of series) {
      hi = Math.max(hi, c.h);
      lo = Math.min(lo, c.l);
      maxVol = Math.max(maxVol, c.v ?? 0);
    }
    // A flat series would collapse the scale; give it a token range.
    if (hi - lo < 1e-9) {
      hi += Math.abs(hi) * 0.0005 || 0.5;
      lo -= Math.abs(lo) * 0.0005 || 0.5;
    }
    const pad = (hi - lo) * 0.06;
    hi += pad;
    lo -= pad;

    const priceH = PLOT_H * (1 - VOL_SHARE);
    const slot = PLOT_W / series.length;
    const barW = Math.max(1.2, Math.min(16, slot * 0.68));

    return {
      hi,
      lo,
      priceH,
      slot,
      barW,
      maxVol,
      xAt: (i: number) => PAD.left + (i + 0.5) * slot,
      yAt: (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * priceH,
    };
  }, [series]);

  if (!geometry || series.length === 0) return null;

  const { hi, lo, priceH, slot, barW, maxVol, xAt, yAt } = geometry;
  const first = series[0];
  const last = series[series.length - 1];
  const spanSeconds = Math.max(0, last.t - first.t);
  const lastPrice = last.c;
  const rising = last.c >= first.o;

  const priceTicks = niceTicks(lo, hi, 5);
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Mouse pixels -> viewBox units for the index, then back to pixels so the
    // HTML tooltip lines up with the scaled SVG.
    const vx = ((event.clientX - rect.left) / rect.width) * W;
    const raw = Math.round((vx - PAD.left) / slot - 0.5);
    const index = Math.min(series.length - 1, Math.max(0, raw));
    setHover({
      index,
      x: event.clientX - rect.left,
      y: yAt(series[index].h) * (rect.height / H),
    });
  };

  const hovered = hover ? series[hover.index] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${timeframe} candles`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* horizontal grid + price axis */}
        {priceTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={yAt(v)}
              y2={yAt(v)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
            <text
              x={PAD.left + PLOT_W + 6}
              y={yAt(v) + 3}
              className="fill-white/35"
              style={{ fontSize: 9 }}
            >
              {v.toFixed(digits)}
            </text>
          </g>
        ))}

        {/* time axis */}
        {series.map((c, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`t${c.t}-${i}`}
              x={xAt(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-white/25"
              style={{ fontSize: 9 }}
            >
              {stamp(c.t, spanSeconds)}
            </text>
          ) : null,
        )}

        {/* volume strip */}
        {maxVol > 0
          ? series.map((c, i) => {
              const vh = ((c.v ?? 0) / maxVol) * (PLOT_H * VOL_SHARE);
              return (
                <rect
                  key={`v${c.t}-${i}`}
                  x={xAt(i) - barW / 2}
                  y={PAD.top + priceH + (PLOT_H * VOL_SHARE - vh)}
                  width={barW}
                  height={Math.max(0.5, vh)}
                  fill={c.c >= c.o ? UP : DOWN}
                  fillOpacity="0.18"
                />
              );
            })
          : null}

        {/* candles */}
        {series.map((c, i) => {
          const up = c.c >= c.o;
          const colour = up ? UP : DOWN;
          const yo = yAt(c.o);
          const yc = yAt(c.c);
          return (
            <g key={`c${c.t}-${i}`}>
              <line
                x1={xAt(i)}
                x2={xAt(i)}
                y1={yAt(c.h)}
                y2={yAt(c.l)}
                stroke={colour}
                strokeOpacity="0.65"
                strokeWidth="1"
              />
              <rect
                x={xAt(i) - barW / 2}
                y={Math.min(yo, yc)}
                width={barW}
                height={Math.max(1.2, Math.abs(yc - yo))}
                fill={colour}
                fillOpacity={i === series.length - 1 ? 1 : 0.85}
              />
            </g>
          );
        })}

        {/* live price marker */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={yAt(lastPrice)}
          y2={yAt(lastPrice)}
          stroke={rising ? UP : DOWN}
          strokeDasharray="3 3"
          strokeOpacity="0.55"
          strokeWidth="1"
        />
        <rect
          x={PAD.left + PLOT_W + 2}
          y={yAt(lastPrice) - 7}
          width={PAD.right - 6}
          height={14}
          rx={3}
          fill={rising ? UP : DOWN}
          fillOpacity="0.9"
        />
        <text
          x={PAD.left + PLOT_W + 4 + (PAD.right - 6) / 2}
          y={yAt(lastPrice) + 3.5}
          textAnchor="middle"
          className="fill-[#06070c]"
          style={{ fontSize: 9, fontWeight: 600 }}
        >
          {lastPrice.toFixed(digits)}
        </text>

        {/* crosshair */}
        {hover ? (
          <line
            x1={xAt(hover.index)}
            x2={xAt(hover.index)}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="1"
          />
        ) : null}
      </svg>

      {hover && hovered ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-[#0b0d15]/95 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur"
          style={{ left: hover.x, top: Math.max(0, hover.y - 10) }}
        >
          <div className="mb-0.5 text-white/40">{fullStamp(hovered.t)}</div>
          <div className="grid grid-cols-2 gap-x-3 font-mono">
            <span className="text-white/45">O</span>
            <span className="text-white/85">{hovered.o.toFixed(digits)}</span>
            <span className="text-white/45">H</span>
            <span className="text-white/85">{hovered.h.toFixed(digits)}</span>
            <span className="text-white/45">L</span>
            <span className="text-white/85">{hovered.l.toFixed(digits)}</span>
            <span className="text-white/45">C</span>
            <span
              className={hovered.c >= hovered.o ? "text-mint-300" : "text-rose-300"}
            >
              {hovered.c.toFixed(digits)}
            </span>
          </div>
          {hovered.v ? (
            <div className="mt-0.5 text-white/35">vol {hovered.v}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
