// ============================================================
// STUDIO STRONG OPEN BRAIN — Brief "Calm view" lists v1.0
// ============================================================
// Powers the Calm view of the morning-brief page (reelcall.app/brief.html): the data behind
//   project cards with gates · quick wins · thank-yous owed · coming up · all your items by category ·
//   the daily marketing rep · the Sunday view (look back, pick the week's projects, sweep, week ahead).
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, ... }
//
//   list                               → { ok, today, dow, projects[], skipped[], quick[], thanks[], coming[], cats[], rep, week, counts }   read-only
//   move   { id, lane }                → { ok, item }          lane: studio|trainerside|health|home|mom|people|reelcall|someday, or "" for automatic
//   skip   { key, undo? }              → { ok, skipped[] }     "Not today" on a project card (back tomorrow)
//   rep    { result }                  → { ok, rep }           result: asked | yes | no | clear
//   week   { keys[] }                  → { ok, pick[] }        up to 7 projects chosen for the week (on a Sunday: for the coming week)
//   sweep  { id, how, days? }          → { ok, id, prev }      how: keep | snooze (days 7|14|30) | park | drop
//   unsweep { id, prev }               → { ok, id }
//
// A task is never copied. This function writes only these keys on a task: lane, snooze_until, sweep_kept_at, and (Drop) the
// archive keys. Per-day and per-week choices (skipped projects, the rep, the week's picks) live in the brief_state table.
// The 5:30 morning-brief function is untouched.
//
// Secrets (project-wide, all already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// Optional: BRIEF_OWNER (default "dave")
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import {
  addDays, buildCats, buildProjects, dowOf, DROPPED_REASON, isMine, LANES, quickWins, REP_LESSON, repAsk, repTally, rowOut, setLane, sweepApply, sweepList,
  pickWeek, sweepUndo, thankYous, todayCentral, comingUp, weekAhead, weekStart, WEEK_PICK_MAX, type Row, type SweepHow,
} from "./lanes.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY = env("BRIEF_PAGE_KEY");
const OWNER = env("BRIEF_OWNER", "dave");
const CHECKED_REASON = "checked off on daily brief";

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const COLS = "id, content, owner, metadata, created_at, updated_at";
const base = () => db.from("thoughts").select(COLS).in("owner", [OWNER, "studio-strong"]);
const OPEN = "metadata->>archived.is.null,metadata->>archived.eq.false";
const IS_TASK = "metadata->>type.is.null,metadata->>type.eq.task";

