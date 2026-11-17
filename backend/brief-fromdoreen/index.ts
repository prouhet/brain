// ============================================================
// STUDIO STRONG OPEN BRAIN — Brief "From Doreen" v2.0
// ============================================================
// Powers the "From Doreen" section of the morning-brief page (reelcall.app/brief.html), just under Past due:
// tasks Doreen sent to Dave that he hasn't answered yet. For each one he can accept it (and confirm the day it
// is due), push it back to her with a short reason, mark it done, drop it, merge it into another task, or rewrite it.
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, ... }
//
//   list                          → { ok, today, count, items[] }              read-only
//   accept   { id, due }          → { ok, id, due, prev }    due: "keep" | "none" | YYYY-MM-DD (today or later)
//   pushback { id, note? }        → { ok, id, prev }         assigns it back to Doreen, with Dave's note on the task
//   edit     { id, content, due? }→ { ok, id, title, due }   rewrites the text (and the day, if sent)
//   done     { id }               → { ok, id, prev }         already handled: archived, like the brief's own check-off
//   drop     { id }               → { ok, id, prev }         not doing it: archived
//   similar  { id }               → { ok, items[] }          open tasks that look like the same job (on his list or waiting here)
//   merge    { id, into }         → { ok, id, into, into_title, note, prev }   this task goes away; its words become a note on `into`
//   undo     { id, prev }         → { ok }                   puts back exactly what accept / pushback / done / drop / merge changed
//
// What waits for an answer: an open task Doreen captured and assigned to Dave (assignee "dave", captured_by "doreen"),
// or one added by her for him (assigned_by "Doreen"), that he hasn't accepted. It is recorded on the task itself in
// metadata.doreen_handoff { state: accepted | pushed_back, at, by, note }. A task she sends back to him again after a
// push back is asked about again. Repeating tasks, notes and the dids follow-ups are never listed.
//
// Reads/writes: thoughts (only the task you tap; content only on Edit). Pinned to BRIEF_OWNER and the shared
// studio-strong list. Kept as its own function so the morning-brief function that the 5:30 cron depends on is untouched.
//
// Secrets (project-wide, all already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// Optional: BRIEF_OWNER (default "dave")
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { accept, clip, edit, finish, isHandoff, isOpenTask, itemOut, mergeAway, mergeNote, pushBack, rankSimilar, sortHandoffs, stripPrefix, todayCentral, undo, unmergeNote, type Thought } from "./handoff.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY  = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY     = env("BRIEF_PAGE_KEY");
const OWNER        = env("BRIEF_OWNER", "dave");
const MAX_ITEMS    = 60;

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

async function pending(): Promise<Thought[]> {
  const { data, error } = await base()
    .or("and(metadata->>assignee.eq.dave,metadata->>captured_by.eq.doreen),metadata->>assigned_by.ilike.doreen")
    .or("metadata->>archived.is.null,metadata->>archived.eq.false")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return sortHandoffs(((data || []) as Thought[]).filter((t) => isHandoff(t.metadata || {}))).slice(0, MAX_ITEMS);
}

async function load(id: unknown): Promise<Thought | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await base().eq("id", id).maybeSingle();
  return (data as Thought) || null;
}

async function handleList() {
  const today = todayCentral();
  const list = await pending();
  return json({ ok: true, today, count: list.length, items: list.map((t) => itemOut(t, today)) });
}

async function handleAccept(body: Record<string, unknown>) {
  const t = await load(body.id);
  if (!t || !isHandoff(t.metadata || {})) return json({ error: "That task isn't waiting for an answer anymore." }, 404);
  const today = todayCentral(), r = accept(t.metadata || {}, String(body.due ?? "keep"), today, new Date().toISOString());
  if (!r.ok) return json({ error: r.error }, 400);
  const { error } = await db.from("thoughts").update({ metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: t.id, due: r.meta.due_date ? String(r.meta.due_date).slice(0, 10) : "", prev: r.prev });
}

async function handlePushBack(body: Record<string, unknown>) {
  const t = await load(body.id);
  if (!t || !isHandoff(t.metadata || {})) return json({ error: "That task isn't waiting for an answer anymore." }, 404);
  const r = pushBack(t.metadata || {}, String(body.note ?? ""), new Date().toISOString());
  if (!r.ok) return json({ error: r.error }, 400);
  const { error } = await db.from("thoughts").update({ metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: t.id, prev: r.prev });
}

