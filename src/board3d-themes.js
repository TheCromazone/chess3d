// Board and piece themes for Board3D, plus the material factory and a CSS colour parser.
// Board highlight palettes (hl) follow chess.com / lichess conventions per theme.
import * as THREE from "three";

const checker = (a, b) => `conic-gradient(${b} 0 25%, ${a} 0 50%, ${b} 0 75%, ${a} 0)`;

// light/dark/frame: { tex, color, roughness, metalness, env }
//   tex: TextureBank spec (see textures.js); colour multiplies the texture.
export const BOARD_THEME_DEFS = [
  {
    id: "walnut", name: "Walnut", swatch: checker("#e2c99a", "#6b4428"),
    light: { tex: "photo:maple", color: "#ffffff", roughness: 0.42, env: 0.55 },
    dark: { tex: "photo:walnut", color: "#ffffff", roughness: 0.4, env: 0.55 },
    frame: { tex: "photo:espresso", color: "#ffffff", roughness: 0.34, env: 0.7 },
    bg: "#15100c", table: "#28352b", coord: "#e8d7b2", exposure: 0.74,
    hl: {
      last: "rgba(255,212,60,0.42)", sel: "rgba(255,212,60,0.58)", pre: "rgba(236,92,74,0.55)",
      dot: "rgba(24,14,6,0.42)", ring: "rgba(24,14,6,0.42)", hover: "rgba(255,248,230,0.9)",
      check: "rgba(255,38,24,1)", cursor: "rgba(110,175,255,0.95)",
    },
  },
  {
    id: "tournament", name: "Tournament", swatch: checker("#eeeed2", "#769656"),
    light: { tex: "grain:3", color: "#eeeed2", roughness: 0.6, env: 0.35 },
    dark: { tex: "grain:4", color: "#769656", roughness: 0.6, env: 0.35 },
    frame: { tex: "photo:espresso", color: "#ffffff", roughness: 0.36, env: 0.6 },
    bg: "#121410", table: "#2a3326", coord: "#e8d7b2", exposure: 0.6,
    hl: {
      last: "rgba(255,255,51,0.5)", sel: "rgba(255,255,51,0.62)", pre: "rgba(244,64,60,0.55)",
      dot: "rgba(0,0,0,0.2)", ring: "rgba(0,0,0,0.2)", hover: "rgba(255,255,255,0.8)",
      check: "rgba(255,30,20,1)", cursor: "rgba(80,150,255,0.95)",
    },
  },
  {
    id: "classic", name: "Classic", swatch: checker("#f0d9b5", "#b58863"),
    light: { tex: "woodgrain:5", color: "#f0d9b5", roughness: 0.46, env: 0.45 },
    dark: { tex: "woodgrain:6", color: "#b58863", roughness: 0.46, env: 0.45 },
    frame: { tex: "wood:espresso", color: "#a07a5c", roughness: 0.4, env: 0.55 },
    bg: "#17110d", table: "#33281e", coord: "#f0d9b5", exposure: 0.6,
    hl: {
      last: "rgba(155,199,0,0.41)", sel: "rgba(20,85,30,0.5)", pre: "rgba(20,30,85,0.5)",
      dot: "rgba(20,85,30,0.55)", ring: "rgba(20,85,30,0.55)", hover: "rgba(20,85,30,0.75)",
      check: "rgba(255,30,20,1)", cursor: "rgba(60,110,230,0.95)",
    },
  },
  {
    id: "ocean", name: "Ocean", swatch: checker("#dee3e6", "#8ca2ad"),
    light: { tex: "grain:7", color: "#dee3e6", roughness: 0.5, env: 0.4 },
    dark: { tex: "grain:8", color: "#8ca2ad", roughness: 0.5, env: 0.4 },
    frame: { tex: "grain:9", color: "#3a4a56", roughness: 0.55, env: 0.5 },
    bg: "#0e1317", table: "#1f2b35", coord: "#c9d6de", exposure: 0.6,
    hl: {
      last: "rgba(255,236,80,0.46)", sel: "rgba(255,236,80,0.6)", pre: "rgba(240,90,90,0.55)",
      dot: "rgba(8,28,48,0.3)", ring: "rgba(8,28,48,0.3)", hover: "rgba(255,255,255,0.85)",
      check: "rgba(255,30,20,1)", cursor: "rgba(40,120,255,0.95)",
    },
  },
  {
    id: "marble", name: "Marble", swatch: checker("#ecebe7", "#5b7a6c"),
    light: { tex: "marble:carrara", color: "#ffffff", roughness: 0.24, env: 0.7 },
    dark: { tex: "marble:verde", color: "#ffffff", roughness: 0.24, env: 0.7 },
    frame: { tex: "marble:nero", color: "#ffffff", roughness: 0.22, env: 0.8 },
    bg: "#121212", table: "#2c2925", coord: "#d8d6d0", exposure: 0.6,
    hl: {
      last: "rgba(255,210,70,0.44)", sel: "rgba(255,210,70,0.6)", pre: "rgba(236,92,74,0.55)",
      dot: "rgba(0,0,0,0.28)", ring: "rgba(0,0,0,0.28)", hover: "rgba(255,255,255,0.9)",
      check: "rgba(255,30,20,1)", cursor: "rgba(80,150,255,0.95)",
    },
  },
  {
    id: "midnight", name: "Midnight", swatch: checker("#8e98ab", "#4a5468"),
    light: { tex: "grain:11", color: "#8e98ab", roughness: 0.48, env: 0.45 },
    dark: { tex: "grain:12", color: "#4a5468", roughness: 0.48, env: 0.45 },
    frame: { tex: "grain:13", color: "#1b2029", roughness: 0.4, env: 0.55 },
    bg: "#0a0c10", table: "#161b24", coord: "#a9b3c6", exposure: 0.62,
    hl: {
      last: "rgba(96,170,255,0.42)", sel: "rgba(96,170,255,0.58)", pre: "rgba(244,114,182,0.5)",
      dot: "rgba(255,255,255,0.24)", ring: "rgba(255,255,255,0.24)", hover: "rgba(255,255,255,0.85)",
      check: "rgba(255,40,40,1)", cursor: "rgba(255,200,80,0.95)",
    },
  },
];

