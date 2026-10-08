// Board2D sandbox: drives src/board2d.js with chess.js the way a game controller would, plus
// demo buttons for every contract feature. Exposes window.__board / __game / __sb for automation.
// Build: node tools/sandbox2d/build.mjs <outdir>   (bundles this file, copies the html + public/assets)
import { Chess } from "chess.js";
import { Board2D, BOARD_THEMES, PIECE_THEMES } from "../../src/board2d.js";

const $ = (id) => document.getElementById(id);
const wrap = $("wrap");
const logEl = $("log");
const log = (msg) => {
  const t = (performance.now() / 1000).toFixed(2);
  logEl.textContent = `${t}  ${msg}\n` + logEl.textContent.slice(0, 4000);
};

let game = new Chess();
let board;
let selected = null;
let dragSelected = null;
let busy = false;       // a scripted sequence is running
let auto = null;        // autoplay timer
const settings = { boardTheme: "green", pieceTheme: "cburnett", coords: true, animMs: 220 };

function kingSquare(color) {
  for (const row of game.board()) for (const c of row) if (c && c.type === "k" && c.color === color) return c.square;
  return null;
}

function status() {
  const turn = game.turn() === "w" ? "White" : "Black";
  let s = `${turn} to move`;
  if (game.isCheckmate()) s = `Checkmate, ${turn === "White" ? "Black" : "White"} wins`;
  else if (game.isDraw()) s = "Draw";
  else if (game.inCheck()) s += " (check)";
  $("status").textContent = `${s} | orientation ${board.orientation} | ${game.fen()}`;
}

function isCaptureHint(m) { return !!m.captured && !m.flags.includes("e"); }

function select(sq) {
  selected = sq;
  board.setSelected(sq);
  const ms = game.moves({ square: sq, verbose: true });
  const quiet = [...new Set(ms.filter((m) => !isCaptureHint(m)).map((m) => m.to))];
  const caps = [...new Set(ms.filter(isCaptureHint).map((m) => m.to))];
  board.showMoves(quiet, caps);
}
function deselect() { selected = null; board.clearHints(); }

function afterMove(mv) {
  board.setLastMove(mv.from, mv.to);
  board.setCheck(game.inCheck() ? kingSquare(game.turn()) : null);
  deselect();
  status();
}

function play(moveSpec, { instant = false } = {}) {
  let mv;
  try { mv = game.move(moveSpec); } catch { mv = null; }
  if (!mv) return Promise.resolve(null);
  return new Promise((resolve) => {
    board.animateMove(mv, { instant }, () => resolve(mv));
    afterMove(mv);
  });
}

function tryMove(from, to, instant) {
  const legal = game.moves({ square: from, verbose: true }).find((m) => m.to === to);
  if (!legal) return null;
  const mv = game.move({ from, to, promotion: legal.promotion ? "q" : undefined });
  board.animateMove(mv, { instant }, () => log(`animateMove done ${mv.san}`));
  afterMove(mv);
  return mv;
}

function wire(b) {
  b.canDrag = (sq) => {
    const p = game.get(sq);
    return !busy && !!p && p.color === game.turn() && !game.isGameOver();
  };
  b.onDragStart = (sq) => { log(`onDragStart ${sq}`); dragSelected = sq; select(sq); };
  b.onDrop = (from, to) => {
    log(`onDrop ${from} -> ${to}`);
    dragSelected = null;
    if (!to) { return false; }
    const mv = tryMove(from, to, true);
    if (!mv) { log("  refused (snap back)"); return false; }
    log(`  accepted ${mv.san}`);
    return true;
  };
  b.onSquareTap = (sq) => {
    log(`onSquareTap ${sq}`);
    if (busy) return;
    if (dragSelected === sq) { dragSelected = null; return; } // dropped back on origin: keep selection
    dragSelected = null;
    if (selected && selected !== sq && tryMove(selected, sq, false)) return;
    if (selected === sq) { deselect(); return; }
    const p = game.get(sq);
    if (p && p.color === game.turn()) select(sq); else deselect();
  };
}

