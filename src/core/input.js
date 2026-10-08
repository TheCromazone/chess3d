// Board interaction shared by every mode: click-to-move, drag-and-drop, promotion, premoves.
// The owner supplies the interactive position and decides what a move does.
import { Chess } from "chess.js";
import { Chess960 } from "./chess960.js";
import { getSettings } from "../store.js";
import { promotionModal } from "../ui/components.js";
import { SFX } from "../audio.js";

export class MoveInput {
  /**
   * opts.getChess(): chess.js instance for the position the user may move in (null = no input)
   * opts.canMove(color): may the user move pieces of `color` right now?
   * opts.premoveColor(): color the user may premove for while waiting (null = no premoves)
   * opts.onMove({from,to,promotion}, {instant}): perform the move (owner animates the board)
   * opts.onSelect(sq)?: notified on selection changes
   */
  constructor(app, opts) {
    this.app = app;
    this.o = opts;
    this.sel = null;
    this.premove = null;
  }

  get board() { return this.app.board; }

  handlers() {
    return {
      onSquareTap: (sq) => this.tap(sq),
      canDrag: (sq) => this.canDrag(sq),
      onDragStart: (sq) => { this._dragFrom = sq; this.select(sq); },
      onDrop: (from, to) => this.drop(from, to),
    };
  }
  bind() { this.app.bindBoard(this.handlers()); }

  _mover() {
    const c = this.o.getChess();
    if (!c) return null;
    const turn = c.turn();
    if (this.o.canMove(turn)) return { chess: c, color: turn, pre: false };
    const pc = this.o.premoveColor ? this.o.premoveColor() : null;
    if (pc && getSettings().premoves && pc !== turn) return { chess: premoveChess(c, pc), color: pc, pre: true };
    return null;
  }

  canDrag(sq) {
    if (!getSettings().dragMoves) return false;
    const m = this._mover();
    if (!m) return false;
    const p = m.chess.get(sq);
    return !!p && p.color === m.color;
  }

  select(sq) {
    const m = this._mover();
    if (!m) return;
    const p = m.chess.get(sq);
    if (!p || p.color !== m.color) { this.clear(); return; }
    this.sel = sq;
    this.board.setSelected(sq);
    if (getSettings().showLegal || m.pre) {
      const ms = m.chess.moves({ square: sq, verbose: true });
      this.board.showMoves(ms.filter(x => !x.captured).map(x => x.to), ms.filter(x => x.captured).map(x => x.to));
    } else this.board.showMoves([], []);
    if (this.o.onSelect) this.o.onSelect(sq);
  }

  clear() {
    this.sel = null;
    if (this.board) this.board.clearHints();
  }

  tap(sq) {
    const m = this._mover();
    if (!m) { this.clear(); return; }
    // a piece dragged and dropped back on its own square stays selected (chess.com behaviour)
    if (this._dragFrom === sq && this.sel === sq) { this._dragFrom = null; return; }
    this._dragFrom = null;
    if (this.sel && this.sel !== sq) {
      const cands = m.chess.moves({ square: this.sel, verbose: true }).filter(x => x.to === sq);
      if (cands.length) { this._commit(m, this.sel, sq, cands, false); return; }
    }
    if (this.sel === sq) { this.clear(); return; }
    const p = m.chess.get(sq);
    if (p && p.color === m.color) { this.select(sq); return; }
    if (this.premove && !p) { this.cancelPremove(); }
    this.clear();
  }

  drop(from, to) {
    this._dragFrom = null;
    const m = this._mover();
    if (!m || !to) { this.clear(); return false; }
    const cands = m.chess.moves({ square: from, verbose: true }).filter(x => x.to === to);
    if (!cands.length) {
      if (from !== to) SFX.illegal();
      this.select(from);
      return false;
    }
    const needsPromo = cands.some(x => x.promotion);
    if (m.pre || (needsPromo && !getSettings().autoQueen)) {
      this._commit(m, from, to, cands, false);
      return false;
    }
    this._commit(m, from, to, cands, true);
    return true;
  }

  async _commit(m, from, to, cands, instant) {
    this.clear();
    let promotion;
    if (cands.some(x => x.promotion)) {
      promotion = getSettings().autoQueen || m.pre ? "q" : await promotionModal(m.color);
      if (!promotion) return;
    }
    if (m.pre) {
      this.premove = { from, to, promotion };
      this.board.setPremove(from, to);
      return;
    }
    this.o.onMove({ from, to, promotion }, { instant });
  }

  cancelPremove() {
    this.premove = null;
    if (this.board) this.board.setPremove(null, null);
  }

  // Call when it becomes the user's turn; plays the queued premove if it's legal.
  tryPremove() {
    const pm = this.premove;
    if (!pm) return false;
    this.cancelPremove();
    const c = this.o.getChess();
    if (!c) return false;
    const legal = c.moves({ square: pm.from, verbose: true }).some(x => x.to === pm.to);
    if (!legal) return false;
    this.o.onMove(pm, { instant: false });
    return true;
  }
}

// Position with `color` to move and en passant cleared, for generating premove candidates.
function premoveChess(chess, color) {
  const parts = chess.fen().split(" ");
  parts[1] = color;
  parts[3] = "-";
  if (chess instanceof Chess960) return new Chess960(parts.join(" "));
  const c = new Chess();
  try { c.load(parts.join(" "), { skipValidation: true }); } catch { return chess; }
  return c;
}
