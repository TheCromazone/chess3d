// 3D scene: board, pieces, highlights, camera, picking, move animation.
// Engine lighting derived from the STYLE FORMULA: warm key light, cool ambient fill,
// emerald move markers, amber last-move tint, red check tint.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildPieceGeometries, mergeParts } from "./pieces.js";
import { buildTextures } from "./textures.js";

const DPR_CAP = 1.75;
const BOARD_TOP = 0.08;
const COLORS = {
  bg: 0x14100d,
  keyLight: 0xfff1e0,
  fillSky: 0xb8c8e0,
  fillGround: 0x3a2c20,
  white: 0xe9dcc3,
  black: 0x35281f,
  emerald: 0x34d27b,
  amber: 0xe8c35a,
  red: 0xe05548,
};

const FILES = "abcdefgh";
export const sqToXZ = (sq) => ({ x: FILES.indexOf(sq[0]) - 3.5, z: 3.5 - (Number(sq[1]) - 1) });
export const xzToSq = (x, z) => {
  const f = Math.round(x + 3.5), r = Math.round(3.5 - z);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return FILES[f] + (r + 1);
};

function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

export class Board3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.tweens = [];
    this.pieces = new Map();     // square -> mesh
    this.pool = { w: {}, b: {} } ; // color -> type -> mesh[]
    this.onSquareTap = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, DPR_CAP));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);
    this.scene.fog = new THREE.Fog(COLORS.bg, 24, 46);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 9, 11);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 27;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.32;
    this.controls.target.set(0, 0, 0);

    this._lights();
    this.tex = buildTextures();
    this._board();
    this._pieceAssets();
    this._markers();
    this._picking();
    this._upgradeTextures();

    addEventListener("resize", () => this._resize());
    addEventListener("orientationchange", () => this._resize());
    this._resize();

    this._dev = new URLSearchParams(location.search).has("dev");
    if (this._dev) {
      this._devEl = document.createElement("div");
      this._devEl.style.cssText = "position:fixed;top:4px;left:4px;color:#0f0;font:12px monospace;z-index:99";
      document.body.appendChild(this._devEl);
      this._frames = 0; this._fpsAt = performance.now();
    }

    this._clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _lights() {
    const hemi = new THREE.HemisphereLight(COLORS.fillSky, COLORS.fillGround, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(COLORS.keyLight, 2.1);
    key.position.set(6, 12, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -6.5;
    key.shadow.camera.right = key.shadow.camera.top = 6.5;
    key.shadow.camera.near = 4; key.shadow.camera.far = 26;
    key.shadow.bias = -0.0015;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8ea8c8, 0.5);
    rim.position.set(-7, 6, -8);
    this.scene.add(rim);
  }

  _board() {
    // 64 squares merged into 2 meshes (one per color); per-square UV offset kills grain repetition
    const dark = [], light = [];
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const g = new THREE.BoxGeometry(1, BOARD_TOP, 1);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, uv.getX(i) * 0.9 + f * 0.37 + r * 0.11, uv.getY(i) * 0.9 + r * 0.29 + f * 0.07);
        }
        g.translate(f - 3.5, BOARD_TOP / 2, 3.5 - r);
        ((f + r) % 2 === 0 ? dark : light).push(g); // a1 (f=0,r=0) is dark
      }
    }
    const mDark = this._matDark = new THREE.MeshStandardMaterial({ map: this.tex.walnut, roughness: 0.42, metalness: 0.05 });
    const mLight = this._matLight = new THREE.MeshStandardMaterial({ map: this.tex.maple, roughness: 0.45, metalness: 0.05 });
    for (const [geoms, mat] of [[dark, mDark], [light, mLight]]) {
      const mesh = new THREE.Mesh(mergeParts(geoms), mat);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }

    // frame ring + slab
    const frameMat = this._matFrame = new THREE.MeshStandardMaterial({ map: this.tex.espresso, roughness: 0.38, metalness: 0.08 });
    const parts = [];
    const W = 9.7, IN = 8.02, H = 0.13, edge = (W - IN) / 2;
    for (const [w, d, x, z] of [
      [W, edge, 0, -(IN + edge) / 2], [W, edge, 0, (IN + edge) / 2],
      [edge, IN, -(IN + edge) / 2, 0], [edge, IN, (IN + edge) / 2, 0],
    ]) {
      const g = new THREE.BoxGeometry(w, H, d);
      g.translate(x, H / 2 - 0.005, z);
      parts.push(g);
    }
    const slab = new THREE.BoxGeometry(W, 0.28, W);
    slab.translate(0, -0.145, 0);
    parts.push(slab);
    const frame = new THREE.Mesh(mergeParts(parts), frameMat);
    frame.receiveShadow = true;
    frame.castShadow = true;
    this.scene.add(frame);

    this._labels(W, IN, H);

    // table
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(11, 11, 0.5, 48),
      new THREE.MeshStandardMaterial({ map: this.tex.felt, roughness: 0.95, metalness: 0 })
    );
    table.material.map.repeat.set(6, 6);
    table.position.y = -0.54;
    table.receiveShadow = true;
    this.scene.add(table);
  }

  _labels(W, IN, H) {
    // one 512x512 atlas, 16 glyphs (a-h, 1-8), quads on the frame — merged, 1 draw call
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = 512;
    const g2 = atlas.getContext("2d");
    g2.fillStyle = "rgba(0,0,0,0)";
    g2.font = "700 84px Georgia, serif";
    g2.textAlign = "center"; g2.textBaseline = "middle";
    g2.fillStyle = "#d9c9a8";
    const glyphs = [..."abcdefgh", ..."12345678"];
    glyphs.forEach((ch, i) => g2.fillText(ch, (i % 4) * 128 + 64, Math.floor(i / 4) * 128 + 64));
    const tex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const quads = [];
    const quad = (glyphIdx, x, z, rot) => {
      const g = new THREE.PlaneGeometry(0.42, 0.42);
      const uv = g.attributes.uv;
      const cx = (glyphIdx % 4) / 4, cy = 1 - (Math.floor(glyphIdx / 4) + 1) / 4;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, cx + uv.getX(i) / 4, cy + uv.getY(i) / 4);
      g.rotateX(-Math.PI / 2);
      if (rot) g.rotateY(rot);
      g.translate(x, H + 0.002, z);
      quads.push(g);
    };
    const off = (IN / 2 + W / 2) / 2; // center of the frame edge
    for (let f = 0; f < 8; f++) {
      quad(f, f - 3.5, off, 0);            // files, white edge
      quad(f, f - 3.5, -off, Math.PI);     // files, black edge
    }
    for (let r = 0; r < 8; r++) {
      quad(8 + r, -off, 3.5 - r, 0);       // ranks, queenside
      quad(8 + r, off, 3.5 - r, Math.PI);  // ranks, kingside
    }
    const mesh = new THREE.Mesh(mergeParts(quads),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.scene.add(mesh);
  }

  // Swap the procedural wood for the photographic textures as they load.
  // MirroredRepeatWrapping makes non-seamless photos tile invisibly, so the
  // per-square UV offsets never expose a wrap seam.
  _upgradeTextures() {
    const loader = new THREE.TextureLoader();
    const upgrade = (file, material) => {
      loader.load(`./assets/${file}`, (tex) => {
        tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        material.map = tex;
        material.needsUpdate = true;
      }, undefined, () => { /* keep procedural fallback */ });
    };
    upgrade("walnut.jpg", this._matDark);
    upgrade("maple.jpg", this._matLight);
    upgrade("espresso.jpg", this._matFrame);
  }

  _pieceAssets() {
    this.geos = buildPieceGeometries();
    this.mats = {
      w: new THREE.MeshStandardMaterial({ color: COLORS.white, roughness: 0.34, metalness: 0.06 }),
      b: new THREE.MeshStandardMaterial({ color: COLORS.black, roughness: 0.28, metalness: 0.1 }),
    };
  }

  _markers() {
    const dotGeo = new THREE.CircleGeometry(0.13, 24);
    dotGeo.rotateX(-Math.PI / 2);
    this.dots = new THREE.InstancedMesh(dotGeo,
      new THREE.MeshBasicMaterial({ color: COLORS.emerald, transparent: true, opacity: 0.85, depthWrite: false }), 32);
    this.dots.count = 0;
    this.scene.add(this.dots);

    const ringGeo = new THREE.RingGeometry(0.33, 0.43, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ringGeo,
      new THREE.MeshBasicMaterial({ color: COLORS.emerald, transparent: true, opacity: 0.9, depthWrite: false }), 16);
    this.rings.count = 0;
    this.scene.add(this.rings);

    const tintQuad = (color, opacity) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      m.geometry.rotateX(-Math.PI / 2);
      m.visible = false;
      m.position.y = BOARD_TOP + 0.004;
      this.scene.add(m);
      return m;
    };
    this.lastFrom = tintQuad(COLORS.amber, 0.38);
    this.lastTo = tintQuad(COLORS.amber, 0.5);
    this.checkQuad = tintQuad(COLORS.red, 0.55);
    this.selQuad = tintQuad(COLORS.emerald, 0.45);
    this.cursorQuad = tintQuad(0x9ec7ff, 0.4);
  }

  setCursor(sq) {
    this.cursorQuad.visible = !!sq;
    if (sq) { const { x, z } = sqToXZ(sq); this.cursorQuad.position.set(x, BOARD_TOP + 0.0035, z); }
  }

  _picking() {
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_TOP);
    this._hit = new THREE.Vector3();
    let downX = 0, downY = 0, downAt = 0;
    this.canvas.addEventListener("pointerdown", (e) => { downX = e.clientX; downY = e.clientY; downAt = performance.now(); });
    this.canvas.addEventListener("pointerup", (e) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 12 || performance.now() - downAt > 600) return; // it was a camera drag
      const rect = this.canvas.getBoundingClientRect();
      this._ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this._ray.setFromCamera(this._ndc, this.camera);
      if (this._ray.ray.intersectPlane(this._plane, this._hit)) {
        const sq = xzToSq(this._hit.x, this._hit.z);
        if (sq && this.onSquareTap) this.onSquareTap(sq);
      }
    });
  }

  // ---------- piece management ----------
  _acquire(color, type) {
    const bucket = this.pool[color][type] || (this.pool[color][type] = []);
    let mesh = bucket.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.geos[type], this.mats[color]);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData = { color, type };
    }
    mesh.visible = true;
    mesh.scale.set(1, 1, 1);
    mesh.rotation.set(0, type === "n" ? (color === "w" ? Math.PI / 2 : -Math.PI / 2) : 0, 0);
    this.scene.add(mesh);
    return mesh;
  }

  _release(mesh) {
    this.scene.remove(mesh);
    this.pool[mesh.userData.color][mesh.userData.type].push(mesh);
  }

  // Full reconciliation from a chess.js board() 2D array (rank 8 first).
  syncFromBoard(board2d) {
    for (const [, mesh] of this.pieces) this._release(mesh);
    this.pieces.clear();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board2d[r][f];
        if (!cell) continue;
        const sq = FILES[f] + (8 - r);
        const mesh = this._acquire(cell.color, cell.type);
        const { x, z } = sqToXZ(sq);
        mesh.position.set(x, BOARD_TOP, z);
        this.pieces.set(sq, mesh);
      }
    }
  }

  _tween(dur, step, done) {
    this.tweens.push({ t: 0, dur, step, done });
  }

  // Animated application of one verbose chess.js move.
  animateMove(mv, onDone) {
    const from = mv.from, to = mv.to;
    const mesh = this.pieces.get(from);
    if (!mesh) { if (onDone) onDone(); return; }
    this.pieces.delete(from);

    // captured piece (including en passant square)
    let capSq = null;
    if (mv.flags.includes("e")) capSq = to[0] + from[1];
    else if (mv.captured) capSq = to;
    const capMesh = capSq ? this.pieces.get(capSq) : null;
    if (capMesh) {
      this.pieces.delete(capSq);
      this._tween(0.18, (k) => {
        capMesh.scale.setScalar(1 - 0.65 * k);
        capMesh.position.y = BOARD_TOP - 0.55 * k;
      }, () => this._release(capMesh));
    }

    const a = sqToXZ(from), b = sqToXZ(to);
    const hop = mv.piece === "n" ? 0.85 : 0.16;
    this._tween(0.22, (k) => {
      const e = easeInOut(k);
      mesh.position.x = a.x + (b.x - a.x) * e;
      mesh.position.z = a.z + (b.z - a.z) * e;
      mesh.position.y = BOARD_TOP + Math.sin(e * Math.PI) * hop;
    }, () => {
      mesh.position.set(b.x, BOARD_TOP, b.z);
      if (mv.promotion) {
        const promoted = this._acquire(mv.color, mv.promotion);
        promoted.position.copy(mesh.position);
        this._release(mesh);
        this.pieces.set(to, promoted);
      } else {
        this.pieces.set(to, mesh);
      }
      if (onDone) onDone();
    });
    if (!mv.promotion) this.pieces.set(to, mesh);

    // castling rook
    if (mv.flags.includes("k") || mv.flags.includes("q")) {
      const rank = from[1];
      const [rFrom, rTo] = mv.flags.includes("k") ? ["h" + rank, "f" + rank] : ["a" + rank, "d" + rank];
      const rook = this.pieces.get(rFrom);
      if (rook) {
        this.pieces.delete(rFrom);
        this.pieces.set(rTo, rook);
        const ra = sqToXZ(rFrom), rb = sqToXZ(rTo);
        this._tween(0.26, (k) => {
          const e = easeInOut(k);
          rook.position.x = ra.x + (rb.x - ra.x) * e;
          rook.position.z = ra.z + (rb.z - ra.z) * e;
          rook.position.y = BOARD_TOP + Math.sin(e * Math.PI) * 0.12;
        });
      }
    }
  }

  // ---------- highlights ----------
  showMoves(squares, captureSquares) {
    const m = new THREE.Matrix4();
    let di = 0, ri = 0;
    for (const sq of squares) {
      const { x, z } = sqToXZ(sq);
      m.setPosition(x, BOARD_TOP + 0.005, z);
      this.dots.setMatrixAt(di++, m);
    }
    for (const sq of captureSquares) {
      const { x, z } = sqToXZ(sq);
      m.setPosition(x, BOARD_TOP + 0.005, z);
      this.rings.setMatrixAt(ri++, m);
    }
    this.dots.count = di; this.rings.count = ri;
    this.dots.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  setSelected(sq) {
    this.selQuad.visible = !!sq;
    if (sq) { const { x, z } = sqToXZ(sq); this.selQuad.position.set(x, BOARD_TOP + 0.003, z); }
  }

  setLastMove(from, to) {
    for (const [quad, sq] of [[this.lastFrom, from], [this.lastTo, to]]) {
      quad.visible = !!sq;
      if (sq) { const { x, z } = sqToXZ(sq); quad.position.set(x, BOARD_TOP + 0.002, z); }
    }
  }

  setCheck(sq) {
    this.checkQuad.visible = !!sq;
    if (sq) { const { x, z } = sqToXZ(sq); this.checkQuad.position.set(x, BOARD_TOP + 0.0025, z); }
  }

  clearHints() { this.showMoves([], []); this.setSelected(null); }

  // ---------- camera ----------
  viewSide(color, animate = true) {
    const targetAz = color === "w" ? 0 : Math.PI;
    if (!animate) {
      const pol = 0.93, d = this._fitDistance();
      this.camera.position.setFromSphericalCoords(d, pol, targetAz);
      this.controls.update();
      return;
    }
    const sph = new THREE.Spherical().setFromVector3(this.camera.position);
    let from = sph.theta;
    let delta = targetAz - from;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const fromPhi = sph.phi, fromR = sph.radius;
    this._tween(0.6, (k) => {
      const e = easeInOut(k);
      this.camera.position.setFromSphericalCoords(
        fromR + (this._fitDistance() - fromR) * e,
        fromPhi + (0.93 - fromPhi) * e,
        from + delta * e);
      this.camera.lookAt(0, 0, 0);
    });
  }

  _fitDistance() {
    const aspect = this.camera.aspect;
    if (aspect >= 1) return aspect < 1.4 ? 12.5 : 11;
    // portrait: half the board+frame (4.85) must fit the horizontal half-angle
    const halfAngle = Math.atan(Math.tan((this.camera.fov * Math.PI / 180) / 2) * aspect);
    return Math.min(26, Math.max(12, (4.85 * 1.12) / Math.tan(halfAngle)));
  }

  _resize() {
    const w = this.canvas.parentElement.clientWidth, h = this.canvas.parentElement.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.fov = this.camera.aspect < 1 ? 64 : 42; // wider lens on portrait phones
    this.camera.updateProjectionMatrix();
    // keep the viewing angles, refit the distance so the whole board stays on screen
    const sph = new THREE.Spherical().setFromVector3(this.camera.position);
    sph.radius = this._fitDistance();
    this.camera.position.setFromSphericalCoords(sph.radius, sph.phi, sph.theta);
    this.camera.lookAt(0, 0, 0);
  }

  _frame() {
    const dt = Math.min(0.05, this._clock.getDelta());
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.step(k);
      if (k >= 1) { this.tweens.splice(i, 1); if (tw.done) tw.done(); }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this._dev) {
      this._frames++;
      const now = performance.now();
      if (now - this._fpsAt >= 500) {
        this._devEl.textContent = `${Math.round(this._frames * 1000 / (now - this._fpsAt))} fps | ${this.renderer.info.render.calls} calls | ${this.renderer.info.render.triangles} tris`;
        this._frames = 0; this._fpsAt = now;
      }
    }
  }
}
