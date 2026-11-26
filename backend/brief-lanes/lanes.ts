// ============================================================
// Pure helpers for the brief-lanes function (no Deno or network calls, so they can be unit tested).
// Powers the "Calm" view of the brief: Dave's open tasks sorted into 8 categories ("lanes"), project cards
// with gates, quick wins, thank-yous, what is coming up, a daily marketing rep, and the Sunday sweep.
// Nothing here changes a task. Everything is derived from what is already on the task (thoughts.metadata).
// The only keys this feature ever writes are: lane, snooze_until, sweep_kept_at (and archived, for Drop in the sweep).
// ============================================================
import { clip, daysBetween, isArchived, isDavesTask, stripPrefix, todayCentral, type Meta, type Thought } from "./focus.ts";
export { clip, daysBetween, isDavesTask, stripPrefix, todayCentral };
export type { Meta, Thought };
export type Row = Thought & { updated_at?: string };

export const LANES = [
  { key: "studio", name: "Studio Strong" },
  { key: "trainerside", name: "TrainerSide" },
  { key: "health", name: "Health" },
  { key: "home", name: "Home and errands" },
  { key: "mom", name: "Mom" },
  { key: "people", name: "People" },
  { key: "reelcall", name: "ReelCall", badge: "Not now" },
  { key: "someday", name: "Someday" },
] as const;
export type LaneKey = (typeof LANES)[number]["key"];
export const LANE_KEYS = new Set<string>(LANES.map((l) => l.key));

export const COMING_DAYS = 10;      // dates show up this many days ahead
export const QUICK_MAX = 6;
export const THANKS_MAX = 6;
export const SWEEP_MAX = 5;
export const SWEEP_AGE = 30;        // untouched this many days before the Sunday sweep asks about it
export const KEEP_DAYS = 30;        // "Keep" means: ask again in this many days
export const WEEK_PICK_MAX = 7;
export const DROPPED_REASON = "dropped in the Sunday sweep";
export const DROP_KEYS = ["archived", "archived_at", "archived_reason", "completed_via"] as const;

const isTrue = (v: unknown) => v === true || v === "true";
const dateOf = (v: unknown) => (v ? String(v).slice(0, 10) : "");

// A task from Doreen that Dave hasn't answered yet lives in From Doreen, not in these lists (same rule as the From Doreen card).
export function waitingOnDave(m: Meta): boolean {
  const toDave = (m.assignee === "dave" && m.captured_by === "doreen") || String(m.assigned_by ?? "").toLowerCase() === "doreen";
  if (!toDave) return false;
  const h = m.doreen_handoff as { state?: string } | undefined;
  if (h && h.state === "accepted") return false;
  if (h && h.state === "pushed_back" && m.assignee !== "dave") return false;
  return true;
}
// An open task that belongs on Dave's lists.
export const isMine = (t: Row) => isDavesTask(t.metadata || {}) && !waitingOnDave(t.metadata || {});

