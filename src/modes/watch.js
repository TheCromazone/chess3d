// Watch: replay famous games on the 3D board, or tune in to Bot TV (bots playing each other live).
import { Chess } from "chess.js";
import { MoveTree, kingSquare, capturedFromFen } from "../core/tree.js";
import { h, icon } from "../ui/dom.js";
import { MoveList, toast } from "../ui/components.js";
import { BOTS, botMove, botThinkDelay } from "../bots.js";
import { playEngine } from "../core/engines.js";
import { moveSound } from "../audio.js";
import { openingForGame, loadOpenings } from "../openings.js";

let classicsCache = null;
export async function loadClassics() {
  if (classicsCache) return classicsCache;
  const res = await fetch("./data/classics.json");
  classicsCache = await res.json();
  return classicsCache;
}

export class WatchPage {
  constructor(app) { this.app = app; }
  async mount() {
    const page = h("div.page",
      h("div.page-head", h("h1", "Watch"), h("p", "Replay the most famous games ever played, or watch the bots battle it out live.")));
    const tv = h("button.tile", { onclick: () => this.app.go("#/tv"), style: { minHeight: "auto", flexDirection: "row", alignItems: "center", gap: "14px" } },
      h("span.ti", "📺"), h("span", h("b", "Bot TV"), h("small", { style: { display: "block" } }, "Two random bots play a live game. A new match starts when one ends.")));
    const list = h("div.grid-cards");
    page.append(h("section", tv), h("section", h("h2", "Classic games"), list));
    this.app.pageMode(page);
    try {
      const games = await loadClassics();
      for (const g of games) {
        list.appendChild(h("button.tile", { onclick: () => this.app.go(`#/watch/${g.id}`) },
          h("b", `${g.white} vs ${g.black}`), h("small", `${g.event}, ${g.year} · ${g.result}`), h("small", g.blurb)));
      }
    } catch { list.appendChild(h("p.note", "Couldn't load the games list.")); }
  }
  destroy() {}
}

const SPEEDS = [{ label: "Slow", ms: 2600 }, { label: "Normal", ms: 1500 }, { label: "Fast", ms: 700 }];

export class ReplayScreen {
  constructor(app, id) {
    this.app = app;
    this.id = id;
    this.idx = -1;
    this.playing = true;
    this.speed = 1;
    this.moveList = new MoveList((i) => { this.playing = false; this.goto(i); this.renderControls(); });
  }
  async mount() {
    const games = await loadClassics().catch(() => []);
    if (this.dead) return;   // left while the list was loading
    this.g = games.find(x => x.id === this.id);
    if (!this.g) { this.app.go("#/watch"); return; }
    await loadOpenings();
    if (this.dead) return;
    this.tree = MoveTree.fromMoves(this.g.moves.split(/\s+/).filter(Boolean));
    this.line = this.tree.mainline();
    this.app.board.viewSide("w", false);
    this.app.board.syncFromBoard(new Chess().board());
    this.controlsEl = h("div");
    this.openingEl = h("div.opening");
    this.app.panel({
      title: "Watch", back: "#/watch",
      body: [h("div.card", h("h3", `${this.g.white} vs ${this.g.black}`), h("p.note", `${this.g.event}, ${this.g.year} · ${this.g.result}`), h("p", { style: { marginTop: "6px", fontSize: "14px" } }, this.g.blurb)),
        this.openingEl, this.moveList.el],
      foot: [this.controlsEl,
        h("button.btn.block", { onclick: () => this.app.go("#/analysis/pgn/" + encodeURIComponent(this.tree.toPgn({ White: this.g.white, Black: this.g.black, Event: this.g.event, Result: this.g.result }))) }, icon("analysis", 18), "Open in analysis")],
    });
    this.renderControls();
    this.goto(-1);
    this.schedule();
  }
  destroy() { this.dead = true; clearTimeout(this.t); }
  onBoardSwap() { this.goto(this.idx, true); }
  key(e) {
    if (!this.line) return false;   // still loading
    if (e.key === "ArrowLeft") { this.playing = false; this.goto(Math.max(-1, this.idx - 1)); this.renderControls(); return true; }
    if (e.key === "ArrowRight") { this.playing = false; this.goto(Math.min(this.line.length - 1, this.idx + 1)); this.renderControls(); return true; }
    if (e.key === " ") { this.toggle(); return true; }
    return false;
  }
  toggle() { this.playing = !this.playing; if (this.playing && this.idx >= this.line.length - 1) this.goto(-1); this.renderControls(); this.schedule(); }

  schedule() {
    clearTimeout(this.t);
    if (!this.playing || this.dead) return;
    this.t = setTimeout(() => {
      if (!this.playing || this.dead) return;
      if (this.idx >= this.line.length - 1) { this.playing = false; this.renderControls(); return; }
      this.goto(this.idx + 1);
      this.schedule();
    }, SPEEDS[this.speed].ms);
  }

  goto(i, force = false) {
    const prev = this.idx;
    this.idx = i;
    const node = i < 0 ? this.tree.root : this.line[i];
    if (!force && i === prev + 1 && node.move) { this.app.board.animateMove(node.move); moveSound(node.move, new Chess(node.fen)); }
    else this.app.board.syncFromBoard(new Chess(node.fen).board());
    const c = new Chess(node.fen);
    this.app.board.setLastMove(node.move ? node.move.from : null, node.move ? node.move.to : null);
    this.app.board.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    const { captured, diff } = capturedFromFen(node.fen);
    const o = this.app.board.orientation;
    const mk = (col) => ({ name: col === "w" ? this.g.white : this.g.black, avatar: { emoji: col === "w" ? "♔" : "♚", bg: col === "w" ? "#6b5a43" : "#2d241d" }, captured: captured[col === "w" ? "b" : "w"], capColor: col === "w" ? "b" : "w", adv: col === "w" ? diff : -diff });
    this.app.strips(mk(o === "w" ? "b" : "w"), mk(o));
    this.moveList.render(this.line.map(n => ({ san: n.san, color: n.ply % 2 === 1 ? "w" : "b" })), i);
    const op = openingForGame(this.line.slice(0, i + 1).map(n => n.fen));
    this.openingEl.innerHTML = "";
    if (op) this.openingEl.append(h("b", op.eco), " ", op.name);
  }

