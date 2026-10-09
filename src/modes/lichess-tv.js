// Top games now, like chess.com's live top games: Lichess TV picks the highest-rated game being played in
// each speed and streams it. This follows it on the board, with names, titles, ratings and running clocks,
// and moves on to the next featured game when one ends. The games and the stream are Lichess's, credited.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { renderStrip, segmented } from "../ui/components.js";
import { kingSquare } from "../core/tree.js";
import { moveSound } from "../audio.js";

export const TV_CHANNELS = [
  { key: "best", label: "Top rated" }, { key: "bullet", label: "Bullet" }, { key: "blitz", label: "Blitz" },
  { key: "rapid", label: "Rapid" }, { key: "classical", label: "Classical" }, { key: "chess960", label: "Chess960" },
];
const feedUrl = (ch) => (ch === "best" ? "https://lichess.org/api/tv/feed" : `https://lichess.org/api/tv/${ch}/feed`);
const named = (p) => (p.title ? `${p.title} ${p.name}` : p.name);

export class LichessTV {
  constructor(app, channel) {
    this.app = app;
    this.channel = TV_CHANNELS.some((c) => c.key === channel) ? channel : "best";
    this.game = null;
  }

  mount() {
    this.app.board.syncFromBoard(new Chess().board());
    this.render();
    this.connect();
    this.tick = setInterval(() => this.renderStrips(), 250);
  }
  destroy() { this.dead = true; if (this.ctrl) this.ctrl.abort(); clearInterval(this.tick); clearTimeout(this.retry); }
  onBoardSwap() { if (this.fen) this.show(this.fen, this.lm, true); }

  // the feed is newline-delimited JSON that stays open: a "featured" line for each new game, then a "fen"
  // line for every move
  async connect() {
    if (this.ctrl) this.ctrl.abort();
    const ctrl = this.ctrl = new AbortController();
    try {
      const res = await fetch(feedUrl(this.channel), { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`Lichess TV isn't answering (${res.status}).`);
      this.error = null;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || this.dead) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) { try { this.onMessage(JSON.parse(line)); } catch { /* a line we can't read */ } }
        }
      }
    } catch (e) {
      if (this.dead || ctrl.signal.aborted) return;
      this.error = e.message && /Lichess/.test(e.message) ? e.message : "Couldn't reach Lichess TV. Trying again…";
      this.renderInfo();
    }
    // Lichess closes feeds now and then: pick it up again
    if (!this.dead && !ctrl.signal.aborted) this.retry = setTimeout(() => this.connect(), 3000);
  }

  onMessage(m) {
    if (m.t === "featured") {
      const d = m.d;
      const players = {};
      for (const p of d.players || []) {
        players[p.color === "white" ? "w" : "b"] = { name: p.user ? p.user.name : "Anonymous", title: (p.user && p.user.title) || null, rating: p.rating || null };
      }
      this.game = { id: d.id, players };
      this.clock = { w: ((d.players || []).find((p) => p.color === "white") || {}).seconds * 1000 || null, b: ((d.players || []).find((p) => p.color === "black") || {}).seconds * 1000 || null, at: Date.now() };
      this.app.board.viewSide(d.orientation === "black" ? "b" : "w", false);
      this.lm = null;
      this.show(d.fen, null, true);
      this.renderInfo();
    } else if (m.t === "fen" && this.game) {
      const d = m.d;
      this.clock = { w: d.wc != null ? d.wc * 1000 : null, b: d.bc != null ? d.bc * 1000 : null, at: Date.now() };
      this.show(d.fen, d.lm || null, false);
    }
  }

  show(fen, lm, force) {
    let c;
    try { c = new Chess(fen); } catch { return; }       // a position chess.js won't read (some Chess960 castling)
    const b = this.app.board;
    const prev = this.fen;
    this.fen = fen;
    this.lm = lm;
    let mv = null;
    if (!force && lm && prev) {
      try { mv = new Chess(prev).move({ from: lm.slice(0, 2), to: lm.slice(2, 4), promotion: lm[4] || undefined }); } catch { mv = null; }
    }
    if (mv) { b.animateMove(mv); moveSound(mv, c); } else b.syncFromBoard(c.board());
    b.setLastMove(lm ? lm.slice(0, 2) : null, lm ? lm.slice(2, 4) : null);
    b.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    this.turn = c.turn();
    this.renderStrips();
  }

  renderStrips() {
    if (!this.game || !this.app.stripTop) return;
    const b = this.app.board;
    const top = b.orientation === "w" ? "b" : "w";
    const left = (color) => {
      const ms = this.clock && this.clock[color];
      if (ms == null) return null;
      return color === this.turn ? Math.max(0, ms - (Date.now() - this.clock.at)) : ms;
    };
    const strip = (color) => {
      const p = this.game.players[color] || { name: color === "w" ? "White" : "Black" };
      return { name: named(p), rating: p.rating, avatar: { emoji: color === "w" ? "♔" : "♚", bg: color === "w" ? "#8a7a62" : "#3a2e24" }, clockMs: left(color), active: color === this.turn };
    };
    renderStrip(this.app.stripTop, strip(top));
    renderStrip(this.app.stripBottom, strip(top === "w" ? "b" : "w"));
  }

  render() {
    this.infoEl = h("div");
    this.app.panel({
      title: "Top games now", back: "#/watch",
      body: [
        segmented(TV_CHANNELS.map((c) => ({ value: c.key, label: c.label })), this.channel, (v) => {
          this.channel = v;
          this.game = null;
          history.replaceState(null, "", location.pathname + location.search + `#/watch/tv/${v}`);
          this.renderInfo();
          this.connect();
        }),
        this.infoEl,
        h("p.note", "The best game being played right now in each speed, chosen and streamed by Lichess TV. The board follows every move."),
      ],
    });
    this.renderInfo();
  }

  renderInfo() {
    if (!this.infoEl) return;
    if (this.error && !this.game) { this.infoEl.replaceChildren(h("div.status-line.bad", icon("close", 16), h("span", this.error))); return; }
    if (!this.game) { this.infoEl.replaceChildren(h("p.note", "Tuning in…")); return; }
    const { w, b } = this.game.players;
    this.infoEl.replaceChildren(h("div.card",
      h("h3", `${w ? named(w) : "White"} vs ${b ? named(b) : "Black"}`),
      h("p.note", `${w && w.rating ? w.rating : "?"} vs ${b && b.rating ? b.rating : "?"}. Live now.`),
      h("a.btn.small", { href: `https://lichess.org/${this.game.id}`, target: "_blank", rel: "noopener", style: { marginTop: "8px" } }, icon("link", 16), "Open on Lichess")));
  }
}
