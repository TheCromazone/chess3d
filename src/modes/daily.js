// Daily chess: correspondence games with friends, with 1-7 days per move or no limit. Each game is
// a room on the room server (rooms keep their state while nobody is connected); this device
// remembers your seat in each one.
import { Chess } from "chess.js";
import { h, icon, timeAgo } from "../ui/dom.js";
import { toast, segmented, tcLabel } from "../ui/components.js";
import { getDailyGames, upsertDaily, removeDaily } from "../store.js";
import { RoomClient, parsePlayerId } from "../net/room.js";
import { OnlineGame } from "./online-game.js";
import { notice } from "../ui/people.js";
import { SFX } from "../audio.js";

export const DAILY_PACES = [{ value: "1d", label: "1 day" }, { value: "3d", label: "3 days" }, { value: "7d", label: "7 days" }, { value: "inf", label: "No limit" }];
let pace = "3d";

// "2 days left", "5 h left", "40 min left"
export function timeLeft(ms) {
  if (ms <= 0) return "out of time";
  const h = ms / 3600000;
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${Math.floor(h)} h left`;
  return `${Math.max(1, Math.floor(ms / 60000))} min left`;
}

// connect just long enough to read a room's state
function peek(entry, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; c.close(); resolve(v); } };
    const c = new RoomClient(entry.room, entry.playerId, { onState: (s) => finish(s), onError: () => {} });
    setTimeout(() => finish(null), timeoutMs);
  });
}

// read one game's room and update its entry; returns the fresh entry (or null if unreachable)
async function check(e) {
  const s = await peek(e);
  if (!s) return null;
  const v = s.view;
  const myColor = v ? (v.white === e.playerId ? "w" : v.black === e.playerId ? "b" : null) : e.myColor;
  const oppId = v && myColor ? (myColor === "w" ? v.black : v.white) : null;
  const turn = v && v.moves ? (v.moves.length % 2 === 0 ? "w" : "b") : null;
  let result = null;
  if (s.status === "over" && s.result) result = s.result.draw ? "draw" : (s.result.winner === e.playerId ? "won" : "lost");
  // per-move deadline for whoever is to move (daily games with a time limit)
  const deadline = v && v.tc && v.tc.perMove && s.status === "playing" && v.clock.lastAt !== null && turn
    ? Date.now() + (v.clock[turn] - Math.max(0, (v.serverNow || Date.now()) - v.clock.lastAt)) : null;
  return upsertDaily({
    room: e.room, playerId: e.playerId, myColor, tc: v && v.tcKey ? v.tcKey : e.tc || null, deadline,
    opponent: oppId ? parsePlayerId(oppId).name : e.opponent || null,
    moves: v ? v.moves.length : 0, status: s.status, turn, result,
    lastMove: v && v.san && v.san.length ? v.san[v.san.length - 1] : null,
  });
}

// While the app is open, look at your daily games every few minutes and say when it's your move
// (chess.com notifies you the same way). Skipped while you're in a game.
export function watchDaily(app) {
  const announced = new Set(getDailyGames().filter(e => e.status === "playing" && e.turn === e.myColor).map(e => `${e.room}:${e.moves}`));
  const run = async () => {
    if (document.hidden || document.getElementById("app")?.classList.contains("in-game")) return;
    for (const e of getDailyGames().filter(x => x.status === "playing" || x.status === "waiting")) {
      const f = await check(e);
      if (!f || f.status !== "playing" || f.turn !== f.myColor) continue;
      const key = `${f.room}:${f.moves}`;
      if (announced.has(key)) continue;
      announced.add(key);
      if (app.controller instanceof OnlineGame && app.controller.room === f.room) continue;
      SFX.notify();
      notice({
        avatar: h("span.ri", icon("calendar", 20)),
        title: `Your move vs ${f.opponent || "your opponent"}`,
        text: `${f.lastMove ? `They played ${f.lastMove}. ` : ""}${f.deadline ? timeLeftText(f.deadline - Date.now()) : "Daily game"}`,
        ms: 15000,
        actions: [{ label: "Play", primary: true, onClick: () => app.launch(() => new OnlineGame(app, { kind: "daily", room: f.room, playerId: f.playerId, tcKey: f.tc || "inf" }), "#/online") }],
      });
    }
  };
  setInterval(run, 150000);
  setTimeout(run, 20000);
}
const timeLeftText = (ms) => { const t = timeLeft(ms); return t[0].toUpperCase() + t.slice(1) + "."; };

export class DailyScreen {
  constructor(app) { this.app = app; }
  destroy() { this.dead = true; }

  mount() {
    this.app.setLobby(true);
    this.app.board.syncFromBoard(new Chess().board());
    this.app.board.viewSide("w", false);
    if (this.app.board.setIdle) this.app.board.setIdle(true);
    this.render();
    this.refresh();
  }

  async refresh() {
    await Promise.all(getDailyGames().map((e) => (this.dead ? null : check(e))));
    if (!this.dead) this.render();
  }

  open(e) {
    this.app.launch(() => new OnlineGame(this.app, { kind: "daily", room: e.room, playerId: e.playerId, tcKey: e.tc || "inf" }), "#/online");
  }

  render() {
    const games = getDailyGames();
    const yourMove = games.filter(e => e.status === "playing" && e.turn && e.turn === e.myColor);
    const rows = h("div.rows");
    for (const e of games) {
      let state, badge = null;
      if (e.status === "waiting" || !e.status) state = "Waiting for your friend to open the link";
      else if (e.status === "over") state = e.result === "won" ? "You won" : e.result === "lost" ? "You lost" : "Drawn";
      else if (e.turn === e.myColor) { state = "Your move"; badge = h("span.badge", "Your move"); }
      else state = "Their move";
      if (e.status === "playing" && e.deadline) state += ` (${timeLeft(e.deadline - Date.now())})`;
      rows.appendChild(h("div", { style: { display: "flex", gap: "6px", alignItems: "stretch" } },
        h("button.row", { onclick: () => this.open(e), style: { flex: "1" } },
          h("span.ri", icon("calendar", 20)),
          h("span.rt", h("b", e.opponent ? `vs ${e.opponent}` : "New daily game"),
            h("small", `${state}${e.moves ? `, ${Math.ceil(e.moves / 2)} move${Math.ceil(e.moves / 2) === 1 ? "" : "s"}` : ""}${e.lastMove ? `, last ${e.lastMove}` : ""}${e.tc && e.tc !== "inf" ? `, ${tcLabel(e.tc)} per move` : ""}. Updated ${timeAgo(e.updated || e.created)}`)),
          badge || h("span.rv", icon("chevron", 18))),
        e.status === "over" || e.status === "waiting" ? h("button.btn.ghost", { "aria-label": "Remove from list", title: "Remove from list", onclick: () => { removeDaily(e.room); this.render(); } }, icon("trash", 16)) : null));
    }
    this.app.strips(null, null);
    this.app.panel({
      title: "Daily chess", back: "#/",
      body: [
        h("p", { style: { color: "var(--ink-2)" } }, "Correspondence games with friends. Make a move, close the browser, and come back later. Miss the deadline for a move and you lose on time."),
        yourMove.length ? h("div.status-line.good", icon("bolt", 16), h("span", `It's your move in ${yourMove.length} game${yourMove.length === 1 ? "" : "s"}.`)) : null,
        games.length ? rows : h("p.note", "No daily games yet. Start one and send the link to a friend."),
        games.length ? h("button.btn.ghost.small", { onclick: () => { toast("Checking your games…"); this.refresh(); }, style: { alignSelf: "flex-start" } }, icon("undo", 16), "Refresh") : null,
        h("div.field", h("div.lbl", "Time per move for a new game"), segmented(DAILY_PACES, pace, (v) => { pace = v; })),
      ],
      foot: h("button.btn.primary.big.block", { onclick: () => this.app.launch(() => new OnlineGame(this.app, { kind: "daily", tcKey: pace }), "#/online") }, icon("plus", 18), "New daily game"),
    });
  }
}
