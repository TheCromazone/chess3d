// A small Crazyhouse engine: negamax alpha-beta with iterative deepening and a capture search.
// It works on chess.js internals for speed (board moves with make/unmake, drops placed straight on
// the board). Stockfish doesn't play Crazyhouse, so the bots use this; it runs in a Web Worker.
import { Chess } from "chess.js";

const VAL = { p: 100, n: 310, b: 330, r: 480, q: 920, k: 0 };
const HAND = 1.12;                 // a piece in hand can go anywhere, so it's worth a bit more
const MATE = 1e6;
const DROP_TYPES = ["q", "r", "b", "n", "p"];
const AROUND = [-17, -16, -15, -1, 1, 15, 16, 17];
const alg = (i) => "abcdefgh"[i & 15] + (8 - (i >> 4));
const other = (c) => (c === "w" ? "b" : "w");
const dist = (a, b) => Math.max(Math.abs((a & 15) - (b & 15)), Math.abs((a >> 4) - (b >> 4)));
const CENTER = (i) => 3.5 - Math.max(Math.abs((i & 15) - 3.5), Math.abs((i >> 4) - 3.5));

// state: { fen, pockets }; opts: { depth, ms, noise }. Returns the move as text ("e2e4", "N@f3").
export function search(state, { depth = 3, ms = 2000, noise = 0, trace = null } = {}) {
  const c = new Chess();
  c.load(state.fen, { skipValidation: true });
  const pockets = JSON.parse(JSON.stringify(state.pockets));
  const deadline = Date.now() + ms;
  let nodes = 0, stopped = false;

  function evaluate(side) {
    let s = 0;
    const b = c._board;
    for (let i = 0; i < 120; i++) {
      if (i & 0x88) { i += 7; continue; }
      const p = b[i];
      if (!p) continue;
      let v = VAL[p.type];
      if (p.type === "n" || p.type === "b") v += 8 * CENTER(i);
      else if (p.type === "p") v += 4 * (p.color === "w" ? 6 - (i >> 4) : (i >> 4) - 1);
      s += p.color === "w" ? v : -v;
    }
    for (const col of ["w", "b"]) {
      let hand = 0;
      for (const t of DROP_TYPES) hand += pockets[col][t] * VAL[t];
      s += (col === "w" ? 1 : -1) * hand * HAND;
      // king safety: empty squares around the king are landing spots for the enemy's pocket
      const k = c._kings[col];
      if (k === undefined || k < 0) continue;
      let open = 0, shelter = 0;
      for (const d of AROUND) {
        const sq = k + d;
        if (sq & 0x88) continue;
        const p = b[sq];
        if (!p) open++; else if (p.color === col) shelter++;
      }
      let enemyHand = 0;
      for (const t of DROP_TYPES) enemyHand += pockets[other(col)][t] * VAL[t];
      const danger = open * (20 + enemyHand / 60) - shelter * 12;
      s += col === "w" ? -danger : danger;
    }
    return side === "w" ? s : -s;
  }

  function generate(side, capturesOnly) {
    const list = [];
    const enemyK = c._kings[other(side)];
    for (const m of c._moves({ legal: true })) {
      if (capturesOnly && !m.captured) continue;
      let score = 0;
      if (m.captured) score = 10 * VAL[m.captured] - VAL[m.piece] / 10 + 1000;
      if (m.promotion) score += VAL[m.promotion];
      score += 30 - 5 * dist(m.to, enemyK);
      list.push({ m, score });
    }
    if (capturesOnly) return list.sort((a, b) => b.score - a.score);
    const hand = DROP_TYPES.filter((t) => pockets[side][t] > 0);
    if (hand.length) {
      const inCheck = c._isKingAttacked(side);
      const k = c._kings[side];
      for (let i = 0; i < 120; i++) {
        if (i & 0x88) { i += 7; continue; }
        if (c._board[i]) continue;
        if (inCheck) {
          c._board[i] = { type: "n", color: side };
          const still = c._attacked(other(side), k);
          delete c._board[i];
          if (still) continue;
        }
        const rank = 8 - (i >> 4);
        const near = 40 - 10 * dist(i, enemyK);
        for (const t of hand) {
          if (t === "p" && (rank === 1 || rank === 8)) continue;
          list.push({ d: t, i, score: near + VAL[t] / 50 });
        }
      }
    }
    return list.sort((a, b) => b.score - a.score);
  }

  function make(side, x) {
    if (x.d) {
      c._board[x.i] = { type: x.d, color: side };
      pockets[side][x.d]--;
      x.undo = { turn: c._turn, ep: c._epSquare };
      c._turn = other(side);
      c._epSquare = -1;
    } else {
      c._makeMove(x.m);
      if (x.m.captured) pockets[side][x.m.captured]++;
    }
  }
  function unmake(side, x) {
    if (x.d) {
      delete c._board[x.i];
      pockets[side][x.d]++;
      c._turn = x.undo.turn;
      c._epSquare = x.undo.ep;
    } else {
      c._undoMove();
      if (x.m.captured) pockets[side][x.m.captured]--;
    }
  }

  function quiesce(alpha, beta, side, qd) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) stopped = true;
    const stand = evaluate(side);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (qd <= 0) return alpha;
    for (const x of generate(side, true)) {
      make(side, x);
      const v = -quiesce(-beta, -alpha, other(side), qd - 1);
      unmake(side, x);
      if (stopped) return alpha;
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function negamax(d, alpha, beta, side, ply) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) stopped = true;
    if (stopped) return 0;
    const moves = generate(side, false);
    if (!moves.length) return c._isKingAttacked(side) ? -MATE + ply : 0;
    if (d <= 0) return quiesce(alpha, beta, side, 4);
    let best = -Infinity;
    for (const x of moves) {
      make(side, x);
      const v = -negamax(d - 1, -beta, -alpha, other(side), ply + 1);
      unmake(side, x);
      if (stopped) return best === -Infinity ? 0 : best;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  const side = c._turn;
  let root = generate(side, false);
  if (!root.length) return null;
  let bestMove = root[0];
  for (let d = 1; d <= depth; d++) {
    let alpha = -Infinity, iterBest = null, iterScore = -Infinity;
    const scored = [];
    for (const x of root) {
      make(side, x);
      // with noise, every root move needs an exact score (a bound plus noise could pick a blunder)
      let v = -negamax(d - 1, -Infinity, noise ? Infinity : -alpha, other(side), 1);
      unmake(side, x);
      if (stopped) break;
      if (noise) v += (Math.random() - 0.5) * noise;
      scored.push({ x, v });
      if (v > iterScore) { iterScore = v; iterBest = x; }
      if (v > alpha) alpha = v;
    }
    if (trace) trace({ depth: d, nodes, stopped, top: scored.slice().sort((a, b) => b.v - a.v).slice(0, 4).map((s) => [s.x.d ? s.x.d + "@" + alg(s.x.i) : alg(s.x.m.from) + alg(s.x.m.to), Math.round(s.v)]) });
    if (stopped && !iterBest) break;
    if (iterBest) bestMove = iterBest;
    if (stopped) break;
    // search the best moves first next time
    root = scored.sort((a, b) => b.v - a.v).map((s) => s.x).concat(root.filter((x) => !scored.some((s) => s.x === x)));
    if (iterScore >= MATE - 100) break;
  }
  const x = bestMove;
  return x.d ? x.d.toUpperCase() + "@" + alg(x.i) : alg(x.m.from) + alg(x.m.to) + (x.m.promotion || "");
}

// Bot levels for the setup screen
export const ZH_LEVELS = [
  { id: "easy", name: "Pip", elo: "Beginner", avatar: { emoji: "🐣", bg: "#6b8f3a" }, opts: { depth: 1, ms: 500, noise: 220 } },
  { id: "medium", name: "Magpie", elo: "Club player", avatar: { emoji: "🐦", bg: "#3b4f7a" }, opts: { depth: 3, ms: 1500, noise: 40 } },
  { id: "hard", name: "Hoarder", elo: "Strong", avatar: { emoji: "🦝", bg: "#5a2a6b" }, opts: { depth: 5, ms: 3000, noise: 0 } },
];
