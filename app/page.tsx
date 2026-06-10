"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Bot,
  Clock,
  Cpu,
  Gauge,
  HardDrive,
  Package,
  Play,
  Radio,
  RotateCcw,
  ShieldAlert,
  Terminal,
  TriangleAlert,
  Waves,
  Zap,
} from "lucide-react";

/* ============================================================
   Types + status model (stable | warning | critical)
   ============================================================ */

type TwinStatus = "stable" | "warning" | "critical";

type TelemetryPoint = {
  index: number;
  actual: number;
  prediction: number;
  mse: number;
};

type AgentState = {
  state: "idle" | "thinking" | "ready";
  log: string[];
  vendor?: string;
  leadTimeDays?: number;
};

/* ---- Simulation tuning (mirrors firmware statistical baseline) ----
   Baseline MSE distribution: mean mu = 0.15, sigma = 0.04.
   warning threshold = mu + 3 sigma = 0.27
   critical threshold = mu + 6 sigma = 0.39                              */
const SIM_MEAN = 0.15;
const SIM_SIGMA = 0.04;
const WARN_THRESHOLD = SIM_MEAN + 3 * SIM_SIGMA; // 0.27
const CRIT_THRESHOLD = SIM_MEAN + 6 * SIM_SIGMA; // 0.39

const TICK_MS = 400; // simulated live feed cadence
const HISTORY = 20; // last 20 calculation windows kept on the rolling chart
const PHASE_STEP = 0.62; // carrier advance per tick

type Theme = {
  accent: string;
  rgb: string;
  text: string;
  border: string;
  bg: string;
  dot: string;
  bar: string;
  label: string;
};

const THEME: Record<TwinStatus, Theme> = {
  stable: {
    accent: "#22c55e",
    rgb: "34,197,94",
    text: "text-emerald-200",
    border: "border-emerald-400/30",
    bg: "bg-emerald-400/[.06]",
    dot: "bg-emerald-400",
    bar: "bg-emerald-400",
    label: "STABLE",
  },
  warning: {
    accent: "#f59e0b",
    rgb: "245,158,11",
    text: "text-amber-200",
    border: "border-amber-400/40",
    bg: "bg-amber-400/[.07]",
    dot: "bg-amber-400",
    bar: "bg-amber-400",
    label: "WARNING",
  },
  critical: {
    accent: "#ff1f3d",
    rgb: "255,31,61",
    text: "text-red-200",
    border: "border-red-500/60",
    bg: "bg-red-950/25",
    dot: "bg-red-500",
    bar: "bg-red-500",
    label: "CRITICAL",
  },
};

// Dead/frozen look (kept for completeness; the simulation runs always-live).
const OFFLINE_THEME: Theme = {
  accent: "#52525b",
  rgb: "82,82,91",
  text: "text-zinc-500",
  border: "border-zinc-700/50",
  bg: "bg-zinc-800/20",
  dot: "bg-zinc-600",
  bar: "bg-zinc-700",
  label: "OFFLINE",
};

const BANNER: Record<TwinStatus, string> = {
  stable: "SYSTEM BOUNDS: STABLE — Continuous Edge Tracking Active",
  warning: "WARNING: Micro-friction detected. Predictive baseline diverging.",
  critical: "CRITICAL: FAULT DETECTED. RELAY TRIPPED — Agentic logistics engaged.",
};

/* ============================================================
   Self-contained simulation engine
   ------------------------------------------------------------
   Replaces the live hardware WebSocket. A 400ms interval ticks a
   state-driven MSE + waveform feed; judges drive it with buttons.
   ============================================================ */

