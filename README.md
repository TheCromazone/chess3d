# Chess 3D

A complete chess platform in the browser, played on a rendered 3D board (or a classic 2D board,
if you prefer), covering what chess.com does: online play, friends and clubs, bots, puzzles,
lessons, Stockfish game review, and analysis. There's no sign-up: your device holds your key.

**▶ Play it live:** https://chess3d-five.vercel.app/

## Features

**Play**
- **Online:** quick pairing with a random opponent (bullet, blitz, rapid; rated or unrated, optionally within a rating range), or a private invite link for a friend. Moves, clocks, draw offers, resignation, rematch, and spectators are refereed by the room server.
- **Leagues:** weekly divisions from Wood to Legend; earn trophies in rated games against random opponents and in arenas, and the top of each division moves up every Sunday.
- **Daily chess:** correspondence games with friends, with 1, 3 or 7 days per move (or no limit), a daily rating, a "your move" list, conditional moves ("if they play this, I play that"), vacations, and private notes on each game.
- **Bots:** 16 personalities from 250 to 3200, backed by Stockfish 18, with hints, takebacks, resumable games, and a rating vs bots.
- **Pass and play:** two players on one screen, with optional auto-flip.
- **Variants:** Crazyhouse, Bughouse, 4-Player Chess (free-for-all and teams), Duck Chess, Fog of War, Giveaway, Atomic, Horde, Chess960, King of the Hill and Three-check. Each has bots, pass and play, friend invites and rated games against random opponents (Bughouse: a four-player lobby), with a rating and leaderboard per variant.
- **Tournaments:** live arenas every 30 minutes (blitz and bullet) with instant re-pairing, live standings and win-streak bonuses; Swiss tournaments every two hours; daily tournaments anyone can create (groups of daily games, group winners going through); or a Bot Arena against the bots nearest your rating.
- Clocks with increment and custom time controls, premoves, drag-and-drop or click-to-move, auto-queen, keyboard move entry, move-list navigation (← → keys), material count, and opening names.

**Improve**
- **Game Review:** every move classified (brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder), accuracy, an estimated game rating, an evaluation graph, key moments, coach explanations, and "retry" for your mistakes.
- **Analysis board:** move tree with variations, live multi-line Stockfish evaluation, eval bar, best-move arrows, opening explorer, PGN/FEN import and export, a board editor, and "play a bot from here".
- **Share:** a link that opens the game in analysis, an animated GIF, or a PNG of any position.
- **Puzzles:** 17,000+ rated puzzles (with your own puzzle rating, theme and difficulty filters), a daily puzzle with streaks, Puzzle Rush (3 min, 5 min, survival), Puzzle Battle against another player or a bot, and Solo Chess.
- **Learn:** interactive lessons, endgame drills against Stockfish, an opening trainer, the Vision coordinates trainer, and video lessons (whole series from chess teachers, played in the page).
- **Watch:** the best game being played right now in each speed (from Lichess TV), top tournaments live (games relayed by Lichess broadcasts), chess streamers live now, the latest videos and news, a weekly report of the site's own results (tournament winners, league promotions, best Puzzle Rush runs), 40 famous games replayed move by move, and Bot TV.

**Social**
- **Friends:** share your friend code or an invite link, accept requests, and see who's online or playing. Block a player to stop them adding, messaging or challenging you and to hide their posts and chat.
- **Challenges and messages:** challenge a friend to a live or daily game and they get a pop-up with Accept / Decline; message friends one to one.
- **Clubs:** public or invite-only clubs with their own chat and member list, team matches against other clubs (daily games, two per board), and Vote Chess, where a club's moves are chosen by its members' votes.
- **Forums and blogs:** topics and replies in five forums; players' blog posts with likes; both with reporting.
- **Coaches:** players who teach list themselves with a description, languages, topics and rate; students message them directly to ask about lessons.
- **Notifications:** pop-ups in the app, and optional browser notifications when it's closed (challenges, messages, friend requests, your move in daily games).
- **Profiles:** ratings, league, a country flag and a line about the player, and their recent games.
- **Leaderboards:** global top 50 for blitz, bullet, rapid, daily, puzzles, bots, Puzzle Rush and every variant, or just your friends. With a profile, the server rates every online game from the game room's own record, checks each puzzle attempt and times Puzzle Rush runs, so the boards hold real results.
- **Account, no password:** your profile key is the account. Sign in on your other devices with a one-time code or your recovery key; your profile, ratings, settings and games back up automatically and follow you. Sign out of a device, or of all the others, from Settings.
- Social is off until you turn it on; you can delete your profile from Settings at any time.

**You**
- Local profile with ratings per category and per variant, rating history, stats, Insights (accuracy by phase, colour and time control), a game archive (review or download any game as PGN), variant games to replay, and achievements. Export and import your data.
- Settings: eleven languages (English, Spanish, French, German, Italian, Polish, Portuguese, Turkish, Russian, Japanese, Chinese); dark or light appearance, 3D or 2D board, board and piece themes, top-down 3D camera, coordinates, animation speed, legal-move hints, sound.
- Installable as an app (PWA); bots, puzzles, analysis and review work offline.
- Right-click to draw arrows and circles (Shift, Alt, Ctrl change the color).

## Develop

    npm install
    npm run build    # bundle src/ to dist/ with esbuild
    npm run serve    # serve dist/ at http://localhost:8123/s/chess3d/
    npm test         # server-rules + move-tree tests
    node tools/test-data.mjs     # data integrity (openings, puzzles, classics, lessons)
    node tools/test-engine.mjs   # Stockfish wrapper, bots, review (slow)
    npm run test:social          # social API (server/social.ts) against SQLite

`src/logic-src.js` is the online referee. It's bundled with chess.js and the variant rules
(`src/core/zh.js`, `vx.js`, `fp.js`) into `dist/logic.js` for the room server, now at version 8:
v2 chat, takebacks, abort and custom clocks; v3 daily games; v4 Crazyhouse and Bughouse; v5 the
other 8x8 variants; v6 4-Player Chess in four-seat rooms; v7 letting whoever sets a room up take Black; v8 vacations,
conditional moves and aborting before the game is set up. See `docs/online-server.md`.

Languages: `src/i18n.js` translates the interface as it renders. `node tools/i18n-strings.mjs`
lists the interface's strings; each language in `i18n/<code>/` has batches of translations aligned
to the frozen `i18n/base-strings.json`, plus `extra.json` and `patterns.json` for text built at run
time. `node tools/test-i18n.mjs` checks them, and the build writes `dist/i18n/<code>.json`.
`node tools/test-vx.mjs`, `test-zh.mjs` and `test-fp.mjs` cover the variant rules and bots.

`server/social.ts` is the social API (friends, messages, clubs, leaderboard). It runs in the game
server's Worker at `/api/social/*` on a D1 database; see `docs/online-server.md`.

## Credits

- Engine: [Stockfish.js 18](https://github.com/nmrugg/stockfish.js) (GPLv3; the license ships at `stockfish/COPYING.txt`).
- Puzzles and opening names: the [lichess.org open database](https://database.lichess.org/) and [chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
- 2D piece sets: see `public/assets/pieces/LICENSES.md`.
- Rendering: [Three.js](https://threejs.org/); rules: [chess.js](https://github.com/jhlywa/chess.js).
