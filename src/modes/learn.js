// Learn: interactive lessons, endgame drills vs Stockfish, opening trainer, and the Learn page.
import { Chess } from "chess.js";
import { MoveInput } from "../core/input.js";
import { kingSquare } from "../core/tree.js";
import { h, icon } from "../ui/dom.js";
import { toast, openModal } from "../ui/components.js";
import { LESSONS, ENDGAME_DRILLS } from "../learn-data.js";
import { POPULAR_OPENINGS } from "../openings.js";
import { getProfile, updateProfile, unlock } from "../store.js";
import { playEngine } from "../core/engines.js";
import { moveSound, SFX } from "../audio.js";
import { THEME_INFO, loadPuzzles, themesAvailable } from "../puzzles.js";
import { VIDEO_LESSONS } from "../video-lessons.js";

const GOOD = "rgba(82,179,106,.6)", BAD = "rgba(224,55,42,.55)";

// ---------- Learn page ----------
export class LearnPage {
  constructor(app) { this.app = app; }
  mount() {
    const p = getProfile();
    const lessonCats = [...new Set(LESSONS.map(l => l.category))];
    const page = h("div.page",
      h("div.page-head", h("h1", "Learn"), h("p", "Short interactive lessons, endgame drills against Stockfish, an opening trainer and video lessons. Progress saves on this device.")));
    const chips = h("div.seg.learn-chips");
    page.append(chips);
    const addChip = (label, id) => chips.appendChild(h("button", { onclick: () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, label));
    for (const cat of lessonCats) {
      const secId = "learn-" + cat.toLowerCase();
      const done = LESSONS.filter(l => l.category === cat && p.lessons[l.id]).length, total = LESSONS.filter(l => l.category === cat).length;
      addChip(`${cat} ${done}/${total}`, secId);
      page.append(h("section", { id: secId }, h("h2", cat === "Basics" ? "Lessons: the basics" : `Lessons: ${cat.toLowerCase()}`),
        h("div.grid-cards", ...LESSONS.filter(l => l.category === cat).map(l => h("button.tile", { onclick: () => this.app.go(`#/lesson/${l.id}`) },
          h("b", l.title), h("small", `${l.steps.length} steps`), p.lessons[l.id] ? h("span.done", "✓ Completed") : null)))));
    }
    addChip("Vision", "learn-vision");
    page.append(h("section", { id: "learn-vision" }, h("h2", "Vision"),
      h("div.grid-cards", h("button.tile", { onclick: () => this.app.go("#/vision") },
        h("span.ti", icon("eye", 22)), h("b", "Board vision trainer"), h("small", "Tap the named square, as many as you can in 30 seconds"),
        p.vision ? h("span.done", `Best: ${Math.max(p.vision.w || 0, p.vision.b || 0)}`) : null))));
    addChip("Endgame drills", "learn-drills");
    page.append(h("section", { id: "learn-drills" }, h("h2", "Endgame drills"),
      h("p.note", { style: { marginBottom: "10px" } }, "Convert or hold these positions against Stockfish."),
      h("div.grid-cards", ...ENDGAME_DRILLS.map(d => h("button.tile", { onclick: () => this.app.go(`#/drill/${d.id}`) },
        h("b", d.title), h("small", d.blurb), h("small", `${d.goal === "win" ? "Win" : "Draw"} as ${d.side === "w" ? "White" : "Black"} · ${"★".repeat(d.difficulty)}`),
        p.drills[d.id] ? h("span.done", "✓ Completed") : null)))));
    addChip("Openings", "learn-openings");
    page.append(h("section", { id: "learn-openings" }, h("h2", "Opening trainer"),
      h("p.note", { style: { marginBottom: "10px" } }, "Learn the main line of popular openings move by move."),
      h("div.grid-cards", ...POPULAR_OPENINGS.map(o => h("button.tile", { onclick: () => this.app.go(`#/opening/${o.id}`) },
        h("b", o.name), h("small", o.blurb), h("small", `${o.eco} · as ${o.side === "w" ? "White" : "Black"}`),
        p.openings[o.id] ? h("span.done", `✓ Practiced ${p.openings[o.id]}×`) : null)))));
    // video lessons: series you've opened are remembered on this device
    let opened = {};
    try { opened = JSON.parse(localStorage.getItem("c3d-video-lessons") || "{}"); } catch { /* storage blocked */ }
    addChip("Video lessons", "learn-videos");
    page.append(h("section", { id: "learn-videos" }, h("h2", "Video lessons"),
      h("p.note", { style: { marginBottom: "10px" } }, "Whole video series from chess teachers. Each one plays here, episode after episode."),
      ...VIDEO_LESSONS.map((group) => h("div.video-topic", h("h3", group.topic),
        h("div.grid-cards", ...group.items.map((v) => h("button.tile.video-lesson", {
          onclick: (e) => {
            opened[v.id] = Date.now();
            try { localStorage.setItem("c3d-video-lessons", JSON.stringify(opened)); } catch { /* storage blocked */ }
            const tile = e.currentTarget;
            if (!tile.querySelector(".done")) tile.appendChild(h("span.done", "✓ Started"));
            openModal({
              title: v.title, sub: `${v.by}, ${v.count} videos`, wide: true,
              body: h("div.video-frame", h("iframe", {
                src: `https://www.youtube-nocookie.com/embed/videoseries?list=${v.id}&rel=0`, title: v.title,
                allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin",
              })),
            });
          },
        }, h("span.ti", icon("watch", 22)), h("b", v.title), h("small", `${v.by}, ${v.count} videos`), opened[v.id] ? h("span.done", "✓ Started") : null)))))));
    const themes = h("div.grid-cards");
    addChip("Tactics by theme", "learn-themes");
    page.append(h("section", { id: "learn-themes" }, h("h2", "Tactics by theme"), themes));
    loadPuzzles().then(() => {
      for (const t of themesAvailable().slice(0, 24)) {
        themes.appendChild(h("button.tile", { onclick: () => this.app.go(`#/puzzles/theme/${t.id}`) }, h("b", t.name), h("small", t.desc), h("small", `${t.count} puzzles`)));
      }
    }).catch(() => {});
    this.app.pageMode(page);
  }
  destroy() {}
}

// ---------- lesson ----------
export class LessonScreen {
  constructor(app, id) {
    this.app = app;
    this.lesson = LESSONS.find(l => l.id === id);
    this.step = 0;
    this.input = new MoveInput(app, {
      getChess: () => (this.waiting ? this.chess : null),
      canMove: (c) => this.waiting && c === this.chess.turn(),
      onMove: (m, o) => this.move(m, o),
    });
  }
  mount() {
    if (!this.lesson) { this.app.go("#/learn"); return; }
    this.input.bind();
    this.load();
  }
  destroy() { clearTimeout(this._t); this.input.clear(); }
  onBoardSwap() { this.input.bind(); this.app.board.syncFromBoard(this.chess.board()); }

