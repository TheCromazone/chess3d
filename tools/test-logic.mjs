// Exercises dist/logic.js the way the room kernel would.
import * as L from "../dist/logic.js";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };

const P1 = "p-alice", P2 = "p-bob";
let s = L.setup([P1, P2]);
ok(s.white === P1 && s.black === P2, "setup seats white/black");
ok(L.isGameOver(s).over === false, "not over at start");

// config gate
ok(!L.validateAction(s, P1, { t: "move", from: "e2", to: "e4" }).ok, "move blocked before config");
ok(!L.validateAction(s, P2, { t: "config", tc: "3+2" }).ok, "black cannot configure");
ok(L.validateAction(s, P1, { t: "config", tc: "3+2" }).ok, "white configures");
s = L.applyAction(s, P1, { t: "config", tc: "3+2" });
ok(s.phase === "playing" && s.clock.w === 180000, "clock initialized 3+2");

// turn order + legality
ok(!L.validateAction(s, P2, { t: "move", from: "e7", to: "e5" }).ok, "black cannot move first");
ok(!L.validateAction(s, P1, { t: "move", from: "e2", to: "e5" }).ok, "illegal move rejected");
ok(L.validateAction(s, P1, { t: "move", from: "e2", to: "e4" }).ok, "e4 legal");

// scholar's mate
const moves = [
  [P1, "e2", "e4"], [P2, "e7", "e5"],
  [P1, "f1", "c4"], [P2, "b8", "c6"],
  [P1, "d1", "h5"], [P2, "g8", "f6"],
  [P1, "h5", "f7"],
];
for (const [pid, from, to] of moves) {
  const v = L.validateAction(s, pid, { t: "move", from, to });
  if (!v.ok) { ok(false, `move ${from}${to}: ${v.error}`); break; }
  s = L.applyAction(s, pid, { t: "move", from, to });
}
let r = L.isGameOver(s);
ok(r.over && r.winner === P1 && r.reason === "checkmate", "scholar's mate → white wins by checkmate");
ok(s.san.join(" ") === "e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#", "SAN recorded: " + s.san.join(" "));
ok(s.clock.w > 170000 && s.clock.w <= 180000 + 4 * 2000, "white clock decremented + increments");

// resignation
let s2 = L.setup([P1, P2]);
s2 = L.applyAction(s2, P1, { t: "config", tc: "inf" });
s2 = L.applyAction(s2, P1, { t: "move", from: "e2", to: "e4" });
ok(!L.validateAction(s2, P1, { t: "flag" }).ok, "flag rejected in unlimited game");
s2 = L.applyAction(s2, P2, { t: "resign" });
r = L.isGameOver(s2);
ok(r.over && r.winner === P1 && r.reason === "resignation", "resignation → white wins");

// draw agreement
let s3 = L.setup([P1, P2]);
s3 = L.applyAction(s3, P1, { t: "config", tc: "10+0" });
s3 = L.applyAction(s3, P1, { t: "draw-offer" });
ok(!L.validateAction(s3, P1, { t: "draw-accept" }).ok, "cannot accept own offer");
ok(L.validateAction(s3, P2, { t: "draw-accept" }).ok, "opponent can accept");
s3 = L.applyAction(s3, P2, { t: "draw-accept" });
r = L.isGameOver(s3);
ok(r.over && r.draw && r.reason === "agreement", "draw by agreement");

// flag claim (simulate elapsed time by rewinding lastAt)
let s4 = L.setup([P1, P2]);
s4 = L.applyAction(s4, P1, { t: "config", tc: "1+0" });
ok(!L.validateAction(s4, P2, { t: "flag" }).ok, "flag rejected while white has time");
s4 = { ...s4, clock: { ...s4.clock, lastAt: Date.now() - 61000 } };
ok(L.validateAction(s4, P2, { t: "flag" }).ok, "flag accepted after white's time expired");
s4 = L.applyAction(s4, P2, { t: "flag" });
r = L.isGameOver(s4);
ok(r.over && r.winner === P2 && r.reason === "timeout", "timeout → black wins");

