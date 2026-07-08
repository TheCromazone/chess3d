// Procedural wood/felt textures — periodic value noise, seamless by construction
// (noise sampled on a torus so left/right and top/bottom edges match exactly).
import * as THREE from "three";

function hash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

// Periodic value noise: lattice indices wrap modulo `period`, so tiling is exact.
function pnoise(x, y, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (ix, iy) => hash(((ix % period) + period) % period, ((iy % period) + period) % period, seed);
  const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
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

function woodTexture(base, streak, seed, grainStrength) {
  const SIZE = 256, P = 8;
  const canvas = makeCanvas(SIZE, (d, size) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * P, v = (y / size) * P;
        // grain: stretched noise along x + fine rings
        const g1 = pnoise(u * 1.2, v * 7, P * 8, seed);
        const g2 = pnoise(u * 3, v * 18, P * 24, seed + 7);
        const rings = 0.5 + 0.5 * Math.sin((v * 3 + g1 * 4) * Math.PI * 2 / P * 3);
        const t = (g1 * 0.55 + g2 * 0.25 + rings * 0.2) * grainStrength;
        const i = (y * size + x) * 4;
        d[i] = Math.min(255, base[0] + (streak[0] - base[0]) * t);
        d[i + 1] = Math.min(255, base[1] + (streak[1] - base[1]) * t);
        d[i + 2] = Math.min(255, base[2] + (streak[2] - base[2]) * t);
        d[i + 3] = 255;
      }
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function feltTexture() {
  const SIZE = 128, P = 16;
  const canvas = makeCanvas(SIZE, (d, size) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = pnoise((x / size) * P * 6, (y / size) * P * 6, P * 6, 99);
        const i = (y * size + x) * 4;
        d[i] = 24 + n * 14; d[i + 1] = 40 + n * 16; d[i + 2] = 32 + n * 12; d[i + 3] = 255;
      }
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildTextures() {
  return {
    walnut: woodTexture([84, 56, 34], [46, 28, 16], 3, 0.9),     // dark squares
    maple: woodTexture([233, 217, 182], [196, 172, 130], 11, 0.7), // light squares
    espresso: woodTexture([56, 36, 22], [30, 18, 10], 5, 0.85),   // frame
    felt: feltTexture(),                                           // table
  };
}