function createBoard() {
  board = new Board2D(wrap);
  board.applySettings(settings);
  wire(board);
  board.syncFromBoard(game.board());
  window.__board = board;
  status();
}

// ------------------------------------------------------------ settings UI

function chips(el, list, key, render) {
  el.innerHTML = "";
  for (const t of list) {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.dataset.id = t.id;
    btn.innerHTML = render(t);
    btn.setAttribute("aria-pressed", String(settings[key] === t.id));
    btn.onclick = () => {
      settings[key] = t.id;
      board.applySettings({ [key]: t.id });
      for (const c of el.children) c.setAttribute("aria-pressed", String(c.dataset.id === t.id));
      log(`applySettings ${key}=${t.id}`);
    };
    el.appendChild(btn);
  }
}
chips($("boardThemes"), BOARD_THEMES, "boardTheme", (t) => `<span class="sw" style="background:${t.swatch}"></span>${t.name}`);
chips($("pieceThemes"), PIECE_THEMES, "pieceTheme", (t) => `<span class="pc" style="background-image:${t.swatch}"></span>${t.name}`);

$("coords").onchange = (e) => { settings.coords = e.target.checked; board.applySettings({ coords: settings.coords }); };
$("anim").oninput = (e) => { settings.animMs = Number(e.target.value); $("animV").textContent = e.target.value; board.applySettings({ animMs: settings.animMs }); };
$("active").onchange = (e) => board.setActive(e.target.checked);
$("flip").onclick = () => { board.viewSide(board.orientation === "w" ? "b" : "w"); status(); };
$("flipInstant").onclick = () => { board.viewSide(board.orientation === "w" ? "b" : "w", false); status(); };
$("recreate").onclick = () => {
  board.destroy();
  log(`destroyed; container children: ${wrap.children.length}`);
  createBoard();
  log("recreated");
};

// ------------------------------------------------------------ demos

$("arrows").onclick = () => {
  board.setArrows([
    { from: "e2", to: "e4", color: "rgba(52,210,123,.8)" },      // emerald engine arrow
    { from: "g1", to: "f3", color: "rgba(255,170,0,.8)" },        // knight L-shape
    { from: "b8", to: "c6", color: "rgba(0,72,170,.75)" },        // knight L-shape (other leg order)
    { from: "f1", to: "b5", color: "rgba(186,38,38,.75)" },       // diagonal
    { from: "a1", to: "a6", color: "rgba(21,120,27,.5)" },        // translucent long file arrow
  ]);
  log("setArrows (5)");
};
$("marks").onclick = () => {
  board.setMarks([
    { sq: "d4", color: "rgba(52,210,123,.5)" },
    { sq: "e5", color: "rgba(224,85,72,.55)" },
    { sq: "c6", color: "rgba(80,140,255,.45)" },
  ]);
  log("setMarks (3)");
};
$("premove").onclick = () => { board.setPremove("d2", "d4"); log("setPremove d2 d4"); };
$("check").onclick = () => {
  game = new Chess("rnbqkbnr/ppppp1pp/8/5p1Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2");
  board.syncFromBoard(game.board());
  board.setLastMove("d1", "h5");
  board.setCheck(kingSquare("b"));
  deselect();
  status();
};
$("hints").onclick = () => {
  game = new Chess("r1bqkbnr/pppp1ppp/2n5/4p3/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 3");
  board.syncFromBoard(game.board());
  select("d4");
  status();
};
$("userdraw").onclick = () => {
  // simulate right-click drawings through real pointer events
  const r = board._board.getBoundingClientRect(), s = r.width / 8;
  const at = (sq) => {
    const [row, col] = board._rc(sq);
    return { clientX: r.left + (col + 0.5) * s, clientY: r.top + (row + 0.5) * s };
  };
  const fire = (type, sq, mods = {}) => board._board.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 77, pointerType: "mouse", button: 2, buttons: type === "pointerup" ? 0 : 2, ...at(sq), ...mods,
  }));
  const draw = (a, b, mods) => { fire("pointerdown", a, mods); fire("pointermove", b, mods); fire("pointerup", b, mods); };
  draw("e2", "e4");
  draw("d7", "d5", { shiftKey: true });
  draw("g8", "f6", { altKey: true });
  draw("c1", "g5", { ctrlKey: true });
  draw("e4", "e4");
  draw("d5", "d5", { shiftKey: true });
  log("user drawings: green/red/blue/orange arrows + 2 circles");
};
$("clearDemo").onclick = () => {
  board.setArrows([]); board.setMarks([]); board.setPremove(null, null); board.clearUserDrawings();
  log("cleared arrows/marks/premove/user drawings");
};

