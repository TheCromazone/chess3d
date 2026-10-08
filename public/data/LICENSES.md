# Data files: provenance and licenses

## openings.json

- **Source:** [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (`a.tsv` to `e.tsv`, columns `eco`, `name`, `pgn`).
- **License:** CC0 1.0 Universal (public domain dedication).
- **Built by:** `node tools/build-openings.mjs`. The script replays every line with chess.js and maps the first four FEN fields of the final position to `[eco, name]`. When two lines reach the same position, the one with fewer moves wins.
- **Last built:** 2026-10-08. 3,865 named positions.

## puzzles/ (puzzle set)

- **Content:** `puzzles/index.json` (theme list, per-theme counts and the shard list) and six shards `puzzles/r<from>-<to>.<hash>.json`, one per rating band (400-799, 800-1199, 1200-1599, 1600-1999, 2000-2399, 2400-2999), about 2,900 puzzles each. The hash in each shard name is a content hash, so an index always points at the shards it was built with. The app loads the index and then all six shards in parallel (about 2.0 MB raw, 0.8 MB gzipped).
- **Source:** the [Lichess puzzle database](https://database.lichess.org/#puzzles) (`lichess_db_puzzle.csv.zst`, 307,234,795 bytes, ETag `"6abf70a1-125007eb"`, last modified 2 October 2026).
- **Bytes used:** only the first 100,000,001 bytes, fetched with `Range: bytes=0-100000000` (SHA-256 `1292e0a1057944834a357167f9d34c516d58cafb099f2bc751a5f25c7f6d9f02`). The CSV is in puzzle-id order (effectively random), so this is a fair sample of about 2.0 million puzzles. zstd stops with an error at the cut; the script keeps the output up to that point and drops the trailing partial line.
- **License:** CC0 1.0 Universal (public domain dedication).
- **Built by:** `node tools/build-puzzles.mjs`. The script:
  - keeps puzzles with Popularity >= 85, NbPlays >= 300 and RatingDeviation <= 90 (899,943 of 2,002,819);
  - takes up to 720 puzzles from each 100-point rating bucket between 400 and 2999, picked greedily for theme diversity, with extra weight on rarer motifs (zugzwang, underpromotion, castling, en passant, interference, intermezzo, clearance, named mates and so on). The 2800s and 2900s are naturally sparse and keep everything that passes the filter (156 and 16 puzzles);
  - replays every kept puzzle with chess.js (all moves legal, mate themes end in mate).
- **Last built:** 2026-10-08. 17,452 puzzles, 73 themes. The same input bytes give byte-identical files. `tools/test-data.mjs` checks the output.
- **Attribution:** not required. Each puzzle id is a Lichess puzzle id, so `https://lichess.org/training/<id>` opens the original.

## classics.json

- **Content:** the move scores of 40 famous historical games, from Anderssen-Kieseritzky (1851) to Ding-Gukesh (2024). A game score is a factual record and is not subject to copyright.
- **Verification:** every score was replayed with chess.js. The 16 original games were checked move by move against Wikipedia articles and chessgames.com PGNs. The 24 games added on 2026-10-08 were taken move for move from chessgames.com PGNs (`https://www.chessgames.com/perl/chessgame?gid=<gid>`), with their result and round checked against the PGN headers; seven of them were also matched ply for ply against a full score on Wikipedia (Steinitz-Chigorin 1892 game 4, Botvinnik-Tal 1960 game 6, Petrosian-Spassky 1966 game 10, Deep Blue-Kasparov 1996 game 1, Sargissian-Hou 2008, Nepomniachtchi-Ding 2023 tiebreak game 4, Ding-Gukesh 2024 game 14). `tools/test-data.mjs` re-checks legality and that each result matches the final position.
- **chessgames.com gids of the added games:** `paulsen-morphy-1857` 1242884, `zukertort-blackburne-1883` 1001854, `steinitz-chigorin-1892-g4` 1036342, `capablanca-marshall-1918` 1095025, `bogoljubov-alekhine-1922` 1012099, `capablanca-tartakower-1924` 1102104, `reti-alekhine-1925` 1012326, `botvinnik-capablanca-1938` 1031957, `spassky-bronstein-1960` 1034110, `botvinnik-tal-1960-g6` 1032537, `byrne-fischer-1963` 1008419, `tal-larsen-1965-g10` 1139729, `petrosian-spassky-1966-g10` 1106725, `karpov-unzicker-1974` 1067846, `karpov-kasparov-1985-g24` 1067179, `deep-blue-kasparov-1996-g1` 1070874, `kramnik-kasparov-2000-g10` 1252049, `carlsen-ernst-2004` 1272702, `polgar-anand-1999` 1009882, `shirov-polgar-1994` 1111195, `sargissian-hou-2008` 1482388, `aronian-anand-2013` 1704763, `nepomniachtchi-ding-2023-tiebreak` 2488997, `ding-gukesh-2024-g14` 2811859.
- **Text:** the `blurb` texts are original writing for this project.

## Original content (not in this folder)

The following were written for this project and carry no third-party license:

- `src/learn-data.js` (endgame drills and lessons). The drill positions are standard textbook positions such as Lucena, Philidor and Vancura. Lesson positions are composed for teaching, except a few short excerpts from well-known games and traps (Reti-Tartakower 1910, Legal's mate, the fool's and scholar's mates); every lesson move goal was also checked with Stockfish.
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
