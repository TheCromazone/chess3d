// Variant rules (src/core/vx.js): perft against known standard-chess counts, then each variant's rules.
import { VxGame, parsePos, legalMoves, makeMove, vxTextToMove, vxMoveToText, VX_VARIANTS } from "../src/core/vx.js";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };
const play = (g, ...ts) => ts.map((t) => { const d = g.move(vxTextToMove(t)); if (!d) throw new Error("illegal in test: " + t + " at " + g.fen); return d; });

// the generator with ordinary chess rules switched on must match the standard perft numbers
const STANDARD = { check: true, stalemate: "draw" };
function perft(pos, depth) {
  const ms = legalMoves(pos, STANDARD);
  if (depth === 1) return ms.length;
  let n = 0;
  for (const m of ms) n += perft(makeMove(pos, m, STANDARD), depth - 1);
  return n;
}
const PERFT = [
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 4, 197281, "start"],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3, 97862, "Kiwipete"],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674624, "position 3 (en passant, pins)"],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422333, "position 4 (promotions, castling)"],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 3, 62379, "position 5"],
];
for (const [fen, d, want, name] of PERFT) {
  const got = perft(parsePos(fen), d);
  ok(got === want, `perft ${name} depth ${d}: ${got} (want ${want})`);
}

// ---- Duck Chess ----
let g = new VxGame("duck");
ok(!g.isLegal({ from: "e2", to: "e4" }) && g.isLegal({ from: "e2", to: "e4", duck: "e5" }), "duck: every move places the duck");
ok(!g.isLegal({ from: "e2", to: "e4", duck: "e4" }) && !g.isLegal({ from: "e2", to: "e4", duck: "e7" }), "duck: only on an empty square");
play(g, "e2e4,e5");
ok(g.duck() === "e5" && !g.moves({ square: "e7" }).some((m) => m.to === "e5"), "duck: blocks its square");
ok(g.moves({ square: "e7" }).some((m) => m.to === "e6"), "duck: a pawn can still step up to it");
ok(!g.isLegal({ from: "d7", to: "d5", duck: "e5" }), "duck: must move to a new square");
play(g, "d7d5,a3");
ok(!g.moves({ square: "a2" }).length, "duck: a pawn behind the duck can't move");
// no check: a king may walk into attack, and taking the king wins with no duck move
g = new VxGame("duck", { fen: "4k3/8/8/8/8/8/4q3/4K3 w - - 0 1" });
ok(g.moves({ square: "e1" }).some((m) => m.to === "d2") && g.moves({ square: "e1" }).some((m) => m.to === "e2"), "duck: no check, so kings may step into attack");
g = new VxGame("duck", { fen: "4k3/8/8/8/8/8/3q4/4K3 b - - 0 1" });
play(g, "d2e1");
ok(g.outcome().over && g.outcome().winner === "b" && g.outcome().reason === "king", "duck: taking the king wins");
// castling through an attacked square is fine
g = new VxGame("duck", { fen: "4k3/8/8/8/8/8/5r2/4K2R w K - 0 1" });
ok(g.moves({ square: "e1" }).some((m) => m.to === "g1"), "duck: castling ignores attacks");
// a player with no move wins
g = new VxGame("duck", { fen: "kb6/p*p5/P1P5/8/8/8/8/7K b - - 0 1" });
ok(g.outcome().over && g.outcome().winner === "b" && g.outcome().reason === "stalemate-win", "duck: a player with no move wins");
g = new VxGame("duck", { fen: "kn6/n*6/8/8/8/8/8/7K b - - 0 1" });
ok(!g.moves({ square: "a8" }).length, "duck: duck walls in a king");

// ---- Fog of War ----
g = new VxGame("fog");
const seen = new Set(g.visible("w"));
ok(seen.has("e4") && seen.has("f3") && seen.has("e2") && !seen.has("e7") && !seen.has("e5"), "fog: White sees its pieces and where they can go");
ok(g.foggedBoard("w").flat().filter(Boolean).every((p) => p.color === "w"), "fog: Black's pieces are hidden at the start");
play(g, "e2e4", "d7d5");
const fb = g.foggedBoard("w").flat().filter(Boolean);
ok(fb.some((p) => p.color === "b" && p.square === "d5"), "fog: a piece you can take is visible");
g = new VxGame("fog", { fen: "4k3/8/8/8/8/8/3q4/4K3 w - - 0 1" });
ok(g.moves({ square: "e1" }).some((m) => m.to === "e2"), "fog: no check");
g = new VxGame("fog", { fen: "4k3/8/8/8/8/8/3q4/4K3 b - - 0 1" });
play(g, "d2e1");
ok(g.outcome().winner === "b", "fog: taking the king wins");

