// Studio Strong Notes — the Evernote replacement screen.
// Works two ways:
//   • Inside the Drawer: same-origin /api/notes (the Drawer's server adds its key and who's signed in).
//   • Standalone (reelcall.app/notes.html): your personal brain key, like the brief and priorities pages.
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import MarkdownIt from "markdown-it";

const FUNCTION_URL = "https://rzkrydqtgmuyeaipronh.supabase.co/functions/v1/notes-api";
const KEY_STORE = "brain-key";          // shared with the brief and priorities pages
const PAGE = 50;

// ── Tiny helpers ────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: keep going */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M10 13h6m-2-2 2 2-2 2"/>',
  pin: '<path d="M12 17v5"/><path d="M8 3h8l-1 6 3 3v2H6v-2l3-3z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M14 11v6M11 14h6M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  display: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M14 5h-4M14 19h-4M14 5l-4 14"/>',
  heading: '<path d="M6 5v14M18 5v14M6 12h12"/>',
  ul: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  ol: '<path d="M10 6h10M10 12h10M10 18h10M4 4v4M3.5 14.5c.5-1 2.5-1 2.5.5 0 1-2.5 2-2.5 3h2.5"/>',
  check: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="m8 12 3 3 5-6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  done: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};
const icon = (name, cls = "i") => h("span", { "aria-hidden": "true", html: `<svg class="${cls}" viewBox="0 0 24 24">${ICONS[name]}</svg>` }).firstChild;

const fmtDate = (s, withTime = false) => {
  if (!s) return "";
  const d = new Date(s);
  const now = new Date();
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString("en-US", opts);
};
const person = (w) => {
  if (!w) return "";
  if (w === "import") return "Evernote import";
  let s = String(w);
  if (s.includes("@")) s = s.split("@")[0].replace(/[._-]+/g, " ");
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
};

// ── Markdown + photos ───────────────────────────────────────
// Notes store photos as att:<path>. In the editor they need real (signed) URLs; the #att= marker
// lets us turn them back into att: paths when saving.
const toView = (md, urls = {}) =>
  String(md || "").replace(/\]\(att:([^)\s]+)\)/g, (m, p) => (urls[p] ? `](${urls[p]}#att=${encodeURIComponent(p)})` : m));
const fromView = (md) =>
  String(md || "").replace(/\]\((https?:\/\/[^)\s]*?)#att=([^)\s]+)\)/g, (_m, _u, p) => `](att:${decodeURIComponent(p)})`);
const mdView = new MarkdownIt({ html: false, linkify: true, breaks: true });
const plainText = (md) =>
  String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:att:)[^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*|__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ── API ─────────────────────────────────────────────────────
const cfg = { base: null, key: null, mode: null };
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cfg.key) headers["x-brain-key"] = cfg.key;
  let body = opts.body;
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.json); }
  let res;
  try {
    res = await fetch(cfg.base + path, { method: opts.method || "GET", headers, body });
  } catch {
    const e = new Error("Can't reach the notes service. Check your connection."); e.status = 0; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || `Request failed (${res.status})`);
    e.status = res.status; throw e;
  }
  return data;
}

// ── State ───────────────────────────────────────────────────
const S = {
  me: null,
  folders: [], byKey: {}, kids: {}, direct: {}, review: {}, deep: {},
  tags: [], showAllFolders: store.get("notes-all-folders") === "1",
  open: new Set(JSON.parse(store.get("notes-open") || "[]")),
  view: { type: "all" }, sort: store.get("notes-sort") || "updated", scope: "everywhere",
  items: [], total: 0, loading: false, reqSeq: 0,
  picked: new Set(), lastPick: null,
  noteId: null, note: null, baseUpdatedAt: null,
  titleDirty: false, bodyDirty: false, editSeq: 0, saving: false, saveErr: null, conflict: null,
  userEdited: false, loadedMd: "",   // a note only saves after a real edit that changes its text
  totals: { all: 0, review: 0, pinned: 0, trash: 0 },
};

// ── Folder tree ─────────────────────────────────────────────
function indexFolders(folders, counts) {
  S.folders = folders;
  S.byKey = {}; S.kids = {}; S.direct = {}; S.review = {}; S.deep = {};
  for (const f of folders) { S.byKey[f.key] = f; (S.kids[f.parent_key || ""] ||= []).push(f); }
  for (const list of Object.values(S.kids)) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.title.localeCompare(b.title));
  for (const c of counts) { S.direct[c.folder_key || ""] = Number(c.notes); S.review[c.folder_key || ""] = Number(c.review); }
  const walk = (key) => {
    let n = S.direct[key] || 0;
    for (const k of S.kids[key] || []) n += walk(k.key);
    S.deep[key] = n; return n;
  };
  for (const f of S.kids[""] || []) walk(f.key);
  S.totals.review = Object.values(S.review).reduce((a, b) => a + b, 0);
}
const pathOf = (key, sep = " / ") => {
  const parts = []; let cur = key; let g = 0;
  while (cur && S.byKey[cur] && g++ < 12) { parts.unshift(S.byKey[cur].title); cur = S.byKey[cur].parent_key; }
  return parts.join(sep);
};
const folderTitle = (key) => (key && S.byKey[key] ? S.byKey[key].title : "Unfiled");

async function loadFolders() {
  const [{ folders, counts }, { tags }] = await Promise.all([api("/folders"), api("/tags")]);
  indexFolders(folders, counts);
  S.tags = tags.filter((t) => t.tag !== "moved-to-bitwarden");
}

// ── Layout ──────────────────────────────────────────────────
const app = h("div", { class: "app", "data-pane": "list" });
const side = h("aside", { class: "side", "aria-label": "Folders" });
const list = h("section", { class: "list", "aria-label": "Notes" });
const note = h("main", { class: "note", "aria-label": "Note" });
app.append(side, list, note);
const toasts = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
const setPane = (p) => { app.dataset.pane = p; };

function toast(msg, action) {
  const t = h("div", { class: "toast" }, h("span", {}, msg));
  if (action) t.append(h("button", { onclick: () => { action.run(); t.remove(); } }, action.label));
  toasts.append(t);
  setTimeout(() => t.remove(), action ? 7000 : 3200);
}

// ── Sidebar ─────────────────────────────────────────────────
function navBtn({ label, count, active, onClick, iconName, dot, depth, extra }) {
  const b = h("button", { class: "nav" + (active ? " active" : ""), onclick: onClick, style: depth != null ? { "--depth": depth } : null });
  if (iconName) b.append(icon(iconName));
  b.append(h("span", { class: "label" }, label));
  if (dot) b.append(h("span", { class: "dot", title: "Needs a look" }));
  if (count != null) b.append(h("span", { class: "count" }, count.toLocaleString()));
  if (extra) b.append(extra);
  return b;
}
const isView = (type, key) => S.view.type === type && (key === undefined || S.view.key === key || S.view.tag === key);

function renderSide() {
  side.replaceChildren();
  const head = h("div", { class: "side-head" },
    h("button", { type: "button", class: "brand", title: "Start page", "aria-label": "Notes start page", onclick: () => showHome(true) }, h("b", {}, "Notes"), h("span", {}, "Studio Strong")),
    h("button", { class: "new-note", onclick: () => newNote() }, icon("plus"), "New note"),
  );
  const scroll = h("div", { class: "side-scroll" });
  scroll.append(
    navBtn({ label: "All notes", iconName: "notes", count: S.totals.all, active: isView("all"), onClick: () => go({ type: "all" }) }),
    navBtn({ label: "Needs a look", iconName: "flag", count: S.totals.review, dot: S.totals.review > 0, active: isView("review"), onClick: () => go({ type: "review" }) }),
    navBtn({ label: "Pinned", iconName: "pin", active: isView("pinned"), onClick: () => go({ type: "pinned" }) }),
  );

  const fg = h("div", { class: "side-group tree" },
    h("div", { class: "side-label" }, h("span", {}, "Folders"),
      h("button", { onclick: () => { S.showAllFolders = !S.showAllFolders; store.set("notes-all-folders", S.showAllFolders ? "1" : "0"); renderSide(); } },
        S.showAllFolders ? "Only with notes" : "Show all")),
  );
  const addFolderRows = (parent, depth) => {
    for (const f of S.kids[parent] || []) {
      if (!S.showAllFolders && !S.deep[f.key]) continue;
      const kids = (S.kids[f.key] || []).filter((k) => S.showAllFolders || S.deep[k.key]);
      const open = S.open.has(f.key);
      const tw = h("span", { class: "twisty" + (kids.length ? (open ? " open" : "") : " none"), role: "button", "aria-label": open ? "Collapse" : "Expand",
        onclick: (e) => { e.stopPropagation(); if (S.open.has(f.key)) S.open.delete(f.key); else S.open.add(f.key); store.set("notes-open", JSON.stringify([...S.open])); renderSide(); } }, icon("chevron"));
      const more = h("span", { class: "more", role: "button", "aria-label": `Folder options for ${f.title}`, onclick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, f); } }, icon("more"));
      const row = navBtn({ label: f.title, count: S.deep[f.key] || null, active: isView("folder", f.key), depth, dot: (S.review[f.key] || 0) > 0, extra: more,
        onClick: () => { if (kids.length) { S.open.add(f.key); store.set("notes-open", JSON.stringify([...S.open])); } go({ type: "folder", key: f.key }); } });
      row.prepend(tw);
      row.dataset.folder = f.key;
      dropTarget(row, f.key);
      fg.append(row);
      if (open) addFolderRows(f.key, depth + 1);
    }
  };
  addFolderRows("", 0);
  scroll.append(fg);

  if (S.tags.length) {
    const tg = h("div", { class: "side-group tag-list" }, h("div", { class: "side-label" }, h("span", {}, "Tags")));
    const showAll = S.view.type === "tag" || side.dataset.allTags === "1";
    for (const t of S.tags.slice(0, showAll ? 400 : 12)) {
      tg.append(navBtn({ label: t.tag, count: Number(t.notes), active: isView("tag", t.tag), onClick: () => go({ type: "tag", tag: t.tag }) }));
    }
    if (!showAll && S.tags.length > 12) tg.append(h("button", { class: "nav", onclick: () => { side.dataset.allTags = "1"; renderSide(); } }, h("span", { class: "label", style: { color: "var(--side-ink-2)" } }, `All ${S.tags.length} tags`)));
    scroll.append(tg);
  }
  scroll.append(h("div", { class: "side-group" }, navBtn({ label: "Trash", iconName: "trash", active: isView("trash"), onClick: () => go({ type: "trash" }) })));

  const theme = store.get("notes-theme") || "auto";
  const foot = h("div", { class: "side-foot" },
    h("span", { class: "who" }, S.me ? `Signed in as ${person(S.me.who)}` : "",
      // Key mode signs in again; inside the Drawer the login is shared, so the Drawer's
      // /api/notes-person route remembers who is using this browser (Dave or Doreen).
      h("button", { class: "switch", title: cfg.mode === "key" ? "Sign in as someone else on this device" : "Switch between Dave and Doreen on this device", onclick: async () => {
        if (cfg.mode === "key") return switchPerson();
        await flushSave();
        try {
          const r = await fetch("/api/notes-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who: S.me && S.me.who === "dave" ? "doreen" : "dave" }) });
          if (!r.ok) throw new Error(`Switch didn't work (${r.status})`);
          location.reload();
        } catch (e) { toast(e.message); }
      } }, "Switch")),
    h("button", { onclick: () => {
      const next = { auto: "dark", dark: "light", light: "auto" }[theme];
      store.set("notes-theme", next); applyTheme(); renderSide();
    } }, { auto: "Theme: auto", dark: "Theme: dark", light: "Theme: light" }[theme]),
  );
  side.append(head, scroll, foot);
}

