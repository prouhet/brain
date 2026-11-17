// ============================================================
// STUDIO STRONG OPEN BRAIN — Morning Brief v1.22
//   v1.22: Jev (TypeSafe decision model) gives the list a second opinion. One quick call per task
//          scores how costly a slip would be (orders items within a tier), whether it's a ~15-minute
//          job (⚡ tag) and which tier it belongs in (an item sitting in tier 4/5 that Jev confidently
//          puts in tiers 1–3 moves up; tier_override always wins). Needs the JEV_API_KEY secret; with
//          no key, or if Jev errors or is slow, the brief is built exactly as before. brief.jev
//          records what happened so a quiet failure is visible.
//   v1.21: dids follow-ups are labelled by what the flag really means (missed / almost at goal /
//          recheck due / needs a goal) so "almost at goal" and "recheck due" no longer read as a
//          client who stopped; removed a prompt example the AI was copying onto the wrong client.
// ============================================================
// One printable email each morning + a live check-off page.
//
//   POST ?key=BRIEF_TRIGGER_KEY[&send=0][&date=YYYY-MM-DD]
//        Build today's brief, save it, email it. (cron calls this)
//        send=0 → build + save, return the HTML, don't email (for testing)
//
//   GET  ?key=BRIEF_PAGE_KEY[&date=YYYY-MM-DD]
//        Brief data for reelcall.app/brief.html, with live done/notes status
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, date, ... }
//        check   { id }                 → archive (recurring: mark completed)
//        uncheck { id }                 → undo a check
//        note    { id, text }           → append a note to the task
//        push    { id, to? }            → move due date to tomorrow, or to a picked date
//        not_task { id }                → mis-tagged at capture — reclassify as a note (content
//                                          untouched; stops showing as a task here and on priorities)
//        assign  { id, to }             → to: "doreen" sets the task aside as Doreen's (out of the numbered
//                                          list, Upcoming and Don't Forget, into a collapsed "for Doreen"
//                                          row); "dave" claims it back; "" clears the tag. Nothing is
//                                          archived or deleted either way.
//        edit    { id, content, scope?, due?, recurring?, tier?, category? }
//                                       → reword a task and/or change who/when/repeat/priority/category
//                                         (same fields and values as capture.html; only keys sent are changed)
//        add     { content, scope, due?, recurring?, tier?, category? }
//                                       → new task (due defaults to that day)
//        jev_preview { date? }          → read-only dry run of the Jev step on that day's brief tasks:
//                                         what Jev says and how the list would re-order. Writes nothing.
//        save_fitness { date, workout: [{exercise,reps,weight,time}×≤7], summary: {time,calories,hr}, walk: {distance,time,hr} }
//                                       → save that day's workout/walk log (own table, not a brain task).
//                                         summary is the whole-session totals (e.g. off a watch) — distinct
//                                         from each slot's own time, which is that one exercise's time.
//
//   GET  ?key=BRIEF_PAGE_KEY&date=...  also returns fitness: the log for that day (or null);
//        brief.fitness_suggestion carries that morning's suggested workout, once enough history exists;
//        brief.upcoming (dated backlog beyond today's main list, incl. anything overdue past
//        STALE_DAYS, plus items given only a target month via due_month) and brief.tickler
//        (a few undated but important items) — today only, live, not part of the once-a-day
//        snapshot. Their ids are valid targets for every action above.
//        brief.doreen: tasks set aside as Doreen's (metadata.assignee = "doreen", or captured by her
//        and not claimed back) — today only, live. They never reach the numbered list, Upcoming,
//        the tickler, "Added today" or the email.
//        brief.observations[id] = {content, tasks_total, tasks_done} for any item whose
//        source_observation points at a captured note that extracted several linked tasks —
//        same grouping priorities already shows, computed fresh on every load.
//
// The page key can ONLY touch tasks that are on a brief. It can't read or
// change anything else in the brain.
//
// Secrets (project-wide — most already exist):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
//   POSTMARK_SERVER_TOKEN, RECAP_TRIGGER_KEY            (already set)
//   BRIEF_TRIGGER_KEY   new — long random string, used by cron
//   BRIEF_PAGE_KEY      new — long random string, goes in the email link/QR
//   GCAL_ICS_URL        new — Google Calendar "Secret address in iCal format"
// Optional:
//   JEV_API_KEY (TypeSafe API key; turns the Jev second opinion on), JEV_API_URL
//   (default https://api.typesafe.ai/v1/systemone), JEV_MODEL (default jev-latest),
//   BRIEF_OWNER (default "dave"), BRIEF_TO (no default in this public copy),
//   BRIEF_MODEL (default claude-haiku-4-5-20251001),
//   BRIEF_PAGE_URL (default https://reelcall.app/brief.html)
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import ICAL from "npm:ical.js@2.1.0";
import QRCode from "npm:qrcode@1.5.4";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const SUPABASE_URL      = env("SUPABASE_URL");
const SERVICE_KEY       = env("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const POSTMARK_TOKEN    = env("POSTMARK_SERVER_TOKEN");
const RECAP_KEY         = env("RECAP_TRIGGER_KEY");
const TRIGGER_KEY       = env("BRIEF_TRIGGER_KEY");
const PAGE_KEY          = env("BRIEF_PAGE_KEY");
const GCAL_ICS_URL      = env("GCAL_ICS_URL");
const JEV_API_KEY       = env("JEV_API_KEY");
const JEV_API_URL       = env("JEV_API_URL", "https://api.typesafe.ai/v1/systemone");
const JEV_MODEL         = env("JEV_MODEL", "jev-latest");
const OWNER            = env("BRIEF_OWNER", "dave");
const TO_EMAIL          = env("BRIEF_TO", "");
const MODEL             = env("BRIEF_MODEL", "claude-haiku-4-5-20251001");
const PAGE_URL          = env("BRIEF_PAGE_URL", "https://reelcall.app/brief.html");
const FROM_EMAIL        = "connect@studiostrong.fit";
const TZ                = "America/Chicago";
const MAX_TASKS         = 15;   // keeps the printout to about one page
const MAX_DIDS          = 5;

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ── Dates (always Central time) ─────────────────────────────
function todayCentral(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function tzOffsetMs(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - at.getTime();
}
function centralMidnight(dateStr: string): Date {
  const noon = new Date(dateStr + "T12:00:00Z");
  return new Date(new Date(dateStr + "T00:00:00Z").getTime() - tzOffsetMs(noon));
}
function longDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
  });
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}
const monthName = (dateStr: string) =>
  new Date(dateStr + "T12:00:00Z").toLocaleString("en-US", { timeZone: "UTC", month: "long" }).toLowerCase();

// ── Text helpers ──────────────────────────────────────────────
const PREFIX_RE =
  /^\s*(ACTIVE TASK\s*(\([^)]*\))?\s*:|PREVIOUS CLIENT\s*[—-]|FOLLOW-UP CLIENT\s*[—-]|RECURRING\s*:)\s*/i;
const stripPrefix = (s: string) => s.replace(PREFIX_RE, "").trim();
const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function keywordTier(content: string): number {
  const c = content.toLowerCase();
  if (/invest|tsp|compound|wealth|retirement/.test(c)) return 1;
  if (/automation|strategy|system|process|infrastructure/.test(c)) return 2;
  if (/tax|1099|legal|deadline|medical|insurance|psa|doctor/.test(c)) return 3;
  if (/newsletter|article|client|chamber|deliverable|dids?\b|follow.?up|call|text|email|member|session|trainer/.test(c)) return 4;
  return 5;
}

const TIERS: Record<number, { icon: string; name: string }> = {
  1: { icon: "🔴", name: "Opportunity cost" },
  2: { icon: "🟠", name: "Working on the business" },
  3: { icon: "🟡", name: "High consequence" },
  4: { icon: "🔵", name: "Working in the business" },
  5: { icon: "⚪", name: "Maintenance" },
};

// ── Types ────────────────────────────────────────────────────────
type Meta = Record<string, unknown>;
interface Thought { id: string; content: string; owner: string; metadata: Meta; created_at: string }
interface Appt { time: string; title: string; location?: string; all_day: boolean; sort: number }
interface Item {
  n: number; id: string; title: string; detail?: string; tier: number; tier_auto?: number;
  section: "task" | "client"; recurring?: boolean; added?: boolean;
  quick?: boolean;   // Jev: about 15 minutes or less
  slip?: number;     // Jev: cost of another week's slip, 0 (nothing) to 4 (serious)
}
interface BriefData {
  date: string; headline: string; appointments: Appt[]; calendar_ok: boolean;
  dids_ok: boolean; items: Item[]; generated_at: string; stale_overdue?: number;
  fitness_suggestion?: FitSuggestion | null;
  jev?: { ok: boolean; scored: number; promoted: number; error?: string };
}

