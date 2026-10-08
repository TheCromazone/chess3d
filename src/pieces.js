// Procedural Staunton chess set: surfaces of revolution (lathe) plus a sculpted knight head.
// Board square = 1 unit. Every piece sits on a thin felt pad (FELT_H), drawn separately by the
// board as one instanced disc, so piece geometry starts at y = FELT_H.
// Budget: <= ~3,500 triangles per piece type (adaptive profile sampling keeps curves smooth
// with far fewer rings than uniform sampling).
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const RADIAL = 40;
export const FELT_H = 0.012;

// mergeGeometries requires uniform indexing AND identical attribute sets —
// normalize to non-indexed and keep only position/normal/uv.
export function mergeParts(geoms, tag = "") {
  const norm = geoms.map(g => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.attributes.normal) n.computeVertexNormals();
    if (!n.attributes.uv) {
      const pos = n.attributes.position;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) + 0.5; uv[i * 2 + 1] = pos.getY(i); }
      n.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    for (const key of Object.keys(n.attributes)) {
      if (key !== "position" && key !== "normal" && key !== "uv") n.deleteAttribute(key);
    }
    return n;
  });
  const merged = mergeGeometries(norm);
  if (!merged) console.error("mergeParts FAILED", tag, norm.map(g => Object.keys(g.attributes).join("+") + (g.index ? "/idx" : "/noidx")));
  return merged;
}

// Smooth a control-point profile with Catmull-Rom, then keep only the samples where the curve
// actually turns (or a max segment length is exceeded): round beads get many rings, straight
// stems get few.
function profile(pts, maxAngleDeg = 11, maxLen = 0.11) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, "catmullrom", 0.1);
  const dense = curve.getPoints((pts.length - 1) * 24);
  const out = [new THREE.Vector2(Math.max(0, pts[0][0]), pts[0][1])];
  const cosMax = Math.cos(maxAngleDeg * Math.PI / 180);
  let last = dense[0];
  for (let i = 1; i < dense.length - 1; i++) {
    const p = dense[i], n = dense[i + 1];
    const ax = p.x - last.x, ay = p.y - last.y, bx = n.x - p.x, by = n.y - p.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-5 || lb < 1e-6) continue;
    if ((ax * bx + ay * by) / (la * lb) < cosMax || la > maxLen) {
      out.push(new THREE.Vector2(Math.max(0, p.x), p.y));
      last = p;
    }
  }
  const e = pts[pts.length - 1];
  out.push(new THREE.Vector2(Math.max(0, e[0]), e[1]));
  return out;
}

function lathe(pts, radial = RADIAL, maxAngle) {
  return new THREE.LatheGeometry(profile(pts, maxAngle), radial); // analytic smooth normals
}

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function ball(r, x, y, z, ws = 10, hs = 7) {
  const g = new THREE.SphereGeometry(r, ws, hs);
  g.translate(x, y, z);
  return g;
}

// shared turned foot: wide base, cove, bead — every piece starts with a variant of it
function pawn() {
  return lathe([
    [0, 0], [0.30, 0], [0.312, 0.025], [0.30, 0.055], [0.255, 0.08], [0.215, 0.11], [0.16, 0.19],
    [0.12, 0.30], [0.105, 0.41], [0.13, 0.455], [0.175, 0.48], [0.11, 0.515], [0.095, 0.545],
    [0.15, 0.585], [0.172, 0.65], [0.145, 0.72], [0.075, 0.77], [0, 0.78],
  ]);
}

function rook() {
  const body = lathe([
    [0, 0], [0.33, 0], [0.342, 0.03], [0.325, 0.065], [0.275, 0.09], [0.235, 0.13], [0.205, 0.22],
    [0.185, 0.42], [0.178, 0.58], [0.205, 0.635], [0.255, 0.67], [0.268, 0.75], [0.268, 0.84],
    [0.192, 0.84], [0.182, 0.79], [0, 0.79],
  ]);
  const merlons = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 10;
    merlons.push(box(0.118, 0.105, 0.098, Math.cos(a) * 0.212, 0.89, Math.sin(a) * 0.212, -a));
  }
  return mergeParts([body, ...merlons], "rook");
}

