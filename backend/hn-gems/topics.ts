// ============================================================
// Topics for the hn-gems function (pure, so it can be unit tested).
//
// Every post gets one or two topics from a fixed list, so what he keeps can be browsed and searched later
// ("do I have anything for a gym?"). Plain keyword rules: no model, nothing hidden, the same answer every time,
// and it works on the live Discover list, where nothing can be asked of Jev. A topic can also be set by hand
// (the topics column), for example after Jev has looked at saved posts; a set value always wins.
//
// The list was chosen with Jev: Jev sorted 100 of his history posts into it, and the rules below were tuned and
// then checked against Jev's answers on posts the rules had not seen (see claude/hn-gems.md).
// ============================================================

export const TOPICS = {
  ai: "AI & agents",
  dev: "Developer tools",
  apps: "Everyday apps",
  biz: "Business & marketing",
  fitness: "Health & fitness",
  money: "Money & investing",
  learn: "Learning & writing",
  creative: "Games & creative",
  hardware: "Hardware & making",
  data: "Data & science",
  life: "Home & family",
  other: "Other",
} as const;
export type Topic = keyof typeof TOPICS;
export const TOPIC_KEYS = Object.keys(TOPICS) as Topic[];
export const isTopic = (x: unknown): x is Topic => typeof x === "string" && Object.prototype.hasOwnProperty.call(TOPICS, x);

