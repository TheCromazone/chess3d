// Tests the social API (server/social.ts) against SQLite through a small D1-compatible shim.
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = await build({ entryPoints: [new URL("../server/social.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", write: false });
const dir = mkdtempSync(join(tmpdir(), "social-"));
writeFileSync(join(dir, "social.mjs"), out.outputFiles[0].text);
const { Social, swissPairings } = await import(join(dir, "social.mjs"));
// Vote Chess plays moves into rooms: the tests referee them with the real rules (dist/logic.js)
const L = await import(new URL("../dist/logic.js", import.meta.url).href);
const actRooms = new Map();

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
// push requests are captured instead of sent
const pushes = [];
let pushStatus = 201;
const pending = [];
let feedCalls = 0;
const sqlite = new DatabaseSync(":memory:");
const api = new Social(d1(sqlite), () => clock, {
  roomState: async (room) => rooms.get(room) ?? null,
  roomAct: async (room, pid, action) => {
    const r = actRooms.get(room) || { seats: [], status: "waiting", state: null, result: null };
    actRooms.set(room, r);
    if (!r.seats.includes(pid) && r.seats.length < 2) r.seats.push(pid);
    if (r.status === "waiting" && r.seats.length >= 2) { r.state = L.setup(r.seats); r.status = "playing"; }
    if (action == null) return { ok: true, status: r.status };
    if (r.status !== "playing") return { ok: false, error: "game is not in progress" };
    const v = L.validateAction(r.state, pid, action);
    if (!v.ok) return { ok: false, error: v.error };
    r.state = L.applyAction(r.state, pid, action);
    const end = L.isGameOver(r.state);
    if (end.over) { r.status = "over"; r.result = end; }
    rooms.set(room, { status: r.status, seats: r.seats, result: r.result });
    return { ok: true, status: r.status, result: r.result };
  },
  waitUntil: (p) => pending.push(p),
  pushFetch: async (url, init) => { pushes.push({ url, init }); return new Response(null, { status: pushStatus }); },
  feedFetch: async (url) => {
    feedCalls++;
    if (url.includes("fide")) return new Response(`<rss><channel><item><title>Candidates &amp; more</title><link>https://www.fide.com/news/1</link><pubDate>Wed, 07 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`);
    if (url.includes("lichess.org/@")) return new Response(`<feed><entry><title>New lessons</title><link href="https://lichess.org/@/Lichess/blog/x"/><published>2026-10-06T10:00:00Z</published></entry></feed>`);
    if (url.includes("youtube")) return new Response(`<feed><entry><yt:videoId>abcDEF12345</yt:videoId><title>Best traps</title><published>2026-10-05T10:00:00Z</published></entry></feed>`);
    if (url.includes("streamer/live")) return Response.json([{ name: "x", stream: { service: "twitch", status: "Blitz!" }, streamer: { name: "Streamer X", twitch: "https://www.twitch.tv/x" } }]);
    if (url.includes("api.chess.com")) return Response.json({ streamers: [{ username: "Live1", is_live: true, platforms: [{ type: "youtube", stream_url: "https://www.youtube.com/watch?v=1", is_live: true }] }, { username: "Off", is_live: false }] });
    return new Response("", { status: 404 });
  },
});
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
await call("POST", "/heartbeat", { secret: a.secret, body: { rush: 27 } });
const rushLb = (await call("GET", "/leaderboard", { secret: a.secret, query: "?cat=rush" })).data;
ok(rushLb.top[0].name === "Alice" && rushLb.top[0].rush === 27 && rushLb.me.rank === 1, "Puzzle Rush has its own leaderboard");

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
const arenaTrophies = sqlite.prepare("SELECT uid, points FROM social_league_games WHERE room = ?").all(pc.room);
ok(arenaTrophies.length === 2 && arenaTrophies.find((x) => x.uid === ann.id).points === 18 && arenaTrophies.find((x) => x.uid === cid.id).points === 0, "an arena win earns double league trophies (3+0 is blitz: 2 x 9)");
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

// names are unique
const ann2 = (await call("POST", "/register", { body: { name: "ann" }, ip: "4.4.4.4" })).data;
ok(ann2.name !== "ann" && ann2.name.toLowerCase().startsWith("ann"), "a taken name gets a number on the end");
ok((await call("GET", "/names", { secret: ann2.secret, query: "?n=ANN" })).data.available === false, "name checks ignore case");
await call("POST", "/heartbeat", { secret: ann2.secret, body: { name: "Ann" } });
ok((await call("GET", "/me", { secret: ann2.secret })).data.me.name === ann2.name, "renaming to someone else's name doesn't go through");
await call("POST", "/heartbeat", { secret: ann.secret, body: { name: "ANN" } });
ok((await call("GET", "/me", { secret: ann.secret })).data.me.name === "ANN", "you can change the case of your own name");
await call("POST", "/heartbeat", { secret: ann.secret, body: { name: "Ann" } });
await call("POST", "/delete", { secret: ann2.secret });

// forums
const t1 = (await call("POST", "/forums", { secret: ann.secret, body: { cat: "openings", title: "Best reply to 1.e4?", body: "Sicilian or e5?" } })).data;
ok(t1.id && t1.id.startsWith("t_"), "a topic can be started");
ok((await call("POST", "/forums", { secret: ann.secret, body: { title: "Hi", body: "x" } })).status === 400, "titles need some length");
await call("POST", `/forums/${t1.id}`, { secret: cid.secret, body: { body: "The Caro-Kann!" } });
await call("POST", `/forums/${t1.id}`, { secret: dee.secret, body: { body: "e5, always" } });
let topics = (await call("GET", "/forums", { secret: dee.secret, query: "?cat=openings" })).data.topics;
ok(topics[0].title === "Best reply to 1.e4?" && topics[0].replies === 2 && topics[0].author.name === "Ann", "topics list replies and author");
let th = (await call("GET", `/forums/${t1.id}`, { secret: dee.secret })).data;
ok(th.posts.length === 2 && th.posts[1].mine && !th.topic.mine, "a topic shows its replies, marking your own");
await call("POST", `/forums/${t1.id}/posts/${th.posts[0].id}/delete`, { secret: dee.secret });
ok((await call("GET", `/forums/${t1.id}`, { secret: dee.secret })).data.posts.length === 2, "you can't delete someone else's reply");
await call("POST", `/forums/${t1.id}/posts/${th.posts[1].id}/delete`, { secret: dee.secret });
th = (await call("GET", `/forums/${t1.id}`, { secret: ann.secret })).data;
ok(th.posts.length === 1 && th.topic.replies === 1, "but you can delete your own");
for (const u of [cid, dee]) await call("POST", "/report", { secret: u.secret, body: { kind: "topic", id: t1.id } });
ok((await call("GET", `/forums/${t1.id}`, { secret: ann.secret })).status === 200, "two reports don't hide a topic");
const rep3 = (await call("POST", "/register", { body: { name: "Rex" }, ip: "5.5.5.5" })).data;
await call("POST", "/report", { secret: rep3.secret, body: { kind: "topic", id: t1.id } });
ok((await call("GET", `/forums/${t1.id}`, { secret: ann.secret })).status === 404, "three reports hide it");
await call("POST", "/delete", { secret: rep3.secret });

// Swiss pairing on its own
{
  const P = (uid, score2, rating, opps = [], colors = "", byes = 0) => ({ uid, score2, rating, opps, colors, byes });
  let r = swissPairings([P("a", 0, 1500), P("b", 0, 1400), P("c", 0, 1300), P("d", 0, 1200)]);
  ok(r.pairs.length === 2 && r.bye === null && r.pairs.flat().length === 4, "Swiss: four players make two games");
  r = swissPairings([P("a", 2, 1500, ["b"], "w"), P("b", 0, 1400, ["a"], "b"), P("c", 2, 1300, ["d"], "w"), P("d", 0, 1200, ["c"], "b")]);
  const met = (x, y) => r.pairs.some(([w, b]) => (w === x && b === y) || (w === y && b === x));
  ok(met("a", "c") && met("b", "d"), "Swiss: winners meet winners, and nobody meets the same player twice");
  ok(r.pairs.some(([w, b]) => w === "b" && b === "d") || r.pairs.some(([w, b]) => w === "d"), "Swiss: colours balance (a Black last time gets White)");
  r = swissPairings([P("a", 2, 1500), P("b", 2, 1400), P("c", 0, 1300, [], "", 1), P("d", 0, 1200), P("e", 0, 1100, [], "", 1)]);
  ok(r.bye === "d" && r.pairs.length === 2, "Swiss: the odd player out is the lowest placed without a bye");
}

// a whole Swiss tournament, through the API
{
  const SLOT = 2 * 3600_000, OFF = 15 * 60_000;
  const saved = clock;
  const slot = Math.floor((clock - OFF) / SLOT) + 1;
  const id = `sw-${slot}`;
  let list = (await call("GET", "/swiss", { secret: ann.secret })).data.tournaments;
  ok(list.some((t) => t.id === id && t.status === "open" && t.rounds >= 4), "the next Swiss tournament is listed and open");
  const pid = (n) => `p-x${n.toLowerCase()}.${n}.1500`;
  const players = [ann, cid, dee];
  for (const [i, u] of players.entries()) await call("POST", `/swiss/${id}/join`, { secret: u.secret, body: { pid: pid("P" + i) } });
  ok((await call("GET", `/swiss/${id}`, { secret: ann.secret })).data.standings.length === 3, "three players join");
  const t0 = (await call("GET", `/swiss/${id}`, { secret: ann.secret })).data.tournament;
  clock = t0.starts + 1000;
  for (const [i, u] of players.entries()) await call("POST", `/swiss/${id}/ping`, { secret: u.secret, body: { pid: pid("P" + i) } });
  let v = (await call("GET", `/swiss/${id}`, { secret: cid.secret })).data;
  ok(v.tournament.status === "running" && v.tournament.round === 1 && v.round.length === 1, "at the start, round 1 is paired (one game; the third player has a bye)");
  const byeOne = v.standings.find((p) => p.score === 1);
  ok(byeOne && byeOne.byes === 1, "the bye scores a point");
  // the game ends: White wins
  const g1 = v.round[0];
  const pidOf = (uid) => pid("P" + players.findIndex((u) => u.id === uid));
  rooms.set(g1.room, { status: "over", seats: [pidOf(g1.white.uid), pidOf(g1.black.uid)], result: { winner: pidOf(g1.white.uid), reason: "checkmate" } });
  clock += 20_000;
  for (const [i, u] of players.entries()) await call("POST", `/swiss/${id}/ping`, { secret: u.secret, body: { pid: pid("P" + i) } });
  v = (await call("GET", `/swiss/${id}`, { secret: dee.secret })).data;
  ok(v.tournament.round === 2 && v.round.length === 1 && v.games[0].outcome === "w", "round 1 is scored from the room, and round 2 is paired");
  const r2 = v.round[0];
  ok(r2.white.uid !== g1.white.uid || r2.black.uid !== g1.black.uid, "round 2 isn't a rematch");
  const mineView = (await call("GET", `/swiss/${id}`, { secret: r2.white.uid === ann.id ? ann.secret : r2.white.uid === cid.id ? cid.secret : dee.secret })).data.me;
  ok(mineView.game && mineView.game.color === "w" && mineView.game.room === r2.room, "a player sees their game, colour and room");
  // nobody turns up for round 2: a double forfeit once the no-show time passes
  for (let k = 0; k < 5; k++) { clock += 20_000; for (const [i, u] of players.entries()) await call("POST", `/swiss/${id}/ping`, { secret: u.secret, body: { pid: pid("P" + i) } }); }
  v = (await call("GET", `/swiss/${id}`, { secret: ann.secret })).data;
  ok(v.games.find((g) => g.room === r2.room).outcome === "double-forfeit" && v.tournament.round === 3, "a game nobody joined is a double forfeit, and play moves on");
  // the rest: players stop coming; after a grace period the tournament ends
  clock += 30 * 60_000;
  v = (await call("GET", `/swiss/${id}`, { secret: ann.secret })).data;
  for (let k = 0; k < 6 && v.tournament.status !== "done"; k++) { clock += 200_000; v = (await call("GET", `/swiss/${id}`, { secret: ann.secret })).data; }
  ok(v.tournament.status === "done" && v.standings[0].score >= v.standings[2].score, "with nobody left to pair, the tournament ends with final standings");
  ok(typeof v.standings[0].buchholz === "number", "standings carry a Buchholz tie-break");
  clock = saved;
}

// club team matches
{
  const ca = (await call("POST", "/clubs/create", { secret: ann.secret, body: { name: "Rooks United" } })).data;
  const cb = (await call("POST", "/clubs/create", { secret: cid.secret, body: { name: "Knights FC" } })).data;
  await call("POST", "/clubs/join", { secret: dee.secret, body: { code: ca.code } });
  ok((await call("POST", `/clubs/${ca.id}/matches`, { secret: dee.secret, body: { opponent: cb.id } })).status === 403, "only a club's owner can challenge");
  const ch = (await call("POST", `/clubs/${ca.id}/matches`, { secret: ann.secret, body: { opponent: cb.id, tc: "1d", boards: 5 } })).data;
  ok(ch.id && ch.id.startsWith("cm_"), "a club challenges another club");
  ok((await call("GET", `/clubs/${cb.id}/matches`, { secret: cid.secret })).data.matches.some((m) => m.id === ch.id && m.status === "challenge"), "the challenged club sees it");
  ok((await call("POST", `/matches/${ch.id}/accept`, { secret: ann.secret })).status === 403, "only the challenged owner answers");
  await call("POST", `/matches/${ch.id}/accept`, { secret: cid.secret });
  const mp = (u) => `p-cm${u.name.toLowerCase()}.${u.name}.1500`;
  for (const u of [ann, dee, cid]) await call("POST", `/matches/${ch.id}/join`, { secret: u.secret, body: { pid: mp(u) } });
  let mv = (await call("GET", `/matches/${ch.id}`, { secret: dee.secret })).data;
  ok(mv.match.status === "signup" && mv.players.length === 3 && mv.me.joined, "members of both clubs sign up");
  const outsider = (await call("POST", "/register", { body: { name: "Out" }, ip: "7.7.7.7" })).data;
  ok((await call("GET", `/matches/${ch.id}`, { secret: outsider.secret })).status === 403, "outsiders can't see the match");
  ok((await call("POST", `/matches/${ch.id}/join`, { secret: outsider.secret, body: { pid: "p-out.Out.1500" } })).status === 403, "or play in it");
  await call("POST", "/delete", { secret: outsider.secret });
  await call("POST", `/matches/${ch.id}/start`, { secret: cid.secret });
  mv = (await call("GET", `/matches/${ch.id}`, { secret: ann.secret })).data;
  ok(mv.match.status === "running" && mv.games.length === 2 && mv.games.every((g) => g.board === 1), "the match starts: one board (2 against 1), two games");
  // Rooks United's board-one player is whoever is rated higher of Ann and Dee
  const gA = mv.games.find((g) => g.wSide === "a"), gB = mv.games.find((g) => g.wSide === "b");
  const top = [ann, dee].find((u) => u.id === gA.white.uid);
  const tv = (await call("GET", `/matches/${ch.id}`, { secret: top.secret })).data;
  const mineG = tv.games.filter((g) => g.mine);
  ok(mineG.length === 2 && mineG.some((g) => g.mine.color === "w") && mineG.some((g) => g.mine.color === "b") && mineG[0].mine.pid === mp(top), "the board-one player plays both colours, and sees their player id");
  rooms.set(gA.room, { status: "over", seats: [mp(top), mp(cid)], result: { winner: mp(top), reason: "resignation" } });
  rooms.set(gB.room, { status: "over", seats: [mp(cid), mp(top)], result: { draw: true, reason: "agreement" } });
  mv = (await call("GET", `/matches/${ch.id}`, { secret: cid.secret })).data;
  ok(mv.match.status === "done" && mv.match.aScore === 1.5 && mv.match.bScore === 0.5, "results come from the rooms: Rooks United 1.5, Knights FC 0.5");
}

// Vote Chess
{
  const va = (await call("POST", "/clubs/create", { secret: ann.secret, body: { name: "Vote Rooks" } })).data;
  const vb = (await call("POST", "/clubs/create", { secret: cid.secret, body: { name: "Vote Knights" } })).data;
  await call("POST", "/clubs/join", { secret: dee.secret, body: { code: va.code } });
  const vg = (await call("POST", `/clubs/${va.id}/votechess`, { secret: ann.secret, body: { opponent: vb.id, tc: "1d" } })).data;
  ok(vg.id && vg.id.startsWith("vc_"), "a club challenges another to Vote Chess");
  await call("POST", `/votechess/${vg.id}/accept`, { secret: cid.secret });
  let vv = (await call("GET", `/votechess/${vg.id}`, { secret: dee.secret })).data;
  const room = vv.game.room;
  ok(vv.game.status === "running" && vv.toMove === "a" && vv.colour === "w" && actRooms.get(room)?.status === "playing", "accepted: the clubs are seated in a room, White to vote");
  ok((await call("POST", `/votechess/${vg.id}/vote`, { secret: cid.secret, body: { move: "e7e5" } })).status === 409, "the other club can't vote out of turn");
  await call("POST", `/votechess/${vg.id}/vote`, { secret: dee.secret, body: { move: "e2e4" } });
  clock += 1000;
  await call("POST", `/votechess/${vg.id}/vote`, { secret: ann.secret, body: { move: "d2d4" } });
  vv = (await call("GET", `/votechess/${vg.id}`, { secret: ann.secret })).data;
  ok(vv.tally.length === 2 && vv.myVote === "d2d4", "votes are tallied, and you see your own");
  ok((await call("GET", `/votechess/${vg.id}`, { secret: cid.secret })).data.tally.length === 0, "the other club doesn't see your votes");
  ok((await call("POST", `/votechess/${vg.id}/play`, { secret: dee.secret })).status === 403, "only the owner can play the move early");
  await call("POST", `/votechess/${vg.id}/play`, { secret: ann.secret });
  ok(actRooms.get(room).state.moves[0].to === "e4", "a tie goes to the earlier vote: 1.e4 is played");
  await call("POST", `/votechess/${vg.id}/vote`, { secret: cid.secret, body: { move: "e7e5" } });
  clock += 86_400_000 + 1000;
  vv = (await call("GET", `/votechess/${vg.id}`, { secret: cid.secret })).data;
  ok(vv.game.ply === 2 && actRooms.get(room).state.moves[1].to === "e5", "at the deadline the leading move is played (1...e5)");
  await call("POST", `/votechess/${vg.id}/vote`, { secret: dee.secret, body: { move: "e2e4" } });
  clock += 1000;
  await call("POST", `/votechess/${vg.id}/vote`, { secret: ann.secret, body: { move: "g1f3" } });
  await call("POST", `/votechess/${vg.id}/play`, { secret: ann.secret });
  ok(actRooms.get(room).state.moves[2].to === "f3", "an illegal vote is skipped for the next one (2.Nf3)");
  clock += 86_400_000 + 1000;
  vv = (await call("GET", `/votechess/${vg.id}`, { secret: ann.secret })).data;
  ok(vv.game.status === "done" && vv.game.result === "1-0" && actRooms.get(room).status === "over", "a side with no votes at the deadline loses");
  const outsider = (await call("POST", "/register", { body: { name: "Out2" }, ip: "8.8.8.8" })).data;
  ok((await call("GET", `/votechess/${vg.id}`, { secret: outsider.secret })).status === 403, "outsiders can't see or vote");
  await call("POST", "/delete", { secret: outsider.secret });
}

// a club that's dropped takes its unplayed matches and Vote Chess games with it, and any nobody can see any more
{
  const count = (t, col, v) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(v).n;
  const ka = (await call("POST", "/clubs/create", { secret: ann.secret, body: { name: "Gone Rooks" } })).data;
  const kb = (await call("POST", "/clubs/create", { secret: cid.secret, body: { name: "Gone Knights" } })).data;
  const open = (await call("POST", `/clubs/${ka.id}/matches`, { secret: ann.secret, body: { opponent: kb.id } })).data;
  const run = (await call("POST", `/clubs/${ka.id}/matches`, { secret: ann.secret, body: { opponent: kb.id, boards: 1 } })).data;
  await call("POST", `/matches/${run.id}/accept`, { secret: cid.secret });
  await call("POST", `/matches/${run.id}/join`, { secret: ann.secret, body: { pid: "p-gonea.Ann.1500" } });
  await call("POST", `/matches/${run.id}/join`, { secret: cid.secret, body: { pid: "p-goneb.Cid.1500" } });
  await call("POST", `/matches/${run.id}/start`, { secret: ann.secret });
  const vote = (await call("POST", `/clubs/${ka.id}/votechess`, { secret: ann.secret, body: { opponent: kb.id } })).data;
  await call("POST", `/votechess/${vote.id}/accept`, { secret: cid.secret });
  await call("POST", `/votechess/${vote.id}/vote`, { secret: ann.secret, body: { move: "e2e4" } });
  await call("POST", "/clubs/leave", { secret: ann.secret, body: { id: ka.id } });
  ok(count("social_club_matches", "id", open.id) === 0, "a dropped club's open challenges go");
  ok(count("social_club_matches", "id", run.id) === 1 && count("social_vote_games", "id", vote.id) === 1, "games under way stay while the other club is there");
  ok((await call("GET", `/matches/${run.id}`, { secret: cid.secret })).data.games.length === 2, "and the other club still sees them");
  await call("POST", "/clubs/leave", { secret: cid.secret, body: { id: kb.id } });
  ok(count("social_club_matches", "id", run.id) === 0 && count("social_club_match_games", "mid", run.id) === 0 && count("social_club_match_players", "mid", run.id) === 0, "with both clubs gone the match goes");
  ok(count("social_vote_games", "id", vote.id) === 0 && count("social_vote_votes", "game", vote.id) === 0, "and so does the Vote Chess game");
  // games left behind by clubs dropped earlier are swept up when any club goes
  sqlite.prepare("INSERT INTO social_club_matches (id, a_club, b_club, tc, boards, status, created) VALUES ('cm_stale', 'c_x', 'c_y', '3d', 1, 'running', 0)").run();
  sqlite.prepare("INSERT INTO social_vote_games (id, a_club, b_club, tc, status, created) VALUES ('vc_stale', 'c_x', 'c_y', '1d', 'running', 0)").run();
  const kc = (await call("POST", "/clubs/create", { secret: dee.secret, body: { name: "Brief Club" } })).data;
  await call("POST", "/clubs/leave", { secret: dee.secret, body: { id: kc.id } });
  ok(count("social_club_matches", "id", "cm_stale") === 0 && count("social_vote_games", "id", "vc_stale") === 0, "stale games from clubs dropped earlier are swept up too");
}

// variant ratings and leaderboards
await call("POST", "/heartbeat", { secret: ann.secret, body: { status: "online", vratings: { atomic: { r: 1620, n: 4 }, duck: { r: 1490, n: 2 }, bogus: { r: 9999, n: 9 } } } });
await call("POST", "/heartbeat", { secret: cid.secret, body: { status: "online", vratings: { atomic: { r: 1550, n: 1 }, crazyhouse: { r: 99999, n: 3 } } } });
let vlb = (await call("GET", "/leaderboard", { secret: dee.secret, query: "?cat=atomic" })).data;
ok(vlb.cat === "atomic" && vlb.top.length === 2 && vlb.top[0].name === "Ann" && vlb.top[0].variants.atomic.r === 1620 && vlb.me.rank === null, "a variant has its own leaderboard");
ok(!("bogus" in vlb.top[0].variants), "only known variants are kept");
vlb = (await call("GET", "/leaderboard", { secret: cid.secret, query: "?cat=crazyhouse" })).data;
ok(vlb.top[0].variants.crazyhouse.r === 4000 && vlb.me.rank === 1, "ratings are clamped, and your rank shows");
vlb = (await call("GET", "/leaderboard", { secret: cid.secret, query: "?cat=atomic" })).data;
ok(vlb.me.rank === 2 && vlb.me.rating === 1550, "your place on a variant board");

// blogs
const bp = (await call("POST", "/blogs", { secret: ann.secret, body: { title: "How I beat the London", body: "Play ...c5 early, then ...Qb6.\nIt works." } })).data;
ok(bp.id && bp.id.startsWith("b_"), "a blog post can be published");
ok((await call("POST", "/blogs", { secret: ann.secret, body: { title: "Hi", body: "too short" } })).status === 400, "blog posts need a title and some text");
let feed = (await call("GET", "/blogs", { secret: cid.secret })).data.posts;
ok(feed[0].id === bp.id && feed[0].author.name === "Ann" && feed[0].excerpt.startsWith("Play ...c5") && !feed[0].mine, "the blog feed shows the newest posts");
ok((await call("GET", "/blogs", { secret: cid.secret, query: `?by=${ann.id}` })).data.posts.length === 1 && (await call("GET", "/blogs", { secret: cid.secret, query: `?by=${cid.id}` })).data.posts.length === 0, "and one player's posts");
ok((await call("POST", `/blogs/${bp.id}/like`, { secret: cid.secret })).data.liked === true, "a post can be liked");
await call("POST", `/blogs/${bp.id}/like`, { secret: dee.secret });
let full = (await call("GET", `/blogs/${bp.id}`, { secret: cid.secret })).data.post;
ok(full.likes === 2 && full.liked && full.body.includes("\n"), "likes count, and the body keeps its line breaks");
await call("POST", `/blogs/${bp.id}/like`, { secret: cid.secret });
ok((await call("GET", `/blogs/${bp.id}`, { secret: cid.secret })).data.post.likes === 1, "liking again takes the like back");
await call("POST", `/blogs/${bp.id}/delete`, { secret: cid.secret });
ok((await call("GET", `/blogs/${bp.id}`, { secret: ann.secret })).status === 200, "only the author can delete a post");
for (let i = 0; i < 5; i++) await call("POST", "/blogs", { secret: dee.secret, body: { title: `Post number ${i}`, body: "Some thoughts about the game today." } });
ok((await call("POST", "/blogs", { secret: dee.secret, body: { title: "One too many", body: "Some thoughts about the game today." } })).status === 429, "five posts a day");
await call("POST", `/blogs/${bp.id}/delete`, { secret: ann.secret });
ok((await call("GET", `/blogs/${bp.id}`, { secret: ann.secret })).status === 404, "the author can delete it");

// the coach directory
ok((await call("POST", "/coaches", { secret: cid.secret, body: { bio: "Hi" } })).status === 400, "a coach listing needs a real description");
ok((await call("POST", "/coaches", { secret: cid.secret, body: { title: "FM", bio: "I teach club players to think in plans, with homework and game reviews.", langs: "English, Spanish", rate: "$30 an hour", topics: "openings, endgames" } })).data.ok, "a player can list themselves as a coach");
let coaches = (await call("GET", "/coaches", { secret: dee.secret })).data.coaches;
ok(coaches.length === 1 && coaches[0].user.name === "Cid" && coaches[0].title === "FM" && coaches[0].langs === "English, Spanish" && !coaches[0].mine, "the directory lists coaches with their details");
await call("POST", "/coaches", { secret: cid.secret, body: { title: "IM", bio: "I teach club players to think in plans, with homework and game reviews.", rate: "$40 an hour" } });
coaches = (await call("GET", "/coaches", { secret: cid.secret })).data.coaches;
ok(coaches.length === 1 && coaches[0].title === "IM" && coaches[0].rate === "$40 an hour" && coaches[0].mine, "updating a listing replaces it");
for (const u of [ann, dee]) await call("POST", "/report", { secret: u.secret, body: { kind: "coach", id: cid.id } });
const rep4 = (await call("POST", "/register", { body: { name: "Roy" }, ip: "6.6.6.6" })).data;
await call("POST", "/report", { secret: rep4.secret, body: { kind: "coach", id: cid.id } });
ok((await call("GET", "/coaches", { secret: ann.secret })).data.coaches.length === 0, "three reports hide a coach listing");
await call("POST", "/delete", { secret: rep4.secret });
await call("POST", "/coaches", { secret: dee.secret, body: { bio: "Patient lessons for beginners and returning players, any age." } });
await call("POST", "/coaches/remove", { secret: dee.secret });
ok((await call("GET", "/coaches", { secret: ann.secret })).data.coaches.length === 0, "a coach can take their listing down");

// notifications when the app is closed: web push with VAPID
const key = (await call("GET", "/push/key", { secret: ann.secret })).data.key;
ok(/^[A-Za-z0-9_-]{87}$/.test(key), "the server publishes a P-256 VAPID key");
ok((await call("POST", "/push/subscribe", { secret: ann.secret, body: { endpoint: "https://evil.example/x" } })).status === 400, "only browser push services are accepted");
const ep = "https://fcm.googleapis.com/fcm/send/abc123";
ok((await call("POST", "/push/subscribe", { secret: ann.secret, body: { endpoint: ep } })).data.ok, "a device subscribes to push");
await call("POST", "/friends/request", { secret: dee.secret, body: { code: ann.code } });
await Promise.all(pending.splice(0));
const sent = pushes.find((p) => p.url === ep);
const auth = sent && sent.init.headers.Authorization;
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth || "");
const pubKey = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
const signedOk = m && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, Buffer.from(m[3], "base64url"), new TextEncoder().encode(m[1] + "." + m[2]));
const claims = m && JSON.parse(Buffer.from(m[2], "base64url").toString());
ok(sent && sent.init.method === "POST" && sent.init.headers.TTL && signedOk && m[4] === key, "a friend request wakes the device with a correctly signed VAPID push");
ok(claims && claims.aud === "https://fcm.googleapis.com" && claims.exp > clock / 1000 && claims.sub.startsWith("https://"), "the push token is for that push service and expires");
const notes = (await call("GET", "/notes", { secret: ann.secret })).data;
ok(notes.request && notes.request.name === "Dee", "the service worker can see what the push was about");
await call("POST", "/nudge", { secret: dee.secret, body: { code: ann.code, room: "daily-abc", san: "Nf3" } });
await Promise.all(pending.splice(0));
const n2 = (await call("GET", "/notes", { secret: ann.secret })).data.notes;
ok(n2.length === 1 && JSON.parse(n2[0].body).san === "Nf3", "a daily move nudges the opponent");
pushStatus = 410;
await call("POST", "/nudge", { secret: cid.secret, body: { code: ann.code, room: "daily-xyz", san: "e4" } });
await Promise.all(pending.splice(0));
pushStatus = 201;
const before = pushes.length;
await call("POST", "/nudge", { secret: cid.secret, body: { code: ann.code, room: "daily-new", san: "d4" } });
await Promise.all(pending.splice(0));
ok(pushes.length === before, "a push address the service says is gone is dropped");

