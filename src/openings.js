// Opening names + a tiny opening explorer, backed by public/data/openings.json
// (built by tools/build-openings.mjs from lichess-org/chess-openings, CC0).
//
// The data maps a position key (first 4 FEN fields: placement, side, castling, ep, exactly as
// chess.js prints them) to [eco, name]. Browser module: no Node APIs.
import { Chess } from "chess.js";

const DATA_URL = "./data/openings.json";

let table = null;    // Map<positionKey, [eco, name]> once loaded
let loading = null;  // in-flight / settled promise

/**
 * Fetch the opening book once and cache it. Safe to call repeatedly (concurrent calls share
 * one request). Always resolves: true if the book is available, false if the fetch failed
 * (then every lookup returns null / [] / false). A failed load is retried on the next call.
 * @returns {Promise<boolean>}
 */
export function loadOpenings() {
  if (table) return Promise.resolve(true);
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        table = new Map(Object.entries(data));
        return true;
      } catch (err) {
        console.warn("[openings] could not load " + DATA_URL + ":", err);
        loading = null; // allow a later retry
        return false;
      }
    })();
  }
  return loading;
}

/** @returns {boolean} whether the opening book has been loaded. */
export function openingsLoaded() {
  return table !== null;
}

// --- position keys -----------------------------------------------------------------------

function pieceAt(rows, file, rank) {
  // rows[0] is rank 8; returns the FEN letter or "" for empty / off-board
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return "";
  const row = rows[8 - rank];
  if (!row) return "";
  let f = 0;
  for (const ch of row) {
    if (ch >= "1" && ch <= "8") {
      f += ch.charCodeAt(0) - 48;
      if (f > file) return "";
    } else {
      if (f === file) return ch;
      f++;
    }
  }
  return "";
}

// chess.js only prints an en-passant square when a pawn of the side to move could actually
// capture there; FENs from other sources often print it after every double push. Mirror
// chess.js so keys match either way.
function normalizeEp(placement, side, ep) {
  if (!/^[a-h][36]$/.test(ep)) return "-";
  const rows = placement.split("/");
  const file = ep.charCodeAt(0) - 97;
  const rank = +ep[1];
  const white = side === "w";
  if ((white && rank !== 6) || (!white && rank !== 3)) return "-";
  const pawnRank = white ? 5 : 4;          // the pawn that just double-pushed
  const startRank = white ? 7 : 2;
  const enemyPawn = white ? "p" : "P";
  const ownPawn = white ? "P" : "p";
  if (pieceAt(rows, file, startRank) || pieceAt(rows, file, rank)) return "-";
  if (pieceAt(rows, file, pawnRank) !== enemyPawn) return "-";
  if (pieceAt(rows, file - 1, pawnRank) === ownPawn || pieceAt(rows, file + 1, pawnRank) === ownPawn) return ep;
  return "-";
}

/**
 * Position key used by the book: the first 4 FEN fields (placement, side, castling, ep).
 * @param {string} fen
 * @returns {string}
 */
export function positionKey(fen) {
  if (typeof fen !== "string") return "";
  const f = fen.trim().split(/\s+/);
  const placement = f[0] || "";
  const side = f[1] || "w";
  const castling = f[2] || "-";
  const ep = f[3] && f[3] !== "-" ? normalizeEp(placement, side, f[3]) : "-";
  return `${placement} ${side} ${castling} ${ep}`;
}

// --- lookups -------------------------------------------------------------------------------

function lookup(fen) {
  if (!table) return null;
  const hit = table.get(positionKey(fen));
  return hit ? { eco: hit[0], name: hit[1] } : null;
}

/**
 * Named opening for exactly this position.
 * @param {string} fen
 * @returns {{eco: string, name: string} | null}
 */
export function openingAt(fen) {
  return lookup(fen);
}

/**
 * Opening name for a game so far: the DEEPEST ply whose position is named.
 * @param {string[]} fens FEN after each ply; fens[0] is the position after White's first move.
 * @returns {{eco: string, name: string, ply: number, index: number} | null}
 *   ply = number of half-moves played to reach the named position (index + 1);
 *   index = position in the `fens` array.
 */