// ── Categories ────────────────────────────────────────────────
// First match wins. Dave can always move a task (it then carries `lane` and the rules are skipped).
export function laneOf(t: Row): LaneKey {
  const m = t.metadata || {};
  if (typeof m.lane === "string" && LANE_KEYS.has(m.lane)) return m.lane as LaneKey;
  const text = stripPrefix(t.content).toLowerCase();
  if (typeof m.project === "string" && m.project.startsWith("trainerside")) return "trainerside";
  if (/reel ?call/.test(text)) return "reelcall";
  if (/trainerside|pt ?minder/.test(text)) return "trainerside";
  if (/^mom\b|\bmom's\b|\bmom:/.test(text)) return "mom";
  if (/thank[- ]?you|\bgift\b|birthday|guys time/.test(text)) return "people";
  if (/^\s*(follow-up client|previous client)\s*[—-]/i.test(t.content) || /^(studio strong (new lead|client) follow-up|new lead follow-up)/.test(text)) return "people";
  if (m.category === "health" || /blood draw|doctor|physician|dentist|dental/.test(text)) return "health";
  if (m.category === "home") return "home";
  return t.owner === "studio-strong" ? "studio" : "home";
}

// What shows in a list: the first line, and for the one-per-person follow-ups only the name part (no email or phone).
export function shortTitle(content: string, max = 120): string {
  let s = stripPrefix(content).split("\n").map((x) => x.trim()).find((x) => x) || "";
  const bar = s.indexOf(" | ");
  if (bar > 0) s = s.slice(0, bar);
  // The one-per-person follow-ups lose their prefix in stripPrefix; say what they are again.
  const pre = /^\s*(follow-up client|previous client)\s*[—-]/i.exec(content);
  if (pre) s = (/^follow/i.test(pre[1]) ? "Follow up with " : "Previous client: ") + s;
  else if (/^studio strong (new lead|client) follow-up/i.test(s)) s = s.replace(/,\s*(email|contact)\b.*$/i, "");
  return clip(s, max);
}

export interface RowOut {
  id: string; title: string; lane: LaneKey; due: string; due_in: number | null; age: number; project: string; snooze: string; scope: "business" | "personal";
}
export function rowOut(t: Row, today: string): RowOut {
  const m = t.metadata || {};
  const due = dateOf(m.due_date);
  const snooze = dateOf(m.snooze_until);
  return {
    id: t.id, title: shortTitle(t.content), lane: laneOf(t), due, due_in: due ? daysBetween(today, due) : null,
    age: Math.max(0, daysBetween(todayCentral(new Date(t.created_at)), today)),
    project: typeof m.project === "string" ? m.project : "", snooze: snooze > today ? snooze : "",
    scope: t.owner === "studio-strong" ? "business" : "personal",
  };
}
const touched = (t: Row) => String(t.updated_at || t.created_at || "");

// Dated ones first (soonest first), then the most recently touched.
export function sortRows(a: Row, b: Row): number {
  const da = dateOf(a.metadata?.due_date), db = dateOf(b.metadata?.due_date);
  if (da && db) return da.localeCompare(db) || touched(b).localeCompare(touched(a));
  if (da) return -1;
  if (db) return 1;
  return touched(b).localeCompare(touched(a));
}

// ── Projects ──────────────────────────────────────────────────
export interface Gate { n: number; name: string; total: number; open: number; state: "done" | "now" | "later" }
export interface ProjectOut {
  key: string; name: string; gates: Gate[]; now: { n: number; name: string } | null; then: string;
  tasks: Array<{ id: string; title: string; due: string; due_in: number | null }>;
  due: string; due_in: number | null; open: number; total: number;
}
// `rows` includes finished tasks, so a gate can show as done.
export function buildProjects(rows: Row[], today: string): ProjectOut[] {
  const by = new Map<string, Row[]>();
  for (const t of rows) {
    const k = t.metadata?.project;
    if (typeof k !== "string" || !k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(t);
  }
  const out: ProjectOut[] = [];
  for (const [key, list] of by) {
    const open = list.filter((t) => !isArchived(t.metadata || {}) && !waitingOnDave(t.metadata || {}));
    if (!open.length) continue;      // finished projects drop off
    const gm = new Map<number, Gate>();
    for (const t of list) {
      const m = t.metadata || {};
      const n = Number(m.project_gate) || 0;
      const g = gm.get(n) || { n, name: "", total: 0, open: 0, state: "later" as const };
      if (!g.name && typeof m.project_gate_name === "string") g.name = m.project_gate_name;
      g.total++;
      if (!isArchived(m)) g.open++;
      gm.set(n, g);
    }
    const gates = [...gm.values()].sort((a, b) => a.n - b.n);
    const nowG = gates.find((g) => g.open > 0) || null;
    for (const g of gates) g.state = g.open === 0 ? "done" : g === nowG ? "now" : "later";
    const nowTasks = open.filter((t) => (Number(t.metadata?.project_gate) || 0) === nowG?.n).sort(sortRows);
    const nextG = nowG ? gates.find((g) => g.n > nowG.n && g.open > 0) : null;
    const dues = open.map((t) => dateOf(t.metadata?.due_date)).filter(Boolean).sort();
    const due = dues[0] || "";
    out.push({
      key, name: String(list.find((t) => typeof t.metadata?.project_name === "string")?.metadata?.project_name || key),
      gates, now: nowG ? { n: nowG.n, name: nowG.name } : null, then: nextG ? nextG.name : "",
      tasks: nowTasks.slice(0, 6).map((t) => { const d = dateOf(t.metadata?.due_date); return { id: t.id, title: shortTitle(t.content, 140), due: d, due_in: d ? daysBetween(today, d) : null }; }),
      due, due_in: due ? daysBetween(today, due) : null, open: open.length, total: list.length,
    });
  }
  // The ones with a date coming first, then by name.
  return out.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : a.name.localeCompare(b.name)));
}