// ── Fitness log: a personal daily record, separate from the task list ──────
const MAX_SLOTS = 7;
interface FitSlot { exercise: string; reps: string; weight: string; time: string }
interface FitSummary { time: string; calories: string; hr: string }
interface FitWalk { distance: string; time: string; hr: string }
interface FitLog { workout: FitSlot[]; summary: FitSummary; walk: FitWalk; updated_at: string }
const clipStr = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
function sanitizeWorkout(input: unknown): FitSlot[] {
  const arr = Array.isArray(input) ? input.slice(0, MAX_SLOTS) : [];
  return arr.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return { exercise: clipStr(o.exercise, 80), reps: clipStr(o.reps, 10), weight: clipStr(o.weight, 10), time: clipStr(o.time, 20) };
  });
}
function sanitizeWalk(input: unknown): FitWalk {
  const o = (input ?? {}) as Record<string, unknown>;
  return { distance: clipStr(o.distance, 10), time: clipStr(o.time, 20), hr: clipStr(o.hr, 10) };
}
function sanitizeSummary(input: unknown): FitSummary {
  const o = (input ?? {}) as Record<string, unknown>;
  return { time: clipStr(o.time, 20), calories: clipStr(o.calories, 10), hr: clipStr(o.hr, 10) };
}
async function fetchFitness(date: string): Promise<FitLog | null> {
  const { data } = await db.from("fitness_logs").select("workout, summary, walk, updated_at").eq("log_date", date).eq("owner", OWNER).maybeSingle();
  if (!data) return null;
  return { workout: sanitizeWorkout(data.workout), summary: sanitizeSummary(data.summary), walk: sanitizeWalk(data.walk), updated_at: data.updated_at as string };
}

// Once there's enough history, the brief proposes today's workout: the same
// exercises with a small nudge up where things have plateaued, and a walk
// distance target. It only ever fills BLANK boxes on a day nothing's been
// logged yet — never touches something already typed or saved.
const FIT_HISTORY_MIN_DAYS = 3;
interface FitSuggestion { note: string; workout: FitSlot[]; walk: FitWalk }

async function fetchFitnessHistory(beforeDate: string, days = 14): Promise<{ date: string; workout: FitSlot[]; walk: FitWalk }[]> {
  const { data } = await db.from("fitness_logs")
    .select("log_date, workout, walk")
    .eq("owner", OWNER)
    .lt("log_date", beforeDate)
    .order("log_date", { ascending: false })
    .limit(days);
  return ((data || []) as { log_date: string; workout: unknown; walk: unknown }[]).map((r) => ({
    date: r.log_date, workout: sanitizeWorkout(r.workout), walk: sanitizeWalk(r.walk),
  }));
}
const hasFitEntry = (d: { workout: FitSlot[]; walk: FitWalk }) => d.workout.some((s) => s.exercise.trim()) || !!d.walk.distance.trim();

async function suggestWorkout(today: string, history: { date: string; workout: FitSlot[]; walk: FitWalk }[]): Promise<FitSuggestion | null> {
  const logged = history.filter(hasFitEntry);
  if (logged.length < FIT_HISTORY_MIN_DAYS) return null;

  const lines = logged.map((d) => {
    const ex = d.workout.filter((s) => s.exercise.trim())
      .map((s) => `${s.exercise}${s.reps ? ` x${s.reps}` : ""}${s.weight ? ` @${s.weight}lb` : ""}${s.time ? ` (${s.time})` : ""}`)
      .join(", ");
    const w = d.walk.distance.trim() ? `Walk ${d.walk.distance}mi${d.walk.time ? ` in ${d.walk.time}` : ""}${d.walk.hr ? ` avg HR ${d.walk.hr}` : ""}` : "";
    return `${d.date}: ${[ex, w].filter(Boolean).join(" | ") || "(nothing logged)"}`;
  }).join("\n");

  const prompt = `You're helping Dave plan today's (${longDate(today)}) short home workout and walk, based on what he's actually logged recently.

HIS GOALS: about 15 minutes of strength work and a 2-mile walk each day.

RECENT LOG (most recent first):
${lines}

Suggest today's plan: mostly the same exercises he's already doing — don't invent new ones out of nowhere — with a small, sensible progression where his numbers have plateaued (a bit more time, weight, or reps than last time, not a big jump). For the walk, suggest a target distance, nudging toward 2 miles if he's been under; leave walk time and heart rate blank since those are only known after he walks.

Produce JSON only, no markdown:
{"note":"one short, plain, encouraging sentence about today's plan","workout":[{"exercise":"name","reps":"","weight":"","time":""}],"walk":{"distance":"","time":"","hr":""}}

Rules:
- Up to ${MAX_SLOTS} workout entries, matching how many he typically logs — don't pad with extras.
- Only fill reps, weight, or time when that's the kind of target that fits the exercise (a stretch may have none).
- Keep values short, in his own style (weight like "90", time like "1:10").`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.content || []).map((c: { text?: string }) => c.text || "").join("").trim();
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text) as { note?: string; workout?: unknown; walk?: unknown };
    return { note: clipStr(parsed.note, 160), workout: sanitizeWorkout(parsed.workout), walk: sanitizeWalk(parsed.walk) };
  } catch (e) {
    console.error("suggestWorkout:", e);
    return null;
  }
}

// ── 1. Tasks from the brain ────────────────────────────────────────────────────
// Repeating tasks. The schedule is stored either as { every, unit } or as a
// word ("weekly", "biweekly", "monthly", ...).
type Recur = { n: number; unit: "day" | "week" | "month" | "year" };
function parseRecur(r: unknown): Recur | null {
  if (!r) return null;
  if (typeof r === "object") {
    const o = r as { every?: number; unit?: string };
    const u = String(o.unit || "days").toLowerCase();
    const n = Math.max(1, Number(o.every) || 1);
    return { n, unit: /week/.test(u) ? "week" : /month/.test(u) ? "month" : /year/.test(u) ? "year" : "day" };
  }
  const w = String(r).toLowerCase();
  if (/biweek|fortnight/.test(w)) return { n: 2, unit: "week" };
  if (/week/.test(w)) return { n: 1, unit: "week" };
  if (/quarter/.test(w)) return { n: 3, unit: "month" };
  if (/semi.?annual/.test(w)) return { n: 6, unit: "month" };
  if (/month/.test(w)) return { n: 1, unit: "month" };
  if (/year|annual/.test(w)) return { n: 1, unit: "year" };
  if (/day|daily/.test(w)) return { n: 1, unit: "day" };
  return { n: 1, unit: "week" };
}
function addRecur(dateStr: string, r: Recur): string {
  if (r.unit === "day") return addDaysStr(dateStr, r.n);
  if (r.unit === "week") return addDaysStr(dateStr, 7 * r.n);
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (r.unit === "month" ? r.n : 12 * r.n));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
// Next date a repeating task is due. With a due date it repeats on that
// schedule (same weekday each week, same day each month); the first date after
// the last check-off is the next one due. Without a due date it's due one
// interval after the last check-off, or now if it's never been checked off.
function nextRecurringDue(m: Meta, today: string): string {
  const r = parseRecur(m.recurring) || { n: 1, unit: "week" };
  const last = m.last_completed ? todayCentral(new Date(String(m.last_completed))) : "";
  const anchor = String(m.due_date || "").slice(0, 10);
  if (anchor) {
    let next = anchor;
    for (let i = 0; last && next <= last && i < 2000; i++) next = addRecur(next, r);
    return next;
  }
  return last ? addRecur(last, r) : today;
}
function recurringIsDue(m: Meta, today: string): boolean {
  return nextRecurringDue(m, today) <= today;
}

// ── Whose task is it? ────────────────────────────────────────────────
// The business pool ("studio-strong") is shared, so Doreen's own to-dos —
// captured from her sessions — land right next to Dave's, and nothing in a
// plain row says who a task is for. A task is Doreen's when it's tagged
// assignee "doreen", or was captured by her (captured_by) and Dave hasn't
// claimed it (assignee "dave"). Hers stay off Dave's list but are never
// dropped: the page keeps them in a collapsed "for Doreen" row, one tap from
// coming back.
const doreensMeta = (m: Meta): boolean => m.assignee !== "dave" && (m.assignee === "doreen" || m.captured_by === "doreen");
const isDoreens = (t: Thought): boolean => doreensMeta(t.metadata || {});

