// The previewer keeps the query: a tap on a tile opens it large, stepping through exactly what
// the wall shows (files, in wall order), with the held faces (no words) at the bottom. A video
// shows its wall thumbnail and the loading mark until Drive's player has loaded, then fades it in.
// Plus the recent-armfuls writer (localStorage "armful:recent").
// Run: node --test test/previewer.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
let srv, b, D;
const errors = [];
const js = (x) => JSON.stringify(x);
const filesWith = (pred) => D.files.map((f, i) => [f, i]).filter(([f]) => pred(f.p)).map(([, i]) => i);
const LB = `(() => { const lb = document.getElementById('lb'), st = document.getElementById('lbStage'), im = st.querySelector(':scope > img'), fr = st.querySelector('iframe');
  return { open: !lb.hidden, count: document.getElementById('lbCount').textContent, drive: document.getElementById('lbDrive').href,
    src: im ? im.getAttribute('src') : fr ? fr.src : '', soft: im ? im.classList.contains('soft') : null, video: !!fr,
    focusIn: lb.contains(document.activeElement), focus: document.activeElement?.id || '' }; })()`;
const lb = () => b.evalJs(LB);
const swipe = async (x0, y0, x1, y1) => {
  await b.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  for (let k = 1; k <= 4; k++) await b.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * k) / 4, y: y0 + ((y1 - y0) * k) / 4 }] });
  await b.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(80);
};
const light = (extra = []) => b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, ...extra] });

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ROOT, "test", "fixture")], { stdio: "ignore" });
  D = JSON.parse(readFileSync(join(ROOT, "test", "fixture", "data.json"), "utf8"));
  srv = await serve();
  b = await launch(srv.url);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await light();
});
after(async () => { await b?.close(); await srv?.close(); });

