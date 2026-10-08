// Board3D sandbox: a minimal chess.com-style controller (click-to-move, drag-to-move, legal
// dots, premove-free) driving src/board3d.js through the BoardView contract only.
// Build: npx esbuild tools/sandbox3d/main.js --bundle --format=iife --outfile=<dir>/main.js
import { Chess } from "chess.js";
import { Board3D, BOARD_THEMES, PIECE_THEMES } from "../../src/board3d.js";

const $ = (id) => document.getElementById(id);
const container = $("board");
const logEl = $("log");
const log = (msg) => {
  const line = `${new Date().toISOString().slice(14, 23)} ${msg}`;
  logEl.textContent = (line + "\n" + logEl.textContent).split("\n").slice(0, 40).join("\n");
};

let chess = new Chess();
let board = null;
let selected = null;
let settings = { boardTheme: "walnut", pieceTheme: "boxwood", coords: true, animMs: 220, cameraMode: "3d" };
let autoTimer = null;

function legalFrom(sq) { return chess.moves({ square: sq, verbose: true }); }

function select(sq) {
  selected = sq;
  const moves = legalFrom(sq);
  board.setSelected(sq);
  board.showMoves(
    [...new Set(moves.filter((m) => !m.captured).map((m) => m.to))],
    [...new Set(moves.filter((m) => m.captured).map((m) => m.to))]);
}

function deselect() { selected = null; board.clearHints(); }

function updateCheck() {
  if (!chess.inCheck()) { board.setCheck(null); return; }
  const b = chess.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const c = b[r][f];
    if (c && c.type === "k" && c.color === chess.turn()) board.setCheck("abcdefgh"[f] + (8 - r));
  }
}

function play(from, to, instant) {
  let mv = null;
  try { mv = chess.move({ from, to, promotion: $("promo").value }); } catch { mv = null; }
  if (!mv) return null;
  deselect();
  board.animateMove(mv, { instant }, () => log(`animateMove done ${mv.san}`));
  board.setLastMove(mv.from, mv.to);
  updateCheck();
  log(`${instant ? "drop" : "move"} ${mv.san} [${mv.flags}]`);
  return mv;
}

function wire(b) {
  b.canDrag = (sq) => { const p = chess.get(sq); return !!p && p.color === chess.turn() && !chess.isGameOver(); };
  b.onDragStart = (sq) => { log(`dragstart ${sq}`); select(sq); };
  b.onDrop = (from, to) => {
    log(`drop ${from} -> ${to}`);
    if (!to) { deselect(); return false; }
    const ok = !!play(from, to, true);
    if (!ok) select(from);
    return ok;
  };
  b.onSquareTap = (sq) => {
    log(`tap ${sq}`);
    if (selected && selected !== sq && legalFrom(selected).some((m) => m.to === sq)) { play(selected, sq, false); return; }
    const p = chess.get(sq);
    if (p && p.color === chess.turn() && selected !== sq) select(sq);
    else deselect();
  };
}

function createBoard() {
  board = new Board3D(container, { assetBase: "./assets/", settings });
  wire(board);
  board.syncFromBoard(chess.board());
  window.__board = board;
  window.__chess = chess;
}

function resetTo(fen) {
  try { chess = fen ? new Chess(fen) : new Chess(); } catch (e) { log(`bad FEN: ${e.message}`); return; }
  window.__chess = chess;
  selected = null;
  board.syncFromBoard(chess.board());
  board.clearHints();
  board.setLastMove(null, null);
  board.setPremove(null, null);
  updateCheck();
}

