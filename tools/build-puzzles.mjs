// Builds the sharded puzzle set in public/data/puzzles/ from the lichess puzzle database (CC0).
//   https://database.lichess.org/#puzzles  (lichess_db_puzzle.csv.zst, ~307MB zstd)
//
// We don't need the whole file: the CSV is ordered by puzzle id (effectively random), so the
// first ~100MB of the compressed stream (~2M puzzles) is a fair sample. The truncated zstd
// stream is decompressed as far as it goes (streamed, never held in memory as one string) and
// the trailing partial line is dropped.
//
// Selection:
//   - filter: Popularity >= 85, NbPlays >= 300, RatingDeviation <= 90
//   - stratify by rating: 100-point buckets 400..2999, up to PER_BUCKET each (the 2800s and
//     2900s are naturally sparse, so they keep whatever passes the filter)
//   - inside a bucket, pick greedily for theme diversity (rare themes first), ties by quality;
//     the candidate pool is the best CANDIDATES_PER_BUCKET puzzles by quality plus the best few
//     of every theme, so scarce motifs (underPromotion, castling, bodenMate...) are reachable
//   - every kept puzzle is replayed with chess.js (all UCI moves legal, mate themes end in mate)
//
// Output: public/data/puzzles/
//   index.json   {"v":2,"count":N,"themes":[id...],"themeCounts":[n...],
//                 "shards":[{"file":"r0400-0799.<hash>.json","from":400,"to":799,"count":n,"lo":r,"hi":r}, ...]}
//   r<from>-<to>.<hash>.json   {"v":2,"from":400,"to":799,"p":[[id, fen, "uci uci ...", rating, [themeIdx...]], ...]}
// Shards cover the rating BANDS below (~3k puzzles each), sorted by rating; theme indices refer
// to index.json's `themes`. File names carry a content hash, so an index can never be paired
// with a shard from another build. Old shard files in the folder are removed.
//
// Usage:
//   node tools/build-puzzles.mjs                 # download a 100MB range into the cache dir
//   node tools/build-puzzles.mjs --csv file.csv  # use an already-decompressed CSV (may be truncated)
//   env: PUZZLE_CACHE=<dir> (default: $TMPDIR/chess3d-puzzles), PUZZLE_BYTES=100000000,
//        PUZZLE_OUT=<dir> (default: public/data/puzzles)
import { Chess } from "chess.js";
import { createReadStream, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.PUZZLE_OUT || join(root, "public/data/puzzles");
const URL_ZST = "https://database.lichess.org/lichess_db_puzzle.csv.zst";
const BYTES = Number(process.env.PUZZLE_BYTES || 100000000);
const CACHE = process.env.PUZZLE_CACHE || join(tmpdir(), "chess3d-puzzles");

const MIN_POP = 85, MIN_PLAYS = 300, MAX_RD = 90;
const R_MIN = 400, R_MAX = 3000, BUCKET = 100, PER_BUCKET = 720;
// Shard bands [from, to] (inclusive): 400 points wide, ~3k puzzles each. The top band is wider
// because puzzles above 2800 are scarce.
const BANDS = [[400, 799], [800, 1199], [1200, 1599], [1600, 1999], [2000, 2399], [2400, 2999]];
const CANDIDATES_PER_BUCKET = 6000;  // top-quality pool the greedy picker works from...
const PER_THEME_CANDIDATES = 120;    // ...plus the best of every theme in the bucket

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
// Rarer motifs and named mates we want well covered: a slightly lower floor than CORE.
const FEATURED = new Set(["zugzwang", "underPromotion", "castling", "enPassant", "interference",
  "intermezzo", "clearance", "capturingDefender", "attackingF2F7", "exposedKing", "kingsideAttack",
  "queensideAttack", "hookMate", "arabianMate", "anastasiaMate", "bodenMate", "doubleBishopMate",
  "dovetailMate", "discoveredCheck", "collinearMove", "bishopEndgame", "knightEndgame",
  "queenEndgame", "queenRookEndgame"]);
// Other named mate patterns (operaMate, pillsburysMate, ...) are numerous; damp them so that
// mates as a whole don't swamp the set.
const isMatePattern = (t) => (/Mate$/.test(t) && !CORE.has(t) && !FEATURED.has(t)) || t === "mateIn4" || t === "mateIn5";

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

// Calls onLine(line) for every complete CSV line. A truncated input (zstd stops with an error at
// the cut, or a --csv file that ends mid-line) loses only its trailing partial line.
async function forEachCsvLine(onLine) {
  const csvArg = argVal("--csv");
  let stream, done;
  if (csvArg) {
    stream = createReadStream(csvArg);
    done = Promise.resolve();
  } else {
    mkdirSync(CACHE, { recursive: true });
    const zst = join(CACHE, `puzzle-head-${BYTES}.csv.zst`);
    if (!existsSync(zst)) {
      console.log(`downloading bytes 0-${BYTES} of ${URL_ZST} ...`);
      const res = await fetch(URL_ZST, { headers: { Range: `bytes=0-${BYTES}` } });
      if (!(res.status === 206 || res.status === 200)) throw new Error(`HTTP ${res.status}`);
      if (res.status === 200) console.warn("server ignored Range; this downloads the whole file");
      console.log(`  ${res.headers.get("content-range") || ""} etag ${res.headers.get("etag") || "?"} last-modified ${res.headers.get("last-modified") || "?"}`);
      writeFileSync(zst, Buffer.from(await res.arrayBuffer()));
    }
    const zstd = findZstd();
    if (!zstd) throw new Error("zstd CLI not found (brew install zstd), or pass --csv <decompressed.csv>");
    const sha = createHash("sha256");
    await new Promise((res, rej) => createReadStream(zst).on("data", (d) => sha.update(d)).on("end", res).on("error", rej));
    console.log(`input ${zst} sha256 ${sha.digest("hex")}`);
    const child = spawn(zstd, ["-dc", zst], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.resume(); // "premature end" at the cut is expected
    stream = child.stdout;
    done = new Promise((res) => child.on("close", res));
  }
  let rest = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop();
    for (const line of parts) onLine(line);
  }
  await done;
  // `rest` is a partial line (or empty): drop it.
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

// --- read + filter -----------------------------------------------------------------------------
const nBuckets = (R_MAX - R_MIN) / BUCKET;
const buckets = Array.from({ length: nBuckets }, () => []);
let header = null, C = null, rows = 0;
await forEachCsvLine((line) => {
  if (!line) return;
  if (!header) {
    header = line.split(",");
    const col = (n) => {
      const i = header.indexOf(n);
      if (i < 0) throw new Error("missing CSV column " + n);
      return i;
    };
    C = {
      id: col("PuzzleId"), fen: col("FEN"), moves: col("Moves"), rating: col("Rating"),
      rd: col("RatingDeviation"), pop: col("Popularity"), plays: col("NbPlays"), themes: col("Themes"),
    };
    return;
  }
  const c = line.split(",");
  if (c.length < header.length - 1) return;
  rows++;
  const rating = +c[C.rating], rd = +c[C.rd], pop = +c[C.pop], plays = +c[C.plays];
  if (!(pop >= MIN_POP && plays >= MIN_PLAYS && rd <= MAX_RD)) return;
  if (!(rating >= R_MIN && rating < R_MAX)) return;
  buckets[Math.floor((rating - R_MIN) / BUCKET)].push({
    id: c[C.id], fen: c[C.fen], moves: c[C.moves].trim(), rating,
    themes: c[C.themes].split(" ").filter(Boolean),
    quality: pop + 5 * Math.log10(plays), // popularity first, then how battle-tested it is
  });
});
console.log(`read ${rows} puzzles; ${buckets.reduce((s, b) => s + b.length, 0)} pass the filter`);
console.log("filtered per bucket: " + buckets.map((b, i) => `${R_MIN + i * BUCKET}:${b.length}`).join(" "));

// --- theme weights -----------------------------------------------------------------------------
// sqrt of each theme's share of the filtered pool. Greedy picking with score ~ weight / (1 + picked)
// makes picked counts roughly proportional to the weights, i.e. a flattened version of the
// natural mix: forks/pins stay common, rare motifs still show up.
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
  if (FEATURED.has(t)) w = Math.max(w, 0.07);
  if (META.has(t)) w *= 0.1;
  weight.set(t, w);
}

// --- greedy pick per bucket ----------------------------------------------------------------------
const byQuality = (a, b) => b.quality - a.quality || (a.id < b.id ? -1 : 1);
const kept = [];
let invalid = 0;
for (const pool of buckets) {
  pool.sort(byQuality);
  const inPool = new Set();
  const cands = [];
  const add = (p) => { if (!inPool.has(p.id)) { inPool.add(p.id); cands.push(p); } };
  pool.slice(0, CANDIDATES_PER_BUCKET).forEach(add);
  const perTheme = new Map();
  for (const p of pool) for (const t of p.themes) {
    const n = perTheme.get(t) || 0;
    if (n < PER_THEME_CANDIDATES) { perTheme.set(t, n + 1); add(p); }
  }
  cands.sort(byQuality);
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

// --- write shards + index ------------------------------------------------------------------------
kept.sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : 1));
const themeCount = new Map();
for (const p of kept) for (const t of p.themes) themeCount.set(t, (themeCount.get(t) || 0) + 1);
const themes = [...themeCount.keys()].sort((a, b) => themeCount.get(b) - themeCount.get(a) || (a < b ? -1 : 1));
const tIndex = new Map(themes.map((t, i) => [t, i]));

mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) {
  if (f === "index.json" || /^r\d{4}-\d{4}\.[0-9a-f]+\.json$/.test(f)) unlinkSync(join(OUT_DIR, f));
}
const pad = (n) => String(n).padStart(4, "0");
const shards = [];
let totalBytes = 0, totalGz = 0;
for (const [from, to] of BANDS) {
  const ps = kept.filter((p) => p.rating >= from && p.rating <= to);
  if (!ps.length) continue;
  const json = JSON.stringify({
    v: 2, from, to,
    p: ps.map((p) => [p.id, p.fen, p.moves, p.rating, p.themes.map((t) => tIndex.get(t))]),
  });
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 10);
  const file = `r${pad(from)}-${pad(to)}.${hash}.json`;
  writeFileSync(join(OUT_DIR, file), json);
  const gz = gzipSync(json, { level: 9 }).length;
  totalBytes += json.length; totalGz += gz;
  shards.push({ file, from, to, count: ps.length, lo: ps[0].rating, hi: ps[ps.length - 1].rating });
  console.log(`  ${file}: ${ps.length} puzzles, ${(json.length / 1024).toFixed(0)} KB (${(gz / 1024).toFixed(0)} KB gzipped)`);
}
const index = {
  v: 2,
  count: kept.length,
  themes,
  themeCounts: themes.map((t) => themeCount.get(t)),
  shards,
};
const indexJson = JSON.stringify(index);
writeFileSync(join(OUT_DIR, "index.json"), indexJson);
totalBytes += indexJson.length; totalGz += gzipSync(indexJson, { level: 9 }).length;

console.log(`kept ${kept.length} puzzles (${invalid} dropped by chess.js validation) in ${shards.length} shards -> ${OUT_DIR}`);
console.log(`total ${(totalBytes / 1024).toFixed(0)} KB (${(totalGz / 1024).toFixed(0)} KB gzipped), index ${(indexJson.length / 1024).toFixed(1)} KB`);
const per = buckets.map((_, i) => `${R_MIN + i * BUCKET}:${kept.filter((p) => Math.floor((p.rating - R_MIN) / BUCKET) === i).length}`);
console.log("per bucket: " + per.join(" "));
console.log("themes: " + themes.map((t) => `${t}:${themeCount.get(t)}`).join(" "));