// news, videos and streamers
const f1 = (await call("GET", "/feeds")).data;
ok(f1.news.length === 2 && f1.news[0].title === "Candidates & more" && f1.news[1].source === "Lichess", "news from several feeds, newest first, entities decoded");
ok(f1.videos.length === 5 && f1.videos[0].id === "abcDEF12345", "latest videos from the channels");
ok(f1.streamers.length === 2 && f1.streamers.some((x) => x.name === "Live1" && x.platform === "youtube"), "only live streamers are listed");
const callsBefore = feedCalls;
await call("GET", "/feeds");
ok(feedCalls === callsBefore, "feeds are cached between visits");

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

// blocking
{
  const eve = (await call("POST", "/register", { body: { name: "Eve" }, ip: "10.1.1.1" })).data;
  const fay = (await call("POST", "/register", { body: { name: "Fay" }, ip: "10.1.1.2" })).data;
  await call("POST", "/friends/request", { secret: eve.secret, body: { code: fay.code } });
  await call("POST", "/friends/respond", { secret: fay.secret, body: { id: eve.id, accept: true } });
  await call("POST", "/messages", { secret: fay.secret, body: { to: eve.id, text: "hello" } });
  ok((await call("POST", "/heartbeat", { secret: eve.secret, body: {} })).data.unread === 1, "a message from a friend is unread");
  const club = (await call("POST", "/clubs/create", { secret: eve.secret, body: { name: "Blockers" } })).data;
  await call("POST", "/clubs/join", { secret: fay.secret, body: { code: club.code } });
  await call("POST", `/clubs/${club.id}/messages`, { secret: fay.secret, body: { text: "club hello" } });
  const topic = (await call("POST", "/forums", { secret: fay.secret, body: { cat: "general", title: "Fay's thread", body: "Hi all" } })).data;
  const etopic = (await call("POST", "/forums", { secret: eve.secret, body: { cat: "general", title: "Eve's thread", body: "Thoughts?" } })).data;
  await call("POST", `/forums/${etopic.id}`, { secret: fay.secret, body: { body: "Fay's reply" } });
  const blog = (await call("POST", "/blogs", { secret: fay.secret, body: { title: "Fay's blog", body: "Some thoughts about the Caro-Kann defence." } })).data;
  await call("POST", "/coaches", { secret: fay.secret, body: { title: "Coach Fay", bio: "I teach beginners how to castle and why." } });
  ok((await call("POST", "/block", { secret: eve.secret, body: { id: eve.id } })).status === 400, "you can't block yourself");
  ok((await call("POST", "/block", { secret: eve.secret, body: { id: fay.id } })).data.ok, "a player can be blocked");
  ok((await call("GET", "/friends", { secret: eve.secret })).data.friends.length === 0 && (await call("GET", "/friends", { secret: fay.secret })).data.friends.length === 0, "blocking ends the friendship both ways");
  ok((await call("POST", "/heartbeat", { secret: eve.secret, body: {} })).data.unread === 0, "and puts away their unread messages");
  ok((await call("POST", "/messages", { secret: fay.secret, body: { to: eve.id, text: "hi again" } })).status === 403, "they can't message you");
  const back = await call("POST", "/friends/request", { secret: fay.secret, body: { code: eve.code } });
  ok(back.status === 403 && !back.data.error.includes("blocked"), "or send a friend request (without being told they're blocked)");
  ok((await call("POST", "/friends/request", { secret: eve.secret, body: { code: fay.code } })).data.error.includes("unblock"), "you unblock before adding them back");
  ok((await call("POST", "/nudge", { secret: fay.secret, body: { code: eve.code, room: "d-blocked1", san: "e4" } })).data.ok === false, "they can't nudge you about a move");
  ok(!(await call("GET", "/forums", { secret: eve.secret })).data.topics.some((t) => t.id === topic.id), "their forum topics are hidden from you");
  ok((await call("GET", "/forums", { secret: dee.secret })).data.topics.some((t) => t.id === topic.id), "but not from anyone else");
  ok(!(await call("GET", `/forums/${etopic.id}`, { secret: eve.secret })).data.posts.some((p) => p.body === "Fay's reply"), "nor their replies");
  ok(!(await call("GET", "/blogs", { secret: eve.secret })).data.posts.some((p) => p.id === blog.id), "nor their blog posts");
  ok(!(await call("GET", "/coaches", { secret: eve.secret })).data.coaches.some((c) => c.user.id === fay.id), "nor their coach listing");
  ok(!(await call("GET", `/clubs/${club.id}`, { secret: eve.secret })).data.messages.some((m) => m.sender === fay.id), "nor their club chat");
  ok((await call("GET", `/clubs/${club.id}`, { secret: fay.secret })).data.messages.some((m) => m.sender === fay.id), "which still shows for them");
  ok((await call("GET", `/users/${fay.id}`, { secret: eve.secret })).data.blocked === true && (await call("GET", `/users/${eve.id}`, { secret: fay.secret })).data.blocked === false, "a profile says whether you've blocked them");
  ok((await call("GET", "/blocks", { secret: eve.secret })).data.blocked.map((u) => u.id).join() === fay.id, "your blocked list");
  await call("POST", "/unblock", { secret: eve.secret, body: { id: fay.id } });
  ok((await call("GET", "/forums", { secret: eve.secret })).data.topics.some((t) => t.id === topic.id), "unblocking shows their posts again");
  ok((await call("POST", "/friends/request", { secret: fay.secret, body: { code: eve.code } })).data.status === "pending", "and they can ask to be friends again");
  ok((await call("POST", "/block", { secret: eve.secret, body: { code: fay.code } })).data.ok && (await call("GET", "/blocks", { secret: eve.secret })).data.blocked.length === 1, "a player can be blocked by friend code (from a finished game)");
  await call("POST", "/delete", { secret: fay.secret });
  ok((await call("GET", "/blocks", { secret: eve.secret })).data.blocked.length === 0 && sqlite.prepare("SELECT COUNT(*) AS n FROM social_blocks").get().n === 0, "deleting a profile removes its blocks");
  await call("POST", "/delete", { secret: eve.secret });
}

