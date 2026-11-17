// ============================================================
// STUDIO STRONG OPEN BRAIN — RSOTC Act v1.3
// ============================================================
// Powers reelcall.app/act.html: takes one of Randy Phinney's RSOTC setups to the three Schwab orders Dave places himself
// (entry, stop, target), sized only from the risk number Dave sets, then tracks the trade from "planned" to "closed".
//
//   POST ?key=BRIEF_PAGE_KEY   body: { action, ... }       (verify_jwt false, CORS *)
//
//   board        → settings, budget, price note, and Randy's open setups with his levels, today's price, what is missing,
//                  whether this account can place it, and any plan Dave already has on it. Grouped, not ranked.
//   settings     → { set? }  read, or save, Dave's own numbers: account size, funded, risk per trade, margin, futures.
//   calc         → { setup_id | ticker+direction, entry, stop, target?, targets?, shares?, entry_type? }
//                  shares from his risk setting, loss at the stop, gain at the target, and the Schwab ticket. Saves nothing.
//   plan_save    → { setup_id, entry, stop, target, shares?, entry_type?, note?, id? }  save (or edit a not-yet-placed) plan.
//   plans        → { include_skipped? }  his plans with live price, P/L, and what Randy changed since the plan was made.
//   plan_state   → { id, to, fill_price?, fill_shares?, exit_price?, exit_reason?, note? }
//                  planned → placed → filled → closed, or skipped; each step has an undo. Filling writes rsotc_my_trades
//                  (so the brief's "★ You" lines and stop warnings work); closing and undoing keep it in step.
//   estimates    → { setup_id, entry }  stop estimates for a setup where Randy gave no stop (see below). Saves nothing.
//   plan_note    → { id, note }
//   plan_delete  → { id }  only a plan that is still "planned" or "skipped".
//   vehicle      → { setup_id, vehicle, anchor? }  (v1.3) Randy's setup taken through an ETF: the same setup view, but for the ETF, with
//                  his levels converted from today's prices. Saves nothing. calc, estimates and plan_save accept the same `vehicle`
//                  (and `anchor`: the two prices the conversion used, sent back so what was shown is what gets saved).
//   etf_ladders  → { ids? }  (v1.3) the RSOTC chart and the levels (stop, entry, each target) of every ETF stand-in of Randy's open setups,
//                  converted from today's prices and drawn by the same SQL as the alerts. Read-only.
//
// This function never places an order, never moves money, and never picks a setup, a stop, a target or a risk amount.
// Every price is Randy's or Dave's; the share count is one formula from Dave's own setting (size.ts).
// Where Randy gave no stop it also offers ESTIMATES (v1.1, Nov 12 2026, at Dave's request): a percent from Randy's entry that
// Dave sets himself (My account, starts at 2) and Randy's own 2:1 rule per firm target. They are labelled as estimates, shown as
// chips the person taps, and never filled in or saved unless the person uses them. A saved plan records where its stop came
// from (stop_basis), worked out here from the numbers.
// v1.3 (Nov 17 2026, at Dave's request): ETF stand-ins. A short, or a futures/index idea this app can't place, can be taken as an ETF
// you BUY (SQQQ for a QQQ short, SCO for a /CL short, a single-stock bear ETF for a stock short). Randy's levels are converted to the
// ETF from today's prices (vehicles.ts) and are, like the stop estimates, labelled estimates and only ever tap-to-use. The plan is then
// an ordinary long in the ETF; it stays tied to Randy's setup (setup_id) so changes he makes still show, and the trade it writes to
// rsotc_my_trades has setup_id null, because the brief's "★ You" lines compare it with Randy's levels on the underlying.
//
// Secrets (project-wide, all already set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIEF_PAGE_KEY
// Tables: act_settings, act_plans (new), rsotc_setups (Randy's), rsotc_my_trades (Dave's, read by the brief's board).
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import {
  basisWords, canPlace, changesSince, DEFAULT_STOP_EST_PCT, entryTypeFor, entryWords, estimateStops, instrumentOf, MAX_STOP_EST_PCT, normalizeTargets, pctFrom, pnl,
  riskBudget, sizeTrade, snapshotOf, stopBasisFor, ticketFor,
  type Dir, type EntryType, type Settings, type Sized, type Snapshot,
} from "./size.ts";
import { pricesFor, priceNote } from "./quotes.ts";
import { briefOf, cautionsFor, convertedNote, etfFeedRow, findVehicle, fmtLev, levelsOf, vehicleRow, vehiclesFor, type Vehicle } from "./vehicles.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const PAGE_KEY = env("BRIEF_PAGE_KEY");
const OWNER = "dave";
const TZ = "America/Chicago";
const MAX_SETUPS = 80;
const ACTIVE = ["planned", "placed", "filled"];
const CLOSED_SETUP = "(stopped,closed,expired)";
const CAUTIONS = [
  "A stop order isn't guaranteed to fill at the stop price. In a fast market or a gap it can fill worse.",
  "On Schwab's review screen, read the estimated amount and every alert before you place the order.",
];

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class HttpError extends Error {
  status: number; extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (message: string, extra: Record<string, unknown> = {}) => new HttpError(400, message, extra);

// ── small helpers ────────────────────────────────────────────
const todayCentral = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);   // YYYY-MM-DD
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toNum = (x: unknown): number | null => {
  if (x == null) return null;
  if (typeof x === "string" && x.trim() === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number, d = 4) => { const f = 10 ** d; return Math.round(n * f) / f; };
// A price the person typed: a positive number under ten million, kept to 4 decimals.
const priceIn = (x: unknown, what: string): number => {
  const n = toNum(x);
  if (n == null || n <= 0 || n > 1e7) throw bad(`Enter the ${what} price.`);
  return round(n);
};
// Schwab takes prices in whole cents from $1 up and to four decimals under $1, so the levels for the three orders are rounded to that.
const tick = (n: number) => (n >= 1 ? round(n, 2) : round(n, 4));
const levelIn = (x: unknown, what: string): number => {
  const n = tick(priceIn(x, what));
  if (n <= 0) throw bad(`Enter the ${what} price.`);
  return n;
};
const cut = (s: unknown, n: number): string | null => {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};
const noteIn = (x: unknown): string | null => {
  if (x == null) return null;
  if (typeof x !== "string") throw bad("The note has to be text.");
  const t = x.trim();
  if (t.length > 500) throw bad("Keep the note to 500 characters.");
  return t || null;
};
const idIn = (x: unknown, what = "id"): string => {
  if (typeof x !== "string" || !UUID.test(x)) throw bad(`Missing or invalid ${what}.`);
  return x.toLowerCase();
};
const tickerIn = (x: unknown): string => {
  const t = typeof x === "string" ? x.trim().toUpperCase() : "";
  if (!/^[A-Z0-9$/^][A-Z0-9.\-]{0,11}$/.test(t)) throw bad("Missing or invalid ticker.");
  return t;
};
const dirIn = (x: unknown): Dir => {
  if (x === "long" || x === "short") return x;
  throw bad("Direction has to be long or short.");
};

async function getPrices(tickers: string[]): Promise<Record<string, number>> {
  const want = [...new Set(tickers.filter(Boolean))];
  if (!want.length) return {};
  try { return await pricesFor(want); } catch (e) { console.error("prices", (e as Error).message); return {}; }
}

// ── Dave's own numbers ───────────────────────────────────────
const DEFAULTS: Settings = { account_size: null, funded: false, risk_mode: "dollars", risk_value: null, margin_ok: false, futures_ok: false, stop_est_pct: DEFAULT_STOP_EST_PCT };
const estPctOf = (x: unknown): number => { const n = toNum(x); return n != null && n > 0 && n <= MAX_STOP_EST_PCT ? n : DEFAULT_STOP_EST_PCT; };
const settingsOf = (row: Record<string, unknown> | null): Settings => !row ? { ...DEFAULTS } : {
  account_size: toNum(row.account_size), funded: row.funded === true,
  risk_mode: row.risk_mode === "percent" ? "percent" : "dollars", risk_value: toNum(row.risk_value),
  margin_ok: row.margin_ok === true, futures_ok: row.futures_ok === true, stop_est_pct: estPctOf(row.stop_est_pct),
};

async function loadSettings(): Promise<{ settings: Settings; saved: boolean; error: string | null }> {
  const r = await db.from("act_settings").select("*").eq("owner", OWNER).maybeSingle();
  if (r.error) return { settings: { ...DEFAULTS }, saved: false, error: r.error.message };
  return { settings: settingsOf(r.data as Record<string, unknown> | null), saved: !!r.data, error: null };
}
async function mustSettings(): Promise<Settings> {
  const s = await loadSettings();
  if (s.error) throw new HttpError(500, "Couldn't read your account numbers, so nothing was sized. Try again.");
  return s.settings;
}

function parseSettings(set: Record<string, unknown>, cur: Settings): Settings {
  const out: Settings = { ...cur };
  if ("account_size" in set) {
    if (set.account_size === null || set.account_size === "") out.account_size = null;
    else {
      const n = toNum(set.account_size);
      if (n == null || n < 0 || n > 1e9) throw bad("Account size has to be a number from 0 up to 1,000,000,000.");
      out.account_size = round(n, 2);
    }
  }
  if ("risk_mode" in set) {
    if (set.risk_mode !== "dollars" && set.risk_mode !== "percent") throw bad("Risk mode has to be dollars or percent.");
    out.risk_mode = set.risk_mode;
  }
  if ("risk_value" in set) {
    if (set.risk_value === null || set.risk_value === "") out.risk_value = null;
    else {
      const n = toNum(set.risk_value);
      if (n == null || n <= 0) throw bad("Risk per trade has to be more than 0.");
      out.risk_value = round(n, 2);
    }
  }
  if (out.risk_value != null) {
    if (out.risk_mode === "percent" && out.risk_value > 100) throw bad("A percent can't be more than 100.");
    if (out.risk_mode === "dollars" && out.risk_value > 1e9) throw bad("Risk per trade is too large.");
  }
  if ("stop_est_pct" in set) {
    if (set.stop_est_pct === null || set.stop_est_pct === "") out.stop_est_pct = DEFAULT_STOP_EST_PCT;
    else {
      const n = typeof set.stop_est_pct === "number" || typeof set.stop_est_pct === "string" ? toNum(set.stop_est_pct) : null;
      if (n == null || n <= 0 || n > MAX_STOP_EST_PCT) throw bad(`The stop estimate has to be a percent above 0 and up to ${MAX_STOP_EST_PCT}.`);
      out.stop_est_pct = round(n, 2);
    }
  }
  for (const k of ["funded", "margin_ok", "futures_ok"] as const) {
    if (k in set) {
      if (typeof set[k] !== "boolean") throw bad(`${k} has to be true or false.`);
      out[k] = set[k] as boolean;
    }
  }
  return out;
}

async function handleSettings(b: Record<string, unknown>) {
  const cur = await loadSettings();
  if (cur.error) throw new HttpError(500, "Couldn't read your account numbers.");
  let settings = cur.settings;
  if (b.set !== undefined) {
    if (!b.set || typeof b.set !== "object" || Array.isArray(b.set)) throw bad("Nothing to save.");
    settings = parseSettings(b.set as Record<string, unknown>, cur.settings);
    const r = await db.from("act_settings").upsert({ owner: OWNER, ...settings, updated_at: new Date().toISOString() }, { onConflict: "owner" }).select("*").single();
    if (r.error) throw new HttpError(500, "Couldn't save your account numbers.");
    settings = settingsOf(r.data as Record<string, unknown>);
  }
  return json({ ok: true, settings, risk_budget: riskBudget(settings), saved: cur.saved || b.set !== undefined });
}

// ── Randy's setups ───────────────────────────────────────────
// deno-lint-ignore no-explicit-any
type Row = any;
const setupNow = (row: Row, dir: Dir) => ({
  entry_price: toNum(row.entry_price), stop: toNum(row.stop), status: String(row.status), targets: normalizeTargets(row.targets, dir),
  updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
});

async function loadOpenSetups(): Promise<Row[]> {
  const r = await db.from("rsotc_setups").select("*").not("status", "in", CLOSED_SETUP).limit(MAX_SETUPS);
  if (r.error) throw new HttpError(500, "Couldn't load Randy's setups.");
  return (r.data || []) as Row[];
}
async function loadSetupsById(ids: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  if (!ids.length) return out;
  const r = await db.from("rsotc_setups").select("*").in("id", ids);
  if (r.error) throw new HttpError(500, "Couldn't load Randy's setups.");
  for (const row of (r.data || []) as Row[]) out.set(String(row.id), row);
  return out;
}

function setupView(row: Row, settings: Settings, prices: Record<string, number>, plan: Row | null) {
  const dir: Dir = row.direction === "short" ? "short" : "long";
  const ticker = String(row.ticker);
  const targets = normalizeTargets(row.targets, dir);
  const entry = toNum(row.entry_price), stop = toNum(row.stop), invalidation = toNum(row.invalidation);
  const price = prices[ticker] ?? null;
  const placeable = canPlace(ticker, dir, settings);
  const missing: string[] = [];
  if (entry == null) missing.push("entry");
  if (stop == null) missing.push("stop");
  if (!targets.some((t) => t.price != null && !t.hit)) missing.push("target");
  const hist = Array.isArray(row.history) ? row.history : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  // Where Randy gave no stop: the two estimates, worked out from his entry. A setup that lacks only the stop, and has an entry
  // to work from, goes in its own group so it can be considered (the estimate is still only used if the person taps it).
  const est = stop == null ? estimateStops(dir, entry, targets, settings.stop_est_pct) : null;
  const onlyStop = missing.length === 1 && missing[0] === "stop" && est != null && est.pct != null;
  // ETF stand-ins (v1.3): offered for every short and for the futures/index ideas. Where the idea can't be placed as Randy has it,
  // the ETF is the way to place it, so it gets its own group instead of "can't place".
  const vehicles = vehiclesFor(ticker, dir).map(briefOf);
  const group = plan ? "plan" : !placeable.ok ? (vehicles.length ? "etf" : "blocked") : missing.length === 0 ? "ready" : onlyStop ? "estimate" : "needs";
  return {
    id: String(row.id), ticker, direction: dir, status: String(row.status), tf: row.chart_timeframe ?? null, instrument: instrumentOf(ticker),
    price, vehicles,
    randy: {
      entry, stop, invalidation, targets,
      entry_note: cut(row.entry_note, 600), stop_note: cut(row.stop_note, 400), notes: cut(row.notes, 700),
      link: typeof row.post_link === "string" && /^https?:\/\//.test(row.post_link) ? row.post_link : null,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
      last_event: cut(last && last.event, 300),
    },
    pct: { to_entry: pctFrom(price, entry), to_stop: pctFrom(price, stop) },
    missing, placeable, group, est,
    plan: plan ? { id: String(plan.id), state: String(plan.state), ticker: typeof plan.ticker === "string" ? plan.ticker : null, etf: vehicleOf(plan)?.t ?? null } : null,
  };
}

async function handleBoard() {
  const [st, setups, activePlans] = await Promise.all([
    loadSettings(),
    loadOpenSetups(),
    db.from("act_plans").select("id,setup_id,state,ticker,vehicle").eq("owner", OWNER).in("state", ACTIVE),
  ]);
  if (activePlans.error) throw new HttpError(500, "Couldn't load your plans.");
  const planBySetup = new Map<string, Row>();
  for (const p of (activePlans.data || []) as Row[]) if (p.setup_id) planBySetup.set(String(p.setup_id), p);
  const prices = await getPrices(setups.map((s) => String(s.ticker)));
  const got = Object.keys(prices).length > 0;
  const views = setups.map((s) => setupView(s, st.settings, prices, planBySetup.get(String(s.id)) ?? null))
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.direction.localeCompare(b.direction));
  const counts = { plan: 0, ready: 0, estimate: 0, etf: 0, needs: 0, blocked: 0 };
  for (const v of views) counts[v.group as keyof typeof counts]++;
  return json({
    ok: true, today: todayCentral(),
    settings: st.settings, settings_saved: st.saved, settings_error: st.error,
    mode: st.settings.funded ? "live" : "planning",
    risk_budget: riskBudget(st.settings),
    prices_ok: got, price_note: priceNote(new Date(), got),
    counts, setups: views,
  });
}

