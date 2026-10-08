// Bot Arena: a timed arena tournament (chess.com / lichess style). You play bots back to back;
// the rest of the field plays each other in the background (simulated from their ratings).
// Win 2, draw 1; after two wins in a row each win is worth double until you stop winning.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { openModal, segmented, tcLabel, toast } from "../ui/components.js";
import { BOTS } from "../bots.js";
import { BotGame } from "./bot-game.js";
import { getProfile, unlock } from "../store.js";
import { SFX } from "../audio.js";

const DURATIONS = [{ value: 10, label: "10 min" }, { value: 20, label: "20 min" }, { value: 30, label: "30 min" }];
const ARENA_TCS = ["1+0", "3+0", "3+2", "5+0"];
let setup = { minutes: 10, tc: "3+0" };

// the live tournament survives screen changes (you leave the lobby to play each game)
let arena = null;

function makeArena(minutes, tc) {
  const me = getProfile();
  const myR = me.ratings.bots.r;
  const field = [...BOTS].filter(b => b.category !== "Engine")
    .sort((a, b) => Math.abs(a.elo - myR) - Math.abs(b.elo - myR)).slice(0, 9);
  const players = [{ id: "me", name: me.name, rating: myR, avatar: me.avatar, me: true },
    ...field.map(b => ({ id: b.id, name: b.name, rating: b.elo, avatar: b.avatar, bot: b }))];
  for (const p of players) Object.assign(p, { score: 0, games: 0, wins: 0, streak: 0, form: [], busyUntil: 0 });
  const a = { minutes, tc, startedAt: Date.now(), endsAt: Date.now() + minutes * 60000, players, myGames: 0, over: false, lastOpp: null };
  a.timer = setInterval(() => tick(a), 4000);
  return a;
}

function award(p, result) {
  // result: 1 win, 0.5 draw, 0 loss; streak of 2+ wins doubles the next wins
  p.games++;
  let pts = result === 1 ? 2 : result === 0.5 ? 1 : 0;
  if (result === 1) { if (p.streak >= 2) pts *= 2; p.streak++; p.wins++; } else p.streak = 0;
  p.score += pts;
  p.form.push(result === 1 ? (pts === 4 ? "W2" : "W") : result === 0.5 ? "D" : "L");
  if (p.form.length > 12) p.form.shift();
  return pts;
}

function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

// bots play each other in the background
function tick(a) {
  if (a.over) return;
  const now = Date.now();
  if (now >= a.endsAt) {
    if (!a.inGame) finish(a);
    return;
  }
  const idle = a.players.filter(p => !p.me && p.busyUntil <= now);
  if (idle.length < 2) return;
  const x = idle[Math.floor(Math.random() * idle.length)];
  const rest = idle.filter(p => p !== x).sort((p, q) => Math.abs(p.rating - x.rating) - Math.abs(q.rating - x.rating));
  const y = rest[Math.floor(Math.random() * Math.min(3, rest.length))];
  // a simulated game takes a while, roughly like a real one at this time control
  const [m, inc] = a.tc.split("+").map(Number);
  const dur = (m * 60 + inc * 40) * 1000 * (0.55 + Math.random() * 0.6);
  x.busyUntil = y.busyUntil = now + dur;
  setTimeout(() => {
    if (a.over) return;
    const e = expected(x.rating, y.rating);
    const r = Math.random();
    const draw = 0.12;
    const res = r < draw ? 0.5 : r < draw + e * (1 - draw) ? 1 : 0;
    award(x, res); award(y, 1 - res);
    if (arena === a && a.onUpdate) a.onUpdate();
  }, Math.min(dur, Math.max(0, a.endsAt - now)));
}

function standings(a) {
  return [...a.players].sort((p, q) => q.score - p.score || q.wins - p.wins || p.games - q.games);
}

function finish(a) {
  if (a.over) return;
  a.over = true;
  clearInterval(a.timer);
  const table = standings(a);
  const rank = table.findIndex(p => p.me) + 1;
  if (rank <= 3 && a.myGames > 0) unlock("arena-podium");
  if (rank === 1 && a.myGames > 0) unlock("arena-win");
  SFX.end();
  if (a.onUpdate) a.onUpdate();
}

export function arenaActive() { return arena && !arena.over ? arena : null; }

export class ArenaScreen {
  constructor(app) { this.app = app; }

  mount() {
    this.app.board.syncFromBoard(new Chess().board());
    if (this.app.board.setIdle) this.app.board.setIdle(true);
    if (arena) arena.onUpdate = () => this.render();
    this.render();
    this._t = setInterval(() => this._clock(), 500);
  }
  destroy() {
    clearInterval(this._t);
    if (arena) arena.onUpdate = null;
    if (this.app.board.setIdle) this.app.board.setIdle(false);
  }

  _clock() {
    if (!arena || !this.clockEl) return;
    const left = Math.max(0, arena.endsAt - Date.now());
    const s = Math.ceil(left / 1000);
    this.clockEl.textContent = arena.over ? "Finished" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (left <= 0 && !arena.over && !arena.inGame) finish(arena);
  }

