// ============================================================
// Order math for the rsotc-act function (pure: no Deno or database calls, so it can be unit tested).
//
// Takes one of Randy's setups plus the numbers Dave sets himself (account size, how much he risks per trade, what his
// Schwab account is approved for) and works out: can this be placed, how many shares his own risk number allows, what
// is lost at the stop and gained at the target, and the three Schwab orders to enter.
//
// Nothing here chooses a setup, a stop, a target or a risk amount for him. Every price is Randy's or Dave's.
// Shares come from one formula: shares = risk in dollars / (entry - stop), rounded down to whole shares.
//
// Estimated stops (added Nov 12, 2026, at Dave's request) are for setups where Randy gave none. They are not a pick: they come
// from exactly two stated rules, are always labelled as estimates, and are only offered as chips to tap, never filled in:
//   "pct": entry minus (long) or plus (short) the percent Dave sets himself under My account (it starts at 2).
//   "rr2": Randy's own 2:1 rule: the farthest stop that still leaves 2:1 to one of his firm targets (reward / 2 from the entry).
// ============================================================

export type Dir = "long" | "short";
export type Instrument = "equity" | "future" | "index";
export type EntryType = "limit" | "stop" | "market";

export interface Settings {
  account_size: number | null;      // dollars he plans to have (or has) in the Schwab account
  funded: boolean;                  // the money is in
  risk_mode: "dollars" | "percent";
  risk_value: number | null;        // dollars, or percent of the account, he is willing to lose if the stop is hit
  margin_ok: boolean;               // the Schwab account is a margin account (shorting needs one)
  futures_ok: boolean;              // approved for futures at Schwab
  stop_est_pct: number;             // Dave's own number: how far from Randy's entry the "percent" stop estimate sits (starts at 2)
}

export const DEFAULT_STOP_EST_PCT = 2;
export const MAX_STOP_EST_PCT = 50;

export const SCHWAB_MARGIN_MIN = 2000;   // Schwab's stated minimum to start margin borrowing and its short-sale minimum equity (schwab.com/margin/margin-rates-and-requirements)

export const instrumentOf = (ticker: string): Instrument => (ticker.startsWith("/") ? "future" : ticker.startsWith("$") ? "index" : "equity");

const money = (n: number) => Math.round(n * 100) / 100;
const isNum = (x: unknown): x is number => typeof x === "number" && isFinite(x);
const px = (n: number) => (Math.abs(n) >= 1 ? n.toFixed(2) : String(n));

// ── can this be placed with the account he has told us about ──
export interface Placeable { ok: boolean; blockers: string[]; notes: string[] }
export function canPlace(ticker: string, dir: Dir, s: Settings): Placeable {
  const blockers: string[] = [], notes: string[] = [];
  const inst = instrumentOf(ticker);
  if (inst === "index") blockers.push(`${ticker} is an index, not something you can buy or sell directly. Randy's idea would take a fund or futures tied to it, which this app doesn't size.`);
  if (inst === "future") {
    blockers.push("Futures need their own approval at Schwab and are sized in contracts, which this app doesn't do yet. The levels are shown for reference.");
    if (!s.futures_ok) notes.push("Your account isn't ticked as approved for futures.");
  }
  if (inst === "equity" && dir === "short") {
    if (!s.margin_ok) blockers.push("Selling short needs a margin account at Schwab. Tick \"margin account\" under My account once yours has it.");
    else {
      notes.push(`Schwab lists a $${SCHWAB_MARGIN_MIN.toLocaleString("en-US")} short-sale minimum equity, and shares have to be available to borrow at the time. Schwab can close a short position.`);
      if (s.account_size != null && s.account_size < SCHWAB_MARGIN_MIN) blockers.push(`Your account size ($${s.account_size.toLocaleString("en-US")}) is under Schwab's $${SCHWAB_MARGIN_MIN.toLocaleString("en-US")} margin and short-sale minimum.`);
    }
  }
  return { ok: blockers.length === 0, blockers, notes };
}

// ── how the entry order is entered, from where the price is now ──
// A buy below the market waits for the price to come down (limit); a buy above the market waits for a break up (stop).
// A short above the market waits for a bounce up (limit); a short below the market waits for a break down (stop).
export function entryTypeFor(dir: Dir, entry: number, price: number | null | undefined): EntryType {
  if (!isNum(price) || !isNum(entry) || price <= 0) return "limit";
  if (dir === "long") return entry > price ? "stop" : "limit";
  return entry < price ? "stop" : "limit";
}

