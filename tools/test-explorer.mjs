// Validates the opening-explorer data (public/data/explorer/) and src/explorer.js.
//   node tools/test-explorer.mjs
// Reads the JSON from disk (a fetch shim serves ./data/... from public/), so no server is needed.
import { Chess } from "chess.js";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(root, "public/data/explorer");

let failures = 0;
const ok = (cond, name) => {
  if (!cond) { failures++; console.log("FAIL  " + name); }
  return !!cond;
};
const check = (cond, name) => { if (ok(cond, name)) console.log("PASS  " + name); };
const info = (msg) => console.log("      " + msg);
const section = (t) => console.log("\n== " + t + " ==");
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + "%" : "-");

// ---- fetch shim: "./data/x" -> public/data/x, with a log of what was requested ----
let fetchFails = false;
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  if (fetchFails) throw new Error("network down (test)");
  const p = join(root, "public", String(url).replace(/^\.\//, ""));
  let text;
  try { text = readFileSync(p, "utf8"); } catch { return { ok: false, status: 404, json: async () => { throw new Error("404"); } }; }
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

const keyOf = (fen) => fen.split(" ").slice(0, 4).join(" ");
const play = (sans) => { const c = new Chess(); for (const s of sans.split(" ")) c.move(s); return c.fen(); };

// ---------------------------------------------------------------------------------------
section("files");
if (!existsSync(join(DIR, "index.json"))) {
  console.log("FAIL  public/data/explorer/index.json missing (run node tools/build-explorer.mjs)");
  process.exit(1);
}
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const { p: coreP, ...meta } = index;
check(meta.v === 1 && coreP && typeof coreP === "object", "index.json has v=1 and a position table");
check(meta.minRating === 1800 && meta.plies === 24, "meta: minRating 1800, 24 plies");
check(/^lichess\.org rated games, \d{4}-\d{2}$/.test(meta.source), `meta.source = "${meta.source}"`);
check(Number.isInteger(meta.games) && meta.games >= 100000, `meta.games = ${meta.games} (>= 100k)`);
check(Number.isInteger(meta.shards) && meta.shards >= 1, `meta.shards = ${meta.shards}`);

const files = [["index.json", coreP, -1]];
for (let s = 0; s < meta.shards; s++) {
  const name = String(s).padStart(2, "0") + ".json";
  const path = join(DIR, name);
  if (!ok(existsSync(path), `shard ${name} exists`)) continue;
  const d = JSON.parse(readFileSync(path, "utf8"));
  ok(d.v === 1 && d.shard === s && d.p && typeof d.p === "object", `shard ${name} header`);
  files.push([name, d.p, s]);
}
const extra = readdirSync(DIR).filter((f) => !files.some(([n]) => n === f));
check(extra.length === 0, "no stray files in public/data/explorer" + (extra.length ? ": " + extra.join(", ") : ""));

const sizes = files.map(([n]) => [n, statSync(join(DIR, n)).size]);
const totalBytes = sizes.reduce((s, x) => s + x[1], 0);
check(totalBytes < 6 * 1024 * 1024, `total size ${(totalBytes / 1024 / 1024).toFixed(2)} MB < 6 MB`);
check(sizes.every(([, sz]) => sz < 900 * 1024), "every file < 900 KB (lazy loads stay small)");

// all positions, with where they live
const all = new Map(); // key -> { entry, file, shard }
let dup = 0;
for (const [name, table, shard] of files) {
  for (const [key, entry] of Object.entries(table)) {
    if (all.has(key)) dup++;
    all.set(key, { entry, file: name, shard });
  }
}
check(dup === 0, "no position stored twice");
check(all.size === meta.positions, `position count matches meta (${all.size})`);

// ---------------------------------------------------------------------------------------
section("entries are sane");
const parse = (entry) => ({
  w: entry[0], d: entry[1], b: entry[2],
  moves: entry.slice(3).map((s) => {
    const f = s.split(" ");
    return { uci: f[0], san: f[1], w: +f[2], d: +f[3], b: +f[4], r: +f[5], n: +f[2] + +f[3] + +f[4], fields: f.length };
  }),
});
let badShape = 0, smallPos = 0, smallMove = 0, overSum = 0, badRating = 0, unsorted = 0, noMoves = 0;
let sumW = 0, sumD = 0, sumB = 0;
for (const [key, { entry }] of all) {
  if (!Array.isArray(entry) || entry.length < 3 || !entry.slice(0, 3).every((x) => Number.isInteger(x) && x >= 0) ||
      !entry.slice(3).every((s) => typeof s === "string")) { badShape++; continue; }
  const e = parse(entry);
  const total = e.w + e.d + e.b;
  if (total < meta.minGames) smallPos++;
  if (!e.moves.length) noMoves++;
  let s = 0, prev = Infinity;
  for (const m of e.moves) {
    if (m.fields !== 6 || ![m.w, m.d, m.b, m.r].every(Number.isInteger)) badShape++;
    if (m.n < meta.minMoveGames) smallMove++;
    if (!(m.r >= meta.minRating && m.r <= 3500)) badRating++;
    if (m.n > prev) unsorted++;
    prev = m.n;
    s += m.n;
  }
  if (s > total) overSum++;
  if (key === keyOf(new Chess().fen())) { sumW = e.w; sumD = e.d; sumB = e.b; }
}
check(badShape === 0, "every entry is [w, d, b, 'uci san w d b rating', ...]");
check(smallPos === 0, `every position has >= ${meta.minGames} games`);
check(smallMove === 0, `every move has >= ${meta.minMoveGames} games`);
check(overSum === 0, "moves never sum to more than their position's total");
check(badRating === 0, `average ratings within [${meta.minRating}, 3500]`);
check(unsorted === 0, "moves sorted by games played (desc)");
info(`${noMoves} positions have no move above the per-move threshold (totals only)`);

// ---------------------------------------------------------------------------------------
section("every stored move is legal in its position");
let illegal = 0, sanMismatch = 0, badKey = 0, checked = 0;
for (const [key, { entry }] of all) {
  let c;
  try { c = new Chess(key + " 0 1"); } catch { badKey++; continue; }
  if (keyOf(c.fen()) !== key) badKey++; // keys are exactly what chess.js prints
  for (const m of parse(entry).moves) {
    checked++;
    let r;
    try { r = c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); } catch { r = null; }
    if (!r) { illegal++; continue; }
    if (r.san !== m.san || r.from + r.to + (r.promotion || "") !== m.uci) sanMismatch++;
    c.undo();
  }
}
check(badKey === 0, "every key is a valid chess.js position key");
check(illegal === 0, `all ${checked} moves are legal`);
check(sanMismatch === 0, "stored SAN/UCI match chess.js");

// ---------------------------------------------------------------------------------------
section("start position");
const startKey = keyOf(new Chess().fen());
const start = all.get(startKey);
if (ok(start, "start position present")) {
  const e = parse(start.entry);
  const total = e.w + e.d + e.b;
  info(`start: ${total} games, White ${pct(e.w, total)} / draw ${pct(e.d, total)} / Black ${pct(e.b, total)}`);
  info("top moves: " + e.moves.slice(0, 8).map((m) => `${m.san} ${pct(m.n, total)}`).join(", "));
  check(start.file === "index.json", "start position is in the core (no shard fetch needed)");
  check(total === meta.games, "start total = games used (every game starts there)");
  const top4 = e.moves.slice(0, 4).map((m) => m.san);
  check(["e4", "d4"].every((s) => top4.slice(0, 2).includes(s)), "e4 and d4 are the two most played first moves");
  check(["e4", "d4", "Nf3", "c4"].every((s) => e.moves.slice(0, 6).some((m) => m.san === s)), "Nf3 and c4 are in the top 6");
  const big4 = e.moves.filter((m) => ["e4", "d4", "Nf3", "c4"].includes(m.san)).reduce((s, m) => s + m.n, 0);
  check(big4 / total > 0.75, `e4/d4/Nf3/c4 dominate (${pct(big4, total)} of games)`);
  check(e.moves.length >= 15 && e.moves.length <= 20, `${e.moves.length} first moves listed (of 20 legal)`);
  const score = (e.w + e.d / 2) / total;
  check(score > 0.5 && score < 0.56, `White scores ${(100 * score).toFixed(1)}% from the start (50-56%)`);
  check(e.d / total > 0.02 && e.d / total < 0.15, `draw rate ${pct(e.d, total)} (2-15%)`);
  check(e.w > e.b, "White wins more often than Black");
  const e4 = e.moves.find((m) => m.san === "e4");
  const e4pos = all.get(keyOf(play("e4")));
  if (ok(e4 && e4pos, "1.e4 and its position are present")) {
    const r = parse(e4pos.entry).moves.slice(0, 3).map((m) => m.san);
    info("after 1.e4: " + r.join(", "));
    check(r.includes("c5") && r.includes("e5"), "1...c5 and 1...e5 are top replies to 1.e4");
  }
}
// overall sanity across all positions
{
  let w = 0, d = 0, b = 0, extreme = 0;
  for (const { entry } of all.values()) {
    w += entry[0]; d += entry[1]; b += entry[2];
    const t = entry[0] + entry[1] + entry[2];
    if (t >= 1000 && (entry[0] / t > 0.9 || entry[2] / t > 0.9)) extreme++;
  }
  const t = w + d + b;
  info(`all positions: White ${pct(w, t)} / draw ${pct(d, t)} / Black ${pct(b, t)}`);
  check(w / t > 0.4 && w / t < 0.6 && b / t > 0.35 && b / t < 0.55, "aggregate White/Black win shares are plausible");
  check(extreme === 0, "no position with >= 1000 games has a >90% one-sided result");
}

// ---------------------------------------------------------------------------------------
section("module: src/explorer.js");
const mod = await import("../src/explorer.js");
const { loadExplorer, explorerLoaded, explorerMoves, EXPLORER_INFO, explorerShardOf } = mod;
check(typeof loadExplorer === "function" && typeof explorerLoaded === "function" && typeof explorerMoves === "function",
  "exports loadExplorer / explorerLoaded / explorerMoves");
check(EXPLORER_INFO.source === meta.source && EXPLORER_INFO.minRating === meta.minRating &&
  EXPLORER_INFO.games === meta.games && EXPLORER_INFO.plies === meta.plies,
  "EXPLORER_INFO defaults match the shipped data (update src/explorer.js after a rebuild)");

// failure first (module state is fresh): resolves false, never throws, retries later
fetchFails = true;
const warn = console.warn;
let warned = 0;
console.warn = () => { warned++; }; // the module logs failed loads; keep the test output clean
check(await loadExplorer() === false, "loadExplorer() resolves false when the fetch fails");
check(await explorerMoves(new Chess().fen()) === null, "explorerMoves() -> null when data is unavailable");
check(!explorerLoaded(), "explorerLoaded() false after a failed load");
check(warned > 0, "a failed load is logged with console.warn");
console.warn = warn;
fetchFails = false;
fetched.length = 0;
const [l1, l2] = await Promise.all([loadExplorer(), loadExplorer()]);
check(l1 === true && l2 === true && explorerLoaded(), "loadExplorer() retries and succeeds");
check(fetched.length === 1 && fetched[0] === "./data/explorer/index.json", "concurrent loads share one request (index only)");
check(EXPLORER_INFO.games === meta.games, "EXPLORER_INFO refreshed from index.json");

fetched.length = 0;
const s0 = await explorerMoves(new Chess().fen());
check(s0 && fetched.length === 0, "start position answered from the core without fetching");
if (s0) {
  const fields = ["san", "uci", "from", "to", "promotion", "total", "white", "draws", "black", "avgRating"];
  check(fields.every((f) => f in s0.moves[0]) && ["total", "white", "draws", "black", "moves"].every((f) => f in s0),
    "result shape { total, white, draws, black, moves: [{ " + fields.join(", ") + " }] }");
  check(s0.total === s0.white + s0.draws + s0.black, "total = white + draws + black");
  check(s0.moves.every((m, i) => i === 0 || s0.moves[i - 1].total >= m.total), "moves sorted by total desc");
  const e4 = s0.moves.find((m) => m.san === "e4");
  check(e4 && e4.from === "e2" && e4.to === "e4" && e4.uci === "e2e4" && e4.promotion === undefined, "e4 -> from e2, to e4");
}

// transposition: 1.Nf3 d5 2.d4 and 1.d4 d5 2.Nf3
{
  const fa = play("Nf3 d5 d4"), fb = play("d4 d5 Nf3");
  check(keyOf(fa) === keyOf(fb), "1.Nf3 d5 2.d4 and 1.d4 d5 2.Nf3 give the same key");
  const [ra, rb] = [await explorerMoves(fa), await explorerMoves(fb)];
  check(ra && rb && JSON.stringify(ra) === JSON.stringify(rb), "...and the same explorer entry");
  if (ra) {
    info(`after 1.d4 d5 2.Nf3: ${ra.total} games; ` + ra.moves.slice(0, 4).map((m) => `${m.san} ${m.total}`).join(", "));
    check(ra.moves.some((m) => m.san === "Nf6") && ra.moves.some((m) => m.san === "c6" || m.san === "e6"),
      "plausible replies (Nf6, c6/e6)");
  }
  // more transpositions: the QGD reached via 1.d4 Nf6 2.c4 e6 3.Nc3 d5 and 1.c4 e6 2.Nc3 d5 3.d4 Nf6
  const qa = await explorerMoves(play("d4 Nf6 c4 e6 Nc3 d5")), qb = await explorerMoves(play("c4 e6 Nc3 d5 d4 Nf6"));
  check(qa && qb && qa.total === qb.total, "QGD via 1.d4 and via 1.c4 merge");
}

// sharding: every stored key sits in the file explorerShardOf() names; lookups fetch only that file
{
  let wrongShard = 0, coreBelow = 0, shardAbove = 0;
  for (const [key, { shard, entry }] of all) {
    const t = entry[0] + entry[1] + entry[2];
    if (shard >= 0 && explorerShardOf(key, meta.shards) !== shard) wrongShard++;
    if (shard < 0 && t < meta.coreMinGames) coreBelow++;
    if (shard >= 0 && t >= meta.coreMinGames) shardAbove++;
  }
  check(wrongShard === 0, `every sharded position is in shard explorerShardOf(key, ${meta.shards})`);
  check(coreBelow === 0 && shardAbove === 0, `core = positions with >= ${meta.coreMinGames} games, shards = the rest`);
  // a failed shard fetch answers null without throwing; the loop below then retries it
  {
    const [key] = [...all].find(([, v]) => v.shard === 3);
    fetchFails = true;
    console.warn = () => {};
    check(await explorerMoves(key) === null, "a failed shard fetch -> null (retried on the next lookup)");
    console.warn = warn;
    fetchFails = false;
  }
  // one position from every shard: same numbers via the module, and exactly one file fetched
  let mismatch = 0, extraFetch = 0, tested = 0;
  for (let s = 0; s < meta.shards; s++) {
    const pick = [...all].find(([, v]) => v.shard === s);
    if (!pick) continue;
    const [key, { entry }] = pick;
    fetched.length = 0;
    const r = await explorerMoves(key + " 0 5");
    tested++;
    if (fetched.length !== 1 || fetched[0] !== `./data/explorer/${String(s).padStart(2, "0")}.json`) extraFetch++;
    const e = parse(entry);
    if (!r || r.white !== e.w || r.draws !== e.d || r.black !== e.b || r.moves.length !== e.moves.length ||
        r.moves.some((m, i) => m.uci !== e.moves[i].uci || m.san !== e.moves[i].san || m.total !== e.moves[i].n)) mismatch++;
  }
  check(tested === meta.shards && extraFetch === 0, `a lookup in each of the ${tested} shards fetched exactly that shard`);
  check(mismatch === 0, "module results equal the on-disk entries");
  fetched.length = 0;
  const again = await explorerMoves([...all].find(([, v]) => v.shard === 0)[0]);
  check(again && fetched.length === 0, "a loaded shard is cached");
}

// misses
{
  fetched.length = 0;
  check(await explorerMoves("not a fen") === null, "garbage FEN -> null");
  check(await explorerMoves(null) === null, "non-string -> null");
  check(fetched.length === 0, "...without fetching");
  const deep = new Chess();
  for (const s of "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 cxd4 cxd4 Nc6".split(" ")) deep.move(s);
  fetched.length = 0;
  check(await explorerMoves(deep.fen()) === null && fetched.length === 0, "position past move 12 -> null without fetching");
  const odd = await explorerMoves("8/8/8/4k3/8/8/4K3/8 w - - 0 1");
  check(odd === null, "a position that isn't in the data -> null");
  const keyOnly = await explorerMoves(startKey);
  check(keyOnly && keyOnly.total === meta.games, "a 4-field key (no move counters) works too");
  // FEN with a non-capturable en-passant square (other tools print it after every double push)
  const epFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
  const ep = await explorerMoves(epFen), e4 = await explorerMoves(play("e4"));
  check(ep && e4 && JSON.stringify(ep) === JSON.stringify(e4), "FEN with a redundant ep square is normalized (1.e4 ... e3)");
}

// ---------------------------------------------------------------------------------------
section("coverage");
{
  // how much of the data hangs together as a tree from the start position
  const seen = new Set([startKey]);
  const queue = [startKey];
  while (queue.length) {
    const k = queue.shift();
    const v = all.get(k);
    if (!v) continue;
    const c = new Chess(k + " 0 1");
    for (const m of parse(v.entry).moves) {
      c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
      const ck = keyOf(c.fen());
      c.undo();
      if (all.has(ck) && !seen.has(ck)) { seen.add(ck); queue.push(ck); }
    }
  }
  info(`${seen.size} of ${all.size} positions (${pct(seen.size, all.size)}) are reachable from the start through stored moves`);
  check(seen.size / all.size > 0.95, "data is a connected opening tree (> 95% reachable)");
  // deepest main line: follow the most played move while the position is in the data
  const c = new Chess();
  const line = [];
  while (all.has(keyOf(c.fen())) && line.length < 40) {
    const mv = parse(all.get(keyOf(c.fen())).entry).moves[0];
    if (!mv) break;
    line.push(c.move({ from: mv.uci.slice(0, 2), to: mv.uci.slice(2, 4), promotion: mv.uci[4] }).san);
  }
  info(`most-played line (${line.length} plies): ${line.join(" ")}`);
}

// ---------------------------------------------------------------------------------------
section("totals");
info(`source:     ${meta.source} (${meta.url || "local PGN"}, ${meta.range || ""})`);
info(`games used: ${meta.games}`);
info(`positions:  ${meta.positions} (core ${Object.keys(coreP).length} with >= ${meta.coreMinGames} games, ${meta.shards} shards)`);
info(`moves:      ${[...all.values()].reduce((s, v) => s + v.entry.length - 3, 0)}`);
for (const [n, sz] of sizes) info(`  ${n.padEnd(11)} ${(sz / 1024).toFixed(1).padStart(7)} KB`);
info(`total size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB on disk`);
const lastBuild = join(process.env.EXPLORER_CACHE || join(tmpdir(), "chess3d-explorer"), "last-build.json");
if (existsSync(lastBuild)) {
  const lb = JSON.parse(readFileSync(lastBuild, "utf8"));
  info(`build time: ${lb.seconds}s with ${lb.workers} workers (${lb.finished}; ${lb.gamesSeen} games scanned)`);
} else info("build time: n/a (no last-build.json in the cache dir; set EXPLORER_CACHE)");

console.log(failures ? `\n${failures} FAILED` : "\nall explorer checks passed");
process.exit(failures ? 1 : 0);
