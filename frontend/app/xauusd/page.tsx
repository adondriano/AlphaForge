"use client";

import XauusdDesk from "@/components/XauusdDesk";

export default function XauusdPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-white">XAUUSD Desk</h1>
        <p className="text-[12px] text-white/45">
          One instrument, watched properly. Live candles with RSI and MACD
          underneath, parameters you can tune, and an alert only when both
          indicators agree on a closed bar.
        </p>
      </div>
      <XauusdDesk />
    </div>
  );
}
