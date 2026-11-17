// ============================================================
// STUDIO STRONG OPEN BRAIN — HN Gems v1.0
// ============================================================
// Powers reelcall.app/gems.html: find overlooked Hacker News posts (the idea behind pj4533.com/hn-overlooked),
// heart the ones Dave likes, say why, keep them to come back to, and let what he likes shape what is shown first.
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, ... }
//
//   discover  { days=7, min_len=500, max_votes=50, max_comments=10, kinds=["ask","show"], sort="taste"|"passion", hide_seen=true, limit=120, topic?, fresh?, auto?, since?, visit? }
//             → { ok, cands:[{hn_id,kind,title,url,hn_link,author,posted_at,score,comments,text_len,passion,snippet,state,topics,taste}], meta }
//             Hacker News is asked fresh each time the page opens (a 5 minute memory only so sliders don't search again; fresh:true skips it).
//             auto:true sizes the window itself: whole days back to `since` (an ISO time), or to the last visit when no since is sent
//             (7 days when there has been no visit; at most 30). visit:true says "the page was just opened": the answer carries
//             meta.prev_visit (the time of the visit before this one) and this visit is recorded in hn_gems_meta. A new visit starts after
//             30 quiet minutes, so reloads and tapping around keep the same prev_visit.
//   list      → { ok, gems:[liked, newest first], tags:[{tag,count}], topics:[{topic,label,count}], presets, counts }   (history seeds are not listed)
//   search    { q, topic?, limit=40 }          → { ok, results:[saved posts and history posts that match every word, closest first], total, terms }
//   get       { hn_id }                         → one saved post with its full text
//   lookup    { ref }                           → a post from a pasted Hacker News link or number (with its saved state)
//   like      { hn_id, why_tags?, why_note?, post? }   saves it (fetches the post; `post` is the fallback if Hacker News can't be reached)
//   pass      { hn_id, post? }                  → "not for me": hidden from Discover, and it teaches the taste model
//   update    { hn_id, why_tags?, why_note?, topics?, followup?, done? }
//   forget    { hn_id }                         → removes a like or a pass
//
// Posts come from Algolia's public Hacker News search (a day at a time) and, for single posts, the Firebase item API.
// Taste (taste.ts) is plain word overlap with what he liked; every match shows the words and the post behind it.
// Topics (topics.ts) are one or two of twelve fixed topics worked out by keyword rules for every post, so a kept post can be browsed
// and searched later (search.ts); a topics value set by hand on a row wins over the rules.
// Table: hn_gems (RLS on, no policies; only this function reads or writes it). state is liked, passed, or seed:
// a seed is a post from his browsing history (loaded once). It teaches taste like a heart does, but counts for less, is
// hidden from Discover (he has seen it), and never shows in Saved. Hearting a seed (or pasting its link) turns it into a real like.
// His browsing history was loaded as seeds first and then saved as likes tagged "From my history" (dated the day he opened each one), so he
// can Remove the ones he doesn't want. A like whose only reason is that tag, with no note, keeps the lighter seed weight in the taste model.
// Table hn_gems_meta: one row, when the page was last opened, so "since I last looked" is the same on every device.
//
// Secrets (project-wide, already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { cleanTags, fetchWindow, hnLink, parseItemRef, postFromFirebase, toCandidates, type Candidate, type FindOpts, type Post } from "./hn.ts";
import { buildModel, MIN_LIKES, type Doc } from "./taste.ts";
import { cleanTopics, isTopic, TOPICS, topicsFor, topicsOf, type Topic } from "./topics.ts";
import { queryTerms, searchScore, snippetAround } from "./search.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY = env("BRIEF_PAGE_KEY");
const OWNER = "dave";

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

// Reasons he can tap. His own words are added to this list as he uses them.
const PRESET_TAGS = [
  "Clever idea", "Solves a problem I have", "Could build on it", "Business idea", "Beautifully made", "Good writing",
  "Great story", "Learn from it", "Tool I'd use", "For the gym", "AI / agents", "Want to talk to the author",
];

const HISTORY_TAG = "From my history";
const SESSION_MS = 30 * 60_000, DAY_MS = 86_400_000;

const COLS = "hn_id,state,kind,title,url,author,posted_at,score,comments,why_tags,why_note,topics,followup,revisited_at,liked_at,updated_at";
const SNIPPET = 360;

