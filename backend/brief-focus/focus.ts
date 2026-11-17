// ============================================================
// Pure helpers for the brief-focus function (no Deno or network calls, so they can be unit tested).
// Pinned: tasks that always show at the very top of the brief, whatever their age or priority.
// Your day: tasks Dave picked for today. Both live on the task itself (thoughts.metadata):
//   pinned (true), pinned_at, pin_next      focus_date (YYYY-MM-DD), focus_at
// ============================================================

export type Meta = Record<string, unknown>;
export interface Thought { id: string; content: string; owner: string; metadata: Meta; created_at: string }
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export const TZ = "America/Chicago";
export const MAX_PINNED = 3;
export const MAX_DAY = 7;
export const NEXT_MAX = 200;
export const CHECKED_REASON = "checked off on daily brief";   // the same words the brief's own check-off writes

const PREFIX_RE = /^\s*(ACTIVE TASK\s*(\([^)]*\))?\s*:|PREVIOUS CLIENT\s*[—-]|FOLLOW-UP CLIENT\s*[—-]|RECURRING\s*:)\s*/i;
export const stripPrefix = (s: string) => s.replace(PREFIX_RE, "").trim();
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}
export const todayCentral = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);   // YYYY-MM-DD
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86_400_000);

const isTrue = (v: unknown) => v === true || v === "true";
export const isArchived = (m: Meta) => isTrue(m.archived);
export const isPinned = (m: Meta) => isTrue(m.pinned);
export const onDay = (m: Meta, today: string) => m.focus_date === today;

// A plain task: not a note, not a repeating task, not a dids follow-up.
const isPlainTask = (m: Meta) =>
  ["task", ""].includes(String(m.type ?? "task").toLowerCase()) && !m.recurring && m.category !== "dids-followup";
// Open and Dave's: what can be pinned or put on his day.
export const isOpenTask = (m: Meta) => isPlainTask(m) && !isArchived(m);
export const isDavesTask = (m: Meta) => isOpenTask(m) && m.assignee !== "doreen";

// Checked off from the brief today (kept visible, struck through, until the day is over).
export function doneToday(m: Meta, today: string): boolean {
  if (!isPlainTask(m) || !isArchived(m) || m.archived_reason !== CHECKED_REASON) return false;
  const at = typeof m.archived_at === "string" ? Date.parse(m.archived_at) : NaN;
  return !isNaN(at) && todayCentral(new Date(at)) === today;
}

// Shown on the page: flagged, and either still open or checked off today.
export const shown = (t: Thought, today: string) => {
  const m = t.metadata || {};
  if (!(isPinned(m) || onDay(m, today))) return false;
  return isOpenTask(m) ? m.assignee !== "doreen" : doneToday(m, today);
};

export interface ItemOut {
  id: string; title: string; full: string; scope: "business" | "personal";
  due: string; due_in: number | null; next: string; pinned: boolean; in_day: boolean; done: boolean;
}
export function itemOut(t: Thought, today: string): ItemOut {
  const m = t.metadata || {};
  const full = stripPrefix(t.content);
  const due = m.due_date ? String(m.due_date).slice(0, 10) : "";
  return {
    id: t.id, title: clip(full, 140), full, scope: t.owner === "studio-strong" ? "business" : "personal",
    due, due_in: due ? daysBetween(today, due) : null,
    next: typeof m.pin_next === "string" ? m.pin_next : "",
    pinned: isPinned(m), in_day: onDay(m, today), done: isArchived(m),
  };
}

// Pinned ones first (oldest pin first), then today's picks in the order he picked them.
export const sortPinned = (l: Thought[]) => [...l].sort((a, b) => String(a.metadata?.pinned_at ?? "").localeCompare(String(b.metadata?.pinned_at ?? "")));
export const sortDay = (l: Thought[]) => [...l].sort((a, b) => String(a.metadata?.focus_at ?? "").localeCompare(String(b.metadata?.focus_at ?? "")));

const cleanNext = (s: string) => s.replace(/\s+/g, " ").trim();

// pinnedOpen: how many other tasks are pinned and still open right now.
export function pin(m: Meta, next: string | undefined, now: string, pinnedOpen: number): Result<{ meta: Meta }> {
  if (!isDavesTask(m)) return { ok: false, error: "Only an open task of yours can be pinned." };
  const out: Meta = { ...m };
  if (!isPinned(m)) {
    if (pinnedOpen >= MAX_PINNED) return { ok: false, error: `Pinned is full (${MAX_PINNED}). Unpin one first.` };
    out.pinned = true; out.pinned_at = now;
  }
  if (next !== undefined) {
    const n = cleanNext(next);
    if (n.length > NEXT_MAX) return { ok: false, error: `Keep the next step under ${NEXT_MAX} characters.` };
    if (n) out.pin_next = n; else delete out.pin_next;
  }
  return { ok: true, meta: out };
}
export function unpin(m: Meta): Result<{ meta: Meta }> {
  if (!isPinned(m)) return { ok: true, meta: m };
  const out: Meta = { ...m };
  delete out.pinned; delete out.pinned_at; delete out.pin_next;
  return { ok: true, meta: out };
}
export function setNext(m: Meta, next: string): Result<{ meta: Meta }> {
  if (!isPinned(m)) return { ok: false, error: "Pin it first, then add the next step." };
  const n = cleanNext(String(next ?? ""));
  if (n.length > NEXT_MAX) return { ok: false, error: `Keep the next step under ${NEXT_MAX} characters.` };
  const out: Meta = { ...m };
  if (n) out.pin_next = n; else delete out.pin_next;
  return { ok: true, meta: out };
}

// dayOpen: how many other tasks are on today's list and still open.
export function focus(m: Meta, today: string, now: string, dayOpen: number): Result<{ meta: Meta }> {
  if (!isDavesTask(m)) return { ok: false, error: "Only an open task of yours can go on your day." };
  if (onDay(m, today)) return { ok: true, meta: m };
  if (dayOpen >= MAX_DAY) return { ok: false, error: `Your day already has ${MAX_DAY}. Take one off first.` };
  return { ok: true, meta: { ...m, focus_date: today, focus_at: now } };
}
export function unfocus(m: Meta): Result<{ meta: Meta }> {
  if (!("focus_date" in m) && !("focus_at" in m)) return { ok: true, meta: m };
  const out: Meta = { ...m };
  delete out.focus_date; delete out.focus_at;
  return { ok: true, meta: out };
}

// Check off / un-check: the same fields the brief's own check-off writes, so everything else treats it the same.
export function check(m: Meta, now: string): Result<{ meta: Meta }> {
  if (!isPlainTask(m)) return { ok: false, error: "Repeating tasks are checked off in the main list." };
  if (isArchived(m)) return { ok: true, meta: m };
  return { ok: true, meta: { ...m, archived: true, archived_at: now, archived_reason: CHECKED_REASON } };
}
export function uncheck(m: Meta): Result<{ meta: Meta }> {
  if (!isArchived(m)) return { ok: true, meta: m };
  if (m.archived_reason !== CHECKED_REASON) return { ok: false, error: "That one was closed somewhere else, so it stays closed." };
  const out: Meta = { ...m };
  delete out.archived; delete out.archived_at; delete out.archived_reason;
  return { ok: true, meta: out };
}