// A plain sentence for what the entry order does, so the ticket reads the way Schwab will behave.
export function entryWords(dir: Dir, type: EntryType, entry: number): string {
  const p = px(entry);
  if (type === "market") return `Fills right away at the market price (you sized it at about ${p}).`;
  if (dir === "long") return type === "limit" ? `Waits for the price to come down to ${p} or lower, then buys.` : `Waits for the price to rise to ${p}, then buys (a buy stop).`;
  return type === "limit" ? `Waits for the price to rise to ${p} or higher, then sells short.` : `Waits for the price to fall to ${p}, then sells short (a sell-short stop).`;
}

// ── Randy's targets ──
export interface RawTarget { label?: string; price?: number | string | null; low?: number | string | null; high?: number | string | null; hit?: string | null; note?: string; potential?: boolean }
export interface Target { label: string; price: number | null; zone: [number, number] | null; hit: string | null; potential: boolean; note: string }
const num = (x: unknown): number | null => { const n = typeof x === "string" ? Number(x) : x; return isNum(n) ? n : null; };

// A target with a price is that price. A zone (low to high) is entered at its near edge: the low edge for a long, the high edge for a short.
// A target with neither (a trendline Randy only drew) has no price to enter.
export function normalizeTargets(raw: unknown, dir: Dir): Target[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawTarget[]).filter((t) => t && typeof t === "object").map((t, i) => {
    const low = num(t.low), high = num(t.high), p = num(t.price);
    const zone: [number, number] | null = low != null && high != null ? [Math.min(low, high), Math.max(low, high)] : null;
    const price = p ?? (zone ? (dir === "long" ? zone[0] : zone[1]) : null);
    return { label: String(t.label ?? `T${i + 1}`).slice(0, 20), price, zone, hit: t.hit ? String(t.hit) : null, potential: !!t.potential, note: String(t.note ?? "").slice(0, 300) };
  });
}

// ── estimated stops (only offered where Randy gave no stop) ──
export type StopBasis = "randy" | "invalidation" | "estimate_pct" | "estimate_2to1" | "mine" | "converted" | "converted_inval";
export interface StopEstimate {
  kind: "pct" | "rr2";
  price: number;                 // rounded to what Schwab accepts
  dist_pct: number;              // how far it is from the entry, percent, one decimal
  label: string;                 // short chip text
  basis: string;                 // the rule behind it, in plain words
  target_label: string | null;   // rr2 only: which of Randy's targets the 2:1 is measured to
  target_price: number | null;
}
export interface StopEstimates { pct: StopEstimate | null; rr2: StopEstimate[] }

export const schwabTick = (n: number) => (n >= 1 ? Math.round(n * 100) / 100 : Math.round(n * 10000) / 10000);
// Rounds to a price Schwab accepts, toward the entry: up for a long's stop (which sits below it), down for a short's. Randy's 2:1 stop is a
// maximum, so rounding must never carry it farther from the entry than his rule allows. The tiny allowance absorbs floating point noise.
const tickToward = (n: number, dir: Dir) => { const f = n >= 1 ? 100 : 10000, x = n * f; return (dir === "long" ? Math.ceil(x - 1e-7) : Math.floor(x + 1e-7)) / f; };
const distPct = (entry: number, stop: number) => Math.round((Math.abs(entry - stop) / entry) * 1000) / 10;
const onStopSide = (dir: Dir, entry: number, s: number) => s > 0 && (dir === "long" ? s < entry : s > entry);

