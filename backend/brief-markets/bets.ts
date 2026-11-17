// ============================================================
// "By bet" for the RSOTC board (pure: no Deno or network calls, so it can be unit tested).
//
// The board lists setups by ticker. Several tickers can be the same bet (TLT short and TMV long both win when
// Treasuries fall; /CL short and USO short are both short crude; QQQ short can be listed twice) and a dozen
// different tech names are one theme. This groups them by what they actually bet on, and attaches the plain
// facts about each one's levels that matter when deciding: near or past its stop, no stop given, a target already
// hit, through its trigger, down or up against entry.
//
// Facts only. Nothing here ranks, scores or says to buy, sell or hold. The numbers are read from the board's own
// key line (stop, now, entry, targets) and from Randy's setup row; none is invented.
// ============================================================
import type { Board } from "./board.ts";

export const NEAR_STOP_PCT = 2;      // "within 2% of its stop"
export const AGAINST_PCT = 3;        // "down 3% or more against entry"
export const PROFIT_PCT = 5;         // "up 5% or more from entry"

export type Tone = "warn" | "info" | "good";
export interface Flag { k: string; text: string; tone: Tone }
export interface BetMember {
  id: string | null; ticker: string; direction: string; watch: boolean; status: string;
  price: number | null; since_entry: number | null;               // since_entry: + means in the trade's favor
  stop_kind: "stop" | "est" | "invalidation" | "none"; stop: number | null; risk_pct: number | null;
  inverse: boolean;                                                // an inverse ETF: long it = short the thing it tracks
  flags: Flag[];
  same_as: string[];                                               // other rows that are the same bet ("TMV long")
}
export interface BetGroup {
  key: string; label: string; side: "long" | "short"; theme: string;
  rows: number; open: number; watch: number;
  counts: { past_stop: number; near_stop: number; through_trigger: number; no_stop: number; against_entry: number; targets_hit: number };
  members: BetMember[];
}
export interface Bets {
  rows: number; themes: number;
  biggest: { label: string; rows: number } | null;
  repeats: string[];                 // plain sentences: "TLT short and TMV long are the same bet"
  conflicts: string[];               // opposite sides of the same bet: "QQQ long (open) and QQQ short (watching) ..."
  groups: BetGroup[];
  note: string;
}

