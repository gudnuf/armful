// No flashes: the page is filmed (CDP Page.startScreencast, every frame) and each frame is read.
//  - Cold load of a collection at 390x844 (cache disabled, 1.5 Mbps / 150 ms, data.json held back
//    800 ms): the first frame with the wordmark on it already shows the skeleton wall, no later
//    frame has an empty (all-ground) wall, and CLS stays under 0.01 through the skeleton -> tiles morph.
//  - Opening the rail, holding faces, letting go, folding the rail, opening the previewer and
//    stepping it: no frame where the wall (or the previewer's stage) is blank.
//  - The home page with a Recent row: the row is in the first painted frame.
// Builds dist/ in a temp dir from the synthetic fixture (as test/cls.test.mjs); Drive requests are
// answered locally. ARMFUL_SHOTS=1 writes a filmstrip of the cold load to shots/ (git-ignored).
// Run: node --test test/flash.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const W = 390, H = 844;
const PAPER = [0xfb, 0xfa, 0xf7], LB = [0x0d, 0x0f, 0x0e], WHITE = [255, 255, 255];
const SEED = JSON.stringify([{ slug: "example", title: "Example Weekend", door: "DOOR_PHOTO_ID_0123456789", t: 1764000000000 }]);
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
const OBSERVE = `window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
  .observe({ type: "layout-shift", buffered: true });`;
let WORK, srv, base, b;

// ---- a small PNG reader (8-bit RGB / RGBA, not interlaced: what the screencast sends) ----
function png(buf) {
  let w, h, ct, at = 8;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8), d = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error("png: unsupported"); }
    else if (type === "IDAT") idat.push(d);
    at += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error(`png: colour type ${ct}`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      px[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  return { w, h, bpp, px };
}
// the share of pixels in a CSS-px box (frames are W px wide) within 4 levels of `rgb`
function share(img, [x0, y0, x1, y1], rgb) {
  const k = img.w / W;
  let n = 0, same = 0;
  for (let y = Math.floor(y0 * k); y < Math.min(img.h, y1 * k); y += 2) for (let x = Math.floor(x0 * k); x < Math.min(img.w, x1 * k); x += 2) {
    const o = (y * img.w + x) * img.bpp;
    n++;
    if (Math.abs(img.px[o] - rgb[0]) <= 4 && Math.abs(img.px[o + 1] - rgb[1]) <= 4 && Math.abs(img.px[o + 2] - rgb[2]) <= 4) same++;
  }
  return same / n;
}
const WALL = [0, 60, W, H - 110]; // under the header, above the pill
const MARK = [14, 10, 90, 38]; // the collection's wordmark
const blank = (img, box = WALL) => share(img, box, PAPER) > 0.97 || share(img, box, LB) > 0.97 || share(img, box, WHITE) > 0.97;

// film everything `go` does; frames: [{ t (ms since epoch), img }]
async function film(go) {
  const frames = [];
  const off = b.on("Page.screencastFrame", (p) => {
    frames.push({ t: p.metadata.timestamp * 1000, buf: Buffer.from(p.data, "base64") });
    b.cdp("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  await b.cdp("Page.startScreencast", { format: "png", maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  try { await go(); } finally { await b.cdp("Page.stopScreencast").catch(() => {}); off(); }
  await sleep(100);
  return frames.map((f) => ({ ...f, img: png(f.buf) }));
}

before(async () => {
  WORK = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-flash-"));
  const fx = join(WORK, "fixture"), col = join(WORK, "collections", "example");
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), fx], { stdio: "ignore" });
  mkdirSync(join(col, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "collections", "example", "collection.json"), join(col, "collection.json"));
  copyFileSync(join(fx, "data.json"), join(col, "dist", "data.json"));
  execFileSync(process.execPath, [join(ROOT, "bin", "build-dist.mjs"), "--collection", col, "--out", join(WORK, "dist")], { cwd: WORK, stdio: "ignore" });
  const dist = join(WORK, "dist");
  srv = createServer(async (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const [root, rel] = p.startsWith("/example/fx/") ? [fx, normalize(p.slice("/example/".length))]
      : [dist, normalize(p === "/" ? "index.html" : p.endsWith("/") ? p.slice(1) + "index.html" : p.slice(1))];
    if (rel.startsWith("..") || rel.includes(sep + "..")) return res.writeHead(404).end();
    let body;
    try { body = readFileSync(join(root, rel)); } catch { return res.writeHead(404).end(); }
    if (rel.endsWith("data.json")) await sleep(800); // a slow data source
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" }).end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  b = await launch(base, { timeout: 20000 });
  const og = readFileSync(join(ROOT, "home", "og", "og.png")).toString("base64");
  b.on("Fetch.requestPaused", (p) => setTimeout(() => b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: og }).catch(() => {}), 300));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*drive.google.com*" }, { urlPattern: "*googleusercontent.com*" }] });
  await b.cdp("Network.enable");
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVE });
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
}, { timeout: 90000 });

