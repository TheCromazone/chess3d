// Opening explorer: which moves were played from a position, how often, and how those games
// ended. Backed by public/data/explorer/ (built by tools/build-explorer.mjs from the lichess
// open game database, CC0): rated Blitz/Rapid/Classical games, both players rated >= 1800,
// first 24 plies of each game.
//
// Data layout (fetched with relative URLs, so it works under any deploy subpath):
//   ./data/explorer/index.json  meta + the most played positions ("core"), fetched by loadExplorer()
//   ./data/explorer/NN.json     the remaining positions, split by explorerShardOf(key) into
//                               meta.shards files; each is fetched the first time it is needed
// Entry: positionKey -> [white, draws, black, "uci san white draws black avgRating", ...]
//
// Browser module (no Node APIs). Positions are keyed exactly like the opening book
// (positionKey from ./openings.js: first 4 FEN fields, chess.js en-passant convention).
import { positionKey } from "./openings.js";

const BASE = "./data/explorer/";

/**
 * Where the numbers come from. Filled with the shipped build's values and refreshed from
 * index.json once loadExplorer() succeeds.
 * games = games that contributed (each counted once, at every position it passed through).
 */
export const EXPLORER_INFO = {
  source: "lichess.org rated games, 2026-09",
  minRating: 1800,
  games: 995839,
  plies: 24,
};

let meta = null;            // index.json without "p"
let core = null;            // Map<key, entry> once loaded
let loading = null;         // in-flight / settled promise for index.json
const shardMaps = [];       // shard number -> Map<key, entry>
const shardLoading = [];    // shard number -> in-flight promise

/**
 * Shard of a position key: FNV-1a (32-bit) of the key string, mod `count`.
 * Shared with tools/build-explorer.mjs, which uses it to split the data.
 * @param {string} key  positionKey(fen)
 * @param {number} count number of shards
 * @returns {number}
 */
export function explorerShardOf(key, count) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % count;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/**
 * Fetch the explorer index once (meta + the most played positions). Safe to call repeatedly;
 * concurrent calls share one request. Never throws: resolves true when the data is available,
 * false when the fetch failed (a later call retries).
 * @returns {Promise<boolean>}
 */
export async function loadExplorer() {
  if (core) return true;
  if (!loading) {
    loading = (async () => {
      try {
        const data = await fetchJson(BASE + "index.json");
        if (!data || data.v !== 1 || !data.p || typeof data.p !== "object") throw new Error("unexpected format");
        const { p, ...rest } = data;
        meta = rest;
        core = new Map(Object.entries(p));
        EXPLORER_INFO.source = rest.source || EXPLORER_INFO.source;
        EXPLORER_INFO.minRating = rest.minRating || EXPLORER_INFO.minRating;
        EXPLORER_INFO.games = rest.games || EXPLORER_INFO.games;
        EXPLORER_INFO.plies = rest.plies || EXPLORER_INFO.plies;
        return true;
      } catch (err) {
        console.warn("[explorer] could not load " + BASE + "index.json:", err);
        loading = null; // allow a later retry
        return false;
      }
    })();
  }
  return loading;
}

/** @returns {boolean} whether the explorer index has been loaded. */
export function explorerLoaded() {
  return core !== null;
}

// Resolves the shard's Map, or null if it could not be fetched (retried on the next lookup).
function loadShard(n) {
  if (shardMaps[n]) return Promise.resolve(shardMaps[n]);
  if (!shardLoading[n]) {
    const url = BASE + String(n).padStart(2, "0") + ".json";
    shardLoading[n] = fetchJson(url).then((data) => {
      if (!data || data.v !== 1 || data.shard !== n || !data.p || typeof data.p !== "object") throw new Error("unexpected format");
      shardMaps[n] = new Map(Object.entries(data.p));
      shardLoading[n] = null;
      return shardMaps[n];
    }).catch((err) => {
      console.warn("[explorer] could not load " + url + ":", err);
      shardLoading[n] = null;
      return null;
    });
  }
  return shardLoading[n];
}

const KEY_RE = /^[1-8pnbrqkPNBRQK]+(?:\/[1-8pnbrqkPNBRQK]+){7} [wb] (?:-|K?Q?k?q?) (?:-|[a-h][36])$/;

// The data only holds positions from the first `plies` half-moves. A FEN whose move number is
// past that is answered with null without fetching anything (a missing number is not filtered).
function pastBook(fen) {
  const f = fen.trim().split(/\s+/);
  if (!/^\d+$/.test(f[5] || "")) return false;
  const plies = (meta && meta.plies) || EXPLORER_INFO.plies;
  return +f[5] > Math.ceil(plies / 2);
}

function decode(entry) {
  if (!Array.isArray(entry) || entry.length < 3) return null;
  const white = entry[0] | 0, draws = entry[1] | 0, black = entry[2] | 0;
  const moves = [];
  for (let i = 3; i < entry.length; i++) {
    const f = typeof entry[i] === "string" ? entry[i].split(" ") : [];
    if (f.length !== 6 || !/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(f[0])) continue;
    const mw = +f[2] | 0, md = +f[3] | 0, mb = +f[4] | 0;
    moves.push({
      san: f[1],
      uci: f[0],
      from: f[0].slice(0, 2),
      to: f[0].slice(2, 4),
      promotion: f[0][4] || undefined,
      total: mw + md + mb,
      white: mw,
      draws: md,
      black: mb,
      avgRating: +f[5] | 0,
    });
  }
  moves.sort((a, b) => b.total - a.total);
  return { total: white + draws + black, white, draws, black, moves };
}

/**
 * Explorer statistics for a position. Loads the index (and the one shard the position lives in)
 * on demand. Never throws.
 * @param {string} fen  a FEN (only the first 4 fields matter; move counters, if present, are
 *                      used to skip positions past the explorer's depth)
 * @returns {Promise<null | {
 *   total: number, white: number, draws: number, black: number,
 *   moves: {san: string, uci: string, from: string, to: string, promotion: (string|undefined),
 *           total: number, white: number, draws: number, black: number, avgRating: number}[]
 * }>}
 *   white/draws/black are game counts (White wins, draws, Black wins). The position's totals
 *   count every game; `moves` lists moves played at least a handful of times (meta.minMoveGames),
 *   sorted by total desc, so they may sum to less than `total`. null if the position isn't in
 *   the data (or the data couldn't be loaded).
 */
export async function explorerMoves(fen) {
  try {
    if (typeof fen !== "string") return null;
    const key = positionKey(fen);
    if (!KEY_RE.test(key)) return null;
    if (!(await loadExplorer())) return null;
    if (pastBook(fen)) return null;
    let entry = core.get(key);
    if (entry === undefined && meta.shards > 0) {
      const map = await loadShard(explorerShardOf(key, meta.shards));
      entry = map ? map.get(key) : undefined;
    }
    return entry === undefined ? null : decode(entry);
  } catch (err) {
    console.warn("[explorer] lookup failed:", err);
    return null;
  }
}
