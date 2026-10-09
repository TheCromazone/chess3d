// 4-Player Chess (chess.com rules): a 14x14 board with its 3x3 corners cut away, Red at the bottom,
// Blue on the left, Yellow at the top and Green on the right, moving in that (clockwise) order.
// Free-for-all: everyone for themselves, scored in points (captures, checkmates, multi-checks);
// the game ends when three players are out. Teams: Red and Yellow against Blue and Green; the
// first team to checkmate an enemy player wins. Shared by the client, the bots and the room server
// (inlined into logic.js, so no imports).

export const FP_COLORS = ["r", "b", "y", "g"];
export const FP_NAMES = { r: "Red", b: "Blue", y: "Yellow", g: "Green" };
const N = 14;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const LETTERS = " pnbrqk";
// a piece is type | owner << 3 | (promoted ? 32 : 0); owner 0..3 = r b y g
const PROMOTED = 32;
const typeOf = (p) => p & 7;
const ownerOf = (p) => (p >> 3) & 3;

// points (free-for-all)
const CAPTURE_POINTS = [0, 1, 3, 5, 5, 9, 20];
const MATE_POINTS = 20, STALEMATE_POINTS = 20, DRAW_POINTS = 10, CLAIM_LEAD = 21;

const valid = (f, r) => f >= 0 && f < N && r >= 0 && r < N && !((f < 3 || f > 10) && (r < 3 || r > 10));
export const fpSquare = (i) => "abcdefghijklmn"[i % N] + (Math.floor(i / N) + 1);
export const fpIndex = (s) => (Number(s.slice(1)) - 1) * N + "abcdefghijklmn".indexOf(s[0]);
export const FP_SQUARES = [];
for (let i = 0; i < N * N; i++) if (valid(i % N, Math.floor(i / N))) FP_SQUARES.push(i);

// each army's geometry: which way its pawns go, its back rank, where it promotes
// fwd: pawn step (df, dr); pawnLine / home: the coordinate (rank for r/y, file for b/g) of its pawns / pieces
const ARMY = [
  { fwd: [0, 1], axis: "r", home: 0, pawns: 1, promoFfa: 7, promoTeams: 10 },     // Red, bottom, moving up
  { fwd: [1, 0], axis: "f", home: 0, pawns: 1, promoFfa: 7, promoTeams: 10 },     // Blue, left, moving right
  { fwd: [0, -1], axis: "r", home: 13, pawns: 12, promoFfa: 6, promoTeams: 3 },   // Yellow, top, moving down
  { fwd: [-1, 0], axis: "f", home: 13, pawns: 12, promoFfa: 6, promoTeams: 3 },   // Green, right, moving left
];
// the back rank from each player's left to right: rook, knight, bishop, queen, king, bishop, knight, rook
const BACK = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
// squares along each back rank from the player's left to right
function backSquares(c) {
  const out = [];
  for (let k = 0; k < 8; k++) {
    if (c === 0) out.push(0 * N + (3 + k));            // Red: d1..k1
    else if (c === 1) out.push((10 - k) * N + 0);      // Blue: a11..a4
    else if (c === 2) out.push(13 * N + (10 - k));     // Yellow: k14..d14
    else out.push((3 + k) * N + 13);                   // Green: n4..n11
  }
  return out;
}
function pawnSquares(c) {
  const a = ARMY[c];
  return backSquares(c).map((i) => {
    const f = i % N, r = Math.floor(i / N);
    return a.axis === "r" ? a.pawns * N + f : r * N + a.pawns;
  });
}

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const LINES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const AROUND = [...DIAGONALS, ...LINES];

const step = (i, df, dr) => {
  const f = (i % N) + df, r = Math.floor(i / N) + dr;
  return valid(f, r) ? r * N + f : -1;
};

