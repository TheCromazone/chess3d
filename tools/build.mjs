// Bundles the client, the AI worker, and the server rules module into dist/
// (dist/ mirrors the deploy zip layout: index.html + logic.js + game.js + ai-worker.js + design/).
import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/main.js")],
  bundle: true, format: "iife", minify: true,
  target: ["es2020", "safari15"],
  outfile: join(dist, "game.js"),
  logLevel: "info",
});

await build({
  entryPoints: [join(root, "src/ai-worker.js")],
  bundle: true, format: "iife", minify: true,
  target: ["es2020", "safari15"],
  outfile: join(dist, "ai-worker.js"),
  logLevel: "info",
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
  const srcCode = readFileSync(join(root, "src/logic-src.js"), "utf8")
    .replace(/^import\s.*chess\.js.*$/m, "const { Chess } = __ChessLib;");
  writeFileSync(join(dist, "logic.js"), libCode + "\n" + srcCode);
  console.log("logic.js assembled (inline exports)");
}

copyFileSync(join(root, "public/index.html"), join(dist, "index.html"));
cpSync(join(root, "public/assets"), join(dist, "assets"), { recursive: true });
cpSync(join(root, "design"), join(dist, "design"), { recursive: true });
console.log("build complete -> dist/");