// ── ETF stand-ins (v1.3) ─────────────────────────────────────
// What a saved plan records about the ETF it is in: the underlying, which way Randy has it, the fund's multiple, and the two prices
// Randy's levels were converted with. Null for a plan on a ticker of Randy's own.
interface PlanVehicle { t: string; underlying: string; dir: Dir; lev: number; label: string; p_u: number | null; p_v: number | null; at: string | null }
function vehicleOf(p: Row | null | undefined): PlanVehicle | null {
  const o = p && typeof p === "object" ? p.vehicle : null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.t !== "string" || !o.t || typeof o.underlying !== "string" || !o.underlying) return null;
  return {
    t: o.t, underlying: o.underlying, dir: o.dir === "short" ? "short" : "long", lev: toNum(o.lev) ?? 0, label: typeof o.label === "string" ? o.label : o.t,
    p_u: toNum(o.p_u), p_v: toNum(o.p_v), at: typeof o.at === "string" ? o.at : null,
  };
}

interface Via { v: Vehicle; real: Row; realDir: Dir; pU: number | null; pV: number | null }
const near = (a: number, b: number) => b > 0 && Math.abs(a / b - 1) <= 0.25;

// The ETF a request wants to stand in for one of Randy's setups, with the two prices that convert his levels. Today's prices, unless the
// page sends back the pair it was shown (anchor) and they are close to today's: then the numbers the person tapped are the numbers saved.
async function viaFor(real: Row, vehicle: unknown, anchor: unknown): Promise<Via> {
  const realDir: Dir = real.direction === "short" ? "short" : "long";
  const under = String(real.ticker);
  const v = findVehicle(under, realDir, vehicle);
  if (!v) throw bad(`${typeof vehicle === "string" && vehicle.trim() ? vehicle.trim().slice(0, 12).toUpperCase() : "That"} isn't one of the ETFs offered for Randy's ${under} ${realDir}.`);
  const prices = await getPrices([under, v.t]);
  let pU = prices[under] ?? null, pV = prices[v.t] ?? null;
  const a = anchor && typeof anchor === "object" && !Array.isArray(anchor) ? anchor as Record<string, unknown> : null;
  if (a) {
    const au = toNum(a.p_u), av = toNum(a.p_v);
    if (au != null && av != null && au > 0 && av > 0 && au < 1e7 && av < 1e7 && (pU == null || near(au, pU)) && (pV == null || near(av, pV))) { pU = round(au); pV = round(av); }
  }
  return { v, real, realDir, pU, pV };
}
const wantsVehicle = (x: unknown) => x != null && x !== "";

