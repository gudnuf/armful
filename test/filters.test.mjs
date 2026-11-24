// The filters: one pill bottom-left with the people (faces) and a filter icon that swaps the faces
// rail for a card of three rows (people in the photo, day of the trip, media). Every option says
// the files tapping it would give, the other rows as they are; zeros fade and take no tap; a tap on
// the chosen one clears it; × clears everything. The wall is in time order by day, with a sticky
// day label and a right-edge day scrubber that navigates and never filters. The hash keeps the
// query (#p=1.2&any&n=4&d=3e&m=v&s=p) and old people links still read. No interaction shifts the
// layout (CLS 0) at 390x844 or 1440x900.
// Run: node --test test/filters.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch, sleep, STATS, statsFor } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
const js = JSON.stringify;
let srv, b, D;
const errors = [];
// layout-shift entries without recent input (the CLS definition), from the start of each document
const OBSERVE = `window.__cls = 0; window.__shifts = [];
new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue; window.__cls += e.value;
  window.__shifts.push(e.value.toFixed(4) + "@" + Math.round(e.startTime) + "ms " + (e.sources || []).map((s) => s.node ?
    (s.node.id ? "#" + s.node.id : (typeof s.node.className === "string" && s.node.className ? "." + s.node.className.split(" ")[0] : s.node.nodeName)) : "?").join(",")); } })
  .observe({ type: "layout-shift", buffered: true });`;

// ---- the model, computed here from the fixture (tz UTC): what the page must agree with ----
const BANDS = { 0: (k) => k === 0, 1: (k) => k === 1, 2: (k) => k >= 2 && k <= 3, 4: (k) => k >= 4, 8: (k) => k >= 8 };
let FILES; // { p, v, nf, day (0: undated), part, shape }
function model() {
  const good = D.files.filter((f) => f.w > 0 && f.h > 0);
  const dayKey = (f) => Math.floor((f.t - 4 * 3600) / 86400); // 04:00 to 04:00, UTC
  const first = Math.min(...good.filter((f) => "t" in f).map(dayKey));
  FILES = good.map((f) => {
    const h = "t" in f ? new Date(f.t * 1000).getUTCHours() : null;
    return { p: f.p, v: !!f.v, nf: f.nf, day: "t" in f ? dayKey(f) - first + 1 : 0,
      part: h == null ? "" : h >= 4 && h < 12 ? "m" : h >= 12 && h < 18 ? "a" : "e", shape: f.h > f.w ? "p" : f.w > f.h ? "l" : "" };
  });
}
const pass = (f, q) => (!q.p?.length || (q.any ? q.p.some((x) => f.p.includes(x)) : q.p.every((x) => f.p.includes(x))))
  && (q.n == null || BANDS[q.n](f.nf)) && (q.d == null || (f.day === q.d && (!q.part || f.part === q.part)))
  && (!q.m || (q.m === "v") === f.v) && (!q.s || f.shape === q.s);
const want = (q) => FILES.map((f, i) => [f, i]).filter(([f]) => pass(f, q)).map(([, i]) => i);

// ---- the page ----
const shown = () => b.evalJs(`[...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden).map((t) => +t.dataset.n)`);
const hash = () => b.evalJs(`location.hash`);
// the parts of the day: folded (0px, inert) until a day is chosen
const partsOpen = () => b.evalJs(`(() => { const p = document.getElementById('partsWrap'); return !p.inert && p.getBoundingClientRect().height > 20; })()`);
const visible = (sel) => b.evalJs(`(() => { const e = document.querySelector(${js(sel)}); return !!e && e.getClientRects().length > 0; })()`);
// every option on the card: its label, count, pressed and zero states
const OPTS = `[...document.querySelectorAll('#filters .opt')].map((o) => ({ label: o.getAttribute('aria-label').replace(/, .*$/, ''),
  c: o.querySelector('.c').textContent, on: o.getAttribute('aria-pressed') === 'true', zero: o.classList.contains('zero'),
  dis: o.getAttribute('aria-disabled') === 'true', op: getComputedStyle(o).opacity, row: o.parentElement.id }))`;
