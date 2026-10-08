// Flat board overlays for Board3D.
//  - ShapeLayer: every square highlight (tints, outlines, dots, rings, check glow, contact
//    shadows) is one instanced quad with an analytic, anti-aliased shape in the fragment shader,
//    so all highlights cost a single draw call. A second "ghost" draw (depthFunc GREATER) shows
//    the parts hidden behind pieces faintly, so legal-move dots never vanish behind a king.
//  - ArrowLayer: arrows (shaft + head, L-shaped for knight moves) as one dynamic triangle
//    buffer with per-vertex RGBA, also with a ghost pass.
import * as THREE from "three";

export const SHAPE = { FILL: 0, FRAME: 1, DOT: 2, RING: 3, GLOW: 4, BLOB: 5 };

const VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aShape;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vShape;
void main() {
  vUv = uv;
  vColor = aColor;
  vShape = aShape;
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;

// aShape: x = shape id + ghost factor * 0.9 (fractional part), y/z = shape params, w = quad size
const FRAG = /* glsl */ `
uniform float uGhost;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vShape;
void main() {
  float id = floor(vShape.x + 0.001);
  float ghost = fract(vShape.x + 0.001) / 0.9;
  vec2 p = (vUv - 0.5) * vShape.w;
  float d = length(p);
  float aa = max(fwidth(d), 1e-4);
  float a = 1.0;
  if (id < 0.5) {                       // FILL: whole square
    a = 1.0;
  } else if (id < 1.5) {                // FRAME: inset square outline, width y
    float e = 0.5 - max(abs(p.x), abs(p.y));
    float fw = max(fwidth(e), 1e-4);
    a = smoothstep(-fw, fw, e) * (1.0 - smoothstep(vShape.y - fw, vShape.y + fw, e));
  } else if (id < 2.5) {                // DOT: radius y
    a = 1.0 - smoothstep(vShape.y - aa, vShape.y + aa, d);
  } else if (id < 3.5) {                // RING: radii y..z
    a = smoothstep(vShape.y - aa, vShape.y + aa, d) * (1.0 - smoothstep(vShape.z - aa, vShape.z + aa, d));
  } else if (id < 4.5) {                // GLOW: solid core to y, fades out by z
    float t = clamp((d - vShape.y) / max(1e-4, vShape.z - vShape.y), 0.0, 1.0);
    a = 1.0 - t;
    a = a * a * (3.0 - 2.0 * a) * (0.55 + 0.45 * (1.0 - t));
  } else {                              // BLOB: soft contact shadow, radius y
    float t = clamp(d / vShape.y, 0.0, 1.0);
    a = 1.0 - t * t;
    a = a * a;
  }
  a *= vColor.a;
  if (uGhost > 0.5) a *= ghost;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <colorspace_fragment>
}`;

function shapeMaterial(ghost) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uGhost: { value: ghost ? 1 : 0 } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: ghost ? THREE.GreaterDepth : THREE.LessEqualDepth,
    toneMapped: false,
  });
}

