// Play vs a bot: Stockfish-backed personalities, hints, takebacks, resumable, rated vs the bot's Elo.
import { createChess } from "../core/chess960.js";
import { BaseGame, variantName } from "./base-game.js";
import { h, icon } from "../ui/dom.js";
import { confirmModal, toast } from "../ui/components.js";
import { BOTS, botMove, botThinkDelay } from "../bots.js";
import { playEngine } from "../core/engines.js";
import { getProfile, applyRating, setResume, updateProfile, unlock, getSettings } from "../store.js";
import { uciToMove, START_FEN } from "../core/tree.js";
import { judgeMove, coachLine } from "../core/coach.js";
import { analysisEngine } from "../core/engines.js";
import { formatScore, evalBarFraction } from "../engine.js";
import { clsDot } from "../ui/components.js";

export function findBot(id) {
  if (id && id.startsWith("__engine")) {
    const elo = Number(id.slice(8)) || 2000;
    return { id, name: "Stockfish", elo, avatar: { emoji: "🐟", bg: "#2b4a6b" }, category: "Engine", style: "The engine", bio: "", chat: {} };
  }
  return BOTS.find(b => b.id === id) || BOTS[0];
}

export class BotGame extends BaseGame {
  // cfg: { botId, myColor, tcKey, assisted: { hints, takebacks }, resume?: {moves, clocks} }
  constructor(app, cfg) {
    const bot = findBot(cfg.botId);
    const me = getProfile();
    const myColor = cfg.myColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : (cfg.myColor || "w");
    const botColor = myColor === "w" ? "b" : "w";
    const players = {
      [myColor]: { name: me.name, rating: me.ratings.bots.r, avatar: me.avatar },
      [botColor]: { name: bot.name, rating: bot.elo, avatar: bot.avatar, flag: bot.country, botId: bot.id },
    };
    super(app, { ...cfg, mode: "bot", players, myColor });
    this.bot = bot;
    this.botColor = botColor;
    this.assists = { hints: 0, takebacks: 0 };
    this.botBusy = false;
    this.bubble = null;
    this.gen = 0;                 // invalidates in-flight bot moves after takebacks
  }

  title() { return (this.cfg.arena ? "Arena: " : "vs ") + this.bot.name + (this.variant !== "standard" ? ` (${variantName(this.variant)})` : ""); }
  canMove(c) { return c === this.myColor && !this.botBusy; }
  premoveColor() { return this.myColor; }

  mount() {
    super.mount();
    const resume = this.cfg.resume;
    if (resume && resume.moves && resume.moves.length) {
      for (const u of resume.moves) {
        const mv = this.chess.move(uciToMove(u));
        this.node = this.tree.play(this.node, { from: mv.from, to: mv.to, promotion: mv.promotion });
      }
      this.view = this.node;
      if (this.clock && resume.clocks) { this.clock.w = resume.clocks.w; this.clock.b = resume.clocks.b; if (this.plyCount() >= 2) { this.clock.active = this.chess.turn(); this.clock.lastTs = performance.now(); } }
      this.assists = resume.assists || this.assists;
      this.app.board.syncFromBoard(this.chess.board());
      this.redraw(false);
      this.renderMoves();
      this._renderControls();
      this.say("Welcome back! Let's continue.");
    } else {
      this.say(pick(this.bot.chat?.greet) || `Hi, I'm ${this.bot.name}. Good luck!`);
    }
    this.app.leaveGuard = async () => {
      if (this.result) return true;
      if (this.cfg.arena) {
        const ok = await confirmModal({ title: "Leave this arena game?", sub: "It counts as a loss.", yes: "Resign and leave", danger: true });
        if (ok) this.finish({ winner: this.botColor, reason: "resignation" });
        return ok;
      }
      if (this.plyCount() === 0) return true;   // nothing to save yet
      this._saveResume();
      toast("Game saved. Continue it from the Play page.");
      return true;
    };
    playEngine().newGame().catch(() => toast("The chess engine couldn't load. Try reloading the page."));
    if (this.cfg.assisted?.evalBar) { this.app.evalBar.show(true); this.app.evalBar.set(0.5, "0.0", this.app.board.orientation); }
    if (this.chess.turn() === this.botColor) this._botTurn();
  }

  destroy() {
    this.gen++;
    this.dead = true;
    super.destroy();
  }

  extraPanel() {
    this.bubbleEl = h("div.coach");
    return this.bubbleEl;
  }

  say(text) {
    if (!this.bubbleEl || !text) return;
    this.bubbleEl.innerHTML = "";
    this.bubbleEl.append(
      h("div.avatar", { style: { background: this.bot.avatar.bg } }, this.bot.avatar.emoji),
      h("div.bubble", text));
  }

