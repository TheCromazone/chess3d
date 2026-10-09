// Duck Chess, Fog of War, Giveaway, Atomic and Horde: chess.com's other 8x8 variants. chess.js only
// plays standard chess, so these share one small move generator on a 0x88 board (index 0 = a8, the
// same layout chess.js uses), with each variant's rules switched on by flags. Shared by the client,
// the bots (vx-engine.js, in a worker) and the room server (inlined into logic.js, so no imports).

const STD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// duck: a duck is placed after every move and blocks the square; no check, take the king to win
// fog: you only see squares your pieces can move to; no check, take the king to win
// forced: captures are compulsory (Giveaway), and losing every piece or having no move wins
// atomic: captures explode the 8 squares around them (pawns survive); kings can't capture
// horde: White has 36 pawns and no king; Black wins by taking them all
// chess960 / threeCheck / hill: Chess960 (castling with the king onto its rook), Three-check and
// King of the Hill, for online play (their bots use Stockfish elsewhere in the app)
export const VX_VARIANTS = {
  duck: { name: "Duck Chess", start: STD, duck: true, kingCapture: true, stalemate: "win" },
  fog: { name: "Fog of War", start: STD, fog: true, kingCapture: true, stalemate: "draw" },
  giveaway: { name: "Giveaway", start: STD.replace("KQkq", "-"), forced: true, kingPromo: true, stalemate: "win" },
  atomic: { name: "Atomic", start: STD, check: true, atomic: true, stalemate: "draw" },
  horde: { name: "Horde", start: "rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1", check: true, horde: true, stalemate: "draw" },
  chess960: { name: "Chess960", start: STD, check: true, chess960: true, material: true, stalemate: "draw" },
  threecheck: { name: "Three-check", start: STD, check: true, threeCheck: true, stalemate: "draw" },
  koth: { name: "King of the Hill", start: STD, check: true, hill: true, stalemate: "draw" },
};

// Chess960 starting positions by Scharnagl number (518 is the normal setup)
export function vxChess960Fen(n) {
  const back = Array(8).fill(null);
  const free = () => back.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  let k = n;
  back[(k % 4) * 2 + 1] = "b"; k = Math.floor(k / 4);
  back[(k % 4) * 2] = "b"; k = Math.floor(k / 4);
  back[free()[k % 6]] = "q"; k = Math.floor(k / 6);
  const KN = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]][k];
  const f1 = free();
  back[f1[KN[0]]] = "n"; back[f1[KN[1]]] = "n";
  const rest = free();
  back[rest[0]] = "r"; back[rest[1]] = "k"; back[rest[2]] = "r";
  const row = back.join("");
  return `${row}/pppppppp/8/8/8/8/PPPPPPPP/${row.toUpperCase()} w KQkq - 0 1`;
}
const HILL = [51, 52, 67, 68];   // d5 e5 d4 e4

// pieces: type | colour, colour 0 = White, 8 = Black; the duck belongs to nobody
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6, DUCK = 7;
const LETTERS = " pnbrqk";
const TYPE_OF = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
// move flags
const DOUBLE = 1, EP = 2, OO = 4, OOO = 8;

const KNIGHT_STEPS = [-33, -31, -18, -14, 14, 18, 31, 33];
const DIAGONALS = [-17, -15, 15, 17];
const LINES = [-16, -1, 1, 16];
const AROUND = [-17, -16, -15, -1, 1, 15, 16, 17];
const STEPS = { [KNIGHT]: KNIGHT_STEPS, [BISHOP]: DIAGONALS, [ROOK]: LINES, [QUEEN]: AROUND, [KING]: AROUND };

export const vxSquare = (i) => "abcdefgh"[i & 15] + (8 - (i >> 4));
export const vxIndex = (s) => (8 - Number(s[1])) * 16 + "abcdefgh".indexOf(s[0]);
const off = (i) => (i & 0x88) !== 0;          // also true for -128..-1 and 128..255
const colourName = (c) => (c ? "b" : "w");
const isPiece = (p) => p !== 0 && p !== DUCK;

