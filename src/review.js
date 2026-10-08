// Game Review: analyzes every position of a game with Stockfish (MultiPV 2), then
// classifies each move chess.com-style (brilliant ... blunder), computes lichess-style
// accuracy, an eval graph, key moments, a rough "game rating", and coach one-liners.
import { createChess } from "./core/chess960.js";
import {
  START_FEN, winPercent, applyMove, moveToUci, uciLineToSan, materialFromFen,
  PIECE_VALUE, seeMove, enPriseLoss, bestCaptureGain,
} from "./engine.js";

export const CLASSIFICATIONS = [
  "brilliant", "great", "best", "excellent", "good", "book",
  "inaccuracy", "mistake", "miss", "blunder", "forced",
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const other = (c) => (c === "w" ? "b" : "w");

// ---------------------------------------------------------------------------
// Accuracy (lichess)
// ---------------------------------------------------------------------------

/** Per-move accuracy from the mover's win% before/after (0-100). */
export function moveAccuracy(winBefore, winAfter) {
  if (winAfter >= winBefore) return 100;
  return clamp(103.1668 * Math.exp(-0.04354 * (winBefore - winAfter)) - 3.1669, 0, 100);
}

function stdDev(xs) {
  if (!xs.length) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length);
}

/**
 * Lichess game accuracy: volatility-weighted mean of per-move accuracies averaged with
 * their harmonic mean. `whiteWin` = White win% for the initial position and after every ply.
 * @returns {{w:number|null, b:number|null}}
 */
