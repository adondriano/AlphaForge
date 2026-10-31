"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, Sparkles } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { cx } from "./ui";

export default function AuthScreen({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const { signIn, signUp, configured, user, ready } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isRegister = mode === "register";

  // Already signed in? Go straight to the studio.
  useEffect(() => {
    if (ready && user) router.replace("/");
  }, [ready, user, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    if (isRegister && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      if (isRegister) {
        const outcome = await signUp(email.trim(), password);
        if (!outcome.ok) {
          setError(outcome.error ?? "Registration failed.");
        } else if (outcome.needsConfirmation) {
          setNotice(
            `Account created. Check ${email.trim()} for a confirmation link before signing in.`,
          );
        } else {
          router.replace("/");
        }
      } else {
        const outcome = await signIn(email.trim(), password);
        if (!outcome.ok) setError(outcome.error ?? "Sign in failed.");
        else router.replace("/");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center py-10 sm:py-20">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-forge-amber/30 bg-forge-amber/10">
          <Sparkles className="h-6 w-6 text-forge-amber" />
        </div>
        <h1 className="text-2xl font-semibold text-white">
          {isRegister ? "Create your studio" : "Welcome back"}
        </h1>
        <p className="mt-1.5 text-sm text-white/45">
          {isRegister
            ? "Your strategies, parameter lineage and trade log are private to your account."
            : "Sign in to create strategies, run optimizations and trade."}
        </p>
      </div>

      <div className="panel p-6">
        {!configured ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-100">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Supabase is not configured, so accounts are unavailable. Set
              <code className="mx-1 rounded bg-black/30 px-1">NEXT_PUBLIC_SUPABASE_URL</code> and
              <code className="mx-1 rounded bg-black/30 px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
              in Settings (or your environment) to enable sign in.
            </span>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/40">
              Email
            </span>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-white/25 focus:border-forge-amber/50 focus:outline-none"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/40">
              Password
            </span>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <input
                type={showPassword ? "text" : "password"}
                autoComplete={isRegister ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-10 text-sm text-white placeholder:text-white/25 focus:border-forge-amber/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 transition hover:text-white/70"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>

          {isRegister ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/40">
                Confirm password
              </span>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-white/25 focus:border-forge-amber/50 focus:outline-none"
                />
              </div>
            </label>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2.5 text-xs text-rose-100">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {notice ? (
            <div className="rounded-lg border border-mint-400/25 bg-mint-400/10 px-3 py-2.5 text-xs text-mint-100">
              {notice}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy || !configured}
            className={cx(
              "flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition",
              busy || !configured
                ? "cursor-not-allowed bg-white/10 text-white/40"
                : "bg-forge-amber text-black hover:brightness-110",
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isRegister ? "Create account" : "Sign in"}
            {!busy ? <ArrowRight className="h-4 w-4" /> : null}
          </button>
        </form>

        <div className="mt-5 border-t border-white/8 pt-4 text-center text-xs text-white/45">
          {isRegister ? "Already have an account? " : "New to AlphaForge? "}
          <Link
            href={isRegister ? "/login" : "/register"}
            className="font-medium text-forge-amber hover:underline"
          >
            {isRegister ? "Sign in" : "Create an account"}
          </Link>
        </div>
      </div>

      <div className="mt-5 text-center">
        <Link href="/" className="text-xs text-white/35 hover:text-white/70">
          Continue as a read-only guest →
        </Link>
        <p className="mt-2 text-[11px] leading-relaxed text-white/25">
          Guests can browse every strategy and its parameter lineage. Creating, optimizing and
          trading need an account.
        </p>
      </div>
    </div>
  );
}