const optSel = (label) => `[...document.querySelectorAll('#filters .opt')].find((o) => o.getAttribute('aria-label').startsWith(${js(label + ",")}))`;
const where = async (expr) => {
  const r = await b.evalJs(`(() => { const e = ${expr}; if (!e) throw new Error('none: ' + ${js(expr)});
    e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  return r;
};
let mobile = true;
const press = async (expr) => { const [x, y] = await where(expr); if (mobile) await b.tap(x, y); else await b.click(x, y); };
const tapOpt = (label) => press(optSel(label));
const tapId = (id) => press(`document.getElementById(${js(id)})`);
const settled = () => b.until(`document.getAnimations().every((a) => a.playState !== 'running')`, 3000);
// the model's count for an option, given the query q
function countOf(label, q) {
  const tryQ = (patch) => want({ ...q, ...patch }).length;
  const on = isOn(label, q);
  if (on) return want(q).length;
  const m = label.match(/^Day (\d+)$/);
  if (m) return tryQ({ d: +m[1], part: null });
  return tryQ({ "No one": { n: 0 }, "1 face": { n: 1 }, "2–3 faces": { n: 2 }, "4+ faces": { n: 4 }, "8+ faces": { n: 8 },
    Morning: { part: "m" }, Afternoon: { part: "a" }, Evening: { part: "e" }, "All media": { m: null }, Videos: { m: "v" }, Photos: { m: "f" },
    Portrait: { s: "p" }, Landscape: { s: "l" } }[label]);
}
function isOn(label, q) {
  const m = label.match(/^Day (\d+)$/);
  if (m) return q.d === +m[1];
  return { "No one": q.n === 0, "1 face": q.n === 1, "2–3 faces": q.n === 2, "4+ faces": q.n === 4, "8+ faces": q.n === 8,
    Morning: q.part === "m", Afternoon: q.part === "a", Evening: q.part === "e", "All media": q.m == null, Videos: q.m === "v", Photos: q.m === "f",
    Portrait: q.s === "p", Landscape: q.s === "l" }[label];
}
// the page agrees with the model for q: the wall, every option's count and state, every face's count, the header
async function agrees(q, tag) {
  const ids = want(q);
  assert.deepEqual(await shown(), ids, `${tag}: the wall`);
  const opts = await b.evalJs(OPTS);
  for (const o of opts) {
    if (o.row === "optP" && q.d == null) continue; // morning / afternoon / evening wait for a day
    const n = countOf(o.label, q);
    assert.equal(o.c, String(n), `${tag}: ${o.label} says ${o.c}, tapping it gives ${n}`);
    assert.equal(o.on, isOn(o.label, q), `${tag}: ${o.label} pressed`);
    assert.equal(o.zero, n === 0 && !o.on, `${tag}: ${o.label} zero`);
    assert.equal(o.dis, o.zero, `${tag}: ${o.label} aria-disabled`);
  }
  for (const p of D.people) {
    const held = (q.p || []).includes(p.id);
    const n = held ? ids.length : want({ ...q, p: [...(q.p || []), p.id] }).length;
    assert.equal(await b.evalJs(`document.querySelector('.count[data-pid="${p.id}"]').textContent`), String(n), `${tag}: count beside ${p.id}`);
  }
  const v = ids.filter((i) => FILES[i].v).length;
  assert.equal(await b.evalJs(STATS), statsFor(new Set(ids.flatMap((i) => FILES[i].p)).size, ids.length - v, v), `${tag}: the header follows`);
}

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ROOT, "test", "fixture")], { stdio: "ignore" });
  D = JSON.parse(readFileSync(join(ROOT, "test", "fixture", "data.json"), "utf8"));
  model();
  srv = await serve();
  b = await launch(srv.url);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVE });
});
after(async () => { await b?.close(); await srv?.close(); });

test("the fixture's days: 4 trip days then the undated; past midnight is the evening before", () => {
  assert.deepEqual([1, 2, 3, 4, 0].map((d) => FILES.filter((f) => f.day === d).length), [15, 14, 15, 14, 2]);
  assert.equal(FILES[14].day, 1);
  assert.equal(FILES[14].part, "e");
  assert.equal(FILES[36].part, "a");
});

test("counts: every option and face says what tapping it gives, and the wall agrees after each tap", async () => {
  mobile = true;
  await b.load(390, 844, true, "/example/", READY);
  await tapId("fbtn");
  assert.ok(await b.until(`document.getElementById('filters').getClientRects().length > 0`), "the filters open");
  assert.equal(await visible("#list"), false);
  // the rows and their words
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#filters .frow > .lbl')].map((e) => e.textContent)`), ["People in the photo", "Day of the trip", "Media"]);
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#optN .v')].map((e) => e.textContent)`), ["no one", "1", "2–3", "4+", "8+"]);
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#optD .v')].map((e) => e.textContent)`), ["1", "2", "3", "4"]);
  assert.deepEqual(await b.evalJs(`[...document.querySelectorAll('#optM .v, #optS .v')].map((e) => e.textContent)`), ["all", "videos", "photos", "portrait", "landscape"]);
  assert.equal(await partsOpen(), false, "parts of the day wait for a day");
  await agrees({}, "nothing chosen");

  // each tap: the count the option said is what the wall then shows
  const q = {};
  for (const [label, patch] of [["Day 1", { d: 1, part: null }], ["Evening", { part: "e" }], ["2–3 faces", { n: 2 }], ["Photos", { m: "f" }],
    ["Evening", { part: null }], ["Landscape", { s: "l" }], ["Day 3", { d: 3, part: null }], ["Afternoon", { part: "a" }], ["Morning", { part: "m" }], ["Photos", { m: null }]]) {
    await settled(); // the card grows as the parts of the day unfold: tap where the option has come to rest
    const said = (await b.evalJs(OPTS)).find((o) => o.label === label);
    const was = await shown();
    await tapOpt(label);
    if (said.zero) { assert.deepEqual(await shown(), was, `${label} is a zero: no tap`); continue; }
    Object.assign(q, patch);
    if (!said.on) assert.equal((await shown()).length, +said.c, `${label} said ${said.c}`);
    await agrees(q, `after ${label}`);
  }
  assert.equal(await hash(), "#n=2&d=3m&s=l");

  // a held face and the filters together
  await tapId("fbtn"); // swap to the faces
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`));
  await settled();
  await press(`document.querySelector('#list .face[data-pid="1"]')`);
  assert.deepEqual(await b.evalJs(`armful.state.picked`), [1]);
  q.p = [1];
  await agrees(q, "person 1 with the filters");
  assert.equal(await hash(), "#p=1&n=2&d=3m&s=l");
});

test("zeros fade to 30% and take no tap; the chosen option clears on a second tap", async () => {
  mobile = true;
  await b.load(390, 844, true, "/example/#d=1", READY);
  await tapId("fbtn");
  assert.ok(await b.until(`document.getElementById('filters').getClientRects().length > 0`));
  await settled();
  assert.equal(await partsOpen(), true, "a day: its parts unfold");
  // day 1 has no afternoon
  const aft = (await b.evalJs(OPTS)).find((o) => o.label === "Afternoon");
  assert.deepEqual([aft.c, aft.zero, aft.dis, aft.op], ["0", true, true, "0.3"]);
  await tapOpt("Afternoon");
  assert.equal(await hash(), "#d=1", "a zero takes no tap");
  assert.equal(await b.evalJs(`armful.state.part`), null);
  // chosen, then cleared by tapping it again
  await tapOpt("Morning");
  assert.equal(await hash(), "#d=1m");
  await tapOpt("Morning");
  assert.equal(await hash(), "#d=1");
  await tapOpt("Day 1");
  assert.equal(await hash(), "");
  assert.equal((await shown()).length, 60);
  await settled();
  assert.equal(await partsOpen(), false, "no day: the parts fold away");
});

test("the pill: faces, the filter icon, a line of words (no count) and ×; × clears everything", async () => {
  mobile = true;
  await b.load(390, 844, true, "/example/#p=1.2&n=4&d=2&m=f", READY);
  const terms = await b.evalJs(`document.getElementById('terms').textContent`);
  assert.equal(terms, "together · 4+ · Day 2 · photos");
  assert.doesNotMatch(terms, /\d+ (photo|file)|^\d+$/, "no count in the pill");
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 2);
  assert.equal(await visible("#clear"), true);
  assert.equal(await visible("#people"), false, "the held faces stand in for the three");
  const bar = await b.evalJs(`document.getElementById('bar').getBoundingClientRect().toJSON()`);
  assert.ok(bar.right <= 390 - 14 + 0.5, `the pill fits the phone: ${bar.right}`);
  assert.equal(await b.evalJs(`(() => { const t = document.getElementById('terms'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow; })()`), "ellipsis", "a long line truncates");
  await agrees({ p: [1, 2], n: 4, d: 2, m: "f" }, "from the URL");
  // × clears everything: people, filters and the hash
  await tapId("clear");
  assert.equal(await hash(), "");
  assert.equal((await shown()).length, 60);
  assert.equal(await visible("#terms"), false);
  assert.equal(await visible("#clear"), false);
  assert.equal(await visible("#people"), true);
  assert.equal(await b.evalJs(STATS), statsFor(12, 57, 3));
  // filters alone: words and ×, the three faces stay
  await b.load(390, 844, true, "/example/#s=p", READY);
  assert.equal(await b.evalJs(`document.getElementById('terms').textContent`), "portrait");
  assert.equal(await visible("#people"), true);
  assert.equal(await visible("#clear"), true);
  // nothing shown: the empty state's clear clears the filters too
  await b.load(390, 844, true, "/example/#n=0&m=v", READY);
  assert.equal(await visible("#empty"), true);
  await press(`document.querySelector('#empty button')`);
  assert.equal(await hash(), "");
  assert.equal((await shown()).length, 60);
});

test("open, the × is gone: the chevron alone folds (clearing nothing); clear all is inside the panel", async () => {
  for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
    mobile = m;
    const q = "#p=1&d=2&m=f";
    await b.load(w, h, m, "/example/" + q, READY);
    const was = await shown();
    // folded: × and an upward chevron at the right end
    assert.equal(await visible("#clear"), true, `${w}: folded, × clears`);
    assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('#chev .chev')).transform`), "matrix(-1, 0, 0, -1, 0, 0)", "points up");
    const chev = await b.evalJs(`document.getElementById('chev').getBoundingClientRect().toJSON()`);
    for (const view of ["fbtn", "people"]) {
      if (view === "people") await b.evalJs(`armful.openView('faces')`); else await tapId("fbtn");
      await settled();
      // open: no × to see or tap; the chevron is the pill's last control, where it was, pointing down, 44px
      const s = await b.evalJs(`(() => { const x = document.getElementById('clear'), c = document.getElementById('chev'), r = c.getBoundingClientRect(), bar = document.getElementById('bar').getBoundingClientRect();
        const last = [...document.getElementById('bar').children].filter((e) => e.getClientRects().length).at(-1);
        return { x: x.getClientRects().length, hit: document.elementFromPoint(r.right + 22, r.top + r.height / 2)?.closest('#clear') ? 1 : 0, last: last.id,
          w: r.width, h: r.height, left: r.left, top: r.top, down: getComputedStyle(c.querySelector('.chev')).transform, inBar: r.right <= bar.right + 0.5 }; })()`);
      assert.deepEqual([s.x, s.hit, s.last, s.inBar], [0, 0, "chev", true], `${w} ${view}: no × while open`);
      assert.ok(s.w >= 44 && s.h >= 44, `${w}: chevron ${s.w}x${s.h}`);
      assert.deepEqual([s.left, s.top], [chev.left, chev.top], `${w}: the chevron keeps its place`);
      assert.equal(s.down, "none", "points down");
      // clear all, inside the panel, in view
      const sel = view === "fbtn" ? "#filters .clearAll" : "#list .clearAll";
      assert.equal(await b.evalJs(`(() => { const c = document.querySelector(${js(sel)}); return c.classList.contains('on') && getComputedStyle(c).visibility; })()`), "visible");
      // the chevron folds, and clears nothing
      await tapId("chev");
      assert.ok(await b.until(`document.getElementById('list').hidden && document.getElementById('filters').hidden`), `${w}: folded`);
      assert.equal(await hash(), q, "nothing cleared");
      assert.deepEqual(await shown(), was);
      assert.equal(await visible("#clear"), true, "folded: × again");
    }
    // clear all inside the open panel clears everything and leaves it open; then it hides (its place kept)
    await tapId("fbtn"); await settled();
    await press(`document.querySelector('#filters .clearAll')`);
    assert.equal(await hash(), "");
    assert.equal((await shown()).length, 60);
    assert.equal(await visible("#filters"), true, "still open");
    assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('#filters .clearAll')).visibility`), "hidden", "nothing chosen: no clear all");
    await b.key("Escape", 27);
  }
  mobile = true;
});

test("the swap: the filter icon folds the faces away and opens the filters in their place, and back; held faces stay", async () => {
  for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
    mobile = m;
    await b.load(w, h, m, "/example/#p=3", READY);
    await tapId("chev");
    assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), `${w}: the chevron opens the faces`);
    await settled();
    const pair = await b.evalJs(`document.getElementById('pair').getBoundingClientRect().toJSON()`);
    // to the filters: the faces fold away (a frozen copy closes into the pill) while the filters open
    await tapId("fbtn");
    const mid = await b.evalJs(`(() => { const g = [...document.body.children].find((e) => e.classList.contains('list') && e.getAttribute('aria-hidden') === 'true');
      return { ghost: !!g, ghostMoving: !!g && g.getAnimations({ subtree: true }).length > 0, list: document.getElementById('list').hidden,
        filters: document.getElementById('filters').hidden, unfolding: document.getElementById('filters').getAnimations({ subtree: true }).length > 0 }; })()`);
    assert.deepEqual(mid, { ghost: true, ghostMoving: true, list: true, filters: false, unfolding: true }, `${w}: one motion, both ways`);
    assert.equal(await b.evalJs(`document.getElementById('fbtn').getAttribute('aria-expanded')`), "true");
    assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`), "false");
    assert.equal(await visible("#pair"), true, `${w}: the held face stays in the pill`);
    await settled();
    assert.equal(await b.evalJs(`document.querySelectorAll('body > [aria-hidden="true"].list, body > [aria-hidden="true"].filters').length`), 0, "the copy is gone");
    const card = await b.evalJs(`document.getElementById('filters').getBoundingClientRect().toJSON()`);
    const bar = await b.evalJs(`document.getElementById('bar').getBoundingClientRect().toJSON()`);
    assert.ok(card.bottom <= bar.top + 1 && card.left <= 24 && card.top >= 0, `${w}: the card sits above the pill: ${JSON.stringify(card)}`);
    assert.deepEqual(await b.evalJs(`document.getElementById('pair').getBoundingClientRect().toJSON()`), pair, `${w}: the held face never moved`);
    // and back
    await tapId("fbtn");
    assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0 && document.getElementById('filters').hidden`), `${w}: back to the faces`);
    assert.equal(await visible("#pair"), true);
    await settled();
    // the chevron folds whichever view is open; it reopens the same view
    await tapId("chev");
    assert.ok(await b.until(`document.getElementById('list').hidden && document.getElementById('filters').hidden`));
    await tapId("fbtn");
    assert.ok(await b.until(`!document.getElementById('filters').hidden`), `${w}: from folded, the icon opens the filters`);
    await b.key("Escape", 27);
    assert.ok(await b.until(`document.getElementById('filters').hidden`), "Esc folds it");
  }
  mobile = true;
});

test("the URL: the query round-trips; old people links still read; nonsense is dropped", async () => {
  mobile = true;
  const full = "#p=1.2&any&n=2&d=3e&m=f&s=l";
  await b.load(390, 844, true, "/example/" + full, READY);
  assert.deepEqual(await b.evalJs(`(({ picked, any, n, d, part, m, s }) => ({ picked, any, n, d, part, m, s }))(armful.state)`),
    { picked: [1, 2], any: true, n: 2, d: 3, part: "e", m: "f", s: "l" });
  await agrees({ p: [1, 2], any: true, n: 2, d: 3, part: "e", m: "f", s: "l" }, "the full hash");
  // a change writes the hash back in the same shape; that hash loads the same wall
  await b.evalJs(`armful.openView('filters')`);
  await settled();
  await tapOpt("Landscape");
  assert.equal(await hash(), "#p=1.2&any&n=2&d=3e&m=f");
  const was = await shown();
  await b.load(390, 844, true, "/example/#p=1.2&any&n=2&d=3e&m=f", READY);
  assert.deepEqual(await shown(), was, "the hash round-trips");
  // old links: people only
  for (const [h, q] of [["#p=1.2", { p: [1, 2] }], ["#p=1.2&any", { p: [1, 2], any: true }], ["#p=3", { p: [3] }]]) {
    await b.load(390, 844, true, "/example/" + h, READY);
    assert.deepEqual(await shown(), want(q), `${h}`);
    assert.equal(await hash(), h, `${h} stays as it was`);
  }
  // unknown values, a day past the trip, a part without a day: dropped
  await b.load(390, 844, true, "/example/#n=3&d=9&m=x&s=q&part=m", READY);
  assert.deepEqual(await b.evalJs(`[armful.state.n, armful.state.d, armful.state.part, armful.state.m, armful.state.s]`), [null, null, null, null, null]);
  assert.equal((await shown()).length, 60);
  await b.load(390, 844, true, "/example/#d=0&n=8", READY);
  assert.deepEqual(await b.evalJs(`[armful.state.n, armful.state.d]`), [8, null]);
  // a hash change in place (the Back button, a pasted link) redraws
  await b.evalJs(`location.hash = '#d=2m'`);
  assert.ok(await b.until(`armful.state.d === 2 && armful.state.part === 'm'`));
  assert.deepEqual(await shown(), want({ d: 2, part: "m" }));
});

test("the wall: in time order by day, a sticky label naming the day and the part of it, the undated last and in no day", async () => {
  mobile = true;
  await b.load(390, 844, true, "/example/", READY);
  const tags = await b.evalJs(`[...document.querySelectorAll('#wall .day')].map((s) => s.querySelector('.tag span').textContent)`);
  assert.deepEqual(tags, ["Day 1 · morning", "Day 2 · morning", "Day 3 · morning", "Day 4 · morning", "Undated"]);
  assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('.tag span')).textTransform`), "uppercase");
  // scrolled into day 1's evening: the label sticks at the top and says so
  await b.evalJs(`armful.tiles[12].scrollIntoView({ block: 'start' }); scrollBy(0, 20)`);
  assert.ok(await b.until(`document.querySelector('#wall .day .tag span').textContent === 'Day 1 · evening'`, 2000), "the label follows the row under it");
  const t = await b.evalJs(`document.querySelector('#wall .day .tag span').getBoundingClientRect().toJSON()`);
  const head = await b.evalJs(`document.querySelector('.masthead').getBoundingClientRect().bottom`);
  assert.ok(t.top >= head && t.top <= head + 24, `stuck just under the header (${head}): ${t.top}`);
  // file 14 (01:30 the next calendar day) is in day 1's section; the undated are in no day
  assert.equal(await b.evalJs(`armful.tiles[14].closest('.day').dataset.day`), "1");
  for (let d = 1; d <= 4; d++) {
    await b.evalJs(`location.hash = '#d=${d}'`);
    assert.ok(await b.until(`armful.state.d === ${d}`));
    const ids = await shown();
    assert.ok(!ids.includes(58) && !ids.includes(59), `day ${d}: no undated file`);
  }
});

