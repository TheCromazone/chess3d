// Local game controller: vs Computer and Pass & Play.
// Owns the chess.js instance, clocks, selection, HUD updates, AI worker.
import { Chess } from "chess.js";
import { STR } from "./strings.js";
import { SFX } from "./audio.js";

const TIME_CONTROLS = { "1+0": [60, 0], "3+2": [180, 2], "5+0": [300, 0], "10+0": [600, 0], "15+10": [900, 10], "inf": null };

export class LocalGame {
  /**
   * mode: { kind: "ai", level, playerColor: "w"|"b" } | { kind: "local" }
   * tcKey: key of TIME_CONTROLS
   */
  constructor(board3d, ui, mode, tcKey, callbacks) {
    this.b3d = board3d;
    this.ui = ui;
    this.mode = mode;
    this.tcKey = tcKey;
    this.onExit = callbacks.onExit;
    this.onRematch = callbacks.onRematch;
    this.chess = new Chess();
    this.selected = null;
    this.over = false;
    this.captured = { w: [], b: [] };  // pieces captured FROM that color
    this.pendingAI = false;
    this.lastTickSecond = null;

    const tc = TIME_CONTROLS[tcKey];
    this.clock = tc ? { w: tc[0] * 1000, b: tc[0] * 1000, inc: tc[1] * 1000, lastTs: null, active: null } : null;

    this.worker = mode.kind === "ai" ? new Worker("./ai-worker.js") : null;
    if (this.worker) this.worker.onmessage = (e) => this._aiMoved(e.data);

    this.b3d.onSquareTap = (sq) => this._tap(sq);
    this.b3d.syncFromBoard(this.chess.board());
    this.b3d.setLastMove(null, null);
    this.b3d.setCheck(null);
    this.b3d.clearHints();
    this.b3d.viewSide(mode.kind === "ai" ? mode.playerColor : "w", false);

    ui.showGame(this._names());
    ui.setMoveList([]);
    ui.setCaptured(this.captured);
    this._updateClocks(true);
    this._status();
    SFX.start();

    if (this.clock) this._startClock("w");
    this._clockLoop = setInterval(() => this._clockTick(), 100);
    if (mode.kind === "ai" && mode.playerColor === "b") this._askAI();
  }

  destroy() {
    clearInterval(this._clockLoop);
    if (this.worker) this.worker.terminate();
    this.b3d.onSquareTap = null;
  }

  _names() {
    if (this.mode.kind === "ai") {
      const lvl = STR.menu.levels[this.mode.level - 1];
      return {
        bottom: { name: STR.hud.you, color: this.mode.playerColor },
        top: { name: `${STR.hud.computer} · ${lvl}`, color: this.mode.playerColor === "w" ? "b" : "w" },
      };
    }
    return { bottom: { name: STR.hud.white, color: "w" }, top: { name: STR.hud.black, color: "b" } };
  }

  _humanTurn() {
    if (this.over) return false;
    if (this.mode.kind === "local") return true;
    return this.chess.turn() === this.mode.playerColor && !this.pendingAI;
  }

  _tap(sq) {
    if (!this._humanTurn()) return;
    const piece = this.chess.get(sq);
    if (this.selected) {
      const moves = this.chess.moves({ square: this.selected, verbose: true }).filter(m => m.to === sq);
      if (moves.length) {
        if (moves.some(m => m.promotion)) {
          this.ui.askPromotion(this.chess.turn(), (promo) => {
            if (promo) this._makeMove({ from: this.selected, to: sq, promotion: promo });
            else this._deselect();
          });
        } else {
          this._makeMove({ from: this.selected, to: sq });
        }
        return;
      }
    }
    if (piece && piece.color === this.chess.turn()) {
      this.selected = sq;
      this.b3d.setSelected(sq);
      const ms = this.chess.moves({ square: sq, verbose: true });
      this.b3d.showMoves(
        ms.filter(m => !m.captured).map(m => m.to),
        ms.filter(m => m.captured).map(m => m.to));
    } else {
      this._deselect();
      if (piece) SFX.illegal();
    }
  }

