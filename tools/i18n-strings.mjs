// Lists the English text in the app that a translation needs: string literals that read as interface text
// (they start with a capital or are a known lowercase word, and aren't code: no selectors, paths, keys or
// identifiers). Writes i18n/en-strings.json, the list each language's table is checked against
// (tools/test-i18n.mjs reports what a language still lacks).
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk(join(root, "src"));
// code that never shows text, and data the app shows as-is (piece names in notation, licenses)
const SKIP = /src\/(core\/(?!tree)|logic-src|engine|pieces|board3d|i18n)/;
// interface text starts like a sentence or a label (fragments that code joins into a sentence don't: the
// sentence they make is matched by a pattern instead)
const keep = (t) => /^[A-Z¡¿*"(…]/.test(t) && /[a-z]{2,}/.test(t)
  && !/[#{}<>=\\&]|https?:|^\(.*:|^--|^[A-Z][a-z]+[A-Z]\w*$|\.(js|json|png|svg|css|mp3)$/.test(t);
const out = new Set();
for (const f of files) {
  if (SKIP.test(f)) continue;
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const t = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
    if (t.length >= 2 && t.length <= 1500 && keep(t)) out.add(t);
  }
}
mkdirSync(join(root, "i18n"), { recursive: true });
const list = [...out].sort();
writeFileSync(join(root, "i18n", "en-strings.json"), JSON.stringify(list, null, 1) + "\n");
console.log(`${list.length} strings, ${list.reduce((t, s) => t + s.length, 0)} characters`);
