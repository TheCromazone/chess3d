// Web Worker for the Crazyhouse bots, so a search never freezes the board.
import { search } from "./core/zh-engine.js";

self.onmessage = (e) => {
  const { id, state, opts } = e.data || {};
  let move = null;
  try { move = search(state, opts); } catch (err) { console.error(err); }
  self.postMessage({ id, move });
};
