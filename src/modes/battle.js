// Puzzle Battle: race a bot through the same puzzles for 3 minutes; three strikes and you're out.
// The bot's pace and accuracy come from its rating against each puzzle's rating.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { openModal, toast, confirmModal } from "../ui/components.js";
import { PuzzleRunner } from "./puzzles.js";
import { loadPuzzles, rushSequence } from "../puzzles.js";
import { BOTS } from "../bots.js";
import { getProfile, updateProfile, unlock } from "../store.js";
import { SFX } from "../audio.js";

const DURATION = 180000;
const STRIKES = 3;

function pickOpponent() {
  const r = getProfile().ratings.puzzle.r;
  const pool = BOTS.filter(b => b.category !== "Engine");
  const near = [...pool].sort((a, b) => Math.abs(a.elo - r) - Math.abs(b.elo - r)).slice(0, 4);
  return near[Math.floor(Math.random() * near.length)];
}

export class BattleScreen {
  constructor(app) {
    this.app = app;
    this.state = "menu";
    this.runner = new PuzzleRunner(app, {
      onSolved: (clean) => this.mine(clean),
      onWrong: () => this.mine(false),
      onProgress: () => {},
    });
  }

  mount() {
    this.runner.bind();
    loadPuzzles().catch(() => toast("Couldn't load puzzles."));
    this.menu();
  }
  destroy() { this.dead = true; clearInterval(this.timer); clearTimeout(this.botT); this.runner.stop(); }
  onBoardSwap() { this.runner.bind(); if (this.runner.chess) this.app.board.syncFromBoard(this.runner.chess.board()); }

  menu() {
    this.state = "menu";
    this.app.setLobby(true);
    this.app.setInGame(false);
    this.app.leaveGuard = null;
    this.opp = this.opp || pickOpponent();
    const p = getProfile();
    this.app.board.syncFromBoard(new Chess().board());
    this.app.strips({ name: this.opp.name, rating: this.opp.elo, avatar: this.opp.avatar }, { name: p.name, rating: p.ratings.puzzle.r, avatar: p.avatar });
    const list = h("div.bot-grid", ...BOTS.filter(b => b.category !== "Engine").map(b => {
      const chip = h(`button.bot-chip${b.id === this.opp.id ? ".on" : ""}`, { "aria-label": `${b.name}, ${b.elo}`, title: `${b.name} (${b.elo})`, onclick: () => { this.opp = b; this.menu(); } },
        h("div.avatar", { style: { background: b.avatar.bg } }, b.avatar.emoji), h("small", String(b.elo)));
      return chip;
    }));
    this.app.panel({
      title: "Puzzle Battle", back: "#/puzzles",
      body: [
        h("p", { style: { color: "var(--ink-2)" } }, "Race a bot through the same puzzles. Three minutes, three strikes. Most puzzles solved wins."),
        h("div.card", h("div.bot-hero", h("div.avatar.lg", { style: { background: this.opp.avatar.bg } }, this.opp.avatar.emoji),
          h("div", h("h3", this.opp.name), h("div.rating", String(this.opp.elo)), h("p.note", this.opp.style)))),
        h("div.lbl.note", "Choose an opponent"), list,
        h("div.kv", h("span", "Battles won"), h("b", String(p.battle?.wins || 0) + " of " + String(p.battle?.played || 0))),
      ],
      foot: h("button.btn.primary.big.block", { onclick: () => this.start() }, "Start battle"),
    });
  }

