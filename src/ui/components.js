// Reusable UI pieces: player strips, move lists, variation tree, eval bar/graph, modals, toasts.
import { h, esc, icon, fmtClock, $ } from "./dom.js";
import { getSettings } from "../store.js";

export const GLYPH = { w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" }, b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" } };
const TEXT = "︎";
export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export const CLS = {
  brilliant: { label: "Brilliant", sym: "!!", color: "var(--c-brilliant)" },
  great: { label: "Great", sym: "!", color: "var(--c-great)" },
  best: { label: "Best", sym: "★", color: "var(--c-best)" },
  excellent: { label: "Excellent", sym: "👍", color: "var(--c-excellent)" },
  good: { label: "Good", sym: "✓", color: "var(--c-good)" },
  book: { label: "Book", sym: "📖", color: "var(--c-book)" },
  inaccuracy: { label: "Inaccuracy", sym: "?!", color: "var(--c-inaccuracy)" },
  mistake: { label: "Mistake", sym: "?", color: "var(--c-mistake)" },
  miss: { label: "Miss", sym: "✕", color: "var(--c-miss)" },
  blunder: { label: "Blunder", sym: "??", color: "var(--c-blunder)" },
  forced: { label: "Forced", sym: "→", color: "var(--c-forced)" },
};
export const CLS_HEX = {
  brilliant: "#1fc0b4", great: "#5b8fd6", best: "#52b36a", excellent: "#78c25c", good: "#97ad86", book: "#b08d68",
  inaccuracy: "#e8c13c", mistake: "#f0913a", miss: "#ec6b5b", blunder: "#e0372a", forced: "#8a8f96",
};
export function clsDot(id, size = 18) {
  const c = CLS[id];
  if (!c) return null;
  const sym = c.sym === "👍" ? "+" : c.sym === "📖" ? "B" : c.sym;
  return h("span.cls-dot", { style: { background: c.color, width: size + "px", height: size + "px" }, title: c.label }, sym);
}

// SAN with figurines when the setting asks for it
export function sanHtml(san, color) {
  if (getSettings().notation !== "figurine" || !san) return esc(san);
  const m = /^([KQRBN])/.exec(san);
  if (!m) return esc(san);
  return `<span class="fig">${GLYPH[color][m[1].toLowerCase()]}${TEXT}</span>${esc(san.slice(1))}`;
}

// ---------- player strip ----------
export function renderStrip(el, p) {
  if (!p) { el.innerHTML = ""; return; }
  el.innerHTML = "";
  const av = h("div.avatar", { style: { background: p.avatar?.bg || "#3a2e24" } }, p.avatar?.emoji || "♟");
  const name = h("div.pname", h("span", p.name),
    p.rating ? h("span.rating", `(${p.rating})`) : null,
    p.flag ? h("span.flagc", p.flag) : null,
    p.thinking ? h("span.thinking", h("i"), h("i"), h("i")) : null);
  const caps = h("div.caps");
  if (p.captured) {
    const order = ["p", "n", "b", "r", "q"];
    const sorted = [...p.captured].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    let prev = null;
    for (const t of sorted) {
      if (prev && prev !== t) caps.appendChild(h("span.gap"));
      caps.appendChild(h("span.g", GLYPH[p.capColor || "b"][t] + TEXT));
      prev = t;
    }
    if (p.adv > 0) caps.appendChild(h("span.adv", "+" + p.adv));
  }
  el.append(av, h("div.pinfo", name, caps));
  if (p.clockMs !== undefined && p.clockMs !== null) {
    const ck = h("div.clock", { role: "timer", "aria-label": `${p.name} clock` });
    el.appendChild(ck);
    el._clock = ck;
    updateClock(el, p.clockMs, p.active);
  } else el._clock = null;
}

export function updateClock(stripEl, ms, active) {
  const ck = stripEl._clock;
  if (!ck) return;
  const txt = fmtClock(ms);
  if (ck._t !== txt) { ck.textContent = txt; ck._t = txt; }
  ck.classList.toggle("active", !!active);
  ck.classList.toggle("low", getSettings().lowTimeWarning && ms <= 20000 && ms > 0 && !!active);
}