// ---- positions ----
// { b: Int8Array(128), turn: 0|8, castle: [rook squares that may still castle], ep: index|-1, half, full,
//   duck: index|-1, checks?: [given by White, given by Black] (Three-check, FEN field "+w+b") }
export function parsePos(fen) {
  const [rows, turn, castle, ep, half, full, checks] = fen.trim().split(/\s+/);
  const b = new Int8Array(128);
  let duck = -1;
  rows.split("/").forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const i = r * 16 + f++;
      if (ch === "*") { b[i] = DUCK; duck = i; continue; }
      const t = TYPE_OF[ch.toLowerCase()];
      if (t) b[i] = t | (ch === ch.toLowerCase() ? 8 : 0);
    }
  });
  // K/Q (and k/q) mean the outermost rook on that side of the king; a-h name the rook's file (Chess960)
  const rights = [];
  for (const ch of castle || "-") {
    if (!/[KQkqA-Ha-h]/.test(ch)) continue;
    const white = ch === ch.toUpperCase(), row = white ? 7 : 0, rook = ROOK | (white ? 0 : 8);
    const kf = [0, 1, 2, 3, 4, 5, 6, 7].find((f) => b[row * 16 + f] === (KING | (white ? 0 : 8)));
    let file = -1;
    if (ch === "K" || ch === "k") { for (let f = 7; f > (kf ?? 7); f--) if (b[row * 16 + f] === rook) { file = f; break; } }
    else if (ch === "Q" || ch === "q") { for (let f = 0; f < (kf ?? 0); f++) if (b[row * 16 + f] === rook) { file = f; break; } }
    else file = ch.toLowerCase().charCodeAt(0) - 97;
    if (file >= 0 && b[row * 16 + file] === rook && !rights.includes(row * 16 + file)) rights.push(row * 16 + file);
  }
  const cm = /^\+(\d+)\+(\d+)$/.exec(checks || "");
  return {
    b, turn: turn === "b" ? 8 : 0, castle: rights.sort((x, y) => y - x), ep: ep && ep !== "-" ? vxIndex(ep) : -1,
    half: Number(half) || 0, full: Number(full) || 1, duck, checks: cm ? [Number(cm[1]), Number(cm[2])] : undefined,
  };
}

export function posFen(pos) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = "", empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.b[r * 16 + f];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p === DUCK ? "*" : (p & 8 ? LETTERS[p & 7] : LETTERS[p & 7].toUpperCase());
    }
    rows.push(row + (empty ? empty : ""));
  }
  // the outermost rook on a side is written K/Q (as in standard FEN), any other rook by its file
  const letter = (r) => {
    const white = (r >> 4) === 7, row = r & 0x70, rook = ROOK | (white ? 0 : 8);
    const kf = [0, 1, 2, 3, 4, 5, 6, 7].find((f) => pos.b[row + f] === (KING | (white ? 0 : 8))) ?? 4;
    const f = r & 15, side = f > kf ? 1 : -1;
    let outer = true;
    for (let g = f + side; g >= 0 && g < 8; g += side) if (pos.b[row + g] === rook) outer = false;
    const ch = outer ? (side > 0 ? "k" : "q") : "abcdefgh"[f];
    return white ? ch.toUpperCase() : ch;
  };
  const order = (r) => ((r >> 4) === 7 ? 0 : 2) + ((r & 15) > 3 ? 0 : 1);
  const castle = [...pos.castle].sort((x, y) => order(x) - order(y) || (y & 15) - (x & 15)).map(letter).join("") || "-";
  const tail = pos.checks ? ` +${pos.checks[0]}+${pos.checks[1]}` : "";
  return `${rows.join("/")} ${colourName(pos.turn)} ${castle} ${pos.ep >= 0 ? vxSquare(pos.ep) : "-"} ${pos.half} ${pos.full}${tail}`;
}

