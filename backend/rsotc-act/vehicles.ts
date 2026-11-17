// ============================================================
// ETF stand-ins for Randy's shorts, and for ideas Act can't place directly (futures, indexes). Added Nov 17 2026 at Dave's request:
// "for selling short there are vehicles to do so, so translate them please."
// ============================================================
// Pure code (no Deno calls, no database) so it can be unit tested.
//
// A "vehicle" is an ETF you BUY that moves with (or against) Randy's underlying: SQQQ for a QQQ short, SCO for a /CL or USO short,
// the single-stock bear ETF for a stock short. Buying it is an ordinary long order, so it needs no margin account and no short sale.
//
// Randy's levels are on the underlying (his QQQ stop is a QQQ price). To use them on the ETF they are converted with today's two
// prices. For an ETF that seeks `lev` times the underlying's daily move (SQQQ: -3, SOXS: -3, ERY: -2, a single-stock bear: -1):
//
//     level_on_ETF = price_ETF * (1 + lev * (level / price_underlying - 1))
//
// It is a straight-line estimate from where both prices are right now. It is NOT what the ETF will do: these funds reset daily, so
// over more than a day the result drifts away from the multiple. Everything built from it is labelled an estimate and is only ever
// offered as a tap-to-use number; the page never fills it in by itself.
// ============================================================

import { schwabTick, type Dir, type RawTarget } from "./size.ts";

export interface Vehicle { t: string; name: string; lev: number; kind: "convert" | "manual"; note: string }
export type VehicleBrief = Pick<Vehicle, "t" | "name" | "lev" | "kind">;
// "manual" = a stand-in whose price does not follow the underlying in a straight line (VIX funds) or is only a basket the idea belongs to
// (ASML in a semiconductor fund). It is offered, but Randy's levels are not converted; the person enters their own from the ETF's chart.
const V = (t: string, name: string, lev: number, note = "", kind: "convert" | "manual" = "convert"): Vehicle => ({ t, name, lev, kind, note });

