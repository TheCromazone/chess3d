# BoardView contract

Every board renderer (`Board3D` in `src/board3d.js`, `Board2D` in `src/board2d.js`) implements
this exact interface so game/analysis/puzzle controllers can drive either one. Squares are
algebraic strings (`"e4"`). Colors are `"w"` / `"b"`. Moves are chess.js verbose move objects
(`{ from, to, color, piece, captured?, promotion?, flags, san }`; flags contains `"e"` en passant,
`"k"`/`"q"` castling, `"p"` promotion, `"c"` capture).

## Construction

```js
const board = new Board3D(containerEl);   // or new Board2D(containerEl)
```

The board owns everything it renders inside `containerEl` and must size itself to the container
(listen to `ResizeObserver` on the container, not only `window.resize`). It must never touch DOM
outside `containerEl` (no global key handlers, no `document.body` children except while dragging
in 2D if absolutely necessary).

`board.setActive(bool)` pauses or resumes rendering and input (an inactive 3D board stops its animation
loop; an inactive 2D board is simply hidden by the app). `board.destroy()` releases everything.

## Position

- `syncFromBoard(board2d)`: full reconcile from `chess.board()` (8×8, rank 8 first). No animation.
- `animateMove(mv, { instant = false } = {}, onDone)`: applies one verbose move to the rendered
  position, handling captures (including en passant), castling (rook moves too), and promotion
  (piece swaps to the promoted type). `instant: true` applies it with no animation; it's used right
  after a successful drag-drop, where the piece is already under the cursor.
  Animation duration comes from the `animMs` setting.

## Orientation

- `viewSide(color, animate = true)`: puts `color` at the bottom.
- `orientation`: getter that returns `"w"` | `"b"` (which side is currently at the bottom).

## Highlights (all idempotent; passing null/[] clears)

- `setLastMove(from, to)`: from- and to-square tint.
- `setCheck(sq)`: king-in-check tint.
- `setSelected(sq)`: selected-square tint.
- `showMoves(quietSquares, captureSquares)`: legal-move dots and capture rings.
- `clearHints()`: same as `showMoves([], [])` + `setSelected(null)`.
- `setPremove(from, to)`: premove tint (distinct color, e.g. red/coral).
- `setMarks([{ sq, color }])`: programmatic square tints (hint square, puzzle right/wrong
  flash, review highlights). `color` is a CSS color string (e.g. `"rgba(52,210,123,.5)"`).
- `setArrows([{ from, to, color }])`: programmatic arrows (engine best move, hints). Color is a CSS
  color string; alpha is respected.
- `clearUserDrawings()`: clears the user's own right-click drawings.

## User drawings (internal to the board)

Right-click (mouse button 2) on a square toggles a circle on it. Right-drag from A to B toggles an
arrow. Modifiers pick the color: none = green, Shift = red, Alt = blue, Ctrl/Meta = orange
(lichess convention). Any left click/tap on the board clears all user drawings. The context menu
is suppressed on the board. User drawings are drawn in addition to `setArrows` / `setMarks`.

## Input (callbacks set by the controller; any may be null)

- `onSquareTap(sq)`: click/tap on a square (select / click-to-move). Fired on pointer-up for a
  short press with no drag.
- `canDrag(sq) -> bool`: asked on pointer-down over a piece. If true, the press becomes a piece drag.
  If false (or null), in 3D the press orbits the camera; in 2D nothing happens.
- `onDragStart(sq)`: drag began (controller typically selects the square and shows legal moves).
- `onDrop(from, to) -> bool`: drag released over square `to` (`to` is null if off-board). Return
  true if the controller accepted it, in which case the controller will immediately call
  `animateMove(mv, { instant: true })` itself, so the board must just put the dragged piece back at
  `from` (no animation) and let `animateMove` place it. Return false to snap it back (short animation).
  Dropping on the origin square is a "tap" (fires `onSquareTap(from)` instead of `onDrop`).
- While dragging, the piece follows the pointer (3D: lifted above the board plane under the
  cursor; 2D: centered under the cursor, slightly enlarged). The square under the pointer gets a
  hover outline.

## Settings

`applySettings(s)` with any subset of:

- `boardTheme`: a string id (see the renderer's exported `BOARD_THEMES` list: `[{ id, name }]`).
- `pieceTheme`: a string id (see the exported `PIECE_THEMES`).
- `coords`: bool, show rank/file coordinates.
- `animMs`: number, base move-animation duration in ms (0 means instant).
- `cameraMode` (3D only): `"3d"` (free orbit, default) | `"top"` (straight-down, no orbit).

Both modules export `BOARD_THEMES` and `PIECE_THEMES` arrays of `{ id, name, swatch }`, where `swatch`
is a CSS color or gradient for a settings preview chip.
