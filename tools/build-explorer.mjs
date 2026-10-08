// Builds the opening-explorer statistics under public/data/explorer/ from the lichess open
// game database (CC0): https://database.lichess.org/
//
// SOURCE (pinned, so the build is reproducible):
//   https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst
//   (29,224,520,887 bytes, ETag "6ac08d73-6cdeaccb7", Last-Modified Sat, 03 Oct 2026 05:06:59 GMT)
//   Only a prefix is used: HTTP "Range: bytes=0-1999999999" (the first 2,000,000,000 bytes,
//   SHA-256 9673b661a6273668e1ce741596a9e7da58bb47c3f9dd7b1a2d2845aab15eed61). Games in the
//   file are in time order, so the prefix is roughly the first five days of September 2026
//   (6.1M games, 14.3 GB of PGN). The truncated zstd stream is decompressed as far as it goes
//   (zstd errors at the cut) and the trailing partial game is dropped. Result: 995,839 games
//   qualify -> 28,669 positions, 109,858 moves, 4.4 MB in 17 files (~1.2 MB gzipped).
//   The build takes ~100 s on a 12-core laptop (10 worker threads), plus the download.
//
// Game filter: Event is rated Blitz, Rapid or Classical (game, arena or swiss; Bullet,
// UltraBullet and Correspondence are skipped), both WhiteElo and BlackElo >= 1800, Result is
// 1-0 / 0-1 / 1/2-1/2, Termination is Normal / Time forfeit / Insufficient material (skips
// Abandoned, Unterminated, Rules infraction), standard start position, at least one move.
//
// Build: the first 24 plies of every kept game are replayed with chess.js (in worker threads).
// Positions are keyed by the first 4 FEN fields as chess.js prints them (placement, side,
// castling, en passant), so transpositions merge. For every position and every move played
// from it we count white wins / draws / black wins and sum the game's average rating.
// A game counts once per position: if a position repeats inside the first 24 plies, only its
// first visit (and the move played there) is counted.
//   - a position is kept if >= MIN_POS_GAMES games played a move from it (within 24 plies);
//   - inside a kept position a move is kept if it was played >= MIN_MOVE_GAMES times;
//     the position totals still count every game, so kept moves may sum to less than the total.
// Every kept move is re-validated with chess.js (legal in its position; SAN and UCI from chess.js).
//
// Memory: positions are first counted by a 64-bit hash of the key in typed arrays (millions of
// one-off positions never become JS strings); only kept positions are turned back into FEN keys,
// by replaying the first game that reached them. The key's hash is re-checked at that point.
//
// Output (compact JSON, see src/explorer.js for the reader):
//   public/data/explorer/index.json   meta + the "core": the most played positions (the trunk of
//                                     the opening tree), loaded by loadExplorer()
//   public/data/explorer/NN.json      everything else, split by explorerShardOf(key) (FNV-1a of
//                                     the key) into SHARDS files, fetched lazily per lookup
//   Position entry: key -> [white, draws, black, m1, m2, ...] with
//                   m = "uci san white draws black avgRating" (one space-separated string)
//   Positions sorted by total desc (then key); moves by count desc (then uci).
//
// Usage:
//   node tools/build-explorer.mjs                     # download the range (cached) and build
//   node tools/build-explorer.mjs --pgn file.pgn      # use an already-decompressed PGN (may be truncated)
//   env: EXPLORER_CACHE=<dir> (default $TMPDIR/chess3d-explorer), EXPLORER_MONTH=2026-09,
//        EXPLORER_BYTES=2000000000, EXPLORER_WORKERS=<n>, EXPLORER_OUT=<dir> (default public/data/explorer)
//   The download is streamed to <cache>/lichess_db_standard_rated_<month>.head-<bytes>.pgn.zst
//   (a longer cached prefix of the same month is reused). Expect HTTP 206; anything else aborts.
// Deterministic: the same input bytes give byte-identical output files.
import { Chess } from "chess.js";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir, availableParallelism } from "node:os";
import { explorerShardOf } from "../src/explorer.js";

const PLIES = 24;

// ------------------------------------------------------------------------------------------
// Worker: replay games, emit (64-bit position hash, move code) per ply.
// ------------------------------------------------------------------------------------------

