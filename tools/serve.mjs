// Tiny static server for local preflight (serves dist/ under a subpath like production).
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = process.env.ROOT ? resolve(process.env.ROOT) : join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = Number(process.env.PORT || 8123);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".csv": "text/csv", ".md": "text/markdown", ".json": "application/json",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};
const PREFIX = "/s/chess3d"; // simulate production subpath serving

createServer(async (req, res) => {
  try {
    // dev-only: accept data-URL uploads for marketing captures
    if (req.method === "POST" && req.url.startsWith("/save")) {
      const name = new URL(req.url, "http://x").searchParams.get("name").replace(/[^a-z0-9_-]/gi, "");
      let body = "";
      for await (const chunk of req) body += chunk;
      const b64 = body.replace(/^data:image\/png;base64,/, "");
      const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "marketing");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name + ".png"), Buffer.from(b64, "base64"));
      res.writeHead(200); res.end("saved " + name);
      return;
    }
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.startsWith(PREFIX)) path = path.slice(PREFIX.length);
    if (path === "" || path === "/") path = "/index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, () => console.log(`serving ${root} at http://localhost:${PORT}/s/chess3d/`));