export function estimateStops(dir: Dir, entry: number | null | undefined, targets: Target[], pct: number | null | undefined): StopEstimates {
  const out: StopEstimates = { pct: null, rr2: [] };
  if (!isNum(entry) || entry <= 0) return out;
  const sgn = dir === "long" ? -1 : 1;                                // the stop sits below a long's entry and above a short's
  const p = isNum(pct) && pct > 0 && pct <= MAX_STOP_EST_PCT ? pct : DEFAULT_STOP_EST_PCT;
  const sp = schwabTick(entry * (1 + (sgn * p) / 100));
  if (onStopSide(dir, entry, sp)) {
    out.pct = {
      kind: "pct", price: sp, dist_pct: distPct(entry, sp), label: `${p}% from entry`, target_label: null, target_price: null,
      basis: `Your setting: ${p}% ${dir === "long" ? "below" : "above"} the entry price (${px(entry)}).`,
    };
  }
  for (const t of targets) {
    if (t.price == null || t.hit || t.potential) continue;           // only Randy's firm, untouched targets
    const reward = dir === "long" ? t.price - entry : entry - t.price;
    if (!(reward > 0)) continue;
    const s = tickToward(entry + (sgn * reward) / 2, dir);
    if (!onStopSide(dir, entry, s)) continue;
    out.rr2.push({
      kind: "rr2", price: s, dist_pct: distPct(entry, s), label: `2:1 to ${t.label}`, target_label: t.label, target_price: t.price,
      basis: `Randy's 2:1 rule: the farthest stop that still leaves 2:1 to ${t.label} (${px(t.price)}). He treats it as a maximum, judged on a daily close.`,
    });
  }
  return out;
}

// Where a stop number came from, worked out here from the numbers (never taken from the request): Randy's own stop or
// invalidation, one of the two estimates, or the person's own.
export function stopBasisFor(i: { dir: Dir; entry: number; stop: number; randyStop: number | null; randyInval: number | null; targets: Target[]; pct: number | null }): StopBasis {
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  if (i.randyStop != null) return same(schwabTick(i.randyStop), i.stop) ? "randy" : "mine";
  if (i.randyInval != null && same(schwabTick(i.randyInval), i.stop)) return "invalidation";
  const est = estimateStops(i.dir, i.entry, i.targets, i.pct);
  if (est.pct && same(est.pct.price, i.stop)) return "estimate_pct";
  if (est.rr2.some((e) => same(e.price, i.stop))) return "estimate_2to1";
  return "mine";
}

export function basisWords(b: StopBasis | null | undefined, entry: number | null, stop: number | null): string | null {
  if (b === "randy") return "Randy's stop";
  if (b === "invalidation") return "Randy's invalidation level";
  if (b === "estimate_pct") return `An estimate, ${entry != null && stop != null && entry > 0 ? distPct(entry, stop) + "% from the entry" : "a percent from the entry"}, not Randy's`;
  if (b === "estimate_2to1") return "An estimate from Randy's 2:1 rule, not his stop";
  if (b === "converted") return "An estimate: Randy's stop on the underlying, converted to this ETF at that day's prices";
  if (b === "converted_inval") return "An estimate: Randy's invalidation level on the underlying, converted to this ETF at that day's prices";
  if (b === "mine") return "Your own number";
  return null;
}

// ── sizing ──
export interface SizeIn { dir: Dir; entry: number; stop: number; target: number; settings: Settings; ticker?: string; shares?: number | null }
export interface Sized {
  ok: boolean;                       // the levels are usable (right side of the entry)
  errors: string[];                  // why not, in plain words
  warnings: string[];                // things to look at before placing
  risk_per_share: number | null;
  reward_per_share: number | null;
  rr: number | null;                 // reward per share / risk per share
  risk_budget: number | null;        // dollars he allows himself to lose, from his setting
  max_by_risk: number | null;
  max_by_cash: number | null;
  shares: number | null;             // the number to enter
  limited_by: "risk" | "account" | "you" | null;
  cost: number | null;               // shares x entry
  loss_at_stop: number | null;
  loss_pct: number | null;           // of the account size
  gain_at_target: number | null;
  gain_pct: number | null;
  needs: string | null;              // what is missing before shares can be worked out
}

export function riskBudget(s: Settings): number | null {
  if (!isNum(s.risk_value) || s.risk_value <= 0) return null;
  if (s.risk_mode === "percent") return isNum(s.account_size) && s.account_size > 0 ? money((s.account_size * s.risk_value) / 100) : null;
  return money(s.risk_value);
}