// ---------- linear move list ----------
// plies: [{ san, color, cls? }]; cur: index of current ply (-1 = start)
export class MoveList {
  constructor(onPick) {
    this.el = h("div.moves", { role: "list", "aria-label": "Moves" });
    this.onPick = onPick;
    this.el.addEventListener("click", (e) => {
      const mv = e.target.closest(".mv");
      if (mv) this.onPick(Number(mv.dataset.i));
    });
  }
  render(plies, cur, startPly = 0) {
    if (!plies.length) { this.el.innerHTML = `<div class="moves-empty">Moves will appear here.</div>`; return; }
    let html = "";
    let i = 0;
    // a game starting with Black to move shows "1... e5"
    const offset = startPly % 2;
    const firstNo = Math.floor(startPly / 2) + 1;
    let row = -1;
    const cell = (k) => {
      const p = plies[k];
      const cls = p.cls ? `<span class="cls" style="background:${CLS[p.cls].color}">${CLS[p.cls].sym === "👍" ? "+" : CLS[p.cls].sym === "📖" ? "B" : CLS[p.cls].sym}</span>` : "";
      const t = p.time != null ? `<span class="mt">${fmtSpent(p.time)}</span>` : "";
      return `<span class="mv${k === cur ? " cur" : ""}" data-i="${k}" role="listitem">${sanHtml(p.san, p.color)}${cls}${t}</span>`;
    };
    if (offset) {
      html += `<div class="mrow"><span class="mno">${firstNo}.</span><span class="mv muted">…</span>${cell(0)}</div>`;
      i = 1; row = 0;
    }
    for (; i < plies.length; i += 2) {
      const no = firstNo + Math.floor((i + offset) / 2);
      html += `<div class="mrow"><span class="mno">${no}.</span>${cell(i)}${i + 1 < plies.length ? cell(i + 1) : "<span></span>"}</div>`;
      row++;
    }
    this.el.innerHTML = html;
    const curEl = this.el.querySelector(".mv.cur");
    if (curEl) scrollWithin(this.el, curEl);
    else if (cur === plies.length - 1 || cur < 0) this.el.scrollTop = cur < 0 ? 0 : this.el.scrollHeight;
  }
}

// Scroll only the list itself: scrollIntoView also scrolls the page, which on phones pushes
// the board off the top of the screen as the move list grows.
function scrollWithin(list, el) {
  const r = el.getBoundingClientRect(), box = list.getBoundingClientRect();
  if (r.top < box.top) list.scrollTop -= box.top - r.top;
  else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
}