  async start() {
    await loadPuzzles();
    if (this.dead) return;
    this.state = "playing";
    this.app.setLobby(false);
    this.app.setInGame(true);
    this.app.leaveGuard = async () => this.state !== "playing" || confirmModal({ title: "Leave the battle?", sub: "Leaving now counts as a loss.", yes: "Leave", danger: true }).then(ok => { if (ok) this.end(); return ok; });
    this.seq = rushSequence(Math.floor(Math.random() * 1e6), 80);
    this.me = { score: 0, strikes: 0, i: 0, out: false, log: [] };
    this.bot = { score: 0, strikes: 0, i: 0, out: false, log: [] };
    this.endAt = performance.now() + DURATION;
    this.render();
    this.loadMine();
    this.botNext();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 200);
    SFX.start?.();
  }

  loadMine() {
    if (this.me.i >= this.seq.length) { this.me.out = true; this.checkEnd(); return; }
    this.runner.load(this.seq[this.me.i]);
    this.render();
  }

  mine(clean) {
    if (this.state !== "playing" || this.me.out) return;
    const pz = this.seq[this.me.i];
    this.me.log.push({ ok: clean, r: pz.rating });
    if (clean) this.me.score++; else this.me.strikes++;
    this.me.i++;
    if (this.me.strikes >= STRIKES) { this.me.out = true; this.runner.stop(); this.render(); this.checkEnd(); return; }
    setTimeout(() => { if (this.state === "playing") this.loadMine(); }, clean ? 350 : 250);
  }

  // simulated opponent: solve chance and time from rating vs puzzle rating
  botNext() {
    if (this.state !== "playing" || this.bot.out || this.bot.i >= this.seq.length) return;
    const pz = this.seq[this.bot.i];
    const R = this.opp.elo;
    const p = Math.max(0.05, Math.min(0.97, 1 / (1 + Math.pow(10, (pz.rating - R) / 400)) + 0.08));
    const moves = Math.ceil((pz.moves.length - 1) / 2);
    const secs = Math.max(2.5, Math.min(28, (3 + 3.5 * moves) * Math.pow(pz.rating / Math.max(600, R), 1.4) * (0.7 + Math.random() * 0.7)));
    this.botT = setTimeout(() => {
      if (this.state !== "playing" || this.dead) return;
      const ok = Math.random() < p;
      this.bot.log.push({ ok, r: pz.rating });
      if (ok) this.bot.score++; else this.bot.strikes++;
      this.bot.i++;
      if (this.bot.strikes >= STRIKES) this.bot.out = true;
      this.render();
      if (this.bot.out) this.checkEnd(); else this.botNext();
    }, secs * 1000);
  }

  tick() {
    if (this.state !== "playing") return;
    const left = this.endAt - performance.now();
    if (this.timerEl) this.timerEl.textContent = fmt(left);
    if (left <= 0) this.end();
  }

  checkEnd() {
    // both out, or one out and already behind the other
    if (this.me.out && this.bot.out) return this.end();
    if (this.me.out && this.bot.score > this.me.score) return this.end();
    if (this.bot.out && this.me.score > this.bot.score) return this.end();
  }

  end() {
    if (this.state !== "playing") return;
    this.state = "over";
    clearInterval(this.timer);
    clearTimeout(this.botT);
    this.runner.stop();
    const res = this.me.score > this.bot.score ? "win" : this.me.score < this.bot.score ? "loss" : "draw";
    updateProfile(p => { p.battle = p.battle || { played: 0, wins: 0 }; p.battle.played++; if (res === "win") p.battle.wins++; });
    if (res === "win") unlock("battle-win");
    SFX.end();
    const m = openModal({
      title: res === "win" ? "You won the battle!" : res === "loss" ? `${this.opp.name} wins` : "It's a tie",
      sub: `${this.me.score} – ${this.bot.score}`,
      body: h("div.btn-row",
        h("button.btn", { onclick: () => { m.close(); this.menu(); } }, "Change opponent"),
        h("button.btn.primary", { onclick: () => { m.close(); this.start(); } }, "Rematch")),
    });
    this.render();
  }

  render() {
    if (this.state === "menu") return;
    const side = (who, s, name, avatar) => h("div.card", { style: { flex: "1", display: "flex", flexDirection: "column", gap: "6px", alignItems: "center", opacity: s.out ? ".6" : "1" } },
      h("div.avatar", { style: { background: avatar.bg } }, avatar.emoji),
      h("b", { style: { fontSize: "13px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, name),
      h("div.big-num", String(s.score)),
      h("div.rush-strikes", ...Array.from({ length: STRIKES }, (_, k) => h(`span${k < s.strikes ? ".hit" : ""}`, "✕"))));
    const p = getProfile();
    this.timerEl = h("div.timer-big", this.state === "playing" ? fmt(this.endAt - performance.now()) : "0:00");
    const pz = this.runner.p;
    this.app.panel({
      title: "Puzzle Battle", back: () => { if (this.state === "playing") this.end(); else this.menu(); },
      body: [
        this.timerEl,
        h("div", { style: { display: "flex", gap: "8px" } }, side("me", this.me, p.name, p.avatar), side("bot", this.bot, this.opp.name, this.opp.avatar)),
        this.state === "playing" && pz && !this.me.out ? h("div.status-line", h(`span.dot.${pz.playerColor}`), h("span", `${pz.playerColor === "w" ? "White" : "Black"} to move`))
          : this.me.out && this.state === "playing" ? h("div.status-line.bad", icon("close", 16), h("span", "Out of strikes. Waiting for the result…")) : null,
        h("div.rush-log", ...this.me.log.map(l => h(`span.${l.ok ? "ok" : "no"}`, String(l.r)))),
      ],
      foot: this.state === "over" ? h("button.btn.primary.big.block", { onclick: () => this.start() }, "Rematch") : null,
    });
  }
}

function fmt(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