// stalemate detection (fastest known stalemate)
let s5 = L.setup([P1, P2]);
s5 = L.applyAction(s5, P1, { t: "config", tc: "inf" });
const stale = [
  [P1,"e2","e3"],[P2,"a7","a5"],[P1,"d1","h5"],[P2,"a8","a6"],
  [P1,"h5","a5"],[P2,"h7","h5"],[P1,"h2","h4"],[P2,"a6","h6"],
  [P1,"a5","c7"],[P2,"f7","f6"],[P1,"c7","d7"],[P2,"e8","f7"],
  [P1,"d7","b7"],[P2,"d8","d3"],[P1,"b7","b8"],[P2,"d3","h7"],
  [P1,"b8","c8"],[P2,"f7","g6"],[P1,"c8","e6"],
];
for (const [pid, from, to] of stale) {
  const v = L.validateAction(s5, pid, { t: "move", from, to });
  if (!v.ok) { ok(false, `stalemate line ${from}${to}: ${v.error}`); break; }
  s5 = L.applyAction(s5, pid, { t: "move", from, to });
}
r = L.isGameOver(s5);
ok(r.over && r.draw && r.reason === "stalemate", "stalemate detected");

// state must survive JSON round-trip
ok(JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s), "state JSON-safe");

// spectator rejected
ok(!L.validateAction(s2, "p-nosy", { t: "move", from: "e7", to: "e5" }).ok, "spectator cannot act");

// v2 additions: chat, custom time control, abort, takebacks
let s6 = L.setup([P1, P2]);
ok(s6.v === 2 && Array.isArray(s6.chat), "state advertises v2");
ok(L.validateAction(s6, P1, { t: "config", tc: "7+3" }).ok, "custom time control accepted");
ok(!L.validateAction(s6, P1, { t: "config", tc: "999+0" }).ok, "absurd time control rejected");
s6 = L.applyAction(s6, P1, { t: "config", tc: "7+3" });
ok(s6.tc.initial === 420 && s6.tc.inc === 3, "custom clock 7+3");
ok(L.validateAction(s6, P2, { t: "chat", text: "good luck!" }).ok, "chat allowed");
ok(!L.validateAction(s6, "p-nosy", { t: "chat", text: "hi" }).ok, "spectators can't chat");
s6 = L.applyAction(s6, P2, { t: "chat", text: "  good luck!  " });
ok(s6.chat.length === 1 && s6.chat[0].c === "b" && s6.chat[0].text === "good luck!", "chat stored trimmed with color");
ok(L.validateAction(s6, P1, { t: "abort" }).ok, "abort allowed before moves");
s6 = L.applyAction(s6, P1, { t: "move", from: "e2", to: "e4" });
s6 = L.applyAction(s6, P2, { t: "move", from: "e7", to: "e5" });
ok(!L.validateAction(s6, P1, { t: "abort" }).ok, "abort refused after both moved");
s6 = L.applyAction(s6, P1, { t: "move", from: "g1", to: "f3" });
ok(L.validateAction(s6, P1, { t: "takeback-offer" }).ok, "takeback request allowed");
s6 = L.applyAction(s6, P1, { t: "takeback-offer" });
ok(!L.validateAction(s6, P1, { t: "takeback-accept" }).ok, "can't accept own takeback");
s6 = L.applyAction(s6, P2, { t: "takeback-accept" });
ok(s6.moves.length === 2 && s6.san.join(" ") === "e4 e5" && !s6.takebackOffer, "takeback undid Nf3 (opponent to move → 1 ply)");
let s7 = L.applyAction(L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf" }), P1, { t: "abort" });
r = L.isGameOver(s7);
ok(r.over && r.draw && r.reason === "aborted", "aborted game reported");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
