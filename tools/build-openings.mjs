// Builds public/data/openings.json from the lichess chess-openings dataset (CC0).
//   https://github.com/lichess-org/chess-openings  ({a,b,c,d,e}.tsv: eco, name, pgn)
//
// Output: a compact JSON object mapping a position key -> [eco, name].
// Position key = the first 4 space-separated FEN fields (placement, side, castling, ep)
// as produced by chess.js after replaying the line. The runtime (src/openings.js) uses
// the same chess.js, so keys match exactly.
//
// When several lines reach the same position (transpositions), the line with the fewest
// moves wins (the most canonical name); ties keep the first one seen (file order a..e).
//
// Usage:  node tools/build-openings.mjs [--src <dir with a.tsv..e.tsv>]
//   Without --src the TSVs are downloaded from GitHub (raw.githubusercontent.com).
import { Chess } from "chess.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "public/data/openings.json");
const BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master/";
const FILES = ["a", "b", "c", "d", "e"];

const argSrc = (() => {
  const i = process.argv.indexOf("--src");
  return i > 0 ? process.argv[i + 1] : null;
})();

async function loadTsv(letter) {
  if (argSrc) return readFileSync(join(argSrc, `${letter}.tsv`), "utf8");
  const res = await fetch(BASE + `${letter}.tsv`);
  if (!res.ok) throw new Error(`download ${letter}.tsv failed: HTTP ${res.status}`);
  return res.text();
}

// "1. e4 e5 2. Nf3" -> ["e4","e5","Nf3"]
function pgnToSans(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^\d+\.+$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t))
    .map((t) => t.replace(/^\d+\.+/, ""))
    .filter(Boolean);
}

const keyOf = (fen) => fen.split(" ").slice(0, 4).join(" ");

const best = new Map(); // key -> { eco, name, plies }
let lines = 0, bad = 0;

for (const letter of FILES) {
  const text = await loadTsv(letter);
  const rows = text.split(/\r?\n/);
  const header = rows.shift().split("\t");
  const iEco = header.indexOf("eco"), iName = header.indexOf("name"), iPgn = header.indexOf("pgn");
  if (iEco < 0 || iName < 0 || iPgn < 0) throw new Error(`${letter}.tsv: unexpected header ${header}`);
  for (const row of rows) {
    if (!row.trim()) continue;
    const cols = row.split("\t");
    const eco = cols[iEco], name = cols[iName], pgn = cols[iPgn];
    if (!/^[A-E]\d\d$/.test(eco) || !name || !pgn) { bad++; continue; }
    const sans = pgnToSans(pgn);
    const chess = new Chess();
    let ok = true;
    for (const san of sans) {
      try { chess.move(san); } catch { ok = false; break; }
    }
    if (!ok || sans.length === 0) { bad++; console.warn(`skip (illegal): ${eco} ${name}: ${pgn}`); continue; }
    lines++;
    const key = keyOf(chess.fen());
    const prev = best.get(key);
    if (!prev || sans.length < prev.plies) best.set(key, { eco, name, plies: sans.length });
  }
}

const out = {};
for (const [key, v] of best) out[key] = [v.eco, v.name];
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json);
console.log(`openings: ${lines} lines read, ${bad} skipped, ${best.size} unique positions -> ${OUT} (${(json.length / 1024).toFixed(1)} KB)`);