interface Row {
  hn_id: number; state: string; kind: string; title: string; url: string | null; author: string | null; posted_at: string | null;
  score: number | null; comments: number | null; why_tags: string[]; why_note: string | null; topics: string[] | null; followup: string | null;
  revisited_at: string | null; liked_at: string | null; updated_at: string; body?: string | null;
}
const rowTopics = (r: Row): Topic[] => topicsFor({ title: r.title, text: r.body, note: r.why_note, tags: r.why_tags ?? [] }, r.topics);
const topicRows = (lists: Topic[][]) => {            // how many posts carry each topic, biggest first
  const n = new Map<Topic, number>();
  for (const l of lists) for (const t of l) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].map(([topic, count]) => ({ topic, label: TOPICS[topic], count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};
const gemOut = (r: Row, withBody = false) => ({
  hn_id: r.hn_id, kind: r.kind, title: r.title, url: r.url, hn_link: hnLink(r.hn_id), author: r.author, posted_at: r.posted_at,
  score: r.score ?? 0, comments: r.comments ?? 0, why_tags: r.why_tags ?? [], why_note: r.why_note, followup: r.followup,
  topics: rowTopics(r), revisited_at: r.revisited_at, liked_at: r.liked_at,
  ...(withBody ? { body: r.body ?? "" } : { snippet: (r.body ?? "").replace(/\s+/g, " ").slice(0, SNIPPET) }),
});

// ── input hygiene ──
const hnId = (x: unknown): number => { const n = Number(x); if (!Number.isInteger(n) || n <= 0 || n > 9_999_999_999) throw new Bad("That isn't a Hacker News post number."); return n; };
const note = (x: unknown, max = 1000): string | null => { const s = String(x ?? "").trim(); return s ? s.slice(0, max) : null; };

// ── Hacker News ──
async function fetchPost(id: number): Promise<Post | null> {
  try {
    const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return postFromFirebase(await res.json());
  } catch (e) { console.error("item", id, (e as Error).message); return null; }
}
// What the page sent about a post, used only when Hacker News can't be reached; every field is cut to size.
function clientPost(id: number, p: unknown): Post | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const title = String(o.title ?? "").trim().slice(0, 300);
  if (!title) return null;
  const kind = o.kind === "ask" || o.kind === "show" ? o.kind : "story";
  const url = typeof o.url === "string" && /^https?:\/\//i.test(o.url) ? o.url.slice(0, 1000) : null;
  return { hn_id: id, kind, title, url, author: o.author ? String(o.author).slice(0, 60) : null, posted_at: typeof o.posted_at === "string" ? o.posted_at.slice(0, 40) : null,
    score: Number(o.score) || 0, comments: Number(o.comments) || 0, text: String(o.text ?? o.snippet ?? "").slice(0, 20000) };
}

// ── candidates are cached for 5 minutes, so tweaking a slider doesn't search again ──
const winCache = new Map<string, { at: number; posts: Post[]; looked: number }>();
const WIN_TTL_MS = 5 * 60_000;
async function getWindow(o: FindOpts, fresh = false) {
  const key = `${o.days}|${o.maxVotes}|${o.maxComments}|${o.kinds.join(",")}`;
  const hit = winCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < WIN_TTL_MS) return hit;
  const r = await fetchWindow(o, fetch as never);
  const entry = { at: Date.now(), posts: r.posts, looked: r.looked_at };
  winCache.set(key, entry);
  if (winCache.size > 12) winCache.delete(winCache.keys().next().value as string);
  return entry;
}

async function savedRows(states: string[], withBody = true): Promise<Row[]> {
  const q = await db.from("hn_gems").select(withBody ? COLS + ",body" : COLS).eq("owner", OWNER).in("state", states).order("liked_at", { ascending: false, nullsFirst: false }).limit(2000);
  if (q.error) throw new Error(q.error.message);
  return (q.data || []) as unknown as Row[];
}
// A history post he saved but never gave a reason of his own: it teaches like a seed (lighter) until he adds a reason or note.
const historyOnly = (r: Row) => r.state === "liked" && !r.why_note && (r.why_tags ?? []).length === 1 && r.why_tags[0].toLowerCase() === HISTORY_TAG.toLowerCase();
const toDoc = (r: Row): Doc => ({ id: r.hn_id, title: r.title, text: r.body ?? "", note: r.why_note, tags: r.why_tags ?? [], seed: r.state === "seed" || historyOnly(r) });

