// Procedural textures: periodic value noise, seamless by construction (lattice indices wrap, so
// left/right and top/bottom edges match exactly). Everything is generated lazily and cached by
// TextureBank, so a theme's textures cost nothing until that theme is picked.
import * as THREE from "three";

function hash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

// periodic value noise with independent periods on x and y
function pnoise(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const ax = ((x0 % px) + px) % px, ay = ((y0 % py) + py) % py;
  const bx = (ax + 1) % px, by = (ay + 1) % py;
  const a = hash(ax, ay, seed), b = hash(bx, ay, seed), c = hash(ax, by, seed), d = hash(bx, by, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// fractal noise over u,v in [0,1); fx/fy are integer base frequencies (keeps it periodic)
function fbm(u, v, fx, fy, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const kx = fx << o, ky = fy << o;
    sum += amp * pnoise(u * kx, v * ky, kx, ky, seed + o * 31);
    norm += amp; amp *= 0.5;
  }
  return sum / norm;
}

function makeCanvas(size, fill) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  fill(img.data, size);
  g.putImageData(img, 0, 0);
  return c;
}

function toTexture(canvas, { srgb = true, aniso = 4 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// --- wood (board squares / frames) --------------------------------------------------------
function woodTexture(base, streak, seed, grainStrength, size = 256) {
  const [b0, b1, b2] = hex(base), [s0, s1, s2] = hex(streak);
  return toTexture(makeCanvas(size, (d, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        const g1 = fbm(u, v, 2, 16, 3, seed);
        const g2 = fbm(u, v, 6, 48, 2, seed + 7);
        const rings = 0.5 + 0.5 * Math.sin((v * 6 + g1 * 2.5) * Math.PI * 2);
        const t = Math.min(1, (g1 * 0.5 + g2 * 0.3 + rings * 0.25) * grainStrength);
        const i = (y * n + x) * 4;
        d[i] = b0 + (s0 - b0) * t; d[i + 1] = b1 + (s1 - b1) * t; d[i + 2] = b2 + (s2 - b2) * t; d[i + 3] = 255;
      }
    }
  }));
}

// --- near-white mottling, multiplied by a material colour (painted / vinyl squares) ------
function grainTexture(seed, amount = 0.06, size = 256) {
  return toTexture(makeCanvas(size, (d, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        const m = fbm(u, v, 8, 8, 3, seed);
        const fine = hash(x, y, seed + 3);
        const val = 255 * (1 - amount + amount * (0.75 * m + 0.25 * fine));
        const i = (y * n + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255;
      }
    }
  }));
}

// --- wood grain for painted wood (multiplied by a colour) --------------------------------
function woodGrainTexture(seed, amount = 0.22, size = 256) {
  return toTexture(makeCanvas(size, (d, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        const g1 = fbm(u, v, 2, 24, 3, seed);
        const rings = 0.5 + 0.5 * Math.sin((v * 10 + g1 * 3) * Math.PI * 2);
        const t = g1 * 0.6 + rings * 0.4;
        const val = 255 * (1 - amount * t);
        const i = (y * n + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255;
      }
    }
  }));
}

// --- piece grain: streaks run along v (lathe profile direction = up the piece) ------------
function pieceGrainTexture(seed, amount, size = 256) {
  return toTexture(makeCanvas(size, (d, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        const g = fbm(u, v, 24, 2, 3, seed);
        const s = 0.5 + 0.5 * Math.sin((u * 40 + g * 4) * Math.PI * 2);
        const t = g * 0.55 + s * s * 0.45;
        const val = 255 * (1 - amount * t);
        const i = (y * n + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255;
      }
    }
  }));
}

// --- marble: domain-warped turbulent veins + cloudy body, periodic ------------------------
const MARBLE = {
  carrara: { base: "#ecebe7", cloud: "#d6d5d1", vein: "#8a8e92", vein2: "#b4b6b9", seed: 11, sharp: 9, veinAmt: 0.7 },
  verde: { base: "#5b7a6c", cloud: "#45604f", vein: "#d4e0d8", vein2: "#2d4236", seed: 23, sharp: 11, veinAmt: 0.55 },
  nero: { base: "#2a2b2e", cloud: "#1b1c1f", vein: "#b5b7ba", vein2: "#4b4d52", seed: 37, sharp: 12, veinAmt: 0.6 },
  ivory: { base: "#f3efe6", cloud: "#e2dccf", vein: "#a59f94", vein2: "#cfc8bb", seed: 5, sharp: 9, veinAmt: 0.5 },
  onyx: { base: "#2a2c31", cloud: "#18191c", vein: "#9196a0", vein2: "#3c3f46", seed: 41, sharp: 10, veinAmt: 0.55 },
};

