// Online chess rules module — bundled with chess.js into a self-contained logic.js
// (six-export contract; no imports or timers survive in the bundle output).
import { Chess } from "chess.js";
import { Crazyhouse, textToMove } from "./core/zh.js";
import { VxGame, VX_VARIANTS, vxTextToMove, vxMoveToText } from "./core/vx.js";
import { FourPlayer, FP_COLORS, fpTextToMove } from "./core/fp.js";

export const meta = { game: "Chess 3D", minPlayers: 2, maxPlayers: 2 };

const TIME_CONTROLS = { "1+0": [60, 0], "3+2": [180, 2], "5+0": [300, 0], "10+0": [600, 0], "15+10": [900, 10], "inf": null };
const VERSION = 6;           // v2: chat / takebacks / abort / custom clocks; v3: daily deadlines; v4: crazyhouse, bughouse;
                             // v5: duck chess, fog of war, giveaway, atomic, horde; v6: 4-player chess
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const otherColor = (c) => (c === "w" ? "b" : "w");

// Crazyhouse and Bughouse rooms keep their position in state.zh. In Bughouse a capture goes to
// the partner (the other colour on the linked board): it's queued in state.outbox, and the room
// relays it to the linked room, which applies it as an internal "give" action.
function zhOf(state) {
  if (state.variant !== "bughouse") return new Crazyhouse(state.zh);
  return new Crazyhouse(state.zh, { feed: (color, type) => { state.outbox = [...(state.outbox || []), { t: "give", color: otherColor(color), type }]; } });
}
// Duck Chess, Fog of War, Giveaway, Atomic and Horde keep their position in state.vx
const ZH_VARIANTS = ["crazyhouse", "bughouse"];
const VARIANTS = [...ZH_VARIANTS, ...Object.keys(VX_VARIANTS)];

// a variant room's rules behind one interface: whose turn, is it over, is this move text legal
function rulesOf(state) {
  if (state.vx) {
    const g = new VxGame(state.variant, state.vx);
    return { turn: () => g.turn(), outcome: () => g.outcome(), isLegal: (t) => { const m = vxTextToMove(t); return !!m && g.isLegal(m); } };
  }
  const z = new Crazyhouse(state.zh);
  return { turn: () => z.turn(), outcome: () => z.outcome(), isLegal: (t) => { const m = textToMove(t); return !!m && z.isLegal(m); } };
}
const DAILY_DAYS = [1, 2, 3, 5, 7, 14];

// "7+2", "0.5+0" ... -> [seconds, increment] (custom controls), or a preset key.
// "3d" is a daily game: 3 days for each move, and the deadline resets after every move.
function parseTc(key) {
  if (key in TIME_CONTROLS) return { ok: true, tc: TIME_CONTROLS[key] };
  const d = /^(\d{1,2})d$/.exec(String(key));
  if (d) return DAILY_DAYS.includes(Number(d[1])) ? { ok: true, tc: [Number(d[1]) * 86400, 0], perMove: true } : { ok: false };
  const m = /^(\d{1,3}(?:\.5)?)\+(\d{1,2})$/.exec(String(key));
  if (!m) return { ok: false };
  const mins = Number(m[1]), inc = Number(m[2]);
  if (mins < 0.5 || mins > 180 || inc > 60) return { ok: false };
  return { ok: true, tc: [Math.round(mins * 60), inc] };
}

function rebuild(state) {
  const game = new Chess();
  for (const m of state.moves) game.move(m);
  return game;
}

function colorOf(state, playerId) {
  return state.white === playerId ? "w" : state.black === playerId ? "b" : null;
}

export function setup(players) {
  if (players.length === 4) return setupFour(players);
  return {
    players: [...players],
    white: players[0],
    black: players[1],
    phase: "config",             // white picks the time control, then "playing"
    tcKey: null,
    tc: null,                    // {initial: s, inc: s} or null for unlimited
    moves: [],                   // [{from,to,promotion}]
    san: [],
    fen: new Chess().fen(),
    clock: { w: 0, b: 0, lastAt: null },
    drawOffer: null,
    resigned: null,
    flagged: null,
    timeoutDraw: false,
    agreedDraw: false,
    aborted: false,
    takebackOffer: null,
    chat: [],
    v: VERSION,
  };
}

