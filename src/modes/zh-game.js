// Crazyhouse and Bughouse. Captured pieces go to a pocket and can be dropped back on the board as
// a move. Crazyhouse: against the built-in bots (src/core/zh-engine.js in a worker), pass and play,
// or a friend online. Bughouse: two boards, two teams of two; your captures feed your partner.
import { h, icon, copyText } from "../ui/dom.js";
import { GLYPH, openModal, toast, confirmModal, tcLabel, tcPicker, segmented, updateClock, renderStrip } from "../ui/components.js";
import { MoveInput } from "../core/input.js";
import { kingSquare } from "../core/tree.js";
import { Crazyhouse, POCKET_ORDER, textToMove, moveToText, VALUES } from "../core/zh.js";
import { ZH_LEVELS } from "../core/zh-engine.js";
import { VX_VARIANTS } from "../core/vx.js";
import { VX_INFO } from "./vx-game.js";
import { RoomClient, makePlayerId, parsePlayerId, peekRoom, live, findMatch } from "../net/room.js";
import { getProfile, getSettings, variantRating, applyVariantRating, saveVariantGame, newGameId } from "../store.js";
import { SFX } from "../audio.js";
import * as Social from "../net/social.js";

const other = (c) => (c === "w" ? "b" : "w");
const randomId = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const REASONS = { checkmate: "by checkmate", stalemate: "by stalemate", threefold: "by repetition", resignation: "by resignation", timeout: "on time", agreement: "by agreement", aborted: "game aborted" };
const reasonText = (r) => (r && r.startsWith("partner-") ? `on the other board (${REASONS[r.slice(8)] || r.slice(8)})` : REASONS[r] || "");

// one engine worker for the page (also used by the other variants: kind "vx")
let worker = null, jobId = 0;
const jobs = new Map();
export function think(state, opts, kind = "zh") {
  if (!worker) {
    worker = new Worker("./zh-worker.js");
    worker.onmessage = (e) => { const j = jobs.get(e.data.id); if (j) { jobs.delete(e.data.id); j(e.data.move); } };
  }
  const id = ++jobId;
  return new Promise((res) => { jobs.set(id, res); worker.postMessage({ id, state, opts, kind }); });
}

// a pocket row: tap a piece to drop it
function pocketRow(pockets, color, { onPick = null, picked = null, label } = {}) {
  const pk = pockets[color];
  const items = POCKET_ORDER.filter((t) => pk[t] > 0);
  return h("div.pocket", { "aria-label": label },
    h("span.pocket-label", label),
    items.length ? items.map((t) => h(`button.pocket-piece${picked === t ? ".on" : ""}`, {
      disabled: !onPick, onclick: onPick ? () => onPick(t) : null, "aria-label": `${pk[t]} ${({ q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" })[t]}${pk[t] === 1 ? "" : "s"} in hand`,
    }, h("span.pg", GLYPH[color][t]), pk[t] > 1 ? h("small", String(pk[t])) : null)) : h("small.muted", "empty"));
}

// a small read-only board (the partner's game in Bughouse)
function miniBoard(fen, flip) {
  const rows = fen.split(" ")[0].split("/");
  const cells = [];
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { for (let k = 0; k < Number(ch); k++) cells.push({ r, f: f++, p: null }); }
      else cells.push({ r, f: f++, p: ch });
    }
  }
  const order = flip ? cells.slice().reverse() : cells;
  return h("div.mini-board", ...order.map((c) => h(`span.${(c.r + c.f) % 2 ? "dk" : "lt"}`, c.p ? (c.p === c.p.toUpperCase() ? GLYPH.w[c.p.toLowerCase()] : GLYPH.b[c.p]) : "")));
}