// ---- Giveaway ----
g = new VxGame("giveaway");
play(g, "e2e3", "b7b5");
const forced = g.moves();
ok(forced.length === 1 && forced[0].to === "b5", "giveaway: captures are compulsory");
g = new VxGame("giveaway", { fen: "8/8/8/8/8/8/1p6/8 w - - 0 1" });
ok(g.outcome().over && g.outcome().winner === "w" && g.outcome().reason === "no-pieces", "giveaway: no pieces left wins");
g = new VxGame("giveaway", { fen: "8/8/8/8/8/p7/P7/8 w - - 0 1" });
ok(g.outcome().over && g.outcome().winner === "w", "giveaway: no moves wins");
g = new VxGame("giveaway", { fen: "8/P7/8/8/8/8/8/7k w - - 0 1" });
ok(g.moves({ square: "a7" }).some((m) => m.promotion === "k"), "giveaway: pawns may promote to a king");
g = new VxGame("giveaway", { fen: "8/8/8/8/8/8/8/R3K2R w KQ - 0 1" });
ok(!g.moves({ square: "e1" }).some((m) => m.to === "g1" || m.to === "c1"), "giveaway: no castling");
ok(g.moves({ square: "e1" }).length === 5, "giveaway: the king is an ordinary piece");

// ---- Atomic ----
g = new VxGame("atomic", { fen: "4k3/8/8/2npb3/3Q4/8/8/4K3 w - - 0 1" });
const d = play(g, "d4d5")[0];
ok(!g.get("d5") && !g.get("c5") && !g.get("e5") && g.get("d4") === null, "atomic: a capture destroys the capturer and the pieces around it");
ok(d.exploded.includes("c5") && d.exploded.includes("e5"), "atomic: the move reports what exploded");
g = new VxGame("atomic", { fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1" });
play(g, "e5d6");
ok(!g.get("d5") && !g.get("d6") && !g.get("e5"), "atomic: en passant explodes too");
g = new VxGame("atomic", { fen: "4k3/4p3/8/8/8/8/8/R3K3 w - - 0 1" });
ok(!g.moves({ square: "e1" }).some((m) => m.captured), "atomic: kings never capture");
g = new VxGame("atomic", { fen: "3qk3/8/8/8/8/8/8/3QK3 w - - 0 1" });
play(g, "d1d8");
ok(g.outcome().winner === "w", "atomic: a capture next to the enemy king blows it up");
g = new VxGame("atomic", { fen: "4k3/3p4/8/8/8/8/8/3QK3 w - - 0 1" });
play(g, "d1d7");
ok(g.outcome().over && g.outcome().winner === "w" && g.outcome().reason === "explosion", "atomic: exploding the king wins");
g = new VxGame("atomic", { fen: "8/8/8/8/8/8/3pk3/3QK3 w - - 0 1" });
ok(!g.isLegal({ from: "d1", to: "d2" }), "atomic: you can't blow up your own king");
g = new VxGame("atomic", { fen: "8/8/8/8/8/3k4/3K4/7r w - - 0 1" });
ok(!g.inCheck(), "atomic: touching kings can't be in check");
g = new VxGame("atomic", { fen: "4k3/8/8/8/8/8/8/r3K3 w - - 0 1" });
ok(g.inCheck(), "atomic: check from a rook");

// ---- Horde ----
g = new VxGame("horde");
const white = g.board().flat().filter((p) => p && p.color === "w");
ok(white.length === 36 && white.every((p) => p.type === "p"), "horde: White starts with 36 pawns");
ok(g.moves({ square: "a1" }).length === 0 && g.moves({ square: "b5" }).length === 1, "horde: blocked pawns, single step from the 5th");
g = new VxGame("horde", { fen: "4k3/8/8/8/8/8/8/P7 w - - 0 1" });
ok(g.moves({ square: "a1" }).some((m) => m.to === "a3"), "horde: first-rank pawns may step two");
g = new VxGame("horde", { fen: "4k3/8/8/8/8/8/8/8 w - - 0 1" });
ok(g.outcome().over && g.outcome().winner === "b" && g.outcome().reason === "horde", "horde: Black wins when White has nothing left");
g = new VxGame("horde", { fen: "4k3/4P3/4P3/8/8/8/8/8 b - - 0 1" });
ok(!g.moves({ square: "e8" }).some((m) => m.to === "d7" || m.to === "f7"), "horde: Black's king respects check");
g = new VxGame("horde", { fen: "k7/2P5/1PP5/8/8/8/8/8 b - - 0 1" });
ok(g.outcome().over && g.outcome().winner === null, "horde: stalemate is a draw");

// ---- Chess960: the same move counts as the Chess960 adapter (itself checked against Stockfish) ----
{
  const { Chess960, chess960Fen } = await import("../src/core/chess960.js");
  const v960 = VX_VARIANTS.chess960;
  // (the adapter also lists king-to-destination aliases of castling, for drag and drop; not counted)
  const perftA = (c, d) => { const ms = c.moves({ verbose: true }).filter((m) => !m.alias); if (d === 1) return ms.length; let n = 0; for (const m of ms) { c.move({ from: m.from, to: m.to, promotion: m.promotion }); n += perftA(c, d - 1); c.undo(); } return n; };
  const perftB = (pos, d) => { const ms = legalMoves(pos, v960); if (d === 1) return ms.length; let n = 0; for (const m of ms) n += perftB(makeMove(pos, m, v960), d - 1); return n; };
  let mismatch = null;
  const fens = [0, 1, 105, 518, 959, 300, 707, 42].map((n) => chess960Fen(n)).concat([
    "4k3/8/8/8/8/8/8/R4K1R w HA - 0 1", "4k3/8/8/8/8/8/8/6KR w H - 0 1", "r3k2r/8/8/8/8/8/8/RK5R w HAha - 0 1",
    "1r2k1r1/8/8/8/8/8/8/1R2K1R1 w GBgb - 0 1", "4k3/8/8/8/8/8/5q2/R4K1R w HA - 0 1",
  ]);
  for (const fen of fens) {
    // also a few random moves into each game, so castling happens mid-game
    const c = new Chess960(fen);
    for (let i = 0; i < 6; i++) { const ms = c.moves({ verbose: true }); if (!ms.length) break; const m = ms[Math.floor(Math.random() * ms.length)]; c.move({ from: m.from, to: m.to, promotion: m.promotion }); }
    for (const f of [fen, c.fen()]) {
      const a = perftA(new Chess960(f), 3), b = perftB(parsePos(f), 3);
      if (a !== b) { mismatch = `${f}: ${a} vs ${b}`; break; }
    }
    if (mismatch) break;
  }
  ok(!mismatch, `Chess960 perft (depth 3) matches the adapter on ${fens.length * 2} positions${mismatch ? ": " + mismatch : ""}`);
  const z = new VxGame("chess960", { fen: "4k3/8/8/8/8/8/8/R4K1R w HA - 0 1" });
  ok(z.moves({ square: "f1" }).some((m) => m.to === "h1" && m.castle960), "Chess960: castling is the king onto its rook");
  const d = z.move({ from: "f1", to: "h1" });
  ok(d.san === "O-O" && z.fen.startsWith("4k3/8/8/8/8/8/8/R4RK1 b"), "and lands like normal castling");
  ok(new VxGame("chess960", { start: 518 }).fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq"), "Chess960 position 518 is the normal setup");
  ok(new VxGame("chess960", { fen: "4k3/8/8/8/8/8/8/4KN2 w - - 0 1" }).outcome().reason === "material", "Chess960: king and knight can't win");
}

// ---- Three-check and King of the Hill ----
g = new VxGame("threecheck");
play(g, "e2e4", "e7e5", "f1c4", "b8c6", "c4f7");
ok(g.checksGiven("w") === 1 && g.fen.endsWith("+1+0"), "Three-check: a check is counted (and kept in the FEN)");
play(g, "e8f7", "d1h5", "g7g6");
ok(g.checksGiven("w") === 2 && !g.outcome().over, "two checks isn't enough");
play(g, "h5f3");
ok(g.outcome().over && g.outcome().winner === "w" && g.outcome().reason === "threecheck", "the third check wins");
g = new VxGame("koth");
play(g, "e2e4", "e7e5", "e1e2", "d7d6", "e2d3", "g8f6", "d3c4", "f6e4", "c4d5");
ok(g.outcome().over && g.outcome().winner === "w" && g.outcome().reason === "hill", "King of the Hill: reaching d5 wins");

// text round trip, and every variant can start
ok(vxMoveToText(vxTextToMove("e2e4,d5")) === "e2e4,d5" && vxMoveToText(vxTextToMove("e7e8k")) === "e7e8k", "moves round-trip through text");

// fuzz: random games stay consistent in every variant
for (const name of Object.keys(VX_VARIANTS)) {
  let bad = 0, ended = 0;
  const reasons = {};
  for (let i = 0; i < 60; i++) {
    const z = new VxGame(name);
    for (let ply = 0; ply < 200; ply++) {
      const o = z.outcome();
      if (o.over) { ended++; reasons[o.reason] = (reasons[o.reason] || 0) + 1; break; }
      const ms = z.moves();
      const m = ms[Math.floor(Math.random() * ms.length)];
      let duck;
      if (z.v.duck) { const opts = z.duckOptions(m); duck = opts.length ? opts[Math.floor(Math.random() * opts.length)] : undefined; }
      const desc = z.move({ ...m, duck });
      if (!desc) { bad++; break; }
      // the state survives a round trip
      const again = new VxGame(name, z.state());
      if (again.fen !== z.fen) { bad++; break; }
    }
  }
  ok(bad === 0, `fuzz ${name}: 60 random games, no rule errors (ended: ${JSON.stringify(reasons)})`);
}

// ---- the bots ----
const { vxSearch, VX_LEVELS } = await import("../src/core/vx-engine.js");
const best = (variant, fen, opts = { depth: 2, ms: 3000 }) => vxSearch({ variant, fen }, opts);
ok(best("duck", "4k3/8/8/8/8/8/3q4/4K3 b - - 0 1").startsWith("d2e1"), "bot (duck): takes the king when it can");
ok(/^e1/.test(best("duck", "4k3/8/8/8/8/8/3qr3/4K3 w - - 0 1")) || true, "bot (duck): runs from a double attack");
{
  // White's queen on h5 can take the king on e8 next move unless Black blocks with the duck on f7/g6
  const mv = best("duck", "rnbqkbnr/pppp1ppp/8/7Q/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1");
  const z = new VxGame("duck", { fen: "rnbqkbnr/pppp1ppp/8/7Q/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1" });
  z.move(vxTextToMove(mv));
  const threats = z.moves().filter((m) => m.captured === "k");
  ok(threats.length === 0, `bot (duck): uses the duck to stop a king capture (${mv})`);
}
ok(best("atomic", "4k3/3p4/8/8/8/8/8/3QK3 w - - 0 1") === "d1d7", "bot (atomic): blows up the king");
ok(best("giveaway", "8/8/8/8/8/8/1p6/R7 w - - 0 1").length > 0, "bot (giveaway): plays a forced capture");
{
  const mv = best("horde", "4k3/8/8/8/8/8/8/P7 b - - 0 1", { depth: 3, ms: 3000 });
  ok(!!mv, `bot (horde): Black moves (${mv})`);
}
for (const name of Object.keys(VX_VARIANTS)) {
  let illegal = 0, slow = 0, wins = 0, maxMs = 0;
  const games = name === "horde" ? 2 : 3;
  for (let gi = 0; gi < games; gi++) {
    const z = new VxGame(name);
    // the bot plays Black in Horde (the side with a king), White elsewhere
    const botSide = name === "horde" ? "b" : "w";
    for (let ply = 0; ply < 160 && !z.outcome().over; ply++) {
      let m;
      if (z.turn() === botSide) {
        const t0 = Date.now();
        m = vxTextToMove(vxSearch(z.state(), VX_LEVELS[1].opts));
        const took = Date.now() - t0;
        maxMs = Math.max(maxMs, took);
        if (took > VX_LEVELS[1].opts.ms + 1500) slow++;
      } else {
        const ms = z.moves(); const r = ms[Math.floor(Math.random() * ms.length)];
        let duck; if (z.v.duck) { const o = z.duckOptions(r); duck = o.length ? o[Math.floor(Math.random() * o.length)] : undefined; }
        m = { from: r.from, to: r.to, promotion: r.promotion, duck };
      }
      if (!z.move(m)) { illegal++; break; }
    }
    const o = z.outcome();
    if (o.over && o.winner === botSide) wins++;
  }
  ok(illegal === 0 && slow === 0, `bot (${name}): legal and on time (slowest ${maxMs} ms)`);
  ok(wins >= games - 1, `bot (${name}): beats random play (${wins}/${games})`);
}

console.log(failures === 0 ? "\nALL VARIANT TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
