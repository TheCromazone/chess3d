# Chess 3D — numeric thresholds (fixed before code)

- Frame budget: 60 fps on a mid-range phone (worst case: full 32-piece scene + highlights + move animation). Frame time ≤ 16 ms.
- devicePixelRatio cap: 1.75 (mobile GPUs).
- Draw calls: ≤ 60 total (board merged to 2 meshes, 32 piece meshes sharing 6 geometries × 2 materials, instanced move markers, 1 table, 1 frame).
- Shadow map: single 1024×1024 directional light; no other shadow casters beyond pieces + board.
- Zero per-frame allocations in the render loop (reused vectors, preallocated raycaster).
- Piece geometry: ≤ 3,500 triangles per piece type (lathe segments 48 radial / profile ~24 points); total scene ≤ 120k triangles.
- Textures: 256×256 procedural wood (power of two, mipmapped).
- Move animation: 220 ms ease; capture sink 180 ms; never blocks input for the next legal action.
- AI think caps: L1 120 ms, L2 300 ms, L3 800 ms, L4 1600 ms (Web Worker; UI never blocks).
- Low-time warning: tick sound + red clock at ≤ 10 s (only for controls ≤ 10 min).
- Input tolerance: tap targets ≥ 44 px equivalent; square picking via raycast against full square top face, not piece mesh only.
- Zip budget: ≤ 25 MiB per asset (platform bound); target total zip ≤ 10 MiB including audio.
- Online: every action server-validated by logic.js; client disables out-of-turn input; reconnect restores full view from state broadcast.
