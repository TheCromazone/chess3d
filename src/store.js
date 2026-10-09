// Persistent settings, profile, ratings, and game archive (localStorage, all reads guarded).
const KEY = { settings: "chess3d.settings", profile: "chess3d.profile", games: "chess3d.games", reviews: "chess3d.reviews", resume: "chess3d.resume", daily: "chess3d.daily", social: "chess3d.social", vgames: "chess3d.vgames" };
const MAX_GAMES = 300;
const MAX_REVIEWS = 12;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const DEFAULT_SETTINGS = {
  appearance: "dark",     // "dark" | "light" | "system"
  view: "3d",             // "3d" | "2d"
  boardTheme3d: "walnut",
  pieceTheme3d: "boxwood",
  boardTheme2d: "green",
  pieceTheme2d: "cburnett",
  cameraMode: "3d",       // 3D board camera: "3d" orbit | "top"
  coords: true,
  animMs: 220,
  showLegal: true,
  highlightLast: true,
  premoves: true,
  autoQueen: false,
  dragMoves: true,
  confirmResign: true,
  sound: true,
  notation: "figurine",   // "figurine" | "san"
  lowTimeWarning: true,
  evalBarInAnalysis: true,
};

const listeners = new Set();
let settings = { ...DEFAULT_SETTINGS, ...read(KEY.settings, {}) };

export function getSettings() { return settings; }
export function setSettings(patch) {
  settings = { ...settings, ...patch };
  write(KEY.settings, settings);
  for (const fn of listeners) fn(settings, patch);
}
export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// after a wholesale replace (import, erase) every setting counts as changed: view, theme, sound...
function notifyAllSettings() { for (const fn of listeners) fn(settings, { ...settings }); }

// ---------- profile ----------
const AVATAR_BGS = ["#2f6b4f", "#6b4a2f", "#3b4f7a", "#7a3b4f", "#5a4f2a", "#2a5a5a"];
const DEFAULT_PROFILE = () => ({
  name: "Guest" + Math.floor(1000 + Math.random() * 9000),
  avatar: { emoji: "♞", bg: AVATAR_BGS[Math.floor(Math.random() * AVATAR_BGS.length)] },
  country: "",                 // ISO 3166 code, shown as a flag on your profile
  about: "",                   // a line about yourself
  created: Date.now(),
  ratings: {
    bots: { r: 800, n: 0, hist: [] },
    puzzle: { r: 1200, n: 0, hist: [] },
    bullet: { r: 1200, n: 0, hist: [] },
    blitz: { r: 1200, n: 0, hist: [] },
    rapid: { r: 1200, n: 0, hist: [] },
  },
  rush: { "3": 0, "5": 0, survival: 0 },
  puzzles: { solved: 0, failed: 0, streak: 0, bestStreak: 0, seen: [] },
  daily: { solved: {}, streak: 0, last: null },
  lessons: {},            // lessonId -> true
  drills: {},             // drillId -> true
  openings: {},           // openingId -> times completed
  botsBeaten: {},         // botId -> true
  achievements: {},       // id -> timestamp
  stats: { games: 0, wins: 0, losses: 0, draws: 0 },
  variants: {},           // variant -> { r, n, hist }: rated games against random opponents
});

let profile = null;
export function getProfile() {
  if (!profile) {
    const d = DEFAULT_PROFILE();
    const p = read(KEY.profile, null);
    profile = p ? deepMerge(d, p) : d;
    if (!p) write(KEY.profile, profile);
  }
  return profile;
}
export function saveProfile() { write(KEY.profile, profile); }
export function updateProfile(fn) { fn(getProfile()); saveProfile(); }

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (k in base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]))
      ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

// Elo update; K shrinks as the player accumulates games.
export function eloDelta(r, opp, score, n) {
  const k = n < 10 ? 40 : n < 30 ? 32 : 20;
  const exp = 1 / (1 + Math.pow(10, (opp - r) / 400));
  return Math.round(k * (score - exp));
}

export function applyRating(cat, opp, score) {
  const p = getProfile();
  const slot = p.ratings[cat];
  const d = eloDelta(slot.r, opp, score, slot.n);
  slot.r = Math.max(100, slot.r + d);
  slot.n++;
  slot.hist.push([Date.now(), slot.r]);
  if (slot.hist.length > 200) slot.hist.shift();
  saveProfile();
  return d;
}