// Leagues
{
  const saved = clock;
  const week = Math.floor((clock - Date.UTC(2026, 0, 4, 19)) / (7 * 86_400_000));
  clock = Date.UTC(2026, 0, 4, 19) + (week + 2) * 7 * 86_400_000 + 3_600_000;  // an hour into a later league week (the arena test's players are in this one)
  const gil = (await call("POST", "/register", { body: { name: "Gil" }, ip: "10.2.2.1" })).data;
  const hal = (await call("POST", "/register", { body: { name: "Hal" }, ip: "10.2.2.2" })).data;
  const gp = `p-gggg.Gil.1500.${gil.code}`, hp = `p-hhhh.Hal.1500.${hal.code}`;
  let n = 0;
  const game = (seats, result, tc = "3p2") => { const room = `pool-${tc}-${14000000 + n}-${n++ % 10}`; rooms.set(room, { status: "over", seats, result }); return room; };
  const report = (u, room, pid) => call("POST", "/league/result", { secret: u.secret, body: { room, pid } });
  let lg = (await call("GET", "/league", { secret: gil.secret })).data;
  ok(lg.tier === 0 && lg.tiers[0] === "Wood" && !lg.division && lg.ends > clock && lg.ends - clock < 7 * 86_400_000, "everyone starts in Wood, joining a division with their first scoring game");
  ok((await report(gil, "c-friendly1", gp)).status === 400, "games against friends don't earn trophies");
  rooms.set("pool-3p2-14000000-9", { status: "playing", seats: [gp, hp], result: null });
  ok((await report(gil, "pool-3p2-14000000-9", gp)).status === 409, "a game in progress can't be scored");
  const r1 = game([gp, hp], { winner: gp, reason: "checkmate" });
  ok((await report(gil, r1, hp)).status === 403, "you can only score your own seat");
  lg = (await report(gil, r1, gp)).data;
  ok(lg.earned === 9 && lg.division.standings.length === 1 && lg.division.standings[0].points === 9 && lg.division.standings[0].me, "a blitz win against a random opponent earns 9 trophies");
  ok((await report(gil, r1, gp)).data.why.includes("already"), "a game counts once");
  lg = (await report(hal, r1, hp)).data;
  ok(lg.earned === 0 && lg.division.standings.length === 2 && lg.division.standings[1].name === "Hal" && lg.division.standings[1].games === 1, "a loss earns nothing but joins the same Wood division");
  ok((await report(gil, game([gp, "p-anon.Guest.1200"], { winner: gp, reason: "resignation" }), gp)).data.why.includes("Social"), "games against players without Social don't count");
  ok((await report(gil, game([gp, hp], { draw: true, reason: "aborted" }), gp)).data.why.includes("aborted"), "nor do aborted games");
  ok((await report(gil, game([gp, hp], { draw: true, reason: "agreement" }, "10p0"), gp)).data.earned === 5, "a rapid draw earns 5");
  ok((await report(gil, game([gp, hp], { winner: gp, reason: "timeout" }, "1p0"), gp)).data.earned === 3, "a bullet win earns 3");
  // four scoring games a day against one opponent: the fifth earns nothing
  ok((await report(gil, game([gp, hp], { winner: gp, reason: "checkmate" }), gp)).data.earned === 9, "a fourth scoring game against the same opponent counts");
  ok((await report(gil, game([gp, hp], { winner: gp, reason: "checkmate" }), gp)).data.earned === 0, "after four scoring games against one opponent in a day, more don't earn trophies");
  clock += 86_400_000;
  ok((await report(gil, game([gp, hp], { winner: gp, reason: "checkmate" }), gp)).data.earned === 9, "the next day they do again");
  ok((await report(gil, game([gp, hp], { winner: gp, reason: "checkmate" }, "0_5p0"), gp)).status === 400, "games under a minute a side don't count");
  ok((await call("GET", `/users/${gil.id}`, { secret: hal.secret })).data.league === 0, "a profile shows the player's league");
  lg = (await call("GET", "/league", { secret: hal.secret })).data;
  ok(lg.division.promote === 1 && lg.division.standings[0].name === "Gil" && lg.division.standings[0].points === 35, "standings, and how many places move up");
  // the week ends: Gil (top, with trophies) moves up to Stone; Hal stays in Wood
  clock = lg.ends + 60_000;
  lg = (await call("GET", "/league", { secret: hal.secret })).data;
  ok(lg.tier === 0 && !lg.division && lg.last.place === 2 && !lg.last.promoted && lg.last.settled, "after the week, your final place");
  lg = (await call("GET", "/league", { secret: gil.secret })).data;
  ok(lg.tier === 1 && lg.best === 1 && lg.last.place === 1 && lg.last.promoted, "the winner moves up to Stone");
  lg = (await report(gil, game([gp, hp], { winner: hp, reason: "resignation" }), gp)).data;
  ok(lg.division && lg.division.tier === 1 && lg.division.standings.length === 1, "and plays this week in a Stone division");
  lg = (await report(hal, game([gp, hp], { winner: hp, reason: "resignation" }), hp)).data;
  ok(lg.division.tier === 0 && !lg.division.standings.some((x) => x.name === "Gil"), "while Hal's division is Wood");
  await call("POST", "/delete", { secret: gil.secret });
  await call("POST", "/delete", { secret: hal.secret });
  ok(sqlite.prepare("SELECT COUNT(*) AS n FROM social_league_entries WHERE uid IN (?, ?)").get(gil.id, hal.id).n === 0, "deleting a profile removes its league entries");
  clock = saved;
}

