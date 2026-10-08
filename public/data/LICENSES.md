# Data files: provenance and licenses

## openings.json

- **Source:** [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (`a.tsv` to `e.tsv`, columns `eco`, `name`, `pgn`).
- **License:** CC0 1.0 Universal (public domain dedication).
- **Built by:** `node tools/build-openings.mjs`. The script replays every line with chess.js and maps the first four FEN fields of the final position to `[eco, name]`. When two lines reach the same position, the one with fewer moves wins.
- **Last built:** 2026-10-08. 3,865 named positions.

## puzzles.json

- **Source:** the [Lichess puzzle database](https://database.lichess.org/#puzzles) (`lichess_db_puzzle.csv.zst`).
- **License:** CC0 1.0 Universal (public domain dedication).
- **Built by:** `node tools/build-puzzles.mjs`. The script downloads only the first ~25 MB of the compressed file, which holds about 500k puzzles in puzzle-id order (effectively random). It then:
  - keeps puzzles with Popularity >= 85, NbPlays >= 300 and RatingDeviation <= 90;
  - takes up to 200 puzzles from each 100-point rating bucket between 400 and 2999, picked for theme diversity;
  - replays every kept puzzle with chess.js.
- **Last built:** 2026-10-08. 4,847 puzzles.
- **Attribution:** not required. Each puzzle id is a Lichess puzzle id, so `https://lichess.org/training/<id>` opens the original.

## classics.json

- **Content:** the move scores of 16 famous historical games. A game score is a factual record and is not subject to copyright.
- **Verification:** each score was checked move by move against a public reference (Wikipedia articles and chessgames.com PGNs) and replayed with chess.js. `tools/test-data.mjs` re-checks legality and that each result matches the final position.
- **Text:** the `blurb` texts are original writing for this project.

## Original content (not in this folder)

The following were written for this project and carry no third-party license:

- `src/learn-data.js` (endgame drills and lessons). The drill positions are standard textbook positions such as Lucena, Philidor and Vancura.
- `POPULAR_OPENINGS` in `src/openings.js` (trainer lines). Their names match the CC0 opening book above.
- `THEME_INFO` in `src/puzzles.js`. The theme ids are Lichess's; the names and descriptions are our own wording.

## Explorer (explorer/)

- **Content:** opening explorer statistics. For each common position in the first 12 moves, the moves played from it, each with the number of White wins, draws and Black wins and the average rating of the players. Files: `explorer/index.json` (metadata and the 1,150 most played positions) and `explorer/00.json` to `explorer/15.json` (the other positions, split by a hash of the position key).
- **Source:** the [Lichess open database](https://database.lichess.org/), standard rated games of September 2026: `https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst` (29,224,520,887 bytes, ETag `"6ac08d73-6cdeaccb7"`).
- **Bytes used:** only the first 2,000,000,000 bytes, fetched with `Range: bytes=0-1999999999` (SHA-256 `9673b661a6273668e1ce741596a9e7da58bb47c3f9dd7b1a2d2845aab15eed61`). The file is in time order, so this covers roughly the first five days of the month. zstd stops with an error at the cut. The script keeps the output up to that point and drops the trailing partial game.
- **License:** CC0 1.0 Universal (public domain dedication).
- **Built by:** `node tools/build-explorer.mjs`. The script:
  - keeps rated Blitz, Rapid and Classical games (arena and swiss included) where both players are rated 1800 or higher and the game ended normally, on time or by insufficient material: 995,839 of the 6,118,394 games in the range;
  - replays the first 24 plies of each game with chess.js and keys positions by the first four FEN fields, so transpositions merge. A game counts once per position;
  - keeps positions reached by at least 40 games and, inside them, moves played at least 5 times. Position totals still count every game;
  - checks every stored move with chess.js.
- **Last built:** 2026-10-08. 28,669 positions and 109,858 moves, 4.4 MB on disk (about 1.2 MB gzipped). The build takes about 2 minutes plus the download, and the same input bytes give byte-identical files. `tools/test-explorer.mjs` checks the output.
- **Attribution:** not required. The files hold only aggregate counts: no game ids, player names or individual games.