// ------------------------------------------------------------ sequences

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function sequence(fen, sans, label) {
  stopAuto();
  busy = true;
  game = fen ? new Chess(fen) : new Chess();
  board.syncFromBoard(game.board());
  board.setLastMove(null, null); board.setCheck(null); deselect();
  log(`sequence ${label}`);
  for (const san of sans) {
    const mv = await play(san);
    log(`  ${san} -> ${mv ? mv.flags : "ILLEGAL"}`);
    await wait(Math.max(120, settings.animMs * 0.6));
  }
  busy = false;
  status();
}
$("seqCastle").onclick = () => sequence(null,
  ["e4", "e5", "Nf3", "Nf6", "Bc4", "Bc5", "O-O", "d6", "d4", "Bg4", "Nc3", "Qd7", "Be3", "Nc6", "Qd2", "O-O-O"], "castling");
$("seqEp").onclick = () => sequence(null, ["e4", "h5", "e5", "d5", "exd6", "h4", "g4", "hxg3"], "en passant");
$("seqPromo").onclick = () => sequence("1n5k/P7/8/8/8/8/7p/K5N1 w - - 0 1", ["axb8=Q+", "Kh7", "Qb6", "hxg1=N", "Qg6+", "Kg8"], "promotion");

function stopAuto() { if (auto) { clearTimeout(auto); auto = null; $("autoplay").classList.remove("on"); } }
$("autoplay").onclick = () => {
  if (auto) { stopAuto(); return; }
  $("autoplay").classList.add("on");
  const step = async () => {
    if (game.isGameOver()) { game = new Chess(); board.syncFromBoard(game.board()); board.setLastMove(null, null); board.setCheck(null); }
    const ms = game.moves({ verbose: true });
    const m = ms[Math.floor(Math.random() * ms.length)];
    await play({ from: m.from, to: m.to, promotion: m.promotion });
    if (auto) auto = setTimeout(step, 60);
  };
  auto = setTimeout(step, 0);
};
$("reset").onclick = () => {
  stopAuto();
  game = new Chess();
  board.syncFromBoard(game.board());
  board.setLastMove(null, null); board.setCheck(null); deselect();
  status();
};
$("undo").onclick = () => {
  stopAuto();
  game.undo();
  board.syncFromBoard(game.board());
  const h = game.history({ verbose: true });
  const last = h[h.length - 1];
  board.setLastMove(last ? last.from : null, last ? last.to : null);
  board.setCheck(game.inCheck() ? kingSquare(game.turn()) : null);
  deselect();
  status();
};
$("resync").onclick = () => { board.syncFromBoard(game.board()); log("syncFromBoard"); };

// container size readout
new ResizeObserver(() => { $("size").textContent = `container ${wrap.clientWidth}x${wrap.clientHeight} | board ${board ? board._size : "-"}px`; }).observe(wrap);

// ------------------------------------------------------------ URL-driven states (for screenshots)
// ?board=wood&pieces=merida&orient=b&coords=0&fen=...&moves=e4,e5&sel=g1&check=e8&premove=d2d4
//  &demo=arrows,marks,userdraw&drag=e2:e4&bare=1   |   ?gallery=board|pieces