// ---- positions ----
// { b: Int8Array(196) (0 = empty), turn: 0..3, status: ["active"|"resigned"|"out"] x4,
//   points: [n x4], castle: [rook squares still able to castle] x4, ep: [{sq, victim, owner}],
//   half: plies since a capture or pawn move, checkedBy: [owner who last checked each king | -1] x4 }
export function fpStart() {
  const b = new Int8Array(N * N);
  for (let c = 0; c < 4; c++) {
    backSquares(c).forEach((i, k) => { b[i] = BACK[k] | (c << 3); });
    for (const i of pawnSquares(c)) b[i] = PAWN | (c << 3);
  }
  return {
    b, turn: 0, status: ["active", "active", "active", "active"], points: [0, 0, 0, 0],
    castle: [0, 1, 2, 3].map((c) => { const s = backSquares(c); return [s[0], s[7]]; }),
    ep: [], half: 0, checkedBy: [-1, -1, -1, -1],
  };
}

export const teammate = (c) => (c + 2) % 4;
// a piece counts (moves, attacks) unless its army is out; a resigned army keeps only its king
function live(pos, p) {
  const st = pos.status[ownerOf(p)];
  return st === "active" || (st === "resigned" && typeOf(p) === KING);
}
export function kingOf(pos, c) {
  for (const i of FP_SQUARES) if (pos.b[i] === (KING | (c << 3))) return i;
  return -1;
}
// can a piece of c take what's on this square? (anything but your own and, in Teams, your partner's)
const enemyOf = (pos, teams, c, p) => p && ownerOf(p) !== c && !(teams && ownerOf(p) === teammate(c));

// is square i attacked by a live piece of any army hostile to c?
export function fpAttacked(pos, teams, i, c) {
  const hostile = (a) => a !== c && !(teams && a === teammate(c));
  return attackedBy(pos, i, hostile);
}
// is square i attacked by army a's own live pieces? (who gave a check)
const attackedByArmy = (pos, i, a) => attackedBy(pos, i, (x) => x === a);

function attackedBy(pos, i, armyOk) {
  const b = pos.b;
  const hostile = (p) => p && armyOk(ownerOf(p)) && live(pos, p);
  for (const [df, dr] of KNIGHT_STEPS) { const j = step(i, df, dr); if (j >= 0 && hostile(b[j]) && typeOf(b[j]) === KNIGHT) return true; }
  for (const [df, dr] of AROUND) { const j = step(i, df, dr); if (j >= 0 && hostile(b[j]) && typeOf(b[j]) === KING) return true; }
  for (const [df, dr] of DIAGONALS) {
    for (let j = step(i, df, dr); j >= 0; j = step(j, df, dr)) {
      const p = b[j];
      if (!p) continue;
      if (hostile(p) && (typeOf(p) === BISHOP || typeOf(p) === QUEEN)) return true;
      break;
    }
  }
  for (const [df, dr] of LINES) {
    for (let j = step(i, df, dr); j >= 0; j = step(j, df, dr)) {
      const p = b[j];
      if (!p) continue;
      if (hostile(p) && (typeOf(p) === ROOK || typeOf(p) === QUEEN)) return true;
      break;
    }
  }
  // pawns: a pawn of army a on square j attacks j + fwd(a) +/- sideways
  for (let a = 0; a < 4; a++) {
    if (!armyOk(a) || pos.status[a] !== "active") continue;
    const [fx, fy] = ARMY[a].fwd;
    const sides = fx === 0 ? [[1, fy], [-1, fy]] : [[fx, 1], [fx, -1]];
    for (const [df, dr] of sides) { const j = step(i, -df, -dr); if (j >= 0 && b[j] === (PAWN | (a << 3))) return true; }
  }
  return false;
}

export function fpInCheck(pos, teams, c) {
  const k = kingOf(pos, c);
  return k >= 0 && fpAttacked(pos, teams, k, c);
}

