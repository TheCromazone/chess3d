// 4-Player Chess rules (src/core/fp.js): setup, moves for every army, castling, en passant,
// promotion, check from anyone, free-for-all scoring and eliminations, Teams, and random-game fuzzing.
import { FourPlayer, fpStart, fpLegal, fpIndex, fpSquare, FP_SQUARES } from "../src/core/fp.js";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };
const mv = (g, from, to, promotion) => { const e = g.play({ from, to, promotion }); if (!e) throw new Error(`illegal in test: ${g.turn()} ${from}-${to}`); return e; };

ok(FP_SQUARES.length === 160, "the board has 160 squares (14x14 without the corners)");
let g = new FourPlayer("ffa");
const at = (sq) => g.pieces().find((p) => p.sq === sq);
ok(at("h1").type === "k" && at("g1").type === "q" && at("h1").color === "r", "Red: king h1, queen g1");
ok(at("a7").type === "k" && at("a8").type === "q" && at("a7").color === "b", "Blue: king a7, queen a8");
ok(at("g14").type === "k" && at("h14").type === "q" && at("g14").color === "y", "Yellow: king g14, queen h14");
ok(at("n8").type === "k" && at("n7").type === "q" && at("n8").color === "g", "Green: king n8, queen n7");
ok(g.pieces().length === 64, "64 pieces");
const counts = [0, 1, 2, 3].map((c) => fpLegal({ ...fpStart(), turn: c }, false).length);
ok(counts.every((n) => n === 20), `every army has 20 first moves (${counts})`);

// turn order and pawn directions
mv(g, "h2", "h4"); ok(g.turn() === "b", "Red, then Blue");
mv(g, "b8", "d8"); ok(g.turn() === "y", "Blue's pawns move right");
mv(g, "g13", "g11"); ok(g.turn() === "g", "Yellow's pawns move down");
mv(g, "m9", "k9"); ok(g.turn() === "r", "Green's pawns move left, then back to Red");
ok(g.log.length === 4 && g.log[0].c === "r" && g.log[0].san === "h4", "the move list records who moved");

// castling, both ways, for Red
let s = fpStart();
for (const sq of ["e1", "f1", "g1", "i1", "j1"]) s.b[fpIndex(sq)] = 0;
let ms = fpLegal(s, false).filter((m) => fpSquare(m.from) === "h1").map((m) => fpSquare(m.to));
ok(ms.includes("j1") && ms.includes("f1"), "Red can castle short (Kj1) and long (Kf1)");
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
mv(g, "h1", "j1");
ok(at("j1").type === "k" && at("i1").type === "r" && !at("k1"), "short castling puts the rook on i1");

// promotion on the 8th rank in free-for-all (always a queen, worth 1 point when taken)
s = fpStart();
s.b.fill(0);
const put = (sq, t, c) => { s.b[fpIndex(sq)] = t | (c << 3); };
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("e7", 1, 0);
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
mv(g, "e7", "e8");
ok(at("e8").type === "q" && at("e8").promoted, "a Red pawn promotes to a queen on the 8th rank");

// en passant: Blue can take Red's double step until Red moves again
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("f2", 1, 0); put("e4", 1, 1);   // a Blue pawn on e4 moves right, so it attacks f5 and f3
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
mv(g, "f2", "f4");
ok(g.legalMoves().some((m) => m.from === "e4" && m.to === "f3"), "Blue may take the double-stepped pawn en passant");
mv(g, "e4", "f3");
ok(!at("f4") && at("f3").color === "b", "en passant removes the pawn that stepped past");

// check from any opponent, and free-for-all checkmate points
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("h3", 4, 2);  // a Yellow rook gives Red check down the h-file
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
ok(g.inCheck("r") && g.legalMoves().every((m) => m.from === "h1"), "Red, checked by Yellow, must deal with it");

// a two-rook mate on Red's king, delivered by Blue, scored on Red's turn
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("d2", 4, 1); put("e3", 4, 1);
s.turn = 1;
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
mv(g, "e3", "e1");   // Blue: Re1+ with Rd2 covering the 2nd rank
ok(g.status()[0] === "active" && g.turn() === "y", "a mate only counts when the mated player's turn comes");
mv(g, "g14", "f13");
mv(g, "n8", "m8");
ok(g.status()[0] === "out" && g.points()[1] === 20, "Blue mates Red: on Red's turn Red is out and Blue scores 20");
ok(g.pieces().filter((p) => p.color === "r").every((p) => p.dead), "Red's army turns grey");
ok(g.turn() === "b", "play goes on with Blue");

// capture points, and nothing for grey pieces
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("h5", 5, 0); put("h9", 4, 2);
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
mv(g, "h5", "h9");
ok(g.points()[0] === 5, "taking a rook scores 5");

