// ============================================================
// Prices for the rsotc-act function (no Deno-only calls, so it can be unit tested).
// The same Yahoo "spark" lookup the brief-markets function and the RSOTC alerts task use, with a one-minute memory per ticker.
// ============================================================

// Our tickers -> Yahoo symbols (the same map the alerts task uses). Anything else is the ticker without a leading $.
const YMAP: Record<string, string> = {
  "/CL": "CL=F", "/NQ": "NQ=F", "/ES": "ES=F", "/GC": "GC=F", "/SI": "SI=F", "/HG": "HG=F", "/NG": "NG=F", "/ZB": "ZB=F",
  "/RTY": "RTY=F", "/YM": "YM=F", "$VIX": "^VIX", "$SPX": "^GSPC", "$NDX": "^NDX", "$DXY": "DX-Y.NYB", "$TNX": "^TNX",
};
export const yahooSymbol = (t: string) => YMAP[t] ?? t.replace(/^\$/, "");

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

// One call per 15 symbols, in parallel, each given 5 seconds. A symbol that doesn't answer is simply left out.
export async function fetchPrices(tickers: string[], fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<Record<string, number>> {
  const bySym = new Map<string, string>();
  for (const t of tickers) bySym.set(yahooSymbol(t), t);
  const syms = [...bySym.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < syms.length; i += 15) chunks.push(syms.slice(i, i + 15));
  const out: Record<string, number> = {};
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const url = "https://query1.finance.yahoo.com/v7/finance/spark?range=1d&interval=5m&symbols=" + encodeURIComponent(chunk.join(","));
      const res = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const body = await res.json() as { spark?: { result?: Array<{ symbol: string; response?: Array<{ meta?: { regularMarketPrice?: number } }> }> } };
      for (const r of body?.spark?.result ?? []) {
        const p = r.response?.[0]?.meta?.regularMarketPrice;
        const ours = bySym.get(r.symbol);
        if (ours && typeof p === "number" && isFinite(p)) out[ours] = Math.round(p * 100) / 100;
      }
    } catch (e) { console.error("quotes", (e as Error).message); }
  }));
  return out;
}

// Prices stay for a minute, so a few page loads or ticket edits in a row make one trip to Yahoo.
const memory = new Map<string, { at: number; price: number }>();
const TTL_MS = 60_000;
export async function pricesFor(tickers: string[], now = Date.now(), fetchFn?: FetchLike): Promise<Record<string, number>> {
  const want = [...new Set(tickers)];
  const stale = want.filter((t) => { const m = memory.get(t); return !m || now - m.at >= TTL_MS; });
  if (stale.length) {
    const got = await fetchPrices(stale, fetchFn);
    for (const [t, p] of Object.entries(got)) memory.set(t, { at: now, price: p });
  }
  const out: Record<string, number> = {};
  for (const t of want) { const m = memory.get(t); if (m && now - m.at < TTL_MS * 30) out[t] = m.price; }   // a price up to 30 minutes old beats none when Yahoo is down
  return out;
}
export const forgetPrices = () => memory.clear();

// "prices 10:08 AM CT" while the market is open, "prices as of last close" before 8:30 AM, after 3:00 PM and on weekends.
export function priceNote(now: Date, gotPrices: boolean): string {
  if (!gotPrices) return "prices unavailable right now";
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  const weekday = !["Sat", "Sun"].includes(get("weekday"));
  if (!weekday || mins < 8 * 60 + 30 || mins >= 15 * 60) return "prices as of last close";
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(now).replace(/\s/g, " ");
  return `prices ${t} CT`;
}
