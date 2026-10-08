# Engine layer: Stockfish, bots, Game Review

Three ES modules, all browser-safe (no Node imports), bundled by esbuild:

| Module | What it does |
|---|---|
| `src/engine.js` | Async UCI client for Stockfish 18 lite (single-threaded WASM, GPLv3) in a Web Worker, plus score helpers and static-exchange helpers |
| `src/bots.js` | 16 bot personalities (250 → 3200), `botMove`, `botThinkDelay`, chat lines |
| `src/review.js` | `reviewGame` (chess.com-style classifications, accuracy, key moments, coach text) |

The build copies the engine to `dist/stockfish/stockfish-18-lite-single.{js,wasm}`; the
default transport loads `./stockfish/stockfish-18-lite-single.js` relative to the page.
Tests: `node tools/test-engine.mjs` (about 30 s; `--quick` skips bot matches, `--ladder`
plays an adjacent-rating calibration ladder).

## engine.js

```js
import { Engine, winPercent, formatScore, evalBarFraction } from "./engine.js";

const engine = new Engine();          // options: { createTransport, hash = 16 (MB), initTimeoutMs = 30000 }
await engine.init();                  // optional: every method calls it lazily; idempotent
const r = await engine.analyze(fen, { depth: 18, multipv: 3 }, (partial) => drawLines(partial));
```

`analyze(fen, opts, onInfo)` resolves to a `Result`:

```js
{
  fen, bestmove: "e2e4" | null, ponder, depth, aborted: bool, nodes, nps, time,
  terminal?: "checkmate" | "stalemate",              // set when the position has no legal moves
  lines: [{ multipv, depth, seldepth, cp, mate,      // cp/mate: side to move (raw UCI); the other is null
            pv: ["e2e4", ...], san: ["e4", ...],     // san stops at the first illegal move
            scoreWhite: { cp } | { mate } }]         // White's point of view; mate > 0 = White mates
}
```

