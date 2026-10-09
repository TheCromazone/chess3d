// Puzzles: rated trainer (optionally by theme), daily puzzle, and Puzzle Rush (3 min / 5 min / survival).
import { Chess } from "chess.js";
import { MoveInput } from "../core/input.js";
import { kingSquare, uciToMove } from "../core/tree.js";
import { h, icon, todayStr } from "../ui/dom.js";
import { openModal, toast, segmented, announceMove, announce, confirmModal } from "../ui/components.js";
import { loadPuzzles, nextPuzzle, dailyPuzzle, rushSequence, puzzleRatingUpdate, isCorrectMove, themesAvailable, THEME_INFO } from "../puzzles.js";
import { getProfile, updateProfile, unlock } from "../store.js";
import { moveSound, SFX } from "../audio.js";

const GOOD = "rgba(82,179,106,.6)", BAD = "rgba(224,55,42,.55)", HINT = "rgba(91,143,214,.55)";
const DIFFICULTY = { easiest: -600, easier: -300, normal: 0, harder: 300, hardest: 600 };
let difficulty = "normal";

// Drives one puzzle on the board: plays the setup move, checks answers, replies, hints, solution.
export class PuzzleRunner {
  constructor(app, { onSolved, onWrong, onProgress }) {
    this.app = app;
    this.cb = { onSolved, onWrong, onProgress };
    this.input = new MoveInput(app, {
      getChess: () => (this.state === "solving" ? this.chess : null),
      canMove: (c) => this.state === "solving" && c === this.p.playerColor,
      onMove: (m, o) => this.userMove(m, o),
    });
  }
  bind() { this.input.bind(); }

  load(p) {
    this.p = p;
    this.idx = 1;
    this.failed = false;
    this.hints = 0;
    this.state = "intro";
    this.chess = new Chess(p.fen);
    this.input.clear();   // a selection from the previous puzzle
    const b = this.app.board;
    b.viewSide(p.playerColor, false);
    b.syncFromBoard(this.chess.board());
    b.setMarks([]); b.setArrows([]); b.setLastMove(null, null); b.setCheck(null);
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      if (this.p !== p) return;
      const mv = this.chess.move(uciToMove(p.moves[0]));
      b.animateMove(mv);
      announceMove(mv);
      moveSound(mv, this.chess, { opponent: true });
      this._decorate(mv);
      this.state = "solving";
      if (this.cb.onProgress) this.cb.onProgress();
    }, 550);
  }

  _decorate(mv) {
    const b = this.app.board;
    b.setLastMove(mv ? mv.from : null, mv ? mv.to : null);
    b.setCheck(this.chess.inCheck() ? kingSquare(this.chess, this.chess.turn()) : null);
  }

  userMove(m, { instant } = {}) {
    if (this.state !== "solving") return;
    const before = this.chess.fen();
    let mv;
    try { mv = this.chess.move(m); } catch { return; }
    const uci = mv.from + mv.to + (mv.promotion || "");
    const b = this.app.board;
    b.animateMove(mv, { instant });
    announceMove(mv);
    b.setArrows([]);
    if (isCorrectMove(this.p, this.chess, uci, this.idx)) {
      moveSound(mv, this.chess);
      b.setMarks([{ sq: mv.to, color: GOOD }]);
      this._decorate(mv);
      // a different mate than the stored line still ends the puzzle
      if (this.chess.isCheckmate() || this.idx + 1 >= this.p.moves.length) { this.state = "done"; SFX.correct(); this.cb.onSolved(!this.failed, this.hints); return; }
      this.state = "reply";
      const reply = this.p.moves[this.idx + 1];
      this.idx += 2;
      this._t = setTimeout(() => {
        const r = this.chess.move(uciToMove(reply));
        b.animateMove(r);
        announceMove(r);
        moveSound(r, this.chess, { opponent: true });
        b.setMarks([]);
        this._decorate(r);
        this.state = "solving";
        if (this.cb.onProgress) this.cb.onProgress();
      }, 380);
    } else {
      SFX.wrong();
      b.setMarks([{ sq: mv.to, color: BAD }]);
      this.state = "wrong";
      const firstFail = !this.failed;
      this.failed = true;
      this._t = setTimeout(() => {
        this.chess.load(before);
        b.syncFromBoard(this.chess.board());
        b.setMarks([]);
        const prev = this.chess.history().length ? null : null;
        void prev;
        this.state = "solving";
        this.cb.onWrong(firstFail);
      }, 650);
    }
  }

  hint() {
    if (this.state !== "solving") return false;
    const u = this.p.moves[this.idx];
    this.hints++;
    if (this.hints === 1) this.app.board.setMarks([{ sq: u.slice(0, 2), color: HINT }]);
    else this.app.board.setArrows([{ from: u.slice(0, 2), to: u.slice(2, 4), color: "rgba(91,143,214,.85)" }]);
    return true;
  }

  // Plays out the rest of the line; resolves true if it ran to the end (not superseded).
  async solution() {
    if (this.state === "done" || this.state === "showing") return false;
    const p = this.p;
    this.state = "showing";
    this.failed = true;
    clearTimeout(this._t);
    // a wrong move or the opponent's reply may still be pending: rebuild the position at idx
    this.chess = new Chess(p.fen);
    for (let i = 0; i < this.idx; i++) this.chess.move(uciToMove(p.moves[i]));
    const b = this.app.board;
    b.syncFromBoard(this.chess.board());
    b.setMarks([]);
    for (let i = this.idx; i < p.moves.length; i++) {
      const mv = this.chess.move(uciToMove(p.moves[i]));
      b.animateMove(mv);
      announceMove(mv);
      moveSound(mv, this.chess, { opponent: i % 2 === 0 });
      b.setArrows([{ from: mv.from, to: mv.to, color: "rgba(82,179,106,.8)" }]);
      this._decorate(mv);
      await new Promise(r => setTimeout(r, 750));
      // a new puzzle was loaded, or the screen was left, while we waited
      if (this.p !== p || this.state !== "showing") return false;
    }
    this.state = "done";
    return true;
  }

  stop() { clearTimeout(this._t); this.state = "done"; this.input.clear(); }
}

