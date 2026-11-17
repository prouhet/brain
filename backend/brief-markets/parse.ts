// ============================================================
// Pure helpers for the brief-markets function (no Deno or network calls, so they can be unit tested).
// Turn the TSP and Hard Asset morning-brief text into the few lines Dave acts on,
// and turn an rsotc_setups row into something a card can print.
// Nothing here invents a number: every figure shown is copied from the brief text or the table row.
// ============================================================

export interface Section { label: string; lines: string[] }
export interface BriefParsed {
  brief_date: string | null;       // date found in the brief's own heading (the caller's stored date wins)
  as_of: string | null;            // TSP: the close the prices are from
  tag: string;                     // MOVE / WAIT / HOLD, or the Hard Asset verb ("WAIT FOR STABILITY")
  tone: "act" | "quiet" | "info";  // act = something to do today
  headline: string;                // one line, shown while the card is folded
  sections: Section[];             // what opens first
  full: string;                    // the whole brief, tidied
}

// Gmail rewrites links as https://www.google.com/url?q=<real link>&source=gmail&ust=...&sa=E — put the real link back.
const GOOGLE_URL = /https?:\/\/www\.google\.com\/url\?q=([^&\s)]+)(?:&[A-Za-z_]+=[A-Za-z0-9_%.\-]*)*/g;

