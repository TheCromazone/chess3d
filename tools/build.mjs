// Bundles the client and the server rules module into dist/
// (dist/ mirrors the deploy layout: public/ + game.js + logic.js + stockfish/ + design/).
// OUTDIR=<dir> builds somewhere else (parallel sandboxes); default is dist/.
import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.OUTDIR ? resolve(process.env.OUTDIR) : join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/main.js")],
  bundle: true, format: "iife", minify: true,
  target: ["es2020", "safari15"],
  outfile: join(dist, "game.js"),
  logLevel: "info",
});

// the Crazyhouse engine runs in its own worker
await build({
  entryPoints: [join(root, "src/zh-worker.js")],
  bundle: true, format: "iife", minify: true,
  target: ["es2020", "safari15"],
  outfile: join(dist, "zh-worker.js"),
  logLevel: "warning",
});

// server rules module: the platform validator statically scans for `export const meta`
// etc., so bundle chess.js as an inline IIFE library and keep the six exports inline.
{
  const lib = await build({
    stdin: {
      contents: 'export { Chess } from "chess.js";',
      resolveDir: root,
    },
    bundle: true, format: "iife", globalName: "__ChessLib", minify: true,
    target: ["es2022"], write: false,
  });
  const libCode = lib.outputFiles[0].text;
  // the Crazyhouse rules go in inline too (no imports may survive), minus their own exports
  const zhCode = readFileSync(join(root, "src/core/zh.js"), "utf8")
    .replace(/^import\s.*chess\.js.*$/m, "")
    .replace(/^export (const|class|function) /gm, "$1 ");
  // the other variants' rules (no imports of their own) go in wrapped, so their names stay private
  const vxCode = readFileSync(join(root, "src/core/vx.js"), "utf8").replace(/^export (const|class|function) /gm, "$1 ");
  const srcCode = readFileSync(join(root, "src/logic-src.js"), "utf8")
    .replace(/^import\s.*chess\.js.*$/m, "const { Chess } = __ChessLib;")
    .replace(/^import\s.*zh\.js.*$/m, zhCode)
    .replace(/^import\s*\{([^}]*)\}\s*from\s*"\.\/core\/vx\.js";$/m, (_, names) => `const {${names}} = (() => {\n${vxCode}\nreturn {${names}};\n})();`);
  writeFileSync(join(dist, "logic.js"), libCode + "\n" + srcCode);
  console.log("logic.js assembled (inline exports)");
}

// Stockfish 18 lite (single-threaded WASM, GPLv3): the worker script finds its .wasm
// by swapping the extension of its own URL, so both files ship side by side.
{
  const sfDir = join(root, "node_modules/stockfish/bin");
  mkdirSync(join(dist, "stockfish"), { recursive: true });
  for (const f of ["stockfish-18-lite-single.js", "stockfish-18-lite-single.wasm"]) {
    copyFileSync(join(sfDir, f), join(dist, "stockfish", f));
  }
  copyFileSync(join(root, "node_modules/stockfish/Copying.txt"), join(dist, "stockfish", "COPYING.txt"));
}

cpSync(join(root, "public"), dist, { recursive: true });
cpSync(join(root, "design"), join(dist, "design"), { recursive: true });

// stamp the service worker with a content hash so each deploy gets a fresh cache
{
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name !== "sw.js") hash.update(name).update(readFileSync(p));
    }
  };
  walk(dist);
  const v = hash.digest("hex").slice(0, 12);
  const swPath = join(dist, "sw.js");
  writeFileSync(swPath, readFileSync(swPath, "utf8").replace("__BUILD_HASH__", v));
  console.log("service worker version " + v);
}
console.log("build complete -> " + dist);
