// Chess960 adapter tests: position generation, castling geometry, rights, and random-game fuzzing.
import { Chess960, chess960Fen, createChess, is960Fen } from "../src/core/chess960.js";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };

ok(chess960Fen(518).startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha"), "position 518 is the standard setup");
const seen = new Set();
for (let n = 0; n < 960; n++) {
  const row = chess960Fen(n).split("/")[0];
  seen.add(row);
  const b1 = row.indexOf("b"), b2 = row.lastIndexOf("b");
  const k = row.indexOf("k"), r1 = row.indexOf("r"), r2 = row.lastIndexOf("r");
  if ((b1 + b2) % 2 === 0 || !(r1 < k && k < r2)) { ok(false, "bad setup " + n + " " + row); break; }
}
ok(seen.size === 960, "960 distinct legal setups");
ok(is960Fen(chess960Fen(0)) && !is960Fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"), "is960Fen");
ok(createChess(chess960Fen(5)) instanceof Chess960, "createChess routes 960 FENs");

// kingside castle with king on b1, rook on c1? use a hand-made position: king f1, rook h1, rook a1
let c = new Chess960("4k3/8/8/8/8/8/8/R4K1R w HA - 0 1");
let cs = c.moves({ verbose: true, square: "f1" }).filter(m => m.castle960);
ok(cs.some(m => m.to === "h1" && m.san === "O-O") && cs.some(m => m.to === "a1" && m.san === "O-O-O"), "both castles generated (king f1)");
c.move({ from: "f1", to: "h1" });
ok(c.fen().startsWith("4k3/8/8/8/8/8/8/R4RK1 b - -"), "O-O lands king g1 rook f1: " + c.fen());
c.undo();
ok(c.fen().startsWith("4k3/8/8/8/8/8/8/R4K1R w HA"), "undo restores rights");
c.move("O-O-O");
ok(c.fen().startsWith("4k3/8/8/8/8/8/8/2KR3R b - -"), "O-O-O lands king c1 rook d1: " + c.fen());

// king already on its destination (g1) with rook h1: castling just moves the rook
c = new Chess960("4k3/8/8/8/8/8/8/6KR w H - 0 1");
cs = c.moves({ verbose: true }).filter(m => m.castle960);
ok(cs.length === 1, "castle when king already on g1");
c.move({ from: "g1", to: "h1" });
ok(c.fen().startsWith("4k3/8/8/8/8/8/8/5RK1 b"), "rook hops to f1: " + c.fen());

// blocked & attacked paths
c = new Chess960("4k3/8/8/8/8/8/8/RN2K2R w HA - 0 1");
ok(!c.moves({ verbose: true }).some(m => m.castle960 && m.flags === "q"), "queenside blocked by knight");
c = new Chess960("4k3/8/8/8/8/8/5r2/R3K2R w HA - 0 1");
ok(!c.moves({ verbose: true }).some(m => m.castle960 && m.flags === "k"), "kingside illegal through attacked f1");
c = new Chess960("4k3/8/8/8/8/8/8/R3K2R w HA - 0 1");
c.move("Rb1"); 
ok(c.fen().split(" ")[2] === "H", "rook move drops that right: " + c.fen().split(" ")[2]);

// random fuzz: 300 games from random setups, every move legal, no exceptions
let castles = 0, games = 0;
for (let g = 0; g < 300; g++) {
  const x = new Chess960(chess960Fen(Math.floor(Math.random() * 960)));
  for (let ply = 0; ply < 120 && !x.isGameOver(); ply++) {
    const ms = x.moves({ verbose: true }).filter(m => !m.alias);
    const pick = ms.find(m => m.castle960 && Math.random() < 0.7) || ms[Math.floor(Math.random() * ms.length)];
    if (pick.castle960) castles++;
    const before = x.fen();
    x.move(pick.castle960 ? { from: pick.from, to: pick.to } : { from: pick.from, to: pick.to, promotion: pick.promotion });
    const kings = x.fen().split(" ")[0].replace(/[^kK]/g, "");
    if (kings.length !== 2) { ok(false, "king vanished after " + before + " " + pick.san); g = 999; break; }
  }
  games++;
}
ok(games === 300 && castles > 50, `fuzz: 300 random 960 games, ${castles} castles`);

console.log(failures === 0 ? "\nALL 960 TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
