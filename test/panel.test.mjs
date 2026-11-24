// The header (wordmark + numbers) and the people: one compact pill bottom-left that opens a
// narrow, barely veiled rail of faces up the left edge. Collapsed on arrival, faces load only when
// the rail opens; the wall keeps scrolling and taking taps beside it; the pill or Esc folds it.
// Run: node --test test/panel.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
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

const NO_HINTS = /together|\bany\b|tap|narrow|separate|overlap/i;
// text in the pill that is painted (screen-reader-only text sits in a 1px clipped box)
const NO_TEXT = `(() => { const out = []; const w = document.createTreeWalker(document.getElementById('bar'), NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { if (!n.textContent.trim()) continue; const r = document.createRange(), box = n.parentElement.getBoundingClientRect(); r.selectNodeContents(n);
      if (box.width > 1 && box.height > 1 && [...r.getClientRects()].some((x) => x.width > 1 && x.height > 1)) out.push(n.textContent.trim()); } return out; })()`;
// the header's numbers: right-aligned text, ending within 16px of the right edge
const rightAligned = async (w) => {
  const s = await b.evalJs(`(() => { const e = document.getElementById('stats'), r = document.createRange(); r.selectNodeContents(e);
    const t = r.getBoundingClientRect(); return { right: t.right, align: getComputedStyle(e).textAlign, num: getComputedStyle(e).fontVariantNumeric }; })()`);
  assert.ok(w - s.right <= 16 && s.right <= w, `${w}: the numbers end ${w - s.right}px from the right edge`);
  assert.equal(s.align, "right");
  assert.equal(s.num, "tabular-nums");
};

test("phone: a header, a compact pill bottom-left; the rail is a narrow column up the left edge", async () => {
  await b.load(390, 844, true, "/example/", READY);
  // the header: the wordmark linking home, the numbers beside it; its height is reserved
  const head = await rect(".masthead");
  assert.equal(head.top, 0);
  assert.equal(head.height, 48);
  const mark = await rect(".masthead .mark svg");
  assert.ok(Math.abs(mark.width - 72) <= 1 && mark.left <= 24, `wordmark ${JSON.stringify(mark)}`);
  assert.equal(await b.evalJs(`document.querySelector('.masthead .mark').getAttribute('href')`), "/");
  assert.equal(await b.evalJs(STATS), statsFor(12, 57, 3));
  assert.ok(Math.abs((await rect("#stats")).top + (await rect("#stats")).height / 2 - (mark.top + mark.height / 2)) <= 3, "one line");
  await rightAligned(390);
  assert.equal(await b.evalJs(`document.querySelector('#panel .mark, #slug')`), null, "no wordmark or slug in the panel");
  assert.equal((await rect("#wall")).top, head.bottom, "the wall starts under the header");

  // the pill: bottom-left, within 24px of the corner, ~52px tall, as wide as its content
  assert.equal(await visible("#list"), false);
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "false");
  const bar = await rect("#bar");
  assert.ok(bar.left <= 24 && 844 - bar.bottom <= 24 && bar.bottom <= 844, `pill at ${JSON.stringify(bar)}`);
  assert.ok(bar.height >= 50 && bar.height <= 54, `pill is ${bar.height}px tall`);
  assert.ok(bar.width < 260, `pill is ${bar.width}px wide`);
  const pill = await rect("#people");
  assert.ok(pill.height >= 44, `pill button is ${pill.height}px tall`);
  assert.equal(await b.evalJs(`document.getElementById('peopleLabel').textContent`), "12 people", "said to screen readers");
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-label')`), "People filter, 12 people");
  assert.deepEqual(await b.evalJs(NO_TEXT), [], "the pill shows no words");
  assert.equal(await b.evalJs(`document.querySelector('#more, #listMore, #list button:not(.face):not(.clearAll)')`), null, "one list, no +N more");
  assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('#list .clearAll')).visibility`), "hidden", "nothing chosen: no clear all");
  assert.equal(await visible("#pair"), false);
  assert.equal(await visible("#clear"), false);
  // the stack's three faces load with the page; the list's only when it opens
  assert.ok(await b.until(`[...document.querySelectorAll('#people .stack img')].length === 3 && [...document.querySelectorAll('#people .stack img')].every((i) => i.complete && i.naturalWidth > 0)`), "stack faces loaded");
  assert.equal(await b.evalJs(`[...document.querySelectorAll('#list img')].filter((i) => i.getAttribute('src')).length`), 0);

  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), "list opens");
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "true");
  await sleep(500); // past any motion
  const list = await rect("#list");
  assert.ok(list.bottom <= (await rect("#bar")).top + 1, "the rail sits above the pill");
  assert.ok(list.left <= 16, `the rail hugs the left edge (${list.left})`);
  assert.ok(list.width <= 110, `the rail is narrow: ${list.width}px`);
  assert.ok(same(pill, await rect("#people")), `pill moved: ${JSON.stringify(pill)} -> ${JSON.stringify(await rect("#people"))}`);
  assert.ok(await b.until(`[...document.querySelectorAll('#listMain img')].slice(0, 3).every((i) => i.getAttribute('src'))`), "list faces load once open");
  // barely a veil: nothing dark or opaque behind the column, and none over the rest of the wall
  const bg = await b.evalJs(`getComputedStyle(document.getElementById('list')).backgroundImage`);
  assert.match(bg, /gradient/);
  for (const a of [...bg.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((m) => +m[1])) assert.ok(a <= 0.6, `veil alpha ${a}`);
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('panel')).backgroundColor`), "rgba(0, 0, 0, 0)");
  assert.doesNotMatch(await b.evalJs(`document.getElementById('panel').innerText`), NO_HINTS);

  const rows = await b.evalJs(`[...document.querySelectorAll('#listMain li')].map((li) => ({
    pid: +li.querySelector('.face').dataset.pid, count: li.querySelector('.count').textContent, label: li.querySelector('.face').getAttribute('aria-label'),
    s: li.querySelector('.face img').getBoundingClientRect().width, h: li.querySelector('.face').getBoundingClientRect().height }))`);
  const people = await b.evalJs(`armful.D.people`);
  assert.equal(rows.length, 12, "everyone data.json names");
  assert.deepEqual(rows.map((r) => r.pid).sort((x, y) => x - y), people.map((p) => p.id).sort((x, y) => x - y));
  for (const r of rows) {
    const p = people.find((q) => q.id === r.pid);
    assert.equal(r.count, String(p.n), `person ${r.pid}`);
    assert.equal(r.label, `Person ${r.pid}, ${p.n} photos`);
    assert.equal(r.s, 44);
    assert.ok(r.h >= 44, "44px tap target");
  }

  // the whole list scrolls inside the rail, between the top and the pill
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('list')).overflowY`), "auto");
  const tall = await rect("#list");
  assert.ok(tall.top >= 0 && tall.bottom <= (await rect("#bar")).top + 1, `the rail fits between the top and the pill: ${JSON.stringify(tall)}`);
  assert.ok(tall.width <= 110, `still narrow: ${tall.width}px`);
  await sleep(500);
  assert.ok(same(pill, await rect("#people")), "pill still in place");

  await b.key("Escape", 27);
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`), "Esc folds it");
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "false");
  assert.ok(same(pill, await rect("#people")), "pill still in place after closing");
});

