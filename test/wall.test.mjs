// The wall: one tile per file, justified rows (2 on a phone, 4 / 5 on wide screens), boxes
// reserved before any image, a wave of fades, right-sized thumbnails one viewport ahead, failed
// tiles that keep their box and retry in place, the loading and error states.
// Row policy: full rows reach both edges at one height; a short last row is ragged (left-aligned,
// natural height), never stretched.
// Every test loads its own page and computes its own baselines.
// Run: node --test test/wall.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch, sleep, STATS, statsFor } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test", "fixture");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
// visible tiles grouped into rows by their top edge (layout boxes, not mid-animation)
const ROWS = `(() => { const rows = new Map();
  for (const t of document.querySelectorAll('#wall .tile')) { if (t.hidden) continue;
    const r = t.getBoundingClientRect(), k = Math.round(r.top + scrollY);
    if (!rows.has(k)) rows.set(k, []); rows.get(k).push({ n: +t.dataset.n, w: r.width, h: r.height, left: r.left, right: r.right }); }
  return [...rows.values()]; })()`;
const LENS = `JSON.stringify(${ROWS}.map((r) => r.length))`;
// the fixture's trip days (04:00 to 04:00 UTC), in files: 4 days, then the 2 undated files
const DAYS = [15, 14, 15, 14, 2];
// each day packs its own rows of n: full rows, then the day's short last row
// the same for the files with keep(i) (fixture files are in wall order)
const packedIf = (n, keep) => packed(n, DAYS.map((m, d) => { const at = DAYS.slice(0, d).reduce((a, x) => a + x, 0);
  return Array.from({ length: m }, (_, k) => at + k).filter(keep).length; }).filter((m) => m > 0));
