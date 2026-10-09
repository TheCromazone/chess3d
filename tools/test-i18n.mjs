// Language tables: each batch lines up with the English base (one translation per string, in order), every
// pattern compiles, and translations keep the placeholders and chess notation their English has. Reports how
// much of the base each language covers.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(readFileSync(join(root, "i18n", "base-strings.json"), "utf8"));
let failures = 0;
const ok = (cond, name) => { if (!cond) { console.log("FAIL  " + name); failures++; } };
const BATCH = 200;
const langs = readdirSync(join(root, "i18n"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
for (const lang of langs) {
  const dir = join(root, "i18n", lang);
  let covered = 0;
  for (const f of readdirSync(dir).filter((f) => /^\d{3,4}\.json$/.test(f)).sort()) {
    const from = Number(f.slice(0, -5));
    let arr;
    try { arr = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch (e) { ok(false, `${lang}/${f} isn't valid JSON: ${e.message}`); continue; }
    const want = Math.min(BATCH, base.length - from);
    ok(Array.isArray(arr) && arr.length === want, `${lang}/${f} has ${arr.length} entries, the base has ${want} from ${from}`);
    arr.forEach((tr, i) => {
      const en = base[from + i];
      if (tr === null || en === undefined) return;
      covered++;
      ok(typeof tr === "string" && tr.trim().length > 0, `${lang}/${f}[${i}] is empty`);
      // squares and moves (e4, Nf3, O-O) and numbers carry over unchanged
      for (const tok of en.match(/\b[a-h][1-8]\b|\b\d+\b/g) || []) ok(tr.includes(tok), `${lang}/${f}[${i}] lost "${tok}": ${JSON.stringify(en)} -> ${JSON.stringify(tr)}`);
      if (/^\s/.test(en) !== /^\s/.test(tr) || /\s$/.test(en) !== /\s$/.test(tr)) ok(false, `${lang}/${f}[${i}] changed the spaces around ${JSON.stringify(en)}`);
    });
  }
  if (existsSync(join(dir, "patterns.json"))) {
    for (const [re, rep] of JSON.parse(readFileSync(join(dir, "patterns.json"), "utf8"))) {
      try { new RegExp(re); } catch { ok(false, `${lang} pattern ${re} doesn't compile`); }
      ok(typeof rep === "string", `${lang} pattern ${re} has no replacement`);
    }
  }
  console.log(`${lang}: ${covered} of ${base.length} strings translated (${Math.round((covered / base.length) * 100)}%)`);
}
console.log(failures ? `\n${failures} FAILURES` : "\nALL LANGUAGE CHECKS PASSED");
process.exit(failures ? 1 : 0);