// ── What each ticker really is ──────────────────────────────
// u = the thing it tracks (two rows with the same u and the same effective side are the same bet);
// theme = the broad group; inv = an inverse fund (long it = short the thing).
interface Under { u: string; theme: string; inv?: boolean }
const THEMES: Record<string, { noun: string; order: number }> = {
  tech:   { noun: "big tech, semis & Nasdaq", order: 1 },
  fin:    { noun: "financials & payments",    order: 2 },
  rates:  { noun: "Treasuries",               order: 3 },
  energy: { noun: "oil & energy",             order: 4 },
  metals: { noun: "precious metals",          order: 5 },
  grains: { noun: "grains",                   order: 6 },
  vol:    { noun: "volatility",               order: 7 },
};
const U: Record<string, Under> = {};
const add = (theme: string, u: string, tickers: string[], inv = false) => { for (const t of tickers) U[t] = { u, theme, inv }; };
add("tech", "nasdaq",  ["QQQ", "/NQ", "NQ", "TQQQ", "NDX", "$NDX"]);
add("tech", "nasdaq",  ["SQQQ", "PSQ"], true);
add("tech", "semis",   ["SOXX", "SMH", "SOXL", "XSD"]);
add("tech", "semis",   ["SOXS"], true);
for (const t of ["MSFT", "AAPL", "AMZN", "META", "GOOGL", "GOOG", "NVDA", "TSLA", "PLTR", "AMD", "MU", "ASML", "AVGO", "INTC", "ORCL", "CRM", "NFLX", "TSM", "QCOM", "ARM", "SMCI", "ADBE", "NOW", "SNOW", "CRWD", "ANET", "MRVL", "LRCX", "AMAT", "KLAC"]) add("tech", t.toLowerCase(), [t]);
add("rates",  "treasuries", ["TLT", "IEF", "/ZB", "ZB", "TMF", "UBT", "EDV"]);
add("rates",  "treasuries", ["TMV", "TBT", "TBF", "TTT"], true);
add("energy", "crude",   ["/CL", "CL", "USO", "UCO", "OIL", "BNO"]);
add("energy", "crude",   ["SCO", "DNO"], true);
add("energy", "natgas",  ["/NG", "UNG", "BOIL"]);
add("energy", "natgas",  ["KOLD"], true);
add("energy", "energy-stocks", ["XLE", "XOM", "CVX", "OIH", "XOP"]);
add("metals", "gold",    ["GLD", "/GC", "GC", "IAU", "GLDM", "PHYS"]);
add("metals", "silver",  ["SLV", "/SI", "SI", "PSLV", "SIVR", "AGQ"]);
add("metals", "gold-miners", ["GDX", "GDXJ", "NUGT", "RING", "GOAU"]);
add("metals", "gold-miners", ["DUST", "JDST"], true);
add("metals", "silver-miners", ["SIL", "SILJ", "SLVP"]);
add("grains", "corn",    ["CORN", "/ZC", "ZC"]);
add("grains", "wheat",   ["WEAT", "/ZW", "ZW"]);
add("grains", "soy",     ["SOYB", "/ZS", "ZS"]);
add("grains", "grains-basket", ["DBA", "MOO"]);
add("vol",    "vix",     ["$VIX", "VIX", "VXX", "UVXY", "VIXY"]);
add("vol",    "vix",     ["SVXY", "SVIX"], true);
add("fin",    "financials", ["XLF", "KRE", "KBE", "FAS"]);
add("fin",    "financials", ["SKF", "FAZ", "SEF"], true);
for (const t of ["V", "MA", "PYPL", "SQ", "JPM", "BAC", "GS", "MS", "WFC", "C"]) add("fin", t.toLowerCase(), [t]);

const under = (ticker: string): Under => U[ticker.toUpperCase()] ?? { u: ticker.toLowerCase(), theme: "other" };

// ── Reading the board's key line ────────────────────────────
// "✕ Est. max stop 41.96  ◆ Now 47.47 (-4.1% since entry)  ▼ Entry 49.50  T1 52.89  … T4 64.58-65.94"
const NUM = "([\\d,]+(?:\\.\\d+)?)";
const n = (s: string | undefined) => (s == null ? null : Number(s.replace(/,/g, "")));
export interface KeyLine {
  price: number | null; since: number | null; entry: number | null; trigger: number | null;
  stop: number | null; stop_kind: "stop" | "est" | "invalidation" | "none";
}
export function parseKeyLine(lines: string[]): KeyLine {
  const l = (lines || []).find((x) => /[✕◆▼]/.test(x)) ?? "";
  const price = l.match(new RegExp(`◆\\s*Now\\s+${NUM}`));
  const since = l.match(/\(([+-]?\d+(?:\.\d+)?)%\s+since entry\)/);
  const lvl = l.match(new RegExp(`▼\\s*(Entry|Trigger)\\s+${NUM}`));
  const stop = l.match(new RegExp(`✕\\s*(Stop|Est\\. max stop|Invalidation)\\s+${NUM}`));
  return {
    price: n(price?.[1]), since: since ? Number(since[1]) : null,
    entry: lvl && lvl[1] === "Entry" ? n(lvl[2]) : null, trigger: lvl && lvl[1] === "Trigger" ? n(lvl[2]) : null,
    stop: n(stop?.[2]),
    stop_kind: !stop ? "none" : stop[1] === "Stop" ? "stop" : stop[1] === "Invalidation" ? "invalidation" : "est",
  };
}

const statusOf = (head: string, watch: boolean): string => {
  const m = String(head).match(/^\*\*.+?\*\*\s*·\s*([^·]+?)\s*·/) || String(head).match(/^\*\*.+?\*\*\s*·\s*([^·]+?)\s*$/);
  return (m ? m[1].trim() : watch ? "watch" : "open");
};
const r1 = (x: number) => Math.round(x * 10) / 10;

