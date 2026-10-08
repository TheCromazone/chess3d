// Online play over the room server: quick pairing (public pool rooms) or a private invite link.
// Moves are applied optimistically and reconciled against the server's authoritative move list.
import { Chess } from "chess.js";
import { createChess } from "../core/chess960.js";
import { BaseGame } from "./base-game.js";
import { h, icon, copyText } from "../ui/dom.js";
import { confirmModal, openModal, toast, tcLabel, closeAllModals } from "../ui/components.js";
import { RoomClient, makePlayerId, parsePlayerId, findMatch } from "../net/room.js";
import { getProfile, applyRating, timeClass, unlock, getSettings, getDaily, upsertDaily } from "../store.js";
import { SFX } from "../audio.js";
import * as Social from "../net/social.js";
import { userAvatar, presenceText } from "../ui/people.js";

function myRatingFor(tcKey) {
  const cls = timeClass(tcKey) || "rapid";
  return getProfile().ratings[cls].r;
}

export class OnlineGame extends BaseGame {
  // cfg: { kind: "pool"|"friend", room?, tcKey, client? (already matched) }
  constructor(app, cfg) {
    const me = getProfile();
    const tcKey = cfg.tcKey || "10+0";
    super(app, {
      ...cfg, tcKey, mode: "online",
      players: { w: { name: me.name, avatar: me.avatar }, b: { name: "Opponent", avatar: { emoji: "♟", bg: "#3a3f4a" } } },
      myColor: null,
    });
    this.kind = cfg.kind === "daily" || (cfg.room && cfg.room.startsWith("daily-")) ? "daily" : (cfg.kind || "friend");
    this.phase = "connecting";
    this.myRating = myRatingFor(tcKey);
    // daily games keep their seat in localStorage so they survive closing the browser
    const daily = this.kind === "daily" && cfg.room ? getDaily(cfg.room) : null;
    this.playerId = cfg.playerId || (daily && daily.playerId) || sessionStorage.getItem("mp-pid-" + (cfg.room || "")) || makePlayerId(me.name, this.myRating);
    this.room = cfg.room || null;
    this.client = cfg.client || null;
    this.flagSentAt = 0;
    this.answeredDraw = null;
    this.serverMoves = 0;
    this.sentConfig = false;
  }

  title() { return this.kind === "pool" ? `Online ${tcLabel(this.tcKey)}` : this.kind === "daily" ? "Daily game" : "Play a friend"; }
  bottomColor() { return this.myColor || "w"; }
  canMove(c) { return this.phase === "playing" && c === this.myColor; }
  premoveColor() { return this.phase === "playing" ? this.myColor : null; }

  mount() {
    super.mount();
    if (this.kind === "pool" && !this.client) this._search();
    else this._join();
    this.app.leaveGuard = async () => {
      if (this.kind === "daily") return true;   // correspondence: come back any time
      if (this.result || !this.myColor || this.phase !== "playing") return true;
      const ok = await confirmModal({ title: "Leave and resign?", sub: "Leaving a live game counts as a loss.", yes: "Resign and leave", danger: true });
      if (ok) this.client && this.client.action({ t: "resign" });
      return ok;
    };
  }

  destroy() {
    super.destroy();
    this.dead = true;
    if (this._onVis) document.removeEventListener("visibilitychange", this._onVis);
    document.title = "Chess 3D";
    clearInterval(this._lobbyTimer);
    if (this.search) this.search.cancel();
    if (this.client) this.client.close();
    const params = new URLSearchParams(location.search);
    if (params.has("room")) {
      params.delete("room"); params.delete("tc");
      history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
    }
  }

  // ---------- connection ----------
  _search() {
    this.phase = "searching";
    this._renderLobby();
    this.search = findMatch(this.tcKey, this.playerId, (p) => { if (p.phase === "waiting") this._renderLobby(); });
    this.search.promise.then(({ room, client }) => {
      if (this.dead) { client.close(); return; }   // matched just as the user left
      this.search = null;
      this.room = room;
      this.client = client;
      SFX.notify();
      this._takeClient();
    }).catch((e) => {
      this.search = null;
      if (this.dead || this.phase !== "searching") return;
      this.phase = "failed";
      this._renderLobby(e.message);
    });
    this._searchStarted = Date.now();
    this._lobbyTimer = setInterval(() => { if (this.phase === "searching") this._renderLobbyTime(); }, 1000);
  }

