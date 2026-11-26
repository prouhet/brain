// ============================================================
// STUDIO STRONG BRAIN: Morning Email v1 (Nov 26, 2026)
// ============================================================
// The 5:30 AM cron calls this instead of morning-brief. It does not replace morning-brief: it asks morning-brief to
// build the day's brief and the numbered printout (send=0, nothing is emailed), adds a Calm-style top to that email
// (an Open today's page button, then Pinned, the next task of each project, quick wins and what is coming up, read
// live from brief-focus and brief-lanes), and sends it.
//
// If ANY part of the new top fails (a slow or broken function, a changed layout), the email goes out without that
// part. If building or sending fails here, it falls back to calling morning-brief the old way, which builds and
// sends the plain email. So a problem in this file can only cost the new top, never the morning email.
//
//   POST ?key=BRIEF_TRIGGER_KEY[&send=0][&date=YYYY-MM-DD]
//        send=0 -> build and return the finished HTML; do not email (preview). The same call morning-brief makes.
//        dry=1  -> test only: skip morning-brief (it would rebuild and re-save the day's brief) and use a stand-in
//                  email, so the new top can be checked against the live lists. Always returns HTML, never emails.
//
// Secrets (project-wide, all already set): SUPABASE_URL, BRIEF_TRIGGER_KEY, BRIEF_PAGE_KEY, POSTMARK_SERVER_TOKEN.
// Optional: BRIEF_TO (default prouhet@gmail.com in the deployed copy, blank in this public one), BRIEF_PAGE_URL.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import QRCode from "npm:qrcode@1.5.4";
import { buildTop, htmlToText, inject, type Focus, type Lanes } from "./top.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL   = env("SUPABASE_URL");
const TRIGGER_KEY    = env("BRIEF_TRIGGER_KEY");
const PAGE_KEY       = env("BRIEF_PAGE_KEY");
const POSTMARK_TOKEN = env("POSTMARK_SERVER_TOKEN");
const TO_EMAIL       = env("BRIEF_TO", "");
const PAGE_URL       = env("BRIEF_PAGE_URL", "https://reelcall.app/brief.html");
const FROM_EMAIL     = "connect@studiostrong.fit";
const TZ             = "America/Chicago";
const BUILD_MS       = 100_000;  // morning-brief's own build (it calls Claude, the calendar, dids and Jev)
const TOP_MS         = 12_000;   // each of the two live reads for the new top

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const todayCentral = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const longDate = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const pageLink = (date: string) => `${PAGE_URL}?key=${encodeURIComponent(PAGE_KEY)}&date=${date}`;
// Stand-in for morning-brief's email (dry=1 only): just the two landmarks the new top is placed between.
const STAND_IN = `<html><body><div>
  <h2 style="font-size:15px;margin:20px 0 4px;color:#00778B">Today's schedule</h2><p>(stand-in)</p>
  <h2 style="font-size:15px;margin:22px 0 0;color:#00778B">To do</h2><p>(stand-in)</p></div></body></html>`;
const fn = (name: string, q: string) => `${SUPABASE_URL}/functions/v1/${name}?${q}`;

async function readLive<T>(name: string): Promise<T | null> {
  try {
    const r = await fetch(fn(name, `key=${encodeURIComponent(PAGE_KEY)}`), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }), signal: AbortSignal.timeout(TOP_MS),
    });
    if (!r.ok) { console.error(name, "list failed", r.status); return null; }
    const d = await r.json();
    return d && d.ok !== false ? (d as T) : null;
  } catch (e) { console.error(name, "list error", (e as Error).message); return null; }
}

// The old email, exactly as before: morning-brief builds, saves and sends it.
async function oldWay(date: string, why: string) {
  console.error("falling back to the plain morning-brief email:", why);
  const r = await fetch(fn("morning-brief", `key=${encodeURIComponent(TRIGGER_KEY)}&date=${date}`), { method: "POST" });
  if (!r.ok) throw new Error(`morning-brief ${r.status}: ${await r.text()}`);
  return json({ ok: true, date, fallback: why });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  if (!TRIGGER_KEY || key !== TRIGGER_KEY || req.method !== "POST") return json({ error: "Invalid or missing key" }, 401);
  const date = url.searchParams.get("date") || todayCentral();
  const dry = url.searchParams.get("dry") === "1";
  const preview = dry || url.searchParams.get("send") === "0";

  try {
    // 1. morning-brief builds the brief and the printout; at the same time, read the live pieces for the new top.
    const built = dry ? null : fetch(fn("morning-brief", `key=${encodeURIComponent(TRIGGER_KEY)}&send=0&date=${date}`),
      { method: "POST", signal: AbortSignal.timeout(BUILD_MS) });
    // The Calm lists are about today, so only ask for them on today's email.
    const live = date === todayCentral()
      ? Promise.all([readLive<Lanes>("brief-lanes"), readLive<Focus>("brief-focus")])
      : Promise.resolve([null, null] as [Lanes | null, Focus | null]);

    let baseHtml = "";
    try {
      if (built) {
        const r = await built;
        if (!r.ok) throw new Error(`morning-brief ${r.status}`);
        baseHtml = await r.text();
        if (!baseHtml.includes("<html")) throw new Error("morning-brief did not return the email");
      } else {
        baseHtml = STAND_IN;
      }
    } catch (e) {
      if (preview) return json({ ok: false, error: (e as Error).message }, 502);
      return await oldWay(date, "build: " + (e as Error).message);
    }

    // 2. add the new top. Anything that goes wrong here just leaves the old email as it was.
    let html = baseHtml; const notes: string[] = [];
    try {
      const [lanes, focus] = await live;
      if (!lanes) notes.push("project, quick-win and coming-up lists unavailable");
      if (!focus) notes.push("pinned unavailable");
      const done = inject(baseHtml, buildTop(lanes, focus, pageLink(date)));
      html = done.html; notes.push(...done.notes);
    } catch (e) { notes.push("top failed: " + (e as Error).message); html = baseHtml; }
    if (notes.length) console.error("morning-email notes:", notes.join("; "));

    if (preview) return new Response(html, { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Notes": notes.join("; ").slice(0, 300) } });

    // 3. send it (same From, subject and QR image as morning-brief).
    try {
      const qr: Uint8Array = await QRCode.toBuffer(pageLink(date), { width: 300, margin: 1 });
      let bin = ""; for (const b of qr) bin += String.fromCharCode(b);
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": POSTMARK_TOKEN },
        body: JSON.stringify({
          From: FROM_EMAIL, To: TO_EMAIL, Subject: `Morning brief — ${longDate(date)}`,
          HtmlBody: html, TextBody: htmlToText(html, pageLink(date)), MessageStream: "outbound",
          Attachments: [{ Name: "qr.png", Content: btoa(bin), ContentType: "image/png", ContentID: "cid:qr.png" }],
        }),
      });
      if (!res.ok) throw new Error(`Postmark ${res.status}: ${await res.text()}`);
    } catch (e) {
      return await oldWay(date, "send: " + (e as Error).message);
    }
    return json({ ok: true, date, notes });
  } catch (e) {
    // Nothing above should get here. If it does, still try to get the plain email out.
    console.error("morning-email unexpected:", e);
    if (!preview) { try { return await oldWay(date, "unexpected: " + (e as Error).message); } catch (_) { /* fall through */ } }
    return json({ error: (e as Error).message }, 500);
  }
});
