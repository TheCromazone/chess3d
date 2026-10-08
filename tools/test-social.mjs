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
const api = new Social(d1(new DatabaseSync(":memory:")), () => clock);
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
await call("POST", "/clubs/leave", { secret: b.secret, body: { id: c.id } });
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

console.log(failures === 0 ? "\nALL SOCIAL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
