// Rated puzzles, Puzzle Rush and the daily puzzle, backed by public/data/puzzles.json
// (built by tools/build-puzzles.mjs from the lichess puzzle database, CC0).
//
// Data: {"v":1,"themes":[id...],"p":[[id, fen, "uci uci ...", rating, [themeIdx...]], ...]}
// sorted by rating. Browser module: no Node APIs.
//
// Puzzle convention (lichess): `fen` is the position BEFORE the opponent's last move;
// moves[0] is that setup move (play it automatically), then the player answers with
// moves[1], the opponent replies moves[2], and so on. The puzzle always ends on a player move.
//
// Normalized puzzle object returned by every function here:
//   { id, fen, moves: ["e2e4", ...], rating, themes: ["fork", ...], playerColor: "w" | "b" }
// playerColor is the side that moves SECOND (i.e. NOT the side to move in `fen`).

const DATA_URL = "./data/puzzles.json";

let rows = null;     // raw rows, sorted by rating
let themeIds = null; // index -> theme id
let byId = null;     // id -> row index
let loading = null;

/**
 * Fetch the puzzle set once and cache it. Safe to call repeatedly. Always resolves:
 * true when loaded, false if the fetch failed (lookups then return null / []).
 * A failed load is retried on the next call.
 * @returns {Promise<boolean>}
 */
export function loadPuzzles() {
  if (rows) return Promise.resolve(true);
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.p) || !Array.isArray(data.themes)) throw new Error("bad puzzle data");
        const p = data.p.slice().sort((a, b) => a[3] - b[3]);
        themeIds = data.themes;
        byId = new Map(p.map((r, i) => [r[0], i]));
        rows = p;
        return true;
      } catch (err) {
        console.warn("[puzzles] could not load " + DATA_URL + ":", err);
        loading = null;
        return false;
      }
    })();
  }
  return loading;
}

/** @returns {boolean} */
export function puzzlesLoaded() {
  return rows !== null;
}

/** @returns {number} number of puzzles loaded (0 before load). */
export function puzzleCount() {
  return rows ? rows.length : 0;
}

// --- theme catalogue -----------------------------------------------------------------------

