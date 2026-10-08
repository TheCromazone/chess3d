// Chess960 on top of chess.js. chess.js can't castle with arbitrary king/rook files, so this
// wrapper strips castling rights from the inner chess.js position and generates castling itself.
// Castling uses Stockfish's UCI_Chess960 convention: the king moves onto its own rook ("e1h1").
// FENs carry Shredder-style castling rights (rook files, e.g. "HAha"); createChess() routes on that.
import { Chess } from "chess.js";

const FILES = "abcdefgh";

export function is960Fen(fen) {
  const c = (fen || "").split(" ")[2] || "-";
  return /[A-Ha-h]/.test(c);
}

// The right engine for a FEN: plain chess.js, or the 960 wrapper when rights name rook files.
export function createChess(fen) {
  if (fen && is960Fen(fen)) return new Chess960(fen);
  return fen ? new Chess(fen) : new Chess();
}

// Scharnagl numbering: n in 0..959; 518 is the standard position.
export function chess960Fen(n = Math.floor(Math.random() * 960)) {
  const back = Array(8).fill(null);
  const free = () => back.map((p, i) => (p ? -1 : i)).filter(i => i >= 0);
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
  const rights = (FILES[back.indexOf("r")] + FILES[back.lastIndexOf("r")]);
  const castle = rights[1].toUpperCase() + rights[0].toUpperCase() + rights[1] + rights[0];
  return `${row}/pppppppp/8/8/8/8/PPPPPPPP/${row.toUpperCase()} w ${castle} - 0 1`;
}

export class Chess960 {
  constructor(fen) {
    this.load(fen);
  }

  load(fen) {
    const parts = fen.trim().split(/\s+/);
    this._rights = { w: new Set(), b: new Set() };
    for (const ch of parts[2] || "-") {
      if (/[A-H]/.test(ch)) this._rights.w.add(ch.toLowerCase());
      else if (/[a-h]/.test(ch)) this._rights.b.add(ch);
      else if (ch === "K" || ch === "Q" || ch === "k" || ch === "q") {
        // X-FEN letters: outermost rook on that side
        const color = ch === ch.toUpperCase() ? "w" : "b";
        const rank = color === "w" ? 0 : 7;
        const row = expandRow(parts[0].split("/")[7 - rank]);
        const kf = row.findIndex(p => p === (color === "w" ? "K" : "k"));
        const rook = color === "w" ? "R" : "r";
        const files = row.map((p, i) => (p === rook ? i : -1)).filter(i => i >= 0);
        const pickF = ch.toLowerCase() === "k" ? files.filter(f => f > kf).pop() : files.find(f => f < kf);
        if (pickF !== undefined) this._rights[color].add(FILES[pickF]);
      }
    }
    parts[2] = "-";
    this._inner = new Chess();
    this._inner.load(parts.join(" "), { skipValidation: true });
    this._history = [];
    this._keys = [this._key()];
  }

  // ---- delegated basics ----
  turn() { return this._inner.turn(); }
  get(sq) { return this._inner.get(sq); }
  board() { return this._inner.board(); }
  inCheck() { return this._inner.inCheck(); }
  isCheck() { return this.inCheck(); }
  isAttacked(sq, by) { return this._inner.isAttacked(sq, by); }
  isInsufficientMaterial() { return this._inner.isInsufficientMaterial(); }
  moveNumber() { return this._inner.moveNumber(); }

  fen() {
    const parts = this._inner.fen().split(" ");
    parts[2] = this._rightsString();
    return parts.join(" ");
  }

  _rightsString() {
    // Shredder-FEN: outer rook first for readability (e.g. "HAha")
    const w = [...this._rights.w].sort().reverse().map(f => f.toUpperCase()).join("");
    const b = [...this._rights.b].sort().reverse().join("");
    return w + b || "-";
  }

  _key() { return this.fen().split(" ").slice(0, 4).join(" "); }