const NDX_SHORT = [V("PSQ", "ProShares Short QQQ", -1), V("QID", "ProShares UltraShort QQQ", -2), V("SQQQ", "ProShares UltraPro Short QQQ", -3)];
const NDX_LONG = [V("QQQ", "Invesco QQQ Trust", 1), V("TQQQ", "ProShares UltraPro QQQ", 3)];
const SPX_SHORT = [V("SH", "ProShares Short S&P500", -1), V("SDS", "ProShares UltraShort S&P500", -2), V("SPXU", "ProShares UltraPro Short S&P500", -3)];
const SPX_LONG = [V("SPY", "SPDR S&P 500 ETF Trust", 1), V("UPRO", "ProShares UltraPro S&P500", 3)];
const RUT_SHORT = [V("RWM", "ProShares Short Russell2000", -1), V("TWM", "ProShares UltraShort Russell2000", -2), V("SRTY", "ProShares UltraPro Short Russell2000", -3)];
const RUT_LONG = [V("IWM", "iShares Russell 2000 ETF", 1), V("URTY", "ProShares UltraPro Russell2000", 3)];
const DOW_SHORT = [V("DOG", "ProShares Short Dow30", -1), V("DXD", "ProShares UltraShort Dow30", -2), V("SDOW", "ProShares UltraPro Short Dow30", -3)];
const DOW_LONG = [V("DIA", "SPDR Dow Jones Industrial Average ETF", 1)];
const SEMI_NOTE = "Follows a semiconductor index of its own, not SOXX itself, so the two can move apart.";
const SEMI_SHORT = [V("SSG", "ProShares UltraShort Semiconductors", -2, SEMI_NOTE), V("SOXS", "Direxion Daily Semiconductor Bear 3X", -3, SEMI_NOTE)];
const ENERGY_SHORT = [V("ERY", "Direxion Daily Energy Bear 2X", -2)];
const FIN_SHORT = [V("SKF", "ProShares UltraShort Financials", -2), V("FAZ", "Direxion Daily Financial Bear 3X", -3)];
const OIL_NOTE = "Follows an index of crude oil futures, not the exact contract Randy charts, so it can differ from it.";
const OIL_SHORT = [V("SCO", "ProShares UltraShort Bloomberg Crude Oil", -2, OIL_NOTE)];
const OIL_LONG = [V("USO", "United States Oil Fund", 1, "Holds front-month crude futures and can lag the contract when it rolls.")];
const T20_SHORT = [V("TBF", "ProShares Short 20+ Year Treasury", -1), V("TBT", "ProShares UltraShort 20+ Year Treasury", -2), V("TTT", "ProShares UltraPro Short 20+ Year Treasury", -3)];
const T10_SHORT = [V("TBX", "ProShares Short 7-10 Year Treasury", -1), V("PST", "ProShares UltraShort 7-10 Year Treasury", -2)];
const GOLD_SHORT = [V("GLL", "ProShares UltraShort Gold", -2, "Follows gold futures, so it can differ a little from the price Randy charts.")];
const SILVER_SHORT = [V("ZSL", "ProShares UltraShort Silver", -2, "Follows silver futures, so it can differ a little from the price Randy charts.")];
const MINERS_SHORT = [V("DUST", "Direxion Daily Gold Miners Index Bear 2X", -2)];
const NG_NOTE = "Natural gas funds follow futures and lose or gain from rolling contracts, so they can drift from the price Randy charts.";
const NG_SHORT = [V("KOLD", "ProShares UltraShort Bloomberg Natural Gas", -2, NG_NOTE)];
const NG_LONG = [V("UNG", "United States Natural Gas Fund", 1, NG_NOTE)];
const VIX_NOTE = "VIX funds hold VIX futures, not the VIX index, and lose value from rolling contracts, so they don't follow $VIX level for level. Randy's levels aren't converted; use your own from the fund's chart.";
const VIX_LONG = [V("VIXY", "ProShares VIX Short-Term Futures ETF", 1, VIX_NOTE, "manual"), V("VXX", "iPath Series B S&P 500 VIX Short-Term Futures ETN", 1, VIX_NOTE + " VXX is an ETN, a note from the bank that issues it.", "manual")];
const VIX_SHORT = [V("SVIX", "Short VIX Futures ETF (-1x)", -1, VIX_NOTE, "manual")];
const BASKET_NOTE = (name: string) => `A semiconductor basket, not ${name} alone. Randy's levels aren't converted; use your own from the fund's chart.`;

// Single-stock -1x bear ETFs (Direxion). [stock, ETF, the symbol in the fund's name]
const SINGLE: Array<[string, string, string]> = [
  ["AAPL", "AAPD", "AAPL"], ["MSFT", "MSFD", "MSFT"], ["AMZN", "AMZD", "AMZN"], ["GOOGL", "GGLS", "GOOGL"], ["GOOG", "GGLS", "GOOGL"], ["META", "METD", "META"],
  ["NVDA", "NVDD", "NVDA"], ["PLTR", "PLTD", "PLTR"], ["MU", "MUD", "MU"], ["AMD", "AMDD", "AMD"], ["TSLA", "TSLS", "TSLA"], ["ORCL", "ORCS", "ORCL"],
  ["AVGO", "AVS", "AVGO"], ["CSCO", "CSCS", "CSCO"], ["NFLX", "NFXS", "NFLX"], ["PANW", "PALD", "PANW"], ["QCOM", "QCMD", "QCOM"], ["TSM", "TSMZ", "TSM"],
];