// The view page needs: what the ETF is, what its levels were converted from, and what to know before using it.
function viaInfo(via: Via) {
  const under = String(via.real.ticker);
  return {
    t: via.v.t, name: via.v.name, lev: via.v.lev, lev_text: fmtLev(via.v.lev), kind: via.v.kind, note: via.v.note,
    underlying: under, underlying_dir: via.realDir, underlying_price: via.pU, price: via.pV,
    converted: via.v.kind === "convert" && via.pU != null && via.pV != null,
    anchor: via.pU != null && via.pV != null ? { p_u: via.pU, p_v: via.pV } : null,
    words: convertedNote(via.v, under, via.pU, via.pV), cautions: cautionsFor(via.v, under),
    randy: { entry: toNum(via.real.entry_price), stop: toNum(via.real.stop), invalidation: toNum(via.real.invalidation), targets: normalizeTargets(via.real.targets, via.realDir) },
  };
}

async function handleVehicle(b: Record<string, unknown>) {
  const id = idIn(b.setup_id, "setup");
  const m = await loadSetupsById([id]);
  const real = m.get(id);
  if (!real) throw new HttpError(404, "That setup isn't on Randy's list anymore.");
  if (["stopped", "closed", "expired"].includes(String(real.status))) throw new HttpError(409, `Randy has this one as ${real.status}.`);
  const settings = await mustSettings();
  const via = await viaFor(real, b.vehicle, b.anchor);
  const prices: Record<string, number> = {};
  if (via.pV != null) prices[via.v.t] = via.pV;
  const view = setupView(vehicleRow(real, via.v, via.pU, via.pV), settings, prices, null);
  const info = viaInfo(via);
  return json({ ok: true, setup: { ...view, via: info }, via: info, risk_budget: riskBudget(settings), price_note: priceNote(new Date(), via.pU != null || via.pV != null) });
}