  renderControls() {
    this.controlsEl.innerHTML = "";
    this.controlsEl.append(h("div.navbar",
      h("button", { "aria-label": "Start", onclick: () => { this.playing = false; this.goto(-1); this.renderControls(); } }, icon("first")),
      h("button", { "aria-label": "Back", onclick: () => { this.playing = false; this.goto(Math.max(-1, this.idx - 1)); this.renderControls(); } }, icon("prev")),
      h("button", { "aria-label": this.playing ? "Pause" : "Play", onclick: () => this.toggle() }, icon(this.playing ? "pause" : "resume")),
      h("button", { "aria-label": "Forward", onclick: () => { this.playing = false; this.goto(Math.min(this.line.length - 1, this.idx + 1)); this.renderControls(); } }, icon("next")),
      h("button", { "aria-label": "End", onclick: () => { this.playing = false; this.goto(this.line.length - 1); this.renderControls(); } }, icon("last"))),
      h("div.seg", { style: { marginTop: "8px" } }, ...SPEEDS.map((s, k) => h(`button${k === this.speed ? ".on" : ""}`, { onclick: () => { this.speed = k; this.renderControls(); this.schedule(); } }, s.label))));
  }
}

// ---------- Bot TV ----------
export class BotTV {
  constructor(app) { this.app = app; this.moveList = new MoveList(() => {}); }
  mount() {
    playEngine().init().catch(() => toast("The engine couldn't load."));
    this.newMatch();
  }
  destroy() { this.dead = true; this.gen++; }

  newMatch() {
    this.gen = (this.gen || 0) + 1;
    const pool = BOTS.filter(b => b.elo >= 600);
    const a = pool[Math.floor(Math.random() * pool.length)];
    let b = pool[Math.floor(Math.random() * pool.length)];
    if (b === a) b = pool[(pool.indexOf(a) + 3) % pool.length];
    this.bots = Math.random() < 0.5 ? { w: a, b } : { w: b, b: a };
    this.chess = new Chess();
    this.app.board.viewSide("w", false);
    this.app.board.syncFromBoard(this.chess.board());
    this.app.board.setLastMove(null, null); this.app.board.setCheck(null);
    this.openingEl = h("div.opening");
    this.statusEl = h("div");
    this.app.panel({
      title: "Bot TV", back: "#/watch",
      body: [this.statusEl, this.openingEl, this.moveList.el],
      foot: h("button.btn.block", { onclick: () => this.newMatch() }, icon("next", 18), "Next match"),
    });
    this.update();
    this.loop(this.gen);
  }

  async loop(gen) {
    loadOpenings();
    while (!this.dead && gen === this.gen && !this.chess.isGameOver() && this.chess.history().length < 300) {
      const bot = this.bots[this.chess.turn()];
      const fen = this.chess.fen();
      let mv;
      try { mv = await botMove(playEngine(), fen, bot, { history: this.chess.history() }); } catch { break; }
      const delay = Math.min(1600, botThinkDelay(bot, fen, Math.floor(this.chess.history().length / 2) + 1));
      await new Promise(r => setTimeout(r, delay));
      if (this.dead || gen !== this.gen) return;
      const m = this.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      this.app.board.animateMove(m);
      moveSound(m, this.chess);
      this.app.board.setLastMove(m.from, m.to);
      this.app.board.setCheck(this.chess.inCheck() ? kingSquare(this.chess, this.chess.turn()) : null);
      this.update();
    }
    if (this.dead || gen !== this.gen) return;
    this.update(true);
    setTimeout(() => { if (!this.dead && gen === this.gen) this.newMatch(); }, 6000);
  }

  update(over = false) {
    const { captured, diff } = capturedFromFen(this.chess.fen());
    const mk = (c) => ({ name: this.bots[c].name, rating: this.bots[c].elo, avatar: this.bots[c].avatar, flag: this.bots[c].country, captured: captured[c === "w" ? "b" : "w"], capColor: c === "w" ? "b" : "w", adv: c === "w" ? diff : -diff });
    this.app.strips(mk("b"), mk("w"));
    const hist = this.chess.history({ verbose: true });
    this.moveList.render(hist.map(m => ({ san: m.san, color: m.color })), hist.length - 1);
    const fens = [];
    const c = new Chess();
    for (const m of hist) { c.move(m); fens.push(c.fen()); }
    const op = openingForGame(fens);
    this.openingEl.innerHTML = "";
    if (op) this.openingEl.append(h("b", op.eco), " ", op.name);
    this.statusEl.innerHTML = "";
    let text;
    if (over || this.chess.isGameOver()) {
      if (this.chess.isCheckmate()) text = `${this.bots[this.chess.turn() === "w" ? "b" : "w"].name} wins by checkmate`;
      else text = "Draw";
      text += ". Next match in a few seconds…";
    } else text = `${this.bots[this.chess.turn()].name} is thinking…`;
    this.statusEl.appendChild(h("div.status-line", h(`span.dot.${this.chess.turn()}`), h("span", text)));
  }
}
