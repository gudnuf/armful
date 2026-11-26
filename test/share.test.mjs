// Sharing: the previewer's share button hands the real file to the share sheet
// (navigator.share({ files: [File] }), stubbed here), with a ring while it fetches and a ready dot
// when the sheet wants a fresh tap; without file sharing a phone shares the view's link and a desktop
// downloads. The link button shares exactly this view (the query and the open photo, o=<id>), or
// copies it with a quiet "Link copied"; such a link opens on that photo and the URL drops o=. Select
// mode: a long press (or a shift-click) starts it, taps add and remove with a check and a count, 30 at
// most, share sends every chosen file at once, save downloads them one after another, × and Esc end it.
// None of it moves the layout (CLS 0, tiles and pill where they were) at 390x844 and 1440x900.
// The fixture's data.json gets thumbs.file (fx/p{i}.svg) so the "full-size" files are local.
// Run: node --test test/share.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
const js = JSON.stringify;
let FX, srv, b, D;
const errors = [];
const OBSERVE = `window.__cls = 0; window.__shifts = [];
new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue; window.__cls += e.value;
  window.__shifts.push(e.value.toFixed(4) + "@" + Math.round(e.startTime) + "ms " + (e.sources || []).map((s) => s.node ?
    (s.node.id ? "#" + s.node.id : (typeof s.node.className === "string" && s.node.className ? "." + s.node.className.split(" ")[0] : s.node.nodeName)) : "?").join(",")); } })
  .observe({ type: "layout-shift", buffered: true });`;
