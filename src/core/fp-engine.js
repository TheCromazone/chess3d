// Bots for 4-Player Chess. A "paranoid" alpha-beta search: the bot maximises its own score while
// assuming the other armies all play against it (in Teams, its partner plays with it). Leaves are
// scored on material, points (free-for-all) and pieces left hanging. Runs in the bot worker.
import { FourPlayer, fpLegal, fpMake, fpAttacked, fpInCheck, teammate, fpSquare, FP_SQUARES, PAWN, KING } from "./fp.js";

const VAL = [0, 100, 300, 450, 500, 900, 0];
const CAPTURE_POINTS = [0, 1, 3, 5, 5, 9, 20];
const MATE = 1e6;
const typeOf = (p) => p & 7;
const ownerOf = (p) => (p >> 3) & 3;
const centre = (i) => 6.5 - Math.max(Math.abs((i % 14) - 6.5), Math.abs(Math.floor(i / 14) - 6.5));

// next army to move in the search (resigned armies' wandering kings are left out)
function nextMover(pos, c) {
  for (let k = 1; k <= 4; k++) { const a = (c + k) % 4; if (pos.status[a] === "active") return a; }
  return c;
}

// play a move in the search: the board, capture points, a taken king's army leaving
function child(pos, m, teams) {
  const next = fpMake(pos, m);
  const c = pos.turn;
  if (m.cap) {
    const victim = ownerOf(m.cap);
    if (!teams && pos.status[victim] === "active") next.points = next.points.map((p, a) => (a === c ? p + (m.cap & 32 ? 1 : CAPTURE_POINTS[typeOf(m.cap)]) : p));
    if (typeOf(m.cap) === KING) next.status = next.status.map((s, a) => (a === victim ? "out" : s));
  }
  next.turn = nextMover(next, c);
  return next;
}

function evaluate(pos, teams, me) {
  const friend = (a) => a === me || (teams && a === teammate(me));
  let s = 0;
  const others = [0, 1, 2, 3].filter((a) => !friend(a) && pos.status[a] === "active").length || 1;
  for (const i of FP_SQUARES) {
    const p = pos.b[i];
    if (!p) continue;
    const a = ownerOf(p);
    if (pos.status[a] !== "active") continue;
    const t = typeOf(p);
    let v = VAL[t] + (t !== PAWN && t !== KING ? 6 * centre(i) : 0);
    if (friend(a)) {
      // a piece of ours under attack is worth less; more so if it's the bot's own and undefended
      if (t !== KING && fpAttacked(pos, teams, i, a)) v *= a === me ? 0.45 : 0.7;
      s += a === me || teams ? v : 0;
    } else s -= teams ? v : v / others;
  }
  if (!teams) {
    s += 100 * pos.points[me];
    const best = Math.max(...[0, 1, 2, 3].filter((a) => a !== me).map((a) => pos.points[a]));
    s -= 40 * best;
  }
  return s;
}

function ordered(ms) {
  return ms.map((m) => ({ m, s: (m.cap ? 1000 + VAL[typeOf(m.cap)] * 10 - VAL[typeOf(m.piece)] + (typeOf(m.cap) === KING ? 50000 : 0) : 0) + (m.promo ? 800 : 0) }))
    .sort((a, b) => b.s - a.s).map((x) => x.m);
}

// state: FourPlayer.state(); opts: { depth, ms, noise }. Returns "from-to[promo]" or null.
export function fpSearch(state, { depth = 2, ms = 1500, noise = 0 } = {}) {
  const g = new FourPlayer(state.mode, state);
  const teams = g.teams;
  const root = g.pos;
  const me = root.turn;
  const friend = (a) => a === me || (teams && a === teammate(me));
  const deadline = Date.now() + ms;
  let nodes = 0, stopped = false;

  function search(pos, d, alpha, beta, ply) {
    if ((++nodes & 255) === 0 && Date.now() > deadline) stopped = true;
    if (stopped) return 0;
    if (pos.status[me] !== "active") return -MATE + ply;
    if (teams && pos.status[teammate(me)] !== "active") return -MATE + ply;
    const c = pos.turn;
    const legal = fpLegal(pos, teams, c);
    if (!legal.length) {
      const mated = fpInCheck(pos, teams, c);
      if (friend(c)) return mated || teams ? -MATE + ply : evaluate(pos, teams, me);
      if (teams) return mated ? MATE - ply : 0;
      // an opponent out of the game: good for us, and play goes on without them
      const next = { ...pos, status: pos.status.map((s, a) => (a === c ? "out" : s)) };
      next.turn = nextMover(next, c);
      return d <= 0 ? evaluate(next, teams, me) + (mated ? 600 : 0) : search(next, d, alpha, beta, ply) + (mated ? 600 : 0);
    }
    if (d <= 0) return evaluate(pos, teams, me);
    const maximise = friend(c);
    let best = maximise ? -Infinity : Infinity;
    for (const m of ordered(legal)) {
      const v = search(child(pos, m, teams), d - 1, alpha, beta, ply + 1);
      if (stopped) return best === Infinity || best === -Infinity ? 0 : best;
      if (maximise) { if (v > best) best = v; if (v > alpha) alpha = v; }
      else { if (v < best) best = v; if (v < beta) beta = v; }
      if (alpha >= beta) break;
    }
    return best;
  }

  let moves = ordered(fpLegal(root, teams, me));
  if (!moves.length) return null;
  let bestMove = moves[0];
  for (let d = 1; d <= depth; d++) {
    let alpha = -Infinity, iterBest = null, iterScore = -Infinity;
    const scored = [];
    for (const m of moves) {
      let v = search(child(root, m, teams), d - 1, noise ? -Infinity : alpha, Infinity, 1);
      if (stopped) break;
      if (noise) v += (Math.random() - 0.5) * noise;
      scored.push({ m, v });
      if (v > iterScore) { iterScore = v; iterBest = m; }
      if (v > alpha) alpha = v;
    }
    if (iterBest) bestMove = iterBest;
    if (stopped) break;
    moves = scored.sort((a, b) => b.v - a.v).map((x) => x.m).concat(moves.filter((m) => !scored.some((x) => x.m === m)));
  }
  return fpSquare(bestMove.from) + "-" + fpSquare(bestMove.to) + (bestMove.promo ? " pnbrqk"[bestMove.promo] : "");
}

export const FP_LEVELS = [
  { id: "easy", name: "Novice", opts: { depth: 1, ms: 400, noise: 250 } },
  { id: "medium", name: "Club", opts: { depth: 3, ms: 1500, noise: 40 } },
  { id: "hard", name: "Expert", opts: { depth: 4, ms: 3000, noise: 0 } },
];