// moves: { from, to, piece, cap, promo, castle: rook square | -1, ep: victim square | -1 }
function pseudo(pos, teams, c) {
  const out = [];
  const b = pos.b, a = ARMY[c];
  const promoLine = teams ? a.promoTeams : a.promoFfa;
  for (const i of FP_SQUARES) {
    const p = b[i];
    if (!p || ownerOf(p) !== c || !live(pos, p)) continue;
    const t = typeOf(p);
    if (t === PAWN) {
      const [fx, fy] = a.fwd;
      const promoAt = (j) => (a.axis === "r" ? Math.floor(j / N) : j % N) === promoLine;
      const push = (to, cap, ep = -1) => {
        if (promoAt(to)) for (const pr of teams ? [QUEEN, ROOK, BISHOP, KNIGHT] : [QUEEN]) out.push({ from: i, to, piece: p, cap, promo: pr, castle: -1, ep });
        else out.push({ from: i, to, piece: p, cap, promo: 0, castle: -1, ep });
      };
      const one = step(i, fx, fy);
      if (one >= 0 && !b[one]) {
        push(one, 0);
        const onStart = (a.axis === "r" ? Math.floor(i / N) : i % N) === a.pawns;
        const two = step(one, fx, fy);
        if (onStart && two >= 0 && !b[two]) out.push({ from: i, to: two, piece: p, cap: 0, promo: 0, castle: -1, ep: -1, double: one });
      }
      const sides = fx === 0 ? [[1, fy], [-1, fy]] : [[fx, 1], [fx, -1]];
      for (const [df, dr] of sides) {
        const to = step(i, df, dr);
        if (to < 0) continue;
        if (enemyOf(pos, teams, c, b[to])) push(to, b[to]);
        else if (!b[to]) {
          const e = pos.ep.find((x) => x.sq === to && x.owner !== c && !(teams && x.owner === teammate(c)) && b[x.victim] === (PAWN | (x.owner << 3)));
          if (e) push(to, b[e.victim], e.victim);
        }
      }
      continue;
    }
    const steps = t === KNIGHT ? KNIGHT_STEPS : t === BISHOP ? DIAGONALS : t === ROOK ? LINES : AROUND;
    const slides = t === BISHOP || t === ROOK || t === QUEEN;
    for (const [df, dr] of steps) {
      for (let to = step(i, df, dr); to >= 0; to = step(to, df, dr)) {
        const q = b[to];
        if (!q) out.push({ from: i, to, piece: p, cap: 0, promo: 0, castle: -1, ep: -1 });
        else { if (enemyOf(pos, teams, c, q)) out.push({ from: i, to, piece: p, cap: q, promo: 0, castle: -1, ep: -1 }); break; }
        if (!slides) break;
      }
    }
    if (t === KING) castles(pos, teams, c, i, out);
  }
  return out;
}

// castling: the king goes two squares toward an unmoved rook, which lands on the square it crossed
function castles(pos, teams, c, k, out) {
  const back = backSquares(c);
  if (k !== back[4] || !pos.castle[c].length || fpInCheck(pos, teams, c)) return;
  for (const rook of pos.castle[c]) {
    if (pos.b[rook] !== (ROOK | (c << 3))) continue;
    const dir = Math.sign(back.indexOf(rook) - 4);
    const between = dir > 0 ? back.slice(5, 7) : back.slice(1, 4);
    if (between.some((s) => pos.b[s])) continue;
    const pass = [back[4 + dir], back[4 + 2 * dir]];
    if (pass.some((s) => fpAttacked(pos, teams, s, c))) continue;
    out.push({ from: k, to: pass[1], piece: KING | (c << 3), cap: 0, promo: 0, castle: rook, ep: -1, rookTo: pass[0] });
  }
}

// play a move's board part; returns a new position (turn and scoring are handled by fpPlay)
export function fpMake(pos, m) {
  const b = pos.b.slice();
  const c = ownerOf(m.piece);
  b[m.from] = 0;
  if (m.ep >= 0) b[m.ep] = 0;
  b[m.to] = m.promo ? m.promo | (c << 3) | PROMOTED : m.piece;
  if (m.castle >= 0) { b[m.castle] = 0; b[m.rookTo] = ROOK | (c << 3); }
  const castle = pos.castle.map((list, a) => list.filter((r) => b[r] === (ROOK | (a << 3)) && b[backSquares(a)[4]] === (KING | (a << 3))));
  // an en passant chance lasts until its pawn's owner moves again
  const ep = pos.ep.filter((e) => e.owner !== c && b[e.victim] === (PAWN | (e.owner << 3)));
  if (m.double !== undefined) ep.push({ sq: m.double, victim: m.to, owner: c });
  return { ...pos, b, castle, ep, half: typeOf(m.piece) === PAWN || m.cap ? 0 : pos.half + 1 };
}

export function fpLegal(pos, teams, c = pos.turn) {
  return pseudo(pos, teams, c).filter((m) => !fpInCheck(fpMake(pos, m), teams, c));
}

