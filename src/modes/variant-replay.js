// Replaying a finished variant game from the archive. Each record keeps the position after every
// move, so any variant replays the same way: Crazyhouse pockets and the duck included. 4-Player
// games show their final board, standings and moves.
import { h, icon, timeAgo } from "../ui/dom.js";
import { MoveList, renderStrip, GLYPH } from "../ui/components.js";
import { getVariantGames } from "../store.js";
import { VX_VARIANTS } from "../core/vx.js";
import { FourPlayer, FP_COLORS, FP_NAMES } from "../core/fp.js";
import { drawBoard, loadArt } from "./fp-game.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const VARIANT_NAMES = {
  ...Object.fromEntries(Object.entries(VX_VARIANTS).map(([k, v]) => [k, v.name])),
  crazyhouse: "Crazyhouse", bughouse: "Bughouse", fourplayer: "4-Player Chess", fourteams: "4-Player Teams",
};

// how a game ended, in words
const WHY = {
  checkmate: "checkmate", stalemate: "stalemate", "stalemate-win": "no moves left", king: "king taken", explosion: "king blown up",
  "no-pieces": "every piece lost", horde: "the horde taken", threefold: "repetition", fifty: "50-move rule", material: "only kings left",
  resignation: "resignation", timeout: "time", agreement: "agreement", threecheck: "three checks", hill: "king reached the centre",
};
const why = (r) => (r && r.startsWith("partner-") ? `on the other board (${WHY[r.slice(8)] || r.slice(8)})` : WHY[r] || r || "");

// a FEN's board for the renderers (chess.js layout); the duck ("*") comes back separately
function boardOf(fen) {
  let duck = null;
  const rows = fen.split(" ")[0].split("/").map((row, r) => {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let k = 0; k < Number(ch); k++) out.push(null); continue; }
      const sq = "abcdefgh"[out.length] + (8 - r);
      if (ch === "*") { duck = sq; out.push(null); continue; }
      out.push({ type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? "w" : "b", square: sq });
    }
    return out;
  });
  return { board: rows, duck };
}

export class VariantReplay {
  constructor(app, id) { this.app = app; this.id = id; this.idx = -1; }
  mount() {
    this.rec = getVariantGames().find((g) => g.id === this.id);
    if (!this.rec) { this.app.go("#/profile"); return; }
    if (this.rec.variant === "fourplayer") { this.mountFour(); return; }
    const r = this.rec;
    this.fens = [r.start || START, ...r.plies.map((p) => p.fen)];
    this.moveList = new MoveList((i) => this.goto(i));
    const name = VARIANT_NAMES[r.variant] || r.variant;
    this.pocketEl = h("div");
    this.app.panel({
      title: name, back: "#/profile",
      body: [h("div.card", h("h3", `${r.white.name} vs ${r.black.name}`), h("p.note", `${r.result.replace("1/2-1/2", "½–½")}, ${why(r.reason)}. Played ${timeAgo(r.date)}${r.rated ? ", rated" : ""}.`)),
        this.pocketEl, this.moveList.el],
      foot: [h("div.btn-row",
        h("button.btn", { "aria-label": "Start", onclick: () => this.goto(-1) }, icon("first", 18)),
        h("button.btn", { "aria-label": "Back", onclick: () => this.goto(Math.max(-1, this.idx - 1)) }, icon("prev", 18)),
        h("button.btn", { "aria-label": "Forward", onclick: () => this.goto(Math.min(r.plies.length - 1, this.idx + 1)) }, icon("next", 18)),
        h("button.btn", { "aria-label": "End", onclick: () => this.goto(r.plies.length - 1) }, icon("last", 18)))],
    });
    const who = (c) => ({ name: c === "w" ? r.white.name : r.black.name, rating: (c === "w" ? r.white.rating : r.black.rating) || null, avatar: { emoji: c === "w" ? "♔" : "♚", bg: c === "w" ? "#8a7a62" : "#3a2e24" } });
    this.app.board.viewSide(r.myColor || "w", false);
    const top = this.app.board.orientation === "w" ? "b" : "w";
    renderStrip(this.app.stripTop, who(top));
    renderStrip(this.app.stripBottom, who(top === "w" ? "b" : "w"));
    this.goto(r.plies.length - 1);
  }
  destroy() { for (const b of Object.values(this.app.boards || {})) if (b && b.setDuck) b.setDuck(null); }
  onBoardSwap() { this.goto(this.idx); }
  key(e) {
    if (!this.fens) return false;
    if (e.key === "ArrowLeft") { this.goto(Math.max(-1, this.idx - 1)); return true; }
    if (e.key === "ArrowRight") { this.goto(Math.min(this.rec.plies.length - 1, this.idx + 1)); return true; }
    return false;
  }
  goto(i) {
    this.idx = i;
    const { board, duck } = boardOf(this.fens[i + 1]);
    const b = this.app.board;
    b.syncFromBoard(board);
    b.setDuck(duck);
    b.setLastMove(null, null);
    this.moveList.render(this.rec.plies.map((p, k) => ({ san: p.san, color: k % 2 ? "b" : "w" })), i);
    const ply = this.rec.plies[i];
    const pk = ply && ply.pockets;
    this.pocketEl.replaceChildren(...(pk ? ["w", "b"].map((c) => h("p.note", `${c === "w" ? "White" : "Black"} in hand: `,
      ...["q", "r", "b", "n", "p"].flatMap((t) => Array(pk[c][t]).fill(GLYPH[c][t])).join(" ") || "nothing")) : []));
  }

  mountFour() {
    const r = this.rec;
    const g = new FourPlayer(r.rules, r.state);
    const page = h("div.fp-page");
    this.app.pageMode(page);
    const draw = () => {
      const order = r.place ? [...FP_COLORS].sort((a, b) => r.points[FP_COLORS.indexOf(b)] - r.points[FP_COLORS.indexOf(a)]) : FP_COLORS;
      page.replaceChildren(h("div.fp-layout", h("div.fp-board-wrap", drawBoard(g, r.myColor || "r")),
        h("div.fp-side",
          h("div.fp-head", h("button.back", { "aria-label": "Back", onclick: () => this.app.go("#/profile") }, icon("back", 22)), h("h2", r.rules === "teams" ? "4-Player Teams" : "4-Player Chess")),
          h("p.note", `${timeAgo(r.date)}${r.rated ? ", rated" : ""}. The final position.`),
          h("div.fp-standings", ...order.map((c, i) => h("div.fp-stand", h("b", `${i + 1}.`), h(`span.fp-chip.${c}`), h("span", r.players[c] || FP_NAMES[c]), h("span.grow"), r.rules === "teams" ? null : h("b", String(r.points[FP_COLORS.indexOf(c)]))))),
          h("div.fp-moves", ...g.log.slice(-120).map((x) => h(`span.fp-mv${x.note ? ".note" : ""}`, h(`span.fp-chip.small.${x.c}`), x.san || x.note, " "))))));
    };
    draw();
    loadArt().then(draw);
  }
}
