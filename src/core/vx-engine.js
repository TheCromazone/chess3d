// Bots for Duck Chess, Fog of War, Giveaway, Atomic and Horde: negamax alpha-beta with iterative
// deepening and a capture search, on the variant rules in vx.js. Runs in the bot worker.
// - Duck Chess: trying every duck square would be ~30x the work, so each move only tries the few
//   squares that matter: ones that block a capture the opponent could make, or crowd their king.
// - Fog of War: the bot searches only the position it can see (hidden pieces removed), so it plays
//   fair; its root moves are still its real legal ones.
import { VX_VARIANTS, parsePos, legalMoves, pseudoMoves, makeMove, placeDuck, vxOutcome, foggedPos, kingAt, vxSquare, PAWN, KNIGHT, BISHOP, KING, DUCK } from "./vx.js";

const VAL = [0, 100, 310, 330, 500, 900, 0, 0];
const KING_PRIZE = 20000;               // taking the king (Duck Chess, Fog of War) ends the game
const MATE = 1e6;
const AROUND = [-17, -16, -15, -1, 1, 15, 16, 17];
const off = (i) => (i & 0x88) !== 0;
const centre = (i) => 3.5 - Math.max(Math.abs((i & 15) - 3.5), Math.abs((i >> 4) - 3.5));

function evaluate(pos, v, side) {
  const b = pos.b;
  let s = 0, wCount = 0, bCount = 0;
  const wk = kingAt(b, 0), bk = kingAt(b, 8);
  for (let i = 0; i < 120; i++) {
    if (off(i)) { i += 7; continue; }
    const p = b[i];
    if (!p || p === DUCK) continue;
    const t = p & 7, black = p & 8;
    if (black) bCount++; else wCount++;
    let val = VAL[t];
    if (t === KNIGHT || t === BISHOP) val += 8 * centre(i);
    else if (t === PAWN) {
      const adv = black ? (i >> 4) - 1 : 6 - (i >> 4);
      val += (v.horde && !black ? 9 : 5) * adv;
    }
    if (v.atomic && t !== KING) {
      // pieces near the enemy king threaten to blow it up
      const ek = black ? wk : bk;
      if (ek >= 0 && Math.max(Math.abs((i & 15) - (ek & 15)), Math.abs((i >> 4) - (ek >> 4))) <= 2) val += 25;
    }
    s += black ? -val : val;
  }
  if (v.forced) s = (bCount - wCount) * 120 - s / 20;   // Giveaway: fewer pieces is better
  return side ? -s : s;
}

// Duck Chess: where to put the duck after a move (the opponent is to move in `after`)
function duckCandidates(after, v, max) {
  const lifted = { ...after, b: after.b.slice() };
  if (after.duck >= 0) lifted.b[after.duck] = 0;
  const score = new Map();
  const add = (sq, n) => { if (!lifted.b[sq] && sq !== after.duck) score.set(sq, (score.get(sq) || 0) + n); };
  for (const m of pseudoMoves(lifted, v)) {
    if (!m.cap) continue;
    const t = m.piece & 7;
    const prize = (m.cap & 7) === KING ? KING_PRIZE : VAL[m.cap & 7];
    if (t === BISHOP || t === 4 || t === 5) {
      // a sliding capture can be blocked anywhere along its line
      const dr = Math.sign((m.to >> 4) - (m.from >> 4)), df = Math.sign((m.to & 15) - (m.from & 15));
      for (let sq = m.from + dr * 16 + df; sq !== m.to; sq += dr * 16 + df) add(sq, prize);
    }
  }
  // otherwise crowd the opponent's king
  const ek = kingAt(after.b, after.turn);
  if (ek >= 0) for (const d of AROUND) if (!off(ek + d)) add(ek + d, 30);
  let list = [...score.entries()].sort((a, c) => c[1] - a[1]).map((e) => e[0]);
  if (list.length < max) {
    for (let i = 0; i < 120 && list.length < max; i++) { if (off(i)) { i += 7; continue; } if (!after.b[i] && i !== after.duck && !list.includes(i)) list.push(i); }
  }
  return list.slice(0, max);
}

function ordered(ms, v) {
  return ms.map((m) => {
    let s = 0;
    if (m.cap) s = 1000 + ((m.cap & 7) === KING ? KING_PRIZE : 10 * VAL[m.cap & 7]) - VAL[m.piece & 7] / 10;
    if (m.promo) s += VAL[m.promo];
    if (v.forced) s = -s;   // in Giveaway, prefer giving away
    return { m, s };
  }).sort((a, c) => c.s - a.s).map((x) => x.m);
}