  _deselect() { this.selected = null; this.b3d.clearHints(); }

  _makeMove(mvIn) {
    this._deselect();
    let mv;
    try { mv = this.chess.move(mvIn); } catch { SFX.illegal(); return; }
    this._afterMove(mv);
    if (!this.over && this.mode.kind === "ai" && this.chess.turn() !== this.mode.playerColor) this._askAI();
  }

  _afterMove(mv) {
    this.b3d.animateMove(mv);
    this.b3d.setLastMove(mv.from, mv.to);
    if (mv.captured) this.captured[mv.color === "w" ? "b" : "w"].push(mv.captured);
    this.ui.setCaptured(this.captured);
    this.ui.setMoveList(this.chess.history());

    if (this.chess.isCheckmate()) SFX.end();
    else if (mv.promotion) SFX.promote();
    else if (mv.flags.includes("k") || mv.flags.includes("q")) SFX.castle();
    else if (mv.captured) SFX.capture();
    else SFX.move();
    if (this.chess.inCheck() && !this.chess.isCheckmate()) SFX.check();

    this._syncCheckHighlight();
    if (this.clock) {
      this.clock[mv.color] += this.clock.inc;
      this._startClock(this.chess.turn());
    }
    this._updateClocks();
    this._status();
    this._checkGameOver();
    if (this.mode.kind === "local" && !this.over) this.ui.hintTurn(this.chess.turn());
  }