// ── Quick wins, thank-yous, coming up ─────────────────────────
const QUICK_VERB = /^(cancel|schedule|call|send|pay|order|email|text|reply|book|confirm|renew|get|put|post|remember|sign|set|check|ask|decide|choose|report|move|bring|find|disable|verify|resolve|reconcile|review|follow up)\b/i;
export const isThanks = (t: Row) => /thank[- ]?you/i.test(stripPrefix(t.content));
const snoozed = (m: Meta, today: string) => dateOf(m.snooze_until) > today;

// Short, one-step jobs: starts with a doing word, one line, no project, not a thank-you. A guess; Dave can move anything.
export function quickWins(mine: Row[], today: string): RowOut[] {
  return mine.filter((t) => {
    const m = t.metadata || {};
    if (m.project || snoozed(m, today) || isThanks(t)) return false;
    const lane = laneOf(t);
    if (lane === "reelcall" || lane === "someday" || lane === "people") return false;
    const text = stripPrefix(t.content);
    if (text.length > 110 || text.includes("\n") || !QUICK_VERB.test(text)) return false;
    const d = dateOf(m.due_date);
    return !d || daysBetween(today, d) <= COMING_DAYS;
  }).sort(sortRows).slice(0, QUICK_MAX).map((t) => rowOut(t, today));
}
export function thankYous(mine: Row[], today: string): RowOut[] {
  return mine.filter((t) => isThanks(t) && !snoozed(t.metadata || {}, today))
    .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, THANKS_MAX).map((t) => rowOut(t, today));
}
// One-time dates from today to COMING_DAYS ahead. (Anything already late is in Past due.)
export function comingUp(mine: Row[], today: string): RowOut[] {
  return mine.filter((t) => {
    const d = dateOf(t.metadata?.due_date);
    if (!d || t.metadata?.project || snoozed(t.metadata || {}, today)) return false;
    const n = daysBetween(today, d);
    return n >= 0 && n <= COMING_DAYS;
  }).sort(sortRows).map((t) => rowOut(t, today));
}

// ── All your items (by category) ──────────────────────────────
export interface CatOut { key: LaneKey; name: string; badge?: string; count: number; items: RowOut[] }
export function buildCats(mine: Row[], today: string): CatOut[] {
  const by = new Map<LaneKey, Row[]>();
  for (const l of LANES) by.set(l.key, []);
  for (const t of mine) by.get(laneOf(t))!.push(t);
  return LANES.map((l) => {
    const list = by.get(l.key)!.sort(sortRows);
    return { key: l.key, name: l.name, ...("badge" in l ? { badge: l.badge } : {}), count: list.length, items: list.map((t) => rowOut(t, today)) };
  });
}

// ── Sunday: the sweep ─────────────────────────────────────────
// Up to 5 undated, not-in-a-project tasks nobody has touched for 30 days (oldest first), skipping ReelCall and Someday,
// anything Dave already kept recently, and anything snoozed.
export function sweepList(mine: Row[], today: string): { items: RowOut[]; left: number } {
  const all = mine.filter((t) => {
    const m = t.metadata || {};
    if (m.due_date || m.project || snoozed(m, today)) return false;
    const lane = laneOf(t);
    if (lane === "reelcall" || lane === "someday") return false;
    const kept = dateOf(m.sweep_kept_at);
    if (kept && daysBetween(kept, today) < KEEP_DAYS) return false;
    return daysBetween(todayCentral(new Date(touched(t))), today) >= SWEEP_AGE;
  }).sort((a, b) => touched(a).localeCompare(touched(b)));
  return { items: all.slice(0, SWEEP_MAX).map((t) => rowOut(t, today)), left: Math.max(0, all.length - SWEEP_MAX) };
}

