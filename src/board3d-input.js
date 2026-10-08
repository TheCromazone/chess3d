// Pointer gestures for Board3D (mouse, pen, touch).
//
//  left press on a piece where canDrag(sq)  -> piece gesture: tap if released before moving,
//                                              piece drag once it moves past DRAG_PX
//                                              (OrbitControls never sees this pointer)
//  left press anywhere else                 -> tap if it stays within TAP_PX, otherwise it's
//                                              OrbitControls' orbit gesture
//  second finger                            -> pinch (OrbitControls); cancels a pending tap
//  right press (mouse)                      -> user drawing: circle (release on same square)
//                                              or arrow (release elsewhere), brush by modifier
//
// Listeners run in the capture phase on the canvas so they fire before OrbitControls' own
// listeners; stopImmediatePropagation() hides a pointer from OrbitControls.
import { BRUSHES } from "./board3d-themes.js";

const DRAG_PX = { mouse: 3, pen: 6, touch: 9 };

function scrollParent(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}
const TAP_PX = { mouse: 6, pen: 9, touch: 14 };

function brushFor(e) {
  if (e.shiftKey) return BRUSHES.red;
  if (e.altKey) return BRUSHES.blue;
  if (e.ctrlKey || e.metaKey) return BRUSHES.orange;
  return BRUSHES.green;
}

export class BoardInput {
  constructor(board, canvas) {
    this.b = board;
    this.c = canvas;
    this.g = null;               // the active primary gesture
    this.down = new Set();       // pointer ids currently pressed on the canvas
    this.swallowed = new Set();  // pointer ids hidden from OrbitControls
    this._hoverCursor = "";
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onCancel = this._onCancel.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this._onContext = (e) => e.preventDefault();
    const cap = { capture: true };
    canvas.addEventListener("pointerdown", this._onDown, cap);
    canvas.addEventListener("pointermove", this._onMove, cap);
    canvas.addEventListener("pointerup", this._onUp, cap);
    canvas.addEventListener("pointercancel", this._onCancel, cap);
    canvas.addEventListener("pointerleave", this._onLeave);
    canvas.addEventListener("wheel", this._onWheel, { capture: true, passive: true });
    canvas.addEventListener("contextmenu", this._onContext);
  }

  dispose() {
    const c = this.c, cap = { capture: true };
    c.removeEventListener("pointerdown", this._onDown, cap);
    c.removeEventListener("pointermove", this._onMove, cap);
    c.removeEventListener("pointerup", this._onUp, cap);
    c.removeEventListener("pointercancel", this._onCancel, cap);
    c.removeEventListener("pointerleave", this._onLeave);
    c.removeEventListener("wheel", this._onWheel, cap);
    c.removeEventListener("contextmenu", this._onContext);
  }

  // abandon any gesture (board deactivated / position replaced)
  reset() {
    const g = this.g;
    this.g = null;
    if (g && g.kind === "piece" && g.dragging) this.b._dragEnd(true);
    if (g && g.kind === "draw") this.b._setDrawPreview(null);
    this._setCursor("");
  }

  _setCursor(c) {
    if (this._hoverCursor !== c) { this._hoverCursor = c; this.c.style.cursor = c; }
  }

  _swallow(e) {
    e.stopImmediatePropagation();
    this.swallowed.add(e.pointerId);
  }