function pointer(type, sq, { button = 0, dx = 0, dy = 0, mods = {}, pointerType = "mouse" } = {}) {
  const r = board._board.getBoundingClientRect(), s = r.width / 8;
  const [row, col] = board._rc(sq);
  board._board.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 5, pointerType, isPrimary: true, button,
    buttons: type === "pointerup" ? 0 : button === 2 ? 2 : 1,
    clientX: r.left + (col + 0.5 + dx) * s, clientY: r.top + (row + 0.5 + dy) * s, ...mods,
  }));
}
window.__pointer = pointer;

function applyQuery(q) {
  if (q.get("bare")) document.body.classList.add("bare");
  const s = {};
  if (q.get("board")) s.boardTheme = q.get("board");
  if (q.get("pieces")) s.pieceTheme = q.get("pieces");
  if (q.get("coords")) s.coords = q.get("coords") !== "0";
  if (q.get("anim")) s.animMs = Number(q.get("anim"));
  Object.assign(settings, s);
  board.applySettings(s);
  for (const [id, key] of [["boardThemes", "boardTheme"], ["pieceThemes", "pieceTheme"]]) {
    for (const c of $(id).children) c.setAttribute("aria-pressed", String(c.dataset.id === settings[key]));
  }
  if (q.get("orient")) board.viewSide(q.get("orient"), false);
  if (q.get("fen")) game = new Chess(q.get("fen"));
  for (const san of (q.get("moves") || "").split(",").filter(Boolean)) {
    const mv = game.move(san);
    board.syncFromBoard(game.board());
    afterMove(mv);
  }
  board.syncFromBoard(game.board());
  if (q.get("sel")) select(q.get("sel"));
  if (q.get("check")) board.setCheck(q.get("check"));
  const pm = q.get("premove");
  if (pm) board.setPremove(pm.slice(0, 2), pm.slice(2, 4));
  const demos = (q.get("demo") || "").split(",");
  for (const d of demos) if (d && $(d)) $(d).click();
  const drag = q.get("drag");
  if (drag) { // after layout settles (bare mode resizes the container)
    const [a, b] = drag.split(":");
    const pointerType = q.get("touch") ? "touch" : "mouse";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pointer("pointerdown", a, { pointerType });
      pointer("pointermove", a, { dx: 0.1, dy: -0.1, pointerType });
      pointer("pointermove", b, { dx: 0.18, dy: 0.12, pointerType });
    }));
  }
  const toPlay = (q.get("play") || "").split(",").filter(Boolean);
  if (toPlay.length) requestAnimationFrame(async () => { for (const san of toPlay) await play(san); });
  if (q.get("selftest")) requestAnimationFrame(() => selftest().then((r) => {
    const pre = document.createElement("pre");
    pre.id = "selftest";
    pre.textContent = r.join("\n");
    document.body.appendChild(pre);
  }));
  status();
}

