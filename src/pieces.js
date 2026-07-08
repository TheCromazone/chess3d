// Procedural Staunton chess set — surfaces of revolution (lathe) + shaped knight head.
// Board square = 1 unit. Budget: <=3500 tris per piece type (48 radial segments).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const RADIAL = 36;

// mergeGeometries requires uniform indexing AND identical attribute sets —
// normalize to non-indexed and keep only position/normal/uv.
export function mergeParts(geoms, tag = "") {
  const norm = geoms.map(g => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.attributes.normal) n.computeVertexNormals();
    for (const key of Object.keys(n.attributes)) {
      if (key !== "position" && key !== "normal" && key !== "uv") n.deleteAttribute(key);
    }
    return n;
  });
  const merged = mergeGeometries(norm);
  if (!merged) console.error("mergeParts FAILED", tag, norm.map(g => Object.keys(g.attributes).join("+") + (g.index ? "/idx" : "/noidx")));
  return merged;
}

// Smooth a control-point profile with Catmull-Rom so pieces read as lathe-turned.
function profile(pts, samples) {
  const v3 = pts.map(([r, y]) => new THREE.Vector3(r, y, 0));
  const curve = new THREE.CatmullRomCurve3(v3, false, "catmullrom", 0.1);
  const out = curve.getPoints(samples).map(p => new THREE.Vector2(Math.max(0, p.x), p.y));
  out[0] = new THREE.Vector2(Math.max(0, pts[0][0]), pts[0][1]);
  out[out.length - 1] = new THREE.Vector2(Math.max(0, pts[pts.length - 1][0]), pts[pts.length - 1][1]);
  return out;
}

function lathe(pts, samples = 36) {
  const g = new THREE.LatheGeometry(profile(pts, samples), RADIAL);
  g.computeVertexNormals();
  return g;
}

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function pawn() {
  return lathe([
    [0, 0], [0.30, 0], [0.31, 0.03], [0.28, 0.06], [0.22, 0.09], [0.15, 0.18],
    [0.11, 0.30], [0.10, 0.42], [0.13, 0.465], [0.17, 0.49], [0.10, 0.525], [0.09, 0.55],
    [0.15, 0.59], [0.17, 0.65], [0.14, 0.72], [0.07, 0.77], [0, 0.78],
  ]);
}

function rook() {
  const body = lathe([
    [0, 0], [0.33, 0], [0.34, 0.04], [0.30, 0.08], [0.24, 0.13], [0.20, 0.22],
    [0.18, 0.42], [0.17, 0.58], [0.20, 0.64], [0.25, 0.68], [0.26, 0.76], [0.26, 0.84],
    [0.19, 0.84], [0.18, 0.79], [0, 0.79],
  ]);
  const merlons = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    merlons.push(box(0.115, 0.11, 0.10, Math.cos(a) * 0.195, 0.885, Math.sin(a) * 0.195, -a));
  }
  return mergeParts([body, ...merlons]);
}

function bishop() {
  return lathe([
    [0, 0], [0.31, 0], [0.32, 0.03], [0.29, 0.07], [0.22, 0.11], [0.15, 0.22],
    [0.11, 0.38], [0.10, 0.52], [0.14, 0.565], [0.18, 0.595], [0.11, 0.635], [0.10, 0.66],
    [0.16, 0.71], [0.18, 0.78], [0.15, 0.87], [0.09, 0.95], [0.045, 0.99],
    [0.065, 1.02], [0.045, 1.06], [0, 1.09],
  ]);
}

function queen() {
  return lathe([
    [0, 0], [0.35, 0], [0.36, 0.04], [0.32, 0.08], [0.24, 0.13], [0.16, 0.28],
    [0.12, 0.50], [0.105, 0.68], [0.14, 0.735], [0.19, 0.775], [0.12, 0.82], [0.11, 0.85],
    [0.20, 0.95], [0.24, 1.03], [0.25, 1.08], [0.18, 1.10], [0.12, 1.09],
    [0.09, 1.12], [0.10, 1.17], [0.07, 1.22], [0, 1.25],
  ]);
}

function king() {
  const body = lathe([
    [0, 0], [0.36, 0], [0.37, 0.04], [0.33, 0.08], [0.25, 0.14], [0.17, 0.30],
    [0.13, 0.55], [0.11, 0.74], [0.15, 0.795], [0.20, 0.835], [0.13, 0.875], [0.12, 0.91],
    [0.21, 1.02], [0.24, 1.10], [0.22, 1.16], [0.15, 1.20], [0.08, 1.22], [0, 1.23],
  ]);
  const crossV = box(0.055, 0.20, 0.055, 0, 1.325, 0);
  const crossH = box(0.16, 0.055, 0.055, 0, 1.35, 0);
  return mergeParts([body, crossV, crossH]);
}

function knightHeadShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.16, 0.28);
  s.bezierCurveTo(-0.21, 0.42, -0.21, 0.62, -0.16, 0.78);
  s.bezierCurveTo(-0.13, 0.87, -0.09, 0.93, -0.055, 0.965);   // back of crest
  s.lineTo(-0.075, 1.055);                                     // back ear tip
  s.lineTo(-0.015, 0.985);                                     // notch between ears
  s.lineTo(0.045, 1.045);                                      // front ear tip
  s.lineTo(0.065, 0.945);                                      // front of ears
  s.bezierCurveTo(0.11, 0.87, 0.17, 0.80, 0.24, 0.735);        // forehead
  s.bezierCurveTo(0.29, 0.69, 0.315, 0.655, 0.31, 0.615);      // nose
  s.bezierCurveTo(0.30, 0.585, 0.27, 0.575, 0.23, 0.565);      // nose underside
  s.bezierCurveTo(0.17, 0.555, 0.13, 0.545, 0.10, 0.50);       // mouth / jaw
  s.bezierCurveTo(0.065, 0.45, 0.05, 0.41, 0.02, 0.37);        // throat
  s.bezierCurveTo(-0.03, 0.315, -0.09, 0.29, -0.16, 0.28);
  return s;
}

function knight() {
  const base = lathe([
    [0, 0], [0.33, 0], [0.34, 0.04], [0.30, 0.08], [0.24, 0.12],
    [0.205, 0.19], [0.225, 0.25], [0.24, 0.30], [0.15, 0.315], [0, 0.32],
  ], 36);
  const head = new THREE.ExtrudeGeometry(knightHeadShape(), {
    depth: 0.16, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.03,
    bevelSegments: 3, curveSegments: 14,
  });
  head.translate(0, 0, -0.08 - 0.035);  // center the extrusion (incl. bevel) on the axis
  head.scale(1.02, 1.02, 1);
  return mergeParts([base, head]);
}

// -> { p, r, n, b, q, k } BufferGeometries, base sitting on y=0
export function buildPieceGeometries() {
  return { p: pawn(), r: rook(), n: knight(), b: bishop(), q: queen(), k: king() };
}

export const PIECE_HEIGHTS = { p: 0.78, r: 0.95, n: 1.02, b: 1.09, q: 1.25, k: 1.43 };
