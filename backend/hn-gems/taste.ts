// ============================================================
// Taste for the hn-gems function (pure, so it can be unit tested).
//
// Learns from what Dave liked and passed on, and lifts overlooked posts that read like the ones he liked.
// No model, no guesswork hidden anywhere: each post is turned into a weighted bag of words (rarer words count
// more), and a candidate is scored by how close it is to the nearest posts he liked, minus a little for how
// close it is to posts he passed on. His own reasons ("why I liked it") count extra, so what he writes teaches
// it faster than the posts do. Every score comes with the words and the liked post that explain it.
// ============================================================

// seed: a post he opened in his browsing history. It teaches the model like a heart does, but counts for less.
export interface Doc { id: number; title: string; text: string; note?: string | null; tags?: string[]; seed?: boolean }
export type Label = "strong" | "some" | "weak" | "none";
export interface Taste {
  score: number;                 // 0..1 closeness (before the pass penalty it is the closeness to his nearest likes)
  label: Label;
  because: string[];             // up to 3 shared words
  like: { id: number; title: string; tags: string[]; seed: boolean } | null;   // the liked post it is closest to (seed = from his history)
  near_passed: boolean;          // closer to something he passed on than to anything he liked
}
export interface Model { ready: boolean; likes: number; seeds: number; passes: number; scores(): Map<number, Taste> }

export const MIN_LIKES = 3;      // fewer than this (hearts and history posts together) and there is nothing to learn from yet
export const SEED_WEIGHT = 0.6;  // a post from his history counts this much compared with a heart

const STOP = new Set(("a about above after again against all also am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just let me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours "
  + "hn show ask hello hey thanks thank please post posts feedback website site link links check http https www com org net io github get got getting use used using uses make made making like want need know think really thing things way one two new also still even much many lot lots less around maybe pretty quite etc eg ie via per without within across among ago today yesterday year years month months week weeks day days time").split(/\s+/));
const KEEP_SHORT = new Set(["ai", "ml", "ui", "ux", "os", "db", "qa", "vr", "ar", "3d", "2d", "c#", "c++", "js", "ts"]);

// Words with the form they were written in, so a shown word is always a real one ("caches", not the stem "cach").
export function tokenPairs(s: string): Array<[string, string]> {
  const t = String(s ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/&[a-z#0-9]+;/g, " ");
  const raw = t.match(/[a-z0-9][a-z0-9+#.\-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  const out: Array<[string, string]> = [];
  for (let w of raw) {
    w = w.replace(/^[.\-]+|[.\-]+$/g, "");
    if (!w) continue;
    if (/^\d+$/.test(w)) continue;                      // bare numbers say nothing
    if (w.length < 3 && !KEEP_SHORT.has(w)) continue;
    const st = stem(w);
    if (STOP.has(st) || STOP.has(w) || (st.length < 3 && !KEEP_SHORT.has(st))) continue;
    out.push([st, w]);
  }
  return out;
}
export const tokens = (s: string): string[] => tokenPairs(s).map((p) => p[0]);
// Plurals only, so "agents" and "agent" meet; nothing cleverer, so a shown word stays a real word.
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

type Vec = Map<string, number>;
const W_TITLE = 3, W_NOTE = 4, W_TAG = 3;

function counts(d: Doc, surf: Map<string, string>): Map<string, number> {
  const c = new Map<string, number>();
  const add = (s: string, w: number) => {
    for (const [t, orig] of tokenPairs(s)) {
      c.set(t, (c.get(t) ?? 0) + w);
      const cur = surf.get(t);
      if (cur === undefined || orig.length < cur.length) surf.set(t, orig);
    }
  };
  add(d.title, W_TITLE);
  add(d.text, 1);
  if (d.note) add(d.note, W_NOTE);
  for (const tag of d.tags ?? []) add(tag, W_TAG);
  return c;
}
function vectorize(c: Map<string, number>, idf: (t: string) => number): Vec {
  const v: Vec = new Map();
  let norm = 0;
  for (const [t, n] of c) { const w = (1 + Math.log(n)) * idf(t); v.set(t, w); norm += w * w; }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}
const dot = (a: Vec, b: Vec) => { const [s, l] = a.size < b.size ? [a, b] : [b, a]; let x = 0; for (const [t, w] of s) { const o = l.get(t); if (o) x += w * o; } return x; };

export function buildModel(liked: Doc[], passed: Doc[]): { forCandidates(cands: Doc[]): Model } {
  return {
    forCandidates(cands: Doc[]): Model {
      const seeds = liked.filter((d) => d.seed).length, likes = liked.length - seeds, passes = passed.length;
      const ready = likes + seeds >= MIN_LIKES;
      const model: Model = { ready, likes, seeds, passes, scores: () => new Map() };
      if (!ready) return model;
      // Word rarity comes from everything in view, so a word that every post uses counts for little.
      const all = [...cands, ...liked, ...passed];
      const df = new Map<string, number>();
      const cs = new Map<Doc, Map<string, number>>();
      const surf = new Map<string, string>();
      for (const d of all) { const c = counts(d, surf); cs.set(d, c); for (const t of c.keys()) df.set(t, (df.get(t) ?? 0) + 1); }
      const N = all.length;
      const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
      const L = liked.map((d) => ({ d, v: vectorize(cs.get(d)!, idf) }));
      const P = passed.map((d) => ({ d, v: vectorize(cs.get(d)!, idf) }));
      const raw: Array<{ d: Doc; cv: Vec; s: number; near: typeof L[number]; nearSim: number; passSim: number }> = [];
      for (const d of cands) {
        const cv = vectorize(cs.get(d)!, idf);
        const sims = L.map((x) => ({ x, s: x.d.id === d.id ? 0 : dot(cv, x.v) * (x.d.seed ? SEED_WEIGHT : 1) })).sort((a, b) => b.s - a.s);
        const w = [0.5, 0.3, 0.2];
        const top = sims.slice(0, 3);
        const wsum = top.reduce((n, _t, i) => n + w[i], 0);
        const sLike = top.reduce((n, t, i) => n + t.s * w[i], 0) / (wsum || 1);
        const passSim = P.reduce((m, x) => (x.d.id === d.id ? m : Math.max(m, dot(cv, x.v))), 0);
        raw.push({ d, cv, s: Math.max(0, sLike - 0.5 * passSim), near: sims[0].x, nearSim: sims[0].s, passSim });
      }
      const order = [...raw].sort((a, b) => b.s - a.s);
      const rank = new Map(order.map((r, i) => [r.d.id, i]));
      const n = raw.length || 1;
      const out = new Map<number, Taste>();
      for (const r of raw) {
        const pct = (rank.get(r.d.id) ?? n) / n;                        // 0 = best
        const label: Label = r.nearSim < 0.05 ? "none" : pct < 0.1 ? "strong" : pct < 0.3 ? "some" : "weak";
        const because: string[] = [];
        if (label !== "none") {
          const shared = [...r.cv].filter(([t]) => r.near.v.has(t)).map(([t, w]) => ({ t, p: w * (r.near.v.get(t) ?? 0) })).sort((a, b) => b.p - a.p);
          for (const s of shared) { if (because.length < 3) because.push(surf.get(s.t) ?? s.t); }
        }
        out.set(r.d.id, {
          score: Math.round(r.s * 1000) / 1000, label, because,
          like: label === "none" ? null : { id: r.near.d.id, title: r.near.d.title, tags: r.near.d.tags ?? [], seed: !!r.near.d.seed },
          near_passed: r.passSim > r.nearSim && r.passSim > 0.1,
        });
      }
      model.scores = () => out;
      return model;
    },
  };
}