// A recurring task must stay "due" indefinitely once its date has passed and
// it's never been checked off — but the general fetch below is ordered by
// recency and capped, so an old recurring task (created long ago, still
// legitimately due) can silently fall outside that window as newer rows
// accumulate (dids follow-ups alone add up to 5 rows every morning). Fetching
// every recurring task unconditionally, with no recency window at all, means
// none of them — currently a small, fixed handful — can ever be lost that way.
async function fetchOpenTasks(today: string, includeDoreen = false): Promise<Thought[]> {
  const base = () => db.from("thoughts").select("id, content, owner, metadata, created_at").in("owner", [OWNER, "studio-strong"]);
  const notArchived = (q: ReturnType<typeof base>) => q.or("metadata->>archived.is.null,metadata->>archived.eq.false");

  const [{ data: recData, error: recErr }, { data: genData, error: genErr }] = await Promise.all([
    notArchived(base()).not("metadata->recurring", "is", null).limit(1000),
    notArchived(base())
      .or("metadata->>type.is.null,metadata->>type.eq.task")
      .or("metadata->>category.is.null,metadata->>category.neq.dids-followup")
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (recErr) throw new Error("thoughts(recurring): " + recErr.message);
  if (genErr) throw new Error("thoughts: " + genErr.message);

  const byId = new Map<string, Thought>();
  for (const t of (genData || []) as Thought[]) byId.set(t.id, t);
  for (const t of (recData || []) as Thought[]) byId.set(t.id, t);

  return [...byId.values()].filter((t) => {
    const m = t.metadata || {};
    const type = String(m.type || "").toLowerCase();
    if (type !== "task" && type !== "") return false;
    if (m.archived) return false;
    if (m.category === "dids-followup") return false; // regenerated fresh each day
    if (!includeDoreen && doreensMeta(m)) return false; // Doreen's own to-dos stay off Dave's list
    if (m.recurring) return recurringIsDue(m, today);
    return true;
  });
}

// Items that always make the list, no matter what the AI picks: anything
// due today or overdue by up to STALE_DAYS, and repeating tasks that are due.
// Older overdue items are counted, not listed, so they can't crowd out today.
const STALE_DAYS = 14;
const AHEAD_DAYS = 7;          // dated items further out than this stay off the brief
const dueOf = (t: Thought, today = todayCentral()) =>
  t.metadata?.recurring ? nextRecurringDue(t.metadata, today) : String(t.metadata?.due_date || "").slice(0, 10);
function isStale(t: Thought, today: string): boolean {
  const due = dueOf(t, today);
  return !t.metadata?.recurring && !!due && due < addDaysStr(today, -STALE_DAYS);
}
// An appointment whose date has passed happened; don't list it as overdue.
function isPastAppointment(t: Thought, today: string): boolean {
  const due = dueOf(t, today);
  return !t.metadata?.recurring && !!due && due < today && /\b(appointment|appt)\b/i.test(t.content);
}
// Added since the previous brief (e.g. notes captured last night)
function isNew(t: Thought, since: string): boolean {
  return !!since && t.created_at > since;
}
function isMustInclude(t: Thought, today: string, since = ""): boolean {
  if (isPastAppointment(t, today) || isStale(t, today)) return false;
  if (t.metadata?.recurring) return true;             // only due ones reach here
  const due = dueOf(t, today);
  if (due && due <= today) return true;
  return isNew(t, since) && (!due || due <= addDaysStr(today, AHEAD_DAYS));
}
// What the brief may show at all: the must-includes plus anything dated in the
// next AHEAD_DAYS. Undated backlog and far-off items stay on the priorities page.
function isEligible(t: Thought, today: string, since = ""): boolean {
  if (isMustInclude(t, today, since)) return true;
  const due = dueOf(t, today);
  return !!due && due > today && due <= addDaysStr(today, AHEAD_DAYS) && !isPastAppointment(t, today);
}

// A task due today that's really just a calendar entry ("Haircut appointment"
// vs. calendar "Haircut Amy") is left off; the schedule already shows it.
const GENERIC = new Set(["appointment", "meeting", "session", "today", "tomorrow", "studio", "strong"]);
function duplicatesCalendar(t: Thought, appts: Appt[], today: string): boolean {
  if (dueOf(t) !== today || !appts.length) return false;
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !GENERIC.has(w)) || []);
  const mine = words(stripPrefix(t.content));
  return appts.some((a) => [...words(a.title)].some((w) => mine.has(w)));
}

// Unchecked client follow-ups from earlier briefs (including an earlier run
// today) are replaced by the new analysis
async function supersedeOldFollowups(today: string) {
  const { data } = await db
    .from("thoughts")
    .select("id, metadata")
    .contains("metadata", { category: "dids-followup" });
  for (const t of (data || []) as { id: string; metadata: Meta }[]) {
    const m = t.metadata || {};
    if (m.archived || String(m.brief_date || "") > today) continue;
    await db.from("thoughts").update({
      metadata: { ...m, archived: true, archived_at: new Date().toISOString(), archived_reason: "replaced by a newer brief" },
    }).eq("id", t.id);
  }
}

// ── 2. Google Calendar (secret iCal address) ────────────────────────────────
// A Google feed holds every event ever. Parsing all of it blows the edge
// function CPU limit, so first drop (by plain text) everything that can't
// touch today: one-off events outside a ±2 day window and repeating events
// whose UNTIL has passed. Only what's left gets fully parsed.
function prefilterIcs(raw: string, today: string): string {
  const text = raw.replace(/\r?\n[ \t]/g, "");             // unfold long lines
  const first = text.indexOf("BEGIN:VEVENT");
  if (first < 0) return text;
  const header = text.slice(0, first);                      // VCALENDAR + VTIMEZONEs
  const lo = +addDaysStr(today, -2).replace(/-/g, "");
  const hi = +addDaysStr(today, 2).replace(/-/g, "");
  const dateOf = (block: string, prop: string) => {
    const m = block.match(new RegExp(`^${prop}[^:\\n]*:(\\d{8})`, "m"));
    return m ? +m[1] : 0;
  };
  const kept: string[] = [];
  for (const block of text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []) {
    const rrule = block.match(/^RRULE:(.*)$/m);
    if (rrule) {
      const until = rrule[1].match(/UNTIL=(\d{8})/);
      if (until && +until[1] < lo) continue;               // series already ended
      if (dateOf(block, "DTSTART") > hi) continue;          // series starts later
      kept.push(block);
      continue;
    }
    const rid = dateOf(block, "RECURRENCE-ID");
    const start = dateOf(block, "DTSTART");
    const end = dateOf(block, "DTEND") || start;
    if ((start && start <= hi && end >= lo) || (rid >= lo && rid <= hi)) kept.push(block);
  }
  return `${header}${kept.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}

// Start a repeating event's expansion shortly before the window instead of at
// its original start (possibly years ago). Only for DAILY/WEEKLY rules without
// COUNT, shifting by whole multiples of the interval so the pattern is unchanged.
function fastForwardStart(ev: ICAL.Event, windowStart: string): ICAL.Time {
  const s = ev.startDate;
  const rrule = ev.component.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  if (!rrule || rrule.count) return s;
  const freq = String(rrule.freq);
  if (freq !== "DAILY" && freq !== "WEEKLY") return s;
  const interval = rrule.interval || 1;
  const step = (freq === "WEEKLY" ? 7 : 1) * interval;
  const startDay = Date.UTC(s.year, s.month - 1, s.day);
  const target = new Date(addDaysStr(windowStart, -8) + "T00:00:00Z").getTime();
  const days = Math.floor((target - startDay) / 86400000);
  if (days <= step) return s;
  // Build a clean start at the shifted date from plain fields. Shifting the
  // original with addDuration() leaves ical.js expanding the wrong weeks for any
  // rule with INTERVAL > 1 (every-other-week events landed on the off weeks).
  const shiftedDay = new Date(startDay + Math.floor(days / step) * step * 86400000);
  return ICAL.Time.fromData({
    year: shiftedDay.getUTCFullYear(), month: shiftedDay.getUTCMonth() + 1, day: shiftedDay.getUTCDate(),
    hour: s.hour, minute: s.minute, second: s.second, isDate: s.isDate,
  }, s.zone);
}

async function fetchAppointments(today: string): Promise<{ ok: boolean; appts: Appt[] }> {
  if (!GCAL_ICS_URL) return { ok: false, appts: [] };
  try {
    const res = await fetch(GCAL_ICS_URL);
    if (!res.ok) throw new Error(`ics ${res.status}`);
    const comp = new ICAL.Component(ICAL.parse(prefilterIcs(await res.text(), today)));
    for (const tz of comp.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

    const dayStart = centralMidnight(today);
    const dayEnd = centralMidnight(addDaysStr(today, 1));
    const out: Appt[] = [];

    const vevents = comp.getAllSubcomponents("vevent");
    const exceptions = new Map<string, unknown[]>();
    for (const ve of vevents) {
      if (ve.hasProperty("recurrence-id")) {
        const uid = String(ve.getFirstPropertyValue("uid"));
        exceptions.set(uid, [...(exceptions.get(uid) || []), ve]);
      }
    }

    const consider = (summary: string, location: string, status: string, start: ICAL.Time, end: ICAL.Time | null) => {
      if (status.toUpperCase() === "CANCELLED") return;
      if (start.isDate) {
        const s = start.toString().slice(0, 10);
        const e = end ? end.toString().slice(0, 10) : addDaysStr(s, 1);
        if (s <= today && today < e) out.push({ time: "All day", title: summary, location, all_day: true, sort: -1 });
        return;
      }
      const s = start.toJSDate();
      const e = end ? end.toJSDate() : s;
      if (s < dayEnd && e > dayStart && !(e.getTime() === s.getTime() && s < dayStart)) {
        out.push({ time: fmtTime(s), title: summary, location, all_day: false, sort: s.getTime() });
      }
    };

    for (const ve of vevents) {
      if (ve.hasProperty("recurrence-id")) continue;
      const ev = new ICAL.Event(ve);
      const status = String(ve.getFirstPropertyValue("status") || "");
      if (!ev.isRecurring()) {
        consider(ev.summary || "(no title)", ev.location || "", status, ev.startDate, ev.endDate);
        continue;
      }
      for (const ex of exceptions.get(ev.uid) || []) ev.relateException(ex as ICAL.Component);
      const it = ev.iterator(fastForwardStart(ev, today));
      const lo = +addDaysStr(today, -2).replace(/-/g, "");
      const hi = +addDaysStr(today, 2).replace(/-/g, "");
      let next: ICAL.Time | null;
      let guard = 0;
      while ((next = it.next()) && guard++ < 5000) {
        const nd = next.year * 10000 + next.month * 100 + next.day;   // cheap compare, no timezone math
        if (nd > hi) break;
        if (nd < lo) continue;
        const det = ev.getOccurrenceDetails(next);
        const occStatus = String(det.item.component.getFirstPropertyValue("status") || status);
        consider(det.item.summary || ev.summary || "(no title)", det.item.location || "", occStatus, det.startDate, det.endDate);
      }
    }
    out.sort((a, b) => a.sort - b.sort);
    return { ok: true, appts: out };
  } catch (e) {
    console.error("calendar:", e);
    return { ok: false, appts: [] };
  }
}

// ── 3. Dids flags from daily-recap (JSON mode) ────────────────
interface DidsFlags { no_goal: string[]; zero_week: string[]; short_week: string[]; missing: string[]; closing_in: string[]; recheck: string[] }
async function fetchDids(): Promise<{ ok: boolean; flags: DidsFlags | null }> {
  try {
    const u = `${SUPABASE_URL}/functions/v1/daily-recap?key=${encodeURIComponent(RECAP_KEY)}&format=json&trainer_email=${encodeURIComponent(TO_EMAIL)}`;
    const res = await fetch(u, { method: "POST" });
    if (!res.ok) throw new Error(`daily-recap ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const mine = (body.trainers || [])[0];
    return { ok: true, flags: mine ? mine.flags : null };
  } catch (e) {
    console.error("dids:", e);
    return { ok: false, flags: null };
  }
}

