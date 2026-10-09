// Events: top over-the-board tournaments live, from Lichess's public broadcasts (official relays of
// real events). The Watch page lists what's on; an event shows a round's games on small boards; a
// game opens on the main board with clocks and moves, following along while it's being played.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { MoveList, renderStrip, GLYPH } from "../ui/components.js";
import { kingSquare } from "../core/tree.js";
import { moveSound } from "../audio.js";

const API = "https://lichess.org/api";
const POLL_MS = 15000;

async function get(path, type = "json") {
  const res = await fetch(API + path, { headers: { Accept: type === "json" ? "application/json" : "application/x-chess-pgn" } });
  if (!res.ok) throw new Error("The broadcast service didn't answer. Try again in a minute.");
  return type === "json" ? res.json() : res.text();
}

// a round's PGN -> [{ white, black, whiteElo, blackElo, whiteTitle, blackTitle, result, sans, clocks, fens }]
export function parseRound(text) {
  return text.split(/\n\n(?=\[Event )/).map((chunk) => {
    const tag = (k) => { const m = new RegExp(`\\[${k} "([^"]*)"\\]`).exec(chunk); return m ? m[1] : ""; };
    const body = chunk.replace(/^\[.*\]\s*$/gm, "");
    const sans = [], clocks = [];
    for (const m of body.matchAll(/(\{[^}]*\})|(\d+\.+)|([^\s{}()]+)/g)) {
      if (m[1]) {
        const c = /%clk (\d+):(\d+):(\d+)/.exec(m[1]);
        if (c && sans.length) clocks[sans.length - 1] = (Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3])) * 1000;
      } else if (m[3] && !/^(1-0|0-1|1\/2-1\/2|\*|\$\d+)$/.test(m[3])) sans.push(m[3]);
    }
    const c = new Chess();
    const fens = [c.fen()], moves = [];
    for (const san of sans) {
      let mv = null;
      try { mv = c.move(san); } catch { mv = null; }
      if (!mv) break;
      moves.push(mv);
      fens.push(c.fen());
    }
    return {
      white: tag("White") || "?", black: tag("Black") || "?", whiteElo: tag("WhiteElo"), blackElo: tag("BlackElo"),
      whiteTitle: tag("WhiteTitle"), blackTitle: tag("BlackTitle"), result: tag("Result") || "*",
      moves, clocks: clocks.slice(0, moves.length), fens,
    };
  }).filter((g) => g.white !== "?" || g.moves.length);
}

const named = (title, name) => (title ? `${title} ${name}` : name);
const resultText = (r) => (r === "1-0" ? "1–0" : r === "0-1" ? "0–1" : r === "1/2-1/2" ? "½–½" : "Live");

// a small read-only board for the game cards
function miniBoard(fen) {
  const rows = fen.split(" ")[0].split("/");
  const cells = [];
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let k = 0; k < Number(ch); k++) cells.push(h(`span.${(r + f++) % 2 ? "dk" : "lt"}`)); }
      else cells.push(h(`span.${(r + f++) % 2 ? "dk" : "lt"}`, ch === ch.toUpperCase() ? GLYPH.w[ch.toLowerCase()] : GLYPH.b[ch]));
    }
  });
  return h("div.mini-board", ...cells);
}

// ---- the Watch page section: top events running now ----
export function eventsSection(app) {
  const box = h("div.grid-cards.events", h("p.note", "Looking for live events…"));
  get("/broadcast/top?page=1").then((d) => {
    const active = (d.active || []).filter((e) => (e.tour.tier || 0) >= 4)
      .sort((a, b) => (b.round && b.round.ongoing ? 1 : 0) - (a.round && a.round.ongoing ? 1 : 0) || (b.tour.tier || 0) - (a.tour.tier || 0)).slice(0, 9);
    if (!active.length) { box.replaceChildren(h("p.note", "No major events are on right now.")); return; }
    box.replaceChildren(...active.map((e) => {
      const info = e.tour.info || {};
      return h("button.tile.event-tile", { onclick: () => app.go(`#/event/${e.tour.id}/${e.round.id}`) },
        h("b", e.tour.name),
        h("small", [e.round && e.round.name, info.format, info.location].filter(Boolean).join(", ")),
        e.round && e.round.ongoing ? h("span.live-dot", "LIVE") : h("small.muted", info.tc || ""));
    }));
  }).catch((err) => box.replaceChildren(h("p.note", err.message)));
  return box;
}