export function validateAction(state, playerId, action) {
  if (!action || typeof action.t !== "string") return { ok: false, error: "malformed action" };
  if (state.fourSeats) return validateFour(state, playerId, action);
  const color = colorOf(state, playerId);
  if (!color) return { ok: false, error: "you are spectating" };
  const finished = state.resigned || state.flagged || state.agreedDraw || state.timeoutDraw || state.aborted;

  if (action.t === "chat") {
    if (typeof action.text !== "string" || !action.text.trim()) return { ok: false, error: "empty message" };
    if (action.text.length > 200) return { ok: false, error: "message too long" };
    return { ok: true };
  }

  if (action.t === "config") {
    if (state.phase !== "config") return { ok: false, error: "the game already started" };
    if (color !== "w") return { ok: false, error: "White chooses the time control" };
    if (!parseTc(action.tc).ok) return { ok: false, error: "unknown time control" };
    if (action.variant !== undefined && action.variant !== "standard" && !VARIANTS.includes(action.variant)) return { ok: false, error: "unknown variant" };
    if (action.variant === "bughouse" && !(typeof action.link === "string" && ROOM_RE.test(action.link))) return { ok: false, error: "a bughouse board needs its partner board" };
    if (action.variant === "chess960" && !(Number.isInteger(action.start) && action.start >= 0 && action.start < 960)) return { ok: false, error: "which Chess960 position?" };
    return { ok: true };
  }
  if (state.phase === "config") return { ok: false, error: "waiting for White to choose the time control" };
  if (finished) return { ok: false, error: "the game is over" };

  if (action.t === "move" && state.variant) {
    const r = rulesOf(state);
    if (r.outcome().over) return { ok: false, error: "the game is over" };
    if (r.turn() !== color) return { ok: false, error: "not your turn" };
    if (typeof action.move !== "string" || !r.isLegal(action.move)) return { ok: false, error: "illegal move" };
    return { ok: true };
  }
  if (action.t === "move") {
    const game = rebuild(state);
    if (game.isGameOver()) return { ok: false, error: "the game is over" };
    if (game.turn() !== color) return { ok: false, error: "not your turn" };
    const legal = game.moves({ square: action.from, verbose: true })
      .some(m => m.to === action.to && (m.promotion || null) === (action.promotion || null));
    if (!legal) return { ok: false, error: "illegal move" };
    return { ok: true };
  }
  if (action.t === "resign") return { ok: true };
  if (action.t === "abort") {
    if (state.moves.length >= 2) return { ok: false, error: "too late to abort" };
    return { ok: true };
  }
  if (action.t === "takeback-offer") {
    if (state.variant) return { ok: false, error: "no takebacks in this variant" };
    if (!state.moves.length) return { ok: false, error: "no move to take back" };
    if (state.takebackOffer) return { ok: false, error: "a takeback request is already pending" };
    return { ok: true };
  }
  if (action.t === "takeback-accept" || action.t === "takeback-decline") {
    if (!state.takebackOffer || state.takebackOffer === color) return { ok: false, error: "no takeback request to answer" };
    return { ok: true };
  }
  if (action.t === "draw-offer") {
    if (state.drawOffer) return { ok: false, error: "a draw offer is already pending" };
    return { ok: true };
  }
  if (action.t === "draw-accept" || action.t === "draw-decline") {
    if (!state.drawOffer || state.drawOffer === color) return { ok: false, error: "no draw offer to answer" };
    return { ok: true };
  }
  if (action.t === "flag") {
    if (!state.tc) return { ok: false, error: "no clock in this game" };
    const opp = color === "w" ? "b" : "w";
    let turn;
    if (state.variant) {
      const r = rulesOf(state);
      if (r.outcome().over) return { ok: false, error: "the game is over" };
      turn = r.turn();
    } else {
      const game = rebuild(state);
      if (game.isGameOver()) return { ok: false, error: "the game is over" };
      turn = game.turn();
    }
    let remaining = state.clock[opp];
    if (turn === opp && state.clock.lastAt !== null) remaining -= Date.now() - state.clock.lastAt;
    if (remaining > 0) return { ok: false, error: "opponent still has time" };
    return { ok: true };
  }
  return { ok: false, error: "unknown action" };
}