// Variant ratings start at 1500, like chess.com's
export const VARIANT_START = 1500;
export function variantRating(variant) {
  const v = getProfile().variants[variant];
  return v ? v.r : VARIANT_START;
}
export function applyVariantRating(variant, opp, score) {
  const p = getProfile();
  const slot = p.variants[variant] || (p.variants[variant] = { r: VARIANT_START, n: 0, hist: [] });
  const d = eloDelta(slot.r, opp, score, slot.n);
  slot.r = Math.max(100, slot.r + d);
  slot.n++;
  slot.hist.push([Date.now(), slot.r]);
  if (slot.hist.length > 200) slot.hist.shift();
  saveProfile();
  return d;
}

// Variant games are kept apart from the main archive (which reviews and analyses with standard
// rules): each record keeps the position after every move, so it replays with any rules.
const MAX_VARIANT_GAMES = 40;
export function getVariantGames() { return read(KEY.vgames, []); }
export function saveVariantGame(rec) {
  const list = getVariantGames().filter((g) => g.id !== rec.id);
  list.unshift(rec);
  if (list.length > MAX_VARIANT_GAMES) list.length = MAX_VARIANT_GAMES;
  while (!write(KEY.vgames, list) && list.length > 1) list.length = Math.floor(list.length * 0.8);
  const p = getProfile();
  p.stats.games++;
  if (rec.myResult === "win") p.stats.wins++; else if (rec.myResult === "loss") p.stats.losses++; else if (rec.myResult === "draw") p.stats.draws++;
  saveProfile();
}

export function timeClass(tcKey) {
  if (!tcKey || tcKey === "inf" || /d$/.test(tcKey)) return null;   // unlimited and daily games
  const [m, inc] = tcKey.split("+").map(Number);
  const est = m * 60 + inc * 40;   // chess.com: estimated duration over 40 moves
  if (est < 180) return "bullet";
  if (est < 600) return "blitz";
  return "rapid";
}

// ---------- archive ----------
export function getGames() { return read(KEY.games, []); }
export function getGame(id) { return getGames().find(g => g.id === id) || null; }
export function saveGame(rec) {
  const games = getGames().filter(g => g.id !== rec.id);
  games.unshift(rec);
  if (games.length > MAX_GAMES) games.length = MAX_GAMES;
  if (write(KEY.games, games)) return true;
  // storage full: drop cached reviews first, then the oldest games, until the new game fits
  try { localStorage.removeItem(KEY.reviews); } catch { /* noop */ }
  while (games.length > 1) {
    if (write(KEY.games, games)) return true;
    games.length = Math.max(1, Math.floor(games.length * 0.8));
  }
  return write(KEY.games, games);
}
export function patchGame(id, patch) {
  const games = getGames();
  const g = games.find(x => x.id === id);
  if (!g) return;
  Object.assign(g, patch);
  write(KEY.games, games);
}
export function newGameId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export function getCachedReview(id) { return (read(KEY.reviews, {}))[id] || null; }
export function cacheReview(id, review) {
  const all = read(KEY.reviews, {});
  all[id] = { ...review, _at: Date.now() };
  const ids = Object.keys(all).sort((a, b) => all[b]._at - all[a]._at);
  for (const old of ids.slice(MAX_REVIEWS)) delete all[old];
  if (!write(KEY.reviews, all)) { write(KEY.reviews, { [id]: all[id] }); }
}

// ---------- daily (correspondence) games: room + seat kept on this device ----------
export function getDailyGames() { return read(KEY.daily, []); }
export function getDaily(room) { return getDailyGames().find(e => e.room === room) || null; }
export function upsertDaily(entry) {
  const list = getDailyGames();
  const i = list.findIndex(e => e.room === entry.room);
  const merged = { ...(i >= 0 ? list[i] : { created: Date.now() }), ...entry, updated: Date.now() };
  if (i >= 0) list.splice(i, 1);
  list.unshift(merged);
  write(KEY.daily, list.slice(0, 50));
  return merged;
}
export function removeDaily(room) { write(KEY.daily, getDailyGames().filter(e => e.room !== room)); }

// ---------- social identity: this device's key for friends, messages and clubs ----------
export function getSocialId() { const v = read(KEY.social, null); return v && v.id && v.secret ? v : null; }
export function setSocialId(v) { if (v) write(KEY.social, v); else { try { localStorage.removeItem(KEY.social); } catch { /* noop */ } } }

// ---------- resumable bot game ----------
export function getResume() { return read(KEY.resume, null); }
export function setResume(v) { if (v) write(KEY.resume, v); else { try { localStorage.removeItem(KEY.resume); } catch { /* noop */ } } }