// ── when he last looked ──
interface Visit { last_visit_at: string; prev_visit_at: string | null }
async function readVisit(): Promise<Visit | null> {
  const q = await db.from("hn_gems_meta").select("last_visit_at,prev_visit_at").eq("owner", OWNER).maybeSingle();
  if (q.error) throw new Error(q.error.message);
  return (q.data as Visit | null) ?? null;
}
// The visit before this one. A visit ends after 30 quiet minutes, so a reload or a slider keeps the same answer.
const visitBefore = (v: Visit | null, now: number): string | null => (!v ? null : now - Date.parse(v.last_visit_at) < SESSION_MS ? v.prev_visit_at : v.last_visit_at);
async function touchVisit(v: Visit | null, now: number) {
  const iso = new Date(now).toISOString();
  const r = !v
    ? await db.from("hn_gems_meta").insert({ owner: OWNER, last_visit_at: iso, prev_visit_at: null, updated_at: iso })
    : await db.from("hn_gems_meta").update(now - Date.parse(v.last_visit_at) < SESSION_MS ? { last_visit_at: iso, updated_at: iso } : { prev_visit_at: v.last_visit_at, last_visit_at: iso, updated_at: iso }).eq("owner", OWNER);
  if (r.error) throw new Error(r.error.message);
}

// ── actions ──
async function discover(b: Record<string, unknown>) {
  const kindsIn = Array.isArray(b.kinds) ? b.kinds.filter((k) => k === "ask" || k === "show") : [];
  // When he last looked. A failure here never stops the list from loading; the page just has no "since" to go on.
  const now = Date.now(), auto = b.auto === true;
  let visit: Visit | null = null, prev: string | null = null;
  const sent = typeof b.since === "string" ? Date.parse(b.since) : NaN;
  const sinceSent = Number.isFinite(sent) && sent <= now + 60_000 ? sent : NaN;
  if (b.visit === true || (auto && !Number.isFinite(sinceSent))) {
    try { visit = await readVisit(); prev = visitBefore(visit, now); } catch (e) { console.error("visit read", (e as Error).message); }
  }
  const sinceMs = Number.isFinite(sinceSent) ? sinceSent : prev ? Date.parse(prev) : NaN;
  const o: FindOpts = {
    days: auto ? (Number.isFinite(sinceMs) ? Math.max(1, Math.min(30, Math.ceil((now - sinceMs) / DAY_MS))) : 7) : Math.max(1, Math.min(30, Number(b.days) || 7)),
    maxVotes: Math.max(1, Math.min(500, Number(b.max_votes) || 50)),
    maxComments: Math.max(0, Math.min(200, b.max_comments === 0 ? 0 : Number(b.max_comments) || 10)),
    kinds: (kindsIn.length ? [...new Set(kindsIn)] : ["ask", "show"]) as FindOpts["kinds"],
  };
  const minLen = Math.max(0, Math.min(10000, b.min_len === 0 ? 0 : Number(b.min_len) || 500));
  const limit = Math.max(10, Math.min(300, Number(b.limit) || 120));
  const hideSeen = b.hide_seen !== false;
  const topic: Topic | null = isTopic(b.topic) ? b.topic : null;

  const [win, saved] = await Promise.all([getWindow(o, b.fresh === true), savedRows(["liked", "passed", "seed"])]);
  const state = new Map(saved.map((r) => [r.hn_id, r.state]));
  const all = toCandidates(win.posts, minLen);
  const matched = all.length;
  const liked = saved.filter((r) => r.state !== "passed"), passed = saved.filter((r) => r.state === "passed");   // hearts and history seeds teach; passes teach the other way

  const model = buildModel(liked.map(toDoc), passed.map(toDoc)).forCandidates(all.map((c): Doc => ({ id: c.hn_id, title: c.title, text: c.text })));
  const taste = model.scores();
  let pool: Candidate[] = all;
  if (hideSeen) pool = pool.filter((c) => !state.has(c.hn_id));
  const tmap = new Map(pool.map((c) => [c.hn_id, topicsOf({ title: c.title, text: c.text })]));
  const topicCounts = topicRows([...tmap.values()]);                    // counted before the topic filter, so the chips stay put
  if (topic) pool = pool.filter((c) => tmap.get(c.hn_id)!.includes(topic));
  const sort = b.sort === "passion" || !model.ready ? "passion" : "taste";
  if (sort === "taste") pool = [...pool].sort((a, c) => (taste.get(c.hn_id)?.score ?? 0) - (taste.get(a.hn_id)?.score ?? 0) || c.passion - a.passion);
  if (b.visit === true) { try { await touchVisit(visit, now); } catch (e) { console.error("visit write", (e as Error).message); } }
  const cands = pool.slice(0, limit).map((c) => ({
    hn_id: c.hn_id, kind: c.kind, title: c.title, url: c.url, hn_link: hnLink(c.hn_id), author: c.author, posted_at: c.posted_at,
    score: c.score, comments: c.comments, text_len: c.text_len, passion: c.passion,
    snippet: c.text.replace(/\s+/g, " ").slice(0, 600), state: state.get(c.hn_id) ?? null,
    topics: tmap.get(c.hn_id) ?? topicsOf({ title: c.title, text: c.text }),
    taste: model.ready ? taste.get(c.hn_id) ?? null : null,
  }));
  return { ok: true, cands, meta: {
    looked: win.looked, matched, shown: cands.length, hidden_seen: hideSeen ? all.length - [...tmap.keys()].length : 0, days: o.days,
    topics: topicCounts, topic, auto, prev_visit: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    sort, taste_ready: model.ready, likes: model.likes, seeds: model.seeds, passes: model.passes, min_likes: MIN_LIKES, at: new Date(win.at).toISOString(),
  } };
}

