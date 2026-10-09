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
ok(s6.v >= 2 && Array.isArray(s6.chat), "state advertises v2 or later");
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

// v3: daily games with a deadline per move
let s8 = L.setup([P1, P2]);
ok(s8.v >= 3, "state advertises v3");
ok(L.validateAction(s8, P1, { t: "config", tc: "3d" }).ok, "3 days per move accepted");
ok(!L.validateAction(s8, P1, { t: "config", tc: "4d" }).ok, "unsupported daily length rejected");
s8 = L.applyAction(s8, P1, { t: "config", tc: "3d" });
const D3 = 3 * 86400000;
ok(s8.tc.perMove && s8.clock.w === D3 && s8.clock.b === D3, "both sides start with 3 days");
s8 = { ...s8, clock: { ...s8.clock, lastAt: Date.now() - 2 * 86400000 } };   // White thinks for 2 days
s8 = L.applyAction(s8, P1, { t: "move", from: "e2", to: "e4" });
ok(s8.moves.length === 1 && s8.clock.w === D3, "after moving, White's allowance resets to 3 days");
ok(!L.validateAction(s8, P1, { t: "flag" }).ok, "no flag while Black is inside the deadline");
s8 = { ...s8, clock: { ...s8.clock, lastAt: Date.now() - D3 - 1000 } };       // Black misses the deadline
ok(L.validateAction(s8, P1, { t: "flag" }).ok, "flag accepted once Black's deadline has passed");
s8 = L.applyAction(s8, P1, { t: "flag" });
r = L.isGameOver(s8);
ok(r.over && r.winner === P1 && r.reason === "timeout", "missing the daily deadline loses on time");
let s9 = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "1d" });
s9 = { ...s9, clock: { ...s9.clock, lastAt: Date.now() - 86400000 - 1000 } };
s9 = L.applyAction(s9, P1, { t: "move", from: "e2", to: "e4" });
ok(s9.flagged === "w" && s9.moves.length === 0, "a move after your deadline is a loss, not a move");

// v4: Crazyhouse
let z = L.setup([P1, P2]);
ok(z.v >= 4, "state advertises v4");
ok(!L.validateAction(z, P1, { t: "config", tc: "3+0", variant: "losers" }).ok, "unknown variants are refused (v4)");
z = L.applyAction(z, P1, { t: "config", tc: "3+0", variant: "crazyhouse" });
const zplay = (pid, mv) => { const v = L.validateAction(z, pid, { t: "move", move: mv }); if (!v.ok) { ok(false, mv + ": " + v.error); return; } z = L.applyAction(z, pid, { t: "move", move: mv }); };
for (const [pid, mv] of [[P1, "e2e4"], [P2, "d7d5"], [P1, "e4d5"], [P2, "d8d5"]]) zplay(pid, mv);
ok(z.zh.pockets.w.p === 1 && z.zh.pockets.b.p === 1, "captures fill the pockets");
ok(L.validateAction(z, P1, { t: "move", move: "P@e4" }).ok && !L.validateAction(z, P1, { t: "move", move: "Q@e4" }).ok, "you can only drop what you hold");
zplay(P1, "P@e4");
ok(z.san[z.san.length - 1] === "@e4" && z.zh.pockets.w.p === 0, "a drop is recorded and leaves the pocket");
ok(!L.validateAction(z, P1, { t: "takeback-offer" }).ok, "no takebacks in Crazyhouse");
let zm = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "crazyhouse" });
zm = { ...zm, zh: { fen: "6k1/5ppp/8/8/8/8/8/K7 w - - 0 1", pockets: { w: { q: 0, r: 1, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } }, promoted: [], keys: [] } };
zm = L.applyAction(zm, P1, { t: "move", move: "R@d8" });
r = L.isGameOver(zm);
ok(r.over && r.winner === P1 && r.reason === "checkmate", "a drop can mate");

