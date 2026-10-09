// Live arenas: timed tournaments against real players on a fixed schedule (blitz on the hour,
// bullet on the half hour). Pairing and scoring run on the game server (server/social.ts), which
// reads each result from the game room itself. Bot Arena stays available for practice.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { toast, tcLabel } from "../ui/components.js";
import { userAvatar } from "../ui/people.js";
import { getProfile, timeClass } from "../store.js";
import { OnlineGame } from "../modes/online-game.js";
import { arenaActive } from "../modes/arena.js";
import { makePlayerId } from "../net/room.js";
import { SFX } from "../audio.js";
import * as S from "../net/social.js";
import { swissStatus } from "./swiss.js";

const PAIR_MS = 2500;
const autoPair = new Set();      // arenas to pair in again straight away (back from a game)

// one player id per arena, so the server can tell which seat in a room is yours
function pidFor(arena) {
  const key = "arena-pid-" + arena.id;
  let pid = null;
  try { pid = sessionStorage.getItem(key); } catch { /* private mode */ }
  if (!pid) {
    const p = getProfile();
    pid = makePlayerId(p.name, p.ratings[timeClass(arena.tc) || "blitz"].r, S.myCode());
    try { sessionStorage.setItem(key, pid); } catch { /* noop */ }
  }
  return pid;
}