test("the scrubber fades in while scrolling, navigates, and never filters", async () => {
  mobile = false;
  await b.load(390, 844, false, "/example/#m=f", READY); // a mouse drag at phone size
  const before = { shown: await shown(), hash: await hash() };
  assert.equal(await b.evalJs(`getComputedStyle(document.getElementById('scrub')).opacity`), "0", "hidden at rest");
  assert.equal(await b.evalJs(`document.querySelectorAll('#ticks .tk:not([hidden])').length`), 4, "a tick per day");
  await b.evalJs(`scrollBy(0, 300)`);
  assert.ok(await b.until(`document.getElementById('scrub').classList.contains('on')`, 2000), "it wakes while the wall moves");
  // drag it from near the top to near the bottom
  const r = await b.evalJs(`document.getElementById('scrub').getBoundingClientRect().toJSON()`);
  const x = r.left + r.width / 2;
  await b.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y: r.top + 10, button: "left", clickCount: 1 });
  assert.equal(await b.evalJs(`document.getElementById('scrub').classList.contains('drag')`), true);
  for (let y = r.top + 10; y < r.bottom - 10; y += 40) await b.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  const y0 = await b.evalJs(`scrollY`);
  assert.match(await b.evalJs(`document.getElementById('bubble').textContent`), /^(Day \d · (morning|afternoon|evening)|Undated)$/);
  await b.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: r.bottom - 10, button: "left", clickCount: 1 });
  assert.ok(y0 > 1000, `it went down the wall: ${y0}`);
  assert.deepEqual({ shown: await shown(), hash: await hash() }, before, "the scrubber never filters");
  assert.deepEqual(await b.evalJs(`[armful.state.d, armful.state.part, armful.state.n, armful.state.s]`), [null, null, null, null]);
  assert.ok(await b.until(`!document.getElementById('scrub').classList.contains('on')`, 3000), "it fades after the wall stops");
  mobile = true;
});