interface Entry { short?: Vehicle[]; long?: Vehicle[] }
const MAP: Record<string, Entry> = {
  QQQ: { short: NDX_SHORT }, "/NQ": { short: NDX_SHORT, long: NDX_LONG }, "$NDX": { short: NDX_SHORT, long: NDX_LONG },
  SPY: { short: SPX_SHORT }, "/ES": { short: SPX_SHORT, long: SPX_LONG }, "$SPX": { short: SPX_SHORT, long: SPX_LONG },
  IWM: { short: RUT_SHORT }, "/RTY": { short: RUT_SHORT, long: RUT_LONG },
  DIA: { short: DOW_SHORT }, "/YM": { short: DOW_SHORT, long: DOW_LONG },
  SOXX: { short: SEMI_SHORT }, SMH: { short: SEMI_SHORT },
  XLE: { short: ENERGY_SHORT }, XLF: { short: FIN_SHORT },
  USO: { short: OIL_SHORT }, "/CL": { short: OIL_SHORT, long: OIL_LONG },
  TLT: { short: T20_SHORT }, "/ZB": { short: T20_SHORT }, IEF: { short: T10_SHORT },
  GLD: { short: GOLD_SHORT }, "/GC": { short: GOLD_SHORT, long: [V("GLD", "SPDR Gold Shares", 1)] },
  SLV: { short: SILVER_SHORT }, "/SI": { short: SILVER_SHORT, long: [V("SLV", "iShares Silver Trust", 1)] },
  GDX: { short: MINERS_SHORT },
  UNG: { short: NG_SHORT }, "/NG": { short: NG_SHORT, long: NG_LONG },
  "/HG": { long: [V("CPER", "United States Copper Index Fund", 1, "Follows copper futures, so it can differ a little from the price Randy charts.")] },
  "/ZW": { long: [V("WEAT", "Teucrium Wheat Fund", 1, "Holds wheat futures across several contracts, so it can differ from the front month Randy charts.")] },
  "/ZC": { long: [V("CORN", "Teucrium Corn Fund", 1, "Holds corn futures across several contracts, so it can differ from the front month Randy charts.")] },
  "/ZS": { long: [V("SOYB", "Teucrium Soybean Fund", 1, "Holds soybean futures across several contracts, so it can differ from the front month Randy charts.")] },
  "$VIX": { long: VIX_LONG, short: VIX_SHORT },
  ASML: { short: [V("SOXS", "Direxion Daily Semiconductor Bear 3X", -3, BASKET_NOTE("ASML"), "manual"), V("SSG", "ProShares UltraShort Semiconductors", -2, BASKET_NOTE("ASML"), "manual")] },
};
for (const [stock, etf, sym] of SINGLE) MAP[stock] = { short: [V(etf, `Direxion Daily ${sym} Bear 1X Shares`, -1)] };

const num = (x: unknown): number | null => { const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x; return typeof n === "number" && Number.isFinite(n) ? n : null; };
// The same pattern the RSOTC chart (SQL rsotc_tgts) uses to read a price out of a target that has only a note.
const ABOUT = /about\s+(\d+(?:\.\d+)?)/;

// All the stand-ins for a setup, as a copy the caller can't change. A setup placeable the ordinary way still gets its list (a short
// stock can be taken as its bear ETF); a long stock or ETF has none, because it is already an ordinary buy.
export function vehiclesFor(ticker: string, dir: Dir): Vehicle[] {
  const e = Object.prototype.hasOwnProperty.call(MAP, ticker) ? MAP[ticker] : undefined;
  return ((dir === "short" ? e?.short : e?.long) ?? []).filter((v) => v.t !== ticker).map((v) => ({ ...v }));
}
export const briefOf = (v: Vehicle): VehicleBrief => ({ t: v.t, name: v.name, lev: v.lev, kind: v.kind });
export function findVehicle(ticker: string, dir: Dir, vehicleTicker: unknown): Vehicle | null {
  if (typeof vehicleTicker !== "string") return null;
  const t = vehicleTicker.trim().toUpperCase();
  return vehiclesFor(ticker, dir).find((v) => v.t === t) ?? null;
}
// Every ticker that can ever be a stand-in, so a price lookup can be limited to ones we know.
export function allVehicleTickers(): string[] {
  const s = new Set<string>();
  for (const e of Object.values(MAP)) for (const v of [...(e.short ?? []), ...(e.long ?? [])]) s.add(v.t);
  return [...s].sort();
}

