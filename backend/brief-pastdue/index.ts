// ============================================================
// STUDIO STRONG OPEN BRAIN — Brief "Past due" v1.0
// ============================================================
// Powers the "Past due" card at the top of the morning-brief page
// (reelcall.app/brief.html): tasks whose day has gone by, split into Business
// (first), Personal, and a collapsed group for Doreen's, each with one-tap
// ways to recommit to a new day, mark done, or drop.
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, ... }
//
//   list                      → { ok, today, grace, counts, business[], personal[], doreen[] }   read-only
//   recommit { id, to }       → { ok, id, due, prev }     moves the task to a new day (today or later)
//   done     { id }           → { ok, id, prev }          checks it off, same as the brief's own check-off
//   drop     { id }           → { ok, id, prev }          archives it ("not doing this")
//   undo     { id, prev }     → { ok }                    puts back exactly what the last action changed
//
// What counts as past due: a task with a due date before today, or one that
// only names a month ("october") once that month is over. Repeating tasks,
// notes, the dids follow-ups and appointments that already happened are never
// listed. A task that is only GRACE_DAYS (2) or fewer days late stays out of
// the review: the brief already carries those on its own list, so the card is
// for what has actually slipped. Month-only tasks always show, since they never
// make the daily list.
//
// Each recommit is counted (recommits) and the original date is kept
// (first_due), so the card can say "pushed 3 times" and nudge: do it, hand it
// off, or drop it.
//
// Reads/writes: thoughts (only the metadata of the task you tap), daily_briefs
// (read-only, for tiers). Every query is pinned to BRIEF_OWNER and the shared
// studio-strong list. Kept as its own function so the morning-brief function
// that the 5:30 cron depends on is untouched.
//
// Secrets (project-wide, all already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// Optional: BRIEF_OWNER (default "dave")
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY  = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY     = env("BRIEF_PAGE_KEY");
const OWNER        = env("BRIEF_OWNER", "dave");
const TZ           = "America/Chicago";
const DATE_RE      = /^\d{4}-\d{2}-\d{2}$/;
const GRACE_DAYS   = 2;     // dated tasks this late or less stay on the daily list, out of the review
const MAX_PER_LIST = 150;
const MAX_DOREEN   = 60;

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ── Helpers (same rules as the morning-brief function) ───────
type Meta = Record<string, unknown>;
interface Thought { id: string; content: string; owner: string; metadata: Meta; created_at: string }

const todayCentral = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86_400_000);
const monthName = (dateStr: string) =>
  new Date(dateStr + "T12:00:00Z").toLocaleString("en-US", { timeZone: "UTC", month: "long" }).toLowerCase();

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthTitle = (i: number) => MONTHS[i].charAt(0).toUpperCase() + MONTHS[i].slice(1);
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // m is 1–12

const PREFIX_RE = /^\s*(ACTIVE TASK\s*(\([^)]*\))?\s*:|PREVIOUS CLIENT\s*[—-]|FOLLOW-UP CLIENT\s*[—-]|RECURRING\s*:)\s*/i;
const stripPrefix = (s: string) => s.replace(PREFIX_RE, "").trim();
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

function keywordTier(content: string): number {
  const c = content.toLowerCase();
  if (/invest|tsp|compound|wealth|retirement/.test(c)) return 1;
  if (/automation|strategy|system|process|infrastructure/.test(c)) return 2;
  if (/tax|1099|legal|deadline|medical|insurance|psa|doctor/.test(c)) return 3;
  if (/newsletter|article|client|chamber|deliverable|dids?\b|follow.?up|call|text|email|member|session|trainer/.test(c)) return 4;
  return 5;
}

// Whose task is it? Same rule as the brief: Doreen's when tagged assignee "doreen",
// or captured by her and not claimed by Dave.
const doreensMeta = (m: Meta): boolean => m.assignee !== "dave" && (m.assignee === "doreen" || m.captured_by === "doreen");

// A task that only names a month ("october") is due by that month's last day. With no year given, the
// month is taken in whichever year lands it closest to today: "december" read in January is last
// December, "january" read in November is next January.
function monthOnly(raw: unknown, today: string): { end: string; label: string } | null {
  const s = String(raw ?? "").toLowerCase();
  const idx = MONTHS.findIndex((mn) => s.includes(mn.slice(0, 3)));
  if (idx < 0) return null;
  const curY = Number(today.slice(0, 4));
  const ym = s.match(/\b(20\d\d)\b/);
  let y = ym ? Number(ym[1]) : curY;
  if (!ym) {
    let best = Infinity;
    for (const cand of [curY - 1, curY, curY + 1]) {
      const dist = Math.abs(daysBetween(today, monthEnd(cand, idx + 1)));
      if (dist < best) { best = dist; y = cand; }
    }
  }
  return { end: monthEnd(y, idx + 1), label: monthTitle(idx) + (y !== curY ? ` ${y}` : "") };
}

