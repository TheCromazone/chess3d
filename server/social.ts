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
  // keep work going after the response (Worker ctx.waitUntil); push sends use it
  waitUntil?: (p: Promise<unknown>) => void;
  // how push requests leave the Worker (tests swap it out)
  pushFetch?: (url: string, init: RequestInit) => Promise<Response>;
  // how news/video/streamer feeds are fetched (tests swap it out)
  feedFetch?: (url: string) => Promise<Response>;
  // Vote Chess: seat a player in a room (action null) or act for them; the room referees as usual
  roomAct?: (room: string, playerId: string, action: unknown) => Promise<{ ok: boolean; error?: string; status?: string; result?: RoomState["result"] }>;
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
  // a player you block can't add you, message or challenge you, or nudge you about a move, and you stop seeing what they post
  `CREATE TABLE IF NOT EXISTS social_blocks (uid TEXT NOT NULL, blocked TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (uid, blocked))`,
  `CREATE INDEX IF NOT EXISTS social_blocks_blocked ON social_blocks (blocked)`,
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
  // Swiss tournaments: fixed rounds, each paired by score once the previous round is decided
  `CREATE TABLE IF NOT EXISTS social_swiss (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, tc TEXT NOT NULL, cat TEXT NOT NULL, rounds INTEGER NOT NULL, starts INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open', round INTEGER NOT NULL DEFAULT 0, round_started INTEGER NOT NULL DEFAULT 0, token TEXT)`,
  `CREATE TABLE IF NOT EXISTS social_swiss_players (
     sid TEXT NOT NULL, uid TEXT NOT NULL, joined INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, pid TEXT NOT NULL DEFAULT '',
     score2 INTEGER NOT NULL DEFAULT 0, opps TEXT NOT NULL DEFAULT '', colors TEXT NOT NULL DEFAULT '', byes INTEGER NOT NULL DEFAULT 0,
     withdrawn INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sid, uid))`,
  `CREATE TABLE IF NOT EXISTS social_swiss_games (
     room TEXT PRIMARY KEY, sid TEXT NOT NULL, round INTEGER NOT NULL, w_uid TEXT NOT NULL, w_pid TEXT NOT NULL, b_uid TEXT NOT NULL, b_pid TEXT NOT NULL,
     created INTEGER NOT NULL, outcome TEXT, token TEXT)`,
  `CREATE INDEX IF NOT EXISTS social_swiss_games_round ON social_swiss_games (sid, round)`,
  // club team matches: daily games between two clubs' members, two games per board
  `CREATE TABLE IF NOT EXISTS social_club_matches (
     id TEXT PRIMARY KEY, a_club TEXT NOT NULL, b_club TEXT NOT NULL, tc TEXT NOT NULL, boards INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'challenge', created INTEGER NOT NULL, starts INTEGER NOT NULL DEFAULT 0,
     a_score2 INTEGER NOT NULL DEFAULT 0, b_score2 INTEGER NOT NULL DEFAULT 0, token TEXT)`,
  `CREATE INDEX IF NOT EXISTS social_club_matches_a ON social_club_matches (a_club)`,
  `CREATE INDEX IF NOT EXISTS social_club_matches_b ON social_club_matches (b_club)`,
  `CREATE TABLE IF NOT EXISTS social_club_match_players (
     mid TEXT NOT NULL, uid TEXT NOT NULL, side TEXT NOT NULL, pid TEXT NOT NULL, joined INTEGER NOT NULL, PRIMARY KEY (mid, uid))`,
  `CREATE TABLE IF NOT EXISTS social_club_match_games (
     room TEXT PRIMARY KEY, mid TEXT NOT NULL, board INTEGER NOT NULL, w_uid TEXT NOT NULL, w_pid TEXT NOT NULL,
     b_uid TEXT NOT NULL, b_pid TEXT NOT NULL, w_side TEXT NOT NULL, created INTEGER NOT NULL, outcome TEXT, token TEXT)`,
  `CREATE INDEX IF NOT EXISTS social_club_match_games_mid ON social_club_match_games (mid)`,
  // Vote Chess: two clubs play one daily game, each move chosen by its members' votes
  `CREATE TABLE IF NOT EXISTS social_vote_games (
     id TEXT PRIMARY KEY, a_club TEXT NOT NULL, b_club TEXT NOT NULL, room TEXT NOT NULL DEFAULT '', a_pid TEXT NOT NULL DEFAULT '',
     b_pid TEXT NOT NULL DEFAULT '', tc TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'challenge', created INTEGER NOT NULL,
     deadline INTEGER NOT NULL DEFAULT 0, ply INTEGER NOT NULL DEFAULT 0, result TEXT, token TEXT)`,
  // daily tournaments: rounds of groups, each a double round robin of daily games; group winners go through
  `CREATE TABLE IF NOT EXISTS social_dtours (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, tc TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'signup',
     round INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, starts INTEGER NOT NULL, winner TEXT, token TEXT)`,
  `CREATE TABLE IF NOT EXISTS social_dtour_players (
     tid TEXT NOT NULL, uid TEXT NOT NULL, pid TEXT NOT NULL, joined INTEGER NOT NULL, out_round INTEGER, PRIMARY KEY (tid, uid))`,
  `CREATE TABLE IF NOT EXISTS social_dtour_seats (tid TEXT NOT NULL, round INTEGER NOT NULL, uid TEXT NOT NULL, grp INTEGER NOT NULL, PRIMARY KEY (tid, round, uid))`,
  `CREATE TABLE IF NOT EXISTS social_dtour_games (
     room TEXT PRIMARY KEY, tid TEXT NOT NULL, round INTEGER NOT NULL, grp INTEGER NOT NULL, w_uid TEXT NOT NULL, w_pid TEXT NOT NULL,
     b_uid TEXT NOT NULL, b_pid TEXT NOT NULL, created INTEGER NOT NULL, outcome TEXT)`,
  `CREATE INDEX IF NOT EXISTS social_dtour_games_round ON social_dtour_games (tid, round)`,
  // Leagues: a permanent tier per player, weekly divisions of up to 50, entries with trophies, and each scored game once
  `CREATE TABLE IF NOT EXISTS social_league (uid TEXT PRIMARY KEY, tier INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS social_league_divs (
     id TEXT PRIMARY KEY, week INTEGER NOT NULL, tier INTEGER NOT NULL, created INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, token TEXT)`,
  `CREATE INDEX IF NOT EXISTS social_league_divs_week ON social_league_divs (week, tier)`,
  `CREATE TABLE IF NOT EXISTS social_league_entries (
     week INTEGER NOT NULL, uid TEXT NOT NULL, div TEXT NOT NULL, tier INTEGER NOT NULL, points INTEGER NOT NULL DEFAULT 0,
     games INTEGER NOT NULL DEFAULT 0, reached INTEGER NOT NULL, place INTEGER, promoted INTEGER, PRIMARY KEY (week, uid))`,
  `CREATE INDEX IF NOT EXISTS social_league_entries_div ON social_league_entries (div)`,
  `CREATE TABLE IF NOT EXISTS social_league_games (
     room TEXT NOT NULL, uid TEXT NOT NULL, opp TEXT NOT NULL, created INTEGER NOT NULL, points INTEGER NOT NULL, token TEXT, PRIMARY KEY (room, uid))`,
  `CREATE INDEX IF NOT EXISTS social_league_games_opp ON social_league_games (uid, opp, created)`,
  `CREATE TABLE IF NOT EXISTS social_vote_votes (
     game TEXT NOT NULL, ply INTEGER NOT NULL, uid TEXT NOT NULL, move TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (game, ply, uid))`,
  `CREATE TABLE IF NOT EXISTS social_battles (
     id TEXT PRIMARY KEY, seed INTEGER NOT NULL, created INTEGER NOT NULL, starts INTEGER NOT NULL DEFAULT 0,
     a_uid TEXT NOT NULL, a_score INTEGER NOT NULL DEFAULT 0, a_strikes INTEGER NOT NULL DEFAULT 0, a_done INTEGER NOT NULL DEFAULT 0, a_seen INTEGER NOT NULL DEFAULT 0,
     b_uid TEXT, b_score INTEGER NOT NULL DEFAULT 0, b_strikes INTEGER NOT NULL DEFAULT 0, b_done INTEGER NOT NULL DEFAULT 0, b_seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS social_battles_open ON social_battles (b_uid, a_seen)`,
  `CREATE TABLE IF NOT EXISTS social_games (id TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS social_games_uid ON social_games (uid, created)`,
  // more devices on the same profile: each linked device has its own key
  `CREATE TABLE IF NOT EXISTS social_keys (hash TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS social_keys_uid ON social_keys (uid)`,
  `CREATE INDEX IF NOT EXISTS social_users_name ON social_users (name COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS social_links (code TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS social_backups (uid TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS social_topics (
     id TEXT PRIMARY KEY, cat TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
     created INTEGER NOT NULL, last_at INTEGER NOT NULL, replies INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS social_topics_cat ON social_topics (cat, hidden, last_at)`,
  `CREATE TABLE IF NOT EXISTS social_posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, uid TEXT NOT NULL, body TEXT NOT NULL,
     created INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS social_posts_topic ON social_posts (topic, id)`,
  `CREATE TABLE IF NOT EXISTS social_reports (kind TEXT NOT NULL, item TEXT NOT NULL, uid TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (kind, item, uid))`,
  // blogs: articles players write, with likes; and the coach directory (players offering lessons)
  `CREATE TABLE IF NOT EXISTS social_blogs (
     id TEXT PRIMARY KEY, uid TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
     likes INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS social_blogs_recent ON social_blogs (hidden, created)`,
  `CREATE INDEX IF NOT EXISTS social_blogs_uid ON social_blogs (uid, created)`,
  `CREATE TABLE IF NOT EXISTS social_blog_likes (blog TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (blog, uid))`,
  `CREATE TABLE IF NOT EXISTS social_coaches (
     uid TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL, langs TEXT NOT NULL DEFAULT '',
     rate TEXT NOT NULL DEFAULT '', topics TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`,
  // web push: the server's VAPID key pair, each device's push endpoint, and "your move" notes
  `CREATE TABLE IF NOT EXISTS social_config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS social_push (endpoint TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS social_push_uid ON social_push (uid)`,
  `CREATE TABLE IF NOT EXISTS social_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS social_notes_uid ON social_notes (uid, id)`,
];

// Web push goes only to the browsers' own push services (no arbitrary URLs leave the Worker)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
const PUSH_SUBJECT = "https://chess3d-five.vercel.app";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pushHostOk(endpoint: string): boolean {
  try { const u = new URL(endpoint); return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname)); } catch { return false; }
}

// News, videos and live streamers for the Watch page: public feeds, refreshed every 15 minutes
const FEEDS_MS = 15 * 60_000;
const NEWS_FEEDS = [
  { source: "FIDE", url: "https://www.fide.com/feed/" },
  { source: "Lichess", url: "https://lichess.org/@/Lichess/blog.atom" },
  { source: "Chess.com", url: "https://www.chess.com/rss/news" },
];
const VIDEO_CHANNELS = [
  { channel: "GothamChess", id: "UCQHX6ViZmPsWiYSFAyS0a3Q" },
  { channel: "Chess.com", id: "UC5kS0l76kC0xOzMPtOmSFGw" },
  { channel: "Saint Louis Chess Club", id: "UCM-ONC2bCHytG2mYtKDmIeA" },
  { channel: "agadmator", id: "UCL5YbN5WLFD8dLIegT5QAbA" },
  { channel: "Hanging Pawns", id: "UCkJdvwRC-oGPhRHW_XPNokg" },
];
function decode(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m && m[1] !== undefined ? decode(m[1]) : "";
}
function httpsUrl(u: string): string | null {
  try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; }
}

// Forums: a few fixed categories; anything three different players report is hidden
const FORUM_CATS = ["general", "openings", "tactics", "endgames", "help"];
const REPORTS_TO_HIDE = 3;
// what can be reported: [table, key column]
const REPORTABLE: Record<string, [string, string]> = {
  topic: ["social_topics", "id"], post: ["social_posts", "id"], blog: ["social_blogs", "id"], coach: ["social_coaches", "uid"],
};
const authorOf = (r: Record<string, unknown>) => {
  let avatar: unknown = null;
  try { avatar = r["avatar"] ? JSON.parse(String(r["avatar"])) : null; } catch { avatar = null; }
  return { id: r["uid"], name: r["name"] ?? "Deleted player", avatar };
};

const LINK_MS = 10 * 60_000;         // a device link code works for 10 minutes, once
const BACKUP_MAX = 1_800_000;        // characters; D1 rows top out at 2 MB

const GAMES_KEPT = 30;              // recent games shown on a profile
const BLOCKS_KEPT = 1000;           // players one player can block
// leaves out rows by players you've blocked (binds your id)
const HIDE_BLOCKED = (col: string) => `${col} NOT IN (SELECT blocked FROM social_blocks WHERE uid = ?)`;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const RESULTS = ["1-0", "0-1", "1/2-1/2", "*"];

// Puzzle Battle: two players race through the same seeded puzzles for three minutes
const BATTLE_MS = 180_000;
const BATTLE_COUNTDOWN_MS = 5_000;
const BATTLE_FRESH_MS = 8_000;

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so each one runs
// on its own and "duplicate column" errors are expected (and ignored) once it's in place.
const MIGRATIONS = [
  `ALTER TABLE social_users ADD COLUMN room TEXT`,     // the live game a player is in, for friends to watch
  `ALTER TABLE social_users ADD COLUMN rush INTEGER NOT NULL DEFAULT 0`,   // best 5-minute Puzzle Rush
  `ALTER TABLE social_users ADD COLUMN vratings TEXT NOT NULL DEFAULT '{}'`,   // variant ratings, {variant: {r, n}}
];