// ── converting a level ──
// null when it can't be done honestly: a missing or non-positive price, or a move so large the ETF's line would reach zero.
export function convertLevel(level: number | null | undefined, pU: number | null | undefined, pV: number | null | undefined, lev: number): number | null {
  const x = num(level), u = num(pU), w = num(pV);
  if (x == null || u == null || w == null || x <= 0 || u <= 0 || w <= 0 || !Number.isFinite(lev) || lev === 0) return null;
  const f = 1 + lev * (x / u - 1);
  if (!(f > 0)) return null;
  const out = schwabTick(w * f);
  return out > 0 ? out : null;
}

// Randy's targets on the ETF. A price converts to a price; a zone converts both edges and is put back in order (an inverse ETF turns the
// zone upside down). A target that can't be converted keeps its label and note but has no price.
export function convertTargets(raw: unknown, pU: number, pV: number, lev: number): RawTarget[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawTarget[]).filter((t) => t && typeof t === "object").map((t, i) => {
    const out: RawTarget = { label: t.label ?? `T${i + 1}`, hit: t.hit ?? null, potential: !!t.potential, note: t.note ?? "" };
    const p = num(t.price), lo = num(t.low), hi = num(t.high);
    if (p != null) { const c = convertLevel(p, pU, pV, lev); if (c != null) out.price = c; }
    if (lo != null && hi != null) {
      const a = convertLevel(lo, pU, pV, lev), b = convertLevel(hi, pU, pV, lev);
      if (a != null && b != null) { out.low = Math.min(a, b); out.high = Math.max(a, b); }
    }
    // A target Randy only described ("about 650") is a price too: the RSOTC chart reads it from the note, so the converted note is
    // rewritten with the converted number. If it can't be converted the note is cleared, so nothing on the underlying's scale is read
    // as a price on the ETF's.
    if (p == null && !(lo != null && hi != null)) {
      const m = ABOUT.exec(String(t.note ?? ""));
      if (m) { const c = convertLevel(Number(m[1]), pU, pV, lev); out.note = c != null ? `about ${c}` : ""; }
    }
    return out;
  });
}

// Randy's setup row as the ETF trade it becomes: the ETF's ticker, always a LONG (you buy the ETF), his levels converted. The id,
// status, dates and history stay his. His free-text notes stay as he wrote them: they are about the underlying.
// deno-lint-ignore no-explicit-any
export function vehicleRow(row: any, v: Vehicle, pU: number | null | undefined, pV: number | null | undefined): any {
  const u = num(pU), w = num(pV);
  const can = v.kind === "convert" && u != null && w != null && u > 0 && w > 0;
  const c = (x: unknown) => (can ? convertLevel(num(x), u, w, v.lev) : null);
  return {
    ...row, ticker: v.t, direction: "long", entry_price: c(row.entry_price), stop: c(row.stop), invalidation: c(row.invalidation),
    targets: can ? convertTargets(row.targets, u as number, w as number, v.lev) : [],
  };
}

// ── what to tell the person about it (short, factual) ──
export const fmtLev = (lev: number) => `${lev < 0 ? "−" : ""}${Math.abs(lev)}×`;

export function cautionsFor(v: Vehicle, underlying: string): string[] {
  const out: string[] = [];
  if (v.lev !== 1) {
    out.push(`${v.t} aims for ${fmtLev(v.lev)} the daily move of ${v.kind === "manual" ? "its benchmark" : underlying}. It resets every day, so over more than a day the result can differ a lot from that multiple.`);
  }
  if (v.note) out.push(v.note);
  return out;
}

