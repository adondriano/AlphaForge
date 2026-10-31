"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Plug,
  PlugZap,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import { Badge, Spinner, cx } from "./ui";
import type { AppSettings } from "@/lib/types";
import { SYMBOLS, TIMEFRAMES } from "@/lib/types";
import { llmProvider } from "@/lib/settings";

type FieldKey = keyof AppSettings;

const MT5_GUIDE_URL =
  "https://github.com/adondriano/AlphaForge/blob/main/docs/CONNECTING-MT5.md";

const MT5_AGENT_GUIDE_URL =
  "https://github.com/adondriano/AlphaForge/blob/main/docs/CONNECTING-MT5.md#path-c--bridge-agent-keep-the-engine-on-vercel";

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
    title: "Python engine",
    icon: <Zap size={15} />,
    description:
      "Where the FastAPI engine lives. This overrides NEXT_PUBLIC_API_URL at runtime, so you can point a hosted dashboard at the engine running on your own machine. Leave it blank to use the in-browser TypeScript engine.",
    fields: [
      {
        key: "ENGINE_URL",
        label: "ENGINE_URL",
        placeholder: "http://localhost:8000",
        hint: "Base URL only — no /api suffix. If you open AlphaForge over HTTPS (the hosted site), this must be HTTPS too, otherwise the browser blocks it as mixed content. Use a tunnel (cloudflared / ngrok) and paste its https:// URL here.",
      },
    ],
  },
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
      {
        key: "MT5_PASSWORD",
        label: "MT5_PASSWORD",
        type: "password",
        placeholder: "••••••••",
        hint: "Kept in this browser and forwarded to the Python engine only — never to the LLM provider.",
      },
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
  const {
    settings,
    updateSettings,
    engineStatus,
    storeMode,
    notify,
    canEdit,
    requireAccount,
    mt5Status,
    mt5Busy,
    refreshMt5,
    connectMt5,
    disconnectMt5,
    resetEverything,
  } = useAlphaForge();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [reseed, setReseed] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  // Keep the form in sync when settings change from elsewhere (reset, first load).
  useEffect(() => {
    setDraft((current) => (JSON.stringify(current) === JSON.stringify(settings) ? current : settings));
  }, [settings]);

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

  const mt5Connected = Boolean(mt5Status?.connected);
  const mt5Tone: "mint" | "amber" | "neutral" = mt5Connected ? "mint" : "amber";

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
          detail={`${engineStatus.detail ?? ""}${
            engineStatus.detail ? " " : ""
          }Target: ${settings.ENGINE_URL?.trim() || "not set (in-browser engine)"}`}
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

      <div className={cx("panel p-5", mt5Connected ? "border-forge-mint/25" : "border-forge-amber/25")}>
        <div className="mb-1 flex items-center gap-2">
          {mt5Connected ? (
            <PlugZap size={15} className="text-forge-mint" />
          ) : (
            <Plug size={15} className="text-forge-amber" />
          )}
          <h3 className="text-sm font-semibold text-white">MetaTrader 5 bridge</h3>
          <Badge tone={mt5Tone}>{mt5Connected ? "connected" : "disconnected"}</Badge>
          <Badge tone="neutral">{mt5Status?.mode ?? "shadow"}</Badge>
          {mt5Status?.relay ? (
            <Badge tone="cyan" title={`Last heartbeat ${mt5Status.relay.age_seconds ?? "?"}s ago`}>
              via bridge · {mt5Status.relay.name}
            </Badge>
          ) : null}
        </div>
        <p className="mb-4 text-[12px] leading-relaxed text-white/40">
          {mt5Connected
            ? mt5Status?.relay
              ? `Live quotes and order routing are relayed over Supabase by the bridge agent "${mt5Status.relay.name}" running next to your terminal.`
              : "Live quotes and order routing are active through the Python engine."
            : "Fill in MT5_PATH, MT5_LOGIN, MT5_SERVER and MT5_PASSWORD, run the Python engine on the Windows machine that hosts your terminal, then connect. Until then every fill is simulated locally so the studio stays fully usable."}
          {mt5Status?.reason ? (
            <>
              {" "}
              <span className="text-white/55">Engine says: {mt5Status.reason}</span>
            </>
          ) : null}{" "}
          <a
            href={MT5_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-forge-cyan underline decoration-dotted underline-offset-2 hover:text-white"
          >
            Full step-by-step setup guide →
          </a>{" "}
          <a
            href={MT5_AGENT_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-forge-violet underline decoration-dotted underline-offset-2 hover:text-white"
          >
            Bridge agent (keeps the engine on Vercel) →
          </a>
        </p>
        {mt5Connected && mt5Status?.account ? (
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <AccountCell label="Account" value={String(mt5Status.account.login ?? "—")} />
            <AccountCell label="Server" value={mt5Status.account.server ?? "—"} />
            <AccountCell
              label="Balance"
              value={
                mt5Status.account.balance != null
                  ? `${mt5Status.account.currency ?? ""} ${mt5Status.account.balance.toFixed(2)}`
                  : "—"
              }
            />
            <AccountCell
              label="Equity"
              value={
                mt5Status.account.equity != null
                  ? `${mt5Status.account.currency ?? ""} ${mt5Status.account.equity.toFixed(2)}`
                  : "—"
              }
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {mt5Connected ? (
            <button
              className="btn-ghost text-[12px]"
              disabled={mt5Busy || !canEdit}
              onClick={() => void disconnectMt5()}
            >
              {mt5Busy ? <Spinner /> : <Plug size={14} />} Disconnect
            </button>
          ) : (
            <button
              className="btn-primary text-[12px]"
              disabled={mt5Busy || !canEdit}
              onClick={async () => {
                await updateSettings(draft);
                await connectMt5();
              }}
            >
              {mt5Busy ? <Spinner /> : <PlugZap size={14} />} Save &amp; connect
            </button>
          )}
          <button
            className="btn-ghost text-[12px]"
            disabled={mt5Busy}
            onClick={() => void refreshMt5()}
          >
            {mt5Busy ? <Spinner /> : <RefreshCw size={14} />} Refresh status
          </button>
          {!canEdit ? (
            <span className="text-[11px] text-white/35">
              Sign in to open or close the terminal bridge.
            </span>
          ) : null}
        </div>
      </div>

      <div className="panel border-forge-rose/25 p-5">
        <div className="mb-1 flex items-center gap-2">
          <AlertTriangle size={15} className="text-forge-rose" />
          <h3 className="text-sm font-semibold text-white">Reset everything</h3>
        </div>
        <p className="text-[12px] leading-relaxed text-white/40">
          Deletes every strategy, parameter version, trade log and paper-trading session and clears
          the engine cache. Your saved settings are kept.
        </p>
        <label className="mt-3 flex items-center gap-2 text-[12px] text-white/60">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-forge-cyan"
            checked={reseed}
            onChange={(event) => setReseed(event.target.checked)}
          />
          Re-seed three demo strategies afterwards
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <button
                className="btn-danger text-[12px]"
                disabled={resetting || !canEdit}
                onClick={async () => {
                  setResetting(true);
                  try {
                    await resetEverything({ reseed });
                  } finally {
                    setResetting(false);
                    setConfirming(false);
                  }
                }}
              >
                {resetting ? <Spinner /> : <Trash2 size={14} />} Yes, wipe it all
              </button>
              <button
                className="btn-ghost text-[12px]"
                disabled={resetting}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="btn-ghost text-[12px]"
              disabled={!canEdit}
              onClick={() => {
                if (!requireAccount("Resetting the studio")) return;
                setConfirming(true);
              }}
            >
              <Trash2 size={14} /> Reset everything…
            </button>
          )}
          {!canEdit ? (
            <span className="text-[11px] text-white/35">Sign in to reset your workspace.</span>
          ) : null}
        </div>
      </div>

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
        <button className="btn-primary" onClick={save} disabled={saving || !dirty || !canEdit}>
          {saving ? <Spinner /> : <Save size={15} />}
          {dirty ? "Save settings" : "Saved"}
        </button>
      </div>
    </div>
  );
}

function AccountCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className="tabular truncate text-[13px] font-semibold text-white/85">{value}</div>
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
