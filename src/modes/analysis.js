// Analysis board: move tree with variations, live Stockfish lines + eval bar, opening explorer,
// PGN/FEN import & export, board editor, and "play from here".
import { createChess, animateOn } from "../core/chess960.js";
import { MoveTree, START_FEN, kingSquare, capturedFromFen } from "../core/tree.js";
import { MoveInput } from "../core/input.js";
import { h, icon, copyText, downloadText, downloadBlob, esc } from "../ui/dom.js";
import { positionPng } from "../core/gif.js";
import { TreeView, toast, switchRow, GLYPH, sanHtml, openModal } from "../ui/components.js";
import { analysisEngine } from "../core/engines.js";
import { formatScore, evalBarFraction } from "../engine.js";
import { loadOpenings, openingForGame, bookMoves } from "../openings.js";
import { explorerMoves, EXPLORER_INFO } from "../explorer.js";
import { getSettings, getGame } from "../store.js";
import { moveSound } from "../audio.js";
import { BotGame } from "./bot-game.js";

let engineOn = true;
let multiPv = 3;

export class AnalysisScreen {
  // opts: { gameId?, pgn?, fen? }
  constructor(app, opts = {}) {
    this.app = app;
    this.opts = opts;
    this.tab = "analysis";
    this.tree = new MoveTree(START_FEN);
    this.headers = {};
    if (opts.gameId) {
      const g = getGame(opts.gameId);
      if (g) {
        this.tree = MoveTree.fromMoves(g.moves, g.startFen || START_FEN);
        this.headers = { White: g.white.name, Black: g.black.name, Result: g.result };
        this.orientation = g.myColor || "w";
      }
    } else if (opts.fen) {
      try { createChess(opts.fen); this.tree = new MoveTree(opts.fen); } catch { toast("That FEN isn't a legal position."); }
    } else if (opts.pgn) {
      try { const r = MoveTree.fromPgn(opts.pgn); this.tree = r.tree; this.headers = r.headers; } catch { toast("Couldn't read that PGN."); }
    }
    this.node = opts.gameId || opts.pgn ? this.tree.lastMain() : this.tree.root;
    this.input = new MoveInput(app, {
      getChess: () => (this.editing ? null : this.tree.chessAt(this.node)),
      canMove: () => true,
      onMove: (m, o) => this.play(m, o),
    });
    this.treeView = new TreeView((id) => this.goto(this.tree.get(id)));
    this.lastResult = null;
  }

  mount() {
    const app = this.app;
    this.input.bind();
    app.board.viewSide(this.orientation || "w", false);
    app.board.syncFromBoard(createChess(this.node.fen).board());
    loadOpenings().then(() => this.renderSide());
    this.renderPanel();
    this.refresh(true);
  }
  destroy() {
    this.dead = true;
    analysisEngine().stop().catch(() => {});
    this.input.clear();
  }
  onBoardSwap() { this.input.bind(); this.refresh(true); }
  onSettings() { this.refresh(false); }
  onFlip() { this.renderStrips(); this._evalBar(); }

  key(e) {
    if (this.editing) return false;
    if (e.key === "ArrowLeft") { if (this.node.parent) this.goto(this.node.parent); return true; }
    if (e.key === "ArrowRight") { if (this.node.children[0]) this.goto(this.node.children[0]); return true; }
    if (e.key === "ArrowUp" || e.key === "Home") { this.goto(this.tree.root); return true; }
    if (e.key === "ArrowDown" || e.key === "End") { let n = this.node; while (n.children[0]) n = n.children[0]; this.goto(n); return true; }
    return false;
  }

  play(m, { instant } = {}) {
    const next = this.tree.play(this.node, m);
    if (!next) return;
    this.goto(next, { instant });
  }

  goto(node, { instant = false } = {}) {
    if (!node) return;
    const prev = this.node;
    this.node = node;
    this.input.clear();
    if (node.parent === prev && node.move) {
      animateOn(this.app.board, node.move, { instant });
      moveSound(node.move, createChess(node.fen));
    } else this.app.board.syncFromBoard(createChess(node.fen).board());
    this.refresh(false);
  }

