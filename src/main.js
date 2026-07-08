// Entry point: boots the 3D scene + UI, routes menu choices to game modes,
// wires the toolbar and keyboard (physical key codes only).
import { STR } from "./strings.js";
import { Board3D } from "./board3d.js";
import { UI } from "./ui.js";
import { LocalGame } from "./game.js";
import { OnlineGame } from "./online.js";

const ui = new UI();
const b3d = new Board3D(document.getElementById("scene"));
let game = null;
let lastStart = null;

// static text
document.title = STR.title;
document.getElementById("menu-title").textContent = STR.title;
document.getElementById("menu-sub").textContent = STR.menu.subtitle;
document.getElementById("mode-ai").textContent = STR.menu.vsComputer;
document.getElementById("mode-local").textContent = STR.menu.passPlay;
document.getElementById("mode-online").textContent = STR.menu.online;
document.getElementById("online-hint").textContent = STR.menu.onlineHint;
document.getElementById("opt-side-label").textContent = STR.menu.side;
document.getElementById("opt-level-label").textContent = STR.menu.difficulty;
document.getElementById("opt-time-label").textContent = STR.menu.time;
document.getElementById("opt-back").textContent = STR.menu.back;
document.getElementById("opt-start").textContent = STR.menu.start;
document.getElementById("lbl-moves").textContent = STR.hud.moves;
for (const [i, name] of STR.menu.levels.entries()) {
  const el = document.querySelector(`#seg-level [data-v="${i + 1}"]`);
  if (el) el.textContent = name;
}
for (const [k, name] of Object.entries(STR.menu.times)) {
  const el = document.querySelector(`#seg-time [data-v="${k}"]`);
  if (el) el.textContent = name;
}
document.querySelector('#seg-side [data-v="w"]').textContent = STR.menu.white;
document.querySelector('#seg-side [data-v="b"]').textContent = STR.menu.black;
document.querySelector('#seg-side [data-v="random"]').textContent = STR.menu.random;

// segmented controls
for (const seg of document.querySelectorAll(".seg")) {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    seg.querySelectorAll("button").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
  });
}

function destroyGame() {
  if (game) { game.destroy(); game = null; }
}

function exitToMenu() {
  destroyGame();
  showMenu();
}

function start(opts) {
  destroyGame();
  lastStart = opts;
  if (opts.mode === "online") {
    game = new OnlineGame(b3d, ui, { onExit: exitToMenu });
  } else {
    const mode = opts.mode === "ai"
      ? { kind: "ai", level: opts.level, playerColor: opts.side }
      : { kind: "local" };
    game = new LocalGame(b3d, ui, mode, opts.tcKey, {
      onExit: exitToMenu,
      onRematch: () => start(lastStart),
    });
  }
  document.getElementById("btn-undo").style.display = opts.mode === "ai" ? "" : "none";
}

function showMenu() {
  ui.showMenu((opts) => start(opts));
}

// toolbar
document.getElementById("btn-new").addEventListener("click", exitToMenu);
document.getElementById("btn-flip").addEventListener("click", () => game && game.flip());
document.getElementById("btn-undo").addEventListener("click", () => game && game.undo());
document.getElementById("btn-resign").addEventListener("click", () => {
  if (game) ui.askConfirmResign(() => game.resign());
});
document.getElementById("btn-draw").addEventListener("click", () => game && game.offerDraw());

// keyboard: physical key codes; arrows drive a board cursor, Enter/Space selects
let cursor = null;
const FILES2 = "abcdefgh";
function blackView() {
  return Math.abs(Math.atan2(b3d.camera.position.x, b3d.camera.position.z)) > Math.PI / 2;
}
addEventListener("keydown", (e) => {
  if (document.getElementById("modal").style.display === "flex") return;
  if (document.getElementById("menu").style.display !== "none") return;
  const DIRS = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (e.code in DIRS) {
    e.preventDefault();
    const inv = blackView() ? -1 : 1;
    if (!cursor) cursor = blackView() ? "e7" : "e2";
    else {
      let f = FILES2.indexOf(cursor[0]) + DIRS[e.code][0] * inv;
      let r = Number(cursor[1]) - 1 + DIRS[e.code][1] * inv;
      f = Math.max(0, Math.min(7, f)); r = Math.max(0, Math.min(7, r));
      cursor = FILES2[f] + (r + 1);
    }
    b3d.setCursor(cursor);
  } else if ((e.code === "Enter" || e.code === "Space") && cursor) {
    e.preventDefault();
    if (b3d.onSquareTap) b3d.onSquareTap(cursor);
  } else if (e.code === "KeyF") {
    if (game) game.flip();
  } else if (e.code === "Escape") {
    b3d.setCursor(null); cursor = null;
  }
});
addEventListener("pointerdown", () => { b3d.setCursor(null); cursor = null; });

// dev-only E2E hook (?dev=1): lets automated checks tap squares and read state
if (new URLSearchParams(location.search).has("dev")) {
  window.__test = {
    tap: (sq) => b3d.onSquareTap && b3d.onSquareTap(sq),
    game: () => game,
    fen: () => game && (game.chess || game.mirror) && (game.chess || game.mirror).fen(),
    b3d,
    calls: () => b3d.renderer.info.render.calls,
    tris: () => b3d.renderer.info.render.triangles,
    shot: () => {
      b3d.renderer.render(b3d.scene, b3d.camera);
      return b3d.renderer.domElement.toDataURL("image/png");
    },
    cam: (r, phi, theta) => {
      b3d.camera.position.setFromSphericalCoords(r, phi, theta);
      b3d.camera.lookAt(0, 0, 0);
      b3d.controls.target.set(0, 0, 0);
    },
    lookAt: (x, y, z, r, phi, theta) => {
      b3d.controls.target.set(x, y, z);
      b3d.camera.position.set(x, y, z).add(new (b3d.camera.position.constructor)().setFromSphericalCoords(r, phi, theta));
      b3d.camera.lookAt(x, y, z);
    },
  };
}

// arriving via an invite link jumps straight into the online game
if (new URLSearchParams(location.search).get("room")) {
  start({ mode: "online" });
} else {
  showMenu();
}
