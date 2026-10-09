// Two quick trainers on the main board, as on chess.com:
// - Vision: a square is named, tap it; as many as you can in 30 seconds, from White's or Black's side.
// - Solo Chess: every move must capture, and the last piece standing wins. A piece may capture at
//   most twice, and the king (when there is one) can't be taken. Puzzles are built backwards from
//   a single survivor, so every one has a solution.
import { h, icon } from "../ui/dom.js";
import { segmented } from "../ui/components.js";
import { getProfile, updateProfile, unlock } from "../store.js";
import { SFX } from "../audio.js";

const FILES = "abcdefgh";
const ALL = [];
for (const f of FILES) for (let r = 1; r <= 8; r++) ALL.push(f + r);
const GOOD = "rgba(82,179,106,.6)", BAD = "rgba(224,55,42,.55)";

// ---------- Vision ----------
let visionSide = "w";

export class VisionTrainer {
  constructor(app) { this.app = app; this.state = "menu"; }
  mount() {
    this.app.setInGame(false);
    this.app.bindBoard({ onSquareTap: (sq) => this.tap(sq), canDrag: () => false });
    this.app.board.syncFromBoard(null);
    this.app.board.viewSide(visionSide, false);
    this.render();
  }
  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    this.app.board.setMarks([]);
    this.app._applyBoardSettings();    // coordinates back on
  }
  start() {
    this.state = "playing";
    this.score = 0;
    this.misses = 0;
    this.ends = performance.now() + 30000;
    // no coordinates while you play: that's the point
    this.app.board.applySettings({ coords: false });
    this.app.board.viewSide(visionSide, false);
    this.pick();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 100);
    this.render();
  }
  pick() {
    let t;
    do t = ALL[Math.floor(Math.random() * 64)]; while (t === this.target);
    this.target = t;
  }
  tick() {
    const left = Math.max(0, this.ends - performance.now());
    if (this.clockEl) this.clockEl.textContent = (left / 1000).toFixed(1);
    if (left <= 0) this.finish();
  }
  tap(sq) {
    if (this.state !== "playing") return;
    const right = sq === this.target;
    this.app.board.setMarks([{ sq, color: right ? GOOD : BAD }]);
    setTimeout(() => !this.dead && this.app.board.setMarks([]), 220);
    if (right) { this.score++; SFX.move(); this.pick(); } else { this.misses++; SFX.illegal(); }
    this.render();
  }
  finish() {
    clearInterval(this.timer);
    this.state = "done";
    this.app._applyBoardSettings();
    const p = getProfile();
    const best = (p.vision && p.vision[visionSide]) || 0;
    this.newBest = this.score > best;
    if (this.newBest) updateProfile((pr) => { pr.vision = { ...(pr.vision || {}), [visionSide]: this.score }; });
    if (this.score >= 20) unlock("vision-20");
    SFX.end();
    this.render();
  }
  render() {
    if (this.dead) return;
    const p = getProfile();
    const best = (side) => (p.vision && p.vision[side]) || 0;
    const body = [];
    if (this.state === "playing") {
      this.clockEl = h("div.timer-big", "30.0");
      body.push(h("div.vision-target", { "aria-live": "polite" }, this.target), h("p.note", "Tap that square."),
        h("div.card.arena-head", h("div", h("div.note", "Time left"), this.clockEl), h("div", { style: { textAlign: "right" } }, h("div.note", "Found"), h("div.big-num", String(this.score)))));
    } else {
      body.push(h("p", { style: { color: "var(--ink-2)" } }, "Learn the board by heart: a square is named, and you tap it. Find as many as you can in 30 seconds. Coordinates are hidden while you play."));
      body.push(h("div.field", h("div.lbl", "Play from"), segmented([{ value: "w", label: "White's side" }, { value: "b", label: "Black's side" }], visionSide, (v) => { visionSide = v; this.app.board.viewSide(v); this.render(); })));
      if (this.state === "done") body.push(h(`div.status-line${this.newBest ? ".good" : ""}`, icon("trophy", 18), h("span", `${this.score} found${this.misses ? `, ${this.misses} missed` : ""}. ${this.newBest ? "A new best!" : `Your best: ${best(visionSide)}.`}`)));
      body.push(h("p.note", `Best from White's side: ${best("w")}. From Black's side: ${best("b")}.`));
    }
    this.app.strips(null, null);
    this.app.panel({
      title: "Vision", back: "#/learn", body,
      foot: this.state === "playing" ? null : h("button.btn.primary.big.block", { onclick: () => this.start() }, this.state === "done" ? "Play again" : "Start"),
    });
  }
}