// ── 4. Claude: pick today's list + client action points ─────────────
interface Plan {
  headline: string;
  tasks: { id: string; title: string; tier: number; detail?: string }[];
  client_actions: { client: string; action: string; reason: string; kind?: string }[];
}

// What each daily-recap flag actually means. Only "miss" kinds are a client not doing something;
// "goal" is good news, "recheck" is Dave's own reminder to review a plan, "setup" is a missing goal.
const DIDS_FLAG: Record<string, { kind: string; meaning: string }> = {
  missing:    { kind: "miss",    meaning: "MISSED (a real miss: the client skipped their most recent scheduled day)" },
  zero_week:  { kind: "miss",    meaning: "MISSED (a real miss: did none of a weekly did last week)" },
  short_week: { kind: "miss",    meaning: "MISSED (a real miss: fell short on a weekly did last week)" },
  recheck:    { kind: "recheck", meaning: "RECHECK DUE (Dave's own reminder to review the plan; says nothing about whether the client is doing it)" },
  closing_in: { kind: "goal",    meaning: "GOOD NEWS (the client IS doing it and is a few check-ins from finishing their goal; not a problem)" },
  no_goal:    { kind: "setup",   meaning: "NEEDS A GOAL (no consistency goal set yet; not a client problem)" },
};
const KIND_LABEL: Record<string, string> = { miss: "Missed", goal: "Almost at goal 🎯", recheck: "Recheck due 📅", setup: "Needs a goal" };

async function plan(today: string, tasks: Thought[], appts: Appt[], flags: DidsFlags | null, since = ""): Promise<Plan> {
  const taskLines = tasks.filter((t) => isEligible(t, today, since)).slice(0, 120).map((t) => {
    const m = t.metadata || {};
    const due = dueOf(t, today) || "no date";
    const tier = (m.tier_override as number) || "";
    const rec = m.recurring ? " | recurring" : "";
    const must = isMustInclude(t, today, since) ? " | MUST INCLUDE" : "";
    const fresh = isNew(t, since) ? " | NEW" : "";
    const scope = t.owner === "studio-strong" ? "business" : "personal";
    return `[id:${t.id} | due:${due} | ${scope}${tier ? ` | tier_override:${tier}` : ""}${rec}${must}${fresh}] ${stripPrefix(t.content).slice(0, 240)}`;
  }).join("\n");

  const didsText = flags
    ? Object.entries(flags).filter(([, v]) => v.length).map(([k, v]) => `== ${DIDS_FLAG[k]?.meaning || k.toUpperCase()} ==\n${v.join("\n")}`).join("\n\n")
    : "No dids data today.";
  const apptText = appts.length ? appts.map((a) => `${a.time} ${a.title}`).join("\n") : "Nothing on the calendar.";

  const prompt = `Today is ${longDate(today)} (${today}). You're preparing Dave's printed morning brief for Studio Strong, a private personal training gym he co-owns with Doreen.

PRIORITY TIERS (show Tier 1 first):
1 Opportunity cost — every day delayed = lost growth (invest, TSP, compound, wealth, retirement)
2 Working ON the business — builds long-term value (automation, strategy, systems, process, infrastructure)
3 High consequence — penalties or health if missed (tax, 1099, legal, deadlines, medical, insurance)
4 Working IN the business — client commitments with deadlines (newsletter, article, client, chamber, deliverables)
5 Maintenance — routine (errands, subscriptions, appointments, groceries)
If a task has tier_override, use that tier exactly.

TODAY'S CALENDAR:
${apptText}

OPEN TASKS:
${taskLines || "None"}

DIDS.TODAY FLAGS (clients' daily habit check-ins; each line is one client and one did, under a heading that says what it means):
${didsText}

Produce JSON only, no markdown:
{"headline":"one sentence: the single most important thing today",
 "tasks":[{"id":"<exact id from input>","title":"short action, no prefixes","tier":1,"detail":"optional few words: due date or why now"}],
 "client_actions":[{"client":"First Last","kind":"miss|goal|recheck|setup","action":"specific thing Dave should do or say today","reason":"the flag, in plain words"}]}

Rules:
- Every task marked MUST INCLUDE (overdue, due today, repeating and due today, or NEW since yesterday) must be in tasks.
- tasks: up to ${MAX_TASKS}. The OPEN TASKS list is already limited to what's relevant this week; choose from it only. Every id must be copied exactly from the input. Each task at most once.
- Don't list a task that only repeats something already on TODAY'S CALENDAR (e.g. a haircut or appointment that's on the calendar). It's already printed in the schedule.
- client_actions: up to ${MAX_DIDS}, most important first: real misses (clients who've missed several days, zero-week clients) first, then overdue rechecks, then good news, then needs-a-goal. Skip a client whose only flag is minor if the list is already full. The action is a short instruction under 70 characters, not a script of what to say.
- Each client line sits under a heading that says what it means. Follow the heading: set "kind" to miss (MISSED), recheck (RECHECK DUE), goal (GOOD NEWS) or setup (NEEDS A GOAL).
  - Only a MISSED line may say or imply a client missed, stopped, restarted, or fell behind. Examples: "Text to check in", "Call about the missed week".
  - GOOD NEWS: the action is an encouragement, e.g. "Congrats text, 2 days from the 20/20 goal". Never frame it as a nudge or concern.
  - RECHECK DUE: the action is to review or reassess the plan, e.g. "Review plan; recheck due Sat". The client may be doing it fine.
  - NEEDS A GOAL: e.g. "Set a consistency goal for Notes".
  - Use only what the line says. Don't guess what else the client is or isn't doing from the name of the did.
- Titles under 90 characters.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((c: { text?: string }) => c.text || "").join("").trim();
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text) as Plan;
}

// If Claude is down, still send something useful
function fallbackPlan(tasks: Thought[], flags: DidsFlags | null, today: string, since = ""): Plan {
  const ranked = tasks
    .filter((t) => isEligible(t, today, since))
    .map((t) => ({ t, tier: (t.metadata?.tier_override as number) || keywordTier(t.content) }))
    .sort((a, b) => a.tier - b.tier)
    .slice(0, MAX_TASKS);
  const lines: { l: string; kind: string }[] = flags
    ? [
      ...[...flags.missing, ...flags.zero_week, ...flags.short_week].map((l) => ({ l, kind: "miss" })),
      ...flags.recheck.map((l) => ({ l, kind: "recheck" })),
      ...flags.closing_in.map((l) => ({ l, kind: "goal" })),
    ]
    : [];
  return {
    headline: "Automatic summary (AI step unavailable this morning).",
    tasks: ranked.map(({ t, tier }) => ({ id: t.id, title: stripPrefix(t.content).slice(0, 90), tier })),
    client_actions: lines.slice(0, MAX_DIDS).map(({ l, kind }) => {
      const [client, ...rest] = l.trim().split(" — ");
      return { client, kind, action: kind === "miss" ? "Check in" : kind === "recheck" ? "Review plan" : "Congrats text", reason: rest.join(" — ") };
    }),
  };
}

// Shorten at a word boundary so printed lines never end mid-word
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}

// Combine the AI's picks with the must-include items. Must-includes are never
// dropped: if the AI left one out it's added with its own wording, and they
// sort ahead of other items within their tier. Other picks fill the rest.
interface Chosen { id: string; title: string; detail?: string; tier: number; recurring: boolean; must: boolean; quick?: boolean; slip?: number }
function selectTasks(picked: Plan["tasks"], allTasks: Thought[], today: string, appts: Appt[] = [], since = ""): Chosen[] {
  const tasks = allTasks.filter((t) => isEligible(t, today, since) && !duplicatesCalendar(t, appts, today));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const toItem = (t: Thought, x?: Plan["tasks"][number]): Chosen => {
    const m = t.metadata || {};
    const tier = (m.tier_override as number) || Math.min(5, Math.max(1, Number(x?.tier) || keywordTier(t.content)));
    const due = dueOf(t, today);
    const detail = x?.detail || (due && due < today ? `Overdue since ${due}` : isNew(t, since) ? "New since yesterday's brief" : undefined);
    return {
      id: t.id, title: clip(stripPrefix(x?.title || t.content), 110), detail: detail ? clip(detail, 120) : undefined,
      tier, recurring: !!m.recurring, must: isMustInclude(t, today, since),
    };
  };
  const fromAi = picked
    .filter((x) => byId.has(x.id) && !seen.has(x.id) && seen.add(x.id))
    .map((x) => toItem(byId.get(x.id)!, x));
  const missedMust = tasks.filter((t) => isMustInclude(t, today, since) && !seen.has(t.id)).map((t) => toItem(t));
  const must = [...fromAi.filter((c) => c.must), ...missedMust];
  const rest = fromAi.filter((c) => !c.must);
  const all = [...must, ...rest.slice(0, Math.max(0, MAX_TASKS - must.length))];
  return all.sort((a, b) => a.tier - b.tier || Number(b.must) - Number(a.must));
}

// ── Jev: a fast second opinion on the list (TypeSafe's decision model) ─────────────
// Three narrow judgments per task: which tier it belongs in, what another week's slip would cost,
// and whether it's a quick job. Jev answers in about 0.3 s for a fraction of a cent. It is only a
// tie-breaker and a nudge: no key, an error or a slow answer leaves the brief exactly as it was,
// and a tier_override that Dave set is never touched.
interface JevRead { tier: number | null; tierP: number; slip: number | null; quick: boolean }

const JEV_QUESTIONS = {
  tier: {
    type: "choice",
    instructions: "Which priority tier does this task belong in for Dave, who co-owns a small personal training gym and is building long-term wealth?",
    criteria: {
      t1_opportunity_cost: "Every day of delay loses growth: investing, retirement, compounding wealth",
      t2_build_business: "Working ON the business: automation, systems, strategy, infrastructure that builds long-term value",
      t3_high_consequence: "Penalties, legal, tax, insurance, health or money at stake if missed",
      t4_in_business: "Working IN the business: client commitments, newsletters, deliverables with deadlines",
      t5_maintenance: "Routine errands, household upkeep, shopping, subscriptions",
    },
  },
  slip_cost: {
    type: "score",
    instructions: "If this slips another full week, how costly is that for Dave?",
    criteria: [
      "Nothing happens",
      "Minor annoyance",
      "Small cost or a missed opportunity",
      "Real money, health, or relationship cost",
      "Serious penalty or a loss that cannot be recovered",
    ],
  },
  effort: {
    type: "choice",
    instructions: "How long does this task realistically take Dave to do?",
    criteria: {
      quick: "15 minutes or less: a call, text, order, or one click",
      medium: "15 to 60 minutes of focused work",
      deep: "More than an hour, needs a protected block of time",
    },
  },
};

const JEV_MIN_TIER_P = 0.65;   // only move an item up a tier when Jev is clearly sure
const JEV_MIN_SLIP_CONF = 0.5; // ignore a slip score Jev itself isn't sure about
const JEV_QUICK_P = 0.75;

// Task text goes to a third-party model: mask long digit runs (card, phone, account numbers) and links.
const jevScrub = (s: string) =>
  s.replace(/(?:\d[ -]?){8,}\d/g, "[number]").replace(/https?:\/\/\S+/g, "[link]").slice(0, 240);

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

function jevStatus(t: Thought, today: string): string {
  const due = dueOf(t, today);
  const bits: string[] = [];
  if (!due) bits.push("no due date");
  else {
    const d = dayDiff(due, today);
    bits.push(d < 0 ? `overdue by ${-d} day${d === -1 ? "" : "s"}` : d === 0 ? "due today" : `due in ${d} day${d === 1 ? "" : "s"}`);
  }
  if (t.metadata?.recurring) bits.push("recurring");
  return bits.join("; ");
}

// deno-lint-ignore no-explicit-any
function parseJev(answers: any): JevRead | null {
  if (!answers || typeof answers !== "object") return null;
  const tierA = answers.tier, slipA = answers.slip_cost, effA = answers.effort;
  const tm = String(tierA?.choice || "").match(/^t([1-5])/);
  const tierP = Number(tierA?.probabilities?.[tierA?.choice]);
  const slipOk = typeof slipA?.score === "number" && Number(slipA?.confidence) >= JEV_MIN_SLIP_CONF;
  const quickP = Number(effA?.probabilities?.quick);
  if (!tm && !slipOk && !Number.isFinite(quickP)) return null;
  return {
    tier: tm ? Number(tm[1]) : null,
    tierP: Number.isFinite(tierP) ? tierP : 0,
    slip: slipOk ? Math.min(4, Math.max(0, slipA.score)) : null,
    quick: Number.isFinite(quickP) && quickP >= JEV_QUICK_P,
  };
}

async function jevCall(state: unknown): Promise<JevRead | null> {
  const res = await fetch(JEV_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JEV_API_KEY}` },
    body: JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return parseJev(data?.answers);
}