function applyTheme() {
  const t = store.get("notes-theme") || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
}

function folderMenu(anchor, f) {
  openMenu(anchor, [
    { label: "New folder inside", run: () => inlineFolderInput(f.key, null) },
    { label: "Rename", run: () => inlineFolderInput(f.parent_key, f) },
  ]);
}

function inlineFolderInput(parentKey, existing) {
  // Show an input in place of (or under) the folder row
  if (parentKey) { S.open.add(parentKey); }
  renderSide();
  const anchorKey = existing ? existing.key : parentKey;
  const row = anchorKey ? side.querySelector(`[data-folder="${CSS.escape(anchorKey)}"]`) : side.querySelector(".tree .side-label");
  const input = h("input", { class: "inline-input", value: existing ? existing.title : "", placeholder: "Folder name", "aria-label": "Folder name" });
  const wrap = h("div", { class: "nav", style: { "--depth": existing ? Number(row?.style.getPropertyValue("--depth") || 0) : Number(row?.style.getPropertyValue("--depth") || -1) + 1, paddingLeft: "calc(30px + var(--depth) * 14px)" } }, input);
  if (existing && row) row.replaceWith(wrap); else if (row) row.after(wrap); else side.querySelector(".tree").append(wrap);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (save && title && (!existing || title !== existing.title)) {
      try {
        if (existing) { await api(`/folders/${encodeURIComponent(existing.key)}`, { method: "PATCH", json: { title } }); toast(`Renamed to “${title}”`); }
        else { const f = await api("/folders", { method: "POST", json: { title, parent_key: parentKey } }); toast(`Created “${f.title}”`); S.showAllFolders = true; }
        await loadFolders();
      } catch (e) { toast(e.message); }
    }
    renderSide(); renderListHead();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
}

// ── Drag & drop moves ───────────────────────────────────────
let dragIds = [];
function dropTarget(el, folderKey) {
  el.addEventListener("dragover", (e) => { if (!dragIds.length) return; e.preventDefault(); el.classList.add("drop"); });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault(); el.classList.remove("drop");
    const ids = dragIds; dragIds = [];
    if (ids.length) await moveNotes(ids, folderKey);
  });
}

// ── Note list ───────────────────────────────────────────────
const listHead = h("div", { class: "list-head" });
const listScroll = h("div", { class: "list-scroll" });
const bulkBar = h("div", { class: "bulk", hidden: true });
list.append(listHead, bulkBar, listScroll);

const searchInput = h("input", { type: "search", placeholder: "Search notes, or #tag", "aria-label": "Search notes", autocomplete: "off" });
// Built once and never taken out of the page: moving a focused box closes the phone keyboard
// and drops the cursor, which stopped typing after the first letter.
const searchLabel = h("label", { class: "search" }, icon("search"), searchInput, h("kbd", { title: "Press / to search" }, "/"));
const tagFor = (q) => { const m = /^#(\S+)$/.exec(q); return m ? S.tags.find((t) => t.tag.toLowerCase() === m[1].toLowerCase()) : null; };
const runSearch = debounce(() => {
  const q = searchInput.value.trim();
  const tag = tagFor(q);
  if (tag) { go({ type: "tag", tag: tag.tag }, { keepNote: true }); return; }
  if (q) go({ type: "search", q, within: S.scope === "here" ? S.searchWithin : null }, { keepNote: true });
  else if (S.view.type === "search") go(S.beforeSearch || { type: "all" }, { keepNote: true });
}, 280);
searchInput.addEventListener("input", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { searchInput.value = ""; runSearch(); searchInput.blur(); }
  if (e.key === "Enter") { const first = S.items[0]; if (first) openNote(first.id); }
});

// ── Quick note (top of the list, under search) ──────────────
// Type a note and save; the server files it (similar notes + Claude, with Jev settling disagreements)
// and the page says where it went, with one-tap moves to the next-best folders. Like the search box,
// it is built once and never taken out of the page, so typing isn't interrupted.
const qnInput = h("textarea", { class: "qn-input", rows: "1", placeholder: "Add a note… Claude and Jev will file it", "aria-label": "Add a note", maxlength: "20000" });
const qnSave = h("button", { class: "btn primary sm", type: "button", onclick: () => saveQuickNote() }, "Save note");
const qnClear = h("button", { class: "btn sm", type: "button", onclick: () => { qnInput.value = ""; qnGrow(); qnInput.focus(); } }, "Clear");
const qnBar = h("div", { class: "qn-bar", hidden: true }, h("span", { class: "qn-hint" }, "First line is the title, or Claude writes one"), qnClear, qnSave);
const qnResult = h("div", { class: "qn-result", hidden: true, role: "status" });
const quickNote = h("div", { class: "qn" }, qnInput, qnBar, qnResult);
function qnGrow() {
  qnInput.style.height = "auto";
  if (qnInput.value) qnInput.style.height = Math.min(qnInput.scrollHeight + 2, 260) + "px";
  qnBar.hidden = !qnInput.value.trim() && document.activeElement !== qnInput;
}
qnInput.addEventListener("input", qnGrow);
qnInput.addEventListener("focus", () => { qnBar.hidden = false; });
qnInput.addEventListener("blur", () => setTimeout(qnGrow, 200));
qnInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveQuickNote(); }
  if (e.key === "Escape") { e.stopPropagation(); qnInput.blur(); }
});