export function applyAction(state, playerId, action) {
  if (state.fourSeats) return applyFour(state, playerId, action);
  const color = colorOf(state, playerId);
  const now = Date.now();

  // internal actions from the linked Bughouse board (the room calls these directly; clients can't,
  // because validateAction rejects them)
  if (playerId === "__link") {
    if (state.variant !== "bughouse" || !state.zh) return state;
    if (action.t === "give" && ["w", "b"].includes(action.color) && ["p", "n", "b", "r", "q"].includes(action.type)) {
      const zh = { ...state.zh, pockets: JSON.parse(JSON.stringify(state.zh.pockets)) };
      zh.pockets[action.color][action.type]++;
      return { ...state, zh };
    }
    if (action.t === "partner-end" && !state.partnerEnd) {
      return { ...state, partnerEnd: { winner: ["w", "b"].includes(action.winner) ? action.winner : null, reason: String(action.reason || "partner").slice(0, 20) }, clock: { ...state.clock, lastAt: null } };
    }
    return state;
  }

  if (action.t === "chat") {
    const msg = { c: color, text: action.text.trim().slice(0, 200), at: now };
    return { ...state, chat: [...(state.chat || []), msg].slice(-60) };
  }

  if (action.t === "config") {
    const { tc, perMove } = parseTc(action.tc);
    const variant = VARIANTS.includes(action.variant) ? action.variant : null;
    const vx = VX_VARIANTS[variant] ? new VxGame(variant, variant === "chess960" ? { start: action.start } : {}) : null;
    return {
      ...state,
      phase: "playing",
      tcKey: action.tc,
      variant,
      zh: ZH_VARIANTS.includes(variant) ? new Crazyhouse().state() : undefined,
      vx: vx ? vx.state() : undefined,
      fen: vx ? vx.fen : state.fen,
      link: variant === "bughouse" ? action.link : undefined,
      outbox: [],
      tc: tc ? { initial: tc[0], inc: tc[1], perMove: !!perMove } : null,
      clock: tc ? { w: tc[0] * 1000, b: tc[0] * 1000, lastAt: now } : { w: 0, b: 0, lastAt: null },
    };
  }

  if (action.t === "move") {
    let clock = state.clock;
    let flagged = state.flagged;
    if (state.tc && clock.lastAt !== null) {
      const elapsed = now - clock.lastAt;
      const remaining = clock[color] - elapsed;
      if (remaining <= 0) {
        flagged = color;
        clock = { ...clock, [color]: 0, lastAt: null };
        return withPartnerEnd({ ...state, clock, flagged });
      }
      // daily games: the mover gets their full allowance back for their next turn
      clock = { ...clock, [color]: state.tc.perMove ? state.tc.initial * 1000 : remaining + state.tc.inc * 1000, lastAt: now };
    }
    if (state.vx) {
      const g = new VxGame(state.variant, state.vx);
      const desc = g.move(vxTextToMove(action.move));
      return { ...state, clock, drawOffer: null, vx: g.state(), fen: g.fen, moves: [...state.moves, action.move], san: [...state.san, desc.san] };
    }
    if (state.variant) {
      const next = { ...state, clock, drawOffer: null };
      const z = zhOf(next);
      const desc = z.move(textToMove(action.move));
      next.zh = z.state();
      next.fen = z.fen;
      next.moves = [...state.moves, action.move];
      next.san = [...state.san, desc.san];
      return withPartnerEnd(next);
    }
    const game = rebuild(state);
    const mv = game.move({ from: action.from, to: action.to, promotion: action.promotion || undefined });
    return {
      ...state,
      moves: [...state.moves, { from: action.from, to: action.to, promotion: action.promotion || undefined }],
      san: [...state.san, mv.san],
      fen: game.fen(),
      clock,
      drawOffer: null,
      takebackOffer: null,
    };
  }

  if (action.t === "abort") return withPartnerEnd({ ...state, aborted: true, clock: { ...state.clock, lastAt: null } });
  if (action.t === "takeback-offer") return { ...state, takebackOffer: color };
  if (action.t === "takeback-decline") return { ...state, takebackOffer: null };
  if (action.t === "takeback-accept") {
    // undo back to the requester's last move (1 ply if it's the opponent's turn, else 2)
    const requester = state.takebackOffer;
    const game = rebuild(state);
    const plies = game.turn() === requester ? 2 : 1;
    const keep = Math.max(0, state.moves.length - plies);
    const moves = state.moves.slice(0, keep);
    const g2 = new Chess();
    for (const m of moves) g2.move(m);
    const clock = state.tc ? { ...state.clock, lastAt: now } : state.clock;
    return { ...state, moves, san: state.san.slice(0, keep), fen: g2.fen(), takebackOffer: null, drawOffer: null, clock };
  }

  if (action.t === "resign") return withPartnerEnd({ ...state, resigned: color });
  if (action.t === "draw-offer") return { ...state, drawOffer: color };
  if (action.t === "draw-accept") return withPartnerEnd({ ...state, agreedDraw: true, drawOffer: null });
  if (action.t === "draw-decline") return { ...state, drawOffer: null };

  if (action.t === "flag") {
    const opp = color === "w" ? "b" : "w";
    // timeout vs bare king is a draw (standard rule, simplified to lone-king check)
    const game = rebuild(state);
    const board = game.board().flat().filter(Boolean);
    const claimerHasMaterial = board.some(p => p.color === color && p.type !== "k");
    // (in the drop variants material in hand counts, so a flag always wins there)
    if (!claimerHasMaterial && !state.variant) return { ...state, timeoutDraw: true, clock: { ...state.clock, [opp]: 0, lastAt: null } };
    return withPartnerEnd({ ...state, flagged: opp, clock: { ...state.clock, [opp]: 0, lastAt: null } });
  }
  return state;
}

