// Engine-layer tests: drives the real Stockfish 18 lite (WASM) as a Node child process.
//   node tools/test-engine.mjs            full suite (~1-2 min)
//   node tools/test-engine.mjs --quick    skip the bot matches
//   node tools/test-engine.mjs --ladder   also play an adjacent-rating calibration ladder
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Chess } from "chess.js";
import {
  Engine, winPercent, formatScore, evalBarFraction, uciLineToSan,
  seeCapture, boardArray, bestCaptureGain, materialFromFen,
} from "../src/engine.js";
import { BOTS, botMove, botThinkDelay, humanParams, getBot, botChat, engineMovetime } from "../src/bots.js";
import {
  reviewGame, classifyMove, coachText, moveAccuracy, gameAccuracy, estimateElo, CLASSIFICATIONS,
} from "../src/review.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SF = join(root, "node_modules/stockfish/bin/stockfish-18-lite-single.js");
const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let failures = 0, passes = 0;
const ok = (cond, name, extra = "") => {
  if (cond) passes++; else failures++;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
};
const section = (t) => console.log("\n=== " + t + " ===");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UCI over a child process: the same {post,onLine,onError,terminate} contract as the Worker transport. */
function nodeTransport({ file = SF, log = null } = {}) {
  const p = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
  let onLine = () => {}, onError = () => {}, buf = "", dead = false;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  p.on("exit", (code, sig) => { if (!dead) { dead = true; onError(new Error("process exited (" + (code ?? sig) + ")")); } });
  p.on("error", (e) => { if (!dead) { dead = true; onError(e); } });
  p.stdin.on("error", () => {});
  return {
    post: (l) => { if (log) log.push(l); if (!dead) p.stdin.write(l + "\n"); },
    onLine: (cb) => { onLine = cb; },
    onError: (cb) => { onError = cb; },
    terminate: () => { dead = true; p.kill(); },
    proc: p,
  };
}
const newEngine = (o = {}) => new Engine({ createTransport: () => nodeTransport(o), ...o.engine });

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.now();

// ---------------------------------------------------------------------------
section("score helpers");
// ---------------------------------------------------------------------------
ok(Math.abs(winPercent({ cp: 0 }) - 50) < 1e-9, "winPercent 0cp = 50");
ok(Math.abs(winPercent({ cp: 100 }) - 59.1) < 0.1, "winPercent +100 ≈ 59.1", winPercent({ cp: 100 }).toFixed(2));
ok(Math.abs(winPercent({ cp: 100 }, "b") - 40.9) < 0.1, "winPercent +100 for black ≈ 40.9");
ok(winPercent({ mate: 3 }) === 100 && winPercent({ mate: -2 }) === 0 && winPercent({ mate: -2 }, "b") === 100, "winPercent mate -> 100/0");
ok(winPercent({ mate: 0, winner: "b" }) === 0, "winPercent checkmated white = 0");
ok(winPercent({ cp: 5000 }) === winPercent({ cp: 1000 }), "winPercent clamps at ±1000cp");
ok(formatScore({ cp: 134 }) === "+1.34" && formatScore({ cp: -50 }) === "-0.50" && formatScore({ cp: 0 }) === "0.00", "formatScore cp");
ok(formatScore({ mate: 3 }) === "M3" && formatScore({ mate: -2 }) === "-M2", "formatScore mate");
ok(formatScore({ mate: 0, winner: "w" }) === "1-0" && formatScore({ mate: 0, winner: "b" }) === "0-1", "formatScore finished game");
ok(evalBarFraction({ cp: 0 }) === 0.5 && evalBarFraction({ mate: 2 }) === 1 && evalBarFraction({ mate: -1 }) === 0, "evalBarFraction center / mate");
ok(evalBarFraction({ cp: 300 }) > 0.7 && evalBarFraction({ cp: 300 }) < 0.8 && evalBarFraction({ cp: 99999 }) === 0.98, "evalBarFraction sigmoid, non-mate capped at 0.98");
ok(evalBarFraction({ cp: -200 }) < 0.5 && evalBarFraction({ cp: -200 }) + evalBarFraction({ cp: 200 }) - 1 < 1e-9, "evalBarFraction symmetric");

// ---------------------------------------------------------------------------
section("static exchange / material helpers");
// ---------------------------------------------------------------------------
{
  const idx = (s) => (s.charCodeAt(0) - 97) + (s.charCodeAt(1) - 49) * 8;
  const see = (fen, from, to) => seeCapture(boardArray(new Chess(fen)), idx(from), idx(to));
  ok(see("4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1", "d1", "d5") === -800, "SEE Qxd5 defended pawn = -800");
  ok(see("4k3/8/8/3b4/8/4N3/8/4K3 w - - 0 1", "e3", "d5") === 310, "SEE NxB undefended = +310");
  ok(see("4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1", "e4", "d5") === 200, "SEE PxN defended by pawn = +200");
  ok(see("3rk3/8/8/3p4/8/8/3R4/3RK3 w - - 0 1", "d2", "d5") === 100, "SEE battery RxP, R recaptures, R recaptures = +100");
  const c = new Chess("4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1");
  ok(bestCaptureGain(c).gain === 900, "bestCaptureGain finds hanging queen");
  const m = materialFromFen("4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1");
  ok(m.w === 300 && m.b === 900, "materialFromFen");
  ok(uciLineToSan("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", ["e2e4", "e7e5", "zzzz", "g1f3"]).join(" ") === "e4 e5", "uciLineToSan stops at the first bad move");
}