  _onDown(e) {
    const b = this.b;
    // a primary pointer starts a fresh interaction: forget ids whose release we never saw
    if (e.isPrimary) { this.down.clear(); this.swallowed.clear(); if (this.g) this.reset(); }
    this.down.add(e.pointerId);
    // capture every tracked pointer so its release always reaches us (OrbitControls only
    // captures when it is enabled, which it isn't in top-down mode)
    try { this.c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!b._active) { this._swallow(e); return; }
    if (b._idle) { b.setIdle(false); this._swallow(e); return; }

    if (this.g) {
      const g = this.g;
      if (g.kind === "piece") {
        // a second finger while pressing a piece: abandon the press (drag keeps going)
        if (!g.dragging) { this.g = null; }
        this._swallow(e);
        return;
      }
      if (g.kind === "draw") { this._swallow(e); return; }
      if (g.kind === "tap") { g.cancelled = true; b._userOrbited = true; return; } // pinch: OrbitControls
    }
    if (this.down.size > 1) return; // multi-touch gestures belong to OrbitControls

    const type = e.pointerType || "mouse";
    if (e.button === 2) {
      this._swallow(e);
      const sq = b._pickSquare(e.clientX, e.clientY, type);
      if (!sq) return;
      this.g = { kind: "draw", id: e.pointerId, from: sq, to: sq, color: brushFor(e) };
      return;
    }
    if (e.button !== 0) return; // middle button: OrbitControls dolly

    const sq = b._pickSquare(e.clientX, e.clientY, type);
    if (sq && b._hasPiece(sq) && b.canDrag && b.canDrag(sq)) {
      this._swallow(e);
      e.preventDefault();
      this.g = { kind: "piece", id: e.pointerId, sq, x0: e.clientX, y0: e.clientY, type, dragging: false };
      return;
    }
    // tap or orbit: OrbitControls sees this pointer; we only decide on release
    this.g = { kind: "tap", id: e.pointerId, sq, x0: e.clientX, y0: e.clientY, type, moved: false, cancelled: false };
  }

  _onMove(e) {
    const b = this.b;
    const g = this.g;
    if (!g || g.id !== e.pointerId) {
      if (!g && e.pointerType === "mouse" && e.buttons === 0 && b._active && !b._idle) {
        const sq = b._pickSquare(e.clientX, e.clientY, "mouse");
        this._setCursor(sq && b._hasPiece(sq) && b.canDrag && b.canDrag(sq) ? "grab" : "");
      }
      return;
    }
    const dist = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
    if (g.kind === "piece") {
      if (!g.dragging) {
        if (dist < (DRAG_PX[g.type] || 4)) return;
        g.dragging = true;
        this._setCursor("grabbing");
        if (!b._dragBegin(g.sq, e.clientX, e.clientY, g.type)) { this.g = null; return; }
      }
      b._dragMove(e.clientX, e.clientY);
    } else if (g.kind === "tap") {
      if (g.type === "touch" && this.down.size === 1) {
        // a one-finger swipe off the pieces scrolls the page (the canvas blocks native scrolling)
        if (dist > (TAP_PX.touch || 8)) g.moved = true;
        if (g.moved) {
          if (g.scroller === undefined) g.scroller = scrollParent(this.c);
          if (g.scroller) g.scroller.scrollTop -= e.clientY - (g.lastY ?? e.clientY);
        }
        g.lastY = e.clientY;
        return;
      }
      if (dist > (TAP_PX[g.type] || 8)) { g.moved = true; b._userOrbited = true; }
    } else if (g.kind === "draw") {
      const sq = b._pickSquare(e.clientX, e.clientY, g.type || "mouse");
      if (sq && sq !== g.to) {
        g.to = sq;
        b._setDrawPreview(sq !== g.from ? { from: g.from, to: sq, color: g.color } : null);
      }
    }
  }

  _onUp(e) {
    this.down.delete(e.pointerId);
    if (this.swallowed.has(e.pointerId)) {
      this.swallowed.delete(e.pointerId);
      e.stopImmediatePropagation();
    }
    const g = this.g;
    if (!g || g.id !== e.pointerId) return;
    this.g = null;
    const b = this.b;
    if (g.kind === "piece") {
      if (g.dragging) { this._setCursor("grab"); b._dragEnd(false); }
      else { b.clearUserDrawings(); b._tap(g.sq); }
    } else if (g.kind === "tap") {
      if (!g.moved && !g.cancelled) {
        b.clearUserDrawings();
        if (g.sq) b._tap(g.sq);
      }
    } else if (g.kind === "draw") {
      b._setDrawPreview(null);
      if (g.to === g.from) b._toggleCircle(g.from, g.color);
      else b._toggleArrow(g.from, g.to, g.color);
    }
  }

  _onCancel(e) {
    this.down.delete(e.pointerId);
    if (this.swallowed.has(e.pointerId)) {
      this.swallowed.delete(e.pointerId);
      e.stopImmediatePropagation();
    }
    const g = this.g;
    if (!g || g.id !== e.pointerId) return;
    this.reset();
  }

  _onLeave(e) {
    if (e.pointerType === "mouse" && !this.g) this._setCursor("");
  }

  _onWheel() {
    if (this.b._idle) this.b.setIdle(false);
    else this.b._userOrbited = true;
  }
}