function bishop() {
  return lathe([
    [0, 0], [0.31, 0], [0.322, 0.025], [0.305, 0.06], [0.255, 0.085], [0.215, 0.115], [0.155, 0.22],
    [0.115, 0.38], [0.102, 0.52], [0.14, 0.562], [0.185, 0.592], [0.112, 0.632], [0.1, 0.66],
    [0.158, 0.71], [0.182, 0.78], [0.168, 0.85], [0.125, 0.92], [0.07, 0.975], [0.042, 0.995],
    [0.068, 1.022], [0.07, 1.05], [0.045, 1.08], [0, 1.09],
  ]);
}

function queen() {
  const body = lathe([
    [0, 0], [0.35, 0], [0.362, 0.03], [0.345, 0.07], [0.29, 0.095], [0.245, 0.13], [0.165, 0.28],
    [0.122, 0.50], [0.108, 0.68], [0.14, 0.732], [0.19, 0.772], [0.122, 0.818], [0.11, 0.85],
    [0.19, 0.94], [0.235, 1.02], [0.252, 1.075], [0.23, 1.105], [0.16, 1.085], [0.11, 1.09],
    [0.085, 1.13], [0.07, 1.165], [0, 1.17],
  ], RADIAL, 13);
  // coronet: a ring of pearls on the crown rim (reads as a star from above) + finial
  const parts = [body];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(ball(0.036, Math.cos(a) * 0.218, 1.112, Math.sin(a) * 0.218, 7, 5));
  }
  parts.push(ball(0.068, 0, 1.215, 0, 12, 8));
  return mergeParts(parts, "queen");
}

function king() {
  const body = lathe([
    [0, 0], [0.36, 0], [0.372, 0.03], [0.355, 0.07], [0.30, 0.095], [0.25, 0.14], [0.172, 0.30],
    [0.13, 0.55], [0.112, 0.74], [0.15, 0.795], [0.2, 0.835], [0.13, 0.875], [0.12, 0.91],
    [0.205, 1.015], [0.24, 1.095], [0.225, 1.15], [0.16, 1.19], [0.09, 1.215], [0.06, 1.225],
    [0.07, 1.245], [0, 1.25],
  ]);
  const crossV = box(0.064, 0.215, 0.064, 0, 1.345, 0);
  const crossH = box(0.19, 0.064, 0.064, 0, 1.37, 0);
  return mergeParts([body, crossV, crossH], "king");
}

// ---- knight -------------------------------------------------------------------------------
function knightHeadShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.162, 0.2);                                          // buried in the collar
  s.lineTo(-0.17, 0.30);
  s.bezierCurveTo(-0.24, 0.44, -0.228, 0.64, -0.158, 0.79);     // back of the neck (mane line)
  s.bezierCurveTo(-0.125, 0.862, -0.09, 0.912, -0.064, 0.948);   // poll
  s.lineTo(-0.05, 1.062);                                          // ear tip
  s.quadraticCurveTo(-0.005, 1.0, 0.03, 0.962);                   // front of the ear
  s.bezierCurveTo(0.09, 0.93, 0.15, 0.872, 0.205, 0.80);          // forehead
  s.bezierCurveTo(0.255, 0.735, 0.298, 0.682, 0.318, 0.642);      // nose bridge
  s.bezierCurveTo(0.334, 0.61, 0.318, 0.574, 0.282, 0.568);       // muzzle tip / lips
  s.bezierCurveTo(0.236, 0.562, 0.2, 0.578, 0.168, 0.584);        // chin
  s.bezierCurveTo(0.118, 0.592, 0.088, 0.556, 0.074, 0.51);       // round cheek / jaw
  s.bezierCurveTo(0.06, 0.462, 0.062, 0.41, 0.088, 0.372);        // throat
  s.bezierCurveTo(0.112, 0.338, 0.124, 0.316, 0.124, 0.30);       // chest
  s.lineTo(0.118, 0.2);
  s.lineTo(-0.162, 0.2);
  return s;
}

function smooth01(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// head thickness profile: full at the neck, narrower muzzle, thin ears
function knightTaper(x, y) {
  let f = 1 - 0.36 * smooth01(0.02, 0.31, x) * smooth01(0.46, 0.64, y);
  f *= 1 - 0.12 * smooth01(0.93, 1.04, y);
  f *= 1 + 0.08 * (1 - smooth01(0.30, 0.48, y)); // chest swells into the collar
  return f;
}

function smoothExtrude(shape, opts, taper) {
  let g = new THREE.ExtrudeGeometry(shape, opts);
  g.translate(0, 0, -(opts.depth / 2));
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g, 1e-4);
  const pos = g.attributes.position;
  if (taper) for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) * taper(pos.getX(i), pos.getY(i)));
  g.computeVertexNormals();
  return g;
}