// One call per task, a few at a time, with a hard stop so a slow Jev can never hold up the brief.
async function jevRead(tasks: Thought[], today: string): Promise<{ reads: Map<string, JevRead>; error?: string }> {
  const reads = new Map<string, JevRead>();
  if (!JEV_API_KEY) return { reads, error: "JEV_API_KEY not set" };
  let firstError = "";
  const queue = [...tasks];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const r = await jevCall({
          task: jevScrub(stripPrefix(t.content)),
          status: jevStatus(t, today),
          list: t.owner === "studio-strong" ? "business" : "personal",
        });
        if (r) reads.set(t.id, r);
      } catch (e) {
        if (!firstError) firstError = String((e as Error)?.message || e).slice(0, 200);
      }
    }
  };
  let stop: number | undefined;
  await Promise.race([
    Promise.all(Array.from({ length: 6 }, worker)),
    new Promise<void>((res) => { stop = setTimeout(res, 20000); }),
  ]);
  clearTimeout(stop);
  queue.length = 0; // a straggler past the deadline takes no new work
  return { reads: new Map(reads), error: firstError || (reads.size ? undefined : "no answers") };
}

// Within a tier, higher slip cost first (rounded to half points so small wobbles don't reshuffle the
// list); then the existing rule (must-include items first). Items Jev didn't score count as neutral.
// An item in tier 4/5 that Jev confidently puts in tiers 1–3 moves up, unless Dave set its tier.
function applyJev(chosen: Chosen[], reads: Map<string, JevRead>, overridden: (id: string) => boolean): { list: Chosen[]; promoted: number } {
  let promoted = 0;
  const bucket = (c: Chosen) => (c.slip == null ? 2 : Math.round(c.slip * 2) / 2);
  const list = chosen.map((c) => {
    const r = reads.get(c.id);
    if (!r) return c;
    const next: Chosen = { ...c, quick: r.quick || undefined, slip: r.slip ?? undefined };
    if (r.tier && r.tier <= 3 && c.tier >= 4 && r.tierP >= JEV_MIN_TIER_P && !overridden(c.id)) { next.tier = r.tier; promoted++; }
    return next;
  });
  list.sort((a, b) => a.tier - b.tier || bucket(b) - bucket(a) || Number(b.must) - Number(a.must));
  return { list, promoted };
}

// When the previous brief was built; anything created after it is "new".
async function previousBriefTime(today: string): Promise<string> {
  const { data } = await db.from("daily_briefs").select("data").eq("owner", OWNER).lt("brief_date", today)
    .order("brief_date", { ascending: false }).limit(1).maybeSingle();
  const at = (data?.data as BriefData | undefined)?.generated_at;
  return at || new Date(Date.now() - 24 * 3600e3).toISOString();
}

// ── Build ─────────────────────────────────────────────────────────────
async function buildBrief(today: string): Promise<BriefData> {
  await supersedeOldFollowups(today);
  const since = await previousBriefTime(today);
  const [tasks, cal, dids, fitHistory] = await Promise.all([
    fetchOpenTasks(today), fetchAppointments(today), fetchDids(), fetchFitnessHistory(today),
  ]);

  const [planResult, fitResult] = await Promise.allSettled([
    plan(today, tasks, cal.appts, dids.flags, since),
    suggestWorkout(today, fitHistory),
  ]);
  let p: Plan;
  if (planResult.status === "fulfilled") p = planResult.value;
  else { console.error("plan:", planResult.reason); p = fallbackPlan(tasks, dids.flags, today, since); }
  const fitnessSuggestion = fitResult.status === "fulfilled" ? fitResult.value : null;

  let chosen = selectTasks(p.tasks || [], tasks, today, cal.appts, since);
  const staleCount = tasks.filter((t) => isStale(t, today)).length;

  // Jev's second opinion (see above). Never allowed to break the brief.
  let jev: BriefData["jev"];
  try {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const j = await jevRead(chosen.map((c) => byId.get(c.id)).filter((t): t is Thought => !!t), today);
    if (j.reads.size) {
      const overridden = new Set(tasks.filter((t) => t.metadata?.tier_override).map((t) => t.id));
      const r = applyJev(chosen, j.reads, (id) => overridden.has(id));
      chosen = r.list;
      jev = { ok: true, scored: j.reads.size, promoted: r.promoted, ...(j.error ? { error: j.error } : {}) };
    } else {
      jev = { ok: false, scored: 0, promoted: 0, error: j.error };
    }
  } catch (e) {
    console.error("jev:", e);
    jev = { ok: false, scored: 0, promoted: 0, error: String((e as Error)?.message || e).slice(0, 200) };
  }

  // Save client action points as real tasks so they can be checked off
  const clientItems: { id: string; title: string; detail: string }[] = [];
  for (const a of (p.client_actions || []).slice(0, MAX_DIDS)) {
    const title = clip(`${a.client} — ${a.action}`, 110);
    const { data, error } = await db.from("thoughts").insert({
      content: title,
      owner: "studio-strong",
      metadata: { type: "task", category: "dids-followup", brief_date: today, due_date: today, due_month: monthName(today), reason: a.reason, kind: a.kind || null },
    }).select("id").single();
    // The label (Missed / Almost at goal / Recheck due / Needs a goal) leads the detail line so the row says what it is
    const label = KIND_LABEL[String(a.kind || "")] || "";
    if (!error && data) clientItems.push({ id: data.id, title, detail: clip([label, a.reason].filter(Boolean).join(" · "), 120) });
  }

  let n = 0;
  const items: Item[] = [
    ...chosen.map((c) => ({
      n: ++n, id: c.id, title: c.title, detail: c.detail, tier: c.tier, section: "task" as const, recurring: c.recurring,
      ...(c.quick ? { quick: true } : {}), ...(c.slip != null ? { slip: Math.round(c.slip * 10) / 10 } : {}),
    })),
    ...clientItems.map((c) => ({ n: ++n, id: c.id, title: c.title, detail: c.detail, tier: 4, section: "client" as const })),
  ];

  const brief: BriefData = {
    date: today, headline: p.headline || "", appointments: cal.appts, calendar_ok: cal.ok,
    dids_ok: dids.ok, items, generated_at: new Date().toISOString(), stale_overdue: staleCount,
    fitness_suggestion: fitnessSuggestion, jev,
  };
  const { error } = await db.from("daily_briefs").upsert({ brief_date: today, owner: OWNER, data: brief });
  if (error) throw new Error("daily_briefs: " + error.message);
  return brief;
}

