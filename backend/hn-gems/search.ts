// ============================================================
// Search for the hn-gems function (pure, so it can be unit tested).
//
// "Do I have anything for X?" Every word he types has to appear somewhere in the post: its title, the text,
// his own reason or note, or its topic name. Words match inside longer words ("gym" finds "gyms"), any case.
// Title, his own words and the topic count more than the text, so the closest posts come first.
// ============================================================

import { TOPICS, type Topic } from "./topics.ts";

export interface SearchDoc { title: string; text?: string | null; note?: string | null; tags?: string[]; topics?: Topic[] }

// Up to 6 words of at least 2 characters (a lone letter says nothing), lowercase, no repeats.
export function queryTerms(q: unknown): string[] {
  const out: string[] = [];
  for (const w of String(q ?? "").toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (w.length >= 2 && !out.includes(w)) out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

// 0 when any word is missing, otherwise how well it fits (higher is closer).
export function searchScore(terms: string[], d: SearchDoc): number {
  if (!terms.length) return 0;
  const title = String(d.title ?? "").toLowerCase();
  const text = String(d.text ?? "").toLowerCase();
  const mine = [d.note ?? "", ...(d.tags ?? [])].join(" ").toLowerCase();
  const topic = (d.topics ?? []).map((t) => `${t} ${TOPICS[t] ?? ""}`).join(" ").toLowerCase();
  let score = 0;
  for (const t of terms) {
    let s = 0;
    if (title.includes(t)) s += 5;
    if (mine.includes(t)) s += 4;
    if (topic.includes(t)) s += 3;
    const i = text.indexOf(t);
    if (i !== -1) { s += 1; let n = 1, j = i; while (n < 4 && (j = text.indexOf(t, j + t.length)) !== -1) n++; s += (n - 1) * 0.3; }
    if (!s) return 0;
    score += s;
  }
  return score;
}

// A stretch of the text around the first word that matches, so a result shows why it matched.
export function snippetAround(text: string, terms: string[], len = 220): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= len) return flat;
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return flat.slice(0, len) + "…";
  const start = Math.max(0, Math.min(at - 60, flat.length - len));
  return (start > 0 ? "…" : "") + flat.slice(start, start + len) + (start + len < flat.length ? "…" : "");
}
