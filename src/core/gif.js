// Animated GIF / PNG export of a game, drawn as a flat 2D board (like chess.com's "Download GIF").
// Self-contained: a 6×7×6 colour cube palette and a standard GIF LZW encoder.
import { createChess } from "./chess960.js";

const LIGHT = "#ebecd0", DARK = "#739552", HL = "rgba(255,255,51,.5)";

function loadImg(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

async function pieceImages(set = "cburnett") {
  const out = {};
  await Promise.all(["w", "b"].flatMap(c => ["K", "Q", "R", "B", "N", "P"].map(async t => {
    out[c + t.toLowerCase()] = await loadImg(`./assets/pieces/${set}/${c}${t}.svg`);
  })));
  return out;
}

function drawBoard(ctx, size, fen, imgs, { flip = false, last = null, coords = true } = {}) {
  const sq = size / 8;
  const board = createChess(fen).board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const rr = flip ? 7 - r : r, ff = flip ? 7 - f : f;
    const x = f * sq, y = r * sq;
    ctx.fillStyle = (rr + ff) % 2 === 0 ? LIGHT : DARK;
    ctx.fillRect(x, y, sq, sq);
    const name = "abcdefgh"[ff] + (8 - rr);
    if (last && (last.from === name || last.to === name)) { ctx.fillStyle = HL; ctx.fillRect(x, y, sq, sq); }
    const p = board[rr][ff];
    if (p) ctx.drawImage(imgs[p.color + p.type], x, y, sq, sq);
    if (coords) {
      ctx.font = `600 ${Math.round(sq * 0.2)}px system-ui, sans-serif`;
      ctx.fillStyle = (rr + ff) % 2 === 0 ? DARK : LIGHT;
      if (f === 0) { ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(String(8 - rr), x + 3, y + 2); }
      if (r === 7) { ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText("abcdefgh"[ff], x + sq - 3, y + sq - 2); }
    }
  }
}

export async function positionPng(fen, { flip = false, last = null, size = 640 } = {}) {
  const imgs = await pieceImages();
  const c = document.createElement("canvas");
  c.width = c.height = size;
  drawBoard(c.getContext("2d"), size, fen, imgs, { flip, last });
  return new Promise((res) => c.toBlob(res, "image/png"));
}

// plies: [{ fenAfter, uci }], startFen
export async function gameGif(startFen, plies, { flip = false, size = 360, delayCs = 90 } = {}) {
  const imgs = await pieceImages();
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const frames = [];
  const grab = (fen, last, delay) => {
    drawBoard(ctx, size, fen, imgs, { flip, last });
    frames.push({ data: ctx.getImageData(0, 0, size, size).data, delay });
  };
  grab(startFen, null, delayCs);
  plies.forEach((p, i) => grab(p.fenAfter, { from: p.uci.slice(0, 2), to: p.uci.slice(2, 4) }, i === plies.length - 1 ? 400 : delayCs));
  return new Blob([encodeGif(size, size, frames)], { type: "image/gif" });
}

// ---------- encoder ----------
// 252-colour cube plus exact board colours (light, dark, and both with the last-move tint)
const EXACT = [[235, 236, 208], [115, 149, 82], [245, 246, 130], [185, 202, 67]];
const PAL = (() => {
  const p = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) p.push([Math.round(r * 51), Math.round(g * 42.5), Math.round(b * 51)]);
  p.push(...EXACT);
  return p;
})();

function indexPixels(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2];
    let idx = -1;
    for (let e = 0; e < EXACT.length; e++) {
      const c = EXACT[e];
      if (Math.abs(c[0] - R) <= 3 && Math.abs(c[1] - G) <= 3 && Math.abs(c[2] - B) <= 3) { idx = 252 + e; break; }
    }
    out[i] = idx >= 0 ? idx : Math.round(R / 51) * 42 + Math.round(G / 42.5) * 6 + Math.round(B / 51);
  }
  return out;
}

export function encodeGif(w, h, frames) {
  const bytes = [];
  const put = (...b) => { for (const x of b) bytes.push(x & 255); };
  const word = (v) => put(v & 255, (v >> 8) & 255);
  for (const ch of "GIF89a") put(ch.charCodeAt(0));
  word(w); word(h);
  put(0xf7, 0, 0);                       // global colour table, 256 entries
  for (const [r, g, b] of PAL) put(r, g, b);
  put(0x21, 0xff, 11); for (const ch of "NETSCAPE2.0") put(ch.charCodeAt(0)); put(3, 1, 0, 0, 0); // loop forever
  for (const f of frames) {
    put(0x21, 0xf9, 4, 0, f.delay & 255, (f.delay >> 8) & 255, 0, 0);
    put(0x2c); word(0); word(0); word(w); word(h); put(0);
    const data = lzw(indexPixels(f.data), 8);
    put(8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.subarray(i, i + 255);
      put(chunk.length);
      for (const b of chunk) bytes.push(b);
    }
    put(0);
  }
  put(0x3b);
  return new Uint8Array(bytes);
}

function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  const out = [];
  let cur = 0, bits = 0, size = minCode + 1;
  const emit = (code) => {
    cur |= code << bits; bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; }
  };
  let dict = new Map();
  let next = eoi + 1;
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map(); next = eoi + 1; size = minCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}