// ── Email ──────────────────────────────────────────────────────────────
function pageLink(date: string) {
  return `${PAGE_URL}?key=${encodeURIComponent(PAGE_KEY)}&date=${date}`;
}

function renderEmail(b: BriefData): { html: string; text: string } {
  const teal = "#00778B";
  const box = `<span style="display:inline-block;width:13px;height:13px;border:1.5px solid #222;border-radius:2px;vertical-align:-2px"></span>`;
  const row = (it: Item) => `
    <tr>
      <td style="width:22px;padding:5px 0;vertical-align:top">${box}</td>
      <td style="width:24px;padding:5px 0;vertical-align:top;font-weight:600;color:${teal}">${it.n}.</td>
      <td style="padding:5px 0;vertical-align:top">${esc(it.title)}${it.recurring ? " ⟳" : ""}${it.quick ? " ⚡" : ""}${it.detail ? `<div style="font-size:12px;color:#666">${esc(it.detail)}</div>` : ""}</td>
    </tr>`;

  const tierBlocks = [1, 2, 3, 4, 5].map((t) => {
    const its = b.items.filter((i) => i.section === "task" && i.tier === t);
    if (!its.length) return "";
    return `<div style="margin:14px 0 2px;font-weight:600;font-size:14px">${TIERS[t].icon} ${TIERS[t].name}</div>
      <table style="border-collapse:collapse;width:100%;font-size:14px">${its.map(row).join("")}</table>`;
  }).join("");

  const clients = b.items.filter((i) => i.section === "client");
  const clientBlock = clients.length
    ? `<h2 style="font-size:15px;margin:22px 0 4px;color:${teal}">Client follow-ups from dids</h2>
       <table style="border-collapse:collapse;width:100%;font-size:14px">${clients.map(row).join("")}</table>`
    : b.dids_ok ? "" : `<p style="font-size:13px;color:#a33">Dids data didn't load this morning.</p>`;

  const appts = b.appointments.length
    ? `<table style="border-collapse:collapse;font-size:14px">${b.appointments.map((a) =>
        `<tr><td style="padding:3px 14px 3px 0;white-space:nowrap;color:#555">${esc(a.time)}</td><td style="padding:3px 0">${esc(a.title)}${a.location ? ` <span style="color:#888">(${esc(a.location)})</span>` : ""}</td></tr>`).join("")}</table>`
    : `<p style="font-size:14px;color:#666;margin:4px 0">${b.calendar_ok ? "Nothing on the calendar." : "Calendar didn't load this morning."}</p>`;

  const lines = Array.from({ length: 8 }).map(() => `<div style="border-bottom:1px solid #bbb;height:26px"></div>`).join("");

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fff">
  <div style="max-width:680px;margin:0 auto;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
    <table style="width:100%;border-collapse:collapse"><tr>
      <td style="vertical-align:top">
        <div style="font-size:22px;font-weight:700">${esc(longDate(b.date))}</div>
        <div style="font-size:14px;color:#444;margin-top:6px;line-height:1.4">${esc(b.headline)}</div>
      </td>
      <td style="width:110px;text-align:right;vertical-align:top">
        <a href="${pageLink(b.date)}"><img src="cid:qr.png" width="100" height="100" alt="Open check-off page" style="display:block;margin-left:auto"></a>
        <div style="font-size:10px;color:#888">Scan to check off</div>
      </td>
    </tr></table>

    <h2 style="font-size:15px;margin:20px 0 4px;color:${teal}">Today's schedule</h2>
    ${appts}

    <h2 style="font-size:15px;margin:22px 0 0;color:${teal}">To do</h2>
    ${tierBlocks || `<p style="font-size:14px;color:#666">Nothing pressing on the list.</p>`}
    ${b.stale_overdue ? `<p style="font-size:12px;color:#666;margin:10px 0 0">${b.stale_overdue} older overdue task${b.stale_overdue === 1 ? " isn't" : "s aren't"} listed (due more than ${STALE_DAYS} days ago). Clear or reschedule them on your priorities page.</p>` : ""}

    ${clientBlock}

    <h2 style="font-size:15px;margin:24px 0 4px;color:${teal}">Notes</h2>
    ${lines}

    <p style="font-size:12px;color:#888;margin-top:20px">Check items off and add new ones: <a href="${pageLink(b.date)}" style="color:${teal}">today's page</a></p>
  </div></body></html>`;

  const text = [
    longDate(b.date), b.headline, "",
    "SCHEDULE", ...(b.appointments.length ? b.appointments.map((a) => `${a.time}  ${a.title}`) : ["(none)"]), "",
    "TO DO", ...b.items.filter((i) => i.section === "task").map((i) => `[ ] ${i.n}. ${TIERS[i.tier].icon} ${i.title}${i.quick ? " ⚡" : ""}`),
    ...(b.stale_overdue ? [`(${b.stale_overdue} older overdue tasks not listed. Review on your priorities page.)`] : []), "",
    "CLIENT FOLLOW-UPS", ...b.items.filter((i) => i.section === "client").map((i) => `[ ] ${i.n}. ${i.title} (${i.detail || ""})`), "",
    `Check off: ${pageLink(b.date)}`,
  ].join("\n");

  return { html, text };
}

async function sendEmail(b: BriefData) {
  const { html, text } = renderEmail(b);
  const qr: Uint8Array = await QRCode.toBuffer(pageLink(b.date), { width: 300, margin: 1 });
  let bin = ""; for (const byte of qr) bin += String.fromCharCode(byte);
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": POSTMARK_TOKEN },
    body: JSON.stringify({
      From: FROM_EMAIL, To: TO_EMAIL,
      Subject: `Morning brief — ${longDate(b.date)}`,
      HtmlBody: html, TextBody: text, MessageStream: "outbound",
      Attachments: [{ Name: "qr.png", Content: btoa(bin), ContentType: "image/png", ContentID: "cid:qr.png" }],
    }),
  });
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${await res.text()}`);
}

