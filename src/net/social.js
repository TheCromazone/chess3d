// Social client: friends and presence, direct messages and challenges, clubs, and the global
// leaderboard, served by the game's Higgsfield project (server/social.ts). There's no sign-in:
// this device registers once and keeps a private key; the 8-character friend code is what you share.
import { getProfile, updateProfile, getSocialId, setSocialId, exportAll, importAll } from "../store.js";
import { live } from "./room.js";

const HOST = "https://timely-ibis-513.higgsfield.app";
const BASE = (/(^|\.)higgsfield\.app$/.test(location.hostname) ? "" : HOST) + "/api/social";
const BEAT_VISIBLE_MS = 20000;
const BEAT_HIDDEN_MS = 60000;
export const CATS = ["blitz", "bullet", "rapid", "puzzle", "bots"];
export const LIVE_CHALLENGE_MS = 15 * 60000;   // a live challenge nobody answered is stale after this

export class SocialError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function registered() { return !!getSocialId(); }
export function myId() { const s = getSocialId(); return s ? s.id : null; }
export function myCode() { const s = getSocialId(); return s ? s.code : null; }

// names on the server are 2-16 letters, numbers or _
export function socialName(name) {
  const n = String(name || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  return n.length >= 2 ? n : n ? n + "_" : "Guest";
}

// "K7M2QX9P" -> "K7M2 QX9P"; input in any case, with spaces or dashes
export function fmtCode(code) { return code ? code.slice(0, 4) + " " + code.slice(4) : ""; }
export function cleanCode(text) { return String(text || "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8); }

// the last answer to each GET, so screens can draw at once and refresh behind it
const cache = new Map();
export function cached(path) { return cache.get(path) || null; }

export async function api(method, path, body) {
  const id = getSocialId();
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (id) headers.Authorization = "Bearer " + id.secret;
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  } catch {
    throw new SocialError(0, "Can't reach the Chess 3D server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && id) {
    // the server no longer knows this key (signed out or deleted elsewhere): forget it here too
    setSocialId(null);
    state.signedOut = true;
    reset();
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error[0].toUpperCase() + data.error.slice(1) + "." : `The server answered ${res.status}.`;
    throw new SocialError(res.status, msg);
  }
  if (method === "GET") cache.set(path, data);
  return data;
}

export async function join() {
  const p = getProfile();
  const r = await api("POST", "/register", { name: socialName(p.name), avatar: p.avatar });
  setSocialId({ id: r.id, secret: r.secret, code: r.code, created: Date.now() });
  // names are unique across players: adopt the one the server gave us
  if (r.name !== p.name) updateProfile(pr => { pr.name = r.name; });
  await beat();
  backupNow().catch(() => {});
  return r;
}

// ---------- account: other devices, recovery key, cloud backup ----------
// Sign in with a one-time code made on another device; that profile's backup replaces local data.
export async function claimLink(code) {
  const r = await api("POST", "/link/claim", { code: cleanCode(code) });
  setSocialId({ id: r.id, secret: r.secret, code: r.code, created: Date.now() });
  return restoreBackup();
}
export function makeLinkCode() { return api("POST", "/link/create", {}); }

// the recovery key is this device's secret, shown in groups of eight
export function recoveryKey() { const s = getSocialId(); return s ? s.secret.match(/.{8}/g).join(" ") : null; }
export async function useRecoveryKey(text) {
  const secret = String(text || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (secret.length !== 64) throw new SocialError(400, "A recovery key has 64 characters: digits and the letters a to f.");
  setSocialId({ id: "pending", secret, code: null });
  try {
    const r = await api("GET", "/me");
    setSocialId({ id: r.me.id, secret, code: r.me.code, created: Date.now() });
  } catch (e) {
    setSocialId(null);
    throw e.status === 401 ? new SocialError(401, "That recovery key doesn't match a profile.") : e;
  }
  return restoreBackup();
}

async function restoreBackup() {
  const d = await api("GET", "/backup");
  if (!d.data) { await beat(); return false; }
  importAll(d.data);            // the backup has no social key, so this device keeps its own
  try { localStorage.setItem("chess3d.backupAt", String(d.updated)); } catch { /* noop */ }
  await beat();
  return true;
}

function checksum(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${h}:${text.length}`;
}
// Upload profile, ratings, settings and games (not the key) when they've changed.
export async function backupNow(force = false) {
  if (!registered()) return null;
  const data = JSON.parse(exportAll());
  delete data.social;
  let text = JSON.stringify(data);
  // the server keeps up to ~1.8 MB; very long archives send their newest games
  while (text.length > 1_700_000 && Array.isArray(data.games) && data.games.length > 10) {
    data.games = data.games.slice(0, Math.floor(data.games.length * 0.8));
    text = JSON.stringify(data);
  }
  const sum = checksum(text);
  let prev = null;
  try { prev = localStorage.getItem("chess3d.backupSum"); } catch { /* noop */ }
  if (!force && sum === prev) return null;
  const r = await api("POST", "/backup", { data: text });
  try { localStorage.setItem("chess3d.backupSum", sum); localStorage.setItem("chess3d.backupAt", String(r.updated)); } catch { /* noop */ }
  return r.updated;
}
export function lastBackup() { try { return Number(localStorage.getItem("chess3d.backupAt")) || null; } catch { return null; } }

// sign every other device out; this one gets a new key (so the old recovery key stops working)
export async function signOutOthers() {
  const r = await api("POST", "/devices/reset", {});
  const id = getSocialId();
  setSocialId({ ...id, secret: r.secret });
}
// forget the key on this device only; the profile stays (sign back in with a code or recovery key)
export function signOutHere() { setSocialId(null); reset(); }

export async function leave() {
  if (registered()) await api("POST", "/delete", {});
  setSocialId(null);
  reset();
}

// ---------- live state: presence heartbeat, unread counts, notifications ----------
const state = { me: null, unread: 0, requests: 0, offline: false };
const listeners = new Set();
const notified = new Set();   // message ids already shown as a notification
let firstBeat = true;
let notifier = null;
let timer = null;

export function socialState() { return state; }
export function onSocial(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } } }
function reset() { state.me = null; state.unread = 0; state.requests = 0; firstBeat = true; cache.clear(); emit(); }

// notify(message) is called for each new direct message or challenge (set by the app shell)
export function setNotifier(fn) { notifier = fn; }

export async function beat() {
  if (!registered()) return;
  const p = getProfile();
  const ratings = {};
  for (const c of CATS) ratings[c] = { r: p.ratings[c].r, n: p.ratings[c].n };
  const playing = !!live.room || live.busy;
  let r;
  try {
    r = await api("POST", "/heartbeat", { status: playing ? "playing" : "online", room: live.room, name: socialName(p.name), avatar: p.avatar, ratings, games: p.stats.games });
  } catch {
    state.offline = true;
    emit();
    return;
  }
  state.offline = false;
  state.me = r.me;
  // a rename to a taken name doesn't go through: keep this device in step with what others see
  if (r.me && r.me.name !== socialName(p.name)) { state.nameTaken = socialName(p.name); updateProfile(pr => { pr.name = r.me.name; }); }
  state.unread = r.unread;
  state.requests = r.requests;
  // the newest unread messages: on the first beat after loading only fresh live challenges pop up
  const fresh = (r.latest || []).filter(m => !notified.has(m.id)).reverse();
  for (const m of fresh) {
    notified.add(m.id);
    if (firstBeat && !(m.kind === "challenge" && Date.now() - m.created < LIVE_CHALLENGE_MS)) continue;
    if (notifier) { try { notifier(m); } catch (e) { console.error(e); } }
  }
  firstBeat = false;
  emit();
}

// runs for the life of the page; beats faster while the tab is visible
export function startHeartbeat() {
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { await beat(); schedule(); }, document.hidden ? BEAT_HIDDEN_MS : BEAT_VISIBLE_MS);
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { beat(); schedule(); } });
  beat().finally(schedule);
  // settings, puzzle progress and the like change outside games too: back up every few minutes
  setInterval(() => { if (!document.hidden) backupNow().catch(() => {}); }, 5 * 60000);
}

// finished games go on your profile (online and bot games; the server keeps the last 30)
export function shareGame(rec) {
  if (!registered() || !rec || !["online", "bot"].includes(rec.mode) || !rec.moves || !rec.moves.length) return;
  const side = (p) => ({ name: p.name, rating: p.rating });
  api("POST", "/games", { game: {
    id: rec.id, white: side(rec.white), black: side(rec.black), result: rec.result, reason: rec.reason, tc: rec.tc, mode: rec.mode,
    variant: rec.variant, myColor: rec.myColor, startFen: rec.startFen, opening: rec.opening, date: rec.date, moves: rec.moves,
  } }).catch(() => {});
  // and the whole profile follows you to your other devices
  setTimeout(() => backupNow().catch(() => {}), 1500);
}

// a challenge message body is JSON: { room, tc, mode }
export function parseChallenge(m) {
  try { const c = JSON.parse(m.body); return c && c.room ? c : null; } catch { return null; }
}
export function challengeRoom(mode) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  return (mode === "daily" ? "daily-" : "c-") + id;
}