// Bughouse: when this board ends, the linked board ends too, with the result for the same teams
// (this board's White partners the other board's Black)
function withPartnerEnd(state) {
  if (state.variant !== "bughouse" || state.partnerEnd || state.endSent) return state;
  const r = isGameOver(state);
  if (!r.over) return state;
  const winnerColor = r.winner === state.white ? "w" : r.winner === state.black ? "b" : null;
  return { ...state, endSent: true, outbox: [...(state.outbox || []), { t: "partner-end", winner: winnerColor ? otherColor(winnerColor) : null, reason: r.reason }] };
}

export function isGameOver(state) {
  if (state.phase === "config") return { over: false };
  if (state.fourSeats) return fourOver(state);
  if (state.partnerEnd) {
    const w = state.partnerEnd.winner;
    return w ? { over: true, winner: w === "w" ? state.white : state.black, reason: "partner-" + state.partnerEnd.reason } : { over: true, draw: true, reason: "partner-" + state.partnerEnd.reason };
  }
  if (state.resigned) {
    const winner = state.resigned === "w" ? state.black : state.white;
    return { over: true, winner, reason: "resignation" };
  }
  if (state.flagged) {
    const winner = state.flagged === "w" ? state.black : state.white;
    return { over: true, winner, reason: "timeout" };
  }
  if (state.timeoutDraw) return { over: true, draw: true, reason: "timeout-draw" };
  if (state.aborted) return { over: true, draw: true, reason: "aborted" };
  if (state.agreedDraw) return { over: true, draw: true, reason: "agreement" };
  if (state.variant) {
    const o = rulesOf(state).outcome();
    if (!o.over) return { over: false };
    return o.winner ? { over: true, winner: o.winner === "w" ? state.white : state.black, reason: o.reason } : { over: true, draw: true, reason: o.reason };
  }

  const game = rebuild(state);
  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? state.black : state.white;
    return { over: true, winner, reason: "checkmate" };
  }
  if (game.isStalemate()) return { over: true, draw: true, reason: "stalemate" };
  if (game.isThreefoldRepetition()) return { over: true, draw: true, reason: "threefold" };
  if (game.isInsufficientMaterial()) return { over: true, draw: true, reason: "material" };
  if (game.isDraw()) return { over: true, draw: true, reason: "fifty" };
  return { over: false };
}

// Chess has no hidden information, except in Fog of War: there each player gets only what their
// pieces can see (the server sends their legal moves too, since a hidden piece can block a pawn),
// and the other side's moves stay hidden until the game ends. Spectators see nothing until then.
export function viewFor(state, playerId) {
  if (state.variant !== "fog" || !state.vx || isGameOver(state).over) return { ...state, serverNow: Date.now() };
  const g = new VxGame("fog", state.vx);
  const color = colorOf(state, playerId);
  const mine = (i) => (i % 2 === 0 ? "w" : "b") === color;
  const fen = color ? g.foggedFen(color) : "8/8/8/8/8/8/8/8 " + g.fen.split(" ").slice(1).join(" ");
  return {
    ...state,
    vx: { variant: "fog", fen, keys: [] },
    fen,
    moves: state.moves.map((m, i) => (mine(i) ? m : null)),
    san: state.san.map((x, i) => (mine(i) ? x : null)),
    visible: color ? g.visible(color) : [],
    legal: color && g.turn() === color ? g.moves().map(vxMoveToText) : [],
    serverNow: Date.now(),
  };
}

// ---- 4-Player Chess: a four-seat room (seats fill Red, Blue, Yellow, Green); Red picks the game ----
function setupFour(players) {
  return {
    players: [...players],
    fourSeats: { r: players[0], b: players[1], y: players[2], g: players[3] },
    four: null,
    phase: "config",
    tcKey: null,
    tc: null,
    clock: { r: 0, b: 0, y: 0, g: 0, lastAt: null },
    lastMove: null,
    chat: [],
    v: VERSION,
  };
}
const fourColorOf = (state, playerId) => FP_COLORS.find((c) => state.fourSeats[c] === playerId) || null;