function fmtSpent(ms) {
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

// ---------- variation tree (analysis) ----------
export class TreeView {
  constructor(onPick) {
    this.el = h("div.moves.tree");
    this.onPick = onPick;
    this.el.addEventListener("click", (e) => {
      const mv = e.target.closest(".mv");
      if (mv) this.onPick(Number(mv.dataset.id));
    });
  }
  render(tree, curNode, annotations = {}) {
    const out = [];
    const tok = (n, forceNo) => {
      const white = n.ply % 2 === 1;
      const no = Math.floor((n.ply - 1) / 2) + 1;
      const prefix = white ? `<span class="vno">${no}.</span>` : forceNo ? `<span class="vno">${no}…</span>` : "";
      const a = annotations[n.id];
      const cls = a && CLS[a] ? `<span class="cls" style="background:${CLS[a].color}">${CLS[a].sym === "👍" ? "+" : CLS[a].sym === "📖" ? "B" : CLS[a].sym}</span>` : "";
      return `${prefix}<span class="mv${n === curNode ? " cur" : ""}" data-id="${n.id}">${sanHtml(n.san, white ? "w" : "b")}${cls}</span> `;
    };
    const walk = (node, forceNo) => {
      if (!node.children.length) return;
      const [main, ...vars] = node.children;
      out.push(tok(main, forceNo));
      for (const v of vars) {
        out.push(`<span class="var">`);
        out.push(tok(v, true));
        walk(v, false);
        out.push(`</span>`);
      }
      walk(main, vars.length > 0);
    };
    walk(tree.root, true);
    this.el.innerHTML = out.length ? out.join("") : `<div class="moves-empty">Make a move on the board, or paste a PGN in the Import tab.</div>`;
    const curEl = this.el.querySelector(".mv.cur");
    if (curEl) scrollWithin(this.el, curEl);
  }
}

// ---------- eval bar ----------
export class EvalBar {
  constructor(el) { this.el = el; this.fill = $(".evalbar-fill", el); this.num = $(".evalbar-num", el); }
  show(on) { this.el.hidden = !on; }
  set(fractionWhite, label, orientation = "w") {
    const f = Math.max(0.02, Math.min(0.98, fractionWhite));
    this.el.classList.toggle("flipped", orientation === "b");
    this.fill.style.transform = `scaleY(${f.toFixed(3)})`;
    this.num.textContent = label || "";
    // the number sits on the side that's ahead
    const whiteAhead = fractionWhite >= 0.5;
    const atBottom = (orientation === "w") === whiteAhead;
    this.num.classList.toggle("top", !atBottom);
    this.num.style.color = whiteAhead ? "#2a2420" : "#f1eadf";
  }
}

// ---------- eval graph (SVG, white win% per ply) ----------
export function evalGraph(values, cur, onPick, marks = {}) {
  const W = 300, H = 80;
  const n = Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [(i / n) * W, H - (v / 100) * H]);
  const area = `M0,${H} ` + pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + ` L${W},${H} Z`;
  const dots = Object.entries(marks).map(([i, cls]) => {
    const p = pts[Number(i)];
    return p ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="${CLS_HEX[cls]}" stroke="#1d1712" stroke-width="1"/>` : "";
  }).join("");
  const cx = cur >= 0 && pts[cur] ? pts[cur][0] : -10;
  const svgEl = h("div", {
    html: `<svg class="graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evaluation graph">
      <path d="${area}" fill="#f1eadf"/>
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="rgba(120,110,100,.6)" stroke-width="1" stroke-dasharray="3 3"/>
      <line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="var(--accent)" stroke-width="2"/>
      ${dots}
    </svg>`,
  });
  svgEl.firstChild.addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * n);
    onPick(Math.max(0, Math.min(values.length - 1, i)));
  });
  return svgEl;
}

export function sparkline(hist, color = "var(--accent)") {
  if (!hist || hist.length < 2) return h("div.note", "Play more to see your trend.");
  const vals = hist.map(x => x[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(20, max - min);
  const W = 160, H = 34;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`).join(" ");
  return h("div", { html: `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>` });
}

// ---------- modal ----------
let modalStack = [];
export function openModal({ title, sub, body, closable = true, onClose }) {
  const root = $("#modal-root");
  const back = h("div.modal-back");
  const close = () => {
    back.remove();
    modalStack = modalStack.filter(m => m !== api);
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === "Escape" && closable && modalStack[modalStack.length - 1] === api) close(); };
  const card = h("div.modal", { role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
    title || sub ? h("div.modal-head",
      title ? h("h2", title) : null,
      sub ? h("p", sub) : null,
      closable ? h("button.x", { "aria-label": "Close", onclick: close }, icon("close")) : null) : null,
    h("div.modal-body", body));
  back.appendChild(card);
  if (closable) back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  root.appendChild(back);
  document.addEventListener("keydown", onKey);
  const api = { close, el: card };
  modalStack.push(api);
  setTimeout(() => { const f = card.querySelector(".btn.primary, .btn"); if (f) f.focus({ preventScroll: true }); }, 30);
  return api;
}
export function closeAllModals() { for (const m of [...modalStack]) m.close(); }
export function anyModalOpen() { return modalStack.length > 0; }

export function confirmModal({ title, sub, yes = "Yes", no = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title, sub, onClose: () => { if (!done) resolve(false); },
      body: h("div.btn-row",
        h("button.btn.ghost", { onclick: () => { done = true; m.close(); resolve(false); } }, no),
        h(`button.btn.${danger ? "danger" : "primary"}`, { onclick: () => { done = true; m.close(); resolve(true); } }, yes)),
    });
  });
}

