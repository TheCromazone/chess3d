# Chess 3D

A complete chess platform in the browser, played on a rendered 3D board (or a classic 2D board,
if you prefer), covering what chess.com does: online play, friends and clubs, bots, puzzles,
lessons, Stockfish game review, and analysis. There's no sign-up: your device holds your key.

**▶ Play it live:** https://chess3d-five.vercel.app/

## Features

**Play**
- **Online:** quick pairing with a random opponent (bullet, blitz, rapid), or a private invite link for a friend. Moves, clocks, draw offers, resignation, rematch, and spectators are refereed by the room server.
- **Daily chess:** correspondence games with friends, with 1, 3 or 7 days per move (or no limit) and a "your move" list.
- **Bots:** 16 personalities from 250 to 3200, backed by Stockfish 18, with hints, takebacks, resumable games, and a rating vs bots.
- **Pass and play:** two players on one screen, with optional auto-flip.
- **Variants:** Chess960, King of the Hill, and Three-check, against bots or a friend on one screen.
- **Arenas:** live tournaments against real players every 30 minutes (blitz and bullet), with instant re-pairing, live standings and win-streak bonuses; or a Bot Arena against the bots nearest your rating.
- Clocks with increment and custom time controls, premoves, drag-and-drop or click-to-move, auto-queen, keyboard move entry, move-list navigation (← → keys), material count, and opening names.

**Improve**
- **Game Review:** every move classified (brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder), accuracy, an estimated game rating, an evaluation graph, key moments, coach explanations, and "retry" for your mistakes.
- **Analysis board:** move tree with variations, live multi-line Stockfish evaluation, eval bar, best-move arrows, opening explorer, PGN/FEN import and export, a board editor, and "play a bot from here".
- **Share:** a link that opens the game in analysis, an animated GIF, or a PNG of any position.
- **Puzzles:** 17,000+ rated puzzles (with your own puzzle rating, theme and difficulty filters), a daily puzzle with streaks, Puzzle Rush (3 min, 5 min, survival), and Puzzle Battle against another player or a bot.
- **Learn:** interactive lessons, endgame drills against Stockfish, and an opening trainer.
- **Watch:** 40 famous games replayed move by move, plus Bot TV.

**Social**
- **Friends:** share your friend code or an invite link, accept requests, and see who's online or playing.
- **Challenges and messages:** challenge a friend to a live or daily game and they get a pop-up with Accept / Decline; message friends one to one.
- **Clubs:** public or invite-only clubs with their own chat and member list.
- **Leaderboards:** global top 50 for blitz, bullet, rapid, puzzles and bots (ratings are reported by each player's device).
- Social is off until you turn it on; you can delete your social profile from Settings at any time.

**You**
- Local profile with ratings per category, rating history, stats, Insights (accuracy by phase, colour and time control), a game archive (review or download any game as PGN), and achievements. Export and import your data.
- Settings: dark or light appearance, 3D or 2D board, board and piece themes, top-down 3D camera, coordinates, animation speed, legal-move hints, sound.
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

`src/logic-src.js` is the online referee. It's bundled with chess.js into `dist/logic.js` for the
room server. Version 2 of the rules adds chat, takeback requests, abort, and custom time controls;
the client turns those features on automatically once the server runs v2.

`server/social.ts` is the social API (friends, messages, clubs, leaderboard). It runs in the game
server's Worker at `/api/social/*` on a D1 database; see `docs/online-server.md`.

## Credits

- Engine: [Stockfish.js 18](https://github.com/nmrugg/stockfish.js) (GPLv3; the license ships at `stockfish/COPYING.txt`).
- Puzzles and opening names: the [lichess.org open database](https://database.lichess.org/) and [chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
- 2D piece sets: see `public/assets/pieces/LICENSES.md`.
- Rendering: [Three.js](https://threejs.org/); rules: [chess.js](https://github.com/jhlywa/chess.js).
