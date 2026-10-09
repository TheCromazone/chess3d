// 4-Player Chess: free-for-all or Teams, against three bots, four people on one device, or four
// friends online (a four-seat room; the server referees with the same rules). The 14x14 board is
// drawn here in the page (the 3D board is 8x8), turned so your army sits at the bottom.
import { h, icon, copyText, fmtClock } from "../ui/dom.js";
import { openModal, toast, confirmModal, tcLabel, tcPicker, segmented, promotionModal } from "../ui/components.js";
import { FourPlayer, FP_COLORS, FP_NAMES, fpTextToMove, fpMoveToText } from "../core/fp.js";
import { FP_LEVELS } from "../core/fp-engine.js";
import { think } from "./zh-game.js";
import { RoomClient, makePlayerId, parsePlayerId, live } from "../net/room.js";
import { getProfile, getSettings } from "../store.js";
import { SFX } from "../audio.js";
import * as Social from "../net/social.js";

const randomId = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const FILES = "abcdefghijklmn";
const INK = { r: "#cf3f37", b: "#3b7bd0", y: "#e1b12c", g: "#3c9a58", dead: "#9c968c" };
const TEAM_NAME = { ry: "Red and Yellow", bg: "Blue and Green" };
const REASONS = {
  checkmate: "by checkmate", stalemate: "by stalemate", king: "by taking a king", resignation: "by resignation", timeout: "on time",
  "last-standing": "with three players out", claimed: "on a claimed win", threefold: "by repetition", fifty: "by the 50-move rule", material: "with only kings left",
};

// pieces: the board's own 2D set, recoloured for each army (built once from the white pieces)
const pieceArt = {};
let artReady = null;
function loadArt() {
  if (!artReady) {
    artReady = Promise.all(["K", "Q", "R", "B", "N", "P"].map(async (t) => {
      const svg = await (await fetch(`./assets/pieces/cburnett/w${t}.svg`)).text();
      for (const [k, color] of Object.entries(INK)) pieceArt[k + t.toLowerCase()] = `url("data:image/svg+xml,${encodeURIComponent(svg.replace(/fill="#fff"/g, `fill="${color}"`))}")`;
    }));
  }
  return artReady;
}

// screen cell (row from the top, column from the left) -> board square, for the army at the bottom
function cellSquare(row, col, bottom) {
  const x = col, y = 13 - row;
  const [f, r] = bottom === "r" ? [x, y] : bottom === "b" ? [y, 13 - x] : bottom === "y" ? [13 - x, 13 - y] : [13 - y, x];
  if ((f < 3 || f > 10) && (r < 3 || r > 10)) return null;
  return FILES[f] + (r + 1);
}

// the board: { sel, last, targets: Map(sq -> move), onTap } are optional (the setup shows a still board)
function drawBoard(g, view, { sel = null, last = null, targets = new Map(), onTap = null } = {}) {
  const pieces = new Map(g.pieces().map((p) => [p.sq, p]));
  const checked = new Set(FP_COLORS.filter((c) => g.status()[FP_COLORS.indexOf(c)] !== "out" && g.inCheck(c)).map((c) => g.kingSquare(c)));
  const cells = [];
  for (let row = 0; row < 14; row++) {
    for (let col = 0; col < 14; col++) {
      const sq = cellSquare(row, col, view);
      if (!sq) { cells.push(h("div.fp-void")); continue; }
      const f = FILES.indexOf(sq[0]), r = Number(sq.slice(1)) - 1;
      const p = pieces.get(sq);
      const cls = ["fp-sq", (f + r) % 2 ? "lt" : "dk"];
      if (last && (last.from === sq || last.to === sq)) cls.push("last");
      if (sel === sq) cls.push("sel");
      if (checked.has(sq)) cls.push("check");
      const tgt = targets.get(sq);
      const label = p ? ` ${FP_NAMES[p.color]} ${({ k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" })[p.type]}${p.dead ? " (out)" : ""}` : "";
      cells.push(h(`div.${cls.join(".")}`, onTap ? { onclick: () => onTap(sq), "data-sq": sq, role: "button", "aria-label": sq + label } : { "data-sq": sq },
        p ? h(`span.fp-pc${p.dead ? ".dead" : ""}`, { style: { backgroundImage: pieceArt[(p.dead ? "dead" : p.color) + p.type] || "none" } },
          pieceArt[p.color + p.type] ? null : h("span.fp-letter", { style: { color: INK[p.dead ? "dead" : p.color] } }, p.type.toUpperCase())) : null,
        tgt ? h(tgt.captured ? "span.fp-ring" : "span.fp-dot") : null,
        col === 0 ? h("small.fp-coord.rk", view === "r" || view === "y" ? sq.slice(1) : sq[0]) : null,
        row === 13 ? h("small.fp-coord.fl", view === "r" || view === "y" ? sq[0] : sq.slice(1)) : null));
    }
  }
  return h("div.fp-board", ...cells);
}