// word → weight. A word in the title counts 3 times as much as one in the text (and a word in the text counts at most 3 times).
// Prefix words end in * ("invest*" = invest, investing, investor).
const RULES: Record<Exclude<Topic, "other">, Record<string, number>> = {
  ai: { "agent*": 3, mcp: 4, "llm*": 2, gpt: 2, chatgpt: 2, claude: 2, openai: 2, "prompt*": 2, copilot: 2, "chatbot*": 3, "generative": 2, "embedding*": 3, rag: 3, "ai": 2, "ml": 1, "machine learning": 2, "neural": 2, "vision-language": 2, vlm: 2, "voice dictation": 2, "stateless": 1, "inference": 3, "moe": 3, "transformer*": 2, "gpu*": 1, "speech": 2, "stt": 3, "tts": 3, "voice ai": 4, "voice": 1, "ocr": 1, "diffusion": 2, "fine-tun*": 3, "decision model": 3, "agentic": 3, "harness": 2, "ollama": 4, "deepseek": 3, "local model*": 3, "context window*": 3, "model*": 0.5, "conversational": 2 },
  dev: { cli: 4, sdk: 4, api: 2, "library": 2, framework: 3, compiler: 4, "self-hosted": 2, "backend": 2, "database*": 3, sql: 3, postgres: 3, sqlite: 3, redis: 2, python: 2, rust: 3, typescript: 3, javascript: 2, golang: 3, "github": 1, git: 2, devops: 3, "deploy*": 2, "docker": 3, kubernetes: 3, "scheduler": 2, "scheduling": 2, "chrome extension": 3, "browser extension": 3, "html": 1, "css": 2, "json": 2, "terminal": 2, "debug*": 3, "developer*": 2, "devs": 2, "code": 1, "router": 2, "protocol": 2, "runtime": 2, "microservice*": 3, "webhook*": 3, "self host*": 2, "wasm": 3, "webgpu": 3, "webassembly": 3, "github pages": 3, "static site*": 3, "push notification*": 3 },
  apps: { "app": 1, "pwa": 3, "ios": 2, "android": 2, "macos": 2, "windows": 1, "iphone": 2, "extension": 1, "notes": 2, "note-taking": 3, "calendar": 2, "to-do": 2, "todo": 2, "photo*": 2, "clipboard": 3, "screenshot*": 2, "offline": 1, "local-first": 2, "no signup": 2, "no account": 2, "privacy": 1, "bookmark*": 3, "reminder*": 2, "productivity": 3, "image search": 2, "search your": 1, "email": 2, "tasks": 2, "task list*": 3, "link shortener": 3, "password*": 2, "archiv*": 2, "annotat*": 3, "face recognition": 2, "browser": 1, "sidebar": 1 },
  biz: { "startup*": 3, "founder*": 3, "customer*": 2, "sales": 3, "marketing": 4, "seo": 4, "ads": 3, "advertis*": 3, "social media": 3, "lead*": 2, "product-market": 4, "revenue": 3, "pricing": 2, "saas": 3, "small business": 4, "business owner*": 4, "invoice*": 3, "contract*": 2, "crm": 4, "newsletter": 2, "blog*": 2, "content": 2, "brand*": 2, "e-commerce": 3, "ecommerce": 3, "shopify": 3, "etsy": 3, "freelanc*": 3, "agency": 2, "profitable": 2, "side project*": 2, "growth": 1, "yc": 1, "icp": 3, "outreach": 3, "support agent": 2, "customer support": 3, "booking": 2, "clients": 2, "client": 1, "your business": 3, "my business": 3, "businesses": 2, "gtm": 4, "churn": 4, "upsell": 4, "roadmap": 2, "validate": 1, "idea*": 1 },
  fitness: { "fitness": 4, "workout*": 4, "exercise*": 3, "gym": 4, "training": 1, "health": 3, "healthcare": 3, "medical": 4, "clinic*": 3, "clinical": 3, "patient*": 3, "doctor*": 3, "diet": 3, "nutrition": 4, "calorie*": 3, "sleep": 3, "meditat*": 4, "mindful*": 3, "wellness": 4, "wearable*": 4, "garmin": 4, "whoop": 4, "oura": 4, "heart rate": 3, "running": 2, "marathon": 3, "yoga": 4, "strength": 2, "hormone*": 4, "longevity": 4, "lab results": 3, "mental health": 4, "therapy": 3, "injur*": 3, "pain": 2, "supplement*": 3, "biomarker*": 4 },
  money: { "stock*": 4, "invest*": 4, "trader*": 3, "trading": 4, "portfolio*": 3, "finance": 4, "financial": 4, "fintech": 3, "bitcoin": 4, "crypto*": 4, "ethereum": 3, "retire*": 3, "401k": 4, "tsp": 4, "tax": 4, "taxes": 4, "budget*": 3, "bank*": 3, "mortgage*": 3, "loan*": 3, "credit": 2, "etf*": 4, "option*": 1, "forex": 4, "market data": 3, "prediction market*": 4, "polymarket": 4, "kalshi": 4, "valuation": 3, "earnings": 3, "sec filing*": 4, "sec data": 4, "sec edgar": 4, "wealth": 3, "dividend*": 4, "gold": 2, "silver": 1, "commodit*": 3, "ticker": 3, "fi calculator": 4, "accounting": 3, "bookkeeping": 4, "payments": 2, "expense*": 3 },
  learn: { "learn*": 2, "education*": 4, "educator*": 4, "teacher*": 3, "student*": 3, "course*": 3, "lecture*": 4, "exam*": 3, "quiz*": 3, "flashcard*": 4, "school": 3, "university": 3, "tutor*": 4, "book*": 2, "ebook": 3, "epub": 4, "reading": 2, "writing": 3, "essay*": 3, "article*": 1, "research": 2, "paper*": 1, "language learning": 4, "vocabulary": 4, "study": 2, "knowledge": 2, "wiki": 2, "notes app": 1, "podcast*": 2, "transcript*": 2, "summar*": 2, "documentation": 1, "tutorial*": 3, "foresight": 2, "horizon scanning": 3, "trend*": 1 },
  creative: { "game*": 3, "gaming": 4, "gamedev": 4, "playable": 3, "puzzle*": 3, "chess": 4, "music": 4, "song*": 3, "audio": 2, "video": 2, "photo editing": 3, "art": 2, "artist*": 3, "drawing": 3, "design": 1, "designer*": 2, "illustrat*": 3, "generative": 1, "animation*": 3, "3d": 2, "creative": 3, "story*": 1, "fiction": 3, "poem*": 3, "sport*": 3, "nba": 4, "nfl": 4, "soccer": 4, "golf": 4, "tennis": 4, "fantasy": 1, "landscape*": 2, "pixel": 3, "shader*": 4, "canvas": 1, "fonts": 2, "typography": 3, "movie*": 3, "film*": 3, "anime": 3, "comic*": 3, "video editor": 4, "capcut": 4, "cinematic": 3, "visualizer*": 3, "music visualizer": 4, "reactive art": 4 },
  hardware: { "hardware": 4, "arduino": 5, "esp32": 5, "raspberry": 4, "sensor*": 4, "iot": 4, "robot*": 4, "drone*": 4, "3d print*": 5, "pcb": 5, "circuit*": 4, "firmware": 5, "microcontroller*": 5, "led": 2, "device*": 1, "smart home": 4, "home assistant": 5, "home automation": 5, "camera": 1, "battery": 3, "electronics": 4, "fpga": 5, "soldering": 5, "bluetooth": 2, "gps": 2, "wifi": 1, "lora": 4, "cnc": 5, "keyboard": 2, "mechanical": 1, "diy": 3, "maker": 2, "chip*": 3, "gpu*": 2, "lpu": 4, "asic": 4 },
  data: { "data": 1, "dataset*": 4, "analytics": 3, "analysis": 1, "analyz*": 1, "visualiz*": 4, "chart*": 3, "dashboard*": 3, "statistic*": 3, "science": 2, "scientific": 3, "scientist*": 3, "math": 3, "mathematic*": 4, "physics": 4, "biology": 4, "genom*": 4, "dna": 4, "astronomy": 4, "climate": 3, "map*": 1, "geospatial": 4, "satellite*": 4, "simulation*": 3, "csv": 2, "spreadsheet*": 2, "pandas": 4, "jupyter": 4, "scrap*": 2, "crawl*": 2, "etl": 3, "openstreetmap": 4, "weather": 3, "census": 4, "public data": 4, "open data": 4, "photogrammetry": 4, "food prices": 3, "usda": 3, "price data": 3, "forecast*": 1, "risk": 1 },
  life: { "family": 3, "kids": 3, "children": 3, "parent*": 3, "wife": 3, "husband": 3, "home": 1, "household": 4, "grocery": 4, "groceries": 4, "recipe*": 4, "cooking": 4, "food": 3, "restaurant*": 3, "meal*": 3, "travel*": 4, "trip*": 3, "vacation*": 4, "flight*": 3, "hotel*": 3, "garden*": 4, "pet": 3, "pets": 3, "dog": 3, "dogs": 3, "cat": 1, "wedding": 4, "chores": 4, "neighbor*": 3, "local": 1, "city": 1, "real estate": 3, "rental*": 2, "apartment*": 3, "car": 1, "cars": 1, "commute": 3, "gift*": 3, "habit*": 2, "journal*": 2 },
};

