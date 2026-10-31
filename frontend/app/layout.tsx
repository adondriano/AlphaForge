import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AlphaForgeProvider } from "@/components/AlphaForgeProvider";
import Nav from "@/components/Nav";
import Toaster from "@/components/Toaster";

export const metadata: Metadata = {
  title: "AlphaForge — AI Quantitative Strategy Studio",
  description:
    "Transpile trading ideas into executable strategies, optimise parameters with Bayesian search and execute inside a prop-firm risk envelope.",
};

export const viewport: Viewport = {
  themeColor: "#06070c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <AlphaForgeProvider>
          <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-4 pb-16 sm:px-6">
            <Nav />
            <main className="flex-1">{children}</main>
            <footer className="mt-12 border-t border-white/5 pt-6 text-xs text-white/35">
              AlphaForge MVP · deterministic backtest core · Optuna parameter search ·
              Prop-Firm Shield enforces a 3.5% daily and 5% total drawdown cap.
            </footer>
          </div>
          <Toaster />
        </AlphaForgeProvider>
      </body>
    </html>
  );
}
