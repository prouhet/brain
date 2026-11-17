// ============================================================
// RSOTC board helpers for the brief-markets function (no Deno-only calls, so they can be unit tested).
//
// The RSOTC setup alerts task draws Dave a "board" with the SQL function rsotc_board(prices): TOP RR NOW,
// NEEDS ATTENTION, then every open setup as a few lines plus a price-line picture. The page shows the same board,
// so this file does two things: get today's prices the way that task does (Yahoo spark), and cut the function's
// text into pieces the page can lay out. Nothing is re-ranked or re-worded here: every line is the function's own.
// ============================================================

// Our tickers -> Yahoo symbols (the same map the alerts task uses). Anything else is the ticker without a leading $.
const YMAP: Record<string, string> = {
  "/CL": "CL=F", "/NQ": "NQ=F", "/ES": "ES=F", "/GC": "GC=F", "/SI": "SI=F", "/HG": "HG=F", "/NG": "NG=F", "/ZB": "ZB=F",
  "/RTY": "RTY=F", "/YM": "YM=F", "$VIX": "^VIX", "$SPX": "^GSPC", "$NDX": "^NDX", "$DXY": "DX-Y.NYB", "$TNX": "^TNX",
};
export const yahooSymbol = (t: string) => YMAP[t] ?? t.replace(/^\$/, "");

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

// One call per 15 symbols, in parallel, each given 5 seconds. A symbol that doesn't answer is simply left out;
// the board draws without a "now" marker for it.
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

// "prices 10:08 AM CT" while the market is open, "prices as of last close" before 8:30 AM, after 3:00 PM and on weekends.
export function priceNote(now: Date, gotPrices: boolean): string {
  if (!gotPrices) return "prices unavailable right now";
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  const weekday = !["Sat", "Sun"].includes(get("weekday"));
  if (!weekday || mins < 8 * 60 + 30 || mins >= 15 * 60) return "prices as of last close";
  // Newer runtimes put a narrow no-break space (U+202F) before AM/PM; make it an ordinary space so the text matches everywhere.
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(now).replace(/\s/g, " ");
  return `prices ${t} CT`;
}

// ── Cutting the board text into pieces ───────────────────────
export interface BoardItem {
  id: string | null;               // the matching rsotc_setups row, so the page can add Randy's notes under it
  ticker: string; direction: string; watch: boolean;
  head: string;                    // **SLV long** · open · RR ≈0.5/2.0 · now 1.3/3.5
  lines: string[];                 // the key line (stop, now, entry, targets) and any "★ You:" lines
  ladder: string;                  // the price-line picture, without its backticks
}
export interface BoardGroup { key: string; title: string; items: BoardItem[] }
export interface BoardTop { ticker: string; direction: string; line: string; rr_next: number | null; rr_final: number | null }
import type { Bets } from "./bets.ts";
export interface Board {
  note: string; prices_ok: boolean;
  top: BoardTop[]; top_note: string;
  attention: string[];
  groups: BoardGroup[];
  mine: Array<{ title: string; lines: string[] }>;
  legend: string;
  bets?: Bets | null;              // "By bet": the setups grouped by what they bet on (bets.ts); absent if it couldn't be built
}

const HEADER = /^━━ (.+?) ━━\s*$/;
const GROUP_KEYS: Record<string, string> = { "OPEN · LONG": "open-long", "OPEN · SHORT": "open-short", "WATCHING · LONG": "watch-long", "WATCHING · SHORT": "watch-short" };

export function parseBoard(raw: string, note = "", pricesOk = true): Board {
  let text = String(raw ?? "").replace(/\r/g, "").trim();
  let legend = "";
  const li = text.indexOf("How to read a line:");
  if (li >= 0) { legend = text.slice(li).trim(); text = text.slice(0, li).trim(); }

  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(HEADER);
    if (m) sections.push({ title: m[1], lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
  }

  const board: Board = { note, prices_ok: pricesOk, top: [], top_note: "", attention: [], groups: [], mine: [], legend };
  for (const s of sections) {
    const body = s.lines.map((l) => l.trimEnd());
    if (s.title === "TOP RR NOW") {
      for (const l of body) {
        const m = l.match(/^\d+\.\s+(.*)$/);
        if (m) {
          const hd = m[1].match(/^\*\*(.+?) (long|short)\*\*/);
          const rr = m[1].match(/now RR ([\d.]+)\/([\d.]+)/);
          board.top.push({ ticker: hd ? hd[1] : "", direction: hd ? hd[2] : "", line: m[1], rr_next: rr ? Number(rr[1]) : null, rr_final: rr ? Number(rr[2]) : null });
        } else if (/^_.*_$/.test(l.trim())) board.top_note = l.trim().slice(1, -1);
      }
    } else if (s.title === "NEEDS ATTENTION") {
      board.attention = body.filter((l) => l.trim());
    } else if (GROUP_KEYS[s.title]) {
      const items: BoardItem[] = [];
      for (const blk of body.join("\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
        const lines = blk.split("\n");
        const head = lines[0];
        const hd = head.match(/^\*\*(.+?) (long|short)\*\*/);
        if (!hd) continue;
        let ladder = "";
        const rest: string[] = [];
        for (const l of lines.slice(1)) {
          const lm = l.match(/^`(.*)`$/);
          if (lm) ladder = lm[1]; else rest.push(l);
        }
        items.push({ id: null, ticker: hd[1], direction: hd[2], watch: s.title.startsWith("WATCHING"), head, lines: rest, ladder });
      }
      board.groups.push({ key: GROUP_KEYS[s.title], title: s.title, items });
    } else {
      const lines = body.filter((l) => l.trim());
      if (lines.length) board.mine.push({ title: s.title, lines });
    }
  }
  return board;
}

// Match each board entry to its rsotc_setups row (ticker + direction + watch or open) so Randy's notes can sit under it.
export function attachIds(board: Board, setups: Array<{ id: string; ticker: string; direction: string; status: string }>): void {
  const used = new Set<string>();
  for (const g of board.groups) for (const it of g.items) {
    const hit = setups.find((s) => !used.has(s.id) && s.ticker === it.ticker && s.direction === it.direction && (s.status === "watch") === it.watch);
    if (hit) { it.id = hit.id; used.add(hit.id); }
  }
}

// One line for the folded card: the best three by RR now, and how many need a look.
export function boardHeadline(board: Board): string {
  const top = board.top.slice(0, 3).filter((t) => t.ticker).map((t) => `${t.ticker} ${t.direction}${t.rr_final != null ? ` ${t.rr_next ?? "?"}/${t.rr_final}` : ""}`);
  const parts: string[] = [];
  if (top.length) parts.push(`Best RR now: ${top.join(", ")}`);
  if (board.attention.length) parts.push(`${board.attention.length} to check`);
  return parts.join(" · ");
}