function validateFour(state, playerId, action) {
  const color = fourColorOf(state, playerId);
  if (!color) return { ok: false, error: "you are spectating" };
  if (action.t === "chat") {
    if (typeof action.text !== "string" || !action.text.trim()) return { ok: false, error: "empty message" };
    if (action.text.length > 200) return { ok: false, error: "message too long" };
    return { ok: true };
  }
  if (action.t === "config") {
    if (state.phase !== "config") return { ok: false, error: "the game already started" };
    if (color !== "r") return { ok: false, error: "Red sets up the game" };
    const tc = parseTc(action.tc);
    if (!tc.ok || tc.perMove) return { ok: false, error: "unknown time control" };
    if (!["ffa", "teams"].includes(action.rules)) return { ok: false, error: "free-for-all or teams?" };
    return { ok: true };
  }
  if (state.phase === "config") return { ok: false, error: "waiting for Red to start the game" };
  const g = new FourPlayer(state.four.mode, state.four);
  if (g.result) return { ok: false, error: "the game is over" };
  const active = g.status()[FP_COLORS.indexOf(color)] === "active";
  if (action.t === "move") {
    if (g.turn() !== color) return { ok: false, error: "not your turn" };
    const m = fpTextToMove(action.move);
    if (!m || !g.isLegal(m)) return { ok: false, error: "illegal move" };
    return { ok: true };
  }
  if (action.t === "resign") return active ? { ok: true } : { ok: false, error: "you're already out" };
  if (action.t === "claim") return g.canClaim(color) ? { ok: true } : { ok: false, error: "you can't claim the win yet" };
  if (action.t === "flag") {
    if (!state.tc || state.clock.lastAt === null) return { ok: false, error: "no clock running" };
    const turn = g.turn();
    if (state.clock[turn] - (Date.now() - state.clock.lastAt) > 0) return { ok: false, error: "they still have time" };
    return { ok: true };
  }
  return { ok: false, error: "unknown action" };
}

function applyFour(state, playerId, action) {
  const color = fourColorOf(state, playerId);
  const now = Date.now();
  if (action.t === "chat") return { ...state, chat: [...state.chat, { c: color, text: action.text.trim().slice(0, 200), at: now }].slice(-60) };
  if (action.t === "config") {
    const { tc } = parseTc(action.tc);
    const ms = tc ? tc[0] * 1000 : 0;
    return {
      ...state,
      phase: "playing",
      tcKey: action.tc,
      tc: tc ? { initial: tc[0], inc: tc[1] } : null,
      four: new FourPlayer(action.rules === "teams" ? "teams" : "ffa").state(),
      clock: { r: ms, b: ms, y: ms, g: ms, lastAt: tc ? now : null },
    };
  }
  const g = new FourPlayer(state.four.mode, state.four);
  let clock = state.clock;
  // the player to move has been using their time since the last move
  const charge = () => {
    if (!state.tc || clock.lastAt === null) return;
    const turn = g.turn();
    clock = { ...clock, [turn]: Math.max(0, clock[turn] - (now - clock.lastAt)) };
  };
  const done = (extra = {}) => ({ ...state, ...extra, four: g.state(), clock: { ...clock, lastAt: state.tc && !g.result ? now : null } });
  if (action.t === "move") {
    const mover = g.turn();
    charge();
    // out of time before the move arrived: that's a timeout, not a move
    if (state.tc && clock[mover] <= 0) { timeOut(g, mover); return done(); }
    g.play(fpTextToMove(action.move));
    if (state.tc) clock = { ...clock, [mover]: clock[mover] + state.tc.inc * 1000 };
    return done({ lastMove: action.move });
  }
  if (action.t === "flag") {
    const who = g.turn();
    clock = { ...clock, [who]: 0 };
    timeOut(g, who);
    return done();
  }
  if (action.t === "resign") { charge(); g.resign(color); return done(); }
  if (action.t === "claim") { charge(); g.claim(color); return done(); }
  return state;
}

// running out of time works like resigning (in free-for-all the king wanders on), with its own reason
function timeOut(g, color) {
  g.resign(color);
  if (g.result && g.result.reason === "resignation") g.result = { ...g.result, reason: "timeout" };
}

function fourOver(state) {
  const r = state.four && state.four.result;
  if (!r) return { over: false };
  if (state.four.mode === "teams") {
    if (!r.winner) return { over: true, draw: true, reason: r.reason };
    const winners = r.winner.split("").map((c) => state.fourSeats[c]);
    return { over: true, winner: winners[0], winners, reason: r.reason };
  }
  return { over: true, winner: state.fourSeats[r.winner], ranking: r.ranking.map((c) => state.fourSeats[c]), points: r.points, reason: r.reason };
}
