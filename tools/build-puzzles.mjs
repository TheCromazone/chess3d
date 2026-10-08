// Builds public/data/puzzles.json from the lichess puzzle database (CC0).
//   https://database.lichess.org/#puzzles  (lichess_db_puzzle.csv.zst, ~300MB zstd)
//
// We don't need the whole file: the CSV is ordered by puzzle id (effectively random), so the
// first ~25MB of the compressed stream (~500k puzzles) is a fair sample. The truncated zstd
// stream is decompressed as far as it goes and the trailing partial line is dropped.
//
// Selection:
//   - filter: Popularity >= 85, NbPlays >= 300, RatingDeviation <= 90
//   - stratify by rating: 100-point buckets 400..2999, up to PER_BUCKET each
//   - inside a bucket, pick greedily for theme diversity (rare themes first), ties by quality
//   - every kept puzzle is replayed with chess.js (all UCI moves legal, mateInN ends in mate)
//
// Output (compact): {"v":1,"themes":[id...],"p":[[id, fen, "uci uci ...", rating, [themeIdx...]], ...]}
// sorted by rating.
//
// Usage:
//   node tools/build-puzzles.mjs                 # download 25MB range into the cache dir
//   node tools/build-puzzles.mjs --csv file.csv  # use an already-decompressed CSV (may be truncated)
//   env: PUZZLE_CACHE=<dir> (default: $TMPDIR/chess3d-puzzles), PUZZLE_BYTES=25000000
import { Chess } from "chess.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "public/data/puzzles.json");
const URL_ZST = "https://database.lichess.org/lichess_db_puzzle.csv.zst";
const BYTES = Number(process.env.PUZZLE_BYTES || 25000000);
const CACHE = process.env.PUZZLE_CACHE || join(tmpdir(), "chess3d-puzzles");

const MIN_POP = 85, MIN_PLAYS = 300, MAX_RD = 90;
const R_MIN = 400, R_MAX = 3000, BUCKET = 100, PER_BUCKET = 200;
const CANDIDATES_PER_BUCKET = 5000; // top-quality pool the greedy picker works from

// Near-universal tags: they still ship with each puzzle, but count little toward diversity.
const META = new Set(["short", "long", "veryLong", "oneMove", "crushing", "advantage", "mate",
  "middlegame", "endgame", "master", "masterVsMaster", "superGM"]);
// Themes the app's theme picker leans on: they get a floor weight so even scarce ones
// (e.g. equality, smotheredMate) are represented wherever the pool has them.
const CORE = new Set(["mateIn1", "mateIn2", "mateIn3", "fork", "pin", "skewer", "hangingPiece",
  "discoveredAttack", "doubleCheck", "sacrifice", "deflection", "attraction", "backRankMate",
  "smotheredMate", "endgame", "rookEndgame", "pawnEndgame", "promotion", "advancedPawn",
  "trappedPiece", "xRayAttack", "zugzwang", "quietMove", "defensiveMove", "crushing", "advantage",
  "equality", "short", "long", "opening", "middlegame"]);