// ---------- rated / themed / daily ----------
export class PuzzleScreen {
  constructor(app, { mode = "rated", theme = null } = {}) {
    this.app = app;
    this.mode = mode;          // "rated" | "daily"
    this.theme = theme;
    this.runner = new PuzzleRunner(app, {
      onSolved: (clean, hints) => this.solved(clean, hints),
      onWrong: (first) => this.wrong(first),
      onProgress: () => this.renderStatus(),
    });
  }

  async mount() {
    this.runner.bind();
    this.app.panel({ title: this.mode === "daily" ? "Daily puzzle" : "Puzzles", body: h("p.note", "Loading puzzles…") });
    try { await loadPuzzles(); } catch { this.app.panel({ title: "Puzzles", body: h("p.note", "Couldn't load the puzzle set. Check your connection and reload.") }); return; }
    if (this.dead) return;
    this.next();
  }
  destroy() { this.dead = true; this.runner.stop(); }
  onBoardSwap() { this.runner.bind(); if (this.runner.chess) this.app.board.syncFromBoard(this.runner.chess.board()); }

  next() {
    const p = getProfile();
    let puzzle;
    if (this.mode === "daily") puzzle = dailyPuzzle(todayStr());
    else puzzle = nextPuzzle({ rating: p.ratings.puzzle.r + DIFFICULTY[difficulty], theme: this.theme, seen: new Set(p.puzzles.seen) });
    if (!puzzle) { toast("No puzzles left for this theme. Showing all themes."); this.theme = null; puzzle = nextPuzzle({ rating: p.ratings.puzzle.r }); }
    this.puzzle = puzzle;
    this.result = null;
    this.delta = null;
    this.ratedOnce = false;
    this.runner.load(puzzle);
    this.renderPanel();
  }

  solved(clean) {
    const p = getProfile();
    if (this.mode === "daily") {
      updateProfile(pr => {
        const today = todayStr();
        if (!pr.daily.solved[today]) {
          const y = new Date(); y.setDate(y.getDate() - 1);
          pr.daily.streak = pr.daily.solved[todayStr(y)] ? pr.daily.streak + 1 : 1;
          pr.daily.solved[today] = true;
        }
      });
      if (getProfile().daily.streak >= 3) unlock("daily-3");
      this.result = "solved";
    } else {
      if (!this.ratedOnce) this.rate(clean);
      this.result = clean ? "solved" : "solved-late";
      if (clean) updateProfile(pr => { pr.puzzles.streak++; pr.puzzles.bestStreak = Math.max(pr.puzzles.bestStreak, pr.puzzles.streak); });
      if (p.puzzles.solved >= 10) unlock("puzzle-10");
      if (p.puzzles.solved >= 100) unlock("puzzle-100");
      if (getProfile().puzzles.streak >= 5) unlock("puzzle-streak-5");
    }
    this.renderPanel();
  }