// What a sweep choice writes, and the old values so it can be undone.
export type SweepHow = "keep" | "snooze" | "park" | "drop";
const SWEEP_TOUCH = ["lane", "snooze_until", "sweep_kept_at", ...DROP_KEYS] as const;
export function sweepApply(m: Meta, how: SweepHow, today: string, now: string, days = 7): { ok: true; meta: Meta; prev: Record<string, unknown> } | { ok: false; error: string } {
  if (isArchived(m)) return { ok: false, error: "That one is already finished." };
  const prev: Record<string, unknown> = {};
  for (const k of SWEEP_TOUCH) prev[k] = k in m ? m[k] : null;
  const out: Meta = { ...m };
  if (how === "keep") out.sweep_kept_at = today;
  else if (how === "snooze") {
    const d = [7, 14, 30].includes(days) ? days : 7;
    const x = new Date(today + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + d);
    out.snooze_until = x.toISOString().slice(0, 10);
  } else if (how === "park") out.lane = "someday";
  else if (how === "drop") { out.archived = true; out.archived_at = now; out.archived_reason = DROPPED_REASON; out.completed_via = DROPPED_REASON; }
  else return { ok: false, error: "Unknown choice." };
  return { ok: true, meta: out, prev };
}
export function sweepUndo(m: Meta, prevRaw: unknown): { ok: true; meta: Meta } | { ok: false; error: string } {
  if (!prevRaw || typeof prevRaw !== "object") return { ok: false, error: "Nothing to undo." };
  // A drop can only be taken back if this feature made it.
  if (isArchived(m) && m.archived_reason !== DROPPED_REASON) return { ok: false, error: "That one was closed somewhere else, so it stays closed." };
  const p = prevRaw as Record<string, unknown>;
  const out: Meta = { ...m };
  for (const k of SWEEP_TOUCH) {
    if (!(k in p)) continue;
    const v = p[k];
    if (v === null || v === undefined) { delete out[k]; continue; }
    if (k === "archived") { out.archived = v === true; continue; }
    if (k === "lane" && !(typeof v === "string" && LANE_KEYS.has(v))) return { ok: false, error: "Can't undo that." };
    if (typeof v !== "string" || v.length > 120) return { ok: false, error: "Can't undo that." };
    out[k] = v;
  }
  return { ok: true, meta: out };
}

export function setLane(m: Meta, lane: string): { ok: true; meta: Meta } | { ok: false; error: string } {
  if (isArchived(m)) return { ok: false, error: "That one is already finished." };
  const out: Meta = { ...m };
  if (lane === "" || lane === "auto") { delete out.lane; return { ok: true, meta: out }; }
  if (!LANE_KEYS.has(lane)) return { ok: false, error: "Unknown category." };
  out.lane = lane;
  return { ok: true, meta: out };
}

// ── Grouping related items into a project ─────────────────────
// Suggests, and never decides: items you just added that start with the name of a project that already exists
// ("TrainerSide: dashboard icons" → TrainerSide for other gyms) can be put in that project, in a step you pick.
// The only keys written are the four project keys below, and Undo puts back exactly what was there.
export const GROUP_MAX = 12;           // items in one go
export const GROUP_OTHERS_MAX = 8;     // other open tasks offered along with them
export const NEW_STEP_NAME = "New items";
export const GROUP_KEYS = ["project", "project_name", "project_gate", "project_gate_name"] as const;