// The RSOTC chart for every ETF stand-in of Randy's open setups (v1.3, Dave: "estimate for the ETF the same stop, entry, T1, T2, T3 below the
// RSOTC chart"). Randy's levels are converted to each fund (vehicleRow) and the chart text is drawn by the same SQL the alerts use
// (rsotc_act_etf_ladders -> rsotc_ladder), so it is drawn exactly as the RSOTC chart is. The levels come back as numbers too, so the page can
// list stop, entry and each target. A "manual" fund (VIX funds, an ASML basket) or a fund with no price right now comes back unconverted.
// Read-only; nothing is saved.
async function handleEtfLadders(b: Record<string, unknown>) {
  let want: string[] | null = null;
  if (b.ids != null) {
    if (!Array.isArray(b.ids) || b.ids.length > MAX_SETUPS) throw bad("ids has to be a list of setup ids (no more than " + MAX_SETUPS + ").");
    want = (b.ids as unknown[]).map((x) => { if (typeof x !== "string" || !UUID.test(x)) throw bad("Missing or invalid setup id."); return x.toLowerCase(); });
  }
  const rows = want ? [...(await loadSetupsById(want)).values()] : await loadOpenSetups();
  const open = rows.filter((r) => !["stopped", "closed", "expired"].includes(String(r.status)));
  const pairs: Array<{ real: Row; v: Vehicle }> = [];
  for (const real of open) {
    const dir: Dir = real.direction === "short" ? "short" : "long";
    for (const v of vehiclesFor(String(real.ticker), dir)) pairs.push({ real, v });
  }
  const prices = await getPrices(pairs.flatMap((p) => [String(p.real.ticker), p.v.t]));
  const feed: Array<{ k: string; row: unknown; px: number }> = [];
  const meta = pairs.map(({ real, v }) => {
    const pU = prices[String(real.ticker)] ?? null, pV = prices[v.t] ?? null;
    const can = v.kind === "convert" && pU != null && pV != null;
    const key = `${real.id}|${v.t}`;
    const row = can ? vehicleRow(real, v, pU, pV) : null;
    if (row && pV != null) feed.push({ k: key, row: etfFeedRow(row), px: pV });
    return { real, v, key, pU, pV, can, row };
  });
  let drawn: Record<string, { ladder?: string; stop?: { v?: number; kind?: string } | null }> = {};
  if (feed.length) {
    const r = await db.rpc("rsotc_act_etf_ladders", { items: feed });
    if (r.error) console.error("etf ladders", r.error.message); else drawn = (r.data || {}) as typeof drawn;
  }
  const items: Record<string, unknown[]> = {};
  for (const m of meta) {
    const d = drawn[m.key];
    const status = String(m.real.status ?? "");
    const stopFrom = (): { v: number; kind: string } | null => {
      if (d && d.stop && toNum(d.stop.v) != null) return { v: toNum(d.stop.v) as number, kind: String(d.stop.kind ?? "stop") };
      if (!m.row) return null;
      const s = toNum(m.row.stop), i = toNum(m.row.invalidation);
      return s != null ? { v: s, kind: "stop" } : i != null ? { v: i, kind: "inval" } : null;
    };
    // A stop that works out to zero or below (a 3x fund that would have to lose everything) is no stop at all: no chart drawn around it either.
    let stop = m.can ? stopFrom() : null;
    let ladder = d && typeof d.ladder === "string" ? d.ladder : null;
    if (stop && stop.v <= 0) { stop = null; ladder = null; }
    (items[String(m.real.id)] ||= []).push({
      t: m.v.t, name: m.v.name, lev: m.v.lev, lev_text: fmtLev(m.v.lev), kind: m.v.kind, converted: m.can,
      price: m.pV, underlying: String(m.real.ticker), underlying_price: m.pU,
      ladder, stop,
      entry: m.row ? toNum(m.row.entry_price) : null, entry_label: status === "watch" ? "Trigger" : "Entry",
      targets: m.row ? levelsOf(m.row.targets, status) : [],
    });
  }
  return json({ ok: true, items, price_note: priceNote(new Date(), Object.keys(prices).length > 0) });
}

// ── the numbers for one idea ─────────────────────────────────
interface Calc {
  ok: boolean; ticker: string; direction: Dir; instrument: string;
  price: number | null; price_note: string; entry_type: EntryType | null; entry_words: string | null;
  placeable: ReturnType<typeof canPlace>; sized: Sized;
  by_target: Array<{ price: number; label: string; hit: string | null; rr: number | null; gain: number | null; gain_pct: number | null; ok: boolean; error: string | null }>;
  warnings: string[]; ticket: ReturnType<typeof ticketFor> | null; cautions: string[];
}

const ENTRY_TYPES = ["limit", "stop", "market"];
function entryTypeIn(x: unknown): EntryType | "auto" {
  if (x == null || x === "" || x === "auto") return "auto";
  if (typeof x === "string" && ENTRY_TYPES.includes(x)) return x as EntryType;
  throw bad("Entry type has to be limit, stop or market.");
}

interface CalcIn { ticker: string; dir: Dir; entry: number; stop: number; target: number | null; targets: Array<{ price: number; label: string; hit: string | null }>; shares: number | null; entry_type: EntryType | "auto"; settings: Settings }

