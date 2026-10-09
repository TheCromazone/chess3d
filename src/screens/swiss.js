// Swiss tournaments: a fixed number of rounds; each round pairs players with similar scores who
// haven't met. The game server pairs and scores (reading each result from the game room), and
// moves the tournament along whenever a player's screen checks in.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { toast, tcLabel } from "../ui/components.js";
import { userAvatar } from "../ui/people.js";
import { getProfile, timeClass } from "../store.js";
import { OnlineGame } from "../modes/online-game.js";
import { makePlayerId, peekRoom } from "../net/room.js";
import { SFX } from "../audio.js";
import * as S from "../net/social.js";

const PING_MS = 3000;
const OUTCOME = { w: "1–0", b: "0–1", draw: "½–½", "w-forfeit": "1–0 (forfeit)", "b-forfeit": "0–1 (forfeit)", "double-forfeit": "0–0 (no-shows)" };

// one player id per tournament, so the server can tell which seat in a room is yours
export function swissPid(t) {
  const key = "swiss-pid-" + t.id;
  let pid = null;
  try { pid = sessionStorage.getItem(key); } catch { /* private mode */ }
  if (!pid) {
    const p = getProfile();
    pid = makePlayerId(p.name, p.ratings[timeClass(t.tc) || "blitz"].r, S.myCode());
    try { sessionStorage.setItem(key, pid); } catch { /* noop */ }
  }
  return pid;
}
const launched = new Set();     // games already opened from the lobby