  _join() {
    if (!this.room) {
      this.room = (this.kind === "daily" ? "daily-" : "") + Math.random().toString(36).slice(2, 8);
    }
    sessionStorage.setItem("mp-pid-" + this.room, this.playerId);
    if (this.kind === "daily") upsertDaily({ room: this.room, playerId: this.playerId });
    const params = new URLSearchParams(location.search);
    params.set("room", this.room);
    if (this.tcKey && !params.get("tc")) params.set("tc", this.tcKey);
    history.replaceState(null, "", location.pathname + "?" + params + "#/online");
    this.client = new RoomClient(this.room, this.playerId, {});
    this._takeClient();
  }

  _takeClient() {
    clearInterval(this._lobbyTimer);
    this.client.rebind({
      onState: (s) => this._state(s),
      onError: (err) => { if (!/not your turn|already/.test(err)) toast(err); this._resyncFromServer(); },
      onStatus: (st) => { if (st === "disconnected" && !this.result) this._setNote("Connection lost. Reconnecting…"); if (st === "open") this._setNote(null); },
    });
  }

  // ---------- server state ----------
  _state(s) {
    this.lastState = s;
    if (s.status === "waiting") {
      this.phase = this.kind === "pool" ? "searching" : "waiting";
      this._renderLobby();
      return;
    }
    const v = s.view;
    if (!v) return;
    // the opponent asked for a rematch: the room was reset under us
    if (this.result && s.status === "playing" && v.moves.length === 0) {
      closeAllModals();
      this._resetLocal();
      toast("Rematch started");
    }
    const color = v.white === s.you ? "w" : v.black === s.you ? "b" : null;
    if (this.myColor !== color || !this._seatedOnce) {
      this._seatedOnce = true;
      this.myColor = color;
      const me = getProfile();
      const oppId = color === "w" ? v.black : v.white;
      const opp = parsePlayerId(oppId);
      const mine = { name: me.name, rating: this.myRating, avatar: me.avatar };
      const theirs = { name: opp.name, rating: opp.rating, avatar: { emoji: "♟", bg: "#3a4a5a" } };
      if (color) {
        this.players = { [color]: mine, [color === "w" ? "b" : "w"]: theirs };
        this.oppRating = opp.rating || 1200;
      } else {
        this.players = { w: parsePlayerIdAsPlayer(v.white), b: parsePlayerIdAsPlayer(v.black) };
      }
      this.app.board.viewSide(color || "w", false);
      this._buildPanel();
      if (color) toast(color === "w" ? "You play White" : "You play Black");
      else toast("Spectating this game");
    }

    const wasV2 = this.v2;
    this.v2 = (v.v || 1) >= 2;
    if (this.v2 !== wasV2) { this._renderChat(); this._renderControls(); }

    // time control: the first seat (White) configures it from the room's agreed setting
    if (v.phase !== "config") this.sentConfig = false;   // a later reset needs a fresh config
    if (v.phase === "config") {
      this.phase = "config";
      if (this.myColor === "w" && !this.sentConfig) {
        this.sentConfig = true;
        const tc = this.tcKey || new URLSearchParams(location.search).get("tc") || "10+0";
        this.client.action({ t: "config", tc: this.v2 || SERVER_TCS.includes(tc) ? tc : nearestTc(tc) });
      }
      this._setNote(this.myColor === "w" ? "Starting…" : "Waiting for White to start the clock…");
      this.renderStrips();
      return;
    }
    if (v.tcKey && v.tcKey !== this.tcKey) { this.tcKey = v.tcKey; }

    // moves: reconcile
    this._syncMoves(v.moves);

    if (this.kind === "daily" && this.myColor) {
      const oppId = this.myColor === "w" ? v.black : v.white;
      upsertDaily({ room: this.room, playerId: this.playerId, myColor: this.myColor, opponent: parsePlayerId(oppId).name, moves: v.moves.length, status: s.status });
    }

    // clocks from the server
    if (v.tc) {
      const now = performance.now();
      const elapsed = v.clock.lastAt !== null ? Math.max(0, (v.serverNow || Date.now()) - v.clock.lastAt) : 0;
      const turn = this.chess.turn();
      this.clock = this.clock || { inc: v.tc.inc * 1000 };
      this.clock.inc = v.tc.inc * 1000;
      this.clock.w = v.clock.w; this.clock.b = v.clock.b;
      if (v.clock.lastAt !== null && s.status === "playing") { this.clock[turn] = Math.max(0, v.clock[turn] - elapsed); this.clock.active = turn; this.clock.lastTs = now; }
      else this.clock.active = null;
    } else this.clock = null;

    // opponent presence
    if (s.status === "playing" && this.myColor) {
      if (s.connected < 2) { if (!this._oppGoneAt) this._oppGoneAt = Date.now(); this._setNote("Your opponent disconnected. If they don't return, you can claim the win when their clock runs out."); }
      else { this._oppGoneAt = null; this._setNote(null); }
    }

    // draw offers
    if (v.drawOffer && this.myColor && v.drawOffer !== this.myColor && this.answeredDraw !== v.drawOffer + ":" + v.moves.length && s.status === "playing") {
      this.answeredDraw = v.drawOffer + ":" + v.moves.length;
      SFX.notify();
      const m = openModal({
        title: "Draw offered", sub: "Your opponent offers a draw.",
        onClose: () => { if (this._drawModal === m) this._drawModal = null; },
        body: h("div.btn-row",
          h("button.btn.ghost", { onclick: () => { m.close(); this.client.action({ t: "draw-decline" }); } }, "Decline"),
          h("button.btn.primary", { onclick: () => { m.close(); this.client.action({ t: "draw-accept" }); } }, "Accept draw")),
      });
      this._drawModal = m;
    } else if (!v.drawOffer && this._drawModal) {
      // the offer lapsed (a move was made) or was withdrawn
      const m = this._drawModal;
      this._drawModal = null;
      m.close();
    }

    // chat (server rules v2)
    if (this.v2 && Array.isArray(v.chat) && v.chat.length !== this.chatSeen) {
      const fresh = v.chat.slice(this.chatSeen || 0);
      this.chatSeen = v.chat.length;
      this.chat = v.chat;
      this._renderChat();
      if (fresh.some(m => m.c !== this.myColor)) SFX.notify();
    }

    // takeback requests (server rules v2)
    if (this.v2 && v.takebackOffer && this.myColor && v.takebackOffer !== this.myColor && this.answeredTb !== v.moves.length && s.status === "playing") {
      this.answeredTb = v.moves.length;
      SFX.notify();
      const m = openModal({
        title: "Takeback requested", sub: "Your opponent wants to take back their last move.",
        body: h("div.btn-row",
          h("button.btn.ghost", { onclick: () => { m.close(); this.client.action({ t: "takeback-decline" }); } }, "Decline"),
          h("button.btn.primary", { onclick: () => { m.close(); this.client.action({ t: "takeback-accept" }); } }, "Accept")),
      });
    }

    if (s.status === "over" && !this.result) {
      const r = s.result || {};
      let res;
      if (r.draw) res = { winner: null, reason: r.reason };
      else res = { winner: r.winner === v.white ? "w" : "b", reason: r.reason };
      if (res.reason === "resignation" && this.plyCount() < 2) res = { winner: null, reason: "aborted" };
      this.phase = "over";
      this.finish(res);
      return;
    }
    if (s.status === "playing") {
      if (this.phase !== "playing") { this.phase = "playing"; this._renderControls(); }
    }
    this.renderStrips();
    this._renderStatus();
  }