async function runCalc(i: CalcIn, extraCautions: string[] = []): Promise<Calc> {
  const prices = await getPrices([i.ticker]);
  const price = prices[i.ticker] ?? null;
  const placeable = canPlace(i.ticker, i.dir, i.settings);
  const type: EntryType = i.entry_type === "auto" ? entryTypeFor(i.dir, i.entry, price) : i.entry_type;
  // Without a chosen target the share count is still worked out (it doesn't depend on the target): a stand-in target on the
  // profit side is used for that, and everything that depends on a target is cleared.
  const placeholder = i.dir === "long" ? i.entry * 1.5 : i.entry * 0.5;
  const sized = sizeTrade({ dir: i.dir, entry: i.entry, stop: i.stop, target: i.target ?? placeholder, settings: i.settings, ticker: i.ticker, shares: i.shares });
  if (i.target == null) { sized.rr = null; sized.reward_per_share = null; sized.gain_at_target = null; sized.gain_pct = null; }

  const warnings = [...sized.warnings];
  if (price != null && sized.ok) {
    if (i.dir === "long" && price <= i.stop) warnings.push(`The price now (${price}) is already at or below your stop (${i.stop}). A stop order placed now would trigger at once.`);
    if (i.dir === "short" && price >= i.stop) warnings.push(`The price now (${price}) is already at or above your stop (${i.stop}). A stop order placed now would trigger at once.`);
    if (i.target != null) {
      if (i.dir === "long" && price >= i.target) warnings.push(`The price now (${price}) is already at or above your target (${i.target}).`);
      if (i.dir === "short" && price <= i.target) warnings.push(`The price now (${price}) is already at or below your target (${i.target}).`);
    }
    if (type === "limit" && ((i.dir === "long" && price <= i.entry * 0.999) || (i.dir === "short" && price >= i.entry * 1.001))) {
      warnings.push(`A ${i.dir === "long" ? "buy limit" : "sell-short limit"} at ${i.entry} with the price at ${price} would fill right away, at the price then, not at ${i.entry}.`);
    }
  }

  const by_target = i.targets.map((t) => {
    const r = sizeTrade({ dir: i.dir, entry: i.entry, stop: i.stop, target: t.price, settings: i.settings, ticker: i.ticker, shares: sized.shares });
    return { price: t.price, label: t.label, hit: t.hit, rr: r.rr, gain: r.gain_at_target, gain_pct: r.gain_pct, ok: r.ok, error: r.ok ? null : (r.errors[0] ?? null) };
  });

  let ticket: Calc["ticket"] = null;
  if (sized.ok && sized.shares != null && i.target != null && placeable.ok) {
    ticket = ticketFor({ ticker: i.ticker, dir: i.dir, qty: sized.shares, entry: i.entry, entry_type: type, stop: i.stop, target: i.target });
  }
  return {
    ok: sized.ok && sized.shares != null && i.target != null && placeable.ok,
    ticker: i.ticker, direction: i.dir, instrument: instrumentOf(i.ticker),
    price, price_note: priceNote(new Date(), price != null), entry_type: sized.ok ? type : null, entry_words: sized.ok ? entryWords(i.dir, type, i.entry) : null,
    placeable, sized, by_target, warnings, ticket, cautions: [...extraCautions, ...CAUTIONS],
  };
}

// Reads the numbers out of a request. If it names one of Randy's setups, ticker and direction come from that row.
// With a `vehicle`, `setup` is Randy's row turned into the ETF trade (ETF ticker, long, his levels converted) and `real` is his row as it
// is. Without one they are the same row.
async function calcInputs(b: Record<string, unknown>, needTarget: boolean): Promise<{ input: CalcIn; setup: Row | null; real: Row | null; via: Via | null }> {
  let setup: Row | null = null, real: Row | null = null, via: Via | null = null;
  let ticker: string, dir: Dir;
  if (b.setup_id != null) {
    const id = idIn(b.setup_id, "setup");
    const m = await loadSetupsById([id]);
    real = m.get(id) ?? null;
    if (!real) throw new HttpError(404, "That setup isn't on Randy's list anymore.");
    if (wantsVehicle(b.vehicle)) { via = await viaFor(real, b.vehicle, b.anchor); setup = vehicleRow(real, via.v, via.pU, via.pV); } else setup = real;
    ticker = String(setup.ticker); dir = setup.direction === "short" ? "short" : "long";
  } else {
    if (wantsVehicle(b.vehicle)) throw bad("An ETF stand-in has to be for one of Randy's setups.");
    ticker = tickerIn(b.ticker); dir = dirIn(b.direction);
  }
  const settings = await mustSettings();
  const entry = levelIn(b.entry, "entry");
  const stop = levelIn(b.stop, "stop");
  const target = needTarget || (b.target != null && b.target !== "") ? levelIn(b.target, "target") : null;
  let shares: number | null = null;
  if (b.shares != null && b.shares !== "") {
    const n = toNum(b.shares);
    if (n == null || !Number.isInteger(n) || n < 1 || n > 1e7) throw bad("Shares has to be a whole number, 1 or more.");
    shares = n;
  }
  const targets = Array.isArray(b.targets)
    ? (b.targets as unknown[]).slice(0, 12).map((t, k) => {
        const o = (t && typeof t === "object" ? t : { price: t }) as Record<string, unknown>;
        return { price: levelIn(o.price, "target"), label: cut(o.label, 20) ?? `T${k + 1}`, hit: o.hit ? String(o.hit) : null };
      })
    : [];
  return { input: { ticker, dir, entry, stop, target, targets, shares, entry_type: entryTypeIn(b.entry_type), settings }, setup, real, via };
}

// Where a stop number came from, for a request that names one of Randy's setups (worked out from the numbers, not taken from the page).
// For an ETF stand-in the same comparison runs on the converted levels, and a match is "converted" (Randy's level, converted), never
// "randy": nothing in the ETF's price was ever his.
function basisOf(setup: Row | null, input: CalcIn, via: Via | null = null) {
  if (!setup) return "mine" as const;
  const b = stopBasisFor({
    dir: input.dir, entry: input.entry, stop: input.stop, randyStop: toNum(setup.stop), randyInval: toNum(setup.invalidation),
    targets: normalizeTargets(setup.targets, input.dir), pct: input.settings.stop_est_pct,
  });
  return via ? (b === "randy" ? "converted" : b === "invalidation" ? "converted_inval" : b) : b;
}

async function handleCalc(b: Record<string, unknown>) {
  const { input, setup, real, via } = await calcInputs(b, false);
  const calc = await runCalc(input, via && real ? cautionsFor(via.v, String(real.ticker)) : []);
  const stop_basis = basisOf(setup, input, via);
  return json({ ok: true, calc: { ...calc, stop_basis, stop_basis_text: basisWords(stop_basis, input.entry, input.stop) }, risk_budget: riskBudget(input.settings) });
}

// Stop estimates for a setup where Randy gave no stop, measured from the entry the person is using. Saves nothing.
async function handleEstimates(b: Record<string, unknown>) {
  const id = idIn(b.setup_id, "setup");
  const m = await loadSetupsById([id]);
  const real = m.get(id);
  if (!real) throw new HttpError(404, "That setup isn't on Randy's list anymore.");
  const setup = wantsVehicle(b.vehicle) ? await (async () => { const via = await viaFor(real, b.vehicle, b.anchor); return vehicleRow(real, via.v, via.pU, via.pV); })() : real;
  const dir: Dir = setup.direction === "short" ? "short" : "long";
  const settings = await mustSettings();
  const entry = levelIn(b.entry, "entry");
  if (toNum(setup.stop) != null) return json({ ok: true, applies: false, estimates: { pct: null, rr2: [] }, stop_est_pct: settings.stop_est_pct });
  return json({ ok: true, applies: true, estimates: estimateStops(dir, entry, normalizeTargets(setup.targets, dir), settings.stop_est_pct), stop_est_pct: settings.stop_est_pct });
}

// ── plans ────────────────────────────────────────────────────
// A plan row as the page gets it: numbers are numbers whichever way the database sends them.
const PLAN_NUMS = ["entry", "stop", "target", "shares", "risk_dollars", "fill_price", "fill_shares", "exit_price"];
const normPlan = (p: Row): Row => { const o = { ...p }; for (const k of PLAN_NUMS) if (k in o) o[k] = toNum(o[k]); return o; };
const PLAN_COLS = "id,setup_id,ticker,direction,state,entry,entry_type,stop,target,target_label,shares,risk_dollars,snapshot,my_trade_id,fill_price,fill_shares,exit_price,exit_reason,note,placed_at,filled_at,closed_at,created_at,updated_at,stop_basis,vehicle";

