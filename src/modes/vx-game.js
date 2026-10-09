// Duck Chess, Fog of War, Giveaway, Atomic and Horde: against the variant bots (in the worker),
// pass and play on one device, or a friend online (the room server referees with the same rules).
import { h, icon, copyText } from "../ui/dom.js";
import { openModal, toast, confirmModal, tcLabel, tcPicker, segmented, updateClock, renderStrip } from "../ui/components.js";
import { MoveInput } from "../core/input.js";
import { VxGame, VX_VARIANTS, vxTextToMove, vxMoveToText } from "../core/vx.js";
import { VX_LEVELS } from "../core/vx-engine.js";
import { think } from "./zh-game.js";
import { RoomClient, makePlayerId, parsePlayerId, live, findMatch } from "../net/room.js";
import { getProfile, getSettings, variantRating, applyVariantRating, saveVariantGame, newGameId } from "../store.js";
import { presetVariant } from "../screens/play.js";
import { SFX } from "../audio.js";
import * as Social from "../net/social.js";

const other = (c) => (c === "w" ? "b" : "w");
const randomId = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const ALL_SQUARES = [];
for (const f of "abcdefgh") for (let r = 1; r <= 8; r++) ALL_SQUARES.push(f + r);
const REASONS = {
  king: "by taking the king", explosion: "by blowing up the king", checkmate: "by checkmate", "stalemate-win": "with no moves left",
  stalemate: "by stalemate", "no-pieces": "by losing every piece", horde: "by taking the whole horde", threefold: "by repetition",
  fifty: "by the 50-move rule", material: "with only the kings left", resignation: "by resignation", timeout: "on time",
  agreement: "by agreement", aborted: "game aborted", threecheck: "by three checks", hill: "by reaching the centre",
};
// these three have Stockfish bots in the main bot setup, so "Computer" goes there
const STOCKFISH_BOTS = { chess960: "960", threecheck: "3check", koth: "koth" };
const HILL_SQUARES = ["d4", "e4", "d5", "e5"];

// what each variant is, in a sentence or two, for the setup screen and the game panel
export const VX_INFO = {
  duck: { icon: "duck", short: "Move, then place the duck. Take the king to win", rules: "After every move, put the duck on any empty square. Nothing can land on it or pass through it (knights jump over). There's no check: take the king to win, and a player left with no move wins." },
  fog: { icon: "eye", short: "You only see where your pieces can go", rules: "You only see your own pieces and the squares they can move to. There's no check, so watch for the unseen: take the king to win." },
  giveaway: { icon: "gift", short: "Lose all your pieces to win. Captures are forced", rules: "Lose all your pieces, or get stuck with no move, to win. If you can capture you must, the king is an ordinary piece, and pawns may promote to a king." },
  atomic: { icon: "bolt", short: "Every capture explodes. Blow up the king", rules: "Every capture is an explosion: the capturing piece and every piece next to it, except pawns, are destroyed. Blow up the king (or checkmate it) to win. Kings can't capture, and touching kings can't be in check." },
  horde: { icon: "users", short: "36 pawns against a full army", rules: "White has 36 pawns and no king. Black wins by taking every white piece; White wins by checkmating Black. Pawns on the first rank may step two squares." },
  chess960: { icon: "grid", short: "Shuffled back rank. Bots, pass and play, or a friend", rules: "The back-rank pieces start in one of 960 shuffled orders, the same for both sides. Castle by moving your king onto its rook; king and rook land where they would in normal chess." },
  koth: { icon: "star", short: "Also win by reaching the centre with your king", rules: "Normal chess, but you also win by getting your king to one of the four centre squares (d4, e4, d5, e5)." },
  threecheck: { icon: "bolt", short: "Also win by giving three checks", rules: "Normal chess, but you also win by checking the enemy king three times." },
};

function lostPieces(g, colour) {
  // pieces of `colour` no longer on the board, compared with the variant's starting position
  const start = new VxGame(g.variant).board().flat().filter((p) => p && p.color === colour);
  const now = g.board().flat().filter((p) => p && p.color === colour);
  const count = (list) => { const c = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }; for (const p of list) c[p.type]++; return c; };
  const a = count(start), b = count(now);
  const out = [];
  for (const t of ["q", "r", "b", "n", "p"]) for (let i = 0; i < Math.max(0, a[t] - b[t]); i++) out.push(t);
  return out;
}