/** Human-friendly names and one-line descriptions for every lichess puzzle theme. */
export const THEME_INFO = {
  // phases
  opening: { name: "Opening", desc: "A tactic that appears in the first moves of the game." },
  middlegame: { name: "Middlegame", desc: "A tactic from the middle phase of the game." },
  endgame: { name: "Endgame", desc: "A tactic from the last phase of the game, with few pieces left." },
  // goals
  mate: { name: "Checkmate", desc: "Finish the game with checkmate." },
  mateIn1: { name: "Mate in 1", desc: "Deliver checkmate in one move." },
  mateIn2: { name: "Mate in 2", desc: "Deliver checkmate in two moves." },
  mateIn3: { name: "Mate in 3", desc: "Deliver checkmate in three moves." },
  mateIn4: { name: "Mate in 4", desc: "Deliver checkmate in four moves." },
  mateIn5: { name: "Mate in 5+", desc: "Work out a long forced checkmate." },
  crushing: { name: "Crushing", desc: "Punish the opponent's blunder and win decisively." },
  advantage: { name: "Advantage", desc: "Find the move that gives you a clear, lasting edge." },
  equality: { name: "Equality", desc: "Save a bad position and reach a draw or a balanced game." },
  // length
  oneMove: { name: "One-move puzzle", desc: "Only one move to find." },
  short: { name: "Short puzzle", desc: "Two moves to find." },
  long: { name: "Long puzzle", desc: "Three moves to find." },
  veryLong: { name: "Very long puzzle", desc: "Four or more moves to find." },
  // motifs
  fork: { name: "Fork", desc: "One piece attacks two or more enemy pieces at once." },
  pin: { name: "Pin", desc: "A piece can't move without exposing a more valuable piece behind it." },
  skewer: { name: "Skewer", desc: "Attack a valuable piece so that it moves and exposes the piece behind it." },
  hangingPiece: { name: "Hanging piece", desc: "Grab a piece that is left undefended." },
  discoveredAttack: { name: "Discovered attack", desc: "Move one piece out of the way to unleash an attack by another." },
  discoveredCheck: { name: "Discovered check", desc: "Move one piece to reveal a check from the piece behind it." },
  doubleCheck: { name: "Double check", desc: "Check with two pieces at once, so the king has to move." },
  sacrifice: { name: "Sacrifice", desc: "Give up material now to gain something bigger later." },
  deflection: { name: "Deflection", desc: "Distract a defender so it abandons a key square or piece." },
  attraction: { name: "Attraction", desc: "Lure an enemy piece (often the king) onto a square where it can be exploited." },
  capturingDefender: { name: "Remove the defender", desc: "Capture the piece that guards something important." },
  clearance: { name: "Clearance", desc: "Clear a square, file or diagonal, often with tempo, for a follow-up tactic." },
  interference: { name: "Interference", desc: "Drop a piece between two enemy pieces to cut their connection." },
  intermezzo: { name: "Intermezzo", desc: "Insert a forcing in-between move before the expected one (zwischenzug)." },
  xRayAttack: { name: "X-ray attack", desc: "A piece attacks or defends a square through an enemy piece." },
  trappedPiece: { name: "Trapped piece", desc: "Win a piece that has no safe squares to escape to." },
  quietMove: { name: "Quiet move", desc: "A calm move with no check or capture that sets up an unstoppable threat." },
  defensiveMove: { name: "Defensive move", desc: "Find the precise move that avoids losing material or the game." },
  zugzwang: { name: "Zugzwang", desc: "Put the opponent in a position where every move makes things worse." },
  collinearMove: { name: "Collinear move", desc: "Slide a piece along a line toward an enemy piece facing it on that line." },
  advancedPawn: { name: "Advanced pawn", desc: "A pawn deep in enemy territory, close to promoting." },
  promotion: { name: "Promotion", desc: "Push a pawn to the last rank and promote it." },
  underPromotion: { name: "Underpromotion", desc: "Promote to a knight, bishop or rook instead of a queen." },
  enPassant: { name: "En passant", desc: "Use the special en passant pawn capture." },
  castling: { name: "Castling", desc: "Castle to bring the king to safety and the rook into play." },
  exposedKing: { name: "Exposed king", desc: "Attack a king with few defenders around it." },
  kingsideAttack: { name: "Kingside attack", desc: "Attack the king after it has castled short." },
  queensideAttack: { name: "Queenside attack", desc: "Attack the king after it has castled long." },
  attackingF2F7: { name: "Attacking f2 or f7", desc: "Strike at the weak f2 or f7 pawn next to the king." },
  // endgame types
  pawnEndgame: { name: "Pawn endgame", desc: "Only kings and pawns are left." },
  rookEndgame: { name: "Rook endgame", desc: "Only rooks, kings and pawns are left." },
  bishopEndgame: { name: "Bishop endgame", desc: "Only bishops, kings and pawns are left." },
  knightEndgame: { name: "Knight endgame", desc: "Only knights, kings and pawns are left." },
  queenEndgame: { name: "Queen endgame", desc: "Only queens, kings and pawns are left." },
  queenRookEndgame: { name: "Queen and rook", desc: "Only queens, rooks, kings and pawns are left." },
  // checkmate patterns
  backRankMate: { name: "Back-rank mate", desc: "Mate on the back rank, where the king is boxed in by its own pawns." },
  smotheredMate: { name: "Smothered mate", desc: "A knight mates a king that is surrounded by its own pieces." },
  anastasiaMate: { name: "Anastasia's mate", desc: "A knight and a rook or queen trap the king on the edge of the board." },
  arabianMate: { name: "Arabian mate", desc: "A rook and a knight team up to mate the king in the corner." },
  balestraMate: { name: "Balestra mate", desc: "A bishop gives mate while the queen covers the escape squares." },
  blindSwineMate: { name: "Blind swine mate", desc: "Two rooks on the seventh rank mate a king stuck in the corner." },
  bodenMate: { name: "Boden's mate", desc: "Two bishops on crossing diagonals mate a king blocked by its own pieces." },
  cornerMate: { name: "Corner mate", desc: "A rook or queen pins the king in the corner and a knight delivers mate." },
  doubleBishopMate: { name: "Double bishop mate", desc: "Two bishops on neighbouring diagonals mate a king blocked by its own pieces." },
  dovetailMate: { name: "Dovetail mate", desc: "The queen mates an adjacent king whose escape squares are blocked by its own pieces." },
  epauletteMate: { name: "Epaulette mate", desc: "The king's own pieces on both sides block its escape, like shoulder epaulettes." },
  hookMate: { name: "Hook mate", desc: "A rook, knight and pawn combine, with an enemy pawn blocking the king's escape." },
  killBoxMate: { name: "Kill box mate", desc: "A rook beside the king, backed by the queen, traps it in a 3x3 box." },
  morphysMate: { name: "Morphy's mate", desc: "A bishop gives mate while a rook cuts off the king." },
  operaMate: { name: "Opera mate", desc: "A rook mates on the back rank, protected by a bishop." },
  pillsburysMate: { name: "Pillsbury's mate", desc: "A rook gives mate while a bishop helps box in the king." },
  swallowstailMate: { name: "Swallow's tail mate", desc: "The queen mates head-on while the king's own pieces block its retreat in a V shape." },
  triangleMate: { name: "Triangle mate", desc: "Queen and rook form a triangle around the king to deliver mate." },
  vukovicMate: { name: "Vuković mate", desc: "A rook and knight mate together, with the rook supported by a third piece." },
  // origin
  master: { name: "Master games", desc: "Taken from games played by titled players." },
  masterVsMaster: { name: "Master vs master", desc: "Taken from games between two titled players." },
  superGM: { name: "Super GM games", desc: "Taken from games of the world's best players." },
};