// the share sheet, the clipboard and downloads, stubbed: every call is recorded on window.__log
// mode: { files: can share files, share: navigator.share exists, reject: the next share's DOMException name }
const STUB = (mode) => `(() => {
  window.__mode = ${js(mode)}; window.__log = { share: [], copy: [], dl: [] };
  const desc = (f) => ({ name: f.name, type: f.type, size: f.size, file: f instanceof File });
  if (__mode.share) {
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
      __log.share.push({ url: d.url || null, files: (d.files || []).map(desc) });
      if (__mode.reject) { const n = __mode.reject; __mode.reject = null; throw new DOMException('stub', n); }
    } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => (d && d.files ? !!__mode.files : true) });
  } else { delete Navigator.prototype.share; delete Navigator.prototype.canShare;
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined }); }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { __log.copy.push(t); } } });
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { __log.dl.push({ href: this.href, name: this.download }); return; } return click.call(this); };
})()`;
const log = () => b.evalJs(`window.__log`);
let mobile = true;
const where = (expr) => b.evalJs(`(() => { const e = ${expr}; if (!e) throw new Error('none: ' + ${js(expr)});
  e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const press = async (expr) => { const [x, y] = await where(expr); if (mobile) await b.tap(x, y); else await b.click(x, y); };
const tapId = (id) => press(`document.getElementById(${js(id)})`);
const tile = (n) => `document.querySelector('.tile[data-n="${n}"]')`;
// a held press on a tile: touch on a phone, the mouse on a desktop
async function longPress(n) {
  const [x, y] = await where(tile(n));
  if (mobile) {
    await b.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(650);
    await b.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await b.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(650);
    await b.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  await sleep(100);
}
async function shiftClick(n) {
  const [x, y] = await where(tile(n));
  for (const type of ["mousePressed", "mouseReleased"]) await b.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, modifiers: 8 });
}
const SELN = `({ on: document.body.classList.contains('selecting'), bar: !document.getElementById('selbar').hidden, n: document.getElementById('selN').textContent,
  sel: [...document.querySelectorAll('#wall .tile.sel')].map((t) => +t.dataset.n), lb: !document.getElementById('lb').hidden })`;
const selState = () => b.evalJs(SELN);
// the boxes that must never move: the visible tiles, the pill (or the select bar in its place) and the header
const BOXES = `(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(','); };
  return { tiles: [...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden).slice(0, 24).map(r), bar: r(document.getElementById('bar')), head: r(document.querySelector('.masthead')),
    scroll: scrollY, doc: document.documentElement.scrollHeight }; })()`;
const visibleTile = (k = 0) => b.evalJs(`[...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden && t.getBoundingClientRect().top > 70 && t.getBoundingClientRect().bottom < innerHeight - 90)[${k}].dataset.n`);
const photoSize = (i) => statSync(join(FX, "fx", `p${i}.svg`)).size;

before(async () => {
  FX = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-share-"));
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), FX], { stdio: "ignore" });
  const data = JSON.parse(readFileSync(join(FX, "data.json"), "utf8"));
  data.thumbs.file = "fx/p{i}.svg"; // the "full-size file": the local placeholder
  writeFileSync(join(FX, "data.json"), JSON.stringify(data));
  D = data;
  srv = await serve({ fixture: FX, delay: { [join("fx", "p5.svg")]: 700 } }); // file 5 is slow: the ring shows
  b = await launch(srv.url);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVE });
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});
after(async () => { await b?.close(); await srv?.close(); if (FX) rmSync(FX, { recursive: true, force: true }); });

test("previewer: share hands the real file to the share sheet, with a ring while it comes", async () => {
  mobile = true;
  await b.load(390, 844, true, "/example/", READY);
  await b.evalJs(STUB({ files: true, share: true }));
  assert.equal(await b.evalJs(`matchMedia('(pointer: coarse)').matches`), true, "the phone is coarse");
  await press(tile(5));
  assert.ok(await b.until(`!document.getElementById('lb').hidden`), "previewer open");
  const box = await b.evalJs(`document.getElementById('lbShare').getBoundingClientRect().toJSON()`);
  assert.deepEqual([box.width, box.height], [44, 44]);
  // the new buttons sit in the top row; the arrows keep their own places (low, at the two edges)
  const nav = await b.evalJs(`['lbPrev', 'lbNext'].map((id) => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return [getComputedStyle(e).position, r.bottom > innerHeight - 90]; })`);
  assert.deepEqual(nav, [["absolute", true], ["absolute", true]]);
  const top = await b.evalJs(`['lbLink', 'lbShare', 'lbDrive', 'lbClose'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top))`);
  assert.equal(new Set(top).size, 1, `one row: ${top}`);
  await tapId("lbShare");
  assert.ok(await b.until(`document.getElementById('lbShare').classList.contains('busy') && document.getElementById('lbShare').getAttribute('aria-busy') === 'true'`, 600), "the ring while the file comes");
  assert.deepEqual(await b.evalJs(`document.getElementById('lbShare').getBoundingClientRect().toJSON()`), box, "the button keeps its box while busy");
  assert.ok(await b.until(`window.__log.share.length === 1`, 5000), "shared");
  const l = await log();
  assert.deepEqual(l.share[0], { url: null, files: [{ name: "example-06.svg", type: "image/svg+xml", size: photoSize(5), file: true }] });
  assert.equal(await b.evalJs(`document.getElementById('lbShare').classList.contains('busy')`), false, "the ring goes");
  assert.deepEqual(l.dl, []);
});

test("previewer: a stale tap (NotAllowedError) keeps the file; the next tap shares it at once", async () => {
  await b.load(390, 844, true, "/example/", READY);
  await b.evalJs(STUB({ files: true, share: true, reject: "NotAllowedError" }));
  await press(tile(3));
  assert.ok(await b.until(`!document.getElementById('lb').hidden`));
  await b.evalJs(`window.__fetches = 0; const f = window.fetch; window.fetch = (...a) => { window.__fetches++; return f(...a); }`);
  await tapId("lbShare");
  assert.ok(await b.until(`document.getElementById('lbShare').classList.contains('ready')`, 5000), "the ready dot");
  assert.equal(await b.evalJs(`document.getElementById('toast').textContent`), "Ready: tap share again");
  await tapId("lbShare");
  assert.ok(await b.until(`window.__log.share.length === 2`, 3000));
  assert.equal(await b.evalJs(`window.__fetches`), 1, "fetched once");
  assert.equal((await log()).share[1].files[0].size, photoSize(3));
  assert.equal(await b.evalJs(`document.getElementById('lbShare').classList.contains('ready')`), false);
});

test("previewer: no file sharing: a phone shares the view's link, a desktop downloads the file", async () => {
  await b.load(390, 844, true, "/example/#m=f", READY);
  await b.evalJs(STUB({ files: false, share: true }));
  await press(tile(3));
  assert.ok(await b.until(`!document.getElementById('lb').hidden`));
  await tapId("lbShare");
  assert.ok(await b.until(`window.__log.share.length === 1`, 3000));
  assert.deepEqual((await log()).share[0], { url: `${srv.url}/example/#m=f&o=${D.files[3].i}`, files: [] });

  mobile = false;
  await b.load(1440, 900, false, "/example/", READY);
  await b.evalJs(STUB({ files: false, share: false }));
  await press(tile(3));
  assert.ok(await b.until(`!document.getElementById('lb').hidden`));
  await tapId("lbShare");
  assert.ok(await b.until(`window.__log.dl.length === 1`, 3000), "downloaded");
  const dl = (await log()).dl[0];
  assert.match(dl.href, /^blob:/);
  assert.equal(dl.name, "example-04.svg");
  mobile = true;
});