// Tasks added since the PREVIOUS brief that this brief doesn't list: last
// night's notes that didn't make the printout, and anything captured during
// the day. They show on the page so they can be checked off or given a date.
async function capturedAfter(brief: BriefData, date: string): Promise<Thought[]> {
  if (!brief.generated_at) return [];
  const prev = await previousBriefTime(date);
  const start = prev < brief.generated_at ? prev : brief.generated_at;
  const { data } = await db.from("thoughts")
    .select("id, content, owner, metadata, created_at")
    .in("owner", [OWNER, "studio-strong"])
    .gt("created_at", start)
    .lt("created_at", centralMidnight(addDaysStr(date, 1)).toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  return ((data || []) as Thought[]).filter((t) => {
    const m = t.metadata || {};
    const type = String(m.type || "").toLowerCase();
    // Archived items only stay visible if they were checked off on the page
    const archivedElsewhere = !!m.archived && m.archived_reason !== "checked off on daily brief";
    return (type === "task" || type === "") && !archivedElsewhere && m.category !== "dids-followup" && m.added_via !== "brief" && !doreensMeta(m);
  });
}

// ── Page: read with live status ─────────────────────────────────────────────
// ── Upcoming + tickler: the rest of the backlog, live on today's page ──
// fetchOpenTasks already pulls the WHOLE backlog (every recurring task, plus
// up to 1000 general ones) — the brief's main list only ever shows a slice
// of it (today's must-includes + up to MAX_TASKS picks). This surfaces what
// that slice leaves out: dated items further out than the main list's
// 7-day window, items overdue by more than STALE_DAYS (until now only a
// silent count), and a few undated-but-important ones as a tickler. Only
// computed for today — like the fitness suggestion, a backlog view doesn't
// make sense pinned to a past day's snapshot.
interface ExtraItem { id: string; title: string; tier: number; due_date?: string; due_month?: string; scope: "personal" | "business"; source_observation?: string }
const resolvedTier = (t: Thought) => (t.metadata?.tier_override as number) || keywordTier(t.content);
const toExtraItem = (t: Thought): ExtraItem => ({
  id: t.id, title: clip(stripPrefix(t.content), 110), tier: resolvedTier(t),
  due_date: t.metadata?.due_date ? String(t.metadata.due_date).slice(0, 10) : undefined,
  // Some tasks only ever got a target month, not an exact day (due_month with
  // no due_date) — a "get to this in November" intent, not a specific date.
  // These go in Upcoming too, grouped by month instead of by day.
  due_month: !t.metadata?.due_date && t.metadata?.due_month ? String(t.metadata.due_month) : undefined,
  scope: t.owner === OWNER ? "personal" : "business",
  source_observation: (t.metadata?.source_id as string) || undefined,
});
function buildUpcomingAndTickler(backlog: Thought[], mainIds: Set<string>): { upcoming: ExtraItem[]; tickler: ExtraItem[] } {
  const rest = backlog.filter((t) => !t.metadata?.recurring && !mainIds.has(t.id));
  const upcoming = rest.filter((t) => !!t.metadata?.due_date || !!t.metadata?.due_month).map(toExtraItem);
  const tickler = rest
    .filter((t) => !t.metadata?.due_date && !t.metadata?.due_month && (resolvedTier(t) <= 2 || t.metadata?.category === "important"))
    .sort((a, b) => resolvedTier(a) - resolvedTier(b))
    .slice(0, 5)
    .map(toExtraItem);
  return { upcoming, tickler };
}

// Archived because Dave dropped it, not because it was checked off. The page's Drop and the other drop paths write one of
// these reasons; a checked-off task keeps showing as done, a dropped one stays off the list after a reload.
function droppedMeta(m: Meta): boolean {
  if (!m.archived) return false;
  return /^dropped/i.test(String(m.archived_reason || "")) || m.handoff_archived === "drop" || m.handoff_archived === "merge";
}

async function loadBrief(date: string) {
  const { data: row } = await db.from("daily_briefs").select("data").eq("brief_date", date).eq("owner", OWNER).maybeSingle();
  if (!row) return null;
  const brief = row.data as BriefData;

  // Items added from the page that day
  const { data: added } = await db
    .from("thoughts")
    .select("id, content, owner, metadata, created_at")
    .contains("metadata", { brief_date: date, added_via: "brief" })
    .order("created_at", { ascending: true });

  // Tasks captured after this brief was built (e.g. a note at 6:45 AM) show
  // up live on the page, so nothing waits a day to be checked off.
  const onBrief = new Set(brief.items.map((i) => i.id));
  const later = await capturedAfter(brief, date);
  const extra = [...((added || []) as Thought[]), ...later.filter((t) => !onBrief.has(t.id) && !(added || []).some((a: Thought) => a.id === t.id))];

  let n = brief.items.length;
  const addedItems: Item[] = extra.map((t) => ({
    n: ++n, id: t.id, title: clip(stripPrefix(t.content), 110), tier: (t.metadata?.tier_override as number) || keywordTier(t.content),
    tier_auto: keywordTier(t.content), section: "task", added: true,
  }));
  const all = [...brief.items, ...addedItems];

  const ids = all.map((i) => i.id);
  const { data: live } = ids.length
    ? await db.from("thoughts").select("id, content, owner, metadata").in("id", ids)
    : { data: [] };
  const liveRows = (live || []) as { id: string; content: string; owner: string; metadata: Meta }[];
  const metaById = new Map(liveRows.map((t) => [t.id, t.metadata || {}]));
  const contentById = new Map(liveRows.map((t) => [t.id, t.content]));
  const scopeById = new Map(liveRows.map((t) => [t.id, t.owner === OWNER ? "personal" : "business"]));
  const dayStartIso = centralMidnight(date).toISOString();

  const finalItems = all.map((i) => {
      const m = metaById.get(i.id) || {};
      const done = m.recurring
        ? !!m.last_completed && String(m.last_completed) >= dayStartIso
        : !!m.archived && m.archived_reason !== "replaced by a newer brief";
      const edited = !!m.edited && contentById.has(i.id);
      const override = Number(m.tier_override) || 0;
      const auto = i.tier_auto ?? (override && override === i.tier ? keywordTier(contentById.get(i.id) ?? i.title) : i.tier);
      return {
        ...i,
        tier: override || i.tier,
        tier_auto: auto,
        tier_override: override || null,
        category: String(m.category ?? ""),
        repeat: m.recurring ?? null,
        due_date: m.due_date ? String(m.due_date).slice(0, 10) : "",
        title: edited ? clip(stripPrefix(contentById.get(i.id)!), 110) : i.title,
        full_text: contentById.has(i.id) ? stripPrefix(contentById.get(i.id)!) : i.title,
        scope: scopeById.get(i.id) ?? "business",
        done,
        pushed: !done && !!m.due_date && String(m.due_date) > date,
        moved_to: !done && m.due_date && String(m.due_date) > date ? String(m.due_date).slice(0, 10) : undefined,
        notes: (m.notes as { at: string; text: string }[]) || [],
        missing: !metaById.has(i.id),
        source_observation: (m.source_id as string) || undefined,
      };
    }).filter((i) => {
      const m = metaById.get(i.id) || {};
      // Notes aren't tasks; Doreen's tasks (including ones tagged after this
      // morning's snapshot was built) move to the "for Doreen" row below.
      // A task Dave dropped (past-due review, Sunday sweep, the Drop item in the menu, a dropped or merged hand-off) is gone, not "done".
      return String(m.type || "") !== "note" && !doreensMeta(m) && !droppedMeta(m);
    });

  let upcoming: ExtraItem[] = [];
  let tickler: ExtraItem[] = [];
  let doreen: ExtraItem[] = [];
  if (date === todayCentral()) {
    const everything = await fetchOpenTasks(date, true);
    const backlog = everything.filter((t) => !isDoreens(t));
    const mainIds = new Set(finalItems.map((i) => i.id));
    ({ upcoming, tickler } = buildUpcomingAndTickler(backlog, mainIds));
    doreen = everything.filter(isDoreens)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 40)
      .map(toExtraItem);
  }

  // Sub-tasks: a note captured once can extract several linked tasks (source_id
  // points back at it). Same grouping priorities already shows — a header with
  // a running "N left" count — fetched fresh each load so the count stays
  // right even as the other tasks in the group get checked off elsewhere.
  const obsIds = new Set<string>();
  for (const i of [...finalItems, ...upcoming, ...tickler]) if (i.source_observation) obsIds.add(i.source_observation);
  const observations: Record<string, { content: string; tasks_total: number; tasks_done: number }> = {};
  if (obsIds.size) {
    const { data: obsData } = await db.from("thoughts").select("id, content, metadata").in("id", Array.from(obsIds));
    for (const obs of (obsData || []) as { id: string; content: string; metadata: Meta }[]) {
      if (obs.content.length > 400) continue; // long notes make poor group headers
      observations[obs.id] = {
        content: obs.content,
        tasks_total: (obs.metadata?.tasks_total as number) || 0,
        tasks_done: (obs.metadata?.tasks_done as number) || 0,
      };
    }
  }

  return { ...brief, items: finalItems, upcoming, tickler, doreen, observations };
}

