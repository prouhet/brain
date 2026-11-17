// ============================================================
// Hacker News helpers for the hn-gems function (pure: no Deno or database calls, so they can be unit tested).
//
// Finds "overlooked" posts the same way pj4533.com/hn-overlooked does: text posts (Ask HN, Show HN) with few
// votes and few comments, ranked by his "passion score" (long text, little attention). He scans three feeds with
// the Firebase API; this asks Algolia's public Hacker News search for the same kind of post over a window of days,
// which covers everything his scan found (checked on live data: 58 of 58) plus the posts his feed caps cut off.
// ============================================================

export type Kind = "ask" | "show" | "story";
export interface Post {
  hn_id: number; kind: Kind; title: string; url: string | null; author: string | null;
  posted_at: string | null; score: number; comments: number; text: string;   // text is plain text, paragraphs split by a blank line
}
export interface Candidate extends Post { text_len: number; passion: number }

const NAMED: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&" };
export function decodeEntities(s: string): string {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d+);/g, (_m, d: string) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } })
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);   // &amp; is decoded in this same pass, so "&amp;lt;" stays "&lt;"
}

// HN's HTML (<p>, <a>, <i>, <pre><code>) to readable text. A link whose text was cut short with "..." shows its full address instead.
export function htmlToText(html: string | null | undefined): string {
  let s = String(html ?? "");
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_m, href: string, inner: string) => {
    const t = inner.replace(/<[^>]*>/g, "");
    return /(\.\.\.|…)\s*$/.test(t) ? decodeEntities(href) : t;
  });
  s = s.replace(/<\s*(p|\/p|br\s*\/?|\/pre|pre|\/li|li)\s*[^>]*>/gi, (_m, tag: string) => (/^br/i.test(tag) ? "\n" : "\n\n"));
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export const kindOf = (title: string): Kind => (/^\s*ask hn\b/i.test(title) ? "ask" : /^\s*show hn\b/i.test(title) ? "show" : "story");

// pj4533's formula, unchanged: long text and little engagement score high.
export function passion(textLen: number, score: number, comments: number): number {
  const lengthScore = Math.min((textLen || 0) / 500, 10);
  const engagement = Math.max(score || 0, 1) + (comments || 0) * 2;
  return engagement === 0 ? lengthScore * 100 : (lengthScore / engagement) * 100;
}