  load() {
    clearTimeout(this._t);   // a pending "try again" reset belongs to the previous step
    this.input.clear();
    const s = this.lesson.steps[this.step];
    this.chess = new Chess(s.fen);
    const b = this.app.board;
    b.viewSide(this.chess.turn(), false);
    b.syncFromBoard(this.chess.board());
    b.setMarks([]); b.setArrows([]); b.setLastMove(null, null);
    b.setCheck(this.chess.inCheck() ? kingSquare(this.chess, this.chess.turn()) : null);
    if (s.goal && s.goal.type === "capture") b.setMarks([{ sq: s.goal.square, color: "rgba(232,193,60,.45)" }]);
    this.waiting = s.goal && s.goal.type !== "info";
    this.done = !this.waiting;
    this.feedback = null;
    this.render();
  }

  move(m, { instant } = {}) {
    const s = this.lesson.steps[this.step];
    const fen = this.chess.fen();
    let mv;
    try { mv = this.chess.move(m); } catch { return; }
    this.app.board.animateMove(mv, { instant });
    moveSound(mv, this.chess);
    const uci = mv.from + mv.to + (mv.promotion || "");
    const g = s.goal;
    const ok = (g.type === "move" && g.moves.includes(uci)) || (g.type === "mate" && this.chess.isCheckmate()) || (g.type === "capture" && mv.to === g.square && mv.captured);
    if (ok) {
      SFX.correct();
      this.app.board.setMarks([{ sq: mv.to, color: GOOD }]);
      this.waiting = false; this.done = true;
      this.feedback = { ok: true, text: "Correct!" };
    } else {
      SFX.wrong();
      this.app.board.setMarks([{ sq: mv.to, color: BAD }]);
      this.feedback = { ok: false, text: "Not quite. Try again." };
      this._t = setTimeout(() => { this.chess.load(fen); this.app.board.syncFromBoard(this.chess.board()); this.app.board.setMarks(g.type === "capture" ? [{ sq: g.square, color: "rgba(232,193,60,.45)" }] : []); }, 650);
    }
    this.render();
  }