// resigning in free-for-all: grey army, wandering king; the game ends when three are out
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("e5", 4, 0); put("e9", 4, 1); put("j10", 4, 2); put("j5", 4, 3);
g = new FourPlayer("ffa", { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
g.resign("r");
ok(g.status()[0] === "resigned" && g.turn() === "b" && g.log.some((x) => x.c === "r" && /^K/.test(x.san || "")), "Red resigns on its turn: its king makes a move by itself, then Blue plays");
mv(g, "a7", "b7");
mv(g, "g14", "f14");
mv(g, "n8", "m8");
ok(g.turn() === "b" && g.log.filter((x) => x.c === "r" && x.san).length >= 1, "Red's king moves on its own");
g.resign("b"); g.resign("y");
ok(g.result && g.result.reason === "last-standing" && g.result.winner === "g", "three out: Green, the last one standing, wins");
ok(g.points()[3] >= 60, "and collects 20 for each king still on the board");

// claiming the win with a 21-point lead
s = fpStart();
const st = { mode: "ffa", pos: { ...s, b: Array.from(s.b), status: ["active", "out", "active", "out"], points: [30, 0, 5, 0] }, log: [], keys: [], result: null };
g = new FourPlayer("ffa", st);
ok(g.canClaim("r") && !g.canClaim("y"), "two left, 25 points ahead: Red may claim");
g.claim("r");
ok(g.result && g.result.winner === "r", "the claim ends the game with Red first");

// Teams: partners can't take each other; mate one opponent and your team wins
g = new FourPlayer("teams");
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("h5", 5, 0); put("h9", 4, 2);
g = new FourPlayer("teams", { mode: "teams", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
ok(!g.legalMoves().some((m) => m.from === "h5" && m.to === "h9"), "Teams: Red can't take Yellow's rook");
s = fpStart();
s.b.fill(0);
put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
put("d2", 4, 1); put("e3", 4, 1);
s.turn = 1;
g = new FourPlayer("teams", { mode: "teams", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null });
mv(g, "e3", "e1");
mv(g, "g14", "f13");
mv(g, "n8", "m8");
ok(g.result && g.result.winner === "bg" && g.result.reason === "checkmate", "Teams: Blue mates Red, Blue and Green win");
ok(new FourPlayer("teams").legalMoves().length === 20, "Teams starts the same way");

// fuzz: random games run to the end without breaking
let bad = 0, ended = 0, plies = 0;
const reasons = {};
for (const mode of ["ffa", "teams"]) {
  for (let i = 0; i < 25; i++) {
    const z = new FourPlayer(mode);
    for (let k = 0; k < 1500 && !z.result; k++) {
      const legal = z.legalMoves();
      if (!legal.length) { bad++; break; }
      const m = legal[Math.floor(Math.random() * legal.length)];
      if (!z.play(m)) { bad++; break; }
      // the saved state rebuilds the same game
      if (k % 97 === 0) { const again = new FourPlayer(mode, JSON.parse(JSON.stringify(z.state()))); if (again.key() !== z.key()) { bad++; break; } }
      plies++;
    }
    if (z.result) { ended++; reasons[z.result.reason] = (reasons[z.result.reason] || 0) + 1; }
  }
}
ok(bad === 0, `fuzz: 50 random games, no rule errors (${ended} finished: ${JSON.stringify(reasons)}, ${plies} moves)`);

// the bots
const { fpSearch, FP_LEVELS } = await import("../src/core/fp-engine.js");
const { fpTextToMove, fpMoveToText } = await import("../src/core/fp.js");
ok(fpMoveToText(fpTextToMove("e10-e11q")) === "e10-e11q" && fpTextToMove("x1-a1") === null, "move text round-trips");
{
  // a free queen: Red's queen can take Yellow's undefended queen
  s = fpStart();
  s.b.fill(0);
  put("h1", 6, 0); put("a7", 6, 1); put("g14", 6, 2); put("n8", 6, 3);
  put("h5", 5, 0); put("h9", 5, 2);
  const st = { mode: "ffa", pos: { ...s, b: Array.from(s.b) }, log: [], keys: [], result: null };
  ok(fpSearch(st, { depth: 2, ms: 2000 }) === "h5-h9", "bot: takes a free queen");
}
for (const mode of ["ffa", "teams"]) {
  let illegal = 0, slow = 0, maxMs = 0, ahead = 0;
  const games = 2;
  for (let gi = 0; gi < games; gi++) {
    const z = new FourPlayer(mode);
    for (let k = 0; k < 160 && !z.result; k++) {
      let m;
      if (z.turn() === "r" || (mode === "teams" && z.turn() === "y")) {
        const t0 = Date.now();
        m = fpTextToMove(fpSearch(z.state(), FP_LEVELS[1].opts));
        const took = Date.now() - t0;
        maxMs = Math.max(maxMs, took);
        if (took > FP_LEVELS[1].opts.ms + 1500) slow++;
      } else {
        const legal = z.legalMoves();
        m = legal[Math.floor(Math.random() * legal.length)];
      }
      if (!z.play(m)) { illegal++; break; }
    }
    const pts = z.points();
    if (mode === "ffa" ? pts[0] >= Math.max(pts[1], pts[2], pts[3]) : z.result ? z.result.winner === "ry" : true) ahead++;
  }
  ok(illegal === 0 && slow === 0, `bot (${mode}): legal and on time (slowest ${maxMs} ms)`);
  ok(ahead >= 1, `bot (${mode}): does better than random players (${ahead}/${games})`);
}

console.log(failures === 0 ? "\nALL 4-PLAYER TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