async function handlePlanSave(b: Record<string, unknown>) {
  const editing = b.id != null;
  let existing: Row | null = null;
  if (editing) {
    const id = idIn(b.id, "plan id");
    const r = await db.from("act_plans").select(PLAN_COLS).eq("owner", OWNER).eq("id", id).maybeSingle();
    if (r.error) throw new HttpError(500, "Couldn't read that plan.");
    existing = r.data as Row | null;
    if (!existing) throw new HttpError(404, "That plan isn't there anymore.");
    if (existing.state !== "planned") throw new HttpError(409, "This plan is already placed at Schwab, so its prices can't be edited here. Skip it (and cancel the orders at Schwab), then make a new one.");
    b = { ...b, setup_id: existing.setup_id ?? b.setup_id };
    // A plan that is in an ETF stays in it when edited, with the prices its levels were converted with, unless the request names an ETF.
    const ev = vehicleOf(existing);
    if (ev && !wantsVehicle(b.vehicle)) b = { ...b, vehicle: ev.t, anchor: ev.p_u != null && ev.p_v != null ? { p_u: ev.p_u, p_v: ev.p_v } : undefined };
  }
  if (b.setup_id == null) throw bad("Pick one of Randy's setups.");
  const { input, setup, real, via } = await calcInputs(b, true);
  if (!setup || !real) throw new HttpError(404, "That setup isn't on Randy's list anymore.");
  if (["stopped", "closed", "expired"].includes(String(real.status))) {
    throw new HttpError(409, `Randy has this one as ${real.status}, so it can't be planned.`);
  }
  const setupId = String(real.id);

  const clash = await db.from("act_plans").select("id,state").eq("owner", OWNER).eq("setup_id", setupId).in("state", ACTIVE);
  if (clash.error) throw new HttpError(500, "Couldn't check your existing plans.");
  const other = ((clash.data || []) as Row[]).find((p) => !existing || p.id !== existing.id);
  if (other) throw new HttpError(409, `You already have a plan on this setup (${other.state}). Open it under My plans.`);

  const calc = await runCalc(input, via ? cautionsFor(via.v, String(real.ticker)) : []);
  if (!calc.placeable.ok) throw bad(calc.placeable.blockers[0], { blockers: calc.placeable.blockers });
  if (!calc.sized.ok) throw bad(calc.sized.errors[0] ?? "Those levels can't be sized.", { errors: calc.sized.errors });
  if (calc.sized.shares == null) throw bad(calc.sized.errors[0] ?? calc.sized.needs ?? "Set your risk per trade under My account first.", { needs: calc.sized.needs });

  // A target that is one of Randy's keeps his label; any other number is Dave's own. (For an ETF the label goes with the converted target.)
  // The snapshot is always Randy's own setup as it is now, on his ticker, so what he changes later is compared with what he had.
  const tradeNow = setupNow(setup, input.dir);
  const hit = tradeNow.targets.find((t) => t.price != null && Math.abs(t.price - (input.target as number)) < 1e-9);
  const nowIso = new Date().toISOString();
  const row = {
    owner: OWNER, setup_id: setupId, ticker: input.ticker, direction: input.dir, entry: input.entry, entry_type: calc.entry_type as EntryType,
    stop: input.stop, stop_basis: basisOf(setup, input, via), target: input.target as number, target_label: hit ? hit.label : "Mine", shares: calc.sized.shares, risk_dollars: calc.sized.loss_at_stop,
    snapshot: snapshotOf(setupNow(real, via ? via.realDir : input.dir)), note: noteIn(b.note), updated_at: nowIso,
    vehicle: via ? { t: via.v.t, underlying: String(real.ticker), dir: via.realDir, lev: via.v.lev, label: via.v.name, p_u: via.pU, p_v: via.pV, at: nowIso } : null,
  };
  if (existing) {
    const r = await db.from("act_plans").update(row).eq("owner", OWNER).eq("id", existing.id).eq("state", "planned").select(PLAN_COLS).single();
    if (r.error) throw new HttpError(500, "Couldn't save that plan.");
    return json({ ok: true, plan: normPlan(r.data as Row), calc });
  }
  const r = await db.from("act_plans").insert(row).select(PLAN_COLS).single();
  if (r.error) {
    if (r.error.code === "23505") throw new HttpError(409, "You already have a plan on this setup. Open it under My plans.");
    throw new HttpError(500, "Couldn't save that plan.");
  }
  return json({ ok: true, plan: normPlan(r.data as Row), calc });
}