test("the header sticks: after 2000px it is at the top, the day label just under it, nothing shifted", async () => {
  for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
    mobile = m;
    await b.load(w, h, m, "/example/", READY);
    await sleep(600);
    const head0 = await b.evalJs(`document.querySelector('.masthead').getBoundingClientRect().toJSON()`);
    const row0 = await b.evalJs(`document.querySelector('#wall .tile').getBoundingClientRect().top`);
    assert.equal(row0, head0.bottom, `${w}: the wall starts under the header`);
    await b.evalJs(`window.__cls = 0; window.__shifts = []`);
    for (let k = 0; k < 10; k++) { await b.evalJs(`scrollBy(0, 200)`); await sleep(60); }
    await sleep(500);
    const s = await b.evalJs(`(() => { const hd = document.querySelector('.masthead').getBoundingClientRect(), st = document.getElementById('stats').getBoundingClientRect();
      const tags = [...document.querySelectorAll('#wall .day:not([hidden]) .tag span')].map((t) => t.getBoundingClientRect()).filter((r) => r.bottom > 0 && r.top < innerHeight);
      return { y: scrollY, top: hd.top, bottom: hd.bottom, h: hd.height, stats: st.top >= hd.top && st.bottom <= hd.bottom && st.width > 0,
        tag: Math.min(...tags.map((r) => r.top)), bg: getComputedStyle(document.querySelector('.masthead')).backgroundColor,
        cls: window.__cls, shifts: window.__shifts }; })()`);
    assert.equal(s.y, 2000);
    assert.deepEqual([s.top, s.h, s.stats], [0, 48, true], `${w}: the header (wordmark and counts) is at the top`);
    assert.ok(s.tag >= s.bottom, `${w}: the day label (${s.tag}) is below the header (${s.bottom})`);
    assert.notEqual(s.bg, "rgba(0, 0, 0, 0)", "opaque over the wall");
    assert.equal(s.cls, 0, `${w}: CLS ${s.shifts.join(" | ")}`);
    // a jump to a day lands its first row below the header, not under it
    await b.evalJs(`document.querySelector('#wall .day[data-day="3"]').scrollIntoView()`);
    await sleep(200);
    const d3 = await b.evalJs(`document.querySelector('#wall .day[data-day="3"] .tile').getBoundingClientRect().top`);
    assert.ok(Math.abs(d3 - s.bottom) < 1, `${w}: day 3's first row at ${d3}, the header ends at ${s.bottom}`);
    // the previewer covers it
    await press(`[...document.querySelectorAll('#wall .tile')].find((t) => t.getBoundingClientRect().top > 200 && t.getBoundingClientRect().bottom < innerHeight - 120)`);
    assert.ok(await b.until(`!document.getElementById('lb').hidden`, 2000));
    assert.equal(await b.evalJs(`document.elementFromPoint(40, 24)?.closest('.masthead') ? 'header' : 'previewer'`), "previewer");
    await b.key("Escape", 27);
  }
  mobile = true;
});

