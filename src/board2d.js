// 2D board renderer: crisp, chess.com-style DOM board implementing docs/board-contract.md.
// Squares are 64 static grid cells (fixed light/dark per visual position, relabelled on flip);
// pieces, highlights and hints are absolutely positioned 12.5% boxes moved with percentage
// transforms, so resizing touches one CSS variable and nothing per piece. Moves animate with the
// Web Animations API (compositor-only transforms/opacity). Arrows live in one SVG overlay.

const FILES = "abcdefgh";
const SQ_RE = /^[a-h][1-8]$/;
const PIECE_NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const CODES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];
const EASE = "cubic-bezier(.3,.05,.2,1)";          // quick start, soft landing
const SNAP_MS = 160;                                // illegal-drop snap-back
const FLIP_MS = 200;
const MAX_FLIP_FADE = 0.15;                         // opacity the flipped layers fade in from

// Arrow geometry in SVG units (one square = 100).
const ARROW = { shaft: 20, headW: 52, headL: 44, start: 0, tipBack: 8 };
const CIRCLE = { stroke: 7.5 };

// User-drawing brushes (lichess palette, chess.com-like translucency).
const BRUSHES = {
  green: "rgba(21,120,27,.8)",
  red: "rgba(186,38,38,.8)",
  blue: "rgba(0,72,170,.8)",
  orange: "rgba(232,145,0,.85)",
};

const DEFAULT_HL = {
  last: "rgba(255,255,51,.5)",     // chess.com last-move yellow
  sel: "rgba(255,255,51,.5)",
  pre: "rgba(226,72,62,.6)",       // premove coral-red
  hint: "rgba(0,0,0,.14)",         // legal-move dots and capture rings
};

const checker = (dark, light) => `conic-gradient(${dark} 0 25%, ${light} 0 50%, ${dark} 0 75%, ${light} 0)`;

// Board palettes. `light`/`dark` are square colors; optional `lightImg`/`darkImg` texture the squares
// (relative URLs, the app is served from a subpath); `last`/`sel`/`pre`/`hint` override highlight colors;
// `coordL`/`coordD` are the coordinate colors drawn on light/dark squares (default: the opposite color).
export const BOARD_THEMES = [
  { id: "green", name: "Green", light: "#ebecd0", dark: "#739552" },
  { id: "brown", name: "Brown", light: "#f0d9b5", dark: "#b58863", last: "rgba(155,199,0,.41)", sel: "rgba(20,85,30,.5)" },
  { id: "blue", name: "Blue", light: "#dee3e6", dark: "#8ca2ad", last: "rgba(155,199,0,.41)", sel: "rgba(20,85,30,.5)" },
  { id: "purple", name: "Purple", light: "#f0f1f0", dark: "#8476ba" },
  { id: "slate", name: "Slate", light: "#d5d9de", dark: "#6f7c8b" },
  {
    // photographic maple/walnut (same textures as the 3D board), warmed and lifted with blend modes
    // so black pieces stay readable on walnut; the colors double as the pre-load fallback
    id: "wood", name: "Wood", light: "#f8dfb4", dark: "#734626",
    lightImg: "./assets/maple.jpg", darkImg: "./assets/walnut.jpg", lightBlend: "multiply", darkBlend: "screen",
    coordL: "#734626", coordD: "#f6e2bd", swatchColors: ["#9a6a43", "#e8c895"],
  },
  { id: "coral", name: "Coral", light: "#f5e4d7", dark: "#cf8775", sel: "rgba(255,236,80,.55)" },
  { id: "ice", name: "Ice", light: "#e9f1f5", dark: "#88abc2" },
  { id: "espresso", name: "Espresso", light: "#e9d8b9", dark: "#7b5a41", coordD: "#efe1c6" },
].map((t) => ({ ...t, swatch: checker(...(t.swatchColors || [t.dark, t.light])) }));

// Piece sets shipped under public/assets/pieces/<id>/ (see LICENSES.md there).
export const PIECE_THEMES = [
  { id: "cburnett", name: "Cburnett", author: "Colin M.L. Burnett", license: "GPL-2.0-or-later" },
  { id: "merida", name: "Merida", author: "Armando Hernandez Marroquin", license: "GPL-2.0-or-later" },
  { id: "chessnut", name: "Chessnut", author: "Alexis Luengas", license: "Apache-2.0" },
  { id: "celtic", name: "Celtic", author: "Maurizio Monge", license: "MIT" },
  { id: "rhosgfx", name: "RhosGFX", author: "RhosGFX", license: "CC0-1.0" },
].map((t) => ({ ...t, swatch: `url(./assets/pieces/${t.id}/wN.svg)` }));

/** URL of one piece image, e.g. pieceUrl("cburnett", "w", "n"). Handy for promotion pickers / trays. */
export const pieceUrl = (set, color, type, assetBase = "./assets/") =>
  `${assetBase}pieces/${set}/${color}${type.toUpperCase()}.svg`;