  refresh(sync) {
    const b = this.app.board;
    if (sync) b.syncFromBoard(createChess(this.node.fen).board());
    const s = getSettings();
    const mv = this.node.move;
    b.setLastMove(s.highlightLast && mv ? mv.from : null, s.highlightLast && mv ? mv.to : null);
    const c = createChess(this.node.fen);
    b.setCheck(c.inCheck() ? kingSquare(c, c.turn()) : null);
    b.setArrows([]);
    this.renderStrips();
    this.treeView.render(this.tree, this.node);
    this.renderSide();
    this.runEngine();
  }

  renderStrips() {
    const { captured, diff } = capturedFromFen(this.node.fen);
    const o = this.app.board.orientation;
    const mk = (color) => ({
      name: this.headers[color === "w" ? "White" : "Black"] || (color === "w" ? "White" : "Black"),
      avatar: { emoji: color === "w" ? "♔" : "♚", bg: color === "w" ? "#6b5a43" : "#2d241d" },
      captured: captured[color === "w" ? "b" : "w"], capColor: color === "w" ? "b" : "w", adv: color === "w" ? diff : -diff,
    });
    this.app.strips(mk(o === "w" ? "b" : "w"), mk(o));
  }

  // ---------- engine ----------
  runEngine() {
    const eb = this.app.evalBar;
    if (!engineOn || this.editing) { eb.show(false); analysisEngine().stop().catch(() => {}); return; }
    eb.show(getSettings().evalBarInAnalysis);
    const fen = this.node.fen;
    const c = createChess(fen);
    if (c.isGameOver()) {
      this.lastResult = null;
      const label = c.isCheckmate() ? (c.turn() === "w" ? "0-1" : "1-0") : "½";
      eb.set(c.isCheckmate() ? (c.turn() === "w" ? 0 : 1) : 0.5, label, this.app.board.orientation);
      this.renderLines();
      return;
    }
    this.lastResult = null;
    this.renderLines();
    // updates can still arrive after the engine was switched off or Setup was opened
    const stale = () => this.dead || fen !== this.node.fen || !engineOn || this.editing;
    analysisEngine().analyze(fen, { depth: 22, multipv: multiPv }, (partial) => {
      if (stale()) return;
      this.lastResult = partial;
      this._evalBar();
      this.renderLines();
    }).then((r) => {
      if (stale() || !r || r.aborted) return;
      this.lastResult = r;
      this._evalBar();
      this.renderLines();
    }).catch((e) => { if (!this.dead) { this.engineErr = String(e.message || e); this.renderLines(); } });
  }

  _evalBar() {
    const r = this.lastResult;
    if (!r || !r.lines || !r.lines[0]) return;
    const sw = r.lines[0].scoreWhite;
    this.app.evalBar.set(evalBarFraction(sw), formatScore(sw).replace("+", ""), this.app.board.orientation);
    const best = r.lines[0].pv && r.lines[0].pv[0];
    this.app.board.setArrows(best ? [{ from: best.slice(0, 2), to: best.slice(2, 4), color: "rgba(91,143,214,.8)" }] : []);
  }