// state: { variant, fen } ; opts: { depth, ms, noise }. Returns the move as text ("e2e4", "e2e4,d5")
export function vxSearch(state, { depth = 3, ms = 2000, noise = 0 } = {}) {
  const v = VX_VARIANTS[state.variant];
  const real = parsePos(state.fen);
  const side = real.turn;
  const rootLegal = legalMoves(real, v);
  if (!rootLegal.length) return null;
  const start = v.fog ? foggedPos(real, v, side) : real;
  const deadline = Date.now() + ms;
  let nodes = 0, stopped = false;

  // Fog of War: an enemy king out of sight isn't a captured one, so then only our own king can fall
  const kingHidden = v.fog && kingAt(start.b, side ^ 8) < 0;
  const terminal = (pos, legal, ply) => {
    if (kingHidden) {
      if (kingAt(pos.b, side) < 0) return pos.turn === side ? -MATE + ply : MATE - ply;
      return legal.length ? null : 0;
    }
    const o = vxOutcome(pos, v, legal);
    if (!o.over) return null;
    if (!o.winner) return 0;
    return (o.winner === "b") === !!pos.turn ? MATE - ply : -MATE + ply;
  };

  // children of a node: [position, move, duck] (each move tried with its candidate duck squares)
  function children(pos, list, ducks) {
    const out = [];
    for (const m of list) {
      const after = makeMove(pos, m, v);
      if (!v.duck || (m.cap & 7) === KING) { out.push([after, m, -1]); continue; }
      for (const d of duckCandidates(after, v, ducks)) out.push([placeDuck(after, d), m, d]);
    }
    return out;
  }

  function quiesce(pos, alpha, beta, ply, qd) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) stopped = true;
    const legal = legalMoves(pos, v);
    const t = terminal(pos, legal, ply);
    if (t !== null) return t;
    const caps = legal.filter((m) => m.cap);
    // Giveaway: captures are forced, so there's no standing pat when one is available
    const forcedNow = v.forced && caps.length;
    let best = -Infinity;
    if (!forcedNow) {
      best = evaluate(pos, v, pos.turn);
      if (best >= beta || qd <= 0) return best;
      if (best > alpha) alpha = best;
    } else if (qd <= -4) return evaluate(pos, v, pos.turn);
    for (const [child] of children(pos, ordered(caps, v), 1)) {
      const s = -quiesce(child, -beta, -alpha, ply + 1, qd - 1);
      if (stopped) return best === -Infinity ? 0 : best;
      if (s > best) best = s;
      if (s > alpha) alpha = s;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(pos, d, alpha, beta, ply) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) stopped = true;
    if (stopped) return 0;
    const legal = legalMoves(pos, v);
    const t = terminal(pos, legal, ply);
    if (t !== null) return t;
    if (d <= 0) return quiesce(pos, alpha, beta, ply, 4);
    let best = -Infinity;
    for (const [child] of children(pos, ordered(legal, v), 2)) {
      const s = -negamax(child, d - 1, -beta, -alpha, ply + 1);
      if (stopped) return best === -Infinity ? 0 : best;
      if (s > best) best = s;
      if (s > alpha) alpha = s;
      if (alpha >= beta) break;
    }
    return best;
  }

  let root = children(start, ordered(rootLegal, v), 4);
  let bestChild = root[0];
  for (let d = 1; d <= depth; d++) {
    let alpha = -Infinity, iterBest = null, iterScore = -Infinity;
    const scored = [];
    for (const c of root) {
      // with noise every root move needs an exact score, or a bound plus noise could pick a blunder
      let s = -negamax(c[0], d - 1, -Infinity, noise ? Infinity : -alpha, 1);
      if (stopped) break;
      if (noise) s += (Math.random() - 0.5) * noise;
      scored.push({ c, s });
      if (s > iterScore) { iterScore = s; iterBest = c; }
      if (s > alpha) alpha = s;
    }
    if (iterBest) bestChild = iterBest;
    if (stopped) break;
    root = scored.sort((a, c) => c.s - a.s).map((x) => x.c).concat(root.filter((c) => !scored.some((x) => x.c === c)));
    if (iterScore >= MATE - 100) break;
  }
  const [, m, duck] = bestChild;
  return vxSquare(m.from) + vxSquare(m.to) + (m.promo ? " pnbrqk"[m.promo] : "") + (duck >= 0 ? "," + vxSquare(duck) : "");
}

// Bot levels for the setup screen
export const VX_LEVELS = [
  { id: "easy", name: "Dabble", elo: "Beginner", avatar: { emoji: "🐥", bg: "#6b8f3a" }, opts: { depth: 1, ms: 500, noise: 200 } },
  { id: "medium", name: "Mallard", elo: "Club player", avatar: { emoji: "🦆", bg: "#3b6f5a" }, opts: { depth: 2, ms: 1500, noise: 30 } },
  { id: "hard", name: "Drake", elo: "Strong", avatar: { emoji: "🦢", bg: "#4a3b7a" }, opts: { depth: 4, ms: 3000, noise: 0 } },
];
