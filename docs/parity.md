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

Rules v2 (chat, takebacks, abort, custom time controls) is deployed to the room server. Loop 5 added
the social layer without sign-in: each device registers for a private key and a shareable friend
code, and the game server (Cloudflare Worker + D1) holds friends with online status, direct messages
and challenges, clubs with their own chat, and a global leaderboard of self-reported ratings.
Loop 6 added live arenas and Puzzle Battles against real players, daily games with a deadline per
move (rules v3) and "your move" notices, adding your opponent as a friend after a game, a friends
leaderboard, and club moderation.
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
| Daily / correspondence chess | ✅ | 1, 3 or 7 days per move (or no limit), lose on time when a deadline passes (rules v3); persistent rooms, "your move" list with time left, daily challenges to friends |
| Tournaments / arenas | ✅ | live arenas against real players every 30 minutes (blitz on the hour, bullet on the half hour): instant re-pairing, streak bonuses, live standings, results read by the server from the game room; Bot Arena for practice |

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
| Puzzle Battle | ✅ | against real players (matched by the server, same puzzles, live scores) or a bot |
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
| Spectate a live game | ✅ | Watch button on friends who are in a live game, or open any game link |

## Profile & social

| chess.com feature | Status | Notes |
|---|---|---|
| Profile with ratings per category | ✅ | bullet / blitz / rapid / bots / puzzles / rush, kept on the device |
| Game archive, replay, review, PGN download | ✅ | |
| Stats (W/L/D, rating trend, openings) | ✅ | |
| Insights (accuracy trend, by phase, by colour / time control, mistakes per game) | ✅ | from your archive and reviews |
| Achievements / streaks | ✅ | 24 achievements |
| Friends with online status | ✅ | friend codes and invite links, requests (accept / decline), online / playing / last seen, watch their live games; also "people you've played" with your record vs each |
| Player profiles | ✅ | any player's ratings and recent games (the last 30 online and bot games), each opening on the analysis board |
| Member search | ✅ | find players by name (or add them by friend code) and open their profile |
| Challenges | ✅ | challenge a friend to a live game (any time control) or a daily game; pop-up notice with Accept / Decline wherever they are in the app; challenge friends from the invite lobby |
| Direct messages | ✅ | threads with friends, unread counts on the nav, notices for new messages |
| Clubs | ✅ | create (public or invite-only), join by code or from the public list, club chat, member list with presence |
| Leaderboards | ✅ | global top 50 per category (blitz, bullet, rapid, puzzles, bots) with your rank; ratings are self-reported by devices and labelled so; bot ladder on the profile |
| Accounts | 🟡 | no sign-in by design: a device key instead of a password; move it with export / import; delete your social profile any time |
| Data portability | ✅ | export / import backup (includes the social key) |

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
