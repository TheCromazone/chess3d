// Room-server client. The server (logic.js on the room kernel) is the referee; clients send
// actions and render the latest state. Player identity rides in the playerId string so the
// opponent can show our name and rating without any account system.
// The game's Higgsfield project hosts the rooms (Durable Objects at /ws/<room>).
const PLATFORM_HOST = "timely-ibis-513.higgsfield.app";

export function roomUrl(room) {
  // served from the Higgsfield project itself: rooms live on the same origin
  if (/(^|\.)higgsfield\.app$/.test(location.hostname)) {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + room;
  }
  return "wss://" + PLATFORM_HOST + "/ws/" + room;
}

// "p-k3j2x9.MagnusFan.1450", plus ".K7M2QX9P" (a friend code) when social is on, so the
// opponent can add you as a friend after the game
export function makePlayerId(name, rating, code) {
  const clean = String(name || "Guest").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16) || "Guest";
  const tag = /^[0-9A-Z]{8}$/.test(code || "") ? "." + code : "";
  return `p-${Math.random().toString(36).slice(2, 8)}.${clean}.${Math.round(rating || 1200)}${tag}`;
}
export function parsePlayerId(id) {
  const m = /^p-[a-z0-9]+\.([A-Za-z0-9_]{1,16})\.(\d{2,4})(?:\.([0-9A-Z]{8}))?$/.exec(id || "");
  return m ? { name: m[1], rating: Number(m[2]), code: m[3] || null } : { name: "Opponent", rating: null, code: null };
}

export class RoomClient {
  constructor(room, playerId, { onState, onError, onStatus } = {}) {
    this.room = room;
    this.playerId = playerId;
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this.closed = false;
    this.last = null;
    this.retries = 0;
    this._connect();
  }
  _connect() {
    if (this.closed) return;
    this.onStatus("connecting");
    let ws;
    try { ws = new WebSocket(roomUrl(this.room)); } catch (e) { this.onError(String(e)); return; }
    this.ws = ws;
    ws.onopen = () => { this.retries = 0; this.onStatus("open"); this._send({ type: "join", playerId: this.playerId }); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "error") this.onError(msg.error || "error");
      else if (msg.type === "state") { this.last = msg; this.onState(msg); }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.onStatus("disconnected");
      const wait = Math.min(8000, 800 * Math.pow(1.6, this.retries++));
      setTimeout(() => this._connect(), wait);
    };
    ws.onerror = () => {};
  }
  _send(obj) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
  action(a) { return this._send({ type: "action", action: a }); }
  reset() { return this._send({ type: "reset" }); }
  close() {
    this.closed = true;
    try { this.ws && this.ws.close(); } catch { /* noop */ }
  }
  // re-route callbacks when ownership moves from the matchmaker to the game
  rebind(handlers) { Object.assign(this, handlers); if (this.last && handlers.onState) handlers.onState(this.last); }
}

// ---------- quick pairing ----------
// Searchers sweep numbered public rooms in a 2-minute bucket: join a room that has one waiting
// player (instant match), skip full or finished rooms, and otherwise wait in the first empty room.
// Ghost seats (players who left) are detected through the server's connected-socket count.
const BUCKET_MS = 120000;
const POOL_SIZE = 10;

export function findMatch(tcKey, playerId, onProgress = () => {}) {
  let cancelled = false;
  let client = null;
  let rolloverTimer = null;
  let sweepId = 0;              // a rollover starts a new sweep; older ones must stand down
  let resolveFn, rejectFn;
  const done = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

  const tcSlug = tcKey.replace("+", "p").replace(".", "_");
  const tryRoom = (bucket, i, id) => new Promise((resolve) => {
    const room = `pool-${tcSlug}-${bucket}-${i}`;
    let settled = false;
    let waitingHere = false;
    const finish = (outcome) => { if (!settled) { settled = true; resolve(outcome); } };
    const c = new RoomClient(room, playerId, {
      onState: (s) => {
        if (cancelled) { c.close(); return; }
        // superseded by a newer sweep: leave, so we never hold a second seat somewhere
        if (id !== sweepId && !settled) { c.close(); finish({ next: true }); return; }
        const seated = s.seats.includes(playerId);
        if (!seated) { c.close(); finish({ next: true }); return; }
        if (s.status === "over") { c.close(); finish({ next: true }); return; }
        if (s.status === "waiting") {
          if (!waitingHere) { waitingHere = true; onProgress({ phase: "waiting", room }); client = c; }
          return;
        }
        if (s.status === "playing") {
          if (s.connected < 2) {
            // opponent seat belongs to someone who already left
            setTimeout(() => {
              if (settled) return;
              if ((c.last && c.last.connected) < 2) { c.close(); finish({ next: true }); }
            }, 1500);
            return;
          }
          if (s.view && s.view.moves && s.view.moves.length) { c.close(); finish({ next: true }); return; }
          finish({ matched: true, room, client: c });
        }
      },
      onError: () => {},
    });
    // a room that never answers is skipped
    setTimeout(() => { if (!settled && !waitingHere) { c.close(); finish({ next: true }); } }, 6000);
    if (waitingHere) client = c;
  });

  const sweep = async () => {
    const id = ++sweepId;
    const bucket = Math.floor(Date.now() / BUCKET_MS);
    onProgress({ phase: "searching" });
    for (let i = 0; i < POOL_SIZE && !cancelled; i++) {
      const out = await tryRoom(bucket, i, id);
      if (cancelled || id !== sweepId) return;
      if (out.matched) { clearTimeout(rolloverTimer); resolveFn({ room: out.room, client: out.client }); return; }
      if (!out.next) return;        // waiting in this room; resolution comes from its onState
    }
    if (!cancelled && id === sweepId) rejectFn(new Error("No pairing room available right now."));
  };

  // when the bucket rolls over, re-enter the search so late arrivals still find us
  const scheduleRollover = () => {
    const ms = BUCKET_MS - (Date.now() % BUCKET_MS) + 500;
    rolloverTimer = setTimeout(() => {
      if (cancelled) return;
      if (client) { client.close(); client = null; }
      sweep().catch(rejectFn);
      scheduleRollover();
    }, ms);
  };

  sweep().catch(rejectFn);
  scheduleRollover();
  return {
    promise: done,
    cancel() { cancelled = true; clearTimeout(rolloverTimer); if (client) client.close(); },
  };
}