The `opts` object accepts these fields:
- `depth`, `movetime` (ms), `nodes`: the search stops at whichever limit comes first. With none of them, the search is infinite and runs until `stop()` or the next call.
- `multipv` (default 1).
- `searchMoves`: UCI or SAN moves; restricts the search to those root moves.
- `elo`: play at limited strength (`UCI_LimitStrength` + `UCI_Elo`, clamped to the engine's 1320 to 3190 range). Omit it for full strength. Strength is set per call, so one engine can serve a bot and hints.
- `history: { startFen?, moves }`: the game so far, in SAN or UCI. If it leads to `fen`, it is sent as `position … moves …`, so Stockfish can see repetitions. Otherwise it is ignored.
- `onInfo(partialResult)`: called while searching, at most about 10 times per second, with `partial: true`.

Other methods:
- `setOption(name, value)`: values are cached, so unchanged values are not resent.
- `newGame()`: sends `ucinewgame`.
- `stop()`: resolves once the engine is idle.
- `terminate()`.
- Properties: `ready`, `busy`, `error`, `name`, `optionInfo` (for example `optionInfo.UCI_Elo.min`), and an `onCrash` hook.

Score helpers take `scoreWhite`. A finished game is represented as `{ mate: 0, winner: "w" | "b" }`.
- `winPercent(score, forColor = "w")` uses the lichess formula `50 + 50·(2/(1+e^(-0.00368208·cp)) − 1)`, with cp clamped to ±1000. A mate for `forColor` gives 100; a mate against gives 0.
- `formatScore(score)` returns strings such as `"+1.34"`, `"-0.50"`, `"0.00"`, `"M3"`, `"-M2"`, `"1-0"` and `"0-1"`.
- `evalBarFraction(score)` returns White's share of the bar: `1/(1+e^(-0.004·cp))`, kept within [0.02, 0.98]. Only a mate gives exactly 1 or 0.

Lower-level exports, used by bots.js and review.js:
- `createWorkerTransport(url)`, `STOCKFISH_WORKER_URL`, `START_FEN`
- `uciLineToSan`, `applyMove`, `moveToUci`
- `materialFromFen`, `boardArray`, `attackersOf`
- `seeCapture`, `seeMove`, `bestCaptureGain`, `enPriseLoss`
- `PIECE_VALUE`, `PIECE_NAME`

### Concurrency and errors

- **One Engine instance runs one Stockfish worker, with 16 MB of hash.** Two instances run in parallel without interfering, which is fine on phones.
- **Calls are serialized, and the latest request wins.** A new `analyze`, `setOption`, `newGame` or `stop` call interrupts the running search. The interrupted search's promise *resolves* with whatever it had, marked `aborted: true`. Analyses that were queued but never started resolve as `{ aborted: true, lines: [] }`. A new `go` is never sent before the previous `bestmove` arrives, and every bestmove is matched to its `go`, so the stale bestmove from a stopped search is ignored.
- **Invalid positions are rejected before reaching Stockfish**, which can crash on them. This covers a bad FEN, a missing king, a pawn on the back rank, and the side not to move being in check.
- **Failures reject promptly with `err.code === "ENGINE_UNAVAILABLE"`.** Show "Engine unavailable" in that case. The failure cases are:
  - The worker script is missing: fails in milliseconds.
  - The `.wasm` is missing: a HEAD probe fails it after about 2.5 s.
  - No `uciok` arrives within `initTimeoutMs`.
  - The worker crashes or stops answering `stop`.
- **Crash recovery:** after a crash *after* a successful start, the next call restarts a fresh worker (up to 2 times). A failure to load is sticky.
- **Terminate:** after `terminate()`, calls reject with `ENGINE_TERMINATED`.
- **Hidden tabs are throttled.** Browsers throttle timers in background tabs, including inside the worker, because this Stockfish build yields with `setTimeout`. Searches and reviews slow down a lot, or pause, while the tab is hidden, and resume when it is visible again. The watchdogs know this and won't declare a throttled engine dead.

## bots.js

```js
import { BOTS, getBot, botMove, botThinkDelay, botChat } from "./bots.js";
const mv = await botMove(engine, fen, bot, { history: sanMovesSoFar /*, startFen, movetime, random */ });
// -> { from, to, promotion, san, uci, thinkMs, delayMs, reason }
setTimeout(() => applyMove(mv), mv.delayMs);
```

`BOTS[i]` has the following fields:
- `id`, `name`, `elo`, `category` (one of "Beginner", "Intermediate", "Advanced", "Master", "Engine")
- `avatar: { emoji, bg }`, an optional `country` (flag emoji), and an optional `speed` (think-time multiplier)
- `style`: a one-line personality
- `bio`
- `openings`: SAN lines the bot likes to follow
- `chat`: `{ greet, win, lose, draw, blunder, goodMove, oops }`
  - `win`, `lose` and `draw` are written from the bot's side.
  - `blunder` and `goodMove` react to the opponent's move.
  - `oops` is for the bot's own error. A `botMove` reason of `"random"` or `"hang"` is a good trigger.

`botChat(bot, event)` returns a random line for that event.

The roster:

| Rating | Bots |
|---|---|
| 250 to 700 | Pebble, Biscuit, Nonna Rosa, Dex |
| 850 to 1300 | Professor Quill, Marisol, Tank, Yuki |
| 1500 to 1800 | Captain Brine, Inês, Viktor |
| 2000 to 2450 | Kestrel, Lady Morgane, Coach Tunde |
| 2700, 3200 | Nova, Apex |

**Strength model.**
- **Rating ≥ 1400:** Stockfish with `UCI_Elo` (3190 and above plays at full strength). The movetime is `engineMovetime(elo)` = 150 ms at 1400, rising to 800 ms at 3200.
- **Rating < 1400 (human emulation):** a shallow MultiPV search (depth 4 to 7, 10 to 6 candidates), then a softmax sample with a temperature of about 380 cp at 250 and about 50 cp at 1300. On top of that come:
  - random moves: 30% of moves at 250, about 0% at 1300
  - deliberately hanging material: 18% at 250, 3% at 1300
  - grabbing loose material and instinctive recaptures
  - always taking a mate in one from 800 up

  The tunables are in `humanParams(elo)`.
- **Opening book:** bots follow their `openings` lines while `history` (which must actually lead to `fen`) is a prefix of a line.
- **Forced moves:** a position with a single legal move returns immediately, without a search.

**Timing.** `thinkMs` is the compute time already spent. `delayMs` is the extra "human" wait still recommended: `botThinkDelay` minus `thinkMs`, never below 0.
- `botThinkDelay(bot, fen, moveNumber)` is bounded to 300 to 2500 ms.
- It is shorter in the opening, for book moves and for forced moves, and for engine bots.
- It is longer in positions with many moves, many captures, or check.

**Errors.** If the engine is preempted before it found any move, `botMove` rejects with `code: "ABORTED"`. It rejects with `ENGINE_UNAVAILABLE` if Stockfish can't run. In that case you could fall back to the legacy `ai-worker.js`.

## review.js

```js
import { reviewGame, coachText } from "./review.js";
const review = await reviewGame(engine, { startFen, moves /* SAN or UCI */, result /* optional */ },
  { movetime: 350, depth: 14, isBook: (fen) => false, onProgress: (done, total, partial) => {},
    ratings: { w, b } /* optional */, signal /* AbortSignal */ });
coachText(plyIndex, review); // "Qb8+ is brilliant! It sacrifices the queen to force mate in 2."
```

`reviewGame` analyzes every position, before each move and the final one, with MultiPV 2. It then re-searches up to 10 "unstable" positions deeper, at depth + 6 with 4× the movetime. A position is unstable when the engine's own best move appeared to lose ≥ 10 win%. This typically means a mate or sacrifice that Stockfish lite pruned at depth 14.

**Speed.** In Node a 40-move game takes about 9 s at the defaults; a desktop browser is similar.

**Errors.** `reviewGame` rejects with:
- `code: "ABORTED"` if the signal fires, or if someone else uses the same engine during the review. Give the review its own Engine.
- `code: "BAD_GAME"` if the move list contains an illegal move.

The `Review` object:
- `plies[]`, one entry per move:
  - identity: `ply`, `moveNumber`, `color`, `san`, `uci`, `fenBefore`, `fenAfter`
  - evals: `evalBefore`, `evalAfter` (`scoreWhite`)
  - best line: `bestUci`, `bestSan`, `bestLineSan`, `replyLineSan`, `secondUci`
  - scores: `winBefore`, `winAfter` (mover's win%), `accuracy`, `classification`, `depth`
  - `tags`: the reasons the coach can cite (`checkmate`, `forcesMate`, `allowsMate`, `missedMate`, `sacrifice`, `loses` + `hangs`, `wins`, `missedWin`, `onlyMove`, `turnaround`)
- `accuracy: { w, b }`
- `counts: { w: {brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder, forced}, b }`
- `evalGraph`: White win% for the start position and after every ply
- `keyMoments`: up to 6 ply indexes
- `estimatedElo: { w, b }`
- `result`, `startFen`, `settings`, `durationMs`

**Classification.** EP is the mover's expected points (win% / 100), and loss = EP(best) − EP(played). The rules are checked in this order (`classifyMove` is pure and unit-tested):

| Classification | Rule |
|---|---|
| forced | only one legal move |
| book | `isBook(fenAfter)` and ply < 30 |
| blunder (mate) | the move allows a mate in ≤ 5 that wasn't already coming |
| brilliant | near-best (loss < 0.02 or the engine's move) **and** a sacrifice of ≥ 200 cp **and** EP after ≥ 0.5 **and** (EP before < 0.95, or the sacrifice is the only way to force mate) |
| great | near-best **and** not the 2nd-best line, not a recapture, and not a capture that wins ≥ 200 cp outright **and** either:<br>• the only good move: the 2nd line is ≥ 0.10 EP worse and EP before < 0.9, or<br>• a turnaround: the mover had EP < 0.35 before the opponent's last move and now has ≥ 0.5 |
| best | the engine's move, or the loss rounds to 0.00 |
| excellent | loss < 0.02 |
| good | loss < 0.05 |
| miss | loss ≥ 0.10, after the opponent's last move raised the mover's best EP by ≥ 0.15, without dropping below the pre-blunder EP − 0.05 |
| inaccuracy | loss < 0.10 |
| mistake | loss < 0.20 |
| blunder | loss ≥ 0.20 |

**Sacrifice.** A move counts as a sacrifice when either:
- the moved piece is left en prise: SEE of the opponent's best capture of it, minus what the move captured, is ≥ 200; or
- the opponent's best line wins ≥ 200 cp net, and that material is still gone 2 and 4 plies later.

Material the opponent was already threatening before the move doesn't count (null-move test). Captures that simply win material (SEE ≥ 100) are never brilliant.

**Accuracy** follows the lichess method:
- Per move: `103.1668·e^(−0.04354·(winBefore − winAfter)) − 3.1669`, clamped to 0..100. It is 100 if the mover's win% didn't drop.
- Per game: the mean of (a) the per-move accuracies weighted by the standard deviation of win% over a sliding window (clamped 0.5..12, window size n/10 clamped 2..8) and (b) their harmonic mean.

**Estimated Elo (game rating).** This is not chess.com's formula.
1. `accuracyToElo` interpolates these anchors: 50% → 600, 60 → 900, 70 → 1250, 80 → 1650, 85 → 1900, 90 → 2250, 95 → 2700, 100 → 3100.
2. Combine: `est = 0.7·accuracyToElo(own) + 0.3·opponentStrength + 200·(score − 0.5)`.
   - `opponentStrength` is `ratings[opp]` if you pass it, otherwise `accuracyToElo` of the opponent's accuracy.
   - `score` is 1, 0.5 or 0 when the result is known; otherwise the term is dropped.
3. Shrink toward 1200 for short games: `1200 + (est − 1200)·min(1, ownMoves/15)`.
4. Round to 50 and clamp to 100..3200.

**Coach text** uses the tags. Material claims ("hangs a knight", "winning the exchange") are only made when the line doesn't end in mate and the eval swing is at least half the claimed material.

## Integration checklist

- **Engines.** Create one engine for bot play and a separate one for analysis (eval bar, hints, lines), if memory allows. Give Game Review its own engine, or reuse the analysis engine while nothing else is using it. A single shared engine also works, because strength is set per call, but hint requests then interrupt the bot's search.
- **Game start:**
  1. Call `engine.newGame()`.
  2. Show `botChat(bot, "greet")`.
  3. Pass the SAN `history` to every `botMove`, so the bot sees its book, recaptures and repetitions.
- **Bot moves.** Before applying a `botMove` result, check that the game and position are still the ones you asked about (takebacks, new game). Then wait `delayMs`.
- **Eval bar.** Call `analyze(fen, { depth: 18 or more, multipv: 1–3 }, onInfo)` on every position change. Earlier searches abort on their own; ignore results with `aborted: true` or `fen !== currentFen`. Feed `lines[0].scoreWhite` to `evalBarFraction` and `formatScore`.
- **Hints.** Use `analyze(fen, { movetime: 1000 })`, then `bestmove`.
- **Errors.** Catch `ENGINE_UNAVAILABLE` and show "Engine unavailable".
- **Licensing.** Stockfish is GPLv3, and its COPYING.txt ships in `dist/stockfish/`.