export class VxPlay {
  // cfg: { variant, mode: "bot"|"local"|"online"|"pool", level, myColor, room, tcKey }
  // ("online" is a friend's invite; "pool" a rated game against a random opponent)
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.variant = cfg.variant;
    this.rules = VX_VARIANTS[cfg.variant];
    this.mode = cfg.mode;
    this.start = cfg.variant === "chess960" ? cfg.start ?? Math.floor(Math.random() * 960) : undefined;
    this.g = new VxGame(this.variant, { start: this.start });
    this.startFen = this.g.fen;
    this.moveTexts = [];
    this.id = newGameId();
    this.sans = [];
    this.last = null;
    this.result = null;
    this.myColor = cfg.myColor || "w";
    this.level = VX_LEVELS.find((l) => l.id === cfg.level) || VX_LEVELS[1];
    this.phase = this.online ? "connecting" : "playing";
    this.duckFor = null;      // Duck Chess: { m, opts } while the duck is being placed
    this.curtain = false;     // Fog of War, pass and play: the board is hidden while the device changes hands
    this.clock = null;
    this.input = new MoveInput(app, {
      getChess: () => (this.canInput() ? this.inputView() : null),
      canMove: (c) => this.canMove(c),
      premoveColor: () => null,
      onMove: (m) => this.pieceMove(m),
    });
  }

  get online() { return this.mode === "online" || this.mode === "pool"; }
  title() { return this.rules.name; }
  canInput() { return !this.result && this.phase === "playing" && !this.duckFor && !this.curtain && !this.sent; }
  canMove(c) {
    if (!this.canInput() || this.g.turn() !== c) return false;
    return this.mode === "local" ? true : c === this.myColor;
  }
  bottom() { return this.mode === "local" ? this.g.turn() : this.myColor || "w"; }
  // whose eyes the board is seen through in Fog of War (nobody's once the game is over)
  viewer() { return this.rules.fog && !this.result ? (this.mode === "local" ? this.g.turn() : this.myColor) : null; }

  // Online Fog of War: the server knows what's really there, so it sends our legal moves
  inputView() {
    if (!this.serverLegal) return this.g;
    const g = this.g, legal = this.serverLegal;
    return { turn: () => g.turn(), get: (sq) => g.get(sq), moves: (o) => g.moves(o).filter((m) => legal.has(m.from + m.to + (m.promotion || ""))) };
  }

  mount() {
    this.app.setInGame(true);
    live.busy = !this.online;
    this.app.bindBoard({
      onSquareTap: (sq) => this.tap(sq),
      canDrag: (sq) => this.input.canDrag(sq),
      onDragStart: (sq) => { this.input._dragFrom = sq; this.input.select(sq); },
      onDrop: (from, to) => this.input.drop(from, to),
    });
    this.app.board.viewSide(this.bottom(), false);
    this.redraw();
    this.render();
    this.tick = setInterval(() => this._clockTick(), 200);
    if (this.mode === "bot" && this.myColor !== this.g.turn()) this.botMove();
    if (this.online) this.connect();
    this.app.leaveGuard = async () => {
      if (this.result || this.phase !== "playing" || !this.online) return true;
      const ok = await confirmModal({ title: "Leave and resign?", sub: "Leaving a live game counts as a loss.", yes: "Resign and leave", danger: true });
      if (ok && this.client) this.client.action({ t: "resign" });
      return ok;
    };
  }
  destroy() {
    this.dead = true;
    live.busy = false;
    if (live.room === this.room) live.room = null;
    clearInterval(this.tick);
    this.input.clear();
    // both boards (2D and 3D) may have drawn the duck or the fog
    for (const b of Object.values(this.app.boards)) if (b) { b.setDuck(null); b.setFog([]); b.setMarks([]); }
    if (this.search) this.search.cancel();
    if (this.client) this.client.close();
    const params = new URLSearchParams(location.search);
    if (params.has("room")) { params.delete("room"); params.delete("tc"); history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash); }
  }
  onBoardSwap() { this.redraw(); }

  // ---- input ----
  tap(sq) {
    if (this.duckFor) {
      if (this.duckFor.opts.includes(sq)) {
        const m = { ...this.duckFor.m, duck: sq };
        this.duckFor = null;
        this.app.board.clearHints();
        this.play(m, { shown: true });
      } else toast("Tap an empty square for the duck");
      return;
    }
    this.input.tap(sq);
  }

  // a piece move from the board; in Duck Chess the duck comes next (unless that move took the king)
  pieceMove(m) {
    if (this.rules.duck) {
      const opts = this.g.duckOptions(m);
      if (opts.length) {
        this.duckFor = { m, opts };
        this.input.clear();
        const b = this.app.board;
        b.syncFromBoard(this.g.previewBoard(m));
        b.setLastMove(m.from, m.to);
        b.showMoves(opts, []);
        SFX.move();
        this.render();
        return;
      }
    }
    this.play(m);
  }
  cancelDuck() {
    this.duckFor = null;
    this.app.board.clearHints();
    this.redraw();
    this.render();
  }

  play(m, { remote = false, shown = false } = {}) {
    const d = this.g.move(m);
    if (!d) return null;
    if (!this.online) this.moveTexts.push(vxMoveToText(m));
    this.sans.push(d.san);
    this.last = d;
    this.input.clear();
    const b = this.app.board;
    const sound = () => {
      const over = !this.online && this.g.outcome().over;   // online, the server decides
      if (over) SFX.end(); else if (/\+$/.test(d.san)) SFX.check(); else if (d.captured) SFX.capture(); else if (remote) SFX.moveOpp(); else SFX.move();
    };
    if (this.rules.fog || shown || d.castle960) { this.redraw(); sound(); }
    else {
      b.animateMove({ ...d, flags: d.flags || "" }, {}, () => {
        if (this.dead) return;
        this.redraw();
        if (d.exploded && d.exploded.length) this.flash([d.to, ...d.exploded]);
      });
      sound();
    }
    if (this.online && !remote) {
      this.client.action({ t: "move", move: vxMoveToText(m) });
      this.sent = true;
    }
    if (this.mode === "bot" || this.mode === "local") {
      const o = this.g.outcome();
      if (o.over) this.finish(o);
      else if (this.mode === "bot" && this.g.turn() !== this.myColor) this.botMove();
      else if (this.mode === "local") {
        if (this.rules.fog) { this.curtain = true; this.redraw(); }
        else setTimeout(() => !this.dead && b.viewSide(this.g.turn()), 350);
      }
    }
    this.render();
    return d;
  }

  // Atomic: a short orange flash where the explosion was
  flash(squares) {
    const b = this.app.board;
    b.setMarks(squares.map((sq) => ({ sq, color: "rgba(255,128,32,.6)" })));
    setTimeout(() => { if (!this.dead) b.setMarks([]); }, 650);
  }

  async botMove() {
    this.thinking = true;
    this.render();
    const t0 = performance.now();
    const move = await think(this.g.state(), this.level.opts, "vx");
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (performance.now() - t0))));
    this.thinking = false;
    if (this.dead || this.result || !move) { this.render(); return; }
    this.play(vxTextToMove(move), { remote: true });
  }

  finish(o) {
    if (this.result) return;
    this.result = o;
    const extra = this.record(o);
    this.duckFor = null;
    this.curtain = false;
    live.busy = false;
    if (live.room === this.room) live.room = null;
    if (this.clock) this.clock.active = null;
    this.redraw();
    this.render();
    const mine = o.winner === this.myColor;
    const title = !o.winner ? "Draw" : this.mode === "local" ? `${o.winner === "w" ? "White" : "Black"} won` : mine ? "You won!" : "You lost";
    setTimeout(() => {
      if (this.dead) return;
      const m = openModal({
        title, sub: (REASONS[o.reason] || "") + (extra.delta != null ? `. ${this.rules.name} rating ${extra.rating} (${extra.delta >= 0 ? "+" : ""}${extra.delta})` : ""),
        body: h("div.btn-row",
          h("button.btn", { onclick: () => { m.close(); this.app.go(`#/variant/${this.variant}`); } }, "New game"),
          this.mode === "pool" ? h("button.btn.primary", { onclick: () => { m.close(); this.app.setController(() => new VxPlay(this.app, this.cfg)); } }, "New opponent") : null,
          !this.online ? h("button.btn.primary", { onclick: () => { m.close(); this.app.setController(() => new VxPlay(this.app, { ...this.cfg, myColor: this.mode === "bot" ? other(this.myColor) : "w" })); } }, "Rematch") : null),
      });
    }, 500);
  }

  // the game for the archive (and the rating, for games against a random opponent)
  record(o) {
    if (o.reason === "aborted") return {};
    const v = this.lastState && this.lastState.view;
    // online, the server has the whole game (in Fog of War it's revealed once the game ends)
    const texts = this.online ? (v ? v.moves.filter(Boolean) : []) : this.moveTexts;
    const startFen = this.online && v && v.vx && v.vx.keys && v.vx.keys[0] ? v.vx.keys[0] + " 0 1" : this.startFen;
    if (!texts.length) return {};
    const z = new VxGame(this.variant, { fen: startFen });
    const plies = [];
    for (const t of texts) { const d = z.move(vxTextToMove(t)); if (!d) break; plies.push({ fen: z.fen, san: d.san }); }
    const my = this.mode === "local" ? null : this.myColor;
    const myResult = !my ? null : !o.winner ? "draw" : o.winner === my ? "win" : "loss";
    let delta = null, rating = null;
    if (this.mode === "pool" && my) {
      const opp = this.oppInfo && this.oppInfo.rating ? this.oppInfo.rating : 1500;
      delta = applyVariantRating(this.variant, opp, myResult === "win" ? 1 : myResult === "loss" ? 0 : 0.5);
      rating = variantRating(this.variant);
    }
    const name = (c) => this.player(c).name;
    saveVariantGame({
      id: this.id, date: Date.now(), variant: this.variant, mode: this.mode, tc: this.cfg.tcKey || null, rated: this.mode === "pool",
      white: { name: name("w"), rating: this.player("w").rating || null }, black: { name: name("b"), rating: this.player("b").rating || null },
      myColor: my, myResult, result: !o.winner ? "1/2-1/2" : o.winner === "w" ? "1-0" : "0-1", reason: o.reason, delta,
      start: startFen, plies,
    });
    return { delta, rating };
  }

  // ---- online ----
  connect() {
    const me = getProfile();
    const handlers = {
      onState: (s) => this._state(s),
      onError: (err) => { if (!/not your turn|already/.test(err)) toast(err); this.sent = false; if (this.lastState) this._state(this.lastState); },
      onStatus: (st) => { this.netNote = st === "disconnected" ? "Connection lost. Reconnecting…" : null; this.render(); },
    };
    if (this.mode === "pool") {
      // rated: you show with your rating in this variant
      this.playerId = makePlayerId(me.name, variantRating(this.variant), Social.myCode());
      this.phase = "searching";
      this.search = findMatch(this.cfg.tcKey || "3+0", this.playerId, () => this.render(), { prefix: "vp" + this.variant });
      this.search.promise.then(({ room, client }) => {
        if (this.dead) { client.close(); return; }
        this.search = null;
        this.room = room;
        this.client = client;
        SFX.notify();
        client.rebind(handlers);
      }).catch((e) => { this.search = null; if (!this.dead) { this.phase = "failed"; this.failNote = e.message; this.render(); } });
      return;
    }
    this.room = this.cfg.room;
    this.playerId = sessionStorage.getItem("mp-pid-" + this.room) || makePlayerId(me.name, me.ratings.blitz.r, Social.myCode());
    sessionStorage.setItem("mp-pid-" + this.room, this.playerId);
    const params = new URLSearchParams(location.search);
    params.set("room", this.room);
    params.set("tc", this.cfg.tcKey || "3+0");
    history.replaceState(null, "", location.pathname + "?" + params + `#/variant/${this.variant}/online`);
    this.client = new RoomClient(this.room, this.playerId, handlers);
  }

  _state(s) {
    this.lastState = s;
    if (s.status === "waiting") { this.phase = "waiting"; this.render(); return; }
    const v = s.view;
    if (!v) return;
    this.myColor = v.white === s.you ? "w" : v.black === s.you ? "b" : null;
    const opp = this.myColor ? parsePlayerId(this.myColor === "w" ? v.black : v.white) : null;
    this.oppInfo = opp;
    if ((v.v || 1) < 5) { this.phase = "unsupported"; this.render(); return; }
    if (v.phase === "config") {
      this.phase = "config";
      if (v.white === this.playerId && !this.sentConfig) {
        this.sentConfig = true;
        this.client.action({ t: "config", tc: this.cfg.tcKey || "3+0", variant: this.variant, start: this.start });
      }
      this.render();
      return;
    }
    if (!v.vx) return;
    if (this.app.board.orientation !== (this.myColor || "w")) this.app.board.viewSide(this.myColor || "w", false);
    const was = this.sans.length;
    this.g = new VxGame(v.variant, v.vx);
    this.sans = v.san.map((x) => x || "?");
    this.visible = v.visible || null;
    this.serverLegal = v.legal ? new Set(v.legal.map((t) => t.split(",")[0])) : null;
    const lastText = v.moves[v.moves.length - 1];
    this.last = lastText ? vxTextToMove(lastText) : null;
    if (this.sans.length !== was && !this.sent && was) {
      const san = this.sans[this.sans.length - 1];
      if (/#$/.test(san)) SFX.end(); else if (/\+$/.test(san)) SFX.check(); else if (/x/.test(san)) SFX.capture(); else SFX.moveOpp();
    }
    this.sent = false;
    this.phase = s.status === "over" ? "over" : "playing";
    if (this.myColor && s.status === "playing") { live.room = this.room; live.busy = true; }
    if (v.tc) {
      const turn = this.g.turn();
      const elapsed = v.clock.lastAt !== null ? Math.max(0, (v.serverNow || Date.now()) - v.clock.lastAt) : 0;
      this.clock = { w: v.clock.w, b: v.clock.b, lastTs: performance.now(), active: v.clock.lastAt !== null && s.status === "playing" ? turn : null };
      if (this.clock.active) this.clock[turn] = Math.max(0, v.clock[turn] - elapsed);
    } else this.clock = null;
    if (s.status === "over" && !this.result) {
      const r = s.result || {};
      this.finish({ over: true, winner: r.draw ? null : r.winner === v.white ? "w" : "b", reason: r.reason });
    }
    this.redraw();
    this.render();
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
  redraw() {
    const b = this.app.board;
    if (this.curtain) {
      b.syncFromBoard(null);
      b.setFog(ALL_SQUARES);
      b.setDuck(null);
      b.setLastMove(null, null);
      b.setCheck(null);
      this.renderStrips();
      return;
    }
    const eyes = this.viewer();
    // online, the server already hid what we can't see; offline we hide it here
    const fogged = eyes && !this.online;
    b.syncFromBoard(fogged ? this.g.foggedBoard(eyes) : this.g.board());
    const seen = eyes ? new Set(this.online && this.visible ? this.visible : this.g.visible(eyes)) : null;
    b.setFog(seen ? ALL_SQUARES.filter((sq) => !seen.has(sq)) : []);
    b.setDuck(this.g.duck());
    const s = getSettings();
    const l = this.last;
    // in the fog, only your own last move is shown
    const showLast = s.highlightLast && l && (!eyes || this.lastBy() === eyes);
    b.setLastMove(showLast ? l.from : null, showLast ? l.to : null);
    b.setCheck(this.rules.check && this.g.inCheck() ? this.g.kingSquare(this.g.turn()) : null);
    // King of the Hill: the four goal squares stay lightly marked
    if (this.rules.hill) b.setMarks(HILL_SQUARES.map((sq) => ({ sq, color: "rgba(217,180,90,.28)" })));
    this.renderStrips();
  }
  lastBy() { return this.sans.length % 2 === 1 ? "w" : "b"; }

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
    // what each side has taken (hidden in the fog, where it would give positions away)
    const strip = (color) => ({ ...this.player(color), captured: this.viewer() ? [] : lostPieces(this.g, other(color)), capColor: other(color), clockMs: this.clock ? this.clock[color] : null, active: this.clock && this.clock.active === color });
    renderStrip(this.app.stripTop, strip(top));
    renderStrip(this.app.stripBottom, strip(other(top)));
  }

  render() {
    if (this.dead) return;
    const mover = this.g.turn();
    const body = [];
    if (this.phase === "unsupported") body.push(h("div.status-line.bad", h("span", `The game server hasn't been updated for ${this.rules.name} yet. Try again in a few minutes.`)));
    if (this.phase === "searching" || this.phase === "failed") body.push(this._searching());
    else if (this.phase === "waiting" || this.phase === "connecting" || this.phase === "config") body.push(this.mode === "pool" ? this._searching() : this._lobby());
    if (this.netNote) body.push(h("div.status-line.bad", h("span", this.netNote)));
    const name = (c) => (c === "w" ? "White" : "Black");
    const status = this.result ? (this.result.winner ? `${name(this.result.winner)} won ${REASONS[this.result.reason] || ""}` : `Draw ${REASONS[this.result.reason] || ""}`)
      : this.phase !== "playing" ? null
        : this.duckFor ? "Now place the duck on an empty square"
          : this.curtain ? `Pass the device to ${name(mover)}`
            : this.thinking ? `${this.level.name} is thinking…`
              : this.mode === "local" ? `${name(mover)} to move`
                : mover === this.myColor ? "Your move" : "Their move";
    if (status) body.push(h(`div.status-line${this.result ? "" : this.duckFor || mover === this.myColor || this.mode === "local" ? ".good" : ""}`, h(`span.dot.${mover}`), h("span", status)));
    if (this.duckFor) body.push(h("div.btn-row", h("button.btn", { onclick: () => this.cancelDuck() }, icon("undo", 18), "Take back the move")));
    if (this.curtain) {
      body.push(h("div.card", h("p.note", `The board is hidden so ${name(mover)} can't see ${name(other(mover))}'s pieces. Hand over the device, then show the board.`),
        h("button.btn.primary.block", { onclick: () => { this.curtain = false; this.app.board.viewSide(mover, false); this.redraw(); this.render(); } }, icon("eye", 18), `Show ${name(mover)}'s board`)));
    }
    body.push(h("div.zh-moves", ...this.sans.map((san, i) => h("span", i % 2 === 0 ? h("b.muted", `${i / 2 + 1}.`) : null, " ", this.viewer() && !this.online && (i % 2 === 0 ? "w" : "b") !== this.viewer() ? "?" : san, " "))));
    if (this.rules.threeCheck) body.push(h("div.status-line", h("span", `Checks given: White ${this.g.checksGiven("w")}/3, Black ${this.g.checksGiven("b")}/3`)));
    body.push(h("p.note", VX_INFO[this.variant].rules));
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
    if (this.result) foot.push(h("button.btn.primary.block", { onclick: () => this.app.go(`#/variant/${this.variant}`) }, "New game"));
    const v = this.lastState && this.lastState.view;
    if (v && v.drawOffer && this.myColor && v.drawOffer !== this.myColor && !this.result && this.answeredDraw !== v.drawOffer + v.moves.length) {
      this.answeredDraw = v.drawOffer + v.moves.length;
      const m = openModal({ title: "Draw offered", body: h("div.btn-row",
        h("button.btn.ghost", { onclick: () => { m.close(); this.client.action({ t: "draw-decline" }); } }, "Decline"),
        h("button.btn.primary", { onclick: () => { m.close(); this.client.action({ t: "draw-accept" }); } }, "Accept")) });
    }
    this.app.panel({ title: this.title(), back: `#/variant/${this.variant}`, body, foot });
    this.renderStrips();
  }

  _searching() {
    return h("div.card", h("h3", this.phase === "failed" ? "No opponent found" : `Looking for a ${this.rules.name} opponent`),
      h("p.note", this.phase === "failed" ? (this.failNote || "Try again in a moment.") : `${tcLabel(this.cfg.tcKey || "3+0")}, rated. You'll be paired with the next player looking for the same game.`),
      h("div.btn-row", h("button.btn", { onclick: () => this.app.go(`#/variant/${this.variant}`) }, this.phase === "failed" ? "Back" : "Cancel"),
        this.phase === "failed" ? h("button.btn.primary", { onclick: () => this.app.setController(() => new VxPlay(this.app, this.cfg)) }, "Try again") : null));
  }

  _lobby() {
    const link = location.origin + location.pathname + `?room=${this.room}&tc=${encodeURIComponent(this.cfg.tcKey || "3+0")}#/variant/${this.variant}/online`;
    return h("div.card", h("h3", `Invite a friend to ${this.rules.name}`),
      h("p.note", `Send this link. The game (${tcLabel(this.cfg.tcKey || "3+0")}) starts when they open it. You play White.`),
      h("div.field", h("input.input", { value: link, readonly: true, "aria-label": "Invite link", onfocus: (e) => e.target.select() })),
      h("div.btn-row", h("button.btn.primary", { onclick: async () => { if (await copyText(link)) toast("Link copied"); } }, icon("copy", 18), "Copy link"),
        navigator.share ? h("button.btn", { onclick: () => navigator.share({ title: `Play ${this.rules.name} with me`, url: link }).catch(() => {}) }, icon("share", 18), "Share") : null));
  }
}