// ---------------------------------------------------------------------------
section("engine: basics");
// ---------------------------------------------------------------------------
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MIDGAME = "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 8";
const sentLog = [];
const E = newEngine({ log: sentLog });
{
  let t = Date.now();
  await E.init();
  ok(E.ready && /Stockfish/.test(E.name), "init: uciok + readyok", `${Date.now() - t}ms, ${E.name}`);
  ok(E.optionInfo.UCI_Elo && E.optionInfo.UCI_Elo.min === 1320 && E.optionInfo.UCI_Elo.max === 3190, "UCI_Elo range parsed", JSON.stringify(E.optionInfo.UCI_Elo));
  ok(sentLog.includes("setoption name Hash value 16"), "hash set to 16 MB");
  await E.init();
  ok(sentLog.filter((l) => l === "uci").length === 1, "init is idempotent");

  t = Date.now();
  let infos = 0;
  const r = await E.analyze(START, { depth: 14, multipv: 3 }, () => infos++);
  ok(r.lines.length === 3 && r.depth >= 14 && !r.aborted, "multipv 3 at depth 14", `${Date.now() - t}ms, ${infos} onInfo calls`);
  ok(r.lines.every((l, i) => l.multipv === i + 1 && l.san.length >= 1 && l.pv.length >= l.san.length), "lines have multipv index, pv and san");
  ok(new Chess(START).moves().includes(r.lines[0].san[0]) && r.bestmove === r.lines[0].pv[0], "bestmove is the first PV move and legal");
  ok(r.lines[0].scoreWhite.cp > -50 && r.lines[0].scoreWhite.cp < 100, "startpos eval sane", formatScore(r.lines[0].scoreWhite));

  const rb = await E.analyze("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", { depth: 12 });
  ok(rb.lines[0].scoreWhite.cp === -rb.lines[0].cp, "black to move: scoreWhite = -cp", `cp=${rb.lines[0].cp} white=${rb.lines[0].scoreWhite.cp}`);

  const rm = await E.analyze("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", { depth: 10 });
  ok(rm.lines[0].mate === 1 && rm.lines[0].san[0] === "Ra8#" && formatScore(rm.lines[0].scoreWhite) === "M1", "finds mate in 1 (white)");
  const rmb = await E.analyze("r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1", { depth: 10 });
  ok(rmb.lines[0].mate === 1 && rmb.lines[0].scoreWhite.mate === -1 && formatScore(rmb.lines[0].scoreWhite) === "-M1", "mate in 1 for black -> scoreWhite mate -1");

  const rc = await E.analyze("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", { depth: 5 });
  ok(rc.terminal === "checkmate" && rc.bestmove === null && rc.lines[0].scoreWhite.winner === "b" && formatScore(rc.lines[0].scoreWhite) === "0-1", "checkmated position short-circuits");
  const rs = await E.analyze("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", { depth: 5 });
  ok(rs.terminal === "stalemate" && rs.lines[0].scoreWhite.cp === 0, "stalemate short-circuits to 0.00");

  let rej = await E.analyze("not a fen", { depth: 3 }).then(() => null, (e) => e);
  ok(rej && /Invalid FEN/.test(rej.message), "garbage FEN rejected", rej && rej.message);
  rej = await E.analyze("8/8/8/8/8/8/8/K7 w - - 0 1", { depth: 3 }).then(() => null, (e) => e);
  ok(rej && /Invalid FEN/.test(rej.message), "FEN without black king rejected before reaching Stockfish", rej && rej.message);
  rej = await E.analyze("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", { depth: 3 }).then(() => null, (e) => e);
  ok(rej && /in check/.test(rej.message), "side-not-to-move-in-check rejected", rej && rej.message);

  const rsm = await E.analyze(START, { depth: 8, searchMoves: ["a2a3", "h3"] });
  ok(["a2a3", "h2h3"].includes(rsm.bestmove), "searchMoves restricts the root (UCI + SAN)", rsm.bestmove);

  const re = await E.analyze(MIDGAME, { movetime: 100, elo: 1500 });
  ok(sentLog.includes("setoption name UCI_LimitStrength value true") && sentLog.includes("setoption name UCI_Elo value 1500") && re.bestmove, "elo option enables UCI_LimitStrength + UCI_Elo");
  await E.analyze(MIDGAME, { depth: 6 });
  ok(sentLog.lastIndexOf("setoption name UCI_LimitStrength value false") > sentLog.lastIndexOf("setoption name UCI_LimitStrength value true"), "analyze without elo restores full strength");
  const rClamp = await E.analyze(MIDGAME, { movetime: 50, elo: 250 });
  ok(sentLog.includes("setoption name UCI_Elo value 1320") && rClamp.bestmove, "elo clamped to engine minimum 1320");

  const hist = ["e4", "e5", "Nf3", "Nc6"];
  const hc = new Chess(); for (const m of hist) hc.move(m);
  await E.analyze(hc.fen(), { depth: 4, history: { moves: hist } });
  ok(sentLog.includes("position startpos moves e2e4 e7e5 g1f3 b8c6"), "history is sent as position startpos moves ...");
  await E.analyze(hc.fen(), { depth: 4, history: { moves: ["d4"] } });
  ok(sentLog[sentLog.length - 2].startsWith("position fen "), "mismatching history falls back to plain fen");
}

