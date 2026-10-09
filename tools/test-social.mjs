// Tests the social API (server/social.ts) against SQLite through a small D1-compatible shim.
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = await build({ entryPoints: [new URL("../server/social.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", write: false });
const dir = mkdtempSync(join(tmpdir(), "social-"));
writeFileSync(join(dir, "social.mjs"), out.outputFiles[0].text);
const { Social } = await import(join(dir, "social.mjs"));

function d1(db) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          // like D1, the SQL is compiled when the statement runs, not when it's bound
          const vals = args.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v));
          return {
            first: async () => db.prepare(sql).get(...vals) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...vals) }),
            run: async () => db.prepare(sql).run(...vals),
          };
        },
      };
    },
    // D1 runs a batch as one transaction; sequential execution is equivalent here
    batch: async (stmts) => { const out = []; for (const st of stmts) out.push(await st.all()); return out; },
  };
}

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };

let clock = 1_800_000_000_000;
// the room server, as the arena code sees it: room -> {status, seats, result}
const rooms = new Map();
const api = new Social(d1(new DatabaseSync(":memory:")), () => clock, { roomState: async (room) => rooms.get(room) ?? null });
async function call(method, path, { body, secret, query = "", ip = "1.1.1.1" } = {}) {
  const req = new Request("https://x/api/social" + path + query, {
    method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...(secret ? { Authorization: "Bearer " + secret } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await api.handle(req, path);
  return { status: res.status, data: await res.json(), cors: res.headers.get("Access-Control-Allow-Origin") };
}

// registration
const bad = await call("POST", "/register", { body: { name: "x y!" } });
ok(bad.status === 400, "bad names are refused");
const a = (await call("POST", "/register", { body: { name: "Alice", avatar: { emoji: "♛", bg: "#2f6b4f" } } })).data;
const b = (await call("POST", "/register", { body: { name: "Bob" } })).data;
ok(/^[0-9a-f]{64}$/.test(a.secret) && a.code.length === 8 && a.id.startsWith("u_"), "register returns id, secret and friend code");
ok((await call("GET", "/me", { secret: "0".repeat(64) })).status === 401, "unknown secret is refused");
ok((await call("GET", "/me", {})).status === 401, "missing secret is refused");
const me = await call("GET", "/me", { secret: a.secret });
ok(me.data.me.name === "Alice" && me.data.me.avatar.emoji === "♛" && me.cors === "*", "me works, avatar stored, CORS header present");

// heartbeat + ratings
await call("POST", "/heartbeat", { secret: a.secret, body: { status: "playing", ratings: { blitz: { r: 1600, n: 12 }, puzzle: { r: 99999, n: 30 } }, games: 12 } });
const hb = await call("GET", "/me", { secret: a.secret });
ok(hb.data.me.ratings.blitz.r === 1600 && hb.data.me.ratings.puzzle.r === 3500 && hb.data.me.status === "playing", "heartbeat stores ratings (clamped) and status");

// friends
ok((await call("POST", "/friends/request", { secret: a.secret, body: { code: a.code } })).status === 400, "can't friend yourself");
ok((await call("POST", "/friends/request", { secret: a.secret, body: { code: "ZZZZZZZZ" } })).status === 404, "unknown code is a 404");
const fr = await call("POST", "/friends/request", { secret: a.secret, body: { code: b.code } });
ok(fr.data.status === "pending", "friend request is pending");
let bf = (await call("GET", "/friends", { secret: b.secret })).data;
ok(bf.incoming.length === 1 && bf.incoming[0].name === "Alice" && bf.friends.length === 0, "recipient sees the incoming request");
ok((await call("POST", "/messages", { secret: a.secret, body: { to: b.id, text: "hi" } })).status === 403, "can't message before being friends");
await call("POST", "/friends/respond", { secret: b.secret, body: { id: a.id, accept: true } });
bf = (await call("GET", "/friends", { secret: b.secret })).data;
const af = (await call("GET", "/friends", { secret: a.secret })).data;
ok(bf.friends.length === 1 && af.friends.length === 1 && af.friends[0].name === "Bob", "accepting makes both sides friends");
ok(af.friends[0].online === true, "a fresh friend shows as online");
await call("POST", "/heartbeat", { secret: b.secret, body: { status: "playing", room: "c-live123" } });
ok((await call("GET", "/friends", { secret: a.secret })).data.friends[0].watch === "c-live123", "friends can see which game you're playing");
await call("POST", "/heartbeat", { secret: b.secret, body: { status: "online", room: "c-live123" } });
ok((await call("GET", "/friends", { secret: a.secret })).data.friends[0].watch === null, "and nothing once you're out of it");
clock += 120_000;
ok((await call("GET", "/friends", { secret: a.secret })).data.friends[0].online === false, "after 2 minutes without a heartbeat they're offline");

// messages and challenges
await call("POST", "/messages", { secret: a.secret, body: { to: b.id, text: "  good game!  " } });
await call("POST", "/messages", { secret: a.secret, body: { to: b.id, kind: "challenge", room: "abc123", tc: "5+0", mode: "live" } });
ok((await call("POST", "/messages", { secret: a.secret, body: { to: b.id, kind: "challenge", room: "../x", tc: "5+0" } })).status === 400, "malformed challenge is refused");
ok((await call("POST", "/messages", { secret: a.secret, body: { to: b.id, kind: "challenge", room: "daily-abc", tc: "3d", mode: "daily" } })).status === 200, "daily challenge with days per move is accepted");
let hbB = (await call("POST", "/heartbeat", { secret: b.secret, body: {} })).data;
ok(hbB.unread === 3 && hbB.latest.length === 3 && hbB.latest[0].kind === "challenge", "heartbeat reports unread messages and the latest ones");
const thread = (await call("GET", "/messages", { secret: b.secret, query: "?with=" + a.id })).data.messages;
ok(thread.length === 3 && thread[0].body === "good game!" && JSON.parse(thread[1].body).room === "abc123" && JSON.parse(thread[2].body).tc === "3d", "thread returns messages in order, trimmed");
hbB = (await call("POST", "/heartbeat", { secret: b.secret, body: {} })).data;
ok(hbB.unread === 0, "reading a thread marks it seen");
const convs = (await call("GET", "/conversations", { secret: a.secret })).data.conversations;
ok(convs.length === 1 && convs[0].last.kind === "challenge", "conversations list the last message");
let limited = false;
for (let i = 0; i < 35; i++) { const r = await call("POST", "/messages", { secret: a.secret, body: { to: b.id, text: "spam " + i } }); if (r.status === 429) { limited = true; break; } }
ok(limited, "message rate limit kicks in");

// clubs
const c = (await call("POST", "/clubs/create", { secret: a.secret, body: { name: "Knights of e4", about: "Open games only" } })).data;
ok(c.id.startsWith("c_") && c.code.length === 8, "club created with an invite code");
ok((await call("GET", "/clubs/" + c.id, { secret: b.secret })).status === 403, "non-members can't read a club");
await call("POST", "/clubs/join", { secret: b.secret, body: { code: c.code } });
await call("POST", "/clubs/" + c.id + "/messages", { secret: b.secret, body: { text: "hello club" } });
const club = (await call("GET", "/clubs/" + c.id, { secret: a.secret })).data;
ok(club.members.length === 2 && club.messages.length === 1 && club.messages[0].sender_name === "Bob", "club shows members and chat");
const clubs = (await call("GET", "/clubs", { secret: b.secret })).data;
ok(clubs.mine.length === 1 && clubs.public[0].members === 2, "club lists show membership counts");
ok((await call("POST", "/clubs/" + c.id + "/remove", { secret: b.secret, body: { member: a.id } })).status === 403, "members can't remove others");
ok((await call("POST", "/clubs/" + c.id + "/remove", { secret: a.secret, body: { member: b.id } })).data.ok === true, "the owner can remove a member");
ok((await call("GET", "/clubs/" + c.id, { secret: b.secret })).status === 403, "a removed member loses access");
ok((await call("POST", "/clubs/join", { secret: b.secret, body: { code: c.code } })).status === 403, "a removed member can't rejoin");
await call("POST", "/clubs/leave", { secret: a.secret, body: { id: c.id } });
ok((await call("GET", "/clubs", { secret: a.secret })).data.public.length === 0, "an empty club is removed");

// leaderboard
for (const [name, r] of [["Carol", 1900], ["Dan", 1400], ["Eve", 2100]]) {
  const u = (await call("POST", "/register", { body: { name } })).data;
  await call("POST", "/heartbeat", { secret: u.secret, body: { ratings: { blitz: { r, n: 20 } } } });
}
await call("POST", "/heartbeat", { secret: a.secret, body: { ratings: { blitz: { r: 1600, n: 12 } } } });
const lb = (await call("GET", "/leaderboard", { secret: a.secret, query: "?cat=blitz" })).data;
ok(lb.top.map((u) => u.name).join(",") === "Eve,Carol,Alice,Dan" && lb.me.rank === 3, "leaderboard ranks active players with enough games");
ok((await call("GET", "/leaderboard", { secret: b.secret, query: "?cat=blitz" })).data.me.rank === null, "players without enough games aren't ranked");
ok((await call("GET", "/leaderboard", { secret: a.secret, query: "?cat=hacker'--" })).data.cat === "blitz", "unknown categories fall back safely");

// registration rate limit per IP
let regLimited = false;
for (let i = 0; i < 25; i++) { const r = await call("POST", "/register", { body: { name: "spam" + i }, ip: "9.9.9.9" }); if (r.status === 429) { regLimited = true; break; } }
ok(regLimited, "registrations are rate limited per IP");
ok((await call("GET", "/nope", { secret: a.secret })).status === 404, "unknown routes are 404");

// deleting a player removes them everywhere
const c2 = (await call("POST", "/clubs/create", { secret: b.secret, body: { name: "Bob's club" } })).data;
await call("POST", "/clubs/" + c2.id + "/messages", { secret: b.secret, body: { text: "anyone here?" } });
ok((await call("POST", "/delete", { secret: b.secret })).data.ok === true, "a player can delete their social profile");
ok((await call("GET", "/me", { secret: b.secret })).status === 401, "a deleted player's key stops working");
const afterDel = (await call("GET", "/friends", { secret: a.secret })).data;
ok(afterDel.friends.length === 0 && (await call("GET", "/conversations", { secret: a.secret })).data.conversations.length === 0, "friendships and messages go with them");
ok(!(await call("GET", "/clubs", { secret: a.secret })).data.public.some((x) => x.id === c2.id), "a club left empty is removed");

// live arenas
const ann = (await call("POST", "/register", { body: { name: "Ann" }, ip: "2.2.2.2" })).data;
const cid = (await call("POST", "/register", { body: { name: "Cid" }, ip: "2.2.2.2" })).data;
const dee = (await call("POST", "/register", { body: { name: "Dee" }, ip: "2.2.2.2" })).data;
const arenas = (await call("GET", "/arenas", { secret: ann.secret })).data.arenas;
const live = arenas.find((x) => x.starts <= clock && clock < x.ends);
ok(arenas.length >= 2 && live && live.tc === "3+0", "the schedule always has a running arena and the next one");
const later = arenas.find((x) => x.starts > clock);
const pidA = "p-aaaa.Ann.1500.ABCDEFGH", pidC = "p-cccc.Cid.1500", pidD = "p-dddd.Dee.1500";
for (const u of [ann, cid, dee]) await call("POST", `/arenas/${live.id}/join`, { secret: u.secret });
let pa = (await call("POST", `/arenas/${live.id}/pair`, { secret: ann.secret, body: { pid: pidA } })).data;
ok(pa.state === "waiting" && !pa.room, "the first player waits for an opponent");
let pc = (await call("POST", `/arenas/${live.id}/pair`, { secret: cid.secret, body: { pid: pidC } })).data;
ok(pc.state === "paired" && pc.room && pc.opponent.name === "Ann", "the next player is paired with them");
pa = (await call("POST", `/arenas/${live.id}/pair`, { secret: ann.secret, body: { pid: pidA } })).data;
ok(pa.state === "paired" && pa.room === pc.room && pa.opponent.name === "Cid", "both sides see the same game");
ok((await call("POST", `/arenas/${live.id}/pair`, { secret: ann.secret, body: { pid: "../../x" } })).status === 400, "bad player ids are refused");
rooms.set(pc.room, { status: "playing", seats: [pidC, pidA], result: null });
ok((await call("POST", `/arenas/${live.id}/result`, { secret: ann.secret, body: { room: pc.room } })).status === 409, "a game in progress can't be scored");
rooms.set(pc.room, { status: "over", seats: [pidC, pidA], result: { winner: pidA, reason: "checkmate" } });
const res = (await call("POST", `/arenas/${live.id}/result`, { secret: cid.secret, body: { room: pc.room } })).data;
await call("POST", `/arenas/${live.id}/result`, { secret: ann.secret, body: { room: pc.room } });
let st = (await call("GET", `/arenas/${live.id}`, { secret: ann.secret })).data;
const row = (n) => st.standings.find((x) => x.name === n);
ok(res.outcome && row("Ann").score === 2 && row("Cid").score === 0 && row("Ann").games === 1, "the server reads the winner from the room and scores once");
// two more wins for Ann: the third win in a row counts double
for (let i = 0; i < 2; i++) {
  await call("POST", `/arenas/${live.id}/pair`, { secret: ann.secret, body: { pid: pidA } });
  const p2 = (await call("POST", `/arenas/${live.id}/pair`, { secret: dee.secret, body: { pid: pidD } })).data;
  rooms.set(p2.room, { status: "over", seats: [pidA, pidD], result: { winner: pidA, reason: "resignation" } });
  await call("POST", `/arenas/${live.id}/result`, { secret: dee.secret, body: { room: p2.room } });
}
st = (await call("GET", `/arenas/${live.id}`, { secret: ann.secret })).data;
ok(row("Ann").score === 8 && row("Ann").streak === 3 && st.standings[0].name === "Ann", "win streaks score double after two wins");
// a player who stopped asking isn't paired
await call("POST", `/arenas/${live.id}/pair`, { secret: cid.secret, body: { pid: pidC } });
clock += 20_000;
const pd = (await call("POST", `/arenas/${live.id}/pair`, { secret: dee.secret, body: { pid: pidD } })).data;
ok(pd.state === "waiting", "players who stopped polling aren't paired");
const pc2 = (await call("POST", `/arenas/${live.id}/pair`, { secret: cid.secret, body: { pid: pidC } })).data;
ok(pc2.state === "paired" && pc2.opponent.name === "Dee", "but are as soon as they ask again");
// the opponent never shows up: no score after 45 seconds
rooms.set(pc2.room, { status: "waiting", seats: [pidC], result: null });
clock += 50_000;
const v = (await call("POST", `/arenas/${live.id}/result`, { secret: cid.secret, body: { room: pc2.room } })).data;
st = (await call("GET", `/arenas/${live.id}`, { secret: ann.secret })).data;
ok(v.outcome === "void" && row("Cid").games === 1 && row("Dee").state === "idle", "a no-show voids the game and frees both players");
const notYet = (await call("POST", `/arenas/${later.id}/pair`, { secret: ann.secret, body: { pid: pidA } }));
ok(notYet.status === 403 || notYet.data.running === false, "an arena that hasn't started doesn't pair");

// accounts without passwords: link another device, cloud backup, sign out other devices
const link = (await call("POST", "/link/create", { secret: ann.secret })).data;
ok(link.code && link.code.length === 8 && link.expires > clock, "a device link code is issued");
const dev2 = (await call("POST", "/link/claim", { body: { code: link.code }, ip: "3.3.3.3" })).data;
ok(dev2.id === ann.id && dev2.secret !== ann.secret, "another device signs in to the same profile with its own key");
ok((await call("GET", "/me", { secret: dev2.secret })).data.me.name === "Ann", "the linked device acts as that player");
ok((await call("POST", "/link/claim", { body: { code: link.code }, ip: "3.3.3.3" })).status === 404, "a link code works once");
ok((await call("GET", "/devices", { secret: ann.secret })).data.devices === 2, "the profile counts its devices");
const backup = JSON.stringify({ v: 1, profile: { name: "Ann" }, games: [{ id: "x" }] });
ok((await call("POST", "/backup", { secret: dev2.secret, body: { data: backup } })).data.ok, "a backup can be stored");
ok((await call("POST", "/backup", { secret: dev2.secret, body: { data: "{\"nope\":1}" } })).status === 400, "only Chess 3D backups are accepted");
ok((await call("GET", "/backup", { secret: ann.secret })).data.data === backup, "and read back from any of the profile's devices");
const reset = (await call("POST", "/devices/reset", { secret: dev2.secret })).data;
ok((await call("GET", "/me", { secret: ann.secret })).status === 401 && (await call("GET", "/me", { secret: reset.secret })).status === 200,
  "signing out other devices leaves only this one, with a new key");
ann.secret = reset.secret;
clock += LINK_WAIT();
const stale = (await call("POST", "/link/create", { secret: ann.secret })).data;
clock += 11 * 60_000;
ok((await call("POST", "/link/claim", { body: { code: stale.code }, ip: "3.3.3.4" })).status === 404, "link codes expire after 10 minutes");
function LINK_WAIT() { return 1000; }

// finding players by name
const found = (await call("GET", "/search", { secret: ann.secret, query: "?q=ci" })).data.players;
ok(found.length === 1 && found[0].name === "Cid", "players can be found by the start of their name");
ok((await call("GET", "/search", { secret: ann.secret, query: "?q=%25" })).data.players.length === 0, "wildcards aren't searches");

// recent games on profiles
const game = (i) => ({ id: "g" + i, white: { name: "Ann", rating: 1500 }, black: { name: "Stockfish", rating: 2000 }, result: "0-1", reason: "checkmate",
  tc: "5+0", mode: "bot", myColor: "w", moves: ["e2e4", "e7e5", "<script>", "g1f3"], date: clock });
ok((await call("POST", "/games", { secret: ann.secret, body: { game: game(0) } })).data.ok, "a finished game can be shared");
ok((await call("POST", "/games", { secret: ann.secret, body: { game: { ...game(1), moves: [] } } })).status === 400, "a game needs moves");
for (let i = 1; i <= 33; i++) { clock += 1000; await call("POST", "/games", { secret: ann.secret, body: { game: game(i) } }); }
const g = (await call("GET", `/users/${ann.id}/games`, { secret: cid.secret })).data.games;
ok(g.length === 30 && g[0].id === "g33" && g[0].moves.join(" ") === "e2e4 e7e5 g1f3", "profiles keep the last 30 games, newest first, moves cleaned");

// puzzle battles against real players
let fa = (await call("POST", "/battles/find", { secret: ann.secret })).data.battle;
ok(fa && !fa.opponent && !fa.starts, "the first searcher opens a battle and waits");
let fc = (await call("POST", "/battles/find", { secret: cid.secret })).data.battle;
ok(fc && fc.id === fa.id && fc.opponent.name === "Ann" && fc.starts > clock, "the next searcher joins it, with a short countdown");
fa = (await call("POST", "/battles/find", { secret: ann.secret })).data.battle;
ok(fa.id === fc.id && fa.opponent.name === "Cid" && fa.seed === fc.seed, "both get the same puzzles");
clock = fa.starts + 1000;
await call("POST", `/battles/${fa.id}/progress`, { secret: ann.secret, body: { score: 4, strikes: 1 } });
await call("POST", `/battles/${fa.id}/progress`, { secret: ann.secret, body: { score: 2, strikes: 0 } });
const prog = (await call("POST", `/battles/${fa.id}/progress`, { secret: cid.secret, body: { score: 3, strikes: 3, done: true } })).data.battle;
ok(prog.opponent.score === 4 && prog.opponent.strikes === 1 && prog.you.done, "progress is shared and never goes backwards");
ok((await call("POST", `/battles/${fa.id}/progress`, { secret: dee.secret, body: { score: 99 } })).status === 404, "outsiders can't touch a battle");
// two searchers who each opened a battle still meet: the older battle wins
clock += BATTLE_GAP();
const o1 = (await call("POST", "/battles/find", { secret: ann.secret })).data.battle;
clock += 100;
const o2 = (await call("POST", "/battles/find", { secret: dee.secret })).data.battle;
ok(o2.opponent && o2.id === o1.id, "a second searcher joins the open battle");
function BATTLE_GAP() { return 5 * 60_000; }
clock += 4 * 60_000;
const again = (await call("POST", "/battles/find", { secret: ann.secret })).data.battle;
ok(again && again.id !== o1.id && !again.opponent, "after a battle ends, searching opens a new one");

console.log(failures === 0 ? "\nALL SOCIAL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
