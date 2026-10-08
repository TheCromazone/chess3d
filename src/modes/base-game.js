// Shared game controller: live position + move tree, history navigation, clocks, panel,
// player strips, game-over flow, and the archive record. Bot, pass-and-play and online extend it.
import { createChess, animateOn, chess960Fen } from "../core/chess960.js";
import { MoveTree, START_FEN, kingSquare, capturedFromFen } from "../core/tree.js";
import { MoveInput } from "../core/input.js";
import { h, icon } from "../ui/dom.js";
import { MoveList, openModal, updateClock, parseTc, tcLabel, toast, moveEntry } from "../ui/components.js";
import { getSettings, saveGame, newGameId, updateProfile, unlock } from "../store.js";
import { moveSound, SFX } from "../audio.js";
import { openingForGame, loadOpenings } from "../openings.js";

export const VARIANTS = [
  { value: "standard", label: "Standard", desc: "" },
  { value: "koth", label: "King of the Hill", desc: "Also win by walking your king to d4, e4, d5 or e5." },
  { value: "3check", label: "Three-check", desc: "Also win by checking the enemy king three times." },
  { value: "960", label: "Chess960", desc: "The back-rank pieces start in a random order. Castle by moving your king onto its rook." },
];
export const variantName = (v) => (VARIANTS.find(x => x.value === v) || VARIANTS[0]).label;

export const REASON_TEXT = {
  checkmate: "by checkmate", resignation: "by resignation", timeout: "on time",
  stalemate: "by stalemate", threefold: "by repetition", fifty: "by the 50-move rule",
  material: "by insufficient material", agreement: "by agreement", "timeout-draw": "timeout vs insufficient material",
  abandoned: "by abandonment", aborted: "game aborted",
  koth: "by reaching the center", threecheck: "by three checks",
};