// ---------------------------------------------------------------------------
section("engine: preemption, stop, throttling");
// ---------------------------------------------------------------------------
{
  let infos1 = 0;
  const p1 = E.analyze(MIDGAME, {}, () => infos1++); // infinite
  await sleep(400);
  const POS2 = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
  const p2 = E.analyze(POS2, { depth: 10 });
  const [a1, a2] = await Promise.all([p1, p2]);
  ok(a1.aborted && a1.lines.length > 0 && a1.depth > 5, "running search is stopped and resolves {aborted:true} with its lines", `depth ${a1.depth}, ${infos1} infos`);
  ok(!a2.aborted && a2.bestmove === "h5f7" && a2.lines[0].san[0] === "Qxf7#", "next search answers the NEW position (stale bestmove ignored)", a2.bestmove);

  // rapid fire: only the last of five survives
  const fens = [START, MIDGAME, POS2, "8/8/4k3/8/2K5/8/3Q4/8 w - - 0 1", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"];
  const ps = fens.map((f) => E.analyze(f, { depth: 12 }));
  const rs = await Promise.all(ps);
  ok(rs.slice(0, 4).every((r) => r.aborted) && !rs[4].aborted && rs[4].fen === fens[4], "rapid-fire analyze: earlier calls aborted/cancelled, last one completes");
  const legalLast = new Chess(fens[4]).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
  ok(legalLast.includes(rs[4].bestmove), "rapid-fire result belongs to the last position", rs[4].bestmove);

  // throttling + stop()
  let n = 0, t0 = Date.now();
  const p3 = E.analyze(MIDGAME, { multipv: 3 }, () => n++);
  await sleep(1500);
  const tStop = Date.now();
  await E.stop();
  const stopMs = Date.now() - tStop;
  const r3 = await p3;
  const rate = n / ((Date.now() - t0) / 1000);
  ok(rate <= 11.5, "onInfo throttled to ~10/s", `${n} calls in ${Date.now() - t0}ms (${rate.toFixed(1)}/s)`);
  ok(r3.aborted && r3.lines.length === 3 && stopMs < 500, "stop() resolves quickly with a usable aborted result", `${stopMs}ms`);
  await E.stop();
  ok(true, "stop() while idle is a no-op");

  // setOption interrupts and is cached
  const p4 = E.analyze(MIDGAME, {});
  await sleep(100);
  await E.setOption("Hash", 32);
  const r4 = await p4;
  ok(r4.aborted && sentLog.includes("setoption name Hash value 32"), "setOption interrupts a running search");
  const before = sentLog.length;
  await E.setOption("Hash", 32);
  ok(sentLog.length === before, "setOption caches unchanged values");
  await E.setOption("Hash", 16);
  await E.newGame();
  ok(sentLog.includes("ucinewgame"), "newGame sends ucinewgame");
}

// ---------------------------------------------------------------------------
section("engine: two instances, crashes, load failures, terminate");
// ---------------------------------------------------------------------------
{
  const E2 = newEngine();
  const t = Date.now();
  const [x, y] = await Promise.all([E.analyze(MIDGAME, { depth: 14 }), E2.analyze(START, { depth: 14 })]);
  ok(!x.aborted && !y.aborted && x.fen === MIDGAME && y.fen === START && x.depth >= 14 && y.depth >= 14, "two engines search concurrently and independently", `${Date.now() - t}ms`);

  // crash mid-search -> prompt rejection, then lazy restart
  let crashT;
  const tr = [];
  const E3 = new Engine({ createTransport: () => { const x = nodeTransport(); tr.push(x); return x; } });
  let crashed = null;
  E3.onCrash = (e) => { crashed = e; };
  await E3.init();
  const pc = E3.analyze(MIDGAME, {});
  await sleep(200);
  crashT = Date.now();
  tr[0].proc.kill("SIGKILL");
  const err = await pc.then(() => null, (e) => e);
  ok(err && err.code === "ENGINE_UNAVAILABLE" && Date.now() - crashT < 1000 && crashed, "engine crash rejects the pending search promptly", err && `${err.message} (${Date.now() - crashT}ms)`);
  const again = await E3.analyze(START, { depth: 8 }).then((r) => r, (e) => e);
  ok(again && again.bestmove && tr.length === 2, "after a crash the next call restarts a fresh Stockfish");
  E3.terminate();

  // failed load: script that does not exist
  const tl = Date.now();
  const E4 = new Engine({ createTransport: () => nodeTransport({ file: join(root, "node_modules/stockfish/bin/does-not-exist.js") }) });
  const e4 = await E4.analyze(START, { depth: 5 }).then(() => null, (e) => e);
  ok(e4 && e4.code === "ENGINE_UNAVAILABLE" && Date.now() - tl < 3000, "missing engine file rejects promptly with ENGINE_UNAVAILABLE", e4 && `${e4.message} (${Date.now() - tl}ms)`);
  const e4b = await E4.analyze(START, { depth: 5 }).then(() => null, (e) => e);
  ok(e4b === e4 || (e4b && e4b.code === "ENGINE_UNAVAILABLE"), "failed engine stays unavailable (no retry storm)");

  // silent process: init times out
  const silent = () => {
    const p = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
    return { post: () => {}, onLine: () => {}, onError: () => {}, terminate: () => p.kill() };
  };
  const ts = Date.now();
  const E5 = new Engine({ createTransport: silent, initTimeoutMs: 800 });
  const e5 = await E5.init().then(() => null, (e) => e);
  ok(e5 && e5.code === "ENGINE_UNAVAILABLE" && Date.now() - ts < 2000, "unresponsive engine: init times out", e5 && e5.message);

  // throwing transport factory (e.g. no Worker support)
  const E6 = new Engine({ createTransport: () => { throw new Error("Workers blocked"); } });
  const e6 = await E6.analyze(START, { depth: 3 }).then(() => null, (e) => e);
  ok(e6 && e6.code === "ENGINE_UNAVAILABLE" && /Workers blocked/.test(e6.message), "transport factory error -> ENGINE_UNAVAILABLE", e6 && e6.message);

  // terminate with a pending search
  const p7 = E2.analyze(MIDGAME, {});
  await sleep(100);
  E2.terminate();
  const e7 = await p7.then(() => null, (e) => e);
  ok(e7 && e7.code === "ENGINE_TERMINATED", "terminate() rejects the pending search");
  const e7b = await E2.analyze(START, { depth: 3 }).then(() => null, (e) => e);
  ok(e7b && e7b.code === "ENGINE_TERMINATED", "calls after terminate() reject");
}

// ---------------------------------------------------------------------------
section("review: classifier (synthetic)");
// ---------------------------------------------------------------------------
{
  const C = (f) => classifyMove({ epBest: 0.6, epPlayed: 0.6, ...f });
  ok(C({ legalCount: 1, epPlayed: 0.1 }) === "forced", "only legal move -> forced");
  ok(C({ book: true, epPlayed: 0.3 }) === "book", "book move");
  ok(C({ playedIsBest: true, epPlayed: 0.58 }) === "best", "engine's move -> best");
  ok(C({ epPlayed: 0.597 }) === "best", "loss rounding to 0.00 -> best");
  ok(C({ epPlayed: 0.585 }) === "excellent", "loss 0.015 -> excellent");
  ok(C({ epPlayed: 0.57 }) === "good", "loss 0.03 -> good");
  ok(C({ epPlayed: 0.53 }) === "inaccuracy", "loss 0.07 -> inaccuracy");
  ok(C({ epPlayed: 0.45 }) === "mistake", "loss 0.15 -> mistake");
  ok(C({ epPlayed: 0.3 }) === "blunder", "loss 0.30 -> blunder");
  ok(C({ epBest: 1, epPlayed: 0.0 }) === "blunder", "mate for -> mate against = blunder");
  ok(C({ epBest: 0.03, epPlayed: 0.02, allowsMate: 2 }) === "blunder", "allowing mate in 2 is a blunder even in a lost position");
  ok(C({ epBest: 0.03, epPlayed: 0.02, allowsMate: 9 }) === "excellent", "allowing a distant mate in a lost position is not");
  ok(C({ playedIsBest: true, epSecond: 0.45 }) === "great", "only good move (2nd best -0.15) -> great");
  ok(C({ playedIsBest: true, epBest: 0.93, epPlayed: 0.93, epSecond: 0.7 }) === "best", "only move but already winning (EP>=0.9) -> best");
  ok(C({ playedIsBest: true, epSecond: 0.45, recapture: true }) === "best", "recaptures are never great");
  ok(C({ playedIsBest: true, epSecond: 0.45, captureGain: 300 }) === "best", "winning a free piece is best, not great");
  ok(C({ playedIsBest: true, epPrev: 0.2, epSecond: 0.3 }) === "great", "turns a lost game around -> great");
  ok(C({ playedIsBest: true, sacrifice: true }) === "brilliant", "sound sacrifice -> brilliant");
  ok(C({ sacrifice: true, epPlayed: 0.59 }) === "brilliant", "near-best sacrifice (loss 0.01) -> brilliant");
  ok(C({ sacrifice: true, epPlayed: 0.5 }) === "inaccuracy", "unsound sacrifice is not brilliant");
  ok(C({ playedIsBest: true, sacrifice: true, epBest: 0.45, epPlayed: 0.45 }) === "best", "sacrifice leaving EP < 0.5 -> not brilliant");
  ok(C({ playedIsBest: true, sacrifice: true, captureGain: 200 }) === "best", "a capture that simply wins material is never brilliant");
  ok(C({ playedIsBest: true, sacrifice: true, epBest: 0.97, epPlayed: 0.97 }) === "best", "sacrifice in a trivially won position -> not brilliant");
  ok(C({ playedIsBest: true, sacrifice: true, epBest: 1, epPlayed: 1, bestIsMate: true, secondIsMate: false }) === "brilliant", "...unless it is the only way to force mate");
  ok(C({ epPrev: 0.5, epBest: 0.85, epPlayed: 0.55 }) === "miss", "opponent blundered, you let it go -> miss");
  ok(C({ epPrev: 0.5, epBest: 0.85, epPlayed: 0.3 }) === "blunder", "...but making it worse than before is a blunder");
  ok(C({ epPrev: 0.55, epBest: 0.6, epPlayed: 0.4 }) === "mistake", "no opportunity -> regular mistake");
  ok(moveAccuracy(60, 60) === 100 && moveAccuracy(60, 70) === 100, "accuracy 100 when win% does not drop");
  ok(Math.abs(moveAccuracy(60, 50) - (103.1668 * Math.exp(-0.4354) - 3.1669)) < 1e-9, "accuracy formula", moveAccuracy(60, 50).toFixed(2));
  ok(moveAccuracy(100, 0) === 0, "accuracy clamps at 0");
  const ga = gameAccuracy([50, 50, 50, 50, 50, 50]);
  ok(ga.w === 100 && ga.b === 100, "game accuracy of a flawless game = 100");
  const gb = gameAccuracy([50, 20, 90, 90, 90, 90]); // white drops 30 points, black drops 70
  ok(gb.w < 85 && gb.b < 75 && gb.b < gb.w, "game accuracy punishes big drops", `w=${gb.w.toFixed(1)} b=${gb.b.toFixed(1)}`);
  const el = estimateElo({ w: 92, b: 60 }, { result: "1-0", moves: { w: 30, b: 30 } });
  ok(el.w > el.b + 500 && el.w >= 1800 && el.b <= 1300, "estimated Elo ordering", JSON.stringify(el));

  const R = (ply) => ({ plies: [ply] });
  const base = { ply: 0, san: "Nf3", bestSan: "Bxe5", winAfter: 50, tags: {} };
  ok(coachText(0, R({ ...base, classification: "book" })) === "Nf3 is a book move.", "coach: book");
  ok(coachText(0, R({ ...base, san: "Bxe5", classification: "best" })) === "Bxe5 is the best move.", "coach: best");
  ok(coachText(0, R({ ...base, classification: "mistake", tags: { missedWin: "a knight" } })) === "Nf3 is a mistake. Bxe5 was best, winning a knight.", "coach: mistake missing material");
  ok(coachText(0, R({ ...base, classification: "blunder", tags: { allowsMate: 2 } })) === "Nf3 is a blunder. It allows mate in 2. Bxe5 was best.", "coach: allows mate");
  ok(coachText(0, R({ ...base, classification: "blunder", tags: { loses: "the queen", hangs: true } })) === "Nf3 is a blunder. It hangs the queen. Bxe5 was best.", "coach: hangs material");
  ok(coachText(0, R({ ...base, san: "Qc2", bestSan: "Nd5", classification: "miss", tags: { missedWin: "the queen" } })) === "You missed a chance to win the queen with Nd5.", "coach: miss");
  ok(coachText(0, R({ ...base, classification: "miss", tags: { missedMate: 2 } })) === "You missed mate in 2 with Bxe5.", "coach: missed mate");
  ok(coachText(0, R({ ...base, san: "Qb8+", classification: "brilliant", tags: { sacrifice: "the queen", forcesMate: 2 } })) === "Qb8+ is brilliant! It sacrifices the queen to force mate in 2.", "coach: brilliant sacrifice");
  ok(coachText(0, R({ ...base, classification: "great", winAfter: 80, tags: { onlyMove: true } })) === "Nf3 is a great move. It's the only move that keeps the advantage.", "coach: great only move");
}

// ---------------------------------------------------------------------------
section("review: real games");
// ---------------------------------------------------------------------------
function printReview(name, r, ms) {
  console.log(`\n-- ${name}: ${r.plies.length} plies, ${ms} ms (${(ms / Math.max(1, r.plies.length + 1)).toFixed(0)} ms/position, ${r.settings.rechecked} deep re-checks)`);
  console.log(`   accuracy W ${r.accuracy.w?.toFixed(1)}  B ${r.accuracy.b?.toFixed(1)}   est. rating W ${r.estimatedElo.w}  B ${r.estimatedElo.b}   result ${r.result}   key moments ${r.keyMoments.join(",")}`);
  console.log("   ply  move      class        eval   acc  coach");
  for (const p of r.plies) {
    const mv = (p.color === "w" ? `${p.moveNumber}. ` : `${p.moveNumber}... `) + p.san;
    console.log(`   ${String(p.ply).padStart(3)}  ${mv.padEnd(13)} ${p.classification.padEnd(11)} ${formatScore(p.evalAfter).padStart(6)} ${p.accuracy.toFixed(0).padStart(4)}  ${coachText(p.ply, r)}`);
  }
}
const RE = newEngine();
const reviewTimes = [];
{
  // 1) Scholar's mate
  let t = Date.now(), prog = 0;
  const r1 = await reviewGame(RE, { moves: "e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#".split(" ") }, { onProgress: () => prog++ });
  let ms = Date.now() - t; reviewTimes.push(["scholar", r1.plies.length, ms]);
  printReview("Scholar's mate", r1, ms);
  ok(prog === 8, "onProgress called once per position", String(prog));
  ok(r1.plies[5].classification === "blunder" && r1.plies[5].tags.allowsMate === 1, "...Nf6?? is a blunder that allows mate in 1");
  ok(/allows mate in 1/.test(coachText(5, r1)), "coach mentions the mate", coachText(5, r1));
  ok(r1.plies[6].tags.checkmate && r1.result === "1-0", "Qxf7# recognized as checkmate, result 1-0");
  ok(r1.evalGraph.length === 8 && r1.evalGraph[7] === 100, "eval graph has initial + every ply, ends at 100");
  ok(r1.accuracy.w > r1.accuracy.b + 30, "white far more accurate");
  ok(CLASSIFICATIONS.every((k) => k in r1.counts.w && k in r1.counts.b), "counts include every classification for both sides");

  // 2) Légal's mate (UCI input)
  const legalSan = "e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#".split(" ");
  const c = new Chess(); const legalUci = legalSan.map((s) => { const m = c.move(s); return m.from + m.to; });
  const bookSet = new Set(); { const b = new Chess(); for (const s of legalSan.slice(0, 4)) { b.move(s); bookSet.add(b.fen()); } }
  t = Date.now();
  const r2 = await reviewGame(RE, { moves: legalUci }, { isBook: (f) => bookSet.has(f) });
  ms = Date.now() - t; reviewTimes.push(["legal", r2.plies.length, ms]);
  printReview("Légal's mate (UCI input, first 4 plies 'book')", r2, ms);
  ok(r2.plies.slice(0, 4).every((p) => p.classification === "book"), "isBook positions classified as book");
  ok(r2.plies[8].classification === "brilliant", "5.Nxe5!! (queen 'sacrifice') is brilliant", r2.plies[8].classification);
  ok(r2.plies[9].classification === "blunder" && r2.plies[9].tags.allowsMate === 2, "5...Bxd1?? allows mate in 2");
  ok(r2.plies[11].classification === "forced", "6...Ke7 is forced");

  // 3) The Opera Game (Morphy, Paris 1858), 33 plies
  const opera = "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");
  t = Date.now();
  const r3 = await reviewGame(RE, { moves: opera }, { ratings: { b: 1500 } });
  ms = Date.now() - t; reviewTimes.push(["opera", r3.plies.length, ms]);
  printReview("Opera Game (Morphy 1858)", r3, ms);
  ok(r3.plies[30].classification === "brilliant" && /sacrifices the queen/.test(coachText(30, r3)), "16.Qb8+!! brilliant queen sacrifice", coachText(30, r3));
  ok(r3.plies[29].classification === "blunder", "15...Nxd7?? blunder (search-instability re-check)", r3.plies[29].classification);
  ok(r3.accuracy.w > r3.accuracy.b, "Morphy more accurate", `${r3.accuracy.w.toFixed(1)} vs ${r3.accuracy.b.toFixed(1)}`);
  ok(r3.keyMoments.length >= 3 && r3.keyMoments.length <= 6, "3-6 key moments", r3.keyMoments.join(","));
  ok(r3.counts.w.brilliant + r3.counts.b.brilliant <= 3, "brilliants stay rare");

  // 4) A blunder-filled club game with a missed tactic (exercises miss / hangs / mistakes)
  const club = "e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5 Nxf7 Qxg2 Rf1 Qxe4+ Be2 Nf3#".split(" ");
  t = Date.now();
  const r4 = await reviewGame(RE, { moves: club });
  ms = Date.now() - t; reviewTimes.push(["club trap", r4.plies.length, ms]);
  printReview("Blackburne Shilling trap", r4, ms);
  ok(r4.result === "0-1" && r4.plies[r4.plies.length - 1].tags.checkmate, "black mates");
  ok(["mistake", "blunder", "miss"].includes(r4.plies[6].classification), "4.Nxe5? punished", r4.plies[6].classification);

  // 5) The Immortal Game (Anderssen-Kieseritzky, London 1851), 45 plies
  const immortal = "e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#".split(" ");
  t = Date.now();
  const r5 = await reviewGame(RE, { moves: immortal });
  ms = Date.now() - t; reviewTimes.push(["immortal", r5.plies.length, ms]);
  printReview("Immortal Game (Anderssen 1851)", r5, ms);
  ok(r5.result === "1-0" && r5.plies.length === 45, "Immortal Game reviewed to mate");
  ok(r5.plies[43].classification !== "blunder" || r5.plies[42].classification !== "brilliant", "sanity: classifications present");

  // 6) Timing: an 80-ply (40-move) game at the default settings
  {
    const g = new Chess(); const hist = [];
    const ew = newEngine(), eb = newEngine();
    const rnd = mulberry32(42);
    while (!g.isGameOver() && hist.length < 80) {
      const bot = g.turn() === "w" ? getBot("ines") : getBot("viktor");
      const m = await botMove(g.turn() === "w" ? ew : eb, g.fen(), bot, { history: hist, movetime: 30, random: rnd });
      hist.push(g.move({ from: m.from, to: m.to, promotion: m.promotion }).san);
    }
    ew.terminate(); eb.terminate();
    t = Date.now();
    const r6 = await reviewGame(RE, { moves: hist });
    ms = Date.now() - t; reviewTimes.push([`${hist.length}-ply bot game`, r6.plies.length, ms]);
    console.log(`\n-- ${hist.length}-ply bot game (Inês vs Viktor) reviewed at defaults (movetime 350, depth 14): ${ms} ms, ${r6.settings.rechecked} re-checks, accuracy W ${r6.accuracy.w.toFixed(1)} B ${r6.accuracy.b.toFixed(1)}, est. ${r6.estimatedElo.w}/${r6.estimatedElo.b}`);
    console.log("   counts W " + JSON.stringify(r6.counts.w) + "\n   counts B " + JSON.stringify(r6.counts.b));
    ok(ms < 60000, "40-move review finishes in under a minute (Node)", `${(ms / 1000).toFixed(1)}s`);
  }

  // 7) abort via AbortSignal
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const ab = await reviewGame(RE, { moves: opera }, { signal: ac.signal }).then(() => null, (e) => e);
  ok(ab && ab.code === "ABORTED", "AbortSignal cancels a review");
  const bad = await reviewGame(RE, { moves: ["e4", "e4"] }).then(() => null, (e) => e);
  ok(bad && bad.code === "BAD_GAME", "illegal move in game rejected");
}
RE.terminate();