// v4: Bughouse. Board A (P1 White, P2 Black) and board B (P3 White, P4 Black); teams P1+P4 v P2+P3.
const P3 = "p-carol", P4 = "p-dave";
let A = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "3+0", variant: "bughouse", link: "bh-b" });
let Bd = L.applyAction(L.setup([P3, P4]), P3, { t: "config", tc: "3+0", variant: "bughouse", link: "bh-a" });
ok(!L.validateAction(L.setup([P1, P2]), P1, { t: "config", tc: "3+0", variant: "bughouse" }).ok, "a bughouse board needs its partner");
for (const [pid, mv] of [[P1, "e2e4"], [P2, "d7d5"], [P1, "e4d5"]]) A = L.applyAction(A, pid, { t: "move", move: mv });
ok(A.zh.pockets.w.p === 0 && A.outbox.length === 1 && A.outbox[0].t === "give" && A.outbox[0].color === "b" && A.outbox[0].type === "p", "a capture goes to the partner, not the capturer");
ok(!L.validateAction(Bd, P4, { t: "give", color: "b", type: "q" }).ok, "players can't give themselves pieces");
Bd = L.applyAction(Bd, "__link", A.outbox[0]);
ok(Bd.zh.pockets.b.p === 1, "the partner board receives the piece");
A = L.applyAction(A, P2, { t: "resign" });
const end = A.outbox.find((m) => m.t === "partner-end");
ok(L.isGameOver(A).over && end && end.winner === "b", "when board A ends, a result goes to board B (A's White won, so B's Black wins)");
Bd = L.applyAction(Bd, "__link", end);
r = L.isGameOver(Bd);
ok(r.over && r.winner === P4 && /^partner-/.test(r.reason), "board B ends with the same team winning (P1 and P4)");

// v5: Duck Chess, Fog of War, Giveaway, Atomic, Horde
ok(L.setup([P1, P2]).v >= 5, "state advertises v5");
ok(!L.validateAction(L.setup([P1, P2]), P1, { t: "config", tc: "3+0", variant: "kriegspiel" }).ok, "unknown variants are refused");
const vplay = (st, ...ms) => { for (const [pid, mv] of ms) { const v = L.validateAction(st, pid, { t: "move", move: mv }); if (!v.ok) throw new Error(mv + ": " + v.error); st = L.applyAction(st, pid, { t: "move", move: mv }); } return st; };
let d = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "3+0", variant: "duck" });
ok(d.variant === "duck" && d.vx && !d.zh, "a duck room keeps its position in state.vx");
ok(!L.validateAction(d, P1, { t: "move", move: "e2e4" }).ok, "duck: a move without the duck is refused");
ok(!L.validateAction(vplay(d, [P1, "e2e4,e6"]), P2, { t: "move", move: "e7e5,a3" }).ok, "duck: a pawn can't pass through the duck");
d = vplay(d, [P1, "e2e4,e6"], [P2, "d7d5,a3"]);
ok(d.san.join(" ") === "e4@e6 d5@a3" && !L.validateAction(d, P1, { t: "move", move: "a2a3,h5" }).ok, "duck: moves are recorded with the duck, which blocks its square");
let atom = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "atomic" });
atom = vplay(atom, [P1, "e2e4"], [P2, "d7d5"], [P1, "e4d5"]);
ok(atom.fen.split(" ")[0] === "rnbqkbnr/ppp1pppp/8/8/8/8/PPPP1PPP/RNBQKBNR", "atomic: a capture explodes (both pawns gone)");
atom = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "atomic" });
atom = vplay(atom, [P1, "g1f3"], [P2, "e7e6"], [P1, "f3g5"], [P2, "a7a6"], [P1, "g5f7"]);
r = L.isGameOver(atom);
ok(r.over && r.winner === P1 && r.reason === "explosion", "atomic: Nxf7 blows up the king and wins");
let give = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "giveaway" });
give = vplay(give, [P1, "e2e3"], [P2, "b7b5"]);
ok(!L.validateAction(give, P1, { t: "move", move: "a2a3" }).ok && L.validateAction(give, P1, { t: "move", move: "f1b5" }).ok, "giveaway: a capture is compulsory");
let horde = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "horde" });
ok(horde.fen.startsWith("rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP"), "horde: the horde is set up");
// Fog of War: each side sees only its own part of the board, and the other side's moves stay hidden
let fog = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "fog" });
fog = vplay(fog, [P1, "e2e4"], [P2, "e7e5"]);
const vw = L.viewFor(fog, P1), vb = L.viewFor(fog, P2), vs = L.viewFor(fog, "p-spectator");
ok(!vw.fen.split(" ")[0].includes("r") && vw.fen.includes("P"), "fog: White's view hides Black's back rank");
ok(vw.moves[0] === "e2e4" && vw.moves[1] === null && vw.san[1] === null, "fog: White doesn't see Black's move");
ok(vb.moves[0] === null && vb.moves[1] === "e7e5", "fog: Black doesn't see White's move");
ok(Array.isArray(vw.legal) && vw.legal.includes("g1f3") && !vw.legal.includes("e4e5") && vb.legal.length === 0, "fog: the mover gets their legal moves (e4 is blocked by an unseen pawn)");
ok(vw.visible.includes("e5") === false && vw.vx.keys.length === 0, "fog: a blocking pawn stays hidden; history isn't sent");
ok(vs.fen.startsWith("8/8/8/8/8/8/8/8") && vs.moves.every((m) => m === null), "fog: spectators see nothing until the end");
fog = L.applyAction(fog, P2, { t: "resign" });
ok(L.viewFor(fog, P1).moves[1] === "e7e5" && L.viewFor(fog, P1).fen.includes("pppp1ppp"), "fog: everything is revealed when the game ends");