interface Late { due: string; month: string; late: number; eff: string }
// null = not past due. Otherwise how late, and whether it is a real date or just a month.
function lateness(m: Meta, today: string): Late | null {
  const d = String(m.due_date || "").slice(0, 10);
  if (DATE_RE.test(d)) {
    if (d >= today) return null;
    return { due: d, month: "", late: daysBetween(d, today), eff: d };
  }
  if (m.due_month) {
    const mo = monthOnly(m.due_month, today);
    if (mo && mo.end < today) return { due: "", month: mo.label, late: daysBetween(mo.end, today), eff: mo.end };
  }
  return null;
}

// ── list ─────────────────────────────────────────────────────
interface PdItem {
  id: string; title: string; full: string; tier: number; scope: "business" | "personal" | "doreen";
  due: string; month: string; late: number; first_due: string; pushes: number;
}

// Tiers: a tier you set always wins, then the brief's own scoring from the latest snapshot, then the keyword guess.
async function snapshotInfo(today: string): Promise<{ tiers: Map<string, number>; todayIds: Set<string> }> {
  const tiers = new Map<string, number>(), todayIds = new Set<string>();
  const { data } = await db.from("daily_briefs").select("brief_date, data").eq("owner", OWNER).order("brief_date", { ascending: false }).limit(1);
  const row = (data || [])[0] as { brief_date: string; data: { items?: { id: string; tier: number }[] } } | undefined;
  for (const i of row?.data?.items || []) {
    if (Number.isInteger(i.tier)) tiers.set(i.id, i.tier);
    if (row && row.brief_date === today) todayIds.add(i.id);
  }
  return { tiers, todayIds };
}

async function openDatedTasks(): Promise<Thought[]> {
  const { data, error } = await db.from("thoughts").select("id, content, owner, metadata, created_at")
    .in("owner", [OWNER, "studio-strong"])
    .or("metadata->>archived.is.null,metadata->>archived.eq.false")
    .or("metadata->>type.is.null,metadata->>type.eq.task")
    .or("metadata->>category.is.null,metadata->>category.neq.dids-followup")
    .or("metadata->>due_date.not.is.null,metadata->>due_month.not.is.null")
    .order("created_at", { ascending: false })
    .limit(1500);
  if (error) throw new Error("thoughts: " + error.message);
  return (data || []) as Thought[];
}

function isOpenTask(t: Thought): boolean {
  const m = t.metadata || {};
  const type = String(m.type || "").toLowerCase();
  if (type !== "task" && type !== "") return false;
  if (m.archived) return false;
  if (m.category === "dids-followup") return false;
  if (m.recurring) return false;      // repeating tasks come back on their own schedule
  return true;
}

async function handleList() {
  const today = todayCentral();
  const [rows, snap] = await Promise.all([openDatedTasks(), snapshotInfo(today)]);
  const business: PdItem[] = [], personal: PdItem[] = [], doreen: PdItem[] = [];
  let grace = 0;
  for (const t of rows) {
    if (!isOpenTask(t)) continue;
    const m = t.metadata || {};
    const l = lateness(m, today);
    if (!l) continue;
    // An appointment that has passed happened; it isn't something to recommit.
    if (l.due && /\b(appointment|appt)\b/i.test(t.content)) continue;
    const mine = !doreensMeta(m);
    if (l.due && l.late <= GRACE_DAYS) { if (mine) grace++; continue; }
    const override = Number(m.tier_override) || 0;
    const body = stripPrefix(t.content);
    const item: PdItem = {
      id: t.id, title: clip(oneLine(body), 150), full: clip(oneLine(body), 700),
      tier: override || snap.tiers.get(t.id) || keywordTier(t.content),
      scope: !mine ? "doreen" : t.owner === OWNER ? "personal" : "business",
      due: l.due, month: l.month, late: l.late,
      first_due: DATE_RE.test(String(m.first_due || "")) ? String(m.first_due) : "",
      pushes: Math.max(0, Number(m.recommits) || 0),
    };
    (item.scope === "doreen" ? doreen : item.scope === "personal" ? personal : business).push(item);
  }
  // Highest-stakes tier first, then whatever has waited longest.
  const order = (a: PdItem, b: PdItem) => a.tier - b.tier || b.late - a.late || a.title.localeCompare(b.title);
  business.sort(order); personal.sort(order);
  doreen.sort((a, b) => b.late - a.late || a.tier - b.tier);
  const counts = { business: business.length, personal: personal.length, doreen: doreen.length, grace };
  console.log(`pastdue list business=${counts.business} personal=${counts.personal} doreen=${counts.doreen} grace=${grace}`);
  return json({
    ok: true, today, grace_days: GRACE_DAYS, counts,
    business: business.slice(0, MAX_PER_LIST), personal: personal.slice(0, MAX_PER_LIST), doreen: doreen.slice(0, MAX_DOREEN),
  });
}