// Two 32-bit lanes (cyrb53-style mixing) -> a 64-bit identity for a position key.
function hash64(str, out, o) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  out[o] = h1 >>> 0;
  out[o + 1] = h2 >>> 0;
}

const PROMO = ["", "n", "b", "r", "q"];
// move code: from (6 bits) | to << 6 | promotion << 12; REPEAT marks a ply whose position
// already occurred earlier in the same game (kept for replay, skipped by the statistics)
const REPEAT = 0x8000;
const sqIndex = (sq) => (sq.charCodeAt(0) - 97) + 8 * (sq.charCodeAt(1) - 49);
const sqName = (i) => String.fromCharCode(97 + (i & 7)) + String.fromCharCode(49 + (i >> 3));
const encodeMove = (m) => sqIndex(m.from) | (sqIndex(m.to) << 6) | (PROMO.indexOf(m.promotion || "") << 12);
const decodeMove = (c) => ({ from: sqName(c & 63), to: sqName((c >> 6) & 63), promotion: PROMO[(c >> 12) & 7] || undefined });
const uciOf = (c) => { const m = decodeMove(c); return m.from + m.to + (m.promotion || ""); };

function keyOfFen(fen) {
  // first 4 fields: cut at the 4th space
  let i = -1;
  for (let k = 0; k < 4; k++) i = fen.indexOf(" ", i + 1);
  return fen.slice(0, i);
}

function workerMain() {
  parentPort.on("message", ({ id, text }) => {
    const games = text.split("\n");
    const counts = new Uint8Array(games.length);
    const hashes = new Uint32Array(games.length * PLIES * 2);
    const moves = new Uint16Array(games.length * PLIES);
    let p = 0, bad = 0;
    for (let g = 0; g < games.length; g++) {
      const sans = games[g].split(" ");
      const chess = new Chess();
      const start = p;
      let ok = true;
      const seen = new Set(); // a position repeated inside one game counts once (first visit)
      for (let i = 0; i < sans.length && i < PLIES; i++) {
        const key = keyOfFen(chess.fen());
        hash64(key, hashes, 2 * p);
        const dup = seen.has(key);
        seen.add(key);
        let m;
        try { m = chess.move(sans[i]); } catch { m = null; }
        if (!m) { ok = false; break; }
        moves[p++] = encodeMove(m) | (dup ? REPEAT : 0);
      }
      if (!ok) { p = start; bad++; } // drop the whole game: corrupt movetext
      counts[g] = p - start;
    }
    const h = hashes.slice(0, 2 * p), mv = moves.slice(0, p);
    parentPort.postMessage({ id, counts, hashes: h, moves: mv, bad }, [counts.buffer, h.buffer, mv.buffer]);
  });
}

// ------------------------------------------------------------------------------------------
// Main thread
// ------------------------------------------------------------------------------------------

