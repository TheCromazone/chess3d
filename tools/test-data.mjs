// Validates the static data layer: public/data/openings.json, public/data/puzzles/ (index +
// rating-band shards), public/data/classics.json, src/openings.js, src/puzzles.js and
// src/learn-data.js.
//   node tools/test-data.mjs            # all checks
//   node tools/test-data.mjs --engine   # also print Stockfish evals of the endgame drills (slow)
import { Chess } from "chess.js";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = (f) => join(root, "public/data", f);
const readJson = (f) => JSON.parse(readFileSync(dataPath(f), "utf8"));
const kb = (f) => statSync(dataPath(f)).size / 1024;

let failures = 0, warnings = 0;
const ok = (cond, name) => {
  if (!cond) { failures++; console.log("FAIL  " + name); }
  return !!cond;
};
const pass = (name) => console.log("PASS  " + name);
const check = (cond, name) => { if (ok(cond, name)) pass(name); };
const warn = (msg) => { warnings++; console.log("WARN  " + msg); };
const info = (msg) => console.log("      " + msg);
const section = (t) => console.log("\n== " + t + " ==");

// Browser fetch shim: "./data/x.json" -> public/data/x.json. Every requested URL is logged;
// `fetchFails` makes every request throw, and URLs matching `fetch404` answer 404.
let fetchFails = false;
let fetch404 = null;
const fetchLog = [];
globalThis.fetch = async (url) => {
  fetchLog.push(String(url));
  if (fetchFails) throw new Error("network down (test)");
  const notFound = { ok: false, status: 404, json: async () => { throw new Error("404"); } };
  if (fetch404 && fetch404.test(String(url))) return notFound;
  const p = join(root, "public", String(url).replace(/^\.\//, ""));
  let text;
  try { text = readFileSync(p, "utf8"); } catch { return notFound; }
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

const keyOf = (fen) => fen.split(" ").slice(0, 4).join(" ");
const sanList = (s) => s.trim().split(/\s+/).filter(Boolean);
function replaySan(moves, fen) {
  const c = fen ? new Chess(fen) : new Chess();
  for (const san of sanList(moves)) {
    try { c.move(san); } catch { return { chess: c, error: san }; }
  }
  return { chess: c, error: null };
}
function applyUci(c, u) {
  return c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
}
// null if the FEN is a legal, playable position; otherwise the reason
function fenProblem(fen) {
  let c;
  try { c = new Chess(fen); } catch (e) { return "chess.js rejects it: " + e.message; }
  const f = fen.split(" ");
  const rows = f[0].split("/");
  if (/[pP]/.test(rows[0]) || /[pP]/.test(rows[7])) return "pawn on the first/last rank";
  const flipped = [f[0], f[1] === "w" ? "b" : "w", "-", "-", "0", "1"].join(" ");
  try { if (new Chess(flipped).inCheck()) return "side NOT to move is in check (illegal position)"; } catch (e) { return "flip failed: " + e.message; }
  if (c.isGameOver()) return "position is already game over";
  return null;
}

// =========================================================================================
section("Openings");
const book = readJson("openings.json");
const bookKeys = Object.keys(book);
info(`openings.json: ${bookKeys.length} named positions, ${kb("openings.json").toFixed(1)} KB`);
check(bookKeys.length > 3000, `book has > 3000 positions (${bookKeys.length})`);
check(kb("openings.json") < 500, "openings.json under 500 KB");
check(!/\n|": \[/.test(readFileSync(dataPath("openings.json"), "utf8").slice(0, 2000)), "openings.json is compact");
check(bookKeys.every((k) => k.split(" ").length === 4 && /^[wb]$/.test(k.split(" ")[1])), "every key is 4 FEN fields");
check(Object.values(book).every((v) => Array.isArray(v) && /^[A-E]\d\d$/.test(v[0]) && typeof v[1] === "string" && v[1].length > 0), "every value is [eco, name]");
{
  const samples = [
    ["e4 e5 Nf3 Nc6 Bb5", "Ruy Lopez"],
    ["e4 c5", "Sicilian Defense"],
    ["d4 d5 c4", "Queen's Gambit"],
    ["e4 e6", "French Defense"],
    ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "Sicilian Defense: Najdorf Variation"],
  ];
  for (const [line, name] of samples) {
    const { chess } = replaySan(line);
    const hit = book[keyOf(chess.fen())];
    check(hit && hit[1] === name, `book: ${line} -> ${name}${hit ? "" : " (missing)"}${hit && hit[1] !== name ? " (got " + hit[1] + ")" : ""}`);
  }
}

const O = await import(pathToFileURL(join(root, "src/openings.js")).href);
check(O.openingsLoaded() === false, "openingsLoaded() false before load");
check(O.openingAt(new Chess().fen()) === null && O.bookMoves(new Chess().fen()).length === 0, "lookups are empty before load");
const [l1, l2] = await Promise.all([O.loadOpenings(), O.loadOpenings()]);
check(l1 === true && l2 === true && O.openingsLoaded(), "loadOpenings() resolves true (concurrent calls ok)");
check((await O.loadOpenings()) === true, "loadOpenings() again resolves true");
{
  const c = new Chess();
  c.move("e4");
  const afterE4 = c.fen();
  check(O.positionKey(afterE4) === keyOf(afterE4), "positionKey = first 4 FEN fields");
  const foreign = afterE4.split(" "); foreign[3] = "e3";
  check(O.positionKey(foreign.join(" ")) === keyOf(afterE4), "positionKey drops an uncapturable en-passant square");
  const epFen = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3";
  check(O.positionKey(epFen).endsWith(" f6"), "positionKey keeps a capturable en-passant square");
  check(O.openingAt(afterE4)?.name === "King's Pawn Game", "openingAt(1.e4) = King's Pawn Game");
  check(O.isBookPosition(afterE4) && !O.isBookPosition("8/8/8/4k3/8/8/8/4K3 w - - 0 1"), "isBookPosition");

  const g = new Chess();
  const fens = [];
  for (const m of sanList("e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 a4 Bd7 Qe2 Rac8 Kh1 Rfe8 Na3 Bf8")) { g.move(m); fens.push(g.fen()); }
  const og = O.openingForGame(fens);
  check(og && /Ruy Lopez/.test(og.name) && og.ply === og.index + 1 && og.ply >= 16, `openingForGame (Ruy Lopez, deepest named ply): ${og && og.eco + " " + og.name + " @ply " + og.ply}`);
  check(O.openingForGame([]) === null && O.openingForGame(["8/8/8/4k3/8/8/8/4K3 w - - 0 1"]) === null, "openingForGame returns null when nothing is named");

  const bm = O.bookMoves(new Chess().fen());
  check(bm.length >= 15 && bm.every((m) => m.san && m.from && m.to && m.eco && m.name), `bookMoves(start) lists ${bm.length} named replies`);
  check(bm.every((m, i) => i === 0 || bm[i - 1].name.localeCompare(m.name) <= 0), "bookMoves sorted by name");
  check(bm.some((m) => m.san === "e4" && m.name === "King's Pawn Game"), "bookMoves(start) includes e4 King's Pawn Game");
  check(O.bookMoves("not a fen").length === 0, "bookMoves(invalid fen) = []");
}
{
  // failure path on a fresh module instance
  fetchFails = true;
  const O2 = await import(pathToFileURL(join(root, "src/openings.js")).href + "?fresh");
  const origWarn = console.warn; console.warn = () => {};
  const r = await O2.loadOpenings();
  console.warn = origWarn;
  fetchFails = false;
  check(r === false && !O2.openingsLoaded() && O2.openingAt(new Chess().fen()) === null && O2.openingForGame([new Chess().fen()]) === null && O2.bookMoves(new Chess().fen()).length === 0,
    "loadOpenings() resolves false when fetch fails, lookups return null/[]");
  check((await O2.loadOpenings()) === true, "loadOpenings() retries after a failed load");
}

// POPULAR_OPENINGS
{
  const P = O.POPULAR_OPENINGS;
  info(`POPULAR_OPENINGS: ${P.length} lines`);
  check(P.length >= 28, "POPULAR_OPENINGS has ~30 entries");
  check(new Set(P.map((p) => p.id)).size === P.length, "POPULAR_OPENINGS ids unique");
  const required = ["italian-game", "ruy-lopez", "scotch-game", "sicilian-najdorf", "sicilian-dragon", "french-defense",
    "caro-kann", "pirc-defense", "scandinavian", "queens-gambit-declined", "queens-gambit-accepted", "slav-defense",
    "kings-indian", "nimzo-indian", "grunfeld", "dutch-defense", "london-system", "english-opening", "reti-opening",
    "kings-gambit", "vienna-game", "petrov-defense", "philidor-defense", "alekhine-defense", "catalan", "benoni",
    "budapest-gambit", "evans-gambit", "two-knights", "four-knights"];
  const missing = required.filter((id) => !P.some((p) => p.id === id));
  check(missing.length === 0, "POPULAR_OPENINGS covers all requested openings" + (missing.length ? ": missing " + missing : ""));
  check(P.some((p) => p.side === "w") && P.some((p) => p.side === "b"), "POPULAR_OPENINGS has both sides");
  let allLegal = true, allNamed = true, allShape = true;
  for (const p of P) {
    const shape = p.id && p.name && /^[A-E]\d\d$/.test(p.eco) && (p.side === "w" || p.side === "b") && p.blurb && typeof p.moves === "string";
    const plies = sanList(p.moves || "").length;
    if (!shape || plies < 6 || plies > 12) { allShape = false; ok(false, `${p.id}: bad shape or ${plies} plies`); }
    const { chess, error } = replaySan(p.moves);
    if (error) { allLegal = false; ok(false, `${p.id}: illegal move ${error}`); continue; }
    const hit = book[keyOf(chess.fen())];
    if (!hit) { allNamed = false; warn(`${p.id}: final position is not a named book position`); }
    else {
      if (hit[0] !== p.eco) warn(`${p.id}: eco ${p.eco} but book says ${hit[0]}`);
      info(`${p.id.padEnd(24)} ${p.side} ${String(plies).padStart(2)} plies -> ${hit[0]} ${hit[1]}`);
    }
  }
  check(allShape, "every POPULAR_OPENINGS entry has the right shape and 6-12 plies");
  check(allLegal, "every POPULAR_OPENINGS line replays legally");
  if (allNamed) pass("every POPULAR_OPENINGS line ends on a named position");
}

// =========================================================================================
section("Puzzles");
const PZ_DIR = "puzzles/";
check(!existsSync(dataPath("puzzles.json")), "legacy single-file puzzles.json is gone (the set is sharded now)");
const PZI = readJson(PZ_DIR + "index.json");
check(PZI.v === 2 && Number.isInteger(PZI.count) && Array.isArray(PZI.themes) && Array.isArray(PZI.themeCounts) &&
  PZI.themeCounts.length === PZI.themes.length && Array.isArray(PZI.shards) && PZI.shards.length >= 4,
  "puzzles/index.json shape {v:2, count, themes, themeCounts, shards}");
check(kb(PZ_DIR + "index.json") < 8, `index.json is small (${kb(PZ_DIR + "index.json").toFixed(1)} KB)`);
// Load every shard and check it against the index.
const PZ = { themes: PZI.themes, p: [] };
{
  let shapeOk = true, bandOk = true, countOk = true, sortedOk = true, totalKb = 0, totalGz = 0;
  const shardFiles = new Set();
  PZI.shards.forEach((s, i) => {
    const where = `shard ${s.file}`;
    if (!(typeof s.file === "string" && /^r\d{4}-\d{4}\.[0-9a-f]+\.json$/.test(s.file) && Number.isInteger(s.from) && Number.isInteger(s.to) &&
      s.from <= s.to && Number.isInteger(s.count) && s.lo >= s.from && s.hi <= s.to && s.lo <= s.hi)) { shapeOk = false; ok(false, where + ": bad index entry"); return; }
    if (i > 0 && s.from !== PZI.shards[i - 1].to + 1) { bandOk = false; ok(false, where + ": bands are not contiguous"); }
    shardFiles.add(s.file);
    const raw = readFileSync(dataPath(PZ_DIR + s.file), "utf8");
    totalKb += raw.length / 1024;
    totalGz += gzipSync(raw).length / 1024;
    const d = JSON.parse(raw);
    if (!(d.v === 2 && d.from === s.from && d.to === s.to && Array.isArray(d.p))) { shapeOk = false; ok(false, where + ": bad shard header"); return; }
    if (d.p.length !== s.count) { countOk = false; ok(false, `${where}: ${d.p.length} puzzles but index says ${s.count}`); }
    if (!d.p.every((r) => r[3] >= s.from && r[3] <= s.to)) { bandOk = false; ok(false, where + ": rating outside its band"); }
    if (!d.p.every((r, j) => j === 0 || d.p[j - 1][3] <= r[3])) { sortedOk = false; ok(false, where + ": not sorted by rating"); }
    if (d.p.length && (d.p[0][3] !== s.lo || d.p[d.p.length - 1][3] !== s.hi)) { bandOk = false; ok(false, where + ": lo/hi do not match"); }
    info(`${s.file.padEnd(28)} ${String(s.from).padStart(4)}-${String(s.to).padEnd(4)} ${String(d.p.length).padStart(5)} puzzles  ${(raw.length / 1024).toFixed(0).padStart(4)} KB`);
    for (const r of d.p) PZ.p.push(r);
  });
  check(shapeOk, "every shard entry and shard file has the right shape");
  check(bandOk, "shards cover contiguous rating bands and every puzzle sits in its band");
  check(countOk && PZ.p.length === PZI.count, `shard counts match the index (total ${PZ.p.length})`);
  check(sortedOk, "every shard is sorted by rating");
  check(PZI.shards.every((s) => s.count >= 2000 && s.count <= 3500), "every shard holds 2,000-3,500 puzzles");
  const stray = readdirSync(dataPath(PZ_DIR)).filter((f) => f !== "index.json" && !shardFiles.has(f));
  check(stray.length === 0, "no stray files in public/data/puzzles/" + (stray.length ? ": " + stray : ""));
  info(`total transfer: ${totalKb.toFixed(0)} KB raw, ${totalGz.toFixed(0)} KB gzipped`);
  check(totalGz < 1100, `all shards together stay under ~1 MB gzipped (${totalGz.toFixed(0)} KB)`);
  check(PZI.shards.every((s) => statSync(dataPath(PZ_DIR + s.file)).size < 500 * 1024), "every shard is under 500 KB");
}
info(`puzzle set: ${PZ.p.length} puzzles, ${PZ.themes.length} themes`);
check(PZ.p.length >= 15000 && PZ.p.length <= 20000, `15,000-20,000 puzzles (${PZ.p.length})`);
check(new Set(PZ.p.map((r) => r[0])).size === PZ.p.length, "puzzle ids unique across shards");
check(PZ.p.every((r) => r.length === 5 && typeof r[0] === "string" && typeof r[1] === "string" && typeof r[2] === "string" &&
  Number.isInteger(r[3]) && Array.isArray(r[4]) && r[4].length > 0 && r[4].every((t) => Number.isInteger(t) && t >= 0 && t < PZ.themes.length)), "every row is [id, fen, moves, rating, [themeIdx]]");
{
  let bad = 0;
  const mateIdx = new Set(PZ.themes.map((t, i) => (/^mate(In\d)?$/.test(t) ? i : -1)).filter((i) => i >= 0));
  for (const [id, fen, moves, , th] of PZ.p) {
    try {
      const c = new Chess(fen);
      const ms = moves.split(" ");
      for (const u of ms) applyUci(c, u);
      if (ms.length < 2 || ms.length % 2) throw new Error("move count " + ms.length);
      if (th.some((t) => mateIdx.has(t)) && !c.isCheckmate()) throw new Error("mate theme but no mate");
    } catch (e) { if (bad++ < 5) ok(false, `puzzle ${id}: ${e.message}`); }
  }
  check(bad === 0, `every puzzle replays legally with chess.js (${PZ.p.length} checked)`);
}
const PZ_ROWS = [...PZ.p].sort((a, b) => a[3] - b[3]);
{
  const buckets = new Map();
  for (const r of PZ.p) { const b = Math.floor(r[3] / 100) * 100; buckets.set(b, (buckets.get(b) || 0) + 1); }
  info("per rating bucket: " + [...buckets].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}:${n}`).join(" "));
  check(PZ_ROWS[0][3] >= 400 && PZ_ROWS[PZ_ROWS.length - 1][3] < 3000, "ratings within 400..2999");
  const thin = [...buckets].filter(([b, n]) => b < 2800 && n < 500);
  check(thin.length === 0, "every 100-point bucket from 400 to 2799 has at least 500 puzzles" + (thin.length ? ": " + thin.map(([b, n]) => b + ":" + n) : ""));
  const counts = new Map(PZ.themes.map((t) => [t, 0]));
  for (const r of PZ.p) for (const t of r[4]) counts.set(PZ.themes[t], counts.get(PZ.themes[t]) + 1);
  check(PZ.themes.every((t, i) => counts.get(t) === PZI.themeCounts[i]), "index themeCounts match the shards");
  info("themes: " + [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(" "));
  const core = ["mateIn1", "mateIn2", "mateIn3", "fork", "pin", "skewer", "hangingPiece", "discoveredAttack", "doubleCheck",
    "sacrifice", "deflection", "attraction", "backRankMate", "smotheredMate", "endgame", "rookEndgame", "pawnEndgame",
    "promotion", "advancedPawn", "trappedPiece", "xRayAttack", "zugzwang", "quietMove", "defensiveMove", "crushing",
    "advantage", "equality", "short", "long", "opening", "middlegame"];
  const absent = core.filter((t) => !(counts.get(t) > 0));
  check(absent.length === 0, "all common themes present" + (absent.length ? ": missing " + absent : ""));
  for (const t of core) if (counts.get(t) > 0 && counts.get(t) < 100 && t !== "equality") warn(`theme ${t} has only ${counts.get(t)} puzzles`);
  const rare = ["zugzwang", "underPromotion", "castling", "enPassant", "interference", "intermezzo", "clearance",
    "capturingDefender", "attackingF2F7", "exposedKing", "kingsideAttack", "queensideAttack", "hookMate", "arabianMate",
    "anastasiaMate", "bodenMate", "doubleBishopMate", "dovetailMate"];
  const thinRare = rare.filter((t) => !(counts.get(t) >= 100));
  check(thinRare.length === 0, "rarer themes have at least 100 puzzles each (" + rare.map((t) => `${t} ${counts.get(t) || 0}`).join(", ") + ")");
}

fetchLog.length = 0;
const Z = await import(pathToFileURL(join(root, "src/puzzles.js")).href);
check(Z.nextPuzzle() === null && Z.themesAvailable().length === 0 && Z.dailyPuzzle("2026-01-01") === null &&
  Z.rushSequence(1).length === 0 && Z.getPuzzle(PZ.p[0][0]) === null && !Z.puzzlesLoaded() && Z.puzzleCount() === 0, "puzzle lookups empty before load");
check((await Z.loadPuzzles()) === true && (await Z.loadPuzzles()) === true, "loadPuzzles() resolves true (repeatable)");
{
  const want = ["./data/puzzles/index.json", ...PZI.shards.map((s) => "./data/puzzles/" + s.file)];
  check(fetchLog.length === want.length && want.every((u) => fetchLog.includes(u)) && fetchLog[0] === want[0],
    `loadPuzzles() fetched the index, then each of the ${PZI.shards.length} shards exactly once`);
  check(Z.puzzlesLoaded() && Z.puzzleCount() === PZI.count, `puzzleCount() = ${Z.puzzleCount()} after load`);
  const missingInfo = PZ.themes.filter((t) => !Z.THEME_INFO[t] || !Z.THEME_INFO[t].name || !Z.THEME_INFO[t].desc);
  check(missingInfo.length === 0, "THEME_INFO has a name + desc for every theme in the data" + (missingInfo.length ? ": " + missingInfo : ""));
  const ta = Z.themesAvailable();
  check(ta.length === PZ.themes.length && ta.every((t, i) => t.id && t.name && t.count > 0 && (i === 0 || ta[i - 1].count >= t.count)),
    `themesAvailable(): ${ta.length} themes sorted by count (top: ${ta.slice(0, 3).map((t) => t.name + " " + t.count).join(", ")})`);

  // one sample puzzle from every shard
  let gpOk = true;
  for (let i = 0; i < PZ.p.length; i += 2909) {
    const sample = PZ.p[i];
    const p = Z.getPuzzle(sample[0]);
    if (!(p && p.id === sample[0] && p.fen === sample[1] && p.moves.join(" ") === sample[2] && p.rating === sample[3] &&
      p.themes.length === sample[4].length && p.themes.every((t, k) => t === PZ.themes[sample[4][k]]) &&
      p.playerColor === (sample[1].split(" ")[1] === "w" ? "b" : "w"))) gpOk = false;
  }
  check(gpOk, "getPuzzle() returns the normalized puzzle for samples from every shard");
  const gp = Z.getPuzzle(PZ.p[1234][0]);
  check(Z.getPuzzle("nope!") === null, "getPuzzle(unknown) = null");
  {
    const c = new Chess(gp.fen);
    applyUci(c, gp.moves[0]);
    check(c.turn() === gp.playerColor, "playerColor is the side to move after the setup move");
  }

  let near = true;
  for (const r of [450, 800, 1200, 1600, 2000, 2400, 2750]) {
    for (let i = 0; i < 20; i++) { const p = Z.nextPuzzle({ rating: r }); if (!p || Math.abs(p.rating - r) > 75) near = false; }
  }
  check(near, "nextPuzzle() stays within +-75 of the rating in every band");
  const far = Z.nextPuzzle({ rating: 3400 });
  check(far && far.rating > 2700, `nextPuzzle() widens the window at the extremes (3400 -> ${far && far.rating})`);
  let themed = true;
  for (let i = 0; i < 20; i++) { const p = Z.nextPuzzle({ rating: 1500, theme: "fork" }); if (!p || !p.themes.includes("fork")) themed = false; }
  check(themed, "nextPuzzle({theme:'fork'}) only returns forks");
  const up = Z.nextPuzzle({ rating: 1500, theme: "underPromotion" });
  check(up && up.themes.includes("underPromotion"), "nextPuzzle() finds a rare theme (underPromotion)");
  check(Z.nextPuzzle({ theme: "noSuchTheme" }) === null, "nextPuzzle(unknown theme) = null");
  const seen = new Set(PZ.p.filter((r) => r[3] >= 1100 && r[3] <= 1300).map((r) => r[0]));
  const ns = Z.nextPuzzle({ rating: 1200, seen });
  check(ns && !seen.has(ns.id), "nextPuzzle() skips seen ids (widening past a fully-seen band)");
  const eqIds = new Set(PZ.p.filter((r) => r[4].includes(PZ.themes.indexOf("equality"))).map((r) => r[0]));
  check(Z.nextPuzzle({ theme: "equality", seen: eqIds }) === null, "nextPuzzle() = null when every match is seen");

  const d1 = Z.dailyPuzzle("2026-10-08"), d1b = Z.dailyPuzzle("2026-10-08");
  check(d1 && d1b && d1.id === d1b.id && d1.rating >= 1500 && d1.rating <= 2100, `dailyPuzzle() deterministic, rated 1500-2100 (${d1 && d1.id} ${d1 && d1.rating} ${d1 && d1.themes.join(",")})`);
  const days = [];
  for (let i = 1; i <= 60; i++) days.push(Z.dailyPuzzle(`2026-${String(1 + Math.floor((i - 1) / 28)).padStart(2, "0")}-${String(1 + ((i - 1) % 28)).padStart(2, "0")}`).id);
  check(new Set(days).size === days.length, "dailyPuzzle() gives a different puzzle on 60 different days");
  check(days.every((id) => { const p = Z.getPuzzle(id); return p.themes.some((t) => ["long", "mateIn3", "sacrifice"].includes(t)); }), "daily puzzles favour long / mateIn3 / sacrifice");
  check(Z.dailyPuzzle() !== null, "dailyPuzzle() with no argument uses today");

  const rs = Z.rushSequence(42), rs2 = Z.rushSequence(42), rs3 = Z.rushSequence("other");
  check(rs.length === 80 && rs.map((p) => p.id).join() === rs2.map((p) => p.id).join(), "rushSequence(seed) deterministic, 80 puzzles");
  check(rs.map((p) => p.id).join() !== rs3.map((p) => p.id).join(), "rushSequence differs per seed");
  check(new Set(rs.map((p) => p.id)).size === rs.length, "rushSequence has no repeats");
  check(rs[0].rating < 750 && rs[rs.length - 1].rating > 2450, `rushSequence ramps ${rs[0].rating} -> ${rs[rs.length - 1].rating}`);
  const halves = [rs.slice(0, 40), rs.slice(40)].map((h) => h.reduce((s, p) => s + p.rating, 0) / h.length);
  check(halves[0] < halves[1], "rushSequence gets harder");
  check(Z.rushSequence(1, 10).length === 10, "rushSequence(seed, 10) length 10");
  check(Z.rushSequence(7, 120).length === 120, "rushSequence(seed, 120) length 120 (Puzzle Rush screen)");

  // A second, independently loaded module instance must agree (determinism doesn't depend on load order).
  const Z2 = await import(pathToFileURL(join(root, "src/puzzles.js")).href + "?determinism");
  await Z2.loadPuzzles();
  const dates = Array.from({ length: 30 }, (_, i) => `2027-03-${String(i + 1).padStart(2, "0")}`);
  check(dates.every((d) => Z2.dailyPuzzle(d).id === Z.dailyPuzzle(d).id) && Z2.rushSequence(42).map((p) => p.id).join() === rs.map((p) => p.id).join(),
    "dailyPuzzle(date) and rushSequence(seed) agree across separately loaded module instances");

  const upd = Z.puzzleRatingUpdate(1200, 1200, true, 0), down = Z.puzzleRatingUpdate(1200, 1200, false, 0);
  check(upd === 1230 && down === 1170, `puzzleRatingUpdate K=60 at start (1200 vs 1200: win ${upd}, loss ${down})`);
  check(Z.puzzleRatingUpdate(1200, 1200, true, 50) === 1208 && Z.puzzleRatingUpdate(1200, 1200, true, 500) === 1208, "puzzleRatingUpdate K decays to 16 by 50 puzzles");
  check(Z.puzzleRatingUpdate(1200, 1225, true, 25) > 1200 && Z.puzzleRatingUpdate(1200, 1225, true, 25) < 1230, "puzzleRatingUpdate K mid-decay");
  check(Z.puzzleRatingUpdate(120, 120, false, 0) === 100 && Z.puzzleRatingUpdate(3490, 3490, true, 0) === 3500, "puzzleRatingUpdate clamps to 100..3500");
  check(Number.isInteger(Z.puzzleRatingUpdate(1234.5, 1500, true, 3)), "puzzleRatingUpdate returns an integer");

  // isCorrectMove: exact match, wrong move, and an alternative mate
  {
    const c = new Chess(gp.fen);
    applyUci(c, gp.moves[0]);
    applyUci(c, gp.moves[1]);
    check(Z.isCorrectMove(gp, c, gp.moves[1], 1), "isCorrectMove accepts the solution move");
    c.undo();
    const wrong = c.moves({ verbose: true }).find((m) => m.from + m.to + (m.promotion || "") !== gp.moves[1]);
    c.move(wrong);
    const isMate = c.isCheckmate();
    check(Z.isCorrectMove(gp, c, wrong.from + wrong.to + (wrong.promotion || ""), 1) === isMate, "isCorrectMove rejects a different non-mating move");
  }
  {
    // Black to move mates with ...Qg2# (the "solution") but ...Qh2# must be accepted too.
    const fake = { id: "x", fen: "8/8/8/8/8/6k1/q7/7K b - - 0 1", moves: ["xxxx", "a2g2"], rating: 600, themes: ["mateIn1"], playerColor: "b" };
    const c = new Chess(fake.fen);
    c.move({ from: "a2", to: "h2" });
    check(c.isCheckmate() && Z.isCorrectMove(fake, c, "a2h2", 1), "isCorrectMove accepts any checkmating move");
    c.undo();
    c.move({ from: "a2", to: "a3" });
    check(!Z.isCorrectMove(fake, c, "a2a3", 1), "isCorrectMove rejects a non-mating alternative");
    check(Z.isCorrectMove(fake, null, "A2G2", 1), "isCorrectMove compares UCI case-insensitively");
  }
}
{
  // Failure paths on fresh module instances: a missing shard, then the whole network.
  const origWarn = console.warn; console.warn = () => {};
  const Z3 = await import(pathToFileURL(join(root, "src/puzzles.js")).href + "?shard404");
  const victim = PZI.shards[2].file;
  fetch404 = new RegExp(victim.replace(/\./g, "\\."));
  fetchLog.length = 0;
  const r1 = await Z3.loadPuzzles();
  check(r1 === false && !Z3.puzzlesLoaded() && Z3.puzzleCount() === 0 && Z3.nextPuzzle() === null && Z3.rushSequence(1).length === 0 &&
    Z3.dailyPuzzle("2026-10-08") === null && Z3.getPuzzle(PZ.p[0][0]) === null && Z3.themesAvailable().length === 0,
    "loadPuzzles() resolves false when one shard is missing, and lookups stay empty");
  fetch404 = null;
  fetchLog.length = 0;
  const r2 = await Z3.loadPuzzles();
  check(r2 === true && Z3.puzzleCount() === PZI.count && fetchLog.length === 1 && fetchLog[0].endsWith(victim),
    "a retry fetches only the missing shard and then succeeds");
  fetchFails = true;
  const Z4 = await import(pathToFileURL(join(root, "src/puzzles.js")).href + "?offline");
  const r3 = await Z4.loadPuzzles();
  fetchFails = false;
  check(r3 === false && !Z4.puzzlesLoaded(), "loadPuzzles() resolves false (no throw) when the network is down");
  check((await Z4.loadPuzzles()) === true && Z4.puzzleCount() === PZI.count, "loadPuzzles() retries after a failed load");
  console.warn = origWarn;
}

// =========================================================================================
section("Classic games");
{
  const games = readJson("classics.json");
  info(`classics.json: ${games.length} games, ${kb("classics.json").toFixed(1)} KB`);
  check(Array.isArray(games) && games.length >= 36 && games.length <= 45, `about 40 classic games (${games.length})`);
  check(new Set(games.map((g) => g.id)).size === games.length, "classic ids unique");
  check(games.every((g, i) => i === 0 || games[i - 1].year <= g.year), "classic games are in chronological order");
  {
    const required = ["immortal-game", "opera-game", "game-of-the-century", "paulsen-morphy-1857", "zukertort-blackburne-1883",
      "steinitz-chigorin-1892-g4", "capablanca-marshall-1918", "bogoljubov-alekhine-1922", "capablanca-tartakower-1924",
      "reti-alekhine-1925", "botvinnik-capablanca-1938", "spassky-bronstein-1960", "botvinnik-tal-1960-g6", "byrne-fischer-1963",
      "tal-larsen-1965-g10", "petrosian-spassky-1966-g10", "karpov-unzicker-1974", "karpov-kasparov-1985-g24",
      "deep-blue-kasparov-1996-g1", "kramnik-kasparov-2000-g10", "carlsen-ernst-2004", "polgar-anand-1999", "shirov-polgar-1994",
      "sargissian-hou-2008", "aronian-anand-2013", "nepomniachtchi-ding-2023-tiebreak", "ding-gukesh-2024-g14"];
    const missing = required.filter((id) => !games.some((g) => g.id === id));
    check(missing.length === 0, "classics include the added games from every era" + (missing.length ? ": missing " + missing : ""));
    const decades = new Set(games.map((g) => Math.floor(g.year / 10) * 10));
    info(`decades covered: ${[...decades].sort().join(" ")}`);
    check(decades.size >= 14, "classics span at least 14 different decades");
  }
  let allGood = true;
  for (const g of games) {
    const shape = g.id && g.white && g.black && g.event && Number.isInteger(g.year) && ["1-0", "0-1", "1/2-1/2"].includes(g.result) && g.blurb && typeof g.moves === "string" && !/\d+\./.test(g.moves);
    const { chess, error } = replaySan(g.moves);
    let why = !shape ? "bad shape" : error ? "illegal move " + error : null;
    if (!why && chess.isCheckmate()) {
      const winner = chess.turn() === "w" ? "0-1" : "1-0";
      if (g.result !== winner) why = `ends in mate but result is ${g.result}`;
    }
    if (!why && chess.isGameOver() && !chess.isCheckmate() && g.result !== "1/2-1/2") why = "ends drawn but result is decisive";
    if (why) { allGood = false; ok(false, `${g.id}: ${why}`); }
    else info(`${g.id.padEnd(30)} ${g.year} ${g.result.padEnd(7)} ${String(chess.history().length).padStart(3)} plies${chess.isCheckmate() ? " (checkmate)" : ""}`);
  }
  check(allGood, "every classic game replays legally and its result is consistent");
}

// =========================================================================================
section("Learn data");
const L = await import(pathToFileURL(join(root, "src/learn-data.js")).href);
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function material(c, color) {
  let s = 0;
  for (const row of c.board()) for (const sq of row) if (sq && sq.color === color) s += VALUE[sq.type];
  return s;
}
function canMate(c, color) {
  const pcs = [];
  for (const row of c.board()) for (const sq of row) if (sq && sq.color === color && sq.type !== "k") pcs.push(sq);
  if (pcs.some((p) => "pqr".includes(p.type))) return true;
  const bishops = pcs.filter((p) => p.type === "b").map((p) => c.squareColor(p.square));
  const knights = pcs.filter((p) => p.type === "n").length;
  return (bishops.length && knights) || new Set(bishops).size === 2 || knights >= 2;
}
{
  const D = L.ENDGAME_DRILLS;
  info(`ENDGAME_DRILLS: ${D.length}`);
  check(D.length >= 12, "~14 endgame drills");
  check(new Set(D.map((d) => d.id)).size === D.length, "drill ids unique");
  let good = true;
  for (const d of D) {
    let why = null;
    if (!(d.id && d.title && d.blurb && (d.goal === "win" || d.goal === "draw") && (d.side === "w" || d.side === "b") && [1, 2, 3].includes(d.difficulty))) why = "bad shape";
    else why = fenProblem(d.fen);
    if (!why) {
      const c = new Chess(d.fen);
      const opp = d.side === "w" ? "b" : "w";
      if (c.turn() !== d.side) why = "side to move is not the drill side";
      else if (d.goal === "win" && !canMate(c, d.side)) why = "winning side lacks mating material";
      else if (d.goal === "draw" && material(c, opp) <= material(c, d.side)) why = "draw drill but the opponent is not ahead in material";
    }
    if (why) { good = false; ok(false, `drill ${d.id}: ${why}`); }
    else info(`${d.id.padEnd(26)} ${d.side} ${d.goal.padEnd(4)} d${d.difficulty}  ${d.fen}`);
  }
  check(good, "every drill FEN is legal, has the drill side to move, and its goal is plausible");
}
{
  const LS = L.LESSONS;
  const cats = new Set(["Basics", "Tactics", "Strategy", "Endgames"]);
  info(`LESSONS: ${LS.length}, steps: ${LS.reduce((s, l) => s + l.steps.length, 0)}`);
  check(LS.length >= 20, `~22 lessons (${LS.length})`);
  check(new Set(LS.map((l) => l.id)).size === LS.length, "lesson ids unique");
  check([...cats].every((c) => LS.some((l) => l.category === c)), "lessons cover Basics, Tactics, Strategy and Endgames");
  const topics = ["rook", "bishop", "queen", "king", "knight", "pawn", "check", "castl", "passant", "promot", "fork", "pin", "skewer", "back-rank", "opening",
    "discovered attack", "double check", "deflection", "decoy", "defender", "zwischenzug", "overloaded", "smothered", "lucena", "bridge",
    "opposition", "legal's mate", "fool's mate", "scholar's mate"];
  const blob = JSON.stringify(LS).toLowerCase();
  const missingTopics = topics.filter((t) => !blob.includes(t));
  check(missingTopics.length === 0, "curriculum covers every requested topic" + (missingTopics.length ? ": " + missingTopics : ""));
  let good = true, steps = 0;
  for (const l of LS) {
    if (!(l.id && l.title && cats.has(l.category) && Array.isArray(l.steps) && l.steps.length)) { good = false; ok(false, `lesson ${l.id}: bad shape`); continue; }
    l.steps.forEach((s, i) => {
      steps++;
      const where = `lesson ${l.id} step ${i + 1}`;
      let why = !s.text || !s.goal ? "missing text/goal" : fenProblem(s.fen);
      if (!why) {
        const c = new Chess(s.fen);
        const legal = c.moves({ verbose: true });
        const uci = (m) => m.from + m.to + (m.promotion || "");
        const g = s.goal;
        if (c.turn() !== "w") why = "learner (White) is not to move";
        else if (g.type === "info") { /* nothing to check */ }
        else if (g.type === "move") {
          if (!Array.isArray(g.moves) || !g.moves.length) why = "move goal without moves";
          else {
            const bad = g.moves.filter((u) => !legal.some((m) => uci(m) === u));
            if (bad.length) why = "illegal goal move(s) " + bad;
          }
        } else if (g.type === "mate") {
          const mates = legal.filter((m) => { c.move(m); const r = c.isCheckmate(); c.undo(); return r; });
          if (!mates.length) why = "mate goal but no mating move";
        } else if (g.type === "capture") {
          if (!legal.some((m) => m.to === g.square && m.captured)) why = "no legal capture on " + g.square;
        } else why = "unknown goal type " + g.type;
      }
      if (why) { good = false; ok(false, `${where}: ${why}`); }
    });
  }
  check(good, `every lesson step FEN is legal and every goal is achievable (${steps} steps)`);
  {
    const required = ["discovered-attacks", "double-check", "deflection", "decoys", "removing-the-defender", "zwischenzug",
      "overloading", "smothered-mate", "opening-traps", "opposition", "lucena"];
    const missing = required.filter((id) => !LS.some((l) => l.id === id));
    check(missing.length === 0, "new lessons present" + (missing.length ? ": missing " + missing : ""));
    // Lessons are grouped by category in order of first appearance, so keep each category contiguous.
    const order = LS.map((l) => l.category).filter((c, i, a) => i === 0 || a[i - 1] !== c);
    check(new Set(order).size === order.length, "each lesson category is one contiguous block (" + order.join(", ") + ")");
    let interactive = 0;
    for (const l of LS) for (const st of l.steps) if (st.goal.type !== "info") interactive++;
    info(`${interactive} interactive steps across ${LS.length} lessons`);
  }
}

// =========================================================================================
if (process.argv.includes("--engine")) {
  section("Engine evals of endgame drills (informational)");
  const enginePath = join(root, "node_modules/stockfish/bin/stockfish-18-lite-single.js");
  const eng = spawn(process.execPath, [enginePath]);
  let buf = "", waiters = [];
  eng.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); for (const w of waiters.slice()) w(line); }
  });
  const send = (s) => eng.stdin.write(s + "\n");
  const until = (pred) => new Promise((res) => { const w = (l) => { if (pred(l)) { waiters = waiters.filter((x) => x !== w); res(l); } }; waiters.push(w); });
  send("uci"); await until((l) => l === "uciok");
  for (const d of L.ENDGAME_DRILLS) {
    send("ucinewgame"); send("isready"); await until((l) => l === "readyok");
    let last = "";
    const w = (l) => { if (l.startsWith("info") && l.includes(" score ")) last = l; };
    waiters.push(w);
    send("position fen " + d.fen); send("go depth 18");
    const bm = await until((l) => l.startsWith("bestmove"));
    waiters = waiters.filter((x) => x !== w);
    const m = /score (cp|mate) (-?\d+)/.exec(last);
    const cp = !m ? NaN : m[1] === "mate" ? Math.sign(+m[2]) * 10000 : +m[2];
    const suspicious = d.goal === "win" ? cp < 100 : Math.abs(cp) > 150;
    (suspicious ? warn : info)(`${d.id.padEnd(26)} goal ${d.goal}: ${m ? m[1] + " " + m[2] : "?"} ${bm}${suspicious ? " (engine disagrees at depth 18; check theory)" : ""}`);
  }
  send("quit"); eng.stdin.end();
}

console.log(`\n${failures === 0 ? "ALL DATA CHECKS PASSED" : failures + " FAILURE(S)"}${warnings ? ` (${warnings} warning(s))` : ""}`);
process.exit(failures ? 1 : 0);