// ── Flags: plain facts, worst first ─────────────────────────
function flagsFor(m: Omit<BetMember, "flags" | "same_as">, k: KeyLine, hits: number): Flag[] {
  const out: Flag[] = [];
  const long = m.direction === "long";
  const price = k.price, stop = k.stop;
  if (price != null && stop != null) {
    const past = long ? price <= stop : price >= stop;
    if (past) out.push({ k: "past_stop", text: k.stop_kind === "est" ? "past its estimated stop" : k.stop_kind === "invalidation" ? "past its invalidation level" : "past its stop", tone: "warn" });
    else if (m.risk_pct != null && m.risk_pct <= NEAR_STOP_PCT) out.push({ k: "near_stop", text: `${m.risk_pct.toFixed(1)}% from its ${k.stop_kind === "est" ? "estimated " : ""}stop`, tone: "warn" });
  }
  if (m.watch && price != null && k.trigger != null && (long ? price >= k.trigger : price <= k.trigger)) out.push({ k: "through_trigger", text: "price is through its trigger (still on watch)", tone: "warn" });
  if (!m.watch && m.since_entry != null && m.since_entry <= -AGAINST_PCT) out.push({ k: "against_entry", text: `down ${Math.abs(m.since_entry).toFixed(1)}% vs entry`, tone: "warn" });
  if (k.stop_kind === "none") out.push({ k: "no_stop", text: m.watch && k.trigger == null ? "no stop and no trigger price" : "no stop given", tone: "info" });
  else if (k.stop_kind === "est") out.push({ k: "est_stop", text: "stop is an estimate", tone: "info" });
  else if (m.watch && k.trigger == null && k.stop_kind !== "none") out.push({ k: "no_trigger", text: "no trigger price", tone: "info" });
  if (hits > 0) out.push({ k: "targets_hit", text: hits === 1 ? "1 target hit" : `${hits} targets hit`, tone: "good" });
  if (!m.watch && m.since_entry != null && m.since_entry >= PROFIT_PCT) out.push({ k: "in_profit", text: `up ${m.since_entry.toFixed(1)}% vs entry`, tone: "good" });
  return out;
}

// ── Build ───────────────────────────────────────────────────
interface SetupLite { id: string; targets?: Array<{ hit?: string | null }> }