test("open, the panel never meets the header or the day label: both views, scrolled, phone and desktop", async () => {
  for (const [w, h, m] of [[390, 844, true], [390, 600, true], [1440, 900, false], [1000, 640, false]]) {
    mobile = m;
    await b.load(w, h, m, "/example/#p=1", READY); // someone held: clear all shows
    for (const view of ["faces", "filters"]) {
      await b.evalJs(`armful.openView(${js(view)})`);
      await settled();
      for (const y of [0, 700, 2000]) {
        await b.evalJs(`scrollTo(0, ${y})`);
        await sleep(150);
        const r = await b.evalJs(`(() => { const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
          const panel = document.getElementById(${js(view === "faces" ? "list" : "filters")});
          const tags = [...document.querySelectorAll('#wall .day:not([hidden]) .tag span')].filter((t) => getComputedStyle(t).visibility === 'visible').map(box).filter((b) => b[3] > 0 && b[1] < innerHeight);
          const stuck = [...document.querySelectorAll('#wall .day:not([hidden]) .tag span')].filter((t) => getComputedStyle(t).visibility === 'visible' && Math.abs(t.getBoundingClientRect().top - document.querySelector('.masthead').getBoundingClientRect().bottom - 8) < 1).length;
          return { head: box(document.querySelector('.masthead')), tags, clear: box(panel.querySelector('.clearAll')), clearOn: panel.querySelector('.clearAll').classList.contains('on'),
            stuck, panel: box(panel), kids: [...panel.querySelectorAll('li, .lbl, .opt')].map(box).filter((b) => b[3] - b[1] > 0) }; })()`);
        const meet = (a, c) => a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3];
        const tag = `${w}x${h} ${view} at ${y}`;
        assert.ok(r.clearOn, `${tag}: clear all is there`);
        if (y >= 700) assert.equal(r.stuck, 1, `${tag}: the stuck day label stays in view (only labels under the panel yield)`);
        for (const other of [r.head, ...r.tags]) {
          assert.ok(!meet(r.clear, other), `${tag}: clear all ${r.clear} meets ${other}`);
          assert.ok(!meet(r.panel, other), `${tag}: the panel ${r.panel} meets ${other}`);
          for (const k of r.kids) assert.ok(!meet(k, other) || k[3] <= r.panel[1] || k[1] >= r.panel[3], `${tag}: ${k} meets ${other}`);
        }
      }
    }
  }
  mobile = true;
});