// Accepts a news.ycombinator.com link, a Firebase or Algolia address, "hn:123", or just the number.
export function parseItemRef(input: string): number | null {
  const t = String(input ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(?:hn\s*:?\s*)?#?(\d{1,10})$/i);
  if (m) return Number(m[1]);
  m = t.match(/[?&]id=(\d{1,10})\b/) || t.match(/\/item\/(\d{1,10})(?:\.json)?\b/) || t.match(/\/items\/(\d{1,10})\b/);
  if (m && /ycombinator\.com|algolia\.com|firebaseio\.com/i.test(t)) return Number(m[1]);
  return null;
}

const iso = (sec: unknown) => (typeof sec === "number" && isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const num = (x: unknown) => (typeof x === "number" && isFinite(x) ? x : 0);
const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null);
const link = (x: unknown) => (typeof x === "string" && /^https?:\/\//i.test(x.trim()) ? x.trim().slice(0, 1000) : null);

// A Firebase item (https://hacker-news.firebaseio.com/v0/item/ID.json). null for comments, jobs, deleted or dead posts.
export function postFromFirebase(it: Record<string, unknown> | null | undefined): Post | null {
  if (!it || typeof it !== "object" || it.deleted || it.dead) return null;
  if (it.type !== "story" && it.type !== "poll") return null;
  const title = str(it.title, 300);
  if (!title || typeof it.id !== "number") return null;
  return {
    hn_id: it.id, kind: kindOf(title), title: decodeEntities(title), url: link(it.url), author: str(it.by, 60),
    posted_at: iso(it.time), score: num(it.score), comments: num(it.descendants), text: htmlToText(it.text as string),
  };
}

// An Algolia hit from search_by_date.
export function postFromAlgolia(h: Record<string, unknown> | null | undefined): Post | null {
  if (!h || typeof h !== "object") return null;
  const id = Number(h.objectID);
  const title = str(h.title, 300);
  if (!id || !isFinite(id) || !title) return null;
  return {
    hn_id: id, kind: kindOf(title), title: decodeEntities(title), url: link(h.url), author: str(h.author, 60),
    posted_at: typeof h.created_at_i === "number" ? iso(h.created_at_i) : str(h.created_at, 40),
    score: num(h.points), comments: num(h.num_comments), text: htmlToText(h.story_text as string),
  };
}

export const hnLink = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

export interface FindOpts { days: number; maxVotes: number; maxComments: number; kinds: Array<"ask" | "show"> }
const DAY = 86400;
// Algolia answers at most 1000 posts per search, newest first, so the window is searched a slice at a time (a day each).
export function algoliaUrl(o: FindOpts, fromSec: number, toSec: number): string {
  const tags = o.kinds.length === 1 ? `story,${o.kinds[0]}_hn` : "story,(ask_hn,show_hn)";
  const filters = `points<=${o.maxVotes},num_comments<=${o.maxComments},created_at_i>=${Math.floor(fromSec)},created_at_i<${Math.floor(toSec)}`;
  return `https://hn.algolia.com/api/v1/search_by_date?tags=${tags}&numericFilters=${encodeURIComponent(filters)}&hitsPerPage=1000&page=0`;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

// Every Ask/Show post in the window with at most maxVotes votes and maxComments comments (text not yet checked for length).
export async function fetchWindow(o: FindOpts, fetchFn: FetchLike, nowSec = Math.floor(Date.now() / 1000)): Promise<{ posts: Post[]; looked_at: number }> {
  const byId = new Map<number, Post>();
  let looked = 0;
  async function slice(from: number, to: number, depth: number): Promise<void> {
    const res = await fetchFn(algoliaUrl(o, from, to), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error("Hacker News search answered with an error.");
    const body = await res.json() as { hits?: Array<Record<string, unknown>> };
    const hits = body.hits ?? [];
    if (hits.length >= 1000 && depth < 4 && to - from > 3600) {      // a full page means posts may have been cut off: look at each half
      const mid = Math.floor((from + to) / 2);
      await Promise.all([slice(from, mid, depth + 1), slice(mid, to, depth + 1)]);
      return;
    }
    for (const h of hits) { looked++; const p = postFromAlgolia(h); if (p) byId.set(p.hn_id, p); }
  }
  const days = Math.max(1, Math.min(30, Math.round(o.days)));
  const slices: Array<[number, number]> = [];
  for (let d = 0; d < days; d++) slices.push([nowSec - (d + 1) * DAY, d === 0 ? nowSec + 60 : nowSec - d * DAY]);
  for (let i = 0; i < slices.length; i += 6) await Promise.all(slices.slice(i, i + 6).map(([a, b]) => slice(a, b, 0)));
  return { posts: [...byId.values()], looked_at: looked };
}

export function toCandidates(posts: Post[], minLen: number): Candidate[] {
  const out: Candidate[] = [];
  for (const p of posts) {
    const text_len = p.text.replace(/\n+/g, "").length;   // counted the way his page does: the text with the tags taken out, no paragraph breaks
    if (!p.text || text_len < minLen) continue;
    out.push({ ...p, text_len, passion: Math.round(passion(text_len, p.score, p.comments) * 100) / 100 });
  }
  return out.sort((a, b) => b.passion - a.passion || b.hn_id - a.hn_id);
}

// Reasons he gives: trimmed, no repeats (any case), at most 8, each at most 40 characters.
export function cleanTags(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>(), out: string[] = [];
  for (const t of x) {
    const s = String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    if (out.length >= 8) break;
  }
  return out;
}