// online Chess960, Three-check, King of the Hill (rules v5 variants)
ok(!L.validateAction(L.setup([P1, P2]), P1, { t: "config", tc: "3+0", variant: "chess960" }).ok, "Chess960 needs a starting position");
let c9 = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "3+0", variant: "chess960", start: 0 });
ok(c9.fen.startsWith("bbqnnrkr/pppppppp") && c9.vx.fen === c9.fen, "Chess960 position 0 is set up (bbqnnrkr)");
let k3 = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "threecheck" });
k3 = vplay(k3, [P1, "e2e4"], [P2, "e7e5"], [P1, "f1c4"], [P2, "b8c6"], [P1, "c4f7"], [P2, "e8f7"], [P1, "d1h5"], [P2, "g7g6"], [P1, "h5f3"]);
r = L.isGameOver(k3);
ok(r.over && r.winner === P1 && r.reason === "threecheck", "Three-check: the third check wins on the server");
let hill = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "inf", variant: "koth" });
hill = vplay(hill, [P1, "e2e4"], [P2, "e7e5"], [P1, "e1e2"], [P2, "d7d6"], [P1, "e2d3"], [P2, "g8f6"], [P1, "d3c4"], [P2, "f6e4"], [P1, "c4d5"]);
r = L.isGameOver(hill);
ok(r.over && r.winner === P1 && r.reason === "hill", "King of the Hill: the king reaching the centre wins on the server");

// v7: the player setting up a game can take Black
{
  const sw = L.applyAction(L.setup([P1, P2]), P1, { t: "config", tc: "3d", swap: true });
  ok(sw.white === P2 && sw.black === P1 && sw.v >= 7, "config with swap gives the other player White");
  ok(!L.validateAction(L.setup([P1, P2]), P1, { t: "config", tc: "3d", swap: "yes" }).ok, "swap must be true or false");
  ok(L.validateAction(sw, P2, { t: "move", from: "e2", to: "e4" }).ok && !L.validateAction(sw, P1, { t: "move", from: "e2", to: "e4" }).ok, "after the swap, the new White moves first");
}

// v6: 4-Player Chess in a four-seat room
{
  const [R, B, Y, G] = ["p-red", "p-blue", "p-yellow", "p-green"];
  let f = L.setup([R, B, Y, G]);
  ok(f.fourSeats && f.fourSeats.y === Y && f.phase === "config" && f.v >= 6, "four players: seats go Red, Blue, Yellow, Green");
  ok(!L.validateAction(f, B, { t: "config", tc: "5+0", rules: "ffa" }).ok && L.validateAction(f, R, { t: "config", tc: "5+0", rules: "ffa" }).ok, "Red sets up the game");
  ok(!L.validateAction(f, R, { t: "config", tc: "3d", rules: "ffa" }).ok, "no daily clocks for four players");
  f = L.applyAction(f, R, { t: "config", tc: "5+0", rules: "ffa" });
  ok(f.four && f.clock.g === 300000 && !L.isGameOver(f).over, "the game starts with four clocks");
  ok(!L.validateAction(f, B, { t: "move", move: "b8-c8" }).ok, "Blue can't move on Red's turn");
  ok(!L.validateAction(f, R, { t: "move", move: "h2-h5" }).ok && L.validateAction(f, R, { t: "move", move: "h2-h4" }).ok, "Red's moves are checked");
  for (const [p, m] of [[R, "h2-h4"], [B, "b8-c8"], [Y, "g13-g12"], [G, "m9-l9"]]) f = L.applyAction(f, p, { t: "move", move: m });
  ok(f.four.log.length === 4 && f.lastMove === "m9-l9" && L.viewFor(f, R).four.log.length === 4, "a round of four moves");
  f = L.applyAction(f, B, { t: "resign" });
  ok(f.four.pos.status[1] === "resigned" && !L.isGameOver(f).over, "free-for-all: Blue resigns and the game goes on");
  ok(!L.validateAction(f, B, { t: "resign" }).ok, "a resigned player can't resign again");
  ok(!L.validateAction(f, Y, { t: "flag" }).ok, "time can't be called on a player who still has some");
  f = L.applyAction(f, Y, { t: "resign" });
  f = L.applyAction(f, G, { t: "resign" });
  const end = L.isGameOver(f);
  ok(end.over && end.winner === R && end.ranking[0] === R && end.reason === "last-standing", "three out: Red wins, with the full ranking");
  // Teams
  let t = L.applyAction(L.setup([R, B, Y, G]), R, { t: "config", tc: "inf", rules: "teams" });
  t = L.applyAction(t, G, { t: "resign" });
  const te = L.isGameOver(t);
  ok(te.over && te.winners.includes(R) && te.winners.includes(Y) && !te.winners.includes(G), "Teams: Green resigns, so Red and Yellow win");
}

