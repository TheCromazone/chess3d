// 3D board renderer implementing docs/board-contract.md (BoardView contract).
//
//  new Board3D(containerEl, { assetBase = "./assets/", settings })
//
// Scene: photo/procedural board themes on a rounded frame, PMREM room environment for real
// reflections, one shadow-casting key light. Pieces are 12 InstancedMeshes (6 types x 2 colours)
// plus one instanced felt pad mesh and one instanced contact-shadow layer, so the whole position
// costs ~14 draw calls. All square highlights are a single instanced shape layer (+1 x-ray ghost
// pass); arrows are one dynamic buffer (+1 ghost pass).
//
// Rendering is on demand: the rAF loop only calls renderer.render() while something moves
// (tweens, drags, orbit damping, idle orbit) or after a state change, so a static board costs
// almost nothing on phones. Set `board.continuous = true` to render every frame (profiling).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildPieceGeometries, buildFeltGeometry, mergeParts, PIECE_HEIGHTS, BASE_RADII, BODY_RADII } from "./pieces.js";
import { TextureBank } from "./textures.js";
import { BOARD_THEMES, PIECE_THEMES, boardThemeDef, pieceThemeDef, makePieceMaterial, parseColor } from "./board3d-themes.js";
import { ShapeLayer, ArrowLayer, SHAPE } from "./board3d-overlay.js";
import { BoardInput } from "./board3d-input.js";

export { BOARD_THEMES, PIECE_THEMES };

const DPR_CAP = 1.75;
const BOARD_TOP = 0.08;
const FRAME_W = 9.7, FRAME_IN = 8.02, FRAME_H = 0.13;
const LIFT = 0.42, LIFT_TOUCH = 0.55;
const SIDE_POLAR = 0.84, SIDE_POLAR_PORTRAIT = 0.64, TOP_POLAR = 0.3;
const FILES = "abcdefgh";
const TYPES = "pnbrqk";
const KNIGHT_TURN = 0.55; // knights look ~30 degrees toward the centre so their profile reads
const UP = new THREE.Vector3(0, 1, 0);

export const sqToXZ = (sq) => ({ x: FILES.indexOf(sq[0]) - 3.5, z: 3.5 - (Number(sq[1]) - 1) });
export const xzToSq = (x, z) => {
  const f = Math.round(x + 3.5), r = Math.round(3.5 - z);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return FILES[f] + (r + 1);
};
const sqX = (sq) => FILES.indexOf(sq[0]) - 3.5;
const sqZ = (sq) => 3.5 - (sq.charCodeAt(1) - 49);
const isSq = (sq) => typeof sq === "string" && /^[a-h][1-8]$/.test(sq);

const kindOf = (color, type) => (color === "w" ? 0 : 6) + TYPES.indexOf(type);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

function restYaw(color, type, sq) {
  if (type !== "n") return color === "w" ? 0 : Math.PI;
  const toward = FILES.indexOf(sq[0]) <= 3 ? 1 : -1;
  return color === "w" ? Math.PI / 2 - toward * KNIGHT_TURN : -(Math.PI / 2 - toward * KNIGHT_TURN);
}

// ray vs. vertical cylinder (axis at cx,cz; y in [y0,y1]) -> distance or Infinity. No allocation.
function rayCylinder(o, d, cx, cz, r, y0, y1) {
  const ox = o.x - cx, oz = o.z - cz;
  let best = Infinity;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0) { const y = o.y + t * d.y; if (y >= y0 && y <= y1) best = t; }
    }
  }
  if (Math.abs(d.y) > 1e-9) {
    const t = (y1 - o.y) / d.y;
    if (t > 0 && t < best) { const x = ox + t * d.x, z = oz + t * d.z; if (x * x + z * z <= r * r) best = t; }
  }
  return best;
}

// points that must stay on screen: frame corners (top and slab bottom) and back-rank piece tops.
// Portrait containers fit the squares + coordinates and let the outer frame rim crop, since
// width is the scarce dimension on phones.
const fitPoints = (e) => {
  const pts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    pts.push(new THREE.Vector3(sx * e, FRAME_H, sz * e), new THREE.Vector3(sx * e, -0.32, sz * e),
      new THREE.Vector3(sx * 3.5, 1.5, sz * 3.5));
  }
  return pts;
};
const FIT_POINTS = fitPoints(4.87), FIT_POINTS_TIGHT = fitPoints(4.66);

const BLOB_RGBA = [0, 0, 0, 0.5];

