// Solo Chess puzzles (src/modes/trainers.js): every generated puzzle can be solved.
// The module imports the UI, so only its pure helpers are loaded, through esbuild with stubs.
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stub = { name: "stub", setup(b) { b.onResolve({ filter: /\/(ui|store|audio)/ }, (a) => ({ path: a.path, namespace: "stub" })); b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const h = () => null, icon = () => null, segmented = () => null, getProfile = () => ({}), updateProfile = () => {}, unlock = () => {}, SFX = {};", loader: "js" })); } };
const out = await build({ entryPoints: [new URL("../src/modes/trainers.js", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", write: false, plugins: [stub] });
const dir = mkdtempSync(join(tmpdir(), "trainers-"));
writeFileSync(join(dir, "t.mjs"), out.outputFiles[0].text);
const { _soloForTest, _soloSolvable } = await import(join(dir, "t.mjs"));

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };
for (const n of [5, 7, 9]) {
  let made = 0, solvable = 0, kings = 0;
  for (let i = 0; i < 40; i++) {
    const p = _soloForTest(n);
    if (!p) continue;
    made++;
    if (p.some((x) => x.t === "k")) kings++;
    if (_soloSolvable(p)) solvable++;
    if (p.some((x) => x.t === "p" && /[18]$/.test(x.sq))) { ok(false, "a pawn on the back rank"); break; }
  }
  ok(made === 40 && solvable === 40, `Solo Chess, ${n} pieces: 40 puzzles made, all solvable (${kings} with a king)`);
}
console.log(failures === 0 ? "\nALL TRAINER TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