// Cheap approximate Gaussian (sum of 6 uniforms), ~N(0, 0.71).
function gauss() {
  let s = 0;
  for (let i = 0; i < 6; i++) s += Math.random();
  return s - 3;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// MSE for the current mode, honoring the mu/sigma threshold bands.
function mseFor(mode: TwinStatus): number {
  if (mode === "warning") {
    // 3-sigma territory: 0.27 .. 0.38
    return clamp(0.31 + gauss() * 0.03, WARN_THRESHOLD + 0.005, 0.382);
  }
  if (mode === "critical") {
    // Past the 6-sigma latch: 0.40 .. ~0.75
    return clamp(0.48 + Math.abs(gauss()) * 0.12, CRIT_THRESHOLD + 0.01, 0.78);
  }
  // Normal: fluctuates tightly below the warning threshold.
  return clamp(SIM_MEAN + gauss() * SIM_SIGMA, 0.06, WARN_THRESHOLD - 0.012);
}

// One waveform sample (actual reality vs the clean 1.58-bit prediction).
function sampleFor(mode: TwinStatus, phase: number): { actual: number; prediction: number } {
  // The learned healthy model always predicts the same calm carrier.
  const prediction = 0.42 * Math.sin(phase);

  if (mode === "warning") {
    return { actual: 0.55 * Math.sin(phase * 1.1) + gauss() * 0.17, prediction };
  }
  if (mode === "critical") {
    // Motor seizing: violent amplitude + random structural spikes.
    const spike = Math.random() < 0.32 ? (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 0.8) : 0;
    return { actual: 1.25 * Math.sin(phase * 0.6) + gauss() * 0.5 + spike, prediction };
  }
  // Normal: actual tracks the prediction tightly.
  return { actual: prediction + gauss() * 0.05, prediction };
}

function seedHistory(): TelemetryPoint[] {
  const pts: TelemetryPoint[] = [];
  for (let i = 0; i < HISTORY; i++) {
    const phase = i * PHASE_STEP;
    const { actual, prediction } = sampleFor("stable", phase);
    pts.push({ index: i, actual, prediction, mse: mseFor("stable") });
  }
  return pts;
}

function useSimulation() {
  const [status, setStatus] = useState<TwinStatus>("stable");
  // Start empty so the server-prerendered HTML (deterministic flat baseline)
  // matches the first client render. Random seed is injected after mount only,
  // otherwise SSR vs client random values cause a hydration mismatch (#418).
  const [data, setData] = useState<TelemetryPoint[]>([]);
  const [agent, setAgent] = useState<AgentState>({ state: "idle", log: [] });

  const modeRef = useRef<TwinStatus>("stable");
  const phaseRef = useRef(HISTORY * PHASE_STEP);
  const idxRef = useRef(HISTORY);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    modeRef.current = status;
  }, [status]);

  // Seed the rolling history once, on the client, after hydration.
  useEffect(() => {
    setData(seedHistory());
  }, []);

  // Live data feed — ticks regardless of mode so the platform always looks monitored.
  useEffect(() => {
    const id = window.setInterval(() => {
      const mode = modeRef.current;
      phaseRef.current += PHASE_STEP;
      const { actual, prediction } = sampleFor(mode, phaseRef.current);
      const point: TelemetryPoint = {
        index: idxRef.current++,
        actual,
        prediction,
        mse: mseFor(mode),
      };
      setData((prev) => [...prev, point].slice(-HISTORY));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const clearChain = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  // Staggered Llama-3 procurement log on a critical trip.
  const runAgent = useCallback(() => {
    clearChain();
    setAgent({ state: "thinking", log: [] });
    const push = (line: string, delay: number) => {
      const t = window.setTimeout(() => {
        setAgent((prev) => ({ ...prev, log: [...prev.log, line] }));
      }, delay);
      timers.current.push(t);
    };
    push("[SYSTEM] 4ms Core Latch Triggered. Hardware rails killed on GPIO13.", 350);
    push("[AGENT] Initializing Llama-3 procurement agent...", 1300);
    push("[AGENT] Context matching complete: Plant 4 Spindle Motor component fault confirmed.", 2500);
    const last = window.setTimeout(() => {
      setAgent((prev) => ({
        state: "ready",
        log: [
          ...prev.log,
          "PURCHASE ORDER GENERATED: PO-2026-993A. Item: High-Load Spindle Ball Bearing (Qty: 1). Routed to SAP ERP queue.",
        ],
        vendor: "Konkan Precision · Mumbai",
        leadTimeDays: 1,
      }));
    }, 3900);
    timers.current.push(last);
  }, [clearChain]);

  const goNormal = useCallback(() => {
    clearChain();
    setAgent({ state: "idle", log: [] });
    setStatus("stable");
  }, [clearChain]);

  const goWarning = useCallback(() => {
    clearChain();
    setAgent({ state: "idle", log: [] });
    setStatus("warning");
  }, [clearChain]);

  const goCritical = useCallback(() => {
    setStatus("critical");
    runAgent();
  }, [runAgent]);

  const reset = useCallback(() => {
    clearChain();
    setAgent({ state: "idle", log: [] });
    phaseRef.current = HISTORY * PHASE_STEP;
    idxRef.current = HISTORY;
    setData(seedHistory());
    setStatus("stable");
  }, [clearChain]);

  useEffect(() => () => clearChain(), [clearChain]);

  return { status, data, agent, goNormal, goWarning, goCritical, reset };
}

/* ============================================================
   Uptime ticker
   ============================================================ */

function useUptime() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return seconds;
}

function formatUptime(total: number) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ============================================================
   Physical Digital Twin — code-generated CNC spindle SVG
   ============================================================ */

function PhysicalDigitalTwin({ status, live }: { status: TwinStatus; live: boolean }) {
  const critical = live && status === "critical";
  const warning = live && status === "warning";
  const theme = live ? THEME[status] : OFFLINE_THEME;

  const hub = { x: 595, y: 250 };
  const sparkAngles = [18, 52, 96, 140, 184, 228, 272, 316];

  const rpm = !live ? 0 : critical ? 0 : warning ? 9400 : 24000;

  return (
    <section
      className={`bf-twin relative h-full min-h-[620px] overflow-hidden rounded-[8px] border bg-[#030303] p-6 shadow-[0_42px_120px_rgba(0,0,0,.82)] ${
        !live
          ? "bf-offline border-zinc-800/70 opacity-80 grayscale"
          : critical
            ? "bf-critical critical-flash border-red-500/60"
            : warning
              ? "bf-warning border-amber-500/40"
              : "border-zinc-700/45"
      }`}
      style={{ "--bf-accent": theme.accent } as React.CSSProperties}
      data-status={live ? status : "offline"}
    >
      <div className="bit-grid absolute inset-0 opacity-70" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,.035),transparent_22%,rgba(0,0,0,.2))]" />
      {critical && (
        <div className="alert-overlay pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_62%_50%,rgba(255,31,61,.30),transparent_46%)]" />
      )}

      <div className="relative z-10 flex h-full flex-col justify-between">
        {/* Header + relay badge */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-zinc-500">Physical Digital Twin</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal text-zinc-50">Line 3 Spindle CNC Assembly</h2>
            <p className="mt-1 text-sm font-medium text-zinc-500">
              {!live ? "— RPM · LINK DOWN" : `${rpm.toLocaleString()} RPM · ${critical ? "rotor halted" : warning ? "degraded" : "nominal"}`}
            </p>
          </div>
          <div
            className={`rounded-[8px] border px-4 py-3 text-right ${
              !live ? `${theme.border} ${theme.bg}` : critical ? "critical-flash border-red-500/80 bg-red-950/20" : `stable-pulse ${theme.border} ${theme.bg}`
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">Relay State</p>
            <p className={`mt-1 text-sm font-bold ${theme.text}`}>
              {!live ? "OFFLINE" : critical ? "ENERGIZED · TRIPPED" : warning ? "ARMED" : "DE-ENERGIZED"}
            </p>
          </div>
        </div>

        {/* The machine */}
        <div className={`gpu relative mx-auto w-full max-w-[960px] ${critical ? "critical-shake" : ""}`}>
          <div
            className="absolute -inset-7 rounded-[8px] blur-2xl"
            style={{ background: `rgba(${theme.rgb},${critical ? 0.22 : warning ? 0.12 : 0.07})` }}
          />

          {/* RELAY TRIPPED warning badge */}
          {critical && (
            <div className="bf-relay-badge pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2">
              <div className="flex items-center gap-2 rounded-[6px] border border-red-400/80 bg-red-950/70 px-4 py-2 shadow-[0_0_40px_rgba(255,31,61,.65)] backdrop-blur-sm">
                <ShieldAlert size={18} className="text-red-300" />
                <span className="text-sm font-black uppercase tracking-[0.18em] text-red-100">Relay Tripped — Power Cut</span>
              </div>
            </div>
          )}

          <div
            className={`relative h-[380px] overflow-hidden rounded-[8px] border bg-zinc-950/90 shadow-[0_48px_100px_rgba(0,0,0,.78),inset_0_1px_0_rgba(255,255,255,.08)] ${
              critical ? "border-red-500/50" : warning ? "border-amber-500/40" : "border-zinc-600/45"
            }`}
          >
            <svg
              viewBox="0 0 920 460"
              className="absolute inset-0 h-full w-full"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`Industrial CNC spindle digital twin, status ${status}`}
            >
              <defs>
                <linearGradient id="bfSteel" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#3f3f46" />
                  <stop offset="0.18" stopColor="#52525b" />
                  <stop offset="0.5" stopColor="#27272a" />
                  <stop offset="0.82" stopColor="#18181b" />
                  <stop offset="1" stopColor="#09090b" />
                </linearGradient>
                <linearGradient id="bfSteelLight" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#71717a" />
                  <stop offset="0.5" stopColor="#3f3f46" />
                  <stop offset="1" stopColor="#1c1c1f" />
                </linearGradient>
                <radialGradient id="bfHub" cx="0.4" cy="0.35" r="0.8">
                  <stop offset="0" stopColor="#6b7280" />
                  <stop offset="0.55" stopColor="#2c2c33" />
                  <stop offset="1" stopColor="#0a0a0c" />
                </radialGradient>
                <linearGradient id="bfShaft" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#a1a1aa" />
                  <stop offset="0.5" stopColor="#52525b" />
                  <stop offset="1" stopColor="#27272a" />
                </linearGradient>
                <filter id="bfGlow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="4" result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* ---- Foundation ---- */}
              <g className="bf-static">
                <rect x="70" y="372" width="640" height="34" rx="5" fill="url(#bfSteelLight)" stroke="#000" strokeWidth="1.5" />
                <rect x="70" y="372" width="640" height="6" rx="3" fill="#71717a" opacity="0.5" />
                {[120, 250, 380, 510, 640].map((bx) => (
                  <circle key={bx} cx={bx} cy={389} r={5} fill="#18181b" stroke="#52525b" strokeWidth="1.4" />
                ))}
                <path d="M150 300 L200 300 L215 372 L135 372 Z" fill="url(#bfSteel)" stroke="#000" strokeWidth="1.5" />
                <path d="M430 300 L480 300 L495 372 L415 372 Z" fill="url(#bfSteel)" stroke="#000" strokeWidth="1.5" />
              </g>

              {/* ---- Motor housing ---- */}
              <g className="bf-static">
                <rect x="120" y="150" width="350" height="190" rx="16" fill="url(#bfSteel)" stroke="#000" strokeWidth="2" />
                <rect x="132" y="158" width="326" height="10" rx="5" fill="#71717a" opacity="0.45" />
                {Array.from({ length: 11 }, (_, i) => (
                  <line key={i} x1={150 + i * 28} y1={172} x2={150 + i * 28} y2={320} stroke="#09090b" strokeWidth="4" opacity="0.7" />
                ))}
                <rect x="210" y="108" width="120" height="48" rx="6" fill="url(#bfSteelLight)" stroke="#000" strokeWidth="1.8" />
                <circle cx="240" cy="132" r="5" className="bf-led" />
                <circle cx="262" cy="132" r="5" fill="#27272a" stroke="#52525b" strokeWidth="1" />
                <rect x="160" y="225" width="120" height="44" rx="4" fill="#0c0c0e" stroke="#3f3f46" strokeWidth="1.4" />
                <text x="220" y="244" textAnchor="middle" fontSize="13" fontWeight="700" letterSpacing="2" fill="#71717a">
                  BIT-FORGE
                </text>
                <text x="220" y="260" textAnchor="middle" fontSize="9" letterSpacing="2" fill="#52525b">
                  3.5kW · 24000 RPM
                </text>
              </g>

              {/* ---- Bearing housing (fault zone) ---- */}
              <g className="bf-static">
                <rect x="462" y="200" width="40" height="100" rx="6" fill="url(#bfSteelLight)" stroke="#000" strokeWidth="1.5" />
                <circle cx={hub.x} cy={hub.y} r="108" fill="url(#bfSteel)" stroke="#000" strokeWidth="2.5" />
                <circle cx={hub.x} cy={hub.y} r="108" fill="none" stroke="#71717a" strokeWidth="1" opacity="0.35" />
                {Array.from({ length: 8 }, (_, i) => {
                  const a = (i / 8) * Math.PI * 2;
                  return (
                    <circle key={i} cx={hub.x + Math.cos(a) * 92} cy={hub.y + Math.sin(a) * 92} r={6} fill="#0a0a0c" stroke="#52525b" strokeWidth="1.5" />
                  );
                })}
                <circle cx={hub.x} cy={hub.y} r="78" fill="#0c0c0e" stroke="#3f3f46" strokeWidth="2" />
              </g>

              {/* ---- Rotor (SPINS; slows on warning, freezes on critical) ---- */}
              <g className="bf-rotor" style={{ transformBox: "fill-box", transformOrigin: "center" }}>
                <g transform={`translate(${hub.x} ${hub.y})`}>
                  <circle r="70" fill="url(#bfHub)" stroke="#000" strokeWidth="1.5" />
                  {Array.from({ length: 6 }, (_, i) => {
                    const a = (i / 6) * 360;
                    return (
                      <rect key={i} x="-6" y="-66" width="12" height="56" rx="4" fill="#3f3f46" stroke="#18181b" strokeWidth="1" transform={`rotate(${a})`} />
                    );
                  })}
                  <circle r="34" fill="#1c1c1f" stroke="#000" strokeWidth="1.5" />
                  <circle r="34" className="bf-accent-ring" fill="none" strokeWidth="3" strokeDasharray="10 8" />
                  <circle r="14" fill="url(#bfSteelLight)" stroke="#000" strokeWidth="1.5" />
                  <rect x="-3" y="-15" width="6" height="8" fill="#09090b" />
                </g>
              </g>

              {/* ---- Drive shaft + collet ---- */}
              <g className="bf-static">
                <rect x="665" y="236" width="150" height="28" rx="6" fill="url(#bfShaft)" stroke="#000" strokeWidth="1.5" />
                <g className="bf-shaft-bands">
                  {Array.from({ length: 9 }, (_, i) => (
                    <line key={i} x1={678 + i * 16} y1={238} x2={678 + i * 16} y2={262} stroke="#18181b" strokeWidth="2" opacity="0.6" />
                  ))}
                </g>
                <path d="M815 230 L860 240 L860 260 L815 270 Z" fill="url(#bfSteelLight)" stroke="#000" strokeWidth="1.5" />
                <path d="M860 244 L885 248 L885 252 L860 256 Z" fill="#71717a" stroke="#000" strokeWidth="1" />
              </g>

              {/* ---- Data flow lines (accent; flat-line + flash on fault) ---- */}
              <g className="bf-data" filter="url(#bfGlow)">
                <path className="bf-flow" d="M330 108 C 330 70, 470 70, 560 70 L 880 70" fill="none" strokeWidth="2.5" strokeLinecap="round" />
                <path className="bf-flow bf-flow-2" d="M595 142 C 595 110, 720 110, 820 110 L 880 110" fill="none" strokeWidth="2" strokeLinecap="round" />
                <circle cx="880" cy="70" r="4" className="bf-accent-fill" />
                <circle cx="880" cy="110" r="3" className="bf-accent-fill" />
              </g>

              {/* ---- FAULT FX: shock rings + glitch + sparks ---- */}
              {critical && (
                <g className="bf-fault" transform={`translate(${hub.x} ${hub.y})`}>
                  {[0, 1, 2].map((i) => (
                    <circle key={i} r="78" fill="none" stroke="#ff1f3d" strokeWidth="3" className="bf-ring" style={{ animationDelay: `${i * 0.5}s` }} />
                  ))}
                  <path
                    className="bf-glitch"
                    d="M-120 0 L-90 -22 L-60 14 L-34 -30 L-8 20 L18 -26 L46 16 L74 -24 L104 18 L130 0"
                    fill="none"
                    stroke="#ff8a3d"
                    strokeWidth="2.5"
                    strokeLinejoin="round"
                  />
                  {sparkAngles.map((deg, i) => {
                    const a = (deg * Math.PI) / 180;
                    return (
                      <line
                        key={i}
                        x1={Math.cos(a) * 72}
                        y1={Math.sin(a) * 72}
                        x2={Math.cos(a) * 108}
                        y2={Math.sin(a) * 108}
                        stroke={i % 2 ? "#ffb347" : "#ff1f3d"}
                        strokeWidth="3"
                        strokeLinecap="round"
                        className="bf-spark"
                        style={{ animationDelay: `${(i % 4) * 0.12}s` }}
                      />
                    );
                  })}
                  <circle r="34" fill="#ff1f3d" className="bf-core-flash" />
                </g>
              )}
            </svg>
          </div>
        </div>

        {/* Edge firmware metrics — real constants from firmware/main/main.ino */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Inference Loop", value: "4.0 ms", note: "SAMPLE_INTERVAL_MS" },
            { label: "Gatekeeper Status", value: critical ? "Latched" : "5 / 5 Windows", note: "CRIT_PERSIST_WINDOWS" },
            { label: "Serial Baud", value: "921600 bps", note: "BAUD_RATE" },
          ].map(({ label, value, note }) => (
            <div key={label} className="depth-panel rounded-[8px] px-4 py-3">
              <div className="flex items-center gap-3">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${theme.dot}`}
                  style={live ? { boxShadow: `0 0 18px rgba(${theme.rgb},.7)` } : undefined}
                />
                <span className={`text-sm font-semibold ${live ? "text-zinc-200" : "text-zinc-600"}`}>{label}</span>
              </div>
              <div className="mt-2.5">
                <div
                  className={`font-mono text-lg font-bold tabular-nums ${live ? theme.text : "text-zinc-600"}`}
                  style={live && critical && label === "Gatekeeper Status" ? { textShadow: `0 0 18px rgba(${theme.rgb},.7)` } : undefined}
                >
                  {live ? value : "--"}
                </div>
                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600">{note}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   Autonomous logistics agent terminal (mock staggered log)
   ============================================================ */

function agentLineClass(line: string): string {
  if (line.startsWith("[SYSTEM]")) return "text-red-300";
  if (line.startsWith("PURCHASE ORDER")) return "font-bold text-emerald-300";
  return "text-emerald-100/90";
}

function AgentTerminal({ status, agent, live }: { status: TwinStatus; agent: AgentState; live: boolean }) {
  const open = live && status === "critical";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ duration: 0.25 }}
          className="flex-none"
        >
          <div className="critical-flash rounded-[8px] border border-red-500/60 bg-[#0a0406]/95 p-4 shadow-[0_0_50px_rgba(255,31,61,.3)]">
            <div className="mb-3 flex items-center justify-between border-b border-red-500/20 pb-2">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-red-300" />
                <span className="text-xs font-black uppercase tracking-[0.2em] text-red-200">Autonomous Logistics Agent</span>
              </div>
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                <Bot size={13} />
                llama-3 · rtx 3060
              </span>
            </div>

            <div className="min-h-[120px] max-h-[200px] overflow-y-auto pr-1 font-mono text-[12.5px] leading-relaxed">
              {agent.log.map((line, i) => (
                <motion.p
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18 }}
                  className={`mb-1 flex gap-2 ${agentLineClass(line)}`}
                >
                  <span className="select-none text-red-400">$</span>
                  <span className="flex items-start gap-1.5">
                    {line.startsWith("PURCHASE ORDER") && <Package size={14} className="mt-0.5 shrink-0 text-emerald-300" />}
                    <span>{line}</span>
                  </span>
                </motion.p>
              ))}
              {agent.state !== "ready" && (
                <div className="mt-1 flex items-center gap-3 text-zinc-400">
                  <span className="bf-spinner h-4 w-4 rounded-full border-2 border-red-500/30 border-t-red-400" />
                  <span className="bf-blink">Llama-3 analyzing factory inventory &amp; approved suppliers…</span>
                </div>
              )}
            </div>

            {agent.state === "ready" && (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-red-500/15 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em]">
                {agent.vendor && (
                  <span className="rounded-[5px] border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-emerald-200">
                    Vendor: {agent.vendor}
                  </span>
                )}
                {typeof agent.leadTimeDays === "number" && (
                  <span className="rounded-[5px] border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-cyan-200">
                    ETA: {agent.leadTimeDays} day(s)
                  </span>
                )}
                <span className="rounded-[5px] border border-red-400/30 bg-red-500/10 px-2.5 py-1 text-red-200">PO auto-drafted → SAP ERP</span>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================================================
   Telemetry monitor (chart + readouts)
   ============================================================ */

function StatusBanner({ status, live }: { status: TwinStatus; live: boolean }) {
  const critical = live && status === "critical";
  const theme = live ? THEME[status] : OFFLINE_THEME;
  const Icon = !live ? Radio : critical ? ShieldAlert : status === "warning" ? TriangleAlert : Radio;
  const message = live ? BANNER[status] : "SYSTEM OFFLINE — simulation halted";
  return (
    <div
      className={`rounded-[8px] border px-5 py-4 ${
        !live ? `${theme.border} ${theme.bg}` : critical ? "critical-flash border-red-500/80 bg-red-950/25" : `stable-pulse ${theme.border} ${theme.bg}`
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`rounded-[8px] p-2 ${theme.bg} ${theme.text}`}>
          <Icon size={22} />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">System Status</p>
          <p className={`mt-1 text-base font-black tracking-normal ${theme.text}`}>{message}</p>
        </div>
      </div>
    </div>
  );
}

// Per-state visual envelope. `domain` = vertical zoom, `clamp` = hard amplitude
// cap so spikes can't blow out the panel.
const WAVE_ENVELOPE: Record<TwinStatus, { domain: number; clamp: number }> = {
  stable: { domain: 0.9, clamp: 0.78 },
  warning: { domain: 0.9, clamp: 0.86 },
  critical: { domain: 2.4, clamp: 2.4 },
};

function buildWavePath(data: TelemetryPoint[], key: "actual" | "prediction", status: TwinStatus) {
  const width = 720;
  const height = 236;
  const pad = 18;
  const { domain, clamp: cap } = WAVE_ENVELOPE[status];

  if (data.length < 2) {
    const mid = (height / 2).toFixed(2);
    return `M ${pad} ${mid} L ${width - pad} ${mid}`;
  }

  return data
    .map((point, index) => {
      const x = pad + (index / Math.max(1, data.length - 1)) * (width - pad * 2);
      const clipped = Math.max(-cap, Math.min(cap, point[key]));
      const y = pad + ((domain - clipped) / (domain * 2)) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function WaveformPlot({ data, status, live }: { data: TelemetryPoint[]; status: TwinStatus; live: boolean }) {
  const theme = live ? THEME[status] : OFFLINE_THEME;
  const actualPath = buildWavePath(data, "actual", status);
  const predictionPath = buildWavePath(data, "prediction", status);

  return (
    <div className="relative h-full overflow-hidden rounded-[8px] border border-zinc-700/70 bg-[#050506]">
      <div className="absolute inset-0 waveform-grid" />
      <svg className="relative z-10 h-full w-full" viewBox="0 0 720 236" preserveAspectRatio="none" role="img" aria-label="CNC spindle vibration line chart">
        <path d="M 18 118 L 702 118" stroke="rgba(212,212,216,.18)" strokeWidth="1" />
        <path d="M 18 48 L 702 48" stroke="rgba(212,212,216,.08)" strokeWidth="1" />
        <path d="M 18 188 L 702 188" stroke="rgba(212,212,216,.08)" strokeWidth="1" />
        <path d={predictionPath} fill="none" stroke="#a1a1aa" strokeDasharray="9 8" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" opacity="0.86" />
        <path
          d={actualPath}
          fill="none"
          stroke={theme.accent}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3.4"
          style={{ filter: `drop-shadow(0 0 10px rgba(${theme.rgb},.6))` }}
        />
      </svg>
      <div className="pointer-events-none absolute left-4 top-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Actual</div>
      <div className="pointer-events-none absolute bottom-3 right-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Prediction</div>
    </div>
  );
}

function Readout({ icon, label, value, theme }: { icon: React.ReactNode; label: string; value: string; theme: Theme }) {
  return (
    <div className="depth-panel rounded-[8px] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <div className={theme.text}>{icon}</div>
      </div>
      <p className={`mt-3 text-2xl font-black tracking-normal ${theme.text}`}>{value}</p>
    </div>
  );
}

function TelemetryMonitor({ data, status, uptime, live }: { data: TelemetryPoint[]; status: TwinStatus; uptime: number; live: boolean }) {
  const theme = live ? THEME[status] : OFFLINE_THEME;
  const latest = data[data.length - 1];
  const mse = latest?.mse ?? 0;
  const recent = data.slice(-12);
  const rms = recent.length ? Math.sqrt(recent.reduce((sum, p) => sum + p.actual * p.actual, 0) / recent.length) : 0;
  const vibration = (rms * 9.2).toFixed(2);

  return (
    <div className={`depth-panel flex-none overflow-hidden rounded-[8px] p-5 ${live && status === "critical" ? "critical-flash" : ""}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">CNC Spindle Vibration · Live MSE</p>
          <h3 className="mt-2 text-xl font-semibold text-slate-50">Actual Reality vs 1.58-bit AI Prediction</h3>
        </div>
        <Activity className={theme.text} size={24} />
      </div>
      <div className="h-[182px] overflow-hidden">
        <WaveformPlot data={data} status={status} live={live} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Readout icon={<Waves size={18} />} label="Vibration" value={live ? `${vibration} mm/s` : "—"} theme={theme} />
        <Readout icon={<Gauge size={18} />} label="Live MSE" value={live ? mse.toFixed(3) : "—"} theme={theme} />
        <Readout icon={<Clock size={18} />} label="Uptime" value={live ? formatUptime(uptime) : "—"} theme={theme} />
      </div>
    </div>
  );
}

/* ============================================================
   Judge Sandbox control panel
   ============================================================ */

function JudgeSandbox({
  status,
  onNormal,
  onWarning,
  onFault,
  onReset,
}: {
  status: TwinStatus;
  onNormal: () => void;
  onWarning: () => void;
  onFault: () => void;
  onReset: () => void;
}) {
  return (
    <div className="depth-panel rounded-[8px] border border-zinc-700/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(34,211,238,.7)]" />
          <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">Judge Sandbox</p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Self-contained · no hardware</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <button
          type="button"
          onClick={onNormal}
          className={`button-3d flex h-14 items-center justify-center gap-2 rounded-[8px] border px-3 text-xs font-black uppercase tracking-[0.08em] transition hover:-translate-y-0.5 active:translate-y-0 ${
            status === "stable" ? "border-emerald-400/50 bg-emerald-400/12 text-emerald-100" : "border-zinc-400/30 bg-white/[.05] text-zinc-100"
          }`}
        >
          <Play size={16} />
          Normal Mode
        </button>
        <button
          type="button"
          onClick={onWarning}
          className={`button-3d flex h-14 items-center justify-center gap-2 rounded-[8px] border px-3 text-xs font-black uppercase tracking-[0.08em] transition hover:-translate-y-0.5 active:translate-y-0 ${
            status === "warning" ? "border-amber-400/70 bg-amber-400/16 text-amber-50" : "border-amber-400/35 bg-amber-400/8 text-amber-100"
          }`}
        >
          <TriangleAlert size={16} />
          Trigger Warning
        </button>
        <button
          type="button"
          onClick={onFault}
          className={`button-3d flex h-14 items-center justify-center gap-2 rounded-[8px] border px-3 text-xs font-black uppercase tracking-[0.08em] transition hover:-translate-y-0.5 active:translate-y-0 ${
            status === "critical" ? "critical-flash border-red-400/85 bg-red-500/22 text-red-50" : "border-red-400/40 bg-red-500/10 text-red-100 hover:bg-red-500/18"
          }`}
        >
          <AlertTriangle size={16} />
          Inject Critical Fault
        </button>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="button-3d mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-zinc-500/40 bg-white/[.04] px-3 text-xs font-black uppercase tracking-[0.12em] text-zinc-200 transition hover:-translate-y-0.5 hover:bg-white/[.08] active:translate-y-0"
      >
        <RotateCcw size={15} />
        Reset Simulation
      </button>
    </div>
  );
}

function OperationsConsole({
  status,
  data,
  agent,
  uptime,
  onNormal,
  onWarning,
  onFault,
  onReset,
}: {
  status: TwinStatus;
  data: TelemetryPoint[];
  agent: AgentState;
  uptime: number;
  onNormal: () => void;
  onWarning: () => void;
  onFault: () => void;
  onReset: () => void;
}) {
  return (
    <section className="flex h-full min-h-[620px] flex-col gap-4 overflow-y-auto pr-1">
      <StatusBanner status={status} live />
      <TelemetryMonitor data={data} status={status} uptime={uptime} live />
      <AgentTerminal status={status} agent={agent} live />
      <div className="grid flex-none grid-cols-2 gap-4">
        <MetricCard icon={<Cpu size={20} />} label="Parameters" value="864K (1.58-bit)" />
        <MetricCard icon={<HardDrive size={20} />} label="SRAM Footprint" value="215 KB" />
      </div>
      <div className="flex-none">
        <JudgeSandbox status={status} onNormal={onNormal} onWarning={onWarning} onFault={onFault} onReset={onReset} />
      </div>
    </section>
  );
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="depth-panel rounded-[8px] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <div className="text-zinc-200">{icon}</div>
      </div>
      <p className="mt-3 text-2xl font-black tracking-normal text-slate-50">{value}</p>
    </div>
  );
}

/* ============================================================
   Page
   ============================================================ */

export default function Home() {
  const sim = useSimulation();
  const uptime = useUptime();

  const live = true; // self-contained simulation is always "live"
  const status: TwinStatus = sim.status;
  const data = sim.data;
  const agent = sim.agent;
  const critical = status === "critical";

  const theme = THEME[status];

  return (
    <main className="relative h-screen overflow-hidden bg-[#030303] p-5 text-slate-50">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,.025),transparent_24%,rgba(0,0,0,.2))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg,transparent,rgba(${theme.rgb},.5),transparent)` }} />
      {critical && <div className="alert-overlay pointer-events-none absolute inset-0 bg-red-600/12 mix-blend-screen" />}

      <header className="absolute left-6 right-6 top-5 z-30 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`rounded-[8px] border p-2.5 ${
              critical ? "critical-flash border-red-400/70 bg-red-500/12 text-red-100" : `stable-pulse ${theme.border} ${theme.bg} ${theme.text}`
            }`}
          >
            <Zap size={22} />
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">Bit-Forge · Pune Plant · Line 3</p>
            <h1 className="text-xl font-black tracking-normal text-slate-50">Bit-Forge: 1.58-bit Edge Intelligence</h1>
          </div>
        </div>
        <div
          className={`hidden rounded-[8px] border px-4 py-2 text-sm font-black uppercase tracking-[0.13em] md:block ${
            critical ? "critical-flash border-red-400/80 bg-red-500/16 text-red-50" : `stable-pulse ${theme.border} ${theme.bg} ${theme.text}`
          }`}
        >
          {theme.label}
        </div>
      </header>

      <div className="relative z-10 grid h-full grid-cols-[55fr_45fr] gap-5 pt-20">
        <PhysicalDigitalTwin status={status} live={live} />
        <OperationsConsole
          status={status}
          data={data}
          agent={agent}
          uptime={uptime}
          onNormal={sim.goNormal}
          onWarning={sim.goWarning}
          onFault={sim.goCritical}
          onReset={sim.reset}
        />
      </div>

      <div className="pointer-events-none absolute bottom-4 left-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600">
        <Radio size={14} />
        Judge Sandbox · self-contained simulation
      </div>
    </main>
  );
}