export class FourPlayerGame {
  // cfg: { mode: "bot"|"local"|"online", rules: "ffa"|"teams", level, myColor, room, tcKey }
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.g = new FourPlayer(cfg.rules || "ffa");
    this.myColor = cfg.myColor || "r";
    this.view = this.mode === "local" ? "r" : this.myColor;
    this.level = FP_LEVELS.find((l) => l.id === cfg.level) || FP_LEVELS[1];
    this.sel = null;
    this.last = null;
    this.phase = this.mode === "online" ? "connecting" : "playing";
  }

  mount() {
    this.app.setInGame(true);
    live.busy = this.mode !== "online";
    this.root = h("div.fp-page");
    this.app.pageMode(this.root);
    loadArt().then(() => !this.dead && this.render());
    this.render();
    this.tick = setInterval(() => this._clockTick(), 250);
    if (this.mode === "online") this.connect();
    else this.maybeBot();
    this.app.leaveGuard = async () => {
      if (this.g.result || this.phase !== "playing" || this.mode === "local") return true;
      if (this.mode === "bot" && this.g.status()[FP_COLORS.indexOf(this.myColor)] !== "active") return true;
      const ok = await confirmModal({ title: "Leave and resign?", sub: "Leaving counts as resigning.", yes: "Resign and leave", danger: true });
      if (ok && this.client) this.client.action({ t: "resign" });
      return ok;
    };
  }
  destroy() {
    this.dead = true;
    live.busy = false;
    if (live.room === this.room) live.room = null;
    clearInterval(this.tick);
    if (this.client) this.client.close();
    const params = new URLSearchParams(location.search);
    if (params.has("room")) { params.delete("room"); params.delete("tc"); params.delete("rules"); history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash); }
  }

  isHuman(color) { return this.mode === "local" || (this.mode === "online" ? color === this.myColor : color === this.myColor); }
  canMove() { return !this.g.result && this.phase === "playing" && !this.waiting && this.isHuman(this.g.turn()) && !this.thinking; }

  // ---- input: tap a piece, then where it goes ----
  async tap(sq) {
    if (!this.canMove()) return;
    const legal = this.g.legalMoves();
    if (this.sel) {
      const cands = legal.filter((m) => m.from === this.sel && m.to === sq);
      if (cands.length) {
        let promotion = cands[0].promotion;
        if (cands.length > 1) {
          promotion = getSettings().autoQueen ? "q" : await promotionModal("w");
          if (!promotion) return;
        }
        this.sel = null;
        this.play({ from: cands[0].from, to: sq, promotion });
        return;
      }
    }
    this.sel = legal.some((m) => m.from === sq) && this.sel !== sq ? sq : null;
    this.render();
  }

  play(m, { remote = false } = {}) {
    const before = this.g.points();
    const events = this.g.play(m);
    if (!events) return;
    this.last = { from: m.from, to: m.to };
    this.sound(events, remote);
    if (this.mode === "online" && !remote) { this.client.action({ t: "move", move: fpMoveToText(m) }); this.waiting = true; }
    this.afterTurn(events, before);
  }

  sound(events, remote) {
    const mv = events.find((e) => e.t === "move" && !e.auto) || events[0];
    if (this.g.result || events.some((e) => e.t === "checkmate")) SFX.end();
    else if (mv && /\+$/.test(mv.san)) SFX.check();
    else if (mv && mv.captured) SFX.capture();
    else if (remote) SFX.moveOpp(); else SFX.move();
  }

  afterTurn(events, before) {
    for (const e of events) {
      if (e.t === "checkmate") toast(`${FP_NAMES[e.color]} is checkmated${e.by && !this.g.teams ? ` (+20 ${FP_NAMES[e.by]})` : ""}`);
      if (e.t === "stalemate") toast(`${FP_NAMES[e.color]} is stalemated`);
      if (e.t === "multi-check") toast(`${FP_NAMES[e.color]} checks ${e.kings} kings at once: +${e.points}`);
      if (e.t === "king-taken") toast(`${FP_NAMES[e.by]} took ${FP_NAMES[e.color]}'s king`);
    }
    void before;
    if (this.mode === "local" && !this.g.result) this.view = this.g.turn();
    if (this.g.result) this.finish();
    this.render();
    this.maybeBot();
  }

  async maybeBot() {
    if (this.mode !== "bot" || this.g.result || this.thinking || this.dead) return;
    const c = this.g.turn();
    if (c === this.myColor && this.g.status()[FP_COLORS.indexOf(c)] === "active") return;
    this.thinking = true;
    this.render();
    const t0 = performance.now();
    const text = await think(this.g.state(), this.level.opts, "fp");
    // a beat between bot moves; quicker once you're out and just watching
    const watching = this.g.status()[FP_COLORS.indexOf(this.myColor)] !== "active";
    await new Promise((r) => setTimeout(r, Math.max(0, (watching ? 60 : 350) - (performance.now() - t0))));
    this.thinking = false;
    if (this.dead || this.g.result) { this.render(); return; }
    const m = fpTextToMove(text);
    if (m) this.play(m, { remote: true }); else this.render();
  }

  resign() {
    if (this.mode === "online") { this.client.action({ t: "resign" }); return; }
    if (this.mode === "local") {
      const events = this.g.resign(this.g.turn());
      this.afterTurn(events, null);
      return;
    }
    // against the bots, resigning ends your game; the standings are as they are now
    this.g.resign(this.myColor);
    this.gaveUp = true;
    this.finish();
    this.render();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    live.busy = false;
    if (live.room === this.room) live.room = null;
    const r = this.g.result;
    const pts = this.g.points();
    let title, sub;
    if (this.gaveUp) { title = "You resigned"; sub = "Standings when you left:"; }
    else if (this.g.teams) {
      title = !r.winner ? "Draw" : this.mode === "local" ? `${TEAM_NAME[r.winner]} won` : r.winner.includes(this.myColor) ? "Your team won!" : "Your team lost";
      sub = REASONS[r.reason] || "";
    } else {
      const place = r.ranking.indexOf(this.myColor) + 1;
      title = this.mode === "local" ? `${FP_NAMES[r.winner]} won` : place === 1 ? "You won!" : `You finished ${["", "first", "second", "third", "fourth"][place]}`;
      sub = REASONS[r.reason] || "";
    }
    const order = this.g.teams ? FP_COLORS : (r && r.ranking) || [...FP_COLORS].sort((a, b) => pts[FP_COLORS.indexOf(b)] - pts[FP_COLORS.indexOf(a)]);
    setTimeout(() => {
      if (this.dead) return;
      const m = openModal({
        title, sub,
        body: [
          this.g.teams ? null : h("div.fp-standings", ...order.map((c, i) => h("div.fp-stand", h("b", `${i + 1}.`), h(`span.fp-chip.${c}`), h("span", FP_NAMES[c]), h("span.grow"), h("b", `${pts[FP_COLORS.indexOf(c)]}`)))),
          h("div.btn-row",
            h("button.btn", { onclick: () => { m.close(); this.app.go("#/fourplayer"); } }, "New game"),
            this.mode !== "online" ? h("button.btn.primary", { onclick: () => { m.close(); this.app.setController(() => new FourPlayerGame(this.app, this.cfg)); } }, "Play again") : null),
        ],
      });
    }, 500);
  }

  // ---- online ----
  connect() {
    this.room = this.cfg.room;
    const me = getProfile();
    this.playerId = sessionStorage.getItem("mp-pid-" + this.room) || makePlayerId(me.name, me.ratings.blitz.r, Social.myCode());
    sessionStorage.setItem("mp-pid-" + this.room, this.playerId);
    const params = new URLSearchParams(location.search);
    params.set("room", this.room);
    params.set("tc", this.cfg.tcKey || "5+0");
    params.set("rules", this.cfg.rules || "ffa");
    history.replaceState(null, "", location.pathname + "?" + params + "#/fourplayer/online");
    this.client = new RoomClient(this.room, this.playerId, {
      onState: (s) => this._state(s),
      onError: (err) => { if (!/not your turn/.test(err)) toast(err); this.waiting = false; if (this.lastState) this._state(this.lastState); },
      onStatus: (st) => { this.netNote = st === "disconnected" ? "Connection lost. Reconnecting…" : null; this.render(); },
    });
  }

  _state(s) {
    this.lastState = s;
    this.seats = s.seats || [];
    if (s.status === "waiting") { this.phase = "waiting"; this.render(); return; }
    const v = s.view;
    if (!v || !v.fourSeats) { this.phase = "unsupported"; this.render(); return; }
    const mine = FP_COLORS.find((c) => v.fourSeats[c] === s.you);
    this.myColor = mine || null;
    if (!this.viewSet) { this.view = mine || "r"; this.viewSet = true; }
    if (v.phase === "config") {
      this.phase = "config";
      if (v.fourSeats.r === this.playerId && !this.sentConfig) {
        this.sentConfig = true;
        this.client.action({ t: "config", tc: this.cfg.tcKey || "5+0", variant: "fourplayer", rules: this.cfg.rules || "ffa" });
      }
      this.render();
      return;
    }
    const before = this.g.log.length;
    this.g = new FourPlayer(v.four.mode, v.four);
    if (this.g.log.length > before && !this.waiting && before) {
      const lastMove = [...this.g.log].reverse().find((x) => x.san);
      if (lastMove && /\+$/.test(lastMove.san)) SFX.check(); else if (lastMove && /x/.test(lastMove.san)) SFX.capture(); else SFX.moveOpp();
    }
    this.last = v.lastMove ? fpTextToMove(v.lastMove) : null;
    this.waiting = false;
    this.phase = s.status === "over" ? "over" : "playing";
    if (this.myColor && s.status === "playing") { live.room = this.room; live.busy = true; }
    if (v.tc) {
      const turn = this.g.turn();
      const elapsed = v.clock.lastAt !== null ? Math.max(0, (v.serverNow || Date.now()) - v.clock.lastAt) : 0;
      this.clock = { ...v.clock, lastTs: performance.now(), active: v.clock.lastAt !== null && s.status === "playing" ? turn : null };
      if (this.clock.active) this.clock[turn] = Math.max(0, v.clock[turn] - elapsed);
    } else this.clock = null;
    if (this.g.result) this.finish();
    this.render();
  }

  _clockTick() {
    if (!this.clock || !this.root) return;
    const ck = this.clock;
    for (const c of FP_COLORS) {
      let ms = ck[c];
      if (ck.active === c && !this.g.result) ms -= performance.now() - ck.lastTs;
      const el = this.root.querySelector(`.fp-player.${c} .clock`);
      if (el) { el.textContent = fmtClock(Math.max(0, ms)); el.classList.toggle("low", ms < 20000); }
      // anyone at the table can call time on the player to move
      if (ck.active === c && ms <= 0 && this.myColor && c !== this.myColor && Date.now() - (this.flagAt || 0) > 2500) {
        this.flagAt = Date.now();
        this.client.action({ t: "flag" });
      }
    }
  }

  // ---- drawing ----
  render() {
    if (this.dead || !this.root) return;
    const g = this.g;
    const turn = g.turn();
    const targets = this.sel ? new Map(g.legalMoves().filter((m) => m.from === this.sel).map((m) => [m.to, m])) : new Map();
    const board = drawBoard(g, this.view, { sel: this.sel, last: this.last, targets, onTap: (sq) => this.tap(sq) });

    const status = g.status(), pts = g.points();
    const playerCard = (c) => {
      const i = FP_COLORS.indexOf(c);
      const who = this.playerName(c);
      const st = status[i];
      return h(`div.fp-player.${c}${turn === c && !g.result ? ".on" : ""}${st !== "active" ? ".gone" : ""}`,
        h(`span.fp-chip.${c}`),
        h("span.fp-who", h("b", who), h("small", st === "out" ? "Out" : st === "resigned" ? "Resigned (king wanders)" : turn === c && !g.result ? (this.thinking && !this.isHuman(c) ? "Thinking…" : "To move") : g.teams ? (c === "r" || c === "y" ? "Team Red–Yellow" : "Team Blue–Green") : "")),
        g.teams ? null : h("b.fp-pts", { title: "Points" }, String(pts[i])),
        this.clock ? h("span.clock", fmtClock(this.clock[c])) : null);
    };
    // the sidebar lists armies in turn order, starting from the one on the left of the board
    const order = FP_COLORS;
    const body = [];
    if (this.phase === "unsupported") body.push(h("div.status-line.bad", h("span", "The game server hasn't been updated for 4-Player Chess yet. Try again in a few minutes.")));
    if (this.phase === "waiting" || this.phase === "connecting" || this.phase === "config") body.push(this._lobby());
    if (this.netNote) body.push(h("div.status-line.bad", h("span", this.netNote)));
    body.push(h("div.fp-players", ...order.map(playerCard)));
    if (!g.result && this.phase === "playing") {
      body.push(h(`div.status-line${this.isHuman(turn) ? ".good" : ""}`, h(`span.fp-chip.${turn}`),
        h("span", this.mode === "local" ? `${FP_NAMES[turn]} to move` : turn === this.myColor ? "Your move" : `${FP_NAMES[turn]} to move`)));
    }
    if (g.result) {
      const r = g.result;
      body.push(h("div.status-line", h("span", g.teams ? (r.winner ? `${TEAM_NAME[r.winner]} won ${REASONS[r.reason] || ""}` : `Draw ${REASONS[r.reason] || ""}`) : `${FP_NAMES[r.winner]} won ${REASONS[r.reason] || ""}`)));
    }
    // the move list, a row per round
    const rows = [];
    let cur = null;
    for (const x of g.log) {
      if (x.c === "r" || !cur) { cur = []; rows.push(cur); }
      cur.push(x);
    }
    body.push(h("div.fp-moves", ...rows.slice(-40).map((row, i) => h("div.fp-round", h("b.muted", `${rows.length - Math.min(40, rows.length) + i + 1}.`),
      ...row.map((x) => h(`span.fp-mv${x.note ? ".note" : ""}`, h(`span.fp-chip.small.${x.c}`), x.san || x.note))))));
    body.push(h("p.note", g.teams
      ? "Teams: Red and Yellow play Blue and Green. You can't take your partner's pieces. Pawns promote on your 11th rank. Checkmate either opponent to win."
      : "Free-for-all: score points for captures (pawn 1, knight 3, bishop and rook 5, queen 9, a promoted queen 1), +20 for a checkmate, and bonuses for checking several kings at once. Pawns promote to a queen on the middle line. The game ends when three players are out; most points wins."));
    const myIdx = FP_COLORS.indexOf(this.myColor);
    const actions = [];
    if (!g.result && this.phase === "playing") {
      if (this.mode === "local") actions.push(h("button.btn", { onclick: () => { this.view = FP_COLORS[(FP_COLORS.indexOf(this.view) + 1) % 4]; this.render(); } }, icon("flip", 18), "Turn board"));
      if (this.myColor && g.canClaim(this.myColor)) actions.push(h("button.btn.primary", { onclick: () => this.claim() }, icon("trophy", 18), "Claim the win"));
      if (this.mode === "local" || (myIdx >= 0 && status[myIdx] === "active")) {
        actions.push(h("button.btn.danger", {
          onclick: async () => {
            if (getSettings().confirmResign && !(await confirmModal({ title: this.mode === "local" ? `Resign for ${FP_NAMES[turn]}?` : "Resign this game?", yes: "Resign", danger: true }))) return;
            this.resign();
          },
        }, icon("flag", 18), "Resign"));
      }
    }
    if (g.result || this.gaveUp) actions.push(h("button.btn.primary", { onclick: () => this.app.go("#/fourplayer") }, "New game"));
    const side = h("div.fp-side",
      h("div.fp-head", h("button.back", { "aria-label": "Back", onclick: () => this.app.go("#/fourplayer") }, icon("back", 22)), h("h2", g.teams ? "4-Player Teams" : "4-Player Chess")),
      ...body,
      actions.length ? h("div.btn-row.fp-actions", ...actions) : null);
    this.root.replaceChildren(h("div.fp-layout", h("div.fp-board-wrap", board), side));
  }

  claim() {
    if (this.mode === "online") { this.client.action({ t: "claim" }); return; }
    this.g.claim(this.myColor);
    this.finish();
    this.render();
  }

  playerName(c) {
    const me = getProfile();
    if (this.mode === "local") return FP_NAMES[c];
    if (this.mode === "bot") return c === this.myColor ? me.name : `${this.level.name} bot`;
    const v = this.lastState && this.lastState.view;
    const id = v && v.fourSeats ? v.fourSeats[c] : null;
    if (!id) return "Waiting…";
    return id === this.playerId ? me.name : parsePlayerId(id).name;
  }

  _lobby() {
    const link = location.origin + location.pathname + `?room=${this.room}&tc=${encodeURIComponent(this.cfg.tcKey || "5+0")}&rules=${this.cfg.rules || "ffa"}#/fourplayer/online`;
    const n = (this.seats || []).length;
    return h("div.card", h("h3", "Invite three friends"),
      h("p.note", `${this.cfg.rules === "teams" ? "Teams" : "Free-for-all"}, ${tcLabel(this.cfg.tcKey || "5+0")}. The game starts when four players have opened the link. Seats go Red, Blue, Yellow, Green in the order people join.`),
      h("div.field", h("input.input", { value: link, readonly: true, "aria-label": "Invite link", onfocus: (e) => e.target.select() })),
      h("div.btn-row", h("button.btn.primary", { onclick: async () => { if (await copyText(link)) toast("Link copied"); } }, icon("copy", 18), "Copy link"),
        navigator.share ? h("button.btn", { onclick: () => navigator.share({ title: "Play 4-Player Chess with me", url: link }).catch(() => {}) }, icon("share", 18), "Share") : null),
      h("p.note", n ? `${n} of 4 players here.` : "Connecting…"));
  }
}