export class ZhGame {
  // cfg: { mode: "bot"|"local"|"online"|"pool"|"bughouse", level, myColor, room, tcKey, link, board }
  // ("online" is a friend's invite, "pool" a rated game against a random opponent)
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.z = new Crazyhouse();
    this.sans = [];
    this.moveTexts = [];      // bot and pass-and-play games, for the archive
    this.snaps = [];          // Bughouse: each position as it happened (pieces also arrive from the partner)
    this.id = newGameId();
    this.last = null;
    this.result = null;
    this.myColor = cfg.myColor || "w";
    this.level = ZH_LEVELS.find((l) => l.id === cfg.level) || ZH_LEVELS[1];
    this.dropPick = null;
    this.phase = this.net ? "connecting" : "playing";
    this.clock = null;
    this.input = new MoveInput(app, {
      getChess: () => (this.canInput() ? this.z.chess() : null),
      canMove: (c) => this.canMove(c),
      premoveColor: () => null,
      onMove: (m) => this.play(m),
    });
  }

  get net() { return this.mode === "online" || this.mode === "pool" || this.mode === "bughouse"; }
  title() { return this.mode === "bughouse" ? "Bughouse" : "Crazyhouse"; }
  canInput() { return !this.result && this.phase === "playing"; }
  canMove(c) {
    if (!this.canInput() || this.z.turn() !== c) return false;
    return this.mode === "local" ? true : c === this.myColor;
  }
  bottom() { return this.mode === "local" ? this.z.turn() : this.myColor; }

  mount() {
    this.app.setInGame(true);
    live.busy = !this.net;
    this.app.bindBoard({
      onSquareTap: (sq) => this.tap(sq),
      canDrag: (sq) => this.input.canDrag(sq),
      onDragStart: (sq) => { this.dropPick = null; this.input._dragFrom = sq; this.input.select(sq); },
      onDrop: (from, to) => this.input.drop(from, to),
    });
    this.app.board.viewSide(this.bottom(), false);
    this.redraw();
    this.render();
    this.tick = setInterval(() => this._clockTick(), 200);
    if (this.mode === "bot" && this.myColor === "b") this.botMove();
    if (this.net) this.connect();
    this.app.leaveGuard = async () => {
      if (this.result || this.phase !== "playing" || this.mode === "local" || this.mode === "bot") return true;
      const ok = await confirmModal({ title: "Leave and resign?", sub: "Leaving a live game counts as a loss.", yes: "Resign and leave", danger: true });
      if (ok && this.client) this.client.action({ t: "resign" });
      return ok;
    };
  }
  destroy() {
    this.dead = true;
    live.busy = false;
    if (live.room === this.room) live.room = null;
    clearInterval(this.tick); clearInterval(this.peekT);
    if (this.search) this.search.cancel();
    this.input.clear();
    if (this.client) this.client.close();
    if (this.partner) this.partner.close();
    const params = new URLSearchParams(location.search);
    if (params.has("room")) { params.delete("room"); params.delete("tc"); history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash); }
  }
  onBoardSwap() { this.redraw(); }

  // ---- input: a picked pocket piece drops on the tapped square; otherwise normal moves ----
  tap(sq) {
    if (this.dropPick) {
      const drop = this.dropPick;
      this.dropPick = null;
      if (this.canMove(this.z.turn()) && this.z.isLegal({ drop, to: sq })) { this.play({ drop, to: sq }); return; }
      this.app.board.clearHints();
      this.render();
    }
    this.input.tap(sq);
  }
  pick(type) {
    if (!this.canMove(this.z.turn())) return;
    this.input.clear();
    if (this.dropPick === type) { this.dropPick = null; this.app.board.clearHints(); this.render(); return; }
    this.dropPick = type;
    const squares = this.z.legalMoves().filter((m) => m.drop === type).map((m) => m.to);
    this.app.board.showMoves(squares, []);
    this.render();
    if (!squares.length) toast("Nowhere to drop that right now");
  }

  // ---- moves ----
  play(m, { remote = false } = {}) {
    const before = this.z.state();
    const d = this.z.move(m);
    if (!d) return null;
    if (!this.net) this.moveTexts.push(moveToText(m));
    this.dropPick = null;
    this.sans.push(d.san);
    this.last = d;
    this.input.clear();
    const b = this.app.board;
    if (d.drop) b.syncFromBoard(this.z.chess().board());
    else b.animateMove({ ...d, flags: d.flags || "" });
    if (/#$/.test(d.san)) SFX.end(); else if (/\+$/.test(d.san)) SFX.check(); else if (d.captured) SFX.capture(); else if (remote) SFX.moveOpp(); else SFX.move();
    if (this.mode === "local") setTimeout(() => !this.dead && b.viewSide(this.z.turn()), 350);
    this.redraw(false);
    // online: the server is the referee; we sent the move and its state will confirm it
    if ((this.net) && !remote) {
      this.client.action({ t: "move", move: moveToText(m) });
      this.pending = before;
    }
    if (this.mode === "bot" || this.mode === "local") {
      const o = this.z.outcome();
      if (o.over) this.finish(o);
      else if (this.mode === "bot" && this.z.turn() !== this.myColor) this.botMove();
    }
    this.render();
    return d;
  }

  async botMove() {
    this.thinking = true;
    this.render();
    const t0 = performance.now();
    const move = await think(this.z.state(), this.level.opts);
    // a beat before replying, so instant moves don't feel abrupt
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (performance.now() - t0))));
    this.thinking = false;
    if (this.dead || this.result || !move) { this.render(); return; }
    this.play(textToMove(move), { remote: true });
  }

  finish(o) {
    if (this.result) return;
    this.result = o;
    const extra = this.record(o);
    live.busy = false;
    if (live.room === this.room) live.room = null;
    if (this.clock) this.clock.active = null;
    this.render();
    const mine = o.winner === this.myColor;
    const title = !o.winner ? "Draw" : this.mode === "local" ? `${o.winner === "w" ? "White" : "Black"} won` : mine ? "You won!" : "You lost";
    setTimeout(() => {
      if (this.dead) return;
      const m = openModal({
        title, sub: reasonText(o.reason) + (extra.delta != null ? `. Crazyhouse rating ${extra.rating} (${extra.delta >= 0 ? "+" : ""}${extra.delta})` : ""),
        body: h("div.btn-row",
          h("button.btn", { onclick: () => { m.close(); this.app.go(this.mode === "bughouse" ? "#/bughouse" : "#/crazyhouse"); } }, "New game"),
          this.mode === "pool" ? h("button.btn.primary", { onclick: () => { m.close(); this.app.setController(() => new ZhGame(this.app, this.cfg)); } }, "New opponent") : null,
          this.mode === "bot" || this.mode === "local" ? h("button.btn.primary", { onclick: () => { m.close(); this.app.setController(() => new ZhGame(this.app, { ...this.cfg, myColor: this.mode === "bot" ? other(this.myColor) : "w" })); } }, "Rematch") : null),
      });
    }, 500);
  }

  // the game for the archive, and the rating after a game against a random opponent
  record(o) {
    if (o.reason === "aborted") return {};
    const v = this.lastState && this.lastState.view;
    let plies = this.snaps;
    if (this.mode !== "bughouse") {
      const texts = this.net ? (v ? v.moves : []) : this.moveTexts;
      const z = new Crazyhouse();
      plies = [];
      for (const t of texts) { const d = z.move(textToMove(t)); if (!d) break; plies.push({ fen: z.fen, pockets: z.state().pockets, san: d.san }); }
    }
    if (!plies.length) return {};
    const my = this.mode === "local" ? null : this.myColor;
    const myResult = !my ? null : !o.winner ? "draw" : o.winner === my ? "win" : "loss";
    let delta = null, rating = null;
    if (this.mode === "pool" && my) {
      delta = applyVariantRating("crazyhouse", (this.oppInfo && this.oppInfo.rating) || 1500, myResult === "win" ? 1 : myResult === "loss" ? 0 : 0.5);
      rating = variantRating("crazyhouse");
    }
    const who = (c) => { const p = this.player(c); return { name: p.name, rating: p.rating || null }; };
    saveVariantGame({
      id: this.id, date: Date.now(), variant: this.mode === "bughouse" ? "bughouse" : "crazyhouse", mode: this.mode, tc: this.cfg.tcKey || null, rated: this.mode === "pool",
      white: who("w"), black: who("b"), myColor: my, myResult, result: !o.winner ? "1/2-1/2" : o.winner === "w" ? "1-0" : "0-1", reason: o.reason, delta,
      start: null, plies,
    });
    return { delta, rating };
  }

  // ---- online (Crazyhouse with a friend or a random opponent, or one board of a Bughouse match) ----
  connect() {
    const me = getProfile();
    if (this.mode === "pool") {
      this.playerId = makePlayerId(me.name, variantRating("crazyhouse"), Social.myCode());
      this.phase = "searching";
      this.search = findMatch(this.cfg.tcKey || "3+0", this.playerId, () => this.render(), { prefix: "zpcrazyhouse" });
      this.search.promise.then(({ room, client }) => {
        if (this.dead) { client.close(); return; }
        this.search = null;
        this.room = room;
        this.client = client;
        SFX.notify();
        client.rebind(this._handlers());
      }).catch((e) => { this.search = null; if (!this.dead) { this.phase = "failed"; this.failNote = e.message; this.render(); } });
      return;
    }
    this.room = this.cfg.room;
    this.playerId = sessionStorage.getItem("mp-pid-" + this.room) || makePlayerId(me.name, me.ratings.blitz.r, Social.myCode());
    sessionStorage.setItem("mp-pid-" + this.room, this.playerId);
    if (this.mode === "online") {
      const params = new URLSearchParams(location.search);
      params.set("room", this.room);
      params.set("tc", this.cfg.tcKey || "3+0");
      history.replaceState(null, "", location.pathname + "?" + params + "#/crazyhouse/online");
    }
    this.client = new RoomClient(this.room, this.playerId, this._handlers());
    if (this.mode === "bughouse") {
      // the partner board, watched read-only once both of its seats are taken
      this.peekT = setInterval(() => this._watchPartner(), 2000);
      this._watchPartner();
    }
  }

  _handlers() {
    return {
      onState: (s) => this._state(s),
      onError: (err) => { if (!/not your turn|already/.test(err)) toast(err); this._resync(); },
      onStatus: (st) => { this.netNote = st === "disconnected" ? "Connection lost. Reconnecting…" : null; this.render(); },
    };
  }

  async _watchPartner() {
    if (this.dead || this.partner) return;
    const st = await peekRoom(this.cfg.link).catch(() => null);
    this.partnerSeats = st ? st.seats.length : 0;
    if (st && st.seats.length >= 2) {
      clearInterval(this.peekT);
      this.partner = new RoomClient(this.cfg.link, "p-watch" + randomId(4) + ".Watcher.1200", { onState: (s) => { this.partnerState = s; this.render(); }, onError: () => {} });
      this._maybeConfig();
    }
    this.render();
  }

  _maybeConfig() {
    const s = this.lastState;
    if (!s || !s.view || s.view.phase !== "config" || this.sentConfig) return;
    if (s.view.white !== this.playerId) return;
    if (this.mode === "bughouse" && (!this.partnerSeats || this.partnerSeats < 2)) return;
    this.sentConfig = true;
    this.client.action({ t: "config", tc: this.cfg.tcKey || "3+0", variant: this.mode === "bughouse" ? "bughouse" : "crazyhouse", link: this.cfg.link });
  }

  _state(s) {
    this.lastState = s;
    if (s.status === "waiting") { this.phase = "waiting"; this.render(); return; }
    const v = s.view;
    if (!v) return;
    this.myColor = v.white === s.you ? "w" : v.black === s.you ? "b" : null;
    const opp = this.myColor ? parsePlayerId(this.myColor === "w" ? v.black : v.white) : null;
    this.oppInfo = opp;
    this.oppCode = opp && opp.code;
    if ((v.v || 1) < 4) { this.phase = "unsupported"; this.render(); return; }
    if (v.phase === "config") { this.phase = "config"; this._maybeConfig(); this.render(); return; }
    if (this.app.board.orientation !== (this.myColor || "w")) this.app.board.viewSide(this.myColor || "w", false);
    // the server's position is the truth (it also brings pieces your partner passed you)
    const was = this.sans.length;
    this.z = new Crazyhouse(v.zh);
    this.sans = [...v.san];
    if (this.sans.length !== was || this.pending) {
      const fresh = this.sans.length > was && !this.pending;
      this.pending = null;
      this.app.board.syncFromBoard(this.z.chess().board());
      if (fresh) { const san = this.sans[this.sans.length - 1]; if (/#$/.test(san)) SFX.end(); else if (/\+$/.test(san)) SFX.check(); else SFX.moveOpp(); }
      const lastMv = v.moves[v.moves.length - 1];
      this.last = lastMv ? textToMove(lastMv) : null;
      if (this.mode === "bughouse" && this.sans.length > this.snaps.length) this.snaps.push({ fen: this.z.fen, pockets: this.z.state().pockets, san: this.sans[this.sans.length - 1] });
    }
    this.phase = s.status === "over" ? "over" : "playing";
    if (this.myColor && s.status === "playing") { live.room = this.room; live.busy = true; }
    // clocks
    if (v.tc) {
      const turn = this.z.turn();
      const elapsed = v.clock.lastAt !== null ? Math.max(0, (v.serverNow || Date.now()) - v.clock.lastAt) : 0;
      this.clock = { w: v.clock.w, b: v.clock.b, lastTs: performance.now(), active: v.clock.lastAt !== null && s.status === "playing" ? turn : null };
      if (this.clock.active) this.clock[turn] = Math.max(0, v.clock[turn] - elapsed);
    } else this.clock = null;
    if (s.status === "over" && !this.result) {
      const r = s.result || {};
      this.finish({ over: true, winner: r.draw ? null : r.winner === v.white ? "w" : "b", reason: r.reason });
    }
    this.redraw(false);
    this.render();
  }

  _resync() {
    this.pending = null;
    if (this.lastState) this._state(this.lastState);
  }

  _clockTick() {
    if (!this.clock) return;
    const ck = this.clock;
    const ms = { w: ck.w, b: ck.b };
    if (ck.active && !this.result) {
      ms[ck.active] = ck[ck.active] - (performance.now() - ck.lastTs);
      if (ms[ck.active] <= 0 && ck.active !== this.myColor && this.myColor && Date.now() - (this.flagAt || 0) > 2500) {
        this.flagAt = Date.now();
        this.client.action({ t: "flag" });
      }
    }
    const top = this.app.board.orientation === "w" ? "b" : "w";
    updateClock(this.app.stripTop, Math.max(0, ms[top]), ck.active === top && !this.result);
    updateClock(this.app.stripBottom, Math.max(0, ms[other(top)]), ck.active === other(top) && !this.result);
  }

  // ---- drawing ----
  redraw(sync = true) {
    const b = this.app.board;
    if (sync) b.syncFromBoard(this.z.chess().board());
    const s = getSettings();
    const l = this.last;
    b.setLastMove(s.highlightLast && l ? l.from || l.to : null, s.highlightLast && l ? l.to : null);
    const c = this.z.chess();
    b.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    this.renderStrips();
  }

  player(color) {
    const me = getProfile();
    if (this.mode === "bot") return color === this.myColor ? { name: me.name, avatar: me.avatar } : { name: this.level.name, rating: null, avatar: this.level.avatar, thinking: this.thinking };
    if (this.mode === "local") return { name: color === "w" ? "White" : "Black", avatar: { emoji: color === "w" ? "♔" : "♚", bg: color === "w" ? "#8a7a62" : "#3a2e24" } };
    const v = this.lastState && this.lastState.view;
    const id = v ? (color === "w" ? v.white : v.black) : null;
    const p = id ? parsePlayerId(id) : { name: "Waiting…", rating: null };
    return { name: id === this.playerId ? me.name : p.name, rating: p.rating, avatar: id === this.playerId ? me.avatar : { emoji: "♟", bg: "#3a4a5a" } };
  }

  renderStrips() {
    const top = this.app.board.orientation === "w" ? "b" : "w";
    const strip = (color) => {
      const p = this.player(color);
      const pk = this.z.pockets[color];
      // the strip shows what's in hand; the material line counts it too
      const held = POCKET_ORDER.flatMap((t) => Array(pk[t]).fill(t));
      return { ...p, captured: held, capColor: color, clockMs: this.clock ? this.clock[color] : null, active: this.clock && this.clock.active === color };
    };
    renderStrip(this.app.stripTop, strip(top));
    renderStrip(this.app.stripBottom, strip(other(top)));
  }

  render() {
    if (this.dead) return;
    const top = this.app.board.orientation === "w" ? "b" : "w";
    const mover = this.z.turn();
    const myTurnToDrop = this.canMove(mover) ? mover : null;
    const body = [];
    if (this.phase === "unsupported") body.push(h("div.status-line.bad", h("span", "The game server hasn't been updated for Crazyhouse yet. Try again in a few minutes.")));
    if (this.phase === "waiting" || this.phase === "connecting" || this.phase === "config" || this.phase === "searching" || this.phase === "failed") body.push(this._lobby());
    if (this.netNote) body.push(h("div.status-line.bad", h("span", this.netNote)));
    const status = this.result ? (this.result.winner ? `${this.result.winner === "w" ? "White" : "Black"} won ${reasonText(this.result.reason)}` : `Draw ${reasonText(this.result.reason)}`)
      : this.phase !== "playing" ? null
        : this.thinking ? `${this.level.name} is thinking…`
          : this.mode === "local" ? `${mover === "w" ? "White" : "Black"} to move`
            : mover === this.myColor ? "Your move" : "Their move";
    if (status) body.push(h(`div.status-line${this.result ? "" : mover === this.myColor || this.mode === "local" ? ".good" : ""}`, h(`span.dot.${mover}`), h("span", status)));
    body.push(h("div.pockets",
      pocketRow(this.z.pockets, top, { label: this.mode === "local" ? (top === "w" ? "White's pocket" : "Black's pocket") : "Their pocket", onPick: myTurnToDrop === top ? (t) => this.pick(t) : null, picked: myTurnToDrop === top ? this.dropPick : null }),
      pocketRow(this.z.pockets, other(top), { label: this.mode === "local" ? (other(top) === "w" ? "White's pocket" : "Black's pocket") : "Your pocket", onPick: myTurnToDrop === other(top) ? (t) => this.pick(t) : null, picked: myTurnToDrop === other(top) ? this.dropPick : null })));
    if (this.dropPick) body.push(h("p.note", "Tap a highlighted square to drop the piece, or tap it again to cancel."));
    if (this.mode === "bughouse") body.push(this._partnerPanel());
    body.push(h("div.zh-moves", ...this.sans.map((san, i) => h("span", i % 2 === 0 ? h("b.muted", `${i / 2 + 1}.`) : null, " ", san, " "))));
    body.push(h("p.note", this.mode === "bughouse"
      ? "Bughouse: pieces you capture go to your partner, and theirs come to you. When either board ends, the match ends."
      : "Crazyhouse: pieces you capture join your pocket. On your turn you can drop one on any empty square instead of moving (pawns not on the first or last rank)."));
    const foot = [];
    if (!this.result && this.phase === "playing" && this.mode !== "local") {
      foot.push(h("div.btn-row",
        this.mode === "bot" ? null : h("button.btn", { onclick: () => { this.client.action({ t: "draw-offer" }); toast("Draw offered"); } }, "½ Offer draw"),
        h("button.btn.danger", {
          onclick: async () => {
            if (getSettings().confirmResign && !(await confirmModal({ title: "Resign this game?", yes: "Resign", danger: true }))) return;
            if (this.mode === "bot") this.finish({ over: true, winner: other(this.myColor), reason: "resignation" });
            else this.client.action({ t: this.sans.length < 2 ? "abort" : "resign" });
          },
        }, icon("flag", 18), this.mode !== "bot" && this.sans.length < 2 ? "Abort" : "Resign")));
    }
    if (this.result) foot.push(h("button.btn.primary.block", { onclick: () => this.app.go(this.mode === "bughouse" ? "#/bughouse" : "#/crazyhouse") }, "New game"));
    // a draw offer from the other side
    const v = this.lastState && this.lastState.view;
    if (v && v.drawOffer && this.myColor && v.drawOffer !== this.myColor && !this.result && this.answeredDraw !== v.drawOffer + v.moves.length) {
      this.answeredDraw = v.drawOffer + v.moves.length;
      const m = openModal({ title: "Draw offered", body: h("div.btn-row",
        h("button.btn.ghost", { onclick: () => { m.close(); this.client.action({ t: "draw-decline" }); } }, "Decline"),
        h("button.btn.primary", { onclick: () => { m.close(); this.client.action({ t: "draw-accept" }); } }, "Accept")) });
    }
    this.app.panel({ title: this.title(), back: this.mode === "bughouse" ? "#/bughouse" : "#/crazyhouse", body, foot });
    this.renderStrips();
  }

  _lobby() {
    if (this.mode === "pool") {
      return h("div.card", h("h3", this.phase === "failed" ? "No opponent found" : "Looking for a Crazyhouse opponent"),
        h("p.note", this.phase === "failed" ? (this.failNote || "Try again in a moment.") : `${tcLabel(this.cfg.tcKey || "3+0")}, rated. You'll be paired with the next player looking for the same game.`),
        h("div.btn-row", h("button.btn", { onclick: () => this.app.go("#/crazyhouse") }, this.phase === "failed" ? "Back" : "Cancel"),
          this.phase === "failed" ? h("button.btn.primary", { onclick: () => this.app.setController(() => new ZhGame(this.app, this.cfg)) }, "Try again") : null));
    }
    if (this.mode === "bughouse") {
      return h("div.card", h("h3", "Getting the boards ready"),
        h("p.note", this.phase === "waiting" ? "Waiting for your opponent on this board." : this.partnerSeats < 2 ? "Waiting for both players on the other board." : "Starting…"));
    }
    const link = location.origin + location.pathname + `?room=${this.room}&tc=${encodeURIComponent(this.cfg.tcKey || "3+0")}#/crazyhouse/online`;
    return h("div.card", h("h3", "Invite a friend to Crazyhouse"),
      h("p.note", `Send this link. The game (${tcLabel(this.cfg.tcKey || "3+0")}) starts when they open it. You play White.`),
      h("div.field", h("input.input", { value: link, readonly: true, "aria-label": "Invite link", onfocus: (e) => e.target.select() })),
      h("div.btn-row", h("button.btn.primary", { onclick: async () => { if (await copyText(link)) toast("Link copied"); } }, icon("copy", 18), "Copy link"),
        navigator.share ? h("button.btn", { onclick: () => navigator.share({ title: "Play Crazyhouse with me", url: link }).catch(() => {}) }, icon("share", 18), "Share") : null));
  }

  _partnerPanel() {
    const s = this.partnerState;
    if (!s || !s.view || !s.view.zh) return h("div.card.partner", h("h3", "Partner's board"), h("p.note", "Not started yet."));
    const v = s.view;
    // my partner plays the other colour on the other board
    const partnerColor = this.myColor ? other(this.myColor) : "w";
    const pid = partnerColor === "w" ? v.white : v.black;
    const name = (c) => parsePlayerId(c === "w" ? v.white : v.black).name;
    const ck = v.clock || { w: 0, b: 0 };
    const elapsed = v.clock && v.clock.lastAt !== null ? Math.max(0, (v.serverNow || Date.now()) - v.clock.lastAt) : 0;
    const turn = v.zh.fen.split(" ")[1];
    const t = (c) => { const ms = c === turn && s.status === "playing" ? ck[c] - elapsed : ck[c]; const sec = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };
    return h("div.card.partner",
      h("h3", `Partner's board: ${parsePlayerId(pid).name}`),
      h("div.partner-row", h("small", `${name(other(partnerColor))} ${t(other(partnerColor))}`), pocketRow(v.zh.pockets, other(partnerColor), { label: "" })),
      miniBoard(v.zh.fen, partnerColor === "b"),
      h("div.partner-row", h("small", `${name(partnerColor)} ${t(partnerColor)}`), pocketRow(v.zh.pockets, partnerColor, { label: "" })));
  }
}

// ---- setup screen ----
let setup = { mode: "bot", level: "medium", color: "w", tc: "3+0" };

export class ZhSetup {
  constructor(app) { this.app = app; }
  mount() {
    this.app.setLobby(true);
    this.app.board.syncFromBoard(new Crazyhouse().chess().board());
    this.app.board.viewSide("w", false);
    this.render();
  }
  destroy() {}
  render() {
    const body = [
      h("p", { style: { color: "var(--ink-2)" } }, "Captured pieces join your pocket, and on your turn you can drop one onto any empty square instead of moving. Games swing fast."),
      h("div.field", h("div.lbl", "Opponent"), segmented([{ value: "pool", label: "Random opponent" }, { value: "online", label: "A friend" }, { value: "bot", label: "Computer" }, { value: "local", label: "Pass and play" }], setup.mode, (v) => { setup.mode = v; this.render(); })),
    ];
    if (setup.mode === "bot") {
      body.push(h("div.bot-grid.zh-bots", ...ZH_LEVELS.map((l) => h(`button.bot-chip${l.id === setup.level ? ".on" : ""}`, { onclick: () => { setup.level = l.id; this.render(); }, "aria-label": `${l.name}, ${l.elo}` },
        h("div.avatar", { style: { background: l.avatar.bg } }, l.avatar.emoji), h("small", l.name)))));
      const lv = ZH_LEVELS.find((l) => l.id === setup.level);
      body.push(h("p.note", `${lv.name}: ${lv.elo.toLowerCase()} strength.`));
      body.push(h("div.field", h("div.lbl", "Play as"), segmented([{ value: "w", label: "White" }, { value: "b", label: "Black" }, { value: "r", label: "Random" }], setup.color, (v) => { setup.color = v; })));
    }
    if (setup.mode === "online" || setup.mode === "pool") body.push(h("div.field", h("div.lbl", "Time control"), tcPicker(setup.tc, (v) => { setup.tc = v; }, { allowCustom: setup.mode === "online", allowUnlimited: setup.mode === "online" })));
    if (setup.mode === "pool") body.push(h("p.note", `Rated. Your Crazyhouse rating: ${variantRating("crazyhouse")}.`));
    body.push(h("button.row", { onclick: () => this.app.go("#/bughouse") }, h("span.ri", icon("users", 20)), h("span.rt", h("b", "Bughouse"), h("small", "Two boards, two teams of two: your captures go to your partner")), h("span.rv", icon("chevron", 18))));
    this.app.strips(null, null);
    this.app.panel({
      title: "Crazyhouse", back: "#/variants", body,
      foot: h("button.btn.primary.big.block", { onclick: () => this.start() }, setup.mode === "online" ? "Create invite link" : setup.mode === "pool" ? "Find an opponent" : "Play"),
    });
  }
  start() {
    const color = setup.color === "r" ? (Math.random() < 0.5 ? "w" : "b") : setup.color;
    const cfg = setup.mode === "online" ? { mode: "online", room: "zh-" + randomId(10), tcKey: setup.tc }
      : setup.mode === "pool" ? { mode: "pool", tcKey: setup.tc === "inf" ? "3+0" : setup.tc }
        : { mode: setup.mode, level: setup.level, myColor: color };
    this.app.launch(() => new ZhGame(this.app, cfg), setup.mode === "online" ? "#/crazyhouse/online" : "#/crazyhouse/play");
  }
}

// ---- Bughouse: create a match, share it, take a seat ----
const SEATS = [
  { board: "a", color: "w", label: "Board 1, White", team: 1 },
  { board: "a", color: "b", label: "Board 1, Black", team: 2 },
  { board: "b", color: "w", label: "Board 2, White", team: 2 },
  { board: "b", color: "b", label: "Board 2, Black", team: 1 },
];

export class BughouseLobby {
  constructor(app, match) { this.app = app; this.match = match || null; this.tc = "3+0"; }
  mount() {
    this.app.setLobby(true);
    this.app.board.syncFromBoard(new Crazyhouse().chess().board());
    this.render();
    if (this.match) { this.refresh(); this.t = setInterval(() => this.refresh(), 2500); }
  }
  destroy() { clearInterval(this.t); this.dead = true; }
  rooms() { return { a: `bh-${this.match}-a`, b: `bh-${this.match}-b` }; }
  async refresh() {
    const r = this.rooms();
    const [a, b] = await Promise.all([peekRoom(r.a).catch(() => null), peekRoom(r.b).catch(() => null)]);
    if (this.dead) return;
    this.seats = { a: a ? a.seats : [], b: b ? b.seats : [] };
    this.render();
  }
  take(seat) {
    const r = this.rooms();
    const tc = new URLSearchParams(location.hash.split("?")[1] || "").get("tc") || this.tc;
    this.app.launch(() => new ZhGame(this.app, { mode: "bughouse", room: r[seat.board], link: r[seat.board === "a" ? "b" : "a"], tcKey: tc, board: seat.board }), `#/bughouse/${this.match}/play`);
  }
  render() {
    const body = [h("p", { style: { color: "var(--ink-2)" } }, "Four players on two boards. Your partner plays the other colour on the other board, and every piece you capture goes to them to drop. When either board ends, the match ends.")];
    let foot = null;
    if (!this.match) {
      body.push(h("div.field", h("div.lbl", "Time control"), tcPicker(this.tc, (v) => { this.tc = v; }, { allowUnlimited: false, allowCustom: false })));
      foot = h("button.btn.primary.big.block", { onclick: () => this.app.go(`#/bughouse/${randomId(8)}?tc=${encodeURIComponent(this.tc)}`) }, "Create a match");
    } else {
      const link = location.origin + location.pathname + `#/bughouse/${this.match}`;
      const seats = this.seats || { a: [], b: [] };
      // a room seats players in order (White first), so the next free seat on each board can be taken
      const taken = (s) => seats[s.board][s.color === "w" ? 0 : 1];
      const free = (s) => !taken(s) && (s.color === "w" || seats[s.board].length === 1);
      body.push(h("div.card", h("h3", "Invite three friends"), h("div.field", h("input.input", { value: link, readonly: true, "aria-label": "Match link", onfocus: (e) => e.target.select() })),
        h("button.btn.primary", { onclick: async () => { if (await copyText(link)) toast("Link copied"); } }, icon("copy", 18), "Copy link")));
      for (const team of [1, 2]) {
        body.push(h("h3.team-h", `Team ${team}`));
        body.push(h("div.rows", ...SEATS.filter((s) => s.team === team).map((s) => {
          const who = taken(s);
          return h("div.row", h(`span.dot.${s.color}`), h("span.rt", h("b", s.label), h("small", who ? parsePlayerId(who).name : "Open seat")),
            free(s) ? h("button.btn.small.primary", { onclick: () => this.take(s) }, "Take seat") : null);
        })));
      }
      body.push(h("p.note", "Seats on each board fill White first. The clocks start once all four seats are taken."));
    }
    this.app.strips(null, null);
    this.app.panel({ title: "Bughouse", back: "#/variants", body, foot });
  }
}

// ---- the variants hub ----
export class VariantsScreen {
  constructor(app) { this.app = app; }
  mount() { this.app.setLobby(true); this.render(); }
  destroy() {}
  render() {
    const row = (ic, title, sub, go) => h("button.row", { onclick: go }, h("span.ri", icon(ic, 20)), h("span.rt", h("b", title), h("small", sub)), h("span.rv", icon("chevron", 18)));
    this.app.strips(null, null);
    this.app.panel({
      title: "Variants", back: "#/",
      body: [h("div.rows",
        row("cube", "Crazyhouse", "Captured pieces come back as drops. Bots, pass and play, or a friend", () => this.app.go("#/crazyhouse")),
        row("grid", "4-Player Chess", "Four armies on one board: free-for-all or teams", () => this.app.go("#/fourplayer")),
        row("users", "Bughouse", "Two boards, two teams: your captures feed your partner", () => this.app.go("#/bughouse")),
        ...Object.entries(VX_INFO).map(([id, info]) => row(info.icon, VX_VARIANTS[id].name, info.short, () => this.app.go(`#/variant/${id}`))))],
    });
  }
}

void VALUES;