export function cleanBody(s: string): string {
  return String(s ?? "").replace(/\r/g, "")
    .replace(GOOGLE_URL, (_m, q: string) => { try { return decodeURIComponent(q).replace(/^https?:\/\//, ""); } catch { return q; } })
    .trim();
}

const bare = (s: string) => s.replace(/\*\*/g, "").replace(/^#+\s*/, "").trim();
const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

// ── TSP ──────────────────────────────────────────────────────
// Boundaries between the labelled lines of the TSP brief.
const TSP_LABEL = /^[\s◎◆◇▣⑧*]*(Plan|Volatility|You|Your notes|Weekly heads-up|Funds|Randy|Watch today|Macro voices|Note|Signal from)\b/i;
const tspLabel = (l: string): string | null => { const m = l.match(TSP_LABEL); return m ? m[1].toLowerCase() : null; };
const tspClean = (l: string) => l.replace(/^[\s◎◆◇▣⑧*]+/, "").trim();

export function parseTsp(raw: string): BriefParsed {
  const full = cleanBody(raw);
  const lines = full.split("\n");
  const head = lines.find((l) => /MORNING BRIEF/i.test(l)) ?? "";
  const dates = head.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const out: BriefParsed = { brief_date: dates[0] ?? null, as_of: dates[1] ?? null, tag: "", tone: "info", headline: "", sections: [], full };

  const si = lines.findIndex((l) => /^[\s*]*★/.test(l));
  if (si >= 0) {
    const m = lines[si].match(/★\s*\**(HOLD|WAIT|MOVE)\**\s*(.*)$/);
    if (m) {
      out.tag = m[1]; out.tone = m[1] === "MOVE" ? "act" : "quiet";
      out.headline = m[2].replace(/^\s*[:—–-]\s*/, "").replace(/\*\*/g, "").trim();
    } else {
      out.headline = bare(lines[si].replace(/^[\s*]*★/, ""));
    }
    // The directive can run onto the next lines (an extra caveat) until a blank line or the next labelled line.
    const doNow = [bare(lines[si].replace(/^[\s*]*★\s*/, ""))];
    for (let i = si + 1; i < lines.length && lines[i].trim() && !tspLabel(lines[i]); i++) doNow.push(bare(lines[i]));
    out.sections.push({ label: "Do now", lines: doNow });
  } else {
    out.headline = bare(lines.find((l, i) => i > 0 && l.trim()) ?? "");
  }

  // Where he stands: his holdings against the target, the plan line with the next levels, volatility.
  const stand: string[] = [];
  for (const want of ["you", "plan", "volatility"]) {
    const l = lines.find((x) => tspLabel(x) === want);
    if (l) stand.push(bare(tspClean(l)));
  }
  if (stand.length) out.sections.push({ label: "Where you stand", lines: stand });

  // His own reminders from TSP_Plan.md.
  const ni = lines.findIndex((l) => tspLabel(l) === "your notes");
  if (ni >= 0) {
    const notes: string[] = [];
    for (let i = ni + 1; i < lines.length && lines[i].trim(); i++) notes.push(bare(lines[i]).replace(/^[-•]\s*/, "- "));
    if (notes.length) out.sections.push({ label: "Your notes", lines: notes.map((n) => (n.startsWith("- ") ? n : `- ${n}`)) });
  }
  return out;
}

// ── Hard Asset ───────────────────────────────────────────────
export function parseHardAsset(raw: string): BriefParsed {
  const full = cleanBody(raw);
  const lines = full.split("\n");
  const plain = lines.map(bare);
  const head = plain.find((l) => /MORNING BRIEF/i.test(l)) ?? "";
  let brief_date: string | null = null;
  const dm = head.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (dm && MONTHS[dm[1].toLowerCase()]) brief_date = `${dm[3]}-${MONTHS[dm[1].toLowerCase()]}-${dm[2].padStart(2, "0")}`;
  const iso = head.match(/\d{4}-\d{2}-\d{2}/);
  if (!brief_date && iso) brief_date = iso[0];
  const out: BriefParsed = { brief_date, as_of: null, tag: "", tone: "info", headline: "", sections: [], full };

  const ai = plain.findIndex((l) => /^★?\s*ACTION\s*:/i.test(l));
  if (ai >= 0) {
    const text = plain[ai].replace(/^★?\s*ACTION\s*:\s*/i, "");
    const cut = text.search(/\s[—–]\s/);
    if (cut > 0) { out.tag = text.slice(0, cut).trim(); out.headline = text.slice(cut).replace(/^\s*[—–]\s*/, "").trim(); }
    else { out.tag = text.split(/[.,(]/)[0].trim().slice(0, 40); out.headline = text; }
    out.tone = /^(BUY NOW|CONVERT|DEFENSIVE)/i.test(out.tag) ? "act" : "quiet";
    const doNow = [text];
    const why = plain.find((l) => /^Why\s*:/i.test(l)); if (why) doNow.push(why);
    const flips = plain.find((l) => /^Flips if\s*:/i.test(l)); if (flips) doNow.push(flips);
    out.sections.push({ label: "Do now", lines: doNow });
  } else {
    out.headline = plain.find((l, i) => i > 0 && l && !l.startsWith("---")) ?? "";
  }

  const plan = plain.find((l) => /^BUY PLAN/i.test(l));
  if (plan) out.sections.push({ label: "This month's buy plan", lines: [plan] });

  const yi = plain.findIndex((l) => /^YOUR STACK/i.test(l));
  if (yi >= 0) {
    const stack: string[] = [];
    for (let i = yi + 1; i < plain.length; i++) {
      const l = plain[i];
      if (!l) { if (stack.length) break; else continue; }
      if (/^(STANCE|---)/i.test(l) || lines[i].startsWith("#")) break;
      stack.push(l.startsWith("-") ? l : `- ${l}`);
    }
    if (stack.length) out.sections.push({ label: "Your stack", lines: stack });
  }

  const stance = plain.filter((l) => /^(STANCE|Key level)\s*:/i.test(l));
  if (stance.length) out.sections.push({ label: "Where the market stands", lines: stance });
  return out;
}

// ── RSOTC setups ─────────────────────────────────────────────
export interface TargetOut { text: string; hit: string | null; potential: boolean }
export interface SetupOut {
  id: string; ticker: string; direction: string; tf: string | null; status: string;
  entry: string | null; entry_note: string | null; stop: string | null; stop_note: string | null;
  targets: TargetOut[]; notes: string | null; link: string | null;
  changed: string | null; last_event: string | null; fresh: boolean;
}

export function fmtTarget(t: Record<string, unknown>): TargetOut {
  const label = t.label != null ? String(t.label) : "";
  let lvl = "";
  if (t.low != null && t.high != null) lvl = `${t.low}–${t.high}`;
  else if (t.price != null) lvl = String(t.price);
  const note = t.note != null ? String(t.note) : "";
  let text = [label, lvl].filter(Boolean).join(" ");
  if (!lvl && note) text += ` (${note})`;
  return { text: text || "target", hit: t.hit != null ? String(t.hit) : null, potential: t.potential === true };
}

const cut = (s: unknown, n: number): string | null => {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

export function addDays(d: string, n: number): string {
  const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}

// deno-lint-ignore no-explicit-any
export function setupOut(row: any, today: string): SetupOut {
  const hist = Array.isArray(row.history) ? row.history : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  const changed = last && typeof last.at === "string" ? last.at : null;
  const targets = (Array.isArray(row.targets) ? row.targets : []).map((t: Record<string, unknown>) => fmtTarget(t || {}));
  return {
    id: String(row.id), ticker: String(row.ticker), direction: String(row.direction), tf: row.chart_timeframe ?? null,
    status: String(row.status),
    entry: row.entry_price != null ? String(row.entry_price) : null,
    entry_note: cut(row.entry_note, 500),
    stop: row.stop != null ? String(row.stop) : null,
    stop_note: cut(row.stop_note, 300),
    targets, notes: cut(row.notes, 700),
    link: typeof row.post_link === "string" && /^https?:\/\//.test(row.post_link) ? row.post_link : null,
    changed, last_event: cut(last && last.event, 300),
    fresh: !!changed && changed >= addDays(today, -1),
  };
}

// Freshly changed first, then the rest A to Z.
export function sortSetups(list: SetupOut[]): SetupOut[] {
  return [...list].sort((a, b) =>
    (a.fresh === b.fresh ? 0 : a.fresh ? -1 : 1) ||
    (a.fresh && b.fresh ? (b.changed || "").localeCompare(a.changed || "") : 0) ||
    a.ticker.localeCompare(b.ticker));
}