export function swissStatus(t, now) {
  if (t.status === "done") return "Finished";
  if (t.status === "running") return `Round ${t.round} of ${t.rounds}`;
  const m = Math.max(1, Math.ceil((t.starts - now) / 60000));
  return `Starts in ${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`}`;
}

export class SwissLobby {
  constructor(app, id) { this.app = app; this.id = id; this.d = null; }
  mount() {
    this.app.setLobby(true);
    this.app.board.syncFromBoard(new Chess().board());
    this.app.board.viewSide("w", false);
    if (this.app.board.setIdle) this.app.board.setIdle(true);
    this.render();
    if (!S.registered()) return;
    this.refresh();
    this.t = setInterval(() => this.refresh(), PING_MS);
  }
  destroy() { this.dead = true; clearInterval(this.t); clearInterval(this.waitT); if (this.app.board.setIdle) this.app.board.setIdle(false); }

  async refresh() {
    let d;
    try {
      // while you're in it, checking in keeps you in the next pairing
      d = this.d && this.d.me && this.d.me.joined
        ? await S.api("POST", `/swiss/${this.id}/ping`, { pid: swissPid(this.d.tournament) })
        : await S.api("GET", `/swiss/${this.id}`);
    } catch (e) { if (!this.dead) { this.err = e; this.render(); } return; }
    if (this.dead) return;
    this.err = null;
    this.d = d;
    this.render();
    // a new round has paired you: open the game (like chess.com)
    const g = d.me && d.me.joined && d.me.game;
    if (g && !launched.has(g.room)) this.play(g);
  }

  async join() {
    try {
      const t = this.d.tournament;
      this.d = await S.api("POST", `/swiss/${this.id}/join`, { pid: swissPid(t) });
      toast(t.status === "running" ? "Joined. You'll be paired in the next round." : "Joined. Keep this screen open; the first round pairs at the start.");
      this.render();
    } catch (e) { toast(e.message); }
  }
  async withdraw() {
    try { this.d = await S.api("POST", `/swiss/${this.id}/withdraw`, {}); toast("Withdrawn"); this.render(); } catch (e) { toast(e.message); }
  }

  // White joins the room first, so the room gives each player the colour the pairing chose
  async play(g) {
    launched.add(g.room);
    SFX.notify();
    const t = this.d.tournament;
    const go = () => {
      clearInterval(this.waitT);
      if (this.dead) return;
      const swiss = { id: t.id, name: t.name, round: t.round, back: () => this.app.go(`#/swiss/${t.id}`) };
      this.app.launch(() => new OnlineGame(this.app, { kind: "friend", room: g.room, tcKey: t.tc, playerId: swissPid(t), swiss }), "#/online");
    };
    if (g.color === "w") { go(); return; }
    this.waiting = true;
    this.render();
    const started = Date.now();
    this.waitT = setInterval(async () => {
      const st = await peekRoom(g.room).catch(() => null);
      if ((st && st.seats.length >= 1) || Date.now() - started > 60000) go();
    }, 1000);
  }

  render() {
    if (!S.registered()) {
      this.app.panel({ title: "Swiss", back: "#/arenas", body: [h("div.card", h("h3", "Turn on Social to play tournaments"),
        h("p.note", "Tournaments pair you with other players, so they use your social profile: a key saved on this device, no sign-up."),
        h("button.btn.primary", { onclick: () => this.app.go("#/social"), style: { marginTop: "10px" } }, icon("users", 18), "Open Social"))] });
      return;
    }
    if (!this.d) {
      this.app.panel({ title: "Swiss", back: "#/arenas", body: [this.err ? h("div.status-line.bad", icon("close", 16), h("span", this.err.message)) : h("p.note", "Loading the tournament…")] });
      return;
    }
    const { tournament: t, standings, round, me, now } = this.d;
    const mineIdx = standings.findIndex((p) => p.uid === S.myId());
    const body = [
      h("div.card.arena-head",
        h("div", h("div.note", `${t.name}, ${tcLabel(t.tc)}, ${t.rounds} rounds`), h("div.timer-big", swissStatus(t, now))),
        me && me.joined ? h("div", { style: { textAlign: "right" } }, h("div.note", mineIdx >= 0 ? `You're #${mineIdx + 1}` : "Your score"), h("div.big-num", String(me.score))) : null),
    ];
    if (this.waiting) body.push(h("div.status-line.good", h("span.spinner"), h("span", "Waiting for White to arrive…")));
    else if (me && me.game) body.push(h("div.status-line.good", icon("bolt", 16), h("span", `Round ${t.round}: you have ${me.game.color === "w" ? "White" : "Black"} against ${me.game.opponent.name}.`)));
    else if (me && me.joined && t.status === "running") body.push(h("div.status-line", h("span.spinner"), h("span", "Waiting for this round to finish. The next one pairs automatically.")));
    if (round.length) {
      body.push(h("div.lbl.note", `Round ${t.round}`));
      body.push(h("div.rows", ...round.map((g) => h("div.row.swiss-game",
        h("span.rt", h("b", `${g.white.name} – ${g.black.name}`), h("small", g.outcome ? OUTCOME[g.outcome] || g.outcome : "Playing"))))));
    }
    body.push(standings.length ? h("div.table-wrap", h("table.table.arena-table",
      h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Score"), h("th.wide-only", { title: "Buchholz: your opponents' scores added up" }, "Tie-break"), h("th.wide-only", "Games"))),
      h("tbody", ...standings.map((p, i) => h(`tr${p.uid === S.myId() ? ".me" : ""}`,
        h("td.rank", String(i + 1)),
        h("td", h("div.arena-player", userAvatar(p, ".sm"), h("b", p.name), h("span.muted", ` ${p.rating ?? ""}`), p.withdrawn ? h("small.muted", " withdrawn") : null)),
        h("td.num", h("b", String(p.score))),
        h("td.num.wide-only", String(p.buchholz)),
        h("td.num.wide-only", String(p.games + (p.byes || 0)))))))) : h("p.note", "Nobody has joined yet."));
    body.push(h("p.note", "A win is 1 point, a draw half. Each round pairs players on the same score who haven't met; an odd player out gets a bye (1 point). Results come from the game server; a player who doesn't turn up within 90 seconds forfeits."));
    const foot = [];
    if (t.status === "done") foot.push(h("button.btn.block", { onclick: () => this.app.go("#/arenas") }, "All tournaments"));
    else if (!me || !me.joined) foot.push(h("button.btn.primary.big.block", { onclick: () => this.join() }, "Join"));
    else if (me.game) foot.push(h("button.btn.primary.big.block", { onclick: () => { launched.delete(me.game.room); this.play(me.game); } }, "Go to your game"));
    else foot.push(h("button.btn.ghost.block", { onclick: () => this.withdraw() }, "Withdraw"));
    this.app.strips(null, null);
    this.app.panel({ title: t.name, back: "#/arenas", body, foot });
  }
}
