// App shell: navigation, routing, the board host (3D or 2D), player strips, side panel, pages.
// Screens are "controllers" with mount()/destroy(); the board persists across screens.
import { h, $, icon } from "./ui/dom.js";
import { EvalBar, renderStrip, closeAllModals, anyModalOpen, toast, openModal } from "./ui/components.js";
import { getSettings, setSettings, onSettings, onAchievement } from "./store.js";
import { Board3D } from "./board3d.js";
import { Board2D } from "./board2d.js";
import { setSound } from "./audio.js";

const NAV = [
  { id: "play", label: "Play", icon: "play", hash: "#/" },
  { id: "puzzles", label: "Puzzles", icon: "puzzle", hash: "#/puzzles" },
  { id: "learn", label: "Learn", icon: "learn", hash: "#/learn" },
  { id: "watch", label: "Watch", icon: "watch", hash: "#/watch" },
  { id: "analysis", label: "Analysis", icon: "analysis", hash: "#/analysis" },
  { id: "profile", label: "Profile", icon: "profile", hash: "#/profile" },
  { id: "settings", label: "Settings", icon: "settings", hash: "#/settings" },
];

export class App {
  constructor(routes) {
    this.routes = routes;          // [{ pattern: RegExp, nav, make: (app, match) => controller }]
    this.controller = null;
    this.boards = { "3d": null, "2d": null };
    this.board = null;
    this.handlers = {};
    this.evalBar = new EvalBar($("#evalbar"));
    this.stripTop = $("#strip-top");
    this.stripBottom = $("#strip-bottom");
    this.side = $("#side");
    this.page = $("#page");
    this.leaveGuard = null;        // async () => bool, set by controllers with something to lose

    this._buildNav();
    this._applyAppearance();
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => this._applyAppearance());
    this._mountBoard();
    setSound(getSettings().sound);

    onSettings((s, patch) => {
      if ("view" in patch) this._mountBoard();
      else this._applyBoardSettings();
      if ("sound" in patch) setSound(s.sound);
      if ("appearance" in patch) this._applyAppearance();
      if (this.controller && this.controller.onSettings) this.controller.onSettings(patch);
    });
    onAchievement((a) => toast(h("span", h("span", { style: { fontSize: "18px" } }, a.icon), h("span", "Achievement unlocked: ", h("b", a.name))), { kind: "ach", ms: 4200 }));