  controls() {
    const started = this.plyCount() > 0;
    const live = !this.result;
    const list = [];
    if (this.cfg.assisted?.takebacks !== false) list.push({ label: "Takeback", icon: "undo", onClick: () => this.takeback(), disabled: !live || !this.tree.mainline().some(n => n.move.color === this.myColor) });
    if (this.cfg.assisted?.hints !== false) list.push({ label: "Hint", icon: "hint", onClick: () => this.hint(), disabled: !live });
    list.push({ label: "Offer draw", text: "½", onClick: () => this.offerDraw(), disabled: !live || this.plyCount() < 2 });
    list.push(this.plyCount() < 2 && live
      ? { label: "Abort", icon: "close", onClick: () => this.finish({ winner: null, reason: "aborted" }), disabled: !live }
      : { label: "Resign", icon: "flag", onClick: () => this.resign(), disabled: !live || !started });
    return list;
  }

  postGameButtons(close = () => {}) {
    if (this.cfg.arena) return [h("button.btn.primary", { onclick: () => { close(); this.app.go("#/arena"); } }, icon("trophy", 18), "Back to arena")];
    return [
      h("button.btn", { onclick: () => { close(); this.app.setController(() => new BotGame(this.app, { ...this.cfg, resume: null, id: undefined, myColor: this.myColor === "w" ? "b" : "w" })); } }, icon("flip", 18), "Rematch"),
      h("button.btn", { onclick: () => { close(); this.app.go("#/bots"); } }, icon("robot", 18), "New bot"),
    ];
  }

  statusText() {
    if (this.botBusy) return `${this.bot.name} is thinking…`;
    if (this.chess.turn() === this.myColor) return "Your move" + (this.chess.inCheck() ? ". You're in check!" : "");
    return `${this.bot.name} to move`;
  }

  userMove(m, opts) {
    if (this.chess.turn() !== this.myColor || this.result) return;
    this.app.board.setArrows([]);
    const fenBefore = this.chess.fen();
    const mv = this.applyMove(m, opts);
    if (!mv) return;
    if (this.cfg.assisted?.coach) this._coach(fenBefore, mv);
    else if (mv.captured && "rq".includes(mv.captured) && Math.random() < 0.5) this.say(pick(this.bot.chat?.blunder));
  }

  // live feedback from the analysis engine (separate from the bot's engine)
  async _coach(fenBefore, mv) {
    const uci = mv.from + mv.to + (mv.promotion || "");
    const gen = this.gen;
    try {
      const j = await judgeMove(fenBefore, uci);
      if (!j || this.dead) return;
      if (this.bubbleEl) {
        this.bubbleEl.innerHTML = "";
        this.bubbleEl.append(h("div.avatar", { style: { background: "#3c5a46" } }, "🦉"), h("div.bubble", h("span.cls-tag", clsDot(j.cls, 16), " "), coachLine(j)));
      }
      if (["mistake", "blunder"].includes(j.cls) && j.bestUci && gen === this.gen) {
        this._coachArrow = { from: j.bestUci.slice(0, 2), to: j.bestUci.slice(2, 4) };
      }
      this._updateEval(j.scoreAfter);
    } catch { /* coach is best-effort */ }
  }

  _updateEval(sw) {
    if (!this.cfg.assisted?.evalBar || !sw || this.dead) return;   // results can land after leaving
    this.app.evalBar.show(true);
    this.app.evalBar.set(evalBarFraction(sw), formatScore(sw).replace("+", ""), this.app.board.orientation);
  }

  async _evalAfterBot() {
    if (!this.cfg.assisted?.evalBar || this.result) return;
    try {
      const fen = this.chess.fen();
      const r = await analysisEngine().analyze(fen, { movetime: 300 });
      if (this.chess.fen() === fen && r && r.lines && r.lines[0]) this._updateEval(r.lines[0].scoreWhite);
    } catch { /* best-effort */ }
  }

  onAfterMove(mv) {
    this._saveResume();
    if (mv.color === this.myColor) this._botTurn();
    else { this.input.tryPremove(); this._evalAfterBot(); }
  }

