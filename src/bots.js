// Bot roster (250 -> 3200) and the move picker that gives each bot its strength.
//
// Strength model
//   elo >= 1400  Stockfish with UCI_LimitStrength/UCI_Elo (clamped to the engine's
//                1320..3190 range); >= 3190 plays at full strength. Modest movetime.
//   elo <  1400  "Human emulation": a shallow MultiPV search gives candidate moves, then
//                we sample among them with an elo-dependent temperature, and mix in
//                beginner habits: random moves, hanging pieces, grabbing loose material,
//                instinctive recaptures, and (above ~800) always taking a mate in one.
// Bots with `openings` follow a matching SAN line while the game is still on it.
import { createChess } from "./core/chess960.js";
import {
  START_FEN, moveToUci, applyMove, boardArray, seeMove, bestCaptureGain, PIECE_VALUE,
} from "./engine.js";

// Chat keys: greet (game start), win / lose / draw (game over, from the bot's side),
// blunder (the opponent just blundered), goodMove (the opponent played a great or
// brilliant move), oops (the bot itself just blundered; see botMove().reason).
export const BOTS = [
  {
    id: "pebble", name: "Pebble", elo: 250, category: "Beginner",
    avatar: { emoji: "🪨", bg: "#9aa5b1" },
    style: "Moves pieces mostly at random. Mostly.",
    bio: "Pebble learned chess yesterday from a very patient garden gnome. Knows the horsey moves funny, but not which funny.",
    chat: {
      greet: ["Hi! Which one is the horsey?", "I'm gonna win! Probably!", "Do the castles move? I hope they move."],
      win: ["I WON?! Can I keep the board?", "Wait, that means I won? Yay!"],
      lose: ["Good game! That was fun, can we play again?", "Aw. You're really good at this."],
      draw: ["A tie! Nobody's sad!"],
      blunder: ["Ooh, a free piece? For me?", "Is that one for me?"],
      goodMove: ["Whoa, how did you do that?", "That looked smart!"],
      oops: ["Was I supposed to protect that?", "Oopsie."],
    },
  },
  {
    id: "biscuit", name: "Biscuit", elo: 400, category: "Beginner",
    avatar: { emoji: "🐶", bg: "#e0a458" },
    style: "Chases your queen like it's a tennis ball.",
    bio: "A golden retriever with boundless enthusiasm and zero patience. Loves bringing the queen out early to say hello.",
    openings: ["e4 e5 Qh5 Nc6 Bc4 g6", "e4 e5 Bc4 Nc6 Qh5", "e4 c5 Qh5", "d4 d5 Qd3"],
    chat: {
      greet: ["Woof! Let's play!", "Ball? No? Chess? CHESS!"],
      win: ["WOOF WOOF! I won! Treat time!", "Good game! Do I get a biscuit?"],
      lose: ["Arf. Rematch? Please? Please?", "*sad tail wag* Good game."],
      draw: ["Nobody wins? Everybody gets a treat!"],
      blunder: ["*sniff sniff* Something smells free!", "Fetch! I mean... capture!"],
      goodMove: ["*head tilt* Wow!", "Good human!"],
      oops: ["Ruh-roh.", "I got distracted by a squirrel."],
    },
  },
  {
    id: "rosa", name: "Nonna Rosa", elo: 550, category: "Beginner", country: "🇮🇹",
    avatar: { emoji: "👵", bg: "#c97b84" },
    style: "Slow, sweet, and loyal to the Italian Game.",
    bio: "Plays every afternoon in the piazza between batches of biscotti. Gentle, but she will take any piece you leave lying around.",
    openings: ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3", "e4 e5 Nf3 Nc6 Bc4 Bc5 d3", "e4 e5 Nf3 Nc6 Bc4 Nf6 d3"],
    chat: {
      greet: ["Ciao, tesoro! Sit, sit. Let's play.", "Have you eaten? We play first, then we eat."],
      win: ["Ah, bravo to me! Next time you win, I promise.", "Nonna still has it!"],
      lose: ["Bravissimo! You play like my late husband.", "Mamma mia, you're good."],
      draw: ["A draw, like a good minestrone: everybody shares."],
      blunder: ["Oh, you forgot this one, caro. I'll keep it safe.", "Grazie for the gift!"],
      goodMove: ["Che bella mossa!", "Oh, very clever!"],
      oops: ["Eh, my eyes are not what they were.", "Ah, I left the oven on. And my bishop."],
    },
  },
  {
    id: "dex", name: "Dex", elo: 700, category: "Beginner", country: "🇺🇸", speed: 0.6,
    avatar: { emoji: "🛹", bg: "#4f9d69" },
    style: "Plays fast and flashy. Defense is a later problem.",
    bio: "Learned chess from skate-park speed games. If a move looks cool, he's already played it.",
    openings: ["e4 e5 f4", "e4 c5 f4", "e4 e6 f4", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5"],
    chat: {
      greet: ["Yo! Let's goooo.", "Speedrun time."],
      win: ["Kickflip! GG!", "Too fast, too furious."],
      lose: ["Bailed hard. GG though.", "Okay okay, you got me. Run it back?"],
      draw: ["A draw? That's like landing it sketchy."],
      blunder: ["Free real estate!", "Sending it!"],
      goodMove: ["Okay, that was sick.", "Clean!"],
      oops: ["Slammed.", "Didn't see that rail coming."],
    },
  },
  {
    id: "quill", name: "Professor Quill", elo: 850, category: "Intermediate", country: "🇬🇧",
    avatar: { emoji: "🦉", bg: "#7a6c5d" },
    style: "Knows every opening name; still hangs a bishop.",
    bio: "An owl with a library card and a lecture for every move. His theory is impeccable; his tactics, less so.",
    openings: ["d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3", "d4 Nf6 Bf4 g6 e3 Bg7 Nf3", "e4 e6 d4 d5", "e4 c6 d4 d5", "d4 d5 c4 e6", "c4 e5 Nc3"],
    chat: {
      greet: ["Ah, a pupil! Shall we begin with the theory?", "Hoo! Let us test a hypothesis."],
      win: ["As the literature predicted.", "A textbook result, if I may say so."],
      lose: ["Fascinating. I shall have to revise my notes.", "Hoo... a humbling footnote."],
      draw: ["A balanced conclusion. Most scholarly."],
      blunder: ["Hmm, that is not in any book I own.", "A curious novelty. A losing one."],
      goodMove: ["Splendid! Positively Capablanca-esque.", "Hoo! Excellent technique."],
      oops: ["That was... a deliberate experiment.", "I appear to have mislaid a piece."],
    },
  },
  {
    id: "marisol", name: "Marisol", elo: 1000, category: "Intermediate", country: "🇨🇴",
    avatar: { emoji: "💃", bg: "#d1495b" },
    style: "All-out attack, all the time.",
    bio: "A salsa instructor who plays chess like she dances: quick feet, no fear, and straight at your king.",
    openings: ["e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "d4 d5 e4", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6"],
    chat: {
      greet: ["¡Vamos! Let's dance.", "Your king looks lonely. I'll visit."],
      win: ["¡Olé! What a finish!", "And... dip! Checkmate."],
      lose: ["You led well. Gracias por el baile.", "Ay, you stepped on my toes. Good game!"],
      draw: ["We danced in circles. A draw!"],
      blunder: ["¡Eso! I'll take that.", "You missed a step, cariño."],
      goodMove: ["¡Qué movimiento!", "Ooh, smooth."],
      oops: ["Ay, wrong foot!", "That was not the choreography."],
    },
  },
  {
    id: "tank", name: "Tank", elo: 1150, category: "Intermediate", country: "🇨🇦",
    avatar: { emoji: "🛡️", bg: "#5c6b73" },
    style: "Trades everything and dares you to break through.",
    bio: "A retired hockey goalie who believes the best attack is an unbreakable wall. Patience is his favorite piece.",
    openings: ["d4 d5 c4 c6", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5", "d4 d5 Nf3 Nf6 e3 e6 Bd3", "e4 e5 Nf3 Nc6 Nc3 Nf6"],
    chat: {
      greet: ["The net is closed. Try to score.", "Let's keep it tight, eh?"],
      win: ["Shutout.", "Solid defense wins championships."],
      lose: ["You found the five-hole. Good game.", "Well played. I'll review the tape."],
      draw: ["Nil-nil. Respectable."],
      blunder: ["Turnover. Thank you.", "That one's going in my pocket."],
      goodMove: ["Nice shot.", "Good hands."],
      oops: ["Screened on that one.", "Bad bounce."],
    },
  },
  {
    id: "yuki", name: "Yuki", elo: 1300, category: "Intermediate", country: "🇯🇵",
    avatar: { emoji: "🎧", bg: "#6c5ce7" },
    style: "Calm and positional; lo-fi beats on.",
    bio: "A streamer who narrates every move in a soothing voice. Solid structure first, fireworks later.",
    openings: ["c4 e5 Nc3 Nf6 g3", "Nf3 d5 g3 Nf6 Bg2", "e4 e6 d4 d5 Nc3 Nf6", "d4 Nf6 c4 e6 Nf3 b6"],
    chat: {
      greet: ["Hey chat, and hey you. Let's have a chill game.", "Grab some tea. Let's play."],
      win: ["GG. That was a cozy one.", "Thanks for the game, it was peaceful."],
      lose: ["Ahh, nicely done. Chat, did you see that?", "GG, you outplayed me."],
      draw: ["A draw. Balanced, like a good playlist."],
      blunder: ["Oh no... I'll take it gently.", "Chat is spamming 'free piece'."],
      goodMove: ["Ooh, chat, that was clean.", "Nice. Really nice."],
      oops: ["Chat, don't clip that.", "Okay, that one was rough."],
    },
  },
  {
    id: "brine", name: "Captain Brine", elo: 1500, category: "Advanced",
    avatar: { emoji: "🏴‍☠️", bg: "#1d3557" },
    style: "Gambits first, questions never.",
    bio: "A sea captain who treats every pawn as cannon fodder. If there's a gambit in the books, he's sailed it.",
    openings: ["e4 e5 d4 exd4 c3", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "e4 e5 f4 exf4 Nf3", "d4 e5", "e4 e5 Nf3 f5", "d4 d5 c4 e5"],
    chat: {
      greet: ["Arr! Prepare to be boarded!", "Pawns overboard, matey!"],
      win: ["Yo ho ho! The treasure is mine!", "Your king walks the plank!"],
      lose: ["Blast! Sunk by a landlubber.", "Ye sail well. I'll be back with more cannons."],
      draw: ["Becalmed. A draw, arr."],
      blunder: ["Plunder! Hoist it aboard!", "Ye left yer cargo unguarded!"],
      goodMove: ["Shiver me timbers!", "A fine broadside, that."],
      oops: ["Barnacles!", "That pawn was bait. The bishop... was not."],
    },
  },
  {
    id: "ines", name: "Inês", elo: 1650, category: "Advanced", country: "🇵🇹",
    avatar: { emoji: "🔬", bg: "#2a9d8f" },
    style: "Methodical; every move is an experiment.",
    bio: "A chemistry teacher who annotates her games in a lab notebook. She rarely blunders and never rushes.",
    openings: ["e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6", "d4 Nf6 c4 e6 Nc3 Bb4", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7"],
    chat: {
      greet: ["Hypothesis: this will be a good game.", "Safety goggles on. Let's begin."],
      win: ["Experiment concluded. Results: favorable.", "Thank you for participating in my study."],
      lose: ["Unexpected result. I'll need to repeat the experiment.", "Well done. The data doesn't lie."],
      draw: ["Equilibrium reached."],
      blunder: ["Interesting reaction. I'll take the precipitate.", "That was unstable."],
      goodMove: ["Elegant! Writing that one down.", "Excellent technique."],
      oops: ["Contaminated sample.", "Note to self: that was wrong."],
    },
  },
  {
    id: "viktor", name: "Viktor", elo: 1800, category: "Advanced", country: "🇨🇿",
    avatar: { emoji: "🧔", bg: "#8d5524" },
    style: "Club veteran. Sharp Sicilians, sharper elbows.",
    bio: "Forty years of Tuesday club nights and a scorebook for every one. He knows your opening better than you do.",
    openings: ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6", "e4 e5 Nf3 Nc6 Bb5 a6"],
    chat: {
      greet: ["Sit. Clock is running.", "Let us see what the young people play now."],
      win: ["As I have done since 1985.", "Good. Now we analyze, yes?"],
      lose: ["Hm. You played well. I will remember this.", "Respect. Good game."],
      draw: ["Draw. Is fine. We shake hands."],
      blunder: ["Ah. This, I take.", "In my club, we call this a donation."],
      goodMove: ["Good move. Very good.", "Hm! Strong."],
      oops: ["Bah. Old eyes.", "I have played this a thousand times. Not like this."],
    },
  },
  {
    id: "kestrel", name: "Kestrel", elo: 2000, category: "Master", country: "🇿🇦",
    avatar: { emoji: "🦅", bg: "#bc6c25" },
    style: "Hovers patiently, then strikes on tactics.",
    bio: "A park hustler turned coach with eyes like a hawk. Leave one piece loose and it's gone.",
    openings: ["e4 e5 Nf3 Nc6 d4 exd4 Nxd4", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5", "d4 d5 c4 dxc4"],
    chat: {
      greet: ["I see everything from up here.", "Let's see how sharp you are."],
      win: ["Swooped.", "Too slow. Good game."],
      lose: ["You saw further than me. Respect.", "Sharp play. Well earned."],
      draw: ["Neither of us blinked. Draw."],
      blunder: ["Spotted it.", "Loose pieces drop off."],
      goodMove: ["Sharp eyes!", "Ooh, I missed that one."],
      oops: ["Flew right into that.", "Misjudged the wind."],
    },
  },
  {
    id: "morgane", name: "Lady Morgane", elo: 2200, category: "Master", country: "🇫🇷",
    avatar: { emoji: "👑", bg: "#9b2226" },
    style: "Elegant, positional, merciless in the endgame.",
    bio: "An aristocrat who considers a pawn weakness a personal insult. She will squeeze you for sixty moves and smile the whole time.",
    openings: ["d4 Nf6 c4 e6 Nf3 d5 Nc3 Be7", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4", "c4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7"],
    chat: {
      greet: ["Enchantée. Do try to keep up.", "Shall we? I do so enjoy a long game."],
      win: ["Merci. Your position was... a learning experience.", "Exquisite, non?"],
      lose: ["Magnifique. I underestimated you.", "Touché. Well played."],
      draw: ["A draw. How very diplomatic."],
      blunder: ["Oh dear. How careless of you.", "I accept your offering."],
      goodMove: ["Très élégant.", "Now that is chess."],
      oops: ["How... unbecoming of me.", "A momentary lapse of taste."],
    },
  },
  {
    id: "tunde", name: "Coach Tunde", elo: 2450, category: "Master", country: "🇳🇬",
    avatar: { emoji: "🧑‍🏫", bg: "#264653" },
    style: "Universal style; punishes every inaccuracy.",
    bio: "A strong master turned coach who has seen every trick. He plays clean, principled chess and explains it afterward.",
    openings: ["d4 Nf6 c4 e6 g3 d5 Bg2", "e4 c6 d4 d5 e5 Bf5", "Nf3 Nf6 c4 g6"],
    chat: {
      greet: ["Good to see you. Play your best; I'll play mine.", "Let's make this instructive."],
      win: ["Good fight. Let's review where it turned.", "Well played up to the critical moment."],
      lose: ["Excellent! You earned that one.", "That's how it's done. Proud of you."],
      draw: ["A fair result. Good, principled play."],
      blunder: ["Careful. Always check what your move allows.", "That one will cost you."],
      goodMove: ["Yes! Exactly the right idea.", "Very strong move."],
      oops: ["Even coaches make mistakes. Don't tell my students.", "Hmm. I'll show that one as a warning."],
    },
  },
  {
    id: "nova", name: "Nova", elo: 2700, category: "Engine",
    avatar: { emoji: "🌌", bg: "#3a0ca3" },
    style: "A neural net that dreams in endgames.",
    bio: "An experimental engine personality: cold, precise, and occasionally poetic about pawn structures.",
    chat: {
      greet: ["Initializing. Hello, human.", "Probability of an interesting game: high."],
      win: ["Outcome converged. Thank you for the data.", "Checkmate is a kind of poetry."],
      lose: ["Anomaly detected. Remarkable.", "You have exceeded my predictions."],
      draw: ["Equilibrium. Elegant."],
      blunder: ["Evaluation shifted significantly.", "Your move reduced your winning chances."],
      goodMove: ["Unexpected and strong.", "Recalculating..."],
      oops: ["Error margin exceeded.", "A rare stochastic event."],
    },
  },
  {
    id: "apex", name: "Apex", elo: 3200, category: "Engine",
    avatar: { emoji: "⚙️", bg: "#111827" },
    style: "Full-strength Stockfish. Good luck.",
    bio: "No personality settings, no mercy. Apex runs the engine at full strength and plays the best move it can find.",
    chat: {
      greet: ["Ready.", "Searching."],
      win: ["1-0.", "Game over."],
      lose: ["Impossible. Impressive.", "Result logged."],
      draw: ["Draw."],
      blunder: ["Mistake detected.", "Advantage: Apex."],
      goodMove: ["Best move found.", "Correct."],
      oops: ["...", "Unexpected."],
    },
  },
];

export function getBot(id) { return BOTS.find((b) => b.id === id) || null; }

/** A random chat line for `event` (greet | win | lose | draw | blunder | goodMove | oops), or "". */
export function botChat(bot, event, random = Math.random) {
  const lines = bot && bot.chat && bot.chat[event];
  return lines && lines.length ? lines[Math.floor(random() * lines.length)] : "";
}

// ---------------------------------------------------------------------------
// Strength parameters
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const LIMIT_ELO_FLOOR = 1400; // below this we emulate humans instead of UCI_Elo

/** Tunables for the human-emulation bots (exported for tests / tuning). */
export function humanParams(elo) {
  const x = clamp((elo - 250) / (LIMIT_ELO_FLOOR - 250), 0, 1);
  return {
    depth: Math.round(4 + 3 * x),                       // 4..7
    multipv: Math.round(10 - 4 * x),                    // 10..6 candidates
    temperature: 45 + 335 * Math.pow(1 - x, 1.5),       // softmax temperature in centipawns
    pRandom: 0.30 * (1 - x) * (1 - x),                  // plainly random legal move
    pHang: 0.03 + 0.15 * Math.pow(1 - x, 1.5),          // deliberately pick a move that drops material
    pMate: elo >= 800 ? 1 : 0.35 + 0.65 * clamp((elo - 250) / 550, 0, 1), // play a mate in one
    pGrab: 0.55 + 0.45 * x,                             // take loose material (SEE >= minor piece)
    pRecapture: 0.6 + 0.35 * x,                         // instinctive recapture
    scoreClamp: 1000,                                   // mates don't completely dominate sampling
  };
}

/** Default movetime (ms) for the engine-backed bots. */
export function engineMovetime(elo) {
  return Math.round(150 + 650 * clamp((elo - LIMIT_ELO_FLOOR) / 1800, 0, 1));
}

// ---------------------------------------------------------------------------
// Move selection
// ---------------------------------------------------------------------------

const stripSan = (s) => String(s).replace(/[+#!?]/g, "");

function bookMove(bot, chess, history, startFen) {
  if (!bot.openings || !bot.openings.length) return null;
  if (startFen && startFen.split(" ").slice(0, 4).join(" ") !== START_FEN.split(" ").slice(0, 4).join(" ")) return null;
  const h = history.map(stripSan);
  const next = [];
  for (const line of bot.openings) {
    const toks = line.trim().split(/\s+/);
    if (toks.length <= h.length) continue;
    let ok = true;
    for (let i = 0; i < h.length; i++) if (stripSan(toks[i]) !== h[i]) { ok = false; break; }
    if (ok) next.push(toks[h.length]);
  }
  return next;
}

const samePosition = (a, b) => a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");

function historyLeadsTo(history, startFen, fen) {
  try {
    const c = createChess(startFen || START_FEN);
    for (const mv of history) if (!applyMove(c, mv)) return false;
    return samePosition(c.fen(), fen);
  } catch { return false; }
}

function pick(arr, random) { return arr[Math.floor(random() * arr.length)]; }

function lastCaptureSquare(history) {
  const last = history.length ? String(history[history.length - 1]) : "";
  if (!last.includes("x")) return null;
  const sq = last.replace(/=[QRBN]/, "").match(/[a-h][1-8]/g);
  return sq ? sq[sq.length - 1] : null;
}

function givesMate(chess, m) {
  chess.move(m);
  const mate = chess.isCheckmate();
  chess.undo();
  return mate;
}

/** Net material after `m`: what we capture minus the best the opponent can win back at once. */
function netAfter(chess, m) {
  const gained = m.captured ? PIECE_VALUE[m.captured] : 0;
  chess.move(m);
  const back = chess.isCheckmate() ? 0 : bestCaptureGain(chess).gain;
  chess.undo();
  return gained - back;
}

function lineScore(line, clampTo) {
  const s = line.mate != null ? (line.mate > 0 ? 3000 - 10 * line.mate : -3000 - 10 * line.mate) : line.cp;
  return clamp(s, -clampTo, clampTo);
}

async function humanMove(engine, chess, legal, bot, ctx) {
  const P = humanParams(bot.elo);
  const R = ctx.random;
  const mates = legal.filter((m) => givesMate(chess, m));
  if (mates.length && R() < P.pMate) return { move: mates[0], reason: "mate" };

  if (R() < P.pRandom) return { move: pick(legal, R), reason: "random" };

  if (R() < P.pHang) {
    const hangs = legal.filter((m) => !mates.includes(m) && netAfter(chess, m) <= -200);
    if (hangs.length) return { move: pick(hangs, R), reason: "hang" };
  }

  const board = boardArray(chess);
  const grabs = legal
    .filter((m) => m.captured)
    .map((m) => ({ m, g: seeMove(chess, m, board) }))
    .filter((x) => x.g >= 200)
    .sort((a, b) => b.g - a.g);
  if (grabs.length && R() < P.pGrab) return { move: grabs[0].m, reason: "grab" };

  const recapSq = lastCaptureSquare(ctx.history);
  if (recapSq && R() < P.pRecapture) {
    const recaps = legal
      .filter((m) => m.to === recapSq && m.captured)
      .map((m) => ({ m, g: seeMove(chess, m, board) }))
      .filter((x) => x.g >= 0)
      .sort((a, b) => PIECE_VALUE[a.m.piece] - PIECE_VALUE[b.m.piece]);
    if (recaps.length) return { move: recaps[0].m, reason: "recapture" };
  }

  const r = await engine.analyze(chess.fen(), { depth: P.depth, multipv: Math.min(P.multipv, legal.length) });
  const cands = r.lines.filter((l) => l.pv && l.pv.length);
  if (!cands.length) {
    if (r.aborted) throw abortedError();
    return { move: pick(legal, R), reason: "random" };
  }
  const scores = cands.map((l) => lineScore(l, P.scoreClamp));
  const top = Math.max(...scores);
  const w = scores.map((s) => Math.exp((s - top) / P.temperature));
  let u = R() * w.reduce((a, b) => a + b, 0);
  let k = 0;
  while (k < w.length - 1 && (u -= w[k]) > 0) k++;
  const uci = cands[k].pv[0];
  const move = legal.find((m) => moveToUci(m) === uci) || legal.find((m) => m.from + m.to === uci.slice(0, 4));
  if (!move) return { move: pick(legal, R), reason: "random" };
  return { move, reason: k === 0 ? "engine" : "sampled", rank: k + 1 };
}

function abortedError() {
  const e = new Error("Bot move interrupted");
  e.code = "ABORTED";
  return e;
}

async function engineBotMove(engine, chess, legal, bot, ctx) {
  const full = bot.elo >= 3190;
  const r = await engine.analyze(chess.fen(), {
    movetime: ctx.movetime || engineMovetime(bot.elo),
    elo: full ? null : bot.elo,
    history: ctx.history.length ? { startFen: ctx.startFen, moves: ctx.history } : undefined,
  });
  const uci = r.bestmove;
  const move = uci && legal.find((m) => moveToUci(m) === uci);
  if (!move) {
    if (r.aborted) throw abortedError();
    throw new Error("Engine returned no legal move");
  }
  return { move, reason: "engine" };
}

/**
 * Pick the bot's move.
 * @param {Engine} engine
 * @param {string} fen current position (bot to move)
 * @param {object} bot an entry of BOTS
 * @param {object} [o]
 * @param {string[]} [o.history] SAN moves of the game so far (from startFen) - drives the
 *   opening book, recaptures and repetition awareness.
 * @param {string} [o.startFen] the game's initial position (default standard start)
 * @param {number} [o.movetime] override the engine bots' movetime (ms)
 * @param {() => number} [o.random] RNG (tests)
 * @returns {Promise<{from,to,promotion,san,uci,thinkMs,delayMs,reason}>}
 *   thinkMs = compute time spent; delayMs = extra "human" wait still recommended
 *   (botThinkDelay minus thinkMs, >= 0). reason: book | forced | mate | engine | sampled |
 *   random | hang | grab | recapture ("random"/"hang" are the bot's deliberate errors).
 */
export async function botMove(engine, fen, bot, { history = [], startFen = START_FEN, movetime, random = Math.random } = {}) {
  const t0 = Date.now();
  const chess = createChess(fen);
  const legal = chess.moves({ verbose: true });
  if (!legal.length) throw new Error("No legal moves: the game is over");
  // History only counts (book, recaptures, repetitions) if it really leads to `fen`.
  if (history.length || startFen !== START_FEN) {
    if (!historyLeadsTo(history, startFen, fen)) history = [];
  } else if (!samePosition(fen, START_FEN)) {
    history = null; // unknown game: no book
  }
  const ctx = { history: history || [], startFen, movetime, random };
  let choice = null;

  if (legal.length === 1) choice = { move: legal[0], reason: "forced" };

  if (!choice && history && historyLeadsTo(history, startFen, fen)) {
    const next = bookMove(bot, chess, history, startFen);
    if (next && next.length) {
      const san = pick(next, random);
      const m = legal.find((x) => stripSan(x.san) === stripSan(san));
      if (m) choice = { move: m, reason: "book" };
    }
  }

  if (!choice) {
    choice = bot.elo >= LIMIT_ELO_FLOOR
      ? await engineBotMove(engine, chess, legal, bot, ctx)
      : await humanMove(engine, chess, legal, bot, ctx);
  }

  const m = choice.move;
  const thinkMs = Date.now() - t0;
  const moveNumber = +(fen.split(" ")[5] || 1);
  return {
    from: m.from, to: m.to, promotion: m.promotion || undefined,
    san: m.san, uci: moveToUci(m),
    thinkMs,
    delayMs: Math.max(0, botThinkDelay(bot, fen, moveNumber, { legalCount: legal.length, forced: choice.reason === "forced", book: choice.reason === "book" }) - thinkMs),
    reason: choice.reason,
  };
}

/**
 * "Human" delay (ms) to wait before showing the bot's move: quick in the opening and for
 * forced moves, slower in complex positions; engine bots are snappier. Bounded 300..2500.
 */
export function botThinkDelay(bot, fen, moveNumber = 1, hint = {}) {
  let legalCount = hint.legalCount, captures = 0, inCheck = false;
  try {
    const c = createChess(fen);
    const ms = c.moves({ verbose: true });
    legalCount = ms.length;
    captures = ms.filter((m) => m.captured).length;
    inCheck = c.inCheck();
  } catch { legalCount = legalCount || 20; }
  const jitter = 0.8 + 0.4 * Math.random();
  if (legalCount <= 1 || hint.forced) return Math.round(clamp(320 * jitter, 300, 2500));
  const complexity = clamp((legalCount - 10) / 30, 0, 1) * 0.45 + clamp(captures / 6, 0, 1) * 0.35 + (inCheck ? 0.2 : 0);
  const phase = hint.book ? 0.3 : moveNumber <= 6 ? 0.4 : moveNumber <= 12 ? 0.75 : 1;
  const engineBot = bot && bot.category === "Engine";
  const elo = bot ? bot.elo : 1200;
  const style = engineBot ? 0.35 : 0.55 + 0.45 * clamp((elo - 250) / 2200, 0, 1);
  const speed = bot && bot.speed ? bot.speed : 1;
  const ms = (500 + 1700 * complexity) * phase * style * speed * jitter;
  return Math.round(clamp(ms, 300, 2500));
}
