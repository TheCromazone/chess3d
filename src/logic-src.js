// Online chess rules module — bundled with chess.js into a self-contained logic.js
// (six-export contract; no imports or timers survive in the bundle output).
import { Chess } from "chess.js";

export const meta = { game: "Chess 3D", minPlayers: 2, maxPlayers: 2 };

const TIME_CONTROLS = { "1+0": [60, 0], "3+2": [180, 2], "5+0": [300, 0], "10+0": [600, 0], "15+10": [900, 10], "inf": null };
const VERSION = 3;           // v2: chat / takebacks / abort / custom clocks; v3: daily deadlines
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
    return { ok: true };
  }
  if (state.phase === "config") return { ok: false, error: "waiting for White to choose the time control" };
  if (finished) return { ok: false, error: "the game is over" };

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
    const game = rebuild(state);
    if (game.isGameOver()) return { ok: false, error: "the game is over" };
    const opp = color === "w" ? "b" : "w";
    let remaining = state.clock[opp];
    if (game.turn() === opp && state.clock.lastAt !== null) remaining -= Date.now() - state.clock.lastAt;
    if (remaining > 0) return { ok: false, error: "opponent still has time" };
    return { ok: true };
  }
  return { ok: false, error: "unknown action" };
}

export function applyAction(state, playerId, action) {
  const color = colorOf(state, playerId);
  const now = Date.now();

  if (action.t === "chat") {
    const msg = { c: color, text: action.text.trim().slice(0, 200), at: now };
    return { ...state, chat: [...(state.chat || []), msg].slice(-60) };
  }

  if (action.t === "config") {
    const { tc, perMove } = parseTc(action.tc);
    return {
      ...state,
      phase: "playing",
      tcKey: action.tc,
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
        return { ...state, clock, flagged };
      }
      // daily games: the mover gets their full allowance back for their next turn
      clock = { ...clock, [color]: state.tc.perMove ? state.tc.initial * 1000 : remaining + state.tc.inc * 1000, lastAt: now };
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

  if (action.t === "abort") return { ...state, aborted: true, clock: { ...state.clock, lastAt: null } };
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

  if (action.t === "resign") return { ...state, resigned: color };
  if (action.t === "draw-offer") return { ...state, drawOffer: color };
  if (action.t === "draw-accept") return { ...state, agreedDraw: true, drawOffer: null };
  if (action.t === "draw-decline") return { ...state, drawOffer: null };

  if (action.t === "flag") {
    const opp = color === "w" ? "b" : "w";
    // timeout vs bare king is a draw (standard rule, simplified to lone-king check)
    const game = rebuild(state);
    const board = game.board().flat().filter(Boolean);
    const claimerHasMaterial = board.some(p => p.color === color && p.type !== "k");
    if (!claimerHasMaterial) return { ...state, timeoutDraw: true, clock: { ...state.clock, [opp]: 0, lastAt: null } };
    return { ...state, flagged: opp, clock: { ...state.clock, [opp]: 0, lastAt: null } };
  }
  return state;
}

export function isGameOver(state) {
  if (state.phase === "config") return { over: false };
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

export function viewFor(state, _playerId) {
  return { ...state, serverNow: Date.now() }; // chess has no hidden information
}
