// Crazyhouse rules on top of chess.js. A captured piece joins the capturer's pocket and can later
// be dropped onto any empty square instead of a move (pawns never on the first or last rank).
// A promoted piece goes back to the pocket as a pawn. Shared by the client and the room server,
// and by Bughouse (where captures go to your partner's pocket instead of yours).
import { Chess } from "chess.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const POCKET_ORDER = ["q", "r", "b", "n", "p"];
export const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILES = "abcdefgh";
const SQUARES = [];
for (let r = 1; r <= 8; r++) for (const f of FILES) SQUARES.push(f + r);

export const emptyPockets = () => ({ w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } });
const other = (c) => (c === "w" ? "b" : "w");

export function boardOf(fen) {
  const c = new Chess();
  c.load(fen, { skipValidation: true });
  return c;
}

function kingSq(c, color) {
  for (const sq of SQUARES) { const p = c.get(sq); if (p && p.type === "k" && p.color === color) return sq; }
  return null;
}

export class Crazyhouse {
  // s: { fen, pockets, promoted: [squares], keys: [position keys, for repetition] }
  // feed(color, type): where a captured piece goes; default is the capturer's own pocket
  constructor(s = {}, { feed = null } = {}) {
    this.fen = s.fen || START_FEN;
    this.pockets = s.pockets ? JSON.parse(JSON.stringify(s.pockets)) : emptyPockets();
    this.promoted = [...(s.promoted || [])];
    this.keys = [...(s.keys || [])];
    this.feed = feed;
    if (!this.keys.length) this.keys.push(this.key());    // the starting position counts toward repetition
  }

  state() { return { fen: this.fen, pockets: JSON.parse(JSON.stringify(this.pockets)), promoted: [...this.promoted], keys: [...this.keys] }; }
  turn() { return this.fen.split(" ")[1]; }
  chess() { return boardOf(this.fen); }
  inCheck() { return this.chess().inCheck(); }
  key() { return this.fen.split(" ").slice(0, 4).join(" ") + " " + JSON.stringify(this.pockets); }

  // every legal move: board moves {from, to, promotion} and drops {drop, to}; cached per position
  legalMoves() {
    const k = this.key();
    if (this._legalKey === k) return this._legal;
    this._legalKey = k;
    this._legal = this._generate();
    return this._legal;
  }

  _generate() {
    const c = this.chess();
    const color = c.turn();
    const out = c.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promotion: m.promotion, captured: m.captured, san: m.san }));
    const types = POCKET_ORDER.filter((t) => this.pockets[color][t] > 0);
    if (!types.length) return out;
    const checked = c.inCheck();
    const ks = checked ? kingSq(c, color) : null;
    for (const sq of SQUARES) {
      if (c.get(sq)) continue;
      // a drop never exposes your own king; in check it has to block
      let blocks = true;
      if (checked) {
        // any piece blocks a line equally well; place one straight on chess.js's 0x88 board
        const i = (8 - Number(sq[1])) * 16 + FILES.indexOf(sq[0]);
        c._board[i] = { type: "n", color };
        blocks = !c.isAttacked(ks, other(color));
        delete c._board[i];
      }
      if (!blocks) continue;
      for (const t of types) {
        if (t === "p" && (sq[1] === "1" || sq[1] === "8")) continue;
        out.push({ drop: t, to: sq, san: (t === "p" ? "" : t.toUpperCase()) + "@" + sq });
      }
    }
    return out;
  }

  isLegal(m) {
    return this.legalMoves().some((x) => (m.drop ? x.drop === m.drop && x.to === m.to
      : x.from === m.from && x.to === m.to && (x.promotion || null) === (m.promotion || null)));
  }

  // Play a move; returns a description { color, from, to, drop, promotion, captured, san } or null
  move(m) {
    if (!m || !this.isLegal(m)) return null;
    const c = this.chess();
    const color = c.turn();
    let desc;
    if (m.drop) {
      c.put({ type: m.drop, color }, m.to);
      this.pockets[color][m.drop]--;
      const parts = c.fen().split(" ");
      parts[1] = other(color);
      parts[3] = "-";
      parts[4] = m.drop === "p" ? "0" : String(Number(parts[4]) + 1);
      if (color === "b") parts[5] = String(Number(parts[5]) + 1);
      this.fen = parts.join(" ");
      desc = { color, to: m.to, drop: m.drop, san: (m.drop === "p" ? "" : m.drop.toUpperCase()) + "@" + m.to };
    } else {
      const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion });
      if (!mv) return null;
      if (mv.captured) {
        const capSq = mv.flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to;
        const type = this.promoted.includes(capSq) ? "p" : mv.captured;
        this.promoted = this.promoted.filter((s) => s !== capSq);
        if (this.feed) this.feed(color, type); else this.pockets[color][type]++;
      }
      if (this.promoted.includes(mv.from)) this.promoted = this.promoted.filter((s) => s !== mv.from).concat(mv.to);
      if (mv.promotion) this.promoted.push(mv.to);
      this.fen = c.fen();
      desc = { color, from: mv.from, to: mv.to, promotion: mv.promotion, captured: mv.captured, san: mv.san.replace(/[+#]$/, ""), flags: mv.flags };
    }
    const after = this.chess();
    if (after.inCheck()) desc.san += this.legalMoves().length ? "+" : "#";
    this.keys.push(this.key());
    return desc;
  }

  // { over, winner: "w"|"b"|null, reason } — no insufficient-material or 50-move draws in Crazyhouse
  outcome() {
    const moves = this.legalMoves();
    if (!moves.length) {
      const c = this.chess();
      return c.inCheck() ? { over: true, winner: other(c.turn()), reason: "checkmate" } : { over: true, winner: null, reason: "stalemate" };
    }
    const k = this.key();
    if (this.keys.filter((x) => x === k).length >= 3) return { over: true, winner: null, reason: "threefold" };
    return { over: false };
  }
}

// "N@f3" / "e2e4" / "e7e8q" / "P@e4" <-> move objects (UCI-style text for the wire and the record)
export function moveToText(m) { return m.drop ? m.drop.toUpperCase() + "@" + m.to : m.from + m.to + (m.promotion || ""); }
export function textToMove(t) {
  const d = /^([PNBRQ])@([a-h][1-8])$/.exec(t || "");
  if (d) return { drop: d[1].toLowerCase(), to: d[2] };
  const u = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(t || "");
  return u ? { from: u[1], to: u[2], promotion: u[3] || undefined } : null;
}