test("phone: the rail stays open while the wall scrolls and opens photos; only the chevron or Esc closes it", async () => {
  await b.load(390, 844, true, "/example/", READY);
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`));
  await b.evalJs(`scrollTo(0, 400)`);
  await sleep(100);
  assert.equal(await visible("#list"), true, "scrolling keeps it open");
  // a tile clear of the rail: the previewer opens, the rail stays
  const n = await b.evalJs(`(() => { const x = 300; for (let y = 200; y < 700; y += 40) { const t = document.elementFromPoint(x, y)?.closest('.tile'); if (t) return [x, y]; } })()`);
  await b.tap(n[0], n[1]);
  assert.ok(await b.until(`!document.getElementById('lb').hidden`, 2000), "the tile opens the previewer");
  assert.equal(await b.evalJs(`document.getElementById('list').hidden`), false, "the rail stays open under it");
  await b.key("Escape", 27); // closes the previewer only
  assert.ok(await b.until(`document.getElementById('lb').hidden`, 2000));
  assert.equal(await visible("#list"), true, "Esc in the previewer leaves the rail open");
  // the chevron (the pill) folds it, and opens it again
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`), "the pill folds it");
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`));
  await b.key("Escape", 27);
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length === 0`), "Esc folds it");
});

test("desktop: header top-left, the pill bottom-left, the rail a narrow column above it", async () => {
  await b.load(1440, 900, false, "/example/", READY);
  assert.equal(await b.evalJs(STATS), statsFor(12, 57, 3));
  await rightAligned(1440);
  assert.ok((await rect(".masthead .mark")).left <= 24);
  const bar = await rect("#bar");
  assert.ok(bar.left <= 24 && 900 - bar.bottom <= 24, `pill at ${JSON.stringify(bar)}`);
  assert.equal(await visible("#list"), false);
  const pill = await rect("#people");
  await click("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), "click opens");
  await sleep(500); // past the rail's rise
  const list = await rect("#list");
  assert.ok(list.bottom <= bar.top + 1, "the rail sits above the pill");
  assert.ok(list.width <= 130, `narrow: ${list.width}`);
  assert.ok(same(pill, await rect("#people")), "the pill keeps its place");
  assert.equal(await b.evalJs(`document.querySelector('#listMain .face img').getBoundingClientRect().width`), 56);
  assert.ok(list.top >= 0 && list.bottom <= 900, "the rail fits the screen");
  // a click on the wall opens the photo and leaves the rail open
  await b.click(900, 500);
  assert.ok(await b.until(`!document.getElementById('lb').hidden`, 2000));
  assert.equal(await b.evalJs(`document.getElementById('list').hidden`), false);
  await b.key("Escape", 27);
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

test("uncertain people (x, from a debugging build) are ignored: not listed, not counted, not on any photo", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-x-"));
  try {
    const fx = join(ROOT, "test", "fixture");
    const d = JSON.parse(readFileSync(join(fx, "data.json"), "utf8"));
    // person 99, uncertain, on the first ten files (some of them otherwise empty)
    d.people.push({ id: 99, n: 10, nv: 0, x: 1, rep: { f: 0, box: [0, 0, 100], sz: 400, c: 1 } });
    d.files.slice(0, 10).forEach((f) => f.p.push(99));
    writeFileSync(join(dir, "data.json"), JSON.stringify(d));
    cpSync(join(fx, "fx"), join(dir, "fx"), { recursive: true });
    const s2 = await serve({ fixture: dir });
    try {
      await b.navigate(`${s2.url}/example/`);
      assert.ok(await b.until(READY), "page ready");
      assert.equal(await b.evalJs(STATS), statsFor(12, 57, 3));
      assert.equal(await b.evalJs(`document.getElementById('peopleLabel').textContent`), "12 people");
      assert.equal(await b.evalJs(`document.querySelector('.face[data-pid="99"]')`), null);
      assert.equal(await b.evalJs(`armful.D.people.some((p) => p.id === 99 || p.x)`), false);
      assert.equal(await b.evalJs(`armful.D.files.some((f) => f.p.includes(99))`), false);
    } finally { await s2.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nothing threw", () => assert.deepEqual(errors, []));
