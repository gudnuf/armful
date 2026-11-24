#!/usr/bin/env node
// make-og: render the home page's link-preview card and touch icon, once, to committed PNGs.
//
//   node bin/make-og.mjs   (optionally under lockf/flock "$ARMFUL_CHROME_LOCK" on a shared machine)
//
// home/og/og.png               1200x630: the heap wordmark large on paper, the one line in
//                              Bricolage 700 below it. Nothing else: no photo, no face.
// home/og/apple-touch-icon.png 180x180: site/icon.svg (the paper heap on an ink squircle),
//                              on an ink ground so iOS's own corner mask never shows black.
//
// Headless Chrome (test/cdp.mjs) renders a page built here from site/mark.svg, site/icon.svg
// and the self-hosted woff2 (inlined as a data: URL: no request leaves the machine). The
// PNGs keep only their image chunks (IHDR, PLTE, tRNS, sRGB, IDAT, IEND): no text, no time,
// no metadata. bin/build-dist.mjs ships them; bin/check-no-private.sh allows exactly
// home/og/*.png with PNG bytes. Re-run only when the wordmark or the line changes.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "../test/cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "home", "og");
const LINE = "Armfuls of photos, finally findable.";
const INK = "#16231F", PAPER = "#FBFAF7";

const svg = (name) => readFileSync(join(ROOT, "site", name), "utf8").trim()
  .replace(/^<svg\b([^>]*)>/, (_, a) => `<svg${a.replace(/\s(width|height)="[^"]*"/g, "")}>`);
const font = readFileSync(join(ROOT, "site", "fonts", "bricolage-grotesque-700.woff2")).toString("base64");

const CARD = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Bricolage Grotesque"; font-weight: 700; src: url(data:font/woff2;base64,${font}) format("woff2"); }
* { margin: 0; box-sizing: border-box; }
html, body { width: 1200px; height: 630px; background: ${PAPER}; overflow: hidden; }
body { display: flex; flex-direction: column; justify-content: center; padding: 0 96px; }
svg { display: block; width: 720px; height: auto; }
p { margin-top: 44px; font: 700 54px/1.1 "Bricolage Grotesque"; letter-spacing: -0.03em; color: ${INK}; }
</style></head><body>${svg("mark.svg")}<p>${LINE}</p></body></html>`;

const ICON = `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; } html, body { width: 180px; height: 180px; background: ${INK}; overflow: hidden; }
svg { display: block; width: 180px; height: 180px; }
</style></head><body>${svg("icon.svg")}</body></html>`;

// keep only the chunks that draw the image; every chunk's CRC is kept as written
function stripPng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a png");
  const keep = new Set(["IHDR", "PLTE", "tRNS", "sRGB", "IDAT", "IEND"]);
  const parts = [SIG];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8);
    if (keep.has(type)) parts.push(buf.subarray(o, o + 12 + len));
    o += 12 + len;
  }
  return Buffer.concat(parts);
}

async function render(b, dir, name, html, w, h) {
  const file = join(dir, name + ".html");
  writeFileSync(file, html);
  await b.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await b.navigate(pathToFileURL(file).href);
  await b.evalJs("document.fonts.ready.then(() => true)");
  if (name === "og" && !(await b.evalJs(`document.fonts.check('700 54px "Bricolage Grotesque"')`))) throw new Error("Bricolage did not load");
  const shot = await b.cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  return stripPng(Buffer.from(shot.data, "base64"));
}

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-og-"));
const b = await launch();
try {
  mkdirSync(OUT, { recursive: true });
  const og = await render(b, dir, "og", CARD, 1200, 630);
  const icon = await render(b, dir, "icon", ICON, 180, 180);
  writeFileSync(join(OUT, "og.png"), og);
  writeFileSync(join(OUT, "apple-touch-icon.png"), icon);
  process.stdout.write(`make-og: home/og/og.png ${og.length} B, home/og/apple-touch-icon.png ${icon.length} B\n`);
} finally {
  await b.close();
  rmSync(dir, { recursive: true, force: true });
}