export class Board3D {
  constructor(container, opts = {}) {
    if (!container || typeof container.appendChild !== "function") throw new Error("Board3D: container element required");
    // legacy call style `new Board3D(canvasEl)`: use the canvas's parent as the container
    if (container.tagName === "CANVAS" && container.parentElement) {
      console.warn("Board3D: pass a container element, not a canvas (using the canvas's parent)");
      this._legacyCanvas = container;
      container.style.display = "none";
      container = container.parentElement;
    }
    this.container = container;

    // controller callbacks (contract)
    this.onSquareTap = null;
    this.canDrag = null;
    this.onDragStart = null;
    this.onDrop = null;

    this.continuous = false; // debug: render every frame
    this.stats = { fps: 0, calls: 0, triangles: 0, renders: 0 };

    this._active = true;
    this._destroyed = false;
    this._ready = false;
    this._idle = false;
    this._idleState = null;
    this._side = "w";
    this._s = { boardTheme: null, pieceTheme: null, coords: true, animMs: 220, cameraMode: "3d" };
    this._tweens = [];
    this._camTween = null;
    this._pieces = [];
    this._bySq = new Map();
    this._counts = new Int32Array(12);
    this._hl = { lastFrom: null, lastTo: null, check: null, selected: null, preFrom: null, preTo: null, quiet: [], caps: [], cursor: null, fog: [] };
    this._marks = [];
    this._arrows = [];
    this._userCircles = [];
    this._userArrows = [];
    this._drawPreview = null;
    this._drag = null;
    this._lastDrop = null;
    this._dirtyPieces = true;
    this._dirtyOverlay = true;
    this._dirtyArrows = true;
    this._needsRender = 2;
    this._w = 0; this._h = 0;
    this._fitDist = 14; this._fov = 40; this._shift = 0;
    this._fpsFrames = 0; this._fpsAt = 0; this._lastT = 0;
    this._feltOn = true; this._blobMul = 1;
    this._userOrbited = false; // set by BoardInput once a gesture actually orbits/zooms

    // scratch objects (no allocation in the frame loop)
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._hit = new THREE.Vector3();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_TOP);
    this._dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(BOARD_TOP + LIFT));
    this._m4 = new THREE.Matrix4();
    this._m4b = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qYaw = new THREE.Quaternion();
    this._qLean = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._sph = new THREE.Spherical();

    // ---- canvas / renderer -------------------------------------------------------------
    const canvas = this.canvas = document.createElement("canvas");
    canvas.className = "board3d-canvas";
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none;" +
      "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", opts.label || "3D chess board");

    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // re-rendered only when pieces move
    renderer.shadowMap.needsUpdate = true;
    renderer.toneMapping = THREE.NeutralToneMapping; // keeps theme colours true (chess.com green stays green)
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14100d);
    this.scene.fog = new THREE.Fog(0x14100d, 30, 64);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.camera.position.set(0, 10, 10);
    this._fitCam = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

    // input first: its capture-phase listeners run before OrbitControls' and can hide a pointer
    this.input = new BoardInput(this, canvas);
    const controls = this.controls = new OrbitControls(this.camera, canvas);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 0.9;
    controls.minPolarAngle = 0.1;
    controls.maxPolarAngle = 1.32;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: -1 };
    // touch: one finger scrolls the page (BoardInput does that), two fingers orbit and zoom
    controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.target.set(0, 0, 0);
    // OrbitControls hooks `keydown` on canvas.getRootNode(); the canvas is still detached here, so
    // that root is the canvas itself and no document-level listener is installed (contract).
    container.appendChild(canvas);

    // environment: prefiltered room for real reflections on pieces and board
    this._pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(renderer);
    this._envRT = this._pmrem.fromScene(room, 0.04);
    room.dispose();
    this.scene.environment = this._envRT.texture;
    this.scene.environmentIntensity = 0.75;

    this.bank = new TextureBank(opts.assetBase ?? "./assets/");
    this._buildLights();
    this._buildBoard();
    this._buildPieceMeshes();
    this._buildOverlays();

    this.applySettings({ boardTheme: "walnut", pieceTheme: "boxwood", coords: true, animMs: 220, cameraMode: "3d", ...(opts.settings || {}) });
    this._resize(true);
    this.viewSide("w", false);
    this._ready = true;
    // compile every program now (incl. the hidden capture-fade materials) so nothing hitches later
    try { renderer.compile(this.scene, this.camera); } catch { /* optimisation only */ }

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);

    this._loop = this._loop.bind(this);
    renderer.setAnimationLoop(this._loop);
  }

  // ======================================================================================
  // public API (contract)
  // ======================================================================================

  get orientation() { return this._side; }
  get settings() { return { ...this._s }; }

  setActive(on) {
    on = !!on;
    if (on === this._active || this._destroyed) return;
    this._active = on;
    if (on) {
      this._lastT = 0;
      this.controls.enabled = this._controlsWanted();
      this.renderer.setAnimationLoop(this._loop);
      this._resize(true);
      this.invalidate();
    } else {
      this.input.reset();
      this._cancelDrag();
      this._finishTweens(null);
      this.controls.enabled = false;
      this.renderer.setAnimationLoop(null);
    }
  }

  destroy() {
    if (this._destroyed) return;
    this.setActive(false);
    this._destroyed = true;
    this.renderer.setAnimationLoop(null);
    if (this._ro) this._ro.disconnect();
    this.input.dispose();
    this.controls.dispose();
    this._tweens.length = 0;
    const mats = new Set(), geos = new Set();
    this.scene.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
      if (o.isInstancedMesh) o.dispose();
    });
    for (const fx of this._fx) { mats.add(fx.mats.w); mats.add(fx.mats.b); }
    for (const m of mats) { if (m.map && m.map === this._labelTex) m.map.dispose(); m.dispose(); }
    for (const g of geos) g.dispose();
    for (const g of Object.values(this.geos)) g.dispose();
    this.bank.dispose();
    this._envRT.dispose();
    this._pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    if (this._legacyCanvas) this._legacyCanvas.style.display = "";
    this.onSquareTap = this.canDrag = this.onDragStart = this.onDrop = null;
  }

  // Cinematic slow orbit for the home screen; input or setIdle(false) eases back to the side view.
  setIdle(on) {
    on = !!on;
    if (on === this._idle || this._destroyed) return;
    if (on) {
      this._cancelCamTween();
      this._resetControlsMomentum();
      this._idle = true;
      this.controls.enabled = false;
      this._tmp.copy(this.camera.position).sub(this.controls.target);
      this._sph.setFromVector3(this._tmp);
      this._idleState = { t: 0, theta: this._sph.theta, phi0: this._sph.phi, r0: this._sph.radius };
    } else {
      this._idle = false;
      this._idleState = null;
      this._tweenCamera(this._side, 1100);
    }
    this.invalidate();
  }

  // ---- position --------------------------------------------------------------------------

  syncFromBoard(board2d) {
    this._finishTweens("piece");
    this._cancelDrag();
    this._lastDrop = null;
    this._releaseAllFx();
    this._pieces.length = 0;
    this._bySq.clear();
    if (board2d) {
      for (let r = 0; r < 8; r++) {
        const row = board2d[r];
        if (!row) continue;
        for (let f = 0; f < 8; f++) {
          const cell = row[f];
          if (cell && cell.type && cell.color) this._addPiece(cell.color, cell.type, FILES[f] + (8 - r));
        }
      }
    }
    this._dirtyPieces = true;
    this.invalidate();
  }

  // animateMove(mv, { instant } = {}, onDone). Also accepts the legacy animateMove(mv, onDone).
  animateMove(mv, opts, onDone) {
    if (typeof opts === "function") { onDone = opts; opts = null; }
    const done = () => { if (onDone) { try { onDone(); } catch (e) { console.error(e); } } };
    this._finishTweens("piece");
    if (!mv || !isSq(mv.from) || !isSq(mv.to)) { done(); return; }
    const flags = mv.flags || "";
    const p = this._bySq.get(mv.from);
    if (!p) { this.invalidate(); done(); return; }
    const animMs = this._s.animMs;
    const instant = !!(opts && opts.instant) || !(animMs > 0);

    // captured piece (en passant: the pawn beside the destination)
    let capSq = null;
    if (flags.includes("e")) capSq = mv.to[0] + mv.from[1];
    else if (mv.captured || this._bySq.has(mv.to)) capSq = mv.to;
    let cap = capSq ? this._bySq.get(capSq) || null : null;
    if (cap === p) cap = null;

    // castling rook
    let rook = null, rFrom = null, rTo = null;
    if (flags.includes("k") || flags.includes("q")) {
      const rank = mv.from[1];
      [rFrom, rTo] = flags.includes("k") ? ["h" + rank, "f" + rank] : ["a" + rank, "d" + rank];
      rook = this._bySq.get(rFrom) || null;
    }

    if (this._drag && (this._drag.p === p || this._drag.p === cap || this._drag.p === rook)) this._cancelDrag();

    // logical update first: the board's square map is final immediately
    this._bySq.delete(mv.from);
    if (cap) this._bySq.delete(capSq);
    this._bySq.set(mv.to, p);
    p.sq = mv.to;
    if (rook) { this._bySq.delete(rFrom); this._bySq.set(rTo, rook); rook.sq = rTo; }
    const promo = mv.promotion && mv.promotion !== p.type && TYPES.includes(mv.promotion) ? mv.promotion : null;

    const tx = sqX(mv.to), tz = sqZ(mv.to);
    const yawTo = restYaw(p.color, promo || p.type, mv.to);
    this._dirtyPieces = true;
    this.invalidate();

    if (instant) {
      if (cap) this._removePiece(cap);
      const drop = this._lastDrop;
      this._lastDrop = null;
      p.x = tx; p.z = tz; p.y = BOARD_TOP; p.yaw = yawTo; p.lx = p.lz = 0;
      // just dropped by drag: settle from where it was released instead of teleporting
      if (drop && drop.p === p && drop.from === mv.from && drop.to === mv.to && performance.now() - drop.t < 600 && animMs > 0) {
        this._glide(p, drop.x, drop.y, drop.z, 85);
      }
      if (promo) this._promote(p, promo, animMs > 0);
      if (rook) { rook.x = sqX(rTo); rook.z = sqZ(rTo); rook.y = BOARD_TOP; }
      done();
      return;
    }

    const fx = p.x, fy = p.y, fz = p.z, yaw0 = p.yaw;
    const dist = Math.hypot(tx - fx, tz - fz);
    const knight = p.type === "n";
    const dur = knight ? animMs * 1.15 : animMs * (0.85 + 0.45 * clamp((dist - 1) / 6, 0, 1));
    const hop = knight ? 0.5 : 0.04 + 0.012 * dist;
    const dyaw = wrapAngle(yawTo - yaw0);
    this._tween("piece", dur, (k) => {
      const e = easeInOut(k);
      p.x = lerp(fx, tx, e); p.z = lerp(fz, tz, e);
      p.y = BOARD_TOP + Math.sin(Math.PI * e) * hop + (fy - BOARD_TOP) * (1 - e);
      p.yaw = yaw0 + dyaw * e;
      this._dirtyPieces = true;
    }, () => {
      p.x = tx; p.z = tz; p.y = BOARD_TOP; p.yaw = yawTo;
      if (promo) this._promote(p, promo, true);
      this._dirtyPieces = true;
      done();
    });
    if (cap) this._fadeCapture(cap, dur * 0.55, tx - fx, tz - fz);
    if (rook) {
      const ax = rook.x, az = rook.z, bx = sqX(rTo), bz = sqZ(rTo);
      this._tween("piece", dur, (k) => {
        const e = easeInOut(k);
        rook.x = lerp(ax, bx, e); rook.z = lerp(az, bz, e);
        rook.y = BOARD_TOP + Math.sin(Math.PI * e) * 0.34; // hops over the king
        this._dirtyPieces = true;
      }, () => { rook.x = bx; rook.z = bz; rook.y = BOARD_TOP; this._dirtyPieces = true; }, dur * 0.2);
    }
  }

  // ---- orientation -----------------------------------------------------------------------

  viewSide(color, animate = true) {
    const side = color === "b" ? "b" : "w";
    this._setSide(side);
    if (this._idle) return; // leaving idle eases to this side
    this._tweenCamera(side, animate && this._s.animMs > 0 ? 720 : 0);
  }

  // ---- highlights ------------------------------------------------------------------------

  setLastMove(from, to) { this._hl.lastFrom = isSq(from) ? from : null; this._hl.lastTo = isSq(to) ? to : null; this._overlayChanged(); }
  setCheck(sq) { this._hl.check = isSq(sq) ? sq : null; this._overlayChanged(); }
  setSelected(sq) { this._hl.selected = isSq(sq) ? sq : null; this._overlayChanged(); }
  setPremove(from, to) { this._hl.preFrom = isSq(from) ? from : null; this._hl.preTo = isSq(to) ? to : null; this._overlayChanged(); }
  setCursor(sq) { this._hl.cursor = isSq(sq) ? sq : null; this._overlayChanged(); } // keyboard square cursor (extra)

  showMoves(quietSquares, captureSquares) {
    this._hl.quiet = Array.isArray(quietSquares) ? quietSquares.filter(isSq) : [];
    this._hl.caps = Array.isArray(captureSquares) ? captureSquares.filter(isSq) : [];
    this._overlayChanged();
  }

  clearHints() { this._hl.quiet = []; this._hl.caps = []; this._hl.selected = null; this._overlayChanged(); }

  /** Extra: Fog of War, the squares to hide */
  setFog(squares) { this._hl.fog = (squares || []).filter(isSq); this._overlayChanged(); }

  /** Extra: Duck Chess, the duck's square (null hides it); a small modelled duck */
  setDuck(sq) {
    if (!this._duck) {
      const g = new THREE.Group();
      const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.55 });
      const orange = new THREE.MeshStandardMaterial({ color: 0xe8782a, roughness: 0.5 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.35 });
      const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
      part(new THREE.SphereGeometry(0.25, 24, 16), yellow, 0, 0.19, 0).scale.set(1.25, 0.78, 0.95);
      part(new THREE.ConeGeometry(0.09, 0.2, 12), yellow, -0.33, 0.27, 0).rotation.z = Math.PI / 2.4;
      part(new THREE.SphereGeometry(0.145, 20, 14), yellow, 0.19, 0.47, 0);
      const beak = part(new THREE.ConeGeometry(0.055, 0.15, 12), orange, 0.37, 0.45, 0);
      beak.rotation.z = -Math.PI / 2;
      beak.scale.set(1, 1, 0.65);
      for (const z of [-0.075, 0.075]) part(new THREE.SphereGeometry(0.022, 10, 8), dark, 0.285, 0.52, z);
      g.rotation.y = -Math.PI / 4;
      this.scene.add(g);
      this._duck = g;
    }
    this._duck.visible = isSq(sq);
    if (isSq(sq)) { const { x, z } = sqToXZ(sq); this._duck.position.set(x, BOARD_TOP, z); }
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  }

  /** Extra: Game Review classification badge floating at a square's corner (null clears). */
  setBadge(sq, badge) {
    if (!this._badge) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 128;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
      sprite.renderOrder = 999;
      sprite.scale.set(0.42, 0.42, 1);
      sprite.visible = false;
      this.scene.add(sprite);
      this._badge = { cv, tex, sprite, key: "" };
    }
    const bd = this._badge;
    if (!isSq(sq) || !badge) { bd.sprite.visible = false; this.invalidate(); return; }
    const key = badge.text + "|" + badge.color;
    if (bd.key !== key) {
      bd.key = key;
      const g = bd.cv.getContext("2d");
      g.clearRect(0, 0, 128, 128);
      g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fillStyle = badge.color; g.fill();
      g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,.75)"; g.stroke();
      g.fillStyle = "#fff"; g.font = `900 ${badge.text.length > 1 ? 56 : 66}px system-ui, sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(badge.text, 64, 68);
      bd.tex.needsUpdate = true;
    }
    const { x, z } = sqToXZ(sq);
    bd.sprite.position.set(x + 0.32, BOARD_TOP + 0.95, z - 0.32);
    bd.sprite.visible = true;
    this.invalidate();
  }

  setMarks(list) {
    this._marks = (Array.isArray(list) ? list : []).filter((m) => m && isSq(m.sq)).map((m) => ({ sq: m.sq, rgba: parseColor(m.color || "rgba(52,210,123,.5)") }));
    this._overlayChanged();
  }

  setArrows(list) {
    this._arrows = (Array.isArray(list) ? list : []).filter((a) => a && isSq(a.from) && isSq(a.to) && a.from !== a.to)
      .map((a) => ({ from: a.from, to: a.to, rgba: parseColor(a.color || "rgba(255,170,0,.8)") }));
    this._dirtyArrows = true;
    this.invalidate();
  }

  clearUserDrawings() {
    if (!this._userCircles.length && !this._userArrows.length && !this._drawPreview) return;
    this._userCircles = [];
    this._userArrows = [];
    this._drawPreview = null;
    this._overlayChanged();
    this._dirtyArrows = true;
  }

  // ---- settings --------------------------------------------------------------------------

  applySettings(s = {}) {
    if (!s) return;
    if (s.boardTheme != null && s.boardTheme !== this._s.boardTheme) this._applyBoardTheme(s.boardTheme);
    if (s.pieceTheme != null && s.pieceTheme !== this._s.pieceTheme) this._applyPieceTheme(s.pieceTheme);
    if (s.coords != null) { this._s.coords = !!s.coords; this._updateLabels(); }
    if (s.animMs != null && isFinite(+s.animMs)) this._s.animMs = clamp(+s.animMs, 0, 3000);
    if (s.cameraMode != null) {
      const mode = s.cameraMode === "top" ? "top" : "3d";
      if (mode !== this._s.cameraMode) {
        this._s.cameraMode = mode;
        if (this._ready && !this._idle) {
          this.controls.enabled = this._controlsWanted();
          this._tweenCamera(this._side, this._s.animMs > 0 ? 650 : 0);
        }
      }
    }
    this.invalidate();
  }

  invalidate() { if (this._needsRender < 2) this._needsRender = 2; }

  // Render synchronously with all pending state applied (dev hooks: screenshots via toDataURL).
  renderNow() {
    if (this._destroyed) return;
    this._resize();
    if (this._dirtyOverlay) this._rebuildOverlay();
    if (this._dirtyArrows) this._rebuildArrows();
    if (this._dirtyPieces) { this._writePieces(); this._dirtyPieces = false; }
    this.renderer.render(this.scene, this.camera);
  }

  // ======================================================================================
  // scene construction
  // ======================================================================================

  _buildLights() {
    this._hemi = new THREE.HemisphereLight(0xc8d4e8, 0x3a2c20, 0.22);
    this.scene.add(this._hemi);
    // key light from the side, so lighting and shadows read the same from either player's side
    const key = this._key = new THREE.DirectionalLight(0xfff1e0, 2.6);
    key.position.set(6.5, 12.5, 2.0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -6.4; sc.right = sc.top = 6.4; sc.near = 4; sc.far = 28;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.025;
    this.scene.add(key, key.target);
    // cool rim from behind the viewer's opposite side (follows the camera; keeps black pieces readable)
    const rim = this._rim = new THREE.DirectionalLight(0xa9c2e6, 0.85);
    rim.position.set(-3, 6, -9);
    this.scene.add(rim, rim.target);
  }

  _buildBoard() {
    // 64 squares merged into 2 meshes (one per colour); per-square UV offsets vary the grain
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
    const placeholder = this.bank.get("grain:1");
    const mk = () => new THREE.MeshStandardMaterial({ map: placeholder, roughness: 0.45, metalness: 0 });
    this._matDark = mk(); this._matLight = mk(); this._matFrame = mk();
    for (const [geoms, mat] of [[dark, this._matDark], [light, this._matLight]]) {
      const mesh = new THREE.Mesh(mergeParts(geoms, "squares"), mat);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }

    // rounded, bevelled frame + slab (1 mesh)
    const rr = (s, half, rad) => {
      s.moveTo(-half + rad, -half);
      s.lineTo(half - rad, -half); s.quadraticCurveTo(half, -half, half, -half + rad);
      s.lineTo(half, half - rad); s.quadraticCurveTo(half, half, half - rad, half);
      s.lineTo(-half + rad, half); s.quadraticCurveTo(-half, half, -half, half - rad);
      s.lineTo(-half, -half + rad); s.quadraticCurveTo(-half, -half, -half + rad, -half);
      return s;
    };
    const outer = rr(new THREE.Shape(), FRAME_W / 2 - 0.02, 0.2);
    const hole = new THREE.Path();
    const hi = FRAME_IN / 2;
    hole.moveTo(-hi, -hi); hole.lineTo(-hi, hi); hole.lineTo(hi, hi); hole.lineTo(hi, -hi); hole.lineTo(-hi, -hi);
    outer.holes.push(hole);
    const bevel = { bevelEnabled: true, bevelThickness: 0.022, bevelSize: 0.02, bevelSegments: 3, curveSegments: 6 };
    const ring = new THREE.ExtrudeGeometry(outer, { depth: FRAME_H - 0.044, ...bevel });
    ring.rotateX(-Math.PI / 2);
    ring.translate(0, 0.022, 0);
    const slabShape = rr(new THREE.Shape(), FRAME_W / 2 - 0.02, 0.2);
    const slab = new THREE.ExtrudeGeometry(slabShape, { depth: 0.26, ...bevel });
    slab.rotateX(-Math.PI / 2);
    slab.translate(0, -0.3, 0);
    for (const g of [ring, slab]) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.16 + 0.3, uv.getY(i) * 0.16 + 0.7);
    }
    const frame = new THREE.Mesh(mergeParts([ring, slab], "frame"), this._matFrame);
    frame.receiveShadow = true;
    frame.castShadow = true;
    this.scene.add(frame);

    this._buildLabels();

    this._tableMat = new THREE.MeshStandardMaterial({ map: this.bank.get("felt"), roughness: 0.95, metalness: 0, envMapIntensity: 0.3 });
    this._tableMat.map.repeat.set(36, 36);
    // big enough that its rim is always past the fog: the table melts into the background
    const table = new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 0.4, 96, 1), this._tableMat);
    table.position.y = -0.52;
    table.receiveShadow = true;
    this.scene.add(table);
  }

  _buildLabels() {
    // one 512x512 atlas of white glyphs (a-h, 1-8) tinted by the theme; labels face the viewer
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = 512;
    const g2 = atlas.getContext("2d");
    g2.font = "600 78px Georgia, 'Times New Roman', serif";
    g2.textAlign = "center";
    g2.textBaseline = "middle";
    g2.fillStyle = "#ffffff";
    [..."abcdefgh", ..."12345678"].forEach((ch, i) => g2.fillText(ch, (i % 4) * 128 + 64, Math.floor(i / 4) * 128 + 68));
    const tex = this._labelTex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this._labelMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
    const off = (FRAME_IN / 2 + FRAME_W / 2) / 2, S = 0.36;
    const build = (black) => {
      const quads = [];
      const quad = (gi, x, z, rot) => {
        const g = new THREE.PlaneGeometry(S, S);
        const uv = g.attributes.uv;
        const cx = (gi % 4) / 4, cy = 1 - (Math.floor(gi / 4) + 1) / 4;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, cx + uv.getX(i) / 4, cy + uv.getY(i) / 4);
        g.rotateX(-Math.PI / 2);
        if (rot) g.rotateY(rot);
        g.translate(x, FRAME_H + 0.003, z);
        quads.push(g);
      };
      for (let f = 0; f < 8; f++) quad(f, f - 3.5, black ? -off : off, black ? Math.PI : 0);
      for (let r = 0; r < 8; r++) quad(8 + r, black ? off : -off, 3.5 - r, black ? Math.PI : 0);
      const mesh = new THREE.Mesh(mergeParts(quads, "labels"), this._labelMat);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      return mesh;
    };
    this._labelsW = build(false);
    this._labelsB = build(true);
    this._updateLabels();
  }

  _updateLabels() {
    if (!this._labelsW) return;
    this._labelsW.visible = this._s.coords && this._side === "w";
    this._labelsB.visible = this._s.coords && this._side === "b";
    this.invalidate();
  }

  _buildPieceMeshes() {
    this.geos = buildPieceGeometries();
    this._pieceMeshes = [];
    const tmpMat = new THREE.MeshStandardMaterial();
    for (let k = 0; k < 12; k++) {
      const type = TYPES[k % 6];
      const mesh = this._makePieceMesh(this.geos[type], tmpMat, type === "k" ? 2 : type === "p" ? 10 : 4);
      this._pieceMeshes.push(mesh);
    }
    this._feltMat = new THREE.MeshStandardMaterial({ color: 0x2c5a3a, roughness: 1, metalness: 0, envMapIntensity: 0.2 });
    this._felt = new THREE.InstancedMesh(buildFeltGeometry(), this._feltMat, 40);
    this._felt.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._felt.frustumCulled = false;
    this._felt.count = 0;
    this.scene.add(this._felt);

    // capture fade-out: a few plain meshes with transparent copies of the piece materials
    this._fx = [];
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(this.geos.p, tmpMat);
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.renderOrder = 8;
      mesh.castShadow = false;
      this.scene.add(mesh);
      this._fx.push({ mesh, busy: false, mats: { w: tmpMat, b: tmpMat } });
    }
  }

  _makePieceMesh(geo, mat, cap) {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  _ensureCap(k, n) {
    const mesh = this._pieceMeshes[k];
    if (n <= mesh.instanceMatrix.count) return;
    const nm = this._makePieceMesh(mesh.geometry, mesh.material, Math.max(n, mesh.instanceMatrix.count * 2));
    nm.renderOrder = mesh.renderOrder;
    nm.castShadow = mesh.castShadow;
    this.scene.remove(mesh);
    mesh.dispose();
    this._pieceMeshes[k] = nm;
  }

  _buildOverlays() {
    this._blobs = new ShapeLayer(64, BOARD_TOP + 0.0015, 1, false);
    this._ov = new ShapeLayer(256, BOARD_TOP + 0.004, 2, true);
    this._ar = new ArrowLayer(48, BOARD_TOP + 0.012, 4);
    for (const m of [...this._blobs.meshes, ...this._ov.meshes, ...this._ar.meshes]) this.scene.add(m);
  }

  // ======================================================================================
  // themes
  // ======================================================================================

  _applyBoardTheme(id) {
    const def = boardThemeDef(id);
    this._s.boardTheme = def.id;
    this._boardDef = def;
    for (const [mat, spec] of [[this._matLight, def.light], [this._matDark, def.dark], [this._matFrame, def.frame]]) {
      mat.color.set(spec.color || "#ffffff");
      mat.roughness = spec.roughness ?? 0.45;
      mat.metalness = spec.metalness ?? 0;
      mat.envMapIntensity = spec.env ?? 0.6;
      mat.map = this.bank.get(spec.tex, (tex) => {
        if (this._destroyed || this._boardDef !== def) return;
        mat.map = tex;
        this.invalidate();
      });
    }
    this.scene.background.set(def.bg);
    this.scene.fog.color.set(def.bg);
    this._tableMat.color.set(def.table);
    this._labelMat.color.set(def.coord);
    this.renderer.toneMappingExposure = def.exposure ?? 1;
    const hl = def.hl;
    const pc = (c) => parseColor(c);
    this._pal = {
      last: pc(hl.last), sel: pc(hl.sel), pre: pc(hl.pre), dot: pc(hl.dot), ring: pc(hl.ring),
      hover: pc(hl.hover), check: pc(hl.check), cursor: pc(hl.cursor),
      fog: pc("rgba(10,8,12,.86)"),
    };
    this._overlayChanged();
  }

  _applyPieceTheme(id) {
    const def = pieceThemeDef(id);
    this._s.pieceTheme = def.id;
    this._pieceDef = def;
    const old = this._pieceMats;
    const mats = this._pieceMats = { w: makePieceMaterial(def.w, this.bank), b: makePieceMaterial(def.b, this.bank) };
    for (let k = 0; k < 12; k++) this._pieceMeshes[k].material = k < 6 ? mats.w : mats.b;
    if (def.felt) this._feltMat.color.set(def.felt);
    this._feltOn = !!def.felt;
    this._blobMul = def.blob ?? 1;
    for (const mesh of this._pieceMeshes) mesh.castShadow = def.shadows !== false;
    const oldFx = [];
    for (const fx of this._fx) {
      oldFx.push(fx.mats.w, fx.mats.b);
      fx.mats = { w: makePieceMaterial(def.w, this.bank, true), b: makePieceMaterial(def.b, this.bank, true) };
      fx.mesh.material = fx.mats.w;
      fx.busy = false;
      fx.mesh.visible = false;
    }
    this._updatePieceOrder();
    if (old) { old.w.dispose(); old.b.dispose(); }
    for (const m of new Set(oldFx)) m.dispose();
    // compile now (including the hidden capture-fade materials) so the first capture doesn't hitch
    this._fx[1].mesh.material = this._fx[1].mats.b;
    if (this._ready) {
      try { this.renderer.compile(this.scene, this.camera); } catch { /* compile is an optimisation */ }
    }
    this._dirtyPieces = true;
    this.invalidate();
  }

  // glass pieces are transparent: draw the far side's pieces first so the near ones blend over them
  _updatePieceOrder() {
    const glass = this._pieceDef && this._pieceDef.w.glass;
    for (let k = 0; k < 12; k++) {
      const near = (k < 6 ? "w" : "b") === this._side;
      this._pieceMeshes[k].renderOrder = glass ? (near ? 7 : 6) : 0;
    }
  }

  // ======================================================================================
  // pieces
  // ======================================================================================

  _addPiece(color, type, sq) {
    if (!TYPES.includes(type)) return null;
    const p = {
      color, type, kind: kindOf(color, type), sq,
      x: sqX(sq), y: BOARD_TOP, z: sqZ(sq), yaw: restYaw(color, type, sq),
      lx: 0, lz: 0, s: 1, hidden: false,
    };
    this._pieces.push(p);
    this._bySq.set(sq, p);
    return p;
  }

  _removePiece(p) {
    const i = this._pieces.indexOf(p);
    if (i >= 0) this._pieces.splice(i, 1);
    if (this._bySq.get(p.sq) === p) this._bySq.delete(p.sq);
    this._dirtyPieces = true;
  }

  _hasPiece(sq) { return this._bySq.has(sq); }

  _promote(p, type, pop) {
    p.type = type;
    p.kind = kindOf(p.color, type);
    p.yaw = restYaw(p.color, type, p.sq);
    this._dirtyPieces = true;
    if (!pop) { p.s = 1; return; }
    p.s = 0.5;
    this._tween("piece", 280, (k) => { p.s = 0.5 + 0.5 * easeOutBack(k); this._dirtyPieces = true; }, () => { p.s = 1; this._dirtyPieces = true; });
  }

  // tween p from (fx,fy,fz) to its current position
  _glide(p, fx, fy, fz, ms) {
    const tx = p.x, ty = p.y, tz = p.z, lx = p.lx, lz = p.lz;
    if (!(ms > 0)) return;
    p.x = fx; p.y = fy; p.z = fz;
    this._tween("piece", ms, (k) => {
      const e = easeOut(k);
      p.x = lerp(fx, tx, e); p.y = lerp(fy, ty, e); p.z = lerp(fz, tz, e);
      p.lx = lx * (1 - e); p.lz = lz * (1 - e);
      this._dirtyPieces = true;
    });
  }

  _fadeCapture(cap, delayMs, dx, dz) {
    const fadeMs = Math.max(140, this._s.animMs * 0.8);
    let fx = null;
    const l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l;
    this._tween("piece", fadeMs, (k) => {
      if (!fx) return;
      const e = easeOut(k);
      const mat = fx.mesh.material;
      mat.opacity = (mat.userData.baseOpacity ?? 1) * (1 - e);
      cap.s = 1 - 0.18 * e;
      cap.y = BOARD_TOP - 0.06 * e;
      cap.lx = ux * 0.32 * e; cap.lz = uz * 0.32 * e; // knocked back by the capturing piece
      this._composePiece(cap, fx.mesh.matrix);
      fx.mesh.matrixWorldNeedsUpdate = true;
    }, () => {
      if (fx) { fx.mesh.visible = false; fx.busy = false; }
      this._removePiece(cap);
    }, delayMs, () => {
      // the capturing piece has arrived: hand the captured piece to a fade mesh
      fx = this._fx.find((f) => !f.busy) || null;
      if (fx) {
        fx.busy = true;
        fx.mesh.geometry = this.geos[cap.type];
        fx.mesh.material = fx.mats[cap.color];
        fx.mesh.material.opacity = fx.mesh.material.userData.baseOpacity ?? 1;
        this._composePiece(cap, fx.mesh.matrix);
        fx.mesh.matrixWorldNeedsUpdate = true;
        fx.mesh.visible = true;
      }
      cap.hidden = true;
      this._dirtyPieces = true;
    });
  }

  _releaseAllFx() {
    for (const fx of this._fx) { fx.busy = false; fx.mesh.visible = false; }
  }

  _composePiece(p, out) {
    this._qYaw.setFromAxisAngle(UP, p.yaw);
    const ll = Math.hypot(p.lx, p.lz);
    const s = p.s;
    this._pos.set(p.x, p.y, p.z);
    if (ll > 1e-4) {
      this._axis.set(p.lz / ll, 0, -p.lx / ll);
      this._qLean.setFromAxisAngle(this._axis, ll);
      this._q.multiplyQuaternions(this._qLean, this._qYaw);
      // lean around a pivot near the top (where fingers hold it): the base swings behind
      const h = PIECE_HEIGHTS[p.type] * s * 0.8;
      this._tmp.set(0, h, 0).applyQuaternion(this._qLean);
      this._pos.x -= this._tmp.x; this._pos.y += h - this._tmp.y; this._pos.z -= this._tmp.z;
    } else {
      this._q.copy(this._qYaw);
    }
    this._scl.set(s, s, s);
    return out.compose(this._pos, this._q, this._scl);
  }

  _writePieces() {
    const counts = this._counts;
    const list = this._pieces;
    counts.fill(0);
    let n = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].hidden) { counts[list[i].kind]++; n++; }
    for (let k = 0; k < 12; k++) this._ensureCap(k, counts[k]);
    if (n > this._felt.instanceMatrix.count) {
      const nf = new THREE.InstancedMesh(this._felt.geometry, this._feltMat, n * 2);
      nf.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      nf.frustumCulled = false;
      this.scene.remove(this._felt);
      this._felt.dispose();
      this._felt = nf;
      this.scene.add(nf);
    }
    counts.fill(0);
    let nf = 0;
    const felt = this._felt.instanceMatrix.array;
    const blobs = this._blobs;
    blobs.begin();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.hidden) continue;
      const m = this._composePiece(p, this._m4);
      const mesh = this._pieceMeshes[p.kind];
      m.toArray(mesh.instanceMatrix.array, counts[p.kind] * 16);
      counts[p.kind]++;
      const r = BASE_RADII[p.type] * 0.93;
      this._m4b.makeScale(r, 1, r).premultiply(m);
      this._m4b.toArray(felt, nf * 16);
      nf++;
      const lift = clamp((p.y - BOARD_TOP) / 0.6, 0, 1);
      const R = BASE_RADII[p.type] * p.s;
      blobs.push(p.x, p.z, R * 3.2, SHAPE.BLOB, BLOB_RGBA, R * 1.5 * (1 + lift * 0.5), 0, 0, (1 - 0.7 * lift) * this._blobMul);
    }
    for (let k = 0; k < 12; k++) {
      const mesh = this._pieceMeshes[k];
      mesh.count = counts[k];
      mesh.visible = counts[k] > 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this._felt.count = nf;
    this._felt.visible = this._feltOn !== false && nf > 0;
    this._felt.instanceMatrix.needsUpdate = true;
    blobs.end();
    this.renderer.shadowMap.needsUpdate = true;
  }

  // ======================================================================================
  // highlights / drawings
  // ======================================================================================

  _overlayChanged() { this._dirtyOverlay = true; this.invalidate(); }

  _rebuildOverlay() {
    this._dirtyOverlay = false;
    const ov = this._ov, P = this._pal, hl = this._hl;
    if (!P) return;
    ov.begin();
    const fill = (sq, rgba) => { if (sq) ov.push(sqX(sq), sqZ(sq), 1, SHAPE.FILL, rgba); };
    for (const sq of hl.fog) fill(sq, P.fog);
    fill(hl.lastFrom, P.last);
    fill(hl.lastTo, P.last);
    fill(hl.preFrom, P.pre);
    fill(hl.preTo, P.pre);
    fill(hl.selected, P.sel);
    for (const m of this._marks) fill(m.sq, m.rgba);
    // check: soft red radial glow, solid out past the king's foot, spilling onto neighbours
    if (hl.check) ov.push(sqX(hl.check), sqZ(hl.check), 1.9, SHAPE.GLOW, P.check, 0.3, 0.92);
    for (const c of this._userCircles) ov.push(sqX(c.sq), sqZ(c.sq), 1, SHAPE.RING, c.rgba, 0.4, 0.468, 0.5);
    const d = this._drag;
    if (d && d.hover) {
      if (d.touch) ov.push(sqX(d.hover), sqZ(d.hover), 2, SHAPE.DOT, P.hover, 0.95, 0, 0.3, 0.22);
      ov.push(sqX(d.hover), sqZ(d.hover), 1, SHAPE.FRAME, P.hover, 0.075, 0, 0.7);
    }
    if (hl.cursor) ov.push(sqX(hl.cursor), sqZ(hl.cursor), 1, SHAPE.FRAME, P.cursor, 0.07, 0, 0.7);
    for (const sq of hl.quiet) ov.push(sqX(sq), sqZ(sq), 1, SHAPE.DOT, P.dot, 0.155, 0, 0.75);
    for (const sq of hl.caps) ov.push(sqX(sq), sqZ(sq), 1, SHAPE.RING, P.ring, 0.37, 0.475, 0.75);
    ov.end();
  }

  _rebuildArrows() {
    this._dirtyArrows = false;
    const ar = this._ar;
    ar.begin();
    for (const a of this._arrows) ar.add(sqX(a.from), sqZ(a.from), sqX(a.to), sqZ(a.to), a.rgba);
    for (const a of this._userArrows) ar.add(sqX(a.from), sqZ(a.from), sqX(a.to), sqZ(a.to), a.rgba);
    const pv = this._drawPreview;
    if (pv) ar.add(sqX(pv.from), sqZ(pv.from), sqX(pv.to), sqZ(pv.to), pv.rgba);
    ar.end();
  }

  _toggleCircle(sq, color) {
    const rgba = parseColor(color);
    const i = this._userCircles.findIndex((c) => c.sq === sq);
    if (i >= 0) {
      const same = this._userCircles[i].color === color;
      this._userCircles.splice(i, 1);
      if (!same) this._userCircles.push({ sq, color, rgba });
    } else this._userCircles.push({ sq, color, rgba });
    this._overlayChanged();
  }

  _toggleArrow(from, to, color) {
    const rgba = parseColor(color);
    const i = this._userArrows.findIndex((a) => a.from === from && a.to === to);
    if (i >= 0) {
      const same = this._userArrows[i].color === color;
      this._userArrows.splice(i, 1);
      if (!same) this._userArrows.push({ from, to, color, rgba });
    } else this._userArrows.push({ from, to, color, rgba });
    this._dirtyArrows = true;
    this.invalidate();
  }

  _setDrawPreview(pv) {
    this._drawPreview = pv ? { from: pv.from, to: pv.to, rgba: parseColor(pv.color) } : null;
    this._dirtyArrows = true;
    this.invalidate();
  }

  // ======================================================================================
  // picking & dragging (driven by BoardInput)
  // ======================================================================================

  _setRayFromClient(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    this._ndc.set(((cx - r.left) / Math.max(1, r.width)) * 2 - 1, -((cy - r.top) / Math.max(1, r.height)) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
  }

  // square under the pointer: pieces first (so clicking a king's head picks the king, not the
  // square two ranks behind it), then the board plane
  _pickSquare(cx, cy, pointerType) {
    this._setRayFromClient(cx, cy);
    const o = this._ray.ray.origin, d = this._ray.ray.direction;
    const pad = pointerType === "touch" ? 0.05 : 0.01;
    let best = Infinity, bestSq = null;
    const dragged = this._drag ? this._drag.p : null;
    for (let i = 0; i < this._pieces.length; i++) {
      const p = this._pieces[i];
      if (p.hidden || p === dragged || this._bySq.get(p.sq) !== p) continue;
      const h = PIECE_HEIGHTS[p.type] * p.s;
      // body + wide foot + slim finial (king's cross / queen's ball shouldn't hide what's behind)
      const hb = p.type === "k" ? 1.24 * p.s : p.type === "q" ? 1.16 * p.s : h;
      let t = rayCylinder(o, d, p.x, p.z, BODY_RADII[p.type] + pad, p.y, p.y + hb);
      const tb = rayCylinder(o, d, p.x, p.z, BASE_RADII[p.type] + pad * 0.5, p.y, p.y + 0.2);
      if (tb < t) t = tb;
      if (hb < h) { const tt = rayCylinder(o, d, p.x, p.z, 0.09 + pad, p.y, p.y + h); if (tt < t) t = tt; }
      if (t < best) { best = t; bestSq = p.sq; }
    }
    const onPlane = this._ray.ray.intersectPlane(this._plane, this._hit) ? xzToSq(this._hit.x, this._hit.z) : null;
    // a legal-move dot/ring stays visible through pieces (x-ray pass), so aiming at one picks
    // that square even when a piece stands in front of it
    if (bestSq && onPlane && onPlane !== bestSq && (this._hl.quiet.includes(onPlane) || this._hl.caps.includes(onPlane))) {
      const dx = this._hit.x - sqX(onPlane), dz = this._hit.z - sqZ(onPlane);
      if (dx * dx + dz * dz < 0.3 * 0.3) return onPlane;
    }
    return bestSq || onPlane;
  }

  _tap(sq) {
    if (this.onSquareTap && isSq(sq)) {
      try { this.onSquareTap(sq); } catch (e) { console.error(e); }
    }
  }

  _dragBegin(sq, cx, cy, pointerType) {
    this._finishTweens("piece");
    const p = this._bySq.get(sq);
    if (!p) return false;
    const touch = pointerType === "touch";
    const lift = touch ? LIFT_TOUCH : LIFT;
    this._dragPlane.constant = -(BOARD_TOP + lift);
    this._drag = { p, from: sq, hover: sq, touch, lift, liftK: 0, px: p.x, pz: p.z };
    this.clearUserDrawings();
    if (this.onDragStart) { try { this.onDragStart(sq); } catch (e) { console.error(e); } }
    this._dragMove(cx, cy);
    this._overlayChanged();
    return true;
  }

  _dragMove(cx, cy) {
    const d = this._drag;
    if (!d) return;
    this._setRayFromClient(cx, cy);
    if (!this._ray.ray.intersectPlane(this._dragPlane, this._hit)) return;
    const p = d.p;
    p.x = clamp(this._hit.x, -5.6, 5.6);
    p.z = clamp(this._hit.z, -5.6, 5.6);
    this._dirtyPieces = true;
    const hover = xzToSq(p.x, p.z);
    if (hover !== d.hover) { d.hover = hover; this._dirtyOverlay = true; }
    this.invalidate();
  }

  _stepDrag(dt) {
    const d = this._drag, p = d.p;
    d.liftK = Math.min(1, d.liftK + dt / 0.09);
    p.y = BOARD_TOP + d.lift * easeOut(d.liftK);
    // lean into the motion (velocity-based, smoothed)
    const idt = dt > 1e-4 ? 1 / dt : 0;
    let tx = (p.x - d.px) * idt * 0.045, tz = (p.z - d.pz) * idt * 0.045;
    d.px = p.x; d.pz = p.z;
    const l = Math.hypot(tx, tz);
    if (l > 0.36) { tx *= 0.36 / l; tz *= 0.36 / l; }
    const a = 1 - Math.exp(-dt * 14);
    p.lx += (tx - p.lx) * a;
    p.lz += (tz - p.lz) * a;
    this._dirtyPieces = true;
  }

  _dragEnd(cancelled) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    this._dirtyOverlay = true;
    const p = d.p;
    const dropX = p.x, dropY = p.y, dropZ = p.z;
    const to = cancelled ? null : d.hover;
    // put it back on its square without animation; the controller decides what happens next
    p.x = sqX(p.sq); p.z = sqZ(p.sq); p.y = BOARD_TOP;
    const lx = p.lx, lz = p.lz;
    p.lx = p.lz = 0;
    this._dirtyPieces = true;
    this.invalidate();
    const snap = (ms) => { p.lx = lx; p.lz = lz; this._glide(p, dropX, dropY, dropZ, this._s.animMs > 0 ? ms : 0); p.lx = p.lz = 0; };
    if (cancelled || this._bySq.get(d.from) !== p) { snap(150); return; }
    if (to === d.from) { snap(110); this._tap(d.from); return; }
    this._lastDrop = { p, from: d.from, to, x: dropX, y: dropY, z: dropZ, t: performance.now() };
    let ok = false;
    try { ok = this.onDrop ? !!this.onDrop(d.from, to) : false; } catch (e) { console.error(e); }
    if (!ok) {
      this._lastDrop = null;
      if (p.sq === d.from && this._bySq.get(d.from) === p) snap(160); // rejected: glide home
    }
  }

  _cancelDrag() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (this.input.g && this.input.g.kind === "piece") this.input.g = null;
    this.input._setCursor("");
    const p = d.p;
    p.x = sqX(p.sq); p.z = sqZ(p.sq); p.y = BOARD_TOP; p.lx = p.lz = 0;
    this._dirtyPieces = true;
    this._dirtyOverlay = true;
  }

  // ======================================================================================
  // camera
  // ======================================================================================

  _controlsWanted() { return this._s.cameraMode === "3d" && !this._idle && this._active && !this._camTween; }

  _setSide(side) {
    if (side === this._side) return;
    this._side = side;
    this._updateLabels();
    this._updatePieceOrder();
  }

  _modePolar() {
    if (this._s.cameraMode === "top") return TOP_POLAR;
    return this.camera.aspect < 0.9 ? SIDE_POLAR_PORTRAIT : SIDE_POLAR;
  }

  _modeFov() {
    const top = this._s.cameraMode === "top";
    const vf = top ? 28 : 34, hf = top ? 26 : 34;
    const aspect = this.camera.aspect || 1;
    if (aspect >= 1) return vf;
    // portrait: hold the horizontal field of view (board width is the constraint)
    const v = (2 * Math.atan(Math.tan((hf * Math.PI) / 360) / aspect) * 180) / Math.PI;
    return clamp(v, vf, top ? 62 : 70);
  }

  // distance that fits board + frame + back-rank pieces, and the vertical lens shift (NDC)
  // that centres them (asymmetric perspective otherwise wastes space above the far edge)
  _computeFit(phi, fov, aspect) {
    const cam = this._fitCam;
    cam.fov = fov; cam.aspect = aspect; cam.updateProjectionMatrix();
    const v = this._tmp;
    const M = 0.955;
    let xmax = 0, ymin = 0, ymax = 0;
    const measure = (r) => {
      cam.position.setFromSphericalCoords(r, phi, 0);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      xmax = 0; ymin = Infinity; ymax = -Infinity;
      for (const p of aspect < 0.9 ? FIT_POINTS_TIGHT : FIT_POINTS) {
        v.copy(p).project(cam);
        if (Math.abs(v.x) > xmax) xmax = Math.abs(v.x);
        if (v.y < ymin) ymin = v.y;
        if (v.y > ymax) ymax = v.y;
      }
      return xmax <= M && (ymax - ymin) / 2 <= M;
    };
    let lo = 4, hi = 120;
    for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (measure(mid)) hi = mid; else lo = mid; }
    measure(hi);
    return { r: hi, shift: (ymax + ymin) / 2 };
  }

  _refreshFit() {
    this._fov = this._modeFov();
    const fit = this._computeFit(this._modePolar(), this._fov, this.camera.aspect || 1);
    this._fitDist = fit.r;
    this._shift = fit.shift;
    this.controls.minDistance = fit.r * 0.6;
    this.controls.maxDistance = fit.r * 1.8;
  }

  _applyProjection(fov, shift) {
    const cam = this.camera;
    cam.fov = fov;
    if (Math.abs(shift) > 1e-4 && this._w > 0) {
      cam.setViewOffset(this._w, this._h, 0, -shift * this._h / 2, this._w, this._h); // updates projection
    } else {
      cam.clearViewOffset();
    }
  }

  _placeCamera(r, phi, theta) {
    const t = this.controls.target;
    this.camera.position.setFromSphericalCoords(r, phi, theta).add(t);
    this.camera.lookAt(t);
  }

  _resetControlsMomentum() {
    const c = this.controls;
    const damp = c.enableDamping;
    c.enableDamping = false;
    c.update();
    c.enableDamping = damp;
  }

  _cancelCamTween() {
    if (!this._camTween) return;
    const i = this._tweens.indexOf(this._camTween);
    if (i >= 0) this._tweens.splice(i, 1);
    this._camTween = null;
  }

  // ease the camera to the canonical view of `side` for the current mode (fov + lens shift too)
  _tweenCamera(side, ms) {
    this._cancelCamTween();
    this._userOrbited = false;
    this._resetControlsMomentum();
    this._tmp.copy(this.camera.position).sub(this.controls.target);
    this._sph.setFromVector3(this._tmp);
    const r0 = this._sph.radius, p0 = this._sph.phi, a0 = this._sph.theta;
    const f0 = this.camera.fov, s0 = this._shift;
    const a1 = side === "b" ? Math.PI : 0;
    let da = wrapAngle(a1 - a0);
    if (Math.abs(Math.abs(da) - Math.PI) < 1e-3) da = Math.PI;
    const flip = Math.abs(da) > 2;
    this._refreshFit();
    const s1 = this._shift;
    if (!(ms > 0)) {
      this._applyProjection(this._fov, s1);
      this._placeCamera(this._fitDist, this._modePolar(), a0 + da);
      this.controls.enabled = this._controlsWanted();
      this.invalidate();
      return;
    }
    this.controls.enabled = false;
    const tw = this._tween("camera", ms, (k) => {
      const e = easeInOut(k);
      const lift = flip && this._s.cameraMode === "3d" ? Math.sin(Math.PI * e) * 0.2 : 0;
      this._applyProjection(lerp(f0, this._fov, e), lerp(s0, s1, e));
      this._shift = lerp(s0, s1, e);
      this._placeCamera(lerp(r0, this._fitDist, e), Math.max(0.05, lerp(p0, this._modePolar(), e) - lift), a0 + da * e);
    }, () => {
      this._camTween = null;
      this._shift = s1;
      this.controls.enabled = this._controlsWanted();
      this.invalidate();
    });
    this._camTween = tw;
  }

  _idleStep(dt) {
    const s = this._idleState;
    s.t += dt;
    const t = s.t;
    const ramp = Math.min(1, t / 3);
    const e = ramp * ramp * (3 - 2 * ramp);
    s.theta += dt * 0.11 * e;
    const phi = lerp(s.phi0, 0.96 + 0.1 * Math.sin(t * 0.21), e);
    const r = lerp(s.r0, this._fitDist * (0.97 + 0.05 * Math.sin(t * 0.13)), e);
    this._placeCamera(r, phi, s.theta);
  }

  _cameraMoved() {
    const cp = this.camera.position, t = this.controls.target;
    const dx = cp.x - t.x, dz = cp.z - t.z;
    const l = Math.hypot(dx, dz) || 1;
    this._rim.position.set((-dx / l) * 9, 6, (-dz / l) * 9);
    if (!this._idle && !this._camTween && this._s.cameraMode === "3d") {
      const az = Math.abs(Math.atan2(dx, dz));
      const side = az > Math.PI / 2 + 0.12 ? "b" : az < Math.PI / 2 - 0.12 ? "w" : this._side;
      this._setSide(side);
    }
  }

  _resize(force) {
    if (this._destroyed) return;
    const w = this.container.clientWidth | 0, h = this.container.clientHeight | 0;
    if (w < 2 || h < 2) return; // hidden container: keep the last good framing
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const dprChanged = dpr !== this.renderer.getPixelRatio();
    if (dprChanged) this.renderer.setPixelRatio(dpr);
    if (!force && !dprChanged && w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const oldFit = this._fitDist;
    this._tmp.copy(this.camera.position).sub(this.controls.target);
    this._sph.setFromVector3(this._tmp);
    this._refreshFit();
    if (this._camTween) {
      this._applyProjection(this.camera.fov, this._shift);
    } else {
      this._applyProjection(this._fov, this._shift);
      if (!this._idle && this._sph.radius > 0.01) {
        if (this._s.cameraMode === "top" || !this._userOrbited) {
          // canonical framing for the new aspect (e.g. a phone rotated to landscape)
          this._placeCamera(this._fitDist, this._modePolar(), this._side === "b" ? Math.PI : 0);
        } else {
          // the user has orbited/zoomed: keep their angles and zoom ratio
          this._placeCamera(this._sph.radius * (this._fitDist / oldFit), this._sph.phi, this._sph.theta);
        }
      }
    }
    this.invalidate();
  }

  // ======================================================================================
  // tweens & frame loop
  // ======================================================================================

  _tween(kind, dur, step, done, delay = 0, start = null) {
    const tw = { kind, t: -Math.max(0, delay), dur: Math.max(0, dur), step, done, start, started: false };
    this._tweens.push(tw);
    this.invalidate();
    return tw;
  }

  _stepTweens(ms) {
    const list = this._tweens;
    for (let i = 0; i < list.length;) {
      const tw = list[i];
      tw.t += ms;
      if (tw.t < 0) { i++; continue; }
      if (!tw.started) { tw.started = true; if (tw.start) tw.start(); }
      const k = tw.dur > 0 ? Math.min(1, tw.t / tw.dur) : 1;
      tw.step(k);
      if (k >= 1) {
        list[i] = list[list.length - 1];
        list.pop();
        if (tw.done) { try { tw.done(); } catch (e) { console.error(e); } }
      } else i++;
    }
  }

  // complete tweens immediately (kind null = all). Callbacks may start new tweens.
  _finishTweens(kind) {
    const list = this._tweens;
    const fin = [];
    for (let i = 0; i < list.length;) {
      if (!kind || list[i].kind === kind) fin.push(list.splice(i, 1)[0]);
      else i++;
    }
    for (const tw of fin) {
      if (tw === this._camTween) this._camTween = null;
      if (!tw.started) { tw.started = true; if (tw.start) tw.start(); }
      tw.step(1);
      if (tw.done) { try { tw.done(); } catch (e) { console.error(e); } }
    }
    if (fin.length) this.invalidate();
  }

  _loop(now) {
    if (this._destroyed) return;
    const dt = this._lastT ? Math.min(0.05, Math.max(0, (now - this._lastT) / 1000)) : 1 / 60;
    this._lastT = now;
    let busy = this.continuous;

    if (this._tweens.length) { this._stepTweens(dt * 1000); busy = true; }
    if (this._idle) { this._idleStep(dt); this._cameraMoved(); busy = true; }
    else if (this._camTween) { this._cameraMoved(); }
    else if (this.controls.enabled && this.controls.update()) { this._cameraMoved(); busy = true; }
    if (this._drag) { this._stepDrag(dt); busy = true; }

    if (this._dirtyOverlay) this._rebuildOverlay();
    if (this._dirtyArrows) this._rebuildArrows();
    if (this._dirtyPieces) { this._writePieces(); this._dirtyPieces = false; busy = true; }

    if (busy || this._needsRender > 0) {
      this.renderer.render(this.scene, this.camera);
      if (this._needsRender > 0) this._needsRender--;
      const info = this.renderer.info.render;
      const st = this.stats;
      st.calls = info.calls;
      st.triangles = info.triangles;
      st.renders++;
      this._fpsFrames++;
      if (now - this._fpsAt >= 500) {
        st.fps = Math.round((this._fpsFrames * 1000) / Math.max(1, now - this._fpsAt));
        this._fpsFrames = 0;
        this._fpsAt = now;
      }
    }
  }
}