// First line becomes the title when it's short; one long paragraph gets a title from Claude.
function splitQuick(text) {
  const t = text.trim();
  const lines = t.split("\n");
  const first = lines[0].replace(/^#+\s*/, "").trim();
  if (lines.length > 1 && first.length <= 90) return { title: first, body: lines.slice(1).join("\n").trim() };
  if (lines.length === 1 && first.length <= 70) return { title: first, body: "" };
  return { title: "", body: t };
}

// Put the quick note back under the list's search box (after the start page closes).
function placeQuickNote() {
  if (homeEl) return;
  if (searchLabel.nextSibling !== quickNote) searchLabel.after(quickNote);
  quickNote.hidden = S.view.type === "trash";
}

async function saveQuickNote() {
  const text = qnInput.value.trim();
  if (!text || qnSave.disabled) return;
  qnSave.disabled = qnClear.disabled = true; qnInput.readOnly = true;
  qnResult.hidden = false; qnResult.className = "qn-result busy";
  qnResult.replaceChildren(h("span", { class: "qn-spin", "aria-hidden": "true" }), h("span", {}, "Saving… Claude and Jev are picking a folder"));
  try {
    const { title, body } = splitQuick(text);
    const n = await api("/notes", { method: "POST", json: { title, body, auto_file: true } });
    qnInput.value = ""; qnInput.blur(); qnGrow();
    S.totals.all++;
    showQuickResult(n);
    loadFolders().then(renderSide);
    if (S.view.type !== "search") loadList(true);
  } catch (e) {
    qnResult.className = "qn-result bad";
    qnResult.replaceChildren(h("span", {}, `Couldn’t save that: ${e.message}. Your note is still in the box.`));
  } finally { qnSave.disabled = qnClear.disabled = false; qnInput.readOnly = false; }
}

function showQuickResult(n, { moved = false } = {}) {
  const f = n.filed || null;
  const where = n.folder_key ? pathOf(n.folder_key, " › ") : "Unfiled";
  const unsure = !moved && (!f || f.by === "jev");
  const how = moved ? "Moved."
    : !f ? "Nothing matched well enough to pick a folder, so it’s unfiled. Choose one below."
    : f.by === "agree" ? "Claude and similar notes both picked this folder."
    : f.by === "jev" ? "Not a clear-cut call, so Jev made the final pick. Worth a quick check."
    : f.by === "claude" ? "Claude picked this folder." : "Picked from similar notes.";
  const alts = [...new Set([f?.second, ...(f?.candidates || [])])].filter((k) => k && k !== n.folder_key && S.byKey[k]).slice(0, 2);
  qnResult.className = "qn-result" + (unsure ? " unsure" : "");
  qnResult.replaceChildren(
    h("div", { class: "qn-head" },
      icon("done"),
      h("p", {}, "Saved ", h("b", {}, `“${n.title}”`), " to ", h("b", {}, where))),
    h("p", { class: "qn-how" }, how, f?.why && !moved ? h("span", { class: "qn-why" }, ` Claude’s reason: ${f.why}`) : null),
    h("div", { class: "qn-acts" },
      h("button", { class: "btn sm", onclick: () => { showHome(false); openNote(n.id); } }, "Open"),
      ...alts.map((k) => h("button", { class: "btn sm", title: pathOf(k, " › "), onclick: () => quickMove(n, k) }, `Move to ${folderTitle(k)}`)),
      h("button", { class: "btn sm", onclick: () => moveDialog([n.id], {
        note: { ...n, suggested_folder: alts[0] || null, suggested_second: alts[1] || null }, current: n.folder_key,
        pick: (k) => quickMove(n, k),
      }) }, "Choose a folder…"),
      h("button", { class: "icon-btn qn-x", "aria-label": "Close", title: "Close", onclick: () => { qnResult.hidden = true; } }, icon("x"))),
  );
}

async function quickMove(n, key) {
  try {
    await moveNotes([n.id], key, { quiet: true });
    showQuickResult({ ...n, folder_key: key }, { moved: true });
    toast(`Moved to ${folderTitle(key)}`);
  } catch { /* moveNotes shows the error */ }
}

function viewTitle() {
  const v = S.view;
  if (v.type === "folder") return { title: folderTitle(v.key), path: S.byKey[v.key]?.parent_key ? pathOf(S.byKey[v.key].parent_key) : "" };
  if (v.type === "review") return { title: "Needs a look", path: "Not sure where these belong" };
  if (v.type === "pinned") return { title: "Pinned", path: "" };
  if (v.type === "trash") return { title: "Trash", path: "" };
  if (v.type === "tag") return { title: `#${v.tag}`, path: "Tag" };
  if (v.type === "search") return { title: `“${v.q}”`, path: v.within ? `Search in ${folderTitle(v.within)}` : "Search results" };
  return { title: "All notes", path: "" };
}

function renderListHead() {
  const { title, path } = viewTitle();
  const inFolder = S.view.type === "folder" ? S.view.key : S.view.type === "search" ? S.view.within : null;
  if (S.view.type !== "search") S.searchWithin = S.view.type === "folder" ? S.view.key : null;
  const scope = h("div", { class: "scope", hidden: !(S.searchWithin || S.view.within) },
    h("button", { "aria-pressed": String(S.scope !== "here"), onclick: () => { S.scope = "everywhere"; searchInput.placeholder = "Search notes, or #tag"; renderListHead(); if (searchInput.value.trim()) runSearch(); } }, "Everywhere"),
    h("button", { "aria-pressed": String(S.scope === "here"), onclick: () => { S.scope = "here"; searchInput.placeholder = `Search in ${folderTitle(S.searchWithin)}`; renderListHead(); if (searchInput.value.trim()) runSearch(); } }, `In ${folderTitle(S.searchWithin || S.view.within)}`),
  );
  const sort = h("select", { "aria-label": "Sort notes", onchange: (e) => { S.sort = e.target.value; store.set("notes-sort", S.sort); loadList(true); } },
    ...[["updated", "Recently edited"], ["created", "Date created"], ["title", "Title A–Z"]].map(([v, l]) => h("option", { value: v, selected: S.sort === v }, l)));
  const tq = S.view.type === "search" && /^#\S*$/.test(S.view.q) ? S.view.q.slice(1).toLowerCase() : null;
  const tagHits = tq !== null ? S.tags.filter((t) => t.tag.toLowerCase().includes(tq)).slice(0, 12) : [];
  // Rebuild everything under the search and quick-note boxes, but leave those two where they are
  // (the quick note sits on the start page instead while that's open).
  const keep = homeEl ? [searchLabel] : [searchLabel, quickNote];
  if (!keep.every((el, i) => listHead.children[i] === el)) listHead.replaceChildren(...keep);
  const last = keep[keep.length - 1];
  while (last.nextSibling) last.nextSibling.remove();
  if (!homeEl) quickNote.hidden = S.view.type === "trash";
  listHead.append(...[
    scope,
    tagHits.length ? h("div", { class: "tag-hits", "aria-label": "Matching tags" },
      ...tagHits.map((t) => h("button", { class: "chip", onclick: () => { searchInput.value = `#${t.tag}`; go({ type: "tag", tag: t.tag }, { keepNote: true }); } }, `#${t.tag}`, h("span", { class: "n" }, String(t.notes))))) : null,
    h("div", { class: "list-title" },
      h("div", {},
        path ? h("div", { class: "path" }, path) : null,
        h("h1", {}, title)),
      h("button", { class: "icon-btn only-narrow", "aria-label": "Show folders", onclick: () => setPane("side") }, icon("menu")),
    ),
    S.view.type === "review" && S.total > 0 ? h("button", { class: "qr-cta", onclick: () => openQuickReview() },
      h("b", {}, "Quick review"), h("span", {}, `See all ${S.total.toLocaleString()} at once, grouped by folder. Confirm in a few clicks.`)) : null,
    h("div", { class: "list-sub" },
      h("span", { id: "list-count" }, S.loading && !S.items.length ? "Loading…" : S.view.type === "search" ? plural(S.items.length, "result") : plural(S.total, "note")),
      S.view.type !== "search" ? sort : h("span", {}, "Best match first")),
  ].filter((x) => x != null && x !== false)); // empty slots would print as "null"
  void inFolder;
}

function renderBulk() {
  const n = S.picked.size;
  list.classList.toggle("picking", n > 0);
  bulkBar.hidden = n === 0;
  if (!n) return;
  bulkBar.replaceChildren(
    h("b", {}, `${n} selected`),
    h("button", { class: "primary", onclick: () => moveDialog([...S.picked]) }, "Move to…"),
    S.view.type === "trash"
      ? h("button", { onclick: () => trashNotes([...S.picked], false) }, "Restore")
      : h("button", { onclick: () => trashNotes([...S.picked], true) }, "Move to Trash"),
    h("button", { onclick: () => { S.picked.clear(); renderBulk(); renderCards(); } }, "Clear"),
  );
}

function cardFor(n) {
  const showWhere = S.view.type !== "folder" || (n.folder_key && n.folder_key !== S.view.key);
  const pick = h("input", { type: "checkbox", class: "pick", "aria-label": `Select ${n.title}`, checked: S.picked.has(n.id) });
  const c = h("button", { class: "card" + (n.id === S.noteId ? " active" : "") + (S.picked.has(n.id) ? " picked" : ""), draggable: "true", "data-id": n.id },
    pick,
    h("div", {},
      h("h3", {}, n.title || "Untitled"),
      n.snippet ? h("p", {}, n.snippet) : null,
      h("div", { class: "meta" },
        h("span", {}, fmtDate(n.updated_at)),
        showWhere ? h("span", { class: "where" }, pathOf(n.folder_key, " › ") || "Unfiled") : null,
        n.has_photos ? h("span", { title: "Has photos" }, "Photos") : null,
        n.needs_review ? h("span", { class: "flag" }, "Needs a look") : null,
        S.view.type === "search" && n.matched && !n.matched.includes("words") ? h("span", { title: "Found by meaning, not exact words" }, "Similar") : null,
      )),
    n.pinned ? h("span", { class: "pin", title: "Pinned" }, icon("pin")) : null,
  );
  pick.addEventListener("click", (e) => { e.stopPropagation(); togglePick(n.id, e.shiftKey); });
  c.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) { togglePick(n.id, false); return; }
    if (e.shiftKey && S.lastPick) { togglePick(n.id, true); return; }
    openNote(n.id);
  });
  c.addEventListener("dragstart", (e) => {
    dragIds = S.picked.has(n.id) ? [...S.picked] : [n.id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `${dragIds.length} note(s)`);
  });
  c.addEventListener("dragend", () => { setTimeout(() => { dragIds = []; }, 0); });
  return c;
}

function togglePick(id, range) {
  if (range && S.lastPick) {
    const ids = S.items.map((i) => i.id);
    const a = ids.indexOf(S.lastPick), b = ids.indexOf(id);
    if (a >= 0 && b >= 0) for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) S.picked.add(x);
  } else if (S.picked.has(id)) S.picked.delete(id);
  else S.picked.add(id);
  S.lastPick = id;
  renderBulk(); renderCards();
}

const moreSentinel = h("div", { style: { height: "1px" } });
const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting) && S.items.length < S.total && !S.loading) loadList(false); }, { root: listScroll, rootMargin: "300px" });
io.observe(moreSentinel);

function renderCards() {
  const keepTop = listScroll.scrollTop;
  listScroll.replaceChildren();
  if (!S.items.length && !S.loading) {
    const v = S.view.type;
    const msg = {
      review: ["All caught up", "Every note from Evernote has a folder you’ve confirmed."],
      pinned: ["Nothing pinned yet", "Pin a note you use often, like this week’s class plan, and it stays at the top here."],
      trash: ["Trash is empty", "Notes you trash wait here until you restore them."],
      search: ["No matches", "Try fewer words, or switch the search to Everywhere."],
      folder: ["No notes here yet", "Create one with New note, or drag notes onto this folder."],
    }[v] || ["No notes yet", "Create one with New note."];
    listScroll.append(h("div", { class: "list-empty" }, h("h2", {}, msg[0]), h("p", {}, msg[1])));
    return;
  }
  for (const n of S.items) listScroll.append(cardFor(n));
  if (S.view.type !== "search" && S.items.length < S.total) {
    listScroll.append(moreSentinel, h("button", { class: "load-more", onclick: () => loadList(false) }, S.loading ? "Loading…" : `Show more (${(S.total - S.items.length).toLocaleString()} left)`));
  }
  listScroll.scrollTop = keepTop;
}

async function loadList(reset = true) {
  const seq = ++S.reqSeq;
  S.loading = true;
  if (reset) { S.items = []; S.total = 0; listScroll.scrollTop = 0; renderListHead(); renderCards(); }
  const v = S.view;
  try {
    if (v.type === "search") {
      const qs = new URLSearchParams({ q: v.q.replace(/^#/, ""), limit: "60" });
      if (v.within) qs.set("folder", v.within);
      const { results } = await api(`/search?${qs}`);
      if (seq !== S.reqSeq) return;
      S.items = results; S.total = results.length;
    } else {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(reset ? 0 : S.items.length), sort: S.sort });
      if (v.type === "folder") { qs.set("folder", v.key); qs.set("deep", "1"); }
      if (v.type === "review") qs.set("review", "1");
      if (v.type === "pinned") qs.set("pinned", "1");
      if (v.type === "trash") qs.set("archived", "1");
      if (v.type === "tag") qs.set("tag", v.tag);
      const { total, notes } = await api(`/notes?${qs}`);
      if (seq !== S.reqSeq) return;
      S.items = reset ? notes : S.items.concat(notes.filter((n) => !S.items.some((m) => m.id === n.id)));
      S.total = total;
      if (v.type === "all") S.totals.all = total;
      if (v.type === "review") S.totals.review = total;
    }
  } catch (e) {
    if (seq !== S.reqSeq) return;
    toast(e.message);
  } finally {
    if (seq === S.reqSeq) { S.loading = false; renderListHead(); renderCards(); }
  }
}

// ── Navigation / routing ────────────────────────────────────
function writeHash() {
  const p = new URLSearchParams();
  const v = S.view;
  if (v.type === "folder") p.set("folder", v.key);
  else if (v.type === "tag") p.set("tag", v.tag);
  else if (v.type === "search") p.set("q", v.q);
  else if (v.type !== "all") p.set("view", v.type);
  if (S.noteId) p.set("note", S.noteId);
  const s = p.toString();
  history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : ""));
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let view = { type: "all" };
  if (p.get("folder")) view = { type: "folder", key: p.get("folder") };
  else if (p.get("tag")) view = { type: "tag", tag: p.get("tag") };
  else if (p.get("q")) view = { type: "search", q: p.get("q") };
  else if (["review", "pinned", "trash"].includes(p.get("view"))) view = { type: p.get("view") };
  return { view, noteId: p.get("note") };
}