  render() {
    const L = this.lesson, s = L.steps[this.step];
    const last = this.step === L.steps.length - 1;
    const dots = h("div", { style: { display: "flex", gap: "4px" } }, ...L.steps.map((_, k) => h("span", { style: { flex: "1", height: "5px", borderRadius: "3px", background: k <= this.step ? "var(--accent)" : "var(--panel-3)" } })));
    this.app.panel({
      title: L.title, back: "#/learn",
      body: [dots, h("div.card", h("p", { style: { fontSize: "15.5px" } }, s.text)),
        this.feedback ? h(`div.status-line.${this.feedback.ok ? "good" : "bad"}`, icon(this.feedback.ok ? "check" : "close", 18), h("span", this.feedback.text)) : null,
        this.waiting ? h("div.note", goalText(s.goal, this.chess)) : null],
      foot: h("div.btn-row",
        this.step > 0 ? h("button.btn", { onclick: () => { this.step--; this.load(); } }, "Back") : null,
        h("button.btn.primary", { disabled: !this.done || undefined, onclick: () => this.next() }, last ? "Finish" : "Next")),
    });
  }

  next() {
    if (this.step < this.lesson.steps.length - 1) { this.step++; this.load(); return; }
    updateProfile(p => { p.lessons[this.lesson.id] = true; });
    if (LESSONS.every(l => getProfile().lessons[l.id])) unlock("lesson-all");
    toast("Lesson complete");
    const idx = LESSONS.indexOf(this.lesson);
    const nxt = LESSONS[idx + 1];
    this.app.go(nxt ? `#/lesson/${nxt.id}` : "#/learn");
  }
}

function goalText(g, chess) {
  const who = chess.turn() === "w" ? "White" : "Black";
  if (g.type === "mate") return `Your turn (${who}): deliver checkmate.`;
  if (g.type === "capture") return `Your turn (${who}): capture on ${g.square}.`;
  return `Your turn (${who}): make the move.`;
}

// ---------- endgame drill ----------
export class DrillScreen {
  constructor(app, id) {
    this.app = app;
    this.drill = ENDGAME_DRILLS.find(d => d.id === id);
    this.input = new MoveInput(app, {
      getChess: () => (this.state === "play" ? this.chess : null),
      canMove: (c) => this.state === "play" && c === this.drill.side,
      premoveColor: () => (this.state === "engine" ? this.drill.side : null),
      onMove: (m, o) => this.userMove(m, o),
    });
  }
  mount() {
    if (!this.drill) { this.app.go("#/learn"); return; }
    this.input.bind();
    this.restart();
    playEngine().init().catch(() => toast("The engine couldn't load."));
  }
  destroy() { this.dead = true; this.input.clear(); }
  onBoardSwap() { this.input.bind(); this.app.board.syncFromBoard(this.chess.board()); }

  restart() {
    this.chess = new Chess(this.drill.fen);
    this.gen = (this.gen || 0) + 1;
    this.input.clear();
    this.input.cancelPremove();   // else a premove from the last attempt fires in this one
    this.app.board.viewSide(this.drill.side, false);
    this.app.board.syncFromBoard(this.chess.board());
    this.app.board.setLastMove(null, null); this.app.board.setMarks([]); this.app.board.setArrows([]);
    this.outcome = null;
    this.state = this.chess.turn() === this.drill.side ? "play" : "engine";
    this.render();
    if (this.state === "engine") this.engineMove();
  }

  userMove(m, { instant } = {}) {
    const mv = this.chess.move(m);
    this.after(mv, instant);
    if (!this.outcome) { this.state = "engine"; this.render(); this.engineMove(); }
  }

  async engineMove() {
    const gen = this.gen;
    const fen = this.chess.fen();
    let u;
    try {
      const r = await playEngine().analyze(fen, { movetime: 500 });
      u = r.bestmove;
    } catch { const l = this.chess.moves({ verbose: true }); u = l[0].from + l[0].to; }
    if (this.dead || gen !== this.gen) return;
    await new Promise(r => setTimeout(r, 250));
    if (this.dead || gen !== this.gen) return;   // Restart or leaving during the pause
    const mv = this.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    this.after(mv, false, true);
    if (!this.outcome) { this.state = "play"; this.render(); this.input.tryPremove(); }
  }