export class ShapeLayer {
  constructor(capacity, y, renderOrder, withGhost) {
    this.cap = capacity;
    this.y = y;
    this.n = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.shape.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aColor", this.color);
    geo.setAttribute("aShape", this.shape);
    this.geometry = geo;
    this.mesh = new THREE.InstancedMesh(geo, shapeMaterial(false), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.meshes = [this.mesh];
    if (withGhost) {
      this.ghost = new THREE.InstancedMesh(geo, shapeMaterial(true), capacity);
      this.ghost.instanceMatrix = this.mesh.instanceMatrix; // shared upload
      this.ghost.frustumCulled = false;
      this.ghost.renderOrder = renderOrder + 1;
      this.ghost.count = 0;
      this.ghost.visible = false;
      this.meshes.push(this.ghost);
    }
  }

  begin() { this.n = 0; }

  // rgba: [r,g,b,a] linear; ghost in [0,1]
  push(x, z, size, shape, rgba, p1 = 0, p2 = 0, ghost = 0, alphaMul = 1, yOff = 0) {
    if (this.n >= this.cap || rgba[3] * alphaMul <= 0) return;
    const i = this.n++;
    const m = this.mesh.instanceMatrix.array, o = i * 16;
    m[o] = size; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = size; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = this.y + yOff; m[o + 14] = z; m[o + 15] = 1;
    const c = this.color.array, s = this.shape.array, k = i * 4;
    c[k] = rgba[0]; c[k + 1] = rgba[1]; c[k + 2] = rgba[2]; c[k + 3] = rgba[3] * alphaMul;
    s[k] = shape + Math.min(1, Math.max(0, ghost)) * 0.9; s[k + 1] = p1; s[k + 2] = p2; s[k + 3] = size;
  }

  end() {
    for (const mesh of this.meshes) { mesh.count = this.n; mesh.visible = this.n > 0; }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.color.needsUpdate = true;
    this.shape.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    for (const mesh of this.meshes) { mesh.material.dispose(); mesh.dispose(); }
  }
}

// ---- arrows ---------------------------------------------------------------------------
const SHAFT = 0.095;     // half width of the shaft (square units)
const HEAD_W = 0.27;     // half width of the head
const HEAD_L = 0.42;     // head length
const TIP_BACK = 0.1;    // tip stops short of the target centre
const MAX_VERTS_PER_ARROW = 36;

export class ArrowLayer {
  constructor(capacityArrows, y, renderOrder) {
    this.cap = capacityArrows * MAX_VERTS_PER_ARROW;
    this.y = y;
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 4);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setDrawRange(0, 0);
    this.geometry = geo;
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    });
    const ghostMat = mat.clone();
    ghostMat.depthFunc = THREE.GreaterDepth;
    ghostMat.opacity = 0.32;
    this.mesh = new THREE.Mesh(geo, mat);
    this.ghost = new THREE.Mesh(geo, ghostMat);
    for (const [i, m] of [this.mesh, this.ghost].entries()) {
      m.frustumCulled = false;
      m.renderOrder = renderOrder + i;
      m.visible = false;
    }
    this.meshes = [this.mesh, this.ghost];
    this.v = 0;
  }

  begin() { this.v = 0; this._rgba = null; }

  _vert(x, z, rgba) {
    if (this.v >= this.cap) return;
    const i = this.v++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = this.y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = rgba[0]; this.col[i * 4 + 1] = rgba[1]; this.col[i * 4 + 2] = rgba[2]; this.col[i * 4 + 3] = rgba[3];
  }

  _tri(ax, az, bx, bz, cx, cz, rgba) {
    this._vert(ax, az, rgba); this._vert(bx, bz, rgba); this._vert(cx, cz, rgba);
  }

  // rectangle from (ax,az) to (bx,bz) with half width w
  _seg(ax, az, bx, bz, w, rgba) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
    if (l < 1e-5) return;
    const nx = (-dz / l) * w, nz = (dx / l) * w;
    this._tri(ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, rgba);
    this._tri(ax + nx, az + nz, bx - nx, bz - nz, ax - nx, az - nz, rgba);
  }

  // half-disc cap at (x,z) facing away from direction (dx,dz)
  _cap(x, z, dx, dz, w, rgba) {
    const base = Math.atan2(dz, dx) + Math.PI / 2;
    const N = 6;
    for (let i = 0; i < N; i++) {
      const a0 = base + (i / N) * Math.PI, a1 = base + ((i + 1) / N) * Math.PI;
      this._tri(x, z, x + Math.cos(a0) * w, z + Math.sin(a0) * w, x + Math.cos(a1) * w, z + Math.sin(a1) * w, rgba);
    }
  }

  // from/to as board x,z of square centres; knight moves bend into an L
  add(ax, az, bx, bz, rgba, scale = 1) {
    const sw = SHAFT * scale, hw = HEAD_W * scale, hl = HEAD_L * scale;
    const adx = Math.abs(bx - ax), adz = Math.abs(bz - az);
    const knight = (Math.round(adx) === 1 && Math.round(adz) === 2) || (Math.round(adx) === 2 && Math.round(adz) === 1);
    let sx = ax, sz = az; // start of the final (headed) leg
    if (knight) {
      // long leg first, then the short one
      const cx = adz > adx ? ax : bx, cz = adz > adx ? bz : az;
      const d1x = Math.sign(cx - ax), d1z = Math.sign(cz - az);
      this._cap(ax, az, d1x, d1z, sw, rgba);
      this._seg(ax, az, cx + d1x * sw, cz + d1z * sw, sw, rgba);
      const d2x = Math.sign(bx - cx), d2z = Math.sign(bz - cz);
      sx = cx + d2x * sw; sz = cz + d2z * sw;
    }
    const dx = bx - sx, dz = bz - sz, l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    const ux = dx / l, uz = dz / l;
    const tipx = bx - ux * TIP_BACK, tipz = bz - uz * TIP_BACK;
    const hbx = tipx - ux * hl, hbz = tipz - uz * hl;
    if (!knight) this._cap(sx, sz, ux, uz, sw, rgba);
    this._seg(sx, sz, hbx, hbz, sw, rgba);
    const nx = -uz, nz = ux;
    this._tri(hbx + nx * hw, hbz + nz * hw, tipx, tipz, hbx - nx * hw, hbz - nz * hw, rgba);
  }

  end() {
    this.geometry.setDrawRange(0, this.v);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    for (const m of this.meshes) m.visible = this.v > 0;
  }

  dispose() {
    this.geometry.dispose();
    for (const m of this.meshes) m.material.dispose();
  }
}
