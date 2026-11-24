// Home -> collection, the way a returning visitor goes: a valid gate cookie, the home page's Recent
// card tapped. Served by functions/_middleware.js under `wrangler pages dev` (test/wrangler.mjs);
// filmed (CDP Page.startScreencast, every frame) and measured inside the new document every frame.
//  - no large wordmark on the way: no view transition carries the wordmark (the home page's big
//    one used to morph into the header's slot, a big logo over an empty header), and no filmed
//    frame after the collection is revealed has wordmark ink where the home page's big one was;
//  - the header has its final size and place in the first frame of the collection (wordmark and
//    numbers' slot), and the wordmark is painted in the header in every frame once the
//    cross-fade has ended;
//  - the skeleton is the wall: every block on the first screen has the box of the tile that
//    replaces it, so nothing moves, grows or shrinks when the data arrives;
//  - CLS 0 in the collection.
// 390x844 (touch) and 1440x900. Synthetic fixture only; Drive requests are answered locally.
// Run: node --test test/transition.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { launch, sleep } from "./cdp.mjs";
import { makeWork, start, stop, key } from "./wrangler.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "recent-test-coll";
const PASS = ["tangerine", "orchard", "lantern"].join(" ");
const PAPER = [0xfb, 0xfa, 0xf7], INK = [0x16, 0x23, 0x1f];
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
const ON_COLLECTION = `location.pathname === '/${SLUG}/' && !document.querySelector('form.door')`;
// inside every collection document, from its first frame: the header's boxes, the skeleton's
// boxes (while it is up), the view transitions it runs, layout shifts
const WATCH = `(() => {
  if (!/^\\/${SLUG}\\//.test(location.pathname)) return;
  const T = window.__t = { frames: [], skel: null, vt: [], cls: 0, revealed: 0, vtEnd: 0 };
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10); };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) T.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  addEventListener("pagereveal", (e) => {
    T.revealed = performance.timeOrigin + performance.now();
    const vt = e.viewTransition;
    if (!vt) { T.vtEnd = T.revealed; return; }
    vt.ready.then(() => { for (const a of document.getAnimations()) if (a.effect?.pseudoElement) T.vt.push(a.effect.pseudoElement); }, () => {});
    vt.finished.then(() => { T.vtEnd = performance.timeOrigin + performance.now(); }, () => { T.vtEnd = performance.timeOrigin + performance.now(); });
  });
  const frame = () => {
    const skel = document.getElementById("skel");
    if (skel && document.body) T.skel = [...skel.querySelectorAll("i")].map(box); // the blocks, inside one section per day
    T.frames.push({ t: performance.timeOrigin + performance.now(), mark: box(document.querySelector(".masthead .mark svg")),
      stats: box(document.getElementById("stats")), head: box(document.querySelector(".masthead")) });
    if (T.frames.length < 600) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();`;
let WORK, base, b;

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
// the share of pixels in a CSS-px box [x0, y0, x1, y1] (frames are `vw` CSS px wide) within `tol` of rgb
function share(img, vw, [x0, y0, x1, y1], rgb, tol = 24) {
  const k = img.w / vw;
  let n = 0, same = 0;
  for (let y = Math.floor(y0 * k); y < Math.min(img.h, y1 * k); y += 2) for (let x = Math.floor(x0 * k); x < Math.min(img.w, x1 * k); x += 2) {
    const o = (y * img.w + x) * img.bpp;
    n++;
    if (Math.abs(img.px[o] - rgb[0]) <= tol && Math.abs(img.px[o + 1] - rgb[1]) <= tol && Math.abs(img.px[o + 2] - rgb[2]) <= tol) same++;
  }
  return n ? same / n : 0;
}

async function film(vw, vh, go) {
  const frames = [];
  const off = b.on("Page.screencastFrame", (p) => {
    frames.push({ t: p.metadata.timestamp * 1000, buf: Buffer.from(p.data, "base64") });
    b.cdp("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  await b.cdp("Page.startScreencast", { format: "png", maxWidth: vw, maxHeight: vh, everyNthFrame: 1 });
  try { await go(); } finally { await b.cdp("Page.stopScreencast").catch(() => {}); off(); }
  await sleep(100);
  return frames.map((f) => ({ ...f, img: png(f.buf) }));
}

// evalJs, but a navigation in flight reads as "not yet"
const safe = async (expr) => { try { return await b.evalJs(expr); } catch { return undefined; } };
const until = async (expr, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await safe(expr)) return true; return false; };

before(async () => {
  WORK = makeWork([[SLUG, { title: "Example Weekend", door_photo: "DOOR_PHOTO_ID_0123456789" }]]);
  // the fixture's thumbnails (data.json's thumbs templates name fx/...), behind the gate like the rest
  cpSync(join(WORK, "fixture", "fx"), join(WORK, "dist", SLUG, "fx"), { recursive: true });
  base = await start(WORK, { [key(SLUG)]: PASS });
  b = await launch(base, { timeout: 20000 });
  const og = readFileSync(join(ROOT, "home", "og", "og.png")).toString("base64");
  b.on("Fetch.requestPaused", (p) => setTimeout(() => b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: og }).catch(() => {}), 100));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*drive.google.com*" }, { urlPattern: "*googleusercontent.com*" }] });
  await b.cdp("Network.enable");
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
}, { timeout: 180000 });