const packed = (n, days = DAYS) => days.flatMap((m) => Array.from({ length: Math.ceil(m / n) }, (_, k) => Math.min(n, m - k * n)));
const WALL_H = `document.getElementById('wall').getBoundingClientRect().height`;
const BUCKET = (px) => [400, 600, 800, 1000, 1200].find((z) => z >= px) || 1200;
const dirs = [];
let srv, broken, brokenDir, drive, b;
const errors = [];
const url = (s, path = "/example/") => s.url + path;
const light = (extra = []) => b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, ...extra] });
const resize = (w, h, mobile) => b.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile });
const fixtureCopy = () => { const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-fx-")); dirs.push(d); cpSync(FIX, d, { recursive: true }); return d; };
const enter = async () => { // a real keyboard Enter on the focused element
  await b.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await b.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
};

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), FIX], { stdio: "ignore" });
  // missing thumbnails: file 0 (a video) and file 59
  brokenDir = fixtureCopy();
  rmSync(join(brokenDir, "fx", "p0.svg")); rmSync(join(brokenDir, "fx", "p59.svg"));
  // production URLs (no thumbs templates), file 0 a 2.4 panorama beside a 0.62 portrait
  const driveDir = fixtureCopy();
  const d = JSON.parse(readFileSync(join(driveDir, "data.json"), "utf8"));
  delete d.thumbs;
  Object.assign(d.files[0], { w: 2400, h: 1000 }); Object.assign(d.files[1], { w: 620, h: 1000 });
  writeFileSync(join(driveDir, "data.json"), JSON.stringify(d));
  srv = await serve();
  broken = await serve({ fixture: brokenDir });
  drive = await serve({ fixture: driveDir });
  b = await launch(); // full URLs: one server per fixture
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await b.cdp("Network.enable");
  await light();
});
after(async () => {
  await b?.close(); await srv?.close(); await broken?.close(); await drive?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("phone: 60 tiles in time order, a section per day, 2 per row, rows at least 100px, 2px gutters", async () => {
  await b.load(390, 844, true, url(srv), READY);
  assert.equal(await b.evalJs(`document.querySelectorAll('#wall > section.day > .rows > a.tile').length`), 60);
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#wall > .day')].map((s) => [s.dataset.day, s.querySelectorAll('.tile').length])`),
    [["1", 15], ["2", 14], ["3", 15], ["4", 14], ["0", 2]], "four days, then the undated");
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#wall .tile')].map((t) => +t.dataset.n)`), Array.from({ length: 60 }, (_, i) => i), "time order");
  assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('#wall .rows')).gap`), "2px");
  const rows = await b.evalJs(ROWS);
  assert.deepEqual(rows.map((r) => r.length), packed(2));
  for (const [k, r] of rows.entries()) {
    assert.ok(r[0].h >= 100, `row ${k} is ${r[0].h}px tall`);
    assert.ok(Math.abs(r[0].left) < 1, `row ${k} starts at the edge`);
    if (r.length < 2) continue; // a day's short last row: ragged
    assert.ok(Math.abs(r[0].h - r[1].h) < 1, `row ${k}: tiles share a height`);
    assert.ok(Math.abs(r[1].right - 390) < 1, `row ${k} spans the screen`);
  }
  // a row of two panoramas (2.4 + 2.4) would be 81px: it holds at 100px, still two across
  const pano = await b.evalJs(`(() => { const [a, c] = armful.tiles; a.style.setProperty('--ar', '2.400'); c.style.setProperty('--ar', '2.400');
    armful.layout(); const r = [a, c].map((t) => t.getBoundingClientRect()); return { h: r.map((x) => x.height), top: r.map((x) => x.top), right: r[1].right }; })()`);
  assert.deepEqual(pano.h, [100, 100]);
  assert.equal(pano.top[0], pano.top[1]);
  assert.ok(Math.abs(pano.right - 390) < 1);
});

test("rows re-pack in place across 999/1000 and 1599/1600", async () => {
  await b.load(999, 900, false, url(srv), READY);
  for (const [w, n] of [[999, 2], [1000, 4], [1599, 4], [1600, 5], [1440, 4], [390, 2]]) {
    await resize(w, 900, false);
    const want = JSON.stringify(packed(n));
    assert.ok(await b.until(`${LENS} === ${JSON.stringify(want)}`, 3000), `${w}: rows of ${n}, got ${await b.evalJs(LENS)}`);
    const rows = await b.evalJs(ROWS);
    for (const [k, r] of rows.entries()) {
      assert.ok(r[0].h >= 100, `${w}: row ${k} is ${r[0].h}px`);
      if (r.length === n) assert.ok(Math.abs(r.at(-1).right - w) < 1, `${w}: row ${k} reaches the edge`);
    }
  }
});

test("every tile reserves its box before any image arrives", async () => {
  await b.load(390, 844, true, url(srv), READY);
  const loadedH = await b.evalJs(WALL_H);
  await b.cdp("Network.setBlockedURLs", { urls: ["*/fx/*"] });
  try {
    await b.load(390, 844, true, url(srv), READY);
    const read = `[...document.querySelectorAll('#wall .tile')].map((t) => ({ h: t.getBoundingClientRect().height,
      ar: t.style.getPropertyValue('--ar'), css: getComputedStyle(t).aspectRatio, ok: !!t.querySelector('img.ok') }))`;
    const one = await b.evalJs(read);
    for (const [i, t] of one.entries()) {
      assert.ok(t.h > 0, `tile ${i} has a height`);
      assert.ok(+t.ar >= 0.62 && +t.ar <= 2.4, `tile ${i} --ar ${t.ar}`);
      assert.notEqual(t.css, "auto", `tile ${i} aspect-ratio`);
      assert.equal(t.ok, false, `tile ${i} image is blocked`);
    }
    await b.load(390, 844, true, url(srv), READY);
    assert.deepEqual((await b.evalJs(read)).map((t) => t.h), one.map((t) => t.h));
    assert.equal(await b.evalJs(WALL_H), loadedH, "same wall with and without images");
  } finally { await b.cdp("Network.setBlockedURLs", { urls: [] }); }
});

test("images fade in as a wave: 250ms, 12ms stagger along a row, lazy, async", async () => {
  await b.load(1440, 900, false, url(srv), READY);
  assert.ok(await b.until(`armful.tiles.slice(0, 4).every((t) => t.querySelector('img.ok'))`), "first row loaded");
  const imgs = `armful.tiles.slice(0, 4).map((t) => getComputedStyle(t.querySelector('img')))`;
  assert.deepEqual(await b.evalJs(`${imgs}.map((s) => s.transitionDelay)`), ["0s", "0.012s", "0.024s", "0.036s"]);
  assert.deepEqual(await b.evalJs(`${imgs}.map((s) => s.transitionDuration + ' ' + s.transitionProperty + ' ' + s.transitionTimingFunction)`),
    Array(4).fill("0.25s opacity cubic-bezier(0.2, 0, 0, 1)"));
  assert.deepEqual(await b.evalJs(`(() => { const i = armful.tiles[0].querySelector('img'); return [i.loading, i.decoding, i.getAttribute('src')]; })()`), ["lazy", "async", "fx/p0.svg"]);
  assert.equal(await b.evalJs(`armful.tiles[0].querySelector('.play') !== null`), true, "videos carry a play badge");
});

test("thumbnails load one viewport ahead (by height), in both orientations", async () => {
  for (const [w, h] of [[390, 844], [844, 390]]) {
    await b.load(w, h, true, url(srv), READY);
    const split = `armful.tiles.map((t) => ({ top: t.getBoundingClientRect().top, src: !!t.querySelector('img').getAttribute('src') }))`;
    assert.ok(await b.until(`${split}.filter((t) => t.top < innerHeight * 2 - 1).every((t) => t.src)`, 3000), `${w}x${h}: tiles inside the window have src`);
    const far = await b.evalJs(`${split}.filter((t) => t.top > innerHeight * 2 + 1)`);
    assert.ok(far.length > 0, `${w}x${h}: some tiles beyond the window`);
    assert.deepEqual(far.filter((t) => t.src), [], `${w}x${h}: nothing beyond one viewport`);
  }
  // rotate in place: the window follows the new height
  await b.load(390, 844, true, url(srv), READY);
  await resize(844, 390, true);
  await sleep(300);
  // tiles sourced before the rotation keep their src; judge only the ones still waiting
  const waiting = await b.evalJs(`armful.tiles.filter((t) => !t.querySelector('img').getAttribute('src')).map((t) => +t.dataset.n)`);
  await b.evalJs(`scrollTo(0, 2000)`);
  const split = `${JSON.stringify(waiting)}.map((i) => armful.tiles[i]).map((t) => ({ top: t.getBoundingClientRect().top, src: !!t.querySelector('img').getAttribute('src') }))`;
  assert.ok(await b.until(`${split}.filter((t) => t.top > -innerHeight + 1 && t.top < innerHeight * 2 - 1).every((t) => t.src)`, 3000));
  const beyond = await b.evalJs(`${split}.filter((t) => t.top > innerHeight * 2 + 1)`);
  assert.ok(beyond.length > 0);
  assert.deepEqual(beyond.filter((t) => t.src), [], "landscape window is 390px, not 844px");
});

test("each thumbnail asks Drive for its own rendered width x DPR, rounded up (also after a resize)", async () => {
  await b.cdp("Network.setBlockedURLs", { urls: ["*drive.google.com*"] }); // only the URLs matter
  try {
    await b.load(390, 844, true, url(drive), READY);
    const sz = (i) => `+new URL(armful.tiles[${i}].querySelector('img').src).searchParams.get('sz').slice(1)`;
    const w = await b.evalJs(`armful.tiles.slice(0, 2).map((t) => t.getBoundingClientRect().width)`);
    assert.ok(w[0] > 300 && w[1] < 90, `uneven row: ${w}`);
    assert.equal(await b.evalJs(sz(0)), BUCKET(w[0] * 2));
    assert.equal(await b.evalJs(sz(0)), 800);
    assert.equal(await b.evalJs(sz(1)), 400);
    assert.equal(await b.evalJs(`armful.wallSize()`), 400);
    // widen in place, then scroll to tiles that had no src yet
    const unsourced = await b.evalJs(`armful.tiles.filter((t) => !t.querySelector('img').getAttribute('src')).map((t) => +t.dataset.n)`);
    assert.ok(unsourced.length > 10);
    await resize(1440, 900, false);
    assert.ok(await b.until(`${LENS}.startsWith('[4,')`, 3000));
    await b.evalJs(`scrollTo(0, document.documentElement.scrollHeight)`);
    const last = unsourced.at(-1);
    assert.ok(await b.until(`!!armful.tiles[${last}].querySelector('img').getAttribute('src')`, 3000));
    const late = await b.evalJs(`${JSON.stringify(unsourced)}.filter((i) => armful.tiles[i].querySelector('img').getAttribute('src'))
      .map((i) => [armful.tiles[i].getBoundingClientRect().width, +new URL(armful.tiles[i].querySelector('img').src).searchParams.get('sz').slice(1)])`);
    assert.ok(late.length > 0);
    for (const [width, s] of late) assert.equal(s, BUCKET(width * 2), `tile ${width}px wide asked for w${s}`);
    assert.ok(late.some(([, s]) => s > 400), "desktop tiles ask for more than the phone size");
    assert.equal(await b.evalJs(`armful.wallSize()`), 800);
  } finally { await b.cdp("Network.setBlockedURLs", { urls: [] }); }
});

test("a failed thumbnail keeps its box, retries in place on Enter, and recovers with focus kept", async () => {
  const p59 = join(brokenDir, "fx", "p59.svg");
  rmSync(p59, { force: true });
  await b.load(390, 844, true, url(broken, "/broken/"), READY);
  assert.ok(await b.until(`armful.tiles[0].classList.contains('failed')`), "tile 0 failed");
  await b.evalJs(`scrollTo(0, document.documentElement.scrollHeight)`);
  assert.ok(await b.until(`armful.tiles[59].classList.contains('failed')`), "tile 59 failed");
  const h0 = await b.evalJs(WALL_H);
  const box = `JSON.stringify(armful.tiles[59].getBoundingClientRect())`;
  const box0 = await b.evalJs(box);
  assert.equal(await b.evalJs(`document.querySelectorAll('#wall .tile.failed').length`), 2);
  assert.equal(await b.evalJs(`document.querySelectorAll('#wall button, #wall a a').length`), 0, "nothing interactive nested in a tile");
  assert.equal(await b.evalJs(`armful.tiles[59].getAttribute('aria-label')`), "Try again");
  assert.equal(await b.evalJs(`armful.tiles[59].querySelector('.retry').getAttribute('aria-hidden')`), "true");
  assert.equal(await b.evalJs(`getComputedStyle(armful.tiles[59]).boxShadow.includes('inset')`), true, "hairline");
  assert.equal(await b.evalJs(`getComputedStyle(armful.tiles[0].querySelector('.play')).visibility`), "hidden", "no play badge on a failed video");
  assert.equal(await b.evalJs(`armful.tiles[1].getAttribute('aria-label')`), "Photo 2 of 60");
  // first retry still fails: a new attempt number, same box, focus kept, no previewer
  await b.evalJs(`armful.tiles[59].focus()`);
  await enter();
  assert.ok(await b.until(`armful.tiles[59].dataset.err === '2'`), "the retry was attempted and failed");
  assert.equal(await b.evalJs(`new URL(armful.tiles[59].querySelector('img').src).searchParams.get('r')`), "1");
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), true, "retry does not open the previewer");
  assert.equal(await b.evalJs(`document.activeElement === armful.tiles[59]`), true);
  assert.equal(await b.evalJs(box), box0); assert.equal(await b.evalJs(WALL_H), h0);
  // the picture is back: the next retry asks with r=2 and recovers
  cpSync(join(FIX, "fx", "p59.svg"), p59);
  await enter();
  assert.ok(await b.until(`armful.tiles[59].querySelector('img.ok') !== null && !armful.tiles[59].classList.contains('failed')`), "recovered");
  assert.equal(await b.evalJs(`new URL(armful.tiles[59].querySelector('img').src).searchParams.get('r')`), "2");
  assert.equal(await b.evalJs(`armful.tiles[59].querySelector('.retry')`), null);
  assert.equal(await b.evalJs(`armful.tiles[59].getAttribute('aria-label')`), "Photo 60 of 60");
  assert.equal(await b.evalJs(`document.activeElement === armful.tiles[59]`), true, "focus stays on the link");
  assert.equal(await b.evalJs(box), box0); assert.equal(await b.evalJs(WALL_H), h0);
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), true);
  // recovered: Enter now opens that photo
  await enter();
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), false);
  assert.match(await b.evalJs(`document.getElementById('lbDrive').href`), /\/file\/d\/59\/view$/);
  await b.key("Escape", 27);
  rmSync(p59, { force: true });
});

test("loading shows the skeleton (wall blocks, pill, header) with the footer inert; a failed data.json replaces it", async () => {
  const paused = [];
  const off = b.on("Fetch.requestPaused", (p) => paused.push(p.requestId));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*data.json*" }] });
  try {
    await b.load(390, 844, true, url(srv), "true");
    for (let k = 0; k < 50 && !paused.length; k++) await sleep(100);
    assert.equal(paused.length, 1, "data.json was requested");
    assert.equal(await b.evalJs(`document.getElementById('loading').hidden`), false);
    assert.equal(await b.evalJs(`document.body.dataset.phase`), "skeleton");
    // the blocks fill the first screen, two a row, under the header; the pill and the numbers hold their places
    const sk = await b.evalJs(`(() => { const bs = [...document.querySelectorAll('#skel i')].map((i) => i.getBoundingClientRect());
      return { n: bs.filter((r) => r.top < innerHeight).length, row: bs.filter((r) => Math.abs(r.top - bs[0].top) < 1).length, top: bs[0].top,
        bottom: Math.max(...bs.map((r) => r.bottom)), anim: getComputedStyle(document.getElementById('skel')).animationName,
        pill: document.getElementById('bar').getBoundingClientRect().width, stats: getComputedStyle(document.getElementById('stats'), '::before').width }; })()`);
    assert.ok(sk.n >= 8, `blocks on screen: ${sk.n}`);
    assert.equal(sk.row, 2);
    assert.equal(sk.top, 48);
    assert.ok(sk.bottom >= 844, "the blocks reach the bottom of the screen");
    assert.equal(sk.anim, "breathe");
    assert.ok(sk.pill > 100, "the pill's skeleton");
    assert.notEqual(sk.stats, "auto", "the numbers' placeholder");
    assert.equal(await b.evalJs(`document.getElementById('panel').inert`), true, "the pill waits for the data");
    assert.equal(await b.evalJs(`document.querySelector('footer').inert`), true, "footer out of the tab order while loading");
    await b.cdp("Fetch.fulfillRequest", { requestId: paused[0], responseCode: 500, body: "" });
    assert.ok(await b.until(`document.getElementById('loading').innerText.includes('The photos didn’t load.')`), "error text");
    assert.equal(await b.evalJs(`(() => { const t = [...document.querySelectorAll('#loading button')].find((x) => !x.hidden); return t ? t.textContent.trim() : null; })()`), "Try again");
    assert.equal(await b.evalJs(`document.querySelectorAll('#skel').length`), 0, "the message takes the blocks' place");
    assert.equal(await b.evalJs(`document.getElementById('panel').getClientRects().length`), 0, "no pill without data");
  } finally { await b.cdp("Fetch.disable"); off(); }
});

test("a data.json of the wrong shape shows the error state and mounts nothing", async () => {
  const bad = [
    { files: [{ i: "a", w: 10, h: 10, p: 5 }] },
    { files: [{ i: "a", w: 0, h: 10, p: [] }] },
    { files: [{ i: 7, w: 10, h: 10, p: [] }] },
    { files: "nope" },
    { files: [{ i: "a", w: 10, h: 10, p: [] }], thumbs: { wall: 5 } },
    { files: [{ i: "a", w: 10, h: 10, p: [] }], people: "nope" },
    { files: [null, { i: "b", w: 0, h: 0, p: [], v: 1 }] }, // no usable file left
  ];
  for (const body of bad) {
    const off = b.on("Fetch.requestPaused", (p) => b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") }));
    await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*data.json*" }] });
    try {
      await b.load(390, 844, true, url(srv), "true");
      assert.ok(await b.until(`document.getElementById('loading').innerText.includes('The photos didn’t load.')`), JSON.stringify(body));
      assert.equal(await b.evalJs(`document.querySelectorAll('#wall *').length`), 0, "nothing mounted");
      assert.equal(await b.evalJs(`armful.D`), undefined, "data not published");
    } finally { await b.cdp("Fetch.disable"); off(); }
  }
});

// the page's own console.warn lines ("armful: …") while `go` loads it
async function warnsOf(go) {
  const warns = [];
  const off = b.on("Runtime.consoleAPICalled", (p) => {
    const line = p.args.map((a) => a.value).join(" ");
    if (p.type === "warning" && line.startsWith("armful:")) warns.push(line);
  });
  try { await go(); await sleep(200); } finally { off(); }
  return warns;
}

test("the fixture's malformed last entry (w: 0, h: 0) is dropped: 60 tiles, no error state, one warning", async () => {
  const data = JSON.parse(readFileSync(join(FIX, "data.json"), "utf8"));
  assert.equal(data.files.length, 61);
  assert.equal(data.files[60].w, 0);
  const warns = await warnsOf(() => b.load(390, 844, true, url(srv), READY));
  assert.equal(await b.evalJs(`document.querySelectorAll('#wall .tile').length`), 60);
  assert.equal(await b.evalJs(`armful.D.files.length`), 60);
  assert.equal(await b.evalJs(`document.getElementById('loading').classList.contains('failed')`), false);
  assert.ok(!(await b.evalJs(`document.getElementById('loading').innerText`)).includes("didn’t load"));
  assert.equal(await b.evalJs(STATS), statsFor(12, 57, 3));
  assert.deepEqual(warns, ["armful: skipped 1 malformed entries"]);
});

test("malformed files anywhere and malformed people are dropped; indexes follow the kept files", async () => {
  const data = JSON.parse(readFileSync(join(FIX, "data.json"), "utf8"));
  const good = data.files.slice(0, 60);
  // bad files at the front and in the middle shift every index; a bad person in the list
  data.files = [{ i: "x0", w: 0, h: 0, p: [1], v: 1 }, ...good.slice(0, 30), { i: "", w: 10, h: 10, p: [] },
    { i: "x2", w: 10, h: 10, p: "1" }, ...good.slice(30), { i: "x3", w: -4, h: 3, p: [] }, 7];
  data.files.splice(45, 0, { i: "x4", w: 1, h: NaN, p: [5] });
  for (const p of data.people) p.rep.f = data.files.indexOf(good[p.rep.f]); // reps index this list
  data.people.find((p) => p.id === 5).rep.f = 45; // its rep points at a file that is dropped
  data.people = data.people.flatMap((p) => p.id === 3 ? [p, { id: "3b" }, null] : [p]);
  const body = JSON.stringify(data); // h: NaN arrives as null
  const off = b.on("Fetch.requestPaused", (p) => b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
    responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(body).toString("base64") }));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*data.json*" }] });
  try {
    const warns = await warnsOf(() => b.load(390, 844, true, url(srv) + "#p=1.2", `document.querySelectorAll('#wall .tile').length > 0 && document.getElementById('loading').hidden`));
    assert.deepEqual(warns, ["armful: skipped 8 malformed entries"]);
    assert.deepEqual(await b.evalJs(`armful.D.files.map((f) => f.i)`), good.map((f) => f.i));
    assert.equal(await b.evalJs(`document.querySelectorAll('#wall .tile').length`), 60);
    assert.deepEqual(await b.evalJs(`armful.D.people.map((p) => p.id)`), JSON.parse(readFileSync(join(FIX, "data.json"), "utf8")).people.map((p) => p.id));
    // every kept rep still points at the same file; the one whose file was dropped has none
    const fx = JSON.parse(readFileSync(join(FIX, "data.json"), "utf8"));
    for (const p of fx.people) {
      const rep = await b.evalJs(`armful.D.people.find((q) => q.id === ${p.id}).rep?.f ?? null`);
      assert.equal(rep, p.id === 5 ? null : p.rep.f, `rep of ${p.id}`);
    }
    const want = {};
    good.forEach((f, i) => f.p.forEach((pid) => (want[pid] ||= []).push(i)));
    assert.deepEqual(await b.evalJs(`Object.fromEntries([...armful.tilesOf].map(([k, v]) => [k, v]))`), want);
    // the hash loads against the kept files: 1 and 2 together are their 9 shared files
    assert.equal(await b.evalJs(`armful.state.picked.join('.')`), "1.2");
    assert.equal(await b.evalJs(`armful.tiles.filter((t) => !t.hidden).length`), 9);
    assert.equal(await b.evalJs(`document.getElementById('loading').classList.contains('failed')`), false);
  } finally { await b.cdp("Fetch.disable"); off(); }
});

test("after load: no loading state, footer reachable, the clicked file opens even after a filter", async () => {
  await b.load(390, 844, true, url(srv), READY);
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('loading')).display`), "none");
  assert.equal(await b.evalJs(`document.querySelector('footer').inert`), false);
  await b.evalJs(`armful.tiles[3].click()`);
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), false);
  assert.match(await b.evalJs(`document.getElementById('lbDrive').href`), /\/file\/d\/3\/view$/);
  await b.key("Escape", 27);
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), true);
  await b.evalJs(`armful.setShown(armful.tiles.map((_, i) => i % 3 === 0))`);
  assert.equal(await b.evalJs(`armful.tiles.some((t) => t.getAnimations().length > 0)`), true, "tiles travel");
  assert.ok(await b.until(`document.getAnimations().filter((a) => a.effect?.target?.classList?.contains('tile')).length === 0`, 2000), "FLIP settles");
  assert.deepEqual((await b.evalJs(ROWS)).map((r) => r.length), packedIf(2, (i) => i % 3 === 0), "each day packs its own rows");
  await b.evalJs(`armful.tiles[9].click()`); // the fourth file the filter shows
  assert.match(await b.evalJs(`document.getElementById('lbDrive').href`), /\/file\/d\/9\/view$/);
  assert.equal(await b.evalJs(`document.getElementById('lbCount').textContent`), "4 / 20");
  await b.key("Escape", 27);
});