async function go(view, { keepNote = false } = {}) {
  if (view.type !== "search") { S.beforeSearch = view; if (searchInput.value && !keepNote) searchInput.value = ""; }
  // Only overwrite the box when the search came from somewhere else (a link, a tag chip). While
  // someone is typing, resetting it to the trimmed text ate the space between words.
  if (view.type === "search" && searchInput.value.trim() !== view.q) searchInput.value = view.q;
  S.view = view; S.picked.clear(); renderBulk();
  if (view.type === "folder") {
    let cur = S.byKey[view.key]?.parent_key; while (cur) { S.open.add(cur); cur = S.byKey[cur]?.parent_key; }
  }
  renderSide(); writeHash(); setPane("list");
  await loadList(true);
  if (!keepNote && view.type === "review" && S.items[0]) openNote(S.items[0].id, { stayOnList: window.innerWidth <= 860 });
}

// ── Editor ──────────────────────────────────────────────────
const bar = h("div", { class: "note-bar" });
const banners = h("div");
const titleEl = h("textarea", { class: "title", rows: "1", placeholder: "Title", "aria-label": "Note title", maxlength: "300" });
const metaEl = h("div", { class: "note-meta" });
const tagsEl = h("div", { class: "tags" });
const toolbar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Formatting" });
const bodyEl = h("div", { class: "prose-host" });
const quickInput = h("input", { placeholder: "Add a dated line to the end…", "aria-label": "Add a dated line to the end of this note" });
const quick = h("form", { class: "quick-add", onsubmit: (e) => { e.preventDefault(); quickAdd(); } }, quickInput, h("button", { type: "submit" }, "Add"));
const sheet = h("div", { class: "sheet" }, titleEl, metaEl, tagsEl, toolbar, bodyEl, quick);
const noteScroll = h("div", { class: "note-scroll" }, banners, sheet);
const saveState = h("span", { class: "save-state", "aria-live": "polite" });
const emptyNote = h("div", { class: "note-empty" }, h("div", {}, h("h2", {}, "Pick a note"), h("p", {}, "Choose a note from the list, or search for one. Everything you change saves on its own.")));

let editor = null;
function makeEditor() {
  editor = new Editor({
    element: bodyEl,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false, autolink: true, protocols: ["http", "https", "mailto", "tel"] }),
      TaskList, TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      Placeholder.configure({ placeholder: "Start writing. Lists, checklists and photos all work." }),
      Markdown.configure({ html: false, breaks: true, linkify: true, tightLists: true, transformPastedText: true }),
    ],
    editorProps: {
      attributes: { class: "prose", "aria-label": "Note text" },
      handlePaste: (_view, event) => uploadFromEvent(event.clipboardData?.files),
      handleDrop: (_view, event) => { if (dragIds.length) return true; return uploadFromEvent(event.dataTransfer?.files); },
    },
    onUpdate: () => { if (!S.userEdited) return; S.bodyDirty = true; S.editSeq++; scheduleSave(); },
    onSelectionUpdate: () => syncToolbar(),
    onTransaction: () => syncToolbar(),
  });
}

const TOOLS = [
  ["bold", "Bold (Ctrl+B)", () => editor.chain().focus().toggleBold().run(), () => editor.isActive("bold")],
  ["italic", "Italic (Ctrl+I)", () => editor.chain().focus().toggleItalic().run(), () => editor.isActive("italic")],
  ["heading", "Heading", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), () => editor.isActive("heading")],
  "|",
  ["ul", "Bulleted list", () => editor.chain().focus().toggleBulletList().run(), () => editor.isActive("bulletList")],
  ["ol", "Numbered list", () => editor.chain().focus().toggleOrderedList().run(), () => editor.isActive("orderedList")],
  ["check", "Checklist", () => editor.chain().focus().toggleTaskList().run(), () => editor.isActive("taskList")],
  "|",
  ["link", "Link", () => linkPopover(), () => editor.isActive("link")],
  ["photo", "Add a photo or file", () => pickFile(), () => false],
];
const toolBtns = [];
function renderToolbar() {
  toolbar.replaceChildren();
  toolBtns.length = 0;
  for (const t of TOOLS) {
    if (t === "|") { toolbar.append(h("span", { class: "sep", "aria-hidden": "true" })); continue; }
    const [name, label, run, active] = t;
    const b = h("button", { type: "button", "aria-label": label, title: label, onmousedown: (e) => e.preventDefault(), onclick: run }, icon(name));
    toolBtns.push([b, active]);
    toolbar.append(b);
  }
}
function syncToolbar() { if (!editor) return; for (const [b, active] of toolBtns) b.classList.toggle("on", !!active()); }

function linkPopover() {
  const existing = toolbar.querySelector(".link-pop");
  if (existing) { existing.remove(); return; }
  const cur = editor.getAttributes("link").href || "";
  const input = h("input", { type: "url", placeholder: "Paste a link", value: cur, "aria-label": "Link address" });
  const pop = h("form", { class: "link-pop", onsubmit: (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}` }).run();
    pop.remove();
  } }, input, h("button", { type: "submit" }, cur ? "Update link" : "Add link"), cur ? h("button", { type: "button", onclick: () => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); pop.remove(); } }, "Remove") : null);
  toolbar.append(pop);
  input.focus();
}

const fileInput = h("input", { type: "file", accept: "image/*,application/pdf", multiple: true, hidden: true, onchange: (e) => { uploadFiles([...e.target.files]); e.target.value = ""; } });
function pickFile() { fileInput.click(); }
function uploadFromEvent(files) {
  const list = [...(files || [])];
  if (!list.length) return false;
  uploadFiles(list);
  return true;
}
async function uploadFiles(files) {
  if (!S.noteId) return;
  touched();
  for (const f of files) {
    if (f.size > 25_000_000) { toast(`${f.name} is over 25 MB — too big to attach`); continue; }
    status("Uploading photo…");
    try {
      const r = await api(`/notes/${S.noteId}/attachments?inline=0&name=${encodeURIComponent(f.name)}`, { method: "POST", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
      const src = `${r.url}#att=${encodeURIComponent(r.storage_path)}`;
      if (f.type.startsWith("image/")) editor.chain().focus().setImage({ src, alt: f.name }).run();
      else editor.chain().focus().insertContent({ type: "paragraph", content: [{ type: "text", text: f.name, marks: [{ type: "link", attrs: { href: src } }] }] }).run();
    } catch (e) { toast(`Couldn’t attach ${f.name}: ${e.message}`); status(""); }
  }
}

function status(t, err = false) { saveState.textContent = t; saveState.classList.toggle("err", err); }

const scheduleSave = debounce(() => save(), 900);
async function save(force = false) {
  if (!S.noteId || (!S.titleDirty && !S.bodyDirty) || (S.saving && !force)) return;
  const id = S.noteId, seq = S.editSeq;
  const patch = {};
  let md = null;
  if (S.titleDirty) {
    const t = titleEl.value.replace(/\s+/g, " ").trim() || "Untitled";
    if (t !== S.note.title) patch.title = t; else S.titleDirty = false;
  }
  if (S.bodyDirty) {
    md = editor.storage.markdown.getMarkdown();
    if (md !== S.loadedMd) patch.body = fromView(md); else S.bodyDirty = false;
  }
  if (!patch.title && patch.body === undefined) { if (!S.titleDirty && !S.bodyDirty) status(S.saveErr ? "Not saved" : saveState.textContent); return; }
  if (!S.conflictOverride) patch.expected_updated_at = S.baseUpdatedAt;
  S.saving = true; status("Saving…");
  try {
    const r = await api(`/notes/${id}`, { method: "PATCH", json: patch });
    if (S.noteId === id) {
      S.baseUpdatedAt = r.updated_at; S.note = { ...S.note, ...r }; S.conflictOverride = false; S.saveErr = null;
      if (md !== null) S.loadedMd = md;
      if (S.editSeq === seq) { S.titleDirty = false; S.bodyDirty = false; }
      status("Saved"); renderMeta(); clearBanner("save-error");
    }
    patchItem(r);
  } catch (e) {
    if (e.status === 409) { S.conflict = e.message; status("Not saved", true); showConflict(); }
    else { S.saveErr = e.message; status("Not saved", true); banner("save-error", "bad", `Couldn’t save: ${e.message}`, [["Try again", () => save(true), true]]); setTimeout(() => S.saveErr && save(), 8000); }
  } finally {
    S.saving = false;
    if ((S.titleDirty || S.bodyDirty) && S.editSeq !== seq && !S.conflict) scheduleSave();
  }
}
async function flushSave() {
  scheduleSave.cancel?.();
  if (S.titleDirty || S.bodyDirty) await save(true);
}
window.addEventListener("beforeunload", (e) => { if (S.titleDirty || S.bodyDirty || S.saving) { save(true); e.preventDefault(); e.returnValue = ""; } });

function patchItem(r) {
  const i = S.items.findIndex((n) => n.id === r.id);
  if (i < 0) return;
  const old = S.items[i];
  S.items[i] = { ...old, title: r.title, updated_at: r.updated_at, folder_key: r.folder_key, pinned: r.pinned, needs_review: r.needs_review, tags: r.tags,
    snippet: r.body != null ? plainText(r.body).replace(/\s+/g, " ").slice(0, 220) : old.snippet };
  renderCards();
}

