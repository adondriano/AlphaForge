"use client";

/**
 * Mini indicator panes that sit under the main candle chart.
 *
 * Same hand-rolled SVG approach as LiveChart and EquityChart — these are
 * short series and a charting dependency is not worth the bundle. Both panes
 * share the price chart's x scale so a signal lines up visually with the
 * candle that produced it.
 */

const W = 760;
const H = 120;
const PAD = { top: 8, right: 58, bottom: 6, left: 8 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const UP = "rgb(52,211,153)";
const DOWN = "rgb(248,113,113)";
const MACD_LINE = "rgb(96,165,250)";
const SIGNAL_LINE = "rgb(251,191,36)";

interface MacdProps {
  histogram: number[];
  macd: number[];
  signal: number[];
  height?: number;
}

export function MacdChart({ histogram, macd, signal, height = 150 }: MacdProps) {
  const n = histogram.length;
  if (n < 2) return null;

  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < n; i += 1) {
    hi = Math.max(hi, histogram[i], macd[i] ?? 0, signal[i] ?? 0);
    lo = Math.min(lo, histogram[i], macd[i] ?? 0, signal[i] ?? 0);
  }
  if (hi - lo < 1e-12) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.08;
  hi += pad;
  lo -= pad;

  const slot = PLOT_W / n;
  const xAt = (i: number) => PAD.left + (i + 0.5) * slot;
  const yAt = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * PLOT_H;
  const barW = Math.max(1, Math.min(9, slot * 0.6));

  const line = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(v)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-auto w-full"
      style={{ maxHeight: height }}
      role="img"
      aria-label="MACD"
    >
      <line
        x1={PAD.left}
        x2={PAD.left + PLOT_W}
        y1={yAt(0)}
        y2={yAt(0)}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1"
      />
      {histogram.map((v, i) => (
        <rect
          key={i}
          x={xAt(i) - barW / 2}
          y={Math.min(yAt(v), yAt(0))}
          width={barW}
          height={Math.max(0.6, Math.abs(yAt(v) - yAt(0)))}
          fill={v >= 0 ? UP : DOWN}
          fillOpacity="0.5"
        />
      ))}
      <path d={line(macd)} fill="none" stroke={MACD_LINE} strokeWidth="1.3" />
      <path d={line(signal)} fill="none" stroke={SIGNAL_LINE} strokeWidth="1.3" />
      <text
        x={PAD.left + PLOT_W + 6}
        y={yAt(macd[n - 1]) + 3}
        className="fill-blue-300/80"
        style={{ fontSize: 9 }}
      >
        {macd[n - 1]?.toFixed(2)}
      </text>
      <text
        x={PAD.left + PLOT_W + 6}
        y={yAt(signal[n - 1]) + 3}
        className="fill-amber-300/80"
        style={{ fontSize: 9 }}
      >
        {signal[n - 1]?.toFixed(2)}
      </text>
    </svg>
  );
}

interface RsiProps {
  values: number[];
  oversold: number;
  overbought: number;
  height?: number;
}

export function RsiChart({ values, oversold, overbought, height = 150 }: RsiProps) {
  const n = values.length;
  if (n < 2) return null;

  const yAt = (v: number) => PAD.top + (1 - v / 100) * PLOT_H;
  const slot = PLOT_W / n;
  const xAt = (i: number) => PAD.left + (i + 0.5) * slot;
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(v)}`)
    .join(" ");

  const band = (level: number, label: string, tone: string) => (
    <g key={label}>
      <line
        x1={PAD.left}
        x2={PAD.left + PLOT_W}
        y1={yAt(level)}
        y2={yAt(level)}
        stroke={tone}
        strokeDasharray="3 3"
        strokeOpacity="0.45"
        strokeWidth="1"
      />
      <text
        x={PAD.left + PLOT_W + 6}
        y={yAt(level) + 3}
        className="fill-white/35"
        style={{ fontSize: 9 }}
      >
        {label}
      </text>
    </g>
  );

  const last = values[n - 1] ?? 50;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-auto w-full"
      style={{ maxHeight: height }}
      role="img"
      aria-label="RSI"
    >
      <line
        x1={PAD.left}
        x2={PAD.left + PLOT_W}
        y1={yAt(50)}
        y2={yAt(50)}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
      />
      {band(overbought, String(overbought), DOWN)}
      {band(oversold, String(oversold), UP)}
      <path d={path} fill="none" stroke="rgb(167,139,250)" strokeWidth="1.4" />
      <circle
        cx={xAt(n - 1)}
        cy={yAt(last)}
        r="2.6"
        fill={last >= overbought ? DOWN : last <= oversold ? UP : "rgb(167,139,250)"}
      />
      <text
        x={PAD.left + PLOT_W + 6}
        y={yAt(last) + 3}
        className="fill-violet-300/90"
        style={{ fontSize: 9 }}
      >
        {last.toFixed(1)}
      </text>
    </svg>
  );
}