// Bowyer-Watson Delaunay triangulation of 2D points -> [[a, b, c], ...]. O(n^2); run once at init.
function delaunay(pts) {
  const n = pts.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const d = Math.max(maxX - minX, maxY - minY) * 20, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = pts.map((p) => ({ x: p.x, y: p.y }));
  P.push({ x: mx - d, y: my - d }, { x: mx + d, y: my - d }, { x: mx, y: my + d });
  const circ = (a, b, c) => {
    const A = P[a], B = P[b], C = P[c];
    const D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y;
    const ux = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / D;
    const uy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / D;
    return { a, b, c, x: ux, y: uy, r2: (A.x - ux) ** 2 + (A.y - uy) ** 2 };
  };
  let tris = [circ(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const keep = [], edges = new Map();
    for (const t of tris) {
      if ((p.x - t.x) ** 2 + (p.y - t.y) ** 2 < t.r2) {
        for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
          const k = u < v ? u * 100000 + v : v * 100000 + u;
          const e = edges.get(k);
          if (e) e.n++; else edges.set(k, { u, v, n: 1 });
        }
      } else keep.push(t);
    }
    for (const e of edges.values()) if (e.n === 1) keep.push(circ(e.u, e.v, i));
    tris = keep;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

// "Inflated" silhouette: the 2D outline plus interior points is Delaunay-triangulated and each
// side is pushed out by a rounded cross-section (circular rim of radius R near the edge, plus a
// gentle dome where the shape is wide), so the head has sculpted volume instead of flat sides.
function inflate(shape, H, R, dome, taper) {
  let outline = shape.getSpacedPoints(120);
  if (outline[0].distanceTo(outline[outline.length - 1]) < 1e-6) outline.pop();
  if (THREE.ShapeUtils.isClockWise(outline)) outline = outline.reverse();
  const N = outline.length;
  const dist = (x, y) => {
    let m = Infinity;
    for (let i = 0; i < N; i++) {
      const a = outline[i], b = outline[(i + 1) % N];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const ex = a.x + dx * t - x, ey = a.y + dy * t - y;
      m = Math.min(m, ex * ex + ey * ey);
    }
    return Math.sqrt(m);
  };
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = N - 1; i < N; j = i++) {
      const a = outline[i], b = outline[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const inner = [];
  const tryAdd = (x, y, minD, spacing) => {
    if (!inside(x, y) || dist(x, y) < minD) return;
    for (const q of inner) if ((q.x - x) ** 2 + (q.y - y) ** 2 < spacing * spacing) return;
    inner.push(new THREE.Vector2(x, y));
  };
  // inner rings that follow the outline (they resolve the rounded rim), then a hex grid
  for (const off of [R * 0.3, R * 0.7]) {
    for (let i = 0; i < N; i++) {
      const a = outline[(i + N - 1) % N], b = outline[(i + 1) % N], p = outline[i];
      const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
      tryAdd(p.x - (ty / l) * off, p.y + (tx / l) * off, off * 0.8, 0.017);
    }
  }
  const step = 0.032;
  const box = new THREE.Box2().setFromPoints(outline);
  for (let y = box.min.y, row = 0; y <= box.max.y; y += step * 0.866, row++) {
    for (let x = box.min.x + (row % 2 ? step / 2 : 0); x <= box.max.x; x += step) tryAdd(x, y, R * 0.95, step * 0.8);
  }
  const all = [...outline, ...inner];
  const M = inner.length;
  // keep triangles inside the shape (centroid and non-boundary edge midpoints inside)
  const isRim = (u, v) => u < N && v < N && (Math.abs(u - v) === 1 || Math.abs(u - v) === N - 1);
  const faces = delaunay(all).filter(([a, b, c]) => {
    const A = all[a], B = all[b], C = all[c];
    if (!inside((A.x + B.x + C.x) / 3, (A.y + B.y + C.y) / 3)) return false;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (isRim(u, v)) continue;
      if (!inside((all[u].x + all[v].x) / 2, (all[u].y + all[v].y) / 2)) return false;
    }
    return true;
  });
  const height = (p) => {
    const d = dist(p.x, p.y);
    const t = Math.min(1, d / R);
    const h = H * Math.sqrt(1 - (1 - t) * (1 - t)) + dome * Math.min(1, Math.max(0, (d - R) / 0.12));
    return h * (taper ? taper(p.x, p.y) : 1);
  };
  // vertex layout: outline (shared rim, z = 0) | front interior | back interior
  const pos = new Float32Array((N + 2 * M) * 3);
  for (let i = 0; i < N; i++) pos.set([outline[i].x, outline[i].y, 0], i * 3);
  for (let i = 0; i < M; i++) {
    const p = inner[i], h = height(p);
    pos.set([p.x, p.y, h], (N + i) * 3);
    pos.set([p.x, p.y, -h], (N + M + i) * 3);
  }
  const back = (k) => (k < N ? k : k + M);
  const idx = [];
  for (const [a, b, c] of faces) {
    const A = all[a], B = all[b], C = all[c];
    const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
    if (ccw) { idx.push(a, b, c, back(a), back(c), back(b)); }
    else { idx.push(a, c, b, back(a), back(b), back(c)); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function knight() {
  const base = lathe([
    [0, 0], [0.33, 0], [0.342, 0.03], [0.325, 0.065], [0.275, 0.09], [0.235, 0.125],
    [0.212, 0.19], [0.228, 0.25], [0.245, 0.29], [0.2, 0.315], [0, 0.32],
  ], 36);

  const head = inflate(knightHeadShape(), 0.118, 0.075, 0.022, knightTaper);

  // mane: a narrow ridge that follows the back of the neck
  const back = new THREE.CubicBezierCurve(
    new THREE.Vector2(-0.17, 0.33), new THREE.Vector2(-0.24, 0.46),
    new THREE.Vector2(-0.228, 0.64), new THREE.Vector2(-0.158, 0.79));
  const back2 = new THREE.CubicBezierCurve(
    new THREE.Vector2(-0.158, 0.79), new THREE.Vector2(-0.125, 0.862),
    new THREE.Vector2(-0.09, 0.912), new THREE.Vector2(-0.07, 0.94));
  const spine = [...back.getPoints(10), ...back2.getPoints(5).slice(1)];
  const outer = [], inner = [];
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)], b = spine[Math.min(spine.length - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
    const nx = ty / l, ny = -tx / l; // outward (left of travel = away from the head)
    const w = 0.02 * Math.sin(Math.PI * Math.min(1, (i + 0.6) / (spine.length - 0.4)));
    outer.push(new THREE.Vector2(spine[i].x - nx * (w + 0.004), spine[i].y - ny * (w + 0.004)));
    inner.push(new THREE.Vector2(spine[i].x + nx * 0.03, spine[i].y + ny * 0.03));
  }
  const maneShape = new THREE.Shape([...outer, ...inner.reverse()]);
  const mane = smoothExtrude(maneShape, {
    depth: 0.03, bevelEnabled: true, bevelThickness: 0.016, bevelSize: 0.01,
    bevelSegments: 2, curveSegments: 4,
  });

  const eyeZ = 0.1;
  const eyes = [ball(0.021, 0.13, 0.80, eyeZ, 8, 6), ball(0.021, 0.13, 0.80, -eyeZ, 8, 6)];
  const nostrils = [ball(0.014, 0.302, 0.618, 0.044, 6, 4), ball(0.014, 0.302, 0.618, -0.044, 6, 4)];

  return mergeParts([base, head, mane, ...eyes, ...nostrils], "knight");
}

// -> { p, r, n, b, q, k } BufferGeometries, base resting on y = FELT_H (felt pad below)
export function buildPieceGeometries() {
  const g = { p: pawn(), r: rook(), n: knight(), b: bishop(), q: queen(), k: king() };
  for (const k in g) { g[k].translate(0, FELT_H, 0); g[k].computeBoundingSphere(); }
  return g;
}

// unit felt disc (radius 1, height FELT_H, bottom at y = 0); scaled per piece by BASE_RADII
export function buildFeltGeometry() {
  const g = new THREE.CylinderGeometry(1, 1, FELT_H, 32, 1, false);
  g.translate(0, FELT_H / 2, 0);
  return g;
}

export const PIECE_HEIGHTS = { p: 0.79, r: 0.955, n: 1.075, b: 1.10, q: 1.295, k: 1.45 };
export const BASE_RADII = { p: 0.30, r: 0.33, n: 0.33, b: 0.31, q: 0.35, k: 0.36 };
// picking proxies: a body cylinder radius per type (the wide foot is tested separately)
export const BODY_RADII = { p: 0.17, r: 0.25, n: 0.23, b: 0.18, q: 0.22, k: 0.22 };