// ---- setup ----
const setup = { mode: "bot", rules: "ffa", level: "medium", color: "r", tc: "5+0" };

export class FourPlayerSetup {
  constructor(app) { this.app = app; }
  mount() {
    this.root = h("div.fp-page");
    this.app.pageMode(this.root);
    loadArt().then(() => this.render());
    this.render();
  }
  destroy() {}
  render() {
    const field = (label, control) => h("div.field", h("div.lbl", label), control);
    const body = [
      h("p", { style: { color: "var(--ink-2)" } }, "Four armies on one cross-shaped board, moving in turn: Red, Blue, Yellow, Green. Play everyone for points, or in teams with the player across from you."),
      field("Game", segmented([{ value: "ffa", label: "Free-for-all" }, { value: "teams", label: "Teams" }], setup.rules, (v) => { setup.rules = v; this.render(); })),
      field("Players", segmented([{ value: "bot", label: "You and 3 bots" }, { value: "local", label: "Pass and play" }, { value: "online", label: "Friends online" }], setup.mode, (v) => { setup.mode = v; this.render(); })),
    ];
    if (setup.mode === "bot") {
      body.push(field("Bots", segmented(FP_LEVELS.map((l) => ({ value: l.id, label: l.name })), setup.level, (v) => { setup.level = v; })));
      body.push(field("Play as", segmented(FP_COLORS.map((c) => ({ value: c, label: FP_NAMES[c] })), setup.color, (v) => { setup.color = v; this.render(); })));
    }
    if (setup.mode === "online") body.push(field("Time control", tcPicker(setup.tc, (v) => { setup.tc = v; }, { allowUnlimited: false, allowCustom: true })));
    body.push(h("p.note", setup.rules === "teams"
      ? "Teams: Red and Yellow against Blue and Green. Checkmate either opponent to win."
      : "Free-for-all: points for captures, checkmates and multi-checks. The game ends when three players are out."));
    const side = h("div.fp-side",
      h("div.fp-head", h("button.back", { "aria-label": "Back", onclick: () => this.app.go("#/variants") }, icon("back", 22)), h("h2", "4-Player Chess")),
      ...body,
      h("button.btn.primary.big.block", { onclick: () => this.start() }, setup.mode === "online" ? "Create invite link" : "Play"));
    const view = setup.mode === "bot" ? setup.color : "r";
    this.root.replaceChildren(h("div.fp-layout", h("div.fp-board-wrap", drawBoard(new FourPlayer(setup.rules), view)), side));
  }
  start() {
    const cfg = setup.mode === "online"
      ? { mode: "online", rules: setup.rules, room: "fp-" + randomId(10), tcKey: setup.tc }
      : { mode: setup.mode, rules: setup.rules, level: setup.level, myColor: setup.mode === "bot" ? setup.color : "r" };
    this.app.launch(() => new FourPlayerGame(this.app, cfg), `#/fourplayer/${setup.mode === "online" ? "online" : "play"}`);
  }
}
