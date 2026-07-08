// Chess AI — iterative-deepening negamax + alpha-beta + quiescence, time-capped.
// Runs in a Web Worker so the UI never blocks. Bundled with chess.js (no imports at runtime).
import { Chess } from "chess.js";

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Piece-square tables, white perspective, a8..h1 ordering flipped to rank-major from rank 8.
const PST = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
      0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30,
      -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30,
      -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10,
      -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10,
      -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
      -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10,
      -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10,
      -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
      20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
};

function evaluate(game) {
  const board = game.board();
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = board[r][f];
      if (!cell) continue;
      const idx = r * 8 + f;
      const pst = PST[cell.type];
      if (cell.color === "w") score += VAL[cell.type] + pst[idx];
      else score -= VAL[cell.type] + pst[63 - idx];
    }
  }
  return score;
}

let deadline = 0;
let nodes = 0;
class TimeUp extends Error {}

function orderMoves(moves, pv) {
  return moves.sort((a, b) => {
    if (pv && a.from === pv.from && a.to === pv.to) return -1;
    if (pv && b.from === pv.from && b.to === pv.to) return 1;
    const av = (a.captured ? 10 * VAL[a.captured] - VAL[a.piece] : 0) + (a.promotion ? 800 : 0);
    const bv = (b.captured ? 10 * VAL[b.captured] - VAL[b.piece] : 0) + (b.promotion ? 800 : 0);
    return bv - av;
  });
}

function quiesce(game, alpha, beta, color, depth) {
  if ((++nodes & 255) === 0 && Date.now() > deadline) throw new TimeUp();
  const stand = color * evaluate(game);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (depth <= 0) return alpha;
  const caps = game.moves({ verbose: true }).filter(m => m.captured);
  orderMoves(caps, null);
  for (const m of caps) {
    game.move(m);
    const score = -quiesce(game, -beta, -alpha, -color, depth - 1);
    game.undo();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(game, depth, alpha, beta, color, pv) {
  if ((++nodes & 255) === 0 && Date.now() > deadline) throw new TimeUp();
  if (game.isCheckmate()) return -99000 - depth;
  if (game.isDraw()) return 0;
  if (depth === 0) return quiesce(game, alpha, beta, color, 6);
  const moves = orderMoves(game.moves({ verbose: true }), pv);
  let best = -Infinity, bestMove = null;
  for (const m of moves) {
    game.move(m);
    const score = -negamax(game, depth - 1, -beta, -alpha, -color, null);
    game.undo();
    if (score > best) { best = score; bestMove = m; }
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return bestMove ? best : (game.inCheck() ? -99000 : 0);
}

function searchRoot(game, depth, color, pv) {
  const moves = orderMoves(game.moves({ verbose: true }), pv);
  let best = -Infinity, bestMove = moves[0];
  let alpha = -Infinity;
  for (const m of moves) {
    game.move(m);
    const score = -negamax(game, depth - 1, -Infinity, -alpha, -color, null);
    game.undo();
    if (score > best) { best = score; bestMove = m; }
    if (score > alpha) alpha = score;
  }
  return { move: bestMove, score: best };
}

const LEVEL = {
  1: { time: 150, maxDepth: 1, blunder: 0.35 },
  2: { time: 350, maxDepth: 2, blunder: 0.12 },
  3: { time: 900, maxDepth: 3, blunder: 0 },
  4: { time: 1700, maxDepth: 5, blunder: 0 },
};

self.onmessage = (e) => {
  const { fen, level } = e.data;
  const cfg = LEVEL[level] || LEVEL[3];
  const game = new Chess(fen);
  const color = game.turn() === "w" ? 1 : -1;
  const legal = game.moves({ verbose: true });
  if (!legal.length) { self.postMessage(null); return; }

  let result = null;
  if (cfg.blunder && Math.random() < cfg.blunder) {
    result = legal[Math.floor(Math.random() * legal.length)];
  } else {
    deadline = Date.now() + cfg.time;
    nodes = 0;
    let pv = null;
    for (let d = 1; d <= cfg.maxDepth; d++) {
      try {
        const r = searchRoot(game, d, color, pv);
        pv = r.move;
      } catch (err) {
        if (!(err instanceof TimeUp)) throw err;
        break;
      }
      if (Date.now() > deadline) break;
    }
    result = pv || legal[0];
  }
  self.postMessage({ from: result.from, to: result.to, promotion: result.promotion });
};
