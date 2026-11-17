// ============================================================
// Pure helpers for the brief-fromdoreen function (no Deno or network calls, so they can be unit tested).
// A "hand-off" is a task Doreen sent to Dave: captured by her and assigned to him, or added by her for him.
// Dave answers each one: accept it (and confirm the day it is due), or push it back to her.
// ============================================================

export type Meta = Record<string, unknown>;
export interface Thought { id: string; content: string; owner: string; metadata: Meta; created_at: string }
export interface Handoff { state: "accepted" | "pushed_back"; at: string; by?: string; note?: string }
export type ArchivePrev = Partial<Record<(typeof ARCH_KEYS)[number], unknown>>;
export interface Prev {
  due_date?: string | null; due_month?: string | null; assignee?: string | null; handoff?: Handoff | null; note_at?: string | null;
  archive?: ArchivePrev; merge?: { into: string; note_at: string };
}
// What Done, Drop and Merge write when they archive a task (and so what Undo takes back).
export const ARCH_KEYS = ["archived", "archived_at", "archived_reason", "completed_via", "merged_into", "handoff_archived"] as const;

export const TZ = "America/Chicago";
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREFIX_RE = /^\s*(ACTIVE TASK\s*(\([^)]*\))?\s*:|PREVIOUS CLIENT\s*[—-]|FOLLOW-UP CLIENT\s*[—-]|RECURRING\s*:)\s*/i;
export const stripPrefix = (s: string) => s.replace(PREFIX_RE, "").trim();
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}
export const todayCentral = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);   // YYYY-MM-DD
export const monthName = (dateStr: string) =>
  new Date(dateStr + "T12:00:00Z").toLocaleString("en-US", { timeZone: "UTC", month: "long" }).toLowerCase();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86_400_000);