    addEventListener("hashchange", () => this._route());
    addEventListener("keydown", (e) => this._key(e));
  }

  start() { this._route(); }

  // ---------- navigation ----------
  _buildNav() {
    const rail = $("#rail"), tabbar = $("#tabbar");
    rail.appendChild(h("a.brand", { href: "#/", "aria-label": "Chess 3D home" },
      h("img", { src: "./assets/favicon.png", alt: "" }), h("span", "Chess 3D")));
    for (const n of NAV) {
      const mk = () => h("a.nav-item", { href: n.hash, dataset: { nav: n.id } }, icon(n.icon, 24), h("span", n.label));
      if (n.id === "settings") rail.appendChild(h("div.rail-spacer"));
      rail.appendChild(mk());
      // phones: Analysis gets a tab; Settings is reached from Profile
      if (n.id !== "settings") tabbar.appendChild(mk());
    }
  }
  _setNav(id) {
    for (const el of document.querySelectorAll(".nav-item")) el.classList.toggle("on", el.dataset.nav === id);
  }

  go(hash) {
    if (location.hash === hash) this._route(true);
    else location.hash = hash;
  }

  async _route(force = false) {
    const hash = location.hash || "#/";
    if (!force && this._lastHash === hash) return;
    if (this.leaveGuard && this._lastHash && this._lastHash !== hash) {
      // one "leave?" prompt at a time: further Back/Forward presses while it's open are ignored
      if (this._guardOpen) { history.replaceState(null, "", this._lastHash); return; }
      this._guardOpen = true;
      let ok;
      try { ok = await this.leaveGuard(hash); } finally { this._guardOpen = false; }
      if (!ok) { history.replaceState(null, "", this._lastHash); return; }
      if (location.hash !== hash) { history.replaceState(null, "", location.pathname + location.search + hash); }
    }
    this._lastHash = hash;
    closeAllModals();
    for (const r of this.routes) {
      const m = r.pattern.exec(hash);
      if (m) {
        this._setNav(r.nav);
        this.setController(() => r.make(this, m));
        return;
      }
    }
    location.hash = "#/";
  }

  // Start a controller directly (e.g. a configured game) and record its URL without re-routing.
  launch(factory, hash) {
    if (hash && location.hash !== hash) { history.pushState(null, "", location.pathname + location.search + hash); }
    this._lastHash = hash || location.hash;
    this.setController(factory);
  }

  setController(factory) {
    if (this.controller) { try { this.controller.destroy(); } catch (e) { console.error(e); } }
    this.controller = null;
    this.leaveGuard = null;
    this.resetStage();
    this.controller = factory();
    if (this.controller && this.controller.mount) this.controller.mount();
  }

  // ---------- layout ----------
  pageMode(el) {
    $("#app").classList.add("page-mode");
    this.page.hidden = false;
    this.page.innerHTML = "";
    this.page.scrollTop = 0;
    if (el) this.page.appendChild(el);
    if (this.board) this.board.setActive(false);
  }
  arenaMode() {
    $("#app").classList.remove("page-mode");
    this.page.hidden = true;
    this.page.innerHTML = "";
    if (this.board) this.board.setActive(true);
  }
  setInGame(on) { $("#app").classList.toggle("in-game", !!on); }

  // Side panel: { title, back?, actions?, tabs?, body, foot? }
  panel({ title, back, actions, body, foot, tabs }) {
    this.side.innerHTML = "";
    const head = h("div.side-head",
      back ? h("button.back", { "aria-label": "Back", onclick: () => (typeof back === "function" ? back() : this.go(back)) }, icon("back", 22)) : null,
      h("h2", title || ""), h("div.grow"), actions || null);
    this.side.appendChild(head);
    if (tabs) this.side.appendChild(tabs);
    const bodyEl = h("div.side-body");
    if (body) bodyEl.append(...[].concat(body).filter(Boolean));
    this.side.appendChild(bodyEl);
    if (foot) this.side.appendChild(h("div.side-foot", ...[].concat(foot).filter(Boolean)));
    return bodyEl;
  }

  strips(top, bottom) {
    renderStrip(this.stripTop, top);
    renderStrip(this.stripBottom, bottom);
  }

  // phones: setup screens hide the board so their options and Start button fit on screen
  setLobby(on) { $("#app").classList.toggle("lobby", !!on); }

  resetStage() {
    this.arenaMode();
    this.setInGame(false);
    this.setLobby(false);
    $("#main").scrollTop = 0;
    this.evalBar.show(false);
    $("#stage-overlay").innerHTML = "";
    this.strips(null, null);
    this.bindBoard({});
    const b = this.board;
    if (b) {
      b.clearHints(); b.setLastMove(null, null); b.setCheck(null); b.setPremove(null, null);
      b.setMarks([]); b.setArrows([]); b.clearUserDrawings();
      if (b.setBadge) b.setBadge(null);
      if (b.setIdle) b.setIdle(false);
    }
  }

  _applyAppearance() {
    const a = getSettings().appearance;
    const light = a === "light" || (a === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", light ? "#ece4d7" : "#16110d");
  }

  // ---------- board ----------
  _mountBoard() {
    const view = getSettings().view === "2d" ? "2d" : "3d";
    let prev = this.board;
    if (prev && prev === this.boards[view]) { this._applyBoardSettings(); return; }
    if (!this.boards[view]) {
      try {
        this.boards[view] = view === "3d" ? new Board3D($("#host3d")) : new Board2D($("#host2d"));
      } catch (e) {
        console.error(e);
        if (view === "3d") {
          toast("3D isn't available on this device, so you're on the 2D board.");
          this._no3d = true;
          setSettings({ view: "2d" });
          if (!this.board || this.board === this.boards["3d"]) return this._mountBoard();
          return;
        }
        throw e;
      }
    }
    $("#host3d").hidden = view !== "3d";
    $("#host2d").hidden = view !== "2d";
    $("#app").classList.toggle("view2d", view === "2d");
    if (prev) prev.setActive(false);
    this.board = this.boards[view];
    this.board.setActive(!$("#app").classList.contains("page-mode"));
    this._applyBoardSettings();
    this.bindBoard(this.handlers);
    if (prev && this.controller && this.controller.onBoardSwap) {
      this.board.viewSide(prev.orientation, false);
      this.controller.onBoardSwap();
    }
  }

  _applyBoardSettings() {
    const s = getSettings();
    const is3d = this.board === this.boards["3d"];
    this.board.applySettings({
      boardTheme: is3d ? s.boardTheme3d : s.boardTheme2d,
      pieceTheme: is3d ? s.pieceTheme3d : s.pieceTheme2d,
      coords: s.coords, animMs: s.animMs, cameraMode: s.cameraMode,
    });
  }

  // controller input handlers survive 2D/3D swaps
  bindBoard(handlers) {
    this.handlers = handlers || {};
    const b = this.board;
    if (!b) return;
    b.onSquareTap = this.handlers.onSquareTap || null;
    b.canDrag = this.handlers.canDrag || null;
    b.onDragStart = this.handlers.onDragStart || null;
    b.onDrop = this.handlers.onDrop || null;
  }

  shortcuts() {
    const rows = [["← / →", "Previous / next move"], ["↑ / ↓", "First / last move"], ["F", "Flip the board"], ["Space", "Play / pause a replay"],
      ["Right-click drag", "Draw an arrow"], ["Right-click", "Circle a square"], ["Shift / Alt / Ctrl", "Red / blue / orange drawings"], ["Type a move", "e.g. Nf3, then Enter"], ["?", "This list"]];
    openModal({ title: "Keyboard shortcuts", body: h("div", ...rows.map(([k, v]) => h("div.kv", h("span", v), h("b", k)))) });
  }

  // ---------- keyboard ----------
  _key(e) {
    if (anyModalOpen()) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (this.controller && this.controller.key && this.controller.key(e)) { e.preventDefault(); return; }
    if (e.key === "?") { this.shortcuts(); return; }
    if (e.key === "f" && !e.metaKey && !e.ctrlKey && this.board && !$("#app").classList.contains("page-mode")) {
      this.board.viewSide(this.board.orientation === "w" ? "b" : "w");
      if (this.controller && this.controller.onFlip) this.controller.onFlip();
    }
  }
}