test("desktop: opens in the held set, counts files, steps, traps focus, Esc / Back close", async () => {
  const set = filesWith((p) => p.includes(1) && p.includes(2));
  assert.equal(set.length, 9);
  await b.load(1280, 900, false, "/example/#p=1.2", READY);
  const photo = set.find((i) => !D.files[i].v);

  // the wall's own thumbnail stands in at once, laid out at the photo's final size (offsetWidth: it
  // grows there from its tile on the spring)
  const s = await b.evalJs(`(() => { const t = document.querySelector('.tile[data-n="${photo}"]'); t.scrollIntoView({ block: 'center' });
    return new Promise((r) => { const im = t.querySelector('img'); const go = () => { const w = t.getBoundingClientRect().width; t.click();
      const st = document.querySelector('#lbStage img'); r({ thumb: im.currentSrc, src: st?.src, soft: st?.classList.contains('soft'), w, sw: st?.offsetWidth }); };
      im.complete && im.naturalWidth ? go() : (im.onload = go); }); })()`);
  assert.equal(s.soft, true, "stand-in first");
  assert.equal(s.src, s.thumb, "the wall's thumbnail");
  assert.ok(s.sw > s.w * 1.5, `scaled up (${s.sw} vs ${s.w})`);
  assert.ok(await b.until(`(() => { const i = document.querySelector('#lbStage img'); return i && !i.classList.contains('soft') && i.naturalWidth > 0; })()`, 3000), "the large one lands");
  let a = await lb();
  assert.equal(a.open, true);
  assert.equal(a.count, `${set.indexOf(photo) + 1} / 9`);
  assert.equal(a.focus, "lbClose");
  assert.equal(await b.evalJs(`document.getElementById('lbCount').className`), "lbCount lbl light");

  // the held pair, small at the bottom, and no words
  assert.equal(await b.evalJs(`document.getElementById('lbHold').hidden`), false);
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#lbHold .face img')].map((i) => [i.getBoundingClientRect().width, i.getBoundingClientRect().height])`), [[36, 36], [36, 36]]);
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#lbHold .face')].map((f) => +f.dataset.pid)`), [1, 2]);
  assert.equal(await b.evalJs(`document.getElementById('lbHold').textContent.trim()`), "", "no words, no names");

  // controls: 44px
  for (const id of ["lbPrev", "lbNext", "lbClose", "lbDrive"])
    assert.deepEqual(await b.evalJs(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.width, r.height]; })()`), [44, 44], id);

  // steps: arrows and buttons, through the 9 only
  const k0 = set.indexOf(photo);
  await b.key("ArrowRight", 39);
  assert.equal((await lb()).count, `${k0 + 2} / 9`);
  assert.equal((await lb()).drive, `https://drive.google.com/file/d/${D.files[set[k0 + 1]].i}/view`);
  await b.key("ArrowLeft", 37);
  assert.equal((await lb()).count, `${k0 + 1} / 9`);
  await b.evalJs(`document.getElementById('lbNext').click()`);
  assert.equal((await lb()).count, `${k0 + 2} / 9`);
  await b.evalJs(`document.getElementById('lbPrev').click()`);
  const walk = await b.evalJs(`(() => { const nx = document.getElementById('lbNext'), pv = document.getElementById('lbPrev'), c = document.getElementById('lbCount');
    while (!pv.disabled) pv.click(); const out = [c.textContent]; while (!nx.disabled) { nx.click(); out.push(c.textContent); } return out; })()`);
  assert.deepEqual(walk, set.map((_, k) => `${k + 1} / 9`));

  // focus stays inside
  for (let k = 0; k < 8; k++) {
    await b.key("Tab", 9);
    assert.equal((await lb()).focusIn, true, `tab ${k}`);
  }

  // Esc closes; focus returns to the tile last looked at (the clicked one if nothing stepped)
  await b.key("Escape", 27);
  a = await lb();
  assert.equal(a.open, false);
  assert.equal(await b.evalJs(`document.activeElement?.dataset?.n`), String(set[8]));
  assert.equal(await b.evalJs(`document.body.classList.contains('lbOpen')`), false);
  await b.evalJs(`document.querySelector('.tile[data-n="${photo}"]').click()`);
  await b.key("Escape", 27);
  assert.equal(await b.evalJs(`document.activeElement?.dataset?.n`), String(photo), "back to the clicked tile");

  // Back closes, the hold stays in the URL
  await b.evalJs(`document.querySelector('.tile[data-n="${photo}"]').click()`);
  assert.equal((await lb()).open, true);
  await b.evalJs(`history.back()`);
  assert.ok(await b.until(`document.getElementById('lb').hidden`, 2000), "Back closes");
  assert.equal(await b.evalJs(`location.hash`), "#p=1.2");
  assert.equal(await b.evalJs(`document.activeElement?.dataset?.n`), String(photo));

  // a video plays in Drive's inline player
  await b.evalJs(`document.querySelector('.tile[data-n="${set[0]}"]').click()`);
  a = await lb();
  assert.equal(a.video, true);
  assert.match(a.src, new RegExp(`^https://drive\\.google\\.com/file/d/${D.files[set[0]].i}/preview$`));
  assert.equal(a.count, "1 / 9");
  await b.key("Escape", 27);
});

test("the hold in the previewer: two held (an old &any link: together), one held, nobody held", async () => {
  await b.load(1280, 900, false, "/example/#p=1.2&any", READY);
  const both = filesWith((p) => p.includes(1) && p.includes(2));
  await b.evalJs(`document.querySelector('.tile:not([hidden])').click()`);
  assert.equal((await lb()).count, `1 / ${both.length}`);
  assert.equal(await b.evalJs(`document.getElementById('lbHold').textContent.trim()`), "");
  assert.equal(await b.evalJs(`document.querySelectorAll('#lbHold .face').length`), 2);
  await b.key("Escape", 27);

  await b.load(1280, 900, false, "/example/#p=1", READY);
  await b.evalJs(`document.querySelector('.tile:not([hidden])').click()`);
  assert.equal((await lb()).count, `1 / ${filesWith((p) => p.includes(1)).length}`);
  assert.equal(await b.evalJs(`document.querySelectorAll('#lbHold .face').length`), 1);
  assert.equal(await b.evalJs(`document.getElementById('lbHold').textContent.trim()`), "");
  await b.key("Escape", 27);

  await b.load(1280, 900, false, "/example/", READY);
  await b.evalJs(`document.querySelector('.tile[data-n="5"]').click()`);
  assert.equal((await lb()).count, "6 / 60");
  assert.equal(await b.evalJs(`document.getElementById('lbHold').hidden`), true);
  assert.equal(await b.evalJs(`document.getElementById('lbHold').getClientRects().length`), 0);
  await b.key("Escape", 27);
});

