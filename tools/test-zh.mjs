// Crazyhouse rules (src/core/zh.js): pockets, drops, checks and mates, promoted pieces, fuzzing.
import { Crazyhouse, textToMove, moveToText } from "../src/core/zh.js";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };
const play = (g, ...ts) => ts.map((t) => g.move(textToMove(t)));

let g = new Crazyhouse();
ok(g.legalMoves().length === 20 && !g.legalMoves().some((m) => m.drop), "the start has 20 moves and nothing to drop");
play(g, "e2e4", "d7d5", "e4d5");
ok(g.pockets.w.p === 1 && g.pockets.b.p === 0, "a capture goes to the capturer's pocket");
play(g, "d8d5");
const drops = g.legalMoves().filter((m) => m.drop);
ok(drops.length > 0 && drops.every((m) => m.drop === "p" && !/[18]$/.test(m.to)), "pawns can be dropped, never on the first or last rank");
ok(g.move(textToMove("P@e8")) === null, "dropping onto an occupied or back-rank square is refused");
const d = g.move(textToMove("P@c4"));
ok(d && d.san === "@c4" && g.pockets.w.p === 0 && g.chess().get("c4").type === "p" && g.turn() === "b", "a drop places the piece, empties the pocket and passes the move");

// a drop that gives mate
g = new Crazyhouse({ fen: "6k1/5ppp/8/8/8/8/8/K7 w - - 0 1", pockets: { w: { q: 0, r: 1, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } } });
const mate = g.move(textToMove("R@d8"));
ok(mate && mate.san === "R@d8#" && g.outcome().over && g.outcome().winner === "w" && g.outcome().reason === "checkmate", "a back-rank rook drop mates");
// but not when the defender can drop a blocker
g = new Crazyhouse({ fen: "6k1/5ppp/8/8/8/8/8/K7 w - - 0 1", pockets: { w: { q: 0, r: 1, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 1, p: 0 } } });
const chk = g.move(textToMove("R@a8"));
const replies = g.legalMoves();
ok(chk.san === "R@a8+" && !g.outcome().over && replies.every((m) => m.drop === "n" && /8$/.test(m.to)), "in check, the only drops are ones that block");

// a promoted piece goes back to the pocket as a pawn
g = new Crazyhouse({ fen: "4k3/1P6/8/8/8/8/8/4K3 w - - 0 1" });
play(g, "b7b8q");
ok(g.promoted.includes("b8"), "a promoted piece is remembered");
g = new Crazyhouse({ fen: "1q2k3/8/8/8/8/8/8/4K3 b - - 0 1", promoted: ["b8"] });
play(g, "e8d7");
g = new Crazyhouse({ fen: "1q2k3/8/8/8/8/8/8/1R2K3 w - - 0 1", promoted: ["b8"] });
play(g, "b1b8");
ok(g.pockets.w.p === 1 && g.pockets.w.q === 0, "capturing a promoted queen gives a pawn");

// repetition
g = new Crazyhouse();
play(g, "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8");
ok(g.outcome().over && g.outcome().reason === "threefold", "threefold repetition is a draw");
ok(moveToText(textToMove("N@f3")) === "N@f3" && moveToText(textToMove("e7e8q")) === "e7e8q", "moves round-trip through text");

// fuzz: random games never lose or invent a piece, and always end or keep going legally
let bad = 0, games = 0, mates = 0;
for (let i = 0; i < 120; i++) {
  const z = new Crazyhouse();
  for (let ply = 0; ply < 160; ply++) {
    const o = z.outcome();
    if (o.over) { if (o.reason === "checkmate") mates++; break; }
    const ms = z.legalMoves();
    const m = ms[Math.floor(Math.random() * ms.length)];
    if (!z.move(m.drop ? { drop: m.drop, to: m.to } : { from: m.from, to: m.to, promotion: m.promotion })) { bad++; break; }
    const c = z.chess();
    let onBoard = 0;
    for (const row of c.board()) for (const p of row) if (p) onBoard++;
    const inPockets = Object.values(z.pockets.w).reduce((a, b) => a + b, 0) + Object.values(z.pockets.b).reduce((a, b) => a + b, 0);
    if (onBoard + inPockets !== 32) { bad++; break; }
  }
  games++;
}
ok(bad === 0, `fuzz: ${games} random games, every piece always on the board or in a pocket (${mates} ended in mate)`);

// the engine
const { search, ZH_LEVELS } = await import("../src/core/zh-engine.js");
const mateIn1 = { fen: "6k1/5ppp/8/8/8/8/8/K7 w - - 0 1", pockets: { w: { q: 0, r: 1, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } } };
const mv = search(mateIn1, { depth: 2, ms: 2000 });
const zm = new Crazyhouse(mateIn1); zm.move(textToMove(mv));
ok(zm.outcome().reason === "checkmate", `the engine finds a mating drop (${mv})`);
const hanging = { fen: "rnb1kbnr/pppp1ppp/8/4p1q1/4P3/3P4/PPP2PPP/RNBQKBNR w KQkq - 1 3" };
const take = search({ ...hanging, pockets: { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } } }, { depth: 2, ms: 2000 });
ok(take === "c1g5", `the engine takes a hanging queen (${take})`);
// engine vs random: every move legal, within its time budget
let illegal = 0, slow = 0, engineWins = 0;
for (let gi = 0; gi < 4; gi++) {
  const z = new Crazyhouse();
  for (let ply = 0; ply < 120 && !z.outcome().over; ply++) {
    let m;
    if (ply % 2 === 0) {
      const t0 = Date.now();
      m = textToMove(search(z.state(), ZH_LEVELS[1].opts));
      if (Date.now() - t0 > ZH_LEVELS[1].opts.ms + 800) slow++;
    } else {
      const ms = z.legalMoves(); const r = ms[Math.floor(Math.random() * ms.length)];
      m = r.drop ? { drop: r.drop, to: r.to } : { from: r.from, to: r.to, promotion: r.promotion };
    }
    if (!z.move(m)) { illegal++; break; }
  }
  const o = z.outcome();
  if (o.over && o.winner === "w") engineWins++;
}
ok(illegal === 0 && slow === 0, "engine moves are always legal and on time");
ok(engineWins >= 3, `the club-level bot beats random play (${engineWins}/4)`);

console.log(failures === 0 ? "\nALL CRAZYHOUSE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