// banners keyed by id
function banner(id, kind, text, actions = []) {
  clearBanner(id);
  const b = h("div", { class: `banner ${kind}`, "data-banner": id }, h("p", { html: text }));
  for (const [label, run, primary] of actions) b.append(h("button", { class: primary ? "primary" : "", onclick: run }, label));
  banners.append(b);
}
function clearBanner(id) { banners.querySelector(`[data-banner="${id}"]`)?.remove(); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function showConflict() {
  banner("conflict", "bad", `${esc(S.conflict.replace(/^CONFLICT:\s*(this note\s*)?/i, "This note ").replace(/changed by (\w+)/, (_m, w) => `changed by ${person(w)}`))}. Your latest changes aren’t saved yet.`, [
    ["Load the latest version", async () => { S.titleDirty = S.bodyDirty = false; S.conflict = null; clearBanner("conflict"); await openNote(S.noteId, { force: true }); }],
    ["Save mine anyway", () => { S.conflict = null; S.conflictOverride = true; clearBanner("conflict"); save(true); toast("Saved yours — the other version is in History"); }, true],
  ]);
}

function renderBar() {
  const n = S.note;
  bar.replaceChildren(
    h("button", { class: "icon-btn only-narrow", "aria-label": "Back to notes", onclick: () => setPane("list") }, icon("back")),
    h("button", { class: "crumb", title: "Move to another folder", onclick: () => moveDialog([n.id]) }, icon("folder"), h("span", {}, pathOf(n.folder_key, " › ") || "Unfiled")),
    h("span", { class: "bar-gap" }),
    saveState,
    h("button", { class: "bar-btn show-btn", title: "Show big on the gym TV or tablet", onclick: () => openDisplay() }, icon("display"), h("span", { class: "txt" }, "Display")),
    h("button", { class: "bar-btn wide-only", title: "Copy the text", onclick: () => copyNote() }, icon("copy"), h("span", { class: "txt" }, "Copy")),
    h("button", { class: "bar-btn wide-only", title: "Make a copy of this note", onclick: () => duplicateNote() }, icon("dup"), h("span", { class: "txt" }, "Duplicate")),
    h("button", { class: "bar-btn wide-only", title: "See earlier versions", onclick: () => openHistory() }, icon("history"), h("span", { class: "txt" }, "History")),
    h("button", { class: "bar-btn" + (n.pinned ? " on" : ""), title: n.pinned ? "Unpin" : "Pin to the top", "aria-pressed": String(!!n.pinned), onclick: () => togglePin() }, icon("pin")),
    h("button", { class: "bar-btn", title: "More", "aria-label": "More actions", onclick: (e) => openMenu(e.currentTarget, [
      // On a phone, Copy/Duplicate/History live in this menu instead of the bar
      ...(window.innerWidth <= 860 ? [
        { label: "Copy the text", run: () => copyNote() },
        { label: "Duplicate", run: () => duplicateNote() },
        { label: "History", run: () => openHistory() },
      ] : []),
      { label: "Move to…", run: () => moveDialog([n.id]) },
      n.archived ? { label: "Restore from Trash", run: () => trashNotes([n.id], false) } : { label: "Move to Trash", bad: true, run: () => trashNotes([n.id], true) },
    ]) }, icon("more")),
  );
}

function renderMeta() {
  const n = S.note;
  const bits = [
    `Edited ${fmtDate(n.updated_at, true)}${n.updated_by ? ` by ${person(n.updated_by)}` : ""}`,
    `Created ${fmtDate(n.created_at)}`,
  ];
  metaEl.replaceChildren(...bits.map((b) => h("span", {}, b)));
  if (n.notebook) metaEl.append(h("span", {}, `From Evernote: ${[n.stack, n.notebook].filter(Boolean).join(" › ")}`));
  if (n.source_url) metaEl.append(h("a", { href: n.source_url, target: "_blank", rel: "noopener" }, "Original web page"));
}

function renderTags() {
  const n = S.note;
  const tags = (n.tags || []).filter((t) => t !== "moved-to-bitwarden");
  tagsEl.replaceChildren(...tags.map((t) => h("span", { class: "chip" }, t,
    h("button", { "aria-label": `Remove tag ${t}`, onclick: () => setTags(n.tags.filter((x) => x !== t)) }, icon("x")))));
  const dl = h("datalist", { id: "tag-options" }, ...S.tags.slice(0, 300).map((t) => h("option", { value: t.tag })));
  const add = h("input", { class: "tag-add", placeholder: "Add tag", list: "tag-options", "aria-label": "Add a tag" });
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const t = add.value.replace(/,/g, "").trim();
      if (t && !n.tags.includes(t)) setTags([...(n.tags || []), t]);
      add.value = "";
    }
  });
  tagsEl.append(add, dl);
}
async function setTags(tags) {
  try {
    const r = await api(`/notes/${S.noteId}`, { method: "PATCH", json: { tags } });
    S.note = { ...S.note, ...r }; S.baseUpdatedAt = r.updated_at; renderTags(); renderMeta(); patchItem(r);
  } catch (e) { toast(e.message); }
}

function renderReview() {
  clearBanner("review");
  const n = S.note;
  if (!n.needs_review) return;
  const here = folderTitle(n.folder_key);
  const sug = n.suggested_folder && n.suggested_folder !== n.folder_key && S.byKey[n.suggested_folder] ? n.suggested_folder : null;
  const alt = !sug && n.suggested_second && n.suggested_second !== n.folder_key && S.byKey[n.suggested_second] ? n.suggested_second : null;
  const acts = [];
  if (sug) acts.push([`Move to ${folderTitle(sug)}`, () => resolveReview(sug), true], ["Keep it here", () => resolveReview("keep")]);
  else { acts.push(["Keep it here", () => resolveReview("keep"), !n.review_note]); if (alt) acts.push([`Move to ${folderTitle(alt)}`, () => resolveReview(alt)]); }
  acts.push(["Choose a folder…", () => moveDialog([n.id], { fromReview: true })]);
  if (n.review_note) acts.push(["Move to Trash", async () => { await trashNotes([n.id], true); S.totals.review = Math.max(0, S.totals.review - 1); loadFolders().then(renderSide); }]);
  const text = sug ? `This is in <b>${esc(here)}</b>. It looks like it belongs in <b>${esc(pathOf(sug, " › "))}</b>.`
    : `This is in <b>${esc(here)}</b>, and that looks right.`;
  banner("review", n.review_note ? "bad" : "", text + (n.review_note ? `<br><b>Heads up:</b> ${esc(n.review_note)}` : ""), acts);
}
async function resolveReview(choice) {
  const id = S.noteId;
  try {
    if (choice === "keep") {
      const r = await api(`/notes/${id}`, { method: "PATCH", json: { needs_review: false } });
      S.note = { ...S.note, ...r }; S.baseUpdatedAt = r.updated_at;
      toast(`Kept in ${folderTitle(r.folder_key)}`);
    } else {
      await moveNotes([id], choice, { quiet: true });
      toast(`Moved to ${folderTitle(choice)}`);
    }
    afterReview(id);
  } catch (e) { toast(e.message); }
}
function afterReview(id) {
  S.totals.review = Math.max(0, S.totals.review - 1);
  if (S.view.type === "review") {
    const idx = S.items.findIndex((n) => n.id === id);
    S.items = S.items.filter((n) => n.id !== id); S.total = Math.max(0, S.total - 1);
    renderCards(); renderListHead();
    const next = S.items[idx] || S.items[idx - 1];
    if (next) openNote(next.id); else { S.noteId = null; renderNote(); }
  } else { renderReview(); }
  loadFolders().then(renderSide);
}

function renderNote() {
  note.replaceChildren();
  if (!S.note || !S.noteId) { note.append(emptyNote); return; }
  renderBar(); renderMeta(); renderTags(); renderReview();
  clearBanner("trash");
  if (S.note.archived) banner("trash", "info", "This note is in the Trash.", [["Restore it", () => trashNotes([S.noteId], false), true]]);
  note.append(bar, noteScroll);
  editor.setEditable(!S.note.archived);
  quick.hidden = !!S.note.archived;
  toolbar.hidden = !!S.note.archived;
  titleEl.readOnly = !!S.note.archived;
}

const fitTitle = () => { titleEl.style.height = "auto"; titleEl.style.height = titleEl.scrollHeight + "px"; };
titleEl.addEventListener("input", () => { S.titleDirty = true; S.editSeq++; fitTitle(); scheduleSave(); });
// Only a person's own input marks the body as edited — never loading, normalizing or plugins.
const touched = () => { if (S.note && !S.note.archived) S.userEdited = true; };
for (const ev of ["keydown", "beforeinput", "paste", "drop", "cut", "pointerdown"]) bodyEl.addEventListener(ev, touched, true);
toolbar.addEventListener("pointerdown", touched, true);
titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); editor.commands.focus("start"); } });

async function openNote(id, { force = false, stayOnList = false } = {}) {
  if (!id) return;
  if (id === S.noteId && !force) { if (!stayOnList) setPane("note"); return; }
  await flushSave();
  S.noteId = id; S.userEdited = false; S.conflict = null; S.conflictOverride = false; clearBanner("conflict"); clearBanner("save-error");
  status("");
  renderCards(); writeHash();
  if (!stayOnList) setPane("note");
  try {
    const n = await api(`/notes/${id}`);
    if (S.noteId !== id) return;
    S.note = n; S.baseUpdatedAt = n.updated_at; S.titleDirty = false; S.bodyDirty = false;
    titleEl.value = n.title === "Untitled" ? "" : n.title;
    S.userEdited = false;
    editor.commands.setContent(toView(n.body, n.file_urls), false);
    S.bodyDirty = false;
    S.loadedMd = editor.storage.markdown.getMarkdown();
    const settle = () => { if (!S.userEdited && S.noteId === id) { S.loadedMd = editor.storage.markdown.getMarkdown(); S.bodyDirty = false; } };
    requestAnimationFrame(settle); setTimeout(settle, 400);
    renderNote(); fitTitle();
    noteScroll.scrollTop = 0;
  } catch (e) {
    toast(e.status === 400 ? "That note couldn’t be found." : e.message);
    S.noteId = null; S.note = null; renderNote(); writeHash();
  }
}

async function newNote() {
  await flushSave();
  const folder_key = S.view.type === "folder" ? S.view.key : null;
  try {
    const n = await api("/notes", { method: "POST", json: { title: "Untitled", body: "", folder_key } });
    S.items.unshift({ ...n, snippet: "", has_photos: false }); S.total++; S.totals.all++;
    renderCards(); renderListHead();
    await openNote(n.id);
    titleEl.focus();
    loadFolders().then(renderSide);
  } catch (e) { toast(e.message); }
}

async function quickAdd() {
  const text = quickInput.value.trim();
  if (!text || !S.noteId) return;
  await flushSave();
  try {
    await api(`/notes/${S.noteId}/append`, { method: "POST", json: { text } });
    quickInput.value = "";
    await openNote(S.noteId, { force: true });
    noteScroll.scrollTop = noteScroll.scrollHeight;
    toast("Added to the end");
  } catch (e) { toast(e.message); }
}