function planView(p: Row, setup: Row | null, prices: Record<string, number>, settings: Settings) {
  const dir: Dir = p.direction === "short" ? "short" : "long";
  const ticker = String(p.ticker);
  const entry = toNum(p.entry) as number, stop = toNum(p.stop) as number, target = toNum(p.target) as number;
  const shares = toNum(p.shares) as number;
  const price = prices[ticker] ?? null;
  const fillPrice = toNum(p.fill_price), fillShares = toNum(p.fill_shares), exitPrice = toNum(p.exit_price);
  const state = String(p.state);
  const live = ACTIVE.includes(state);
  const veh = vehicleOf(p);
  // Randy's levels are on his ticker, so for an ETF plan the comparison runs on his own row in his own direction. The plan's target is an
  // ETF price, so Randy's target is checked by its label instead.
  const changes = live ? changesSince(p.snapshot as Snapshot, setup ? setupNow(setup, veh ? veh.dir : dir) : null, veh || p.target_label === "Mine" ? null : target) : [];
  if (live && veh && setup && p.target_label && p.target_label !== "Mine") {
    const t = setupNow(setup, veh.dir).targets.find((x) => x.label === p.target_label);
    if (!t) changes.push(`Randy's ${p.target_label} target isn't on his ${veh.underlying} list anymore.`);
    else if (t.hit) changes.push(`Randy's ${p.target_label} target on ${veh.underlying} is marked hit.`);
  }
  const vehNote = veh ? findVehicle(veh.underlying, veh.dir, veh.t) : null;
  const entryType = (ENTRY_TYPES.includes(p.entry_type) ? p.entry_type : "limit") as EntryType;
  const openPnl = state === "filled" && fillPrice != null && fillShares != null && price != null ? pnl(dir, fillPrice, price, fillShares) : null;
  const realized = state === "closed" && fillPrice != null && fillShares != null && exitPrice != null ? pnl(dir, fillPrice, exitPrice, fillShares) : null;
  return {
    id: String(p.id), setup_id: p.setup_id ? String(p.setup_id) : null, ticker, direction: dir, state,
    entry, entry_type: entryType, stop, target, target_label: p.target_label ?? null, shares, risk_dollars: toNum(p.risk_dollars),
    stop_basis: typeof p.stop_basis === "string" ? p.stop_basis : null, stop_basis_text: basisWords(p.stop_basis, entry, stop),
    note: p.note ?? null, fill_price: fillPrice, fill_shares: fillShares, exit_price: exitPrice, exit_reason: p.exit_reason ?? null,
    placed_at: p.placed_at ?? null, filled_at: p.filled_at ?? null, closed_at: p.closed_at ?? null, created_at: p.created_at ?? null,
    price,
    pct: { to_entry: pctFrom(price, entry), to_stop: pctFrom(price, stop), to_target: pctFrom(price, target) },
    open_pnl: openPnl, open_pnl_pct: openPnl != null && fillPrice != null && fillShares != null ? Math.round((openPnl / (fillPrice * fillShares)) * 1000) / 10 : null,
    realized, realized_pct: realized != null && fillPrice != null && fillShares != null ? Math.round((realized / (fillPrice * fillShares)) * 1000) / 10 : null,
    at_risk: state === "filled" && fillPrice != null && fillShares != null ? Math.round(Math.abs(fillPrice - stop) * fillShares * 100) / 100 : null,
    changes,
    vehicle: veh ? {
      t: veh.t, name: veh.label, underlying: veh.underlying, underlying_dir: veh.dir, lev: veh.lev, lev_text: fmtLev(veh.lev), p_u: veh.p_u, p_v: veh.p_v, at: veh.at,
      words: `Randy's ${veh.underlying} ${veh.dir}, taken as ${veh.t}.` + (veh.p_u != null && veh.p_v != null ? ` His levels were converted at ${veh.underlying} ${veh.p_u} and ${veh.t} ${veh.p_v}${veh.at ? " on " + todayCentral(new Date(veh.at)) : ""}.` : ""),
      cautions: cautionsFor(vehNote ?? { t: veh.t, name: veh.label, lev: veh.lev, kind: "convert", note: "" }, veh.underlying),
    } : null,
    randy_status: setup ? String(setup.status) : null,
    ticket: state === "planned" || state === "placed" ? ticketFor({ ticker, dir, qty: shares, entry, entry_type: entryType, stop, target }) : null,
    entry_words: state === "planned" || state === "placed" ? entryWords(dir, entryType, entry) : null,
    placeable: canPlace(ticker, dir, settings),
  };
}

async function handlePlans(b: Record<string, unknown>) {
  const [st, pl] = await Promise.all([
    loadSettings(),
    db.from("act_plans").select(PLAN_COLS).eq("owner", OWNER).order("created_at", { ascending: false }).limit(300),
  ]);
  if (pl.error) throw new HttpError(500, "Couldn't load your plans.");
  let rows = (pl.data || []) as Row[];
  if (b.include_skipped !== true) rows = rows.filter((r) => r.state !== "skipped");
  const setups = await loadSetupsById([...new Set(rows.map((r) => r.setup_id).filter(Boolean).map(String))]);
  const prices = await getPrices(rows.filter((r) => ACTIVE.includes(r.state)).map((r) => String(r.ticker)));
  const got = Object.keys(prices).length > 0;
  const views = rows.map((r) => planView(r, r.setup_id ? setups.get(String(r.setup_id)) ?? null : null, prices, st.settings));
  const order: Record<string, number> = { filled: 0, placed: 1, planned: 2, closed: 3, skipped: 4 };
  views.sort((a, c) => (order[a.state] - order[c.state]) || String(c.closed_at || c.created_at).localeCompare(String(a.closed_at || a.created_at)));
  const closed = views.filter((v) => v.state === "closed");
  const filled = views.filter((v) => v.state === "filled");
  const sum = (xs: Array<number | null>) => Math.round(xs.reduce<number>((a, x) => a + (x ?? 0), 0) * 100) / 100;
  return json({
    ok: true, plans: views, settings: st.settings, mode: st.settings.funded ? "live" : "planning", prices_ok: got, price_note: priceNote(new Date(), got),
    summary: {
      active: views.filter((v) => ACTIVE.includes(v.state)).length, open: filled.length,
      at_risk: sum(filled.map((v) => v.at_risk)), open_pnl: sum(filled.map((v) => v.open_pnl)),
      closed: closed.length, realized: sum(closed.map((v) => v.realized)),
      wins: closed.filter((v) => (v.realized ?? 0) > 0).length, losses: closed.filter((v) => (v.realized ?? 0) < 0).length,
    },
  });
}

// Which steps are allowed from where. Every forward step has a way back.
const NEXT: Record<string, string[]> = {
  planned: ["placed", "filled", "skipped"],
  placed: ["planned", "filled", "skipped"],
  filled: ["placed", "closed"],
  closed: ["filled"],
  skipped: ["planned"],
};