// ---------- achievements ----------
export const ACHIEVEMENTS = [
  { id: "first-game", name: "First moves", desc: "Finish your first game", icon: "♙" },
  { id: "vision-20", name: "Board sight", desc: "Find 20 squares in a Vision round", icon: "👁" },
  { id: "solo-chess", name: "Last one standing", desc: "Solve a Solo Chess puzzle", icon: "♛" },
  { id: "first-win", name: "Winner", desc: "Win a game", icon: "♔" },
  { id: "beat-beginner", name: "Off the ground", desc: "Beat a Beginner bot", icon: "🥉" },
  { id: "beat-intermediate", name: "Climbing", desc: "Beat an Intermediate bot", icon: "🥈" },
  { id: "beat-advanced", name: "Strong club player", desc: "Beat an Advanced bot", icon: "🥇" },
  { id: "beat-master", name: "Master slayer", desc: "Beat a Master bot", icon: "🏆" },
  { id: "checkmate-pawn", name: "Humble hero", desc: "Deliver checkmate with a pawn", icon: "♟" },
  { id: "checkmate-knight", name: "Horse play", desc: "Deliver checkmate with a knight", icon: "♞" },
  { id: "underpromote", name: "Modesty", desc: "Win a game after promoting to something other than a queen", icon: "♖" },
  { id: "puzzle-10", name: "Tactician", desc: "Solve 10 puzzles", icon: "🧩" },
  { id: "puzzle-100", name: "Puzzle addict", desc: "Solve 100 puzzles", icon: "🧠" },
  { id: "puzzle-streak-5", name: "On fire", desc: "Solve 5 puzzles in a row", icon: "🔥" },
  { id: "rush-15", name: "Rusher", desc: "Score 15 in Puzzle Rush", icon: "⚡" },
  { id: "rush-30", name: "Speed demon", desc: "Score 30 in Puzzle Rush", icon: "🚀" },
  { id: "daily-3", name: "Habit", desc: "Solve the daily puzzle 3 days in a row", icon: "📅" },
  { id: "review-1", name: "Student of the game", desc: "Review a game", icon: "🔍" },
  { id: "brilliant", name: "Brilliant!", desc: "Play a brilliant move", icon: "💎" },
  { id: "accuracy-90", name: "Precision", desc: "Score 90%+ accuracy in a game of 20+ moves", icon: "🎯" },
  { id: "lesson-all", name: "Graduate", desc: "Complete every lesson", icon: "🎓" },
  { id: "drill-5", name: "Endgame technician", desc: "Complete 5 endgame drills", icon: "♚" },
  { id: "online-win", name: "Out in the world", desc: "Win an online game", icon: "🌍" },
  { id: "arena-podium", name: "On the podium", desc: "Finish top three in an arena", icon: "🏅" },
  { id: "arena-win", name: "Arena champion", desc: "Win an arena", icon: "👑" },
  { id: "battle-win", name: "Battle tested", desc: "Win a Puzzle Battle", icon: "⚔️" },
];

const achListeners = new Set();
export function onAchievement(fn) { achListeners.add(fn); }
export function unlock(id) {
  const p = getProfile();
  if (p.achievements[id]) return false;
  p.achievements[id] = Date.now();
  saveProfile();
  const a = ACHIEVEMENTS.find(x => x.id === id);
  if (a) for (const fn of achListeners) fn(a);
  return true;
}

// ---------- export / import ----------
export function exportAll() {
  return JSON.stringify({ v: 1, settings, profile: getProfile(), games: getGames(), vgames: getVariantGames(), social: getSocialId() });
}
export function importAll(json) {
  const data = JSON.parse(json);
  if (!data || data.v !== 1) throw new Error("Not a Chess 3D backup file");
  if (data.settings) { settings = { ...DEFAULT_SETTINGS, ...data.settings }; write(KEY.settings, settings); notifyAllSettings(); }
  if (data.profile) { profile = deepMerge(DEFAULT_PROFILE(), data.profile); saveProfile(); }
  if (Array.isArray(data.games)) write(KEY.games, data.games.slice(0, MAX_GAMES));
  if (Array.isArray(data.vgames)) write(KEY.vgames, data.vgames.slice(0, MAX_VARIANT_GAMES));
  if (data.social && data.social.id && data.social.secret) setSocialId(data.social);
}
export function resetAll() {
  for (const k of Object.values(KEY)) { try { localStorage.removeItem(k); } catch { /* noop */ } }
  settings = { ...DEFAULT_SETTINGS };
  profile = null;
  notifyAllSettings();
}
