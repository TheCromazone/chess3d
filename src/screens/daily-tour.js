// Daily tournaments, like chess.com's: players sign up; each round splits them into groups that play a
// double round robin of daily games (one with each colour against everyone in the group), and group
// winners go through until one group is left. The game server pairs the groups and reads every result
// from the game rooms (server/social.ts).
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { openModal, toast, segmented } from "../ui/components.js";
import { userAvatar } from "../ui/people.js";
import { getProfile } from "../store.js";
import { OnlineGame } from "../modes/online-game.js";
import { makePlayerId } from "../net/room.js";
import * as S from "../net/social.js";

const OUT = { w: "1–0", b: "0–1", draw: "½–½", "w-forfeit": "1–0 forfeit", "b-forfeit": "0–1 forfeit", "double-forfeit": "0–0" };
const pidFor = () => { const p = getProfile(); return makePlayerId(p.name, p.ratings.rapid.r, S.myCode()); };
const perMove = (tc) => `${tc.replace("d", "")} day${tc === "1d" ? "" : "s"} per move`;
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".5", "½").replace(/^0½/, "½"));
const fmtSb = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export function dailyTourStatus(t) {
  if (t.status === "signup") return `Sign-ups close ${new Date(t.starts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
  if (t.status === "running") return `Round ${t.round} in play`;
  if (t.status === "done") return t.winner_name ? `Won by ${t.winner_name}` : "Finished";
  return "Cancelled: not enough players";
}

// the "create a daily tournament" form
export function createDailyTour(app) {
  let tc = "3d", size = 6;
  const name = h("input.input", { maxlength: "60", placeholder: "e.g. Friday Daily Open", "aria-label": "Tournament name" });
  const go = h("button.btn.primary.block", {
    onclick: async () => {
      go.disabled = true;
      try { const r = await S.api("POST", "/dailytours", { name: name.value, tc, size, pid: pidFor() }); m.close(); app.go(`#/dailytour/${r.id}`); }
      catch (e) { toast(e.message); go.disabled = false; }
    },
  }, icon("plus", 18), "Create tournament");
  const m = openModal({
    title: "New daily tournament",
    sub: "Players sign up for two days (or until you start it). Each round, groups play everyone in their group twice, once with each colour, and group winners go through.",
    body: [
      h("div.field", h("label", "Name"), name),
      h("div.field", h("div.lbl", "Time per move"), segmented(["1d", "2d", "3d", "5d", "7d"].map((v) => ({ value: v, label: v.replace("d", "") + (v === "1d" ? " day" : " days") })), tc, (v) => { tc = v; })),
      h("div.field", h("div.lbl", "Players per group"), segmented([4, 6, 8, 10].map((v) => ({ value: v, label: String(v) })), size, (v) => { size = v; })),
      go,
    ],
  });
  setTimeout(() => name.focus(), 50);
}

export class DailyTourScreen {
  constructor(app, id) { this.app = app; this.id = id; }

  mount() {
    this.app.setLobby(true);
    this.app.board.syncFromBoard(new Chess().board());
    this.app.board.viewSide("w", false);
    if (this.app.board.setIdle) this.app.board.setIdle(true);
    this.render(null);
    this.load();
    this.t = setInterval(() => this.load(), 30000);
  }
  destroy() { this.dead = true; clearInterval(this.t); if (this.app.board.setIdle) this.app.board.setIdle(false); }

  async load() {
    if (!S.registered()) { this.render(null, new Error("Turn on Social to play daily tournaments.")); return; }
    try { const d = await S.api("GET", `/dailytours/${this.id}`); if (!this.dead) this.render(d); }
    catch (e) { if (!this.dead) this.render(null, e); }
  }

  async act(path, body = {}, msg) {
    try { const d = await S.api("POST", `/dailytours/${this.id}/${path}`, body); if (msg) toast(msg); if (!this.dead) this.render(d); }
    catch (e) { toast(e.message); }
  }