// v8: abort before set-up, vacation and conditional moves in daily games
{
  const act = (st, p, a) => { const v = L.validateAction(st, p, a); if (!v.ok) throw new Error(v.error); return L.applyAction(st, p, a); };
  let a = L.setup([P1, P2]);
  ok(L.validateAction(a, P2, { t: "abort" }).ok && a.v >= 8, "either player can call a game off before it's set up");
  a = L.applyAction(a, P2, { t: "abort" });
  const over = L.isGameOver(a);
  ok(over.over && over.reason === "aborted", "and it's over, aborted");
  ok(!L.validateAction(a, P1, { t: "config", tc: "3+2" }).ok, "a called-off game can't be set up");

  const D = 86_400_000;
  let d = act(L.setup([P1, P2]), P1, { t: "config", tc: "3d" });
  ok(!L.validateAction(act(L.setup([P1, P2]), P1, { t: "config", tc: "5+0" }), P1, { t: "vacation", days: 2 }).ok, "vacations are only for daily games");
  d = act(d, P1, { t: "vacation", days: 5 });
  ok(d.clock.w === 8 * D && d.vacation.w === 5 && d.away.w > Date.now() + 5 * D - 5000, "a vacation adds days to your clock for this move");
  ok(!L.validateAction(d, P1, { t: "vacation", days: 10 }).ok && L.validateAction(d, P1, { t: "vacation", days: 9 }).ok, "up to 14 vacation days a game");
  d = act(d, P1, { t: "move", from: "e2", to: "e4" });
  ok(d.clock.w === 3 * D, "after your move the usual allowance is back");
  d = act(d, P1, { t: "vacation", days: 2 });
  ok(d.clock.w === 5 * D, "a vacation taken on their move adds to your next one");

  // conditional moves: White lines up 1...e5 2.Nf3 (then 2...Nc6 3.Bb5) and 1...c5 2.Nf3
  let c = act(L.setup([P1, P2]), P1, { t: "config", tc: "3d" });
  ok(!L.validateAction(c, P1, { t: "conditional", lines: [["e7e5", "g1f3"]] }).ok, "on your own move, just play it");
  c = act(c, P1, { t: "move", from: "e2", to: "e4" });
  ok(!L.validateAction(c, P1, { t: "conditional", lines: [["e7e5", "e1e3"]] }).ok, "illegal replies are refused");
  ok(!L.validateAction(c, P1, { t: "conditional", lines: [["e7e5"]] }).ok, "a line pairs their move with your reply");
  ok(!L.validateAction(c, P2, { t: "conditional", lines: [["g1f3", "e7e5"]] }).ok, "only the player waiting can line up replies");
  c = act(c, P1, { t: "conditional", lines: [["e7e5", "g1f3", "b8c6", "f1b5"], ["c7c5", "g1f3"]] });
  ok(L.viewFor(c, P1).cond.w.length === 2 && !L.viewFor(c, P2).cond.w && !L.viewFor(c, "p-watcher").cond, "your lines are hidden from your opponent and spectators");
  c = act(c, P2, { t: "move", from: "e7", to: "e5" });
  ok(c.san.join(" ") === "e4 e5 Nf3" && c.cond.w.length === 1 && c.cond.w[0].join() === "b8c6,f1b5", "their move matched a line: the reply is played at once, and the rest of the line waits");
  c = act(c, P2, { t: "move", from: "b8", to: "c6" });
  ok(c.san.join(" ") === "e4 e5 Nf3 Nc6 Bb5" && c.cond.w.length === 0, "and so on down the line");
  c = act(c, P1, { t: "conditional", lines: [["a7a6", "b5a4"]] });
  c = act(c, P2, { t: "move", from: "g8", to: "f6" });
  ok(c.san.length === 6 && c.cond.w.length === 0, "a move the lines don't cover clears them, and it's your move as usual");
  ok(L.validateAction(c, P1, { t: "move", from: "e1", to: "g1" }).ok, "(White castles by hand)");
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
