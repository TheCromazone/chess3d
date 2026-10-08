// Builds the Board2D sandbox into <outdir> (default: $OUTDIR or ./.sandbox2d-out, never dist/).
//   node tools/sandbox2d/build.mjs /tmp/sandbox2d
//   ROOT=/tmp/sandbox2d PORT=8132 node tools/serve.mjs   -> http://localhost:8132/s/chess3d/
import { build } from "esbuild";
import { mkdirSync, copyFileSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = resolve(process.argv[2] || process.env.OUTDIR || join(root, ".sandbox2d-out"));
if (out === resolve(root, "dist")) throw new Error("refusing to build the sandbox into dist/");

mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "main.js")],
  bundle: true, format: "iife", sourcemap: "inline",
  target: ["es2020", "safari15"],
  outfile: join(out, "main.js"),
  logLevel: "info",
});
copyFileSync(join(here, "index.html"), join(out, "index.html"));
cpSync(join(root, "public/assets"), join(out, "assets"), { recursive: true });
console.log("sandbox2d -> " + out);