// ---------------------------------------------------------------------------
section("bots: roster & helpers");
// ---------------------------------------------------------------------------
{
  ok(BOTS.length >= 16, "16 bots", String(BOTS.length));
  ok(new Set(BOTS.map((b) => b.id)).size === BOTS.length, "unique ids");
  ok(BOTS[0].elo === 250 && BOTS[BOTS.length - 1].elo === 3200 && BOTS.every((b, i) => i === 0 || b.elo > BOTS[i - 1].elo), "ratings ascend 250 -> 3200");
  const cats = new Set(["Beginner", "Intermediate", "Advanced", "Master", "Engine"]);
  ok(BOTS.every((b) => cats.has(b.category) && b.name && b.style && b.bio && b.avatar && b.avatar.emoji && /^#[0-9a-f]{6}$/i.test(b.avatar.bg)), "every bot has category, name, style, bio, avatar");
  const keys = ["greet", "win", "lose", "draw", "blunder", "goodMove"];
  ok(BOTS.every((b) => keys.every((k) => Array.isArray(b.chat[k]) && b.chat[k].length)), "every bot has all chat keys");
  let badLine = null;
  for (const b of BOTS) for (const line of b.openings || []) {
    const c = new Chess();
    for (const s of line.split(" ")) { try { c.move(s); } catch { badLine = `${b.id}: ${line} @ ${s}`; break; } }
  }
  ok(!badLine, "all opening lines are legal SAN", badLine || "");
  ok(getBot("apex").elo === 3200 && botChat(getBot("pebble"), "greet").length > 0, "getBot / botChat");
  const hp = [250, 550, 850, 1150, 1350].map(humanParams);
  ok(hp.every((p, i) => i === 0 || (p.temperature < hp[i - 1].temperature && p.pRandom <= hp[i - 1].pRandom && p.pHang < hp[i - 1].pHang && p.depth >= hp[i - 1].depth)), "human params get stronger with rating");
  let lo = Infinity, hi = 0;
  const pos = [START, MIDGAME, "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", "8/8/4k3/8/2K5/8/3Q4/8 w - - 0 1", "4k3/8/8/8/8/8/4q3/4K3 w - - 0 1"];
  for (const b of BOTS) for (const f of pos) for (const mn of [1, 5, 20, 45]) {
    const d = botThinkDelay(b, f, mn); lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  ok(lo >= 300 && hi <= 2500, "botThinkDelay within 300..2500", `${lo}..${hi}`);
  const avg = (b, f, mn) => { let s = 0; for (let i = 0; i < 50; i++) s += botThinkDelay(b, f, mn); return s / 50; };
  ok(avg(getBot("viktor"), MIDGAME, 20) > avg(getBot("viktor"), START, 1), "slower in a complex middlegame than in the opening");
  ok(avg(getBot("apex"), MIDGAME, 20) < avg(getBot("viktor"), MIDGAME, 20), "engine bots answer faster");
}

// ---------------------------------------------------------------------------
section("bots: move selection");
// ---------------------------------------------------------------------------
const BE = newEngine();
{
  let allLegal = true, t = Date.now();
  for (const b of BOTS) {
    for (const f of [START, MIDGAME]) {
      const m = await botMove(BE, f, b, { movetime: 60 });
      const legal = new Chess(f).moves({ verbose: true }).some((x) => x.from === m.from && x.to === m.to);
      if (!legal || !m.san || m.thinkMs < 0 || m.delayMs < 0) { allLegal = false; console.log("   bad", b.id, f, m); }
    }
  }
  ok(allLegal, "every bot returns a legal move (start + middlegame)", `${Date.now() - t}ms for ${BOTS.length * 2} moves`);
  const brine = getBot("brine");
  const bm = await botMove(BE, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", brine, { history: ["e4"] });
  ok(bm.reason === "book" && ["e5"].includes(bm.san), "opening book followed while the game matches a line", `${bm.san} (${bm.reason})`);
  const bm2 = await botMove(BE, "rnbqkbnr/pppppppp/8/8/8/7P/PPPPPPP1/RNBQKBNR b KQkq - 0 1", brine, { history: ["h3"], movetime: 50 });
  ok(bm2.reason !== "book", "book abandoned once the game leaves it");
  const nb = await botMove(BE, MIDGAME, getBot("kestrel"), { movetime: 40 });
  ok(nb.reason !== "book", "no book move when the history doesn't lead to the position", `${nb.san} (${nb.reason})`);
  const nb2 = await botMove(BE, MIDGAME, getBot("kestrel"), { history: ["e4", "e5"], movetime: 40 });
  ok(nb2.reason !== "book", "inconsistent history is ignored", `${nb2.san} (${nb2.reason})`);
  const wb = await botMove(BE, START, getBot("viktor"));
  ok(wb.reason === "book", "book used from the initial position with empty history", wb.san);
  const forced = await botMove(BE, "7k/8/8/8/8/8/6q1/7K w - - 0 1", getBot("apex"));
  ok(forced.reason === "forced" && forced.san === "Kxg2", "single legal move returned without searching");

  const MATE1 = "6k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1";
  let mates850 = 0, mates250 = 0;
  for (let i = 0; i < 12; i++) {
    if ((await botMove(BE, MATE1, getBot("quill"), { random: mulberry32(i + 1) })).san === "Rb8#") mates850++;
    if ((await botMove(BE, MATE1, getBot("pebble"), { random: mulberry32(i + 100) })).san === "Rb8#") mates250++;
  }
  ok(mates850 === 12, "850 bot always takes a mate in one", `${mates850}/12`);
  ok(mates250 < 12, "250 bot sometimes misses it", `${mates250}/12`);

  // Blunder propensity: over 40 positions from real play, how often does each bot drop >= a minor piece?
  const midFens = [MIDGAME, "r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w - - 0 9", "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7", "r1b2rk1/pp1nqppp/2pbpn2/3p4/2PP4/2NBPN2/PPQ2PPP/R1B2RK1 w - - 0 9", "2rq1rk1/pp1bbppp/2n1pn2/3p4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 10"];
  const drops = async (bot, seed) => {
    let n = 0, total = 0;
    const rnd = mulberry32(seed);
    for (const f of [...midFens, ...midFens, ...midFens, ...midFens]) {
      const m = await botMove(BE, f, bot, { random: rnd, movetime: 40 });
      const c = new Chess(f);
      const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion });
      const gained = mv.captured ? { p: 100, n: 300, b: 310, r: 500, q: 900 }[mv.captured] : 0;
      const back = c.isGameOver() ? 0 : bestCaptureGain(c).gain;
      if (gained - back <= -200) n++;
      total++;
    }
    return [n, total];
  };
  const d250 = await drops(getBot("pebble"), 11), d850 = await drops(getBot("quill"), 12), d1300 = await drops(getBot("yuki"), 13), d2000 = await drops(getBot("kestrel"), 14);
  console.log(`   material-dropping moves: 250 ${d250[0]}/${d250[1]}, 850 ${d850[0]}/${d850[1]}, 1300 ${d1300[0]}/${d1300[1]}, 2000 ${d2000[0]}/${d2000[1]}`);
  ok(d250[0] > d1300[0] && d850[0] >= d1300[0] && d1300[0] <= 3, "weaker bots hang material more often");
}

// ---------------------------------------------------------------------------
// Bot matches
// ---------------------------------------------------------------------------
const PV = { p: 100, n: 300, b: 310, r: 500, q: 900 };
function materialEdge(c) { const m = materialFromFen(c.fen()); return m.w - m.b; }

// movetimeScale: engine bots think engineMovetime(elo) * scale ms (same ratios as real play, just faster)
async function playGame(white, black, engW, engB, { seed = 1, movetimeScale = 0.3, maxPlies = 260 } = {}) {
  const c = new Chess();
  const history = [];
  const rnd = mulberry32(seed);
  const reasons = { w: {}, b: {} };
  await engW.newGame(); await engB.newGame();
  while (!c.isGameOver() && history.length < maxPlies) {
    const side = c.turn();
    const bot = side === "w" ? white : black;
    const movetime = Math.max(20, Math.round(engineMovetime(bot.elo) * movetimeScale));
    const m = await botMove(side === "w" ? engW : engB, c.fen(), bot, { history, movetime, random: rnd });
    const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion });
    history.push(mv.san);
    reasons[side][m.reason] = (reasons[side][m.reason] || 0) + 1;
  }
  let result;
  if (c.isCheckmate()) result = c.turn() === "w" ? "0-1" : "1-0";
  else if (c.isGameOver()) result = "1/2-1/2";
  else { const e = materialEdge(c); result = e >= 300 ? "1-0" : e <= -300 ? "0-1" : "1/2-1/2"; }
  return { result, plies: history.length, how: c.isCheckmate() ? "mate" : c.isGameOver() ? "draw" : "adjudicated", reasons, material: materialEdge(c) };
}