const nextTurn = (pos, from) => {
  for (let k = 1; k <= 4; k++) { const c = (from + k) % 4; if (pos.status[c] !== "out") return c; }
  return from;
};
const activeCount = (pos) => pos.status.filter((s) => s === "active").length;

// a resigned army's king wanders: its move is picked from the position, so every copy agrees
function wanderingMove(pos, teams, c) {
  const ms = fpLegal(pos, teams, c);
  if (!ms.length) return null;
  let h = pos.half * 31 + c;
  for (const i of FP_SQUARES) h = (h * 33 + pos.b[i] + i) >>> 0;
  return ms[h % ms.length];
}

function sanOf(m) {
  if (m.castle >= 0) return backSquares(ownerOf(m.piece)).indexOf(m.castle) === 7 ? "O-O" : "O-O-O";
  const t = typeOf(m.piece);
  return (t === PAWN ? (m.cap ? fpSquare(m.from).replace(/\d+/, "") : "") : LETTERS[t].toUpperCase()) + (m.cap ? "x" : "") + fpSquare(m.to) + (m.promo ? "=" + LETTERS[m.promo].toUpperCase() : "");
}

// moves as text: "h2-h4", promotions "e10-e11q"
export const fpMoveToText = (m) => m.from + "-" + m.to + (m.promotion || "");
export function fpTextToMove(t) {
  const x = /^([a-n](?:1[0-4]|[1-9]))-([a-n](?:1[0-4]|[1-9]))([qrbn])?$/.exec(t || "");
  return x ? { from: x[1], to: x[2], promotion: x[3] || undefined } : null;
}

// The game: position, mode, history. Everything a turn does lives in play(): scoring, checks,
// eliminations at the start of the next player's turn, wandering kings, and the end of the game.
export class FourPlayer {
  // s: saved state, or nothing for a new game; mode "ffa" | "teams"
  constructor(mode = "ffa", s = null) {
    this.mode = mode;
    this.teams = mode === "teams";
    this.pos = s ? { ...s.pos, b: Int8Array.from(s.pos.b) } : fpStart();
    this.log = s ? [...s.log] : [];          // the move list: { c, san } moves and { c, note } events
    this.keys = s ? [...s.keys] : [];
    this.result = s ? s.result : null;
    if (!s) this.keys.push(this.key());
  }
  state() { return { mode: this.mode, pos: { ...this.pos, b: Array.from(this.pos.b) }, log: [...this.log], keys: [...this.keys], result: this.result }; }
  key() { return Array.from(this.pos.b).join(",") + "|" + this.pos.turn + "|" + this.pos.status.join(""); }
  turn() { return FP_COLORS[this.pos.turn]; }
  points() { return [...this.pos.points]; }
  status() { return [...this.pos.status]; }

  // the board for drawing: { sq, color: "r"|"b"|"y"|"g", type, dead, promoted }
  pieces() {
    const out = [];
    for (const i of FP_SQUARES) {
      const p = this.pos.b[i];
      if (p) out.push({ sq: fpSquare(i), color: FP_COLORS[ownerOf(p)], type: LETTERS[typeOf(p)], dead: !live(this.pos, p), promoted: !!(p & PROMOTED) });
    }
    return out;
  }
  inCheck(color) { return fpInCheck(this.pos, this.teams, FP_COLORS.indexOf(color)); }
  kingSquare(color) { const k = kingOf(this.pos, FP_COLORS.indexOf(color)); return k >= 0 ? fpSquare(k) : null; }

  legalMoves() {
    if (this.result) return [];
    return fpLegal(this.pos, this.teams).map((m) => ({ from: fpSquare(m.from), to: fpSquare(m.to), promotion: m.promo ? LETTERS[m.promo] : undefined, captured: !!m.cap }));
  }
  _find(m) {
    return fpLegal(this.pos, this.teams).find((x) => fpSquare(x.from) === m.from && fpSquare(x.to) === m.to && (x.promo ? LETTERS[x.promo] : undefined) === (m.promotion || (x.promo ? "q" : undefined))) || null;
  }
  isLegal(m) { return !this.result && !!this._find(m); }

