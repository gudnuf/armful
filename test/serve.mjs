// Tiny static server for the page tests: /<slug>/data.json and /<slug>/fx/*
// come from test/fixture, everything else under /<slug>/ from site/.
// Loopback only; a path (after symlinks) must stay inside the root it was served from.
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { join, normalize, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

export function serve({ site = join(ROOT, "site"), fixture = join(ROOT, "test", "fixture") } = {}) {
  const server = createServer(async (req, res) => {
    let rel;
    try {
      const m = new URL(req.url, "http://x").pathname.match(/^\/[^/]+\/(.*)$/);
      if (!m) { res.writeHead(404).end(); return; }
      rel = normalize(decodeURIComponent(m[1]) || "index.html");
    } catch { res.writeHead(400).end(); return; }
    if (rel.startsWith("..") || rel.includes("\0")) { res.writeHead(404).end(); return; }
    const dir = rel === "data.json" || rel.startsWith("fx" + sep) ? fixture : site;
    try {
      const [root, file] = await Promise.all([realpath(dir), realpath(join(dir, rel))]);
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch { if (!res.headersSent) res.writeHead(404).end(); }
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () =>
    res({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}
