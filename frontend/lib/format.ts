export const fmt = {
  pct: (value: number, digits = 1) => `${(value ?? 0).toFixed(digits)}%`,
  num: (value: number, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "—"),
  signed: (value: number, digits = 2) =>
    `${value > 0 ? "+" : ""}${(Number.isFinite(value) ? value : 0).toFixed(digits)}`,
  r: (value: number) => `${(value ?? 0).toFixed(2)}R`,
  int: (value: number) => Math.round(value ?? 0).toLocaleString(),
  money: (value: number) =>
    (value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }),
  time: (value?: string | null) =>
    value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—",
  dateTime: (value?: string | null) =>
    value
      ? new Date(value).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—",
  compact: (value: number) =>
    Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`,
};

export function readinessTone(value: number): "mint" | "amber" | "rose" {
  if (value >= 70) return "mint";
  if (value >= 40) return "amber";
  return "rose";
}

export function statusTone(status: string): "neutral" | "cyan" | "mint" | "amber" | "violet" | "rose" {
  switch (status) {
    case "live":
      return "mint";
    case "paper":
      return "cyan";
    case "shadow":
      return "violet";
    case "optimized":
      return "amber";
    case "backtested":
      return "neutral";
    case "halted":
      return "rose";
    default:
      return "neutral";
  }
}