async function handlePlanState(b: Record<string, unknown>) {
  const id = idIn(b.id, "plan id");
  const to = typeof b.to === "string" ? b.to : "";
  if (!Object.prototype.hasOwnProperty.call(NEXT, to)) throw bad("Unknown step.");
  const r = await db.from("act_plans").select(PLAN_COLS).eq("owner", OWNER).eq("id", id).maybeSingle();
  if (r.error) throw new HttpError(500, "Couldn't read that plan.");
  const p = r.data as Row | null;
  if (!p) throw new HttpError(404, "That plan isn't there anymore.");
  const from = String(p.state);
  if (!NEXT[from]?.includes(to)) throw new HttpError(409, `A plan that is ${from} can't go to ${to}.`);

  const nowIso = new Date().toISOString();
  const today = todayCentral();
  const dir: Dir = p.direction === "short" ? "short" : "long";
  const warnings: string[] = [];
  const patch: Row = { state: to, updated_at: nowIso };
  const note = b.note !== undefined ? noteIn(b.note) : undefined;
  if (note !== undefined) patch.note = note;
  let reminder: string | null = null;
  let newTradeId: string | null = null;     // a trade row made in this call, removed again if the plan can't be saved

  // The trade record Dave's brief reads (rsotc_my_trades): its stop feeds the "★ your ... past your stop" warning.
  const appendHistory = async (tradeId: string, event: string, extra: Row): Promise<boolean> => {
    const cur = await db.from("rsotc_my_trades").select("history").eq("id", tradeId).maybeSingle();
    if (cur.error) return false;
    const hist = Array.isArray((cur.data as Row | null)?.history) ? (cur.data as Row).history : [];
    const up = await db.from("rsotc_my_trades").update({ ...extra, history: [...hist, { at: today, event }], updated_at: nowIso }).eq("id", tradeId);
    return !up.error;
  };

  const step = `${from}>${to}`;
  if (step === "planned>placed") {
    patch.placed_at = nowIso;
    reminder = "Marked as placed. This only records it: the orders themselves go in at Schwab.";
  } else if (step === "placed>planned" || step === "placed>skipped") {
    patch.placed_at = null;
    reminder = `${to === "skipped" ? "Skipped" : "Back to planned"}. If you already sent the orders, cancel them at Schwab.`;
  } else if (step === "planned>skipped") {
    // nothing was placed, nothing to cancel
  } else if (step === "skipped>planned") {
    // a skipped plan comes back as it was
  } else if (step === "planned>filled" || step === "placed>filled") {
    const fillPrice = priceIn(b.fill_price, "fill");
    const fillShares = toNum(b.fill_shares) ?? toNum(p.shares);
    if (fillShares == null || !Number.isInteger(fillShares) || fillShares < 1 || fillShares > 1e7) throw bad("Shares filled has to be a whole number, 1 or more.");
    const stop = toNum(p.stop) as number;
    if ((dir === "long" && fillPrice <= stop) || (dir === "short" && fillPrice >= stop)) warnings.push(`The fill (${fillPrice}) is at or past your stop (${stop}).`);
    const bs = typeof p.stop_basis === "string" ? p.stop_basis : "";
    const veh = vehicleOf(p);
    const estNote = bs.startsWith("estimate") ? " The stop was an estimate, not Randy's." : bs.startsWith("converted") ? " The stop was Randy's level converted to the ETF, an estimate." : "";
    // An ETF trade is its own trade: no setup_id, because the brief's "★ You" lines compare a trade with the levels and price of Randy's setup,
    // and an ETF's price and levels are not those of his underlying.
    const viaNote = veh ? ` ${p.ticker} standing in for Randy's ${veh.underlying} ${veh.dir}.` : "";
    const ins = await db.from("rsotc_my_trades").insert({
      setup_id: veh ? null : p.setup_id ?? null, ticker: p.ticker, direction: dir, entry: fillPrice, stop, shares: fillShares, opened_at: today,
      notes: "Opened from the Act page." + viaNote + estNote,
      history: [{ at: today, event: `Opened: ${dir === "short" ? "sold short" : "bought"} ${fillShares} at ${fillPrice} (stop ${stop}, target ${p.target}).${viaNote}${estNote}` }],
    }).select("id").single();
    if (ins.error) throw new HttpError(500, "Couldn't record the trade, so the plan was left as it was.");
    newTradeId = String((ins.data as Row).id);
    Object.assign(patch, { fill_price: fillPrice, fill_shares: fillShares, filled_at: nowIso, my_trade_id: newTradeId, placed_at: p.placed_at ?? nowIso });
  } else if (step === "filled>placed") {
    // Undo a fill: the trade row made for it goes away.
    if (p.my_trade_id) {
      const del = await db.from("rsotc_my_trades").delete().eq("id", p.my_trade_id);
      if (del.error) throw new HttpError(500, "Couldn't take the trade back out, so the plan was left as it was.");
    }
    Object.assign(patch, { fill_price: null, fill_shares: null, filled_at: null, my_trade_id: null, placed_at: p.placed_at ?? nowIso });
    reminder = "Fill undone. The trade was taken back out of your open trades.";
  } else if (step === "filled>closed") {
    const exitPrice = priceIn(b.exit_price, "exit");
    const reason = b.exit_reason == null || b.exit_reason === "" ? "manual" : b.exit_reason;
    if (reason !== "target" && reason !== "stop" && reason !== "manual") throw bad("Exit reason has to be target, stop or manual.");
    Object.assign(patch, { exit_price: exitPrice, exit_reason: reason, closed_at: nowIso });
    const fp = toNum(p.fill_price), fs = toNum(p.fill_shares);
    if (p.my_trade_id && fp != null && fs != null) {
      const gain = pnl(dir, fp, exitPrice, fs);
      const okH = await appendHistory(String(p.my_trade_id), `Closed at ${exitPrice} (${reason}): ${gain >= 0 ? "+" : "-"}$${Math.abs(gain).toFixed(2)}.`, { closed_at: today, exit: exitPrice });
      if (!okH) throw new HttpError(500, "Couldn't close the trade record, so the plan was left as it was.");
    }
  } else if (step === "closed>filled") {
    Object.assign(patch, { exit_price: null, exit_reason: null, closed_at: null });
    if (p.my_trade_id) {
      const okH = await appendHistory(String(p.my_trade_id), "Reopened: the close was undone.", { closed_at: null, exit: null });
      if (!okH) throw new HttpError(500, "Couldn't reopen the trade record, so the plan was left as it was.");
    }
    reminder = "Close undone. It's an open trade again.";
  }

  const up = await db.from("act_plans").update(patch).eq("owner", OWNER).eq("id", id).eq("state", from).select(PLAN_COLS).single();
  if (up.error) {
    if (newTradeId) await db.from("rsotc_my_trades").delete().eq("id", newTradeId);
    throw new HttpError(500, "Couldn't save that step.");
  }
  return json({ ok: true, plan: normPlan(up.data as Row), warnings, reminder });
}

async function handlePlanNote(b: Record<string, unknown>) {
  const id = idIn(b.id, "plan id");
  const note = noteIn(b.note);
  const r = await db.from("act_plans").update({ note, updated_at: new Date().toISOString() }).eq("owner", OWNER).eq("id", id).select(PLAN_COLS);
  if (r.error) throw new HttpError(500, "Couldn't save the note.");
  if (!r.data || !(r.data as Row[]).length) throw new HttpError(404, "That plan isn't there anymore.");
  return json({ ok: true, plan: normPlan((r.data as Row[])[0]) });
}

async function handlePlanDelete(b: Record<string, unknown>) {
  const id = idIn(b.id, "plan id");
  const r = await db.from("act_plans").select("id,state").eq("owner", OWNER).eq("id", id).maybeSingle();
  if (r.error) throw new HttpError(500, "Couldn't read that plan.");
  if (!r.data) throw new HttpError(404, "That plan isn't there anymore.");
  const state = String((r.data as Row).state);
  if (state !== "planned" && state !== "skipped") throw new HttpError(409, `A ${state} plan can't be deleted. Skip it first, or close the trade.`);
  const d = await db.from("act_plans").delete().eq("owner", OWNER).eq("id", id).in("state", ["planned", "skipped"]);
  if (d.error) throw new HttpError(500, "Couldn't delete that plan.");
  return json({ ok: true });
}

// ── entry ────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!PAGE_KEY || key !== PAGE_KEY) return json({ error: "Invalid or missing key" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const parsed = await req.json().catch(() => null);
    const body = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    switch (body.action) {
      case "board": return await handleBoard();
      case "settings": return await handleSettings(body);
      case "calc": return await handleCalc(body);
      case "estimates": return await handleEstimates(body);
      case "vehicle": return await handleVehicle(body);
      case "etf_ladders": return await handleEtfLadders(body);
      case "plan_save": return await handlePlanSave(body);
      case "plans": return await handlePlans(body);
      case "plan_state": return await handlePlanState(body);
      case "plan_note": return await handlePlanNote(body);
      case "plan_delete": return await handlePlanDelete(body);
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
});