  after(mv, instant, opp = false) {
    const b = this.app.board;
    b.animateMove(mv, { instant });
    moveSound(mv, this.chess, { opponent: opp });
    b.setLastMove(mv.from, mv.to);
    b.setCheck(this.chess.inCheck() ? kingSquare(this.chess, this.chess.turn()) : null);
    const c = this.chess;
    const d = this.drill;
    const plies = c.history().length;
    if (c.isCheckmate()) this.outcome = c.turn() !== d.side ? (d.goal === "win" ? "success" : "success") : "fail";
    else if (c.isDraw() || c.isStalemate() || c.isThreefoldRepetition() || c.isInsufficientMaterial()) this.outcome = d.goal === "draw" ? "success" : "fail";
    else if (d.goal === "draw" && plies >= 60) this.outcome = "success";
    if (this.outcome) {
      this.state = "over";
      if (this.outcome === "success") {
        SFX.correct();
        updateProfile(p => { p.drills[d.id] = true; });
        if (Object.keys(getProfile().drills).length >= 5) unlock("drill-5");
      } else SFX.wrong();
      this.render();
    }
  }

  render() {
    const d = this.drill;
    const status = this.outcome === "success" ? h("div.status-line.good", icon("check", 18), h("span", d.goal === "win" ? "Checkmate. Drill complete!" : "You held the draw. Drill complete!"))
      : this.outcome === "fail" ? h("div.status-line.bad", icon("close", 18), h("span", d.goal === "win" ? "The win slipped away. Try again." : "Stockfish broke through. Try again."))
      : h("div.status-line", h(`span.dot.${this.chess.turn()}`), h("span", this.state === "engine" ? "Stockfish is thinking…" : "Your move"));
    this.app.panel({
      title: d.title, back: "#/learn",
      body: [h("div.card", h("p", d.blurb), h("p.note", { style: { marginTop: "6px" } }, `Goal: ${d.goal === "win" ? "checkmate" : "draw (or survive 30 moves)"} as ${d.side === "w" ? "White" : "Black"}.`)), status],
      foot: h("button.btn.block", { onclick: () => this.restart() }, icon("undo", 18), "Restart"),
    });
  }
}

// ---------- opening trainer ----------
export class OpeningTrainer {
  constructor(app, id) {
    this.app = app;
    this.op = POPULAR_OPENINGS.find(o => o.id === id);
    this.input = new MoveInput(app, {
      getChess: () => (this.state === "play" ? this.chess : null),
      canMove: (c) => this.state === "play" && c === this.op.side,
      onMove: (m, o) => this.userMove(m, o),
    });
  }
  mount() {
    if (!this.op) { this.app.go("#/learn"); return; }
    this.line = this.op.moves.split(/\s+/).filter(Boolean);
    this.input.bind();
    this.demo();
  }

  // play the whole line once with arrows, then hand over for practice
  demo() {
    clearTimeout(this._t);
    this.input.clear();
    this.chess = new Chess();
    this.i = 0;
    this.state = "demo";
    this.msg = { ok: true, text: "Watch the main line first. Your turn comes next." };
    const b = this.app.board;
    b.viewSide(this.op.side, false);
    b.syncFromBoard(this.chess.board());
    b.setMarks([]); b.setArrows([]); b.setLastMove(null, null);
    this.render();
    const step = () => {
      if (this.dead || this.state !== "demo") return;
      if (this.i >= this.line.length) {
        this._t = setTimeout(() => { if (!this.dead && this.state === "demo") { this.restart(); this.msg = { ok: true, text: "Now you play it. Your opponent answers with the main line." }; this.render(); } }, 1200);
        return;
      }
      const mv = this.chess.move(this.line[this.i++]);
      b.animateMove(mv);
      b.setLastMove(mv.from, mv.to);
      b.setArrows([{ from: mv.from, to: mv.to, color: "rgba(91,143,214,.8)" }]);
      moveSound(mv, this.chess, { opponent: mv.color !== this.op.side });
      this.render();
      this._t = setTimeout(step, 1100);
    };
    this._t = setTimeout(step, 700);
  }
  destroy() { this.dead = true; clearTimeout(this._t); this.input.clear(); }
  onBoardSwap() { this.input.bind(); this.app.board.syncFromBoard(this.chess.board()); }