async function main() {
  const T0 = Date.now();
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const OUT_DIR = process.env.EXPLORER_OUT ? resolve(process.env.EXPLORER_OUT) : join(root, "public/data/explorer");
  const MONTH = process.env.EXPLORER_MONTH || "2026-09";
  const SRC_URL = `https://database.lichess.org/standard/lichess_db_standard_rated_${MONTH}.pgn.zst`;
  const BYTES = Number(process.env.EXPLORER_BYTES || 2000000000);
  const CACHE = process.env.EXPLORER_CACHE || join(tmpdir(), "chess3d-explorer");
  const NWORKERS = Math.max(1, Number(process.env.EXPLORER_WORKERS || Math.max(1, availableParallelism() - 2)));
  // Pinned input: the default month + byte count must hash to this, else we warn loudly.
  const PINNED = { month: "2026-09", bytes: 2000000000,
    sha256: "9673b661a6273668e1ce741596a9e7da58bb47c3f9dd7b1a2d2845aab15eed61" };

  const MIN_RATING = 1800;
  const MIN_POS_GAMES = 40;     // keep positions with at least this many games
  const MIN_MOVE_GAMES = 5;     // keep moves played at least this many times in a kept position
  const SHARDS = 16;
  const CORE_BYTES = 350_000;   // the most played positions, up to about this size, go in index.json
  const BATCH = 4000;           // games per worker message

  const argVal = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const pgnArg = argVal("--pgn");
  if (!/^\d{4}-\d{2}$/.test(MONTH)) throw new Error("EXPLORER_MONTH must look like 2026-09");
  if (!Number.isSafeInteger(BYTES) || BYTES < 1e6) throw new Error("EXPLORER_BYTES must be an integer >= 1000000");

  // ---------- input stream ----------
  let input, zstdProc = null, sha256 = null;
  if (pgnArg) {
    input = createReadStream(pgnArg);
  } else {
    const zst = await ensurePrefix(SRC_URL, MONTH, BYTES, CACHE);
    sha256 = await sha256File(zst.path, BYTES);
    console.log(`input: ${zst.path} bytes 0-${BYTES - 1}  sha256 ${sha256}`);
    if (MONTH === PINNED.month && BYTES === PINNED.bytes && sha256 !== PINNED.sha256) {
      console.warn("WARNING: input bytes differ from the pinned SHA-256; the output will not match the shipped data");
    }
    const zstd = findZstd();
    if (!zstd) throw new Error("zstd CLI not found (brew install zstd), or pass --pgn <decompressed.pgn>");
    zstdProc = spawn(zstd, ["-dc", "--no-progress", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let zerr = "";
    zstdProc.stderr.on("data", (d) => { if (zerr.length < 4000) zerr += d; });
    zstdProc.on("close", (code) => {
      if (code) console.log(`zstd exited ${code} at the truncation point (expected): ${zerr.trim().split("\n").pop()}`);
    });
    // swallow EPIPE if zstd stops reading early
    zstdProc.stdin.on("error", () => {});
    createReadStream(zst.path, { start: 0, end: BYTES - 1 }).pipe(zstdProc.stdin);
    input = zstdProc.stdout;
  }

  // ---------- workers ----------
  const workers = [];
  const idle = [];
  const queue = [];
  const results = [];            // batch id -> { counts, hashes, moves }
  let pending = 0, badGames = 0;
  let onDrain = null;
  for (let i = 0; i < NWORKERS; i++) {
    const w = new Worker(new URL(import.meta.url));
    w.on("message", (msg) => {
      results[msg.id] = msg;
      badGames += msg.bad;
      pending--;
      idle.push(w);
      pump();
      if (pending === 0 && queue.length === 0 && onDrain) onDrain();
    });
    w.on("error", (e) => { console.error("worker error", e); process.exit(1); });
    workers.push(w);
    idle.push(w);
  }
  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop();
      w.postMessage(queue.shift());
      pending++;
    }
  }

  // ---------- per-game arrays (game order = batch order) ----------
  let gameResult = new Uint8Array(1 << 20);   // 0 white, 1 draw, 2 black
  let gameRating = new Uint16Array(1 << 20);  // WhiteElo + BlackElo
  let nGames = 0;
  let batchSans = [];
  let batchId = 0;
  const flush = () => {
    if (!batchSans.length) return;
    queue.push({ id: batchId++, text: batchSans.join("\n") });
    batchSans = [];
    pump();
  };

  // ---------- PGN stream parser ----------
  const stats = { games: 0, kept: 0, malformed: 0, events: new Map() };
  let hdr = null;            // current game's headers we care about
  let state = 0;             // 0 = between games / headers, 1 = in movetext
  let moveText = "";
  let lineBad = false;

  const finishGame = () => {
    if (!hdr) return;
    const h = hdr; hdr = null;
    const mt = moveText; moveText = "";
    state = 0;
    stats.games++;
    if (lineBad) { lineBad = false; stats.malformed++; return; }
    if (!h.qualifies) return;
    const res = h.result;
    // a complete movetext ends with the result token; anything else is truncated/corrupt
    if (!mt.trimEnd().endsWith(res)) { stats.malformed++; return; }
    const sans = firstSans(mt, PLIES);
    if (!sans) { stats.malformed++; return; }
    if (!sans.length) return;
    if (nGames === gameResult.length) {
      const r = new Uint8Array(nGames * 2); r.set(gameResult); gameResult = r;
      const q = new Uint16Array(nGames * 2); q.set(gameRating); gameRating = q;
    }
    gameResult[nGames] = res === "1-0" ? 0 : res === "0-1" ? 2 : 1;
    gameRating[nGames] = h.we + h.be;
    nGames++;
    stats.kept++;
    batchSans.push(sans.join(" "));
    if (batchSans.length >= BATCH) flush();
  };

  const onHeader = (line) => {
    // [Name "value"]
    const sp = line.indexOf(" ");
    const q2 = line.lastIndexOf('"');
    if (sp < 2 || line.charCodeAt(sp + 1) !== 34 || q2 <= sp + 1) return;
    const name = line.slice(1, sp);
    const value = line.slice(sp + 2, q2);
    switch (name) {
      case "Event": hdr.event = value; break;
      case "WhiteElo": hdr.we = /^\d{3,4}$/.test(value) ? +value : 0; break;
      case "BlackElo": hdr.be = /^\d{3,4}$/.test(value) ? +value : 0; break;
      case "Result": hdr.result = value; break;
      case "Termination": hdr.term = value; break;
      case "Variant": if (value !== "Standard") hdr.nonStd = true; break;
      case "FEN": case "SetUp": hdr.nonStd = true; break;
    }
  };
  const decide = (h) => {
    const m = /^(?:Rated )?(Blitz|Rapid|Classical|Bullet|UltraBullet|Correspondence)\b/.exec(h.event || "");
    const speed = m ? m[1] : "other";
    stats.events.set(speed, (stats.events.get(speed) || 0) + 1);
    h.qualifies = (speed === "Blitz" || speed === "Rapid" || speed === "Classical") &&
      h.we >= MIN_RATING && h.be >= MIN_RATING &&
      (h.result === "1-0" || h.result === "0-1" || h.result === "1/2-1/2") &&
      (h.term === "Normal" || h.term === "Time forfeit" || h.term === "Insufficient material") &&
      !h.nonStd;
  };

  const onLine = (line) => {
    if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (line.charCodeAt(0) === 91 /* [ */ && line.charCodeAt(line.length - 1) === 93 /* ] */) {
      if (state === 1) finishGame();          // movetext without trailing blank line
      if (!hdr) hdr = { qualifies: false };
      onHeader(line);
      return;
    }
    if (line.length === 0) {
      if (state === 1) finishGame();
      else if (hdr) { decide(hdr); state = 1; }   // blank line after the header block
      return;
    }
    if (!hdr) return;                          // stray text outside a game
    if (state === 0) { decide(hdr); state = 1; }
    if (hdr.qualifies) {
      if (moveText.length + line.length > 200_000) lineBad = true;
      else moveText += (moveText ? " " : "") + line;
    }
  };

  const MAX_LINE = 1 << 20;
  let carry = "";
  let bytesIn = 0, lastLog = Date.now();
  for await (const chunk of input) {
    bytesIn += chunk.length;
    const s = carry + chunk.toString("latin1");
    let start = 0, nl;
    while ((nl = s.indexOf("\n", start)) >= 0) {
      onLine(s.slice(start, nl));
      start = nl + 1;
    }
    carry = s.slice(start);
    if (carry.length > MAX_LINE) throw new Error("line longer than 1MB: input is not a PGN file?");
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      console.log(`  ${(bytesIn / 1e9).toFixed(2)} GB pgn, ${stats.games} games, ${stats.kept} kept, ${pending + queue.length} batches in flight`);
    }
  }
  // The trailing partial line (if any) is dropped. A game whose movetext ended exactly at the
  // cut is still complete (it ends with its result token), so finish it.
  if (state === 1) finishGame();
  flush();
  if (pending || queue.length) await new Promise((r) => { onDrain = r; });
  for (const w of workers) await w.terminate();
  if (stats.kept === 0) throw new Error("no qualifying games found; refusing to overwrite the output");
  const tParse = Date.now();
  console.log(`parsed ${(bytesIn / 1e9).toFixed(2)} GB of PGN: ${stats.games} games, ${stats.kept} qualify` +
    ` (${stats.malformed} malformed/truncated skipped, ${badGames} dropped by chess.js) in ${((tParse - T0) / 1000).toFixed(1)}s`);
  console.log("  by speed: " + [...stats.events].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));

  // ---------- assemble plies in game order ----------
  let nPlies = 0;
  for (let b = 0; b < batchId; b++) nPlies += results[b].moves.length;
  const plyHash = new Uint32Array(2 * nPlies);
  const plyMove = new Uint16Array(nPlies);
  const plyGame = new Uint32Array(nPlies);
  const plyIdx = new Uint8Array(nPlies);      // ply number inside its game
  {
    let p = 0, g = 0;
    for (let b = 0; b < batchId; b++) {
      const r = results[b];
      plyHash.set(r.hashes, 2 * p);
      plyMove.set(r.moves, p);
      for (let i = 0; i < r.counts.length; i++, g++) {
        for (let k = 0; k < r.counts[i]; k++) { plyGame[p + k] = g; plyIdx[p + k] = k; }
        p += r.counts[i];
      }
      results[b] = null;
    }
  }
  const gamesUsed = (() => { // games with at least one replayed ply
    let n = 0, last = -1;
    for (let p = 0; p < nPlies; p++) if (plyGame[p] !== last) { n++; last = plyGame[p]; }
    return n;
  })();
  console.log(`${gamesUsed} games replayed, ${nPlies} plies`);

  // ---------- count positions (open addressing on the 64-bit hash) ----------
  let cap = 1 << 22;
  let tHi = new Uint32Array(cap), tLo = new Uint32Array(cap), tCount = new Uint32Array(cap), tFirst = new Uint32Array(cap);
  let used = 0;
  const findSlot = (hi, lo) => {
    let i = (hi ^ Math.imul(lo, 0x9e3779b1)) & (cap - 1);
    while (tCount[i] !== 0 && (tHi[i] !== hi || tLo[i] !== lo)) i = (i + 1) & (cap - 1);
    return i;
  };
  const grow = () => {
    const oHi = tHi, oLo = tLo, oC = tCount, oF = tFirst, oCap = cap;
    cap *= 2;
    tHi = new Uint32Array(cap); tLo = new Uint32Array(cap); tCount = new Uint32Array(cap); tFirst = new Uint32Array(cap);
    for (let j = 0; j < oCap; j++) {
      if (!oC[j]) continue;
      const i = findSlot(oHi[j], oLo[j]);
      tHi[i] = oHi[j]; tLo[i] = oLo[j]; tCount[i] = oC[j]; tFirst[i] = oF[j];
    }
  };
  for (let p = 0; p < nPlies; p++) {
    if (plyMove[p] & REPEAT) continue;
    const hi = plyHash[2 * p], lo = plyHash[2 * p + 1];
    const i = findSlot(hi, lo);
    if (tCount[i] === 0) {
      tHi[i] = hi; tLo[i] = lo; tFirst[i] = p; used++;
      tCount[i] = 1;
      if (used * 10 > cap * 6) grow();
    } else tCount[i]++;
  }
  console.log(`${used} distinct positions in the first ${PLIES} plies`);

  // ---------- aggregate moves for positions that pass the threshold ----------
  const kept = new Map();     // slot -> position record
  for (let i = 0; i < cap; i++) {
    if (tCount[i] >= MIN_POS_GAMES) {
      kept.set(i, { hi: tHi[i], lo: tLo[i], first: tFirst[i], w: 0, d: 0, b: 0, moves: new Map() });
    }
  }
  for (let p = 0; p < nPlies; p++) {
    if (plyMove[p] & REPEAT) continue;
    const pos = kept.get(findSlot(plyHash[2 * p], plyHash[2 * p + 1]));
    if (!pos) continue;
    const g = plyGame[p];
    const res = gameResult[g];
    if (res === 0) pos.w++; else if (res === 1) pos.d++; else pos.b++;
    const code = plyMove[p];
    let mv = pos.moves.get(code);
    if (!mv) pos.moves.set(code, (mv = { code, w: 0, d: 0, b: 0, rating: 0 }));
    if (res === 0) mv.w++; else if (res === 1) mv.d++; else mv.b++;
    mv.rating += gameRating[g];          // sum of (WhiteElo + BlackElo); halved at output
  }
  console.log(`${kept.size} positions reached by >= ${MIN_POS_GAMES} games`);

  // ---------- turn kept positions back into FEN keys + validate every kept move ----------
  // Replay each representative game (the first game that reached the position) once.
  const byGame = new Map();
  for (const pos of kept.values()) {
    const g = plyGame[pos.first];
    if (!byGame.has(g)) byGame.set(g, []);
    byGame.get(g).push(pos);
  }
  // first ply of each game: plies of a game are contiguous; tFirst points into them
  const tmp = new Uint32Array(2);
  let hashMismatch = 0, illegal = 0;
  const entries = [];
  for (const [g, list] of [...byGame].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => plyIdx[a.first] - plyIdx[b.first]);
    const gStart = list[0].first - plyIdx[list[0].first];
    const chess = new Chess();
    let ply = 0;
    for (const pos of list) {
      const target = plyIdx[pos.first];
      while (ply < target) { chess.move(decodeMove(plyMove[gStart + ply])); ply++; }
      const fen = chess.fen();
      const key = keyOfFen(fen);
      hash64(key, tmp, 0);
      if (tmp[0] !== pos.hi || tmp[1] !== pos.lo) { hashMismatch++; continue; }
      const moves = [];
      for (const mv of pos.moves.values()) {
        if (mv.w + mv.d + mv.b < MIN_MOVE_GAMES) continue;
        let m;
        try { m = chess.move(decodeMove(mv.code)); } catch { m = null; }
        if (!m) { illegal++; continue; }
        chess.undo();
        const uci = m.from + m.to + (m.promotion || "");
        if (uci !== uciOf(mv.code)) { illegal++; continue; }
        moves.push({ uci, san: m.san, w: mv.w, d: mv.d, b: mv.b, r: Math.round(mv.rating / 2 / (mv.w + mv.d + mv.b)) });
      }
      const total = pos.w + pos.d + pos.b;
      moves.sort((a, b) => (b.w + b.d + b.b) - (a.w + a.d + a.b) || (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0));
      entries.push({ key, total, w: pos.w, d: pos.d, b: pos.b, moves });
    }
  }
  if (!entries.length) throw new Error("no position reached the threshold; refusing to overwrite the output");
  if (hashMismatch || illegal) throw new Error(`reconstruction failed: ${hashMismatch} hash mismatches, ${illegal} illegal moves`);
  entries.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const nMoves = entries.reduce((s, e) => s + e.moves.length, 0);
  console.log(`kept ${entries.length} positions, ${nMoves} moves (>= ${MIN_MOVE_GAMES} games each); all moves legal`);

  // ---------- serialize ----------
  const encode = (e) => [e.w, e.d, e.b, ...e.moves.map((m) => `${m.uci} ${m.san} ${m.w} ${m.d} ${m.b} ${m.r}`)];
  const entryJson = (e) => JSON.stringify(e.key) + ":" + JSON.stringify(encode(e));
  // core: top positions by total until CORE_BYTES; then everything with total >= that cutoff
  let coreMin = Infinity, acc = 0;
  for (const e of entries) {
    acc += entryJson(e).length + 1;
    coreMin = e.total;
    if (acc >= CORE_BYTES) break;
  }
  const core = entries.filter((e) => e.total >= coreMin);
  const rest = entries.filter((e) => e.total < coreMin);
  const shards = Array.from({ length: SHARDS }, () => []);
  for (const e of rest) shards[explorerShardOf(e.key, SHARDS)].push(e);

  const meta = {
    v: 1,
    source: `lichess.org rated games, ${MONTH}`,
    url: pgnArg ? null : SRC_URL,
    range: pgnArg ? null : `bytes=0-${BYTES - 1}`,
    sha256,
    license: "CC0-1.0",
    filter: "rated Blitz/Rapid/Classical, both players >= 1800",
    minRating: MIN_RATING,
    plies: PLIES,
    games: gamesUsed,
    positions: entries.length,
    minGames: MIN_POS_GAMES,
    minMoveGames: MIN_MOVE_GAMES,
    shards: SHARDS,
    shardHash: "fnv1a32",
    coreMinGames: coreMin,
    format: "key -> [white, draws, black, 'uci san white draws black avgRating', ...]",
  };
  const objJson = (list) => "{" + list.map(entryJson).join(",\n") + "}";
  // index: meta fields first, then the core positions under "p"
  const indexJson = JSON.stringify(meta).slice(0, -1) + ',"p":' + objJson(core) + "}\n";

  // write to a temp dir, then swap in (old shard files never linger)
  const tmpDir = OUT_DIR + ".tmp";
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "index.json"), indexJson);
  const sizes = [["index.json", indexJson.length, core.length]];
  for (let s = 0; s < SHARDS; s++) {
    const name = String(s).padStart(2, "0") + ".json";
    const json = '{"v":1,"shard":' + s + ',"p":' + objJson(shards[s]) + "}\n";
    writeFileSync(join(tmpDir, name), json);
    sizes.push([name, json.length, shards[s].length]);
  }
  rmSync(OUT_DIR, { recursive: true, force: true });
  renameSync(tmpDir, OUT_DIR);

  const total = sizes.reduce((s, x) => s + x[1], 0);
  for (const [n, sz, cnt] of sizes) console.log(`  ${n.padEnd(11)} ${(sz / 1024).toFixed(1).padStart(8)} KB  ${String(cnt).padStart(6)} positions`);
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB in ${sizes.length} files -> ${OUT_DIR}`);
  console.log(`core: ${core.length} positions with >= ${coreMin} games; shards: ${rest.length} positions`);
  const secs = (Date.now() - T0) / 1000;
  console.log(`build time ${secs.toFixed(1)}s (${NWORKERS} workers)`);
  // timing goes to the cache dir, not the (deterministic) output
  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(join(CACHE, "last-build.json"), JSON.stringify({ seconds: +secs.toFixed(1), workers: NWORKERS,
      gamesSeen: stats.games, gamesQualified: stats.kept, gamesUsed, positions: entries.length, moves: nMoves,
      bytes: total, finished: new Date().toISOString() }, null, 1));
  } catch { /* optional */ }
}

// ------------------------------------------------------------------------------------------
// helpers (main thread)
// ------------------------------------------------------------------------------------------

const SAN_RE = /^(?:[NBRQK][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[NBRQ])?|O-O(?:-O)?)[+#]?$/;
const RESULT_RE = /^(?:1-0|0-1|1\/2-1\/2|\*)$/;

// First `max` SAN moves of a movetext; null if it contains something that isn't PGN.
function firstSans(text, max) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n && out.length < max) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    if (c === 123) {                         // { comment }
      const j = text.indexOf("}", i + 1);
      if (j < 0) return null;
      i = j + 1;
      continue;
    }
    if (c === 40) {                          // ( variation ), possibly nested
      let depth = 0;
      for (; i < n; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 123) { const j = text.indexOf("}", i + 1); if (j < 0) return null; i = j; }
        else if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) break;
      }
      if (depth !== 0) return null;
      i++;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 123 || d === 40) break;
      j++;
    }
    let tok = text.slice(i, j);
    i = j;
    if (tok.charCodeAt(0) === 36) continue;                 // $NAG
    if (RESULT_RE.test(tok)) break;
    const num = /^\d+\.(?:\.\.)?/.exec(tok);                 // "12." / "12..." / "12.e4"
    if (num) { tok = tok.slice(num[0].length); if (!tok) continue; }
    tok = tok.replace(/[!?]+$/, "");
    if (!SAN_RE.test(tok)) return null;
    out.push(tok);
  }
  return out;
}

function findZstd() {
  for (const p of ["zstd", "/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd"]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

// Ensure the first `bytes` bytes of the monthly file are in the cache; reuse a longer cached
// prefix of the same month if there is one. Returns { path } (read it with end = bytes - 1).
async function ensurePrefix(url, month, bytes, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const base = `lichess_db_standard_rated_${month}.head-`;
  for (const f of readdirSync(cacheDir).sort()) {
    const m = f.startsWith(base) && /^(\d+)\.pgn\.zst$/.exec(f.slice(base.length));
    if (m && +m[1] >= bytes && statSync(join(cacheDir, f)).size === +m[1]) return { path: join(cacheDir, f) };
  }
  const dest = join(cacheDir, `${base}${bytes}.pgn.zst`);
  const part = dest + ".part";
  console.log(`downloading ${url}  Range: bytes=0-${bytes - 1} ...`);
  const ac = new AbortController();
  const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: ac.signal });
  if (res.status !== 206) {
    ac.abort(); // never pull the whole multi-GB file by accident
    throw new Error(`expected HTTP 206 Partial Content, got ${res.status}`);
  }
  console.log(`  ${res.headers.get("content-range")}  etag ${res.headers.get("etag")}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  const got = statSync(part).size;
  if (got !== bytes) throw new Error(`short download: ${got} of ${bytes} bytes`);
  renameSync(part, dest);
  return { path: dest };
}

async function sha256File(path, bytes) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1 })) h.update(chunk);
  return h.digest("hex");
}

// run last: main() uses the helpers above, which must be initialized first
if (!isMainThread) workerMain();
else await main();
