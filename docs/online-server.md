# Online play: the room server

Online games run in the Higgsfield project **Chess 3D** (`timely-ibis-513`): a Cloudflare Worker
whose rooms are Durable Objects at `/ws/<room>`. The project's `app/src/logic.js` is the referee;
it's built from `src/logic-src.js` into `dist/logic.js` by `npm run build`. The browser client
connects to `wss://timely-ibis-513.higgsfield.app/ws/<room>` (or its own origin when it's served
from the Higgsfield project) and only renders the state the server sends. Rooms persist in
Durable Object storage, which is what daily games rely on.

(The project was migrated from Higgsfield's older games engine at `timely-ibis-513.higgsfield.gg`,
which is being retired; its rooms are separate and aren't used any more.)

## Quick pairing (no server changes needed)

"Play online" sweeps numbered public rooms (`pool-<tc>-<2-minute bucket>-<n>`):
- It joins a room with one waiting player, which starts a game straight away.
- It skips rooms that are full, finished, or held by a player who has left. Abandoned seats are detected through the server's `connected` count.
- If none of those apply, it waits in the first empty room.

Names and ratings travel inside the player ID (`p-<random>.<name>.<rating>`), so opponents see
each other without any account system.

## Rules v2

`src/logic-src.js` now reports `view.v = 2` and adds:
- `chat`: messages up to 200 characters; players only, no spectators.
- `takeback-offer` / `takeback-accept` / `takeback-decline`.
- `abort`, allowed until both sides have moved.
- Custom time controls such as `"7+2"` or `"0.5+0"`, in addition to the presets.

Everything from v1 still behaves the same, so the current client works against either version.
The client turns chat, takebacks, abort and custom time controls on automatically when it sees
`view.v >= 2`. `npm test` covers the new actions (`tools/test-logic.mjs`).

Rules v3 (`view.v = 3`) adds daily time controls: `"1d"`, `"2d"`, `"3d"`, `"5d"`, `"7d"` or
`"14d"` give each side that long for every move. The clock uses the same fields as a live game
(`tc.perMove` is set), but a move resets the mover's allowance instead of adding an increment, and
`flag` claims the win once the opponent's deadline has passed. Clients send `"inf"` to servers
older than v3.

To update the rules: copy `dist/logic.js` to the project's `app/src/logic.js`, run
`bun run build` and `bun run test` in `app/`, then deploy. Because the project was migrated,
its logic check reports `Date.now()` (used by the clocks) as a warning rather than an error.

## Social API

`server/social.ts` runs in the same Worker at `/api/social/*` (copied to the project's
`app/src/social.ts`; `app/src/worker.ts` routes the prefix and answers CORS preflights). It needs
the project's D1 database (`"db": true` in `app/app.manifest.json`, `DB: D1Database` in
`app/src/env.ts`). Tables are created on first use with `CREATE TABLE IF NOT EXISTS`.

There's no sign-in. `POST /register` returns a random 64-hex secret (only its SHA-256 is stored)
and an 8-character friend code; the client keeps the secret in localStorage and sends it as
`Authorization: Bearer <secret>`. Routes:

- `POST /heartbeat`: presence (online / playing), name, avatar and self-reported ratings; returns unread and request counts plus the newest unread messages, which drive the nav badge and the challenge pop-ups.
- `GET /friends`, `POST /friends/request {code}`, `/friends/respond {id, accept}`, `/friends/remove {id}`.
- `GET /conversations`, `GET /messages?with=&after=` (marks them read), `POST /messages {to, text}` or `{to, kind: "challenge", room, tc, mode}`. Only friends can message each other.
- `GET /clubs`, `POST /clubs/create|join|leave`, `GET /clubs/:id`, `GET|POST /clubs/:id/messages`.
- `GET /leaderboard?cat=blitz|bullet|rapid|puzzle|bots`: players active in the last 30 days with at least 5 rated games (10 puzzles).
- `GET /users/:id`, `GET /me`, `POST /delete` (removes the player, friendships, messages and memberships).
- The heartbeat may carry `room` (the live game you're seated in); `GET /friends` returns it to your
  friends only, as `watch`, so they can spectate.

Columns added after the first release go in `MIGRATIONS` (each `ALTER TABLE` runs once per isolate,
and its "duplicate column" error is ignored after the first time).

Accounts: `POST /link/create` makes a one-time code (10 minutes) and `POST /link/claim {code}`
(no key needed) signs a new device in to that profile with its own key, stored in `social_keys`;
authentication accepts the profile's key or any linked device's key. `POST /devices/reset` signs
every other device out and gives this one a new key. `GET|POST /backup` keeps one cloud backup per
profile (the same JSON as the export file, minus the key; up to 1.8 MB), which a newly signed-in
device restores.

Names are unique ignoring case: registering a taken name adds a number, a rename to a taken name
doesn't go through, and `GET /names?n=` checks one. Forums: `GET|POST /forums`, `GET|POST
/forums/:id`, `POST /forums/:id/delete`, `POST /forums/:id/posts/:pid/delete`, and `POST /report
{kind, id}`; three reports from different players hide a topic or reply.

Web push: the Worker makes a VAPID key pair once and keeps it in D1 (`social_config`); `GET
/push/key` publishes the public half. `POST /push/subscribe {endpoint}` accepts only the browsers'
push services (FCM, Mozilla, Apple, Windows). New messages, challenges, friend requests and
`POST /nudge {code, room, san}` (sent after a move in a daily game) trigger an empty push signed
with an ES256 JWT, finished with `ctx.waitUntil`; gone endpoints (404/410) are dropped. The
service worker then reads `GET /notes` with the key the page cached for it and shows the newest item.

Limits: 20 registrations per IP per hour, 30 messages per minute, 40 friend requests per hour,
5 clubs per owner, 500-character messages. Each request batches its queries into one D1 round trip
after the key lookup. `npm run test:social` runs the API against SQLite through a D1-shaped shim.

### Live arenas

`/arenas` runs a fixed schedule: a Blitz Arena (3+0) on the hour and a Bullet Arena (1+0) on the
half hour, each 27 minutes long; rows are created as the schedule reaches them.

- `POST /arenas/:id/join`, then `POST /arenas/:id/pair {pid}` every couple of seconds. Pairing is
  one D1 batch (a transaction): you become `waiting`, and if another player has waited longer and
  asked within the last 8 seconds, both rows switch to `paired` with a fresh room id (`ar…`) and
  a game row records both player ids. The client then plays that room like a friend game.
- `POST /arenas/:id/result {room}`: the Worker reads the room's own state through the Durable
  Object's internal `/__state` path (not reachable from outside; public traffic only arrives as
  `/ws/<room>` upgrades), maps the winning player id to a user, and scores both players once
  (win 2, draw 1, 4 for a win after two wins in a row). Aborted games and no-shows (the room still
  waiting 45 seconds after pairing) don't count.
- `GET /arenas/:id` returns standings; `POST /arenas/:id/pause` stops pairing.

To update it: copy `server/social.ts` to `app/src/social.ts` (check the SHA-256 on both sides),
commit, push and deploy.
