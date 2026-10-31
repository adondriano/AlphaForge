"use client";

import type { ReactNode } from "react";

export function cx(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cx("panel", onClick && "panel-hover cursor-pointer", className)}
    >
      {children}
    </div>
  );
}

const TONES = {
  neutral: "border-white/10 bg-white/[0.04] text-white/70",
  amber: "border-forge-amber/30 bg-forge-amber/10 text-forge-amber",
  mint: "border-forge-mint/30 bg-forge-mint/10 text-forge-mint",
  cyan: "border-forge-cyan/30 bg-forge-cyan/10 text-forge-cyan",
  rose: "border-forge-rose/30 bg-forge-rose/10 text-forge-rose",
  violet: "border-forge-violet/30 bg-forge-violet/10 text-forge-violet",
  ember: "border-forge-ember/30 bg-forge-ember/10 text-forge-ember",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  /** Native tooltip — used to surface shield block reasons. */
  title?: string;
}) {
  return (
    <span className={cx("chip", TONES[tone], className)} title={title}>
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  const accent = {
    neutral: "text-white",
    amber: "text-forge-amber",
    mint: "text-forge-mint",
    cyan: "text-forge-cyan",
    rose: "text-forge-rose",
    violet: "text-forge-violet",
    ember: "text-forge-ember",
  }[tone];
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
          {label}
        </span>
        {icon ? <span className={cx("opacity-70", accent)}>{icon}</span> : null}
      </div>
      <div className={cx("tabular mt-2 text-2xl font-semibold", accent)}>{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-white/40">{hint}</div> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
        checked ? "bg-forge-mint/80" : "bg-white/15",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cx(
          "inline-block h-4 w-4 transform rounded-full bg-white transition",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function ProgressBar({ value, tone = "amber" }: { value: number; tone?: Tone }) {
  const fill = {
    neutral: "bg-white/50",
    amber: "bg-forge-amber",
    mint: "bg-forge-mint",
    cyan: "bg-forge-cyan",
    rose: "bg-forge-rose",
    violet: "bg-forge-violet",
    ember: "bg-forge-ember",
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={cx("h-full rounded-full transition-all", fill)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Sparkline({
  values,
  className,
  stroke = "#2dd4a7",
  height = 44,
}: {
  values: number[];
  className?: string;
  stroke?: string;
  height?: number;
}) {
  if (!values || values.length < 2) {
    return <div className={cx("h-[44px] rounded bg-white/[0.03]", className)} />;
  }
  const width = 240;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / span) * (height - 6) - 3;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const area = `M0,${height} L${points.join(" L")} L${width},${height} Z`;
  const gradientId = `spark-${stroke.replace("#", "")}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cx("w-full", className)}
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** Tailwind max-width class; wins over `wide` when both are given. */
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8">
      <div
        className={cx(
          "panel animate-slideUp w-full bg-ink-900/95 p-0",
          width ?? (wide ? "max-w-5xl" : "max-w-2xl"),
        )}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="text-sm font-semibold text-white">{title}</div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-white/50 transition hover:bg-white/5 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-forge-amber",
        className,
      )}
    />
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="text-base font-semibold text-white/80">{title}</div>
      {detail ? <div className="max-w-md text-sm text-white/45">{detail}</div> : null}
      {action}
    </div>
  );
}
