// ============================================================
// STUDIO STRONG OPEN BRAIN — Brief "Pinned" and "Your day" v1.0
// ============================================================
// Powers the two cards at the very top of the morning-brief page (reelcall.app/brief.html):
//   Pinned    the few things that must happen, shown every day until done, whatever their age or priority
//             (so the 14-day overdue rule and the ranking can never hide them)
//   Your day  the tasks Dave picked for today from the ⋯ menu on any row; it starts empty every day
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, ... }
//
//   list                          → { ok, today, pinned[], day[], limits }        read-only
//   pin     { id, next? }         → { ok, item, counts }   up to 3 at once; `next` is the one small next step
//   unpin   { id }                → { ok, item, counts }
//   next    { id, next }          → { ok, item }           set or clear the next step on a pinned task
//   focus   { id }                → { ok, item, counts }   put on today's list (up to 7)
//   unfocus { id }                → { ok, item, counts }
//   done    { id }                → { ok, item }           checked off, the same way the brief's own check-off does it
//   undone  { id }                → { ok, item }
//
// A flag lives on the task itself (thoughts.metadata): pinned, pinned_at, pin_next, focus_date, focus_at.
// Nothing is copied and nothing is archived except by done. Only open, non-repeating tasks that are Dave's.
// The 5:30 morning-brief function is untouched.
//
// Secrets (project-wide, all already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// Optional: BRIEF_OWNER (default "dave")
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { check, focus, isPinned, itemOut, MAX_DAY, MAX_PINNED, onDay, pin, setNext, shown, sortDay, sortPinned, todayCentral, uncheck, unfocus, unpin, type Thought } from "./focus.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY  = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY     = env("BRIEF_PAGE_KEY");
const OWNER        = env("BRIEF_OWNER", "dave");

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const COLS = "id, content, owner, metadata, created_at";
const base = () => db.from("thoughts").select(COLS).in("owner", [OWNER, "studio-strong"]);

// Everything flagged pinned, or on today's list. The page only ever sees the ones that are still open or were checked off today.
async function flagged(today: string): Promise<Thought[]> {
  const { data, error } = await base()
    .or(`metadata->>pinned.eq.true,metadata->>focus_date.eq.${today}`)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data || []) as Thought[]).filter((t) => shown(t, today));
}
async function load(id: unknown): Promise<Thought | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await base().eq("id", id).maybeSingle();
  return (data as Thought) || null;
}
const notFound = () => json({ error: "Can't find that task." }, 404);

// How many OTHER tasks are pinned / on today's list and still open (for the limits).
function counts(list: Thought[], today: string, exceptId = "") {
  const open = list.filter((t) => t.id !== exceptId && !t.metadata?.archived);
  return { pinned: open.filter((t) => isPinned(t.metadata || {})).length, day: open.filter((t) => onDay(t.metadata || {}, today)).length };
}

async function handleList() {
  const today = todayCentral();
  const list = await flagged(today);
  const pinned = sortPinned(list.filter((t) => isPinned(t.metadata || {})));
  const day = sortDay(list.filter((t) => !isPinned(t.metadata || {}) && onDay(t.metadata || {}, today)));
  return json({ ok: true, today, pinned: pinned.map((t) => itemOut(t, today)), day: day.map((t) => itemOut(t, today)), limits: { pinned: MAX_PINNED, day: MAX_DAY } });
}

async function save(t: Thought, meta: Record<string, unknown>) {
  const { error } = await db.from("thoughts").update({ metadata: meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  const today = todayCentral();
  return json({ ok: true, item: itemOut({ ...t, metadata: meta }, today), counts: counts(await flagged(today), today) });
}

async function handleSet(body: Record<string, unknown>, what: "pin" | "unpin" | "next" | "focus" | "unfocus" | "done" | "undone") {
  const t = await load(body.id);
  if (!t) return notFound();
  const m = t.metadata || {}, today = todayCentral(), now = new Date().toISOString();
  let r;
  if (what === "pin") {
    r = pin(m, "next" in body ? String(body.next ?? "") : undefined, now, isPinned(m) ? 0 : counts(await flagged(today), today, t.id).pinned);
  } else if (what === "unpin") r = unpin(m);
  else if (what === "next") r = setNext(m, String(body.next ?? ""));
  else if (what === "focus") r = focus(m, today, now, onDay(m, today) ? 0 : counts(await flagged(today), today, t.id).day);
  else if (what === "unfocus") r = unfocus(m);
  else if (what === "done") r = check(m, now);
  else r = uncheck(m);
  if (!r.ok) return json({ error: r.error }, 400);
  if (r.meta === m) return json({ ok: true, item: itemOut(t, today), counts: counts(await flagged(today), today), unchanged: true });
  return await save(t, r.meta);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "list":    return await handleList();
      case "pin":     return await handleSet(body, "pin");
      case "unpin":   return await handleSet(body, "unpin");
      case "next":    return await handleSet(body, "next");
      case "focus":   return await handleSet(body, "focus");
      case "unfocus": return await handleSet(body, "unfocus");
      case "done":    return await handleSet(body, "done");
      case "undone":  return await handleSet(body, "undone");
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
