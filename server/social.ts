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
  `CREATE TABLE IF NOT EXISTS social_reg_log (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
];

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
  constructor(private db: SocialDB, private now: () => number = () => Date.now()) {}

  private schema(): Promise<unknown> {
    let p = schemaReady.get(this.db);
    if (!p) {
      p = this.db.batch(SCHEMA.map((sql) => this.q(sql.replace(/\s+/g, " "))));
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
      const [, unread, reqs, latest, updated] = await this.many(
        this.q(`UPDATE social_users SET last_seen = ?, status = ?, name = ?, avatar = ?, games = ?,
            r_bullet = ?, n_bullet = ?, r_blitz = ?, n_blitz = ?, r_rapid = ?, n_rapid = ?,
            r_puzzle = ?, n_puzzle = ?, r_bots = ?, n_bots = ? WHERE id = ?`,
          now, status, name, avatar, games,
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
      return { friends: map(friends), incoming: map(incoming), outgoing: map(outgoing) };
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

  private async dropClub(id: string) {
    await this.many(this.q("DELETE FROM social_messages WHERE club = ?", id), this.q("DELETE FROM social_clubs WHERE id = ?", id));
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