// ---- panel ----------------------------------------------------------------------------
function themeButtons(el, list, key) {
  el.innerHTML = "";
  for (const t of list) {
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="chip" style="background:${t.swatch}"></span>${t.name}`;
    btn.dataset.id = t.id;
    btn.onclick = () => { settings[key] = t.id; board.applySettings({ [key]: t.id }); mark(); };
    el.appendChild(btn);
  }
  const mark = () => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.id === settings[key]));
  mark();
}
themeButtons($("bthemes"), BOARD_THEMES, "boardTheme");
themeButtons($("pthemes"), PIECE_THEMES, "pieceTheme");

$("new").onclick = () => resetTo(null);
$("undo").onclick = () => {
  chess.undo();
  board.syncFromBoard(chess.board());
  const h = chess.history({ verbose: true });
  const last = h[h.length - 1];
  board.setLastMove(last ? last.from : null, last ? last.to : null);
  deselect();
  updateCheck();
};
$("flip").onclick = () => board.viewSide(board.orientation === "w" ? "b" : "w");
$("random").onclick = () => {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return;
  const m = moves[Math.floor(Math.random() * moves.length)];
  play(m.from, m.to, false);
};
$("auto").onclick = () => {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; $("auto").classList.remove("on"); return; }
  $("auto").classList.add("on");
  autoTimer = setInterval(() => {
    if (chess.isGameOver()) resetTo(null);
    else $("random").onclick();
  }, Math.max(350, settings.animMs + 150));
};
$("coords").onchange = (e) => { settings.coords = e.target.checked; board.applySettings({ coords: settings.coords }); };
$("top").onchange = (e) => { settings.cameraMode = e.target.checked ? "top" : "3d"; board.applySettings({ cameraMode: settings.cameraMode }); };
$("idle").onchange = (e) => board.setIdle(e.target.checked);
$("active").onchange = (e) => board.setActive(e.target.checked);
$("continuous").onchange = (e) => { board.continuous = e.target.checked; board.invalidate(); };
$("anim").oninput = (e) => { settings.animMs = +e.target.value; $("animv").textContent = settings.animMs; board.applySettings({ animMs: settings.animMs }); };
document.querySelectorAll("[data-size]").forEach((btn) => {
  btn.onclick = () => { container.className = btn.dataset.size; };
});
$("recreate").onclick = () => {
  board.destroy();
  createBoard();
  log("recreated board");
};

$("arrows").onclick = () => board.setArrows([
  { from: "e2", to: "e4", color: "rgba(255,170,0,0.8)" },
  { from: "g1", to: "f3", color: "rgba(21,120,27,0.8)" },
  { from: "d7", to: "d5", color: "rgba(0,48,136,0.8)" },
  { from: "b8", to: "c6", color: "rgba(136,32,32,0.8)" },
  { from: "f1", to: "b5", color: "rgba(52,210,123,0.65)" },
]);
$("marks").onclick = () => board.setMarks([
  { sq: "e4", color: "rgba(52,210,123,.5)" },
  { sq: "d5", color: "rgba(224,85,72,.55)" },
  { sq: "c3", color: "rgba(80,140,255,.5)" },
  { sq: "f6", color: "#ffcc0080" },
]);
$("premove").onclick = () => board.setPremove("g1", "f3");
$("userdraw").onclick = () => {
  board._toggleCircle("e4", "rgba(38,160,58,0.82)");
  board._toggleCircle("d5", "rgba(214,48,48,0.82)");
  board._toggleArrow("b1", "c3", "rgba(38,110,230,0.82)");
  board._toggleArrow("h2", "h4", "rgba(240,150,10,0.85)");
};
$("clearall").onclick = () => { board.setArrows([]); board.setMarks([]); board.setPremove(null, null); board.clearUserDrawings(); };

$("t-castle").onclick = () => resetTo("r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 8");
$("t-ep").onclick = () => { resetTo("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3"); log("e5xf6 e.p. available"); };
$("t-promo").onclick = () => resetTo("1n2k3/P6P/8/8/8/8/6p1/4K2R w K - 0 1");
$("t-check").onclick = () => resetTo("rnb1kbnr/pppp1ppp/8/4p3/5PPq/8/PPPPP2P/RNBQKBNR w KQkq - 1 3");
$("t-many").onclick = () => resetTo("QQQQkQQQ/QQQQQQQQ/8/8/8/8/qqqqqqqq/qqqqKqqq w - - 0 1");
$("fen").onkeydown = (e) => { if (e.key === "Enter") resetTo(e.target.value.trim()); };

// scripted-check helpers
window.__sandbox = {
  play: (from, to, instant = false) => play(from, to, instant),
  reset: resetTo,
  select,
  // capture the board canvas at a given CSS size and POST it to a local capture server
  async shot(name, w, h, setup, port = 8133) {
    const prev = container.getAttribute("style") || "";
    if (w && h) container.setAttribute("style", `width:${w}px;height:${h}px`);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    board.renderNow();
    if (setup) { await setup(board); board.renderNow(); }
    const url = board.canvas.toDataURL("image/png");
    if (w && h) container.setAttribute("style", prev);
    await fetch(`http://127.0.0.1:${port}/save?name=${encodeURIComponent(name)}`, { method: "POST", body: url });
    return `${name}: ${board.canvas.width}x${board.canvas.height}`;
  },
  // close-up "studio" captures: pieces = [[sq, color, type]], views = [[tx,ty,tz, r, phi, theta]]
  async studio(tag, pieces, views, w = 700, h = 520) {
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (const [sq, color, type] of pieces) g[8 - Number(sq[1])]["abcdefgh".indexOf(sq[0])] = { color, type };
    board.syncFromBoard(g);
    const out = [];
    let i = 0;
    for (const [tx, ty, tz, r, phi, th] of views) {
      out.push(await this.shot(`${tag}-${i++}`, w, h, (b) => {
        b.camera.clearViewOffset();
        b.controls.target.set(tx, ty, tz);
        b._placeCamera(r, phi, th);
      }));
    }
    board.controls.target.set(0, 0, 0);
    board.viewSide(board.orientation, false);
    return out;
  },
  // client coords of a square centre (board plane), for synthetic pointer tests
  squareClient(sq, y = 0.08) {
    const b = board;
    const v = b.camera.position.clone();
    const x = "abcdefgh".indexOf(sq[0]) - 3.5, z = 3.5 - (Number(sq[1]) - 1);
    v.set(x, y, z).project(b.camera);
    const r = b.canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  },
};

createBoard();
setInterval(() => {
  const s = board.stats;
  $("hud").textContent = `fps ${s.fps}  calls ${s.calls}  tris ${s.triangles}  renders ${s.renders}  side ${board.orientation}  ` +
    `turn ${chess.turn()}  ${chess.isCheckmate() ? "MATE" : chess.inCheck() ? "check" : ""}`;
}, 250);