test("the view's link: the query and the open photo, by the share sheet or copied with a quiet line", async () => {
  // the filters card's link: the query only
  await b.load(390, 844, true, "/example/#p=1.2&m=f", READY);
  await b.evalJs(STUB({ files: true, share: true }));
  await tapId("fbtn");
  assert.ok(await b.until(`!document.getElementById('filters').hidden`));
  const lnk = await b.evalJs(`document.getElementById('viewLink').getBoundingClientRect().toJSON()`);
  assert.ok(lnk.width >= 28 && lnk.height >= 28, "a 28px target");
  await tapId("viewLink");
  assert.ok(await b.until(`window.__log.share.length === 1`, 3000));
  assert.equal((await log()).share[0].url, `${srv.url}/example/#p=1.2&m=f`);
  // cancelled in the sheet: nothing else happens
  await b.evalJs(`window.__mode.reject = 'AbortError'`);
  await tapId("viewLink");
  await sleep(300);
  assert.deepEqual((await log()).copy, [], "a cancel copies nothing");
  // no share sheet: the clipboard, and "Link copied"
  await b.evalJs(STUB({ files: false, share: false }));
  await tapId("viewLink");
  assert.ok(await b.until(`window.__log.copy.length === 1`, 3000));
  assert.equal((await log()).copy[0], `${srv.url}/example/#p=1.2&m=f`);
  assert.equal(await b.evalJs(`document.getElementById('toast').textContent`), "Link copied");
  assert.equal(await b.evalJs(`document.getElementById('toast').classList.contains('on')`), true);
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('toast')).position`), "fixed");
  // the previewer's link: the open photo too
  await b.evalJs(`armful.panelOpen(false)`);
  await press(tile(D.files.findIndex((f, i) => i > 0 && !f.v && f.p.includes(1) && f.p.includes(2))));
  assert.ok(await b.until(`!document.getElementById('lb').hidden`));
  const open = await b.evalJs(`armful.state.lb >= 0 && armful.D.files[[...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden).map((t) => +t.dataset.n)[armful.state.lb]].i`);
  await tapId("lbLink");
  assert.ok(await b.until(`window.__log.copy.length === 2`, 3000));
  assert.equal((await log()).copy[1], `${srv.url}/example/#p=1.2&m=f&o=${open}`);
});