  restart() {
    clearTimeout(this._t);   // a scheduled reply from the previous run
    this.input.clear();
    this.chess = new Chess();
    this.i = 0;
    this.mistakes = 0;
    this.app.board.viewSide(this.op.side, false);
    this.app.board.syncFromBoard(this.chess.board());
    this.app.board.setMarks([]); this.app.board.setArrows([]); this.app.board.setLastMove(null, null);
    this.state = "play";
    this.msg = null;
    this.advance();
  }

  advance() {
    if (this.i >= this.line.length) { this.complete(); return; }
    if (this.chess.turn() !== this.op.side) {
      this.state = "reply";
      this.render();
      this._t = setTimeout(() => {
        if (this.dead) return;
        const mv = this.chess.move(this.line[this.i++]);
        this.app.board.animateMove(mv);
        moveSound(mv, this.chess, { opponent: true });
        this.app.board.setLastMove(mv.from, mv.to);
        this.state = "play";
        this.advance();
      }, 450);
      return;
    }
    this.state = "play";
    this.render();
  }

  userMove(m, { instant } = {}) {
    const expected = this.line[this.i];
    const test = new Chess(this.chess.fen());
    const mv = test.move(m);
    if (mv.san.replace(/[+#]/g, "") === expected.replace(/[+#]/g, "")) {
      this.chess.move(m);
      this.app.board.animateMove(mv, { instant });
      moveSound(mv, this.chess);
      this.app.board.setLastMove(mv.from, mv.to);
      this.app.board.setArrows([]);
      this.app.board.setMarks([{ sq: mv.to, color: GOOD }]);
      this.i++;
      this.msg = { ok: true, text: `${mv.san} is the main line.` };
      this.advance();
    } else {
      this.mistakes++;
      SFX.wrong();
      const exp = new Chess(this.chess.fen()).move(expected);
      this.msg = { ok: false, text: `${mv.san} isn't the main line here. Look at the arrow.` };
      this.app.board.setArrows([{ from: exp.from, to: exp.to, color: "rgba(82,179,106,.85)" }]);
      this.render();
    }
  }

  complete() {
    this.state = "done";
    SFX.correct();
    updateProfile(p => { p.openings[this.op.id] = (p.openings[this.op.id] || 0) + 1; });
    this.msg = { ok: true, text: this.mistakes ? `Line complete with ${this.mistakes} slip${this.mistakes > 1 ? "s" : ""}. Run it again to make it stick.` : "Perfect! You know this line." };
    this.render();
  }

  render() {
    const o = this.op;
    const played = this.chess.history();
    let txt = "";
    played.forEach((s, k) => { if (k % 2 === 0) txt += `${k / 2 + 1}. `; txt += s + " "; });
    this.app.panel({
      title: o.name, back: "#/learn",
      body: [h("div.card", h("p", o.blurb), h("p.note", { style: { marginTop: "6px" } }, `${o.eco} · You play ${o.side === "w" ? "White" : "Black"}`)),
        h("div", { style: { height: "6px", borderRadius: "3px", background: "var(--panel-3)", overflow: "hidden" } }, h("div", { style: { height: "100%", width: `${Math.round(this.i / this.line.length * 100)}%`, background: "var(--accent)" } })),
        this.msg ? h(`div.status-line.${this.msg.ok ? "good" : "bad"}`, icon(this.msg.ok ? "check" : "close", 18), h("span", this.msg.text)) : h("div.status-line", h(`span.dot.${o.side}`), h("span", "Play the main line move.")),
        h("div.card", h("div.note", "Moves"), h("p", { style: { fontWeight: "600" } }, txt || "–"))],
      foot: h("div.btn-row",
        h("button.btn", { onclick: () => this.restart() }, icon("undo", 18), "Restart"),
        h("button.btn", { onclick: () => this.demo() }, icon("eye", 18), "Show me"),
        h("button.btn", { onclick: () => { const u = this.line[this.i]; if (!u || this.state !== "play") return; const mv = new Chess(this.chess.fen()).move(u); this.app.board.setArrows([{ from: mv.from, to: mv.to, color: "rgba(91,143,214,.85)" }]); } }, icon("hint", 18), "Hint")),
    });
  }
}
void openModal; void THEME_INFO;