// what repeats for threefold: everything but the move counters
const posKey = (pos) => posFen(pos).split(" ").slice(0, 4).join(" ");

export function kingAt(b, colour) {
  const k = KING | colour;
  for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (b[i] === k) return i; }
  return -1;
}
function hasPieces(b, colour) {
  for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (isPiece(b[i]) && (b[i] & 8) === colour) return true; }
  return false;
}
const adjacent = (a, c) => Math.abs((a & 15) - (c & 15)) <= 1 && Math.abs((a >> 4) - (c >> 4)) <= 1;

// is `sq` attacked by `by`? (kings count unless kingsAttack is false, as in Atomic where they can't capture)
export function attacked(b, sq, by, kingsAttack = true) {
  const pawn = PAWN | by;
  if (by === 0) { if ((!off(sq + 15) && b[sq + 15] === pawn) || (!off(sq + 17) && b[sq + 17] === pawn)) return true; }
  else if ((!off(sq - 15) && b[sq - 15] === pawn) || (!off(sq - 17) && b[sq - 17] === pawn)) return true;
  for (const d of KNIGHT_STEPS) if (!off(sq + d) && b[sq + d] === (KNIGHT | by)) return true;
  if (kingsAttack) for (const d of AROUND) if (!off(sq + d) && b[sq + d] === (KING | by)) return true;
  for (const d of DIAGONALS) {
    for (let i = sq + d; !off(i); i += d) { const p = b[i]; if (!p) continue; if (p === (BISHOP | by) || p === (QUEEN | by)) return true; break; }
  }
  for (const d of LINES) {
    for (let i = sq + d; !off(i); i += d) { const p = b[i]; if (!p) continue; if (p === (ROOK | by) || p === (QUEEN | by)) return true; break; }
  }
  return false;
}

// in check? (variants without check never are; Horde's White has no king)
export function inCheck(pos, v, colour) {
  if (!v.check) return false;
  const k = kingAt(pos.b, colour);
  if (k < 0) return false;
  if (v.atomic) {
    // touching kings: taking one would blow up the other, so neither can be in check
    const ek = kingAt(pos.b, colour ^ 8);
    if (ek >= 0 && adjacent(k, ek)) return false;
    return attacked(pos.b, k, colour ^ 8, false);
  }
  return attacked(pos.b, k, colour ^ 8, true);
}

// ---- moves: { from, to, piece, cap, promo, flags } on board indexes ----
function pawnMoves(out, from, to, piece, cap, v, lastRow) {
  if ((to >> 4) === lastRow) {
    for (const t of v.kingPromo ? [QUEEN, ROOK, BISHOP, KNIGHT, KING] : [QUEEN, ROOK, BISHOP, KNIGHT]) out.push({ from, to, piece, cap, promo: t, flags: 0 });
  } else out.push({ from, to, piece, cap, promo: 0, flags: 0 });
}

function castleMoves(pos, v, k, out) {
  const us = pos.turn, b = pos.b, row = us ? 0 : 0x70;
  if ((k & 0x70) !== row) return;
  const rooks = pos.castle.filter((r) => (r & 0x70) === row && b[r] === (ROOK | us));
  if (!rooks.length) return;
  // only variants with check forbid castling out of or through an attack
  if (v.check && inCheck(pos, v, us)) return;
  for (const r of rooks) {
    const short = (r & 15) > (k & 15);
    const kingTo = row + (short ? 6 : 2), rookTo = row + (short ? 5 : 3);
    // everything between, and both landing squares, must be empty apart from this king and rook
    const lo = Math.min(k & 15, r & 15, kingTo & 15, rookTo & 15), hi = Math.max(k & 15, r & 15, kingTo & 15, rookTo & 15);
    let clear = true;
    for (let f = lo; f <= hi && clear; f++) { const sq = row + f; if (sq !== k && sq !== r && b[sq]) clear = false; }
    if (!clear) continue;
    if (v.check) {
      const step = (kingTo & 15) > (k & 15) ? 1 : -1;
      let safe = true;
      for (let sq = k; safe; sq += step) {
        if (sq !== k && attacked(b, sq, us ^ 8, !v.atomic)) safe = false;
        if (sq === kingTo) break;
      }
      if (!safe) continue;
    }
    out.push({ from: k, to: v.chess960 ? r : kingTo, piece: KING | us, cap: 0, promo: 0, flags: short ? OO : OOO, rook: r, kingTo, rookTo });
  }
}

