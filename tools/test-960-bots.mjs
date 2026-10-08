// Bots play Chess960 games end to end through the real Stockfish (UCI_Chess960 + king-takes-rook castling).
import { spawn } from "node:child_process";
import { Engine } from "../src/engine.js";
import { BOTS, botMove } from "../src/bots.js";
import { Chess960, chess960Fen } from "../src/core/chess960.js";

function nodeTransport() {
  const p = spawn(process.execPath, [new URL("../node_modules/stockfish/bin/stockfish-18-lite-single.js", import.meta.url).pathname]);
  let buf = "", cb = () => {};
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { cb(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
  return { post: (l) => p.stdin.write(l + "\n"), onLine: (f) => { cb = f; }, terminate: () => p.kill() };
}

const engine = new Engine({ createTransport: nodeTransport });
let castles = 0, failures = 0, plies = 0;
const pairs = [[BOTS[0], BOTS[3]], [BOTS[6], BOTS[10]], [BOTS[12], BOTS[15]]];
for (const [a, b] of pairs) {
  const fen = chess960Fen(Math.floor(Math.random() * 960));
  const c = new Chess960(fen);
  const hist = [];
  for (let k = 0; k < 70 && !c.isGameOver(); k++) {
    const bot = c.turn() === "w" ? a : b;
    try {
      const mv = await botMove(engine, c.fen(), bot, { history: hist, startFen: fen, movetime: 60 });
      const played = c.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      if (played.castle960) castles++;
      hist.push(played.from + played.to + (played.promotion || ""));
      plies++;
    } catch (e) { console.log("FAIL", a.name, "vs", b.name, e.message, c.fen()); failures++; break; }
  }
  console.log(`${a.name} vs ${b.name} from ${fen.split(" ")[0].split("/")[0]}: ${c.history().length} plies, ${c.isCheckmate() ? "mate" : c.isDraw() ? "draw" : "unfinished"}`);
}
engine.terminate();
console.log(`${plies} plies, ${castles} castles, ${failures} failures`);
process.exit(failures ? 1 : 0);