// Animation-path checks that need a visible document (run headless: ?selftest=1, read #selftest).
async function selftest() {
  const R = [];
  const ok = (name, cond, extra) => R.push(`${cond ? "PASS" : "FAIL"} ${name}${cond || extra === undefined ? "" : " " + JSON.stringify(extra)}`);
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const b = board;
  b.applySettings({ animMs: 200 });
  ok("document visible", !document.hidden);
  // refused drop slides back
  b.onDrop = () => false;
  pointer("pointerdown", "e2"); pointer("pointermove", "e3"); pointer("pointerup", "e3");
  ok("snap-back animates", b._jobs.length === 1 && b.pieces.get("e2").el.classList.contains("b2d-moving"));
  await tick(260);
  ok("snap-back settles", b._jobs.length === 0 && b.pieces.get("e2").el.getAnimations().length === 0);
  wire(b);
  // animated move + single onDone
  game = new Chess();
  b.syncFromBoard(game.board());
  let done = 0;
  const m1 = game.move("e4");
  b.animateMove(m1, {}, () => done++);
  ok("move animates (job + moving class)", b._jobs.length === 1 && b.pieces.get("e4").el.classList.contains("b2d-moving"));
  // interrupt: a second move completes the first synchronously
  const m2 = game.move("d5");
  let done2 = 0;
  b.animateMove(m2, {}, () => done2++);
  ok("interrupt completes previous onDone", done === 1 && b._jobs.length === 1);
  await tick(260);
  ok("second onDone once", done2 === 1 && b._jobs.length === 0);
  // capture fades out, removed at end
  const m3 = game.move("exd5");
  const victim = b.pieces.get("d5").el;
  b.animateMove(m3, {}, () => {});
  ok("captured piece still present while fading", victim.isConnected && victim.getAnimations().length === 1);
  await tick(260);
  ok("captured piece removed", !victim.isConnected && document.querySelectorAll(".b2d-pieces .b2d-piece").length === 31);
  // promotion swaps image at the end
  game = new Chess("8/P6k/8/8/8/8/8/K7 w - - 0 1");
  b.syncFromBoard(game.board());
  const pm = game.move("a8=Q");
  b.animateMove(pm, {}, () => {});
  const pel = b.pieces.get("a8").el;
  ok("promotion: pawn image while moving", pel.classList.contains("b2d-wP"));
  await tick(260);
  ok("promotion: queen image after", pel.classList.contains("b2d-wQ") && !pel.classList.contains("b2d-wP"));
  // castling: rook animates too
  game = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  b.syncFromBoard(game.board());
  const cm = game.move("O-O-O");
  b.animateMove(cm, {}, () => {});
  ok("castling: rook animating", b.pieces.get("d1").el.classList.contains("b2d-moving") && b.pieces.get("c1").el.classList.contains("b2d-moving"));
  await tick(260);
  ok("castling settled", !document.querySelector(".b2d-moving"));
  // en passant removes the right pawn
  game = new Chess("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  b.syncFromBoard(game.board());
  const ep = game.move("exd6");
  const epVictim = b.pieces.get("d5").el;
  b.animateMove(ep, {}, () => {});
  await tick(260);
  ok("en passant removed d5", !epVictim.isConnected && !b.pieces.has("d5") && b.pieces.has("d6"));
  // animated flip fades layers
  b.viewSide("b");
  ok("flip fade running", b._pieceLayer.getAnimations().length === 1);
  b.viewSide("w", false);
  game = new Chess();
  b.syncFromBoard(game.board());
  return R;
}

function gallery(kind) {
  document.body.classList.add("gallery");
  const app = $("app");
  app.innerHTML = "";
  const list = kind === "pieces" ? PIECE_THEMES : BOARD_THEMES;
  const g = new Chess("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 3 5");
  for (const t of list) {
    const cell = document.createElement("figure");
    const box = document.createElement("div");
    box.className = "gbox";
    const cap = document.createElement("figcaption");
    cap.textContent = `${t.name} (${t.id})${t.license ? " " + t.license : ""}`;
    cell.append(box, cap);
    app.appendChild(cell);
    const b = new Board2D(box);
    b.applySettings(kind === "pieces" ? { boardTheme: "brown", pieceTheme: t.id } : { boardTheme: t.id, pieceTheme: "cburnett" });
    b.syncFromBoard(g.board());
    b.setLastMove("f1", "c4");
    b.setSelected("f3");
    b.showMoves(["g5", "h4", "d2", "g1", "d4"], ["e5"]);
  }
}

const query = new URLSearchParams(location.search);
if (query.get("gallery")) gallery(query.get("gallery"));
else { createBoard(); applyQuery(query); }
window.__game = () => game;
window.__sb = { play, sequence, select, settings, setGame: (fen) => { game = new Chess(fen); board.syncFromBoard(game.board()); status(); } };
