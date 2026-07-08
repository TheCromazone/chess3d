# Chess 3D — design summary

**Experience formula:** The player feels like they are sitting at a real tournament board because the game presents tactile, instantly-responsive 3D pieces while enforcing every rule of chess fairly on every device.

## Profile
- Time: turn-based with optional real-time clocks (bullet 1+0, blitz 3+2/5+0, rapid 10+0/15+10, unlimited)
- Space: discrete 8×8 rendered in continuous 3D (Three.js/WebGL)
- Agency: disembodied hand; Conflict: vs players and vs system (AI)
- Players: solo (vs AI), local versus (pass & play), **online versus** (platform rooms via logic.js)
- Outcome: win / lose / draw (checkmate, resignation, timeout, stalemate, threefold, 50-move, insufficient material)
- Engagement: calculation (primary), clock pressure (secondary)
- Delivery: desktop + mobile browsers; touch + mouse first-class, keyboard square-navigation; all strings external in strings.js

## Rules engine
chess.js (vendored, bundled — no CDN) powers client and server logic.js identically: legal move generation, SAN notation, FEN, all draw rules.

## Modes
1. **vs Computer** — 4 levels (minimax + alpha-beta + piece-square tables in a Web Worker; level 1 adds blunder noise), choose side + time control, undo allowed.
2. **Pass & Play** — same screen, board auto-flip optional.
3. **Online** — invite link, server-authoritative logic.js (six-export contract), white picks time control in a config phase, claim-timeout action for flags, resign + draw offers.

## STYLE FORMULA (approved — pinned by brief's chess.com reference)
Polished physically-based 3D render with soft studio reflections; classic Staunton chess silhouettes with smoothly turned profiles and felt-lined bases; board in warm walnut and cream maple squares with a dark espresso frame, white pieces in warm ivory boxwood tones, black pieces in deep ebony contrasting the board, interactive move targets marked with luminous emerald glow; calm tournament-hall mood, warm key light with cool ambient fill; high contrast between pieces and squares, clean readable silhouettes, consistent three-quarter isometric view across all assets.

Engine lighting derived from formula: warm key directional light (#fff1e0) with 1024 shadow map, cool hemisphere fill (#b8c8e0 low intensity), emerald (#34d27b) legal-move markers, amber (#e8c35a) last-move tint, red (#e05548) check tint.

## Interface (chess.com parity)
Clocks top/bottom, captured trays + material score, SAN move list, buttons: new game, flip board, resign, offer draw, undo (local), sound/music toggles. Promotion picker modal. Game-over modal with reason + rematch. Menu: mode select → options → play. Invite-link banner in online waiting phase.
