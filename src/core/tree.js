// Move tree: the main line plus variations. Games use only the main line; analysis branches.
import { Chess } from "chess.js";
import { createChess, is960Fen } from "./chess960.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
let nextId = 1;

export class MoveTree {
  constructor(startFen = START_FEN) {
    this.root = { id: 0, parent: null, children: [], fen: startFen, ply: plyOfFen(startFen), san: null, uci: null, move: null };
    this.byId = new Map([[0, this.root]]);
  }

  get startFen() { return this.root.fen; }

  // Plays `mvIn` (SAN string or {from,to,promotion}) from `node`; reuses an existing identical child.
  play(node, mvIn) {
    const c = createChess(node.fen);
    let mv;
    try { mv = c.move(mvIn); } catch { return null; }
    const uci = mv.from + mv.to + (mv.promotion || "");
    const existing = node.children.find(ch => ch.uci === uci);
    if (existing) return existing;
    const child = { id: nextId++, parent: node, children: [], fen: c.fen(), ply: node.ply + 1, san: mv.san, uci, move: mv };
    node.children.push(child);
    this.byId.set(child.id, child);
    return child;
  }

  get(id) { return this.byId.get(id) || null; }

  mainline(from = this.root) {
    const out = [];
    let n = from;
    while (n.children.length) { n = n.children[0]; out.push(n); }
    return out;
  }

  lastMain() { let n = this.root; while (n.children.length) n = n.children[0]; return n; }

  path(node) {
    const out = [];
    for (let n = node; n && n.parent; n = n.parent) out.push(n);
    return out.reverse();
  }

  isMainline(node) {
    for (let n = node; n.parent; n = n.parent) if (n.parent.children[0] !== n) return false;
    return true;
  }

  promote(node) {
    for (let n = node; n.parent; n = n.parent) {
      const sibs = n.parent.children;
      const i = sibs.indexOf(n);
      if (i > 0) { sibs.splice(i, 1); sibs.unshift(n); }
    }
  }

  remove(node) {
    if (!node.parent) return;
    const sibs = node.parent.children;
    sibs.splice(sibs.indexOf(node), 1);
    const drop = (n) => { this.byId.delete(n.id); n.children.forEach(drop); };
    drop(node);
  }

  // chess.js instance replayed up to `node` (history available for repetition checks)
  chessAt(node) {
    const c = createChess(this.root.fen);
    for (const n of this.path(node)) c.move(n.uci.length > 4 ? { from: n.uci.slice(0, 2), to: n.uci.slice(2, 4), promotion: n.uci[4] } : { from: n.uci.slice(0, 2), to: n.uci.slice(2, 4) });
    return c;
  }

  toPgn(headers = {}) {
    const hs = { Event: "Casual game", Site: "Chess 3D", Date: pgnDate(new Date()), White: "?", Black: "?", Result: "*", ...headers };
    if (this.root.fen !== START_FEN) { hs.SetUp = "1"; hs.FEN = this.root.fen; }
    if (is960Fen(this.root.fen) && !hs.Variant) hs.Variant = "Chess960";
    const head = Object.entries(hs).map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join("\n");
    const out = [];
    const walk = (node, forceNum) => {
      // node's children[0] is the main continuation; others are variations
      if (!node.children.length) return;
      const [main, ...vars] = node.children;
      out.push(moveToken(main, forceNum));
      for (const v of vars) {
        out.push("(");
        out.push(moveToken(v, true));
        walk(v, false);
        out.push(")");
      }
      walk(main, vars.length > 0);
    };
    walk(this.root, true);
    out.push(hs.Result);
    return head + "\n\n" + wrap(out.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")"), 80) + "\n";
  }

  // Real-world PGNs: tags with no blank line before the moves, castling written with zeros,
  // Windows line endings. chess.js is strict about all three.
  static normalizePgn(pgn) {
    let t = String(pgn || "").replace(/\r\n?/g, "\n").trim();
    t = t.replace(/^((?:\s*\[[^\]\n]*\]\s*\n)+)(?!\s*\n)/, (m) => m.replace(/\n*$/, "") + "\n\n");
    t = t.replace(/\b0-0-0\b/g, "O-O-O").replace(/\b0-0\b(?![-\d])/g, "O-O");
    return t;
  }

  static fromPgn(pgn) {
    pgn = MoveTree.normalizePgn(pgn);
    // chess.js rejects Shredder castling rights, so Chess960 movetext is replayed here
    const fenTag = /\[FEN\s+"([^"]+)"\]/.exec(pgn);
    if (fenTag && is960Fen(fenTag[1])) {
      const headers = {};
      for (const m of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) headers[m[1]] = m[2];
      let text = pgn.replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ").replace(/;[^\n]*/g, " ");
      for (let prev = null; prev !== text;) { prev = text; text = text.replace(/\([^()]*\)/g, " "); }
      const tree = new MoveTree(fenTag[1]);
      let node = tree.root;
      for (let tok of text.split(/\s+/)) {
        tok = tok.replace(/^\d+\.+/, "");
        if (!tok || /^(\$\d+|1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
        const next = tree.play(node, tok.replace(/[?!]+$/, ""));
        if (!next) throw new Error("Illegal move in PGN: " + tok);
        node = next;
      }
      return { tree, headers };
    }
    const c = createChess();
    c.loadPgn(pgn);
    const headers = c.header();
    const startFen = headers.FEN || START_FEN;
    const tree = new MoveTree(startFen);
    let node = tree.root;
    for (const m of c.history({ verbose: true })) node = tree.play(node, { from: m.from, to: m.to, promotion: m.promotion });
    return { tree, headers };
  }

  static fromMoves(moves, startFen = START_FEN) {
    const tree = new MoveTree(startFen);
    let node = tree.root;
    for (const m of moves) {
      const next = tree.play(node, typeof m === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)
        ? { from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] } : m);
      if (!next) break;
      node = next;
    }
    return tree;
  }
}

function plyOfFen(fen) {
  const parts = fen.split(" ");
  return (Number(parts[5] || 1) - 1) * 2 + (parts[1] === "b" ? 1 : 0);
}

function moveToken(node, forceNum) {
  const moveNo = Math.floor((node.ply - 1) / 2) + 1;
  const white = node.ply % 2 === 1;
  if (white) return `${moveNo}. ${node.san}`;
  return forceNum ? `${moveNo}... ${node.san}` : node.san;
}

function wrap(text, width) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) { lines.push(line); line = w; } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function pgnDate(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

export function kingSquare(chess, color) {
  const b = chess.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const c = b[r][f];
    if (c && c.type === "k" && c.color === color) return "abcdefgh"[f] + (8 - r);
  }
  return null;
}

// Captured pieces derived from the board (works for any start position)
const FULL = { p: 8, n: 2, b: 2, r: 2, q: 1 };
export function capturedFromFen(fen) {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(" ")[0]) {
    const lower = ch.toLowerCase();
    if (!(lower in FULL)) continue;
    counts[ch === lower ? "b" : "w"][lower]++;
  }
  const out = { w: [], b: [] };   // pieces of that color that are missing
  for (const color of ["w", "b"]) {
    for (const t of ["p", "n", "b", "r", "q"]) {
      const missing = Math.max(0, FULL[t] - counts[color][t]);
      for (let i = 0; i < missing; i++) out[color].push(t);
    }
  }
  // promotions make "missing" negative for pawns + extra pieces; material diff handles it
  const V = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let wMat = 0, bMat = 0;
  for (const t of Object.keys(V)) { wMat += counts.w[t] * V[t]; bMat += counts.b[t] * V[t]; }
  return { captured: out, diff: wMat - bMat };
}
