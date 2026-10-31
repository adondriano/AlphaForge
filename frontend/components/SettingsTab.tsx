"use client";

import { useState } from "react";
import {
  Bot,
  Check,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Save,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import { Badge, Spinner, cx } from "./ui";
import type { AppSettings } from "@/lib/types";
import { SYMBOLS, TIMEFRAMES } from "@/lib/types";
import { llmProvider } from "@/lib/settings";

type FieldKey = keyof AppSettings;

const GROUPS: {
  title: string;
  icon: React.ReactNode;
  description: string;
  fields: {
    key: FieldKey;
    label: string;
    placeholder?: string;
    type?: "text" | "password" | "number";
    step?: string;
    hint?: string;
  }[];
}[] = [
  {
    title: "Supabase",
    icon: <Database size={15} />,
    description:
      "Realtime strategy state, parameter lineage and trade logs. The anon key is used by the browser; the service role key is only sent to the Python engine.",
    fields: [
      {
        key: "NEXT_PUBLIC_SUPABASE_URL",
        label: "NEXT_PUBLIC_SUPABASE_URL",
        placeholder: "https://xxxxxxxxxxxx.supabase.co",
      },
      {
        key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        label: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        type: "password",
        placeholder: "eyJhbGciOi...",
        hint: "Safe to expose — governed by row level security.",
      },
      {
        key: "SUPABASE_SERVICE_ROLE_KEY",
        label: "SUPABASE_SERVICE_ROLE_KEY",
        type: "password",
        placeholder: "eyJhbGciOi...",
        hint: "Server-side only. Never shipped to the browser bundle.",
      },
    ],
  },
  {
    title: "Execution · MetaTrader 5",
    icon: <Terminal size={15} />,
    description:
      "Windows-only terminal bridge. When it is unavailable AlphaForge fills in shadow mode so the rest of the studio keeps working.",
    fields: [
      { key: "MT5_PATH", label: "MT5_PATH", placeholder: "C:\\Program Files\\MetaTrader 5\\terminal.exe" },
      { key: "MT5_LOGIN", label: "MT5_LOGIN", placeholder: "12345678" },
      { key: "MT5_SERVER", label: "MT5_SERVER", placeholder: "Broker-Demo" },
    ],
  },
  {
    title: "LLM orchestration",
    icon: <Bot size={15} />,
    description:
      "Optional. With no provider configured the studio uses the local statistical transpiler and diagnostic engine — no API key required.",
    fields: [
      { key: "OPENAI_API_KEY", label: "OPENAI_API_KEY", type: "password", placeholder: "sk-..." },
      { key: "OPENAI_MODEL", label: "OPENAI_MODEL", placeholder: "gpt-4o-mini" },
      { key: "OLLAMA_URL", label: "OLLAMA_URL", placeholder: "http://localhost:11434" },
      { key: "OLLAMA_MODEL", label: "OLLAMA_MODEL", placeholder: "llama3.1" },
    ],
  },
  {
    title: "Prop-Firm risk limits",
    icon: <ShieldCheck size={15} />,
    description:
      "Hard middleware. Every order is evaluated against these caps before it reaches a broker — there is no override flag.",
    fields: [
      { key: "MAX_DAILY_DRAWDOWN", label: "MAX_DAILY_DRAWDOWN (%)", type: "number", step: "0.1" },
      { key: "MAX_TOTAL_DRAWDOWN", label: "MAX_TOTAL_DRAWDOWN (%)", type: "number", step: "0.1" },
      { key: "RISK_PER_TRADE_PCT", label: "RISK_PER_TRADE_PCT (%)", type: "number", step: "0.05" },
      { key: "MAX_CONCURRENT_TRADES", label: "MAX_CONCURRENT_TRADES", type: "number", step: "1" },
      { key: "BEST_DAY_PROFIT_CAP_PCT", label: "BEST_DAY_PROFIT_CAP_PCT (%)", type: "number", step: "1" },
    ],
  },
  {
    title: "Engine defaults",
    icon: <Cpu size={15} />,
    description: "Applied to every new backtest and optimisation run.",
    fields: [
      { key: "DEFAULT_SYMBOL", label: "DEFAULT_SYMBOL", placeholder: "XAUUSD" },
      { key: "DEFAULT_TIMEFRAME", label: "DEFAULT_TIMEFRAME", placeholder: "H1" },
      { key: "BACKTEST_BARS", label: "BACKTEST_BARS", type: "number", step: "100" },
      { key: "OPTIMIZER_TRIALS", label: "OPTIMIZER_TRIALS", type: "number", step: "5" },
    ],
  },
];

export default function SettingsTab() {
  const { settings, updateSettings, engineStatus, storeMode, notify } = useAlphaForge();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const set = (key: FieldKey, value: string | number | boolean) => {
    setDraft((current) => ({ ...current, [key]: value } as AppSettings));
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateSettings(draft);
      notify({ kind: "success", title: "Settings saved", detail: "Applied to this browser and pushed to the Python engine." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Status
          label="Data layer"
          value={storeMode === "supabase" ? "Supabase connected" : "Browser storage"}
          tone={storeMode === "supabase" ? "mint" : "amber"}
          detail={
            storeMode === "supabase"
              ? "Realtime subscription active on strategies, optimizations and trade_logs."
              : "Add your Supabase URL + anon key to sync across devices."
          }
        />
        <Status
          label="Compute engine"
          value={engineStatus.label}
          tone={engineStatus.mode === "python" ? "mint" : "cyan"}
          detail={engineStatus.detail ?? ""}
        />
        <Status
          label="LLM provider"
          value={
            llmProvider(settings) === "openai"
              ? "OpenAI"
              : llmProvider(settings) === "ollama"
                ? "Ollama"
                : "None · deterministic engines only"
          }
          tone={llmProvider(settings) === "none" ? "neutral" : "violet"}
          detail={
            llmProvider(settings) === "none"
              ? "The studio runs fully offline on the statistical engines."
              : "LLM transpilation and analyst enrichment are available."
          }
        />
      </div>

      {GROUPS.map((group) => (
        <div key={group.title} className="panel p-5">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-white/60">{group.icon}</span>
            <h3 className="text-sm font-semibold text-white">{group.title}</h3>
          </div>
          <p className="mb-4 text-[12px] leading-relaxed text-white/40">{group.description}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.fields.map((field) => {
              const value = draft[field.key];
              const isSecret = field.type === "password";
              const show = revealed[field.key];
              const isSelect =
                field.key === "DEFAULT_SYMBOL" || field.key === "DEFAULT_TIMEFRAME";
              return (
                <div key={String(field.key)} className={isSecret ? "sm:col-span-2 lg:col-span-3" : ""}>
                  <label className="label">{field.label}</label>
                  <div className="relative">
                    {isSelect ? (
                      <select
                        className="input"
                        value={String(value ?? "")}
                        onChange={(event) => set(field.key, event.target.value)}
                      >
                        <option value="">—</option>
                        {(field.key === "DEFAULT_SYMBOL" ? SYMBOLS : TIMEFRAMES).map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={cx("input", isSecret && "pr-10 font-mono text-[12px]")}
                        type={isSecret ? (show ? "text" : "password") : (field.type ?? "text")}
                        step={field.step}
                        placeholder={field.placeholder}
                        value={value === 0 ? "0" : String(value ?? "")}
                        onChange={(event) =>
                          set(
                            field.key,
                            field.type === "number" ? Number(event.target.value) : event.target.value,
                          )
                        }
                      />
                    )}
                    {isSecret ? (
                      <button
                        type="button"
                        onClick={() =>
                          setRevealed((current) => ({ ...current, [field.key]: !current[field.key] }))
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-white/35 transition hover:text-white"
                        aria-label={show ? "Hide" : "Show"}
                      >
                        {show ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    ) : null}
                  </div>
                  {field.hint ? (
                    <p className="mt-1 text-[11px] text-white/30">{field.hint}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="panel p-5">
        <div className="mb-1 flex items-center gap-2">
          <Server size={15} className="text-white/60" />
          <h3 className="text-sm font-semibold text-white">Database setup</h3>
        </div>
        <p className="text-[12px] leading-relaxed text-white/45">
          Apply <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px]">backend/schema.sql</code>{" "}
          in the Supabase SQL editor (or <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px]">supabase db execute --file backend/schema.sql</code>).
          It creates the <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px]">strategies</code>,{" "}
          <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px]">optimizations</code> and{" "}
          <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px]">trade_logs</code> tables,
          enables row level security and adds all three to the{" "}
          <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px]">supabase_realtime</code>{" "}
          publication.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3">
        {dirty ? (
          <button className="btn-ghost" onClick={() => setDraft(settings)}>
            Discard changes
          </button>
        ) : null}
        <button className="btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? <Spinner /> : <Save size={15} />}
          {dirty ? "Save settings" : "Saved"}
        </button>
      </div>
    </div>
  );
}

function Status({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "mint" | "amber" | "cyan" | "violet" | "neutral";
}) {
  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1.5 flex items-center gap-2">
        <span
          className={cx(
            "h-1.5 w-1.5 rounded-full",
            tone === "mint"
              ? "bg-forge-mint"
              : tone === "amber"
                ? "bg-forge-amber"
                : tone === "cyan"
                  ? "bg-forge-cyan"
                  : tone === "violet"
                    ? "bg-forge-violet"
                    : "bg-white/30",
          )}
        />
        <span className="text-[13px] font-semibold text-white">{value}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-white/40">{detail}</p>
    </div>
  );
}