// every interaction, measured: the layout-shift entries without recent input stay at 0
for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
  test(`CLS 0 for every interaction at ${w}x${h}`, { timeout: 120000 }, async () => {
    mobile = m;
    await b.load(w, h, m, "/example/", READY);
    await sleep(800);
    const steps = [
      ["open the faces", () => tapId("people")],
      ["hold a face", () => press(`document.querySelector('#list .face[data-pid="1"]')`)],
      ["hold another", () => press(`document.querySelector('#list .face[data-pid="2"]')`)],
      ["any", () => tapId("pair")],
      ["swap to the filters", () => tapId("fbtn")],
      ["a day", () => tapOpt("Day 2")],
      ["a part of it", () => tapOpt("Morning")],
      ["faces 2–3", () => tapOpt("2–3 faces")],
      ["photos", () => tapOpt("Photos")],
      ["a zero (no tap)", () => tapOpt("Afternoon")],
      ["clear one", () => tapOpt("Photos")],
      ["swap back", () => tapId("fbtn")],
      ["swap again", () => tapId("fbtn")],
      ["clear all inside the panel", () => press(`document.querySelector('#filters .clearAll')`)],
      ["choose again", () => tapOpt("Photos")],
      ["fold", () => tapId("chev")],
      ["clear all", () => tapId("clear")],
      ["open the filters", () => tapId("fbtn")],
      ["landscape", () => tapOpt("Landscape")],
      ["fold again", () => tapId("chev")],
      ["scroll", () => b.evalJs(`scrollBy(0, 900)`)],
      ["scroll more", () => b.evalJs(`scrollBy(0, 900)`)],
      ["scrub", async () => {
        await b.evalJs(`scrollBy(0, -200)`);
        await b.until(`document.getElementById('scrub').classList.contains('on')`, 2000);
        const r = await b.evalJs(`document.getElementById('scrub').getBoundingClientRect().toJSON()`), x = r.left + r.width / 2;
        await b.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y: r.top + 20, button: "left", clickCount: 1 });
        for (let y = r.top + 20; y < r.bottom - 20; y += 30) { await b.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }); await sleep(30); }
        await b.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: r.bottom - 20, button: "left", clickCount: 1 });
      }],
      ["open a photo", () => press(`[...document.querySelectorAll('#wall .tile')].find((t) => !t.hidden && t.getBoundingClientRect().top > 120 && t.getBoundingClientRect().bottom < innerHeight - 120)`)],
      ["close it", () => b.key("Escape", 27)],
      ["clear all", () => tapId("clear")],
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
    }
    console.log(`cls ${w}x${h}\n  ` + out.join("\n  "));
  });
}

test("nothing threw", () => assert.deepEqual(errors, []));