// every move ignoring check (the duck blocks like a wall and can't be taken)
export function pseudoMoves(pos, v) {
  const out = [];
  const b = pos.b, us = pos.turn, them = us ^ 8;
  const enemy = (p) => isPiece(p) && (p & 8) === them;
  for (let i = 0; i < 120; i++) {
    if (off(i)) { i += 7; continue; }
    const p = b[i];
    if (!isPiece(p) || (p & 8) !== us) continue;
    const t = p & 7;
    if (t === PAWN) {
      const dir = us ? 16 : -16, lastRow = us ? 7 : 0, row = i >> 4;
      const one = i + dir;
      if (!off(one) && !b[one]) {
        pawnMoves(out, i, one, p, 0, v, lastRow);
        // Horde's first-rank pawns may also step two squares
        const start = us ? row === 1 : row === 6 || (v.horde && row === 7);
        if (start && !off(one + dir) && !b[one + dir]) out.push({ from: i, to: one + dir, piece: p, cap: 0, promo: 0, flags: DOUBLE });
      }
      for (const d of us ? [15, 17] : [-15, -17]) {
        const to = i + d;
        if (off(to)) continue;
        if (enemy(b[to])) pawnMoves(out, i, to, p, b[to], v, lastRow);
        else if (to === pos.ep && !b[to] && b[to - dir] === (PAWN | them)) out.push({ from: i, to, piece: p, cap: PAWN | them, promo: 0, flags: EP });
      }
      continue;
    }
    const slides = t === BISHOP || t === ROOK || t === QUEEN;
    for (const d of STEPS[t]) {
      for (let to = i + d; !off(to); to += d) {
        const q = b[to];
        if (!q) out.push({ from: i, to, piece: p, cap: 0, promo: 0, flags: 0 });
        else {
          if (enemy(q) && !(v.atomic && t === KING)) out.push({ from: i, to, piece: p, cap: q, promo: 0, flags: 0 });
          break;
        }
        if (!slides) break;
      }
    }
    if (t === KING && !v.forced) castleMoves(pos, v, i, out);
  }
  return out;
}

// play a move's piece part (the duck moves separately); returns a new position
export function makeMove(pos, m, v) {
  const b = pos.b.slice();
  const us = pos.turn;
  b[m.from] = 0;
  if (m.flags & EP) b[m.to + (us ? -16 : 16)] = 0;
  if (m.flags & (OO | OOO)) { b[m.rook] = 0; b[m.kingTo] = KING | us; b[m.rookTo] = ROOK | us; }
  else b[m.to] = m.promo ? m.promo | us : m.piece;
  if (v.atomic && m.cap) {
    // the capturing piece, the captured piece and every non-pawn next to them are destroyed
    b[m.to] = 0;
    for (const d of AROUND) { const s = m.to + d; if (!off(s) && isPiece(b[s]) && (b[s] & 7) !== PAWN) b[s] = 0; }
  }
  // a king that moves loses both rights; a rook that moves or is taken loses its own
  // (and a king taken or blown up takes its rights with it)
  const castle = pos.castle.length ? pos.castle.filter((r) => {
    const side = (r >> 4) === 7 ? 0 : 8, row = r & 0x70;
    if ((m.piece & 7) === KING && (m.piece & 8) === side) return false;
    let king = false;
    for (let f = 0; f < 8; f++) if (b[row + f] === (KING | side)) king = true;
    return king && b[r] === (ROOK | side);
  }) : pos.castle;
  const reset = (m.piece & 7) === PAWN || m.cap;
  const next = {
    b, turn: us ^ 8, castle,
    ep: m.flags & DOUBLE ? (m.from + m.to) >> 1 : -1,
    half: reset ? 0 : pos.half + 1,
    full: pos.full + (us ? 1 : 0),
    duck: pos.duck,
    checks: pos.checks,
  };
  // Three-check counts every check given
  if (v.threeCheck && inCheck(next, v, us ^ 8)) next.checks = us ? [next.checks[0], next.checks[1] + 1] : [next.checks[0] + 1, next.checks[1]];
  return next;
}