// w/b: material spec. kind "physical" enables clearcoat; glass = cheap translucency
// (alpha + fresnel rim, no transmission pass). felt: base pad colour (null = none).
// shadows: false skips shadow-map casting; blob scales the soft contact shadow.
export const PIECE_THEME_DEFS = [
  {
    id: "boxwood", name: "Boxwood", swatch: "linear-gradient(135deg,#ecdcc0 0 50%,#2b1e16 50% 100%)",
    w: { color: "#e8d5b2", tex: "piecegrain:light", roughness: 0.42, env: 0.5 },
    b: { color: "#3a2a20", tex: "piecegrain:dark", roughness: 0.3, env: 0.95 },
    felt: "#2c5a3a",
  },
  {
    id: "lacquer", name: "Lacquer", swatch: "linear-gradient(135deg,#f5f2ec 0 50%,#141414 50% 100%)",
    w: { kind: "physical", color: "#f2efe8", roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08, env: 0.8 },
    b: { kind: "physical", color: "#151515", roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, env: 1.0 },
    felt: "#7a1f26",
  },
  {
    id: "marble", name: "Marble", swatch: "linear-gradient(135deg,#f3efe6 0 50%,#26282c 50% 100%)",
    w: { color: "#ffffff", tex: "marble:ivory", roughness: 0.15, env: 0.85 },
    b: { color: "#ffffff", tex: "marble:onyx", roughness: 0.16, env: 1.0 },
    felt: "#1e1e1e",
  },
  {
    id: "metal", name: "Chrome", swatch: "linear-gradient(135deg,#eef0f3 0 50%,#3d4148 50% 100%)",
    w: { color: "#eef0f4", metalness: 1, roughness: 0.17, env: 1.15 },
    b: { color: "#4a4e57", metalness: 1, roughness: 0.3, env: 1.1 },
    felt: "#1f2630",
  },
  {
    id: "gilded", name: "Gold & Pewter", swatch: "linear-gradient(135deg,#e8b94e 0 50%,#62656d 50% 100%)",
    w: { color: "#efc25a", metalness: 1, roughness: 0.24, env: 1.1 },
    b: { color: "#5e626a", metalness: 1, roughness: 0.34, env: 1.0 },
    felt: "#4a1420",
  },
  {
    id: "glass", name: "Glass", swatch: "linear-gradient(135deg,rgba(225,236,255,.85) 0 50%,rgba(26,34,48,.9) 50% 100%)",
    w: { kind: "physical", glass: true, color: "#eef5ff", roughness: 0.1, opacity: 0.55, env: 1.6 },
    b: { kind: "physical", glass: true, color: "#1b2536", roughness: 0.08, opacity: 0.72, env: 1.5 },
    felt: null, shadows: false, blob: 0.45, // translucent: no felt pad, no opaque shadow map caster
  },
];

