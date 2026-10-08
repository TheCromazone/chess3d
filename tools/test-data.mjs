// Validates the static data layer: public/data/{openings,puzzles,classics}.json,
// src/openings.js, src/puzzles.js and src/learn-data.js.
//   node tools/test-data.mjs            # all checks
//   node tools/test-data.mjs --engine   # also print Stockfish evals of the endgame drills (slow)
import { Chess } from "chess.js";
import { readFileSync, statSync } from "node:fs";
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

// Browser fetch shim: "./data/x.json" -> public/data/x.json
let fetchFails = false;
globalThis.fetch = async (url) => {
  if (fetchFails) throw new Error("network down (test)");
  const p = join(root, "public", String(url).replace(/^\.\//, ""));
  let text;
  try { text = readFileSync(p, "utf8"); } catch { return { ok: false, status: 404, json: async () => { throw new Error("404"); } }; }
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
const PZ = readJson("puzzles.json");
info(`puzzles.json: ${PZ.p.length} puzzles, ${PZ.themes.length} themes, ${kb("puzzles.json").toFixed(1)} KB`);
check(PZ.v === 1 && Array.isArray(PZ.themes) && Array.isArray(PZ.p), "puzzles.json shape {v:1, themes, p}");
check(kb("puzzles.json") < 900, "puzzles.json under 900 KB");
check(PZ.p.length >= 4000 && PZ.p.length <= 5200, `4000-5200 puzzles (${PZ.p.length})`);
check(PZ.p.every((r, i) => i === 0 || PZ.p[i - 1][3] <= r[3]), "sorted by rating");
check(new Set(PZ.p.map((r) => r[0])).size === PZ.p.length, "puzzle ids unique");
check(PZ.p.every((r) => r.length === 5 && typeof r[0] === "string" && typeof r[1] === "string" && typeof r[2] === "string" &&
  Number.isInteger(r[3]) && Array.isArray(r[4]) && r[4].every((t) => Number.isInteger(t) && t >= 0 && t < PZ.themes.length)), "every row is [id, fen, moves, rating, [themeIdx]]");
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
{
  const buckets = new Map();
  for (const r of PZ.p) { const b = Math.floor(r[3] / 100) * 100; buckets.set(b, (buckets.get(b) || 0) + 1); }
  info("per rating bucket: " + [...buckets].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}:${n}`).join(" "));
  check(PZ.p[0][3] >= 400 && PZ.p[PZ.p.length - 1][3] < 3000, "ratings within 400..2999");
  const counts = new Map(PZ.themes.map((t) => [t, 0]));
  for (const r of PZ.p) for (const t of r[4]) counts.set(PZ.themes[t], counts.get(PZ.themes[t]) + 1);
  info("themes: " + [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(" "));
  const core = ["mateIn1", "mateIn2", "mateIn3", "fork", "pin", "skewer", "hangingPiece", "discoveredAttack", "doubleCheck",
    "sacrifice", "deflection", "attraction", "backRankMate", "smotheredMate", "endgame", "rookEndgame", "pawnEndgame",
    "promotion", "advancedPawn", "trappedPiece", "xRayAttack", "zugzwang", "quietMove", "defensiveMove", "crushing",
    "advantage", "equality", "short", "long", "opening", "middlegame"];
  const absent = core.filter((t) => !(counts.get(t) > 0));
  check(absent.length === 0, "all common themes present" + (absent.length ? ": missing " + absent : ""));
  for (const t of core) if (counts.get(t) > 0 && counts.get(t) < 30 && t !== "equality") warn(`theme ${t} has only ${counts.get(t)} puzzles`);
}

const Z = await import(pathToFileURL(join(root, "src/puzzles.js")).href);
check(Z.nextPuzzle() === null && Z.themesAvailable().length === 0 && Z.dailyPuzzle("2026-01-01") === null, "puzzle lookups empty before load");
check((await Z.loadPuzzles()) === true && (await Z.loadPuzzles()) === true, "loadPuzzles() resolves true (repeatable)");
{
  const missingInfo = PZ.themes.filter((t) => !Z.THEME_INFO[t] || !Z.THEME_INFO[t].name || !Z.THEME_INFO[t].desc);
  check(missingInfo.length === 0, "THEME_INFO has a name + desc for every theme in the data" + (missingInfo.length ? ": " + missingInfo : ""));
  const ta = Z.themesAvailable();
  check(ta.length === PZ.themes.length && ta.every((t, i) => t.id && t.name && t.count > 0 && (i === 0 || ta[i - 1].count >= t.count)),
    `themesAvailable(): ${ta.length} themes sorted by count (top: ${ta.slice(0, 3).map((t) => t.name + " " + t.count).join(", ")})`);

  const sample = PZ.p[1234];
  const gp = Z.getPuzzle(sample[0]);
  check(gp && gp.id === sample[0] && gp.fen === sample[1] && gp.moves.join(" ") === sample[2] && gp.rating === sample[3] &&
    gp.themes.length === sample[4].length && gp.playerColor === (sample[1].split(" ")[1] === "w" ? "b" : "w"), "getPuzzle() returns the normalized puzzle");
  check(Z.getPuzzle("nope!") === null, "getPuzzle(unknown) = null");
  {
    const c = new Chess(gp.fen);
    applyUci(c, gp.moves[0]);
    check(c.turn() === gp.playerColor, "playerColor is the side to move after the setup move");
  }

  let near = true;
  for (const r of [500, 1200, 1800, 2500]) {
    for (let i = 0; i < 20; i++) { const p = Z.nextPuzzle({ rating: r }); if (!p || Math.abs(p.rating - r) > 75) near = false; }
  }
  check(near, "nextPuzzle() stays within +-75 of the rating when puzzles exist there");
  const far = Z.nextPuzzle({ rating: 3400 });
  check(far && far.rating > 2700, `nextPuzzle() widens the window at the extremes (3400 -> ${far && far.rating})`);
  let themed = true;
  for (let i = 0; i < 20; i++) { const p = Z.nextPuzzle({ rating: 1500, theme: "fork" }); if (!p || !p.themes.includes("fork")) themed = false; }
  check(themed, "nextPuzzle({theme:'fork'}) only returns forks");
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

  const up = Z.puzzleRatingUpdate(1200, 1200, true, 0), down = Z.puzzleRatingUpdate(1200, 1200, false, 0);
  check(up === 1230 && down === 1170, `puzzleRatingUpdate K=60 at start (1200 vs 1200: win ${up}, loss ${down})`);
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

// =========================================================================================
section("Classic games");
{
  const games = readJson("classics.json");
  info(`classics.json: ${games.length} games, ${kb("classics.json").toFixed(1)} KB`);
  check(Array.isArray(games) && games.length >= 10, "at least 10 classic games");
  check(new Set(games.map((g) => g.id)).size === games.length, "classic ids unique");
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
  check(LS.length >= 10, "~10 lessons");
  check(new Set(LS.map((l) => l.id)).size === LS.length, "lesson ids unique");
  check([...cats].every((c) => LS.some((l) => l.category === c)), "lessons cover Basics, Tactics, Strategy and Endgames");
  const topics = ["rook", "bishop", "queen", "king", "knight", "pawn", "check", "castl", "passant", "promot", "fork", "pin", "skewer", "back-rank", "opening"];
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