const CSS = `
.b2d-root{position:absolute;inset:0;pointer-events:none;overflow:visible}
.b2d-board{position:absolute;left:0;top:0;width:0;height:0;pointer-events:auto;touch-action:none;isolation:isolate;
  user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;
  --b2d-sq:0px;--b2d-r:max(3px,calc(var(--b2d-sq)*.05))}
.b2d-board.b2d-grab{cursor:grab}
.b2d-board.b2d-dragging,.b2d-board.b2d-dragging *{cursor:grabbing!important}
.b2d-surface{position:absolute;inset:0;border-radius:var(--b2d-r);overflow:hidden;
  box-shadow:0 2px 3px rgba(0,0,0,.18),0 10px 28px rgba(0,0,0,.28);isolation:isolate}
.b2d-cells{position:absolute;inset:0;display:flex;flex-direction:column}
.b2d-row{display:flex;flex:1 1 0;min-height:0}
.b2d-cell{flex:1 1 0;min-width:0;background-color:var(--b2d-light);background-image:var(--b2d-light-img);
  background-size:300% 300%;background-repeat:no-repeat;background-blend-mode:var(--b2d-light-blend)}
.b2d-cell.b2d-dk{background-color:var(--b2d-dark);background-image:var(--b2d-dark-img);background-blend-mode:var(--b2d-dark-blend)}
.b2d-layer{position:absolute;inset:0;pointer-events:none}
.b2d-sqel{position:absolute;left:0;top:0;width:12.5%;height:12.5%;box-sizing:border-box;pointer-events:none}
.b2d-off{display:none!important}
.b2d-last{background:var(--b2d-last)}
.b2d-sel{background:var(--b2d-sel)}
.b2d-pre{background:var(--b2d-pre)}
.b2d-check{background:radial-gradient(ellipse at center,rgba(255,0,0,1) 0%,rgba(231,0,0,1) 25%,rgba(169,0,0,0) 89%,rgba(158,0,0,0) 100%)}
.b2d-dot::after{content:"";position:absolute;left:33.5%;top:33.5%;width:33%;height:33%;border-radius:50%;background:var(--b2d-hint)}
.b2d-ring{border-radius:50%;border:calc(var(--b2d-sq)*.085) solid var(--b2d-hint)}
.b2d-hover{box-shadow:inset 0 0 0 max(2px,calc(var(--b2d-sq)*.05)) rgba(255,255,255,.65)}
.b2d-cursor{box-shadow:inset 0 0 0 max(2px,calc(var(--b2d-sq)*.05)) rgba(52,210,123,.95)}
.b2d-badgesq{pointer-events:none;overflow:visible}
.b2d-badge{position:absolute;right:-9%;top:-9%;width:40%;height:40%;border-radius:50%;display:grid;place-items:center;color:#fff;font:900 calc(var(--b2d-sq)*.19)/1 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.45),inset 0 0 0 max(1px,calc(var(--b2d-sq)*.02)) rgba(255,255,255,.55);letter-spacing:-.5px}
.b2d-coord{position:absolute;left:0;top:0;width:12.5%;height:12.5%;box-sizing:border-box;display:flex;
  padding:calc(var(--b2d-sq)*.035) calc(var(--b2d-sq)*.055);
  font:600 max(8px,calc(var(--b2d-sq)*.17))/1 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.b2d-rk{align-items:flex-start;justify-content:flex-start}
.b2d-fl{align-items:flex-end;justify-content:flex-end}
.b2d-onl{color:var(--b2d-coord-l)}
.b2d-ond{color:var(--b2d-coord-d)}
.b2d-nocoords .b2d-coords{display:none}
.b2d-pieces{z-index:1}
.b2d-piece{position:absolute;left:0;top:0;width:12.5%;height:12.5%;pointer-events:none;
  background-size:100% 100%;background-repeat:no-repeat;background-position:center}
.b2d-moving{z-index:2}
.b2d-ghost{opacity:.35}
.b2d-arrows{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;overflow:visible}
.b2d-drag{z-index:3;will-change:transform;filter:drop-shadow(0 4px 5px rgba(0,0,0,.28))}
${CODES.map((c) => `.b2d-${c}{background-image:var(--b2d-${c})}`).join("")}
`;