test("a link with o= opens that photo over its view; the URL drops o=, Back closes it", async () => {
  const i = D.files.findIndex((f, k) => k > 3 && !f.v && f.p.includes(1));
  await b.load(390, 844, true, `/example/#p=1&o=${D.files[i].i}`, READY);
  assert.ok(await b.until(`!document.getElementById('lb').hidden`, 3000), "the previewer opens");
  assert.equal(await b.evalJs(`armful.D.files[[...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden).map((t) => +t.dataset.n)[armful.state.lb]].i`), D.files[i].i);
  assert.equal(await b.evalJs(`location.hash`), "#p=1", "o= is gone from the URL");
  assert.deepEqual(await b.evalJs(`armful.state.picked`), [1], "the query holds");
  await b.evalJs(`history.back()`);
  assert.ok(await b.until(`document.getElementById('lb').hidden`, 3000), "Back closes it");
  assert.equal(await b.evalJs(`location.hash`), "#p=1");
  // an o= the view does not show (or no such file): just the view
  await b.load(390, 844, true, `/example/#m=v&o=${D.files[i].i}`, READY);
  await sleep(300);
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), true);
  assert.equal(await b.evalJs(`location.hash`), "#m=v");
  await b.load(390, 844, true, `/example/#o=nope<script>`, READY);
  await sleep(300);
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), true);
});

test("select mode: long press starts it, taps add and remove, a check and a count, 30 at most, Esc and × end it", async () => {
  for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
    mobile = m;
    await b.load(w, h, m, "/example/", READY);
    await b.evalJs(STUB({ files: true, share: true }));
    const [a, c, d] = [await visibleTile(0), await visibleTile(1), await visibleTile(2)].map(Number);
    await longPress(a);
    let s = await selState();
    assert.deepEqual([s.on, s.bar, s.n, s.sel, s.lb], [true, true, "1", [a], false], `${w}: the long press chose it and opened nothing`);
    // the check: a filled disc on the chosen tile's corner
    const chk = await b.evalJs(`(() => { const t = ${tile(a)}, x = getComputedStyle(t, '::after'), o = getComputedStyle(${tile(c)}, '::after');
      return { chosen: x.content !== 'none' && x.backgroundImage.startsWith('url('), other: o.content !== 'none' && o.backgroundImage === 'none' }; })()`);
    assert.deepEqual(chk, { chosen: true, other: true }, `${w}: a check on the chosen, an empty ring on the rest`);
    await press(tile(c)); await press(tile(d));
    s = await selState();
    assert.deepEqual([s.n, s.sel.sort((x, y) => x - y)], ["3", [a, c, d].sort((x, y) => x - y)], `${w}: taps add`);
    await press(tile(c));
    s = await selState();
    assert.deepEqual([s.n, s.lb], ["2", false], `${w}: a tap again removes`);
    // the bar in the pill's place, the pill hidden with its box kept
    const bars = await b.evalJs(`(() => { const p = document.getElementById('bar'), q = document.getElementById('selbar'); return { pill: getComputedStyle(p).visibility,
      left: Math.abs(p.getBoundingClientRect().left - q.getBoundingClientRect().left) < 1, bottom: Math.abs(p.getBoundingClientRect().bottom - q.getBoundingClientRect().bottom) < 1 }; })()`);
    assert.deepEqual(bars, { pill: "hidden", left: true, bottom: true }, `${w}: the select bar sits where the pill is`);
    await b.key("Escape", 27);
    s = await selState();
    assert.deepEqual([s.on, s.bar, s.sel], [false, false, []], `${w}: Esc ends it`);
    // start again, end with ×
    if (m) await longPress(d); else await shiftClick(d);
    s = await selState();
    assert.deepEqual([s.on, s.sel, s.lb], [true, [d], false], `${w}: ${m ? "long press" : "shift-click"} starts it`);
    await tapId("selX");
    s = await selState();
    assert.deepEqual([s.on, s.bar], [false, false], `${w}: × ends it`);
    // a plain tap opens the previewer again
    await press(tile(a));
    assert.ok(await b.until(`!document.getElementById('lb').hidden`), `${w}: back to normal taps`);
    await b.key("Escape", 27);
  }
  // 30 at most
  mobile = true;
  await b.load(390, 844, true, "/example/", READY);
  await b.evalJs(`armful.selStart(); for (let i = 0; i < 31; i++) armful.selToggle(i)`);
  assert.deepEqual([(await selState()).n, await b.evalJs(`document.getElementById('toast').textContent`)], ["30", "30 at most at once"]);
});