  render() {
    if (!arena) return this.renderSetup();
    const a = arena;
    const table = standings(a);
    const me = a.players.find(p => p.me);
    this.clockEl = h("div.timer-big", "");
    const rows = h("table.table", h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Score"), h("th", "Form"))),
      h("tbody", ...table.map((p, i) => h("tr", { style: p.me ? { background: "rgba(52,210,123,.08)" } : null },
        h("td", String(i + 1)),
        h("td", h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("div.avatar.sm", { style: { background: p.avatar?.bg || "#3a2e24" } }, p.avatar?.emoji || "♟"),
          h("span", h("b", p.name), h("span.muted", ` ${p.rating}`)),
          p.streak >= 2 ? h("span", { title: "On a winning streak: wins count double" }, "🔥") : null)),
        h("td", h("b", String(p.score))),
        h("td", h("span.muted", { style: { fontSize: "12px", letterSpacing: "1px" } }, p.form.slice(-6).map(f => f === "W2" ? "W" : f).join(" ")))))));
    const body = [
      h("div.card", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        h("div", h("div.note", `Bot Arena, ${tcLabel(a.tc)}`), this.clockEl),
        h("div", { style: { textAlign: "right" } }, h("div.note", "Your score"), h("div.big-num", String(me.score)))),
      me.streak >= 2 && !a.over ? h("div.status-line.good", h("span", "🔥"), h("span", "You're on fire: wins count double.")) : null,
      h("div", { style: { overflowX: "auto" } }, rows),
      h("p.note", "Win 2 points, draw 1. Two wins in a row and every further win is worth 4 until you stop winning. Games that end after the clock runs out still count."),
    ];
    const foot = [];
    if (a.over) {
      const rank = table.findIndex(p => p.me) + 1;
      foot.push(h("div.status-line" + (rank <= 3 ? ".good" : ""), icon("trophy", 18), h("span", `You finished #${rank} of ${table.length}.`)));
      foot.push(h("button.btn.primary.big.block", { onclick: () => { arena = null; this.render(); } }, "New arena"));
    } else {
      foot.push(h("button.btn.primary.big.block", { onclick: () => this.play() }, a.myGames ? "Next game" : "Start playing"));
      foot.push(h("button.btn.ghost.block", { onclick: () => this.withdraw() }, "Leave arena"));
    }
    this.app.strips(null, null);
    this.app.panel({ title: "Arena", back: "#/", body, foot });
    this._clock();
  }

  renderSetup() {
    this.clockEl = null;
    this.app.strips(null, null);
    this.app.panel({
      title: "Arena", back: "#/",
      body: [
        h("p", { style: { color: "var(--ink-2)" } }, "A timed tournament against the bots nearest your rating. Play as many games as you can before the clock runs out; the rest of the field plays each other at the same time."),
        h("div.field", h("div.lbl", "Length"), segmented(DURATIONS, setup.minutes, (v) => { setup.minutes = v; })),
        h("div.field", h("div.lbl", "Time per game"), segmented(ARENA_TCS.map(k => ({ value: k, label: tcLabel(k) })), setup.tc, (v) => { setup.tc = v; })),
      ],
      foot: h("button.btn.primary.big.block", { onclick: () => { arena = makeArena(setup.minutes, setup.tc); arena.onUpdate = () => this.render(); toast("Arena started. Good luck!"); this.render(); } }, "Join arena"),
    });
  }

  play() {
    const a = arena;
    if (!a || a.over) return;
    if (Date.now() >= a.endsAt) { finish(a); return; }
    const me = a.players.find(p => p.me);
    const pool = a.players.filter(p => !p.me && p.id !== a.lastOpp);
    // pair with whoever is free and closest in score, like an arena pairing
    const now = Date.now();
    const free = pool.filter(p => p.busyUntil <= now);
    const cands = (free.length ? free : pool).sort((p, q) => Math.abs(p.score - me.score) - Math.abs(q.score - me.score) || Math.abs(p.rating - me.rating) - Math.abs(q.rating - me.rating));
    const opp = cands[Math.floor(Math.random() * Math.min(2, cands.length))];
    a.lastOpp = opp.id;
    a.inGame = true;
    opp.busyUntil = Number.MAX_SAFE_INTEGER;
    const myColor = a.myGames % 2 === 0 ? (Math.random() < 0.5 ? "w" : "b") : (a.prevColor === "w" ? "b" : "w");
    a.prevColor = myColor;
    this.app.launch(() => new BotGame(this.app, {
      botId: opp.bot.id, myColor, tcKey: a.tc, assisted: { hints: false, takebacks: false },
      arena: {
        onResult: (score) => {
          a.inGame = false;
          opp.busyUntil = 0;
          if (score === null) return;            // aborted
          a.myGames++;
          const pts = award(me, score);
          award(opp, 1 - score);
          toast(score === 1 ? `+${pts} points` : score === 0.5 ? "+1 point" : "No points this time");
          if (Date.now() >= a.endsAt) finish(a);
        },
      },
    }), "#/game");
  }

  async withdraw() {
    const ok = await new Promise((res) => {
      const m = openModal({ title: "Leave the arena?", sub: "Your score stays on the table but you can't rejoin.", body: h("div.btn-row", h("button.btn.ghost", { onclick: () => { m.close(); res(false); } }, "Stay"), h("button.btn.danger", { onclick: () => { m.close(); res(true); } }, "Leave")) });
    });
    if (!ok) return;
    if (arena) { clearInterval(arena.timer); arena.over = true; }
    arena = null;
    this.render();
  }
}