  _syncMoves(serverMoves) {
    const local = this.plies();
    const n = serverMoves.length;
    // fast path: the server has exactly our list (+ maybe one new opponent move)
    const same = (i) => {
      const a = local[i], b = serverMoves[i];
      return a && b && a.uci === b.from + b.to + (b.promotion || "");
    };
    let common = 0;
    while (common < Math.min(n, local.length) && same(common)) common++;
    if (common === local.length && n === local.length + 1) {
      const m = serverMoves[n - 1];
      this.applyMove({ from: m.from, to: m.to, promotion: m.promotion }, { opponent: m && this.myColor && this.chess.turn() !== this.myColor });
      if (!this.result) this.input.tryPremove();
      this._titleAlert();
      return;
    }
    if (common === n && n === local.length) { this.pendingUci = null; return; }
    if (common === n && local.length === n + 1 && this.pendingUci) return; // our optimistic move awaiting echo
    // full rebuild
    this.chess = createChess(this.startFen);
    this.tree = new (this.tree.constructor)(this.startFen);
    this.node = this.tree.root;
    for (const m of serverMoves) {
      const mv = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion });
      this.node = this.tree.play(this.node, { from: mv.from, to: mv.to, promotion: mv.promotion });
    }
    this.view = this.node;
    this.app.board.syncFromBoard(this.chess.board());
    this.redraw(false);
    this.renderMoves();
    this._renderControls();
    this._updateOpening();
  }

  _resyncFromServer() {
    this.pendingUci = null;
    if (this.client && this.client.last && this.client.last.view) this._syncMoves(this.client.last.view.moves);
  }

  userMove(m, opts) {
    if (this.phase !== "playing" || this.chess.turn() !== this.myColor) return;
    const mv = this.applyMove(m, opts);
    if (!mv) return;
    this.pendingUci = mv.from + mv.to + (mv.promotion || "");
    this.client.action({ t: "move", from: mv.from, to: mv.to, promotion: mv.promotion || undefined });
  }

  onAfterMove() { /* server drives everything */ }

  // The server is the referee: a checkmate on our screen may still lose on time if the move
  // reached the server late, so results only come from the server's state.
  _detectEnd() { return null; }

  // the flagged side's opponent claims the win; the server verifies
  onFlag(flagged) {
    if (!this.myColor) return;
    if (flagged !== this.myColor && Date.now() - this.flagSentAt > 2500) {
      this.flagSentAt = Date.now();
      this.client.action({ t: "flag" });
      setTimeout(() => { if (!this.result && this.clock) this.clock.active = this.chess.turn(); }, 3000);
    }
  }

  // finish is driven by the server; rating + bookkeeping happen here
  onFinish(r) {
    if (r.reason === "aborted" || !this.myColor) return {};
    const rated = this.kind === "pool";
    const cls = timeClass(this.tcKey);
    let delta = null;
    if (rated && cls) {
      const score = !r.winner ? 0.5 : r.winner === this.myColor ? 1 : 0;
      delta = applyRating(cls, this.oppRating || 1200, score);
      this.players[this.myColor].rating = getProfile().ratings[cls].r;
    }
    if (r.winner === this.myColor) unlock("online-win");
    return { rated, delta, deltaFor: delta !== null ? { [this.myColor]: delta } : null };
  }

  controls() {
    const live = this.phase === "playing" && !this.result && this.myColor;
    const early = this.plyCount() < 2;
    const list = [];
    if (this.v2) list.push({ label: "Request takeback", short: "Takeback", icon: "undo", onClick: () => { this.client.action({ t: "takeback-offer" }); toast("Takeback requested"); }, disabled: !live || !this.plies().some(n => n.move.color === this.myColor) });
    return [
      ...list,
      { label: "Offer draw", short: "Draw", text: "½", onClick: () => { this.client.action({ t: "draw-offer" }); toast("Draw offer sent"); }, disabled: !live || early },
      early
        ? { label: "Abort", icon: "close", onClick: () => this.client.action({ t: this.v2 ? "abort" : "resign" }), disabled: !live }
        : { label: "Resign", icon: "flag", onClick: async () => { if (!getSettings().confirmResign || await confirmModal({ title: "Resign this game?", yes: "Resign", danger: true })) this.client.action({ t: "resign" }); }, disabled: !live },
    ];
  }

  postGameButtons(close = () => {}) {
    const btns = [];
    if (this.myColor) btns.push(h("button.btn", { onclick: () => { close(); this._rematch(); } }, icon("flip", 18), "Rematch"));
    btns.push(h("button.btn", { onclick: () => { close(); this.app.setController(() => new OnlineGame(this.app, { kind: "pool", tcKey: this.tcKey })); } }, icon("users", 18), "New opponent"));
    return btns;
  }

  _rematch() {
    // the room resets in place for both players. If the reset can't be sent, keep the finished
    // game: resetting locally anyway would replay and re-score it when the next state arrives.
    if (!this.client || !this.client.reset()) { toast("Not connected right now. Try again in a moment."); return; }
    this._resetLocal();
    toast("Rematch started");
  }

  _resetLocal() {
    this.result = null;
    this._modalShown = false;
    this.sentConfig = false;
    this.pendingUci = null;
    this.answeredDraw = null;
    this.answeredTb = null;
    this.chatSeen = 0;
    this.chess = createChess(this.startFen);
    this.tree = new (this.tree.constructor)(this.startFen);
    this.node = this.view = this.tree.root;
    this.id = Math.random().toString(36).slice(2, 10);
    this.startedAt = Date.now();
    this.opening = null;
    this.app.board.syncFromBoard(this.chess.board());
    this.app.board.setLastMove(null, null);
    this.app.board.setCheck(null);
    this.redraw(false); this.renderMoves(); this._renderControls();
  }

  // background tab: flag the title when it's our move (chess.com does the same)
  _titleAlert() {
    if (!document.hidden || this.result || !this.myColor || this.chess.turn() !== this.myColor) return;
    document.title = "● Your move – Chess 3D";
    if (!this._onVis) {
      this._onVis = () => { if (!document.hidden) document.title = "Chess 3D"; };
      document.addEventListener("visibilitychange", this._onVis);
    }
  }

  // ---------- chat (server rules v2) ----------
  _buildPanel() {
    super._buildPanel();
    this.chatEl = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } });
    const body = this.app.side.querySelector(".side-body");
    if (body) body.appendChild(this.chatEl);
    this._renderChat();
  }

  _renderChat() {
    const el = this.chatEl;
    if (!el) return;
    el.innerHTML = "";
    if (!this.v2 || !this.myColor) return;
    const log = h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "160px", overflowY: "auto" } });
    for (const m of (this.chat || []).slice(-30)) {
      const who = m.c === this.myColor ? "You" : (this.players[m.c]?.name || "Opponent");
      log.appendChild(h("div.chatline", h("b", who), h("span", m.text)));
    }
    const input = h("input.input", { placeholder: "Send a message", maxlength: "200", "aria-label": "Chat message" });
    const send = (text) => { text = (text || "").trim(); if (!text) return; this.client.action({ t: "chat", text }); input.value = ""; };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });
    const quick = h("div.seg", ...["Good luck!", "Have fun!", "Good game", "Thanks!"].map(t => h("button", { onclick: () => send(t) }, t)));
    el.append(h("div.lbl.note", "Chat"), log, quick, input);
    log.scrollTop = log.scrollHeight;
  }

  // ---------- lobby UI ----------
  // waiting for a friend: challenge one of your Social friends to this room directly
  _friendInvites() {
    const box = h("div.invite-friends");
    this._friendsP = this._friendsP || Social.api("GET", "/friends").then(d => d.friends).catch(() => []);
    this._friendsP.then((friends) => {
      if (!friends.length || this.phase !== "waiting") return;
      const daily = this.kind === "daily";
      box.append(h("div.lbl", "Or challenge a friend"), h("div.rows", ...friends.slice(0, 8).map(u => {
        const btn = h("button.btn.small", {
          onclick: async () => {
            btn.disabled = true;
            try {
              await Social.api("POST", "/messages", { to: u.id, kind: "challenge", room: this.room, tc: daily ? "inf" : this.tcKey, mode: daily ? "daily" : "live" });
              btn.textContent = "Sent";
              toast(`Challenge sent to ${u.name}`);
            } catch (e) { toast(e.message); btn.disabled = false; }
          },
        }, "Challenge");
        return h("div.row", userAvatar(u), h("span.rt", h("b", u.name), h("small", presenceText(u))), btn);
      })));
    });
    return box;
  }

  _renderLobby(error) {
    const me = getProfile();
    this.app.strips(null, { name: me.name, rating: this.myRating, avatar: me.avatar });
    const body = [];
    if (this.phase === "searching" || this.phase === "connecting") {
      body.push(h("div.card",
        h("h3", `Looking for an opponent at ${tcLabel(this.tcKey)}`),
        this._timeEl = h("p.note", "Searching…"),
        h("p.note", "Chess 3D pairs players who search at the same time. If nobody turns up, play a bot while you wait.")));
      body.push(h("button.btn.block", { onclick: () => this.app.go("#/bots") }, icon("robot", 18), "Play a bot instead"));
    } else if (this.phase === "waiting") {
      const link = location.origin + location.pathname + `?room=${this.room}&tc=${encodeURIComponent(this.tcKey)}#/online`;
      const input = h("input.input", { value: link, readonly: true, "aria-label": "Invite link", onfocus: (e) => e.target.select() });
      const invitee = this.cfg.invitee;
      body.push(h("div.card",
        h("h3", invitee ? `Challenge sent to ${invitee}` : this.kind === "daily" ? "Invite a friend to a daily game" : "Invite a friend"),
        h("p.note", invitee
          ? (this.kind === "daily" ? `The game starts when ${invitee} accepts. There's no clock, so you can both play at your own pace. You play White.`
            : `The game (${tcLabel(this.tcKey)}) starts as soon as ${invitee} accepts. You play White. You can also send them this link.`)
          : this.kind === "daily"
            ? "Send this link. There's no clock: moves are saved, so you can both come back and play at your own pace. You play White."
            : `Send this link. The game starts (${tcLabel(this.tcKey)}) as soon as they open it. You play White.`),
        h("div.field", input),
        h("div.btn-row",
          h("button.btn.primary", { onclick: async () => { if (await copyText(link)) toast("Link copied"); } }, icon("copy", 18), "Copy link"),
          navigator.share ? h("button.btn", { onclick: () => navigator.share({ title: "Play chess with me", url: link }).catch(() => {}) }, icon("share", 18), "Share") : null)));
      if (!invitee && Social.registered()) body.push(this._friendInvites());
    } else if (this.phase === "failed") {
      body.push(h("div.status-line.bad", icon("close", 16), h("span", error || "Couldn't reach the pairing server.")));
      body.push(h("button.btn.primary.block", { onclick: () => this.app.setController(() => new OnlineGame(this.app, { kind: "pool", tcKey: this.tcKey })) }, "Try again"));
    }
    body.push(h("button.btn.ghost.block", { onclick: () => this.app.go("#/") }, "Cancel"));
    this.app.panel({ title: this.title(), back: "#/", body });
  }
  _renderLobbyTime() {
    if (!this._timeEl) return;
    const s = Math.floor((Date.now() - this._searchStarted) / 1000);
    this._timeEl.textContent = `Searching… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  _setNote(text) {
    this._note = text;
    this._renderStatus();
  }
  statusText() {
    if (this._note) return this._note;
    if (!this.myColor) return "Spectating";
    if (this.phase !== "playing") return "Waiting…";
    return this.chess.turn() === this.myColor ? "Your move" : "Opponent to move";
  }
}

export const SERVER_TCS = ["1+0", "3+2", "5+0", "10+0", "15+10", "inf"];
function nearestTc(tc) {
  const [m] = tc.split("+").map(Number);
  if (m <= 1) return "1+0";
  if (m <= 3) return "3+2";
  if (m <= 5) return "5+0";
  if (m <= 10) return "10+0";
  return "15+10";
}
function parsePlayerIdAsPlayer(id) {
  const p = parsePlayerId(id);
  return { name: p.name, rating: p.rating, avatar: { emoji: "♟", bg: "#3a4a5a" } };
}