export class BaseGame {
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.startFen = cfg.startFen || (cfg.variant === "960" ? chess960Fen() : START_FEN);
    this.tree = new MoveTree(this.startFen);
    this.node = this.tree.root;
    this.view = this.tree.root;
    this.chess = createChess(this.startFen);
    this.players = cfg.players;
    this.myColor = cfg.myColor || null;
    this.tcKey = cfg.tcKey || "inf";
    const tc = parseTc(this.tcKey);
    this.clock = tc ? { w: tc.initial, b: tc.initial, inc: tc.inc, active: null, lastTs: 0 } : null;
    this.result = null;
    this.id = cfg.id || newGameId();
    this.startedAt = Date.now();
    this.opening = null;
    this.input = new MoveInput(app, {
      getChess: () => (this.result || this.view !== this.node ? null : this.chess),
      canMove: (c) => this.canMove(c),
      premoveColor: () => (this.result ? null : this.premoveColor()),
      onMove: (m, o) => this.userMove(m, o),
    });
    this.moveList = new MoveList((i) => this.goToPly(i));
    loadOpenings().then(() => { this._updateOpening(); });
  }

  // ---- hooks for subclasses ----
  canMove() { return false; }
  premoveColor() { return null; }
  userMove() {}
  title() { return "Game"; }
  get variant() { return this.cfg.variant || "standard"; }
  checksGiven(color) {
    return this.plies().filter(n => n.move && n.move.color === color && /[+#]/.test(n.san)).length;
  }
  controls() { return []; }
  bottomColor() { return this.myColor || "w"; }
  onAfterMove() {}
  extraPanel() { return null; }
  postGameButtons() { return []; }

  mount() {
    this._lastMoveAt = performance.now();
    this.app.setInGame(true);
    this.input.bind();
    this.app.board.viewSide(this.bottomColor(), false);
    this.app.board.syncFromBoard(this.chess.board());
    this._buildPanel();
    this.redraw();
    this._tick = setInterval(() => this._clockTick(), 100);
  }

  destroy() {
    this._destroyed = true;
    clearInterval(this._tick);
    this.input.clear();
    this.input.cancelPremove();
  }

  onBoardSwap() {
    this.input.bind();
    this.redraw();
  }
  onSettings() { this.redraw(); this.renderMoves(); }
  onFlip() { this.renderStrips(); }

  key(e) {
    if (e.key === "ArrowLeft") { this.step(-1); return true; }
    if (e.key === "ArrowRight") { this.step(1); return true; }
    if (e.key === "ArrowUp" || e.key === "Home") { this.goToPly(-1); return true; }
    if (e.key === "ArrowDown" || e.key === "End") { this.goToPly(this.plyCount() - 1); return true; }
    return false;
  }

  // ---- position & navigation ----
  plies() { return this.tree.mainline(); }
  plyCount() { return this.node.ply - this.tree.root.ply; }

  goToPly(i) {
    const line = this.plies();
    const target = i < 0 ? this.tree.root : line[Math.min(i, line.length - 1)];
    if (!target) return;
    const prev = this.view;
    this.view = target;
    this.input.clear();
    if (target.parent === prev && target.move) animateOn(this.app.board, target.move);
    else this.app.board.syncFromBoard(createChess(target.fen).board());
    if (target.parent === prev && target.move) moveSound(target.move, createChess(target.fen));
    this.redraw(false);
    this.renderMoves();
  }
  step(d) {
    const idx = this.view.ply - this.tree.root.ply - 1;
    const n = this.plyCount();
    const next = Math.max(-1, Math.min(n - 1, idx + d));
    if (next !== idx) this.goToPly(next);
  }

  // Full redraw of board decorations for the viewed node (position sync optional).
  redraw(sync = true) {
    const b = this.app.board;
    const v = this.view;
    if (sync) b.syncFromBoard(createChess(v.fen).board());
    const s = getSettings();
    b.setLastMove(s.highlightLast && v.move ? v.move.from : null, s.highlightLast && v.move ? v.move.to : null);
    const c = createChess(v.fen);
    b.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    this.renderStrips();
    this._renderStatus();
  }

  // Apply a move to the live position (from user, bot, or network).
  applyMove(m, { instant = false, opponent = false } = {}) {
    const wasLive = this.view === this.node;
    let mv;
    try { mv = this.chess.move(m); } catch { return null; }
    const prev = this.node;
    this.node = this.tree.play(this.node, { from: mv.from, to: mv.to, promotion: mv.promotion });
    // time spent on this move (shown in Game Review, like chess.com's move times)
    const tNow = performance.now();
    this.node.spentMs = this._lastMoveAt ? Math.round(tNow - this._lastMoveAt) : null;
    this._lastMoveAt = tNow;
    this.view = this.node;
    if (wasLive) animateOn(this.app.board, mv, { instant });
    else this.app.board.syncFromBoard(this.chess.board());
    moveSound(mv, this.chess, { opponent });
    // clocks: increment for the mover, start the opponent's clock once both sides have moved
    if (this.clock) {
      const now = performance.now();
      if (this.clock.active === mv.color) {
        this.clock[mv.color] -= now - this.clock.lastTs;
        this.clock[mv.color] += this.clock.inc;
      }
      if (this.plyCount() >= 2) { this.clock.active = this.chess.turn(); this.clock.lastTs = now; }
    }
    this._updateOpening();
    this.redraw(false);
    this.renderMoves();
    this._renderControls();
    void prev;
    const res = this._detectEnd();
    if (res) this.finish(res);
    else this.onAfterMove(mv);
    return mv;
  }

  _detectEnd() {
    const c = this.chess;
    if (c.isCheckmate()) return { winner: c.turn() === "w" ? "b" : "w", reason: "checkmate" };
    const mover = c.turn() === "w" ? "b" : "w";
    if (this.variant === "koth") {
      const center = ["d4", "e4", "d5", "e5"];
      if (center.some(sq => { const p = c.get(sq); return p && p.type === "k" && p.color === mover; })) return { winner: mover, reason: "koth" };
    }
    if (this.variant === "3check" && this.checksGiven(mover) >= 3) return { winner: mover, reason: "threecheck" };
    if (c.isStalemate()) return { winner: null, reason: "stalemate" };
    if (c.isInsufficientMaterial()) return { winner: null, reason: "material" };
    if (c.isThreefoldRepetition()) return { winner: null, reason: "threefold" };
    if (c.isDraw()) return { winner: null, reason: "fifty" };
    return null;
  }

  // ---- clocks ----
  _clockTick() {
    if (!this.clock) return;
    const ck = this.clock;
    let ms = { w: ck.w, b: ck.b };
    if (!this.result && ck.active) {
      ms[ck.active] = ck[ck.active] - (performance.now() - ck.lastTs);
      if (ms[ck.active] <= 0) {
        ck[ck.active] = 0; ms[ck.active] = 0;
        const flagged = ck.active;
        ck.active = null;
        this.onFlag(flagged);
      } else if (getSettings().lowTimeWarning && (!this.myColor || ck.active === this.myColor) && ms[ck.active] <= 10000) {
        const sec = Math.ceil(ms[ck.active] / 1000);
        if (sec !== this._lastTickSec) { this._lastTickSec = sec; SFX.tick(); }
      }
    }
    const bottom = this.app.board.orientation;
    const top = bottom === "w" ? "b" : "w";
    updateClock(this.app.stripBottom, ms[bottom], ck.active === bottom && !this.result);
    updateClock(this.app.stripTop, ms[top], ck.active === top && !this.result);
  }
  onFlag(flagged) { this.finish(this._timeoutResult(flagged)); }
  clockMs(color) {
    if (!this.clock) return null;
    const ck = this.clock;
    return ck.active === color && !this.result ? ck[color] - (performance.now() - ck.lastTs) : ck[color];
  }

  _timeoutResult(flagged) {
    const opp = flagged === "w" ? "b" : "w";
    const pieces = this.chess.board().flat().filter(p => p && p.color === opp && p.type !== "k");
    const cannotMate = pieces.length === 0 || (pieces.length === 1 && (pieces[0].type === "b" || pieces[0].type === "n"));
    return cannotMate ? { winner: null, reason: "timeout-draw" } : { winner: opp, reason: "timeout" };
  }

  // ---- panel ----
  _buildPanel() {
    this.statusEl = h("div");
    this.openingEl = h("div.opening");
    this.navEl = h("div.navbar",
      h("button", { "aria-label": "First move", onclick: () => this.goToPly(-1) }, icon("first")),
      h("button", { "aria-label": "Previous move", onclick: () => this.step(-1) }, icon("prev")),
      h("button", { "aria-label": "Next move", onclick: () => this.step(1) }, icon("next")),
      h("button", { "aria-label": "Last move", onclick: () => this.goToPly(this.plyCount() - 1) }, icon("last")));
    this.controlsEl = h("div.iconbar");
    this.postEl = h("div.btn-row");
    this.extraEl = h("div");
    const flipBtn = h("button.back", { "aria-label": "Flip board", title: "Flip board (F)", onclick: () => { this.app.board.viewSide(this.app.board.orientation === "w" ? "b" : "w"); this.renderStrips(); } }, icon("flip", 20));
    const entry = moveEntry(() => (this.result || this.view !== this.node || !this.canMove(this.chess.turn()) ? null : this.chess), (m) => this.userMove(m, {}));
    this.app.panel({
      title: this.title(),
      // phones hide the tab bar in a game, so this is the way out (leave guards still apply)
      back: "#/",
      actions: flipBtn,
      body: [this.extraEl, this.statusEl, this.openingEl, this.moveList.el, this.navEl, entry],
      foot: [this.postEl, this.controlsEl],
    });
    const extra = this.extraPanel();
    if (extra) this.extraEl.appendChild(extra);
    this.renderMoves();
    this._renderControls();
  }

  renderMoves() {
    const line = this.plies();
    const items = line.map(n => ({ san: n.san, color: n.ply % 2 === 1 ? "w" : "b" }));
    const cur = this.view.ply - this.tree.root.ply - 1;
    this.moveList.render(items, cur, this.tree.root.ply);
  }

  _renderControls() {
    if (!this.controlsEl) return;
    this.controlsEl.innerHTML = "";
    for (const c of this.controls()) {
      const b = h("button", { "aria-label": c.label, title: c.label, onclick: c.onClick, disabled: c.disabled || undefined, class: c.on ? "on" : "" },
        c.text ? h("span.txt", c.text) : icon(c.icon));
      this.controlsEl.appendChild(b);
    }
    this.postEl.innerHTML = "";
    if (this.result) for (const b of this.postGameButtons()) this.postEl.appendChild(b);
    this.postEl.hidden = !this.result;
  }

  _renderStatus() {
    if (!this.statusEl) return;
    const el = this.statusEl;
    el.innerHTML = "";
    let text, kind = "", dot = this.chess.turn();
    if (this.result) {
      const r = this.result;
      text = (r.winner ? (r.winner === "w" ? "White won" : "Black won") : r.reason === "aborted" ? "Game aborted" : "Draw") + " " + (r.reason === "aborted" ? "" : REASON_TEXT[r.reason] || "");
      kind = this.myColor ? (r.winner === this.myColor ? "good" : r.winner ? "bad" : "") : "";
      dot = r.winner || null;
    } else if (this.view !== this.node) {
      text = "Viewing an earlier position";
      dot = null;
    } else text = this.statusText();
    if (!text) return;
    el.appendChild(h(`div.status-line${kind ? "." + kind : ""}`, dot ? h(`span.dot.${dot}`) : icon("eye", 16), h("span", text)));
  }
  statusText() {
    const t = this.chess.turn();
    return (t === "w" ? "White" : "Black") + " to move" + (this.chess.inCheck() ? ", in check" : "");
  }

  _updateOpening() {
    if (!this.openingEl) return;
    const fens = this.plies().map(n => n.fen);
    const op = openingForGame(fens);
    if (op) this.opening = op;
    this.openingEl.innerHTML = "";
    if (this.opening) this.openingEl.append(h("b", this.opening.eco), " ", this.opening.name);
  }

  renderStrips() {
    const bottom = this.app.board.orientation || this.bottomColor();
    const top = bottom === "w" ? "b" : "w";
    const { captured, diff } = capturedFromFen(this.view.fen);
    const mk = (color) => {
      const p = this.players[color];
      const opp = color === "w" ? "b" : "w";
      return {
        ...p,
        captured: captured[opp], capColor: opp,
        adv: color === "w" ? diff : -diff,
        name: this.variant === "3check" ? `${p.name} · ${this.checksGiven(color)}/3 checks` : p.name,
        clockMs: this.clock ? this.clockMs(color) : null,
        active: this.clock && this.clock.active === color && !this.result,
        thinking: p.thinking,
      };
    };
    this.app.strips(mk(top), mk(bottom));
  }

  // ---- end of game ----
  finish(result) {
    if (this.result) return;
    this.result = result;
    if (this.clock && this.clock.active) {
      const c = this.clock.active;
      this.clock[c] = Math.max(0, this.clock[c] - (performance.now() - this.clock.lastTs));
      this.clock.active = null;
    }
    this.input.clear();
    this.input.cancelPremove();
    SFX.end();
    const extra = this.onFinish(result) || {};
    const rec = this.record(extra);
    if (rec) {
      saveGame(rec);
      this._stats(rec);
    }
    this.redraw(false);
    this._renderControls();
    this.renderMoves();
    setTimeout(() => this.showResultModal(extra), 650);
  }
  onFinish() { return {}; }

  resultString() {
    const r = this.result;
    if (!r) return "*";
    return r.winner === "w" ? "1-0" : r.winner === "b" ? "0-1" : "1/2-1/2";
  }

  record(extra = {}) {
    if (this.plyCount() < 1 || (this.result && this.result.reason === "aborted")) return null;
    const p = (c) => ({ name: this.players[c].name, rating: this.players[c].rating || null, avatar: this.players[c].avatar || null, bot: this.players[c].botId || null });
    return {
      id: this.id, date: this.startedAt, mode: this.cfg.mode, variant: this.variant,
      white: p("w"), black: p("b"), myColor: this.myColor,
      result: this.resultString(), reason: this.result.reason, tc: this.tcKey,
      startFen: this.startFen, moves: this.plies().map(n => n.uci), san: this.plies().map(n => n.san),
      times: this.plies().map(n => (n.spentMs == null ? null : n.spentMs)),
      opening: this.opening ? `${this.opening.eco} ${this.opening.name}` : null,
      ratingDelta: extra.delta ?? null, rated: !!extra.rated,
    };
  }

  _stats(rec) {
    if (!this.myColor) return;
    const r = this.result;
    updateProfile(p => {
      p.stats.games++;
      if (!r.winner) p.stats.draws++;
      else if (r.winner === this.myColor) p.stats.wins++;
      else p.stats.losses++;
    });
    unlock("first-game");
    if (r.winner === this.myColor) {
      unlock("first-win");
      if (r.reason === "checkmate") {
        const last = this.node.move;
        if (last && last.piece === "p") unlock("checkmate-pawn");
        if (last && last.piece === "n") unlock("checkmate-knight");
      }
      if (this.plies().some(n => n.move && n.move.color === this.myColor && n.move.promotion && n.move.promotion !== "q")) unlock("underpromote");
    }
    void rec;
  }

  showResultModal(extra = {}) {
    // finish() schedules this; skip it if the user already left (or started a rematch)
    if (!this.result || this._modalShown || this._destroyed) return;
    this._modalShown = true;
    const r = this.result;
    let title;
    if (r.reason === "aborted") title = "Game aborted";
    else if (!r.winner) title = "Draw";
    else if (this.myColor) title = r.winner === this.myColor ? "You won!" : "You lost";
    else title = r.winner === "w" ? "White won" : "Black won";
    const side = (c) => {
      const p = this.players[c];
      const won = r.winner === c;
      const delta = extra.deltaFor && extra.deltaFor[c];
      return h(`div.side${won ? ".win" : ""}`,
        h("div.avatar", { style: { background: p.avatar?.bg || "#3a2e24" } }, p.avatar?.emoji || "♟"),
        h("b", p.name),
        h("span.muted", p.rating ? String(p.rating) : " "),
        delta ? h(`span.delta.${delta > 0 ? "up" : "down"}`, (delta > 0 ? "+" : "") + delta) : null);
    };
    const score = r.reason === "aborted" ? "–" : r.winner === "w" ? "1–0" : r.winner === "b" ? "0–1" : "½–½";
    const body = [h("div.vs", side("w"), h("div.score", score), side("b"))];
    if (this.plyCount() >= 2 && r.reason !== "aborted") {
      body.push(h("button.btn.primary.big.block", { onclick: () => { m.close(); this.app.go(`#/review/${this.id}`); } }, icon("star"), "Game review"));
    }
    body.push(h("div.btn-row", ...this.postGameButtons(() => m.close())));
    const m = openModal({ title, sub: r.reason === "aborted" ? "" : REASON_TEXT[r.reason], body });
  }

  // Offer the user to leave; returns true if navigation may proceed.
  async confirmLeave() { return true; }

  toast(msg) { toast(msg); }
  tcText() { return tcLabel(this.tcKey); }
}
