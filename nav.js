/* Studio Strong: the one top bar shared by every Brain page.
 *
 *   Morning Brief | Gems | Act | Drawer | Notes
 *
 * Each page loads it as the first thing in <body>:   <script src="nav.js?v=2"></script>
 * To add, rename or reorder a page, change PAGES below and upload this one file; every page follows.
 *
 * Keys: this file never writes the key anywhere and the key is not in this file. It only carries it:
 * the key this browser has saved (localStorage "brain-key", saved by the pages themselves) or, when
 * storage is blocked, the one in this page's own address. It adds that key to the other pages' links
 * at the moment you tap, so moving between pages never asks again. Drawer and Notes live on the Drawer's
 * own site and login (its front page and its Notes library), so they open in a new tab and get no key.
 *
 * Colours come from the page the bar sits on (--surface, --text, --teal ...), so it follows that page's
 * light and dark themes, including the manual theme button on Priorities and Capture.
 */
(function () {
  "use strict";
  if (window.__ssNav) return;
  window.__ssNav = true;

  var STORE = "brain-key";
  var PAGES = [
    { id: "brief",      href: "brief.html",      label: "Morning Brief", short: "Brief" },
    { id: "gems",       href: "gems.html",       label: "Gems" },
    { id: "act",        href: "act.html",        label: "Act" },
    { id: "drawer",     href: "https://drawer.studiostrong.fit/",      label: "Drawer", external: true },
    { id: "notes",      href: "https://drawer.studiostrong.fit/notes", label: "Notes",  external: true }
  ];

  var good = function (k) { return /^[A-Za-z0-9_-]{16,}$/.test(k || ""); };
  function savedKey() { try { var k = localStorage.getItem(STORE) || ""; return good(k) ? k : ""; } catch (e) { return ""; } }
  function addressKey() { try { var k = new URLSearchParams(location.search).get("key") || ""; return good(k) ? k : ""; } catch (e) { return ""; } }
  // The saved key wins: pages save a key once the server has accepted it, so a stale key left in an
  // old link can't push the good one out. The address is only the fallback when storage is blocked.
  function currentKey() { return savedKey() || addressKey(); }

  function pageId() {
    var seg = (location.pathname.split("/").pop() || "").replace(/\.html?$/i, "").toLowerCase();
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === seg) return seg;
    return "";
  }
  function hrefFor(p) {
    if (p.external) return p.href;
    var k = currentKey();
    return k ? p.href + "?key=" + encodeURIComponent(k) : p.href;
  }

  function mount() {
    if (!document.body || document.getElementById("ssnav")) return;

    var css = document.createElement("style");
    css.id = "ssnav-css";
    css.textContent =
      "#ssnav{position:fixed;top:0;left:0;right:0;z-index:90;height:44px;background:var(--surface,#fff);" +
        "border-bottom:1px solid var(--line,var(--border,rgba(0,0,0,.12)));color:var(--text,#1a1a1a);" +
        "font:500 13px/1 'DM Sans',system-ui,-apple-system,sans-serif;-webkit-text-size-adjust:100%}" +
      "#ssnav .in{height:100%;padding:0 6px;display:flex;align-items:center;gap:2px;" +
        "overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch}" +
      "#ssnav .in::-webkit-scrollbar{display:none}" +
      "#ssnav .in>a:first-child{margin-left:auto}#ssnav .in>a:last-child{margin-right:auto}" +   // centred when there is room; starts at the left (and scrolls) when there isn't
      "#ssnav a{flex:0 0 auto;display:flex;align-items:center;height:34px;padding:0 9px;border-radius:8px;" +
        "color:var(--dim,var(--text-dim,#555));text-decoration:none;white-space:nowrap;box-shadow:none}" +
      "#ssnav a:hover{background:var(--teal-dim,rgba(43,125,148,.12));color:var(--text,#1a1a1a);text-decoration:none}" +
      "#ssnav a:focus-visible{outline:2px solid var(--teal,#2b7d94);outline-offset:-2px}" +
      "#ssnav a[aria-current=page]{color:var(--text,#1a1a1a);font-weight:700;background:var(--teal-dim,rgba(43,125,148,.12));" +
        "box-shadow:inset 0 -2px 0 var(--teal,#2b7d94)}" +
      "#ssnav .s{display:none}" +
      "#ssnav .x{margin-left:3px;font-size:11px;opacity:.7}" +
      "#ssnav-sp{height:44px}" +
      "@media (max-width:440px){#ssnav .in{padding:0 4px;gap:0}#ssnav a{padding:0 8px;font-size:12.5px}#ssnav .l{display:none}#ssnav .s{display:inline}}" +
      "@media print{#ssnav,#ssnav-sp{display:none}}";
    document.head.appendChild(css);

    var cur = pageId();
    var nav = document.createElement("nav");
    nav.id = "ssnav";
    nav.setAttribute("aria-label", "Studio Strong pages");
    var row = document.createElement("div");
    row.className = "in";
    PAGES.forEach(function (p) {
      var a = document.createElement("a");
      a.setAttribute("data-nav", p.id);
      a.href = hrefFor(p);
      a.setAttribute("aria-label", p.external ? p.label + " (opens in a new tab)" : p.label);
      if (p.short) {
        var l = document.createElement("span"); l.className = "l"; l.textContent = p.label;
        var s = document.createElement("span"); s.className = "s"; s.textContent = p.short;
        a.appendChild(l); a.appendChild(s);
      } else a.appendChild(document.createTextNode(p.label));
      if (p.external) {
        a.target = "_blank"; a.rel = "noopener";
        var x = document.createElement("span"); x.className = "x"; x.setAttribute("aria-hidden", "true"); x.textContent = "↗";
        a.appendChild(x);
      }
      if (p.id === cur) a.setAttribute("aria-current", "page");
      row.appendChild(a);
    });
    nav.appendChild(row);
    var sp = document.createElement("div");
    sp.id = "ssnav-sp";
    sp.setAttribute("aria-hidden", "true");
    document.body.insertBefore(sp, document.body.firstChild);
    document.body.insertBefore(nav, sp);

    // Keep links that a page scrolls to from hiding under the bar.
    try { document.documentElement.style.scrollPaddingTop = "52px"; } catch (e) {}

    // The key is read at the moment of the tap, so a key pasted or saved after the page loaded is used.
    function refresh() {
      PAGES.forEach(function (p) {
        var a = row.querySelector('[data-nav="' + p.id + '"]');
        if (a && !p.external) a.href = hrefFor(p);
      });
    }
    row.addEventListener("click", refresh, true);
    row.addEventListener("focusin", refresh);
    row.addEventListener("pointerdown", refresh);
    row.addEventListener("mouseover", refresh);
    row.addEventListener("touchstart", refresh, { passive: true });
    window.addEventListener("storage", function (e) { if (!e.key || e.key === STORE) refresh(); });
    window.addEventListener("pageshow", refresh);
    // Scroll the current page's link into view when the row is wider than the screen.
    var here = row.querySelector("[aria-current=page]");
    if (here && row.scrollWidth > row.clientWidth) { try { here.scrollIntoView({ inline: "center", block: "nearest" }); } catch (e) {} }
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