export function gameAccuracy(whiteWin, startColor = "w") {
  const n = whiteWin.length - 1;
  if (n < 1) return { w: null, b: null };
  const win = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const windows = [];
  for (let i = 0; i < Math.min(win, whiteWin.length) - 2; i++) windows.push(whiteWin.slice(0, win));
  for (let i = 0; i + win <= whiteWin.length; i++) windows.push(whiteWin.slice(i, i + win));
  const per = { w: [], b: [] };
  for (let i = 0; i < n; i++) {
    const color = (i % 2 === 0) === (startColor === "w") ? "w" : "b";
    const before = color === "w" ? whiteWin[i] : 100 - whiteWin[i];
    const after = color === "w" ? whiteWin[i + 1] : 100 - whiteWin[i + 1];
    const weight = clamp(stdDev(windows[i] || windows[windows.length - 1] || [50]), 0.5, 12);
    per[color].push([moveAccuracy(before, after), weight]);
  }
  const out = { w: null, b: null };
  for (const c of ["w", "b"]) {
    const xs = per[c];
    if (!xs.length) continue;
    const wsum = xs.reduce((a, [, w]) => a + w, 0);
    const weighted = xs.reduce((a, [acc, w]) => a + acc * w, 0) / wsum;
    const harmonic = xs.length / xs.reduce((a, [acc]) => a + 1 / Math.max(1, acc), 0);
    out[c] = (weighted + harmonic) / 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rough "game rating"
// ---------------------------------------------------------------------------

// Accuracy -> rating anchors (roughly what chess.com players see in practice).
const ACC_ELO = [[0, 100], [30, 250], [40, 400], [50, 600], [60, 900], [70, 1250], [80, 1650], [85, 1900], [90, 2250], [95, 2700], [100, 3100]];

export function accuracyToElo(acc) {
  if (acc == null) return null;
  for (let i = 1; i < ACC_ELO.length; i++) {
    const [a1, e1] = ACC_ELO[i];
    if (acc <= a1) {
      const [a0, e0] = ACC_ELO[i - 1];
      return e0 + ((acc - a0) / (a1 - a0)) * (e1 - e0);
    }
  }
  return ACC_ELO[ACC_ELO.length - 1][1];
}

/**
 * est = 0.7 * accuracyToElo(ownAccuracy) + 0.3 * opponentStrength + 200 * (score - 0.5)
 * where opponentStrength = known opponent rating (opts.ratings) or accuracyToElo(theirs),
 * score = 1 / 0.5 / 0 when the result is known (else the term is 0); then shrunk toward
 * 1200 for short games (weight = min(1, ownMoves / 15)), rounded to 50, clamped 100..3200.
 */
export function estimateElo(accuracy, { ratings = {}, result = null, moves = { w: 20, b: 20 } } = {}) {
  const out = { w: null, b: null };
  for (const c of ["w", "b"]) {
    if (accuracy[c] == null) continue;
    const o = other(c);
    const own = accuracyToElo(accuracy[c]);
    const opp = ratings[o] != null ? ratings[o] : accuracy[o] != null ? accuracyToElo(accuracy[o]) : own;
    let est = 0.7 * own + 0.3 * opp;
    const score = result === "1-0" ? (c === "w" ? 1 : 0) : result === "0-1" ? (c === "b" ? 1 : 0) : result === "1/2-1/2" ? 0.5 : null;
    if (score != null) est += 200 * (score - 0.5);
    est = 1200 + (est - 1200) * Math.min(1, (moves[c] || 0) / 15);
    out[c] = clamp(Math.round(est / 50) * 50, 100, 3200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify one move from precomputed facts (pure; all EPs are the mover's expected
 * points 0..1 = win%/100).
 * @param {object} f
 * @param {number} f.epBest       EP of the engine's best move (eval of the position before)
 * @param {number} f.epPlayed     EP after the played move
 * @param {number|null} [f.epSecond] EP of the second-best line (MultiPV 2)
 * @param {number|null} [f.epPrev]   mover's EP before the opponent's previous move
 * @param {number} [f.legalCount=2]
 * @param {boolean} [f.book]
 * @param {boolean} [f.playedIsBest] played == engine best move
 * @param {boolean} [f.playedIsSecond] played == second MultiPV move
 * @param {boolean} [f.sacrifice]  move gives up >= a minor piece's worth (see detectSacrifice)
 * @param {number} [f.captureGain=0] SEE of the move if it is a capture (material it simply wins)
 * @param {boolean} [f.recapture]  captures on the square the opponent just captured on
 * @param {boolean} [f.bestIsMate] best line is a forced mate for the mover
 * @param {boolean} [f.secondIsMate] second line is also a forced mate for the mover
 * @param {number|null} [f.allowsMate] the move allows a forced mate in N (and the mover
 *   wasn't already being mated): always a blunder when N <= 5
 * @returns {string} one of CLASSIFICATIONS
 */
export function classifyMove(f) {
  const {
    epBest, epPlayed, epSecond = null, epPrev = null, legalCount = 2, book = false,
    playedIsBest = false, playedIsSecond = false, sacrifice = false, captureGain = 0,
    recapture = false, bestIsMate = false, secondIsMate = false, allowsMate = null,
  } = f;
  if (legalCount <= 1) return "forced";
  if (book) return "book";
  if (allowsMate != null && allowsMate > 0 && allowsMate <= 5) return "blunder";
  const loss = Math.max(0, epBest - epPlayed);
  const nearBest = playedIsBest || loss < 0.02;

  // Brilliant: a sound sacrifice that isn't just cashing in an already won game.
  // (Exception: the sacrifice is the only way to force mate.)
  if (nearBest && sacrifice && captureGain < 100 && epPlayed >= 0.5 &&
      (epBest < 0.95 || (bestIsMate && !secondIsMate))) return "brilliant";

  // Great: the only good move, or the move that turns a lost game around.
  if (nearBest && !playedIsSecond && captureGain < 200 && !recapture) {
    const onlyMove = epSecond != null && epBest - epSecond >= 0.10 && epBest < 0.9;
    const turnaround = epPrev != null && epPrev < 0.35 && epPlayed >= 0.5 &&
      (epSecond == null || epSecond < 0.5 || epBest - epSecond >= 0.10);
    if (onlyMove || turnaround) return "great";
  }

  if (playedIsBest || Math.round(loss * 100) <= 0) return "best";
  if (loss < 0.02) return "excellent";
  if (loss < 0.05) return "good";
  // Miss: the opponent just handed over a big chance and this move lets it go
  // (without making things worse than before their error).
  if (loss >= 0.10 && epPrev != null && epBest >= epPrev + 0.15 && epPlayed >= epPrev - 0.05) return "miss";
  if (loss < 0.10) return "inaccuracy";
  if (loss < 0.20) return "mistake";
  return "blunder";
}

// ---------------------------------------------------------------------------
// Material along a line / sacrifices
// ---------------------------------------------------------------------------

function matDiff(fen, color) {
  const m = materialFromFen(fen);
  return m[color] - m[other(color)];
}

/** Walk `ucis` from `fen`; per ply: {san, uci, color, captured, delta (mover material vs start), mate}. */
export function lineMaterial(fen, ucis, mover, maxPlies = 10) {
  const steps = [];
  let c;
  try { c = createChess(fen); } catch { return steps; }
  const base = matDiff(fen, mover);
  for (const u of ucis.slice(0, maxPlies)) {
    const mv = applyMove(c, u);
    if (!mv) break;
    const f = c.fen();
    steps.push({ san: mv.san, uci: u, color: mv.color, piece: mv.promotion || mv.piece, captured: mv.captured || null, delta: matDiff(f, mover) - base, mate: c.isCheckmate() });
  }
  return steps;
}

/** Material delta once the capture sequence that is under way after `minPlies` has finished. */
export function settledDelta(steps, minPlies = 2) {
  if (!steps.length) return { delta: 0, plies: 0 };
  let k = Math.min(minPlies, steps.length);
  while (k < steps.length && steps[k].captured && k < 12) k++;
  return { delta: steps[k - 1].delta, plies: k };
}

const ARTICLE = { p: "a pawn", n: "a knight", b: "a bishop", r: "a rook", q: "the queen", k: "the king" };

/** Remove pieces that were traded one-for-one, leaving the net material that changed hands. */
function netPieces(lost, won) {
  const w = [...won];
  const net = [];
  for (const p of lost) {
    const i = w.indexOf(p);
    if (i >= 0) w.splice(i, 1); else net.push(p);
  }
  return [net, w];
}

/** Name the material behind a swing of `amount` cp: `lostRaw` changed hands one way, `wonRaw` the other. */
function nameMaterial(amount, lostRaw, wonRaw = []) {
  amount = Math.abs(amount);
  const [pieces, otherPieces] = netPieces(lostRaw, wonRaw);
  if (amount >= 150 && amount <= 420 && pieces.includes("r") && otherPieces.some((p) => p === "n" || p === "b")) return "the exchange";
  const sorted = [...new Set(pieces)].filter((p) => p !== "k").sort((a, b) => PIECE_VALUE[b] - PIECE_VALUE[a]);
  const fit = sorted.find((p) => PIECE_VALUE[p] <= amount + 100 && PIECE_VALUE[p] >= amount - 150);
  if (fit) return ARTICLE[fit];
  if (amount >= 800) return "the queen";
  if (amount >= 450) return "a rook";
  if (amount >= 250) return "a piece";
  return amount >= 150 ? "two pawns" : "a pawn";
}

function capturedBy(steps, color, plies) {
  return steps.slice(0, plies).filter((s) => s.color === color && s.captured).map((s) => s.captured);
}

function nullMoveThreat(fen) {
  const f = fen.split(" ");
  f[1] = f[1] === "w" ? "b" : "w";
  f[3] = "-";
  try {
    const c = createChess(f.join(" "));
    return bestCaptureGain(c).gain;
  } catch { return 0; }
}

/**
 * Does the played move sacrifice material? Either the moved piece is left en prise
 * (SEE of the opponent capturing it, minus what the move captured, >= 200) or the
 * opponent's best line wins >= 200 net and keeps it. Losses the opponent was already
 * threatening before the move (null-move test) don't count as a sacrifice.
 * @returns {{amount:number, piece:string|null}} amount in cp (0 = no sacrifice)
 */
export function detectSacrifice(fenBefore, move, replyPv) {
  const mover = move.color;
  let after;
  try { after = createChess(move.after || fenBefore); } catch { return { amount: 0, piece: null }; }
  if (!move.after) { try { after.move({ from: move.from, to: move.to, promotion: move.promotion }); } catch { return { amount: 0, piece: null }; } }
  const capturedVal = move.captured ? PIECE_VALUE[move.captured] : 0;
  const enPriseNet = after.isGameOver() ? 0 : enPriseLoss(after, move.to) - capturedVal;
  const steps = lineMaterial(fenBefore, [moveToUci(move), ...replyPv], mover, 10);
  const s2 = settledDelta(steps, 2), s4 = settledDelta(steps, 4);
  const pvSac = steps.length >= 2 ? Math.min(-s2.delta, -s4.delta) : 0;
  const amount = Math.max(enPriseNet, pvSac);
  if (amount < 200) return { amount: 0, piece: null };
  const inCheck = createChess(fenBefore).inCheck();
  const threat = inCheck ? 0 : nullMoveThreat(fenBefore);
  if (threat > amount - 100) return { amount: 0, piece: null }; // that material was already lost
  let piece;
  if (enPriseNet >= pvSac) piece = nameMaterial(enPriseNet, [move.promotion || move.piece], move.captured ? [move.captured] : []);
  else piece = nameMaterial(pvSac, capturedBy(steps, other(mover), s4.plies), capturedBy(steps, mover, s4.plies));
  return { amount, piece };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function mateFor(score, color) {
  if (!score || score.mate == null || score.mate === 0) return null;
  return color === "w" ? score.mate : -score.mate;
}

/** Mover's score in cp (mates as ±2000) for plausibility checks. */
function cpFor(score, color) {
  if (!score) return 0;
  if (score.mate != null) {
    if (score.mate === 0) return score.winner === color ? 2000 : score.winner ? -2000 : 0;
    return (color === "w") === (score.mate > 0) ? 2000 : -2000;
  }
  return Math.max(-2000, Math.min(2000, color === "w" ? score.cp : -score.cp));
}

function scoreOf(r) {
  return (r && r.lines && r.lines[0] && r.lines[0].scoreWhite) || { cp: 0 };
}

function reviewError(msg, code) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * Review a whole game.
 * @param {Engine} engine (ideally a dedicated instance; other calls on it abort the review)
 * @param {{startFen?:string, moves:string[], result?:"1-0"|"0-1"|"1/2-1/2"}} game  moves in SAN or UCI
 * @param {object} [o]
 * @param {number} [o.movetime=350] per position, ms
 * @param {number} [o.depth=14] per position (whichever limit comes first)
 * @param {(fen:string)=>boolean} [o.isBook] opening-book lookup for the position after a move
 * @param {number} [o.bookMaxPly=30] only plies before this can be "book"
 * @param {(done:number,total:number,partial:object)=>void} [o.onProgress]
 * @param {{w?:number,b?:number}} [o.ratings] known player ratings (improves estimatedElo)
 * @param {AbortSignal} [o.signal] cancel the review (rejects with code "ABORTED")
 * @param {number} [o.maxRechecks=10] max positions re-searched deeper (depth+6, 4x movetime)
 *   when the engine's own best move appears to lose (search instability)
 */
export async function reviewGame(engine, { startFen = START_FEN, moves = [], result = null } = {}, {
  movetime = 350, depth = 14, isBook = () => false, bookMaxPly = 30,
  onProgress = () => {}, ratings = {}, signal = null, maxRechecks = 10,
} = {}) {
  const t0 = Date.now();
  const chess = createChess(startFen);
  startFen = chess.fen();
  const played = [];
  const fens = [startFen];
  for (const mv of moves) {
    const legalCount = chess.moves().length;
    const fenBefore = chess.fen();
    const m = applyMove(chess, mv);
    if (!m) throw reviewError(`Illegal move "${mv}" at ply ${played.length + 1}`, "BAD_GAME");
    played.push({ ...m, uci: moveToUci(m), legalCount, fenBefore, fenAfter: chess.fen() });
    fens.push(chess.fen());
  }
  if (!result) {
    if (chess.isCheckmate()) result = chess.turn() === "w" ? "0-1" : "1-0";
    else if (chess.isDraw()) result = "1/2-1/2";
  }
  const ucis = played.map((p) => p.uci);
  const startColor = startFen.split(" ")[1] === "b" ? "b" : "w";

  if (signal && signal.aborted) throw reviewError("Review cancelled", "ABORTED");
  const onAbort = () => { engine.stop().catch(() => {}); };
  if (signal) signal.addEventListener("abort", onAbort);

  const evals = [];
  let plies = [];
  const evalGraph = [];
  const ctx = { isBook, bookMaxPly };
  const run = async (i, d, mt) => {
    if (signal && signal.aborted) throw reviewError("Review cancelled", "ABORTED");
    const r = await engine.analyze(fens[i], { depth: d, movetime: mt, multipv: 2, history: { startFen, moves: ucis.slice(0, i) } });
    if (r.aborted) {
      if (signal && signal.aborted) throw reviewError("Review cancelled", "ABORTED");
      throw reviewError("Review interrupted: the engine was used for something else", "ABORTED");
    }
    return r;
  };
  let rechecked = 0;
  try {
    await engine.newGame();
    for (let i = 0; i < fens.length; i++) {
      evals.push(await run(i, depth, movetime));
      evalGraph.push(winPercent(scoreOf(evals[i]), "w"));
      if (i > 0) plies.push(buildPly(i - 1, played, fens, evals, ctx));
      try { onProgress(i + 1, fens.length, { plies: plies.slice(), evalGraph: evalGraph.slice() }); } catch (e) { console.error(e); }
    }
    // Verification pass: if the engine's own best move "loses" a lot, one of the two
    // searches was too shallow (typically a pruned sacrifice/mate). Re-search both
    // positions deeper and rebuild. Bounded so reviews stay fast.
    const done = new Set();
    for (let round = 0; round < 2 && rechecked < maxRechecks; round++) {
      const suspects = [];
      for (const p of plies) {
        const unstable = p.uci === p.bestUci && p.winBefore - p.winAfter >= 10;
        const mateFlip = p.uci === p.bestUci && mateFor(p.evalBefore, p.color) > 0 && !(mateFor(p.evalAfter, p.color) > 0) && !(p.evalAfter.mate === 0);
        if (unstable || mateFlip) suspects.push(p.ply);
      }
      let changed = false;
      for (const k of suspects) {
        for (const i of [k, k + 1]) {
          if (done.has(i) || rechecked >= maxRechecks || i >= fens.length) continue;
          done.add(i);
          rechecked++;
          const r = await run(i, depth + 6, movetime * 4);
          if (r.lines.length && r.depth >= evals[i].depth) { evals[i] = r; changed = true; }
        }
      }
      if (!changed) break;
      for (let i = 0; i < fens.length; i++) evalGraph[i] = winPercent(scoreOf(evals[i]), "w");
      plies = played.map((_, i) => buildPly(i, played, fens, evals, ctx));
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  // Final pass so "miss"/"great" see their neighbours' final evals.
  plies = played.map((_, i) => buildPly(i, played, fens, evals, ctx));

  const accuracy = gameAccuracy(evalGraph, startColor);
  const counts = { w: {}, b: {} };
  for (const c of ["w", "b"]) for (const k of CLASSIFICATIONS) counts[c][k] = 0;
  for (const p of plies) counts[p.color][p.classification]++;
  const movesBy = { w: plies.filter((p) => p.color === "w").length, b: plies.filter((p) => p.color === "b").length };
  return {
    startFen,
    result,
    plies,
    accuracy,
    counts,
    evalGraph,
    keyMoments: keyMoments(plies, evalGraph),
    estimatedElo: estimateElo(accuracy, { ratings, result, moves: movesBy }),
    settings: { movetime, depth, rechecked },
    durationMs: Date.now() - t0,
  };
}

function buildPly(i, played, fens, evals, { isBook, bookMaxPly }) {
  const mv = played[i];
  const color = mv.color, opp = other(color);
  const eb = evals[i], ea = evals[i + 1];
  const evalBefore = scoreOf(eb), evalAfter = scoreOf(ea);
  const winBefore = winPercent(evalBefore, color);
  const winAfter = winPercent(evalAfter, color);
  const l1 = eb.lines[0] || null, l2 = eb.lines[1] || null;
  const bestUci = eb.bestmove || (l1 && l1.pv[0]) || null;
  const bestLine = l1 ? l1.pv : bestUci ? [bestUci] : [];
  const bestLineSan = l1 ? l1.san.slice(0, 8) : uciLineToSan(mv.fenBefore, bestLine, 8);
  const bestSan = bestLineSan[0] || null;
  const replyPv = (ea.lines[0] && ea.lines[0].pv) || [];
  const replyLineSan = (ea.lines[0] && ea.lines[0].san.slice(0, 8)) || [];

  // Material facts
  const chessBefore = createChess(mv.fenBefore);
  const captureGain = mv.captured ? seeMove(chessBefore, mv) : 0;
  const prevMove = i > 0 ? played[i - 1] : null;
  const recapture = !!(mv.captured && prevMove && prevMove.captured && prevMove.to === mv.to);
  const playedSteps = lineMaterial(mv.fenBefore, [mv.uci, ...replyPv], color, 10);
  const bestSteps = lineMaterial(mv.fenBefore, bestLine, color, 10);
  const pS = settledDelta(playedSteps, Math.min(4, playedSteps.length));
  const bS = settledDelta(bestSteps, Math.min(4, bestSteps.length));
  const prevBase = i > 0 ? matDiff(fens[i - 1], color) - matDiff(mv.fenBefore, color) : 0; // material already swung by their last move
  const sac = detectSacrifice(mv.fenBefore, mv, replyPv);

  const epBest = winBefore / 100, epPlayed = winAfter / 100;
  const epSecond = l2 ? winPercent(l2.scoreWhite, color) / 100 : null;
  const epPrev = i > 0 ? winPercent(scoreOf(evals[i - 1]), color) / 100 : null;
  const bestMate = mateFor(evalBefore, color);
  const secondMate = l2 ? mateFor(l2.scoreWhite, color) : null;
  const afterMate = mateFor(evalAfter, color);
  const checkmate = evalAfter.mate === 0 && evalAfter.winner === color;
  const allowsMate = afterMate != null && afterMate < 0 && !(bestMate != null && bestMate < 0) ? -afterMate : null;
  const book = i < bookMaxPly && !!safeCall(isBook, mv.fenAfter);
  const classification = classifyMove({
    epBest, epPlayed, epSecond, epPrev,
    legalCount: mv.legalCount, book,
    playedIsBest: bestUci === mv.uci,
    playedIsSecond: !!(l2 && l2.pv[0] === mv.uci),
    sacrifice: sac.amount >= 200,
    captureGain, recapture,
    bestIsMate: bestMate != null && bestMate > 0,
    secondIsMate: secondMate != null && secondMate > 0,
    allowsMate,
  });

  // Reasons for the coach
  const tags = {};
  if (checkmate) tags.checkmate = true;
  if (afterMate != null && afterMate > 0) tags.forcesMate = afterMate + 1; // counted from before this move
  if (allowsMate) tags.allowsMate = allowsMate;
  if (bestMate != null && bestMate > 0 && !(afterMate != null && afterMate > 0) && !checkmate) tags.missedMate = bestMate;
  if (sac.amount >= 200) tags.sacrifice = sac.piece;
  // Material reasons only make sense on lines that don't end in mate, and only when the
  // evaluation agrees (a claimed swing of A cp needs an eval swing of at least A/2).
  const playedMateLine = afterMate != null || checkmate || playedSteps.some((x) => x.mate);
  const bestMateLine = bestMate != null || bestSteps.some((x) => x.mate);
  const cpBefore = cpFor(evalBefore, color), cpAfter = cpFor(evalAfter, color);
  const cpPrev = i > 0 ? cpFor(scoreOf(evals[i - 1]), color) : cpBefore;
  const lossAmt = -pS.delta;
  if (!playedMateLine && lossAmt >= 200 && bS.delta - pS.delta >= 200 && cpBefore - cpAfter >= lossAmt / 2) {
    tags.loses = nameMaterial(lossAmt, capturedBy(playedSteps, opp, pS.plies), capturedBy(playedSteps, color, pS.plies));
    tags.hangs = !!(playedSteps[1] && playedSteps[1].captured);
  }
  const missAmt = bS.delta - Math.max(pS.delta, prevBase);
  if (!bestMateLine && bS.delta - prevBase >= 200 && bS.delta - pS.delta >= 200 && cpBefore - cpAfter >= missAmt / 2) {
    tags.missedWin = nameMaterial(missAmt, capturedBy(bestSteps, color, bS.plies), capturedBy(bestSteps, opp, bS.plies));
  }
  const winAmt = pS.delta - prevBase;
  if (!playedMateLine && winAmt >= 200 && cpAfter - cpPrev >= winAmt / 2) {
    tags.wins = nameMaterial(winAmt, capturedBy(playedSteps, color, pS.plies), capturedBy(playedSteps, opp, pS.plies));
  }
  if (classification === "great") {
    tags.onlyMove = epSecond != null && epBest - epSecond >= 0.10;
    tags.turnaround = epPrev != null && epPrev < 0.35 && epPlayed >= 0.5;
  }

  return {
    ply: i,
    moveNumber: +mv.fenBefore.split(" ")[5],
    color,
    san: mv.san,
    uci: mv.uci,
    fenBefore: mv.fenBefore,
    fenAfter: mv.fenAfter,
    evalBefore,
    evalAfter,
    bestUci,
    bestSan,
    bestLineSan,
    replyLineSan,
    secondUci: l2 ? l2.pv[0] : null,
    winBefore,
    winAfter,
    accuracy: moveAccuracy(winBefore, winAfter),
    classification,
    tags,
    depth: eb.depth,
  };
}

function safeCall(fn, arg) { try { return fn(arg); } catch { return false; } }

const SPECIAL_WEIGHT = { brilliant: 100, great: 40, blunder: 30, miss: 25, mistake: 15 };

/** Up to 6 ply indexes: biggest eval swings plus brilliant / great / blunder / miss / mistake. */
export function keyMoments(plies, evalGraph, max = 6) {
  const scored = plies.map((p, i) => {
    const swing = Math.abs((evalGraph[i + 1] ?? 50) - (evalGraph[i] ?? 50));
    const bonus = SPECIAL_WEIGHT[p.classification] || 0;
    return { i, score: swing + bonus, keep: swing >= 10 || bonus > 0 };
  }).filter((x) => x.keep);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.i).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Coach text
// ---------------------------------------------------------------------------

const AN = { inaccuracy: "an inaccuracy", mistake: "a mistake", blunder: "a blunder" };
const mateIn = (n) => `mate in ${n}`;

/** A chess.com-style one-liner for review.plies[plyIndex]. */
export function coachText(plyIndex, review) {
  const p = review && review.plies && review.plies[plyIndex];
  if (!p) return "";
  const s = p.san, best = p.bestSan, t = p.tags || {};
  const bestOther = best && best !== s;
  switch (p.classification) {
    case "book":
      return `${s} is a book move.`;
    case "forced":
      return t.checkmate ? `${s} is checkmate!` : `${s} is the only legal move.`;
    case "brilliant": {
      let x = `${s} is brilliant!`;
      if (t.sacrifice) x += ` It sacrifices ${t.sacrifice}` + (t.forcesMate ? ` to force ${mateIn(t.forcesMate)}.` : t.checkmate ? " and delivers mate." : ".");
      return x;
    }
    case "great": {
      let x = `${s} is a great move.`;
      if (t.forcesMate) x += ` It forces ${mateIn(t.forcesMate)}.`;
      else if (t.turnaround) x += " It turns the game around.";
      else if (t.onlyMove) {
        x += p.winAfter >= 60 ? " It's the only move that keeps the advantage."
          : p.winAfter >= 40 ? " It's the only move that holds the balance."
          : " It's the only move that keeps you in the game.";
      }
      return x;
    }
    case "best": {
      if (t.checkmate) return `${s} is checkmate!`;
      let x = `${s} is the best move.`;
      if (t.forcesMate) x += ` It forces ${mateIn(t.forcesMate)}.`;
      else if (t.wins) x += ` It wins ${t.wins}.`;
      return x;
    }
    case "excellent": {
      if (t.checkmate) return `${s} is checkmate!`;
      let x = `${s} is excellent.`;
      if (t.forcesMate) x += ` It still forces ${mateIn(t.forcesMate)}.`;
      else if (t.wins) x += ` It wins ${t.wins}.`;
      return x;
    }
    case "good":
      if (t.missedMate && bestOther) return `${s} is good, but ${best} forced ${mateIn(t.missedMate)}.`;
      return bestOther ? `${s} is good. ${best} was best.` : `${s} is a good move.`;
    case "miss":
      if (t.missedMate && best) return `You missed ${mateIn(t.missedMate)} with ${best}.`;
      if (t.missedWin && best) return `You missed a chance to win ${t.missedWin} with ${best}.`;
      return best ? `You missed a chance to take the advantage with ${best}.` : `${s} misses a chance.`;
    case "inaccuracy":
    case "mistake":
    case "blunder": {
      let x = `${s} is ${AN[p.classification]}.`;
      if (t.allowsMate) x += ` It allows ${mateIn(t.allowsMate)}.`;
      else if (t.missedMate && best) return x + ` ${best} was best, leading to ${mateIn(t.missedMate)}.`;
      else if (t.loses) x += ` It ${t.hangs ? "hangs" : "loses"} ${t.loses}.`;
      else if (t.missedWin && best) return x + ` ${best} was best, winning ${t.missedWin}.`;
      if (bestOther) x += ` ${best} was best.`;
      return x;
    }
    default:
      return `${s}.`;
  }
}