function marbleTexture(spec, size = 512) {
  const B = hex(spec.base), C = hex(spec.cloud), V = hex(spec.vein), V2 = hex(spec.vein2);
  const { seed, sharp, veinAmt } = spec;
  return toTexture(makeCanvas(size, (d, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n;
        const w1 = fbm(u, v, 2, 2, 4, seed + 1), w2 = fbm(u, v, 2, 2, 4, seed + 2);
        const t = fbm(u + 0.5 * w1, v + 0.5 * w2, 2, 2, 5, seed);
        const t2 = fbm(u - 0.4 * w2, v + 0.4 * w1, 4, 4, 4, seed + 9);
        const main = Math.pow(1 - Math.abs(Math.sin((u + v) * Math.PI * 2 + t * 16)), sharp);
        const fine = Math.pow(1 - Math.abs(Math.sin((u * 2 - v) * Math.PI * 2 + t2 * 20)), sharp * 3);
        const cl = Math.min(1, Math.max(0, (fbm(u, v, 3, 3, 4, seed + 5) - 0.3) * 2));
        let r = B[0] + (C[0] - B[0]) * cl, g = B[1] + (C[1] - B[1]) * cl, b = B[2] + (C[2] - B[2]) * cl;
        const m1 = main * veinAmt * (0.55 + 0.45 * w2), m2 = fine * 0.22;
        r += (V[0] - r) * m1; g += (V[1] - g) * m1; b += (V[2] - b) * m1;
        r += (V2[0] - r) * m2; g += (V2[1] - g) * m2; b += (V2[2] - b) * m2;
        const i = (y * n + x) * 4;
        d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b); d[i + 3] = 255;
      }
    }
  }), { aniso: 8 });
}

// --- felt / baize (near-white, tinted by the table material colour) ----------------------
function feltTexture() {
  return toTexture(makeCanvas(128, (d, n) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const m = fbm(x / n, y / n, 16, 16, 2, 99);
        const val = 255 * (0.78 + 0.22 * (0.7 * m + 0.3 * hash(x, y, 7)));
        const i = (y * n + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255;
      }
    }
  }), { aniso: 1 });
}

const WOOD = {
  walnut: ["#543822", "#2e1c10", 3, 0.9],
  maple: ["#e9d9b6", "#c4ac82", 11, 0.7],
  espresso: ["#382416", "#1e120a", 5, 0.85],
};

const PHOTO_FALLBACK = { walnut: "wood:walnut", maple: "wood:maple", espresso: "wood:espresso" };

// Cache of textures by spec string:
//   "photo:<name>"  public/assets/<name>.jpg (procedural wood fallback until loaded)
//   "wood:<name>" | "marble:<name>" | "grain:<seed>" | "woodgrain:<seed>" | "piecegrain:<light|dark>" | "felt"
export class TextureBank {
  constructor(assetBase = "./assets/") {
    this.assetBase = assetBase;
    this.cache = new Map();
    this.loading = new Map(); // photo spec -> callbacks waiting for it
    this.loader = new THREE.TextureLoader();
  }

  // Returns a texture now. For photos still loading, returns the fallback and calls onLoad(tex) later.
  get(spec, onLoad) {
    const hit = this.cache.get(spec);
    if (hit) return hit;
    const [kind, arg] = spec.split(":");
    if (kind === "photo") {
      let waiting = this.loading.get(spec);
      if (!waiting) {
        waiting = [];
        this.loading.set(spec, waiting);
        this.loader.load(`${this.assetBase}${arg}.jpg`, (tex) => {
          tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping; // non-seamless photos tile invisibly
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          this.cache.set(spec, tex);
          const cbs = this.loading.get(spec) || [];
          this.loading.delete(spec);
          for (const cb of cbs) cb(tex);
        }, undefined, () => { this.loading.delete(spec); });
      }
      if (onLoad) waiting.push(onLoad);
      return this.get(PHOTO_FALLBACK[arg] || "grain:1");
    }
    let tex;
    if (kind === "wood") { const w = WOOD[arg] || WOOD.walnut; tex = woodTexture(w[0], w[1], w[2], w[3]); }
    else if (kind === "marble") tex = marbleTexture(MARBLE[arg] || MARBLE.carrara, 256);
    else if (kind === "woodgrain") tex = woodGrainTexture(Number(arg) || 1);
    else if (kind === "piecegrain") tex = arg === "dark" ? pieceGrainTexture(17, 0.35) : pieceGrainTexture(9, 0.09);
    else if (kind === "felt") tex = feltTexture();
    else tex = grainTexture(Number(arg) || 1);
    this.cache.set(spec, tex);
    return tex;
  }

  dispose() {
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
    this.loading.clear();
  }
}