  // play the side to move's move; returns the events it caused, or null if illegal
  play(m) {
    if (this.result) return null;
    const x = this._find(m);
    if (!x) return null;
    const events = this._apply(x);
    this._advance(events);
    return events;
  }

  _apply(x) {
    const pos = this.pos, c = pos.turn;
    const events = [{ t: "move", color: FP_COLORS[c], from: fpSquare(x.from), to: fpSquare(x.to), san: sanOf(x), captured: x.cap ? LETTERS[typeOf(x.cap)] : null }];
    let next = fpMake(pos, x);
    const points = [...pos.points];
    if (x.cap) {
      const victim = ownerOf(x.cap);
      const worth = this.teams || !live(pos, x.cap) ? 0 : x.cap & PROMOTED ? 1 : CAPTURE_POINTS[typeOf(x.cap)];
      if (worth) { points[c] += worth; events[0].points = worth; }
      if (typeOf(x.cap) === KING && pos.status[victim] !== "out") events.push({ t: "king-taken", color: FP_COLORS[victim], by: FP_COLORS[c] });
    }
    // checks this move gives (and multi-check bonuses in free-for-all)
    const checkedBy = [...pos.checkedBy];
    let checked = 0;
    for (let a = 0; a < 4; a++) {
      if (a === c || (this.teams && a === teammate(c)) || next.status[a] === "out") continue;
      const k = kingOf(next, a);
      if (k >= 0 && attackedByArmy(next, k, c)) { checkedBy[a] = c; checked++; }
    }
    if (checked) events[0].san += "+";
    if (!this.teams && checked >= 2) {
      const queen = typeOf(x.promo || x.piece) === QUEEN;
      const bonus = checked >= 3 ? (queen ? 5 : 20) : (queen ? 1 : 5);
      points[c] += bonus;
      events.push({ t: "multi-check", color: FP_COLORS[c], kings: checked, points: bonus });
    }
    next = { ...next, points, checkedBy };
    this.log.push({ c: FP_COLORS[c], san: events[0].san });
    // a captured king takes its army out (free-for-all) or wins for the captor's team
    for (const e of events.filter((ev) => ev.t === "king-taken")) {
      const v = FP_COLORS.indexOf(e.color);
      next.status = next.status.map((s, i) => (i === v ? "out" : s));
      this.log.push({ c: e.color, note: "lost the king" });
      if (this.teams) this.result = { winner: FP_COLORS[c] === "r" || FP_COLORS[c] === "y" ? "ry" : "bg", reason: "king" };
    }
    this.pos = next;
    return events;
  }

  // pass the turn on, settling whatever happens at the start of each player's turn
  _advance(events) {
    for (let guard = 0; guard < 12 && !this.result; guard++) {
      const pos = this.pos;
      const c = nextTurn(pos, pos.turn);
      this.pos = { ...pos, turn: c };
      if (this._checkEnd(events)) return;
      const legal = fpLegal(this.pos, this.teams, c);
      if (!legal.length) {
        const mated = fpInCheck(this.pos, this.teams, c);
        if (this.teams) {
          this.result = mated ? { winner: c % 2 === 0 ? "bg" : "ry", reason: "checkmate", loser: FP_COLORS[c] } : { winner: null, reason: "stalemate" };
          events.push({ t: mated ? "checkmate" : "stalemate", color: FP_COLORS[c] });
          return;
        }
        // free-for-all: out of the game, with points for the mate (or to themselves for a stalemate)
        const points = [...this.pos.points];
        const by = this.pos.checkedBy[c];
        if (this.pos.status[c] === "resigned") {
          // a wandering king caught: the mate (or the stalemate's share) goes to the others
          const others = [0, 1, 2, 3].filter((a) => a !== c && this.pos.status[a] === "active");
          if (mated && by >= 0) points[by] += MATE_POINTS; else for (const a of others) points[a] += Math.floor(MATE_POINTS / Math.max(1, others.length));
        } else if (mated && by >= 0) points[by] += MATE_POINTS;
        else if (!mated) points[c] += STALEMATE_POINTS;
        this.pos = { ...this.pos, points, status: this.pos.status.map((s, i) => (i === c ? "out" : s)) };
        this.log.push({ c: FP_COLORS[c], note: mated ? "checkmated" : "stalemated" });
        events.push({ t: mated ? "checkmate" : "stalemate", color: FP_COLORS[c], by: mated && by >= 0 ? FP_COLORS[by] : null });
        continue;
      }
      if (this.pos.status[c] === "resigned") {
        // the wandering king moves by itself
        const w = wanderingMove(this.pos, this.teams, c);
        events.push(...this._apply(w).map((e) => ({ ...e, auto: true })));
        if (this.result) return;
        continue;
      }
      this.keys.push(this.key());
      this._checkEnd(events, true);
      return;
    }
  }

