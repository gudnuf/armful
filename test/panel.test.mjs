// The floating panel (desktop, top-left) and the phone rail (a pill bottom-left that opens
// upward): collapsed on arrival, faces load only when the list opens, Esc / a tap outside fold it.
// Run: node --test test/panel.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
let srv, b;
const errors = [];
const rect = (sel) => b.evalJs(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const visible = (sel) => b.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`);
// tap / click the centre of an element (scrolled into view inside its scroller first)
const centre = async (sel) => {
  const r = await b.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  return r;
};
const tap = async (sel) => { const [x, y] = await centre(sel); await b.tap(x, y); };
const click = async (sel) => { const [x, y] = await centre(sel); await b.click(x, y); };
const same = (a, c) => ["left", "top", "width", "height"].every((k) => Math.abs(a[k] - c[k]) <= 1);

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ROOT, "test", "fixture")], { stdio: "ignore" });
  srv = await serve();
  b = await launch(srv.url);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});
after(async () => { await b?.close(); await srv?.close(); });

test("phone: a pill bottom-left, collapsed; the rail opens upward and the pill stays put", async () => {
  await b.load(390, 844, true, "/example/", READY);
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('panel')).position`), "fixed");
  assert.equal(await visible("#list"), false);
  assert.equal(await visible("#people"), true);
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "false");
  const panel = await rect("#panel");
  assert.ok(844 - panel.bottom <= 40 && panel.bottom <= 844, `panel bottom at ${panel.bottom}`);
  assert.ok(Math.abs(panel.left - 14) <= 1, `panel left at ${panel.left}`);
  const pill = await rect("#people");
  assert.ok(pill.height >= 44, `pill is ${pill.height}px tall`);
  assert.ok(pill.bottom <= 844 && pill.left >= 14, "the pill is on screen");
  // words: the collection label, the people count, +N more; no names
  assert.equal(await b.evalJs(`document.getElementById('peopleLabel').textContent`), "10 people");
  assert.equal(await b.evalJs(`document.getElementById('more').textContent.trim()`), "+2 more");
  assert.equal(await b.evalJs(`document.getElementById('slug').textContent`), "example · 60");
  // the stack's three faces load with the page; the list's only when it opens
  assert.ok(await b.until(`[...document.querySelectorAll('#people .stack img')].length === 3 && [...document.querySelectorAll('#people .stack img')].every((i) => i.complete && i.naturalWidth > 0)`), "stack faces loaded");
  assert.equal(await b.evalJs(`[...document.querySelectorAll('#list img')].filter((i) => i.getAttribute('src')).length`), 0);

  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), "list opens");
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "true");
  assert.equal(await b.evalJs(`document.body.classList.contains('panelOpen')`), true);
  await sleep(500); // past any motion
  const list = await rect("#list");
  assert.ok(list.bottom <= (await rect("#people")).top + 1, "the list sits above the pill");
  assert.ok(same(pill, await rect("#people")), `pill moved: ${JSON.stringify(pill)} -> ${JSON.stringify(await rect("#people"))}`);
  assert.ok(await b.until(`[...document.querySelectorAll('#listMain img')].slice(0, 3).every((i) => i.getAttribute('src'))`), "list faces load once open");

  const rows = await b.evalJs(`[...document.querySelectorAll('#listMain li')].map((li) => ({
    pid: +li.querySelector('.face').dataset.pid, count: li.querySelector('.count').textContent, label: li.querySelector('.face').getAttribute('aria-label'),
    s: li.querySelector('.face img').getBoundingClientRect().width }))`);
  const people = await b.evalJs(`armful.D.people`);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.pid).sort((x, y) => x - y), people.filter((p) => !p.x).map((p) => p.id).sort((x, y) => x - y));
  for (const r of rows) {
    const p = people.find((q) => q.id === r.pid);
    assert.equal(r.count, String(p.n), `person ${r.pid}`);
    assert.equal(r.label, `Person ${r.pid}, ${p.n} photos`);
    assert.equal(r.s, 44);
  }

  await tap("#more");
  assert.ok(await b.until(`document.getElementById('listMore').getClientRects().length > 0`), "+2 more opens");
  assert.equal(await b.evalJs(`document.querySelectorAll('#listMore li').length`), 2);
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('list')).overflowY`), "auto");
  assert.equal(await b.evalJs(`(() => { const l = document.getElementById('list'); return l.scrollHeight >= l.clientHeight; })()`), true);
  assert.ok((await rect("#list")).height <= 844 * 0.6 + 1, "the rail is capped at 60vh");
  await sleep(500);
  assert.ok(same(pill, await rect("#people")), "pill still in place after +more");

  await b.key("Escape", 27);
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`), "Esc folds it");
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "false");
  assert.ok(same(pill, await rect("#people")), "pill still in place after closing");
});

test("phone: a tap outside folds the rail without opening the photo", async () => {
  await b.load(390, 844, true, "/example/", READY);
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`));
  await b.tap(300, 120); // a tile, top-right, clear of the rail
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`), "outside tap folds it");
  assert.equal(await b.evalJs(`document.getElementById('lb').hidden`), true);
  // tapping the pill again opens, and again folds
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`));
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`));
});

test("desktop: the panel floats top-left over the wall, the list opens below the pill", async () => {
  await b.load(1440, 900, false, "/example/", READY);
  const panel = await rect("#panel");
  assert.ok(Math.abs(panel.left - 18) <= 1 && Math.abs(panel.top - 18) <= 1, `panel at ${panel.left},${panel.top}`);
  assert.ok(Math.abs(panel.width - 236) <= 1, `panel is ${panel.width} wide`);
  assert.equal(await visible("#list"), false);
  assert.equal(await visible(".panel .mark"), true);
  const pill = await rect("#people");
  await click("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), "click opens");
  const list = await rect("#list");
  assert.ok(list.top >= pill.bottom - 1, "the list opens below the pill");
  assert.ok(same(pill, await rect("#people")), "the pill keeps its place");
  assert.equal(await b.evalJs(`document.querySelector('#listMain .face img').getBoundingClientRect().width`), 36);
  const over = await b.evalJs(`(() => { const p = document.getElementById('panel').getBoundingClientRect();
    return [...document.querySelectorAll('#wall .tile')].some((t) => { const r = t.getBoundingClientRect();
      return r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top; }); })()`);
  assert.equal(over, true, "the wall runs under the panel");
  assert.ok(list.bottom <= 900, "the list fits the screen");
  await click("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`), "click again folds");
});

test("updateCounts writes every count and dims the zeros", async () => {
  await b.load(1440, 900, false, "/example/", READY);
  const out = await b.evalJs(`(() => { armful.updateCounts((pid) => pid === 3 ? 0 : pid * 100);
    const f = (pid) => document.querySelector('.face[data-pid="' + pid + '"]');
    const c = (pid) => document.querySelector('.count[data-pid="' + pid + '"]').textContent;
    return { c3: c(3), d3: f(3).classList.contains('dim'), c12: c(12), d12: f(12).classList.contains('dim'), l12: f(12).getAttribute('aria-label') }; })()`);
  assert.deepEqual(out, { c3: "0", d3: true, c12: "1,200", d12: false, l12: "Person 12, 1,200 photos" });
});

test("nothing threw", () => assert.deepEqual(errors, []));
