// Web Worker for the variant bots (Crazyhouse; Duck / Fog of War / Giveaway / Atomic / Horde;
// 4-Player Chess), so a search never freezes the board.
import { search } from "./core/zh-engine.js";
import { vxSearch } from "./core/vx-engine.js";
import { fpSearch } from "./core/fp-engine.js";

self.onmessage = (e) => {
  const { id, state, opts, kind } = e.data || {};
  let move = null;
  try { move = kind === "vx" ? vxSearch(state, opts) : kind === "fp" ? fpSearch(state, opts) : search(state, opts); } catch (err) { console.error(err); }
  self.postMessage({ id, move });
};