after(async () => {
  await b?.close();
  await stop();
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

for (const [W, H, mobile] of [[390, 844, true], [1440, 900, false]]) {
  test(`Recent card -> collection at ${W}x${H}, valid cookie: no big wordmark, header in place from the first frame, skeleton = wall, CLS 0`, { timeout: 120000 }, async () => {
    await b.cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile });
    await b.cdp("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    // a returning visitor: signed in (the door's own JSON login sets the cookie), the collection
    // opened once (which writes the Recent row), then the home page
    await b.cdp("Network.clearBrowserCookies");
    await b.navigate("about:blank");
    await b.navigate(`${base}/`);
    await b.evalJs(`localStorage.clear()`);
    const login = await b.evalJs(`fetch('/${SLUG}/__gate', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ p: ${JSON.stringify(PASS)} }) }).then((r) => r.status)`);
    assert.equal(login, 200, "signed in");
    await b.navigate(`${base}/${SLUG}/`);
    assert.ok(await until(READY), "the collection draws");
    assert.ok(await until(`JSON.parse(localStorage.getItem('armful:recent') || '[]').some((r) => r.slug === '${SLUG}')`), "remembered in Recent");
    await b.navigate(`${base}/`);
    assert.ok(await until(`!!document.querySelector('.recent .card')`), "the Recent card");
    await sleep(500);
    const big = await b.evalJs(`(() => { const r = document.querySelector('h1 .mark').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
    const [cx, cy] = await b.evalJs(`(() => { const r = document.querySelector('.recent .card .thumb').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);

    let tClick = 0;
    const frames = await film(W, H, async () => {
      await sleep(150);
      tClick = Date.now();
      if (mobile) await b.tap(cx, cy); else await b.click(cx, cy);
      assert.ok(await until(ON_COLLECTION), "lands on the collection");
      assert.ok(await until(READY), "the wall draws");
      await b.until(`[...document.querySelectorAll('#wall img')].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete)`, 15000);
      await sleep(800);
    });
    const T = await b.evalJs(`window.__t`);
    assert.ok(T && T.frames.length > 2, "the collection was watched");
    assert.equal(await b.evalJs(`performance.getEntriesByType('navigation')[0].responseStatus`), 200, "the page, not the door");

    if (process.env.ARMFUL_SHOTS) {
      const dir = join(ROOT, "shots");
      mkdirSync(dir, { recursive: true });
      frames.forEach((f, i) => { if (i % 2 === 0 || f.t >= T.revealed - 50 && f.t <= T.vtEnd + 200) writeFileSync(join(dir, `recent-${W}-${String(i).padStart(3, "0")}-${Math.round(f.t - tClick)}ms.png`), f.buf); });
    }

    // 1. no view transition carries the wordmark from the home page into the header
    const named = T.vt.filter((p) => /^::view-transition/.test(p) && !/\(root\)$/.test(p));
    assert.deepEqual(named, [], "view-transition pseudo-elements other than the root cross-fade");
    // ...and once the collection is fully in (the cross-fade over), no frame shows wordmark ink where
    // the home page's big one stood, and every frame shows the header's wordmark
    const inner = [big[0] + 4, big[1] + 4, big[2] - 4, big[3] - 4];
    // (the screencast only sends a frame when something repaints, so the settled page is shot too)
    const settled = Buffer.from((await b.cdp("Page.captureScreenshot", { format: "png" })).data, "base64");
    const after = [...frames.filter((f) => f.t > T.vtEnd + 20), { t: Date.now(), img: png(settled) }];
    const ghost = after.filter((f) => share(f.img, W, inner, INK) > 0.04).map((f) => Math.round(f.t - tClick));
    assert.deepEqual(ghost, [], "frames with a large wordmark over the collection (ms after the tap)");
    const MARKBOX = [T.frames[0].mark[0], T.frames[0].mark[1], T.frames[0].mark[0] + T.frames[0].mark[2], T.frames[0].mark[1] + T.frames[0].mark[3]];
    const noMark = after.filter((f) => share(f.img, W, MARKBOX, INK) < 0.08).map((f) => Math.round(f.t - tClick));
    assert.deepEqual(noMark, [], "frames with an empty header (ms after the tap)");
    // the cross-fade, if any, is short
    assert.ok(T.vtEnd - T.revealed < 600, `cross-fade ${Math.round(T.vtEnd - T.revealed)}ms`);

    // 2. the header: final size and place in the first frame, never moved after
    const first = T.frames[0];
    assert.ok(Math.abs(first.mark[2] - 72) <= 1, `the slim wordmark from the first frame: ${JSON.stringify(first.mark)}`);
    for (const f of T.frames) {
      assert.deepEqual([f.mark, f.stats, f.head], [first.mark, first.stats, first.head], `header moved at +${Math.round(f.t - T.frames[0].t)}ms`);
    }

    // 3. the skeleton is the wall: each block on the first screen has its tile's box
    assert.ok(T.skel && T.skel.length, "the skeleton was up");
    const tiles = await b.evalJs(`[...document.querySelectorAll('#wall .tile')].map((t) => { const r = t.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10); })`);
    const onScreen = T.skel.filter((r) => r[1] < H && r[2] > 0);
    assert.ok(onScreen.length >= 4, `blocks on the first screen: ${onScreen.length}`);
    const off = onScreen.map((r, i) => [i, r, tiles[i]]).filter(([, r, t]) => !t || r.some((v, k) => Math.abs(v - t[k]) > 0.6));
    assert.deepEqual(off.map(([i, r, t]) => `block ${i} ${JSON.stringify(r)} -> tile ${JSON.stringify(t)}`), [], "skeleton blocks that change shape");

    // 4. nothing shifted
    assert.equal(T.cls, 0, `CLS ${T.cls}`);
    console.log(`transition ${W}x${H}: ${frames.length} frames, reveal +${Math.round(T.revealed - tClick)}ms, cross-fade ${Math.round(T.vtEnd - T.revealed)}ms, view transitions ${JSON.stringify(T.vt)}`);
  });
}
