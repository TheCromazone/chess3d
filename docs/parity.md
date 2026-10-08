# Gauntlet scoreboard: Chess 3D vs chess.com

Each loop: pick the highest-value gaps, build them, verify in a real browser, update this table.

Loop 1 built the platform (shell, engine, bots, review, analysis, puzzles, learn, watch, online pairing,
2D/3D boards). Loop 2 added Chess960 / KOTH / Three-check, the opening explorer, Bot Arena, Puzzle
Battle, Insights, sharing (link, GIF, PNG), light mode, a PWA, and an independent bug hunt (22 fixes).
Loop 3 added onboarding, move times, background-tab alerts, and daily (correspondence) chess on
persistent rooms. Loop 4 went deep rather than wide: 17k puzzles, 40 classic games and 23 lessons; keyboard play and
spoken moves for screen-reader users; and a flow-by-flow UX review at phone and desktop sizes whose
findings were all fixed (sticky actions on phones, review badges on the board, tolerant PGN import,
live settings preview, contrast, tap targets).

Rules v2 (chat, takebacks, abort, custom time controls) is deployed to the room server. What remains
needs an accounts backend: friend requests and presence, clubs, direct messages, and a global
leaderboard (the user chose to stay account-free).
Status: ✅ shipped · 🟡 partial · ❌ missing · ⛔ needs a backend we don't have (alternative noted)

## Play

| chess.com feature | Status | Notes |
|---|---|---|
| Play online vs random opponent (matchmaking) | ✅ | quick pairing through rotating public pool rooms; ghost seats skipped; verified with two live clients |
| Play a friend (invite link) | ✅ | time control chosen up front, share sheet on mobile |
| Time controls: bullet/blitz/rapid presets + custom | ✅ | 9 presets + custom for bots, friends and pass and play; quick pairing uses the 5 pool presets |
| Bots with names, ratings, personalities | ✅ | 16 original personalities, 250 → 3200, chat lines, Stockfish 18 |
| Pass and play | ✅ | names, clocks, auto-flip |
| Draw offer / resign / abort | ✅ | abort before both sides move |
| Takebacks | ✅ | vs bots, and online takeback requests (rules v2) |
| Hints vs bots | ✅ | |
| Coach feedback while playing | ✅ | live move verdicts + eval bar in bot games |
| Premoves | ✅ | |
| Drag-and-drop moves | ✅ | 2D and 3D |
| Auto-queen | ✅ | setting |
| Move list with navigation (←/→, click a move) | ✅ | |
| Keyboard move entry | ✅ | type `Nf3` / `g1f3` |
| Rematch | ✅ | both sides reset in place |
| Clocks with low-time warning | ✅ | |
| Material count / captured pieces | ✅ | |
| Opening name during game | ✅ | 3,865 named positions (lichess chess-openings, CC0) |
| Resume an unfinished bot game | ✅ | |
| "Your move" alert in a background tab | ✅ | online games |
| New-player onboarding (skill level seeds ratings) | ✅ | |
| In-game chat (online) | ✅ | rules v2 live on the room server; quick phrases + free text |
| Variants (Chess960, 3-check, KOTH) | ✅ | vs bots and pass and play; Chess960 castling verified against Stockfish perft |
| Daily / correspondence chess | ✅ | untimed friend games on persistent rooms; your seats are remembered on this device, "your move" list (no per-move deadline until rules v2) |
| Tournaments / arenas | ✅ | Bot Arena: timed arena vs the bots near your rating, live standings, streak bonuses (human arenas would need a server) |

## Analysis

| chess.com feature | Status | Notes |
|---|---|---|
| Game Review (classifications, accuracy, key moments, coach) | ✅ | brilliant → blunder, miss, book, forced; accuracy; game rating; graph |
| Time spent per move | ✅ | recorded in every game, shown in review |
| Retry mistakes from review | ✅ | |
| Evaluation bar | ✅ | |
| Engine lines (multi-PV) | ✅ | 1–3 lines, depth 22 |
| Analysis board (free moves, variations) | ✅ | full move tree with variations |
| Best-move arrows, user arrows and highlights | ✅ | right-click drawing on both boards |
| PGN import / export, FEN load / copy | ✅ | |
| Share a game (link, GIF, image) | ✅ | link carries the PGN; animated GIF and PNG export |
| Board editor / setup position | ✅ | |
| Opening explorer | ✅ | move statistics from ~1M lichess games (both players 1800+, CC0), first 12 moves; named book moves beyond that |
| Play vs computer from a position | ✅ | |

## Puzzles

| chess.com feature | Status | Notes |
|---|---|---|
| Rated puzzles | ✅ | 17,452 puzzles (lichess, CC0), puzzle rating + streak |
| Puzzle Rush (3 min / 5 min / survival) | ✅ | |
| Daily puzzle | ✅ | with day streak |
| Puzzles by theme | ✅ | 73 themes |
| Hints / show solution | ✅ | |
| Puzzle Battle | ✅ | race a bot through the same puzzles (human battles would need a server) |
| Puzzle difficulty | ✅ | easiest → hardest |

## Learn

| chess.com feature | Status | Notes |
|---|---|---|
| Lessons (rules, tactics, strategy) | ✅ | 23 interactive lessons |
| Endgame practice vs engine | ✅ | 15 drills |
| Opening trainer | ✅ | 32 openings |

## Watch

| chess.com feature | Status | Notes |
|---|---|---|
| Watch games | ✅ | 40 classic games replayed + Bot TV (live bot vs bot) |
| Spectate a live game | ✅ | open a friend's game link |

## Profile & social

| chess.com feature | Status | Notes |
|---|---|---|
| Profile with ratings per category | ✅ | bullet / blitz / rapid / bots / puzzles / rush (local, no accounts) |
| Game archive, replay, review, PGN download | ✅ | |
| Stats (W/L/D, rating trend, openings) | ✅ | |
| Insights (accuracy trend, by phase, by colour / time control, mistakes per game) | ✅ | from your archive and reviews |
| Achievements / streaks | ✅ | 21 achievements |
| Friends | 🟡 | people you've played online or by daily game, your record vs each, one-click live/daily challenge; no presence or friend requests (needs accounts) |
| Leaderboards | 🟡 | bot ladder (your rank among the bots); a global leaderboard needs an accounts backend |
| Clubs, messages | ⛔ | need an accounts backend |
| Data portability | ✅ | export / import backup |

## Settings & polish

| chess.com feature | Status | Notes |
|---|---|---|
| Board themes / piece sets | ✅ | 3D themes + 2D themes and 5 SVG sets |
| 2D board option | ✅ | |
| Coordinates, legal moves, last-move highlight | ✅ | toggles |
| Animation speed | ✅ | |
| Sounds on/off | ✅ | |
| Light / dark site theme | ✅ | dark, light, or match device |
| Keyboard shortcuts sheet | ✅ | press ? |
| Mobile app | ✅ | installable PWA, works offline for bots / puzzles / analysis |
| Accessibility | ✅ | labelled controls, focus rings, reduced motion, keyboard play on the 2D board, spoken moves for screen readers |
