// Puzzle Battle: race another player (or a bot) through the same puzzles for 3 minutes; three
// strikes and you're out. Real opponents are matched by the social API, which hands both players
// the same puzzle seed and relays scores. A bot's pace and accuracy come from its rating.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { openModal, toast, confirmModal } from "../ui/components.js";
import { PuzzleRunner } from "./puzzles.js";
import { loadPuzzles, rushSequence } from "../puzzles.js";
import { BOTS } from "../bots.js";
import { getProfile, updateProfile, unlock } from "../store.js";
import { SFX } from "../audio.js";
import { segmented } from "../ui/components.js";
import { userAvatar } from "../ui/people.js";
import * as S from "../net/social.js";

const DURATION = 180000;
const STRIKES = 3;
let versus = "human";     // "human" | "bot"

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
  destroy() {
    this.dead = true;
    clearInterval(this.timer); clearTimeout(this.botT); clearTimeout(this.findT); clearInterval(this.syncT); clearTimeout(this.goT);
    this.runner.stop();
    if (this.state === "searching") S.api("POST", "/battles/cancel", {}).catch(() => {});
  }
  onBoardSwap() { this.runner.bind(); if (this.runner.chess) this.app.board.syncFromBoard(this.runner.chess.board()); }

  menu() {
    this.state = "menu";
    this.app.setLobby(true);
    this.app.setInGame(false);
    this.app.leaveGuard = null;
    if (!this.opp || this.opp.human) this.opp = pickOpponent();
    const p = getProfile();
    this.app.board.syncFromBoard(new Chess().board());
    this.app.strips({ name: this.opp.name, rating: this.opp.elo, avatar: this.opp.avatar }, { name: p.name, rating: p.ratings.puzzle.r, avatar: p.avatar });
    const list = h("div.bot-grid", ...BOTS.filter(b => b.category !== "Engine").map(b => {
      const chip = h(`button.bot-chip${b.id === this.opp.id ? ".on" : ""}`, { "aria-label": `${b.name}, ${b.elo}`, title: `${b.name} (${b.elo})`, onclick: () => { this.opp = b; this.menu(); } },
        h("div.avatar", { style: { background: b.avatar.bg } }, b.avatar.emoji), h("small", String(b.elo)));
      return chip;
    }));
    const human = versus === "human";
    const pick = segmented([{ value: "human", label: "Real player" }, { value: "bot", label: "Bot" }], versus, (v) => { versus = v; this.menu(); });
    this.app.panel({
      title: "Puzzle Battle", back: "#/puzzles",
      body: [
        h("p", { style: { color: "var(--ink-2)" } }, "Race an opponent through the same puzzles. Three minutes, three strikes. Most puzzles solved wins."),
        pick,
        human
          ? (S.registered()
            ? h("div.card", h("h3", "Battle a real player"), h("p.note", "You're matched with someone else looking for a battle. Both of you get the same puzzles, and you see each other's score live."))
            : h("div.card", h("h3", "Turn on Social to battle real players"), h("p.note", "Matching uses your social profile: a key on this device, no sign-up."),
              h("button.btn.primary", { style: { marginTop: "10px" }, onclick: () => this.app.go("#/social") }, icon("users", 18), "Open Social")))
          : [h("div.card", h("div.bot-hero", h("div.avatar.lg", { style: { background: this.opp.avatar.bg } }, this.opp.avatar.emoji),
            h("div", h("h3", this.opp.name), h("div.rating", String(this.opp.elo)), h("p.note", this.opp.style)))),
          h("div.lbl.note", "Choose an opponent"), list],
        h("div.kv", h("span", "Battles won"), h("b", String(p.battle?.wins || 0) + " of " + String(p.battle?.played || 0))),
      ],
      foot: human && !S.registered() ? null : h("button.btn.primary.big.block", { onclick: () => (human ? this.search() : this.start()) }, human ? "Find an opponent" : "Start battle"),
    });
  }

  // ---- real opponents ----
  async search() {
    await loadPuzzles();
    if (this.dead) return;
    this.state = "searching";
    this.app.setLobby(true);
    this.app.leaveGuard = null;
    this.app.panel({
      title: "Puzzle Battle", back: () => this.cancelSearch(),
      body: [h("div.status-line.good", h("span.spinner"), h("span", "Looking for an opponent…")),
        h("p.note", "Battles start as soon as someone else is looking too. Keep this screen open.")],
      foot: h("button.btn.ghost.block", { onclick: () => this.cancelSearch() }, "Cancel"),
    });
    const step = async () => {
      if (this.dead || this.state !== "searching") return;
      let b = null;
      try { b = (await S.api("POST", "/battles/find", {})).battle; } catch (e) { toast(e.message); this.cancelSearch(); return; }
      if (this.dead || this.state !== "searching") return;
      if (b && b.opponent && b.starts) { this.matched(b); return; }
      this.findT = setTimeout(step, 2000);
    };
    step();
  }

  cancelSearch() {
    clearTimeout(this.findT);
    if (this.state === "searching") S.api("POST", "/battles/cancel", {}).catch(() => {});
    this.state = "menu";
    this.menu();
  }

  matched(b) {
    this.battle = b;
    this.skew = b.now - Date.now();
    this.opp = { name: b.opponent.name, elo: b.opponent.rating, avatar: b.opponent.avatar || { emoji: "♟", bg: "#3a4a5a" }, human: true };
    this.state = "countdown";
    SFX.notify();
    const left = () => b.starts - (Date.now() + this.skew);
    const cd = h("div.timer-big", String(Math.ceil(left() / 1000)));
    this.app.panel({
      title: "Puzzle Battle",
      body: [h("div.card", { style: { display: "flex", alignItems: "center", gap: "12px" } }, userAvatar(b.opponent, ".lg"),
        h("div", h("div.note", "Your opponent"), h("h3", b.opponent.name), h("div.rating", String(b.opponent.rating)))),
      h("p.note", "Same puzzles for both of you. Get ready…"), cd],
    });
    const tick = () => {
      if (this.dead) return;
      const ms = left();
      if (ms <= 0) { this.start(b); return; }
      cd.textContent = String(Math.ceil(ms / 1000));
      this.goT = setTimeout(tick, 200);
    };
    tick();
  }

  // report our progress and read theirs, once a second
  async sync(final = false) {
    if (!this.battle) return;
    try {
      const r = await S.api("POST", `/battles/${this.battle.id}/progress`, { score: this.me.score, strikes: this.me.strikes, done: this.me.out || final });
      const o = r.battle && r.battle.opponent;
      if (!o || this.dead) return;
      const before = this.bot.score + this.bot.strikes;
      this.bot.score = o.score;
      this.bot.strikes = o.strikes;
      if ((o.done || o.gone) && !this.bot.out) this.bot.out = true;
      if (this.state === "playing" && (o.score + o.strikes !== before || this.bot.out)) { this.render(); if (this.bot.out) this.checkEnd(); }
    } catch { /* next tick */ }
  }

  async start(battle = null) {
    await loadPuzzles();
    if (this.dead) return;
    this.battle = battle;
    this.state = "playing";
    this.app.setLobby(false);
    this.app.setInGame(true);
    this.app.leaveGuard = async () => this.state !== "playing" || confirmModal({ title: "Leave the battle?", sub: "Leaving now counts as a loss.", yes: "Leave", danger: true }).then(ok => { if (ok) this.end(); return ok; });
    const pr = getProfile();
    this.app.strips({ name: this.opp.name, rating: this.opp.elo, avatar: this.opp.avatar }, { name: pr.name, rating: pr.ratings.puzzle.r, avatar: pr.avatar });
    this.seq = rushSequence(battle ? battle.seed : Math.floor(Math.random() * 1e6), 80);
    this.me = { score: 0, strikes: 0, i: 0, out: false, log: [] };
    this.bot = { score: 0, strikes: 0, i: 0, out: false, log: [] };
    // a real battle ends at the server's time, the same moment for both players
    this.endAt = battle ? performance.now() + (battle.ends - (Date.now() + this.skew)) : performance.now() + DURATION;
    this.render();
    this.loadMine();
    if (battle) { clearInterval(this.syncT); this.syncT = setInterval(() => this.sync(), 1000); }
    else this.botNext();
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
    if (this.me.strikes >= STRIKES) { this.me.out = true; this.runner.stop(); this.render(); if (this.battle) this.sync(); this.checkEnd(); return; }
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

  async end() {
    if (this.state !== "playing") return;
    this.state = "over";
    clearInterval(this.timer);
    clearInterval(this.syncT);
    clearTimeout(this.botT);
    this.runner.stop();
    // a real battle: send our final score and read theirs before deciding
    if (this.battle) {
      await this.sync(true);
      // give the other side's last report a moment to land when time ran out for both of us
      if (!this.bot.out) { await new Promise(r => setTimeout(r, 1500)); await this.sync(true); }
      if (this.dead) return;
    }
    const res = this.me.score > this.bot.score ? "win" : this.me.score < this.bot.score ? "loss" : "draw";
    updateProfile(p => { p.battle = p.battle || { played: 0, wins: 0 }; p.battle.played++; if (res === "win") p.battle.wins++; });
    if (res === "win") unlock("battle-win");
    SFX.end();
    const m = openModal({
      title: res === "win" ? "You won the battle!" : res === "loss" ? `${this.opp.name} wins` : "It's a tie",
      sub: `${this.me.score} – ${this.bot.score}`,
      body: h("div.btn-row",
        h("button.btn", { onclick: () => { m.close(); this.battle = null; this.opp = null; this.menu(); } }, this.battle ? "Back" : "Change opponent"),
        h("button.btn.primary", { onclick: () => { m.close(); if (this.battle) { this.battle = null; this.search(); } else this.start(); } }, this.battle ? "New battle" : "Rematch")),
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
      foot: this.state === "over" ? h("button.btn.primary.big.block", { onclick: () => { if (this.battle) { this.battle = null; this.search(); } else this.start(); } }, this.battle ? "New battle" : "Rematch") : null,
    });
  }
}

function fmt(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