// ---- one event: the round's games ----
export class EventScreen {
  constructor(app, tourId, roundId) { this.app = app; this.tourId = tourId; this.roundId = roundId; }
  async mount() {
    this.page = h("div.page.event-page", h("p.note", "Loading the event…"));
    this.app.pageMode(this.page);
    try { this.tour = await get(`/broadcast/${this.tourId}`); } catch (e) { this.page.replaceChildren(h("p.note", e.message)); return; }
    if (this.dead) return;
    // open on the round being played, or else the latest one that has started
    const rounds = this.tour.rounds;
    const asked = rounds.find((r) => r.id === this.roundId);
    const started = rounds.filter((r) => r.ongoing || r.finished || (r.startsAt && r.startsAt <= Date.now()));
    if (!asked || (!asked.ongoing && !asked.finished && asked.startsAt > Date.now())) {
      const pick = rounds.find((r) => r.ongoing) || started[started.length - 1] || asked || rounds[0];
      this.roundId = pick && pick.id;
      if (this.roundId) { history.replaceState(null, "", `#/event/${this.tourId}/${this.roundId}`); this.app._lastHash = location.hash; }
    }
    await this.load();
    this.timer = setInterval(() => { if (this.round && this.round.ongoing) this.load(); }, POLL_MS);
  }
  destroy() { this.dead = true; clearInterval(this.timer); }
  async load() {
    this.round = this.tour.rounds.find((r) => r.id === this.roundId) || this.tour.rounds[0];
    let games = [];
    try { games = parseRound(await get(`/broadcast/round/${this.round.id}.pgn`, "pgn")); } catch (e) { if (!this.games) { this.render(e.message); return; } }
    if (this.dead) return;
    this.games = games;
    this.render();
  }
  render(error) {
    const t = this.tour.tour, info = t.info || {};
    const rounds = h("div.seg.round-picker", ...this.tour.rounds.map((r) => h(`button${r.id === this.round.id ? ".on" : ""}`, {
      onclick: () => { this.roundId = r.id; history.replaceState(null, "", `#/event/${this.tourId}/${r.id}`); this.app._lastHash = location.hash; this.load(); },
    }, r.name, r.ongoing ? " •" : "")));
    const games = (this.games || []).map((g, i) => h("button.event-game", { onclick: () => this.app.go(`#/event/${this.tourId}/${this.round.id}/${i}`), "aria-label": `${g.white} against ${g.black}` },
      miniBoard(g.fens[g.fens.length - 1]),
      h("span.eg-players",
        h("span", h("b", named(g.whiteTitle, g.white)), g.whiteElo ? h("small", ` ${g.whiteElo}`) : null),
        h("span", h("b", named(g.blackTitle, g.black)), g.blackElo ? h("small", ` ${g.blackElo}`) : null)),
      h(`span.eg-result${g.result === "*" ? ".live" : ""}`, resultText(g.result))));
    this.page.replaceChildren(...[
      h("div.page-head", h("div", h("a.btn.small.ghost", { href: "#/watch", "aria-label": "Back to Watch" }, icon("back", 16)), h("h1", t.name),
        h("p", [info.format, info.tc, info.location].filter(Boolean).join(". ")))),
      rounds,
      error ? h("p.note", error) : null,
      games.length ? h("div.event-games", ...games) : h("p.note", this.round.startsAt && this.round.startsAt > Date.now() ? `This round starts ${new Date(this.round.startsAt).toLocaleString()}.` : "No games in this round yet."),
      h("p.note", h("span", "Games relayed by "), h("a", { href: t.url || "https://lichess.org/broadcast", target: "_blank", rel: "noopener" }, "Lichess broadcasts"), "."),
    ].filter(Boolean));
  }
}