  _syncCheckHighlight() {
    if (!this.chess.inCheck()) { this.b3d.setCheck(null); return; }
    const color = this.chess.turn();
    const board = this.chess.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const c = board[r][f];
      if (c && c.type === "k" && c.color === color) {
        this.b3d.setCheck("abcdefgh"[f] + (8 - r));
        return;
      }
    }
  }

  _askAI() {
    this.pendingAI = true;
    this.ui.setStatus(STR.hud.thinking);
    const fen = this.chess.fen();
    setTimeout(() => this.worker.postMessage({ fen, level: this.mode.level }), 250);
  }

  _aiMoved(mv) {
    this.pendingAI = false;
    if (this.over || !mv) return;
    try { this._afterMoveApply(mv); } catch { /* stale reply after undo/reset */ }
  }

  _afterMoveApply(mvIn) {
    const mv = this.chess.move(mvIn);
    this._afterMove(mv);
  }

  // ---------- clocks ----------
  _startClock(color) {
    if (!this.clock) return;
    this.clock.active = color;
    this.clock.lastTs = performance.now();
  }

  _clockTick() {
    if (!this.clock || this.over || this.clock.active === null) return;
    const now = performance.now();
    const c = this.clock.active;
    this.clock[c] -= now - this.clock.lastTs;
    this.clock.lastTs = now;
    if (this.clock[c] <= 0) {
      this.clock[c] = 0;
      this._updateClocks();
      this._finish(this._timeoutResult(c));
      return;
    }
    const humanClock = this.mode.kind !== "ai" || c === this.mode.playerColor;
    const secs = Math.ceil(this.clock[c] / 1000);
    if (humanClock && this.clock[c] <= 10500 && secs !== this.lastTickSecond) {
      this.lastTickSecond = secs;
      SFX.tick();
    }
    this._updateClocks();
  }

  _timeoutResult(flaggedColor) {
    // timeout vs lone king = draw
    const opp = flaggedColor === "w" ? "b" : "w";
    const hasMaterial = this.chess.board().flat().some(p => p && p.color === opp && p.type !== "k");
    if (!hasMaterial) return { draw: true, reason: "timeout-draw" };
    return { winner: opp, reason: "timeout" };
  }

  _updateClocks(init = false) {
    if (!this.clock) { this.ui.setClocks(null, null, null); return; }
    this.ui.setClocks({ w: this.clock.w, b: this.clock.b }, this.over ? null : (init ? "w" : this.clock.active),
      this.mode.kind === "ai" ? this.mode.playerColor : "w");
  }

  _status() {
    if (this.over) return;
    if (this.mode.kind === "ai") {
      this.ui.setStatus(this._humanTurn() ? STR.hud.yourTurn : STR.hud.thinking);
    } else {
      this.ui.setStatus(this.chess.turn() === "w" ? STR.hud.whiteTurn : STR.hud.blackTurn);
    }
    if (this.chess.inCheck()) this.ui.setStatus(this.ui.statusText() + " — " + STR.hud.check);
  }

  _checkGameOver() {
    if (this.chess.isCheckmate()) {
      const winner = this.chess.turn() === "w" ? "b" : "w";
      this._finish({ winner, reason: "checkmate" });
    } else if (this.chess.isStalemate()) this._finish({ draw: true, reason: "stalemate" });
    else if (this.chess.isThreefoldRepetition()) this._finish({ draw: true, reason: "threefold" });
    else if (this.chess.isInsufficientMaterial()) this._finish({ draw: true, reason: "material" });
    else if (this.chess.isDraw()) this._finish({ draw: true, reason: "fifty" });
  }

  _finish(result) {
    if (this.over) return;
    this.over = true;
    if (this.clock) this.clock.active = null;
    this.b3d.clearHints();
    SFX.end();
    const youAre = this.mode.kind === "ai" ? this.mode.playerColor : null;
    this.ui.showGameOver(result, youAre, this.onRematch, this.onExit);
  }

  // ---------- toolbar actions ----------
  resign() {
    if (this.over) return;
    const loser = this.mode.kind === "ai" ? this.mode.playerColor : this.chess.turn();
    this._finish({ winner: loser === "w" ? "b" : "w", reason: "resignation" });
  }

  offerDraw() {
    if (this.over) return;
    if (this.mode.kind === "local") {
      this.ui.askDraw(() => this._finish({ draw: true, reason: "agreement" }));
    } else {
      // the computer accepts only when clearly worse (rough material count)
      let score = 0;
      const V = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
      for (const p of this.chess.board().flat()) if (p) score += (p.color === this.mode.playerColor ? 1 : -1) * V[p.type];
      if (score >= 4) this._finish({ draw: true, reason: "agreement" });
      else this.ui.toast(STR.hud.drawOfferSent + " — declined");
    }
  }

  undo() {
    if (this.over || this.mode.kind !== "ai" || this.pendingAI) return;
    const h = this.chess.history({ verbose: true });
    if (!h.length) return;
    const plies = this.chess.turn() === this.mode.playerColor ? 2 : 1;
    for (let i = 0; i < plies && this.chess.history().length; i++) this.chess.undo();
    this._recomputeCaptured();
    this.b3d.syncFromBoard(this.chess.board());
    const nh = this.chess.history({ verbose: true });
    const last = nh[nh.length - 1];
    this.b3d.setLastMove(last ? last.from : null, last ? last.to : null);
    this._syncCheckHighlight();
    this._deselect();
    this.ui.setMoveList(this.chess.history());
    this.ui.setCaptured(this.captured);
    if (this.clock) this._startClock(this.chess.turn());
    this._status();
  }

  _recomputeCaptured() {
    this.captured = { w: [], b: [] };
    for (const m of this.chess.history({ verbose: true })) {
      if (m.captured) this.captured[m.color === "w" ? "b" : "w"].push(m.captured);
    }
  }

  flip() {
    this._flipped = !this._flipped;
    const base = this.mode.kind === "ai" ? this.mode.playerColor : "w";
    this.b3d.viewSide(this._flipped ? (base === "w" ? "b" : "w") : base);
  }
}