export function placeDuck(pos, sq) {
  const b = pos.b.slice();
  if (pos.duck >= 0 && b[pos.duck] === DUCK) b[pos.duck] = 0;
  b[sq] = DUCK;
  return { ...pos, b, duck: sq };
}

// does this move leave the mover's own king safe? (only asked in variants with check)
function keepsKingSafe(pos, m, v) {
  const after = makeMove(pos, m, v);
  const us = pos.turn;
  if (v.atomic) {
    if (kingAt(after.b, us) < 0) return false;          // never blow up your own king
    if (kingAt(after.b, us ^ 8) < 0) return true;       // blowing up theirs wins on the spot
  }
  return !inCheck(after, v, us);
}

export function legalMoves(pos, v) {
  let ms = pseudoMoves(pos, v);
  if (v.forced) { const caps = ms.filter((m) => m.cap); if (caps.length) ms = caps; }
  if (v.check) ms = ms.filter((m) => keepsKingSafe(pos, m, v));
  return ms;
}

// where the duck may go after a move: any empty square except where it already is
export function duckSquares(after) {
  const out = [];
  for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (!after.b[i] && i !== after.duck) out.push(i); }
  return out;
}

// { over, winner: "w"|"b"|null, reason } for the side to move, given its legal moves
export function vxOutcome(pos, v, legal, keys = []) {
  const us = pos.turn, them = us ^ 8;
  if (v.threeCheck && pos.checks && pos.checks[them ? 1 : 0] >= 3) return { over: true, winner: colourName(them), reason: "threecheck" };
  if (v.hill && HILL.includes(kingAt(pos.b, them))) return { over: true, winner: colourName(them), reason: "hill" };
  if ((v.kingCapture || v.atomic) && kingAt(pos.b, us) < 0) return { over: true, winner: colourName(them), reason: v.atomic ? "explosion" : "king" };
  if (v.horde && !hasPieces(pos.b, 0)) return { over: true, winner: "b", reason: "horde" };
  if (v.forced && !hasPieces(pos.b, us)) return { over: true, winner: colourName(us), reason: "no-pieces" };
  if (!legal.length) {
    if (v.stalemate === "win") return { over: true, winner: colourName(us), reason: "stalemate-win" };
    if (inCheck(pos, v, us)) return { over: true, winner: colourName(them), reason: "checkmate" };
    return { over: true, winner: null, reason: "stalemate" };
  }
  if (v.material) {
    // bare kings, or a lone knight or bishop, can't mate
    const rest = [];
    for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } const p = pos.b[i]; if (isPiece(p) && (p & 7) !== KING) rest.push(p & 7); }
    if (!rest.length || (rest.length === 1 && (rest[0] === KNIGHT || rest[0] === BISHOP))) return { over: true, winner: null, reason: "material" };
  }
  if (v.atomic) {
    let pieces = 0;
    for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (isPiece(pos.b[i])) pieces++; }
    if (pieces <= 2) return { over: true, winner: null, reason: "material" };
  }
  if (pos.half >= 100) return { over: true, winner: null, reason: "fifty" };
  const k = posKey(pos);
  if (keys.filter((x) => x === k).length >= 3) return { over: true, winner: null, reason: "threefold" };
  return { over: false };
}