async function copyNote() {
  await flushSave();
  const text = `${S.note.title}\n\n${plainText(fromView(editor.storage.markdown.getMarkdown()))}`;
  try { await navigator.clipboard.writeText(text); toast("Copied the text"); }
  catch { toast("Your browser blocked copying — select the text and copy it instead"); }
}

async function duplicateNote() {
  await flushSave();
  try {
    const c = await api(`/notes/${S.noteId}/duplicate`, { method: "POST", json: {} });
    S.items.unshift({ ...c, snippet: plainText(c.body).slice(0, 220) }); S.total++;
    renderCards();
    await openNote(c.id);
    titleEl.focus(); titleEl.select();
    toast("Duplicated — rename the copy");
    loadFolders().then(renderSide);
  } catch (e) { toast(e.message); }
}

async function togglePin() {
  try {
    const r = await api(`/notes/${S.noteId}`, { method: "PATCH", json: { pinned: !S.note.pinned } });
    S.note = { ...S.note, ...r }; S.baseUpdatedAt = r.updated_at; renderBar(); patchItem(r);
    toast(r.pinned ? "Pinned" : "Unpinned");
  } catch (e) { toast(e.message); }
}

async function trashNotes(ids, toTrash) {
  await flushSave();
  try {
    await Promise.all(ids.map((id) => api(`/notes/${id}`, { method: "PATCH", json: { archived: toTrash } })));
    const label = toTrash ? (ids.length > 1 ? `Moved ${ids.length} notes to Trash` : "Moved to Trash") : (ids.length > 1 ? `Restored ${ids.length} notes` : "Restored");
    toast(label, toTrash ? { label: "Undo", run: () => trashNotes(ids, false) } : null);
    S.picked.clear(); renderBulk();
    if (ids.includes(S.noteId)) { if (toTrash && S.view.type !== "trash") { S.noteId = null; S.note = null; renderNote(); writeHash(); } else await openNote(S.noteId, { force: true }); }
    await Promise.all([loadList(true), loadFolders()]);
    renderSide();
  } catch (e) { toast(e.message); }
}

async function moveNotes(ids, folderKey, { quiet = false } = {}) {
  await flushSave();
  try {
    const r = await api("/move", { method: "POST", json: { ids, folder_key: folderKey } });
    if (!quiet) toast(`Moved ${r.moved === 1 ? "note" : `${r.moved} notes`} to ${folderTitle(folderKey)}`);
    S.picked.clear(); renderBulk();
    if (ids.includes(S.noteId) && S.note) {
      const n = await api(`/notes/${S.noteId}`); S.note = { ...S.note, ...n, body: S.note.body }; S.baseUpdatedAt = n.updated_at; renderBar(); renderReview();
    }
    if (S.view.type === "review") { S.items = S.items.filter((n) => !ids.includes(n.id)); S.total = Math.max(0, S.total - ids.length); renderCards(); renderListHead(); }
    else await loadList(true);
    await loadFolders(); renderSide();
    return r;
  } catch (e) { toast(e.message); throw e; }
}

// ── Move dialog ─────────────────────────────────────────────
function moveDialog(ids, { fromReview = false, pick = null, note = null, current: cur = undefined } = {}) {
  const one = note || (ids.length === 1 && S.note && ids[0] === S.noteId ? S.note : (ids.length === 1 ? S.items.find((n) => n.id === ids[0]) : null));
  const current = cur !== undefined ? cur : one?.folder_key || null;
  const suggested = [];
  if (one?.suggested_folder && S.byKey[one.suggested_folder] && one.suggested_folder !== current) suggested.push([one.suggested_folder, "Suggested"]);
  if (one?.suggested_second && S.byKey[one.suggested_second] && one.suggested_second !== one.suggested_folder && one.suggested_second !== current) suggested.push([one.suggested_second, "Also likely"]);
  const recent = JSON.parse(store.get("notes-recent-moves") || "[]").filter((k) => S.byKey[k] && !suggested.some(([s]) => s === k)).slice(0, 4);
  const input = h("input", { placeholder: "Find a folder", "aria-label": "Find a folder" });
  const body = h("div", { class: "dialog-body" });
  const parentSel = h("select", { "aria-label": "Put the new folder inside" },
    h("option", { value: "" }, "At the top level"),
    ...S.folders.map((f) => ({ f, p: pathOf(f.key) })).sort((a, b) => a.p.localeCompare(b.p)).map(({ f, p }) => h("option", { value: f.key, selected: f.key === (S.byKey[current]?.parent_key || "") }, p)));
  const createRow = h("div", { class: "create-row", hidden: true });
  let hot = 0, rows = [];
  const choose = async (key) => {
    close();
    const rm = JSON.parse(store.get("notes-recent-moves") || "[]").filter((k) => k !== key); rm.unshift(key); store.set("notes-recent-moves", JSON.stringify(rm.slice(0, 8)));
    if (pick) { pick(key); return; }
    try {
      await moveNotes(ids, key, { quiet: fromReview });
      if (fromReview) { toast(`Moved to ${folderTitle(key)}`); afterReview(ids[0]); }
    } catch { /* toast shown */ }
  };
  const opt = (key, why) => {
    const b = h("button", { class: "opt", onclick: () => choose(key) }, icon("folder"),
      h("span", {}, h("div", { class: "opt-title" }, S.byKey[key].title), S.byKey[key].parent_key ? h("div", { class: "opt-path" }, pathOf(S.byKey[key].parent_key)) : null),
      why ? h("span", { class: "opt-why" }, why) : null);
    rows.push([b, key]); return b;
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    body.replaceChildren(); rows = []; hot = 0;
    if (!q) {
      if (suggested.length) body.append(h("div", { class: "dialog-label" }, "Suggested"), ...suggested.map(([k, why]) => opt(k, why)));
      if (recent.length) body.append(h("div", { class: "dialog-label" }, "Recently used"), ...recent.map((k) => opt(k)));
    }
    const all = S.folders.filter((f) => f.key !== current).map((f) => ({ f, p: pathOf(f.key) }))
      .filter(({ p }) => !q || p.toLowerCase().includes(q))
      .sort((a, b) => (q ? (a.f.title.toLowerCase().startsWith(q) ? 0 : 1) - (b.f.title.toLowerCase().startsWith(q) ? 0 : 1) : 0) || a.p.localeCompare(b.p));
    body.append(h("div", { class: "dialog-label" }, q ? (all.length ? "Matching folders" : "No folder by that name") : "All folders"), ...all.slice(0, 200).map(({ f }) => opt(f.key)));
    const exact = S.folders.some((f) => f.title.toLowerCase() === q);
    createRow.hidden = !q || exact;
    createRow.replaceChildren(h("button", { class: "btn primary", onclick: async () => {
      try {
        const f = await api("/folders", { method: "POST", json: { title: input.value.trim(), parent_key: parentSel.value || null } });
        await loadFolders(); renderSide(); toast(`Created “${f.title}”`); choose(f.key);
      } catch (e) { toast(e.message); }
    } }, `Create “${input.value.trim()}”`), h("span", {}, "inside"), parentSel);
    rows[0]?.[0].classList.add("hot");
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); rows[hot]?.[0].classList.remove("hot");
      hot = (hot + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(rows.length, 1);
      rows[hot]?.[0].classList.add("hot"); rows[hot]?.[0].scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && rows[hot]) { e.preventDefault(); choose(rows[hot][1]); }
    if (e.key === "Escape") close();
  });
  const what = ids.length === 1 ? `“${(one?.title || "this note").slice(0, 60)}”` : `${ids.length} notes`;
  const verb = pick ? "File" : "Move";
  const scrim = h("div", { class: "scrim", onclick: (e) => { if (e.target === scrim) close(); } },
    h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "Move to a folder" },
      h("div", { class: "dialog-head" }, h("h2", {}, `${verb} ${what}`), input), body, createRow));
  const close = () => { scrim.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  document.body.append(scrim);
  draw(); input.focus();
}

