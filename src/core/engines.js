// Two shared Stockfish instances: one for playing (bots, hints), one for analysis/review.
import { Engine } from "../engine.js";

let play = null, analysis = null;
export function playEngine() {
  if (!play) play = new Engine();
  return play;
}
export function analysisEngine() {
  if (!analysis) analysis = new Engine();
  return analysis;
}
