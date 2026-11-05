"use client";

import PropFirmDesk from "@/components/PropFirmDesk";

export default function PropFirmPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-white">
          Prop-Firm Execution &amp; Automation
        </h1>
        <p className="text-[12px] text-white/45">
          A confidence scanner across the prop-firm universe, guardrails matched
          to your firm&apos;s rules, and a kill switch that closes what is
          actually open.
        </p>
      </div>
      <PropFirmDesk />
    </div>
  );
}
