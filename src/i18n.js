// Languages. The interface is written in English; another language swaps its text as it reaches the page.
// Every text node, and the labels people read (aria-label, placeholder, title, alt), is looked up in that
// language's table (public/i18n/<code>.json: {strings: {English: translation}, patterns: [[regex, replacement]]}).
// Text with numbers or names in it ("Looking for an opponent at 10 min") matches a pattern, whose captured
// parts are translated too where the table has them. Text nobody translated stays English.
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "cs", name: "Čeština" },
  { code: "da", name: "Dansk" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "it", name: "Italiano" },
  { code: "hu", name: "Magyar" },
  { code: "nl", name: "Nederlands" },
  { code: "nb", name: "Norsk bokmål" },
  { code: "pl", name: "Polski" },
  { code: "pt", name: "Português" },
  { code: "ro", name: "Română" },
  { code: "fi", name: "Suomi" },
  { code: "sv", name: "Svenska" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "tr", name: "Türkçe" },
  { code: "el", name: "Ελληνικά" },
  { code: "ru", name: "Русский" },
  { code: "uk", name: "Українська" },
  { code: "he", name: "עברית" },
  { code: "ar", name: "العربية" },
  { code: "fa", name: "فارسی" },
  { code: "hi", name: "हिन्दी" },
  { code: "th", name: "ไทย" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh", name: "中文（简体）" },
  { code: "zh-TW", name: "中文（繁體）" },
];
// languages written right to left: the page mirrors, while boards and move notation stay left to right
const RTL = new Set(["ar", "he", "fa"]);
const KEY = "chess3d.lang";
const ATTRS = ["aria-label", "placeholder", "title", "alt"];

let lang = "en";
let strings = null;
let patterns = [];
const misses = new Set();      // text with no translation (dev builds list it for translators)

// the language picked in Settings, or the browser's if we have it
export function currentLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  // Taiwan, Hong Kong and Macau, or any "Hant" tag, read Traditional Chinese; any Norwegian reads Bokmål;
  // otherwise the first two letters decide
  const nav = (navigator.languages || [navigator.language || "en"]).map((x) => String(x).toLowerCase())
    .map((x) => (/^zh-(tw|hk|mo|hant)/.test(x) ? "zh-TW" : /^(no|nn)\b/.test(x) ? "nb" : x.slice(0, 2)));
  return nav.find((c) => LANGUAGES.some((l) => l.code === c)) || "en";
}
export function setLanguage(code) {
  try { localStorage.setItem(KEY, code); } catch { /* noop */ }
}

// translate one string (untouched if there's no translation). A pattern's captured parts are translated
// too, so "1 won. Last played 2 h ago" can use the pattern for "2 h ago"
export function t(text, depth = 0) {
  if (!strings || typeof text !== "string" || depth > 3) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const core = m[2];
  if (!core || !/[A-Za-z]/.test(core)) return text;
  let out = strings[core];
  if (out === undefined) {
    for (const [re, rep] of patterns) {
      const hit = re.exec(core);
      if (hit) { out = rep.replace(/\$(\d)/g, (_, n) => t(hit[Number(n)] ?? "", depth + 1)); break; }
    }
  }
  if (out === undefined) { if (depth === 0 && misses.size < 5000) misses.add(core); return text; }
  return m[1] + out + m[3];
}

const done = new WeakMap();    // node -> the text we put there (so our own change isn't translated again)
function translateText(node) {
  const before = node.data;
  if (done.get(node) === before) return;
  const after = t(before);
  done.set(node, after);
  if (after !== before) node.data = after;
}
function translateAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const key = "__i18n_" + a;
    if (el[key] === v) continue;
    const out = t(v);
    el[key] = out;
    if (out !== v) el.setAttribute(a, out);
  }
}
function walk(root) {
  if (root.nodeType === 3) { translateText(root); return; }
  if (root.nodeType !== 1 || root.tagName === "SCRIPT" || root.tagName === "STYLE") return;
  translateAttrs(root);
  // the user's own words (chat, posts, names in inputs) are left alone where the app marks them
  if (root.hasAttribute && root.hasAttribute("data-no-i18n")) return;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && (n.tagName === "SCRIPT" || n.tagName === "STYLE" || n.hasAttribute("data-no-i18n")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = tw.nextNode())) { if (n.nodeType === 3) translateText(n); else translateAttrs(n); }
}

// load the language's table and translate the page from now on
export async function startI18n() {
  lang = currentLanguage();
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? "rtl" : "ltr";
  if (lang === "en") return;
  try {
    const res = await fetch(`./i18n/${lang}.json`);
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    strings = d.strings || {};
    patterns = (d.patterns || []).map(([re, rep]) => [new RegExp(re), rep]);
  } catch {
    strings = null;            // offline without the table: stay in English
    return;
  }
  walk(document.body);
  document.title = t(document.title);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") translateText(m.target);
      else if (m.type === "attributes") translateAttrs(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // dev builds: what's still English on the screens visited
  if (new URLSearchParams(location.search).has("dev")) window.__i18nMisses = () => [...misses];
}
