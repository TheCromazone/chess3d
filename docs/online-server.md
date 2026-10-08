# Online play: the room server

Online games run in the Higgsfield project **Chess 3D** (`timely-ibis-513`): a Cloudflare Worker
whose rooms are Durable Objects at `/ws/<room>`. The project's `app/src/logic.js` is the referee;
it's built from `src/logic-src.js` into `dist/logic.js` by `npm run build`. The browser client
connects to `wss://timely-ibis-513.higgsfield.app/ws/<room>` (or its own origin when it's served
from the Higgsfield project) and only renders the state the server sends. Rooms persist in
Durable Object storage, which is what daily games rely on.

(The project was migrated from Higgsfield's older games engine at `timely-ibis-513.higgsfield.gg`,
which is being retired; its rooms are separate and aren't used any more.)

## Quick pairing (no server changes needed)

"Play online" sweeps numbered public rooms (`pool-<tc>-<2-minute bucket>-<n>`):
- It joins a room with one waiting player, which starts a game straight away.
- It skips rooms that are full, finished, or held by a player who has left. Abandoned seats are detected through the server's `connected` count.
- If none of those apply, it waits in the first empty room.

Names and ratings travel inside the player ID (`p-<random>.<name>.<rating>`), so opponents see
each other without any account system.

## Rules v2

`src/logic-src.js` now reports `view.v = 2` and adds:
- `chat`: messages up to 200 characters; players only, no spectators.
- `takeback-offer` / `takeback-accept` / `takeback-decline`.
- `abort`, allowed until both sides have moved.
- Custom time controls such as `"7+2"` or `"0.5+0"`, in addition to the presets.

Everything from v1 still behaves the same, so the current client works against either version.
The client turns chat, takebacks, abort and custom time controls on automatically when it sees
`view.v >= 2`. `npm test` covers the new actions (`tools/test-logic.mjs`).

To update the rules: copy `dist/logic.js` to the project's `app/src/logic.js`, run
`bun run build` and `bun run test` in `app/`, then deploy. Because the project was migrated,
its logic check reports `Date.now()` (used by the clocks) as a warning rather than an error.