export function buildBets(board: Board, setups: SetupLite[] = []): Bets | null {
  const byId = new Map(setups.map((s) => [s.id, s]));
  const members: Array<BetMember & { theme: string; u: string; side: "long" | "short" }> = [];
  for (const g of board.groups || []) for (const it of g.items || []) {
    const k = parseKeyLine(it.lines);
    const ud = under(it.ticker);
    const inv = !!ud.inv;
    const side: "long" | "short" = (it.direction === "long") !== inv ? "long" : "short";   // the bet on what it tracks
    const hits = (byId.get(it.id ?? "")?.targets || []).filter((t) => t && t.hit).length;
    const risk = k.price != null && k.stop != null && k.price > 0 ? r1(Math.abs(k.price - k.stop) / k.price * 100) : null;
    const base = {
      id: it.id, ticker: it.ticker, direction: it.direction, watch: it.watch, status: statusOf(it.head, it.watch),
      price: k.price, since_entry: k.since, stop_kind: k.stop_kind, stop: k.stop, risk_pct: risk, inverse: inv,
    };
    members.push({ ...base, flags: flagsFor(base, k, hits), same_as: [], theme: ud.theme, u: ud.u, side });
  }
  if (!members.length) return null;

  // Same bet: same thing tracked, same effective side.
  const keyOf = (m: { u: string; side: string }) => `${m.u}|${m.side}`;
  const byBet = new Map<string, typeof members>();
  for (const m of members) { const a = byBet.get(keyOf(m)) ?? []; a.push(m); byBet.set(keyOf(m), a); }
  const label = (m: BetMember) => `${m.ticker} ${m.direction}`;
  const repeats: string[] = [];
  for (const list of byBet.values()) {
    if (list.length < 2) continue;
    for (const m of list) m.same_as = list.filter((x) => x !== m).map(label);
    const labels = [...new Set(list.map(label))];
    if (labels.length === 1) repeats.push(`${labels[0]} is listed ${list.length === 2 ? "twice" : `${list.length} times`} (${list.map((m) => (m.watch ? "watching" : "open")).join(" and ")})`);
    else {
      const names = labels.length === 2 ? `${labels[0]} and ${labels[1]}` : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
      const twice = labels.filter((l) => list.filter((m) => label(m) === l).length > 1);
      repeats.push(`${names} ${labels.length === 2 ? "are" : "are all"} the same bet${twice.length ? ` (${twice.join(", ")} listed more than once)` : ""}`);
    }
  }

  // Opposite sides of the same thing (QQQ long open while QQQ short is still on watch, or QQQ long next to SQQQ long).
  const byUnder = new Map<string, typeof members>();
  for (const m of members) { const a = byUnder.get(m.u) ?? []; a.push(m); byUnder.set(m.u, a); }
  const conflicts: string[] = [];
  const say = (l: typeof members) => [...new Set(l.map((m) => `${label(m)} (${m.watch ? "watching" : "open"})`))].join(" + ");
  for (const list of byUnder.values()) {
    const lo = list.filter((m) => m.side === "long"), sh = list.filter((m) => m.side === "short");
    if (lo.length && sh.length) conflicts.push(`${say(lo)} and ${say(sh)} are opposite sides of the same bet`);
  }

  // Groups: theme + effective side. "other" has no real theme, so those stay in one catch-all per side.
  const groups = new Map<string, BetGroup>();
  for (const m of members) {
    const key = `${m.theme}-${m.side}`;
    let g = groups.get(key);
    if (!g) {
      const t = THEMES[m.theme];
      g = {
        key, theme: m.theme, side: m.side,
        label: t ? `${m.side === "short" ? "Short" : "Long"} ${t.noun}` : `Other ${m.side === "short" ? "shorts" : "longs"} (separate bets)`,
        rows: 0, open: 0, watch: 0,
        counts: { past_stop: 0, near_stop: 0, through_trigger: 0, no_stop: 0, against_entry: 0, targets_hit: 0 },
        members: [],
      };
      groups.set(key, g);
    }
    g.rows++; if (m.watch) g.watch++; else g.open++;
    for (const f of m.flags) if (f.k in g.counts) (g.counts as Record<string, number>)[f.k]++;
    const { theme: _t, u: _u, side: _s, ...pub } = m;
    g.members.push(pub);
  }
  const list = [...groups.values()].sort((a, b) =>
    b.rows - a.rows || (THEMES[a.theme]?.order ?? 99) - (THEMES[b.theme]?.order ?? 99) || a.side.localeCompare(b.side));
  // Inside a group: open before watching, then worst flags first (past its stop outranks near it), then A to Z.
  const SEV: Record<string, number> = { past_stop: 100, near_stop: 10, through_trigger: 10, against_entry: 3 };
  const weight = (m: BetMember) => m.flags.reduce((n, f) => n + (SEV[f.k] ?? (f.tone === "warn" ? 1 : 0)), 0);
  for (const g of list) g.members.sort((a, b) => Number(a.watch) - Number(b.watch) || weight(b) - weight(a) || a.ticker.localeCompare(b.ticker));
  const real = list.filter((g) => g.theme !== "other");
  const biggest = real.length ? { label: real[0].label, rows: real[0].rows } : null;
  return {
    rows: members.length, themes: real.length, biggest, repeats, conflicts, groups: list,
    note: "Grouped by what each setup bets on, not by ticker. Flags are facts about Randy's levels (thresholds: near stop = within " + NEAR_STOP_PCT + "%, against or in profit = " + AGAINST_PCT + "% / " + PROFIT_PCT + "% from entry). They are not signals: nothing here says to buy, sell or hold.",
  };
}
