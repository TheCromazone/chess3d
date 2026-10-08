// In-game coach for bot games: a quick Stockfish verdict on each of your moves, and the eval.
import { createChess } from "./chess960.js";
import { analysisEngine } from "./engines.js";
import { winPercent } from "../engine.js";

// Classify one move by expected-points loss (same thresholds as Game Review, shallower search).
export async function judgeMove(fenBefore, uci) {
  const eng = analysisEngine();
  const before = await eng.analyze(fenBefore, { movetime: 260, multipv: 2 });
  if (!before || !before.lines || !before.lines.length) return null;
  const mover = createChess(fenBefore).turn();
  const best = before.lines[0];
  const bestUci = best.pv && best.pv[0];
  const after = createChess(fenBefore);
  const mv = after.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  let scoreAfter;
  if (after.isCheckmate()) scoreAfter = { mate: 0, winner: mover };
  else if (after.isGameOver()) scoreAfter = { cp: 0 };
  else {
    const r = await eng.analyze(after.fen(), { movetime: 260 });
    scoreAfter = r && r.lines && r.lines[0] ? r.lines[0].scoreWhite : null;
  }
  if (!scoreAfter) return null;
  const epBest = winPercent(best.scoreWhite, mover) / 100;
  const epPlayed = uci === bestUci ? epBest : winPercent(scoreAfter, mover) / 100;
  const loss = Math.max(0, epBest - epPlayed);
  let cls;
  if (uci === bestUci) cls = "best";
  else if (loss < 0.02) cls = "excellent";
  else if (loss < 0.05) cls = "good";
  else if (loss < 0.10) cls = "inaccuracy";
  else if (loss < 0.20) cls = "mistake";
  else cls = "blunder";
  const bestSan = best.san && best.san[0];
  return { cls, san: mv.san, bestSan, bestUci, scoreAfter, loss };
}

const PRAISE = { best: ["Best move!", "That's the engine's choice.", "Spot on."], excellent: ["Excellent move.", "Very accurate."], good: ["Good move.", "Solid."] };
export function coachLine(j) {
  if (!j) return null;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  if (PRAISE[j.cls]) return `${j.san}: ${pick(PRAISE[j.cls])}`;
  const what = j.cls === "inaccuracy" ? "an inaccuracy" : j.cls === "mistake" ? "a mistake" : "a blunder";
  return `${j.san} is ${what}.${j.bestSan ? ` ${j.bestSan} was better.` : ""}`;
}