// variants with their own rating (and leaderboard)
const VARIANT_KEYS = ["crazyhouse", "chess960", "threecheck", "koth", "duck", "fog", "giveaway", "atomic", "horde", "fourplayer", "fourteams"];
function cleanVariantRatings(v: unknown): Record<string, { r: number; n: number }> {
  const out: Record<string, { r: number; n: number }> = {};
  if (!v || typeof v !== "object") return out;
  for (const k of VARIANT_KEYS) {
    const slot = (v as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
    const r = Number(slot && slot["r"]), n = Number(slot && slot["n"]);
    if (Number.isFinite(r) && Number.isFinite(n) && n >= 1) out[k] = { r: Math.max(100, Math.min(4000, Math.round(r))), n: Math.min(100_000, Math.round(n)) };
  }
  return out;
}
function variantRatingsOf(u: { vratings?: string | null }): Record<string, { r: number; n: number }> {
  try { return cleanVariantRatings(JSON.parse(u.vratings || "{}")); } catch { return {}; }
}

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

// Swiss tournaments every two hours at a quarter past: Blitz (3+2, 5 rounds) and Rapid (10+0,
// 4 rounds) in turn. Joining opens two hours ahead.
const SWISS_SLOT_MS = 2 * 60 * 60_000;
const SWISS_OFFSET_MS = 15 * 60_000;
const SWISS_PRESENT_MS = 60_000;     // a player counts as here if their screen asked this recently
const SWISS_NO_SHOW_MS = 90_000;     // a room still missing a player this long after the round started is a forfeit
const SWISS_GRACE_MS = 5 * 60_000;   // a round waits this long for at least two players to be here
function swissForSlot(slot: number) {
  const blitz = slot % 2 === 0;
  return { id: `sw-${slot}`, name: blitz ? "Blitz Swiss" : "Rapid Swiss", tc: blitz ? "3+2" : "10+0", cat: blitz ? "blitz" : "rapid", rounds: blitz ? 5 : 4, starts: slot * SWISS_SLOT_MS + SWISS_OFFSET_MS };
}
// how long a round may run before an unfinished game is scored a draw
function swissRoundCap(tc: string) {
  const [m, inc] = tc.split("+").map(Number);
  return ((m ?? 3) * 60 * 2 + (inc ?? 0) * 80 + 120) * 1000;
}

export interface SwissEntrant { uid: string; score2: number; rating: number; opps: string[]; colors: string; byes: number }
// Pairs a round: players in order of score then rating; each takes the next player they haven't
// met (or the next one at all, if they've met everyone left); an odd player out gets a bye (the
// lowest-placed who hasn't had one). Colours go to whoever has had White less, else alternate.
export function swissPairings(players: SwissEntrant[]): { pairs: [string, string][]; bye: string | null } {
  const order = [...players].sort((a, b) => b.score2 - a.score2 || b.rating - a.rating || (a.uid < b.uid ? -1 : 1));
  let bye: string | null = null;
  if (order.length % 2 === 1) {
    const pick = [...order].reverse().find((p) => p.byes === 0) ?? order[order.length - 1]!;
    bye = pick.uid;
    order.splice(order.indexOf(pick), 1);
  }
  const pairs: [string, string][] = [];
  const left = [...order];
  while (left.length >= 2) {
    const a = left.shift()!;
    let j = left.findIndex((b) => !a.opps.includes(b.uid));
    if (j < 0) j = 0;
    const b = left.splice(j, 1)[0]!;
    const whites = (p: SwissEntrant) => [...p.colors].filter((c) => c === "w").length - [...p.colors].filter((c) => c === "b").length;
    const aWhite = whites(a) !== whites(b) ? whites(a) < whites(b) : a.colors.slice(-1) !== "w";
    pairs.push(aWhite ? [a.uid, b.uid] : [b.uid, a.uid]);
  }
  return { pairs, bye };
}

// club matches: sign-ups close a day after the challenge is accepted (or when an owner starts it)
const MATCH_SIGNUP_MS = 24 * 60 * 60_000;
const MATCH_TCS = ["1d", "2d", "3d", "5d", "7d"];

// daily tournaments: sign-ups close two days after one is created (or when its creator starts it)
const DTOUR_SIGNUP_MS = 2 * 86_400_000;
const DTOUR_MAX = 100;
// score each player in a round's group: 1 a win (forfeits too), ½ a draw; Sonneborn-Berger breaks ties
export function dtourGroupTable(uids: string[], games: { w_uid: string; b_uid: string; outcome: string | null }[]) {
  const pts = new Map(uids.map((u) => [u, 0]));
  const gain = (g: { outcome: string | null }, side: "w" | "b") =>
    !g.outcome ? 0 : g.outcome === "draw" ? 0.5 : g.outcome === side || g.outcome === `${side}-forfeit` ? 1 : 0;
  for (const g of games) {
    pts.set(g.w_uid, (pts.get(g.w_uid) ?? 0) + gain(g, "w"));
    pts.set(g.b_uid, (pts.get(g.b_uid) ?? 0) + gain(g, "b"));
  }
  const sb = new Map(uids.map((u) => [u, 0]));
  for (const g of games) {
    sb.set(g.w_uid, (sb.get(g.w_uid) ?? 0) + gain(g, "w") * (pts.get(g.b_uid) ?? 0));
    sb.set(g.b_uid, (sb.get(g.b_uid) ?? 0) + gain(g, "b") * (pts.get(g.w_uid) ?? 0));
  }
  return uids.map((uid) => ({ uid, points: pts.get(uid) ?? 0, sb: sb.get(uid) ?? 0 })).sort((x, y) => y.points - x.points || y.sb - x.sb);
}

// Leagues (like chess.com's): eight tiers; each week players are grouped in divisions of up to 50 of the same
// tier, earn trophies from rated games against random opponents and from arenas, and the top of each division
// moves up a tier when the week ends (nobody moves down)
export const LEAGUE_TIERS = ["Wood", "Stone", "Bronze", "Silver", "Crystal", "Elite", "Champion", "Legend"];
const LEAGUE_PROMOTE = [20, 15, 10, 5, 3, 3, 1, 0];    // places that move up, per 50 players
const LEAGUE_SIZE = 50;
const WEEK_MS = 7 * 86_400_000;
const LEAGUE_EPOCH = Date.UTC(2026, 0, 4, 19);        // a Sunday, 19:00 UTC: every league week ends at that time
export const LEAGUE_POINTS: Record<string, [number, number]> = { bullet: [3, 1], blitz: [9, 3], rapid: [15, 5] };   // win, draw
const LEAGUE_PER_OPPONENT = 4;                        // scoring games against one opponent in a day
const LEAGUE_ARENA_FACTOR = 2;
export function leagueWeek(now: number): number { return Math.floor((now - LEAGUE_EPOCH) / WEEK_MS); }
export function leagueWeekEnds(week: number): number { return LEAGUE_EPOCH + (week + 1) * WEEK_MS; }
// how many of a division move up: the tier's share of 50 places, at least one (none from Legend)
export function leaguePromotions(tier: number, size: number): number {
  const q = LEAGUE_PROMOTE[tier] ?? 0;
  return q ? Math.max(1, Math.round(size * q / LEAGUE_SIZE)) : 0;
}
// "3+2" -> blitz (chess.com's estimate over 40 moves); null for daily, unlimited and anything under a minute a side
export function tcClass(tc: string): string | null {
  const m = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(tc);
  if (!m) return null;
  const base = Number(m[1]), inc = Number(m[2]);
  if (base < 1) return null;
  const est = base * 60 + inc * 40;
  return est < 180 ? "bullet" : est < 600 ? "blitz" : "rapid";
}
// a quick-pairing room's time class from its name ("pool-3p2-<bucket>-<n>", or Chess960's "vpchess960-…")
export function leagueRoomClass(room: string): string | null {
  const m = /^(?:pool|vpchess960)-(\d+(?:_\d+)?)p(\d+)-\d+-\d+$/.exec(room);
  return m ? tcClass(`${m[1]!.replace("_", ".")}+${m[2]}`) : null;
}
// the friend code a player id carries when its player has social on ("p-x1y2z3.Name.1500.K7M2QX9P")
function codeOfPid(pid: string): string | null { return /\.([0-9A-Z]{8})$/.exec(pid)?.[1] ?? null; }

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
  rush?: number;
  vratings?: string | null;
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
    status: online ? u.status : "offline", lastSeen: u.last_seen, games: u.games, rush: u.rush ?? 0, variants: variantRatingsOf(u),
    ratings: Object.fromEntries(CATS.map((c) => [c, { r: u[`r_${c}`], n: u[`n_${c}`] }])),
  };
}