  play(g, t) {
    this.app.launch(() => new OnlineGame(this.app, { kind: "daily", room: g.room, tcKey: t.tc, playerId: g.mine.pid, forceColor: g.mine.color }), "#/online");
  }

  render(d, err) {
    const body = [];
    let foot = null;
    if (err) body.push(h("div.status-line.bad", icon("close", 16), h("span", err.message)));
    else if (!d) body.push(h("p.note", "Loading the tournament…"));
    else {
      const t = d.tournament;
      body.push(h("p", { style: { color: "var(--ink-2)" } }, `${dailyTourStatus(t)}. ${perMove(t.tc)}, groups of up to ${t.size}. Created by ${t.owner_name || "a player"}.`));
      if (t.status === "done" && t.winner_name) body.push(h("div.status-line.good", icon("trophy", 16), h("span", `${t.winner_name} won the tournament.`)));
      if (d.me.out) body.push(h("div.status-line", h("span", `You went out in round ${d.me.out}.`)));
      if (t.status === "signup") {
        body.push(h("section", h("h3", `Players (${d.players.length})`), h("div.rows",
          ...d.players.map((p) => h("div.row", userAvatar(p, ".sm"), h("span.rt", h("b", p.name), h("small", `Rapid ${p.rating ?? "?"}`)))))));
        const btns = [];
        if (!d.me.joined) btns.push(h("button.btn.primary.big.block", { onclick: () => this.act("join", { pid: pidFor() }, "You're in") }, icon("plus", 18), "Join"));
        else btns.push(h("button.btn.ghost.block", { onclick: () => this.act("leave", {}, "You've left the tournament") }, "Leave"));
        if (d.me.owner) btns.push(h("button.btn.block", { onclick: () => this.act("start", {}, "The tournament has started"), disabled: d.players.length < 3 }, d.players.length < 3 ? "Needs 3 players to start" : "Start now"));
        foot = h("div", { style: { display: "grid", gap: "8px" } }, ...btns);
      } else if (d.groups.length) {
        const mine = d.games.filter((g) => g.mine && !g.outcome);
        if (mine.length) {
          body.push(h("section", h("h3", `Your games (${mine.length})`), h("div.rows", ...mine.map((g) => h("div.row",
            h("span.rt", h("b", `${g.mine.color === "w" ? "White" : "Black"} against ${g.mine.color === "w" ? g.black.name : g.white.name}`), h("small", perMove(t.tc))),
            h("button.btn.small.primary", { onclick: () => this.play(g, t) }, "Play"))))));
        }
        const groups = [...d.groups].sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.grp - b.grp);
        for (const g of groups) {
          body.push(h("section",
            h("h3", d.groups.length === 1 ? (t.round > 1 ? `Round ${t.round}: the final group` : `Round ${t.round}`) : `Round ${t.round}, group ${g.grp + 1}${g.mine ? " (yours)" : ""}`),
            h("div.table-wrap", h("table.table.arena-table",
              h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Points"), h("th.wide-only", { title: "Sonneborn–Berger tie-break" }, "SB"))),
              h("tbody", ...g.rows.map((r, i) => h(`tr${r.uid === S.myId() ? ".me" : ""}`,
                h("td.rank", String(i + 1)),
                h("td", h("div.arena-player", userAvatar(r, ".sm"), h("b", r.name))),
                h("td.num", h("b", fmt(r.points))),
                h("td.num.wide-only", fmtSb(r.sb)))))))));
        }
        const shown = d.games.filter((g) => !g.mine || g.outcome);
        if (shown.length) {
          body.push(h("details.league-how", h("summary", `Games (${shown.length})`), h("div.rows",
            ...shown.map((g) => h("div.row.swiss-game", h("span.rt", h("b", `${g.white.name} – ${g.black.name}`), h("small", g.outcome ? OUT[g.outcome] || g.outcome : "In play")))))));
        }
      }
    }
    this.app.strips(null, null);
    this.app.panel({ title: d ? d.tournament.name : "Daily tournament", back: "#/arenas", body, foot });
  }
}