test("a filter that leaves a short last row: ragged, natural height, not stretched", async () => {
  await b.load(390, 844, true, url(srv), READY);
  await b.evalJs(`armful.setShown(armful.tiles.map((_, i) => i < 5))`);
  assert.ok(await b.until(`document.getAnimations().length === 0 || document.getAnimations().every((a) => a.playState !== 'running')`, 2000));
  const rows = await b.evalJs(ROWS);
  assert.deepEqual(rows.map((r) => r.length), [2, 2, 1]);
  const lone = rows[2][0];
  assert.ok(lone.left < 1, "starts at the left edge");
  assert.ok(lone.right < 389, `ragged: ends at ${lone.right}, not the edge`);
  assert.ok(lone.h >= 100, "at least a row tall");
  assert.equal(await b.evalJs(`document.getElementById('empty').hidden`), true);
  await b.evalJs(`armful.setShown(armful.tiles.map(() => false))`);
  assert.equal(await b.evalJs(`document.getElementById('empty').hidden`), false, "nothing shown: the empty state");
});

test("reduced motion: setShown snaps, nothing animates", async () => {
  await light([{ name: "prefers-reduced-motion", value: "reduce" }]);
  try {
    await b.load(390, 844, true, url(srv), READY);
    await b.evalJs(`armful.setShown(armful.tiles.map((_, i) => i % 2 === 0))`);
    assert.equal(await b.evalJs(`document.getAnimations().length`), 0);
    assert.equal(await b.evalJs(`armful.tiles.every((t) => !t.style.transform && !t.style.opacity)`), true);
    assert.equal(await b.evalJs(`armful.tiles.filter((t) => !t.hidden).length`), 30);
    assert.equal(await b.evalJs(`getComputedStyle(armful.tiles[0]).transitionDuration`), "0s");
    assert.deepEqual((await b.evalJs(ROWS)).map((r) => r.length), packedIf(2, (i) => i % 2 === 0));
  } finally { await light(); }
});