const validDate = (s: string) => DATE_RE.test(s) && !isNaN(Date.parse(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s;

// Waiting for Dave's answer: sent to him by Doreen, still open, not already accepted, and not sitting with her after a push back.
export function isHandoff(m: Meta): boolean {
  const toDave = (m.assignee === "dave" && m.captured_by === "doreen") || String(m.assigned_by ?? "").toLowerCase() === "doreen";
  if (!toDave) return false;
  if (m.archived === true || m.archived === "true") return false;
  const type = String(m.type ?? "task").toLowerCase();
  if (type !== "task" && type !== "") return false;
  if (m.recurring || m.category === "dids-followup") return false;
  const h = m.doreen_handoff as Handoff | undefined;
  if (h && h.state === "accepted") return false;
  if (h && h.state === "pushed_back" && m.assignee !== "dave") return false;   // she sent it to him again: ask again
  return true;
}

export interface ItemOut {
  id: string; title: string; full: string; scope: "business" | "personal";
  sent: string; sent_days: number; due: string; month: string; returned: boolean;
  notes: Array<{ at: string; text: string }>;
}
export function itemOut(t: Thought, today: string): ItemOut {
  const m = t.metadata || {};
  const full = stripPrefix(t.content);
  const sent = todayCentral(new Date(t.created_at));
  const h = m.doreen_handoff as Handoff | undefined;
  const notes = (Array.isArray(m.notes) ? m.notes : []).filter((n) => n && typeof n.text === "string").slice(-2)
    .map((n: { at?: unknown; text: string }) => ({ at: String(n.at ?? ""), text: clip(n.text, 200) }));
  return {
    id: t.id, title: clip(full, 140), full, scope: t.owner === "studio-strong" ? "business" : "personal",
    sent, sent_days: Math.max(0, daysBetween(sent, today)),
    due: m.due_date ? String(m.due_date).slice(0, 10) : "", month: !m.due_date && m.due_month ? String(m.due_month) : "",
    returned: !!(h && h.state === "pushed_back"), notes,
  };
}

// Oldest first: the one Doreen has waited on longest comes first.
export const sortHandoffs = (list: Thought[]) => [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

// due: "keep" (the date it already has), "none", or a day (today or later).
export function accept(m: Meta, due: string, today: string, now: string): Result<{ meta: Meta; prev: Prev }> {
  const out: Meta = { ...m };
  const prev: Prev = { due_date: (m.due_date as string) ?? null, due_month: (m.due_month as string) ?? null, handoff: (m.doreen_handoff as Handoff) ?? null };
  if (due === "none") { delete out.due_date; delete out.due_month; }
  else if (due !== "keep") {
    if (!validDate(due)) return { ok: false, error: "That date isn't valid." };
    if (due < today) return { ok: false, error: "Pick today or a later day." };
    out.due_date = due; out.due_month = monthName(due);
  }
  out.doreen_handoff = { state: "accepted", at: now, by: "dave" } satisfies Handoff;
  return { ok: true, meta: out, prev };
}

export function pushBack(m: Meta, note: string, now: string): Result<{ meta: Meta; prev: Prev }> {
  const text = note.replace(/\s+/g, " ").trim();
  if (text.length > 300) return { ok: false, error: "Keep the note under 300 characters." };
  const out: Meta = { ...m };
  const prev: Prev = { assignee: (m.assignee as string) ?? null, handoff: (m.doreen_handoff as Handoff) ?? null, note_at: now };
  out.assignee = "doreen";
  out.doreen_handoff = { state: "pushed_back", at: now, by: "dave", ...(text ? { note: text } : {}) } satisfies Handoff;
  out.notes = [...(Array.isArray(m.notes) ? m.notes : []), { at: now, text: text ? `Dave sent this back: ${text}` : "Dave sent this back to you." }];
  return { ok: true, meta: out, prev };
}

// Puts back exactly what accept or pushBack changed. Only what those two ever touch is accepted from the caller.
export function undo(m: Meta, prevRaw: unknown): Result<{ meta: Meta }> {
  if (!m.doreen_handoff && !m.handoff_archived) return { ok: false, error: "Nothing to undo." };
  if (!prevRaw || typeof prevRaw !== "object") return { ok: false, error: "Nothing to undo." };
  const p = prevRaw as Record<string, unknown>;
  const out: Meta = { ...m };
  for (const k of ["due_date", "due_month", "assignee"] as const) {
    if (!(k in p)) continue;
    const v = p[k];
    if (v === null) { delete out[k]; continue; }
    if (typeof v !== "string" || v.length > 40) return { ok: false, error: "Can't undo that." };
    if (k === "due_date" && !validDate(v)) return { ok: false, error: "Can't undo that." };
    if (k === "assignee" && v !== "dave" && v !== "doreen") return { ok: false, error: "Can't undo that." };
    out[k] = v;
  }
  if ("handoff" in p) {
    const h = p.handoff as Handoff | null;
    if (h === null) delete out.doreen_handoff;
    else if (h && (h.state === "accepted" || h.state === "pushed_back") && typeof h.at === "string") out.doreen_handoff = { state: h.state, at: h.at.slice(0, 40), ...(typeof h.by === "string" ? { by: h.by.slice(0, 20) } : {}), ...(typeof h.note === "string" ? { note: h.note.slice(0, 300) } : {}) };
    else return { ok: false, error: "Can't undo that." };
  }
  // Only a task that Done, Drop or Merge archived (it carries handoff_archived) can be un-archived here.
  if ("archive" in p && m.handoff_archived) {
    const a = (p.archive && typeof p.archive === "object" ? p.archive : {}) as Record<string, unknown>;
    for (const k of ARCH_KEYS) {
      const v = a[k];
      if (v === null || v === undefined) delete out[k];
      else if (k === "archived") out.archived = v === true;
      else if (typeof v === "string" && v.length <= 120) out[k] = v;
    }
  }
  if (typeof p.note_at === "string" && Array.isArray(out.notes)) {
    out.notes = (out.notes as Array<{ at?: string }>).filter((n) => n.at !== p.note_at);
    if (!(out.notes as unknown[]).length) delete out.notes;
  }
  return { ok: true, meta: out };
}

// The text of a task can be rewritten while it is waiting; a day can be set at the same time.
export function edit(m: Meta, content: string, due: string | undefined, today: string, now: string): Result<{ meta: Meta; content: string }> {
  const text = String(content ?? "").trim();
  if (!text) return { ok: false, error: "The task can't be empty." };
  if (text.length > 1000) return { ok: false, error: "That's too long for one task." };
  const out: Meta = { ...m, edited: true, edited_at: now };
  if (due !== undefined) {
    if (due === "" || due === "none") { delete out.due_date; delete out.due_month; }
    else if (validDate(due)) { out.due_date = due; out.due_month = monthName(due); }
    else return { ok: false, error: "That date isn't valid." };
  }
  void today;
  return { ok: true, meta: out, content: text };
}

// ── Done, Drop, Merge ─────────────────────────────────────────
const pickArchive = (m: Meta): ArchivePrev => { const o: ArchivePrev = {}; for (const k of ARCH_KEYS) o[k] = k in m ? m[k] : null; return o; };
const addNote = (m: Meta, at: string, text: string) => [...(Array.isArray(m.notes) ? m.notes : []), { at, text }];
const isOpenTask = (m: Meta) => !(m.archived === true || m.archived === "true") && ["task", ""].includes(String(m.type ?? "task").toLowerCase()) && !m.recurring && m.category !== "dids-followup";
export { isOpenTask };

// Already handled (done) or not doing it (drop): archived the way the brief's own check-off and the Past due card do it.
export function finish(m: Meta, how: "done" | "drop", now: string): Result<{ meta: Meta; prev: Prev }> {
  if (m.archived === true || m.archived === "true") return { ok: false, error: "That one is already finished or dropped." };
  const out: Meta = { ...m };
  const prev: Prev = { archive: pickArchive(m), note_at: now };
  out.archived = true; out.archived_at = now;
  out.archived_reason = how === "done" ? "checked off on daily brief" : "dropped from the From Doreen list";
  out.completed_via = how === "done" ? "from-doreen review" : "dropped from the From Doreen list";
  out.handoff_archived = how;
  out.notes = addNote(m, now, how === "done" ? "Dave marked this done." : "Dave dropped this.");
  return { ok: true, meta: out, prev };
}

// The task you tapped goes away (archived, pointing at the one it was merged into)...
export function mergeAway(m: Meta, intoId: string, now: string): Result<{ meta: Meta; prev: Prev }> {
  if (m.archived === true || m.archived === "true") return { ok: false, error: "That one is already finished or dropped." };
  const out: Meta = { ...m };
  const prev: Prev = { archive: pickArchive(m), merge: { into: intoId, note_at: now } };
  out.archived = true; out.archived_at = now; out.archived_reason = "merged into another task"; out.merged_into = intoId; out.handoff_archived = "merge";
  return { ok: true, meta: out, prev };
}
// ...and its words are kept as a note on the one you picked.
export function mergeNote(target: Meta, from: Thought, now: string): { meta: Meta; note: { at: string; text: string } } {
  const due = from.metadata?.due_date ? ` (due ${String(from.metadata.due_date).slice(0, 10)})` : "";
  const note = { at: now, text: `Merged from Doreen's task: "${clip(stripPrefix(from.content), 300)}"${due}` };
  return { meta: { ...target, notes: addNote(target, now, note.text) }, note };
}
export function unmergeNote(target: Meta, noteAt: string): Meta {
  if (!Array.isArray(target.notes)) return target;
  const notes = (target.notes as Array<{ at?: string }>).filter((n) => n.at !== noteAt);
  const out: Meta = { ...target };
  if (notes.length) out.notes = notes; else delete out.notes;
  return out;
}

// ── Finding a task that is probably the same job ──────────────
const STOP = new Set(["with", "from", "that", "this", "have", "will", "your", "their", "them", "then", "than", "into", "about", "also", "need", "needs",
  "make", "send", "check", "review", "update", "when", "what", "were", "been", "just", "more", "some", "like", "dave", "doreen", "task", "tasks"]);
export function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of stripPrefix(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}
// Shared words over the geometric mean of the two sizes; needs at least two words in common.
export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared >= 2 ? shared / Math.sqrt(A.size * B.size) : 0;
}
export function rankSimilar<T extends { id: string; content: string }>(target: { id: string; content: string }, pool: T[], min = 0.3, max = 6): Array<T & { score: number }> {
  return pool.filter((c) => c.id !== target.id).map((c) => ({ ...c, score: similarity(target.content, c.content) }))
    .filter((c) => c.score >= min).sort((x, y) => y.score - x.score).slice(0, max);
}