export const BOARD_THEMES = BOARD_THEME_DEFS.map(({ id, name, swatch }) => ({ id, name, swatch }));
export const PIECE_THEMES = PIECE_THEME_DEFS.map(({ id, name, swatch }) => ({ id, name, swatch }));

export const boardThemeDef = (id) => BOARD_THEME_DEFS.find(t => t.id === id) || BOARD_THEME_DEFS[0];
export const pieceThemeDef = (id) => PIECE_THEME_DEFS.find(t => t.id === id) || PIECE_THEME_DEFS[0];

// glass: opacity rises toward grazing angles (fresnel), so silhouettes stay crisp and readable
function glassFresnel(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <opaque_fragment>",
    `{
      float fres = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
      fres = fres * fres * fres;
      diffuseColor.a = mix(diffuseColor.a, 1.0, clamp(fres * 0.9, 0.0, 0.9));
    }
    #include <opaque_fragment>`);
}

// spec -> material. fade: transparent copy used by the capture fade-out.
export function makePieceMaterial(spec, bank, fade = false) {
  const params = {
    color: new THREE.Color(spec.color),
    roughness: spec.roughness ?? 0.4,
    metalness: spec.metalness ?? 0,
    envMapIntensity: spec.env ?? 1,
  };
  if (spec.tex) params.map = bank.get(spec.tex);
  let mat;
  if (spec.kind === "physical") {
    mat = new THREE.MeshPhysicalMaterial({
      ...params,
      clearcoat: spec.clearcoat ?? 0,
      clearcoatRoughness: spec.clearcoatRoughness ?? 0.1,
    });
  } else {
    mat = new THREE.MeshStandardMaterial(params);
  }
  if (spec.glass) {
    mat.transparent = true;
    mat.opacity = spec.opacity ?? 0.5;
    mat.depthWrite = false;
    mat.onBeforeCompile = glassFresnel;
    mat.customProgramCacheKey = () => "glass-fresnel";
  }
  if (fade) {
    mat.transparent = true;
    mat.depthWrite = false;
    mat.userData.baseOpacity = mat.opacity;
  }
  return mat;
}

// CSS colour -> [r, g, b, a] with rgb in linear space (what shaders expect). Cached.
const _colorCache = new Map();
const _c = new THREE.Color();
export function parseColor(css) {
  if (Array.isArray(css)) return css;
  const key = String(css || "").trim();
  const hit = _colorCache.get(key);
  if (hit) return hit;
  let r = 1, g = 1, b = 1, a = 1;
  const s = key.toLowerCase();
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(ch => ch + ch).join("");
    r = parseInt(h.slice(0, 2), 16) / 255; g = parseInt(h.slice(2, 4), 16) / 255; b = parseInt(h.slice(4, 6), 16) / 255;
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    _c.setRGB(r, g, b, THREE.SRGBColorSpace);
  } else if ((m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/))) {
    const parts = m[2].replace(/\//g, " ").replace(/,/g, " ").split(/\s+/).filter(Boolean);
    const num = (p, scale) => (p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p) / scale);
    if (parts.length > 3) a = num(parts[3], 1);
    if (m[1].startsWith("rgb")) {
      _c.setRGB(num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), THREE.SRGBColorSpace);
    } else {
      _c.setHSL((parseFloat(parts[0]) / 360) % 1, num(parts[1], 100), num(parts[2], 100), THREE.SRGBColorSpace);
    }
  } else {
    try { _c.setStyle(s || "#fff"); } catch { _c.setRGB(1, 1, 1); }
  }
  const out = [_c.r, _c.g, _c.b, Math.max(0, Math.min(1, isNaN(a) ? 1 : a))];
  if (_colorCache.size > 512) _colorCache.clear();
  _colorCache.set(key, out);
  return out;
}

// user drawing brushes (lichess convention: none = green, Shift = red, Alt = blue, Ctrl/Meta = orange)
export const BRUSHES = {
  green: "rgba(38,160,58,0.82)",
  red: "rgba(214,48,48,0.82)",
  blue: "rgba(38,110,230,0.82)",
  orange: "rgba(240,150,10,0.85)",
};