const toks = (s: string) => s.toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);
export interface Cand { key: string; text: string }
// What a task's first words could be called: the bit before a colon or dash ("Previous client", "Trainerside · Legal") and its first word.
export function candidates(content: string): Cand[] {
  const out: Cand[] = [], seen = new Set<string>();
  const add = (text: string) => {
    const key = toks(text).join(" ");
    if (key.replace(/ /g, "").length < 4 || seen.has(key)) return;
    seen.add(key); out.push({ key, text: text.trim() });
  };
  for (const src of [content, stripPrefix(content)]) {
    const line = src.split("\n")[0].trim();
    const m = /^([^:—–]{2,40}?)\s*(?::|—|–|\s-\s)\s*\S/.exec(line);
    if (m && m[1].trim().split(/\s+/).length <= 4) add(m[1]);
    const w = /^[A-Za-z][A-Za-z0-9’']*/.exec(line);
    if (w) add(w[0]);
  }
  return out;
}
const startsWithToks = (name: string[], cand: string[]) => cand.length > 0 && cand.length <= name.length && cand.every((t, i) => name[i] === t);
// The one open project whose name (or short id) begins with these words. Two or more is too unclear to suggest.
export function projectFor(c: Cand, projects: ProjectOut[]): ProjectOut | null {
  const want = c.key.split(" ");
  const hits = projects.filter((p) => startsWithToks(toks(p.name), want) || startsWithToks(toks(p.key), want));
  return hits.length === 1 ? hits[0] : null;
}
export interface GroupPlan { project: ProjectOut; cand: Cand; items: Row[] }
// Which of these new items belong with which project. Only open tasks of Dave's that are in no project yet.
export function planGroups(newRows: Row[], projects: ProjectOut[]): GroupPlan[] {
  const by = new Map<string, GroupPlan>();
  for (const t of newRows) {
    const m = t.metadata || {};
    if (isArchived(m) || m.project || !isMine(t)) continue;
    for (const c of candidates(t.content)) {
      const p = projectFor(c, projects);
      if (!p) continue;
      const g = by.get(p.key) || { project: p, cand: c, items: [] };
      g.items.push(t); by.set(p.key, g);
      break;
    }
  }
  return [...by.values()];
}
// Other open tasks that begin with the same words and are in no project: offered, never pre-ticked.
export function othersFor(plan: GroupPlan, loose: Row[]): Row[] {
  const mine = new Set(plan.items.map((t) => t.id));
  return loose.filter((t) => !mine.has(t.id) && isMine(t) && !t.metadata?.project && !isArchived(t.metadata || {}) &&
    candidates(t.content).some((c) => c.key === plan.cand.key)).sort(sortRows).slice(0, GROUP_OTHERS_MAX);
}
export interface StepOut { n: number; name: string; open: number; state: Gate["state"] }
export function stepsOf(p: ProjectOut): { steps: StepOut[]; newStep: { n: number; name: string; reuse: boolean } } {
  const steps = p.gates.filter((g) => g.state !== "done").map((g) => ({ n: g.n, name: g.name, open: g.open, state: g.state }));
  const had = p.gates.find((g) => g.name === NEW_STEP_NAME && g.state !== "done");
  const top = p.gates.reduce((a, g) => Math.max(a, g.n), 0);
  return { steps, newStep: had ? { n: had.n, name: had.name, reuse: true } : { n: top + 1, name: NEW_STEP_NAME, reuse: false } };
}
export function resolveStep(p: ProjectOut, gate: unknown): { ok: true; n: number; name: string } | { ok: false; error: string } {
  const s = stepsOf(p);
  if (gate === undefined || gate === null || gate === "new") return { ok: true, n: s.newStep.n, name: s.newStep.name };
  const g = s.steps.find((x) => x.n === Number(gate));
  return g ? { ok: true, n: g.n, name: g.name } : { ok: false, error: "That step isn't open any more." };
}
export function groupApply(m: Meta, project: { key: string; name: string }, step: { n: number; name: string }): { ok: true; meta: Meta; prev: Record<string, unknown> } | { ok: false; error: string } {
  if (isArchived(m)) return { ok: false, error: "That one is already finished." };
  if (typeof m.project === "string" && m.project) return { ok: false, error: "That one is already in a project." };
  const prev: Record<string, unknown> = {};
  for (const k of GROUP_KEYS) prev[k] = k in m ? m[k] : null;
  return { ok: true, meta: { ...m, project: project.key, project_name: project.name, project_gate: step.n, project_gate_name: step.name }, prev };
}
export function groupUndo(m: Meta, project: string, prevRaw: unknown): { ok: true; meta: Meta } | { ok: false; error: string } {
  if (!prevRaw || typeof prevRaw !== "object") return { ok: false, error: "Nothing to undo." };
  if (m.project !== project) return { ok: false, error: "That one has been moved to another project, so it stays there." };
  const p = prevRaw as Record<string, unknown>, out: Meta = { ...m };
  for (const k of GROUP_KEYS) {
    if (!(k in p)) continue;
    const v = p[k];
    if (v === null || v === undefined) { delete out[k]; continue; }
    if (k === "project_gate") { if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: "Can't undo that." }; out[k] = v; continue; }
    if (typeof v !== "string" || v.length > 120) return { ok: false, error: "Can't undo that." };
    out[k] = v;
  }
  return { ok: true, meta: out };
}