async function match(a, b, games, opts = {}) {
  const ea = newEngine(), eb = newEngine();
  let scoreA = 0;
  const t = Date.now();
  const lines = [];
  const reasonsA = {};
  for (let g = 0; g < games; g++) {
    const aWhite = g % 2 === 0;
    const r = await playGame(aWhite ? a : b, aWhite ? b : a, aWhite ? ea : eb, aWhite ? eb : ea, { seed: 1000 + g, ...opts });
    const s = r.result === "1/2-1/2" ? 0.5 : (r.result === "1-0") === aWhite ? 1 : 0;
    scoreA += s;
    for (const [k, v] of Object.entries(r.reasons[aWhite ? "w" : "b"])) reasonsA[k] = (reasonsA[k] || 0) + v;
    lines.push(`g${g + 1}: ${aWhite ? a.name : b.name} (W) vs ${aWhite ? b.name : a.name} (B) ${r.result} in ${r.plies} plies by ${r.how}`);
  }
  ea.terminate(); eb.terminate();
  const ms = Date.now() - t;
  console.log(`   ${a.name} ${a.elo} vs ${b.name} ${b.elo}: ${scoreA}-${games - scoreA}  (${(ms / 1000).toFixed(1)}s)`);
  for (const l of lines) console.log("     " + l);
  console.log("     " + a.name + " move reasons: " + JSON.stringify(reasonsA));
  return { scoreA, scoreB: games - scoreA, ms };
}