function minutesText(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function formMarks(form) {
  return String(form || "").trim().split(/\s+/).filter(Boolean).slice(-6).map(f => h(`span.form-${f === "W2" ? "w2" : f.toLowerCase()}`, f === "W2" ? "W" : f));
}

function idle(app) {
  app.setLobby(true);
  app.board.syncFromBoard(new Chess().board());
  app.board.viewSide("w", false);
  if (app.board.setIdle) app.board.setIdle(true);
}

function needsSocial(app) {
  return h("div.card",
    h("h3", "Turn on Social to play arenas"),
    h("p.note", "Arenas pair you with other players, so they use your social profile: a key saved on this device, no sign-up."),
    h("button.btn.primary", { onclick: () => app.go("#/social"), style: { marginTop: "10px" } }, icon("users", 18), "Open Social"));
}

export class ArenasScreen {
  constructor(app) { this.app = app; }
  mount() {
    idle(this.app);
    this.render(null);
    this.load();
    this.t = setInterval(() => this.load(), 15000);
  }
  destroy() { this.dead = true; clearInterval(this.t); if (this.app.board.setIdle) this.app.board.setIdle(false); }

  async load() {
    if (!S.registered()) return;
    try {
      const [d, sw] = await Promise.all([S.api("GET", "/arenas"), S.api("GET", "/swiss").catch(() => null)]);
      if (!this.dead) this.render({ ...d, swiss: sw ? sw.tournaments : [] });
    }
    catch (e) { if (!this.dead) this.render(null, e); }
  }

  render(d, err) {
    const body = [h("p", { style: { color: "var(--ink-2)" } }, "Tournaments against real players. Arenas run on the clock: you're paired again as soon as a game ends (a win scores 2, a draw 1, and after two wins in a row each win scores 4). Swiss tournaments have fixed rounds, each paired by score.")];
    if (!S.registered()) body.push(needsSocial(this.app));
    else if (err) body.push(h("div.status-line.bad", icon("close", 16), h("span", err.message)));
    else if (!d) body.push(h("p.note", "Loading arenas…"));
    else {
      const t = d.now;
      // a finished arena nobody played isn't worth listing
      body.push(h("div.rows", ...d.arenas.filter(a => a.players || a.ends > t).map(a => {
        const running = a.starts <= t && t < a.ends, over = t >= a.ends;
        const status = running ? `Running, ${minutesText(a.ends - t)} left` : over ? "Finished" : `Starts in ${minutesText(a.starts - t)}`;
        return h("button.row", { onclick: () => this.app.go(`#/arenas/${a.id}`) },
          h(`span.ri${running ? ".live" : ""}`, icon(a.cat === "bullet" ? "bolt" : "fire", 20)),
          h("span.rt", h("b", `${a.name}, ${tcLabel(a.tc)}`), h("small", `${status}. ${a.players} player${a.players === 1 ? "" : "s"}`)),
          a.joined ? h("span.badge", "Joined") : h("span.rv", icon("chevron", 18)));
      })));
      if (d.swiss && d.swiss.length) {
        body.push(h("div.lbl.note", { style: { marginTop: "6px" } }, "Swiss"));
        body.push(h("div.rows", ...d.swiss.filter((s) => s.status !== "done" || s.players).map((s) => h("button.row", { onclick: () => this.app.go(`#/swiss/${s.id}`) },
          h(`span.ri${s.status === "running" ? ".live" : ""}`, icon("trophy", 20)),
          h("span.rt", h("b", `${s.name}, ${tcLabel(s.tc)}`), h("small", `${swissStatus(s, t)}. ${s.rounds} rounds, ${s.players} player${s.players === 1 ? "" : "s"}`)),
          s.joined ? h("span.badge", "Joined") : h("span.rv", icon("chevron", 18))))));
      }
    }
    body.push(h("div.lbl.note", { style: { marginTop: "6px" } }, "Practice"));
    body.push(h("button.row", { onclick: () => this.app.go("#/arena") },
      h("span.ri", icon("robot", 20)),
      h("span.rt", h("b", "Bot Arena"), h("small", arenaActive() ? "In progress" : "An arena against the bots, any time")),
      h("span.rv", icon("chevron", 18))));
    this.app.strips(null, null);
    this.app.panel({ title: "Tournaments", back: "#/", body });
  }
}

export class ArenaLobby {
  constructor(app, id) {
    this.app = app;
    this.id = id;
    this.d = null;
    this.pairing = false;
    this.wantPair = autoPair.delete(id);
  }

  mount() {
    idle(this.app);
    this.render();
    if (!S.registered()) return;
    this.refresh();
    this.t = setInterval(() => this.refresh(), 5000);
    this.ct = setInterval(() => this._tick(), 1000);
  }
  destroy() {
    this.dead = true;
    clearInterval(this.t); clearInterval(this.ct); clearTimeout(this.pt);
    // leaving the lobby without a game: stop being offered as an opponent
    if (this.pairing && !this.launched) S.api("POST", `/arenas/${this.id}/pause`, {}).catch(() => {});
    if (this.app.board.setIdle) this.app.board.setIdle(false);
  }

  get now() { return this.d ? Date.now() + this.skew : Date.now(); }
  get running() { return !!this.d && this.d.arena.starts <= this.now && this.now < this.d.arena.ends; }
  get over() { return !!this.d && this.now >= this.d.arena.ends; }

  async refresh() {
    let d;
    try { d = await S.api("GET", `/arenas/${this.id}`); } catch (e) { if (!this.dead) { this.err = e; this.render(); } return; }
    if (this.dead) return;
    this.err = null;
    this.d = d;
    this.skew = d.now - Date.now();
    if (this.wantPair && !this.pairing && this.running && d.me) this.startPairing();
    if (this.pairing && this.over) this.stopPairing();
    this.render();
  }

  _tick() {
    if (!this.d) return;
    const a = this.d.arena;
    if (this.clockEl) this.clockEl.textContent = this.over ? "Finished" : this.running ? clockText(a.ends - this.now) : clockText(a.starts - this.now);
    // joined before the start: begin pairing the moment the arena opens
    if (this.wantPair && !this.pairing && this.running && this.d.me) this.startPairing();
  }

  async join() {
    try {
      await S.api("POST", `/arenas/${this.id}/join`, {});
      this.wantPair = true;
      toast(this.running ? "Joined. Finding you an opponent…" : "Joined. Pairing starts when the arena begins.");
      await this.refresh();
    } catch (e) { toast(e.message); }
  }

  startPairing() {
    if (this.pairing || this.launched || this.dead) return;
    this.pairing = true;
    this.wantPair = true;
    this.render();
    const step = async () => {
      if (!this.pairing || this.dead) return;
      let r;
      try { r = await S.api("POST", `/arenas/${this.id}/pair`, { pid: pidFor(this.d.arena) }); }
      catch (e) { toast(e.message); this.stopPairing(); return; }
      if (!this.pairing || this.dead) return;
      if (r.state === "paired" && r.room) { this.play(r.room); return; }
      if (!r.running) { this.stopPairing(); return; }
      this.pt = setTimeout(step, PAIR_MS);
    };
    step();
  }

  async stopPairing() {
    this.pairing = false;
    this.wantPair = false;
    clearTimeout(this.pt);
    this.render();
    await S.api("POST", `/arenas/${this.id}/pause`, {}).catch(() => {});
  }

  play(room) {
    this.launched = true;
    this.pairing = false;
    SFX.notify();
    const a = this.d.arena;
    const arena = {
      id: a.id, name: a.name,
      next: () => { autoPair.add(a.id); this.app.go(`#/arenas/${a.id}`); },
      leave: () => this.app.go(`#/arenas/${a.id}`),
    };
    this.app.launch(() => new OnlineGame(this.app, { kind: "friend", room, tcKey: a.tc, playerId: pidFor(a), arena }), "#/online");
  }

  render() {
    if (!S.registered()) {
      this.app.panel({ title: "Arena", back: "#/arenas", body: [needsSocial(this.app)] });
      return;
    }
    if (!this.d) {
      this.app.panel({ title: "Arena", back: "#/arenas", body: [this.err ? h("div.status-line.bad", icon("close", 16), h("span", this.err.message)) : h("p.note", "Loading the arena…")] });
      return;
    }
    const { arena: a, standings, me } = this.d;
    const myRank = standings.findIndex(p => p.uid === S.myId()) + 1;
    const mine = standings.find(p => p.uid === S.myId());
    this.clockEl = h("div.timer-big", "");
    const table = standings.length ? h("div.table-wrap", h("table.table.arena-table",
      h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Score"), h("th.wide-only", "Form"))),
      h("tbody", ...standings.map((p, i) => h(`tr${p.uid === S.myId() ? ".me" : ""}`,
        h("td.rank", String(i + 1)),
        h("td", h("div.arena-player", userAvatar(p, ".sm"), h("b", p.name), h("span.muted", ` ${p.rating}`),
          p.streak >= 2 ? h("span", { title: "On a streak: wins score 4" }, " 🔥") : null,
          p.state === "paired" ? h("small.muted", " playing") : null)),
        h("td.num", h("b", String(p.score))),
        h("td.wide-only", h("span.form", ...formMarks(p.form))))))))
      : h("p.note", "Nobody has joined yet.");
    const body = [
      h("div.card.arena-head",
        h("div", h("div.note", `${a.name}, ${tcLabel(a.tc)}`), this.clockEl,
          h("div.note", this.over ? "Final standings" : this.running ? "until the end" : "until it starts")),
        mine ? h("div", { style: { textAlign: "right" } }, h("div.note", myRank ? `You're #${myRank}` : "Your score"), h("div.big-num", String(mine.score))) : null),
    ];
    if (this.pairing) body.push(h("div.status-line.good", h("span.spinner"), h("span", "Looking for an opponent…")));
    else if (me && me.state === "paired") body.push(h("div.status-line", icon("bolt", 16), h("span", "You have a game in progress.")));
    else if (mine && mine.streak >= 2 && !this.over) body.push(h("div.status-line.good", h("span", "🔥"), h("span", "You're on a streak: wins score 4.")));
    body.push(table);
    body.push(h("p.note", "Results come straight from the game server. Games that start before the end still count."));

    const foot = [];
    if (this.over) {
      if (mine) foot.push(h("div.status-line" + (myRank <= 3 ? ".good" : ""), icon("trophy", 18), h("span", `You finished #${myRank} of ${standings.length}.`)));
      foot.push(h("button.btn.block", { onclick: () => this.app.go("#/arenas") }, "All arenas"));
    } else if (!me) {
      foot.push(h("button.btn.primary.big.block", { onclick: () => this.join() }, "Join arena"));
    } else if (me.state === "paired" && me.room) {
      foot.push(h("button.btn.primary.big.block", { onclick: () => this.play(me.room) }, "Return to your game"));
    } else if (this.pairing) {
      foot.push(h("button.btn.ghost.block", { onclick: () => this.stopPairing() }, "Pause"));
    } else if (this.running) {
      foot.push(h("button.btn.primary.big.block", { onclick: () => this.startPairing() }, me.games ? "Next game" : "Find a game"));
    } else {
      foot.push(h("div.status-line", icon("clock", 16), h("span", "You're in. Pairing starts when the arena begins; keep this screen open.")));
    }
    this.app.strips(null, null);
    this.app.panel({ title: a.name, back: "#/arenas", body, foot });
    this._tick();
  }
}