test("motion: the photo's opacity fades (250ms), its travel springs; reduced motion: neither", async () => {
  await b.load(1280, 900, false, "/example/", READY);
  await b.evalJs(`document.querySelector('.tile[data-n="1"]').click()`);
  await b.key("ArrowRight", 39);
  const m = await b.evalJs(`(() => { const el = document.querySelector('#lbStage > *');
    return el.getAnimations().map((a) => ({ props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x))))],
      dur: a.effect.getTiming().duration, ease: getComputedStyle(el).animationTimingFunction })); })()`);
  const fade = m.find((x) => x.props.includes("opacity")), move = m.find((x) => x.props.includes("transform"));
  assert.ok(fade && move, JSON.stringify(m));
  assert.deepEqual(fade.props, ["opacity"]);
  assert.deepEqual(move.props, ["transform"]);
  assert.equal(fade.dur, 250);
  assert.equal(move.dur, 420);
  assert.match(m[0].ease, /^linear\(0[ ,].*0\.1895/);
  assert.match(m[0].ease, /cubic-bezier\(0\.2, 0, 0, 1\)/);
  await b.key("Escape", 27);

  await light([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await b.load(1280, 900, false, "/example/", READY);
  await b.evalJs(`document.querySelector('.tile[data-n="1"]').click()`);
  await b.key("ArrowRight", 39);
  assert.equal(await b.evalJs(`[...document.querySelectorAll('#lb, #lb *')].some((e) => e.getAnimations().length > 0)`), false);
  await b.key("Escape", 27);
  await light();
});

test("phone: tap opens; swipes step and close; 44px controls; the counter is a light label", async () => {
  const set = filesWith((p) => p.includes(1) && p.includes(2));
  await b.load(390, 844, true, "/example/#p=1.2", READY);
  // a photo tile the panel does not cover (the held set is short: the page barely scrolls)
  const [n, x, y] = await b.evalJs(`(() => { scrollTo(0, 0); for (const n of ${js(set)}) { const t = document.querySelector('.tile[data-n="' + n + '"]');
    if (t.querySelector('.play')) continue; const r = t.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y < innerHeight && document.elementFromPoint(x, y)?.closest('.tile') === t) return [n, x, y]; } })()`);
  const k = set.indexOf(n);
  assert.ok(k > 0 && k < 7, `k ${k}`);
  await b.tap(x, y);
  assert.ok(await b.until(`!document.getElementById('lb').hidden`, 2000), "opens");
  assert.equal((await lb()).count, `${k + 1} / 9`);
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('lbCount')).color`), "rgb(242, 239, 232)");
  for (const id of ["lbPrev", "lbNext", "lbClose", "lbDrive"])
    assert.deepEqual(await b.evalJs(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.width, r.height]; })()`), [44, 44], id);
  assert.equal(await b.evalJs(`document.getElementById('lbHold').textContent.trim()`), "");
  // the hold sits clear of the arrows
  const ov = await b.evalJs(`(() => { const h = document.querySelector('#lbHold').getBoundingClientRect();
    return ['lbPrev', 'lbNext'].some((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.left < h.right && h.left < r.right && r.top < h.bottom && h.top < r.bottom; }); })()`);
  assert.equal(ov, false);

  await swipe(300, 420, 80, 425); // left: next
  assert.equal((await lb()).count, `${k + 2} / 9`);
  await swipe(80, 420, 300, 425); // right: back
  assert.equal((await lb()).count, `${k + 1} / 9`);
  await swipe(200, 300, 205, 340); // too short: settles
  assert.equal((await lb()).count, `${k + 1} / 9`);
  assert.equal((await lb()).open, true);
  await swipe(200, 300, 205, 560); // down: close
  assert.ok(await b.until(`document.getElementById('lb').hidden`, 2000), "swipe down closes");
  assert.equal(await b.evalJs(`document.activeElement?.dataset?.n`), String(n));
});