test("the header reserves its height: the wall does not move when the numbers arrive", async () => {
  const held = [];
  const off = b.on("Fetch.requestPaused", (p) => held.push(p.requestId));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*data.json*" }] });
  try {
    await b.load(390, 844, true, url(srv), `document.readyState === 'complete'`);
    const before = await b.evalJs(`[document.querySelector('.masthead').getBoundingClientRect().height, document.getElementById('wall').getBoundingClientRect().top, document.querySelector('.masthead .mark').getBoundingClientRect().left, document.getElementById('stats').textContent]`);
    assert.equal(before[3], "");
    for (const id of held.splice(0)) await b.cdp("Fetch.continueRequest", { requestId: id });
    assert.ok(await b.until(READY));
    const after = await b.evalJs(`[document.querySelector('.masthead').getBoundingClientRect().height, document.getElementById('wall').getBoundingClientRect().top, document.querySelector('.masthead .mark').getBoundingClientRect().left, document.getElementById('stats').textContent]`);
    assert.deepEqual(after.slice(0, 3), before.slice(0, 3), "header height, wall top and wordmark unmoved");
    assert.equal(await b.evalJs(STATS), statsFor(12, 57, 3));
  } finally { await b.cdp("Fetch.disable"); off(); }
});

test("tilesOf maps each person to exactly their files", async () => {
  await b.load(390, 844, true, url(srv), READY);
  const files = JSON.parse(readFileSync(join(FIX, "data.json"), "utf8")).files.slice(0, 60); // the 61st is malformed
  const want = {};
  files.forEach((f, i) => f.p.forEach((pid) => (want[pid] ||= []).push(i)));
  assert.deepEqual(await b.evalJs(`Object.fromEntries([...armful.tilesOf].map(([k, v]) => [k, v]))`), want);
});

