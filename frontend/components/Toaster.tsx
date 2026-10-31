"use client";

import { useAlphaForge } from "./AlphaForgeProvider";
import { cx } from "./ui";

export default function Toaster() {
  const { toasts, dismissToast } = useAlphaForge();
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            "panel pointer-events-auto animate-slideUp px-4 py-3 text-sm",
            toast.kind === "success" && "border-forge-mint/30",
            toast.kind === "error" && "border-forge-rose/40",
            toast.kind === "info" && "border-forge-cyan/25",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-white">{toast.title}</div>
              {toast.detail ? (
                <div className="mt-0.5 text-xs text-white/50">{toast.detail}</div>
              ) : null}
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              className="text-white/40 transition hover:text-white"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
