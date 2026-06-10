import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

// Local Llama-3 via Ollama. Override with env if your setup differs.
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 45000);

type Supplier = {
  id: string;
  name: string;
  location: string;
  ships_part: string;
  lead_time_days: number;
  shipping: string;
  unit_price_usd: number;
  min_order_qty: number;
  customs: string;
  reliability_rating: number;
};

type FactoryContext = {
  facility: {
    plant: string;
    location: string;
    assembly_line: string;
    asset: string;
    asset_id: string;
    downtime_cost_per_hour_usd: number;
  };
  inventory: Array<{ part: string; sku: string; spindle_compatible: boolean; on_hand: number }>;
  approved_suppliers: Supplier[];
  policy: { priority: string; notes: string };
};

async function loadFactoryContext(): Promise<FactoryContext> {
  const file = path.join(process.cwd(), "data", "factory_context.json");
  const raw = await readFile(file, "utf-8");
  return JSON.parse(raw) as FactoryContext;
}

function buildPrompt(ctx: FactoryContext, mse: number): string {
  return [
    "You are an autonomous industrial logistics agent for a smart factory.",
    "A CNC spindle bearing on the line below just failed (anomaly detected by an edge AI).",
    "The safety relay has tripped and the line is DOWN. Spindle replacement bearings on hand: 0.",
    "",
    "LIVE FAILURE:",
    `- Asset: ${ctx.facility.asset} (${ctx.facility.asset_id}) on ${ctx.facility.assembly_line}, ${ctx.facility.location}`,
    `- Prediction error (MSE) at trip: ${mse.toFixed(2)} (threshold 4.70)`,
    `- Downtime cost: $${ctx.facility.downtime_cost_per_hour_usd}/hour`,
    "",
    "FACTORY DATA (JSON):",
    JSON.stringify(
      { inventory: ctx.inventory, approved_suppliers: ctx.approved_suppliers, policy: ctx.policy },
      null,
      2,
    ),
    "",
    "TASK: Look at the supplier list, choose the single best vendor to restore the line fastest,",
    "and write a 3-sentence summary for the operator dashboard. Sentence 1: state the failure and that",
    "stock is zero. Sentence 2: name the chosen vendor, lead time, qty, and total cost, and why it beats",
    "the alternative. Sentence 3: the immediate action for the operator. Be decisive. No preamble, no lists.",
  ].join("\n");
}

// Deterministic fallback so the dashboard always shows a decision even if Ollama is offline.
function fallbackReport(ctx: FactoryContext, mse: number) {
  const suppliers = ctx.approved_suppliers.filter((s) => s.ships_part === "BRG-7008-ACD");
  const chosen = suppliers.reduce((best, s) => (s.lead_time_days < best.lead_time_days ? s : best), suppliers[0]);
  const alt = suppliers.find((s) => s.id !== chosen.id);
  const qty = chosen.min_order_qty;
  const total = (qty * chosen.unit_price_usd).toFixed(2);
  const report =
    `CRITICAL: ${ctx.facility.asset} (${ctx.facility.asset_id}) tripped at MSE ${mse.toFixed(2)} and ` +
    `spindle bearing stock is 0, halting ${ctx.facility.assembly_line}. ` +
    `Auto-reordering ${qty}x ${chosen.ships_part} from ${chosen.name} (${chosen.location}) at ` +
    `$${chosen.unit_price_usd}/unit = $${total}, arriving in ${chosen.lead_time_days} day(s) — ` +
    (alt
      ? `chosen over ${alt.name} whose ${alt.lead_time_days}-day ${alt.customs.toLowerCase()} would extend downtime well past the part-cost saving. `
      : "the fastest approved source. ") +
    `Operator: lock out ${ctx.facility.asset_id}, fit the loaner bearing if available, and confirm the PO so the courier dispatches today.`;
  return { report, vendor: chosen.name, lead_time_days: chosen.lead_time_days, source: "fallback" as const };
}

async function callOllama(prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.4, num_predict: 220 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { response?: string };
    const text = data.response?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request) {
  let mse = 0;
  let status = "critical";
  try {
    const body = (await request.json()) as { mse?: number; status?: string };
    mse = typeof body.mse === "number" ? body.mse : 0;
    status = body.status ?? "critical";
  } catch {
    // empty / malformed body — treat as a critical trip with unknown MSE.
  }

  let ctx: FactoryContext;
  try {
    ctx = await loadFactoryContext();
  } catch {
    return NextResponse.json({ error: "factory_context.json missing or invalid" }, { status: 500 });
  }

  const llamaText = await callOllama(buildPrompt(ctx, mse));
  const fallback = fallbackReport(ctx, mse);

  return NextResponse.json({
    status,
    mse,
    asset: ctx.facility.asset,
    asset_id: ctx.facility.asset_id,
    plant: ctx.facility.plant,
    report: llamaText ?? fallback.report,
    vendor: fallback.vendor,
    lead_time_days: fallback.lead_time_days,
    model: OLLAMA_MODEL,
    source: llamaText ? "llama3" : "fallback",
    generated_at: new Date().toISOString(),
  });
}