test("helpers honour data.json thumbs; head carries the Veil colours and the favicon", async () => {
  await b.load(390, 844, true, url(srv), READY);
  assert.equal(await b.evalJs(`armful.thumbUrl({ i: '7', w: 4, h: 3 }, 400)`), "fx/p7.svg");
  assert.equal(await b.evalJs(`armful.bigUrl({ i: '7', w: 4, h: 3 })`), "fx/p7.svg");
  assert.equal(await b.evalJs(`armful.faceUrl({ id: 5, rep: { f: 0, box: [0, 0, 10] } })`), "fx/f5.svg");
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('meta[name=theme-color]')].map((m) => m.media + ' ' + m.content)`),
    ["(prefers-color-scheme: light) #FBFAF7", "(prefers-color-scheme: dark) #0D0F0E"]);
  assert.equal(await b.evalJs(`document.querySelector('link[rel=icon]')?.getAttribute('href')`), "favicon.svg");
  assert.equal(await b.evalJs(`document.querySelector('footer').textContent.trim().replace(/\\s+/g, ' ')`), "Want your face removed? Write to photos@armful.photos");
  assert.equal(await b.evalJs(`document.querySelector('aside#panel.panel') !== null`), true);
  assert.equal(await b.evalJs(`document.querySelector('header.masthead a.mark[href="/"] svg') !== null`), true);
});

test("nothing threw", () => assert.deepEqual(errors, []));
