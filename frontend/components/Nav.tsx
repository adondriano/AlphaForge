"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Flame, Settings, SlidersHorizontal, Database, Cpu } from "lucide-react";

import { useAlphaForge } from "./AlphaForgeProvider";
import { cx } from "./ui";

const LINKS = [
  { href: "/", label: "Command Center", icon: Activity },
  { href: "/studio", label: "Strategy Studio", icon: SlidersHorizontal },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Nav() {
  const pathname = usePathname();
  const { engineStatus, storeMode } = useAlphaForge();

  return (
    <header className="sticky top-0 z-40 -mx-4 mb-6 border-b border-white/5 bg-ink-950/80 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-forge-amber to-forge-ember text-ink-950">
            <Flame className="h-4.5 w-4.5" size={18} />
          </span>
          <span className="text-[15px] font-bold tracking-tight text-white">
            Alpha<span className="text-forge-amber">Forge</span>
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {LINKS.map((link) => {
            const Icon = link.icon;
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cx(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition",
                  active
                    ? "bg-white/[0.07] text-white"
                    : "text-white/50 hover:bg-white/[0.04] hover:text-white/80",
                )}
              >
                <Icon size={15} />
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className="chip border-white/10 bg-white/[0.04] text-white/60"
            title={engineStatus.detail}
          >
            <Cpu size={12} className={engineStatus.mode === "python" ? "text-forge-mint" : "text-forge-cyan"} />
            {engineStatus.label}
          </span>
          <span
            className="chip border-white/10 bg-white/[0.04] text-white/60"
            title={
              storeMode === "supabase"
                ? "Supabase connected — realtime updates streaming"
                : "No Supabase credentials — data is stored in this browser"
            }
          >
            <Database size={12} className={storeMode === "supabase" ? "text-forge-mint" : "text-white/40"} />
            {storeMode === "supabase" ? "Supabase live" : "Local storage"}
          </span>
          <span className="chip border-forge-amber/25 bg-forge-amber/10 text-forge-amber">
            <span className="h-1.5 w-1.5 animate-pulseline rounded-full bg-forge-amber" />
            Shield 3.5 / 5.0%
          </span>
        </div>
      </div>
    </header>
  );
}