// ---------- Solo Chess ----------
const SOLO_LEVELS = [{ value: "easy", label: "Easy", n: 5 }, { value: "medium", label: "Medium", n: 7 }, { value: "hard", label: "Hard", n: 9 }];
let soloLevel = "easy";
const STEPS = {
  n: [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
STEPS.q = [...STEPS.b, ...STEPS.r];
STEPS.k = STEPS.q;
const slides = (t) => t === "b" || t === "r" || t === "q";
const at = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? FILES[f] + (r + 1) : null);
const fr = (sq) => [FILES.indexOf(sq[0]), Number(sq[1]) - 1];

// squares a piece of type t on sq attacks on this board (pawns capture up the board)
function attacks(t, sq, occupied) {
  const [f, r] = fr(sq);
  if (t === "p") return [at(f - 1, r + 1), at(f + 1, r + 1)].filter(Boolean);
  const out = [];
  for (const [df, dr] of STEPS[t]) {
    for (let k = 1; k < 8; k++) {
      const s = at(f + df * k, r + dr * k);
      if (!s) break;
      out.push(s);
      if (occupied.has(s) || !slides(t)) break;
    }
  }
  return out;
}

// build a puzzle backwards: start from one survivor, and n-1 times "un-capture": a piece steps back
// off its square (to a square it could have captured from) and leaves the piece it took behind
function makeSolo(n) {
  for (let tries = 0; tries < 400; tries++) {
    const pieces = new Map();   // sq -> { t, caps }
    const withKing = n >= 6 && Math.random() < 0.5;
    const start = ALL[8 + Math.floor(Math.random() * 48)];
    pieces.set(start, { t: withKing ? "k" : "qrbn"[Math.floor(Math.random() * 4)], caps: 0 });
    let ok = true;
    for (let i = 1; i < n && ok; i++) {
      ok = false;
      const movers = [...pieces.entries()].filter(([, p]) => p.caps < 2).sort(() => Math.random() - 0.5);
      for (const [to, p] of movers) {
        const occupied = new Set(pieces.keys());
        // squares it could have come from: the squares it attacks from `to` going backwards
        // (for sliders and knights that's the same set; pawns came from one rank lower)
        let froms;
        if (p.t === "p") { const [f, r] = fr(to); froms = [at(f - 1, r - 1), at(f + 1, r - 1)].filter(Boolean); }
        else froms = attacks(p.t, to, occupied);
        froms = froms.filter((s) => !occupied.has(s) && (p.t !== "p" || (s[1] !== "1" && s[1] !== "8")));
        if (!froms.length) continue;
        const from = froms[Math.floor(Math.random() * froms.length)];
        // the piece that was captured on `to` (never a king; pawns never on the back ranks)
        const types = ["p", "n", "b", "r", "q"].filter((t) => t !== "p" || (to[1] !== "1" && to[1] !== "8"));
        const victim = types[Math.floor(Math.random() * types.length)];
        pieces.delete(to);
        pieces.set(from, { t: p.t, caps: p.caps + 1 });
        pieces.set(to, { t: victim, caps: 0 });
        ok = true;
        break;
      }
    }
    if (ok && pieces.size === n) return [...pieces.entries()].map(([sq, p]) => ({ sq, t: p.t, caps: 0 }));
  }
  return null;
}

export class SoloChess {
  constructor(app) { this.app = app; this.newPuzzle(); }
  newPuzzle() {
    const lv = SOLO_LEVELS.find((l) => l.value === soloLevel);
    this.start = makeSolo(lv.n) || makeSolo(4);
    this.reset();
  }
  reset() {
    this.pieces = new Map(this.start.map((p) => [p.sq, { t: p.t, caps: 0 }]));
    this.sel = null;
    this.state = "playing";
    this.history = [];
  }
  mount() {
    this.app.setInGame(false);
    this.app.bindBoard({
      onSquareTap: (sq) => this.tap(sq),
      canDrag: (sq) => this.state === "playing" && this.pieces.has(sq) && this.pieces.get(sq).caps < 2,
      onDragStart: (sq) => this.select(sq),
      onDrop: (from, to) => { this.sel = from; this.tap(to); },
    });
    this.app.board.viewSide("w", false);
    this.redraw();
    this.render();
  }
  destroy() { this.dead = true; this.app.board.setMarks([]); this.app.board.clearHints(); }
  board2d() {
    const rows = [];
    for (let r = 7; r >= 0; r--) rows.push(FILES.split("").map((f) => { const p = this.pieces.get(f + (r + 1)); return p ? { type: p.t, color: "w" } : null; }));
    return rows;
  }
  legalFrom(sq) {
    const p = this.pieces.get(sq);
    if (!p || p.caps >= 2) return [];
    const occupied = new Set(this.pieces.keys());
    return attacks(p.t, sq, occupied).filter((s) => this.pieces.has(s) && this.pieces.get(s).t !== "k");
  }
  select(sq) {
    if (this.state !== "playing") return;
    const targets = this.legalFrom(sq);
    this.sel = this.pieces.has(sq) ? sq : null;
    this.app.board.setSelected(this.sel);
    this.app.board.showMoves([], targets);
  }
  tap(sq) {
    if (this.state !== "playing") return;
    if (this.sel && this.legalFrom(this.sel).includes(sq)) {
      const p = this.pieces.get(this.sel);
      this.history.push(new Map([...this.pieces].map(([k, v]) => [k, { ...v }])));
      this.pieces.delete(this.sel);
      this.pieces.set(sq, { t: p.t, caps: p.caps + 1 });
      this.sel = null;
      SFX.capture();
      this.check();
      this.redraw();
      this.render();
      return;
    }
    if (this.pieces.has(sq)) this.select(sq);
    else { this.sel = null; this.app.board.clearHints(); }
  }
  check() {
    if (this.pieces.size === 1) {
      this.state = "won";
      SFX.end();
      updateProfile((pr) => { pr.solo = { ...(pr.solo || {}), [soloLevel]: ((pr.solo || {})[soloLevel] || 0) + 1 }; });
      unlock("solo-chess");
      return;
    }
    if (![...this.pieces.keys()].some((sq) => this.legalFrom(sq).length)) { this.state = "stuck"; SFX.illegal(); }
  }
  undo() {
    if (!this.history.length) return;
    this.pieces = this.history.pop();
    this.state = "playing";
    this.redraw();
    this.render();
  }
  redraw() {
    const b = this.app.board;
    b.syncFromBoard(this.board2d());
    b.clearHints();
    // a piece with one capture left is tinted; one with none left is greyed
    b.setMarks([...this.pieces].filter(([, p]) => p.caps > 0).map(([sq, p]) => ({ sq, color: p.caps >= 2 ? "rgba(90,90,90,.55)" : "rgba(217,180,90,.45)" })));
  }
  render() {
    if (this.dead) return;
    const solved = (getProfile().solo || {})[soloLevel] || 0;
    const body = [
      h("p", { style: { color: "var(--ink-2)" } }, "Every move must capture. Clear the board down to one piece. A piece can capture at most twice (tinted: one capture left; grey: none), and the king can't be taken."),
      h("div.field", h("div.lbl", "Level"), segmented(SOLO_LEVELS.map((l) => ({ value: l.value, label: l.label })), soloLevel, (v) => { soloLevel = v; this.newPuzzle(); this.redraw(); this.render(); })),
    ];
    if (this.state === "won") body.push(h("div.status-line.good", icon("check", 18), h("span", "Solved: one piece left.")));
    else if (this.state === "stuck") body.push(h("div.status-line.bad", icon("close", 18), h("span", "No captures left. Take a move back, or start over.")));
    else body.push(h("div.status-line", h("span", `${this.pieces.size} pieces left`)));
    body.push(h("p.note", `Solved at this level: ${solved}.`));
    const foot = [h("div.btn-row",
      h("button.btn", { onclick: () => this.undo(), disabled: !this.history.length }, icon("undo", 18), "Take back"),
      h("button.btn", { onclick: () => { this.reset(); this.redraw(); this.render(); } }, "Start over")),
    h("button.btn.primary.block", { onclick: () => { this.newPuzzle(); this.redraw(); this.render(); } }, this.state === "won" ? "Next puzzle" : "New puzzle")];
    this.app.strips(null, null);
    this.app.panel({ title: "Solo Chess", back: "#/puzzles", body, foot });
  }
}

// for tests: the generator and a solver that checks a puzzle can be cleared
export function _soloForTest(n) { return makeSolo(n); }
export function _soloSolvable(pieces) {
  const key = (m) => [...m].sort().map(([s, p]) => s + p.t + p.caps).join();
  const seen = new Set();
  const solve = (m) => {
    if (m.size === 1) return true;
    const k = key(m);
    if (seen.has(k)) return false;
    seen.add(k);
    const occupied = new Set(m.keys());
    for (const [sq, p] of m) {
      if (p.caps >= 2) continue;
      for (const to of attacks(p.t, sq, occupied)) {
        if (!m.has(to) || m.get(to).t === "k") continue;
        const next = new Map(m);
        next.delete(sq);
        next.set(to, { t: p.t, caps: p.caps + 1 });
        if (solve(next)) return true;
      }
    }
    return false;
  };
  return solve(new Map(pieces.map((p) => [p.sq, { t: p.t, caps: 0 }])));
}
