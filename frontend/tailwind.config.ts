import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#06070c",
          900: "#0a0c14",
          850: "#0e111b",
          800: "#141824",
          700: "#1c2130",
          600: "#2a3142",
          500: "#3d465c",
        },
        forge: {
          amber: "#f0b429",
          ember: "#ff6b35",
          mint: "#2dd4a7",
          cyan: "#38bdf8",
          violet: "#a78bfa",
          rose: "#fb7185",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(240,180,41,0.25), 0 8px 30px -12px rgba(240,180,41,0.35)",
        panel: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 40px -30px rgba(0,0,0,0.9)",
      },
      keyframes: {
        pulseline: {
          "0%,100%": { opacity: "0.35" },
          "50%": { opacity: "1" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        pulseline: "pulseline 2.2s ease-in-out infinite",
        slideUp: "slideUp 0.18s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
