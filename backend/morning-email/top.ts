// Pure helpers for the morning-email function. No Deno or network calls in here, so they can be tested in Node.
// They build the "Calm-style" top of the 5:30 AM email: an Open today's page button, then Pinned, the next
// task of each project, quick wins and what is coming up. The numbered printout from morning-brief stays underneath.

const TEAL = "#00778B";

export interface Task { id: string; title: string; due?: string | null; due_in?: number | null; next?: string }
export interface Project {
  key: string; name: string; now?: { n: number; name?: string } | null; then?: string;
  tasks: Task[]; due?: string | null; due_in?: number | null; open?: number; picked?: boolean;
}
export interface Lanes {
  projects?: Project[]; skipped?: string[]; quick?: Task[]; coming?: Task[];
  rep?: { ask?: string; result?: string };
}
export interface Focus { pinned?: Task[] }

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const clip = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function shortDate(d: string): string {
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function dueText(t: { due?: string | null; due_in?: number | null }): string {
  if (!t.due || t.due_in === null || t.due_in === undefined) return "";
  const n = t.due_in;
  return n < 0 ? `Late · ${shortDate(t.due)}` : n === 0 ? "Due today" : n === 1 ? "Due tomorrow" : `Due ${shortDate(t.due)}`;
}
function dayLabel(t: { due?: string | null; due_in?: number | null }): string {
  if (!t.due) return "";
  const n = t.due_in ?? 0;
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : shortDate(t.due);
}

const head = (label: string) =>
  `<div style="margin:14px 0 2px;font-weight:600;font-size:14px">${label}</div>`;
const grey = (s: string) => `<span style="color:#666;font-size:12px">${s}</span>`;
const rows = (cells: string[]) =>
  `<table role="presentation" style="border-collapse:collapse;width:100%;font-size:14px">${cells.map((c) =>
    `<tr><td style="width:16px;padding:3px 0;vertical-align:top;color:${TEAL}">•</td><td style="padding:3px 0;vertical-align:top">${c}</td></tr>`).join("")}</table>`;
const more = (n: number) => (n > 0 ? `<div style="font-size:12px;color:#666;margin:2px 0 0 16px">+ ${n} more on the page</div>` : "");

export interface Top { button: string; focus: string }

export function buildTop(lanes: Lanes | null, focus: Focus | null, link: string): Top {
  const button = `
    <table role="presentation" style="border-collapse:collapse;margin:16px 0 0"><tr>
      <td style="background:${TEAL};border-radius:8px"><a href="${esc(link)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none">Open today's page</a></td>
    </tr></table>
    <div style="font-size:12px;color:#666;margin-top:6px">Pick what goes on your day and check things off there. The numbered list at the bottom is the printout.</div>`;

  const pinned = (focus?.pinned || []).filter((t) => t && t.title);
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const parts: string[] = [];

  if (pinned.length) {
    parts.push(head("📌 Pinned") + rows(pinned.map((t) => {
      const d = dueText(t);
      return `<b>${esc(clip(t.title))}</b>${d ? ` ${grey(esc(d))}` : ""}${t.next ? `<div style="font-size:12px;color:#444">Next: ${esc(clip(t.next, 140))}</div>` : ""}`;
    })));
  }

  const ask = lanes?.rep?.ask;
  if (ask) parts.push(`<div style="margin:14px 0 0;font-size:14px"><b>Today's marketing ask:</b> ${esc(ask)}</div>`);

  const skipped = new Set(lanes?.skipped || []);
  let projects = (lanes?.projects || []).filter((p) => !skipped.has(p.key));
  if (projects.some((p) => p.picked)) projects = projects.filter((p) => p.picked);
  const shownProjects = projects.map((p) => ({ p, next: (p.tasks || []).find((t) => !pinnedIds.has(t.id)) })).filter((x) => x.next);
  if (shownProjects.length) {
    const cap = 5;
    parts.push(head("Pick your next move") + rows(shownProjects.slice(0, cap).map(({ p, next }) => {
      const d = dueText(p);
      const nowName = p.now ? (p.now.name || `Step ${p.now.n}`) : "";
      return `<b>${esc(p.name)}</b>${d ? ` ${grey(esc(d))}` : ""}`
        + `<div style="font-size:13px;color:#444">${nowName ? `Now: ${esc(nowName)}${p.open ? ` · ${p.open} left` : ""}` : ""}</div>`
        + `<div style="font-size:14px"><span style="color:${TEAL};font-weight:600">Up next:</span> ${esc(clip(next!.title))}</div>`;
    })) + more(shownProjects.length - cap));
  }

  const quick = (lanes?.quick || []).filter((t) => !pinnedIds.has(t.id));
  if (quick.length) {
    const cap = 6;
    parts.push(head("Quick wins") + rows(quick.slice(0, cap).map((t) => {
      const d = dueText(t);
      return `${esc(clip(t.title))}${d ? ` ${grey(esc(d))}` : ""}`;
    })) + more(quick.length - cap));
  }

  const coming = (lanes?.coming || []).filter((t) => !pinnedIds.has(t.id));
  if (coming.length) {
    const cap = 8;
    parts.push(head("Coming up · next 10 days") + rows(coming.slice(0, cap).map((t) =>
      `${grey(esc(dayLabel(t)))} ${esc(clip(t.title))}`)) + more(coming.length - cap));
  }

  const focusHtml = parts.length
    ? `<h2 style="font-size:15px;margin:22px 0 0;color:${TEAL}">Today's focus</h2>${parts.join("")}`
    : "";
  return { button, focus: focusHtml };
}

// Put the two pieces into the email morning-brief built, at known landmarks. A landmark that isn't found is skipped
// (and named in `notes`), so the email still goes out.
export function inject(html: string, top: Top): { html: string; notes: string[] } {
  const notes: string[] = [];
  let out = html;
  const sched = `<h2 style="font-size:15px;margin:20px 0 4px;color:${TEAL}">Today's schedule</h2>`;
  const todo = `<h2 style="font-size:15px;margin:22px 0 0;color:${TEAL}">To do</h2>`;
  if (out.includes(sched)) out = out.replace(sched, top.button + "\n    " + sched); else notes.push("schedule landmark missing: button not added");
  if (top.focus) {
    if (out.includes(todo)) out = out.replace(todo, top.focus + "\n    " + todo); else notes.push("to-do landmark missing: focus block not added");
  }
  // morning-brief's note about older overdue tasks still points at the Priorities page, which was deleted on Nov 23.
  out = out.replace("them on your priorities page", "them in Past due on today's page");
  return { html: out, notes };
}

export function htmlToText(html: string, link: string): string {
  const t = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|p|div|h2|h1|table)>/gi, "\n")
    .replace(/<\/td>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return `${t}\n\nOpen today's page: ${link}`;
}