  async _botTurn() {
    if (this.result || this.chess.turn() !== this.botColor) return;
    const gen = ++this.gen;
    this.botBusy = true;
    this.players[this.botColor].thinking = true;
    this.renderStrips();
    this._renderStatusSafe();
    const fen = this.chess.fen();
    const t0 = performance.now();
    let mv;
    try {
      const history = this.plies().map(n => n.san);
      mv = await botMove(playEngine(), fen, this.bot, { history, startFen: this.startFen });
    } catch (e) {
      console.error(e);
      // engine trouble: fall back to any legal move so the game never hangs
      const legal = createChess(fen).moves({ verbose: true });
      mv = legal[Math.floor(Math.random() * legal.length)];
    }
    if (gen !== this.gen || this.result) return;
    let delay = (mv.delayMs !== undefined ? mv.delayMs : botThinkDelay(this.bot, fen, Math.floor(this.plyCount() / 2) + 1)) - Math.max(0, performance.now() - t0 - (mv.thinkMs || 0));
    if (this.clock) delay = Math.min(delay, Math.max(0, this.clockMs(this.botColor) / 40));
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    if (gen !== this.gen || this.result) return;
    this.botBusy = false;
    this.players[this.botColor].thinking = false;
    this.applyMove({ from: mv.from, to: mv.to, promotion: mv.promotion }, { opponent: true });
    if (!this.result && (mv.reason === "random" || mv.reason === "hang") && Math.random() < 0.35) this.say(pick(this.bot.chat?.oops));
  }
  _renderStatusSafe() { this._renderStatus(); }

  async hint() {
    if (this.result || this.chess.turn() !== this.myColor || this.view !== this.node) return;
    this.assists.hints++;
    const fen = this.chess.fen();
    try {
      const r = await playEngine().analyze(fen, { movetime: 700 });
      if (this.dead || this.chess.fen() !== fen || !r.bestmove) return;
      const u = r.bestmove;
      this.app.board.setArrows([{ from: u.slice(0, 2), to: u.slice(2, 4), color: "rgba(52,210,123,.85)" }]);
      this.say("Here's an idea: try the move I highlighted.");
    } catch { toast("Hint unavailable: the engine isn't ready."); }
  }

  takeback() {
    if (this.result || this.botBusy && this.chess.turn() !== this.botColor) return;
    const line = this.plies();
    if (!line.some(n => n.move.color === this.myColor)) return;
    this.gen++;
    this.botBusy = false;
    this.players[this.botColor].thinking = false;
    this.assists.takebacks++;
    // undo back to the position before the user's last move
    let n = this.node;
    while (n.parent && n.move.color !== this.myColor) n = n.parent;
    n = n.parent;
    this.tree.remove(n.children[0]);
    this.node = n; this.view = n;
    this.chess = this.tree.chessAt(n);
    if (this.clock && this.plyCount() < 2) this.clock.active = null;
    else if (this.clock) { this.clock.active = this.chess.turn(); this.clock.lastTs = performance.now(); }
    this.app.board.setArrows([]);
    this.input.cancelPremove();
    this.redraw();
    this.renderMoves();
    this._renderControls();
    this._saveResume();
  }

  async offerDraw() {
    if (this.result) return;
    // bots accept when the position is dead level late in the game, or when they're worse
    let accept = false;
    try {
      // not the play engine: that would cut short the bot's own search if it's thinking
      const r = await analysisEngine().analyze(this.chess.fen(), { movetime: 400 });
      const line = r.lines[0];
      const cpWhite = line?.scoreWhite?.mate !== undefined && line?.scoreWhite?.mate !== null ? (line.scoreWhite.mate > 0 ? 9999 : -9999) : (line?.scoreWhite?.cp ?? 0);
      const forBot = this.botColor === "w" ? cpWhite : -cpWhite;
      accept = (Math.abs(forBot) <= 40 && this.plyCount() >= 60) || forBot <= -250;
    } catch { accept = false; }
    if (this.dead || this.result) return;
    if (accept) { this.say(pick(this.bot.chat?.draw) || "A draw sounds fair."); this.finish({ winner: null, reason: "agreement" }); }
    else { this.say("No thanks, I'd like to keep playing."); }
  }

  async resign() {
    if (this.result) return;
    if (getSettings().confirmResign && !(await confirmModal({ title: "Resign this game?", yes: "Resign", danger: true }))) return;
    this.finish({ winner: this.botColor, reason: "resignation" });
  }

