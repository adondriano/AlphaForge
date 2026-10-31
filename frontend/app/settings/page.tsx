"use client";

import SettingsTab from "@/components/SettingsTab";

export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-white">Settings</h1>
        <p className="text-[12px] text-white/45">
          Integrations, execution credentials and the prop-firm risk envelope. Supabase values are
          applied immediately; secrets stay in this browser for the session and are never written to
          local storage.
        </p>
      </div>
      <SettingsTab />
    </div>
  );
}