async function body(request: Request, max = 8 * 1024): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "request too large");
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
    const hash = await sha256(m[1]);
    // the profile's own key, or one of its linked devices' keys
    const u = await this.q("SELECT * FROM social_users WHERE secret_hash = ? OR id = (SELECT uid FROM social_keys WHERE hash = ?)", hash, hash).first<UserRow>();
    if (!u) throw new HttpError(401, "unknown device; register again");
    return u;
  }

  // The server's VAPID key pair (made once, kept in D1): pub is the raw P-256 point, base64url
  private async vapid(): Promise<{ pub: string; key: CryptoKey }> {
    const row = await this.q("SELECT v FROM social_config WHERE k = 'vapid'").first<{ v: string }>();
    let stored = row ? (JSON.parse(row.v) as { pub: string; jwk: JsonWebKey }) : null;
    if (!stored) {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const pub = b64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
      const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
      await this.q("INSERT OR IGNORE INTO social_config (k, v) VALUES ('vapid', ?)", JSON.stringify({ pub, jwk })).run();
      // two isolates may race: whichever pair landed first is the one everyone uses
      const again = await this.q("SELECT v FROM social_config WHERE k = 'vapid'").first<{ v: string }>();
      stored = again ? (JSON.parse(again.v) as { pub: string; jwk: JsonWebKey }) : { pub, jwk };
    }
    const key = await crypto.subtle.importKey("jwk", stored.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return { pub: stored.pub, key };
  }

  // A VAPID JWT (ES256) for one push service origin
  private async vapidHeader(endpoint: string): Promise<string> {
    const { pub, key } = await this.vapid();
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(this.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
    return `vapid t=${unsigned}.${b64url(sig)}, k=${pub}`;
  }

  // Wake a player's devices: an empty push, after which their service worker asks /notes what it was
  private pushTo(uid: string) {
    const send = (async () => {
      const r = await this.q("SELECT endpoint FROM social_push WHERE uid = ?", uid).all<{ endpoint: string }>();
      const go = this.hooks.pushFetch ?? ((url: string, init: RequestInit) => fetch(url, init));
      for (const { endpoint } of r.results) {
        try {
          const res = await go(endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", Authorization: await this.vapidHeader(endpoint), "Content-Length": "0" } });
          if (res.status === 404 || res.status === 410) await this.q("DELETE FROM social_push WHERE endpoint = ?", endpoint).run();
        } catch (e) { console.error("push failed", e); }
      }
    })();
    if (this.hooks.waitUntil) this.hooks.waitUntil(send); else send.catch(() => {});
  }

  private async feeds(now: number): Promise<unknown> {
    const row = await this.q("SELECT v FROM social_config WHERE k = 'feeds'").first<{ v: string }>();
    const cached = row ? (JSON.parse(row.v) as { at: number }) : null;
    if (cached && now - cached.at < FEEDS_MS) return cached;
    const get = this.hooks.feedFetch ?? ((url: string) => fetch(url, { headers: { "User-Agent": "Chess3D/1.0 (+https://chess3d-five.vercel.app)" } }));
    const text = async (url: string) => { try { const r = await get(url); return r.ok ? await r.text() : ""; } catch { return ""; } };
    const json = async (url: string) => { try { const r = await get(url); return r.ok ? await r.json() : null; } catch { return null; } };
    const [newsXml, videoXml, lichessLive, chesscomStreamers] = await Promise.all([
      Promise.all(NEWS_FEEDS.map((f) => text(f.url))),
      Promise.all(VIDEO_CHANNELS.map((c) => text(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`))),
      json("https://lichess.org/api/streamer/live"),
      json("https://api.chess.com/pub/streamers"),
    ]);
    const news: { title: string; link: string; source: string; date: number }[] = [];
    NEWS_FEEDS.forEach((f, i) => {
      const xml = newsXml[i] ?? "";
      const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
      for (const it of items.slice(0, 6)) {
        const link = httpsUrl(tag(it, "link") || (/<link[^>]*href="([^"]+)"/.exec(it)?.[1] ?? ""));
        const date = Date.parse(tag(it, "pubDate") || tag(it, "published") || tag(it, "updated")) || 0;
        const title = tag(it, "title");
        if (title && link) news.push({ title: title.slice(0, 200), link, source: f.source, date });
      }
    });
    news.sort((a, b) => b.date - a.date);
    const videos: { id: string; title: string; channel: string; date: number }[] = [];
    VIDEO_CHANNELS.forEach((c, i) => {
      // three per channel, so the busiest uploaders don't crowd out the rest
      for (const e of ((videoXml[i] ?? "").match(/<entry>[\s\S]*?<\/entry>/g) || []).slice(0, 3)) {
        const id = tag(e, "yt:videoId");
        if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) videos.push({ id, title: tag(e, "title").slice(0, 200), channel: c.channel, date: Date.parse(tag(e, "published")) || 0 });
      }
    });
    videos.sort((a, b) => b.date - a.date);
    const streamers: { name: string; title: string; platform: string; url: string; image: string | null; source: string }[] = [];
    for (const s of Array.isArray(lichessLive) ? (lichessLive as Record<string, any>[]).slice(0, 12) : []) {
      const st = s["streamer"] || {}, stream = s["stream"] || {};
      const url = httpsUrl(st["twitch"] || st["youTube"] || "");
      if (url) streamers.push({ name: String(st["name"] || s["name"] || "").slice(0, 60), title: String(stream["status"] || "").slice(0, 140), platform: String(stream["service"] || ""), url, image: httpsUrl(st["image"] || ""), source: "Lichess" });
    }
    const cs = chesscomStreamers && Array.isArray((chesscomStreamers as Record<string, unknown>)["streamers"]) ? ((chesscomStreamers as Record<string, any>)["streamers"] as Record<string, any>[]) : [];
    for (const s of cs.filter((x) => x["is_live"]).slice(0, 12)) {
      const live = (Array.isArray(s["platforms"]) ? s["platforms"] : []).find((p: Record<string, unknown>) => p["is_live"]) || {};
      const url = httpsUrl(live["stream_url"] || live["channel_url"] || s["twitch_url"] || "");
      if (url) streamers.push({ name: String(s["username"] || "").slice(0, 60), title: "", platform: String(live["type"] || ""), url, image: httpsUrl(s["avatar"] || ""), source: "Chess.com" });
    }
    const fresh = { at: now, news: news.slice(0, 18), videos: videos.slice(0, 15), streamers };
    // keep the old copy if every source failed this time
    if (!news.length && !videos.length && !streamers.length && cached) return cached;
    await this.q("INSERT OR REPLACE INTO social_config (k, v) VALUES ('feeds', ?)", JSON.stringify(fresh)).run();
    return fresh;
  }

  private async nameTaken(name: string, exceptId: string): Promise<boolean> {
    return !!(await this.q("SELECT 1 AS x FROM social_users WHERE name = ? COLLATE NOCASE AND id <> ?", name, exceptId).first());
  }

  private async user(id: string): Promise<UserRow | null> {
    return this.q("SELECT * FROM social_users WHERE id = ?", id).first<UserRow>();
  }

  // a two-player game's result from its room: "w", "b" or "draw" (aborted counts as a draw) once it's over;
  // "w-forfeit", "b-forfeit" or "double-forfeit" when it hasn't started noShowMs after it was paired (whoever
  // came wins); null while it's on
  private async roomOutcome(room: string, wPid: string, bPid: string, created: number, noShowMs: number, now: number): Promise<string | null> {
    const st = this.hooks.roomState ? await this.hooks.roomState(room) : null;
    if (st && st.status === "over" && st.result) {
      const r = st.result;
      return r.reason === "aborted" || r.draw ? "draw" : r.winner === wPid ? "w" : r.winner === bPid ? "b" : "draw";
    }
    if ((!st || st.status === "waiting") && now - created > noShowMs) {
      const seated = st ? st.seats : [];
      return seated.includes(wPid) ? "w-forfeit" : seated.includes(bPid) ? "b-forfeit" : "double-forfeit";
    }
    return null;
  }

  private async blockedEitherWay(a: string, b: string): Promise<boolean> {
    return !!(await this.q("SELECT 1 AS x FROM social_blocks WHERE (uid = ? AND blocked = ?) OR (uid = ? AND blocked = ?)", a, b, b, a).first());
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
      // names are unique (ignoring case): a taken one gets a number on the end
      let finalName = name;
      for (let i = 0; i < 6 && (await this.nameTaken(finalName, "")); i++) {
        finalName = name.slice(0, 11) + String(Math.floor(10 + Math.random() * (i < 3 ? 990 : 99990)));
      }
      const [recent, taken] = await this.many(
        this.q("SELECT COUNT(*) AS n FROM social_reg_log WHERE ip = ? AND at > ?", ip, now - 3_600_000),
        this.q("SELECT 1 AS x FROM social_users WHERE code = ?", code));
      if (Number(recent?.[0]?.["n"] ?? 0) >= 20) throw new HttpError(429, "too many registrations; slow down");
      for (let i = 0; taken?.length && i < 4 && (await this.q("SELECT 1 AS x FROM social_users WHERE code = ?", code).first()); i++) code = randomString(8);
      await this.many(
        this.q("INSERT INTO social_users (id, secret_hash, code, name, avatar, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, await sha256(secret), code, finalName, cleanAvatar(b["avatar"]), now, now),
        this.q("INSERT INTO social_reg_log (ip, at) VALUES (?, ?)", ip, now));
      return { id, secret, code, name: finalName };
    }

    // GET /feeds: news, videos and live streamers (public, no key needed)
    if (method === "GET" && path === "/feeds") return this.feeds(now);

    // POST /link/claim {code}: sign this device in to a profile with a code made on another device
    if (method === "POST" && path === "/link/claim") {
      const b = await body(request);
      const code = str(b["code"], 8).toUpperCase();
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const [recent] = await this.many(
        this.q("SELECT COUNT(*) AS n FROM social_reg_log WHERE ip = ? AND at > ?", ip, now - 3_600_000),
        this.q("INSERT INTO social_reg_log (ip, at) VALUES (?, ?)", ip, now));
      if (Number(recent?.[0]?.["n"] ?? 0) >= 20) throw new HttpError(429, "too many attempts; slow down");
      const link = await this.q("SELECT uid FROM social_links WHERE code = ? AND expires > ?", code, now).first<{ uid: string }>();
      if (!link) throw new HttpError(404, "that code is wrong or has expired");
      const u = await this.user(link.uid);
      if (!u) throw new HttpError(404, "that profile no longer exists");
      const secret = randomSecret();
      await this.many(
        this.q("DELETE FROM social_links WHERE code = ?", code),
        this.q("INSERT INTO social_keys (hash, uid, created) VALUES (?, ?, ?)", await sha256(secret), u.id, now));
      return { id: u.id, secret, code: u.code, name: u.name };
    }

    const me = await this.auth(request);

    // ---- account: devices and cloud backup ----
    // POST /link/create: a one-time code to sign in on another device
    if (method === "POST" && path === "/link/create") {
      const code = randomString(8);
      await this.many(
        this.q("DELETE FROM social_links WHERE uid = ? OR expires < ?", me.id, now),
        this.q("INSERT INTO social_links (code, uid, expires) VALUES (?, ?, ?)", code, me.id, now + LINK_MS));
      return { code, expires: now + LINK_MS };
    }
    // GET /devices: how many devices are signed in to this profile
    if (method === "GET" && path === "/devices") {
      const r = await this.q("SELECT COUNT(*) AS n FROM social_keys WHERE uid = ?", me.id).first<{ n: number }>();
      return { devices: 1 + (r ? r.n : 0) };
    }
    // POST /devices/reset: sign out every other device; this one gets a fresh key (and recovery key)
    if (method === "POST" && path === "/devices/reset") {
      const secret = randomSecret();
      await this.many(
        this.q("UPDATE social_users SET secret_hash = ? WHERE id = ?", await sha256(secret), me.id),
        this.q("DELETE FROM social_keys WHERE uid = ?", me.id),
        this.q("DELETE FROM social_links WHERE uid = ?", me.id));
      return { secret };
    }
    // GET /backup and POST /backup {data}: your profile, ratings, settings and games, kept in the cloud
    if (method === "GET" && path === "/backup") {
      const r = await this.q("SELECT data, updated FROM social_backups WHERE uid = ?", me.id).first<{ data: string; updated: number }>();
      return r ? { data: r.data, updated: r.updated } : { data: null, updated: null };
    }
    if (method === "POST" && path === "/backup") {
      const b = await body(request, BACKUP_MAX + 1024);
      const data = typeof b["data"] === "string" ? b["data"] : "";
      if (!data || data.length > BACKUP_MAX) throw new HttpError(400, "backup missing or too large");
      try { const v = JSON.parse(data); if (!v || v.v !== 1) throw new Error("bad"); } catch { throw new HttpError(400, "that isn't a Chess 3D backup"); }
      await this.q("INSERT OR REPLACE INTO social_backups (uid, data, updated) VALUES (?, ?, ?)", me.id, data, now).run();
      return { ok: true, updated: now };
    }

    // ---- notifications when the app is closed (web push) ----
    if (method === "GET" && path === "/push/key") return { key: (await this.vapid()).pub };
    if (method === "POST" && path === "/push/subscribe") {
      const b = await body(request);
      const endpoint = str(b["endpoint"], 800);
      if (!pushHostOk(endpoint)) throw new HttpError(400, "that isn't a browser push address");
      await this.q("INSERT OR REPLACE INTO social_push (endpoint, uid, created) VALUES (?, ?, ?)", endpoint, me.id, now).run();
      return { ok: true };
    }
    if (method === "POST" && path === "/push/unsubscribe") {
      const b = await body(request);
      await this.q("DELETE FROM social_push WHERE endpoint = ? AND uid = ?", str(b["endpoint"], 800), me.id).run();
      return { ok: true };
    }
    // GET /notes: what a push was about (the service worker asks, then shows a notification)
    if (method === "GET" && path === "/notes") {
      const [msgs, reqs, notes] = await this.many(
        this.q(`SELECT m.id, m.kind, m.body, m.created, u.name AS sender_name, m.sender FROM social_messages m
            JOIN social_users u ON u.id = m.sender WHERE m.recipient = ? AND m.seen = 0 ORDER BY m.id DESC LIMIT 3`, me.id),
        this.q(`SELECT u.name, f.created FROM social_friends f JOIN social_users u ON u.id = f.a
            WHERE f.b = ? AND f.state = 'pending' ORDER BY f.created DESC LIMIT 1`, me.id),
        this.q("SELECT id, kind, body, created FROM social_notes WHERE uid = ? AND created > ? ORDER BY id DESC LIMIT 3", me.id, now - 3_600_000));
      return { messages: msgs ?? [], request: reqs?.[0] ?? null, notes: notes ?? [], now };
    }
    // POST /nudge {code, room, san}: tell a daily-game opponent it's their move
    if (method === "POST" && path === "/nudge") {
      const b = await body(request);
      const code = str(b["code"], 8).toUpperCase(), room = str(b["room"], 64), san = cleanText(b["san"], 10);
      if (!ROOM_RE.test(room)) throw new HttpError(400, "bad room");
      const them = await this.q("SELECT id FROM social_users WHERE code = ?", code).first<{ id: string }>();
      if (!them || them.id === me.id) return { ok: false };
      if (await this.blockedEitherWay(me.id, them.id)) return { ok: false };
      const recent = await this.q("SELECT COUNT(*) AS n FROM social_notes WHERE uid = ? AND created > ? AND body LIKE ?", them.id, now - 60_000, `%"room":"${room}"%`).first<{ n: number }>();
      if (recent && recent.n > 0) return { ok: true };
      await this.many(
        this.q("INSERT INTO social_notes (uid, kind, body, created) VALUES (?, 'move', ?, ?)", them.id, JSON.stringify({ room, from: me.name, san }), now),
        this.q("DELETE FROM social_notes WHERE uid = ? AND created < ?", them.id, now - 86_400_000));
      this.pushTo(them.id);
      return { ok: true };
    }

    // POST /heartbeat {status, name, avatar, ratings, games} -> {me, unread, requests}
    if (method === "POST" && path === "/heartbeat") {
      const b = await body(request);
      const status = b["status"] === "playing" ? "playing" : "online";
      // a rename only goes through if nobody else has that name
      const wanted = NAME_RE.test(str(b["name"], 16)) ? str(b["name"], 16) : me.name;
      const name = wanted.toLowerCase() === me.name.toLowerCase() || !(await this.nameTaken(wanted, me.id)) ? wanted : me.name;
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
      const rushIn = Number(b["rush"]);
      const rush = Number.isFinite(rushIn) ? Math.max(0, Math.min(300, Math.round(rushIn))) : (me.rush ?? 0);
      const vratings = b["vratings"] !== undefined ? JSON.stringify(cleanVariantRatings(b["vratings"])) : (me.vratings ?? "{}");
      const [, unread, reqs, latest, updated] = await this.many(
        this.q(`UPDATE social_users SET last_seen = ?, status = ?, name = ?, avatar = ?, games = ?, room = ?, rush = ?, vratings = ?,
            r_bullet = ?, n_bullet = ?, r_blitz = ?, n_blitz = ?, r_rapid = ?, n_rapid = ?,
            r_puzzle = ?, n_puzzle = ?, r_bots = ?, n_bots = ? WHERE id = ?`,
          now, status, name, avatar, games, room, rush, vratings,
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
      const [sent, mine, theirs, blocks] = await this.many(
        this.q("SELECT COUNT(*) AS n FROM social_friends WHERE a = ? AND created > ?", me.id, now - 3_600_000),
        this.q("SELECT state FROM social_friends WHERE a = ? AND b = ?", me.id, them.id),
        this.q("SELECT state FROM social_friends WHERE a = ? AND b = ?", them.id, me.id),
        this.q("SELECT uid FROM social_blocks WHERE (uid = ? AND blocked = ?) OR (uid = ? AND blocked = ?)", me.id, them.id, them.id, me.id));
      if (blocks?.some((k) => k["uid"] === me.id)) throw new HttpError(403, "you've blocked this player; unblock them first");
      if (blocks?.length) throw new HttpError(403, "this player isn't taking friend requests from you");
      if (mine?.[0]?.["state"] === "accepted") return { status: "friends" };
      if (Number(sent?.[0]?.["n"] ?? 0) >= 40) throw new HttpError(429, "too many friend requests; slow down");
      // they already asked us: accept straight away
      if (theirs?.[0]?.["state"] === "pending") { await this.accept(them.id, me.id, now); return { status: "friends" }; }
      await this.q("INSERT OR IGNORE INTO social_friends (a, b, state, created) VALUES (?, ?, 'pending', ?)", me.id, them.id, now).run();
      this.pushTo(them.id);
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

    // ---- blocking ----
    if (method === "GET" && path === "/blocks") {
      const r = await this.q("SELECT u.* FROM social_blocks k JOIN social_users u ON u.id = k.blocked WHERE k.uid = ? ORDER BY k.created DESC", me.id).all<UserRow>();
      return { blocked: r.results.map((u) => publicUser(u, now)) };
    }
    // POST /block {id} or {code}: ends any friendship or request between you, and their unread messages to you are put away
    if (method === "POST" && path === "/block") {
      const b = await body(request);
      const byCode = b["code"] ? await this.q("SELECT id FROM social_users WHERE code = ?", str(b["code"], 8).toUpperCase()).first<{ id: string }>() : null;
      const other = byCode ? byCode.id : str(b["id"], 32);
      if (other === me.id) throw new HttpError(400, "you can't block yourself");
      if (!(await this.user(other))) throw new HttpError(404, "no such player");
      const n = await this.q("SELECT COUNT(*) AS n FROM social_blocks WHERE uid = ?", me.id).first<{ n: number }>();
      if (n && n.n >= BLOCKS_KEPT) throw new HttpError(429, `you can block up to ${BLOCKS_KEPT} players`);
      await this.many(
        this.q("INSERT OR IGNORE INTO social_blocks (uid, blocked, created) VALUES (?, ?, ?)", me.id, other, now),
        this.q("DELETE FROM social_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", me.id, other, other, me.id),
        this.q("UPDATE social_messages SET seen = 1 WHERE sender = ? AND recipient = ? AND seen = 0", other, me.id));
      return { ok: true };
    }
    if (method === "POST" && path === "/unblock") {
      await this.q("DELETE FROM social_blocks WHERE uid = ? AND blocked = ?", me.id, str((await body(request))["id"], 32)).run();
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
      this.pushTo(to);
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
    // club team matches (before the club routes, which would take /clubs/:id/matches)
    if (seg0 === "matches" || (seg0 === "clubs" && seg2 === "matches")) return this.clubMatches(request, me, seg, now);
    if (seg0 === "league") return this.league(request, me, seg, now);
    if (seg0 === "dailytours") return this.dailyTours(request, me, seg, now);
    if (seg0 === "votechess" || (seg0 === "clubs" && seg2 === "votechess")) return this.voteChess(request, me, seg, now);
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
              JOIN social_users u ON u.id = m.sender WHERE m.club = ? AND ${HIDE_BLOCKED("m.sender")} ORDER BY m.id DESC LIMIT 60`, id, me.id));
        if (!member?.length) throw denied();
        const mem = (members ?? []) as unknown as (UserRow & { role: string })[];
        return { club: club?.[0] ?? null, members: mem.map((u) => ({ ...publicUser(u, now), role: u.role })), messages: (msgs ?? []).reverse() };
      }
      if (seg2 === "messages" && method === "GET") {
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const [member, msgs] = await this.many(memberQ,
          this.q(`SELECT m.id, m.sender, u.name AS sender_name, m.body, m.created FROM social_messages m
              JOIN social_users u ON u.id = m.sender WHERE m.club = ? AND m.id > ? AND ${HIDE_BLOCKED("m.sender")} ORDER BY m.id DESC LIMIT 60`, id, after, me.id));
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
    if (method === "GET" && path === "/leaderboard" && url.searchParams.get("cat") === "rush") {
      // best 5-minute Puzzle Rush scores
      const since = now - 30 * 86_400_000, mine = me.rush ?? 0;
      const [top, rank, total] = await this.many(
        this.q("SELECT * FROM social_users WHERE rush > 0 AND last_seen > ? ORDER BY rush DESC, last_seen DESC LIMIT 50", since),
        this.q("SELECT COUNT(*) AS n FROM social_users WHERE rush > ? AND last_seen > ?", mine, since),
        this.q("SELECT COUNT(*) AS n FROM social_users WHERE rush > 0 AND last_seen > ?", since));
      return {
        cat: "rush", minGames: 1, top: (top ?? []).map((u) => publicUser(u as unknown as UserRow, now)),
        me: { rank: mine > 0 ? Number(rank?.[0]?.["n"] ?? 0) + 1 : null, rating: mine, games: null },
        total: Number(total?.[0]?.["n"] ?? 0),
      };
    }
    if (method === "GET" && path === "/leaderboard" && VARIANT_KEYS.includes(url.searchParams.get("cat") || "")) {
      // a variant's top players (the JSON path comes from the fixed list above, never from input)
      const key = VARIANT_KEYS.find((k) => k === url.searchParams.get("cat"))!;
      const since = now - 30 * 86_400_000, mine = variantRatingsOf(me)[key];
      const r = `json_extract(vratings, '$.${key}.r')`, n = `json_extract(vratings, '$.${key}.n')`;
      const [top, rank, total] = await this.many(
        this.q(`SELECT * FROM social_users WHERE ${n} >= 1 AND last_seen > ? ORDER BY ${r} DESC, ${n} DESC LIMIT 50`, since),
        this.q(`SELECT COUNT(*) AS n FROM social_users WHERE ${n} >= 1 AND last_seen > ? AND ${r} > ?`, since, mine ? mine.r : 0),
        this.q(`SELECT COUNT(*) AS n FROM social_users WHERE ${n} >= 1 AND last_seen > ?`, since));
      return {
        cat: key, minGames: 1, top: (top ?? []).map((u) => publicUser(u as unknown as UserRow, now)),
        me: { rank: mine ? Number(rank?.[0]?.["n"] ?? 0) + 1 : null, rating: mine ? mine.r : null, games: mine ? mine.n : 0 },
        total: Number(total?.[0]?.["n"] ?? 0),
      };
    }
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
    if (seg0 === "swiss") return this.swiss(request, me, seg, now);
    if (seg0 === "battles") return this.battles(request, me, seg, now);

    // POST /games {game}: share a finished game on your profile (the last 30 are kept)
    if (method === "POST" && path === "/games") {
      const b = await body(request);
      const g = (b["game"] && typeof b["game"] === "object" ? b["game"] : {}) as Record<string, unknown>;
      const side = (v: unknown) => {
        const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
        const r = Number(o["rating"]);
        return { name: cleanText(o["name"], 24) || "?", rating: Number.isFinite(r) ? Math.round(r) : null };
      };
      const moves = Array.isArray(g["moves"]) ? (g["moves"] as unknown[]).slice(0, 600).filter((m): m is string => typeof m === "string" && UCI_RE.test(m)) : [];
      const result = RESULTS.includes(String(g["result"])) ? String(g["result"]) : "*";
      if (!moves.length) throw new HttpError(400, "a game needs moves");
      const gid = str(g["id"], 24).replace(/[^A-Za-z0-9]/g, "") || randomString(10);
      const data = {
        id: gid, white: side(g["white"]), black: side(g["black"]), result, reason: cleanText(g["reason"], 24),
        tc: str(g["tc"], 8), mode: ["bot", "online", "local"].includes(String(g["mode"])) ? String(g["mode"]) : "online",
        variant: cleanText(g["variant"], 16), myColor: g["myColor"] === "b" ? "b" : g["myColor"] === "w" ? "w" : null,
        startFen: cleanText(g["startFen"], 100) || null, opening: cleanText(g["opening"], 80) || null,
        date: Number.isFinite(Number(g["date"])) ? Number(g["date"]) : now, moves,
      };
      await this.many(
        this.q("INSERT OR REPLACE INTO social_games (id, uid, created, data) VALUES (?, ?, ?, ?)", `${me.id}:${gid}`, me.id, now, JSON.stringify(data)),
        this.q(`DELETE FROM social_games WHERE uid = ? AND id NOT IN (
            SELECT id FROM social_games WHERE uid = ? ORDER BY created DESC LIMIT ?)`, me.id, me.id, GAMES_KEPT));
      return { ok: true };
    }

    // ---- forums, blogs, coaches ----
    if (seg0 === "forums" || path === "/report") return this.forums(request, me, seg, url, now);
    if (seg0 === "blogs") return this.blogs(request, me, seg, url, now);
    if (seg0 === "coaches") return this.coaches(request, me, seg, now);

    // GET /names?n=: is a name free?
    if (method === "GET" && path === "/names") {
      const n = str(url.searchParams.get("n"), 16);
      return { name: n, valid: NAME_RE.test(n), available: NAME_RE.test(n) && !(await this.nameTaken(n, me.id)) };
    }

    // GET /search?q=: players whose name starts with q (most recently active first)
    if (method === "GET" && path === "/search") {
      const q = str(url.searchParams.get("q"), 16).replace(/[^A-Za-z0-9_]/g, "");
      if (q.length < 2) return { players: [] };
      const r = await this.q(`SELECT * FROM social_users WHERE name LIKE ? ESCAPE '\\' ORDER BY last_seen DESC LIMIT 20`,
        q.replace(/_/g, "\\_") + "%").all<UserRow>();
      return { players: r.results.map((u) => publicUser(u, now)) };
    }

    // GET /users/:id/games: a player's recent games
    if (method === "GET" && seg0 === "users" && seg1 && seg2 === "games") {
      const r = await this.q("SELECT data FROM social_games WHERE uid = ? ORDER BY created DESC LIMIT ?", seg1, GAMES_KEPT).all<{ data: string }>();
      const games = r.results.map((x) => { try { return JSON.parse(x.data); } catch { return null; } }).filter(Boolean);
      return { games };
    }

    // GET /users/:id — a friend's or club-mate's public profile
    if (method === "GET" && seg0 === "users" && seg1) {
      const [ur, blocked, lg] = await this.many(this.q("SELECT * FROM social_users WHERE id = ?", seg1),
        this.q("SELECT 1 AS x FROM social_blocks WHERE uid = ? AND blocked = ?", me.id, seg1),
        this.q("SELECT tier FROM social_league WHERE uid = ?", seg1));
      const u = ur?.[0] as UserRow | undefined;
      if (!u) throw new HttpError(404, "no such player");
      return { user: publicUser(u, now), blocked: !!blocked?.length, league: lg?.length ? Number(lg[0]!["tier"]) : null };
    }

    // POST /delete: remove this player, their friendships, messages and club memberships
    if (method === "POST" && path === "/delete") {
      const [clubs] = await this.many(
        this.q("SELECT club FROM social_club_members WHERE member = ?", me.id),
        this.q("DELETE FROM social_friends WHERE a = ? OR b = ?", me.id, me.id),
        this.q("DELETE FROM social_blocks WHERE uid = ? OR blocked = ?", me.id, me.id),
        this.q("DELETE FROM social_league WHERE uid = ?", me.id),
        this.q("DELETE FROM social_dtour_players WHERE uid = ? AND tid IN (SELECT id FROM social_dtours WHERE status = 'signup')", me.id),
        this.q("DELETE FROM social_league_entries WHERE uid = ?", me.id),
        this.q("DELETE FROM social_league_games WHERE uid = ?", me.id),
        this.q("DELETE FROM social_messages WHERE sender = ? OR recipient = ?", me.id, me.id),
        this.q("DELETE FROM social_club_members WHERE member = ?", me.id),
        this.q("DELETE FROM social_club_bans WHERE member = ?", me.id),
        this.q("DELETE FROM social_arena_players WHERE uid = ?", me.id),
        this.q("UPDATE social_swiss_players SET withdrawn = 1 WHERE uid = ?", me.id),
        this.q("DELETE FROM social_club_match_players WHERE uid = ? AND mid IN (SELECT id FROM social_club_matches WHERE status IN ('challenge', 'signup'))", me.id),
        this.q("DELETE FROM social_games WHERE uid = ?", me.id),
        this.q("DELETE FROM social_keys WHERE uid = ?", me.id),
        this.q("DELETE FROM social_links WHERE uid = ?", me.id),
        this.q("DELETE FROM social_backups WHERE uid = ?", me.id),
        this.q("DELETE FROM social_posts WHERE uid = ?", me.id),
        this.q("DELETE FROM social_topics WHERE uid = ?", me.id),
        this.q("DELETE FROM social_blog_likes WHERE blog IN (SELECT id FROM social_blogs WHERE uid = ?)", me.id),
        this.q("DELETE FROM social_blogs WHERE uid = ?", me.id),
        this.q("DELETE FROM social_coaches WHERE uid = ?", me.id),
        this.q("DELETE FROM social_reports WHERE uid = ?", me.id),
        this.q("DELETE FROM social_push WHERE uid = ?", me.id),
        this.q("DELETE FROM social_notes WHERE uid = ?", me.id),
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
      const final = await this.q("SELECT outcome, token FROM social_arena_games WHERE room = ?", room).first<{ outcome: string; token: string }>();
      // the request that scored the game also gives both players their league trophies (arena games count double)
      const cls = final?.token === token && outcome !== "void" ? tcClass(String((await this.q("SELECT tc FROM social_arenas WHERE id = ?", id).first<{ tc: string }>())?.tc ?? "")) : null;
      if (cls) {
        const [win, draw] = LEAGUE_POINTS[cls]!;
        const pts = (side: string) => LEAGUE_ARENA_FACTOR * (outcome === side ? win : outcome === "draw" ? draw : 0);
        await this.leagueCredit(game.a_uid, room, game.b_uid, pts("a"), now);
        await this.leagueCredit(game.b_uid, room, game.a_uid, pts("b"), now);
      }
      return { outcome: final?.outcome ?? outcome, you: game.a_uid === me.id ? "a" : "b" };
    }
    throw new HttpError(404, "not found");
  }

  // ---- daily tournaments ----
  // Like chess.com's: players sign up; each round splits the players still in into groups (snake-seeded by
  // rating) that play a double round robin of daily games, one with each colour against everyone in the
  // group. Group winners go through until one group is left; its winner wins the tournament.
  // GET /dailytours: open, running and recent ones; POST /dailytours {name, tc, size, pid}: create one (and join it)
  // GET /dailytours/:id: groups, standings and games (also moves it along)
  // POST /dailytours/:id/join {pid} | leave | start (its creator, with at least 3 players)
  private async dailyTours(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    if (seg.length === 1 && method === "GET") {
      const r = await this.q(`SELECT t.id, t.name, t.tc, t.size, t.status, t.round, t.starts, t.created, t.winner, w.name AS winner_name,
          (SELECT COUNT(*) FROM social_dtour_players p WHERE p.tid = t.id) AS players,
          EXISTS (SELECT 1 FROM social_dtour_players p WHERE p.tid = t.id AND p.uid = ?) AS joined
          FROM social_dtours t LEFT JOIN social_users w ON w.id = t.winner
          WHERE t.status IN ('signup', 'running') OR t.created > ?
          ORDER BY CASE t.status WHEN 'signup' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, t.created DESC LIMIT 40`, me.id, now - 30 * 86_400_000).all();
      return { tournaments: r.results, now };
    }
    if (seg.length === 1 && method === "POST") {
      const b = await body(request);
      const name = cleanText(b["name"], 60).trim();
      if (name.length < 3) throw new HttpError(400, "give the tournament a name");
      const tc = MATCH_TCS.includes(String(b["tc"])) ? String(b["tc"]) : "3d";
      const size = Math.max(3, Math.min(10, Math.round(Number(b["size"]) || 6)));
      const pid = str(b["pid"], 64);
      if (!PID_RE.test(pid)) throw new HttpError(400, "bad player id");
      await this.rateLimit("SELECT COUNT(*) AS n FROM social_dtours WHERE owner = ? AND created > ?", [me.id, now - 86_400_000], 3, "new tournaments today");
      const id = "dt_" + randomString(10).toLowerCase();
      await this.many(
        this.q("INSERT INTO social_dtours (id, name, owner, tc, size, created, starts) VALUES (?, ?, ?, ?, ?, ?, ?)", id, name, me.id, tc, size, now, now + DTOUR_SIGNUP_MS),
        this.q("INSERT INTO social_dtour_players (tid, uid, pid, joined) VALUES (?, ?, ?, ?)", id, me.id, pid, now));
      return { id };
    }
    const id = str(seg[1], 32);
    type T = { id: string; owner: string; tc: string; size: number; status: string; round: number; starts: number };
    const t = await this.q("SELECT * FROM social_dtours WHERE id = ?", id).first<T>();
    if (!t) throw new HttpError(404, "no such tournament");
    const action = seg[2] ?? "";
    const count = async () => (await this.q("SELECT COUNT(*) AS n FROM social_dtour_players WHERE tid = ?", id).first<{ n: number }>())?.n ?? 0;
    if (method === "POST" && action === "join") {
      if (t.status !== "signup") throw new HttpError(409, "sign-ups are closed");
      const pid = str((await body(request))["pid"], 64);
      if (!PID_RE.test(pid)) throw new HttpError(400, "bad player id");
      if ((await count()) >= DTOUR_MAX) throw new HttpError(409, "the tournament is full");
      await this.q("INSERT OR REPLACE INTO social_dtour_players (tid, uid, pid, joined) VALUES (?, ?, ?, ?)", id, me.id, pid, now).run();
    } else if (method === "POST" && action === "leave") {
      if (t.status !== "signup") throw new HttpError(409, "the tournament has started");
      await this.q("DELETE FROM social_dtour_players WHERE tid = ? AND uid = ?", id, me.id).run();
    } else if (method === "POST" && action === "start") {
      if (t.owner !== me.id) throw new HttpError(403, "only the tournament's creator can start it early");
      if (t.status !== "signup") throw new HttpError(409, "it has already started");
      if ((await count()) < 3) throw new HttpError(409, "a tournament needs at least 3 players");
      await this.dtourRound(t, 1, now);
    } else if (!(method === "GET" && seg.length === 2)) throw new HttpError(404, "not found");
    await this.dtourTick(id, now);
    return this.dtourView(id, me, now);
  }

  // start round n: the players still in, snake-seeded by rating into groups of at most `size`
  private async dtourRound(t: { id: string; size: number }, n: number, now: number) {
    const token = randomString(12);
    await this.q("UPDATE social_dtours SET status = 'running', round = ?, token = ? WHERE id = ? AND round = ? AND status IN ('signup', 'running')", n, token, t.id, n - 1).run();
    const mine = await this.q("SELECT token FROM social_dtours WHERE id = ?", t.id).first<{ token: string }>();
    if (!mine || mine.token !== token) return;
    const players = (await this.q(`SELECT p.uid, p.pid FROM social_dtour_players p JOIN social_users u ON u.id = p.uid
        WHERE p.tid = ? AND p.out_round IS NULL ORDER BY u.r_rapid DESC, p.joined`, t.id).all<{ uid: string; pid: string }>()).results;
    if (players.length < 2) {
      await this.q("UPDATE social_dtours SET status = 'done', winner = ? WHERE id = ?", players[0]?.uid ?? null, t.id).run();
      return;
    }
    const groups = Math.ceil(players.length / t.size);
    const seats = players.map((p, i) => {
      const lap = Math.floor(i / groups), pos = i % groups;
      return { ...p, grp: lap % 2 === 0 ? pos : groups - 1 - pos };
    });
    const stmts = seats.map((s) => this.q("INSERT OR REPLACE INTO social_dtour_seats (tid, round, uid, grp) VALUES (?, ?, ?, ?)", t.id, n, s.uid, s.grp));
    for (let g = 0; g < groups; g++) {
      const mem = seats.filter((s) => s.grp === g);
      for (let i = 0; i < mem.length; i++) for (let j = i + 1; j < mem.length; j++) {
        for (const [w, b] of [[mem[i]!, mem[j]!], [mem[j]!, mem[i]!]] as const) {
          stmts.push(this.q("INSERT INTO social_dtour_games (room, tid, round, grp, w_uid, w_pid, b_uid, b_pid, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            "dt" + randomString(10).toLowerCase(), t.id, n, g, w.uid, w.pid, b.uid, b.pid, now));
        }
      }
    }
    for (let k = 0; k < stmts.length; k += 50) await this.many(...stmts.slice(k, k + 50));
  }

  // start when sign-ups close; score games from their rooms; when a round's games are all done, the group
  // winners go through (or, with one group, its winner wins)
  private async dtourTick(id: string, now: number) {
    const t = await this.q("SELECT * FROM social_dtours WHERE id = ?", id).first<{ id: string; tc: string; size: number; status: string; round: number; starts: number }>();
    if (!t) return;
    if (t.status === "signup") {
      if (now < t.starts) return;
      const n = (await this.q("SELECT COUNT(*) AS n FROM social_dtour_players WHERE tid = ?", id).first<{ n: number }>())?.n ?? 0;
      if (n >= 3) await this.dtourRound(t, 1, now);
      else await this.q("UPDATE social_dtours SET status = 'cancelled' WHERE id = ? AND status = 'signup'", id).run();
      return;
    }
    if (t.status !== "running") return;
    const days = Number(t.tc.replace("d", "")) || 3;
    const open = (await this.q("SELECT room, w_pid, b_pid, created FROM social_dtour_games WHERE tid = ? AND round = ? AND outcome IS NULL LIMIT 12", id, t.round)
      .all<{ room: string; w_pid: string; b_pid: string; created: number }>()).results;
    for (const g of open) {
      const outcome = await this.roomOutcome(g.room, g.w_pid, g.b_pid, g.created, days * 86_400_000, now);
      if (outcome) await this.q("UPDATE social_dtour_games SET outcome = ? WHERE room = ? AND outcome IS NULL", outcome, g.room).run();
    }
    const left = await this.q("SELECT COUNT(*) AS n FROM social_dtour_games WHERE tid = ? AND round = ? AND outcome IS NULL", id, t.round).first<{ n: number }>();
    if (!left || left.n > 0) return;
    const tables = await this.dtourTables(id, t.round);
    const winners = tables.map((g) => g.rows[0]!.uid);
    if (tables.length === 1) {
      await this.many(
        this.q("UPDATE social_dtour_players SET out_round = ? WHERE tid = ? AND out_round IS NULL AND uid <> ?", t.round, id, winners[0]),
        this.q("UPDATE social_dtours SET status = 'done', winner = ? WHERE id = ? AND status = 'running' AND round = ?", winners[0], id, t.round));
      return;
    }
    await this.q(`UPDATE social_dtour_players SET out_round = ? WHERE tid = ? AND out_round IS NULL AND uid NOT IN (${winners.map(() => "?").join(",")})`,
      t.round, id, ...winners).run();
    await this.dtourRound(t, t.round + 1, now);
  }

  // each group of a round: its players with points and tie-break, best first
  private async dtourTables(id: string, round: number) {
    const [seats, games] = await this.many(
      this.q("SELECT uid, grp FROM social_dtour_seats WHERE tid = ? AND round = ?", id, round),
      this.q("SELECT grp, w_uid, b_uid, outcome FROM social_dtour_games WHERE tid = ? AND round = ?", id, round));
    const groups = [...new Set((seats ?? []).map((s) => Number(s["grp"])))].sort((a, b) => a - b);
    return groups.map((grp) => ({
      grp,
      rows: dtourGroupTable((seats ?? []).filter((s) => Number(s["grp"]) === grp).map((s) => String(s["uid"])),
        (games ?? []).filter((g) => Number(g["grp"]) === grp) as unknown as { w_uid: string; b_uid: string; outcome: string | null }[]),
    }));
  }

  private async dtourView(id: string, me: UserRow, now: number) {
    const [tr, players, mine] = await this.many(
      this.q(`SELECT t.*, o.name AS owner_name, w.name AS winner_name FROM social_dtours t LEFT JOIN social_users o ON o.id = t.owner
          LEFT JOIN social_users w ON w.id = t.winner WHERE t.id = ?`, id),
      this.q(`SELECT p.uid, p.out_round, u.name, u.avatar, u.r_rapid AS rating FROM social_dtour_players p LEFT JOIN social_users u ON u.id = p.uid
          WHERE p.tid = ? ORDER BY u.r_rapid DESC`, id),
      this.q("SELECT pid, out_round FROM social_dtour_players WHERE tid = ? AND uid = ?", id, me.id));
    const t = tr?.[0] as Record<string, unknown> | undefined;
    if (!t) throw new HttpError(404, "no such tournament");
    const people = new Map(((players ?? []) as Record<string, unknown>[]).map((p) => {
      let avatar: unknown = null;
      try { avatar = p["avatar"] ? JSON.parse(String(p["avatar"])) : null; } catch { avatar = null; }
      return [String(p["uid"]), { uid: p["uid"], name: p["name"] ?? "Deleted player", avatar, rating: p["rating"], out: p["out_round"] ?? null }];
    }));
    const round = Number(t["round"]);
    let groups: unknown[] = [];
    let games: unknown[] = [];
    if (round > 0) {
      const tables = await this.dtourTables(id, round);
      const myGroup = tables.find((g) => g.rows.some((r) => r.uid === me.id))?.grp;
      groups = tables.map((g) => ({ grp: g.grp, mine: g.grp === myGroup, rows: g.rows.map((r) => ({ ...people.get(r.uid), points: r.points, sb: r.sb })) }));
      // the games of your group (or, watching, of every group while that's a short list)
      const rows = (await this.q(`SELECT room, grp, w_uid, w_pid, b_uid, b_pid, outcome FROM social_dtour_games WHERE tid = ? AND round = ?
          AND (grp = ? OR (SELECT COUNT(*) FROM social_dtour_games x WHERE x.tid = ? AND x.round = ?) <= 60) ORDER BY grp, created`,
        id, round, myGroup ?? -1, id, round).all()).results;
      games = rows.map((g) => ({
        room: g["room"], grp: g["grp"], outcome: g["outcome"] ?? null,
        white: people.get(String(g["w_uid"])) ?? { name: "Deleted player" }, black: people.get(String(g["b_uid"])) ?? { name: "Deleted player" },
        mine: g["w_uid"] === me.id ? { color: "w", pid: g["w_pid"] } : g["b_uid"] === me.id ? { color: "b", pid: g["b_pid"] } : null,
      }));
    }
    const { token: _t, ...tour } = t;
    void _t;
    const my = mine?.[0];
    return {
      tournament: tour, now, players: [...people.values()], groups, games,
      me: { joined: !!my, out: my ? my["out_round"] ?? null : null, owner: t["owner"] === me.id },
    };
  }

  // ---- Leagues ----
  // GET /league: your tier, this week's division (once you've played a scoring game) and how last week went
  // POST /league/result {room, pid}: score a finished game against a random opponent; the server reads the room
  private async league(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    if (request.method === "GET" && seg.length === 1) return this.leagueView(me, now);
    if (request.method !== "POST" || seg[1] !== "result") throw new HttpError(404, "not found");
    const b = await body(request);
    const room = str(b["room"], 64), pid = str(b["pid"], 64);
    const cls = leagueRoomClass(room);
    if (!cls) throw new HttpError(400, "only rated games against random opponents earn trophies");
    if (!this.hooks.roomState) throw new HttpError(503, "results can't be checked right now");
    const st = await this.hooks.roomState(room);
    if (!st || st.status !== "over" || !st.result) throw new HttpError(409, "the game isn't over yet");
    if (!st.seats.includes(pid) || codeOfPid(pid) !== me.code) throw new HttpError(403, "that isn't your game");
    const oppPid = st.seats.find((p) => p !== pid) ?? "";
    const oppCode = codeOfPid(oppPid);
    const opp = oppCode ? await this.q("SELECT id FROM social_users WHERE code = ?", oppCode).first<{ id: string }>() : null;
    const r = st.result;
    let why: string | null = null;
    if (r.reason === "aborted") why = "aborted games don't count";
    else if (!opp || opp.id === me.id) why = "trophies come from games against players with Social on";
    let earned = 0;
    if (!why) {
      const [win, draw] = LEAGUE_POINTS[cls]!;
      const got = await this.leagueCredit(me.id, room, opp!.id, r.draw ? draw : r.winner === pid ? win : 0, now);
      if (got === null) why = "this game was already counted";
      else earned = got;
    }
    return { ...(await this.leagueView(me, now)), earned, why };
  }

  // add a game's trophies to this week's entry (joining a division first); each game counts once per player.
  // Returns the trophies added (none past the daily limit against one opponent), or null if it was counted already
  private async leagueCredit(uid: string, room: string, opp: string, points: number, now: number): Promise<number | null> {
    const week = leagueWeek(now);
    await this.leagueSettleFor(uid, week);
    await this.leagueJoin(uid, week, now);
    const against = await this.q("SELECT COUNT(*) AS n FROM social_league_games WHERE uid = ? AND opp = ? AND created > ? AND points > 0",
      uid, opp, now - 86_400_000).first<{ n: number }>();
    const pts = against && against.n >= LEAGUE_PER_OPPONENT ? 0 : points;
    const token = randomString(12);
    await this.many(
      this.q("INSERT OR IGNORE INTO social_league_games (room, uid, opp, created, points, token) VALUES (?, ?, ?, ?, ?, ?)", room, uid, opp, now, pts, token),
      this.q(`UPDATE social_league_entries SET points = points + ?, games = games + 1, reached = CASE WHEN ? > 0 THEN ? ELSE reached END
          WHERE week = ? AND uid = ? AND EXISTS (SELECT 1 FROM social_league_games WHERE room = ? AND uid = ? AND token = ?)`,
        pts, pts, now, week, uid, room, uid, token));
    const g = await this.q("SELECT token FROM social_league_games WHERE room = ? AND uid = ?", room, uid).first<{ token: string }>();
    return g && g.token === token ? pts : null;
  }

  // a player's first scoring game of the week puts them in a division of their tier with room left (or a new one)
  private async leagueJoin(uid: string, week: number, now: number): Promise<void> {
    if (await this.q("SELECT 1 AS x FROM social_league_entries WHERE week = ? AND uid = ?", week, uid).first()) return;
    await this.q("INSERT OR IGNORE INTO social_league (uid, tier, best) VALUES (?, 0, 0)", uid).run();
    const tier = (await this.q("SELECT tier FROM social_league WHERE uid = ?", uid).first<{ tier: number }>())?.tier ?? 0;
    const open = await this.q(`SELECT d.id FROM social_league_divs d WHERE d.week = ? AND d.tier = ?
        AND (SELECT COUNT(*) FROM social_league_entries e WHERE e.div = d.id) < ? ORDER BY d.created LIMIT 1`, week, tier, LEAGUE_SIZE).first<{ id: string }>();
    let div = open?.id;
    if (!div) {
      div = "lg_" + randomString(10).toLowerCase();
      await this.q("INSERT INTO social_league_divs (id, week, tier, created) VALUES (?, ?, ?, ?)", div, week, tier, now).run();
    }
    await this.q("INSERT OR IGNORE INTO social_league_entries (week, uid, div, tier, reached) VALUES (?, ?, ?, ?, ?)", week, uid, div, tier, now).run();
  }

  // divisions from weeks that have ended are settled (once) when one of their players next looks
  private async leagueSettleFor(uid: string, week: number): Promise<void> {
    const open = await this.q(`SELECT d.id, d.tier FROM social_league_entries e JOIN social_league_divs d ON d.id = e.div
        WHERE e.uid = ? AND e.week < ? AND d.settled = 0`, uid, week).all<{ id: string; tier: number }>();
    for (const d of open.results) await this.leagueSettle(d.id, d.tier);
  }

  // final places; the top of the division (with at least one trophy) moves up a tier
  private async leagueSettle(div: string, tier: number): Promise<void> {
    const token = randomString(12);
    await this.q("UPDATE social_league_divs SET settled = 1, token = ? WHERE id = ? AND settled = 0", token, div).run();
    const mine = await this.q("SELECT token FROM social_league_divs WHERE id = ?", div).first<{ token: string }>();
    if (!mine || mine.token !== token) return;
    const rows = (await this.q("SELECT uid, points FROM social_league_entries WHERE div = ? ORDER BY points DESC, reached ASC", div)
      .all<{ uid: string; points: number }>()).results;
    const up = leaguePromotions(tier, rows.length);
    const stmts = [];
    for (const [i, r] of rows.entries()) {
      const promoted = i < up && r.points > 0;
      stmts.push(this.q("UPDATE social_league_entries SET place = ?, promoted = ? WHERE div = ? AND uid = ?", i + 1, promoted ? 1 : 0, div, r.uid));
      if (promoted) stmts.push(this.q("UPDATE social_league SET tier = MAX(tier, ?), best = MAX(best, ?) WHERE uid = ?", tier + 1, tier + 1, r.uid));
    }
    if (stmts.length) await this.many(...stmts);
  }

  private async leagueView(me: UserRow, now: number) {
    const week = leagueWeek(now);
    await this.leagueSettleFor(me.id, week);
    const [t, cur, last] = await this.many(
      this.q("SELECT tier, best FROM social_league WHERE uid = ?", me.id),
      this.q("SELECT div, tier FROM social_league_entries WHERE week = ? AND uid = ?", week, me.id),
      this.q(`SELECT e.week, e.tier, e.place, e.promoted, e.points, (SELECT COUNT(*) FROM social_league_entries x WHERE x.div = e.div) AS size
          FROM social_league_entries e WHERE e.uid = ? AND e.week < ? ORDER BY e.week DESC LIMIT 1`, me.id, week));
    const entry = cur?.[0];
    let division = null;
    if (entry) {
      const dtier = Number(entry["tier"]);
      const rows = (await this.q(`SELECT e.uid, e.points, e.games, u.name, u.avatar FROM social_league_entries e LEFT JOIN social_users u ON u.id = e.uid
          WHERE e.div = ? ORDER BY e.points DESC, e.reached ASC LIMIT ?`, String(entry["div"]), LEAGUE_SIZE + 10).all()).results;
      division = {
        tier: dtier, promote: leaguePromotions(dtier, rows.length),
        standings: rows.map((r, i) => {
          let avatar: unknown = null;
          try { avatar = r["avatar"] ? JSON.parse(String(r["avatar"])) : null; } catch { avatar = null; }
          return { place: i + 1, uid: r["uid"], name: r["name"] ?? "Deleted player", avatar, points: r["points"], games: r["games"], me: r["uid"] === me.id };
        }),
      };
    }
    const l = last?.[0];
    return {
      tiers: LEAGUE_TIERS, tier: Number(t?.[0]?.["tier"] ?? 0), best: Number(t?.[0]?.["best"] ?? 0),
      ends: leagueWeekEnds(week), division,
      last: l ? { tier: Number(l["tier"]), place: l["place"] ?? null, promoted: !!l["promoted"], points: l["points"], size: l["size"], settled: l["place"] != null } : null,
      points: LEAGUE_POINTS, perOpponent: LEAGUE_PER_OPPONENT, arenaFactor: LEAGUE_ARENA_FACTOR,
    };
  }

  // ---- club team matches ----
  // POST /clubs/:id/matches {opponent, tc, boards}: a club's owner challenges another club
  // GET /clubs/:id/matches: the club's matches
  // POST /matches/:mid/accept | decline (the challenged owner) | join {pid} | leave | start (either owner)
  // GET /matches/:mid: sign-ups, boards and results; also moves the match along
  private async clubMatches(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    const memberOf = async (club: string) => !!(await this.q("SELECT 1 AS x FROM social_club_members WHERE club = ? AND member = ?", club, me.id).first());
    const ownerOf = async (club: string) => !!(await this.q("SELECT 1 AS x FROM social_clubs WHERE id = ? AND owner = ?", club, me.id).first());
    if (seg[0] === "clubs") {
      const club = str(seg[1], 32);
      if (method === "POST") {
        const b = await body(request);
        if (!(await ownerOf(club))) throw new HttpError(403, "only the club's owner can challenge another club");
        const opponent = str(b["opponent"], 32);
        if (opponent === club) throw new HttpError(400, "a club can't play itself");
        if (!(await this.q("SELECT 1 AS x FROM social_clubs WHERE id = ?", opponent).first())) throw new HttpError(404, "no such club");
        const tc = MATCH_TCS.includes(String(b["tc"])) ? String(b["tc"]) : "3d";
        const boards = Math.max(1, Math.min(50, Math.round(Number(b["boards"]) || 10)));
        await this.rateLimit("SELECT COUNT(*) AS n FROM social_club_matches WHERE a_club = ? AND status IN ('challenge', 'signup')", [club], 5, "open challenges");
        const id = "cm_" + randomString(10).toLowerCase();
        await this.q("INSERT INTO social_club_matches (id, a_club, b_club, tc, boards, created) VALUES (?, ?, ?, ?, ?, ?)", id, club, opponent, tc, boards, now).run();
        return { id };
      }
      if (!(await memberOf(club))) throw new HttpError(403, "join the club first");
      const r = await this.q(`SELECT m.*, a.name AS a_name, b.name AS b_name,
          (SELECT COUNT(*) FROM social_club_match_players p WHERE p.mid = m.id AND p.side = 'a') AS a_players,
          (SELECT COUNT(*) FROM social_club_match_players p WHERE p.mid = m.id AND p.side = 'b') AS b_players
          FROM social_club_matches m LEFT JOIN social_clubs a ON a.id = m.a_club LEFT JOIN social_clubs b ON b.id = m.b_club
          WHERE (m.a_club = ? OR m.b_club = ?) AND m.status <> 'declined' ORDER BY m.created DESC LIMIT 20`, club, club).all();
      return { matches: r.results };
    }
    const mid = str(seg[1], 32);
    type M = { id: string; a_club: string; b_club: string; tc: string; boards: number; status: string; created: number; starts: number };
    const m = await this.q("SELECT * FROM social_club_matches WHERE id = ?", mid).first<M>();
    if (!m) throw new HttpError(404, "no such match");
    const action = seg[2] ?? "";
    const side = (await memberOf(m.a_club)) ? "a" : (await memberOf(m.b_club)) ? "b" : null;
    if (method === "POST" && (action === "accept" || action === "decline")) {
      if (m.status !== "challenge") throw new HttpError(409, "this challenge has been answered");
      if (!(await ownerOf(m.b_club))) throw new HttpError(403, "only the challenged club's owner can answer");
      if (action === "accept") await this.q("UPDATE social_club_matches SET status = 'signup', starts = ? WHERE id = ? AND status = 'challenge'", now + MATCH_SIGNUP_MS, mid).run();
      else await this.q("UPDATE social_club_matches SET status = 'declined' WHERE id = ?", mid).run();
    } else if (method === "POST" && action === "join") {
      if (m.status !== "signup" && m.status !== "challenge") throw new HttpError(409, "sign-ups are closed");
      if (!side) throw new HttpError(403, "only members of the two clubs can play");
      const b = await body(request);
      const pid = str(b["pid"], 64);
      if (!PID_RE.test(pid)) throw new HttpError(400, "bad player id");
      await this.q("INSERT OR REPLACE INTO social_club_match_players (mid, uid, side, pid, joined) VALUES (?, ?, ?, ?, ?)", mid, me.id, side, pid, now).run();
    } else if (method === "POST" && action === "leave") {
      if (m.status !== "signup" && m.status !== "challenge") throw new HttpError(409, "the match has started");
      await this.q("DELETE FROM social_club_match_players WHERE mid = ? AND uid = ?", mid, me.id).run();
    } else if (method === "POST" && action === "start") {
      if (m.status !== "signup") throw new HttpError(409, "the match can't start now");
      if (!(await ownerOf(m.a_club)) && !(await ownerOf(m.b_club))) throw new HttpError(403, "only the clubs' owners can start the match");
      await this.matchStart(m, now);
    } else if (!(method === "GET" && seg.length === 2)) throw new HttpError(404, "not found");
    if (!side && !(method === "POST")) throw new HttpError(403, "only members of the two clubs can see this match");
    await this.matchTick(mid, now);
    return this.matchView(mid, me);
  }

  // pair the boards: each club's players by rapid rating, top against top; two games per board
  private async matchStart(m: { id: string; tc: string; boards: number }, now: number) {
    const token = randomString(12);
    await this.q("UPDATE social_club_matches SET status = 'running', starts = ?, token = ? WHERE id = ? AND status = 'signup'", now, token, m.id).run();
    const mine = await this.q("SELECT token FROM social_club_matches WHERE id = ?", m.id).first<{ token: string }>();
    if (!mine || mine.token !== token) return;
    const players = (await this.q(`SELECT p.uid, p.side, p.pid, u.r_rapid AS rating FROM social_club_match_players p
        JOIN social_users u ON u.id = p.uid WHERE p.mid = ? ORDER BY u.r_rapid DESC, p.joined`, m.id).all<{ uid: string; side: string; pid: string; rating: number }>()).results;
    const a = players.filter((p) => p.side === "a"), b = players.filter((p) => p.side === "b");
    const n = Math.min(m.boards, a.length, b.length);
    if (!n) { await this.q("UPDATE social_club_matches SET status = 'cancelled' WHERE id = ?", m.id).run(); return; }
    const stmts = [];
    for (let i = 0; i < n; i++) {
      const pa = a[i]!, pb = b[i]!;
      for (const [w, bl, wSide] of [[pa, pb, "a"], [pb, pa, "b"]] as const) {
        const room = "cm" + randomString(10).toLowerCase();
        stmts.push(this.q("INSERT INTO social_club_match_games (room, mid, board, w_uid, w_pid, b_uid, b_pid, w_side, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          room, m.id, i + 1, w.uid, w.pid, bl.uid, bl.pid, wSide, now));
      }
    }
    await this.many(...stmts);
  }

  // start when sign-ups close; score games as they finish (from the rooms); end when all are done
  private async matchTick(mid: string, now: number) {
    const m = await this.q("SELECT * FROM social_club_matches WHERE id = ?", mid).first<{ id: string; tc: string; boards: number; status: string; starts: number }>();
    if (!m) return;
    if (m.status === "signup" && now >= m.starts) { await this.matchStart(m, now); return; }
    if (m.status !== "running") return;
    const days = Number(m.tc.replace("d", "")) || 3;
    const open = (await this.q("SELECT * FROM social_club_match_games WHERE mid = ? AND outcome IS NULL", mid).all<{ room: string; w_pid: string; b_pid: string; w_side: string; created: number }>()).results;
    for (const g of open.slice(0, 8)) {
      // nobody (or only one player) came within a move's allowance: a forfeit
      const outcome = await this.roomOutcome(g.room, g.w_pid, g.b_pid, g.created, days * 86_400_000, now);
      if (!outcome) continue;
      const token = randomString(12);
      const wPts = outcome.startsWith("w") ? 2 : outcome === "draw" ? 1 : 0, bPts = outcome.startsWith("b") ? 2 : outcome === "draw" ? 1 : 0;
      const aPts = g.w_side === "a" ? wPts : bPts, bClubPts = g.w_side === "a" ? bPts : wPts;
      await this.many(
        this.q("UPDATE social_club_match_games SET outcome = ?, token = ? WHERE room = ? AND outcome IS NULL", outcome, token, g.room),
        this.q("UPDATE social_club_matches SET a_score2 = a_score2 + ?, b_score2 = b_score2 + ? WHERE id = ? AND EXISTS (SELECT 1 FROM social_club_match_games WHERE room = ? AND token = ?)", aPts, bClubPts, mid, g.room, token));
    }
    const left = await this.q("SELECT COUNT(*) AS n FROM social_club_match_games WHERE mid = ? AND outcome IS NULL", mid).first<{ n: number }>();
    if (left && left.n === 0) await this.q("UPDATE social_club_matches SET status = 'done' WHERE id = ? AND status = 'running'", mid).run();
  }

  private async matchView(mid: string, me: UserRow) {
    const [mr, players, games] = await this.many(
      this.q(`SELECT m.*, a.name AS a_name, b.name AS b_name, a.owner AS a_owner, b.owner AS b_owner FROM social_club_matches m
          LEFT JOIN social_clubs a ON a.id = m.a_club LEFT JOIN social_clubs b ON b.id = m.b_club WHERE m.id = ?`, mid),
      this.q(`SELECT p.uid, p.side, p.pid, u.name, u.avatar, u.r_rapid AS rating FROM social_club_match_players p
          LEFT JOIN social_users u ON u.id = p.uid WHERE p.mid = ? ORDER BY u.r_rapid DESC`, mid),
      this.q(`SELECT g.room, g.board, g.w_uid, g.b_uid, g.w_pid, g.b_pid, g.w_side, g.outcome, w.name AS w_name, b.name AS b_name FROM social_club_match_games g
          LEFT JOIN social_users w ON w.id = g.w_uid LEFT JOIN social_users b ON b.id = g.b_uid WHERE g.mid = ? ORDER BY g.board, g.w_side`, mid));
    const m = mr?.[0] as Record<string, unknown> | undefined;
    if (!m) throw new HttpError(404, "no such match");
    const plist = ((players ?? []) as Record<string, unknown>[]).map((p) => {
      let avatar: unknown = null;
      try { avatar = p["avatar"] ? JSON.parse(String(p["avatar"])) : null; } catch { avatar = null; }
      return { uid: p["uid"], side: p["side"], name: p["name"] ?? "Deleted player", avatar, rating: p["rating"] };
    });
    const glist = ((games ?? []) as Record<string, unknown>[]).map((g) => ({
      room: g["room"], board: g["board"], wSide: g["w_side"], outcome: g["outcome"] ?? null,
      white: { uid: g["w_uid"], name: g["w_name"] ?? "Deleted player" }, black: { uid: g["b_uid"], name: g["b_name"] ?? "Deleted player" },
      mine: g["w_uid"] === me.id ? { color: "w", pid: g["w_pid"] } : g["b_uid"] === me.id ? { color: "b", pid: g["b_pid"] } : null,
    }));
    const { token: _t, a_owner, b_owner, ...match } = m;
    void _t;
    return {
      match: { ...match, aScore: Number(m["a_score2"]) / 2, bScore: Number(m["b_score2"]) / 2 },
      players: plist, games: glist, me: { joined: plist.some((p) => p.uid === me.id), owner: a_owner === me.id ? "a" : b_owner === me.id ? "b" : null },
    };
  }

  // ---- Vote Chess ----
  // POST /clubs/:id/votechess {opponent, tc}: an owner challenges; GET /clubs/:id/votechess: the club's games
  // POST /votechess/:vid/accept | decline (the challenged owner); GET /votechess/:vid: the game and the vote
  // POST /votechess/:vid/vote {move}: a member of the side to move votes ("e2e4", "e7e8q")
  // POST /votechess/:vid/play: that side's owner plays the leading move now (otherwise it's played at the deadline)
  private async voteChess(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    const memberOf = async (club: string) => !!(await this.q("SELECT 1 AS x FROM social_club_members WHERE club = ? AND member = ?", club, me.id).first());
    const ownerOf = async (club: string) => !!(await this.q("SELECT 1 AS x FROM social_clubs WHERE id = ? AND owner = ?", club, me.id).first());
    if (seg[0] === "clubs") {
      const club = str(seg[1], 32);
      if (method === "POST") {
        const b = await body(request);
        if (!(await ownerOf(club))) throw new HttpError(403, "only the club's owner can challenge another club");
        const opponent = str(b["opponent"], 32);
        if (opponent === club || !(await this.q("SELECT 1 AS x FROM social_clubs WHERE id = ?", opponent).first())) throw new HttpError(404, "no such club");
        const tc = MATCH_TCS.includes(String(b["tc"])) ? String(b["tc"]) : "1d";
        await this.rateLimit("SELECT COUNT(*) AS n FROM social_vote_games WHERE a_club = ? AND status IN ('challenge', 'running')", [club], 3, "Vote Chess games");
        const id = "vc_" + randomString(10).toLowerCase();
        await this.q("INSERT INTO social_vote_games (id, a_club, b_club, tc, created) VALUES (?, ?, ?, ?, ?)", id, club, opponent, tc, now).run();
        return { id };
      }
      if (!(await memberOf(club))) throw new HttpError(403, "join the club first");
      const r = await this.q(`SELECT v.id, v.a_club, v.b_club, v.tc, v.status, v.ply, v.deadline, v.result, a.name AS a_name, b.name AS b_name
          FROM social_vote_games v LEFT JOIN social_clubs a ON a.id = v.a_club LEFT JOIN social_clubs b ON b.id = v.b_club
          WHERE (v.a_club = ? OR v.b_club = ?) AND v.status <> 'declined' ORDER BY v.created DESC LIMIT 20`, club, club).all();
      return { games: r.results };
    }
    const vid = str(seg[1], 32);
    type V = { id: string; a_club: string; b_club: string; room: string; a_pid: string; b_pid: string; tc: string; status: string; deadline: number; ply: number };
    const g = await this.q("SELECT * FROM social_vote_games WHERE id = ?", vid).first<V>();
    if (!g) throw new HttpError(404, "no such game");
    const side = (await memberOf(g.a_club)) ? "a" : (await memberOf(g.b_club)) ? "b" : null;
    if (!side) throw new HttpError(403, "only members of the two clubs can take part");
    const action = seg[2] ?? "";
    const toMove = g.ply % 2 === 0 ? "a" : "b";
    if (method === "POST" && (action === "accept" || action === "decline")) {
      if (g.status !== "challenge") throw new HttpError(409, "this challenge has been answered");
      if (!(await ownerOf(g.b_club))) throw new HttpError(403, "only the challenged club's owner can answer");
      if (action === "decline") await this.q("UPDATE social_vote_games SET status = 'declined' WHERE id = ?", vid).run();
      else await this.voteStart(g, now);
    } else if (method === "POST" && action === "vote") {
      if (g.status !== "running") throw new HttpError(409, "the game isn't in play");
      if (side !== toMove) throw new HttpError(409, "it's the other club's move");
      const b = await body(request);
      const move = str(b["move"], 5);
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new HttpError(400, "bad move");
      await this.q("INSERT OR REPLACE INTO social_vote_votes (game, ply, uid, move, created) VALUES (?, ?, ?, ?, ?)", vid, g.ply, me.id, move, now).run();
    } else if (method === "POST" && action === "play") {
      if (g.status !== "running") throw new HttpError(409, "the game isn't in play");
      if (!(await ownerOf(toMove === "a" ? g.a_club : g.b_club))) throw new HttpError(403, "only the owner of the club to move can play the move early");
      await this.votePlay(g, now, true);
    } else if (!(method === "GET" && seg.length === 2)) throw new HttpError(404, "not found");
    // the move is due: play the most popular legal one
    const cur = await this.q("SELECT * FROM social_vote_games WHERE id = ?", vid).first<V>();
    if (cur && cur.status === "running" && now >= cur.deadline) await this.votePlay(cur, now, false);
    return this.voteView(vid, me, side);
  }

  // the clubs' seats in a fresh room: each plays as "<club name>"
  private async voteStart(g: { id: string; a_club: string; b_club: string; tc: string }, now: number) {
    if (!this.hooks.roomAct) throw new HttpError(503, "games can't be started right now");
    const token = randomString(12);
    await this.q("UPDATE social_vote_games SET status = 'starting', token = ? WHERE id = ? AND status = 'challenge'", token, g.id).run();
    const mine = await this.q("SELECT token FROM social_vote_games WHERE id = ?", g.id).first<{ token: string }>();
    if (!mine || mine.token !== token) return;
    const names = await this.many(this.q("SELECT name FROM social_clubs WHERE id = ?", g.a_club), this.q("SELECT name FROM social_clubs WHERE id = ?", g.b_club));
    const slug = (r: Record<string, unknown>[] | undefined) => (String(r?.[0]?.["name"] ?? "Club").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16) || "Club");
    const room = "vc" + randomString(10).toLowerCase();
    const aPid = `p-vc${randomString(6).toLowerCase()}.${slug(names[0])}.1500`, bPid = `p-vc${randomString(6).toLowerCase()}.${slug(names[1])}.1500`;
    await this.hooks.roomAct(room, aPid, null);
    await this.hooks.roomAct(room, bPid, null);
    const cfg = await this.hooks.roomAct(room, aPid, { t: "config", tc: g.tc });
    if (!cfg.ok) { await this.q("UPDATE social_vote_games SET status = 'challenge' WHERE id = ?", g.id).run(); throw new HttpError(503, "couldn't set up the game"); }
    const days = Number(g.tc.replace("d", "")) || 1;
    await this.q("UPDATE social_vote_games SET status = 'running', room = ?, a_pid = ?, b_pid = ?, deadline = ?, ply = 0 WHERE id = ?", room, aPid, bPid, now + days * 86_400_000, g.id).run();
  }

  // play the side's most voted legal move (ties: the earliest vote); no legal vote at the deadline loses on time
  private async votePlay(g: { id: string; room: string; a_pid: string; b_pid: string; tc: string; ply: number }, now: number, early: boolean) {
    if (!this.hooks.roomAct) return;
    const token = randomString(12);
    // claim this ply: parking the ply number makes the claim atomic (a second request matches nothing)
    const LOCK = 1_000_000;
    await this.q("UPDATE social_vote_games SET token = ?, ply = ply + ? WHERE id = ? AND ply = ? AND status = 'running'", token, LOCK, g.id, g.ply).run();
    const claim = await this.q("SELECT token, ply FROM social_vote_games WHERE id = ?", g.id).first<{ token: string; ply: number }>();
    if (!claim || claim.token !== token || claim.ply !== g.ply + LOCK) return;
    const pid = g.ply % 2 === 0 ? g.a_pid : g.b_pid;
    const votes = (await this.q(`SELECT move, COUNT(*) AS n, MIN(created) AS first FROM social_vote_votes WHERE game = ? AND ply = ?
        GROUP BY move ORDER BY n DESC, first ASC`, g.id, g.ply).all<{ move: string; n: number }>()).results;
    let played: { ok: boolean; status?: string; result?: RoomState["result"] } | null = null;
    for (const v of votes) {
      const r = await this.hooks.roomAct(g.room, pid, { t: "move", from: v.move.slice(0, 2), to: v.move.slice(2, 4), promotion: v.move[4] || undefined });
      if (r.ok) { played = r; break; }
    }
    if (!played) {
      if (early) { await this.q("UPDATE social_vote_games SET token = NULL, ply = ? WHERE id = ?", g.ply, g.id).run(); throw new HttpError(409, "there's no legal move with votes yet"); }
      await this.hooks.roomAct(g.room, pid, { t: "resign" });
      await this.q("UPDATE social_vote_games SET status = 'done', ply = ?, result = ? WHERE id = ?", g.ply, g.ply % 2 === 0 ? "0-1" : "1-0", g.id).run();
      return;
    }
    const days = Number(g.tc.replace("d", "")) || 1;
    if (played.status === "over") {
      const r = played.result;
      const res = !r || r.draw ? "1/2-1/2" : r.winner === g.a_pid ? "1-0" : "0-1";
      await this.q("UPDATE social_vote_games SET status = 'done', ply = ?, result = ? WHERE id = ?", g.ply + 1, res, g.id).run();
    } else await this.q("UPDATE social_vote_games SET ply = ?, deadline = ? WHERE id = ?", g.ply + 1, now + days * 86_400_000, g.id).run();
  }

  private async voteView(vid: string, me: UserRow, side: string) {
    const [gr, tally, mine] = await this.many(
      this.q(`SELECT v.id, v.a_club, v.b_club, v.room, v.tc, v.status, v.ply, v.deadline, v.result, a.name AS a_name, b.name AS b_name, a.owner AS a_owner, b.owner AS b_owner
          FROM social_vote_games v LEFT JOIN social_clubs a ON a.id = v.a_club LEFT JOIN social_clubs b ON b.id = v.b_club WHERE v.id = ?`, vid),
      this.q(`SELECT move, COUNT(*) AS n FROM social_vote_votes WHERE game = ? AND ply = (SELECT ply FROM social_vote_games WHERE id = ?)
          GROUP BY move ORDER BY n DESC, MIN(created) ASC`, vid, vid),
      this.q("SELECT move FROM social_vote_votes WHERE game = ? AND uid = ? AND ply = (SELECT ply FROM social_vote_games WHERE id = ?)", vid, me.id, vid));
    const g = gr?.[0] as Record<string, unknown> | undefined;
    if (!g) throw new HttpError(404, "no such game");
    const toMove = Number(g["ply"]) % 2 === 0 ? "a" : "b";
    const { a_owner, b_owner, ...game } = g;
    return {
      game, side, toMove, colour: side === "a" ? "w" : "b",
      // only your own club's votes are shown while it's your move
      tally: side === toMove ? (tally ?? []) : [], myVote: mine?.[0]?.["move"] ?? null,
      owner: (side === "a" ? a_owner : b_owner) === me.id,
    };
  }

  // ---- Swiss tournaments ----
  private async swiss(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    // GET /swiss: the tournament running now (or just finished) and the next one
    if (method === "GET" && seg.length === 1) {
      const slot = Math.floor((now - SWISS_OFFSET_MS) / SWISS_SLOT_MS);
      const list = [slot, slot + 1].map(swissForSlot);
      const out = await this.many(
        ...list.map((t) => this.q("INSERT OR IGNORE INTO social_swiss (id, name, tc, cat, rounds, starts) VALUES (?, ?, ?, ?, ?, ?)", t.id, t.name, t.tc, t.cat, t.rounds, t.starts)),
        this.q(`SELECT t.*, (SELECT COUNT(*) FROM social_swiss_players p WHERE p.sid = t.id AND p.withdrawn = 0) AS players,
            EXISTS (SELECT 1 FROM social_swiss_players p WHERE p.sid = t.id AND p.uid = ? AND p.withdrawn = 0) AS joined
            FROM social_swiss t WHERE t.id IN (?, ?) ORDER BY t.starts`, me.id, list[0]!.id, list[1]!.id));
      return { tournaments: out[out.length - 1] ?? [], now };
    }
    const id = str(seg[1], 32);
    type T = { id: string; name: string; tc: string; cat: string; rounds: number; starts: number; status: string; round: number; round_started: number };
    let t = await this.q("SELECT * FROM social_swiss WHERE id = ?", id).first<T>();
    if (!t) {
      // a tournament the schedule has reached but nobody listed yet
      const m = /^sw-(\d+)$/.exec(id);
      const slot = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(slot) || Math.abs(slot * SWISS_SLOT_MS - now) > 3 * SWISS_SLOT_MS) throw new HttpError(404, "no such tournament");
      const d = swissForSlot(slot);
      await this.q("INSERT OR IGNORE INTO social_swiss (id, name, tc, cat, rounds, starts) VALUES (?, ?, ?, ?, ?, ?)", d.id, d.name, d.tc, d.cat, d.rounds, d.starts).run();
      t = await this.q("SELECT * FROM social_swiss WHERE id = ?", id).first<T>();
      if (!t) throw new HttpError(404, "no such tournament");
    }
    const action = seg[2] ?? "";
    if (method === "POST" && action === "join") {
      const b = await body(request);
      const pid = str(b["pid"], 64);
      if (!PID_RE.test(pid)) throw new HttpError(400, "bad player id");
      if (t.status === "done" || (t.status === "running" && t.round >= t.rounds)) throw new HttpError(409, "this tournament has finished");
      await this.q(`INSERT INTO social_swiss_players (sid, uid, joined, seen, pid) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (sid, uid) DO UPDATE SET withdrawn = 0, seen = excluded.seen, pid = excluded.pid`, id, me.id, now, now, pid).run();
    } else if (method === "POST" && action === "withdraw") {
      await this.q("UPDATE social_swiss_players SET withdrawn = 1 WHERE sid = ? AND uid = ?", id, me.id).run();
    } else if (method === "POST" && action === "ping") {
      // the tournament screen (or your game) is open: you count as present for the next pairing
      const b = await body(request);
      const pid = str(b["pid"], 64);
      await this.q("UPDATE social_swiss_players SET seen = ?, pid = CASE WHEN ? = 1 THEN ? ELSE pid END WHERE sid = ? AND uid = ?", now, PID_RE.test(pid) ? 1 : 0, pid, id, me.id).run();
    } else if (!(method === "GET" && seg.length === 2)) throw new HttpError(404, "not found");
    await this.swissTick(t, now);
    return this.swissView(id, me, now);
  }

  // Move a tournament along: start it, score finished games, pair the next round, finish it.
  // Runs whenever a player looks at it, and every step is safe to race (tokens, as in arenas).
  private async swissTick(t: { id: string; tc: string; cat: string; rounds: number; starts: number; status: string; round: number; round_started: number }, now: number) {
    if (t.status === "open") {
      if (now < t.starts) return;
      await this.swissPair(t, 1, now);
      return;
    }
    if (t.status !== "running") return;
    const open = (await this.q("SELECT * FROM social_swiss_games WHERE sid = ? AND round = ? AND outcome IS NULL", t.id, t.round).all<{ room: string; w_uid: string; w_pid: string; b_uid: string; b_pid: string; created: number }>()).results;
    for (const g of open.slice(0, 8)) {
      // a no-show: whoever came wins; nobody came, nobody scores. A game still going past the round's cap is a draw
      let outcome = await this.roomOutcome(g.room, g.w_pid, g.b_pid, g.created, SWISS_NO_SHOW_MS, now);
      if (!outcome && now - g.created > swissRoundCap(t.tc)) outcome = "draw";
      if (!outcome) continue;
      const token = randomString(12);
      const w = outcome.startsWith("w") ? 2 : outcome === "draw" ? 1 : 0, b = outcome.startsWith("b") ? 2 : outcome === "draw" ? 1 : 0;
      const ok = "EXISTS (SELECT 1 FROM social_swiss_games WHERE room = ? AND token = ?)";
      await this.many(
        this.q("UPDATE social_swiss_games SET outcome = ?, token = ? WHERE room = ? AND outcome IS NULL", outcome, token, g.room),
        this.q(`UPDATE social_swiss_players SET score2 = score2 + ? WHERE sid = ? AND uid = ? AND ${ok}`, w, t.id, g.w_uid, g.room, token),
        this.q(`UPDATE social_swiss_players SET score2 = score2 + ? WHERE sid = ? AND uid = ? AND ${ok}`, b, t.id, g.b_uid, g.room, token));
    }
    const left = await this.q("SELECT COUNT(*) AS n FROM social_swiss_games WHERE sid = ? AND round = ? AND outcome IS NULL", t.id, t.round).first<{ n: number }>();
    if (left && left.n > 0) return;
    if (t.round >= t.rounds) await this.q("UPDATE social_swiss SET status = 'done' WHERE id = ? AND status = 'running'", t.id).run();
    else await this.swissPair(t, t.round + 1, now);
  }

  private async swissPair(t: { id: string; tc: string; cat: string; round: number; starts: number; round_started: number }, round: number, now: number) {
    // fewer than two players here: wait a while for them, then call it a day
    const here = await this.q("SELECT COUNT(*) AS n FROM social_swiss_players WHERE sid = ? AND withdrawn = 0 AND seen > ?", t.id, now - SWISS_PRESENT_MS).first<{ n: number }>();
    if (!here || here.n < 2) {
      const since = round === 1 ? t.starts : t.round_started + swissRoundCap(t.tc);
      if (now - since < SWISS_GRACE_MS) return;
    }
    // claim the pairing of this round (only one request does it)
    const token = randomString(12);
    await this.q("UPDATE social_swiss SET status = 'running', round = ?, round_started = ?, token = ? WHERE id = ? AND round = ? AND status IN ('open', 'running')", round, now, token, t.id, round - 1).run();
    const mine = await this.q("SELECT token FROM social_swiss WHERE id = ?", t.id).first<{ token: string }>();
    if (!mine || mine.token !== token) return;
    const col = t.cat === "rapid" ? "r_rapid" : "r_blitz";   // fixed names, never input
    const rows = (await this.q(`SELECT p.*, u.${col} AS rating FROM social_swiss_players p JOIN social_users u ON u.id = p.uid
        WHERE p.sid = ? AND p.withdrawn = 0 AND p.seen > ?`, t.id, now - SWISS_PRESENT_MS).all<{ uid: string; pid: string; score2: number; opps: string; colors: string; byes: number; rating: number }>()).results;
    if (rows.length < 2) {
      // not enough players here to play a round: the tournament ends (a lone player takes the bye)
      const stmts = rows.map((p) => this.q("UPDATE social_swiss_players SET score2 = score2 + 2, byes = byes + 1 WHERE sid = ? AND uid = ?", t.id, p.uid));
      await this.many(...stmts, this.q("UPDATE social_swiss SET status = 'done' WHERE id = ?", t.id));
      return;
    }
    const byUid = new Map(rows.map((p) => [p.uid, p]));
    const { pairs, bye } = swissPairings(rows.map((p) => ({ uid: p.uid, score2: p.score2, rating: Number(p.rating) || 1200, opps: p.opps ? p.opps.split(",") : [], colors: p.colors, byes: p.byes })));
    const stmts = [];
    for (const [w, b] of pairs) {
      const room = "sw" + randomString(10).toLowerCase();
      const pw = byUid.get(w)!, pb = byUid.get(b)!;
      stmts.push(
        this.q("INSERT INTO social_swiss_games (room, sid, round, w_uid, w_pid, b_uid, b_pid, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", room, t.id, round, w, pw.pid, b, pb.pid, now),
        this.q("UPDATE social_swiss_players SET opps = opps || CASE WHEN opps = '' THEN '' ELSE ',' END || ?, colors = colors || 'w' WHERE sid = ? AND uid = ?", b, t.id, w),
        this.q("UPDATE social_swiss_players SET opps = opps || CASE WHEN opps = '' THEN '' ELSE ',' END || ?, colors = colors || 'b' WHERE sid = ? AND uid = ?", w, t.id, b));
    }
    if (bye) stmts.push(this.q("UPDATE social_swiss_players SET score2 = score2 + 2, byes = byes + 1 WHERE sid = ? AND uid = ?", t.id, bye));
    await this.many(...stmts);
  }

  private async swissView(id: string, me: UserRow, now: number) {
    const [tr, players, games] = await this.many(
      this.q("SELECT id, name, tc, cat, rounds, starts, status, round, round_started FROM social_swiss WHERE id = ?", id),
      this.q(`SELECT p.uid, p.score2, p.opps, p.byes, p.withdrawn, p.seen, u.name, u.avatar, u.r_blitz, u.r_rapid FROM social_swiss_players p
          LEFT JOIN social_users u ON u.id = p.uid WHERE p.sid = ?`, id),
      this.q(`SELECT g.room, g.round, g.w_uid, g.b_uid, g.outcome, g.created, w.name AS w_name, b.name AS b_name FROM social_swiss_games g
          LEFT JOIN social_users w ON w.id = g.w_uid LEFT JOIN social_users b ON b.id = g.b_uid WHERE g.sid = ? ORDER BY g.round, g.created`, id));
    const t = tr?.[0] as { cat: string; round: number; status: string } | undefined;
    if (!t) throw new HttpError(404, "no such tournament");
    const list = (players ?? []) as Record<string, unknown>[];
    const score = new Map(list.map((p) => [String(p["uid"]), Number(p["score2"]) / 2]));
    // tie-break: Buchholz, the sum of your opponents' scores
    const standings = list.map((p) => {
      const opps = String(p["opps"] || "").split(",").filter(Boolean);
      let avatar: unknown = null;
      try { avatar = p["avatar"] ? JSON.parse(String(p["avatar"])) : null; } catch { avatar = null; }
      return {
        uid: p["uid"], name: p["name"] ?? "Deleted player", avatar, rating: t.cat === "rapid" ? p["r_rapid"] : p["r_blitz"],
        score: Number(p["score2"]) / 2, buchholz: opps.reduce((s, o) => s + (score.get(o) ?? 0), 0), games: opps.length, byes: p["byes"],
        withdrawn: !!p["withdrawn"], here: now - Number(p["seen"]) < SWISS_PRESENT_MS,
      };
    }).sort((a, b) => b.score - a.score || b.buchholz - a.buchholz || Number(b.rating) - Number(a.rating));
    const all = ((games ?? []) as Record<string, unknown>[]).map((g) => ({ room: g["room"], round: g["round"], white: { uid: g["w_uid"], name: g["w_name"] ?? "Deleted player" }, black: { uid: g["b_uid"], name: g["b_name"] ?? "Deleted player" }, outcome: g["outcome"] ?? null }));
    const current = all.filter((g) => g.round === t.round);
    const myGame = current.find((g) => g.white.uid === me.id || g.black.uid === me.id) ?? null;
    const meRow = list.find((p) => p["uid"] === me.id);
    return {
      tournament: tr![0], standings, round: current, games: all, now,
      me: meRow ? { joined: !meRow["withdrawn"], score: Number(meRow["score2"]) / 2, game: myGame && !myGame.outcome ? { room: myGame.room, color: myGame.white.uid === me.id ? "w" : "b", opponent: myGame.white.uid === me.id ? myGame.black : myGame.white } : null } : null,
    };
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

  private async forums(request: Request, me: UserRow, seg: string[], url: URL, now: number): Promise<unknown> {
    const method = request.method;
    const author = authorOf;
    // POST /report {kind: "topic" | "post" | "blog" | "coach", id}
    if (method === "POST" && seg[0] === "report") {
      const b = await body(request);
      const kind = String(b["kind"]) in REPORTABLE ? String(b["kind"]) : "topic", item = str(String(b["id"] ?? ""), 32);
      const [table, key] = REPORTABLE[kind]!;
      const [, count] = await this.many(
        this.q("INSERT OR IGNORE INTO social_reports (kind, item, uid, created) VALUES (?, ?, ?, ?)", kind, item, me.id, now),
        this.q("SELECT COUNT(*) AS n FROM social_reports WHERE kind = ? AND item = ?", kind, item));
      if (Number(count?.[0]?.["n"] ?? 0) >= REPORTS_TO_HIDE) await this.q(`UPDATE ${table} SET hidden = 1 WHERE ${key} = ?`, item).run();
      return { ok: true };
    }
    // GET /forums?cat=: topics, most recently active first
    if (method === "GET" && seg.length === 1) {
      const cat = FORUM_CATS.includes(url.searchParams.get("cat") || "") ? url.searchParams.get("cat") : null;
      const r = await this.q(`SELECT t.id, t.cat, t.uid, t.title, t.created, t.last_at, t.replies, u.name, u.avatar FROM social_topics t
          LEFT JOIN social_users u ON u.id = t.uid WHERE t.hidden = 0 AND (? IS NULL OR t.cat = ?) AND ${HIDE_BLOCKED("t.uid")} ORDER BY t.last_at DESC LIMIT 50`, cat, cat, me.id).all();
      return { cats: FORUM_CATS, topics: r.results.map((t) => ({ id: t["id"], cat: t["cat"], title: t["title"], created: t["created"], lastAt: t["last_at"], replies: t["replies"], author: author(t) })) };
    }
    // POST /forums {cat, title, body}: a new topic
    if (method === "POST" && seg.length === 1) {
      const b = await body(request);
      const cat = FORUM_CATS.includes(String(b["cat"])) ? String(b["cat"]) : "general";
      const title = cleanText(b["title"], 100), text = cleanText(b["body"], 4000);
      if (title.length < 4) throw new HttpError(400, "titles need at least 4 characters");
      if (!text) throw new HttpError(400, "write something in the post");
      await this.rateLimit("SELECT COUNT(*) AS n FROM social_topics WHERE uid = ? AND created > ?", [me.id, now - 3_600_000], 5, "new topics");
      const id = "t_" + randomString(10).toLowerCase();
      await this.q("INSERT INTO social_topics (id, cat, uid, title, body, created, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, cat, me.id, title, text, now, now).run();
      return { id };
    }
    const id = str(seg[1], 32);
    // GET /forums/:id: the topic and its replies
    if (method === "GET" && seg.length === 2) {
      const [topic, posts] = await this.many(
        this.q(`SELECT t.*, u.name, u.avatar FROM social_topics t LEFT JOIN social_users u ON u.id = t.uid WHERE t.id = ? AND t.hidden = 0`, id),
        this.q(`SELECT p.id, p.uid, p.body, p.created, u.name, u.avatar FROM social_posts p LEFT JOIN social_users u ON u.id = p.uid
            WHERE p.topic = ? AND p.hidden = 0 AND ${HIDE_BLOCKED("p.uid")} ORDER BY p.id LIMIT 300`, id, me.id));
      const t = topic?.[0];
      if (!t) throw new HttpError(404, "that topic was removed");
      return {
        topic: { id: t["id"], cat: t["cat"], title: t["title"], body: t["body"], created: t["created"], replies: t["replies"], author: author(t), mine: t["uid"] === me.id },
        posts: (posts ?? []).map((p) => ({ id: p["id"], body: p["body"], created: p["created"], author: author(p), mine: p["uid"] === me.id })),
      };
    }
    // POST /forums/:id {body}: reply
    if (method === "POST" && seg.length === 2) {
      const b = await body(request);
      const text = cleanText(b["body"], 4000);
      if (!text) throw new HttpError(400, "write something first");
      const [topic, recent] = await this.many(
        this.q("SELECT 1 AS x FROM social_topics WHERE id = ? AND hidden = 0", id),
        this.q("SELECT COUNT(*) AS n FROM social_posts WHERE uid = ? AND created > ?", me.id, now - 3_600_000));
      if (!topic?.length) throw new HttpError(404, "that topic was removed");
      if (Number(recent?.[0]?.["n"] ?? 0) >= 60) throw new HttpError(429, "too many replies; slow down");
      await this.many(
        this.q("INSERT INTO social_posts (topic, uid, body, created) VALUES (?, ?, ?, ?)", id, me.id, text, now),
        this.q("UPDATE social_topics SET replies = replies + 1, last_at = ? WHERE id = ?", now, id));
      return { ok: true };
    }
    // POST /forums/:id/delete, POST /forums/:id/posts/:pid/delete: authors remove their own words
    if (method === "POST" && seg[2] === "delete") {
      await this.many(
        this.q("DELETE FROM social_posts WHERE topic = ? AND EXISTS (SELECT 1 FROM social_topics WHERE id = ? AND uid = ?)", id, id, me.id),
        this.q("DELETE FROM social_topics WHERE id = ? AND uid = ?", id, me.id));
      return { ok: true };
    }
    if (method === "POST" && seg[2] === "posts" && seg[4] === "delete") {
      const pid = Number(seg[3]);
      await this.many(
        this.q("UPDATE social_topics SET replies = replies - 1 WHERE id = ? AND EXISTS (SELECT 1 FROM social_posts WHERE id = ? AND topic = ? AND uid = ?)", id, pid, id, me.id),
        this.q("DELETE FROM social_posts WHERE id = ? AND topic = ? AND uid = ?", pid, id, me.id));
      return { ok: true };
    }
    throw new HttpError(404, "not found");
  }

  private async blogs(request: Request, me: UserRow, seg: string[], url: URL, now: number): Promise<unknown> {
    const method = request.method;
    // GET /blogs (?by=player): the newest posts, each with the start of its text
    if (method === "GET" && seg.length === 1) {
      const by = url.searchParams.get("by") ? str(url.searchParams.get("by"), 32) : null;
      const r = await this.q(`SELECT b.id, b.uid, b.title, substr(b.body, 1, 280) AS excerpt, b.created, b.likes, u.name, u.avatar FROM social_blogs b
          LEFT JOIN social_users u ON u.id = b.uid WHERE b.hidden = 0 AND (? IS NULL OR b.uid = ?) AND ${HIDE_BLOCKED("b.uid")} ORDER BY b.created DESC LIMIT 50`, by, by, me.id).all();
      return { posts: r.results.map((p) => ({ id: p["id"], title: p["title"], excerpt: p["excerpt"], created: p["created"], likes: p["likes"], author: authorOf(p), mine: p["uid"] === me.id })) };
    }
    // POST /blogs {title, body}: publish a post
    if (method === "POST" && seg.length === 1) {
      const b = await body(request);
      const title = cleanText(b["title"], 120).trim(), text = cleanText(b["body"], 20000).trim();
      if (title.length < 4) throw new HttpError(400, "titles need at least 4 characters");
      if (text.length < 20) throw new HttpError(400, "write at least a few sentences");
      await this.rateLimit("SELECT COUNT(*) AS n FROM social_blogs WHERE uid = ? AND created > ?", [me.id, now - 86_400_000], 5, "blog posts today");
      const id = "b_" + randomString(10).toLowerCase();
      await this.q("INSERT INTO social_blogs (id, uid, title, body, created) VALUES (?, ?, ?, ?, ?)", id, me.id, title, text, now).run();
      return { id };
    }
    const id = str(seg[1], 32);
    // GET /blogs/:id: the whole post
    if (method === "GET" && seg.length === 2) {
      const [post, liked] = await this.many(
        this.q(`SELECT b.*, u.name, u.avatar FROM social_blogs b LEFT JOIN social_users u ON u.id = b.uid WHERE b.id = ? AND b.hidden = 0`, id),
        this.q("SELECT 1 AS x FROM social_blog_likes WHERE blog = ? AND uid = ?", id, me.id));
      const p = post?.[0];
      if (!p) throw new HttpError(404, "that post was removed");
      return { post: { id: p["id"], title: p["title"], body: p["body"], created: p["created"], likes: p["likes"], liked: !!liked?.length, author: authorOf(p), mine: p["uid"] === me.id } };
    }
    // POST /blogs/:id/like: like it, or take the like back
    if (method === "POST" && seg[2] === "like") {
      const had = await this.q("SELECT 1 AS x FROM social_blog_likes WHERE blog = ? AND uid = ?", id, me.id).first();
      if (had) {
        await this.many(this.q("DELETE FROM social_blog_likes WHERE blog = ? AND uid = ?", id, me.id), this.q("UPDATE social_blogs SET likes = likes - 1 WHERE id = ?", id));
      } else {
        const exists = await this.q("SELECT 1 AS x FROM social_blogs WHERE id = ? AND hidden = 0", id).first();
        if (!exists) throw new HttpError(404, "that post was removed");
        await this.many(this.q("INSERT OR IGNORE INTO social_blog_likes (blog, uid) VALUES (?, ?)", id, me.id), this.q("UPDATE social_blogs SET likes = likes + 1 WHERE id = ?", id));
      }
      return { liked: !had };
    }
    // POST /blogs/:id/delete: authors remove their own posts
    if (method === "POST" && seg[2] === "delete") {
      await this.many(
        this.q("DELETE FROM social_blog_likes WHERE blog = ? AND EXISTS (SELECT 1 FROM social_blogs WHERE id = ? AND uid = ?)", id, id, me.id),
        this.q("DELETE FROM social_blogs WHERE id = ? AND uid = ?", id, me.id));
      return { ok: true };
    }
    throw new HttpError(404, "not found");
  }

  private async coaches(request: Request, me: UserRow, seg: string[], now: number): Promise<unknown> {
    const method = request.method;
    // GET /coaches: players offering lessons, most recently updated first
    if (method === "GET" && seg.length === 1) {
      type Row = UserRow & { c_title: string; c_bio: string; c_langs: string; c_rate: string; c_topics: string; c_updated: number };
      const r = await this.q(`SELECT u.*, c.title AS c_title, c.bio AS c_bio, c.langs AS c_langs, c.rate AS c_rate, c.topics AS c_topics, c.updated AS c_updated
          FROM social_coaches c JOIN social_users u ON u.id = c.uid WHERE c.hidden = 0 AND ${HIDE_BLOCKED("c.uid")} ORDER BY c.updated DESC LIMIT 100`, me.id).all<Row>();
      return {
        coaches: r.results.map((x) => ({ user: publicUser(x, now), title: x.c_title, bio: x.c_bio, langs: x.c_langs, rate: x.c_rate, topics: x.c_topics, updated: x.c_updated, mine: x.id === me.id })),
      };
    }
    // POST /coaches {title, bio, langs, rate, topics}: list yourself as a coach, or update your listing
    if (method === "POST" && seg.length === 1) {
      const b = await body(request);
      const bio = cleanText(b["bio"], 1500).trim();
      if (bio.length < 40) throw new HttpError(400, "tell students a little more about how you teach (40 characters or more)");
      const field = (k: string, max: number) => cleanText(b[k], max).replace(/\s+/g, " ").trim();
      await this.q(`INSERT INTO social_coaches (uid, title, bio, langs, rate, topics, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (uid) DO UPDATE SET title = excluded.title, bio = excluded.bio, langs = excluded.langs, rate = excluded.rate, topics = excluded.topics, updated = excluded.updated`,
        me.id, field("title", 40), bio, field("langs", 80), field("rate", 60), field("topics", 120), now).run();
      return { ok: true };
    }
    // POST /coaches/remove: take your listing down
    if (method === "POST" && seg[1] === "remove") {
      await this.q("DELETE FROM social_coaches WHERE uid = ?", me.id).run();
      return { ok: true };
    }
    throw new HttpError(404, "not found");
  }

  private async dropClub(id: string) {
    await this.many(this.q("DELETE FROM social_messages WHERE club = ?", id), this.q("DELETE FROM social_club_bans WHERE club = ?", id),
      this.q("DELETE FROM social_clubs WHERE id = ?", id));
    // its team matches and Vote Chess games that never started go too, and any game neither club is left to see
    // (one under way against a club that's still there stays, so that club keeps its result)
    const orphan = "(a_club NOT IN (SELECT id FROM social_clubs) AND b_club NOT IN (SELECT id FROM social_clubs))";
    const mids = `SELECT id FROM social_club_matches WHERE ((a_club = ? OR b_club = ?) AND status IN ('challenge', 'signup', 'declined')) OR ${orphan}`;
    const vids = `SELECT id FROM social_vote_games WHERE ((a_club = ? OR b_club = ?) AND status IN ('challenge', 'declined')) OR ${orphan}`;
    await this.many(
      this.q(`DELETE FROM social_club_match_players WHERE mid IN (${mids})`, id, id),
      this.q(`DELETE FROM social_club_match_games WHERE mid IN (${mids})`, id, id),
      this.q(`DELETE FROM social_vote_votes WHERE game IN (${vids})`, id, id),
      this.q(`DELETE FROM social_club_matches WHERE id IN (${mids})`, id, id),
      this.q(`DELETE FROM social_vote_games WHERE id IN (${vids})`, id, id));
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