test("video: the thumbnail and the loading mark until Drive's player loads, then it fades in", async () => {
  const v = D.files.findIndex((f) => f.v);
  assert.ok(v >= 0, "the fixture has a video");
  const held = [];
  const off = b.on("Fetch.requestPaused", (p) => held.push(p.requestId)); // Drive answers only when we say
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*drive.google.com/file/*" }] });
  try {
    for (const [w, h, m] of [[390, 844, true], [1280, 900, false]]) {
      held.length = 0;
      await b.load(w, h, m, "/example/", READY);
      await b.evalJs(`document.querySelector('.tile[data-n="${v}"]').click()`);
      assert.ok(await b.until(`!!document.querySelector('#lbStage .vid iframe')`, 2000), "the player is on its way");
      assert.ok(await b.until(`(() => { const i = document.querySelector('#lbStage .vid .poster'); return i.complete && i.naturalWidth > 0; })()`, 3000), "the poster shows");
      const st = await b.evalJs(`(() => { const box = document.querySelector('#lbStage .vid'), r = box.getBoundingClientRect(), p = box.querySelector('.poster').getBoundingClientRect();
        return { w: r.width, h: r.height, pw: p.width, ph: p.height, poster: box.querySelector('.poster').getAttribute('src'),
          thumb: document.querySelector('.tile[data-n="${v}"] img').currentSrc, mark: !!box.querySelector('.symbol .top'),
          op: getComputedStyle(box.querySelector('iframe')).opacity, filter: getComputedStyle(box.querySelector('.poster')).filter }; })()`);
      assert.ok(st.w > 200 && st.h > 100, `${w}: the box has the video's size (${st.w}x${st.h})`);
      assert.ok(st.pw >= st.w && st.ph >= st.h, `${w}: the poster fills it`);
      assert.ok(st.poster === st.thumb || st.poster.endsWith(`p${v}.svg`), `${w}: the wall's thumbnail (${st.poster})`);
      assert.equal(st.mark, true, "the loading mark");
      assert.equal(st.op, "0", "the player waits unseen");
      assert.match(st.filter, /blur|brightness/);
      await sleep(600);
      assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('#lbStage .vid iframe')).opacity`), "0", "still unseen while Drive is slow");
      // Drive answers: after the load and a short settle, the player fades in on the 250ms fade
      assert.ok(await b.until(`true`) && held.length > 0, "Drive was asked");
      for (const id of held.splice(0)) await b.cdp("Fetch.fulfillRequest", { requestId: id, responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/html" }], body: Buffer.from("<!doctype html><body style=background:#000></body>").toString("base64") }).catch(() => {});
      assert.ok(await b.until(`document.querySelector('#lbStage .vid').classList.contains('ready')`, 3000), "ready after load");
      assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('#lbStage .vid iframe')).transitionDuration`), "0.25s");
      assert.ok(await b.until(`getComputedStyle(document.querySelector('#lbStage .vid iframe')).opacity === '1'`, 2000), "faded in");
      assert.ok(await b.until(`!document.querySelector('#lbStage .vid .symbol')`, 2000), "the mark goes");
      await b.key("Escape", 27);
    }
  } finally { await b.cdp("Fetch.disable"); off(); }
});

// ---- recent armfuls: localStorage["armful:recent"] ----
const DOOR = "AbCdEfGhIjKl_-123";
async function withDoor(resp, fn) {
  const off = b.on("Fetch.requestPaused", (p) => b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, ...resp() }).catch(() => {}));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*door.json*" }] });
  try { await fn(); } finally { await b.cdp("Fetch.disable"); off(); }
}
const json200 = (o) => () => ({ responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(o)).toString("base64") });
const recent = () => b.evalJs(`localStorage.getItem('armful:recent')`);

test("recents: one sanitized entry for this collection, and nothing else", async () => {
  await b.load(1280, 900, false, "/example/", READY);
  await b.evalJs(`localStorage.clear()`);
  const t0 = Date.now();
  await withDoor(json200({ title: "x", photo: DOOR, position: "center 30%" }), async () => {
    await b.load(1280, 900, false, "/example/#p=1.2", READY);
    assert.ok(await b.until(`localStorage.getItem('armful:recent') !== null`, 3000), "written");
  });
  const r = JSON.parse(await recent());
  assert.equal(r.length, 1);
  assert.deepEqual(Object.keys(r[0]), ["slug", "title", "door", "t"]);
  assert.equal(r[0].slug, "example");
  assert.equal(r[0].title, "example"); // the fixture has no title
  assert.equal(r[0].door, DOOR);
  assert.ok(r[0].t >= t0 - 5000 && r[0].t <= Date.now() + 5000);
  assert.equal(await b.evalJs(`localStorage.length`), 1, "no other keys");
  assert.doesNotMatch(await recent(), /p=|any|"n"|people|\b60\b/);

  // a bad door id, or no door.json at all: door null
  await withDoor(json200({ photo: "../../x?y" }), async () => {
    await b.load(1280, 900, false, "/example/", READY);
    assert.ok(await b.until(`JSON.parse(localStorage.getItem('armful:recent'))[0].door === null`, 3000), "bad door id dropped");
  });
  await b.evalJs(`localStorage.clear()`);
  await b.load(1280, 900, false, "/example/", READY); // door.json 404s on the test server
  assert.ok(await b.until(`localStorage.getItem('armful:recent') !== null`, 3000));
  assert.equal(JSON.parse(await recent())[0].door, null);

  // newest first, deduped by slug, max 6; older entries re-sanitized, junk dropped
  const seed = [{ slug: "example", title: "old", door: null, t: 1 }, { slug: "Bad Slug", title: "x", door: null, t: 2 }, "junk", null,
    { slug: "other-one", title: "y".repeat(200), door: "../evil", t: 3, p: [1, 2], hash: "#p=1" },
    ...[2, 3, 4, 5, 6, 7, 8].map((n) => ({ slug: `trip-0${n}`, title: `t${n}`, door: null, t: 10 + n }))];
  await b.evalJs(`localStorage.setItem('armful:recent', ${js(JSON.stringify(seed))})`);
  await b.load(1280, 900, false, "/example/", READY);
  assert.ok(await b.until(`JSON.parse(localStorage.getItem('armful:recent'))[0].t > 1000`, 3000));
  const s = JSON.parse(await recent());
  assert.equal(s.length, 6);
  assert.deepEqual(s.map((e) => e.slug), ["example", "other-one", "trip-02", "trip-03", "trip-04", "trip-05"]);
  assert.equal(s[1].title, "other-one", "a title over 80 chars falls back to the slug");
  assert.equal(s[1].door, null);
  for (const e of s) assert.deepEqual(Object.keys(e), ["slug", "title", "door", "t"]);

  // storage that throws never blocks the page
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });` }).then(async ({ identifier }) => {
    await b.load(1280, 900, false, "/example/", READY);
    await sleep(300);
    await b.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  });
  await b.load(1280, 900, false, "/example/", READY);
  await b.evalJs(`localStorage.clear()`);
});

test("nothing threw", () => assert.deepEqual(errors, []));