test("select mode: share sends every chosen file at once; save downloads them one after another", async () => {
  mobile = true;
  await b.load(390, 844, true, "/example/", READY);
  await b.evalJs(STUB({ files: true, share: true }));
  const pick = [3, 7, 9];
  await b.evalJs(`armful.selStart(); ${js(pick)}.forEach((i) => armful.selToggle(i))`);
  await tapId("selShare");
  assert.ok(await b.until(`window.__log.share.length === 1`, 5000));
  assert.deepEqual((await log()).share[0].files, pick.map((i) => ({ name: `example-${String(i + 1).padStart(2, "0")}.svg`, type: "image/svg+xml", size: photoSize(i), file: true })));
  await tapId("selSave");
  assert.ok(await b.until(`window.__log.dl.length === 3`, 5000), "three downloads");
  assert.deepEqual((await log()).dl.map((x) => x.name), pick.map((i) => `example-${String(i + 1).padStart(2, "0")}.svg`));
  assert.ok(await b.until(`document.getElementById('toast').textContent === 'Saved 3 files'`, 3000));
  // no file sharing: share saves instead
  await b.evalJs(STUB({ files: false, share: true }));
  await tapId("selShare");
  assert.ok(await b.until(`window.__log.dl.length === 3`, 5000));
  assert.deepEqual((await log()).share, []);
  assert.equal((await selState()).on, true, "still selecting after an action");
});

// every new interaction, measured: no layout shift, and the tiles, the pill and the header stay put
for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
  test(`CLS 0 for sharing and selecting at ${w}x${h}`, { timeout: 120000 }, async () => {
    mobile = m;
    await b.load(w, h, m, "/example/", READY);
    await b.evalJs(STUB({ files: true, share: true }));
    await sleep(800);
    const base = await b.evalJs(BOXES);
    const [a, c] = [Number(await visibleTile(0)), Number(await visibleTile(1))];
    const still = async (name) => assert.deepEqual(await b.evalJs(BOXES), base, `${w}x${h} ${name}: the wall, the pill and the header did not move`);
    const steps = [
      ["open a photo", () => press(tile(a))],
      ["share its file", async () => { await tapId("lbShare"); await b.until(`window.__log.share.length === 1`, 5000); }],
      ["share its link", async () => { await b.evalJs(`window.__mode.share = true`); await tapId("lbLink"); }],
      ["close it", () => b.key("Escape", 27)],
      ["open the filters", () => tapId("fbtn")],
      ["share the view", () => tapId("viewLink")],
      ["copy the view", async () => { await b.evalJs(STUB({ files: true, share: false })); await tapId("viewLink"); }],
      ["fold", () => tapId("chev")],
      ["start selecting", async () => { await b.evalJs(STUB({ files: true, share: true })); await longPress(a); }],
      ["choose another", () => press(tile(c))],
      ["let one go", () => press(tile(c))],
      ["share the chosen", async () => { await tapId("selShare"); await b.until(`window.__log.share.length === 1`, 5000); }],
      ["save the chosen", async () => { await tapId("selSave"); await b.until(`window.__log.dl.length === 1`, 5000); }],
      ["Esc ends it", () => b.key("Escape", 27)],
      [m ? "long press again" : "shift-click", () => (m ? longPress(c) : shiftClick(c))],
      ["× ends it", () => tapId("selX")],
    ];
    await b.evalJs(`window.__cls = 0; window.__shifts = []`);
    const out = [];
    for (const [name, fn] of steps) {
      await fn();
      await sleep(900); // past the motion and the 500ms input window: a late shift would count
      const { cls, shifts } = await b.evalJs(`({ cls: window.__cls, shifts: window.__shifts.splice(0) })`);
      await b.evalJs(`window.__cls = 0`);
      out.push(`${name}: ${cls.toFixed(4)}${shifts.length ? " " + shifts.join(" | ") : ""}`);
      assert.equal(cls, 0, `${w}x${h} ${name}: CLS ${cls} ${shifts.join(" | ")}`);
      if (!/photo|share its|close/.test(name)) await still(name);
    }
    console.log(`cls ${w}x${h}\n  ` + out.join("\n  "));
  });
}

test("nothing threw", () => assert.deepEqual(errors, []));
