// ============================================================
// STUDIO STRONG OPEN BRAIN — Brief "Markets" v1.0
// ============================================================
// Powers the "Markets" section of the morning-brief page (reelcall.app/brief.html):
// three folded cards, one per daily market brief, that open to what Dave has to act on.
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action: "get" }
//   → { ok, today, cards: [tsp, hard-asset, rsotc], links: { dids } }
//
//   links.dids       The dids.today admin page for "Client follow-ups from dids". It is handed over here, with the
//                    page key, so the address never sits in the public brief.html. Override with the DIDS_ADMIN_URL secret.
//
//   tsp, hard-asset  Read from market_briefs: the brief text copied verbatim from the Desktop LATEST files
//                    (TSP_Brief_LATEST.md, Hard_Asset_Brief_LATEST.md) by the 7:00 AM publisher task.
//                    parse.ts pulls out the call (MOVE / WAIT / HOLD, BUY NOW / WAIT ...), what to do, where
//                    he stands, and his own reminders. The whole brief rides along for the folded "Full brief".
//   rsotc            Computed live from rsotc_setups, the running list of Randy Phinney's trade setups that the
//                    hourly "RSOTC setup alerts" task keeps up to date: entry, stop, targets, last change.
//                    It also carries `board`: the same board that task sends Dave (TOP RR NOW, NEEDS ATTENTION, every
//                    open setup with its price-line picture), drawn by the SQL function rsotc_board from today's prices.
//                    Prices come from Yahoo the way that task gets them; if they can't be had the board is still drawn
//                    from Randy's levels and says so. Without a board the page falls back to the plain list.
//                    board.bets (bets.ts) groups the same setups by what they bet on (short big tech, short Treasuries ...),
//                    marks setups that are the same bet, and flags facts about each one's levels (near or past its stop,
//                    no stop, targets hit, through its trigger). Facts only; no ranking, no buy or sell calls.
//
// Read only. Nothing here writes. Kept as its own function so the morning-brief function that the 5:30 cron
// depends on is untouched.
//
// Secrets (project-wide, all already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { addDays, parseHardAsset, parseTsp, setupOut, sortSetups, type BriefParsed } from "./parse.ts";
import { attachIds, boardHeadline, fetchPrices, parseBoard, priceNote, type Board } from "./board.ts";
import { buildBets } from "./bets.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY  = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY     = env("BRIEF_PAGE_KEY");
const TZ           = "America/Chicago";
const MAX_SETUPS   = 60;
const DIDS_URL     = env("DIDS_ADMIN_URL", "");

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const todayCentral = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);   // YYYY-MM-DD
const shortDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

interface BriefRow { key: string; brief_date: string; body_md: string; published_at: string }

function briefCard(key: "tsp" | "hard-asset", title: string, row: BriefRow | undefined, parse: (s: string) => BriefParsed, today: string) {
  if (!row) {
    return { key, title, empty: true, tone: "info", tag: "", headline: "Not published here yet. It shows up after the next weekday run.", brief_date: null, stale: false, sections: [], full: "" };
  }
  const p = parse(row.body_md);
  return {
    key, title, empty: false,
    brief_date: row.brief_date, as_of: p.as_of, stale: row.brief_date < today,
    tag: p.tag, tone: p.tone, headline: p.headline, sections: p.sections, full: p.full,
    published_at: row.published_at,
  };
}

// Prices are cached for a minute so a few page loads in a row make one trip to Yahoo.
let priceCache: { at: number; key: string; prices: Record<string, number> } | null = null;
const PRICE_TTL_MS = 60_000;

async function buildBoard(setupRows: Array<{ id: string; ticker: string; direction: string; status: string; targets?: Array<{ hit?: string | null }> }>): Promise<Board | null> {
  try {
    const mine = await db.from("rsotc_my_trades").select("ticker").is("closed_at", null);
    const tickers = [...new Set([...setupRows.map((r) => r.ticker), ...((mine.data || []) as Array<{ ticker: string }>).map((r) => r.ticker)])].sort();
    const key = tickers.join(" ");
    let prices: Record<string, number> = {};
    if (priceCache && priceCache.key === key && Date.now() - priceCache.at < PRICE_TTL_MS) prices = priceCache.prices;
    else {
      prices = await fetchPrices(tickers);
      if (Object.keys(prices).length) priceCache = { at: Date.now(), key, prices };
    }
    const got = Object.keys(prices).length > 0;
    const r = await db.rpc("rsotc_board", { prices, legend: true });
    if (r.error || typeof r.data !== "string") { console.error("rsotc_board", r.error?.message); return null; }
    const board = parseBoard(r.data, priceNote(new Date(), got), got);
    attachIds(board, setupRows);
    // "By bet": the same setups grouped by what they bet on. If it can't be built the board is still sent without it.
    try { board.bets = buildBets(board, setupRows); } catch (e) { console.error("bets", (e as Error).message); board.bets = null; }
    return board;
  } catch (e) {
    console.error("board", (e as Error).message);
    return null;
  }
}

async function handleGet() {
  const today = todayCentral();
  const [mb, su, po] = await Promise.all([
    db.from("market_briefs").select("key,brief_date,body_md,published_at").order("brief_date", { ascending: false }).limit(12),
    db.from("rsotc_setups").select("*").not("status", "in", "(stopped,closed,expired)").limit(MAX_SETUPS),
    db.from("rsotc_posts").select("title,link,published_at").order("published_at", { ascending: false }).limit(1),
  ]);
  if (mb.error) console.error("market_briefs", mb.error.message);
  if (su.error) console.error("rsotc_setups", su.error.message);

  const rows = (mb.data || []) as BriefRow[];
  const latest = (k: string) => rows.find((r) => r.key === k);   // rows are newest first
  const tsp = briefCard("tsp", "TSP", latest("tsp"), parseTsp, today);
  const ha = briefCard("hard-asset", "Hard Asset", latest("hard-asset"), parseHardAsset, today);

  const setups = sortSetups((su.data || []).map((r: unknown) => setupOut(r, today)));
  const nLong = setups.filter((s) => s.direction === "long").length;
  const nShort = setups.filter((s) => s.direction === "short").length;
  const nWatch = setups.filter((s) => s.status === "watch").length;
  const nFresh = setups.filter((s) => s.fresh).length;
  const post = po.data && po.data[0] ? po.data[0] : null;
  const board = setups.length && !su.error ? await buildBoard(setups) : null;
  const rsotc = {
    key: "rsotc", title: "RSOTC", empty: !setups.length && !su.error, error: su.error ? "Couldn't load Randy's setups." : "",
    tone: "info", tag: setups.length ? `${setups.length} open` : "",
    headline: (board && boardHeadline(board)) || (setups.length
      ? `${nLong} long, ${nShort} short${nWatch ? `, ${nWatch} on watch` : ""}${nFresh ? ` · ${nFresh} changed since ${shortDate(addDays(today, -1))}` : ""}`
      : "No open setups right now."),
    counts: { long: nLong, short: nShort, watch: nWatch },
    board,
    setups, last_post: post ? { title: post.title, link: post.link, published_at: post.published_at } : null,
  };
  return json({ ok: true, today, cards: [tsp, ha, rsotc], links: { dids: DIDS_URL } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action === "get") return await handleGet();
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