async function list() {
  const [rows, passed] = await Promise.all([
    savedRows(["liked"]),
    db.from("hn_gems").select("hn_id", { count: "exact", head: true }).eq("owner", OWNER).eq("state", "passed"),
  ]);
  const counts = new Map<string, { tag: string; count: number }>();
  for (const r of rows) for (const t of r.why_tags ?? []) { const k = t.toLowerCase(); const e = counts.get(k) ?? { tag: t, count: 0 }; e.count++; counts.set(k, e); }
  const tags = [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const gems = rows.map((r) => gemOut(r));
  return { ok: true, gems, tags, topics: topicRows(gems.map((g) => g.topics)), presets: PRESET_TAGS,
    counts: { liked: rows.length, with_why: rows.filter((r) => (r.why_tags?.length ?? 0) > 0 || r.why_note).length, to_revisit: rows.filter((r) => !r.revisited_at).length, passed: passed.count ?? 0 } };
}

// Everything he kept or opened that matches every word he typed (and, if given, one topic). Saved posts come before history posts.
async function search(b: Record<string, unknown>) {
  const terms = queryTerms(b.q);
  const topic: Topic | null = isTopic(b.topic) ? b.topic : null;
  if (!terms.length && !topic) throw new Bad("Type a word or two to search for.");
  const limit = Math.max(5, Math.min(100, Number(b.limit) || 40));
  const rows = await savedRows(["liked", "seed"]);
  const hits: Array<{ r: Row; topics: Topic[]; score: number }> = [];
  for (const r of rows) {
    const topics = rowTopics(r);
    if (topic && !topics.includes(topic)) continue;
    const score = terms.length ? searchScore(terms, { title: r.title, text: r.body, note: r.why_note, tags: r.why_tags ?? [], topics }) : 1;
    if (score) hits.push({ r, topics, score });
  }
  hits.sort((a, c) => (a.r.state === "liked" ? 0 : 1) - (c.r.state === "liked" ? 0 : 1) || c.score - a.score || String(c.r.posted_at ?? "").localeCompare(String(a.r.posted_at ?? "")));
  const results = hits.slice(0, limit).map(({ r, topics, score }) => ({ ...gemOut(r), state: r.state, topics, score: Math.round(score * 10) / 10, snippet: snippetAround(r.body ?? "", terms, 240) }));
  return { ok: true, results, total: hits.length, terms };
}

async function getOne(b: Record<string, unknown>) {
  const id = hnId(b.hn_id);
  const q = await db.from("hn_gems").select(COLS + ",body").eq("owner", OWNER).eq("hn_id", id).maybeSingle();
  if (q.error) throw new Error(q.error.message);
  if (!q.data) throw new Bad("That one isn't saved.", 404);
  return { ok: true, gem: gemOut(q.data as unknown as Row, true) };
}

async function lookup(b: Record<string, unknown>) {
  const id = parseItemRef(String(b.ref ?? ""));
  if (!id) throw new Bad("That doesn't look like a Hacker News link or post number. Try the address ending in item?id=12345678.");
  const raw = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null) as Record<string, unknown> | null;
  if (!raw) throw new Bad("Couldn't reach Hacker News for that one. Try again in a moment.", 502);
  const post = postFromFirebase(raw);
  if (!post) throw new Bad(raw.type === "comment" ? "That's a comment. Paste the link to the post itself." : "Couldn't use that one. It may be deleted, or not a story.", 404);
  const q = await db.from("hn_gems").select("state").eq("owner", OWNER).eq("hn_id", id).maybeSingle();
  return { ok: true, post: { ...post, topics: topicsOf({ title: post.title, text: post.text }), hn_link: hnLink(id), snippet: post.text.replace(/\s+/g, " ").slice(0, 600), state: (q.data as { state: string } | null)?.state ?? null } };
}