// Values accepted from the page: identical to what capture.html writes
const CATEGORIES = new Set(["important","finance","marketing","operations","process","recruiting","retention","technical","automation","health","home"]);
const RECUR_WORDS = new Set(["daily","weekly","biweekly","monthly"]);
const RECUR_UNITS = new Set(["days","weeks","months","years"]);
type Parsed = { ok: true; value: unknown } | { ok: false };
function parseRecurringInput(v: unknown): Parsed {
  if (v === null || v === undefined || v === "" || v === "none") return { ok: true, value: null };
  if (typeof v === "string") return RECUR_WORDS.has(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === "object") {
    const o = v as { every?: unknown; unit?: unknown };
    const every = Math.floor(Number(o.every));
    const unit = String(o.unit ?? "");
    if (every >= 1 && every <= 365 && RECUR_UNITS.has(unit)) return { ok: true, value: { every, unit } };
  }
  return { ok: false };
}
function parseTierInput(v: unknown): Parsed {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Math.floor(Number(v));
  return n >= 1 && n <= 5 ? { ok: true, value: n } : { ok: false };
}
function parseCategoryInput(v: unknown): Parsed {
  const c = String(v ?? "");
  if (c === "" || c === "default") return { ok: true, value: null };
  return CATEGORIES.has(c) ? { ok: true, value: c } : { ok: false };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Page: actions ────────────────────────────────────────────────────
async function allowedIds(date: string): Promise<Set<string>> {
  const { data: row } = await db.from("daily_briefs").select("data").eq("brief_date", date).eq("owner", OWNER).maybeSingle();
  const ids = new Set<string>(((row?.data as BriefData)?.items || []).map((i) => i.id));
  const { data: added } = await db.from("thoughts").select("id").contains("metadata", { brief_date: date, added_via: "brief" });
  for (const a of (added || []) as { id: string }[]) ids.add(a.id);
  if (row?.data) for (const t of await capturedAfter(row.data as BriefData, date)) ids.add(t.id);
  // Today's page also shows Upcoming + the tickler, pulled from the whole
  // backlog — so today, the whole backlog is fair game for actions too.
  // Includes Doreen's set-aside tasks, so "Mine" can bring one back.
  if (date === todayCentral()) for (const t of await fetchOpenTasks(date, true)) ids.add(t.id);
  return ids;
}

async function handleAction(body: Record<string, unknown>) {
  const date = String(body.date || todayCentral());
  const action = String(body.action || "");

  if (action === "save_fitness") {
    const workout = sanitizeWorkout(body.workout);
    const summary = sanitizeSummary(body.summary);
    const walk = sanitizeWalk(body.walk);
    const now = new Date().toISOString();
    const { error } = await db.from("fitness_logs").upsert({ log_date: date, owner: OWNER, workout, summary, walk, updated_at: now });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, updated_at: now });
  }

  if (action === "jev_preview") {
    // Dry run: score the tasks already on that day's brief with Jev and show how they'd re-order.
    // Reads only. Nothing is saved, archived, re-tiered or emailed.
    const { data: row } = await db.from("daily_briefs").select("data").eq("brief_date", date).eq("owner", OWNER).maybeSingle();
    const brief = row?.data as BriefData | undefined;
    if (!brief) return json({ error: "No brief for that day." }, 404);
    const taskItems = brief.items.filter((i) => i.section === "task");
    const { data: rows } = await db.from("thoughts").select("id, content, owner, metadata, created_at").in("id", taskItems.map((i) => i.id));
    const byId = new Map(((rows || []) as Thought[]).map((t) => [t.id, t]));
    const live = taskItems.filter((i) => byId.has(i.id));
    const j = await jevRead(live.map((i) => byId.get(i.id)!), date);
    const chosen: Chosen[] = live.map((i) => ({
      id: i.id, title: i.title, detail: i.detail, tier: i.tier, recurring: !!i.recurring, must: isMustInclude(byId.get(i.id)!, date),
    }));
    const overridden = new Set(live.filter((i) => byId.get(i.id)!.metadata?.tier_override).map((i) => i.id));
    const r = applyJev(chosen, j.reads, (id) => overridden.has(id));
    const before = new Map(chosen.map((c, k) => [c.id, { pos: k + 1, tier: c.tier }]));
    return json({
      ok: true, date, jev_configured: !!JEV_API_KEY, scored: j.reads.size, promoted: r.promoted, error: j.error ?? null,
      list: r.list.map((c, k) => ({
        pos: k + 1, was: before.get(c.id)?.pos, title: clip(c.title, 70),
        tier_was: before.get(c.id)?.tier, tier_now: c.tier, slip: c.slip ?? null, quick: !!c.quick,
        jev: j.reads.get(c.id) ? { tier: j.reads.get(c.id)!.tier, tier_p: Math.round(j.reads.get(c.id)!.tierP * 100) / 100 } : null,
      })),
    });
  }

  if (action === "add") {
    const content = String(body.content || "").trim();
    if (!content) return json({ error: "Type something to add." }, 400);
    const owner = body.scope === "personal" ? OWNER : "studio-strong";
    const pickedDue = String(body.due || "");
    const due = /^\d{4}-\d{2}-\d{2}$/.test(pickedDue) && pickedDue >= date ? pickedDue : date;
    const meta: Meta = { type: "task", brief_date: date, added_via: "brief", due_date: due, due_month: monthName(due) };
    if (body.recurring !== undefined) {
      const r = parseRecurringInput(body.recurring);
      if (!r.ok) return json({ error: "That repeat isn't valid." }, 400);
      if (r.value !== null) meta.recurring = r.value;
    }
    if (body.tier !== undefined) {
      const r = parseTierInput(body.tier);
      if (!r.ok) return json({ error: "Priority must be 1 to 5." }, 400);
      if (r.value !== null) meta.tier_override = r.value;
    }
    if (body.category !== undefined) {
      const r = parseCategoryInput(body.category);
      if (!r.ok) return json({ error: "Unknown category." }, 400);
      if (r.value !== null) meta.category = r.value;
    }
    const { data, error } = await db.from("thoughts").insert({ content, owner, metadata: meta }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id });
  }

  const id = String(body.id || "");
  if (!(await allowedIds(date)).has(id)) return json({ error: "That item isn't on this brief." }, 403);

  const { data: t, error: fe } = await db.from("thoughts").select("metadata").eq("id", id).single();
  if (fe || !t) return json({ error: "Task not found." }, 404);

  if (action === "edit") {
    const content = String(body.content || "").trim();
    if (!content) return json({ error: "The task can't be empty." }, 400);
    if (content.length > 1000) return json({ error: "That's too long for one task." }, 400);
    const meta: Meta = { ...(t.metadata as Meta), edited: true, edited_at: new Date().toISOString() };
    if ("due" in body) {
      const d = String(body.due ?? "");
      if (d === "" || d === "none") { delete meta.due_date; delete meta.due_month; }
      else if (DATE_RE.test(d)) { meta.due_date = d; meta.due_month = monthName(d); }
      else return json({ error: "That date isn't valid." }, 400);
    }
    if ("recurring" in body) {
      const r = parseRecurringInput(body.recurring);
      if (!r.ok) return json({ error: "That repeat isn't valid." }, 400);
      if (r.value === null) delete meta.recurring; else meta.recurring = r.value;
    }
    if ("tier" in body) {
      const r = parseTierInput(body.tier);
      if (!r.ok) return json({ error: "Priority must be 1 to 5." }, 400);
      if (r.value === null) delete meta.tier_override; else meta.tier_override = r.value;
    }
    if ("category" in body) {
      const r = parseCategoryInput(body.category);
      if (!r.ok) return json({ error: "Unknown category." }, 400);
      if (r.value === null) delete meta.category; else meta.category = r.value;
    }
    const update: Record<string, unknown> = { content, metadata: meta };
    if (body.scope === "personal") update.owner = OWNER;
    else if (body.scope === "business") update.owner = "studio-strong";
    const { error } = await db.from("thoughts").update(update).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({
      ok: true, title: clip(stripPrefix(content), 110), scope: body.scope === "personal" ? "personal" : "business",
      due_date: String(meta.due_date ?? "").slice(0, 10), repeat: meta.recurring ?? null,
      tier_override: meta.tier_override ?? null, category: String(meta.category ?? ""),
    });
  }
  const m = { ...(t.metadata as Meta) };
  const now = new Date().toISOString();

  if (action === "check") {
    if (m.recurring) { m.prev_last_completed = m.last_completed ?? null; m.last_completed = now; }
    else { m.archived = true; m.archived_at = now; m.archived_reason = "checked off on daily brief"; }
  } else if (action === "uncheck") {
    if (m.recurring) {
      if (m.prev_last_completed) m.last_completed = m.prev_last_completed; else delete m.last_completed;
      delete m.prev_last_completed;
    } else { delete m.archived; delete m.archived_at; delete m.archived_reason; }
  } else if (action === "note") {
    const text = String(body.text || "").trim();
    if (!text) return json({ error: "Note is empty." }, 400);
    m.notes = [...((m.notes as unknown[]) || []), { at: now, text }];
  } else if (action === "push") {
    const today = todayCentral();
    const picked = String(body.to || "");
    const to = /^\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : addDaysStr(today, 1);
    if (to <= today) return json({ error: "Pick a day after today." }, 400);
    m.due_date = to; m.due_month = monthName(to);
  } else if (action === "not_task") {
    // Mis-tagged at capture — it's a note, not something to act on. The
    // content is untouched; this just stops it from ever being treated as
    // a task again, here or on the priorities page, which reads this same field.
    m.type = "note";
  } else if (action === "assign") {
    // Who the task is for. The shared business pool mixes Dave's and Doreen's
    // to-dos; this sets one aside as Doreen's (or claims it back as Dave's).
    // Only the tag changes — never archived, never deleted, content untouched.
    const to = String(body.to ?? "");
    if (to === "doreen" || to === "dave") m.assignee = to;
    else if (to === "" || to === "none") delete m.assignee;
    else return json({ error: "Unknown assignee." }, 400);
  } else {
    return json({ error: "Unknown action." }, 400);
  }

  const { error } = await db.from("thoughts").update({ metadata: m }).eq("id", id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

// ── Router ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";

  try {
    // Cron / manual trigger
    if (TRIGGER_KEY && key === TRIGGER_KEY && req.method === "POST") {
      const date = url.searchParams.get("date") || todayCentral();
      const brief = await buildBrief(date);
      if (url.searchParams.get("send") === "0") {
        return new Response(renderEmail(brief).html, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
      }
      await sendEmail(brief);
      return json({ ok: true, date, items: brief.items.length, appointments: brief.appointments.length });
    }

    // Check-off page
    if (PAGE_KEY && key === PAGE_KEY) {
      if (req.method === "GET") {
        const date = url.searchParams.get("date") || todayCentral();
        const [brief, fitness] = await Promise.all([loadBrief(date), fetchFitness(date)]);
        return brief
          ? json({ ok: true, today: todayCentral(), brief, fitness })
          : json({ ok: false, today: todayCentral(), fitness, error: "No brief for that day." }, 404);
      }
      if (req.method === "POST") return await handleAction(await req.json().catch(() => ({})));
    }

    return json({ error: "Invalid or missing key" }, 401);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