  renderLines() {
    if (!this.linesEl) return;
    this.linesEl.innerHTML = "";
    if (!engineOn) return;
    if (this.engineErr) { this.linesEl.appendChild(h("p.note", "Engine unavailable: " + this.engineErr)); return; }
    const c = createChess(this.node.fen);
    if (c.isGameOver()) { this.linesEl.appendChild(h("p.note", c.isCheckmate() ? "Checkmate." : "The game is drawn.")); return; }
    const r = this.lastResult;
    if (!r || !r.lines || !r.lines.length) { this.linesEl.appendChild(h("p.note", "Calculating…")); return; }
    const depth = r.lines[0].depth || r.depth || 0;
    this.depthEl.textContent = `Depth ${depth}`;
    const startColor = c.turn();
    for (const l of r.lines) {
      const sw = l.scoreWhite;
      const whiteBetter = sw.mate !== undefined && sw.mate !== null ? sw.mate > 0 : (sw.cp || 0) >= 0;
      const moveNo = Number(this.node.fen.split(" ")[5]);
      let pvHtml = "";
      let color = startColor, no = moveNo;
      (l.san || []).slice(0, 10).forEach((san, i) => {
        if (color === "w") pvHtml += `${no}. `;
        else if (i === 0) pvHtml += `${no}… `;
        pvHtml += (i === 0 ? `<b>${sanHtml(san, color)}</b>` : sanHtml(san, color)) + " ";
        if (color === "b") no++;
        color = color === "w" ? "b" : "w";
      });
      const row = h("div.eline", { title: "Play this line" },
        h(`span.sc.${whiteBetter ? "w" : "b"}`, formatScore(sw)),
        h("span.pv", { html: pvHtml }));
      row.addEventListener("click", () => { if (l.pv && l.pv[0]) this.play({ from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4), promotion: l.pv[0][4] }); });
      this.linesEl.appendChild(row);
    }
  }

  // ---------- panel ----------
  renderPanel() {
    const tabs = h("div.tabs", { role: "tablist" });
    for (const [id, label] of [["analysis", "Analysis"], ["explorer", "Explorer"], ["import", "Import"], ["editor", "Setup"]]) {
      tabs.appendChild(h(`button.tab${this.tab === id ? ".on" : ""}`, { role: "tab", onclick: () => { this.tab = id; this.setEditing(id === "editor"); this.renderPanel(); } }, label));
    }
    this.sideBody = this.app.panel({
      title: "Analysis",
      actions: h("button.back", { "aria-label": "Flip board", title: "Flip board (F)", onclick: () => { this.app.board.viewSide(this.app.board.orientation === "w" ? "b" : "w"); this.onFlip(); } }, icon("flip", 20)),
      tabs,
      body: [],
      foot: this.editing ? null : [
        h("div.navbar",
          h("button", { "aria-label": "Start", onclick: () => this.goto(this.tree.root) }, icon("first")),
          h("button", { "aria-label": "Back", onclick: () => this.node.parent && this.goto(this.node.parent) }, icon("prev")),
          h("button", { "aria-label": "Forward", onclick: () => this.node.children[0] && this.goto(this.node.children[0]) }, icon("next")),
          h("button", { "aria-label": "End", onclick: () => { let n = this.node; while (n.children[0]) n = n.children[0]; this.goto(n); } }, icon("last"))),
        h("div.iconbar",
          h("button", { "aria-label": "Copy FEN", title: "Copy FEN", onclick: async () => { if (await copyText(this.node.fen)) toast("FEN copied"); } }, h("span.txt", "FEN")),
          h("button", { "aria-label": "Copy PGN", title: "Copy PGN", onclick: async () => { if (await copyText(this.tree.toPgn(this.headers))) toast("PGN copied"); } }, h("span.txt", "PGN")),
          h("button", { "aria-label": "Download PGN", title: "Download PGN", onclick: () => downloadText("chess3d-analysis.pgn", this.tree.toPgn(this.headers)) }, icon("download")),
          h("button", { "aria-label": "Download image", title: "Download an image of this position", onclick: async () => downloadBlob("chess3d-position.png", await positionPng(this.node.fen, { flip: this.app.board.orientation === "b", last: this.node.move })) }, icon("eye")),
          h("button", { "aria-label": "Copy share link", title: "Copy a link to this analysis", onclick: async () => { if (await copyText(shareLink(this.tree, this.headers))) toast("Link copied. Anyone with it sees this analysis."); } }, icon("share")),
          h("button", { "aria-label": "Delete from here", title: "Delete this move and what follows", onclick: () => this.deleteHere() }, icon("trash")),
          h("button", { "aria-label": "Play vs bot from here", title: "Play a bot from this position", onclick: () => this.playFromHere() }, icon("robot"))),
      ],
    });
    this.renderSide();
  }

  renderSide() {
    const body = this.sideBody;
    if (!body) return;
    body.innerHTML = "";
    const fens = this.tree.path(this.node).map(n => n.fen);
    const op = openingForGame(fens);
    if (this.tab === "analysis") {
      this.depthEl = h("span.note");
      const top = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" } },
        switchRow("Engine", "Stockfish 18", engineOn, (v) => { engineOn = v; this.runEngine(); this.renderLines(); if (!v) this.app.board.setArrows([]); }),
        this.depthEl);
      top.firstChild.style.flex = "1";
      this.linesEl = h("div.engine-lines");
      const pvSel = h("div.seg", ...[1, 2, 3].map(n => h(`button${multiPv === n ? ".on" : ""}`, { onclick: () => { multiPv = n; this.renderSide(); this.runEngine(); } }, `${n} line${n > 1 ? "s" : ""}`)));
      body.append(...[top, pvSel, this.linesEl, op ? h("div.opening", h("b", op.eco), " ", op.name) : null, this.treeView.el].filter(Boolean));
      this.treeView.render(this.tree, this.node);
      this.renderLines();
    } else if (this.tab === "explorer") {
      body.append(op ? h("div.card", h("h3", op.name), h("p.note", `ECO ${op.eco}`)) : h("p.note", "This position doesn't have an opening name."));
      const statsEl = h("div", h("p.note", "Loading games…"));
      body.append(statsEl);
      const fen = this.node.fen;
      const color = createChess(fen).turn();
      explorerMoves(fen).then((data) => {
        if (this.tab !== "explorer" || this.node.fen !== fen) return;
        statsEl.innerHTML = "";
        if (data && data.moves.length) {
          const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
          statsEl.append(h("div.xp-head", h("span", "Move"), h("span", "Games"), h("span", "White / draw / Black")));
          for (const m of data.moves) {
            const w = pct(m.white, m.total), d = pct(m.draws, m.total), b = Math.max(0, 100 - w - d);
            statsEl.append(h("button.xp-row", { onclick: () => this.play({ from: m.from, to: m.to, promotion: m.promotion }), title: `Average rating ${m.avgRating}` },
              h("b", { html: sanHtml(m.san, color) }),
              h("span.muted", m.total.toLocaleString()),
              h("span.xp-bar",
                h("span.w", { style: { width: w + "%" } }, w >= 12 ? w + "%" : ""),
                h("span.d", { style: { width: d + "%" } }, d >= 12 ? d + "%" : ""),
                h("span.b", { style: { width: b + "%" } }, b >= 12 ? b + "%" : ""))));
          }
          statsEl.append(h("p.note", { style: { marginTop: "8px" } }, `${data.total.toLocaleString()} games from ${EXPLORER_INFO.source}, both players ${EXPLORER_INFO.minRating}+.`));
        } else {
          const moves = bookMoves(fen);
          if (moves.length) {
            const list = h("div.rows");
            for (const m of moves) list.appendChild(h("button.row", { onclick: () => this.play({ from: m.from, to: m.to, promotion: m.promotion }) }, h("span.ri", { html: sanHtml(m.san, color) }), h("span.rt", h("b", m.name), h("small", m.eco))));
            statsEl.append(h("p.note", "Not enough games here for statistics. Named book moves:"), list);
          } else statsEl.append(h("p.note", "No games reached this position in the database. You're on your own!"));
        }
      });
    } else if (this.tab === "import") {
      const ta = h("textarea.input", { placeholder: "Paste a PGN or a FEN", "aria-label": "PGN or FEN" });
      body.append(
        h("div.field", h("label", "PGN or FEN"), ta),
        h("div.btn-row",
          h("button.btn.primary", { onclick: () => this.importText(ta.value) }, icon("upload", 18), "Load"),
          h("button.btn", { onclick: () => { this.tree = new MoveTree(START_FEN); this.headers = {}; this.node = this.tree.root; this.tab = "analysis"; this.renderPanel(); this.refresh(true); } }, "New board")),
        h("p.note", "Tip: you can also open any of your past games from Profile."));
    } else if (this.tab === "editor") {
      body.append(this.editorPanel());
    }
  }

  importText(text) {
    text = (text || "").trim();
    if (!text) return;
    try {
      if (/^[rnbqkpRNBQKP1-8/]+\s+[wb]\s/.test(text)) {
        createChess(text);
        this.tree = new MoveTree(text);
        this.headers = {};
      } else {
        const r = MoveTree.fromPgn(text);
        this.tree = r.tree; this.headers = r.headers;
      }
    } catch (e) {
      toast("That doesn't look like a valid PGN or FEN.");
      return;
    }
    this.node = this.tree.root;
    this.tab = "analysis";
    this.renderPanel();
    this.refresh(true);
    toast("Loaded");
  }

  deleteHere() {
    if (!this.node.parent) return;
    const parent = this.node.parent;
    this.tree.remove(this.node);
    this.node = parent;
    this.refresh(true);
  }

  playFromHere() {
    const fen = this.node.fen;
    const color = createChess(fen).turn();
    const m = openModal({
      title: "Play from this position",
      body: [
        h("p.note", `You'll play ${color === "w" ? "White" : "Black"} against Stockfish at full club strength.`),
        h("button.btn.primary.block", { onclick: () => { m.close(); this.app.launch(() => new BotGame(this.app, { botId: "__engine1800", myColor: color, tcKey: "inf", assisted: { hints: true, takebacks: true }, startFen: fen }), "#/game"); } }, "Play"),
      ],
    });
  }

  // ---------- board editor ----------
  setEditing(on) {
    if (this.editing === on) return;
    this.editing = on;
    if (on) {
      this.input.clear();
      const c = createChess(this.node.fen);
      this.ed = { board: c.board().map(r => r.map(x => (x ? { ...x } : null))), turn: c.turn(), castling: this.node.fen.split(" ")[2], piece: "wp" };
      analysisEngine().stop().catch(() => {});
      this.app.evalBar.show(false);
      this.app.board.setArrows([]);
      this.app.board.setLastMove(null, null);
      this.app.board.setCheck(null);
      this.app.bindBoard({ onSquareTap: (sq) => this.editTap(sq) });
    } else {
      // leaving Setup without "Analyze this position": put the real position back on the board
      this.input.bind();
      this.refresh(true);
    }
  }

  editorPanel() {
    const wrap = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
    const pal = h("div.palette");
    for (const color of ["w", "b"]) for (const t of ["k", "q", "r", "b", "n", "p"]) {
      const id = color + t;
      pal.appendChild(h(`button${this.ed.piece === id ? ".on" : ""}`, { "aria-label": `${color === "w" ? "White" : "Black"} ${t}`, onclick: () => { this.ed.piece = id; this.renderSide(); } }, GLYPH[color][t] + "︎"));
    }
    const eraser = h(`button.btn.small${this.ed.piece === "x" ? ".primary" : ""}`, { onclick: () => { this.ed.piece = "x"; this.renderSide(); } }, icon("trash", 16), "Erase");
    const castle = h("div.seg", ...[["K", "White O-O"], ["Q", "White O-O-O"], ["k", "Black O-O"], ["q", "Black O-O-O"]].map(([f, label]) => {
      const on = this.ed.castling.includes(f);
      return h(`button${on ? ".on" : ""}`, { onclick: () => { this.ed.castling = on ? this.ed.castling.replace(f, "") : (this.ed.castling.replace("-", "") + f); if (!this.ed.castling) this.ed.castling = "-"; this.renderSide(); } }, label);
    }));
    wrap.append(
      h("p.note", "Pick a piece, then tap squares to place it. Tap a square holding the same piece to remove it."),
      pal, h("div.btn-row", eraser,
        h("button.btn.small", { onclick: () => { this.ed.board = createChess().board(); this.ed.castling = "KQkq"; this.ed.turn = "w"; this.syncEditor(); } }, "Start position"),
        h("button.btn.small", { onclick: () => { this.ed.board = Array.from({ length: 8 }, () => Array(8).fill(null)); this.ed.castling = "-"; this.syncEditor(); } }, "Clear")),
      h("div.field", h("div.lbl", "Side to move"), h("div.seg",
        h(`button${this.ed.turn === "w" ? ".on" : ""}`, { onclick: () => { this.ed.turn = "w"; this.renderSide(); } }, "White"),
        h(`button${this.ed.turn === "b" ? ".on" : ""}`, { onclick: () => { this.ed.turn = "b"; this.renderSide(); } }, "Black"))),
      h("div.field", h("div.lbl", "Castling rights"), castle),
      h("div.field", h("div.lbl", "FEN"), h("input.input", { value: this.editorFen(), readonly: true, onfocus: (e) => e.target.select() })),
      h("button.btn.primary.block", { onclick: () => this.finishEditing() }, "Analyze this position"));
    this.syncEditor(false);
    return wrap;
  }

  editTap(sq) {
    const f = "abcdefgh".indexOf(sq[0]), r = 8 - Number(sq[1]);
    const cur = this.ed.board[r][f];
    if (this.ed.piece === "x") this.ed.board[r][f] = null;
    else {
      const color = this.ed.piece[0], type = this.ed.piece[1];
      if (cur && cur.color === color && cur.type === type) this.ed.board[r][f] = null;
      else {
        if (type === "k") for (const row of this.ed.board) for (let i = 0; i < 8; i++) if (row[i] && row[i].type === "k" && row[i].color === color) row[i] = null;
        if (type === "p" && (r === 0 || r === 7)) { toast("Pawns can't stand on the first or last rank."); return; }
        this.ed.board[r][f] = { color, type, square: sq };
      }
    }
    this.syncEditor();
  }

  syncEditor(renderPanel = true) {
    this.app.board.syncFromBoard(this.ed.board.map((row, r) => row.map((x, f) => (x ? { ...x, square: "abcdefgh"[f] + (8 - r) } : null))));
    if (renderPanel) this.renderSide();
  }

  editorFen() {
    const rows = this.ed.board.map(row => {
      let s = "", empty = 0;
      for (const x of row) {
        if (!x) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        s += x.color === "w" ? x.type.toUpperCase() : x.type;
      }
      return s + (empty ? empty : "");
    });
    // drop castling rights that the piece placement can't support
    let castling = this.ed.castling === "-" ? "" : this.ed.castling;
    const at = (sq) => { const x = this.ed.board[8 - Number(sq[1])]["abcdefgh".indexOf(sq[0])]; return x ? x.color + x.type : ""; };
    if (at("e1") !== "wk") castling = castling.replace(/[KQ]/g, "");
    if (at("h1") !== "wr") castling = castling.replace("K", "");
    if (at("a1") !== "wr") castling = castling.replace("Q", "");
    if (at("e8") !== "bk") castling = castling.replace(/[kq]/g, "");
    if (at("h8") !== "br") castling = castling.replace("k", "");
    if (at("a8") !== "br") castling = castling.replace("q", "");
    return `${rows.join("/")} ${this.ed.turn} ${castling || "-"} - 0 1`;
  }

  finishEditing() {
    const fen = this.editorFen();
    try {
      const c = createChess(fen);
      const opp = c.turn() === "w" ? "b" : "w";
      // the side not to move must not be in check
      const flipped = fen.replace(/ [wb] /, ` ${opp} `);
      if (createChess(flipped).inCheck()) throw new Error("The side that just moved is in check.");
    } catch (e) {
      toast(/check/.test(e.message) ? "The side that isn't moving can't be in check." : "That position isn't legal (each side needs exactly one king).");
      return;
    }
    this.tree = new MoveTree(fen);
    this.headers = {};
    this.node = this.tree.root;
    this.tab = "analysis";
    this.editing = false;
    this.input.bind();
    this.renderPanel();
    this.refresh(true);
  }
}

export function shareLink(tree, headers = {}) {
  // a compact PGN (main line only keeps URLs short) carried in the hash
  const pgn = MoveTree.fromMoves(tree.mainline().map(n => n.uci), tree.startFen).toPgn({ White: headers.White || "?", Black: headers.Black || "?", Result: headers.Result || "*" });
  return location.origin + location.pathname + "#/analysis/pgn/" + encodeURIComponent(pgn.replace(/\[(Event|Site|Date) "[^"]*"\]\n/g, ""));
}

export { esc };