  wrong(first) {
    if (this.mode === "rated" && first && !this.ratedOnce) {
      this.rate(false);
      updateProfile(pr => { pr.puzzles.streak = 0; });
    }
    this.result = "wrong";
    this.renderPanel();
  }

  rate(won) {
    this.ratedOnce = true;
    updateProfile(pr => {
      const slot = pr.ratings.puzzle;
      const before = slot.r;
      slot.r = puzzleRatingUpdate(slot.r, this.puzzle.rating, won, slot.n);
      slot.n++;
      slot.hist.push([Date.now(), slot.r]);
      if (slot.hist.length > 300) slot.hist.shift();
      this.delta = slot.r - before;
      if (won) pr.puzzles.solved++; else pr.puzzles.failed++;
      pr.puzzles.seen.push(this.puzzle.id);
      if (pr.puzzles.seen.length > 3000) pr.puzzles.seen.splice(0, 500);
    });
  }

  renderStatus() { if (this.statusEl) this._status(); }
  _status() {
    const el = this.statusEl;
    el.innerHTML = "";
    const color = this.puzzle.playerColor;
    const who = color === "w" ? "White" : "Black";
    if (this.result === "solved" || this.result === "solved-late") el.appendChild(h("div.status-line.good", icon("check", 18), h("span", this.result === "solved" ? "Solved!" : "Solved, with help.")));
    else if (this.result === "wrong") el.appendChild(h("div.status-line.bad", icon("close", 18), h("span", "That's not it. Try again.")));
    else el.appendChild(h("div.status-line", h(`span.dot.${color}`), h("span", this.runner.state === "intro" ? "Get ready…" : `${who} to move. Find the best move.`)));
  }