// Every open task (the API hands back at most 1000 rows at a time, so ask in pages).
async function openTasks(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await base().or(OPEN).or(IS_TASK).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data || []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function projectTasks(): Promise<Row[]> {
  const { data, error } = await base().not("metadata->>project", "is", null).limit(500);
  if (error) throw new Error(error.message);
  return (data || []) as Row[];
}
async function load(id: unknown): Promise<Row | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await base().eq("id", id).maybeSingle();
  return (data as Row) || null;
}
async function getStates(keys: string[]): Promise<Record<string, any>> {
  const { data, error } = await db.from("brief_state").select("key, value").in("key", keys);
  if (error) throw new Error(error.message);
  const o: Record<string, any> = {};
  for (const r of data || []) o[r.key] = r.value;
  return o;
}
async function putState(key: string, value: unknown) {
  const { error } = await db.from("brief_state").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
async function delState(key: string) {
  const { error } = await db.from("brief_state").delete().eq("key", key);
  if (error) throw new Error(error.message);
}
async function countWhere(reason: string, sinceIso: string): Promise<number> {
  const { count, error } = await db.from("thoughts").select("id", { count: "exact", head: true })
    .in("owner", [OWNER, "studio-strong"]).eq("metadata->>archived_reason", reason).gte("metadata->>archived_at", sinceIso);
  if (error) throw new Error(error.message);
  return count || 0;
}

const repOut = (today: string, rec: { result?: string } | undefined, week: { asks: number; yes: number; no: number }) =>
  ({ ask: repAsk(today), result: rec?.result || "", lesson: rec?.result ? REP_LESSON[rec.result] || "" : "", week });

async function handleList() {
  const today = todayCentral(), mon = weekStart(today), pickMon = pickWeek(today);
  const weekDays: string[] = []; for (let d = mon; d <= today; d = addDays(d, 1)) weekDays.push(d);
  const [open, ptasks, st, doneWeek, droppedWeek] = await Promise.all([
    openTasks(), projectTasks(),
    getStates([`skip:${today}`, `week:${pickMon}`, ...weekDays.map((d) => `rep:${d}`)]),
    countWhere(CHECKED_REASON, mon + "T05:00:00Z"), countWhere(DROPPED_REASON, mon + "T05:00:00Z"),
  ]);
  const mine = open.filter(isMine);
  const projects = buildProjects(ptasks, today);
  const skip: string[] = Array.isArray(st[`skip:${today}`]) ? st[`skip:${today}`] : [];
  const pick: string[] = Array.isArray(st[`week:${pickMon}`]) ? st[`week:${pickMon}`] : [];
  const rep = repOut(today, st[`rep:${today}`], repTally(weekDays.map((d) => st[`rep:${d}`])));
  const sweep = sweepList(mine, today);
  const cats = buildCats(mine, today);
  return json({
    ok: true, today, dow: dowOf(today), lanes: LANES.map((l) => ({ key: l.key, name: l.name, badge: "badge" in l ? l.badge : "" })),
    projects: projects.map((p) => ({ ...p, picked: pick.includes(p.key) })), skipped: skip.filter((k) => projects.some((p) => p.key === k)),
    quick: quickWins(mine, today), thanks: thankYous(mine, today), coming: comingUp(mine, today), cats, rep,
    week: { start: mon, pick: pick.filter((k) => projects.some((p) => p.key === k)), pick_max: WEEK_PICK_MAX, done: doneWeek, dropped: droppedWeek, sweep, ahead: weekAhead(open, today) },
    counts: { open: mine.length },
  });
}

async function save(t: Row, meta: Record<string, unknown>) {
  const { error } = await db.from("thoughts").update({ metadata: meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, item: rowOut({ ...t, metadata: meta }, todayCentral()) });
}

async function handleMove(b: Record<string, unknown>) {
  const t = await load(b.id);
  if (!t) return json({ error: "Can't find that task." }, 404);
  const r = setLane(t.metadata || {}, String(b.lane ?? ""));
  if (!r.ok) return json({ error: r.error }, 400);
  return await save(t, r.meta);
}

async function handleSkip(b: Record<string, unknown>) {
  const today = todayCentral(), key = String(b.key ?? "").slice(0, 80);
  if (!key) return json({ error: "Which project?" }, 400);
  const k = `skip:${today}`;
  const got = (await getStates([k]))[k];
  const cur: string[] = Array.isArray(got) ? got : [];
  const next = b.undo ? cur.filter((x) => x !== key) : cur.includes(key) ? cur : [...cur, key];
  if (next.length) await putState(k, next); else await delState(k);
  return json({ ok: true, skipped: next });
}

async function handleRep(b: Record<string, unknown>) {
  const today = todayCentral(), mon = weekStart(today), k = `rep:${today}`;
  const result = String(b.result ?? "");
  if (!["asked", "yes", "no", "clear"].includes(result)) return json({ error: "Unknown choice." }, 400);
  if (result === "clear") await delState(k); else await putState(k, { result, at: new Date().toISOString(), ask: repAsk(today) });
  const days: string[] = []; for (let d = mon; d <= today; d = addDays(d, 1)) days.push(d);
  const st = await getStates(days.map((d) => `rep:${d}`));
  return json({ ok: true, rep: repOut(today, st[k], repTally(days.map((d) => st[`rep:${d}`]))) });
}

async function handleWeek(b: Record<string, unknown>) {
  const mon = pickWeek(todayCentral());   // on a Sunday: next Monday
  const keys = Array.isArray(b.keys) ? [...new Set(b.keys.map((x) => String(x).slice(0, 80)))].slice(0, WEEK_PICK_MAX) : null;
  if (!keys) return json({ error: "Pick some projects." }, 400);
  if (keys.length) await putState(`week:${mon}`, keys); else await delState(`week:${mon}`);
  return json({ ok: true, pick: keys });
}

async function handleSweep(b: Record<string, unknown>) {
  const t = await load(b.id);
  if (!t) return json({ error: "Can't find that task." }, 404);
  const how = String(b.how ?? "") as SweepHow;
  const r = sweepApply(t.metadata || {}, how, todayCentral(), new Date().toISOString(), Number(b.days) || 7);
  if (!r.ok) return json({ error: r.error }, 400);
  const { error } = await db.from("thoughts").update({ metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: t.id, prev: r.prev });
}
async function handleUnsweep(b: Record<string, unknown>) {
  const t = await load(b.id);
  if (!t) return json({ error: "Can't find that task." }, 404);
  const r = sweepUndo(t.metadata || {}, b.prev);
  if (!r.ok) return json({ error: r.error }, 400);
  const { error } = await db.from("thoughts").update({ metadata: r.meta }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: t.id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (b.action) {
      case "list": return await handleList();
      case "move": return await handleMove(b);
      case "skip": return await handleSkip(b);
      case "rep": return await handleRep(b);
      case "week": return await handleWeek(b);
      case "sweep": return await handleSweep(b);
      case "unsweep": return await handleUnsweep(b);
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
