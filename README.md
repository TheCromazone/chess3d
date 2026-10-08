# Chess 3D

A complete chess platform in the browser, played on a rendered 3D board (or a classic 2D board,
if you prefer). Everything chess.com does that doesn't need an account server: online play,
bots, puzzles, lessons, Stockfish game review, and analysis.

**▶ Play it live:** https://chess3d-five.vercel.app/

## Features

**Play**
- **Online:** quick pairing with a random opponent (bullet, blitz, rapid), or a private invite link for a friend. Moves, clocks, draw offers, resignation, rematch, and spectators are refereed by the room server.
- **Daily chess:** correspondence games with friends; no clock, come back whenever, with a "your move" list.
- **Bots:** 16 personalities from 250 to 3200, backed by Stockfish 18, with hints, takebacks, resumable games, and a rating vs bots.
- **Pass and play:** two players on one screen, with optional auto-flip.
- **Variants:** Chess960, King of the Hill, and Three-check, against bots or a friend on one screen.
- **Arena:** a timed tournament against the bots nearest your rating, with live standings and win-streak bonuses.
- Clocks with increment and custom time controls, premoves, drag-and-drop or click-to-move, auto-queen, keyboard move entry, move-list navigation (← → keys), material count, and opening names.

**Improve**
- **Game Review:** every move classified (brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder), accuracy, an estimated game rating, an evaluation graph, key moments, coach explanations, and "retry" for your mistakes.
- **Analysis board:** move tree with variations, live multi-line Stockfish evaluation, eval bar, best-move arrows, opening explorer, PGN/FEN import and export, a board editor, and "play a bot from here".
- **Share:** a link that opens the game in analysis, an animated GIF, or a PNG of any position.
- **Puzzles:** rated puzzles (with your own puzzle rating, theme and difficulty filters), a daily puzzle with streaks, Puzzle Rush (3 min, 5 min, survival), and Puzzle Battle against a bot.
- **Learn:** interactive lessons, endgame drills against Stockfish, and an opening trainer.
- **Watch:** famous historical games replayed move by move, plus Bot TV.

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

`src/logic-src.js` is the online referee. It's bundled with chess.js into `dist/logic.js` for the
room server. Version 2 of the rules adds chat, takeback requests, abort, and custom time controls;
the client turns those features on automatically once the server runs v2.

## Credits

- Engine: [Stockfish.js 18](https://github.com/nmrugg/stockfish.js) (GPLv3; the license ships at `stockfish/COPYING.txt`).
- Puzzles and opening names: the [lichess.org open database](https://database.lichess.org/) and [chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
- 2D piece sets: see `public/assets/pieces/LICENSES.md`.
- Rendering: [Three.js](https://threejs.org/); rules: [chess.js](https://github.com/jhlywa/chess.js).
