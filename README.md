# Chess 3D

Full chess on a rendered 3D board. Play **online with a friend**, **against the computer**, or **local pass-and-play** — on phone or desktop.

**▶ Play it live:** https://chess3d-five.vercel.app/

## Features

- 3D board and pieces rendered with [Three.js](https://threejs.org/); full rules and move validation via [chess.js](https://github.com/jhlywa/chess.js).
- Three ways to play: online multiplayer over a shared room server, a Web Worker AI opponent, or pass-and-play on one device.
- Touch and mouse controls; responsive for mobile and desktop.
- WebAudio-synthesized sound effects.

## Develop

    npm install
    npm run serve    # local dev server
    npm run build    # bundle src/ to dist/ with esbuild
    npm test         # chess-logic tests

Built with esbuild; the move-validation logic is a standalone module so the same engine powers the hosted online mode.