// One line saying how the numbers were made.
export function convertedNote(v: Vehicle, underlying: string, pU: number | null, pV: number | null): string {
  if (v.kind === "manual") return `Randy's ${underlying} levels aren't converted for ${v.t}. Enter your own from its chart.`;
  if (pU == null || pV == null) return `Couldn't get a price for ${pU == null ? underlying : v.t} just now, so Randy's levels aren't converted. Try again in a minute, or enter your own.`;
  return `Randy's ${underlying} levels converted to ${v.t} at today's prices (${underlying} ${pU}, ${v.t} ${pV}). They're estimates, not levels Randy gave for ${v.t}.`;
}

// ── the RSOTC chart, for the ETF (Nov 17 2026, Dave: "estimate for the ETF the same stop, entry, T1, T2, T3 below the RSOTC chart") ──
// The chart text itself is drawn by the same SQL the alerts use (rsotc_ladder), fed a copy of Randy's row turned into the ETF trade
// (vehicleRow): so what is drawn for the ETF is exactly what would be drawn for a long in that fund with those levels. These two
// functions only get the row ready for that SQL and read the levels back out, in the SQL's own terms (rsotc_tgts).
interface PricedTarget { label?: unknown; price?: unknown; low?: unknown; high?: unknown; hit?: unknown; potential?: unknown; note?: unknown }
const hasPrice = (t: PricedTarget) => num(t.price) != null || (num(t.low) != null && num(t.high) != null) || ABOUT.test(String(t.note ?? ""));

export interface FeedRow { ticker: string; direction: "long"; status: string; entry_price: number | null; stop: number | null; invalidation: number | null; targets: PricedTarget[] }
// The row the SQL gets. Targets with no price at all are left out, and a `hit` that is empty is removed (the SQL reads the mere presence
// of the key as "hit").
// deno-lint-ignore no-explicit-any
export function etfFeedRow(row: any): FeedRow {
  const targets = (Array.isArray(row.targets) ? row.targets as PricedTarget[] : []).filter((t) => t && typeof t === "object" && hasPrice(t)).map((t) => {
    const o: PricedTarget = { ...t };
    if (!o.hit) delete o.hit;
    return o;
  });
  return { ticker: String(row.ticker), direction: "long", status: String(row.status ?? ""), entry_price: num(row.entry_price), stop: num(row.stop), invalidation: num(row.invalidation), targets };
}

export interface LevelTarget { label: string; p: number; low: number | null; high: number | null; approx: boolean; hit: boolean; potential: boolean }
// Each target with a price, as the chart reads it: a plain price, a zone (low and high; p is the low edge, the near one for a long), or an
// "about N" note (approx). hit = Randy marked it hit, or his status says "T2 hit" and this is T1 or T2.
export function levelsOf(raw: unknown, status: string): LevelTarget[] {
  const nh = /^T(\d+) hit/.exec(status || "");
  const nhit = nh ? Number(nh[1]) : 0;
  if (!Array.isArray(raw)) return [];
  const out: LevelTarget[] = [];
  (raw as PricedTarget[]).forEach((t, i) => {
    if (!t || typeof t !== "object") return;
    const price = num(t.price), lo = num(t.low), hi = num(t.high);
    const label = String(t.label ?? `T${i + 1}`).slice(0, 20);
    const tn = /^T(\d+)$/.exec(label);
    const hit = !!t.hit || (tn != null && Number(tn[1]) <= nhit);
    const potential = !!t.potential;
    if (price != null) out.push({ label, p: price, low: null, high: null, approx: false, hit, potential });
    else if (lo != null && hi != null) out.push({ label, p: Math.min(lo, hi), low: Math.min(lo, hi), high: Math.max(lo, hi), approx: false, hit, potential });
    else { const m = ABOUT.exec(String(t.note ?? "")); if (m) out.push({ label, p: Number(m[1]), low: null, high: null, approx: true, hit, potential }); }
  });
  return out;
}