export function openingForGame(fens) {
  if (!table || !Array.isArray(fens)) return null;
  for (let i = fens.length - 1; i >= 0; i--) {
    const hit = lookup(fens[i]);
    if (hit) return { eco: hit.eco, name: hit.name, ply: i + 1, index: i };
  }
  return null;
}

/**
 * @param {string} fen
 * @returns {boolean} whether this exact position is a named book position.
 */
export function isBookPosition(fen) {
  return !!table && table.has(positionKey(fen));
}

/**
 * Legal moves from `fen` that land on a named book position (a small opening explorer).
 * @param {string} fen
 * @returns {{san: string, from: string, to: string, promotion: (string|undefined), eco: string, name: string}[]}
 *   sorted by name, then SAN.
 */
export function bookMoves(fen) {
  if (!table) return [];
  let chess;
  try { chess = new Chess(fen); } catch { return []; }
  const out = [];
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const hit = table.get(positionKey(chess.fen()));
    chess.undo();
    if (hit) out.push({ san: m.san, from: m.from, to: m.to, promotion: m.promotion, eco: hit[0], name: hit[1] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.san.localeCompare(b.san));
  return out;
}

// --- curated lines for the opening trainer ------------------------------------------------
// side = the side the trainee plays. moves = SAN, space separated, no move numbers.
// Every line replays legally and ends on a named book position (checked by tools/test-data.mjs).
export const POPULAR_OPENINGS = [
  // 1.e4 e5
  { id: "italian-game", name: "Italian Game", eco: "C54", side: "w",
    moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3",
    blurb: "Aim your bishop at f7, build a quiet center with c3 and d3, and castle early." },
  { id: "ruy-lopez", name: "Ruy Lopez", eco: "C84", side: "w",
    moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7",
    blurb: "Pressure the knight that defends e5, then castle and slowly build a strong center." },
  { id: "scotch-game", name: "Scotch Game", eco: "C45", side: "w",
    moves: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5",
    blurb: "Open the center right away with d4 and use your space to chase Black's pieces." },
  { id: "evans-gambit", name: "Evans Gambit", eco: "C52", side: "w",
    moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5",
    blurb: "Give up a pawn on b4 to gain time and build a big center for a fast attack." },
  { id: "two-knights", name: "Two Knights Defense", eco: "C58", side: "b",
    moves: "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5",
    blurb: "Counterattack e4 instead of copying White; if White grabs material, chase the bishop away." },
  { id: "four-knights", name: "Four Knights Game", eco: "C49", side: "w",
    moves: "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6",
    blurb: "Develop both knights before anything else; solid, symmetrical and easy to learn." },
  { id: "kings-gambit", name: "King's Gambit", eco: "C39", side: "w",
    moves: "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5",
    blurb: "A romantic pawn sacrifice on f4 to open the f-file and attack the king." },
  { id: "vienna-game", name: "Vienna Game", eco: "C29", side: "w",
    moves: "e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 d3",
    blurb: "Knight to c3 first, then strike with f4 like a King's Gambit with extra preparation." },
  { id: "petrov-defense", name: "Petrov's Defense", eco: "C42", side: "b",
    moves: "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6",
    blurb: "Answer the attack on e5 with a counterattack on e4: rock-solid and symmetrical." },
  { id: "philidor-defense", name: "Philidor Defense", eco: "C41", side: "b",
    moves: "e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7",
    blurb: "Defend e5 with a pawn and build a compact, hard-to-crack position." },
  // 1.e4 other
  { id: "sicilian-najdorf", name: "Sicilian Defense: Najdorf", eco: "B90", side: "b",
    moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6",
    blurb: "The little move a6 keeps White's pieces off b5 and prepares queenside play." },
  { id: "sicilian-dragon", name: "Sicilian Defense: Dragon", eco: "B70", side: "b",
    moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6",
    blurb: "Fianchetto the bishop on g7 where it breathes fire down the long diagonal." },
  { id: "sicilian-alapin", name: "Sicilian Defense: Alapin", eco: "B22", side: "w",
    moves: "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4",
    blurb: "Play c3 to support d4 and avoid the sharpest Sicilian theory." },
  { id: "french-defense", name: "French Defense: Advance", eco: "C02", side: "b",
    moves: "e4 e6 d4 d5 e5 c5 c3 Nc6",
    blurb: "Challenge White's center with ...d5, then attack the pawn chain at its base with ...c5." },
  { id: "caro-kann", name: "Caro-Kann Defense", eco: "B18", side: "b",
    moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5",
    blurb: "Support ...d5 with the c-pawn and develop the light bishop before playing ...e6." },
  { id: "pirc-defense", name: "Pirc Defense", eco: "B08", side: "b",
    moves: "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7",
    blurb: "Let White take the center, fianchetto your bishop, and hit back later." },
  { id: "scandinavian", name: "Scandinavian Defense", eco: "B01", side: "b",
    moves: "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6",
    blurb: "Attack e4 immediately; the queen recaptures and steps aside to a5." },
  { id: "alekhine-defense", name: "Alekhine Defense", eco: "B05", side: "b",
    moves: "e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4",
    blurb: "Invite White's pawns forward, then attack them once they are overextended." },
  // 1.d4
  { id: "queens-gambit-declined", name: "Queen's Gambit Declined", eco: "D60", side: "b",
    moves: "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7",
    blurb: "Keep a firm pawn on d5 with ...e6 and develop calmly behind it." },
  { id: "queens-gambit-accepted", name: "Queen's Gambit Accepted", eco: "D26", side: "b",
    moves: "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5",
    blurb: "Take the c4 pawn, let White win it back, and use the time to strike with ...c5." },
  { id: "slav-defense", name: "Slav Defense", eco: "D17", side: "b",
    moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5",
    blurb: "Defend d5 with the c-pawn so your light-squared bishop can still get out." },
  { id: "kings-indian", name: "King's Indian Defense", eco: "E92", side: "b",
    moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5",
    blurb: "Let White build a big center, castle quickly, then counterattack it with ...e5." },
  { id: "nimzo-indian", name: "Nimzo-Indian Defense", eco: "E46", side: "b",
    moves: "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O",
    blurb: "Pin the c3 knight to stop e4 and fight for the center with pieces, not pawns." },
  { id: "grunfeld", name: "Grünfeld Defense", eco: "D85", side: "b",
    moves: "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5",
    blurb: "Trade off White's center pawns and pressure d4 with the fianchettoed bishop." },
  { id: "queens-indian", name: "Queen's Indian Defense", eco: "E15", side: "b",
    moves: "d4 Nf6 c4 e6 Nf3 b6 g3 Ba6",
    blurb: "Fianchetto the queenside bishop to control e4 from a distance." },
  { id: "dutch-defense", name: "Dutch Defense", eco: "A92", side: "b",
    moves: "d4 f5 c4 Nf6 g3 e6 Bg2 Be7 Nf3 O-O",
    blurb: "Grab e4 with the f-pawn for an unbalanced game with kingside chances." },
  { id: "benoni", name: "Benoni Defense", eco: "A65", side: "b",
    moves: "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4",
    blurb: "Create an imbalanced pawn structure and play for ...b5 and active pieces." },
  { id: "budapest-gambit", name: "Budapest Gambit", eco: "A52", side: "b",
    moves: "d4 Nf6 c4 e5 dxe5 Ng4",
    blurb: "A surprise pawn sacrifice: the knight hunts the e5 pawn while your pieces develop fast." },
  { id: "london-system", name: "London System", eco: "D02", side: "w",
    moves: "d4 d5 Nf3 Nf6 Bf4 c5 e3 Nc6 Nbd2 e6 c3",
    blurb: "A simple setup: d4, Bf4, e3 and c3, playable against almost anything." },
  { id: "catalan", name: "Catalan Opening", eco: "E06", side: "w",
    moves: "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3",
    blurb: "Queen's Gambit plus a fianchettoed bishop that bears down on the long diagonal." },
  // flank openings
  { id: "english-opening", name: "English Opening", eco: "A29", side: "w",
    moves: "c4 e5 Nc3 Nf6 Nf3 Nc6 g3",
    blurb: "Start with c4 to control d5 from the side, like a Sicilian with an extra move." },
  { id: "reti-opening", name: "Réti Opening", eco: "A12", side: "w",
    moves: "Nf3 d5 c4 c6 b3 Bf5 Bb2",
    blurb: "Develop flexibly and fianchetto, attacking the center from the flanks." },
];