// ── Quick review: every "Needs a look" note on one screen ─────
// Rows are grouped by the folder each note should end up in. Checked rows get filed with one click;
// unchecked rows stay in Needs a look. Nothing moves until a Confirm button is pressed.
async function openQuickReview() {
  await flushSave();
  document.querySelector(".qr")?.remove();
  const Q = { rows: [], target: new Map(), on: new Set(), busy: false, filed: 0, peekId: null };
  const head = h("header", { class: "qr-head" });
  const body = h("div", { class: "qr-body" }, h("p", { class: "qr-note" }, "Loading the notes…"));
  const peek = h("aside", { class: "qr-peek", hidden: true, "aria-label": "Note preview" });
  const foot = h("footer", { class: "qr-foot" });
  const wrap = h("div", { class: "qr", role: "dialog", "aria-modal": "true", "aria-label": "Quick review" },
    head, h("div", { class: "qr-main" }, body, peek), foot);
  document.body.append(wrap);

  const close = async () => {
    if (Q.busy) return;
    document.removeEventListener("keydown", onKey);
    wrap.remove();
    await loadFolders(); renderSide();
    if (S.view.type === "review") await loadList(true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape" || document.querySelector(".scrim, .menu")) return;
    if (!peek.hidden) { peek.hidden = true; Q.peekId = null; draw(); } else close();
  };
  document.addEventListener("keydown", onKey);

  head.replaceChildren(
    h("div", {}, h("h1", {}, "Quick review"), h("p", { class: "qr-sub" }, "Loading…")),
    h("button", { class: "icon-btn", "aria-label": "Close quick review", onclick: close }, icon("x")));

  try {
    let total = Infinity;
    while (Q.rows.length < total && Q.rows.length < 2000) {
      const r = await api(`/notes?review=1&sort=title&photos=1&limit=200&offset=${Q.rows.length}`);
      total = r.total;
      if (!r.notes.length) break;
      Q.rows.push(...r.notes.filter((n) => !Q.rows.some((m) => m.id === n.id)));
    }
  } catch (e) { body.replaceChildren(h("p", { class: "qr-note" }, e.message)); return; }

  for (const n of Q.rows) {
    const t = n.suggested_folder && S.byKey[n.suggested_folder] ? n.suggested_folder : n.folder_key;
    Q.target.set(n.id, t);
    n.section = n.review_note ? "check" : t !== n.folder_key ? "move" : "keep";
    if (!n.review_note) Q.on.add(n.id);
  }

  const live = () => Q.rows.filter((n) => !n.done);
  const groupsOf = (rows) => {
    const m = new Map();
    for (const n of rows) { const k = Q.target.get(n.id) || ""; if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
    return [...m.entries()].sort((a, b) => pathOf(a[0]).localeCompare(pathOf(b[0])));
  };

  async function file(ids, label) {
    ids = ids.filter((id) => Q.on.has(id) && !Q.rows.find((n) => n.id === id)?.done);
    if (!ids.length || Q.busy) return;
    Q.busy = true; draw();
    const byFolder = new Map();
    for (const id of ids) { const k = Q.target.get(id) || null; if (!byFolder.has(k)) byFolder.set(k, []); byFolder.get(k).push(id); }
    let ok = 0, moved = 0;
    try {
      for (const [folder, list] of byFolder) {
        for (let i = 0; i < list.length; i += 100) {
          const part = list.slice(i, i + 100);
          const r = await api("/move", { method: "POST", json: { ids: part, folder_key: folder } });
          ok += part.length; moved += r.changed ?? 0;
          for (const id of part) { const n = Q.rows.find((x) => x.id === id); if (n) n.done = true; }
        }
      }
      Q.filed += ok;
      S.totals.review = Math.max(0, S.totals.review - ok);
      toast(label || `Filed ${plural(ok, "note")}${moved ? ` (${moved} moved to a new folder)` : ""}`);
    } catch (e) { toast(`Stopped after ${plural(ok, "note")}: ${e.message}`); }
    finally { Q.busy = false; draw(); }
  }

  async function trash(n) {
    try {
      await api(`/notes/${n.id}`, { method: "PATCH", json: { archived: true } });
      n.done = true; Q.on.delete(n.id); S.totals.review = Math.max(0, S.totals.review - 1);
      if (Q.peekId === n.id) { peek.hidden = true; Q.peekId = null; }
      draw();
      toast("Moved to Trash", { label: "Undo", run: async () => {
        try { await api(`/notes/${n.id}`, { method: "PATCH", json: { archived: false } }); n.done = false; S.totals.review++; draw(); }
        catch (e) { toast(e.message); }
      } });
    } catch (e) { toast(e.message); }
  }

  async function showPeek(n) {
    Q.peekId = n.id; peek.hidden = false; draw();
    peek.replaceChildren(h("p", { class: "qr-note" }, "Loading…"));
    try {
      const full = await api(`/notes/${n.id}`);
      if (Q.peekId !== n.id) return;
      peek.replaceChildren(
        h("div", { class: "qr-peek-head" },
          h("button", { class: "icon-btn", "aria-label": "Close preview", onclick: () => { peek.hidden = true; Q.peekId = null; draw(); } }, icon("x")),
          h("button", { class: "btn", onclick: async () => { await close(); go({ type: "review" }, { keepNote: true }); openNote(n.id); } }, "Open to edit")),
        h("h2", {}, full.title || "Untitled"),
        h("p", { class: "qr-peek-meta" }, `In ${pathOf(full.folder_key, " › ") || "Unfiled"}${full.notebook ? ` · From Evernote: ${[full.stack, full.notebook].filter(Boolean).join(" › ")}` : ""}`),
        full.body.trim() ? h("div", { class: "prose", html: mdView.render(toView(full.body, full.file_urls)) }) : h("p", { class: "qr-note" }, "This note is empty."));
      peek.scrollTop = 0;
    } catch (e) { peek.replaceChildren(h("p", { class: "qr-note" }, e.message)); }
  }

  function rowFor(n) {
    const tgt = Q.target.get(n.id);
    const changed = tgt !== (n.suggested_folder && S.byKey[n.suggested_folder] ? n.suggested_folder : n.folder_key);
    const cb = h("input", { type: "checkbox", checked: Q.on.has(n.id), "aria-label": `Include ${n.title}`, disabled: Q.busy,
      onchange: (e) => { if (e.target.checked) Q.on.add(n.id); else Q.on.delete(n.id); draw(); } });
    const where = [];
    if (tgt !== n.folder_key) where.push(h("span", { class: "qr-from" }, `from ${folderTitle(n.folder_key)}`));
    if (changed) where.push(h("span", { class: "qr-changed" }, `your pick: ${folderTitle(tgt)}`));
    return h("div", { class: "qr-row" + (Q.on.has(n.id) ? "" : " off") + (Q.peekId === n.id ? " peeking" : ""), "data-id": n.id },
      cb,
      h("button", { class: "qr-open", title: "Preview this note", onclick: () => showPeek(n) },
        n.photo ? h("img", { class: "qr-thumb", src: n.photo, alt: "", loading: "lazy" }) : null,
        h("span", { class: "qr-text" },
          h("span", { class: "qr-title" }, n.title || "Untitled"),
          n.review_note ? h("span", { class: "qr-warn" }, n.review_note) : h("span", { class: "qr-snip" }, n.snippet && n.snippet !== "[photo]" ? n.snippet : n.photo ? "Photo" : "Empty note"),
          where.length ? h("span", { class: "qr-where" }, ...where) : null)),
      h("span", { class: "qr-acts" },
        h("button", { class: "qr-btn", disabled: Q.busy, onclick: () => moveDialog([n.id], { note: { ...n, folder_key: tgt }, current: tgt, pick: (key) => { Q.target.set(n.id, key); Q.on.add(n.id); draw(); } }) }, "Change"),
        n.section === "check" ? h("button", { class: "qr-btn bad", disabled: Q.busy, onclick: () => trash(n) }, "Trash") : null));
  }

  function section(key, title, hint) {
    const rows = live().filter((n) => n.section === key);
    if (!rows.length) return null;
    const sec = h("section", { class: "qr-sec" }, h("div", { class: "qr-sec-head" }, h("h2", {}, `${title} `, h("span", {}, String(rows.length))), h("p", {}, hint)));
    for (const [folder, list] of groupsOf(rows)) {
      const onCount = list.filter((n) => Q.on.has(n.id)).length;
      const all = h("input", { type: "checkbox", checked: onCount === list.length, "aria-label": `Include all in ${folderTitle(folder)}`, disabled: Q.busy,
        onchange: (e) => { for (const n of list) { if (e.target.checked) Q.on.add(n.id); else Q.on.delete(n.id); } draw(); } });
      all.indeterminate = onCount > 0 && onCount < list.length;
      const parent = S.byKey[folder]?.parent_key;
      sec.append(h("div", { class: "qr-group" },
        h("div", { class: "qr-ghead" },
          all,
          h("span", { class: "qr-gname" }, icon("folder"), h("b", {}, folderTitle(folder)), parent ? h("span", { class: "qr-gpath" }, pathOf(parent, " › ")) : null),
          key !== "check" ? h("button", { class: "btn sm" + (key === "move" ? " primary" : ""), disabled: Q.busy || !onCount,
            onclick: () => file(list.map((n) => n.id)) }, onCount === list.length ? `File ${onCount === 1 ? "it" : `all ${onCount}`}` : `File ${onCount} checked`) : null),
        ...list.map(rowFor)));
    }
    return sec;
  }

  function draw() {
    const keep = body.scrollTop;
    const rows = live();
    const moving = rows.filter((n) => n.section === "move").length;
    const checking = rows.filter((n) => n.section === "check").length;
    head.firstChild.replaceChildren(h("h1", {}, "Quick review"),
      h("p", { class: "qr-sub" }, rows.length
        ? `${plural(rows.length, "note")} left. ${moving ? `${moving} should move to a better folder. ` : ""}${checking ? `${checking} need you to look. ` : ""}The rest are in the right place.`
        : "All done."));
    if (!rows.length) {
      body.replaceChildren(h("div", { class: "qr-done" }, h("h2", {}, Q.filed ? `Filed ${plural(Q.filed, "note")}` : "Nothing left to review"),
        h("p", {}, "Every note now has a folder you’ve confirmed. You can still move any note later from its folder name at the top."),
        h("button", { class: "btn primary", onclick: close }, "Back to notes")));
      foot.replaceChildren(); return;
    }
    body.replaceChildren(
      h("p", { class: "qr-how" }, "Each group shows where the notes will go. Uncheck anything that looks wrong, or press Change to pick a different folder. Click a title to see the whole note. Unchecked notes stay in Needs a look."),
      section("check", "Look at these first", "Empty notes and things that belong somewhere safer. These start unchecked."),
      section("move", "Moving to a better folder", "These were filed in the wrong place. Here’s where they belong."),
      section("keep", "Staying where they are", "These are already in the right folder. Confirming just clears the flag."),
    );
    body.scrollTop = keep;
    const onIds = rows.filter((n) => Q.on.has(n.id)).map((n) => n.id);
    foot.replaceChildren(
      h("span", { class: "qr-count" }, Q.busy ? "Filing…" : `${onIds.length} of ${rows.length} checked`),
      h("button", { class: "btn", onclick: close, disabled: Q.busy }, "Finish later"),
      h("button", { class: "btn primary", disabled: Q.busy || !onIds.length, onclick: () => file(onIds) }, `Confirm ${onIds.length === rows.length ? "all " : ""}${onIds.length}`));
  }
  draw();
}

// ── Popover menu ────────────────────────────────────────────
function openMenu(anchor, items) {
  document.querySelector(".menu")?.remove();
  const m = h("div", { class: "menu", role: "menu" },
    ...items.map((it) => h("button", { role: "menuitem", class: it.bad ? "bad" : "", onclick: () => { m.remove(); it.run(); } }, it.label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, hgt = m.offsetHeight;
  m.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w)) + "px";
  m.style.top = (r.bottom + hgt + 8 > window.innerHeight ? r.top - hgt - 6 : r.bottom + 6) + "px";
  m.querySelector("button")?.focus();
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off, true); document.removeEventListener("keydown", offKey, true); } };
  const offKey = (e) => { if (e.key === "Escape") { m.remove(); document.removeEventListener("mousedown", off, true); document.removeEventListener("keydown", offKey, true); } };
  setTimeout(() => { document.addEventListener("mousedown", off, true); document.addEventListener("keydown", offKey, true); });
}