export function sizeTrade(i: SizeIn): Sized {
  const out: Sized = { ok: false, errors: [], warnings: [], risk_per_share: null, reward_per_share: null, rr: null, risk_budget: null, max_by_risk: null, max_by_cash: null, shares: null, limited_by: null, cost: null, loss_at_stop: null, loss_pct: null, gain_at_target: null, gain_pct: null, needs: null };
  const { dir, entry, stop, target } = i;
  for (const [n, v] of [["entry", entry], ["stop", stop], ["target", target]] as const) if (!isNum(v) || v <= 0) out.errors.push(`Enter the ${n} price.`);
  if (out.errors.length) return out;
  if (dir === "long") {
    if (stop >= entry) out.errors.push("For a long, the stop has to be below the entry.");
    if (target <= entry) out.errors.push("For a long, the target has to be above the entry.");
  } else {
    if (stop <= entry) out.errors.push("For a short, the stop has to be above the entry.");
    if (target >= entry) out.errors.push("For a short, the target has to be below the entry.");
  }
  if (out.errors.length) return out;
  out.ok = true;
  const rps = Math.abs(entry - stop), gps = Math.abs(target - entry);
  out.risk_per_share = money(rps); out.reward_per_share = money(gps); out.rr = Math.round((gps / rps) * 100) / 100;

  const s = i.settings;
  out.risk_budget = riskBudget(s);
  if (out.risk_budget == null) out.needs = s.risk_mode === "percent" && !(isNum(s.account_size) && s.account_size > 0) ? "Enter your account size under My account to size by percent." : "Set how much you risk per trade under My account to see share counts.";
  const acct = isNum(s.account_size) && s.account_size > 0 ? s.account_size : null;
  out.max_by_risk = out.risk_budget != null ? Math.floor(out.risk_budget / rps) : null;
  out.max_by_cash = acct != null ? Math.floor(acct / entry) : null;

  let shares: number | null = null;
  if (isNum(i.shares) && Number.isInteger(i.shares) && i.shares >= 1) {
    shares = i.shares; out.limited_by = "you";
    if (out.max_by_risk != null && shares > out.max_by_risk) out.warnings.push(`${shares} shares risks $${money(shares * rps).toFixed(2)} at the stop, over the $${out.risk_budget!.toFixed(2)} you set.`);
    if (out.max_by_cash != null && shares > out.max_by_cash) out.warnings.push(`${shares} shares costs $${money(shares * entry).toFixed(2)}, more than your $${acct!.toLocaleString("en-US")} account size.`);
  } else if (out.max_by_risk != null) {
    shares = out.max_by_cash != null ? Math.min(out.max_by_risk, out.max_by_cash) : out.max_by_risk;
    out.limited_by = out.max_by_cash != null && out.max_by_cash < out.max_by_risk ? "account" : "risk";
  }
  if (shares != null && shares < 1) {
    out.shares = null; out.limited_by = null;
    if (out.max_by_risk === 0) out.errors.push(`One share risks $${money(rps).toFixed(2)} at the stop, which is more than the $${out.risk_budget!.toFixed(2)} you set.`);
    else out.errors.push(`One share costs $${money(entry).toFixed(2)}, more than your $${acct!.toLocaleString("en-US")} account size.`);
    return out;
  }
  if (shares == null) return out;
  out.shares = shares;
  out.cost = money(shares * entry);
  out.loss_at_stop = money(shares * rps);
  out.gain_at_target = money(shares * gps);
  if (acct != null) { out.loss_pct = Math.round((out.loss_at_stop / acct) * 1000) / 10; out.gain_pct = Math.round((out.gain_at_target / acct) * 1000) / 10; }
  return out;
}

