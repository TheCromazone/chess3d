// Game Review: Stockfish classifies every move, computes accuracy, finds key moments, and a coach
// walks through the game. Mistakes can be retried on the board.
import { createChess, animateOn } from "../core/chess960.js";
import { MoveInput } from "../core/input.js";
import { kingSquare, capturedFromFen, START_FEN } from "../core/tree.js";
import { h, icon, copyText } from "../ui/dom.js";
import { shareLink } from "./analysis.js";
import { MoveTree } from "../core/tree.js";
import { gameGif, positionPng } from "../core/gif.js";
import { downloadBlob } from "../ui/dom.js";
import { MoveList, evalGraph, clsDot, CLS, CLS_HEX, toast } from "../ui/components.js";
import { analysisEngine } from "../core/engines.js";
import { reviewGame, coachText } from "../review.js";
import { formatScore, evalBarFraction } from "../engine.js";
import { loadOpenings, isBookPosition } from "../openings.js";
import { getGame, getCachedReview, cacheReview, patchGame, unlock, getSettings } from "../store.js";
import { moveSound, SFX } from "../audio.js";

const ORDER = ["brilliant", "great", "best", "excellent", "good", "book", "inaccuracy", "mistake", "miss", "blunder"];
const COACH = { emoji: "🦉", bg: "#3c5a46" };

export class ReviewScreen {
  constructor(app, gameId) {
    this.app = app;
    this.game = getGame(gameId);
    this.idx = -1;
    this.review = this.game ? getCachedReview(this.game.id) : null;
    this.moveList = new MoveList((i) => this.goto(i));
    this.mode = "summary";
    this.retry = null;
    this.input = new MoveInput(app, {
      getChess: () => (this.retry ? createChess(this.retry.fen) : null),
      canMove: () => !!this.retry,
      onMove: (m, o) => this.retryMove(m, o),
    });
  }

  mount() {
    const app = this.app;
    if (!this.game) {
      app.panel({ title: "Game review", back: "#/profile", body: h("p.note", "That game isn't in your archive anymore.") });
      return;
    }
    this.input.bind();
    app.board.viewSide(this.game.myColor || "w", false);
    app.board.syncFromBoard(createChess(this.game.startFen || START_FEN).board());
    this.renderStrips();
    if (this.review) this.showSummary();
    else this.run();
  }
  destroy() { this.dead = true; analysisEngine().stop().catch(() => {}); this.input.clear(); }
  onBoardSwap() { this.input.bind(); this.goto(this.idx, true); }
  onFlip() { this.renderStrips(); this._evalBar(); }

  key(e) {
    if (!this.review) return false;
    if (e.key === "ArrowLeft") { this.goto(Math.max(-1, this.idx - 1)); return true; }
    if (e.key === "ArrowRight") { this.goto(Math.min(this.review.plies.length - 1, this.idx + 1)); return true; }
    if (e.key === "ArrowUp" || e.key === "Home") { this.goto(-1); return true; }
    if (e.key === "ArrowDown" || e.key === "End") { this.goto(this.review.plies.length - 1); return true; }
    return false;
  }

  async run() {
    const g = this.game;
    const bar = h("div", { style: { height: "8px", borderRadius: "4px", background: "var(--panel-3)", overflow: "hidden" } },
      h("div", { style: { height: "100%", background: "var(--accent)", transformOrigin: "left", transform: "scaleX(0)", transition: "transform .3s cubic-bezier(.22,1,.36,1)" } }));
    const label = h("p.note", "Starting the engine…");
    this.app.panel({
      title: "Game review", back: "#/profile",
      body: [this.coach("Let me look at this game. One moment…"), h("div.card", h("h3", "Analyzing"), label, bar)],
    });
    await loadOpenings();
    try {
      const review = await reviewGame(analysisEngine(), { startFen: g.startFen || START_FEN, moves: g.moves, result: g.result }, {
        isBook: (fen) => isBookPosition(fen),
        ratings: { w: g.white.rating || undefined, b: g.black.rating || undefined },
        onProgress: (done, total) => {
          if (this.dead) return;
          bar.firstChild.style.transform = `scaleX(${(done / total).toFixed(3)})`;
          label.textContent = `Analyzing position ${done} of ${total}`;
        },
      });
      if (this.dead) return;
      this.review = review;
      cacheReview(g.id, review);
      patchGame(g.id, { accuracy: review.accuracy, reviewed: true });
      unlock("review-1");
      const me = g.myColor;
      if (me) {
        if (review.plies.some(p => p.color === me && p.classification === "brilliant")) unlock("brilliant");
        if (review.accuracy[me] >= 90 && g.moves.length >= 40) unlock("accuracy-90");
      }
      SFX.notify();
      this.showSummary();
    } catch (e) {
      if (this.dead) return;
      console.error(e);
      this.app.panel({ title: "Game review", back: "#/profile", body: [h("div.status-line.bad", icon("close", 16), h("span", "The engine couldn't analyze this game. " + (e.message || ""))), h("button.btn.primary.block", { onclick: () => this.run() }, "Try again")] });
    }
  }