after(async () => {
  await b?.close();
  await new Promise((r) => (srv ? srv.close(r) : r()));
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

// a cold load, filmed: cache off and cleared, a slow network
async function coldLoad(path) {
  await b.load(W, H, true, "/404.html");
  await b.cdp("Network.clearBrowserCache");
  await b.cdp("Network.setCacheDisabled", { cacheDisabled: true });
  await b.cdp("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.5e6 / 8, uploadThroughput: 750e3 / 8 });
  await b.navigate("about:blank");
  let t0 = 0;
  try {
    const frames = await film(async () => {
      await sleep(150);
      t0 = Date.now();
      await b.navigate(base + path, 30000);
      if (path.startsWith("/example/")) {
        if (!(await b.until(READY, 15000))) throw new Error("the wall did not arrive");
        await b.until(`[...document.querySelectorAll('#wall img')].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete)`, 15000);
      }
      await sleep(1200);
    });
    return { t0, frames };
  } finally {
    await b.cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await b.cdp("Network.setCacheDisabled", { cacheDisabled: false });
  }
}

test("cold load: skeleton in the first painted frame, never an empty wall, no layout shift", { timeout: 120000 }, async () => {
  await b.load(W, H, true, "/404.html");
  await b.evalJs(`localStorage.clear()`);
  const { t0, frames } = await coldLoad("/example/");
  assert.ok(frames.length > 3, `frames filmed: ${frames.length}`);
  // the first frame of the page itself: the wordmark is painted
  const first = frames.findIndex((f) => share(f.img, MARK, PAPER) < 0.97 && share(f.img, MARK, WHITE) < 0.97);
  assert.ok(first >= 0, "the page painted");
  const fcp = Math.round(frames[first].t - t0);
  assert.ok(!blank(frames[first].img), `the first painted frame (${fcp}ms) shows the skeleton wall`);
  const empty = frames.slice(first).filter((f) => blank(f.img)).map((f) => Math.round(f.t - t0));
  assert.deepEqual(empty, [], "frames with an empty wall (ms after navigation start)");
  // the skeleton really was up before the data, and the morph moved nothing
  assert.equal(await b.evalJs(`document.body.dataset.phase`), "ready");
  const cls = await b.evalJs(`window.__cls`);
  assert.ok(cls < 0.01, `CLS ${cls.toFixed(4)}`);
  console.log(`flash: ${frames.length} frames, first paint ${fcp}ms, CLS ${cls.toFixed(4)}`);
  if (process.env.ARMFUL_SHOTS) {
    const dir = join(ROOT, "shots");
    mkdirSync(dir, { recursive: true });
    for (const ms of [0, 200, 400, 600, 800, 1200, 1600, 2400]) {
      const f = frames.filter((x) => x.t - t0 <= ms).at(-1) || frames[0];
      writeFileSync(join(dir, `cold-${W}x${H}-${String(ms).padStart(4, "0")}ms.png`), f.buf);
    }
    writeFileSync(join(dir, `cold-${W}x${H}-first-paint-${fcp}ms.png`), frames[first].buf);
  }
});

const tapSel = async (sel) => {
  const [x, y] = await b.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)});
    e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await b.tap(x, y);
};

test("rail, hold, let go, previewer: no frame with a blank wall or stage", { timeout: 120000 }, async () => {
  await b.load(W, H, true, "/example/", READY);
  await b.until(`[...document.querySelectorAll('#wall img')].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete)`, 10000);
  await sleep(400);
  const steps = [];
  const frames = await film(async () => {
    const step = async (name, fn, wait = 600) => { steps.push([name, Date.now()]); await fn(); await sleep(wait); };
    await sleep(200);
    await step("open the rail", () => tapSel("#people"));
    await step("hold 1", () => tapSel('#list .face[data-pid="1"]'));
    await step("hold 2", () => tapSel('#list .face[data-pid="2"]'));
    await step("the pair: to the filters", () => tapSel("#pair"));
    await step("the pair: back to the faces", () => tapSel("#pair"));
    await step("let go of 2", () => tapSel('#list .face[data-pid="2"]'));
    await step("clear", () => tapSel("#list .clearAll"));
    await step("fold the rail", () => tapSel("#people"));
    await step("open the previewer", () => b.evalJs(`(() => { const t = document.querySelector('.tile[data-n="3"]'); t.click(); })()`));
    for (let k = 0; k < 3; k++) await step(`step ${k + 1}`, () => b.key("ArrowRight", 39), 400);
    await step("step back", () => b.key("ArrowLeft", 37), 400);
    await step("close the previewer", () => b.key("Escape", 27));
  });
  assert.ok(frames.length > 10, `frames filmed: ${frames.length}`);
  const at = (t) => (steps.filter(([, s]) => s <= t).at(-1) || ["start"])[0];
  const bad = frames.filter((f) => blank(f.img)).map((f) => `${at(f.t)} +${Math.round(f.t - steps.find(([n]) => n === at(f.t))?.[1] || 0)}ms`);
  assert.deepEqual(bad, [], "blank frames");
  console.log(`flash: interactions, ${frames.length} frames`);
});

test("home page: the Recent row is in the first painted frame", { timeout: 120000 }, async () => {
  await b.load(W, H, true, "/404.html");
  await b.evalJs(`localStorage.clear(); localStorage.setItem("armful:recent", ${JSON.stringify(SEED)})`);
  const { t0, frames } = await coldLoad("/");
  const box = await b.evalJs(`(() => { const r = document.querySelector('.recent .thumb').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
  const mark = await b.evalJs(`(() => { const r = document.querySelector('h1 .mark').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
  assert.ok(box[3] <= H, "the card is on the first screen");
  const first = frames.findIndex((f) => share(f.img, mark, PAPER) < 0.97 && share(f.img, mark, WHITE) < 0.97);
  assert.ok(first >= 0, "the page painted");
  assert.ok(share(frames[first].img, box, PAPER) < 0.5, `the Recent card is in the first painted frame (${Math.round(frames[first].t - t0)}ms)`);
});