  renderPanel() {
    const p = getProfile();
    const pz = this.puzzle;
    const done = this.result === "solved" || this.result === "solved-late";
    this.statusEl = h("div");
    this._status();
    const ratingRow = this.mode === "rated" ? h("div.card", { style: { display: "flex", alignItems: "center", gap: "12px" } },
      h("div", h("div.note", "Puzzle rating"), h("div.big-num.brass", String(p.ratings.puzzle.r))),
      this.delta !== null ? h(`span.delta.${this.delta >= 0 ? "up" : "down"}`, (this.delta >= 0 ? "+" : "") + this.delta) : null,
      h("div", { style: { marginLeft: "auto", textAlign: "right" } }, h("div.note", "Streak"), h("b", { style: { fontSize: "20px" } }, "🔥 " + p.puzzles.streak))) : h("div.card",
      h("div.note", new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })), h("b", `Daily streak: ${p.daily.streak} day${p.daily.streak === 1 ? "" : "s"}`));
    const themeSel = this.mode === "rated" ? h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, this.themeSelect(), this.difficultySelect()) : null;
    const info = done ? h("div.card",
      h("div.kv", h("span", "Puzzle difficulty"), h("span", String(pz.rating))),
      h("div.kv", h("span", "Themes"), h("span", { style: { textAlign: "right" } }, pz.themes.filter(t => THEME_INFO[t]).slice(0, 4).map(t => THEME_INFO[t].name).join(", ")))) : null;
    const foot = [];
    if (done) {
      foot.push(this.mode === "daily"
        ? h("button.btn.primary.big.block", { onclick: () => this.app.go("#/puzzles") }, "Rated puzzles")
        : h("button.btn.primary.big.block", { onclick: () => this.next() }, "Next puzzle"));
      foot.push(h("button.btn.block", { onclick: () => this.app.go("#/analysis/fen/" + encodeURIComponent(this.runner.chess.fen())) }, icon("analysis", 18), "Analyze position"));
    } else {
      foot.push(h("div.btn-row",
        h("button.btn", { onclick: () => { if (!this.runner.hint()) return; if (this.mode === "rated" && !this.ratedOnce) { this.rate(false); updateProfile(pr => { pr.puzzles.streak = 0; }); this.renderPanel(); } } }, icon("hint", 18), "Hint"),
        h("button.btn", { onclick: async () => { if (this.runner.state === "showing") return; const pz = this.puzzle; if (this.mode === "rated" && !this.ratedOnce) { this.rate(false); updateProfile(pr => { pr.puzzles.streak = 0; }); } this.result = "wrong"; this.renderPanel(); if (!(await this.runner.solution()) || this.dead || this.puzzle !== pz) return; this.result = "solved-late"; this.renderPanel(); } }, icon("eye", 18), "Solution")));
      if (this.result === "wrong" && this.mode === "rated") foot.push(h("button.btn.ghost.block", { onclick: () => this.next() }, "Skip to next puzzle"));
    }
    this.app.panel({
      title: this.mode === "daily" ? "Daily puzzle" : "Puzzles",
      actions: this.mode === "rated" ? h("div", { style: { display: "flex", gap: "6px" } },
        h("button.btn.small", { onclick: () => this.app.go("#/puzzles/rush") }, icon("bolt", 16), "Rush"),
        h("button.btn.small", { onclick: () => this.app.go("#/puzzles/battle") }, icon("users", 16), "Battle"),
        h("button.btn.small", { onclick: () => this.app.go("#/puzzles/solo") }, icon("puzzle", 16), "Solo")) : null,
      body: [ratingRow, this.statusEl, themeSel, info],
      foot,
    });
  }

  difficultySelect() {
    const sel = h("select.input", { "aria-label": "Puzzle difficulty" },
      ...[["easiest", "Easiest"], ["easier", "Easier"], ["normal", "Normal"], ["harder", "Harder"], ["hardest", "Hardest"]].map(([v, l]) => h("option", { value: v, selected: difficulty === v || undefined }, l)));
    sel.addEventListener("change", () => { difficulty = sel.value; this.next(); });
    return h("div.field", h("label", "Difficulty"), sel);
  }

  themeSelect() {
    const sel = h("select.input", { "aria-label": "Puzzle theme" },
      h("option", { value: "" }, "All themes (rated)"),
      ...themesAvailable().map(t => h("option", { value: t.id, selected: this.theme === t.id || undefined }, `${t.name} (${t.count})`)));
    sel.addEventListener("change", () => { this.theme = sel.value || null; this.next(); });
    return h("div.field", h("label", "Theme"), sel);
  }
}

// ---------- Puzzle Rush ----------
const RUSH_MODES = { "3": { label: "3 minutes", ms: 180000, strikes: 3 }, "5": { label: "5 minutes", ms: 300000, strikes: 3 }, survival: { label: "Survival", ms: null, strikes: 3 } };
let rushMode = "3";

export class RushScreen {
  constructor(app) {
    this.app = app;
    this.runner = new PuzzleRunner(app, {
      onSolved: (clean) => this.solved(clean),
      onWrong: () => this.wrong(),
      onProgress: () => {},
    });
    this.state = "menu";
  }
  async mount() {
    this.runner.bind();
    this.menu();
    loadPuzzles().catch(() => toast("Couldn't load puzzles."));
  }
  destroy() { this.dead = true; this.runner.stop(); clearInterval(this.timer); }
  onBoardSwap() { this.runner.bind(); if (this.runner.chess) this.app.board.syncFromBoard(this.runner.chess.board()); }

  menu() {
    this.state = "menu";
    this.app.setLobby(true);
    this.app.setInGame(false);
    this.app.leaveGuard = null;
    const p = getProfile();
    this.app.board.viewSide("w", false);
    this.app.board.syncFromBoard(new Chess().board());
    this.app.strips(null, null);
    this.app.panel({
      title: "Puzzle Rush", back: "#/puzzles",
      body: [
        h("p.note", "Solve as many puzzles as you can. They get harder as you go. Three mistakes and you're out."),
        segmented(Object.entries(RUSH_MODES).map(([k, v]) => ({ value: k, label: v.label })), rushMode, (v) => { rushMode = v; }),
        h("div.stat-grid",
          ...Object.entries(RUSH_MODES).map(([k, v]) => h("div.stat", h("div.lbl", icon(k === "survival" ? "fire" : "bolt", 16), v.label), h("div.val", String(p.rush[k] || 0)), h("div.note", "Best score")))),
      ],
      foot: h("button.btn.primary.big.block", { onclick: () => this.start() }, "Start"),
    });
  }

