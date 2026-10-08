// Unit tests for the move tree (variations, PGN round-trip) and captured-material helper.
import { MoveTree, START_FEN, capturedFromFen } from "../src/core/tree.js";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };

const t = new MoveTree();
let n = t.root;
for (const san of ["e4", "e5", "Nf3", "Nc6", "Bb5"]) n = t.play(n, san);
ok(t.mainline().map(x => x.san).join(" ") === "e4 e5 Nf3 Nc6 Bb5", "mainline built");
ok(n.ply === 5 && n.uci === "f1b5", "ply + uci tracked");

// variation 2...c5 off 1.e4
const e4 = t.mainline()[0];
const c5 = t.play(e4, "c5");
t.play(c5, "Nf3");
ok(e4.children.length === 2 && e4.children[0].san === "e5", "variation added as second child");
ok(!t.isMainline(c5) && t.isMainline(n), "isMainline");
const same = t.play(e4, "e5");
ok(same === e4.children[0], "replaying an existing move reuses the node");

const pgn = t.toPgn({ White: "A", Black: "B" });
ok(/1\. e4 e5 \(1\.\.\. c5 2\. Nf3\) 2\. Nf3 Nc6 3\. Bb5/.test(pgn.replace(/\n/g, " ")), "PGN with variation: " + pgn.split("\n\n")[1].replace(/\n/g, " "));

const { tree: t2, headers } = MoveTree.fromPgn(pgn);
ok(headers.White === "A" && t2.mainline().length === 5, "PGN import keeps headers + main line");

t.promote(c5);
ok(t.root.children[0].children[0] === c5, "promote variation to main line");
t.remove(c5);
ok(e4.children.length === 1 && !t.get(c5.id), "remove variation");

const fromMoves = MoveTree.fromMoves(["e2e4", "e7e5", "g1f3"]);
ok(fromMoves.mainline().map(x => x.san).join(" ") === "e4 e5 Nf3", "fromMoves accepts UCI");
ok(MoveTree.fromMoves(["e4", "Zz9"]).mainline().length === 1, "fromMoves stops at an illegal move");

const fen = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
const t3 = new MoveTree(fen);
ok(/SetUp/.test(t3.toPgn()) && /FEN/.test(t3.toPgn()), "custom start position adds SetUp/FEN headers");

const c = capturedFromFen("rnbqkbnr/pppp1ppp/8/8/8/8/PPPP1PPP/RNB1KBNR w KQkq - 0 3");
ok(c.captured.w.join("") === "pq" && c.captured.b.join("") === "p" && c.diff === -9, "capturedFromFen: white missing p+q, diff -9");
ok(t.chessAt(t.mainline()[2]).fen() === t.mainline()[2].fen, "chessAt replays to node");
ok(START_FEN.startsWith("rnbqkbnr"), "start fen");

console.log(failures === 0 ? "\nALL CORE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
