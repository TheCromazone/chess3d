// Daily chess: untimed correspondence games with friends. Each game is a room on the room server
// (rooms keep their state while nobody is connected); this device remembers your seat in each one.
import { Chess } from "chess.js";
import { h, icon, timeAgo } from "../ui/dom.js";
import { toast } from "../ui/components.js";
import { getDailyGames, upsertDaily, removeDaily } from "../store.js";
import { RoomClient, parsePlayerId } from "../net/room.js";
import { OnlineGame } from "./online-game.js";

// connect just long enough to read a room's state
function peek(entry, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; c.close(); resolve(v); } };
    const c = new RoomClient(entry.room, entry.playerId, { onState: (s) => finish(s), onError: () => {} });
    setTimeout(() => finish(null), timeoutMs);
  });
}

export class DailyScreen {
  constructor(app) { this.app = app; }
  destroy() { this.dead = true; }

  mount() {
    this.app.board.syncFromBoard(new Chess().board());
    this.app.board.viewSide("w", false);
    if (this.app.board.setIdle) this.app.board.setIdle(true);
    this.render();
    this.refresh();
  }

  async refresh() {
    const games = getDailyGames();
    await Promise.all(games.map(async (e) => {
      const s = await peek(e);
      if (this.dead || !s) return;
      const v = s.view;
      const myColor = v ? (v.white === e.playerId ? "w" : v.black === e.playerId ? "b" : null) : e.myColor;
      const oppId = v && myColor ? (myColor === "w" ? v.black : v.white) : null;
      let turn = null;
      if (v && v.moves) turn = v.moves.length % 2 === 0 ? "w" : "b";
      let result = null;
      if (s.status === "over" && s.result) {
        const r = s.result;
        result = r.draw ? "draw" : (r.winner === e.playerId ? "won" : "lost");
      }
      upsertDaily({
        room: e.room, playerId: e.playerId, myColor,
        opponent: oppId ? parsePlayerId(oppId).name : e.opponent || null,
        moves: v ? v.moves.length : 0, status: s.status, turn, result,
        lastMove: v && v.san && v.san.length ? v.san[v.san.length - 1] : null,
      });
    }));
    if (!this.dead) this.render();
  }

  open(e) {
    this.app.launch(() => new OnlineGame(this.app, { kind: "daily", room: e.room, playerId: e.playerId, tcKey: "inf" }), "#/online");
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
      rows.appendChild(h("div", { style: { display: "flex", gap: "6px", alignItems: "stretch" } },
        h("button.row", { onclick: () => this.open(e), style: { flex: "1" } },
          h("span.ri", icon("calendar", 20)),
          h("span.rt", h("b", e.opponent ? `vs ${e.opponent}` : "New daily game"),
            h("small", `${state}${e.moves ? `, ${Math.ceil(e.moves / 2)} move${Math.ceil(e.moves / 2) === 1 ? "" : "s"}` : ""}${e.lastMove ? `, last ${e.lastMove}` : ""}. Updated ${timeAgo(e.updated || e.created)}`)),
          badge || h("span.rv", icon("chevron", 18))),
        e.status === "over" || e.status === "waiting" ? h("button.btn.ghost", { "aria-label": "Remove from list", title: "Remove from list", onclick: () => { removeDaily(e.room); this.render(); } }, icon("trash", 16)) : null));
    }
    this.app.strips(null, null);
    this.app.panel({
      title: "Daily chess", back: "#/",
      body: [
        h("p", { style: { color: "var(--ink-2)" } }, "Correspondence games with friends. There's no clock: make a move whenever you like, close the browser, and come back later."),
        yourMove.length ? h("div.status-line.good", icon("bolt", 16), h("span", `It's your move in ${yourMove.length} game${yourMove.length === 1 ? "" : "s"}.`)) : null,
        games.length ? rows : h("p.note", "No daily games yet. Start one and send the link to a friend."),
        games.length ? h("button.btn.ghost.small", { onclick: () => { toast("Checking your games…"); this.refresh(); }, style: { alignSelf: "flex-start" } }, icon("undo", 16), "Refresh") : null,
      ],
      foot: h("button.btn.primary.big.block", { onclick: () => this.app.launch(() => new OnlineGame(this.app, { kind: "daily", tcKey: "inf" }), "#/online") }, icon("plus", 18), "New daily game"),
    });
  }
}