  async start() {
    await loadPuzzles();
    if (this.dead) return;
    this.run = (this.run || 0) + 1;
    this.state = "playing";
    this.app.setLobby(false);
    this.app.setInGame(true);
    // a stray tap on another tab shouldn't silently end the run
    this.app.leaveGuard = async () => this.state !== "playing" || confirmModal({ title: "End this run?", sub: "Leaving ends your Puzzle Rush.", yes: "End run", danger: true });
    this.score = 0;
    this.strikes = 0;
    this.log = [];
    this.seq = rushSequence(Date.now() % 100000, 120);
    this.i = 0;
    const cfg = RUSH_MODES[rushMode];
    this.endAt = cfg.ms ? performance.now() + cfg.ms : null;
    this.renderPanel();
    this.loadNext();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 100);
  }

  loadNext() {
    if (this.i >= this.seq.length) { this.end(); return; }
    this.runner.load(this.seq[this.i++]);
    this.renderPanel();
  }

  tick() {
    if (this.state !== "playing" || !this.endAt) return;
    const left = this.endAt - performance.now();
    if (this.timerEl) this.timerEl.textContent = fmt(left);
    if (left <= 0) this.end();
  }

  solved(clean) {
    if (this.state !== "playing") return;
    if (clean) this.score++;
    this.log.push({ ok: clean, r: this.runner.p.rating });
    this._later(350);
  }
  wrong() {
    if (this.state !== "playing") return;
    this.strikes++;
    this.log.push({ ok: false, r: this.runner.p.rating });
    if (this.strikes >= RUSH_MODES[rushMode].strikes) { this.end(); return; }
    // a missed puzzle is skipped in Rush
    this._later(250);
  }
  // next puzzle after a beat, unless the run ended (time, End run, Play again) or we left
  _later(ms) {
    const run = this.run;
    setTimeout(() => { if (!this.dead && this.state === "playing" && this.run === run) this.loadNext(); }, ms);
  }

  end() {
    if (this.state !== "playing") return;
    this.state = "over";
    clearInterval(this.timer);
    this.runner.stop();
    let best = false;
    updateProfile(p => { if (this.score > (p.rush[rushMode] || 0)) { p.rush[rushMode] = this.score; best = true; } });
    if (this.score >= 15) unlock("rush-15");
    if (this.score >= 30) unlock("rush-30");
    SFX.end();
    const m = openModal({
      title: `${this.score} solved`, sub: best ? "New personal best!" : `Best: ${getProfile().rush[rushMode]}`,
      body: [h("div.rush-log", ...this.log.map(l => h(`span.${l.ok ? "ok" : "no"}`, String(l.r)))),
        h("div.btn-row", h("button.btn", { onclick: () => { m.close(); this.menu(); } }, "Menu"), h("button.btn.primary", { onclick: () => { m.close(); this.start(); } }, "Play again"))],
    });
    this.renderPanel();
  }

  renderPanel() {
    const cfg = RUSH_MODES[rushMode];
    this.timerEl = h("div.timer-big", cfg.ms ? fmt(this.endAt ? this.endAt - performance.now() : cfg.ms) : "∞");
    const strikes = h("div.rush-strikes", ...Array.from({ length: cfg.strikes }, (_, k) => h(`span${k < this.strikes ? ".hit" : ""}`, "✕")));
    const pz = this.runner.p;
    this.app.panel({
      title: "Puzzle Rush", back: () => { if (this.state === "playing") this.end(); else this.menu(); },
      body: [
        h("div.card", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } }, this.timerEl, h("div", { style: { textAlign: "right" } }, h("div.note", "Score"), h("div.big-num", String(this.score)))),
        strikes,
        pz && this.state === "playing" ? h("div.status-line", h(`span.dot.${pz.playerColor}`), h("span", `${pz.playerColor === "w" ? "White" : "Black"} to move`)) : null,
        h("div.rush-log", ...this.log.map(l => h(`span.${l.ok ? "ok" : "no"}`, String(l.r)))),
      ],
      foot: this.state === "playing" ? h("button.btn.ghost.block", { onclick: () => this.end() }, "End run") : h("button.btn.primary.big.block", { onclick: () => this.start() }, "Play again"),
    });
  }
}

function fmt(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