function themeInfo(id) {
  return THEME_INFO[id] || {
    // unknown future theme ids: "someThemeName" -> "Some theme name"
    name: id.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (m) => m.toLowerCase()),
    desc: "",
  };
}

/**
 * Themes present in the loaded data, most common first.
 * @returns {{id: string, name: string, desc: string, count: number}[]}
 */
export function themesAvailable() {
  if (!rows) return [];
  const counts = new Array(themeIds.length).fill(0);
  for (const r of rows) for (const t of r[4]) counts[t]++;
  return themeIds
    .map((id, i) => ({ id, ...themeInfo(id), count: counts[i] }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// --- helpers -------------------------------------------------------------------------------

function toPuzzle(r) {
  if (!r) return null;
  const fen = r[1];
  const side = fen.split(" ")[1] === "b" ? "b" : "w";
  return {
    id: r[0],
    fen,
    moves: r[2].split(" "),
    rating: r[3],
    themes: r[4].map((i) => themeIds[i]),
    playerColor: side === "w" ? "b" : "w",
  };
}

function hasSeen(seen, id) {
  if (!seen) return false;
  if (typeof seen.has === "function") return seen.has(id);
  if (Array.isArray(seen)) return seen.includes(id);
  return false;
}

// first index with rating >= x
function lowerBound(x) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][3] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// string/number -> 32-bit seed
function hashSeed(seed) {
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// small fast deterministic PRNG -> [0, 1)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// indices of rows within [center - w, center + w] that pass `ok`, widening w until found
function candidatesNear(center, startWidth, ok, maxWidth = 4000) {
  for (let w = startWidth; ; w = Math.round(w * 1.5)) {
    const out = [];
    const end = lowerBound(center + w + 1);
    for (let i = lowerBound(center - w); i < end; i++) if (ok(rows[i])) out.push(i);
    if (out.length || w >= maxWidth) return out;
  }
}

// --- public API ----------------------------------------------------------------------------

/**
 * @param {string} id lichess puzzle id
 * @returns {object|null} normalized puzzle
 */
export function getPuzzle(id) {
  if (!rows) return null;
  const i = byId.get(id);
  return i === undefined ? null : toPuzzle(rows[i]);
}

/**
 * A random puzzle near `rating` (window starts at +-75 and widens until something matches).
 * @param {{rating?: number, theme?: string|null, seen?: Set<string>|string[]}} [opts]
 * @returns {object|null} normalized puzzle, or null if nothing matches (e.g. all seen)
 */
export function nextPuzzle({ rating = 1200, theme = null, seen = new Set() } = {}) {
  if (!rows || !rows.length) return null;
  let tIdx = -1;
  if (theme) {
    tIdx = themeIds.indexOf(theme);
    if (tIdx < 0) return null;
  }
  const ok = (r) => (tIdx < 0 || r[4].includes(tIdx)) && !hasSeen(seen, r[0]);
  const c = candidatesNear(Math.round(+rating || 1200), 75, ok);
  if (!c.length) return null;
  return toPuzzle(rows[c[Math.floor(Math.random() * c.length)]]);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let dailyPool = null;
function getDailyPool() {
  if (dailyPool) return dailyPool;
  const pref = ["long", "mateIn3", "sacrifice"].map((t) => themeIds.indexOf(t)).filter((i) => i >= 0);
  const inRange = [];
  const preferred = [];
  rows.forEach((r, i) => {
    if (r[3] < 1500 || r[3] > 2100) return;
    inRange.push(i);
    if (r[4].some((t) => pref.includes(t))) preferred.push(i);
  });
  dailyPool = preferred.length ? preferred : inRange.length ? inRange : rows.map((_, i) => i);
  return dailyPool;
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

/**
 * Deterministic puzzle of the day (rating 1500-2100, favouring long / mate-in-3 / sacrifice
 * puzzles). The same date always gives the same puzzle, and consecutive days don't repeat
 * until the whole pool has been used.
 * @param {string} [dateStr] "YYYY-MM-DD" (defaults to today's local date)
 * @returns {object|null} normalized puzzle
 */
export function dailyPuzzle(dateStr = todayStr()) {
  if (!rows || !rows.length) return null;
  const pool = getDailyPool();
  const n = pool.length;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  let day;
  if (m) day = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5);
  else day = hashSeed(dateStr);
  // walk the pool with a fixed stride coprime to its size: a permutation over days
  let stride = 7919 % n || 1;
  while (gcd(stride, n) !== 1) stride++;
  const idx = ((day % n) * stride + 1013) % n;
  return toPuzzle(rows[pool[(idx + n) % n]]);
}

/**
 * Deterministic Puzzle Rush sequence: ratings ramp from ~600 up to ~2600, no repeats,
 * favouring short puzzles (at most 3 player moves) so the clock stays the main enemy.
 * @param {number|string} seed
 * @param {number} [count=80]
 * @returns {object[]} normalized puzzles
 */
export function rushSequence(seed, count = 80) {
  if (!rows || !rows.length) return [];
  const rand = mulberry32(hashSeed(seed));
  const used = new Set();
  const out = [];
  const n = Math.max(0, Math.min(count | 0, rows.length));
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const target = Math.round(600 + 2000 * Math.pow(t, 1.25)); // gentle start, steep finish
    const fresh = (r) => !used.has(r[0]);
    let c = candidatesNear(target, 50, (r) => fresh(r) && r[2].split(" ").length <= 6, 300);
    if (!c.length) c = candidatesNear(target, 50, fresh);
    if (!c.length) break;
    const r = rows[c[Math.floor(rand() * c.length)]];
    used.add(r[0]);
    out.push(toPuzzle(r));
  }
  return out;
}

/**
 * Elo-style puzzle rating update. K starts at 60 for a new player and decays linearly to 16
 * by 50 puzzles played.
 * @param {number} player current player rating
 * @param {number} puzzleRating
 * @param {boolean} solved
 * @param {number} nPlayed puzzles played before this one
 * @returns {number} new rating, rounded, clamped to 100..3500
 */
export function puzzleRatingUpdate(player, puzzleRating, solved, nPlayed = 0) {
  const p = Number.isFinite(+player) ? +player : 1200;
  const n = Math.max(0, +nPlayed || 0);
  const K = Math.max(16, 60 - (44 * n) / 50);
  const expected = 1 / (1 + Math.pow(10, (puzzleRating - p) / 400));
  const next = p + K * ((solved ? 1 : 0) - expected);
  return Math.round(Math.min(3500, Math.max(100, next)));
}

/**
 * Was the player's move correct? True if it matches the solution move at `solutionIndex`
 * (an index into puzzle.moves, so player moves are at odd indices 1, 3, 5...), or if the
 * move delivers checkmate (lichess accepts any mating move).
 * @param {object} puzzle normalized puzzle
 * @param {object} chessAfterMove a chess.js instance with the played move already applied
 * @param {string} playedUci e.g. "e7e8q"
 * @param {number} solutionIndex
 * @returns {boolean}
 */
export function isCorrectMove(puzzle, chessAfterMove, playedUci, solutionIndex) {
  const expected = puzzle && puzzle.moves ? puzzle.moves[solutionIndex] : undefined;
  if (expected && String(playedUci).toLowerCase() === expected.toLowerCase()) return true;
  try {
    if (chessAfterMove && typeof chessAfterMove.isCheckmate === "function") return chessAfterMove.isCheckmate();
  } catch { /* fall through */ }
  return false;
}
