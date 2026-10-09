// Vote Chess: two clubs play one daily game; each move is the one most of the club voted for (played at
// the deadline, or earlier by the club's owner). The game itself lives in a room on the game server,
// which this screen watches as a spectator; your vote is a move made on the board, shown as an arrow.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { toast } from "../ui/components.js";
import { MoveInput } from "../core/input.js";
import { kingSquare } from "../core/tree.js";
import { RoomClient } from "../net/room.js";
import * as S from "../net/social.js";

const POLL_MS = 15000;
const randomId = () => Math.random().toString(36).slice(2, 8);

export class VoteChess {
  constructor(app, vid) {
    this.app = app;
    this.vid = vid;
    this.chess = new Chess();
    this.input = new MoveInput(app, {
      getChess: () => (this.canVote() ? this.chess : null),
      canMove: (c) => this.canVote() && c === this.d.colour,
      premoveColor: () => null,
      onMove: (m) => this.vote(m),
    });
  }
  canVote() { return !!this.d && this.d.game.status === "running" && this.d.side === this.d.toMove && this.synced; }

  async mount() {
    this.app.setInGame(true);
    this.app.bindBoard(this.input.handlers());
    this.app.board.syncFromBoard(this.chess.board());
    this.app.panel({ title: "Vote Chess", back: "#/social/clubs", body: h("p.note", "Loading the game…") });
    await this.load();
    this.t = setInterval(() => this.load(), POLL_MS);
  }
  destroy() { this.dead = true; clearInterval(this.t); if (this.client) this.client.close(); this.app.board.setArrows([]); this.input.clear(); }
  onBoardSwap() { this.redraw(); }

  async load() {
    let d;
    try { d = await S.api("GET", `/votechess/${this.vid}`); } catch (e) { if (!this.d) this.app.panel({ title: "Vote Chess", back: "#/social/clubs", body: h("p.note", e.message) }); return; }
    if (this.dead) return;
    const first = !this.d;
    this.d = d;
    if (first) this.app.board.viewSide(d.colour, false);
    if (d.game.room && !this.client) {
      this.client = new RoomClient(d.game.room, `p-watch${randomId()}.Watcher.1200`, { onState: (s) => this._state(s), onError: () => {} });
    }
    this.render();
    this.arrows();
  }

  _state(s) {
    const v = s.view;
    if (!v || !v.moves) return;
    const c = new Chess();
    for (const m of v.moves) c.move(m);
    this.chess = c;
    this.synced = true;
    this.result = s.status === "over" ? s.result : null;
    this.redraw();
    this.render();
  }

  redraw() {
    const b = this.app.board;
    b.syncFromBoard(this.chess.board());
    const last = this.chess.history({ verbose: true }).pop();
    b.setLastMove(last ? last.from : null, last ? last.to : null);
    b.setCheck(this.chess.inCheck() ? kingSquare(this.chess, this.chess.turn()) : null);
    this.arrows();
  }

  // your vote in green, the club's leading move in blue
  arrows() {
    if (!this.d) return;
    const list = [];
    const top = this.d.tally[0];
    if (top && top.move !== this.d.myVote) list.push({ from: top.move.slice(0, 2), to: top.move.slice(2, 4), color: "rgba(91,143,214,.8)" });
    if (this.d.myVote) list.push({ from: this.d.myVote.slice(0, 2), to: this.d.myVote.slice(2, 4), color: "rgba(82,179,106,.85)" });
    this.app.board.setArrows(list);
  }

  async vote(m) {
    const move = m.from + m.to + (m.promotion || "");
    try {
      this.d = await S.api("POST", `/votechess/${this.vid}/vote`, { move });
      toast("Vote counted");
    } catch (e) { toast(e.message); }
    this.input.clear();
    this.render();
    this.arrows();
  }

  render() {
    if (this.dead || !this.d) return;
    const { game: g, side, toMove, tally, myVote, owner } = this.d;
    const club = (s) => (s === "a" ? g.a_name : g.b_name);
    const san = (uci) => { try { const c = new Chess(this.chess.fen()); const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return mv ? mv.san : uci; } catch { return uci; } };
    const body = [h("div.card", h("h3", `${g.a_name} (White) vs ${g.b_name} (Black)`), h("p.note", `You vote for ${club(side)}. ${g.tc.replace("d", "")} day${g.tc === "1d" ? "" : "s"} per move.`))];
    if (g.status === "done") body.push(h("div.status-line", icon("trophy", 18), h("span", `Finished: ${g.result === "1-0" ? `${g.a_name} won` : g.result === "0-1" ? `${g.b_name} won` : "a draw"}.`)));
    else if (g.status === "challenge") body.push(h("div.status-line", h("span", `Waiting for ${g.b_name} to accept.`)));
    else if (side === toMove) {
      body.push(h("div.status-line.good", h("span", `Your club's move. Make a move on the board to vote; the most popular one is played ${new Date(g.deadline).toLocaleString()}.`)));
      body.push(h("div.rows", ...(tally.length ? tally.map((t) => h("div.row", h("span.rt", h("b", san(t.move)), h("small", `${t.n} vote${t.n === 1 ? "" : "s"}${t.move === myVote ? ", including yours" : ""}`)))) : [h("p.note", "No votes yet.")])));
    } else body.push(h("div.status-line", h("span", `Waiting for ${club(toMove)} to move (by ${new Date(g.deadline).toLocaleString()}).`)));
    const foot = [];
    if (g.status === "running" && side === toMove && owner && tally.length) {
      foot.push(h("button.btn.primary.block", {
        onclick: async () => { try { this.d = await S.api("POST", `/votechess/${this.vid}/play`, {}); toast("Move played"); this.render(); } catch (e) { toast(e.message); } },
      }, "Play the leading move now"));
    }
    this.app.panel({ title: "Vote Chess", back: "#/social/clubs", body, foot });
  }
}