async function handleEdit(body: Record<string, unknown>) {
  const t = await load(body.id);
  if (!t || !isHandoff(t.metadata || {})) return json({ error: "That task isn't waiting for an answer anymore." }, 404);
  const r = edit(t.metadata || {}, String(body.content ?? ""), "due" in body ? String(body.due ?? "") : undefined, todayCentral(), new Date().toISOString());
  if (!r.ok) return json({ error: r.error }, 400);
  const { error } = await db.from("thoughts").update({ content: r.content, metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  const o = itemOut({ ...t, content: r.content, metadata: r.meta }, todayCentral());
  return json({ ok: true, id: t.id, title: o.title, full: o.full, due: o.due, month: o.month });
}

async function handleFinish(body: Record<string, unknown>, how: "done" | "drop") {
  const t = await load(body.id);
  if (!t || !isHandoff(t.metadata || {})) return json({ error: "That task isn't waiting for an answer anymore." }, 404);
  const r = finish(t.metadata || {}, how, new Date().toISOString());
  if (!r.ok) return json({ error: r.error }, 409);
  const { error } = await db.from("thoughts").update({ metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: t.id, prev: r.prev });
}

// Open tasks that look like the same job: on his list, or waiting here.
async function handleSimilar(body: Record<string, unknown>) {
  const t = await load(body.id);
  if (!t || !isHandoff(t.metadata || {})) return json({ error: "That task isn't waiting for an answer anymore." }, 404);
  const { data, error } = await base()
    .or("metadata->>archived.is.null,metadata->>archived.eq.false")
    .order("created_at", { ascending: false }).limit(900);
  if (error) return json({ error: error.message }, 500);
  const pool = ((data || []) as Thought[]).filter((x) => isOpenTask(x.metadata || {}));
  const items = rankSimilar(t, pool).map((x) => ({
    id: x.id, title: clip(stripPrefix(x.content), 90), due: x.metadata?.due_date ? String(x.metadata.due_date).slice(0, 10) : "",
    scope: x.owner === "studio-strong" ? "business" : "personal", waiting: isHandoff(x.metadata || {}),
  }));
  return json({ ok: true, items });
}

async function handleMerge(body: Record<string, unknown>) {
  const t = await load(body.id);
  if (!t || !isHandoff(t.metadata || {})) return json({ error: "That task isn't waiting for an answer anymore." }, 404);
  const target = await load(body.into);
  if (!target || target.id === t.id || !isOpenTask(target.metadata || {})) return json({ error: "That task isn't open anymore. Pick another." }, 404);
  const now = new Date().toISOString();
  const away = mergeAway(t.metadata || {}, target.id, now);
  if (!away.ok) return json({ error: away.error }, 409);
  const kept = mergeNote(target.metadata || {}, t, now);
  // The note goes onto the survivor first, so a failure part-way never loses the words.
  const n = await db.from("thoughts").update({ metadata: kept.meta }).eq("id", target.id);
  if (n.error) return json({ error: n.error.message }, 500);
  const a = await db.from("thoughts").update({ metadata: away.meta }).eq("id", t.id);
  if (a.error) {
    await db.from("thoughts").update({ metadata: target.metadata }).eq("id", target.id);
    return json({ error: a.error.message }, 500);
  }
  return json({ ok: true, id: t.id, into: target.id, into_title: clip(stripPrefix(target.content), 90), note: kept.note, prev: away.prev });
}

async function handleUndo(body: Record<string, unknown>) {
  const t = await load(body.id);
  if (!t) return json({ error: "Can't find that task." }, 404);
  const mergedInto = typeof t.metadata?.merged_into === "string" ? t.metadata.merged_into : "";
  const r = undo(t.metadata || {}, body.prev);
  if (!r.ok) return json({ error: r.error }, 400);
  const { error } = await db.from("thoughts").update({ metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  // A merge also left a note on the other task; take it off again.
  const mg = (body.prev as { merge?: { into?: unknown; note_at?: unknown } } | null)?.merge;
  if (mg && mergedInto && mg.into === mergedInto && typeof mg.note_at === "string") {
    const target = await load(mergedInto);
    if (target) await db.from("thoughts").update({ metadata: unmergeNote(target.metadata || {}, mg.note_at) }).eq("id", target.id);
  }
  return json({ ok: true, id: t.id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "list":     return await handleList();
      case "accept":   return await handleAccept(body);
      case "pushback": return await handlePushBack(body);
      case "edit":     return await handleEdit(body);
      case "done":     return await handleFinish(body, "done");
      case "drop":     return await handleFinish(body, "drop");
      case "similar":  return await handleSimilar(body);
      case "merge":    return await handleMerge(body);
      case "undo":     return await handleUndo(body);
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