  // the game ends when three armies are out (free-for-all), or on a draw rule; afterChange also
  // checks repetition, which only counts once a player is actually to move
  _checkEnd(events, repetition = false) {
    if (this.result) return true;
    const pos = this.pos;
    if (!this.teams) {
      const standing = [0, 1, 2, 3].filter((a) => pos.status[a] === "active");
      if (standing.length <= 1) {
        const points = [...pos.points];
        if (standing.length === 1) {
          // the last player standing collects 20 for every other king still on the board
          const kings = [0, 1, 2, 3].filter((a) => a !== standing[0] && pos.status[a] === "resigned" && kingOf(pos, a) >= 0).length;
          points[standing[0]] += 20 * kings;
        }
        this.pos = { ...pos, points };
        this.result = this._ranking("last-standing");
        events.push({ t: "end", reason: "last-standing" });
        return true;
      }
    }
    let draw = null;
    if (repetition && this.keys.filter((k) => k === this.keys[this.keys.length - 1]).length >= 3) draw = "threefold";
    else if (pos.half >= 50 * Math.max(2, activeCount(pos))) draw = "fifty";
    else if (FP_SQUARES.every((i) => !pos.b[i] || !live(pos, pos.b[i]) || typeOf(pos.b[i]) === KING)) draw = "material";
    if (draw) {
      if (this.teams) this.result = { winner: null, reason: draw };
      else {
        this.pos = { ...pos, points: pos.points.map((p, a) => p + (pos.status[a] === "active" ? DRAW_POINTS : 0)) };
        this.result = this._ranking(draw);
      }
      events.push({ t: "end", reason: draw });
      return true;
    }
    return false;
  }

  // free-for-all standings: most points first (ties keep turn order)
  _ranking(reason) {
    const order = [0, 1, 2, 3].sort((a, c) => this.pos.points[c] - this.pos.points[a]);
    return { reason, ranking: order.map((a) => FP_COLORS[a]), points: [...this.pos.points], winner: FP_COLORS[order[0]] };
  }

  // a player leaves: in free-for-all their army goes grey and the king wanders on; in Teams their team loses
  resign(color) {
    const c = FP_COLORS.indexOf(color);
    if (this.result || this.pos.status[c] !== "active") return [];
    const events = [{ t: "resign", color }];
    this.log.push({ c: color, note: "resigned" });
    if (this.teams) {
      this.result = { winner: c % 2 === 0 ? "bg" : "ry", reason: "resignation", loser: color };
      return events;
    }
    this.pos = { ...this.pos, status: this.pos.status.map((s, i) => (i === c ? "resigned" : s)) };
    if (this._checkEnd(events)) return events;
    // if it was their turn, play on
    if (this.pos.turn === c) {
      const w = wanderingMove(this.pos, this.teams, c);
      if (w) events.push(...this._apply(w).map((e) => ({ ...e, auto: true })));
      this._advance(events);
    }
    return events;
  }

  // free-for-all: with two players left, one 21 or more points ahead may end the game
  canClaim(color) {
    if (this.teams || this.result) return false;
    const c = FP_COLORS.indexOf(color);
    const standing = [0, 1, 2, 3].filter((a) => this.pos.status[a] === "active");
    if (standing.length !== 2 || !standing.includes(c)) return false;
    const rival = standing.find((a) => a !== c);
    return this.pos.points[c] - this.pos.points[rival] >= CLAIM_LEAD;
  }
  claim(color) {
    if (!this.canClaim(color)) return [];
    this.result = this._ranking("claimed");
    return [{ t: "end", reason: "claimed", color }];
  }
}
