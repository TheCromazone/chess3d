// Social client: friends and presence, direct messages and challenges, clubs, and the global
// leaderboard, served by the game's Higgsfield project (server/social.ts). There's no sign-in:
// this device registers once and keeps a private key; the 8-character friend code is what you share.
import { getProfile, getSocialId, setSocialId } from "../store.js";
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
    // the server no longer knows this key (deleted elsewhere): forget it so the page offers to join again
    setSocialId(null);
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
  await beat();
  return r;
}

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
  const playing = !!live.room || !!document.getElementById("app")?.classList.contains("in-game");
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
}

// a challenge message body is JSON: { room, tc, mode }
export function parseChallenge(m) {
  try { const c = JSON.parse(m.body); return c && c.room ? c : null; } catch { return null; }
}
export function challengeRoom(mode) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  return (mode === "daily" ? "daily-" : "c-") + id;
}