  // ---- move generation ----
  _castles() {
    const color = this.turn();
    if (!this._rights[color].size || this.inCheck()) return [];
    const rank = color === "w" ? "1" : "8";
    const opp = color === "w" ? "b" : "w";
    let kf = -1;
    for (let f = 0; f < 8; f++) { const p = this.get(FILES[f] + rank); if (p && p.type === "k" && p.color === color) kf = f; }
    if (kf < 0) return [];
    const out = [];
    for (const rFile of this._rights[color]) {
      const rf = FILES.indexOf(rFile);
      const rook = this.get(rFile + rank);
      if (!rook || rook.type !== "r" || rook.color !== color) continue;
      const kingside = rf > kf;
      const kt = kingside ? 6 : 2, rt = kingside ? 5 : 3;
      // every square either piece crosses or lands on must be empty, apart from the two castlers
      const span = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); const s = []; for (let i = lo; i <= hi; i++) s.push(i); return s; };
      const need = new Set([...span(kf, kt), ...span(rf, rt)]);
      let ok = true;
      for (const f of need) {
        if (f === kf || f === rf) continue;
        if (this.get(FILES[f] + rank)) { ok = false; break; }
      }
      if (!ok) continue;
      for (const f of span(kf, kt)) if (this.isAttacked(FILES[f] + rank, opp)) { ok = false; break; }
      if (!ok) continue;
      const cand = { kingFrom: FILES[kf] + rank, kingTo: FILES[kt] + rank, rookFrom: rFile + rank, rookTo: FILES[rt] + rank, side: kingside ? "k" : "q" };
      // the castling rook may have been shielding the king's destination along the rank
      if (this._applyCastle(cand, true).isAttacked(cand.kingTo, opp)) continue;
      out.push(cand);
    }
    return out;
  }

  _castleMove(c, includeAfter = true) {
    const color = this.turn();
    const mv = {
      color, piece: "k", from: c.kingFrom, to: c.rookFrom, flags: c.side, san: c.side === "k" ? "O-O" : "O-O-O",
      lan: c.kingFrom + c.rookFrom, castle960: c,
    };
    if (includeAfter) {
      const after = this._applyCastle(c, true);
      if (after.isCheckmate()) mv.san += "#";
      else if (after.inCheck()) mv.san += "+";
      mv.before = this.fen();
      mv.after = after.fen();
    }
    return mv;
  }

  moves({ verbose = false, square } = {}) {
    let ms = this._inner.moves({ verbose: true, square });
    ms = ms.map(m => this._decorate(m));
    const castles = this._castles().filter(c => !square || c.kingFrom === square).map(c => this._castleMove(c));
    // also allow dropping the king on its castling destination when that isn't a normal king move
    const aliases = [];
    for (const cm of castles) {
      const kt = cm.castle960.kingTo;
      if (kt !== cm.castle960.kingFrom && kt !== cm.to && !ms.some(m => m.from === cm.from && m.to === kt)) aliases.push({ ...cm, to: kt, alias: true });
    }
    const all = [...ms, ...castles, ...aliases];
    return verbose ? all : [...new Set(all.map(m => m.san))];
  }

  _decorate(m) {
    // fix SAN check markers is unnecessary (castling can't give discovered checks via chess.js moves)
    return { ...m, before: this.fen(), after: undefined };
  }

  // ---- making moves ----
  move(m) {
    const castles = this._castles();
    let c = null;
    if (typeof m === "string") {
      const s = m.replace(/[+#]/g, "").replace(/0/g, "O");
      if (s === "O-O") c = castles.find(x => x.side === "k");
      else if (s === "O-O-O") c = castles.find(x => x.side === "q");
      else if (/^[a-h][1-8][a-h][1-8]$/.test(s)) m = { from: s.slice(0, 2), to: s.slice(2, 4) };
    }
    if (!c && typeof m === "object") {
      c = castles.find(x => x.kingFrom === m.from && x.rookFrom === m.to) || null;
      if (!c) {
        const alias = castles.find(x => x.kingFrom === m.from && x.kingTo === m.to);
        const normal = this._inner.moves({ verbose: true, square: m.from }).some(x => x.to === m.to);
        if (alias && !normal) c = alias;
      }
    }
    const before = this.fen();
    if (c) {
      const mv = this._castleMove(c, true);
      this._applyCastle(c, false);
      this._history.push({ mv, before });
      this._keys.push(this._key());
      return mv;
    }
    let mv;
    try { mv = this._inner.move(m); } catch (e) { throw e; }
    if (!mv) throw new Error("Invalid move");
    this._updateRights(mv);
    const out = { ...mv, before, after: this.fen() };
    this._history.push({ mv: out, before });
    this._keys.push(this._key());
    return out;
  }

  _updateRights(mv) {
    const color = mv.color, opp = color === "w" ? "b" : "w";
    const home = color === "w" ? "1" : "8", oppHome = color === "w" ? "8" : "1";
    if (mv.piece === "k") this._rights[color].clear();
    if (mv.from[1] === home) this._rights[color].delete(mv.from[0]);
    if (mv.to[1] === oppHome) this._rights[opp].delete(mv.to[0]);
  }

  // Applies a castle. dry=true returns a new Chess960 with the result instead of mutating.
  _applyCastle(c, dry) {
    const color = this.turn();
    const parts = this._inner.fen().split(" ");
    const rows = parts[0].split("/").map(expandRow);
    const r = color === "w" ? 7 : 0;
    const row = rows[r];
    const kf = FILES.indexOf(c.kingFrom[0]), rf = FILES.indexOf(c.rookFrom[0]);
    const K = row[kf], R = row[rf];
    row[kf] = null; row[rf] = null;
    row[FILES.indexOf(c.kingTo[0])] = K;
    row[FILES.indexOf(c.rookTo[0])] = R;
    parts[0] = rows.map(compressRow).join("/");
    parts[1] = color === "w" ? "b" : "w";
    parts[3] = "-";
    parts[4] = String(Number(parts[4]) + 1);
    if (color === "b") parts[5] = String(Number(parts[5]) + 1);
    const rights = { w: new Set(this._rights.w), b: new Set(this._rights.b) };
    rights[color].clear();
    if (dry) {
      const x = Object.create(Chess960.prototype);
      x._rights = rights;
      x._inner = new Chess();
      x._inner.load(parts.join(" "), { skipValidation: true });
      x._history = []; x._keys = [];
      return x;
    }
    this._rights = rights;
    this._inner.load(parts.join(" "), { skipValidation: true });
    return this;
  }

  undo() {
    const last = this._history.pop();
    if (!last) return null;
    this._keys.pop();
    const hist = this._history, keys = this._keys;
    this.load(last.before);
    this._history = hist; this._keys = keys;
    return last.mv;
  }

  history({ verbose = false } = {}) {
    return this._history.map(x => (verbose ? x.mv : x.mv.san));
  }

  // ---- game end ----
  isCheckmate() { return this._inner.isCheckmate(); }
  isStalemate() { return !this.inCheck() && this.moves({ verbose: true }).length === 0; }
  isThreefoldRepetition() {
    const k = this._keys[this._keys.length - 1];
    return this._keys.filter(x => x === k).length >= 3;
  }
  isDraw() {
    const half = Number(this._inner.fen().split(" ")[4] || 0);
    return half >= 100 || this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition();
  }
  isGameOver() { return this.isCheckmate() || this.isDraw(); }
}

function expandRow(s) {
  const out = [];
  for (const ch of s) { if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push(null); else out.push(ch); }
  return out;
}
function compressRow(row) {
  let s = "", n = 0;
  for (const p of row) { if (!p) { n++; continue; } if (n) { s += n; n = 0; } s += p; }
  return s + (n || "");
}

// Boards animate standard castling only; a 960 castle snaps to the resulting position instead.
export function animateOn(board, mv, opts = {}) {
  if (mv && mv.castle960) { board.syncFromBoard(createChess(mv.after).board()); return; }
  board.animateMove(mv, opts);
}
