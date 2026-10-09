// Builds each language's table for the app (dist/i18n/<code>.json) from its sources in i18n/<code>/:
//   NNN.json      translations of i18n/base-strings.json from index NNN on, in order (null keeps the English)
//   extra.json    {English: translation} for text added after the base was frozen
//   patterns.json [[regex, replacement], ...] for text with numbers or names in it ($1… are the captures)
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildI18n(root, outDir) {
  const base = JSON.parse(readFileSync(join(root, "i18n", "base-strings.json"), "utf8"));
  const langs = readdirSync(join(root, "i18n"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  mkdirSync(outDir, { recursive: true });
  const report = {};
  for (const lang of langs) {
    const dir = join(root, "i18n", lang);
    const strings = {};
    for (const f of readdirSync(dir).filter((f) => /^\d{3,4}\.json$/.test(f)).sort()) {
      const from = Number(f.slice(0, -5));
      const arr = JSON.parse(readFileSync(join(dir, f), "utf8"));
      arr.forEach((tr, i) => { const en = base[from + i]; if (en !== undefined && tr !== null && tr !== en) strings[en] = tr; });
    }
    if (existsSync(join(dir, "extra.json"))) Object.assign(strings, JSON.parse(readFileSync(join(dir, "extra.json"), "utf8")));
    const patterns = existsSync(join(dir, "patterns.json")) ? JSON.parse(readFileSync(join(dir, "patterns.json"), "utf8")) : [];
    for (const [re] of patterns) new RegExp(re);      // a bad pattern fails the build
    writeFileSync(join(outDir, `${lang}.json`), JSON.stringify({ strings, patterns }));
    report[lang] = { strings: Object.keys(strings).length, patterns: patterns.length };
  }
  return report;
}