export function promotionModal(color) {
  return new Promise((resolve) => {
    let done = false;
    const names = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
    const m = openModal({
      title: "Promote to", onClose: () => { if (!done) resolve(null); },
      body: h("div.promo-row", ["q", "r", "b", "n"].map(t =>
        h("button", { onclick: () => { done = true; m.close(); resolve(t); }, "aria-label": names[t] },
          GLYPH[color][t] + TEXT, h("small", names[t])))),
    });
  });
}

// ---------- toast ----------
export function toast(msg, { ms = 2600, kind = "" } = {}) {
  const t = h(`div.toast${kind ? "." + kind : ""}`);
  if (msg instanceof Node) t.appendChild(msg); else t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 320); }, ms);
}

// ---------- form bits ----------
export function switchRow(label, sub, value, onChange) {
  const btn = h("button.switch", { role: "switch", "aria-checked": String(!!value) },
    h("span", h("span", label), sub ? h("small", sub) : null), h("span.knob"));
  btn.addEventListener("click", () => {
    const v = btn.getAttribute("aria-checked") !== "true";
    btn.setAttribute("aria-checked", String(v));
    onChange(v);
  });
  return btn;
}

export function segmented(options, value, onChange) {
  const el = h("div.seg", { role: "radiogroup" });
  for (const o of options) {
    const b = h("button", { role: "radio", "aria-checked": String(o.value === value), class: o.value === value ? "on" : "" }, o.label);
    b.addEventListener("click", () => {
      el.querySelectorAll("button").forEach(x => { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); });
      b.classList.add("on"); b.setAttribute("aria-checked", "true");
      onChange(o.value);
    });
    el.appendChild(b);
  }
  return el;
}

// ---------- time controls ----------
export const TIME_CONTROLS = [
  { group: "Bullet", icon: "bolt", items: ["1+0", "1+1", "2+1"] },
  { group: "Blitz", icon: "fire", items: ["3+0", "3+2", "5+0"] },
  { group: "Rapid", icon: "clock", items: ["10+0", "15+10", "30+0"] },
];
// the live room server only knows these
export const ONLINE_TIME_CONTROLS = [
  { group: "Bullet", icon: "bolt", items: ["1+0"] },
  { group: "Blitz", icon: "fire", items: ["3+2", "5+0"] },
  { group: "Rapid", icon: "clock", items: ["10+0", "15+10"] },
];
export function tcLabel(key) {
  if (!key || key === "inf") return "Unlimited";
  const [m, inc] = key.split("+").map(Number);
  const mins = m >= 1 ? `${m} min` : `${Math.round(m * 60)} sec`;
  return inc ? `${m} | ${inc}` : mins;
}
export function parseTc(key) {
  if (!key || key === "inf") return null;
  const [m, inc] = key.split("+").map(Number);
  if (!(m > 0) || !(inc >= 0)) return null;
  return { initial: m * 60 * 1000, inc: inc * 1000 };
}