  coach(text, extra) {
    return h("div.coach", h("div.avatar", { style: { background: COACH.bg } }, COACH.emoji), h("div.bubble", extra || null, text));
  }

  // ---------- summary ----------
  showSummary() {
    this.mode = "summary";
    const r = this.review, g = this.game;
    const me = g.myColor;
    const acc = (c) => (r.accuracy[c] ?? 0).toFixed(1);
    let intro;
    if (me) {
      const mine = r.accuracy[me];
      intro = mine >= 90 ? `Excellent game! You played with ${acc(me)}% accuracy.` : mine >= 75 ? `Solid play: ${acc(me)}% accuracy. Let's find the moments that mattered.` : `You scored ${acc(me)}% accuracy. There are a few key moments worth a second look.`;
    } else intro = `White played at ${acc("w")}% and Black at ${acc("b")}% accuracy.`;
    const marks = {};
    r.plies.forEach((p, i) => { if (["brilliant", "great", "blunder", "mistake", "miss"].includes(p.classification)) marks[i + 1] = p.classification; });
    const table = h("div.cls-table");
    for (const id of ORDER) {
      table.append(h(`span.n`, { style: { color: CLS_HEX[id] } }, String(r.counts.w[id] || 0)),
        h("span.mid", clsDot(id), CLS[id].label),
        h(`span.n`, { style: { color: CLS_HEX[id] } }, String(r.counts.b[id] || 0)));
    }
    const pl = (c) => g[c === "w" ? "white" : "black"];
    this.app.panel({
      title: "Game review", back: "#/profile",
      body: [
        this.coach(intro),
        evalGraph(r.evalGraph, 0, (i) => { this.goto(i - 1); this.showSteps(); }, marks),
        h("div.acc-row",
          h("div", h("div.note", pl("w").name), h("div.acc-box.w", acc("w"))),
          h("div.note", "Accuracy"),
          h("div", h("div.note", pl("b").name), h("div.acc-box.b", acc("b")))),
        r.estimatedElo ? h("div.acc-row",
          h("b", { style: { fontSize: "20px" } }, String(r.estimatedElo.w)), h("div.note", "Game rating"), h("b", { style: { fontSize: "20px" } }, String(r.estimatedElo.b))) : null,
        table,
      ],
      foot: [h("button.btn.primary.big.block", { onclick: () => { this.goto(-1); this.showSteps(); } }, "Start review"),
        h("div.btn-row",
          h("button.btn", { onclick: () => { this.showSteps(); this.nextKey(); } }, icon("star", 18), "Key moments"),
          h("button.btn", { onclick: () => this.app.go(`#/analysis/${g.id}`) }, icon("analysis", 18), "Analyze")),
        h("div.btn-row",
          h("button.btn.small", { "aria-label": "Download GIF", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { downloadBlob(`chess3d-${g.id}.gif`, await gameGif(this.review.startFen || g.startFen || START_FEN, this.review.plies, { flip: g.myColor === "b" })); } finally { b.disabled = false; } } }, icon("download", 16), "Download GIF"),
          h("button.btn.small", { "aria-label": "Copy share link", onclick: async () => { if (await copyText(shareLink(MoveTree.fromMoves(g.moves, g.startFen || START_FEN), { White: g.white.name, Black: g.black.name, Result: g.result }))) toast("Link copied"); } }, icon("share", 16), "Share link"))],
    });
    this.goto(this.idx, true);
  }

  // ---------- stepping ----------
  showSteps() {
    if (this.mode === "steps") return;
    this.mode = "steps";
    this.coachEl = h("div");
    this.graphEl = h("div");
    this.actionsEl = h("div.btn-row");
    this.app.panel({
      title: "Game review", back: () => this.showSummary(),
      body: [this.coachEl, this.actionsEl, this.graphEl, this.moveList.el],
      foot: [h("div.navbar",
        h("button", { "aria-label": "Start", onclick: () => this.goto(-1) }, icon("first")),
        h("button", { "aria-label": "Previous", onclick: () => this.goto(Math.max(-1, this.idx - 1)) }, icon("prev")),
        h("button", { "aria-label": "Next", onclick: () => this.goto(Math.min(this.review.plies.length - 1, this.idx + 1)) }, icon("next")),
        h("button", { "aria-label": "End", onclick: () => this.goto(this.review.plies.length - 1) }, icon("last"))),
      h("button.btn.block", { onclick: () => this.nextKey() }, icon("star", 18), "Next key moment")],
    });
    this.renderSteps();
  }

  nextKey() {
    const keys = this.review.keyMoments || [];
    const next = keys.find(k => k > this.idx) ?? keys[0];
    if (next !== undefined) this.goto(next);
  }

  goto(i, force = false) {
    if (!this.review) return;
    const prev = this.idx;
    this.idx = i;
    this.retry = null;
    this.lineTok = (this.lineTok || 0) + 1;   // stops a "Best line" playback
    this.input.clear();
    const fen = i < 0 ? (this.game.startFen || START_FEN) : this.review.plies[i].fenAfter;
    const p = i >= 0 ? this.review.plies[i] : null;
    // after a retry or a best-line playback the board isn't showing ply `prev`, so resync
    const dirty = this.boardDirty;
    this.boardDirty = false;
    if (!force && !dirty && p && i === prev + 1) {
      const mv = createChess(p.fenBefore).move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), promotion: p.uci[4] });
      animateOn(this.app.board, mv);
      moveSound(mv, createChess(fen));
    } else this.app.board.syncFromBoard(createChess(fen).board());
    this.decorate();
    this.renderStrips();
    if (this.mode === "steps") this.renderSteps();
  }

  decorate() {
    const b = this.app.board;
    const i = this.idx;
    const p = i >= 0 ? this.review.plies[i] : null;
    const fen = p ? p.fenAfter : (this.game.startFen || START_FEN);
    const c = createChess(fen);
    b.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    b.setLastMove(null, null);
    if (p) {
      const col = CLS_HEX[p.classification] || "#999";
      b.setMarks([{ sq: p.uci.slice(0, 2), color: hexA(col, 0.38) }, { sq: p.uci.slice(2, 4), color: hexA(col, 0.6) }]);
      const showBest = p.bestUci && p.bestUci !== p.uci && !["best", "book", "forced", "brilliant", "great"].includes(p.classification);
      b.setArrows(showBest ? [{ from: p.bestUci.slice(0, 2), to: p.bestUci.slice(2, 4), color: "rgba(82,179,106,.85)" }] : []);
    } else { b.setMarks([]); b.setArrows([]); }
    this.app.evalBar.show(true);
    this._evalBar();
  }

  _evalBar() {
    if (!this.review) return;
    const i = this.idx;
    const sw = i >= 0 ? this.review.plies[i].evalAfter : (this.review.plies[0] ? this.review.plies[0].evalBefore : { cp: 0 });
    if (!sw) return;
    this.app.evalBar.set(evalBarFraction(sw), formatScore(sw).replace("+", ""), this.app.board.orientation);
  }

  renderSteps() {
    const r = this.review;
    const i = this.idx;
    const p = i >= 0 ? r.plies[i] : null;
    this.coachEl.innerHTML = "";
    if (!p) this.coachEl.appendChild(this.coach("Let's walk through the game. Use the arrows or tap any move."));
    else {
      const tag = h("span.cls-tag", clsDot(p.classification, 16), " ");
      const evalChip = h(`span.eval${isWhiteBetter(p.evalAfter) ? ".wht" : ""}`, formatScore(p.evalAfter));
      this.coachEl.appendChild(this.coach(coachText(i, r), h("span", evalChip, tag)));
    }
    this.actionsEl.innerHTML = "";
    const me = this.game.myColor;
    if (p && ["inaccuracy", "mistake", "blunder", "miss"].includes(p.classification) && (!me || p.color === me) && p.bestUci) {
      this.actionsEl.append(
        h("button.btn.small", { onclick: () => this.startRetry(p) }, icon("undo", 16), "Retry"),
        h("button.btn.small", { onclick: () => this.showBestLine(p) }, icon("eye", 16), "Best line"));
    }
    this.graphEl.innerHTML = "";
    const marks = {};
    r.plies.forEach((pp, k) => { if (["brilliant", "great", "blunder", "mistake", "miss"].includes(pp.classification)) marks[k + 1] = pp.classification; });
    this.graphEl.appendChild(evalGraph(r.evalGraph, i + 1, (k) => this.goto(k - 1), marks));
    const times = this.game.times || [];
    this.moveList.render(r.plies.map((pp, k) => ({ san: pp.san, color: pp.color, cls: pp.classification, time: times[k] })), i, plyOf(this.game.startFen));
  }

  startRetry(p) {
    this.retry = { fen: p.fenBefore, ply: p };
    this.boardDirty = true;
    this.lineTok = (this.lineTok || 0) + 1;
    this.app.board.syncFromBoard(createChess(p.fenBefore).board());
    this.app.board.setMarks([]); this.app.board.setArrows([]);
    this.app.board.setLastMove(null, null);
    this.coachEl.innerHTML = "";
    this.coachEl.appendChild(this.coach(`Find a better move for ${p.color === "w" ? "White" : "Black"}.`));
    this.input.bind();
  }

  retryMove(m, opts) {
    const p = this.retry.ply;
    const c = createChess(this.retry.fen);
    const mv = c.move(m);
    animateOn(this.app.board, mv, opts);
    moveSound(mv, c);
    const uci = mv.from + mv.to + (mv.promotion || "");
    const ok = uci === p.bestUci || (p.goodMoves || []).includes(uci);
    this.coachEl.innerHTML = "";
    if (ok) {
      SFX.correct();
      this.coachEl.appendChild(this.coach(`${mv.san} is the best move. Well found!`));
      this.retry = null;
      this.app.board.setMarks([{ sq: mv.to, color: "rgba(82,179,106,.6)" }]);
    } else {
      SFX.wrong();
      this.coachEl.appendChild(this.coach(`${mv.san} isn't it. Try again, or tap Best line.`));
      this.app.board.setMarks([{ sq: mv.to, color: "rgba(224,55,42,.55)" }]);
      setTimeout(() => { if (this.retry) { this.app.board.syncFromBoard(createChess(this.retry.fen).board()); this.app.board.setMarks([]); } }, 700);
    }
  }

  showBestLine(p) {
    this.retry = null;
    this.boardDirty = true;
    const tok = this.lineTok = (this.lineTok || 0) + 1;
    const c = createChess(p.fenBefore);
    this.app.board.syncFromBoard(c.board());
    this.app.board.setMarks([]);
    const line = (p.bestLineSan || [p.bestSan]).slice(0, 6);
    let k = 0;
    const stepFn = () => {
      if (this.dead || this.mode !== "steps" || k >= line.length || this.retry || tok !== this.lineTok) return;
      let mv;
      try { mv = c.move(line[k]); } catch { return; }
      animateOn(this.app.board, mv);
      moveSound(mv, c);
      this.app.board.setArrows([{ from: mv.from, to: mv.to, color: "rgba(82,179,106,.8)" }]);
      k++;
      setTimeout(stepFn, 900);
    };
    this.coachEl.innerHTML = "";
    this.coachEl.appendChild(this.coach(`The engine's line: ${line.join(" ")}`));
    setTimeout(stepFn, 300);
  }

  renderStrips() {
    const g = this.game;
    const fen = this.idx >= 0 && this.review ? this.review.plies[this.idx].fenAfter : (g.startFen || START_FEN);
    const { captured, diff } = capturedFromFen(fen);
    const o = this.app.board.orientation;
    const mk = (c) => {
      const p = g[c === "w" ? "white" : "black"];
      return { name: p.name, rating: p.rating, avatar: p.avatar || { emoji: c === "w" ? "♔" : "♚", bg: "#4a3b2e" }, captured: captured[c === "w" ? "b" : "w"], capColor: c === "w" ? "b" : "w", adv: c === "w" ? diff : -diff };
    };
    this.app.strips(mk(o === "w" ? "b" : "w"), mk(o));
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function isWhiteBetter(sw) { return sw.mate !== undefined && sw.mate !== null ? sw.mate > 0 : (sw.cp || 0) >= 0; }
function plyOf(fen) { if (!fen) return 0; const p = fen.split(" "); return (Number(p[5] || 1) - 1) * 2 + (p[1] === "b" ? 1 : 0); }
void getSettings; void toast;
