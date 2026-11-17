// ============================================================
// STUDIO STRONG — Act page extras: Randy's setup "ladder" lines + the date he first called each setup
// ============================================================
// Powers two things on reelcall.app/act.html, using the SAME SQL the hourly "RSOTC setup alerts" use (rsotc_ladder), so the
// Act page and the alerts always agree:
//   • the one-line ladder  ✕ stop ─ ▼ entry ─ ◆ price now ─ T1 T2 T3 … with RR
//   • the date Randy first recommended the setup (earliest dated entry in its history, else the day it was first logged)
//
//   POST ?key=BRIEF_PAGE_KEY   body: { prices: { "TICKER": number, … }, ids: [setup uuid, …] }
//   → { ok, items: { "<setup id>": { first: "YYYY-MM-DD", last: "YYYY-MM-DD", ladder: "text" } } }
//
// Read-only. Never writes. Never places orders. The prices are only used to place ◆ "now" on the ladder.
// Secrets (project-wide, already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const PAGE_KEY = env("BRIEF_PAGE_KEY");
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const prices: Record<string, number> = {};
    if (body && typeof body.prices === "object" && body.prices) {
      for (const [k, v] of Object.entries(body.prices as Record<string, unknown>).slice(0, 300)) {
        const n = typeof v === "number" ? v : Number(v);
        if (k.length > 0 && k.length <= 20 && Number.isFinite(n) && n > 0 && n < 1e9) prices[k] = n;
      }
    }
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 300) : null;
    const { data, error } = await db.rpc("rsotc_act_extras", { prices, only_ids: ids });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, items: data || {} });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