// Named mate patterns (operaMate, hookMate, ...) are numerous; damp them so that mates as a
// whole don't swamp the set. backRankMate / smotheredMate are CORE and keep full weight.
const isMatePattern = (t) => (/Mate$/.test(t) && !CORE.has(t)) || t === "mateIn4" || t === "mateIn5";

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function findZstd() {
  for (const p of ["zstd", "/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd"]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

async function getCsvText() {
  const csvArg = argVal("--csv");
  if (csvArg) return readFileSync(csvArg, "utf8");

  mkdirSync(CACHE, { recursive: true });
  const zst = join(CACHE, `puzzle-head-${BYTES}.csv.zst`);
  if (!existsSync(zst)) {
    console.log(`downloading bytes 0-${BYTES} of ${URL_ZST} ...`);
    const res = await fetch(URL_ZST, { headers: { Range: `bytes=0-${BYTES}` } });
    if (!(res.status === 206 || res.status === 200)) throw new Error(`HTTP ${res.status}`);
    if (res.status === 200) console.warn("server ignored Range; this downloads the whole file");
    writeFileSync(zst, Buffer.from(await res.arrayBuffer()));
  }
  const zstd = findZstd();
  if (!zstd) throw new Error("zstd CLI not found (brew install zstd), or pass --csv <decompressed.csv>");
  // A truncated stream makes zstd exit non-zero at the cut; keep whatever it emitted.
  const r = spawnSync(zstd, ["-dc", zst], { maxBuffer: 1 << 30 });
  if (!r.stdout || r.stdout.length === 0) throw new Error("zstd produced no output: " + r.stderr);
  return r.stdout.toString("utf8");
}

function validate(fen, uciMoves, themes) {
  let chess;
  try { chess = new Chess(fen); } catch { return false; }
  for (const u of uciMoves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)) return false;
    try {
      chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch { return false; }
  }
  if (themes.some((t) => /^mateIn\d$/.test(t) || t === "mate") && !chess.isCheckmate()) return false;
  // the puzzle must have the setup move plus at least one player move, and end on a player move
  return uciMoves.length >= 2 && uciMoves.length % 2 === 0;
}

const text = await getCsvText();
const lines = text.split("\n");
const header = lines.shift().split(",");
if (!text.endsWith("\n")) lines.pop(); // drop trailing partial line
const col = (n) => {
  const i = header.indexOf(n);
  if (i < 0) throw new Error("missing CSV column " + n);
  return i;
};
const C = {
  id: col("PuzzleId"), fen: col("FEN"), moves: col("Moves"), rating: col("Rating"),
  rd: col("RatingDeviation"), pop: col("Popularity"), plays: col("NbPlays"), themes: col("Themes"),
};

const nBuckets = (R_MAX - R_MIN) / BUCKET;
const buckets = Array.from({ length: nBuckets }, () => []);
let rows = 0;
for (const line of lines) {
  if (!line) continue;
  const c = line.split(",");
  if (c.length < header.length - 1) continue;
  rows++;
  const rating = +c[C.rating], rd = +c[C.rd], pop = +c[C.pop], plays = +c[C.plays];
  if (!(pop >= MIN_POP && plays >= MIN_PLAYS && rd <= MAX_RD)) continue;
  if (!(rating >= R_MIN && rating < R_MAX)) continue;
  const themes = c[C.themes].split(" ").filter(Boolean);
  buckets[Math.floor((rating - R_MIN) / BUCKET)].push({
    id: c[C.id], fen: c[C.fen], moves: c[C.moves].trim(), rating, themes,
    quality: pop + 5 * Math.log10(plays), // popularity first, then how battle-tested it is
  });
}
console.log(`read ${rows} puzzles; ${buckets.reduce((s, b) => s + b.length, 0)} pass the filter`);

// Theme weights: sqrt of each theme's share of the filtered pool. Greedy picking with
// score ~ weight / (1 + picked) makes picked counts roughly proportional to the weights, i.e. a
// flattened version of the natural mix: forks/pins stay common, rare motifs still show up.
const natural = new Map();
let poolSize = 0;
for (const pool of buckets) for (const p of pool) {
  poolSize++;
  for (const t of p.themes) natural.set(t, (natural.get(t) || 0) + 1);
}
const weight = new Map();
for (const [t, n] of natural) {
  let w = Math.sqrt(n / poolSize);
  if (isMatePattern(t)) w *= 0.5;
  if (CORE.has(t)) w = Math.max(w, 0.08);
  if (META.has(t)) w *= 0.1;
  weight.set(t, w);
}

const kept = [];
let invalid = 0;
for (const pool of buckets) {
  pool.sort((a, b) => b.quality - a.quality || (a.id < b.id ? -1 : 1));
  const cands = pool.slice(0, CANDIDATES_PER_BUCKET);
  const used = new Uint8Array(cands.length);
  const count = new Map(); // theme -> picked in this bucket
  let picked = 0;
  while (picked < PER_BUCKET) {
    let bestI = -1, bestS = -1;
    for (let i = 0; i < cands.length; i++) {
      if (used[i]) continue;
      // The most under-represented theme dominates the score, so tag-heavy puzzles (mates
      // carry mateInN + pattern + kingsideAttack...) don't crowd out single-motif tactics.
      let s = 0, mx = 0;
      for (const t of cands[i].themes) {
        const w = weight.get(t) / (1 + (count.get(t) || 0));
        s += w;
        if (w > mx) mx = w;
      }
      s = mx + 0.25 * s;
      s *= 1 + 0.02 * (cands.length - i) / cands.length; // quality tie-break
      if (s > bestS) { bestS = s; bestI = i; }
    }
    if (bestI < 0) break;
    used[bestI] = 1;
    const p = cands[bestI];
    if (!validate(p.fen, p.moves.split(" "), p.themes)) { invalid++; continue; }
    for (const t of p.themes) count.set(t, (count.get(t) || 0) + 1);
    kept.push(p);
    picked++;
  }
}

kept.sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : 1));
const themeCount = new Map();
for (const p of kept) for (const t of p.themes) themeCount.set(t, (themeCount.get(t) || 0) + 1);
const themes = [...themeCount.keys()].sort((a, b) => themeCount.get(b) - themeCount.get(a) || (a < b ? -1 : 1));
const tIndex = new Map(themes.map((t, i) => [t, i]));

const out = {
  v: 1,
  themes,
  p: kept.map((p) => [p.id, p.fen, p.moves, p.rating, p.themes.map((t) => tIndex.get(t))]),
};
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json);

console.log(`kept ${kept.length} puzzles (${invalid} dropped by chess.js validation) -> ${OUT} (${(json.length / 1024).toFixed(1)} KB)`);
const per = buckets.map((_, i) => `${R_MIN + i * BUCKET}:${kept.filter((p) => Math.floor((p.rating - R_MIN) / BUCKET) === i).length}`);
console.log("per bucket: " + per.join(" "));
console.log("themes: " + themes.map((t) => `${t}:${themeCount.get(t)}`).join(" "));
