// Online play over the room server: quick pairing (public pool rooms) or a private invite link.
// Moves are applied optimistically and reconciled against the server's authoritative move list.
import { Chess } from "chess.js";
import { createChess } from "../core/chess960.js";
import { BaseGame } from "./base-game.js";
import { h, icon, copyText } from "../ui/dom.js";
import { confirmModal, openModal, toast, tcLabel, closeAllModals } from "../ui/components.js";
import { RoomClient, makePlayerId, parsePlayerId, findMatch, live } from "../net/room.js";
import { getProfile, applyRating, timeClass, unlock, getSettings, getDaily, upsertDaily } from "../store.js";
import { SFX } from "../audio.js";
import * as Social from "../net/social.js";
import { userAvatar, presenceText } from "../ui/people.js";

function myRatingFor(tcKey) {
  const cls = /^\d+d$/.test(tcKey || "") ? "daily" : timeClass(tcKey) || "rapid";
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
    this.playerId = cfg.playerId || (daily && daily.playerId) || sessionStorage.getItem("mp-pid-" + (cfg.room || "")) || makePlayerId(me.name, this.myRating, Social.myCode());
    this.room = cfg.room || null;
    this.client = cfg.client || null;
    this.flagSentAt = 0;
    this.answeredDraw = null;
    this.serverMoves = 0;
    this.sentConfig = false;
  }

  title() {
    if (this.cfg.arena) return this.cfg.arena.name;
    if (this.cfg.swiss) return `${this.cfg.swiss.name}, round ${this.cfg.swiss.round}`;
    return this.kind === "pool" ? `Online ${tcLabel(this.tcKey)}` : this.kind === "daily" ? "Daily game" : "Play a friend";
  }
  bottomColor() { return this.myColor || "w"; }
  canMove(c) { return this.phase === "playing" && c === this.myColor; }
  premoveColor() { return this.phase === "playing" ? this.myColor : null; }

  mount() {
    super.mount();
    live.busy = false;     // searching or waiting isn't playing yet
    if (this.kind === "pool" && !this.client) this._search();
    else this._join();
    if (this.cfg.swiss) this._swissPing = setInterval(() => Social.api("POST", `/swiss/${this.cfg.swiss.id}/ping`, { pid: this.playerId }).catch(() => {}), 20000);
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
    clearTimeout(this._noShowT); clearTimeout(this._arenaNextT); clearInterval(this._swissPing);
    if (live.room === this.room) live.room = null;
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
    // unrated games have a pool of their own; a rating range turns down players outside it
    const range = this.cfg.range || 0, mine = this.myRating;
    this.search = findMatch(this.tcKey, this.playerId, (p) => { if (p.phase === "waiting") this._renderLobby(); }, {
      prefix: this.cfg.rated === false ? "upool" : "pool",
      accept: range ? (pid) => { const r = parsePlayerId(pid).rating; return !r || Math.abs(r - mine) <= range; } : null,
    });
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
    // a club match's colour is remembered with the game, for coming back from the daily list
    if (this.kind === "daily") upsertDaily({ room: this.room, playerId: this.playerId, ...(this.cfg.forceColor ? { forceColor: this.cfg.forceColor } : {}) });
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
      if (this.cfg.arena && !this._noShowT) {
        this._noShowT = setTimeout(async () => {
          if (this._destroyed || !this.lastState || this.lastState.status !== "waiting") return;
          toast("Your opponent didn't show up. Finding you another game.");
          try { await Social.api("POST", `/arenas/${this.cfg.arena.id}/result`, { room: this.room }); } catch { /* the server voids it later */ }
          if (!this._destroyed) this.cfg.arena.next();
        }, 50000);
      }
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
        this.oppCode = opp.code;
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

    // called off before it began (quick pairing does this when one player has blocked the other)
    if (s.status === "over" && v.phase === "config") {
      if (this.kind === "pool" && this.app.controller === this) {
        toast("That pairing fell through. Finding you another opponent.");
        this.app.setController(() => new OnlineGame(this.app, { kind: "pool", tcKey: this.tcKey, rated: this.cfg.rated, range: this.cfg.range }));
      } else this._setNote("This game was called off before it started.");
      return;
    }

    // time control: the first seat (White) configures it from the room's agreed setting
    if (v.phase !== "config") {
      this.sentConfig = false;   // a later reset needs a fresh config
      // the "Starting…" note goes once the game is under way (live games clear notes on every update; daily ones don't)
      if (this._startNote) { this._startNote = false; this._setNote(null); }
    }
    if (v.phase === "config") {
      this.phase = "config";
      if (this.myColor === "w" && !this.sentConfig) {
        this.sentConfig = true;
        let tc = this.tcKey || new URLSearchParams(location.search).get("tc") || "10+0";
        if (/d$/.test(tc) && (v.v || 1) < 3) tc = "inf";   // a server without daily deadlines
        // a club match may have given you Black: the room seated you first, so swap
        const forceColor = this.cfg.forceColor || (getDaily(this.room) || {}).forceColor;
        const swap = forceColor === "b" && (v.v || 1) >= 7 ? { swap: true } : {};
        this.client.action({ t: "config", tc: this.v2 || SERVER_TCS.includes(tc) ? tc : nearestTc(tc), ...swap });
      }
      this._setNote(this.myColor === "w" ? "Starting…" : "Waiting for White to start the clock…");
      this._startNote = true;
      this.renderStrips();
      return;
    }
    if (v.tcKey && v.tcKey !== this.tcKey) { this.tcKey = v.tcKey; }

    // moves: reconcile
    const before = this.chess.history().length;
    const hadPlan = (this.cond || []).length > 0;
    this._syncMoves(v.moves);
    const plan = (v.cond && this.myColor && v.cond[this.myColor]) || [];
    const planChanged = JSON.stringify(plan) !== JSON.stringify(this.cond || []) || this.v8 !== (v.v || 1) >= 8;
    this.v8 = (v.v || 1) >= 8;
    this.cond = plan;
    if (planChanged) this._renderControls();
    // daily games: tell the opponent it's their move, unless a reply they lined up already answered it
    if (this._nudge && v.moves.length >= this._nudge.ply) {
      const n = this._nudge;
      this._nudge = null;
      if (v.moves.length === n.ply && s.status === "playing") Social.api("POST", "/nudge", { code: this.oppCode, room: this.room, san: n.san }).catch(() => {});
      else if (v.moves.length > n.ply && v.san) toast(`They had a reply ready: ${v.san[n.ply]}`);
    } else if (this.kind === "daily" && hadPlan && v.moves.length >= before + 2 && this.myColor) {
      toast(`They played ${v.san[before]}, and your planned reply ${v.san[before + 1]} was played`);
    }
    if (this.kind === "daily" && this.myColor && v.away) {
      const until = v.away[this.myColor === "w" ? "b" : "w"];
      if (until > Date.now()) this._setNote(`Your opponent is on vacation until ${new Date(until).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}.`);
    }

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
    if (s.status === "playing" && this.myColor && this.kind !== "daily") {
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
      if (fresh.some(m => m.c !== this.myColor) && !Social.isBlockedCode(this.oppCode)) SFX.notify();
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
      // rules v1 had no abort, so "Abort" resigned: an early resignation there means aborted. From v2 on a
      // resignation is one (tournaments and leagues score it as the server does)
      if (res.reason === "resignation" && this.plyCount() < 2 && !this.v2) res = { winner: null, reason: "aborted" };
      this.phase = "over";
      this.finish(res);
      return;
    }
    if (s.status === "playing") {
      if (this.phase !== "playing") { this.phase = "playing"; this._renderControls(); }
      if (this.myColor && this.kind !== "daily") { live.room = this.room; live.busy = true; }
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
    // daily games: let the opponent's devices know it's their move (if they have a profile), once the
    // server has the move (they may have lined up a reply, and then it's not their move after all)
    if (this.kind === "daily" && this.oppCode && Social.registered()) this._nudge = { ply: this.chess.history().length, san: mv.san };
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
    if (live.room === this.room) live.room = null;
    // arena games are scored by the server from the room, aborted ones included (they don't count)
    if (this.cfg.arena && this.myColor) this._reportArena();
    if (r.reason === "aborted" || !this.myColor) return {};
    // Swiss games: the server scores them from the room; a ping moves the tournament along
    if (this.cfg.swiss && this.myColor) {
      const sw = this.cfg.swiss;
      Social.api("POST", `/swiss/${sw.id}/ping`, { pid: this.playerId }).catch(() => {});
      this._arenaNextT = setTimeout(() => { if (!this._destroyed && this.app.controller === this) { closeAllModals(); sw.back(); } }, 8000);
    }
    // daily games with a time limit are rated too (chess.com's Daily rating); unlimited ones aren't
    const daily = this.kind === "daily" && /^\d+d$/.test(this.tcKey || "");
    const rated = (this.kind === "pool" && this.cfg.rated !== false) || !!this.cfg.arena || !!this.cfg.swiss || daily;
    const cls = daily ? "daily" : timeClass(this.tcKey);
    let delta = null;
    if (rated && cls) {
      const score = !r.winner ? 0.5 : r.winner === this.myColor ? 1 : 0;
      delta = applyRating(cls, this.oppRating || 1200, score);
      this.players[this.myColor].rating = getProfile().ratings[cls].r;
    }
    if (r.winner === this.myColor) unlock("online-win");
    if (this.kind === "pool" && this.cfg.rated !== false && Social.registered()) this._reportLeague();
    if (rated && cls) Social.rateGame(this.room);
    return { rated, delta, deltaFor: delta !== null ? { [this.myColor]: delta } : null };
  }

  controls() {
    const live = this.phase === "playing" && !this.result && this.myColor;
    const early = this.plyCount() < 2;
    const list = [];
    if (this.v2) list.push({ label: "Request takeback", short: "Takeback", icon: "undo", onClick: () => { this.client.action({ t: "takeback-offer" }); toast("Takeback requested"); }, disabled: !live || !this.plies().some(n => n.move.color === this.myColor) });
    // daily games: private notes, kept with the game on this device
    if (this.kind === "daily" && this.myColor) list.push({ label: "Notes", short: "Notes", text: "✎", onClick: () => this._notesModal() });
    // daily games: plan replies while it's their move
    if (this.kind === "daily" && this.v8 && !this.cfg.variant) {
      list.push({ label: this.cond && this.cond.length ? `Planned replies (${this.cond.length})` : "Plan replies", short: "Plan", icon: "edit", onClick: () => this._conditionalModal(), disabled: !live || this.chess.turn() === this.myColor });
    }
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
    if (this.cfg.swiss) {
      btns.push(h("button.btn.primary", { onclick: () => { close(); clearTimeout(this._arenaNextT); this.cfg.swiss.back(); } }, icon("trophy", 18), "Back to the tournament"));
      return btns.concat(this._addFriendButton());
    }
    if (this.cfg.arena) {
      const a = this.cfg.arena;
      btns.push(h("button.btn.primary", { onclick: () => { close(); clearTimeout(this._arenaNextT); a.next(); } }, icon("bolt", 18), "Next game"));
      btns.push(h("button.btn", { onclick: () => { close(); clearTimeout(this._arenaNextT); a.leave(); } }, "Standings"));
      return btns.concat(this._addFriendButton());
    }
    if (this.myColor) btns.push(h("button.btn", { onclick: () => { close(); this._rematch(); } }, icon("flip", 18), "Rematch"));
    btns.push(h("button.btn", { onclick: () => { close(); this.app.setController(() => new OnlineGame(this.app, { kind: "pool", tcKey: this.tcKey, rated: this.cfg.rated, range: this.cfg.range })); } }, icon("users", 18), "New opponent"));
    return btns.concat(this._addFriendButton());
  }

  // both players have social on: offer to add the opponent (chess.com does this after a game)
  _addFriendButton() {
    const btns = [];
    const known = Social.cached("/friends");
    const already = known && known.friends.some(f => f.code === this.oppCode);
    if (this.oppCode && Social.registered() && this.oppCode !== Social.myCode() && !already) {
      const add = h("button.btn", {
        onclick: async () => {
          add.disabled = true;
          try {
            const r = await Social.api("POST", "/friends/request", { code: this.oppCode });
            toast(r.status === "friends" ? "You're already friends" : `Friend request sent to ${r.user.name}`);
          } catch (e) { toast(e.message); add.disabled = false; }
        },
      }, icon("plus", 18), "Add friend");
      btns.push(add);
    }
    if (this.oppCode && Social.registered() && this.oppCode !== Social.myCode() && !already && !Social.isBlockedCode(this.oppCode)) {
      const name = this.players[this.myColor === "w" ? "b" : "w"]?.name || "this player";
      const blk = h("button.btn.ghost", {
        onclick: async () => {
          if (!(await confirmModal({ title: `Block ${name}?`, sub: "They won't be able to add, message or challenge you, you won't be paired with them, and you won't see their posts or chat. You can unblock them from Social.", yes: "Block", danger: true }))) return;
          blk.disabled = true;
          try { await Social.block({ code: this.oppCode }); toast(`Blocked ${name}`); blk.remove(); this._renderChat(); } catch (e) { toast(e.message); blk.disabled = false; }
        },
      }, "Block");
      btns.push(blk);
    }
    return btns;
  }

  // arena games: the server reads the result from this room and scores both players
  async _reportArena(tries = 0) {
    const a = this.cfg.arena;
    try {
      const r = await Social.api("POST", `/arenas/${a.id}/result`, { room: this.room });
      if (this._destroyed) return;
      const won = r.outcome === r.you, drew = r.outcome === "draw";
      toast(r.outcome === "void" ? "This game doesn't count." : won ? "Win recorded in the arena" : drew ? "Draw recorded in the arena" : "Result recorded in the arena");
      // like chess.com: back into the pairing pool after a short pause unless you choose otherwise
      this._arenaNextT = setTimeout(() => { if (!this._destroyed && this.app.controller === this) { closeAllModals(); a.next(); } }, 7000);
    } catch (e) {
      // the room may still be settling, or the server busy: try again shortly
      if (tries < 4 && (e.status === 409 || e.status === 503 || e.status === 0)) setTimeout(() => this._reportArena(tries + 1), 1500 * (tries + 1));
      else toast(e.message);
    }
  }

  // games against random opponents earn league trophies; the server reads the result from the room
  async _reportLeague(tries = 0) {
    try {
      const r = await Social.api("POST", "/league/result", { room: this.room, pid: this.playerId });
      if (r.earned > 0 && !this._destroyed) toast(`+${r.earned} league trophies (${r.tiers[r.division ? r.division.tier : r.tier]} league)`);
    } catch (e) {
      if (tries < 4 && (e.status === 409 || e.status === 503 || e.status === 0)) setTimeout(() => this._reportLeague(tries + 1), 1500 * (tries + 1));
    }
  }

  _notesModal() {
    const notes = h("textarea.input.prose", { rows: "6", maxlength: "2000", placeholder: "Plans, ideas, what to check next time…", "aria-label": "Notes on this game" });
    notes.value = (getDaily(this.room) || {}).notes || "";
    const m = openModal({
      title: "Notes", sub: "Private notes on this game. They stay on this device; your opponent never sees them.",
      body: [notes, h("button.btn.primary.block", { onclick: () => { upsertDaily({ room: this.room, notes: notes.value.slice(0, 2000) }); toast("Notes saved"); m.close(); } }, "Save notes")],
    });
    setTimeout(() => notes.focus(), 50);
  }

  // daily games: line up replies to the opponent's next move ("if they play Nf6, I play e5")
  _conditionalModal() {
    const base = new Chess(this.chess.fen());
    const sanLine = (uci) => {
      const g = new Chess(base.fen());
      const out = [];
      for (const u of uci) { try { out.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined }).san); } catch { break; } }
      return out;
    };
    const send = (lines, done) => {
      this.client.action({ t: "conditional", lines });
      toast(lines.length ? "Replies saved" : "Planned replies cleared");
      done();
    };
    const input = h("input.input", { placeholder: "e.g. Nf6 e5  or  Nf6 e5 Nd5 c4", "aria-label": "Their move and your reply, in algebraic notation", autocomplete: "off", spellcheck: "false" });
    const err = h("p.note", { role: "alert" });
    const add = () => {
      const g = new Chess(base.fen());
      const uci = [];
      for (const t of input.value.trim().split(/[\s,]+/).filter(Boolean).map((x) => x.replace(/^\d+\.+/, "")).filter(Boolean)) {
        let mv;
        try { mv = g.move(t, { strict: false }); } catch { mv = null; }
        if (!mv) { err.textContent = `${t} isn't a legal move there.`; return; }
        uci.push(mv.from + mv.to + (mv.promotion || ""));
      }
      if (uci.length < 2 || uci.length % 2) { err.textContent = "Give their move and then your reply (add more pairs to plan further)."; return; }
      send([...this.cond, uci], () => m.close());
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    const list = this.cond.length
      ? h("div.rows", ...this.cond.map((line, i) => h("div.row", h("span.rt", h("b", sanLine(line).map((x, k) => (k % 2 ? "→ " : "if ") + x).join(" ")), h("small", `${line.length / 2} pair${line.length === 2 ? "" : "s"}`)),
        h("button.btn.small.ghost", { onclick: () => send(this.cond.filter((_, k) => k !== i), () => m.close()) }, "Remove"))))
      : h("p.note", "No replies planned.");
    const m = openModal({
      title: "Plan replies", sub: "If your opponent plays one of these moves, your reply is played at once. Any other move clears the plan, and your opponent never sees it.",
      body: [list, h("label.lbl", "Their move, then your reply"), input, err,
        h("div.btn-row", this.cond.length ? h("button.btn.ghost", { onclick: () => send([], () => m.close()) }, "Clear all") : null, h("button.btn.primary", { onclick: add }, icon("plus", 18), "Add"))],
    });
    setTimeout(() => input.focus(), 50);
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
    live.busy = !!this.myColor;
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
    // you blocked this opponent: their messages stay hidden
    const muted = Social.isBlockedCode(this.oppCode);
    for (const m of (this.chat || []).slice(-30)) {
      if (muted && m.c !== this.myColor) continue;
      const who = m.c === this.myColor ? "You" : (this.players[m.c]?.name || "Opponent");
      log.appendChild(h("div.chatline", h("b", who), h("span", { "data-no-i18n": "" }, m.text)));
    }
    if (muted) log.appendChild(h("small.muted", "You blocked this player, so their messages are hidden."));
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
              await Social.api("POST", "/messages", { to: u.id, kind: "challenge", room: this.room, tc: daily ? (/d$/.test(this.tcKey) ? this.tcKey : "inf") : this.tcKey, mode: daily ? "daily" : "live" });
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
        this.cfg.rated === false || this.cfg.range ? h("p.note", [this.cfg.rated === false ? "Unrated" : "Rated", this.cfg.range ? `opponents within ${this.cfg.range} of your ${this.myRating}` : null].filter(Boolean).join(", ") + ".") : null,
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
          ? (this.kind === "daily" ? `The game starts when ${invitee} accepts. ${dailyPace(this.tcKey)} You play White.`
            : `The game (${tcLabel(this.tcKey)}) starts as soon as ${invitee} accepts. You play White. You can also send them this link.`)
          : this.kind === "daily"
            ? `Send this link. ${dailyPace(this.tcKey)} You play White.`
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

function dailyPace(tcKey) {
  return /d$/.test(tcKey || "") ? `Each of you has ${tcLabel(tcKey)} for every move; run out and you lose on time.`
    : "There's no clock: moves are saved, so you can both come back and play at your own pace.";
}
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