// ── the matcher ──
// A post is cut into words once, and the keyword table is looked up (exact words by lookup, "word*" by prefix
// bucket, phrases by search), so a few hundred posts take a few milliseconds, not a regex pass per keyword.
type T = Exclude<Topic, "other">;
interface Key { topic: T; w: number; word: string }
const EXACT = new Map<string, Key[]>(), PREFIX = new Map<string, Key[]>(), PHRASES: Array<Key & { prefix: boolean }> = [];
const push = (m: Map<string, Key[]>, k: string, v: Key) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
const normWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9*]+/g, " ").trim();
for (const [topic, words] of Object.entries(RULES) as Array<[T, Record<string, number>]>) {
  for (const [raw, w] of Object.entries(words)) {
    const prefix = raw.endsWith("*"), word = normWord(raw).replace(/\*$/, "").trim();
    if (!word || !w) continue;
    const key: Key = { topic, w, word };
    if (word.includes(" ")) PHRASES.push({ ...key, prefix });
    else if (prefix) push(PREFIX, word.slice(0, 3), key);
    else push(EXACT, word, key);
  }
}

const stripUrls = (s: string) => String(s ?? "").replace(/https?:\/\/\S+/g, " ");
const norm = (s: string) => " " + stripUrls(s).toLowerCase().replace(/&[a-z#0-9]+;/g, " ").replace(/[^a-z0-9]+/g, " ").trim() + " ";

// Adds the weight of every keyword found in one piece of text (a keyword counts at most `cap` times).
function scoreField(raw: string, cap: number, mult: number, out: Record<T, number>) {
  const text = norm(raw);
  if (text.length < 4) return;
  const counts = new Map<string, number>();
  for (const t of text.trim().split(" ")) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, n] of counts) { const ex = EXACT.get(t); if (ex) for (const k of ex) out[k.topic] += mult * k.w * Math.min(n, cap); }
  const pc = new Map<Key, number>();
  for (const [t, n] of counts) { const b = PREFIX.get(t.slice(0, 3)); if (b) for (const k of b) if (t.startsWith(k.word)) pc.set(k, (pc.get(k) ?? 0) + n); }
  for (const [k, n] of pc) out[k.topic] += mult * k.w * Math.min(n, cap);
  for (const k of PHRASES) {
    const needle = " " + k.word + (k.prefix ? "" : " ");
    let n = 0, i = 0;
    while (n < cap && (i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length - 1; }
    if (n) out[k.topic] += mult * k.w * n;
  }
}

export interface TopicDoc { title: string; text?: string | null; note?: string | null; tags?: string[] }

// The score of every topic for one post (for tests and for explaining a choice).
// A word in the title counts 3 times as much as one in the text, and so do his own words (reason and note).
export function topicScores(d: TopicDoc): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const k of Object.keys(RULES) as T[]) out[k] = 0;
  scoreField(String(d.title ?? "").replace(/^\s*(show|ask) hn\s*[:\-–—]?\s*/i, ""), 2, 3, out);
  scoreField(String(d.text ?? "").slice(0, 6000), 3, 1, out);
  scoreField([d.note ?? "", ...(d.tags ?? [])].join(" . "), 2, 3, out);
  return out;
}

export const MIN_SCORE = 6;        // below this the post says too little to file
const SECOND_SHARE = 0.5;          // a second topic must score at least this share of the first

// One or two topics, best first. "other" when nothing stands out.
export function topicsOf(d: TopicDoc): Topic[] {
  const s = topicScores(d);
  const ranked = (Object.entries(s) as Array<[Exclude<Topic, "other">, number]>).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < MIN_SCORE) return ["other"];
  const out: Topic[] = [ranked[0][0]];
  if (ranked[1] && ranked[1][1] >= MIN_SCORE && ranked[1][1] >= SECOND_SHARE * ranked[0][1]) out.push(ranked[1][0]);
  return out;
}

// A topic list that was set by hand wins; anything that isn't a topic is dropped; at most two.
export function cleanTopics(x: unknown): Topic[] {
  if (!Array.isArray(x)) return [];
  const out: Topic[] = [];
  for (const t of x) if (isTopic(t) && !out.includes(t)) out.push(t);
  return out.slice(0, 2);
}
export const topicsFor = (d: TopicDoc, set?: unknown): Topic[] => { const c = cleanTopics(set); return c.length ? c : topicsOf(d); };