// ── The week, and the daily marketing rep ─────────────────────
export const dowOf = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();   // 0 = Sunday
export function weekStart(d: string): string {                                 // the Monday of that week
  const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
export const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
// The week a project pick is for: next week's projects are chosen on a Sunday, so on a Sunday that is the coming week.
export const pickWeek = (d: string) => (dowOf(d) === 0 ? addDays(weekStart(d), 7) : weekStart(d));

// A starter set of small asks, one a day in turn. Written for a gym owner who builds more than he sells.
export const REP_ASKS = [
  "Text one past client who has gone quiet: \"Thinking of you. Want to come in for a free check-in session?\"",
  "Ask one happy client for a Google review. One sentence is enough.",
  "Ask one client: \"Who do you know who would love training here? I'd be glad to meet them.\"",
  "Ask a lead who went quiet for a yes or no: \"Do you want to start next week?\"",
  "Ask one client for a one-line testimonial you can use on your page.",
  "Ask a nearby business owner to swap a shout-out with you.",
  "Offer one prospect a free 15-minute session this week.",
  "Ask a client why they chose Studio Strong over the big gym. Write down their words.",
  "Ask one former client what would bring them back.",
  "Ask a trainer or gym owner you know what they would hate to lose if they changed software.",
  "Ask one client to bring a friend to a session this week.",
  "Ask someone who follows your page to a conversation, not a sale: \"What are you working on with your health?\"",
  "Send one person a plain price and a start date, and ask if they want it.",
  "Ask one client if you may share their progress story, with their name or without.",
];
export const repAsk = (today: string) => REP_ASKS[Math.floor(Date.parse(today + "T12:00:00Z") / 86_400_000) % REP_ASKS.length];
export const REP_LESSON: Record<string, string> = {
  asked: "You asked. That is the whole rep, whatever they say.",
  yes: "A yes. Write down exactly what you said, so you can say it again.",
  no: "A no is an answer, not a verdict. Now you know. Ask the next person.",
};
export type RepResult = "asked" | "yes" | "no";
export function repTally(records: Array<{ result?: string } | null | undefined>) {
  let asks = 0, yes = 0, no = 0;
  for (const r of records) { if (!r || !r.result) continue; asks++; if (r.result === "yes") yes++; if (r.result === "no") no++; }
  return { asks, yes, no };
}

// ── Sunday: the week ahead (one-time dates and repeating ones, next 7 days) ──
export function repeatLabel(r: unknown): string {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    const o = r as { unit?: unknown; every?: unknown };
    if (typeof o.unit === "string" && Number(o.every) > 0) return Number(o.every) === 1 ? `every ${o.unit.replace(/s$/, "")}` : `every ${o.every} ${o.unit}`;
  }
  return "repeats";
}
export interface AheadOut { id: string; title: string; due: string; due_in: number; repeat: string }
export function weekAhead(open: Row[], today: string): AheadOut[] {
  return open.filter((t) => {
    const m = t.metadata || {};
    if (isArchived(m) || m.assignee === "doreen" || m.category === "dids-followup" || waitingOnDave(m)) return false;
    if (!["task", ""].includes(String(m.type ?? "task").toLowerCase())) return false;
    const d = dateOf(m.due_date);
    if (!d) return false;
    const n = daysBetween(today, d);
    return n >= 1 && n <= 7;
  }).sort((a, b) => dateOf(a.metadata?.due_date).localeCompare(dateOf(b.metadata?.due_date)))
    .map((t) => { const d = dateOf(t.metadata?.due_date); return { id: t.id, title: shortTitle(t.content), due: d, due_in: daysBetween(today, d), repeat: repeatLabel(t.metadata?.recurring) }; });
}