// ---- setup screen (one per variant) ----
const setups = {};

export class VxSetup {
  constructor(app, variant) {
    this.app = app;
    this.variant = variant;
    this.s = setups[variant] || (setups[variant] = { mode: "bot", level: "medium", color: variant === "horde" ? "b" : "w", tc: "3+0" });
  }
  mount() {
    this.app.setLobby(true);
    const g = new VxGame(this.variant);
    this.app.board.syncFromBoard(g.board());
    this.app.board.setDuck(null);
    this.app.board.setFog([]);
    this.app.board.viewSide("w", false);
    this.render();
  }
  destroy() {}
  render() {
    const s = this.s, rules = VX_VARIANTS[this.variant];
    const body = [
      h("p", { style: { color: "var(--ink-2)" } }, VX_INFO[this.variant].rules),
      h("div.field", h("div.lbl", "Opponent"), segmented([{ value: "pool", label: "Random opponent" }, { value: "online", label: "A friend" }, { value: "bot", label: "Computer" }, { value: "local", label: "Pass and play" }], s.mode, (v) => { s.mode = v; this.render(); })),
    ];
    if (s.mode === "bot" && STOCKFISH_BOTS[this.variant]) {
      body.push(h("p.note", `${rules.name} bots are in Play bots, with all 16 personalities. Play opens there with ${rules.name} chosen.`));
    } else if (s.mode === "bot") {
      body.push(h("div.bot-grid.zh-bots", ...VX_LEVELS.map((l) => h(`button.bot-chip${l.id === s.level ? ".on" : ""}`, { onclick: () => { s.level = l.id; this.render(); }, "aria-label": `${l.name}, ${l.elo}` },
        h("div.avatar", { style: { background: l.avatar.bg } }, l.avatar.emoji), h("small", l.name)))));
      const lv = VX_LEVELS.find((l) => l.id === s.level);
      body.push(h("p.note", `${lv.name}: ${lv.elo.toLowerCase()} strength.`));
      const colors = this.variant === "horde" ? [{ value: "w", label: "White (the horde)" }, { value: "b", label: "Black" }] : [{ value: "w", label: "White" }, { value: "b", label: "Black" }, { value: "r", label: "Random" }];
      body.push(h("div.field", h("div.lbl", "Play as"), segmented(colors, s.color, (v) => { s.color = v; })));
    }
    if (s.mode === "local" && rules.fog) body.push(h("p.note", "Between turns the board is hidden, so each player only sees their own side."));
    if (s.mode === "online" || s.mode === "pool") body.push(h("div.field", h("div.lbl", "Time control"), tcPicker(s.tc, (v) => { s.tc = v; }, { allowCustom: s.mode === "online", allowUnlimited: s.mode === "online" })));
    if (s.mode === "pool") {
      const slot = getProfile().variants[this.variant];
      body.push(h("p.note", `Rated. Your ${rules.name} rating: ${variantRating(this.variant)}${slot ? ` after ${slot.n} game${slot.n === 1 ? "" : "s"}` : " (new)"}.`));
    }
    this.app.strips(null, null);
    this.app.panel({
      title: rules.name, back: "#/variants", body,
      foot: h("button.btn.primary.big.block", { onclick: () => this.start() }, s.mode === "online" ? "Create invite link" : s.mode === "pool" ? "Find an opponent" : "Play"),
    });
  }
  start() {
    const s = this.s;
    if (s.mode === "bot" && STOCKFISH_BOTS[this.variant]) { presetVariant(STOCKFISH_BOTS[this.variant]); this.app.go("#/bots"); return; }
    const color = s.color === "r" ? (Math.random() < 0.5 ? "w" : "b") : s.color;
    const start = this.variant === "chess960" ? Math.floor(Math.random() * 960) : undefined;
    const cfg = s.mode === "online" ? { variant: this.variant, mode: "online", room: "vx-" + randomId(10), tcKey: s.tc, start }
      : s.mode === "pool" ? { variant: this.variant, mode: "pool", tcKey: s.tc === "inf" ? "3+0" : s.tc, start }
        : { variant: this.variant, mode: s.mode, level: s.level, myColor: color, start };
    this.app.launch(() => new VxPlay(this.app, cfg), `#/variant/${this.variant}/${s.mode === "online" ? "online" : "play"}`);
  }
}