const matchResults = [];
if (!args.has("--quick")) {
  section("bots: matches");
  const m1 = await match(getBot("pebble"), getBot("kestrel"), 4, { movetimeScale: 0.3 });
  matchResults.push(["250 vs 2000", m1]);
  ok(m1.scoreB >= 3.5, "2000 bot crushes the 250 bot", `${m1.scoreB}/4`);
  const m2 = await match(getBot("brine"), getBot("apex"), 4, { movetimeScale: 0.3 });
  matchResults.push(["1500 vs 3200", m2]);
  ok(m2.scoreB >= 3, "3200 bot clearly beats the 1500 bot", `${m2.scoreB}/4`);
}
if (args.has("--ladder")) {
  const games = +(process.env.LADDER_GAMES || 6);
  section(`bots: calibration ladder (adjacent ratings, ${games} games each)`);
  const ladder = (process.env.LADDER || "pebble,biscuit,rosa,dex,quill,marisol,tank,yuki,brine,ines,viktor,kestrel").split(",");
  for (let i = 0; i + 1 < ladder.length; i++) {
    const r = await match(getBot(ladder[i]), getBot(ladder[i + 1]), games, { movetimeScale: 0.3 });
    matchResults.push([`${ladder[i]} vs ${ladder[i + 1]}`, r]);
  }
}
BE.terminate();
E.terminate();

// ---------------------------------------------------------------------------
section("summary");
for (const [name, plies, ms] of reviewTimes) console.log(`   review ${name}: ${plies} plies in ${ms} ms`);
for (const [name, r] of matchResults) console.log(`   match ${name}: ${r.scoreA}-${r.scoreB} (${(r.ms / 1000).toFixed(1)}s)`);
console.log(`\n${passes} passed, ${failures} failed, ${((Date.now() - T0) / 1000).toFixed(1)}s total`);
process.exit(failures ? 1 : 0);
