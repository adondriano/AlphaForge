"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ClipboardCopy,
  Cpu,
  FileJson,
  Link2,
  Sparkles,
  Type,
  Wand2,
  Youtube,
} from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import { Badge, Modal, Spinner, cx } from "./ui";
import { SAMPLE_SPEC, PROMPT_TEMPLATE, validateSpecJson } from "@/lib/transpiler";
import type { TranspileResult } from "@/lib/transpiler";
import type { SourceType } from "@/lib/types";
import { SYMBOLS, TIMEFRAMES } from "@/lib/types";

type Tab = "describe" | "json";

function detectPlatform(url: string): { type: SourceType; label: string } {
  if (/youtube\.com|youtu\.be/i.test(url)) return { type: "youtube", label: "YouTube detected" };
  if (/tiktok\.com/i.test(url)) return { type: "tiktok", label: "TikTok detected" };
  if (/facebook\.com|fb\.watch/i.test(url)) return { type: "youtube", label: "Facebook video detected" };
  return { type: "text", label: "No video URL" };
}

export default function StrategyCreatorModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { createStrategy, settings, notify } = useAlphaForge();
  const [tab, setTab] = useState<Tab>("describe");
  const [sourceUrl, setSourceUrl] = useState("");
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [noLlm, setNoLlm] = useState(true);
  const [jsonText, setJsonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("");

  const platform = useMemo(() => detectPlatform(sourceUrl), [sourceUrl]);
  const validation = useMemo(() => validateSpecJson(jsonText), [jsonText]);
  const llmReady = Boolean(settings.OPENAI_API_KEY) ||
    Boolean(
      settings.OLLAMA_URL &&
        !["http://localhost:11434", "http://127.0.0.1:11434", ""].includes(settings.OLLAMA_URL.trim()),
    );

  const reset = () => {
    setSourceUrl("");
    setText("");
    setTranscript("");
    setJsonText("");
    setName("");
    setSymbol("");
    setTimeframe("");
    setTab("describe");
  };

  const forge = async () => {
    setBusy(true);
    try {
      if (tab === "json") {
        const result = validateSpecJson(jsonText);
        if (!result.ok || !result.spec) {
          notify({ kind: "error", title: "Invalid JSON spec", detail: result.errors[0] });
          return;
        }
        await createStrategy({ spec: result.spec, engine: "manual-json" });
      } else {
        const body = (transcript.trim() || text.trim() || "").trim();
        if (!body && !sourceUrl) {
          notify({
            kind: "error",
            title: "Nothing to transpile",
            detail: "Paste a description, a transcript, or a video URL.",
          });
          return;
        }
        const { transpile } = await import("@/lib/api");
        const response = await transpile({
          text: body || `Strategy from ${sourceUrl}`,
          sourceUrl,
          transcript: transcript.trim() || undefined,
          noLlm,
          name: name.trim() || undefined,
          symbol: symbol || undefined,
          timeframe: timeframe || undefined,
        });
        const spec: TranspileResult = {
          ...response.spec,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(symbol ? { symbol } : {}),
          ...(timeframe ? { timeframe } : {}),
        };
        await createStrategy({ spec, engine: response.meta.engine ?? "heuristic" });
      }
      reset();
      onClose();
    } catch (error) {
      notify({
        kind: "error",
        title: "Could not create the strategy",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <div className="flex items-center gap-2">
          <Wand2 size={16} className="text-forge-amber" />
          Strategy Creator
        </div>
      }
    >
      <div className="mb-4 flex gap-1 rounded-lg border border-white/[0.06] bg-ink-950/60 p-1">
        {(
          [
            { id: "describe", label: "Video / Text", icon: Type },
            { id: "json", label: "JSON Spec", icon: FileJson },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={cx(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition",
                tab === item.id
                  ? "bg-white/[0.08] text-white"
                  : "text-white/45 hover:text-white/75",
              )}
            >
              <Icon size={14} />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "describe" ? (
        <div className="space-y-4">
          <div>
            <label className="label">Video URL (YouTube / TikTok / Facebook)</label>
            <div className="relative">
              <Link2
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
              />
              <input
                className="input pl-9"
                placeholder="https://www.youtube.com/watch?v=..."
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-white/40">
              {platform.type === "youtube" ? (
                <Badge tone="rose">
                  <Youtube size={11} /> {platform.label}
                </Badge>
              ) : platform.type === "tiktok" ? (
                <Badge tone="cyan">{platform.label}</Badge>
              ) : null}
              <span>
                No transcript fetcher is bundled — paste the transcript below for a faithful
                transpile.
              </span>
            </div>
          </div>

          <div>
            <label className="label">Strategy description / video title</label>
            <textarea
              className="input min-h-[92px] resize-y"
              placeholder="Buy XAUUSD when the 12 EMA crosses above the 26 EMA during the London session, 2 ATR stop, 2.5R target, risk 0.5% per trade."
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>

          <div>
            <label className="label">
              Transcript <span className="font-normal normal-case text-white/25">(optional)</span>
            </label>
            <textarea
              className="input min-h-[76px] resize-y"
              placeholder="Paste the video transcript here to override the short description above."
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
            />
          </div>

          <div className="panel flex items-start gap-3 p-3">
            <div
              className={cx(
                "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                noLlm ? "bg-forge-cyan/15 text-forge-cyan" : "bg-forge-violet/15 text-forge-violet",
              )}
            >
              {noLlm ? <Cpu size={15} /> : <Sparkles size={15} />}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-white">No-LLM Mode</span>
                <button
                  onClick={() => setNoLlm(!noLlm)}
                  className={cx(
                    "relative inline-flex h-5 w-9 items-center rounded-full transition",
                    noLlm ? "bg-forge-cyan/80" : "bg-white/15",
                  )}
                >
                  <span
                    className={cx(
                      "inline-block h-4 w-4 transform rounded-full bg-white transition",
                      noLlm ? "translate-x-4" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-white/45">
                {noLlm
                  ? "The local statistical transpiler parses your text — no API key, no token spend, works fully offline."
                  : llmReady
                    ? "An LLM provider is configured and will compile the spec. Falls back to the local transpiler if the call fails."
                    : "No LLM provider configured yet. Add OPENAI_API_KEY or a reachable OLLAMA_URL in Settings — until then the local transpiler runs."}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.06] bg-ink-950/50">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-medium text-white/60 hover:text-white"
            >
              Overrides (name, symbol, timeframe)
              <span className="text-white/30">{showAdvanced ? "−" : "+"}</span>
            </button>
            {showAdvanced ? (
              <div className="grid gap-3 border-t border-white/[0.06] p-3 sm:grid-cols-3">
                <div>
                  <label className="label">Name</label>
                  <input
                    className="input"
                    placeholder="Auto-generated"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Symbol</label>
                  <select
                    className="input"
                    value={symbol}
                    onChange={(event) => setSymbol(event.target.value)}
                  >
                    <option value="">Auto-detect</option>
                    {SYMBOLS.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Timeframe</label>
                  <select
                    className="input"
                    value={timeframe}
                    onChange={(event) => setTimeframe(event.target.value)}
                  >
                    <option value="">Auto-detect</option>
                    {TIMEFRAMES.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-ghost text-[12px]"
              onClick={() => setJsonText(JSON.stringify(SAMPLE_SPEC, null, 2))}
            >
              Load sample spec
            </button>
            <button
              className="btn-ghost text-[12px]"
              onClick={() => {
                navigator.clipboard?.writeText(PROMPT_TEMPLATE);
                notify({
                  kind: "info",
                  title: "Prompt template copied",
                  detail: "Paste it into any LLM, then drop the JSON reply here.",
                });
              }}
            >
              <ClipboardCopy size={13} /> Copy LLM prompt template
            </button>
            <span className="text-[11px] text-white/35">
              No API key? Generate the spec in any chat model and paste it here.
            </span>
          </div>

          <textarea
            className={cx(
              "input min-h-[300px] resize-y font-mono text-[12px] leading-relaxed",
              jsonText && !validation.ok && "border-forge-rose/50",
              jsonText && validation.ok && "border-forge-mint/50",
            )}
            placeholder={'{\n  "name": "London Breakout — XAUUSD",\n  "symbol": "XAUUSD",\n  "timeframe": "H1",\n  "entries": [{"indicator": "ema_cross", "params": {"fast": 12, "slow": 26}}]\n}'}
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
          />

          {jsonText.trim() ? (
            <div className="space-y-1.5">
              {validation.errors.map((error) => (
                <div
                  key={error}
                  className="flex items-start gap-2 rounded-md border border-forge-rose/25 bg-forge-rose/[0.07] px-3 py-2 text-[12px] text-forge-rose"
                >
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {error}
                </div>
              ))}
              {validation.warnings.map((warning) => (
                <div
                  key={warning}
                  className="rounded-md border border-forge-amber/25 bg-forge-amber/[0.07] px-3 py-2 text-[12px] text-forge-amber"
                >
                  {warning}
                </div>
              ))}
              {validation.ok ? (
                <div className="rounded-md border border-forge-mint/25 bg-forge-mint/[0.07] px-3 py-2 text-[12px] text-forge-mint">
                  Valid spec — {validation.spec?.name} · {validation.spec?.symbol}{" "}
                  {validation.spec?.timeframe} · {validation.spec?.rules.entries.length} entry rule(s)
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="text-[11px] text-white/35">
          {tab === "json"
            ? "Validated against the engine schema before anything is stored."
            : noLlm
              ? "Parsed locally — nothing leaves your browser."
              : "Uses the configured LLM provider when available."}
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={forge} disabled={busy}>
            {busy ? <Spinner /> : <Wand2 size={15} />}
            Forge strategy
          </button>
        </div>
      </div>
    </Modal>
  );
}