// ── Changes to one task ──────────────────────────────────────
// The only fields any action touches, and so the only ones undo may put back.
const KEYS = ["due_date", "due_month", "first_due", "recommits", "recommitted_at", "brief_date", "added_via",
  "archived", "archived_at", "archived_reason", "completed_via"] as const;
const pick = (m: Meta): Record<string, unknown> => Object.fromEntries(KEYS.map((k) => [k, m[k] === undefined ? null : m[k]]));

async function getTask(id: string): Promise<Thought | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await db.from("thoughts").select("id, content, owner, metadata, created_at")
    .eq("id", id).in("owner", [OWNER, "studio-strong"]).maybeSingle();
  if (error) throw new Error("thoughts: " + error.message);
  return (data as Thought | null) ?? null;
}
async function saveMeta(id: string, m: Meta) {
  const { error } = await db.from("thoughts").update({ metadata: m }).eq("id", id);
  if (error) throw new Error("thoughts: " + error.message);
}

async function openTaskOrError(id: string): Promise<{ t: Thought } | { res: Response }> {
  const t = await getTask(id);
  if (!t) return { res: json({ error: "That task wasn't found." }, 404) };
  const m = t.metadata || {};
  if (m.archived) return { res: json({ error: "That one is already finished or dropped." }, 409) };
  if (m.recurring) return { res: json({ error: "That task repeats, so it comes back on its own. Change it on the priorities page." }, 400) };
  return { t };
}

async function handleRecommit(body: Record<string, unknown>) {
  const today = todayCentral();
  const to = String(body.to || "");
  if (!DATE_RE.test(to) || Number.isNaN(Date.parse(to + "T12:00:00Z"))) return json({ error: "Pick a day." }, 400);
  if (to < today) return json({ error: "Pick today or a later day." }, 400);
  if (to > addDaysStr(today, 730)) return json({ error: "That's too far out." }, 400);
  const got = await openTaskOrError(String(body.id || ""));
  if ("res" in got) return got.res;
  const { t } = got;
  const m = { ...(t.metadata || {}) };
  const prev = pick(m);
  const was = lateness(m, today);
  const now = new Date().toISOString();
  if (!DATE_RE.test(String(m.first_due || ""))) {
    const orig = was?.eff || String(m.due_date || "").slice(0, 10);
    if (DATE_RE.test(orig)) m.first_due = orig;
  }
  m.recommits = (Number(m.recommits) || 0) + 1;
  m.recommitted_at = now;
  m.due_date = to; m.due_month = monthName(to);
  // A task moved to today that isn't already on this morning's list is put there the way the page's own
  // "add" does it, so it shows up right away instead of tomorrow.
  if (to === today) {
    const snap = await snapshotInfo(today);
    if (!snap.todayIds.has(t.id)) { m.brief_date = today; m.added_via = "brief"; }
  }
  await saveMeta(t.id, m);
  return json({ ok: true, id: t.id, due: to, prev });
}

async function handleFinish(body: Record<string, unknown>, how: "done" | "drop") {
  const got = await openTaskOrError(String(body.id || ""));
  if ("res" in got) return got.res;
  const { t } = got;
  const m = { ...(t.metadata || {}) };
  const prev = pick(m);
  m.archived = true; m.archived_at = new Date().toISOString();
  m.archived_reason = how === "done" ? "checked off on daily brief" : "dropped in past-due review";
  m.completed_via = how === "done" ? "past-due review" : "dropped in past-due review";
  await saveMeta(t.id, m);
  return json({ ok: true, id: t.id, prev });
}

async function handleUndo(body: Record<string, unknown>) {
  const t = await getTask(String(body.id || ""));
  if (!t) return json({ error: "That task wasn't found." }, 404);
  const prev = (body.prev && typeof body.prev === "object" ? body.prev : null) as Record<string, unknown> | null;
  if (!prev) return json({ error: "Nothing to undo." }, 400);
  const m = { ...(t.metadata || {}) };
  for (const k of KEYS) {
    if (!(k in prev)) continue;
    const v = prev[k];
    if (v === null) { delete m[k]; continue; }
    if (k === "archived") { m[k] = v === true; continue; }
    if (k === "recommits") { m[k] = Math.max(0, Math.min(1000, Number(v) || 0)); continue; }
    if (typeof v === "string" && v.length <= 80) m[k] = v;
  }
  await saveMeta(t.id, m);
  return json({ ok: true, id: t.id });
}

// ── Router ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "list":     return await handleList();
      case "recommit": return await handleRecommit(body);
      case "done":     return await handleFinish(body, "done");
      case "drop":     return await handleFinish(body, "drop");
      case "undo":     return await handleUndo(body);
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