// daily tournaments
{
  const saved = clock;
  const ps = [];
  for (let i = 0; i < 7; i++) ps.push((await call("POST", "/register", { body: { name: "Dt" + i }, ip: `10.3.3.${i + 1}` })).data);
  const pidOf = (u) => `p-dt${u.name.toLowerCase()}.${u.name}.1200.${u.code}`;
  const [o] = ps;
  ok((await call("POST", "/dailytours", { secret: o.secret, body: { name: "x", pid: pidOf(o) } })).status === 400, "a tournament needs a name");
  const tid = (await call("POST", "/dailytours", { secret: o.secret, body: { name: "Autumn Daily", tc: "1d", size: 3, pid: pidOf(o) } })).data.id;
  ok(tid && tid.startsWith("dt_"), "a player creates a daily tournament (and is in it)");
  for (const u of ps.slice(1)) await call("POST", `/dailytours/${tid}/join`, { secret: u.secret, body: { pid: pidOf(u) } });
  let list = (await call("GET", "/dailytours", { secret: ps[3].secret })).data.tournaments;
  ok(list.some((t) => t.id === tid && t.players === 7 && t.joined && t.status === "signup"), "the list shows it open, with its players");
  ok((await call("POST", `/dailytours/${tid}/start`, { secret: ps[2].secret })).status === 403, "only its creator starts it early");
  let v = (await call("POST", `/dailytours/${tid}/start`, { secret: o.secret })).data;
  const sizes = v.groups.map((g) => g.rows.length).sort().join();
  ok(v.tournament.status === "running" && v.tournament.round === 1 && sizes === "2,2,3", "seven players in groups of at most three: 3, 2 and 2");
  ok(sqlite.prepare("SELECT COUNT(*) AS n FROM social_dtour_games WHERE tid = ?").get(tid).n === 10, "each group plays a double round robin (6 + 2 + 2 games)");
  const mine = v.games.filter((g) => g.mine);
  const myGroup = v.groups.find((g) => g.mine);
  ok(mine.length === 2 * (myGroup.rows.length - 1) && mine.some((g) => g.mine.color === "w") && mine.some((g) => g.mine.color === "b"), "you play everyone in your group with each colour");
  ok((await call("POST", `/dailytours/${tid}/join`, { secret: o.secret, body: { pid: pidOf(o) } })).status === 409, "no joining once it's started");
  // round 1: in each group, the player listed first in the group wins every game; other games go to White
  const settle = (round, champs) => {
    for (const g of sqlite.prepare("SELECT room, w_uid, w_pid, b_uid, b_pid FROM social_dtour_games WHERE tid = ? AND round = ?").all(tid, round)) {
      const winner = champs.includes(g.w_uid) ? g.w_pid : champs.includes(g.b_uid) ? g.b_pid : g.w_pid;
      rooms.set(g.room, { status: "over", seats: [g.w_pid, g.b_pid], result: { winner, reason: "checkmate" } });
    }
  };
  const seats1 = sqlite.prepare("SELECT uid, grp FROM social_dtour_seats WHERE tid = ? AND round = 1 ORDER BY grp, uid").all(tid);
  const champs1 = [...new Set(seats1.map((x) => x.grp))].map((g) => seats1.find((x) => x.grp === g).uid);
  settle(1, champs1);
  for (let k = 0; k < 3; k++) v = (await call("GET", `/dailytours/${tid}`, { secret: o.secret })).data;
  ok(v.tournament.round === 2 && v.groups.length === 1 && v.groups[0].rows.map((r) => r.uid).sort().join() === champs1.slice().sort().join(), "each group's winner goes through to a final group");
  ok(v.players.filter((p) => p.out === 1).length === 4, "everyone else is out after round 1");
  // the final: champs1[1] wins everything except one game nobody turns up for
  settle(2, [champs1[1]]);
  const skip = sqlite.prepare("SELECT room FROM social_dtour_games WHERE tid = ? AND round = 2 AND w_uid <> ? AND b_uid <> ? LIMIT 1").get(tid, champs1[1], champs1[1]);
  rooms.delete(skip.room);
  v = (await call("GET", `/dailytours/${tid}`, { secret: o.secret })).data;
  ok(v.tournament.status === "running", "a game nobody has started holds the round open");
  clock += 86_400_000 + 1000;
  v = (await call("GET", `/dailytours/${tid}`, { secret: o.secret })).data;
  ok(v.games.find((g) => g.room === skip.room).outcome === "double-forfeit", "until a move's time passes: then it's a double forfeit");
  ok(v.tournament.status === "done" && v.tournament.winner === champs1[1] && v.groups[0].rows[0].points === 4, "the final group's winner wins the tournament");
  // too few players by the time sign-ups close: cancelled
  const t2 = (await call("POST", "/dailytours", { secret: ps[1].secret, body: { name: "Quiet one", pid: pidOf(ps[1]) } })).data.id;
  await call("POST", `/dailytours/${t2}/join`, { secret: ps[2].secret, body: { pid: pidOf(ps[2]) } });
  await call("POST", `/dailytours/${t2}/leave`, { secret: ps[2].secret });
  ok((await call("GET", `/dailytours/${t2}`, { secret: ps[1].secret })).data.players.length === 1, "a player can leave before it starts");
  clock += 3 * 86_400_000;
  ok((await call("GET", `/dailytours/${t2}`, { secret: ps[1].secret })).data.tournament.status === "cancelled", "with fewer than 3 players when sign-ups close, it's cancelled");
  for (const u of ps) await call("POST", "/delete", { secret: u.secret });
  const watcher = (await call("POST", "/register", { body: { name: "DtWatch" }, ip: "10.3.3.9" })).data;
  ok(!(await call("GET", "/dailytours", { secret: watcher.secret })).data.tournaments.some((t) => t.id === tid), "a tournament whose players have all left the site isn't listed");
  await call("POST", "/delete", { secret: watcher.secret });
  clock = saved;
}

console.log(failures === 0 ? "\nALL SOCIAL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