// ── History ─────────────────────────────────────────────────
async function openHistory() {
  await flushSave();
  note.querySelector(".slide")?.remove();
  const body = h("div", { class: "slide-body" }, h("p", { style: { padding: "16px", color: "var(--ink-2)" } }, "Loading…"));
  const panel = h("div", { class: "slide", role: "dialog", "aria-label": "Version history" },
    h("div", { class: "slide-head" }, h("h2", {}, "History"), h("button", { class: "icon-btn", "aria-label": "Close history", onclick: () => panel.remove() }, icon("x"))), body);
  note.append(panel);
  const onKey = (e) => { if (e.key === "Escape") { panel.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  try {
    const { versions } = await api(`/notes/${S.noteId}/history`);
    if (!versions.length) { body.replaceChildren(h("p", { style: { padding: "16px", color: "var(--ink-2)" } }, "No earlier versions yet. Once this note is changed, the version before each change shows up here.")); return; }
    const showList = () => body.replaceChildren(...versions.map((v) => h("button", { class: "version", onclick: () => preview(v) },
      h("div", { class: "when" }, fmtDate(v.saved_at, true)),
      h("div", { class: "who" }, [v.edited_by ? person(v.edited_by) : null, v.folder_key !== S.note.folder_key ? `in ${folderTitle(v.folder_key)}` : null].filter(Boolean).join(" · ") || " "),
      h("p", {}, plainText(v.body).replace(/\s+/g, " ").slice(0, 200) || "(empty)"))));
    const preview = (v) => {
      const content = h("div", { class: "prose", html: mdView.render(toView(v.body, S.note.file_urls)) });
      body.replaceChildren(h("div", { class: "version-preview" },
        h("div", { class: "actions" },
          h("button", { class: "btn", onclick: showList }, "Back"),
          h("button", { class: "btn primary", onclick: async () => {
            try {
              await api(`/notes/${S.noteId}/restore`, { method: "POST", json: { version_id: v.id } });
              panel.remove(); await openNote(S.noteId, { force: true });
              toast(`Restored the version from ${fmtDate(v.saved_at, true)}`);
            } catch (e) { toast(e.message); }
          } }, "Restore this version")),
        h("h1", { style: { font: "600 26px/1.1 var(--cond)", margin: "4px 0 12px" } }, v.title), content));
    };
    showList();
  } catch (e) { body.replaceChildren(h("p", { style: { padding: "16px" } }, e.message)); }
}

// ── Gym-floor display ───────────────────────────────────────
async function openDisplay() {
  await flushSave();
  const md = S.bodyDirty ? fromView(editor.storage.markdown.getMarkdown()) : S.note.body;  // unsaved edits show too
  const fit = h("div", { class: "fit", html: mdView.render(toView(md, S.note.file_urls)) });
  const area = h("div", { class: "gym-body" }, fit);
  const clock = h("span", { class: "clock" });
  const tick = () => { clock.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
  tick(); const clockT = setInterval(tick, 15000);
  let scale = 1, spot = -1;
  const items = () => [...fit.querySelectorAll("li")];
  const spotBtn = h("button", { "aria-pressed": "false", onclick: () => setSpot(spot < 0 ? 0 : -1) }, "Spotlight");
  const setSpot = (i) => {
    const li = items(); if (!li.length) return;
    spot = i < 0 ? -1 : Math.max(0, Math.min(li.length - 1, i));
    area.classList.toggle("spot", spot >= 0);
    spotBtn.setAttribute("aria-pressed", String(spot >= 0));
    li.forEach((el, k) => el.classList.toggle("now", k === spot));
    if (spot >= 0) li[spot].scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const autoFit = () => {
    let vw = 7.5;
    fit.style.fontSize = vw * scale + "vw";
    while (area.scrollHeight > area.clientHeight + 2 && vw > 2.2) { vw -= 0.25; fit.style.fontSize = vw * scale + "vw"; }
    area.style.overflowY = area.scrollHeight > area.clientHeight + 2 ? "auto" : "hidden";
  };
  const wrap = h("div", { class: "gym", role: "dialog", "aria-label": `Display: ${S.note.title}` },
    h("div", { class: "gym-top" }, h("h1", {}, S.note.title), clock),
    area,
    h("div", { class: "gym-bar" },
      h("span", { class: "hint" }, "Space or arrows to step through · Esc to close"),
      h("button", { "aria-label": "Smaller text", onclick: () => { scale = Math.max(0.5, scale - 0.12); autoFit(); } }, "A−"),
      h("button", { "aria-label": "Larger text", onclick: () => { scale = Math.min(2.4, scale + 0.12); autoFit(); } }, "A+"),
      spotBtn,
      h("button", { onclick: () => close() }, "Close")));
  const close = () => { clearInterval(clockT); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", autoFit); wrap.remove(); document.exitFullscreen?.().catch(() => {}); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") { e.preventDefault(); setSpot(spot + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setSpot(spot - 1 < 0 ? 0 : spot - 1); }
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", autoFit);
  document.body.append(wrap);
  wrap.requestFullscreen?.().catch(() => {});
  fit.querySelectorAll("img").forEach((img) => img.addEventListener("load", autoFit));
  requestAnimationFrame(autoFit);
  setTimeout(autoFit, 350);
}

// ── Keyboard ────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); newNote(); }
});

// ── Sign-in (standalone use) ────────────────────────────────
function readKey() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("key");
  if (fromUrl) {
    store.set(KEY_STORE, fromUrl);
    url.searchParams.delete("key");
    history.replaceState(null, "", url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : "") + url.hash);
    return fromUrl;
  }
  return store.get(KEY_STORE);
}
// Built as a normal username + password form so Bitwarden (or any password manager) offers to save
// the key and fills it next time. The name only labels the saved login; the key decides who you are.
function showSignIn(err) {
  document.body.replaceChildren();
  const name = h("input", { id: "notes-name", name: "username", autocomplete: "username", placeholder: "Dave or Doreen", value: store.get("notes-last-name") || "" });
  const input = h("input", { id: "notes-key", name: "password", type: "password", autocomplete: "current-password", placeholder: "Paste your key or brief link", required: true });
  const form = h("form", { method: "post", action: "#", onsubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    const m = t.match(/[?&]key=([^&#\s]+)/);
    const key = m ? decodeURIComponent(m[1]) : t;
    if (!key) return;
    if (name.value.trim()) store.set("notes-last-name", name.value.trim());
    store.set(KEY_STORE, key); cfg.key = key;
    start();
  } },
    h("h1", {}, "Studio Strong Notes"),
    h("p", {}, "Use the same key as your morning brief. Paste the key, or the whole brief link."),
    h("label", { for: "notes-name" }, "Name"),
    name,
    h("label", { for: "notes-key" }, "Key"),
    input,
    h("button", { type: "submit" }, "Open notes"),
    err ? h("p", { class: "err" }, err) : null,
    h("p", { class: "hint" }, "Bitwarden will offer to save this. Save one login per person and pick the right one with Switch."));
  document.body.append(h("div", { class: "signin" }, form));
  (name.value ? input : name).focus();
}

// Sign out on this device and sign in as someone else (the brief page on this device switches too).
async function switchPerson() {
  await flushSave();
  store.del(KEY_STORE);
  location.hash = "";
  location.reload();
}

// ── Start ───────────────────────────────────────────────────
async function detectMode() {
  if (window.NOTES_API) { cfg.base = window.NOTES_API; cfg.mode = "drawer"; return; }
  try {
    const r = await fetch("/api/notes/me", { credentials: "same-origin" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) { cfg.base = "/api/notes"; cfg.mode = "drawer"; return; }
  } catch { /* not inside the Drawer */ }
  cfg.base = FUNCTION_URL; cfg.mode = "key"; cfg.key = cfg.key || readKey();
}

async function start() {
  applyTheme();
  if (!cfg.base) await detectMode();
  if (cfg.mode === "key" && !cfg.key) return showSignIn();
  try {
    S.me = await api("/me");
  } catch (e) {
    if (e.status === 401 && cfg.mode === "key") { store.del(KEY_STORE); cfg.key = null; return showSignIn("That key didn’t work. Check it and try again."); }
    document.body.replaceChildren(h("div", { class: "signin" }, h("form", {}, h("h1", {}, "Notes"), h("p", {}, e.message))));
    return;
  }
  document.body.replaceChildren(app, toasts, fileInput);
  if (homeAtStart) showHome(true);
  makeEditor(); renderToolbar();
  await loadFolders();
  api("/notes?limit=1").then((r) => { S.totals.all = r.total; renderSide(); }).catch(() => {});
  const { view, noteId } = readHash();
  S.view = view;
  if (view.type === "search") searchInput.value = view.q;
  renderSide(); renderListHead(); renderNote();
  await go(view, { keepNote: !!noteId });
  if (noteId) openNote(noteId, { stayOnList: window.innerWidth <= 860 });
  homeReady = true;
  if (homePending) { homePending(); homePending = null; }
}

// ── Start page ──────────────────────────────────────────────
// Opening Notes with nothing in the address lands here: search, Folders, and a quick note.
// Links to a folder, search or note skip it. Tapping "Notes" at the top of the folder list brings it back.
const homeAtStart = !location.hash.replace(/^#/, "");
let homeEl = null, homeReady = false, homePending = null;
function showHome(show) {
  if (!show) {
    if (homeEl) { homeEl.remove(); homeEl = null; placeQuickNote(); }
    return;
  }
  if (homeEl) return;
  const input = h("input", { type: "search", placeholder: "Search notes, or #tag", "aria-label": "Search notes", autocomplete: "off", enterkeyhint: "search" });
  const leave = (fn) => { showHome(false); if (fn) { if (homeReady) fn(); else homePending = fn; } };
  const form = h("form", { class: "home-search", role: "search", onsubmit: (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    leave(() => { const tag = tagFor(q); searchInput.value = q; if (tag) go({ type: "tag", tag: tag.tag }, { keepNote: true }); else go({ type: "search", q }); });
  } }, icon("search"), input, h("button", { type: "submit", class: "home-go" }, "Search"));
  const link = (label, fn) => h("button", { type: "button", onclick: () => leave(fn) }, label);
  homeEl = h("div", { class: "home", role: "dialog", "aria-label": "Notes start page", onkeydown: (e) => { if (e.key === "Escape") leave(); } },
    h("div", { class: "home-in" },
      h("p", { class: "home-brand" }, h("b", {}, "Notes"), h("span", {}, "Studio Strong")),
      form,
      h("button", { type: "button", class: "home-menu", onclick: () => leave(() => setPane("side")) }, icon("menu"), h("span", {}, "Folders")),
      quickNote,
      h("div", { class: "home-links" },
        link("All notes", () => go({ type: "all" })),
        link("Pinned", () => go({ type: "pinned" })),
        link("Needs a look", () => go({ type: "review" })),
        link("New note", () => newNote()))));
  quickNote.hidden = false;
  document.body.append(homeEl);
  if (matchMedia("(pointer: fine)").matches) input.focus();
}

start();
