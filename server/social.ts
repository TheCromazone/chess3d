/**
 * Social API for Chess 3D: friends + presence, direct messages and challenges, clubs, and a global
 * leaderboard — with no sign-in. A device registers once and gets a random secret (kept in its
 * localStorage); every request carries it as a bearer token, and only its SHA-256 is stored here.
 * Each player also gets a short public friend code to share.
 *
 * Mounted by worker.ts at /api/social/*. Storage is the app's D1 database; tables are created on
 * first use with CREATE TABLE IF NOT EXISTS (additive only, safe to run on every cold start).
 * Ratings are self-reported by devices, so the leaderboard is labelled that way in the client.
 */

export interface SocialStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
// what the room server knows about a finished (or unfinished) game, for arena results
export interface RoomState {
  status: string;
  seats: string[];
  result: { winner?: string; draw?: boolean; reason?: string } | null;
}
export interface SocialHooks {
  roomState?: (room: string) => Promise<RoomState | null>;
}

export interface SocialDB {
  prepare(sql: string): { bind(...values: unknown[]): SocialStatement };
  // runs the statements in order in one round trip (D1 sends them as a single transaction)
  batch(statements: SocialStatement[]): Promise<{ results?: unknown[] }[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS social_users (
     id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'online', games INTEGER NOT NULL DEFAULT 0,
     r_bullet INTEGER NOT NULL DEFAULT 1200, n_bullet INTEGER NOT NULL DEFAULT 0,
     r_blitz INTEGER NOT NULL DEFAULT 1200, n_blitz INTEGER NOT NULL DEFAULT 0,
     r_rapid INTEGER NOT NULL DEFAULT 1200, n_rapid INTEGER NOT NULL DEFAULT 0,
     r_puzzle INTEGER NOT NULL DEFAULT 1200, n_puzzle INTEGER NOT NULL DEFAULT 0,
     r_bots INTEGER NOT NULL DEFAULT 800, n_bots INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS social_friends (
     a TEXT NOT NULL, b TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (a, b))`,
  `CREATE INDEX IF NOT EXISTS social_friends_b ON social_friends (b, state)`,
  `CREATE TABLE IF NOT EXISTS social_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT, club TEXT,
     kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS social_messages_recipient ON social_messages (recipient, seen, id)`,
  `CREATE INDEX IF NOT EXISTS social_messages_club ON social_messages (club, id)`,
  `CREATE INDEX IF NOT EXISTS social_messages_sender ON social_messages (sender, created)`,
  `CREATE TABLE IF NOT EXISTS social_clubs (
     id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '',
     owner TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS social_club_members (
     club TEXT NOT NULL, member TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined INTEGER NOT NULL,
     PRIMARY KEY (club, member))`,
  `CREATE INDEX IF NOT EXISTS social_club_members_member ON social_club_members (member)`,
  `CREATE TABLE IF NOT EXISTS social_club_bans (club TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (club, member))`,
  `CREATE TABLE IF NOT EXISTS social_reg_log (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS social_arenas (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, tc TEXT NOT NULL, cat TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS social_arena_players (
     arena TEXT NOT NULL, uid TEXT NOT NULL, joined INTEGER NOT NULL,
     score INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
     streak INTEGER NOT NULL DEFAULT 0, form TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL DEFAULT 'idle', since INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
     pid TEXT NOT NULL DEFAULT '', room TEXT, last_opp TEXT, PRIMARY KEY (arena, uid))`,
  `CREATE INDEX IF NOT EXISTS social_arena_players_state ON social_arena_players (arena, state, since)`,
  `CREATE TABLE IF NOT EXISTS social_arena_games (
     room TEXT PRIMARY KEY, arena TEXT NOT NULL, a_uid TEXT NOT NULL, a_pid TEXT NOT NULL, b_uid TEXT NOT NULL, b_pid TEXT NOT NULL,
     created INTEGER NOT NULL, outcome TEXT, token TEXT)`,
  `CREATE TABLE IF NOT EXISTS social_battles (
     id TEXT PRIMARY KEY, seed INTEGER NOT NULL, created INTEGER NOT NULL, starts INTEGER NOT NULL DEFAULT 0,
     a_uid TEXT NOT NULL, a_score INTEGER NOT NULL DEFAULT 0, a_strikes INTEGER NOT NULL DEFAULT 0, a_done INTEGER NOT NULL DEFAULT 0, a_seen INTEGER NOT NULL DEFAULT 0,
     b_uid TEXT, b_score INTEGER NOT NULL DEFAULT 0, b_strikes INTEGER NOT NULL DEFAULT 0, b_done INTEGER NOT NULL DEFAULT 0, b_seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS social_battles_open ON social_battles (b_uid, a_seen)`,
];

// Puzzle Battle: two players race through the same seeded puzzles for three minutes
const BATTLE_MS = 180_000;
const BATTLE_COUNTDOWN_MS = 5_000;
const BATTLE_FRESH_MS = 8_000;

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so each one runs
// on its own and "duplicate column" errors are expected (and ignored) once it's in place.
const MIGRATIONS = [
  `ALTER TABLE social_users ADD COLUMN room TEXT`,     // the live game a player is in, for friends to watch
];

// Live arenas run on a fixed schedule so there's always one to join: every 30 minutes a new one
// starts (blitz on the hour, bullet on the half hour) and runs for 27 minutes.
const ARENA_SLOT_MS = 30 * 60_000;
const ARENA_LEN_MS = 27 * 60_000;
const ARENA_FRESH_MS = 8_000;     // a waiting player must have asked for a pairing this recently
const PID_RE = /^p-[a-z0-9]{1,12}\.[A-Za-z0-9_]{1,16}\.\d{2,4}(?:\.[0-9A-Z]{8})?$/;

function arenaForSlot(slot: number) {
  const starts = slot * ARENA_SLOT_MS;
  const blitz = slot % 2 === 0;
  return { id: `ar-${slot}`, name: blitz ? "Blitz Arena" : "Bullet Arena", tc: blitz ? "3+0" : "1+0", cat: blitz ? "blitz" : "bullet", starts, ends: starts + ARENA_LEN_MS };
}

const CATS = ["bullet", "blitz", "rapid", "puzzle", "bots"] as const;
type Cat = (typeof CATS)[number];
const ONLINE_MS = 90_000;
const CODE_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const NAME_RE = /^[A-Za-z0-9_]{2,16}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TC_RE = /^(\d{1,3}(?:\.5)?\+\d{1,2}|\d{1,2}d|inf)$/;
const EMOJI_MAX = 8;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface UserRow {
  id: string; code: string; name: string; avatar: string; created: number; last_seen: number; status: string; games: number;
  room?: string | null;
  r_bullet: number; n_bullet: number; r_blitz: number; n_blitz: number; r_rapid: number; n_rapid: number;
  r_puzzle: number; n_puzzle: number; r_bots: number; n_bots: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// -- helpers -------------------------------------------------------------------------------------

function randomString(len: number, abc = CODE_ABC): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += abc[b % abc.length];
  return out;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanAvatar(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const a = v as Record<string, unknown>;
  const emoji = [...str(a["emoji"], 16)].slice(0, 2).join("").slice(0, EMOJI_MAX);
  const bg = str(a["bg"], 7);
  return JSON.stringify({ emoji: emoji || "♞", bg: COLOR_RE.test(bg) ? bg : "#3a2e24" });
}

function cleanText(v: unknown, max: number): string {
  // plain text only; control characters are dropped
  return str(v, max).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function publicUser(u: UserRow, now: number) {
  let avatar: unknown = null;
  try { avatar = u.avatar ? JSON.parse(u.avatar) : null; } catch { avatar = null; }
  const online = now - u.last_seen < ONLINE_MS;
  return {
    id: u.id, name: u.name, code: u.code, avatar, online,
    status: online ? u.status : "offline", lastSeen: u.last_seen, games: u.games,
    ratings: Object.fromEntries(CATS.map((c) => [c, { r: u[`r_${c}`], n: u[`n_${c}`] }])),
  };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 8 * 1024) throw new HttpError(413, "request too large");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { throw new HttpError(400, "bad JSON"); }
}

// -- the handler ---------------------------------------------------------------------------------

// Schema creation runs once per isolate (keyed by the database binding), not once per request.
const schemaReady = new WeakMap<object, Promise<unknown>>();

export class Social {
  constructor(private db: SocialDB, private now: () => number = () => Date.now(), private hooks: SocialHooks = {}) {}

  private schema(): Promise<unknown> {
    let p = schemaReady.get(this.db);
    if (!p) {
      p = this.db.batch(SCHEMA.map((sql) => this.q(sql.replace(/\s+/g, " ")))).then(async () => {
        for (const sql of MIGRATIONS) { try { await this.q(sql).run(); } catch { /* already applied */ } }
      });
      p.catch(() => schemaReady.delete(this.db));
      schemaReady.set(this.db, p);
    }
    return p;
  }

  private q(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args); }

  // several independent statements in one round trip; each entry is that statement's rows
  private async many(...stmts: SocialStatement[]): Promise<Record<string, unknown>[][]> {
    const out = await this.db.batch(stmts);
    return out.map((r) => (r.results ?? []) as Record<string, unknown>[]);
  }

  private async auth(request: Request): Promise<UserRow> {
    const h = request.headers.get("Authorization") || "";
    const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
    if (!m || !m[1]) throw new HttpError(401, "missing or bad credentials");
    const u = await this.q("SELECT * FROM social_users WHERE secret_hash = ?", await sha256(m[1])).first<UserRow>();
    if (!u) throw new HttpError(401, "unknown device; register again");
    return u;
  }

  private async user(id: string): Promise<UserRow | null> {
    return this.q("SELECT * FROM social_users WHERE id = ?", id).first<UserRow>();
  }

  private async rateLimit(sql: string, args: unknown[], max: number, what: string) {
    const r = await this.q(sql, ...args).first<{ n: number }>();
    if (r && r.n >= max) throw new HttpError(429, `too many ${what}; slow down`);
  }

  async handle(request: Request, path: string): Promise<Response> {
    try {
      await this.schema();
      const data = await this.route(request, path, new URL(request.url));
      return json(200, data);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error("social api error", e);
      return json(500, { error: "server error" });
    }
  }

  private async route(request: Request, path: string, url: URL): Promise<unknown> {
    const now = this.now();
    const method = request.method;
    const seg = path.split("/").filter(Boolean);

    // POST /register {name, avatar} -> {id, secret, code}
    if (method === "POST" && path === "/register") {
      const b = await body(request);
      const name = str(b["name"], 16);
      if (!NAME_RE.test(name)) throw new HttpError(400, "name must be 2-16 letters, numbers or _");
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const secret = randomSecret();
      const id = "u_" + randomString(12).toLowerCase();
      let code = randomString(8);
      const [recent, taken] = await this.many(
        this.q("SELECT COUNT(*) AS n FROM social_reg_log WHERE ip = ? AND at > ?", ip, now - 3_600_000),
        this.q("SELECT 1 AS x FROM social_users WHERE code = ?", code));
      if (Number(recent?.[0]?.["n"] ?? 0) >= 20) throw new HttpError(429, "too many registrations; slow down");
      for (let i = 0; taken?.length && i < 4 && (await this.q("SELECT 1 AS x FROM social_users WHERE code = ?", code).first()); i++) code = randomString(8);
      await this.many(
        this.q("INSERT INTO social_users (id, secret_hash, code, name, avatar, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, await sha256(secret), code, name, cleanAvatar(b["avatar"]), now, now),
        this.q("INSERT INTO social_reg_log (ip, at) VALUES (?, ?)", ip, now));
      return { id, secret, code, name };
    }

    const me = await this.auth(request);

    // POST /heartbeat {status, name, avatar, ratings, games} -> {me, unread, requests}
    if (method === "POST" && path === "/heartbeat") {
      const b = await body(request);
      const status = b["status"] === "playing" ? "playing" : "online";
      const name = NAME_RE.test(str(b["name"], 16)) ? str(b["name"], 16) : me.name;
      const avatar = b["avatar"] ? cleanAvatar(b["avatar"]) : me.avatar;
      const ratings = (b["ratings"] && typeof b["ratings"] === "object" ? b["ratings"] : {}) as Record<string, unknown>;
      const vals: Record<string, number> = {};
      for (const c of CATS) {
        const slot = ratings[c] as Record<string, unknown> | undefined;
        const r = Number(slot && slot["r"]), n = Number(slot && slot["n"]);
        vals[`r_${c}`] = Number.isFinite(r) ? Math.max(100, Math.min(3500, Math.round(r))) : me[`r_${c}` as `r_${Cat}`];
        vals[`n_${c}`] = Number.isFinite(n) ? Math.max(0, Math.min(1_000_000, Math.round(n))) : me[`n_${c}` as `n_${Cat}`];
      }
      const games = Number.isFinite(Number(b["games"])) ? Math.max(0, Math.min(1_000_000, Math.round(Number(b["games"])))) : me.games;
      const room = typeof b["room"] === "string" && ROOM_RE.test(b["room"]) && status === "playing" ? b["room"] : null;
      const [, unread, reqs, latest, updated] = await this.many(
        this.q(`UPDATE social_users SET last_seen = ?, status = ?, name = ?, avatar = ?, games = ?, room = ?,
            r_bullet = ?, n_bullet = ?, r_blitz = ?, n_blitz = ?, r_rapid = ?, n_rapid = ?,
            r_puzzle = ?, n_puzzle = ?, r_bots = ?, n_bots = ? WHERE id = ?`,
          now, status, name, avatar, games, room,
          vals["r_bullet"], vals["n_bullet"], vals["r_blitz"], vals["n_blitz"], vals["r_rapid"], vals["n_rapid"],
          vals["r_puzzle"], vals["n_puzzle"], vals["r_bots"], vals["n_bots"], me.id),
        this.q("SELECT COUNT(*) AS n FROM social_messages WHERE recipient = ? AND seen = 0", me.id),
        this.q("SELECT COUNT(*) AS n FROM social_friends WHERE b = ? AND state = 'pending'", me.id),
        this.q(`SELECT m.id, m.kind, m.body, m.created, u.name AS sender_name, m.sender FROM social_messages m
            JOIN social_users u ON u.id = m.sender WHERE m.recipient = ? AND m.seen = 0 ORDER BY m.id DESC LIMIT 5`, me.id),
        this.q("SELECT * FROM social_users WHERE id = ?", me.id));
      const u = updated?.[0] as UserRow | undefined;
      return { me: u ? publicUser(u, now) : null, unread: Number(unread?.[0]?.["n"] ?? 0), requests: Number(reqs?.[0]?.["n"] ?? 0), latest, now };
    }

    if (method === "GET" && path === "/me") return { me: publicUser(me, now) };

    // ---- friends ----
    if (method === "GET" && path === "/friends") {
      const [friends, incoming, outgoing] = await this.many(
        this.q(`SELECT u.* FROM social_friends f JOIN social_users u ON u.id = f.b
            WHERE f.a = ? AND f.state = 'accepted' ORDER BY u.last_seen DESC`, me.id),
        this.q(`SELECT u.* FROM social_friends f JOIN social_users u ON u.id = f.a
            WHERE f.b = ? AND f.state = 'pending' ORDER BY f.created DESC`, me.id),
        this.q(`SELECT u.* FROM social_friends f JOIN social_users u ON u.id = f.b
            WHERE f.a = ? AND f.state = 'pending' ORDER BY f.created DESC`, me.id));
      const map = (rows: Record<string, unknown>[] | undefined) => (rows ?? []).map((u) => publicUser(u as unknown as UserRow, now));
      // friends (only) see which live game you're in, so they can watch it
      const withRoom = (friends ?? []).map((u) => {
        const p = publicUser(u as unknown as UserRow, now);
        return { ...p, watch: p.status === "playing" && typeof u["room"] === "string" ? u["room"] : null };
      });
      return { friends: withRoom, incoming: map(incoming), outgoing: map(outgoing) };
    }
    if (method === "POST" && path === "/friends/request") {
      const b = await body(request);
      const code = str(b["code"], 8).toUpperCase();
      const them = await this.q("SELECT * FROM social_users WHERE code = ?", code).first<UserRow>();
      if (!them) throw new HttpError(404, "no player has that friend code");
      if (them.id === me.id) throw new HttpError(400, "that's your own code");
      const [sent, mine, theirs] = await this.many(
        this.q("SELECT COUNT(*) AS n FROM social_friends WHERE a = ? AND created > ?", me.id, now - 3_600_000),
        this.q("SELECT state FROM social_friends WHERE a = ? AND b = ?", me.id, them.id),
        this.q("SELECT state FROM social_friends WHERE a = ? AND b = ?", them.id, me.id));
      if (mine?.[0]?.["state"] === "accepted") return { status: "friends" };
      if (Number(sent?.[0]?.["n"] ?? 0) >= 40) throw new HttpError(429, "too many friend requests; slow down");
      // they already asked us: accept straight away
      if (theirs?.[0]?.["state"] === "pending") { await this.accept(them.id, me.id, now); return { status: "friends" }; }
      await this.q("INSERT OR IGNORE INTO social_friends (a, b, state, created) VALUES (?, ?, 'pending', ?)", me.id, them.id, now).run();
      return { status: "pending", user: publicUser(them, now) };
    }
    if (method === "POST" && path === "/friends/respond") {
      const b = await body(request);
      const from = str(b["id"], 32);
      const pending = await this.q("SELECT 1 AS x FROM social_friends WHERE a = ? AND b = ? AND state = 'pending'", from, me.id).first();
      if (!pending) throw new HttpError(404, "no such request");
      if (b["accept"]) await this.accept(from, me.id, now);
      else await this.q("DELETE FROM social_friends WHERE a = ? AND b = ?", from, me.id).run();
      return { ok: true };
    }
    if (method === "POST" && path === "/friends/remove") {
      const b = await body(request);
      const other = str(b["id"], 32);
      await this.q("DELETE FROM social_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", me.id, other, other, me.id).run();
      return { ok: true };
    }

    // ---- direct messages and challenges ----
    if (method === "GET" && path === "/conversations") {
      type Row = UserRow & { m_id: number | null; m_sender: string; m_kind: string; m_body: string; m_created: number; unread_n: number };
      const r = await this.q(`SELECT u.*, lm.id AS m_id, lm.sender AS m_sender, lm.kind AS m_kind, lm.body AS m_body, lm.created AS m_created,
            (SELECT COUNT(*) FROM social_messages x WHERE x.sender = u.id AND x.recipient = ? AND x.seen = 0) AS unread_n
          FROM social_friends f JOIN social_users u ON u.id = f.b
          LEFT JOIN social_messages lm ON lm.id = (SELECT m.id FROM social_messages m
            WHERE (m.sender = ? AND m.recipient = u.id) OR (m.sender = u.id AND m.recipient = ?) ORDER BY m.id DESC LIMIT 1)
          WHERE f.a = ? AND f.state = 'accepted'`, me.id, me.id, me.id, me.id).all<Row>();
      const out = r.results.map((x) => ({
        user: publicUser(x, now),
        last: x.m_id ? { id: x.m_id, sender: x.m_sender, kind: x.m_kind, body: x.m_body, created: x.m_created } : null,
        unread: x.unread_n,
      }));
      out.sort((x, y) => (y.last?.id ?? 0) - (x.last?.id ?? 0) || y.user.lastSeen - x.user.lastSeen);
      return { conversations: out };
    }
    if (method === "GET" && path === "/messages") {
      const other = str(url.searchParams.get("with"), 32);
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      // polled every few seconds, so the friendship check rides in the same round trip
      const [friend, rows] = await this.many(
        this.q("SELECT 1 AS x FROM social_friends WHERE a = ? AND b = ? AND state = 'accepted'", me.id, other),
        this.q(`SELECT id, sender, recipient, kind, body, created FROM social_messages
            WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND id > ? ORDER BY id DESC LIMIT 100`,
          me.id, other, other, me.id, after),
        this.q("UPDATE social_messages SET seen = 1 WHERE sender = ? AND recipient = ? AND seen = 0", other, me.id));
      if (!friend?.length) throw new HttpError(403, "you can only message friends");
      return { messages: (rows ?? []).reverse() };
    }
    if (method === "POST" && path === "/messages") {
      const b = await body(request);
      const to = str(b["to"], 32);
      const [friend, recent] = await this.many(
        this.q("SELECT 1 AS x FROM social_friends WHERE a = ? AND b = ? AND state = 'accepted'", me.id, to),
        this.q("SELECT COUNT(*) AS n FROM social_messages WHERE sender = ? AND created > ?", me.id, now - 60_000));
      if (!friend?.length) throw new HttpError(403, "you can only message friends");
      if (Number(recent?.[0]?.["n"] ?? 0) >= 30) throw new HttpError(429, "too many messages; slow down");
      let kind = "text", text = "";
      if (b["kind"] === "challenge") {
        const room = str(b["room"], 64), tc = str(b["tc"], 8), mode = b["mode"] === "daily" ? "daily" : "live";
        if (!ROOM_RE.test(room) || !TC_RE.test(tc)) throw new HttpError(400, "bad challenge");
        kind = "challenge";
        text = JSON.stringify({ room, tc, mode });
      } else {
        text = cleanText(b["text"], 500);
        if (!text) throw new HttpError(400, "empty message");
      }
      await this.q("INSERT INTO social_messages (sender, recipient, kind, body, created) VALUES (?, ?, ?, ?, ?)", me.id, to, kind, text, now).run();
      return { ok: true };
    }

    // ---- clubs ----
    if (method === "GET" && path === "/clubs") {
      const [mine, pub] = await this.many(
        this.q(`SELECT c.*, (SELECT COUNT(*) FROM social_club_members m2 WHERE m2.club = c.id) AS members
            FROM social_clubs c JOIN social_club_members m ON m.club = c.id WHERE m.member = ? ORDER BY c.name`, me.id),
        this.q(`SELECT c.*, (SELECT COUNT(*) FROM social_club_members m2 WHERE m2.club = c.id) AS members
            FROM social_clubs c WHERE c.public = 1 ORDER BY members DESC, c.created DESC LIMIT 30`));
      return { mine: mine ?? [], public: pub ?? [] };
    }
    if (method === "POST" && path === "/clubs/create") {
      const b = await body(request);
      const name = cleanText(b["name"], 40);
      if (name.length < 3) throw new HttpError(400, "club names need at least 3 characters");
      await this.rateLimit("SELECT COUNT(*) AS n FROM social_clubs WHERE owner = ?", [me.id], 5, "clubs");
      const id = "c_" + randomString(10).toLowerCase();
      const code = randomString(8);
      await this.many(
        this.q("INSERT INTO social_clubs (id, code, name, about, owner, public, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, code, name, cleanText(b["about"], 200), me.id, b["public"] === false ? 0 : 1, now),
        this.q("INSERT INTO social_club_members (club, member, role, joined) VALUES (?, ?, 'owner', ?)", id, me.id, now));
      return { id, code };
    }
    if (method === "POST" && path === "/clubs/join") {
      const b = await body(request);
      const code = str(b["code"], 8).toUpperCase(), id = str(b["id"], 32);
      const club = code
        ? await this.q("SELECT * FROM social_clubs WHERE code = ?", code).first<{ id: string; public: number }>()
        : await this.q("SELECT * FROM social_clubs WHERE id = ? AND public = 1", id).first<{ id: string; public: number }>();
      if (!club) throw new HttpError(404, "no such club");
      if (await this.q("SELECT 1 AS x FROM social_club_bans WHERE club = ? AND member = ?", club.id, me.id).first()) {
        throw new HttpError(403, "the club's owner removed you from this club");
      }
      await this.q("INSERT OR IGNORE INTO social_club_members (club, member, role, joined) VALUES (?, ?, 'member', ?)", club.id, me.id, now).run();
      return { id: club.id };
    }
    if (method === "POST" && path === "/clubs/leave") {
      const b = await body(request);
      const id = str(b["id"], 32);
      const [, left] = await this.many(
        this.q("DELETE FROM social_club_members WHERE club = ? AND member = ?", id, me.id),
        this.q("SELECT COUNT(*) AS n FROM social_club_members WHERE club = ?", id));
      if (Number(left?.[0]?.["n"] ?? 1) === 0) await this.dropClub(id);
      return { ok: true };
    }
    const seg0 = seg[0] ?? "", seg1 = seg[1] ?? "", seg2 = seg[2] ?? "";
    if (seg0 === "clubs" && seg1 && !["create", "join", "leave"].includes(seg1)) {
      const id = seg1;
      const memberQ = this.q("SELECT 1 AS x FROM social_club_members WHERE club = ? AND member = ?", id, me.id);
      const denied = () => new HttpError(403, "join the club first");
      if (method === "GET" && seg.length === 2) {
        const [member, club, members, msgs] = await this.many(memberQ,
          this.q("SELECT id, code, name, about, owner, public, created FROM social_clubs WHERE id = ?", id),
          this.q(`SELECT u.*, m.role FROM social_club_members m JOIN social_users u ON u.id = m.member
              WHERE m.club = ? ORDER BY u.r_blitz DESC LIMIT 200`, id),
          this.q(`SELECT m.id, m.sender, u.name AS sender_name, m.body, m.created FROM social_messages m
              JOIN social_users u ON u.id = m.sender WHERE m.club = ? ORDER BY m.id DESC LIMIT 60`, id));
        if (!member?.length) throw denied();
        const mem = (members ?? []) as unknown as (UserRow & { role: string })[];
        return { club: club?.[0] ?? null, members: mem.map((u) => ({ ...publicUser(u, now), role: u.role })), messages: (msgs ?? []).reverse() };
      }
      if (seg2 === "messages" && method === "GET") {
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const [member, msgs] = await this.many(memberQ,
          this.q(`SELECT m.id, m.sender, u.name AS sender_name, m.body, m.created FROM social_messages m
              JOIN social_users u ON u.id = m.sender WHERE m.club = ? AND m.id > ? ORDER BY m.id DESC LIMIT 60`, id, after));
        if (!member?.length) throw denied();
        return { messages: (msgs ?? []).reverse() };
      }
      if (seg2 === "messages" && method === "POST") {
        const b = await body(request);
        const text = cleanText(b["text"], 500);
        if (!text) throw new HttpError(400, "empty message");
        const [member, recent] = await this.many(memberQ,
          this.q("SELECT COUNT(*) AS n FROM social_messages WHERE sender = ? AND created > ?", me.id, now - 60_000));
        if (!member?.length) throw denied();
        if (Number(recent?.[0]?.["n"] ?? 0) >= 30) throw new HttpError(429, "too many messages; slow down");
        await this.q("INSERT INTO social_messages (sender, club, kind, body, created) VALUES (?, ?, 'text', ?, ?)", me.id, id, text, now).run();
        return { ok: true };
      }
      // POST /clubs/:id/remove {member}: the owner removes someone, who can't rejoin this club
      if (seg2 === "remove" && method === "POST") {
        const b = await body(request);
        const member = str(b["member"], 32);
        const [owner] = await this.many(this.q("SELECT 1 AS x FROM social_clubs WHERE id = ? AND owner = ?", id, me.id));
        if (!owner?.length) throw new HttpError(403, "only the club's owner can remove members");
        if (member === me.id) throw new HttpError(400, "owners leave instead of removing themselves");
        await this.many(
          this.q("DELETE FROM social_club_members WHERE club = ? AND member = ?", id, member),
          this.q("INSERT OR IGNORE INTO social_club_bans (club, member) VALUES (?, ?)", id, member));
        return { ok: true };
      }
      throw new HttpError(404, "not found");
    }

    // ---- leaderboard ----
    if (method === "GET" && path === "/leaderboard") {
      const cat = (CATS as readonly string[]).includes(url.searchParams.get("cat") || "") ? (url.searchParams.get("cat") as Cat) : "blitz";
      const minGames = cat === "puzzle" ? 10 : 5;
      const since = now - 30 * 86_400_000;
      // the column name comes from the fixed CATS list above, never from input
      const [top, rank, total] = await this.many(
        this.q(`SELECT * FROM social_users WHERE n_${cat} >= ? AND last_seen > ? ORDER BY r_${cat} DESC, n_${cat} DESC LIMIT 50`, minGames, since),
        this.q(`SELECT COUNT(*) AS n FROM social_users WHERE n_${cat} >= ? AND last_seen > ? AND r_${cat} > ?`, minGames, since, me[`r_${cat}`]),
        this.q(`SELECT COUNT(*) AS n FROM social_users WHERE n_${cat} >= ? AND last_seen > ?`, minGames, since));
      const eligible = me[`n_${cat}`] >= minGames;
      return {
        cat, minGames, top: (top ?? []).map((u) => publicUser(u as unknown as UserRow, now)),
        me: { rank: eligible ? Number(rank?.[0]?.["n"] ?? 0) + 1 : null, rating: me[`r_${cat}`], games: me[`n_${cat}`] },
        total: Number(total?.[0]?.["n"] ?? 0),
      };
    }

    // ---- live arenas and puzzle battles ----
    if (seg0 === "arenas") return this.arenas(request, me, seg, now);
    if (seg0 === "battles") return this.battles(request, me, seg, now);

    // GET /users/:id — a friend's or club-mate's public profile
    if (method === "GET" && seg0 === "users" && seg1) {
      const u = await this.user(seg1);
      if (!u) throw new HttpError(404, "no such player");
      return { user: publicUser(u, now) };
    }

    // POST /delete: remove this player, their friendships, messages and club memberships
    if (method === "POST" && path === "/delete") {
      const [clubs] = await this.many(
        this.q("SELECT club FROM social_club_members WHERE member = ?", me.id),
        this.q("DELETE FROM social_friends WHERE a = ? OR b = ?", me.id, me.id),
        this.q("DELETE FROM social_messages WHERE sender = ? OR recipient = ?", me.id, me.id),
        this.q("DELETE FROM social_club_members WHERE member = ?", me.id),
        this.q("DELETE FROM social_club_bans WHERE member = ?", me.id),
        this.q("DELETE FROM social_arena_players WHERE uid = ?", me.id),
        this.q("DELETE FROM social_battles WHERE a_uid = ? AND b_uid IS NULL", me.id),
        this.q("DELETE FROM social_users WHERE id = ?", me.id));
      for (const c of clubs ?? []) {
        const club = String(c["club"]);
        const left = await this.q("SELECT COUNT(*) AS n FROM social_club_members WHERE club = ?", club).first<{ n: number }>();
        if (left && left.n === 0) await this.dropClub(club);
      }
      return { ok: true };
    }

    throw new HttpError(404, "not found");
  }

  private async arenas(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    // GET /arenas: the running arena and the next ones (rows are created as the schedule reaches them)
    if (method === "GET" && seg.length === 1) {
      const slot = Math.floor(now / ARENA_SLOT_MS);
      const upcoming = [slot - 1, slot, slot + 1, slot + 2].map(arenaForSlot);
      const out = await this.many(
        ...upcoming.map((a) => this.q("INSERT OR IGNORE INTO social_arenas (id, name, tc, cat, starts, ends) VALUES (?, ?, ?, ?, ?, ?)", a.id, a.name, a.tc, a.cat, a.starts, a.ends)),
        this.q(`SELECT a.*, (SELECT COUNT(*) FROM social_arena_players p WHERE p.arena = a.id) AS players,
            EXISTS (SELECT 1 FROM social_arena_players p WHERE p.arena = a.id AND p.uid = ?) AS joined
            FROM social_arenas a WHERE a.ends > ? AND a.starts < ? ORDER BY a.starts LIMIT 4`, me.id, now - 60 * 60_000, now + 2 * ARENA_SLOT_MS));
      // one result per statement: the list is the last one
      return { arenas: out[out.length - 1] ?? [], now };
    }
    const id = seg[1] ?? "";
    const arena = await this.q("SELECT * FROM social_arenas WHERE id = ?", id).first<{ id: string; tc: string; cat: string; starts: number; ends: number }>();
    if (!arena) throw new HttpError(404, "no such arena");
    const running = arena.starts <= now && now < arena.ends;
    const action = seg[2] ?? "";

    // GET /arenas/:id: standings
    if (method === "GET" && !action) {
      const col = arena.cat === "bullet" ? "r_bullet" : "r_blitz";
      const [rows, mine] = await this.many(
        this.q(`SELECT p.uid, p.score, p.games, p.wins, p.streak, p.form, p.state, u.name, u.avatar, u.last_seen, u.status, u.${col} AS rating
            FROM social_arena_players p JOIN social_users u ON u.id = p.uid WHERE p.arena = ?
            ORDER BY p.score DESC, p.wins DESC, p.games ASC LIMIT 100`, id),
        this.q("SELECT * FROM social_arena_players WHERE arena = ? AND uid = ?", id, me.id));
      const standings = (rows ?? []).map((r) => {
        let avatar: unknown = null;
        try { avatar = r["avatar"] ? JSON.parse(String(r["avatar"])) : null; } catch { avatar = null; }
        const online = now - Number(r["last_seen"]) < ONLINE_MS;
        return { uid: r["uid"], name: r["name"], avatar, rating: r["rating"], score: r["score"], games: r["games"], wins: r["wins"],
          streak: r["streak"], form: r["form"], state: r["state"], online, status: online ? r["status"] : "offline" };
      });
      return { arena, running, standings, me: mine?.[0] ?? null, now };
    }

    // POST /arenas/:id/join
    if (method === "POST" && action === "join") {
      if (now >= arena.ends) throw new HttpError(409, "this arena has finished");
      await this.q("INSERT OR IGNORE INTO social_arena_players (arena, uid, joined) VALUES (?, ?, ?)", id, me.id, now).run();
      return { ok: true };
    }

    // POST /arenas/:id/pause: stop being paired (a game in progress still counts)
    if (method === "POST" && action === "pause") {
      await this.q("UPDATE social_arena_players SET state = 'idle' WHERE arena = ? AND uid = ? AND state = 'waiting'", id, me.id).run();
      return { ok: true };
    }

    // POST /arenas/:id/pair {pid}: wait for an opponent; pairs atomically with the longest-waiting
    // player who is still asking (and isn't the last opponent, when there's a choice)
    if (method === "POST" && action === "pair") {
      const b = await body(request);
      const pid = str(b["pid"], 64);
      if (!PID_RE.test(pid)) throw new HttpError(400, "bad player id");
      const room = "ar" + randomString(10).toLowerCase();
      const fresh = now - ARENA_FRESH_MS;
      const live = running ? 1 : 0;
      const out = await this.many(
        // a finished game frees you; otherwise start (or keep) waiting
        this.q(`UPDATE social_arena_players SET state = 'waiting', since = CASE WHEN state = 'waiting' THEN since ELSE ? END, seen = ?, pid = ?
            WHERE arena = ? AND uid = ? AND ? = 1 AND (state IN ('idle', 'waiting')
              OR (state = 'paired' AND EXISTS (SELECT 1 FROM social_arena_games g WHERE g.room = social_arena_players.room AND g.outcome IS NOT NULL)))`,
          now, now, pid, id, me.id, live),
        this.q(`UPDATE social_arena_players SET state = 'paired', room = ?, last_opp = ?
            WHERE arena = ? AND uid = (
              SELECT p.uid FROM social_arena_players p WHERE p.arena = ? AND p.uid <> ? AND p.state = 'waiting' AND p.seen > ?
              ORDER BY (p.uid = COALESCE((SELECT last_opp FROM social_arena_players WHERE arena = ? AND uid = ?), '')) ASC, p.since ASC LIMIT 1)
            AND (SELECT state FROM social_arena_players WHERE arena = ? AND uid = ?) = 'waiting'`,
          room, me.id, id, id, me.id, fresh, id, me.id, id, me.id),
        this.q(`UPDATE social_arena_players SET state = 'paired', room = ?,
              last_opp = (SELECT uid FROM social_arena_players WHERE arena = ? AND room = ? AND uid <> ?)
            WHERE arena = ? AND uid = ? AND state = 'waiting'
              AND EXISTS (SELECT 1 FROM social_arena_players WHERE arena = ? AND room = ? AND uid <> ?)`,
          room, id, room, me.id, id, me.id, id, room, me.id),
        this.q(`INSERT INTO social_arena_games (room, arena, a_uid, a_pid, b_uid, b_pid, created)
            SELECT ?, ?, m.uid, m.pid, o.uid, o.pid, ? FROM social_arena_players m
            JOIN social_arena_players o ON o.arena = m.arena AND o.room = m.room AND o.uid <> m.uid
            WHERE m.arena = ? AND m.uid = ? AND m.room = ? AND m.state = 'paired'`,
          room, id, now, id, me.id, room),
        this.q(`SELECT p.*, u.name AS opp_name, u.avatar AS opp_avatar, u.r_${arena.cat === "bullet" ? "bullet" : "blitz"} AS opp_rating
            FROM social_arena_players p LEFT JOIN social_users u ON u.id = p.last_opp WHERE p.arena = ? AND p.uid = ?`, id, me.id));
      const row = out[4]?.[0];
      if (!row) throw new HttpError(403, "join the arena first");
      let opponent: unknown = null;
      if (row["state"] === "paired" && row["opp_name"]) {
        let avatar: unknown = null;
        try { avatar = row["opp_avatar"] ? JSON.parse(String(row["opp_avatar"])) : null; } catch { avatar = null; }
        opponent = { uid: row["last_opp"], name: row["opp_name"], avatar, rating: row["opp_rating"] };
      }
      return { state: row["state"], room: row["state"] === "paired" ? row["room"] : null, opponent, running, tc: arena.tc };
    }

    // POST /arenas/:id/result {room}: the server reads the result from the room itself
    if (method === "POST" && action === "result") {
      const b = await body(request);
      const room = str(b["room"], 64);
      const game = await this.q("SELECT * FROM social_arena_games WHERE room = ? AND arena = ?", room, id)
        .first<{ a_uid: string; a_pid: string; b_uid: string; b_pid: string; created: number; outcome: string | null }>();
      if (!game || (game.a_uid !== me.id && game.b_uid !== me.id)) throw new HttpError(404, "no such arena game");
      if (game.outcome) return { outcome: game.outcome, you: game.a_uid === me.id ? "a" : "b" };
      if (!this.hooks.roomState) throw new HttpError(503, "results can't be checked right now");
      const st = await this.hooks.roomState(room);
      if (!st) throw new HttpError(503, "couldn't reach the game");
      let outcome: string;
      if (st.status === "over" && st.result) {
        const r = st.result;
        outcome = r.reason === "aborted" ? "void" : r.draw ? "draw" : r.winner === game.a_pid ? "a" : r.winner === game.b_pid ? "b" : "void";
      } else if (st.status === "waiting" && now - game.created > 45_000) {
        outcome = "void";          // the opponent never came
      } else {
        throw new HttpError(409, "the game isn't over yet");
      }
      const [pa, pb] = await this.many(
        this.q("SELECT streak FROM social_arena_players WHERE arena = ? AND uid = ?", id, game.a_uid),
        this.q("SELECT streak FROM social_arena_players WHERE arena = ? AND uid = ?", id, game.b_uid));
      const score = (won: number, streak: number) => {
        // win 2, draw 1; after two wins in a row each further win counts double
        if (won === 1) return { pts: streak >= 2 ? 4 : 2, wins: 1, streak: streak + 1, mark: streak >= 2 ? "W2" : "W" };
        if (won === 0.5) return { pts: 1, wins: 0, streak: 0, mark: "D" };
        return { pts: 0, wins: 0, streak: 0, mark: "L" };
      };
      const token = randomString(12);
      const stmts = [this.q("UPDATE social_arena_games SET outcome = ?, token = ? WHERE room = ? AND outcome IS NULL", outcome, token, room)];
      const sides: [string, number, number][] = [
        [game.a_uid, outcome === "a" ? 1 : outcome === "draw" ? 0.5 : 0, Number(pa?.[0]?.["streak"] ?? 0)],
        [game.b_uid, outcome === "b" ? 1 : outcome === "draw" ? 0.5 : 0, Number(pb?.[0]?.["streak"] ?? 0)],
      ];
      for (const [uid, won, streak] of sides) {
        if (outcome === "void") {
          stmts.push(this.q(`UPDATE social_arena_players SET state = CASE WHEN room = ? THEN 'idle' ELSE state END
              WHERE arena = ? AND uid = ? AND EXISTS (SELECT 1 FROM social_arena_games WHERE room = ? AND token = ?)`, room, id, uid, room, token));
          continue;
        }
        const s = score(won, streak);
        stmts.push(this.q(`UPDATE social_arena_players SET score = score + ?, games = games + 1, wins = wins + ?, streak = ?,
              form = substr(form || ? || ' ', -36), state = CASE WHEN room = ? THEN 'idle' ELSE state END
            WHERE arena = ? AND uid = ? AND EXISTS (SELECT 1 FROM social_arena_games WHERE room = ? AND token = ?)`,
          s.pts, s.wins, s.streak, s.mark, room, id, uid, room, token));
      }
      await this.many(...stmts);
      const final = await this.q("SELECT outcome FROM social_arena_games WHERE room = ?", room).first<{ outcome: string }>();
      return { outcome: final?.outcome ?? outcome, you: game.a_uid === me.id ? "a" : "b" };
    }
    throw new HttpError(404, "not found");
  }

  // Puzzle battles. Scores are reported by each player's device (like ratings), so a battle is a
  // friendly race rather than a rated event.
  private async battles(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    const view = (r: Record<string, unknown> | undefined) => {
      if (!r) return null;
      const mine = r["a_uid"] === me.id ? "a" : "b", theirs = mine === "a" ? "b" : "a";
      let avatar: unknown = null;
      try { avatar = r["opp_avatar"] ? JSON.parse(String(r["opp_avatar"])) : null; } catch { avatar = null; }
      return {
        id: r["id"], seed: r["seed"], starts: r["starts"] || null, ends: r["starts"] ? Number(r["starts"]) + BATTLE_MS : null,
        you: { score: r[`${mine}_score`], strikes: r[`${mine}_strikes`], done: !!r[`${mine}_done`] },
        opponent: r[`${theirs}_uid`] ? {
          name: r["opp_name"], avatar, rating: r["opp_rating"],
          score: r[`${theirs}_score`], strikes: r[`${theirs}_strikes`], done: !!r[`${theirs}_done`],
          gone: now - Number(r[`${theirs}_seen`]) > 15_000,
        } : null,
        now,
      };
    };
    const select = `SELECT b.*, u.name AS opp_name, u.avatar AS opp_avatar, u.r_puzzle AS opp_rating FROM social_battles b
        LEFT JOIN social_users u ON u.id = CASE WHEN b.a_uid = ? THEN b.b_uid ELSE b.a_uid END`;

    // POST /battles/find: keep an open battle alive, or join the oldest live open battle (the older
    // of two open battles always wins, so two searchers can't both wait forever)
    if (method === "POST" && seg[1] === "find") {
      const fresh = now - BATTLE_FRESH_MS;
      const id = "b_" + randomString(12).toLowerCase();
      const seed = Math.floor(Math.random() * 1e9);
      const out = await this.many(
        this.q("UPDATE social_battles SET a_seen = ? WHERE a_uid = ? AND b_uid IS NULL", now, me.id),
        this.q(`UPDATE social_battles SET b_uid = ?, b_seen = ?, starts = ? WHERE id = (
            SELECT o.id FROM social_battles o WHERE o.b_uid IS NULL AND o.a_uid <> ? AND o.a_seen > ?
              AND o.created < COALESCE((SELECT m.created FROM social_battles m WHERE m.a_uid = ? AND m.b_uid IS NULL), 9e15)
            ORDER BY o.created LIMIT 1)`, me.id, now, now + BATTLE_COUNTDOWN_MS, me.id, fresh, me.id),
        this.q(`DELETE FROM social_battles WHERE a_uid = ? AND b_uid IS NULL
            AND EXISTS (SELECT 1 FROM social_battles WHERE b_uid = ? AND starts > ?)`, me.id, me.id, now),
        this.q(`INSERT INTO social_battles (id, seed, created, a_uid, a_seen) SELECT ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM social_battles WHERE (a_uid = ? AND b_uid IS NULL) OR (b_uid = ? AND starts > ?))`,
          id, seed, now, me.id, now, me.id, me.id, now),
        // your open battle, or a paired one that still has time on it (never a finished one)
        this.q(`${select} WHERE (b.a_uid = ? OR b.b_uid = ?) AND (b.b_uid IS NULL OR b.starts > ?)
            ORDER BY b.starts DESC LIMIT 1`, me.id, me.id, me.id, now - BATTLE_MS + 10_000));
      return { battle: view(out[4]?.[0]) };
    }

    // POST /battles/cancel: stop searching
    if (method === "POST" && seg[1] === "cancel") {
      await this.q("DELETE FROM social_battles WHERE a_uid = ? AND b_uid IS NULL", me.id).run();
      return { ok: true };
    }

    // POST /battles/:id/progress {score, strikes, done}: report yours, read theirs
    if (method === "POST" && seg[2] === "progress") {
      const b = await body(request);
      const id = str(seg[1], 32);
      const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
      const score = n(b["score"], 200), strikes = n(b["strikes"], 3), done = b["done"] ? 1 : 0;
      const out = await this.many(
        this.q(`UPDATE social_battles SET
              a_score = CASE WHEN a_uid = ? THEN MAX(a_score, ?) ELSE a_score END,
              a_strikes = CASE WHEN a_uid = ? THEN MAX(a_strikes, ?) ELSE a_strikes END,
              a_done = CASE WHEN a_uid = ? THEN MAX(a_done, ?) ELSE a_done END,
              a_seen = CASE WHEN a_uid = ? THEN ? ELSE a_seen END,
              b_score = CASE WHEN b_uid = ? THEN MAX(b_score, ?) ELSE b_score END,
              b_strikes = CASE WHEN b_uid = ? THEN MAX(b_strikes, ?) ELSE b_strikes END,
              b_done = CASE WHEN b_uid = ? THEN MAX(b_done, ?) ELSE b_done END,
              b_seen = CASE WHEN b_uid = ? THEN ? ELSE b_seen END
            WHERE id = ? AND (a_uid = ? OR b_uid = ?) AND starts > 0 AND ? < starts + ?`,
          me.id, score, me.id, strikes, me.id, done, me.id, now,
          me.id, score, me.id, strikes, me.id, done, me.id, now,
          id, me.id, me.id, now, BATTLE_MS + 15_000),
        this.q(`${select} WHERE b.id = ? AND (b.a_uid = ? OR b.b_uid = ?)`, me.id, id, me.id, me.id));
      const battle = view(out[1]?.[0]);
      if (!battle) throw new HttpError(404, "no such battle");
      return { battle };
    }
    throw new HttpError(404, "not found");
  }

  private async dropClub(id: string) {
    await this.many(this.q("DELETE FROM social_messages WHERE club = ?", id), this.q("DELETE FROM social_club_bans WHERE club = ?", id),
      this.q("DELETE FROM social_clubs WHERE id = ?", id));
  }

  private async accept(requester: string, accepter: string, now: number) {
    await this.many(
      this.q("INSERT OR REPLACE INTO social_friends (a, b, state, created) VALUES (?, ?, 'accepted', ?)", requester, accepter, now),
      this.q("INSERT OR REPLACE INTO social_friends (a, b, state, created) VALUES (?, ?, 'accepted', ?)", accepter, requester, now));
  }
}

// CORS: requests are authorised by a bearer token (no cookies), so any origin may call the API;
// the game itself is served from Vercel as well as from this Worker.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}