function injectCss() {
  if (document.getElementById("board2d-css")) return;
  const st = document.createElement("style");
  st.id = "board2d-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

const div = (cls, parent) => {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  if (parent) parent.appendChild(el);
  return el;
};

const SVGNS = "http://www.w3.org/2000/svg";
const preloaded = new Set();

export class Board2D {
  /**
   * @param {HTMLElement} container  the board fills (and centers in) this element
   * @param {{ assetBase?: string, settings?: object }} [opts]  same options as Board3D:
   *   assetBase (default "./assets/") prefixes piece SVGs and wood textures; settings = initial applySettings
   */
  constructor(container, opts = {}) {
    if (!container || typeof container.appendChild !== "function") throw new Error("Board2D: container element required");
    injectCss();
    this.container = container;
    this._assetBase = opts.assetBase != null ? String(opts.assetBase).replace(/\/?$/, "/") : "./assets/";
    this._destroyed = false;
    this._coords = true;
    this.onSquareTap = null;
    this.canDrag = null;
    this.onDragStart = null;
    this.onDrop = null;

    this._orient = "w";
    this._active = true;
    this._animMs = 220;
    this._boardTheme = null;
    this._pieceTheme = null;
    this.pieces = new Map();       // square -> { el, color, type, sq }
    this._jobs = [];               // running animation jobs
    this._ptr = null;              // active pointer interaction
    this._rect = null;             // board client rect, measured once per interaction
    this._size = -1;
    this._arrows = [];             // programmatic arrows
    this._shapes = [];             // user drawings: { kind: "arrow"|"circle", from, to, brush }
    this._preview = null;          // user drawing in progress
    this._hoverSq = null;          // mouse hover (cursor feedback)

    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    this._root = div("b2d-root", container);
    const b = this._board = div("b2d-board", this._root);
    b.setAttribute("role", "grid");
    b.setAttribute("aria-label", "Chess board");
    b.setAttribute("aria-readonly", "true");
    // keyboard play: focus the board, move the outline with the arrow keys, Enter/Space taps
    b.tabIndex = 0;
    b.setAttribute("aria-describedby", "b2d-kbd-help");
    b.addEventListener("keydown", (e) => this._onKey(e));
    b.addEventListener("blur", () => { this._kbd = null; this.setCursor(null); });

    // surface: squares, tints, coordinates, hints (clipped to the rounded board)
    const surface = div("b2d-surface", b);
    const cells = div("b2d-cells", surface);
    this._cells = [];
    for (let r = 0; r < 8; r++) {
      const row = div("b2d-row", cells);
      row.setAttribute("role", "row");
      for (let c = 0; c < 8; c++) {
        const cell = div("b2d-cell" + ((r + c) % 2 ? " b2d-dk" : ""), row);
        cell.setAttribute("role", "gridcell");
        // pseudo-random texture crop per square so wood grain never repeats visibly
        cell.style.backgroundPosition = `${(c * 37 + r * 61) % 100}% ${(r * 43 + c * 29) % 100}%`;
        this._cells.push(cell);
      }
    }
    const hl = div("b2d-layer", surface);
    hl.setAttribute("aria-hidden", "true");
    this._sqEls = [];
    const mk = (cls, layer) => { const el = div("b2d-sqel b2d-off " + cls, layer); el._sq = null; this._sqEls.push(el); return el; };
    this._hlLayer = hl;
    this._el = {
      lastFrom: mk("b2d-last", hl), lastTo: mk("b2d-last", hl),
    };
    this._markLayer = div("b2d-layer", hl);
    this._marks = [];
    Object.assign(this._el, {
      preFrom: mk("b2d-pre", hl), preTo: mk("b2d-pre", hl),
      sel: mk("b2d-sel", hl),
      check: mk("b2d-check", hl),
    });

    const coords = this._coordsLayer = div("b2d-layer b2d-coords", surface);
    coords.setAttribute("aria-hidden", "true");
    this._rankLabels = [];
    this._fileLabels = [];
    for (let i = 0; i < 8; i++) {
      const rk = div(`b2d-coord b2d-rk ${i % 2 ? "b2d-ond" : "b2d-onl"}`, coords);  // column 0, row i
      rk.style.transform = `translate(0,${i * 100}%)`;
      this._rankLabels.push(rk);
      const fl = div(`b2d-coord b2d-fl ${(7 + i) % 2 ? "b2d-ond" : "b2d-onl"}`, coords); // row 7, column i
      fl.style.transform = `translate(${i * 100}%,700%)`;
      this._fileLabels.push(fl);
    }

    const hints = this._hintLayer = div("b2d-layer", surface);
    hints.setAttribute("aria-hidden", "true");
    this._dots = [];
    this._rings = [];
    this._el.hover = mk("b2d-hover", hints);
    this._el.cursor = mk("b2d-cursor", hints);

    this._pieceLayer = div("b2d-layer b2d-pieces", b);
    this._pieceLayer.setAttribute("aria-hidden", "true");

    // move-classification badge (Game Review), drawn over the pieces at a square's corner
    const badgeLayer = div("b2d-layer", b);
    badgeLayer.setAttribute("aria-hidden", "true");
    this._el.badge = mk("b2d-badgesq", badgeLayer);
    this._badgeDot = div("b2d-badge", this._el.badge);

    const svg = this._svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "b2d-arrows");
    svg.setAttribute("viewBox", "0 0 800 800");
    svg.setAttribute("aria-hidden", "true");
    b.appendChild(svg);

    this._dragEl = div("b2d-piece b2d-drag b2d-off", b);
    this._dragEl.setAttribute("aria-hidden", "true");

    this._relabel();
    this.applySettings({ boardTheme: "green", pieceTheme: "cburnett", coords: true, animMs: 220 });
    if (opts.settings) this.applySettings(opts.settings);

    // input
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onCancel = this._onCancel.bind(this);
    b.addEventListener("pointerdown", this._onDown);
    b.addEventListener("pointermove", this._onMove);
    b.addEventListener("pointerup", this._onUp);
    b.addEventListener("pointercancel", this._onCancel);
    // only our own capture loss counts: a touch's implicit capture on the cell under the finger is
    // released (and that event bubbles here) the moment the board takes the capture
    b.addEventListener("lostpointercapture", (e) => { if (e.target === b) this._onCancel(e); });
    b.addEventListener("pointerleave", () => this._setHover(null));
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    b.addEventListener("dragstart", (e) => e.preventDefault());

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
  }

  // ---------------------------------------------------------------- lifecycle

  setActive(on) {
    if (this._destroyed) return;
    this._active = !!on;
    if (!this._active) { this._cancelPointer(); this._finishAnims(); }
  }

  destroy() {
    if (this._destroyed) return;
    this._active = false;
    this._cancelPointer();
    this._finishAnims();
    this._destroyed = true;
    if (this._ro) this._ro.disconnect();
    this._ro = null;
    this._root.remove();
    this.pieces.clear();
    this.onSquareTap = this.canDrag = this.onDragStart = this.onDrop = null;
  }

  get orientation() { return this._orient; }

  /** Current settings ({ boardTheme, pieceTheme, coords, animMs }), mirrors Board3D. */
  get settings() {
    return { boardTheme: this._boardTheme, pieceTheme: this._pieceTheme, coords: this._coords, animMs: this._animMs };
  }

  // Board3D parity no-ops: the DOM board has no render loop, idle camera orbit or dirty flags.
  setIdle() {}
  invalidate() {}
  renderNow() {}

  _asset(path) { // "./assets/x" -> "<assetBase>x"
    return path.startsWith("./assets/") ? this._assetBase + path.slice(9) : path;
  }

  // ---------------------------------------------------------------- geometry

  _rc(sq) { // -> [row, col] visual, row 0 = top
    const f = sq.charCodeAt(0) - 97, r = sq.charCodeAt(1) - 49;
    return this._orient === "w" ? [7 - r, f] : [r, 7 - f];
  }
  _sqRC(r, c) { return this._orient === "w" ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1); }
  _tf(sq) { const [r, c] = this._rc(sq); return `translate(${c * 100}%,${r * 100}%)`; }
  _measure() { this._rect = this._board.getBoundingClientRect(); return this._rect; }
  _sqAt(x, y) {
    const rect = this._rect || this._measure();
    const s = rect.width / 8;
    if (!s) return null;
    const c = Math.floor((x - rect.left) / s), r = Math.floor((y - rect.top) / s);
    return c < 0 || c > 7 || r < 0 || r > 7 ? null : this._sqRC(r, c);
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    // multiple of 8 device pixels: every square lands on whole pixels, no seams, crisp pieces
    const size = Math.max(0, Math.floor((Math.min(w, h) * dpr) / 8) * 8 / dpr);
    const left = Math.round(((w - size) / 2) * dpr) / dpr, top = Math.round(((h - size) / 2) * dpr) / dpr;
    const st = this._board.style;
    if (size !== this._size) {
      this._size = size;
      st.width = st.height = size + "px";
      st.setProperty("--b2d-sq", size / 8 + "px");
    }
    st.left = left + "px";
    st.top = top + "px";
    this._rect = null;
    if (this._ptr) { // resized mid-interaction (rotation, mobile toolbars): keep the drag aligned
      this._measure();
      const p = this._ptr;
      if (p.dragging && p.cx != null) this._dragTo(p, p.cx, p.cy);
    }
  }

  // ---------------------------------------------------------------- orientation

  viewSide(color, animate = true) {
    const o = color === "b" ? "b" : "w";
    if (o === this._orient) return;
    this._cancelPointer();
    this._finishAnims();
    this._orient = o;
    this._relabel();
    for (const p of this.pieces.values()) p.el.style.transform = this._tf(p.sq);
    for (const el of this._sqEls) if (el._sq) el.style.transform = this._tf(el._sq);
    this._renderShapes();
    if (animate && this._active && !document.hidden && this._board.animate) {
      for (const layer of [this._pieceLayer, this._hlLayer, this._hintLayer, this._svg]) {
        layer.animate([{ opacity: MAX_FLIP_FADE }, { opacity: 1 }], { duration: FLIP_MS, easing: "ease-out" });
      }
    }
  }

  _relabel() {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const cell = this._cells[r * 8 + c]; cell.dataset.sq = this._sqRC(r, c); cell.id = "b2d-sq-" + cell.dataset.sq; }
    for (let i = 0; i < 8; i++) {
      this._rankLabels[i].textContent = this._orient === "w" ? String(8 - i) : String(i + 1);
      this._fileLabels[i].textContent = this._orient === "w" ? FILES[i] : FILES[7 - i];
    }
    this._board.setAttribute("aria-label", `Chess board, ${this._orient === "w" ? "white" : "black"} at the bottom`);
    this._updateLabels();
  }

  _updateLabels() {
    for (const cell of this._cells) {
      const sq = cell.dataset.sq;
      const p = this.pieces.get(sq);
      const label = p ? `${sq}, ${p.color === "w" ? "white" : "black"} ${PIECE_NAMES[p.type]}` : sq;
      if (cell.getAttribute("aria-label") !== label) cell.setAttribute("aria-label", label);
    }
  }

  // ---------------------------------------------------------------- pieces

  _newPiece(color, type, sq) {
    const el = div("b2d-piece", this._pieceLayer);
    const p = { el, color, type, sq };
    this._setCode(p);
    el.style.transform = this._tf(sq);
    return p;
  }

  _setCode(p) {
    const code = p.color + p.type.toUpperCase();
    if (p.code === code) return;
    if (p.code) p.el.classList.remove("b2d-" + p.code);
    p.el.classList.add("b2d-" + code);
    p.code = code;
  }

  syncFromBoard(board2d) {
    this._finishAnims();
    const want = new Map();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board2d && board2d[r] && board2d[r][f];
        if (cell) want.set(FILES[f] + (8 - r), cell);
      }
    }
    const spare = new Map(); // code -> piece[] removed from their square, reusable elsewhere
    for (const [sq, p] of this.pieces) {
      const w = want.get(sq);
      if (w && w.color === p.color && w.type === p.type) { want.delete(sq); continue; }
      this.pieces.delete(sq);
      const k = p.color + p.type;
      if (!spare.has(k)) spare.set(k, []);
      spare.get(k).push(p);
    }
    for (const [sq, w] of want) {
      const list = spare.get(w.color + w.type);
      let p;
      if (list && list.length) {
        p = list.pop();
        p.sq = sq;
        p.el.style.transform = this._tf(sq);
      } else {
        p = this._newPiece(w.color, w.type, sq);
      }
      this.pieces.set(sq, p);
    }
    for (const list of spare.values()) for (const p of list) p.el.remove();
    this._afterPositionChange();
  }

  animateMove(mv, opts, onDone) {
    if (typeof opts === "function") { onDone = opts; opts = null; } // Board3D-era call shape
    const instant = !!(opts && opts.instant);
    this._finishAnims();
    const done = typeof onDone === "function" ? onDone : null;
    const p = mv && this.pieces.get(mv.from);
    if (!p || !SQ_RE.test(mv.to)) { if (done) done(); return; }

    const flags = mv.flags || "";
    const dur = instant || !this._active || document.hidden || !p.el.animate ? 0 : Math.max(0, Number(this._animMs) || 0);
    const anims = [], finals = [];

    // capture (en passant: the pawn beside the destination). A piece found on `to` is always removed,
    // so a stale render can't leave two pieces stacked on one square.
    const capSq = flags.includes("e") ? mv.to[0] + mv.from[1] : mv.to;
    const cap = this.pieces.get(capSq);
    if (cap && cap !== p) {
      this.pieces.delete(capSq);
      if (dur) {
        anims.push(cap.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: "ease-in", fill: "forwards" }));
        finals.push(() => cap.el.remove());
      } else cap.el.remove();
    }

    this.pieces.delete(mv.from);
    this._slide(p, mv.to, dur, anims, finals);

    // castling: the rook moves too
    if (flags.includes("k") || flags.includes("q")) {
      const rank = mv.from[1];
      const [rf, rt] = flags.includes("k") ? ["h" + rank, "f" + rank] : ["a" + rank, "d" + rank];
      const rook = this.pieces.get(rf);
      if (rook) { this.pieces.delete(rf); this._slide(rook, rt, dur, anims, finals); }
    }

    // promotion: the pawn arrives, then becomes the new piece
    if (mv.promotion) {
      p.type = mv.promotion;
      if (dur) finals.push(() => this._setCode(p)); else this._setCode(p);
    }

    this._afterPositionChange();
    if (!dur) { if (done) done(); return; }
    this._runJob(anims, finals, done, dur);
  }

  _slide(p, to, dur, anims, finals) {
    const from = p.sq;
    p.sq = to;
    this.pieces.set(to, p);
    const toTf = this._tf(to);
    p.el.style.transform = toTf;
    if (!dur || from === to) return;
    p.el.classList.add("b2d-moving");
    anims.unshift(p.el.animate([{ transform: this._tf(from) }, { transform: toTf }], { duration: dur, easing: EASE }));
    finals.push(() => p.el.classList.remove("b2d-moving"));
  }

  _runJob(anims, finals, onDone, dur) {
    if (!anims.length) { for (const f of finals) f(); if (onDone) onDone(); return; }
    const job = { done: false };
    job.complete = () => {
      if (job.done) return;
      job.done = true;
      clearTimeout(job.timer);
      const i = this._jobs.indexOf(job);
      if (i >= 0) this._jobs.splice(i, 1);
      for (const a of anims) { a.onfinish = null; try { a.cancel(); } catch { /* already gone */ } }
      for (const f of finals) f();
      if (onDone) onDone();
    };
    anims[0].onfinish = job.complete;
    job.timer = setTimeout(job.complete, dur + 250); // safety net if finish never fires
    this._jobs.push(job);
  }

  _finishAnims() {
    while (this._jobs.length) this._jobs[0].complete();
  }

  _afterPositionChange() {
    this._updateLabels();
    // a running drag survives only if its piece is still on the origin square
    const st = this._ptr;
    if (st && st.dragging && this.pieces.get(st.sq) !== st.piece) this._cancelPointer();
  }

  // ---------------------------------------------------------------- highlights

  _show(el, sq) {
    if (sq && SQ_RE.test(sq)) {
      el._sq = sq;
      el.style.transform = this._tf(sq);
      el.classList.remove("b2d-off");
    } else {
      el._sq = null;
      el.classList.add("b2d-off");
    }
  }

  _pool(pool, layer, cls, squares) {
    const list = (squares || []).filter((s) => SQ_RE.test(s));
    while (pool.length < list.length) {
      const el = div("b2d-sqel b2d-off " + cls, layer);
      el._sq = null;
      pool.push(el);
      this._sqEls.push(el);
    }
    for (let i = 0; i < pool.length; i++) this._show(pool[i], list[i] || null);
  }

  setLastMove(from, to) { this._show(this._el.lastFrom, from); this._show(this._el.lastTo, to); }
  setCheck(sq) { this._show(this._el.check, sq); }
  /** Extra: Game Review classification badge on a square (null clears). badge = { text, color } */
  setBadge(sq, badge) {
    if (!sq || !badge) { this._show(this._el.badge, null); return; }
    this._badgeDot.textContent = badge.text;
    this._badgeDot.style.background = badge.color;
    this._show(this._el.badge, sq);
  }
  setSelected(sq) { this._show(this._el.sel, sq); }
  setPremove(from, to) { this._show(this._el.preFrom, from); this._show(this._el.preTo, to); }
  _onKey(e) {
    const D = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (e.key in D) {
      e.preventDefault();
      e.stopPropagation();
      const inv = this._orient === "b" ? -1 : 1;
      let sq = this._kbd || (this._orient === "b" ? "e7" : "e2");
      if (this._kbd) {
        const f = Math.max(0, Math.min(7, "abcdefgh".indexOf(sq[0]) + D[e.key][0] * inv));
        const r = Math.max(0, Math.min(7, Number(sq[1]) - 1 + D[e.key][1] * inv));
        sq = "abcdefgh"[f] + (r + 1);
      }
      this._kbd = sq;
      this.setCursor(sq);
      const cell = this._board.querySelector(`[data-sq="${sq}"]`);
      if (cell) this._board.setAttribute("aria-activedescendant", cell.id || "");
      this._announceSq(sq);
    } else if ((e.key === "Enter" || e.key === " ") && this._kbd) {
      e.preventDefault();
      e.stopPropagation();
      if (this.onSquareTap) this.onSquareTap(this._kbd);
    } else if (e.key === "Escape" && this._kbd) {
      this._kbd = null;
      this.setCursor(null);
    }
  }

  _announceSq(sq) {
    const live = document.getElementById("sr-live");
    const cell = this._board.querySelector(`[data-sq="${sq}"]`);
    if (live) live.textContent = (cell && cell.getAttribute("aria-label")) || sq;
  }

  /** Extra (not in the contract): keyboard-navigation cursor outline, mirrors Board3D.setCursor. */
  setCursor(sq) { this._show(this._el.cursor, sq); }

  showMoves(quietSquares, captureSquares) {
    this._pool(this._dots, this._hintLayer, "b2d-dot", quietSquares);
    this._pool(this._rings, this._hintLayer, "b2d-ring", captureSquares);
  }

  clearHints() { this.showMoves([], []); this.setSelected(null); }

  setMarks(marks) {
    const list = (marks || []).filter((m) => m && SQ_RE.test(m.sq));
    this._pool(this._marks, this._markLayer, "b2d-mark", list.map((m) => m.sq));
    list.forEach((m, i) => { this._marks[i].style.background = m.color || DEFAULT_HL.last; });
  }

  setArrows(arrows) {
    this._arrows = (arrows || []).filter((a) => a && SQ_RE.test(a.from) && SQ_RE.test(a.to) && a.from !== a.to);
    this._renderShapes();
  }

  clearUserDrawings() {
    if (!this._shapes.length && !this._preview) return;
    this._shapes = [];
    this._preview = null;
    this._renderShapes();
  }

  /** Extra: the user's current right-click drawings ({ kind, from, to?, color }). */
  get userDrawings() {
    return this._shapes.map((s) => ({ kind: s.kind, from: s.from, to: s.to, color: BRUSHES[s.brush] }));
  }

  // ---------------------------------------------------------------- arrows & circles (SVG)

  _center(sq) { const [r, c] = this._rc(sq); return [c * 100 + 50, r * 100 + 50]; }

  _arrowPath(from, to) {
    const [ax, ay] = this._center(from), [bx, by] = this._center(to);
    const dc = Math.abs(bx - ax) / 100, dr = Math.abs(by - ay) / 100;
    const W = ARROW.shaft / 2, HW = ARROW.headW / 2, HL = ARROW.headL;
    const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
    const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
    let pts;
    if ((dc === 1 && dr === 2) || (dc === 2 && dr === 1)) {
      // knight: L-shape, long leg first, square corner
      const C = dr > dc ? [ax, by] : [bx, ay];
      const u1 = unit(C[0] - ax, C[1] - ay), u2 = unit(bx - C[0], by - C[1]);
      const n1 = [-u1[1], u1[0]], n2 = [-u2[1], u2[0]];
      const s = add([ax, ay], u1, ARROW.start);
      const tip = add([bx, by], u2, -ARROW.tipBack);
      const base = add(tip, u2, -HL);
      const inner = add(add(C, n1, W), n2, W), outer = add(add(C, n1, -W), n2, -W);
      pts = [add(s, n1, W), inner, add(base, n2, W), add(base, n2, HW), tip,
        add(base, n2, -HW), add(base, n2, -W), outer, add(s, n1, -W)];
    } else {
      const u = unit(bx - ax, by - ay), n = [-u[1], u[0]];
      const s = add([ax, ay], u, ARROW.start);
      const tip = add([bx, by], u, -ARROW.tipBack);
      const base = add(tip, u, -HL);
      pts = [add(s, n, W), add(base, n, W), add(base, n, HW), tip, add(base, n, -HW), add(base, n, -W), add(s, n, -W)];
    }
    return "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L") + "Z";
  }

  _renderShapes() {
    const svg = this._svg;
    while (svg.firstChild) svg.firstChild.remove();
    const draw = (s, color, opacity) => {
      let el;
      if (s.kind === "circle") {
        const [cx, cy] = this._center(s.from);
        el = document.createElementNS(SVGNS, "circle");
        el.setAttribute("cx", cx);
        el.setAttribute("cy", cy);
        el.setAttribute("r", 50 - CIRCLE.stroke / 2 - 1.5);
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", color);
        el.setAttribute("stroke-width", CIRCLE.stroke);
      } else {
        el = document.createElementNS(SVGNS, "path");
        el.setAttribute("d", this._arrowPath(s.from, s.to));
        el.setAttribute("fill", color);
      }
      if (opacity != null) el.setAttribute("opacity", opacity);
      svg.appendChild(el);
    };
    for (const a of this._arrows) draw({ kind: "arrow", from: a.from, to: a.to }, a.color || BRUSHES.green);
    for (const s of this._shapes) draw(s, BRUSHES[s.brush]);
    if (this._preview) draw(this._preview, BRUSHES[this._preview.brush], 0.7);
  }

  _toggleShape(shape) {
    const i = this._shapes.findIndex((s) => s.kind === shape.kind && s.from === shape.from && s.to === shape.to);
    if (i < 0) this._shapes.push(shape);
    else if (this._shapes[i].brush === shape.brush) this._shapes.splice(i, 1);
    else this._shapes[i] = shape;
  }

  // ---------------------------------------------------------------- settings

  applySettings(s = {}) {
    if (!s) return;
    // boardTheme2d / pieceTheme2d (the store's key names) are accepted as aliases; cameraMode is ignored
    const bt = s.boardTheme != null ? s.boardTheme : s.boardTheme2d;
    const pt = s.pieceTheme != null ? s.pieceTheme : s.pieceTheme2d;
    if (bt != null) this._applyBoardTheme(bt);
    if (pt != null) this._applyPieceTheme(pt);
    if (s.coords != null) {
      this._coords = !!s.coords;
      this._board.classList.toggle("b2d-nocoords", !this._coords);
    }
    if (s.animMs != null && Number.isFinite(Number(s.animMs))) this._animMs = Math.min(3000, Math.max(0, Number(s.animMs)));
  }

  _applyBoardTheme(id) {
    const t = BOARD_THEMES.find((x) => x.id === id) || BOARD_THEMES[0];
    if (this._boardTheme === t.id) return;
    this._boardTheme = t.id;
    const st = this._board.style;
    const set = (k, v) => st.setProperty("--b2d-" + k, v);
    set("light", t.light);
    set("dark", t.dark);
    set("light-img", t.lightImg ? `url("${this._asset(t.lightImg)}")` : "none");
    set("dark-img", t.darkImg ? `url("${this._asset(t.darkImg)}")` : "none");
    set("light-blend", t.lightBlend || "normal");
    set("dark-blend", t.darkBlend || "normal");
    set("coord-l", t.coordL || t.dark);
    set("coord-d", t.coordD || t.light);
    for (const k of ["last", "sel", "pre", "hint"]) set(k, t[k] || DEFAULT_HL[k]);
    this._board.dataset.theme = t.id;
  }

  _applyPieceTheme(id) {
    const t = PIECE_THEMES.find((x) => x.id === id) || PIECE_THEMES[0];
    if (this._pieceTheme === t.id) return;
    this._pieceTheme = t.id;
    const st = this._board.style;
    for (const code of CODES) {
      const url = `${this._assetBase}pieces/${t.id}/${code}.svg`;
      st.setProperty("--b2d-" + code, `url("${url}")`);
      if (!preloaded.has(url)) { preloaded.add(url); const img = new Image(); img.src = url; }
    }
    this._board.dataset.pieces = t.id;
  }

  // ---------------------------------------------------------------- input

  _setHover(sq) {
    if (sq === this._hoverSq) return;
    this._hoverSq = sq;
    const p = sq && this.pieces.get(sq);
    let grab = false;
    try { grab = !!(p && this.canDrag && this.canDrag(sq)); } catch { grab = false; }
    this._board.classList.toggle("b2d-grab", grab);
  }

  _onDown(e) {
    if (!this._active) return;
    if (this._ptr) {
      // a second finger during a touch drag is ignored; a new mouse press means the old one was lost
      if (e.pointerType !== "mouse" && this._ptr.type !== "mouse") return;
      this._cancelPointer();
    }
    if (e.button === 2) {
      this._measure();
      const sq = this._sqAt(e.clientX, e.clientY);
      if (!sq) return;
      this._ptr = { id: e.pointerId, type: e.pointerType, right: true, sq };
      this._capture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no emulated mouse events, no focus steal
    this._measure();
    if (this._shapes.length) this.clearUserDrawings();
    const sq = this._sqAt(e.clientX, e.clientY);
    if (!sq) return;
    const p = this.pieces.get(sq);
    let draggable = false;
    try { draggable = !!(p && this.canDrag && this.canDrag(sq)); } catch { draggable = false; }
    this._ptr = {
      id: e.pointerId, type: e.pointerType, sq, x0: e.clientX, y0: e.clientY,
      draggable, dragging: false, piece: p || null, hover: null,
    };
    this._capture(e.pointerId);
  }

  _capture(id) { try { this._board.setPointerCapture(id); } catch { /* synthetic events */ } }

  _onMove(e) {
    const st = this._ptr;
    if (!st) {
      if (e.pointerType === "mouse" && this._active) {
        const cell = e.target && e.target.closest ? e.target.closest(".b2d-cell") : null;
        this._setHover(cell ? cell.dataset.sq : null);
      }
      return;
    }
    if (e.pointerId !== st.id) return;
    if (st.right) {
      const sq = this._sqAt(e.clientX, e.clientY);
      const brush = this._brush(e);
      const pv = !sq ? null : sq === st.sq ? { kind: "circle", from: st.sq, brush } : { kind: "arrow", from: st.sq, to: sq, brush };
      const old = this._preview;
      if ((!pv && !old) || (pv && old && pv.kind === old.kind && pv.to === old.to && pv.brush === old.brush)) return;
      this._preview = pv;
      this._renderShapes();
      return;
    }
    if (!st.dragging) {
      if (!st.draggable) return;
      const thr = st.type === "mouse" ? 3 : 6;
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < thr) return;
      if (!this._startDrag(st)) return;
    }
    this._dragTo(st, e.clientX, e.clientY);
  }

  _startDrag(st) {
    const p = this.pieces.get(st.sq);
    if (!p) { st.draggable = false; return false; }
    st.dragging = true;
    st.piece = p;
    st.scale = st.type === "mouse" ? 1.1 : 1.2;
    p.el.classList.add("b2d-ghost");
    const d = this._dragEl;
    d.className = `b2d-piece b2d-drag b2d-${p.code}`;
    d.style.width = d.style.height = 12.5 * st.scale + "%"; // enlarge by size, not scale(): stays crisp
    this._board.classList.add("b2d-dragging");
    if (this.onDragStart) this.onDragStart(st.sq);
    return this._ptr === st; // the callback may have cancelled us (e.g. by flipping the board)
  }

  _dragTo(st, x, y) {
    const rect = this._rect || this._measure(), half = (rect.width / 16) * st.scale;
    st.cx = x;
    st.cy = y;
    st.x = x - rect.left;
    st.y = y - rect.top;
    this._dragEl.style.transform = `translate(${st.x - half}px,${st.y - half}px)`;
    const sq = this._sqAt(x, y);
    if (sq !== st.hover) { st.hover = sq; this._show(this._el.hover, sq); }
  }

  _endDragVisuals(st) {
    this._dragEl.classList.add("b2d-off");
    this._show(this._el.hover, null);
    this._board.classList.remove("b2d-dragging");
    if (st.piece) st.piece.el.classList.remove("b2d-ghost");
  }

  _onUp(e) {
    const st = this._ptr;
    if (!st || e.pointerId !== st.id) return;
    this._ptr = null;
    if (st.right) {
      const sq = this._sqAt(e.clientX, e.clientY);
      this._preview = null;
      if (sq) this._toggleShape(sq === st.sq
        ? { kind: "circle", from: sq, brush: this._brush(e) }
        : { kind: "arrow", from: st.sq, to: sq, brush: this._brush(e) });
      this._renderShapes();
      return;
    }
    if (!st.dragging) {
      const tapSlop = st.type === "mouse" ? 6 : 12;
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) <= tapSlop && this.onSquareTap) this.onSquareTap(st.sq);
      return;
    }
    const to = this._sqAt(e.clientX, e.clientY);
    this._endDragVisuals(st);
    if (to === st.sq) { if (this.onSquareTap) this.onSquareTap(st.sq); return; }
    // The piece is back on `from` (ghost removed). An accepted drop is placed by the controller's
    // animateMove(mv, { instant: true }); a refused one slides back from where it was released.
    const ok = this.onDrop ? !!this.onDrop(st.sq, to) : false;
    if (!ok && this.pieces.get(st.sq) === st.piece) this._snapBack(st);
  }

  _snapBack(st) {
    const p = st.piece, s = (this._rect || this._measure()).width / 8;
    const dur = this._animMs > 0 && this._active && !document.hidden && p.el.animate ? Math.min(SNAP_MS, this._animMs) : 0;
    if (!dur) return;
    const [r, c] = this._rc(p.sq);
    p.el.classList.add("b2d-moving");
    const a = p.el.animate(
      [{ transform: `translate(${st.x - s / 2}px,${st.y - s / 2}px)` }, { transform: `translate(${c * s}px,${r * s}px)` }],
      { duration: dur, easing: "cubic-bezier(.2,.7,.3,1)" });
    this._runJob([a], [() => p.el.classList.remove("b2d-moving")], null, dur);
  }

  _onCancel(e) {
    const st = this._ptr;
    if (!st || (e && e.pointerId !== st.id)) return;
    this._cancelPointer();
  }

  _cancelPointer() {
    const st = this._ptr;
    if (!st) return;
    this._ptr = null;
    if (st.right) { this._preview = null; this._renderShapes(); }
    else if (st.dragging) this._endDragVisuals(st);
    try { this._board.releasePointerCapture(st.id); } catch { /* not captured */ }
  }

  _brush(e) {
    if (e.shiftKey) return "red";
    if (e.altKey) return "blue";
    if (e.ctrlKey || e.metaKey) return "orange";
    return "green";
  }
}