// ── the three Schwab orders ──
export interface Order { n: 1 | 2 | 3; label: "Entry" | "Stop" | "Target"; action: string; qty: number; symbol: string; type: string; price: number | null; price_label: string | null; tif: string }
export interface Ticket { conditional: string; orders: Order[]; steps: string[]; text: string }
export function ticketFor(p: { ticker: string; dir: Dir; qty: number; entry: number; entry_type: EntryType; stop: number; target: number }): Ticket {
  const long = p.dir === "long";
  const closing = long ? "Sell" : "Buy to Cover";
  const entryOrder: Order = {
    n: 1, label: "Entry", action: long ? "Buy" : "Sell Short", qty: p.qty, symbol: p.ticker,
    type: p.entry_type === "limit" ? "Limit" : p.entry_type === "stop" ? "Stop" : "Market",
    price: p.entry_type === "market" ? null : p.entry, price_label: p.entry_type === "limit" ? "Limit price" : p.entry_type === "stop" ? "Stop price" : null, tif: "Good 'til canceled",
  };
  const stopOrder: Order = { n: 2, label: "Stop", action: closing, qty: p.qty, symbol: p.ticker, type: "Stop", price: p.stop, price_label: "Stop price", tif: "Good 'til canceled" };
  const targetOrder: Order = { n: 3, label: "Target", action: closing, qty: p.qty, symbol: p.ticker, type: "Limit", price: p.target, price_label: "Limit price", tif: "Good 'til canceled" };
  const orders = [entryOrder, stopOrder, targetOrder];
  const line = (o: Order) => `${o.action} ${o.qty} ${o.symbol}, ${o.type}${o.price != null ? ` at ${px(o.price)}` : ""}, ${o.tif}`;
  const steps = [
    "On schwab.com, go to Trade and open the All-in-One Trade Ticket. Pick the brokerage account.",
    "Click Add Conditional at the bottom of the ticket and choose Order 1 Triggers OCO.",
    `Order 1 (the entry): ${line(entryOrder)}.`,
    `Order 2 (the stop): ${line(stopOrder)}.`,
    `Order 3 (the target): ${line(targetOrder)}. Orders 2 and 3 are the OCO pair: when one fills, Schwab cancels the other.`,
    "Click Review Order, read the estimated amount and every alert message, then Place Order.",
  ];
  const text = [`${p.ticker} ${p.dir}: Order 1 Triggers OCO`, `1. ${line(entryOrder)}`, `2. ${line(stopOrder)}`, `3. ${line(targetOrder)}`, "Orders 2 and 3 cancel each other."].join("\n");
  return { conditional: "Order 1 Triggers OCO", orders, steps, text };
}

// ── what Randy changed since the plan was made ──
export interface Snapshot { entry: number | null; stop: number | null; status: string; targets: Array<{ label: string; price: number | null; hit: string | null }>; updated_at: string | null }
export interface SetupNow { entry_price: number | null; stop: number | null; status: string; targets: Target[]; updated_at?: string | null }

export function snapshotOf(s: SetupNow): Snapshot {
  return { entry: s.entry_price, stop: s.stop, status: s.status, targets: s.targets.map((t) => ({ label: t.label, price: t.price, hit: t.hit })), updated_at: s.updated_at ?? null };
}

const eq = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
const fmtN = (n: number | null) => (n == null ? "none" : String(n));

// planTarget is the target price the plan uses; null when the target is Dave's own number (nothing of Randy's to compare it to).
export function changesSince(snap: Snapshot | null | undefined, now: SetupNow | null, planTarget: number | null): string[] {
  if (!snap || typeof snap !== "object" || !("status" in snap)) return [];
  if (!now) return ["Randy's setup is no longer in the list."];
  const out: string[] = [];
  if (["closed", "stopped"].includes(now.status) && !["closed", "stopped"].includes(snap.status)) out.push(`Randy now has this as ${now.status}.`);
  else if (now.status !== snap.status) out.push(`Randy's status changed from "${snap.status}" to "${now.status}".`);
  if (!eq(snap.entry, now.entry_price)) out.push(`Randy's entry changed from ${fmtN(snap.entry)} to ${fmtN(now.entry_price)}.`);
  if (!eq(snap.stop, now.stop)) out.push(`Randy's stop changed from ${fmtN(snap.stop)} to ${fmtN(now.stop)}.`);
  if (planTarget != null) {
    const t = now.targets.find((x) => x.price != null && eq(x.price, planTarget));
    if (!t) out.push(`The ${planTarget} target is no longer on Randy's list.`);
    else if (t.hit) out.push(`The ${t.label} target (${planTarget}) is marked hit.`);
  }
  return out;
}

// ── plain facts about where the price is now ──
export function pctFrom(price: number | null | undefined, level: number | null | undefined): number | null {
  if (!isNum(price) || !isNum(level) || price <= 0) return null;
  return Math.round(((level - price) / price) * 1000) / 10;
}

// P/L of a trade at a price, in dollars (a short gains when the price falls).
export function pnl(dir: Dir, entry: number, exit: number, shares: number): number {
  return money((dir === "short" ? -1 : 1) * (exit - entry) * shares);
}