async function ensurePost(id: number, fallback: unknown): Promise<Post> {
  const p = (await fetchPost(id)) ?? clientPost(id, fallback);
  if (!p) throw new Bad("Couldn't get that post from Hacker News, and nothing was sent to save instead.", 502);
  return p;
}
const postCols = (p: Post) => ({ kind: p.kind, title: p.title, url: p.url, author: p.author, posted_at: p.posted_at, score: p.score, comments: p.comments, body: p.text });

async function like(b: Record<string, unknown>) {
  const id = hnId(b.hn_id);
  const now = new Date().toISOString();
  const old = await db.from("hn_gems").select("state,liked_at,why_tags,why_note").eq("owner", OWNER).eq("hn_id", id).maybeSingle();
  if (old.error) throw new Error(old.error.message);
  const prev = old.data as { state: string; liked_at: string | null; why_tags: string[]; why_note: string | null } | null;
  const patch: Record<string, unknown> = { state: "liked", updated_at: now, liked_at: prev?.state === "liked" && prev.liked_at ? prev.liked_at : now };
  if (b.why_tags !== undefined) patch.why_tags = cleanTags(b.why_tags);
  if (b.why_note !== undefined) patch.why_note = note(b.why_note);
  if (b.topics !== undefined) patch.topics = cleanTopics(b.topics).length ? cleanTopics(b.topics) : null;
  let res;
  if (prev) res = await db.from("hn_gems").update(patch).eq("owner", OWNER).eq("hn_id", id).select(COLS + ",body").single();
  else {
    const p = await ensurePost(id, b.post);
    res = await db.from("hn_gems").insert({ owner: OWNER, hn_id: id, why_tags: [], ...patch, ...postCols(p) }).select(COLS + ",body").single();
  }
  if (res.error) throw new Error(res.error.message);
  return { ok: true, gem: gemOut(res.data as unknown as Row, true) };
}

async function pass(b: Record<string, unknown>) {
  const id = hnId(b.hn_id);
  const old = await db.from("hn_gems").select("state").eq("owner", OWNER).eq("hn_id", id).maybeSingle();
  if (old.data) {
    if ((old.data as { state: string }).state === "liked") throw new Bad("That one is saved. Remove it from Saved first.", 409);
    return { ok: true };
  }
  const p = await ensurePost(id, b.post);
  const res = await db.from("hn_gems").insert({ owner: OWNER, hn_id: id, state: "passed", why_tags: [], ...postCols(p) });
  if (res.error) throw new Error(res.error.message);
  return { ok: true };
}

async function update(b: Record<string, unknown>) {
  const id = hnId(b.hn_id);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.why_tags !== undefined) patch.why_tags = cleanTags(b.why_tags);
  if (b.why_note !== undefined) patch.why_note = note(b.why_note);
  if (b.topics !== undefined) patch.topics = cleanTopics(b.topics).length ? cleanTopics(b.topics) : null;
  if (b.followup !== undefined) patch.followup = note(b.followup);
  if (b.done !== undefined) patch.revisited_at = b.done ? new Date().toISOString() : null;
  const res = await db.from("hn_gems").update(patch).eq("owner", OWNER).eq("hn_id", id).eq("state", "liked").select(COLS + ",body").maybeSingle();
  if (res.error) throw new Error(res.error.message);
  if (!res.data) throw new Bad("That one isn't saved.", 404);
  return { ok: true, gem: gemOut(res.data as unknown as Row, true) };
}

async function forget(b: Record<string, unknown>) {
  const id = hnId(b.hn_id);
  const res = await db.from("hn_gems").delete().eq("owner", OWNER).eq("hn_id", id);
  if (res.error) throw new Error(res.error.message);
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "discover": return json(await discover(body));
      case "list": return json(await list());
      case "search": return json(await search(body));
      case "get": return json(await getOne(body));
      case "lookup": return json(await lookup(body));
      case "like": return json(await like(body));
      case "pass": return json(await pass(body));
      case "update": return json(await update(body));
      case "forget": return json(await forget(body));
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof Bad) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
