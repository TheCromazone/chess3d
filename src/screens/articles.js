// Articles: original writing on openings, strategy, endgames, tactics, improvement and history
// (public/data/articles.json). Each article is a list of paragraphs, subheadings and diagrams; a
// diagram is a FEN and/or moves played from it, drawn as a small 2D board in the player's colours,
// with a button that opens the position on the analysis board. Articles are in English.
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { getSettings } from "../store.js";
import { BOARD_THEMES, pieceUrl } from "../board2d.js";

let cache = null;
export async function loadArticles() {
  if (!cache) cache = fetch("./data/articles.json").then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .catch((e) => { cache = null; throw e; });
  return cache;
}

const words = (a) => a.body.map((b) => (typeof b === "string" ? b : b.h || b.board?.caption || "")).join(" ").split(/\s+/).length;
export const readingMinutes = (a) => Math.max(1, Math.ceil(words(a) / 220));

// the position a diagram shows: its FEN (or the start) with its moves played
export function diagramFen(board) {
  const c = new Chess(board.fen || undefined);
  for (const tok of (board.moves || "").split(/\s+/)) if (tok && !/^\d+\.+$/.test(tok)) c.move(tok);
  return c.fen();
}

function diagram(board) {
  const fen = diagramFen(board);
  const s = getSettings();
  const theme = BOARD_THEMES.find((t) => t.id === s.boardTheme2d) || BOARD_THEMES[0];
  const rows = fen.split(" ")[0].split("/");
  const cells = [];
  for (let vr = 0; vr < 8; vr++) for (let vf = 0; vf < 8; vf++) {
    const r = board.flip ? 7 - vr : vr, f = board.flip ? 7 - vf : vf;
    let file = 0, piece = null;
    for (const ch of rows[r]) { if (/\d/.test(ch)) file += Number(ch); else { if (file === f) piece = ch; file++; } }
    const light = (r + f) % 2 === 0;
    const sq = h("div.dg-sq", { style: { background: light ? theme.light : theme.dark } });
    if (piece) sq.appendChild(h("img", { src: pieceUrl(s.pieceTheme2d, piece === piece.toUpperCase() ? "w" : "b", piece.toLowerCase()), alt: "", draggable: "false" }));
    cells.push(sq);
  }
  const side = fen.split(" ")[1] === "w" ? "White to move" : "Black to move";
  return h("figure.diagram",
    h("div.dg-board", { role: "img", "aria-label": `${side}. ${board.caption}` }, ...cells),
    h("figcaption", board.caption),
    h("a.btn.small", { href: `#/analysis/fen/${encodeURIComponent(fen)}` }, icon("analysis", 16), "Open in analysis"));
}

// the article tiles on the Learn page
export function articleTiles(app, list) {
  return h("div.grid-cards", ...list.map((a) => h("button.tile", { onclick: () => app.go(`#/article/${a.id}`) },
    h("b", { "data-no-i18n": "" }, a.title), h("small", { "data-no-i18n": "" }, a.summary),
    h("small", a.topic, " · ", `${readingMinutes(a)} min read`))));
}

export class ArticleScreen {
  constructor(app, id) { this.app = app; this.id = id; }
  async mount() {
    const page = h("div.page.article-page", h("p.note", "Loading…"));
    this.app.pageMode(page);
    let list;
    try { list = await loadArticles(); } catch { page.replaceChildren(h("p.note", "Couldn't load this article. Check your connection and try again.")); return; }
    if (this.dead) return;
    const a = list.find((x) => x.id === this.id);
    if (!a) { page.replaceChildren(h("p.note", "That article doesn't exist."), h("a.btn", { href: "#/learn" }, icon("back", 16), "Learn")); return; }
    const i = list.indexOf(a), next = list[(i + 1) % list.length];
    page.replaceChildren(
      h("a.back-link", { href: "#/learn" }, icon("back", 16), "Learn"),
      h("article.article",
        h("p.article-topic", a.topic),
        h("h1", { "data-no-i18n": "" }, a.title),
        h("p.article-meta", "Chess 3D", " · ", `${readingMinutes(a)} min read`),
        h("div.article-body", { "data-no-i18n": "" }, ...a.body.map((b) => (typeof b === "string" ? h("p", b) : b.h ? h("h2", b.h) : diagram(b.board))))),
      h("a.row.article-next", { href: `#/article/${next.id}` },
        h("span.rt", h("small", "Next article"), h("b", { "data-no-i18n": "" }, next.title)), icon("chevron", 18)));
    this.title = document.title;
    document.title = `${a.title} · Chess 3D`;
  }
  destroy() { this.dead = true; if (this.title) document.title = this.title; }
}