// ---- one game on the main board, following the live game ----
export class BroadcastGame {
  constructor(app, tourId, roundId, index) {
    this.app = app; this.tourId = tourId; this.roundId = roundId; this.index = index;
    this.idx = -1;
    this.follow = true;
    this.moveList = new MoveList((i) => { this.follow = i === this.g.moves.length - 1; this.goto(i); });
  }
  async mount() {
    this.app.panel({ title: "Event", back: `#/event/${this.tourId}/${this.roundId}`, body: h("p.note", "Loading the game…") });
    this.app.board.syncFromBoard(new Chess().board());
    await this.load();
    this.timer = setInterval(() => { if (this.g && this.g.result === "*") this.load(); }, POLL_MS);
  }
  destroy() { this.dead = true; clearInterval(this.timer); }
  onBoardSwap() { this.goto(this.idx, true); }
  key(e) {
    if (!this.g) return false;
    if (e.key === "ArrowLeft") { this.follow = false; this.goto(Math.max(-1, this.idx - 1)); return true; }
    if (e.key === "ArrowRight") { this.goto(Math.min(this.g.moves.length - 1, this.idx + 1)); this.follow = this.idx === this.g.moves.length - 1; return true; }
    return false;
  }
  async load() {
    let games;
    try { games = parseRound(await get(`/broadcast/round/${this.roundId}.pgn`, "pgn")); }
    catch (e) { if (!this.g) this.app.panel({ title: "Event", back: `#/event/${this.tourId}/${this.roundId}`, body: h("p.note", e.message) }); return; }
    if (this.dead) return;
    const g = games[this.index];
    if (!g) { this.app.go(`#/event/${this.tourId}/${this.roundId}`); return; }
    const fresh = !this.g;
    const grew = this.g && g.moves.length > this.g.moves.length;
    this.g = g;
    if (fresh) this.render();
    this.renderInfo();
    if (fresh || (grew && this.follow)) this.goto(g.moves.length - 1, fresh);
    else this.renderMoves();
  }
  render() {
    this.infoEl = h("div");
    this.app.panel({
      title: "Event", back: `#/event/${this.tourId}/${this.roundId}`,
      body: [this.infoEl, this.moveList.el],
      foot: [h("div.btn-row",
        h("button.btn", { "aria-label": "Start", onclick: () => { this.follow = false; this.goto(-1); } }, icon("first", 18)),
        h("button.btn", { "aria-label": "Back", onclick: () => { this.follow = false; this.goto(Math.max(-1, this.idx - 1)); } }, icon("prev", 18)),
        h("button.btn", { "aria-label": "Forward", onclick: () => { this.goto(Math.min(this.g.moves.length - 1, this.idx + 1)); this.follow = this.idx === this.g.moves.length - 1; } }, icon("next", 18)),
        h("button.btn", { "aria-label": "Latest move", onclick: () => { this.follow = true; this.goto(this.g.moves.length - 1); } }, icon("last", 18))),
      h("button.btn.block", { onclick: () => this.app.go("#/analysis/pgn/" + encodeURIComponent(this.pgn())) }, icon("analysis", 18), "Open in analysis")],
    });
    this.app.board.viewSide("w", false);
  }
  pgn() {
    const g = this.g, c = new Chess();
    c.header("White", g.white, "Black", g.black, "Result", g.result);
    for (const m of g.moves) c.move(m.san);
    return c.pgn();
  }
  renderInfo() {
    const g = this.g;
    this.infoEl.replaceChildren(h("div.card",
      h("h3", `${named(g.whiteTitle, g.white)} vs ${named(g.blackTitle, g.black)}`),
      h("p.note", g.result === "*" ? `Being played now. The board follows each new move${this.follow ? "" : " (go to the latest move to follow again)"}.` : `Finished: ${resultText(g.result)}`)));
  }
  renderMoves() {
    this.moveList.render(this.g.moves.map((m) => ({ san: m.san, color: m.color })), this.idx);
  }
  goto(i, force = false) {
    const g = this.g;
    const prev = this.idx;
    this.idx = i;
    const fen = g.fens[i + 1];
    const b = this.app.board;
    if (!force && i === prev + 1 && g.moves[i]) { b.animateMove(g.moves[i]); moveSound(g.moves[i], new Chess(fen)); }
    else b.syncFromBoard(new Chess(fen).board());
    const m = g.moves[i];
    b.setLastMove(m ? m.from : null, m ? m.to : null);
    const c = new Chess(fen);
    b.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    // clocks: each side's time after its latest move up to here
    const clockOf = (color) => { for (let k = i; k >= 0; k--) if (g.moves[k].color === color && g.clocks[k] != null) return g.clocks[k]; return null; };
    const top = b.orientation === "w" ? "b" : "w";
    const strip = (color) => ({
      name: color === "w" ? named(g.whiteTitle, g.white) : named(g.blackTitle, g.black),
      rating: (color === "w" ? g.whiteElo : g.blackElo) || null,
      avatar: { emoji: color === "w" ? "♔" : "♚", bg: color === "w" ? "#8a7a62" : "#3a2e24" },
      clockMs: clockOf(color), active: g.result === "*" && i === g.moves.length - 1 && c.turn() === color,
    });
    renderStrip(this.app.stripTop, strip(top));
    renderStrip(this.app.stripBottom, strip(top === "w" ? "b" : "w"));
    this.renderMoves();
  }
}