  onFinish(r) {
    setResume(null);
    if (this.cfg.arena) {
      const sc = r.reason === "aborted" ? null : !r.winner ? 0.5 : r.winner === this.myColor ? 1 : 0;
      try { this.cfg.arena.onResult(sc); } catch (e) { console.error(e); }
    }
    this.gen++;
    this.players[this.botColor].thinking = false;
    if (r.reason === "aborted") return {};
    const score = !r.winner ? 0.5 : r.winner === this.myColor ? 1 : 0;
    const helped = this.assists.hints > 0 || this.assists.takebacks > 0 || !!this.cfg.assisted?.coach || !!this.cfg.assisted?.evalBar;
    // only standard games from the normal start count ("Play from here" positions don't)
    const rated = this.variant === "standard" && this.startFen === START_FEN && !helped;
    let delta = null;
    if (rated) delta = applyRating("bots", this.bot.elo, score);
    if (score === 1) {
      updateProfile(p => { p.botsBeaten[this.bot.id] = true; });
      const cat = (this.bot.category || "").toLowerCase();
      if (cat === "beginner") unlock("beat-beginner");
      if (cat === "intermediate") unlock("beat-intermediate");
      if (cat === "advanced") unlock("beat-advanced");
      if (cat === "master" || cat === "engine") unlock("beat-master");
      this.say(pick(this.bot.chat?.lose) || "Well played!");
    } else if (score === 0) this.say(pick(this.bot.chat?.win) || "Good game!");
    else this.say(pick(this.bot.chat?.draw) || "A fair result.");
    this.players[this.myColor].rating = getProfile().ratings.bots.r;
    if (!rated) toast(helped ? "Unrated game: assistance was on." : "Unrated game.");
    return { rated, delta, deltaFor: delta !== null ? { [this.myColor]: delta } : null };
  }

  _saveResume() {
    if (this.cfg.arena) return;
    if (this.result || this.plyCount() === 0) { if (this.result) setResume(null); return; }
    setResume({
      kind: "bot", botId: this.bot.id, myColor: this.myColor, tcKey: this.tcKey, assisted: this.cfg.assisted, startFen: this.startFen, variant: this.variant,
      moves: this.plies().map(n => n.uci), id: this.id, assists: this.assists,
      clocks: this.clock ? { w: this.clockMs("w"), b: this.clockMs("b") } : null, at: Date.now(),
    });
  }
}

function pick(arr) { return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

// ---------- pass & play ----------
export class LocalGame extends BaseGame {
  constructor(app, cfg) {
    const me = getProfile();
    super(app, {
      ...cfg, mode: "local", myColor: null,
      players: {
        w: { name: cfg.whiteName || me.name, avatar: { emoji: "♔", bg: "#6b5a43" } },
        b: { name: cfg.blackName || "Friend", avatar: { emoji: "♚", bg: "#2d241d" } },
      },
    });
    this.autoFlip = !!cfg.autoFlip;
  }
  title() { return this.variant === "standard" ? "Pass and play" : variantName(this.variant); }
  canMove(c) { return c === this.chess.turn(); }
  userMove(m, opts) { if (!this.result) this.applyMove(m, opts); }   // e.g. a promotion picked after a flag
  onAfterMove() {
    if (this.autoFlip && !this.result) setTimeout(() => { if (this._destroyed) return; this.app.board.viewSide(this.chess.turn()); this.renderStrips(); }, 450);
  }
  mount() {
    super.mount();
    this.app.leaveGuard = async () => this.result || this.plyCount() === 0 || confirmModal({ title: "Leave this game?", sub: "The game will be lost.", yes: "Leave", danger: true });
  }
  controls() {
    const live = !this.result;
    return [
      { label: "Undo", icon: "undo", onClick: () => this.undo(), disabled: !live || this.plyCount() === 0 },
      { label: "Draw", text: "½", onClick: async () => { if (await confirmModal({ title: "Agree to a draw?", yes: "Draw" })) this.finish({ winner: null, reason: "agreement" }); }, disabled: !live || this.plyCount() < 2 },
      { label: "Resign", icon: "flag", onClick: async () => { if (await confirmModal({ title: `${this.chess.turn() === "w" ? "White" : "Black"} resigns?`, yes: "Resign", danger: true })) this.finish({ winner: this.chess.turn() === "w" ? "b" : "w", reason: "resignation" }); }, disabled: !live || this.plyCount() === 0 },
    ];
  }
  undo() {
    if (this.result || !this.node.parent) return;
    const n = this.node.parent;
    this.tree.remove(this.node);
    this.node = n; this.view = n;
    this.chess = this.tree.chessAt(n);
    if (this.clock) { if (this.plyCount() < 2) this.clock.active = null; else { this.clock.active = this.chess.turn(); this.clock.lastTs = performance.now(); } }
    this.redraw(); this.renderMoves(); this._renderControls();
  }
  postGameButtons(close = () => {}) {
    return [h("button.btn", { onclick: () => { close(); this.app.setController(() => new LocalGame(this.app, { ...this.cfg, id: undefined })); } }, icon("flip", 18), "Play again")];
  }
}