// squares a side can see in Fog of War: its own pieces and everywhere they could move
export function visibleFrom(pos, v, colour) {
  const seen = new Set();
  const asMover = { ...pos, turn: colour, ep: pos.turn === colour ? pos.ep : -1 };
  for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (isPiece(pos.b[i]) && (pos.b[i] & 8) === colour) seen.add(i); }
  for (const m of pseudoMoves(asMover, v)) {
    seen.add(m.to);
    if (m.flags & EP) seen.add(m.to + (colour ? -16 : 16));
  }
  return seen;
}

// the position as `colour` sees it in Fog of War (hidden enemy pieces removed)
export function foggedPos(pos, v, colour) {
  const seen = visibleFrom(pos, v, colour);
  const b = pos.b.slice();
  for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (!seen.has(i)) b[i] = 0; }
  return { ...pos, b, ep: seen.has(pos.ep) ? pos.ep : -1 };
}

function sanOf(pos, m, v, legal) {
  let s;
  if (m.flags & OO) s = "O-O";
  else if (m.flags & OOO) s = "O-O-O";
  else {
    const t = m.piece & 7;
    if (t === PAWN) s = (m.cap ? vxSquare(m.from)[0] + "x" : "") + vxSquare(m.to);
    else {
      const rivals = legal.filter((x) => x.to === m.to && x.piece === m.piece && x.from !== m.from);
      let dis = "";
      if (rivals.length) {
        const sameFile = rivals.some((x) => (x.from & 15) === (m.from & 15));
        const sameRank = rivals.some((x) => (x.from >> 4) === (m.from >> 4));
        dis = !sameFile ? vxSquare(m.from)[0] : !sameRank ? vxSquare(m.from)[1] : vxSquare(m.from);
      }
      s = LETTERS[t].toUpperCase() + dis + (m.cap ? "x" : "") + vxSquare(m.to);
    }
    if (m.promo) s += "=" + LETTERS[m.promo].toUpperCase();
  }
  if (v.check) {
    const after = makeMove(pos, m, v);
    const them = pos.turn ^ 8;
    if (v.atomic && kingAt(after.b, them) < 0) s += "#";
    else if (inCheck(after, v, them)) s += legalMoves(after, v).length ? "+" : "#";
  }
  return s;
}

// "e2e4", "e7e8q", Duck Chess adds where the duck went: "e2e4,d5"
export function vxMoveToText(m) { return m.from + m.to + (m.promotion || "") + (m.duck ? "," + m.duck : ""); }
export function vxTextToMove(t) {
  const x = /^([a-h][1-8])([a-h][1-8])([qrbnk])?(?:,([a-h][1-8]))?$/.exec(t || "");
  return x ? { from: x[1], to: x[2], promotion: x[3] || undefined, duck: x[4] || undefined } : null;
}

// The game: a position plus its history for repetition. Board-facing methods mirror chess.js
// (get, board, moves, turn) so the shared move input and board renderers work unchanged.
export class VxGame {
  constructor(variant, s = {}) {
    this.variant = variant;
    this.v = VX_VARIANTS[variant];
    this.pos = parsePos(s.fen || (this.v.chess960 ? vxChess960Fen(s.start ?? 518) : this.v.start));
    if (this.v.threeCheck && !this.pos.checks) this.pos.checks = [0, 0];
    this.keys = [...(s.keys || [])];
    if (!this.keys.length) this.keys.push(posKey(this.pos));
  }

  state() { return { variant: this.variant, fen: posFen(this.pos), keys: [...this.keys] }; }
  get fen() { return posFen(this.pos); }
  turn() { return colourName(this.pos.turn); }
  duck() { return this.pos.duck >= 0 ? vxSquare(this.pos.duck) : null; }

  _legal() {
    const f = posFen(this.pos);
    if (this._legalFen !== f) { this._legalFen = f; this._legalList = legalMoves(this.pos, this.v); }
    return this._legalList;
  }