export function tcPicker(value, onChange, { allowUnlimited = true, allowCustom = true, groups = TIME_CONTROLS } = {}) {
  const wrap = h("div.tc-picker");
  const render = () => {
    wrap.innerHTML = "";
    for (const g of groups) {
      const grid = h("div.tc-grid");
      for (const k of g.items) {
        grid.appendChild(h(`button${k === value ? ".on" : ""}`, { onclick: () => { value = k; onChange(k); render(); } }, tcLabel(k)));
      }
      wrap.appendChild(h("div.tc-group", h("div.lbl", icon(g.icon, 16), g.group), grid));
    }
    const extra = h("div.tc-grid");
    if (allowUnlimited) extra.appendChild(h(`button${value === "inf" ? ".on" : ""}`, { onclick: () => { value = "inf"; onChange("inf"); render(); } }, "Unlimited"));
    if (allowCustom) {
      const isCustom = value !== "inf" && !groups.some(g => g.items.includes(value));
      extra.appendChild(h(`button${isCustom ? ".on" : ""}`, {
        onclick: () => {
          const m = openModal({
            title: "Custom time",
            body: (() => {
              const mins = h("input.input", { type: "number", min: "0.5", max: "180", step: "0.5", value: "7" });
              const inc = h("input.input", { type: "number", min: "0", max: "60", step: "1", value: "2" });
              return [
                h("div.two-col", h("div.field", h("label", "Minutes"), mins), h("div.field", h("label", "Increment (sec)"), inc)),
                h("button.btn.primary", {
                  onclick: () => {
                    // half-minute steps: the room server accepts "7+2" or "0.5+0", not "7.25+2"
                    const mm = Math.max(0.5, Math.min(180, Math.round((Number(mins.value) || 5) * 2) / 2));
                    const ii = Math.max(0, Math.min(60, Math.round(Number(inc.value) || 0)));
                    value = `${mm}+${ii}`; onChange(value); render(); m.close();
                  },
                }, "Use this time"),
              ];
            })(),
          });
        },
      }, isCustom ? tcLabel(value) : "Custom"));
    }
    wrap.appendChild(h("div.tc-group", h("div.lbl", icon("plus", 16), "More"), extra));
  };
  render();
  return wrap;
}

// Type a move (SAN like "Nf3" or UCI like "g1f3") and press Enter.
export function moveEntry(getChess, onMove) {
  const input = h("input.input.move-entry", { placeholder: "Type a move, e.g. Nf3", "aria-label": "Type a move", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const c = getChess();
    const text = input.value.trim();
    if (!c || !text) return;
    let mv = null;
    try {
      const probe = new c.constructor(c.fen());
      mv = /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(text)
        ? probe.move({ from: text.slice(0, 2).toLowerCase(), to: text.slice(2, 4).toLowerCase(), promotion: text[4] ? text[4].toLowerCase() : undefined })
        : probe.move(text.replace(/0/g, "O"));
    } catch { mv = null; }
    if (!mv) { input.classList.add("bad"); setTimeout(() => input.classList.remove("bad"), 500); return; }
    input.value = "";
    onMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
  });
  return input;
}

// ---------- screen-reader announcements ----------
const PIECE_WORD = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" };
export function sanToWords(san) {
  if (!san) return "";
  let s = san, tail = "";
  if (s.endsWith("#")) { tail = ", checkmate"; s = s.slice(0, -1); }
  else if (s.endsWith("+")) { tail = ", check"; s = s.slice(0, -1); }
  if (s.startsWith("O-O-O")) return "castles queenside" + tail;
  if (s.startsWith("O-O")) return "castles kingside" + tail;
  let promo = "";
  const pm = /=([QRBN])$/.exec(s);
  if (pm) { promo = ", promotes to " + PIECE_WORD[pm[1]]; s = s.slice(0, -2); }
  const piece = PIECE_WORD[s[0]] ? PIECE_WORD[s[0]] : "pawn";
  if (PIECE_WORD[s[0]]) s = s.slice(1);
  const to = s.slice(-2);
  const capture = s.includes("x");
  const from = s.slice(0, -2).replace("x", "");
  const subject = piece === "pawn" ? (from ? `${from} pawn` : "pawn") : (from ? `${piece} ${from}` : piece);
  return `${subject} ${capture ? "takes" : "to"} ${to}${promo}${tail}`;
}
let announceTimer = null;
export function announce(text) {
  const el = document.getElementById("sr-live");
  if (!el || !text) return;
  el.textContent = "";
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = text; }, 40);
}
export function announceMove(mv) {
  if (!mv || !mv.san) return;
  announce(`${mv.color === "w" ? "White" : "Black"}: ${sanToWords(mv.san)}`);
}