  // chess.js-style views of the board (the duck isn't a piece, so it's drawn separately)
  get(sq) {
    const p = this.pos.b[vxIndex(sq)];
    return isPiece(p) ? { type: LETTERS[p & 7], color: colourName(p & 8) } : null;
  }
  board(pos = this.pos) {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) { const p = pos.b[r * 16 + f]; row.push(isPiece(p) ? { type: LETTERS[p & 7], color: colourName(p & 8), square: vxSquare(r * 16 + f) } : null); }
      rows.push(row);
    }
    return rows;
  }
  moves({ square = null } = {}) {
    return this._legal().filter((m) => !square || vxSquare(m.from) === square).map((m) => this._public(m));
  }
  _public(m) {
    return { from: vxSquare(m.from), to: vxSquare(m.to), promotion: m.promo ? LETTERS[m.promo] : undefined, captured: m.cap ? LETTERS[m.cap & 7] : undefined, piece: LETTERS[m.piece & 7], flags: (m.flags & EP ? "e" : "") + (m.flags & OO ? "k" : "") + (m.flags & OOO ? "q" : "") + (m.cap ? "c" : ""), castle960: !!(this.v.chess960 && m.flags & (OO | OOO)) };
  }
  _find(m) {
    if (!m) return null;
    return this._legal().find((x) => vxSquare(x.from) === m.from && vxSquare(x.to) === m.to && (x.promo ? LETTERS[x.promo] : null) === (m.promotion || null)) || null;
  }

  inCheck() { return inCheck(this.pos, this.v, this.pos.turn); }
  checksGiven(colour) { return this.pos.checks ? this.pos.checks[colour === "b" ? 1 : 0] : 0; }
  kingSquare(colour) { const k = kingAt(this.pos.b, colour === "b" ? 8 : 0); return k >= 0 ? vxSquare(k) : null; }

  // Duck Chess: after this move (piece part only), where may the duck go? [] when the move takes the king
  duckOptions(m) {
    const x = this._find(m);
    if (!x || !this.v.duck) return [];
    if ((x.cap & 7) === KING) return [];
    return duckSquares(makeMove(this.pos, x, this.v)).map(vxSquare);
  }
  // the board after a move's piece part, for showing it while the duck is being placed
  previewBoard(m) { const x = this._find(m); return x ? this.board(makeMove(this.pos, x, this.v)) : this.board(); }

  isLegal(m) {
    const x = this._find(m);
    if (!x) return false;
    if (!this.v.duck) return !m.duck;
    if ((x.cap & 7) === KING) return !m.duck;
    return !!m.duck && duckSquares(makeMove(this.pos, x, this.v)).includes(vxIndex(m.duck));
  }

  // play a move; returns { color, from, to, piece, captured, promotion, duck, san, flags, exploded } or null
  move(m) {
    if (!this.isLegal(m)) return null;
    const x = this._find(m);
    const legal = this._legal();
    const colour = this.turn();
    let san = sanOf(this.pos, x, this.v, legal);
    let after = makeMove(this.pos, x, this.v);
    const exploded = [];
    if (this.v.atomic && x.cap) {
      for (let i = 0; i < 120; i++) { if (off(i)) { i += 7; continue; } if (isPiece(this.pos.b[i]) && !after.b[i] && i !== x.from) exploded.push(vxSquare(i)); }
    }
    if (m.duck) { after = placeDuck(after, vxIndex(m.duck)); san += "@" + m.duck; }
    this.pos = after;
    this.keys.push(posKey(after));
    return { ...this._public(x), color: colour, duck: m.duck || null, san, exploded };
  }

  outcome() { return vxOutcome(this.pos, this.v, this._legal(), this.keys); }

  // Fog of War: the squares `colour` can see, and the board with everything else hidden
  visible(colour) { return [...visibleFrom(this.pos, this.v, colour === "b" ? 8 : 0)].map(vxSquare); }
  foggedBoard(colour) { return this.board(foggedPos(this.pos, this.v, colour === "b" ? 8 : 0)); }
  foggedFen(colour) { return posFen(foggedPos(this.pos, this.v, colour === "b" ? 8 : 0)); }
}
