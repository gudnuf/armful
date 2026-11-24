// The hold: tap faces to hold them. The pill shows the held faces, "N photos" and ×; two or more
// mean together (photos with all of them), and a tap on the faces switches to any (photos with
// any of them) without a word on screen. Every list count is the count you would get by tapping
// that face; the URL keeps the hold.
// Run: node --test test/hold.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
let srv, b, D;
const errors = [];
const js = (x) => JSON.stringify(x);
const shown = () => b.evalJs(`[...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden).map((t) => +t.dataset.n)`);
const text = (id) => b.evalJs(`document.getElementById(${js(id)}).textContent`);
const visible = (sel) => b.evalJs(`(() => { const e = document.querySelector(${js(sel)}); return !!e && e.getClientRects().length > 0; })()`);
const hash = () => b.evalJs(`location.hash`);
const count = (pid) => b.evalJs(`document.querySelector('.count[data-pid="${pid}"]').textContent`);
const tap = async (sel) => {
  const [x, y] = await b.evalJs(`(() => { const e = document.querySelector(${js(sel)}); if (!e) throw new Error('no ' + ${js(sel)});
    e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await b.tap(x, y);
};
const openList = async () => {
  if (!(await visible("#list"))) await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), "list open");
};
const openMore = async () => {
  await openList();
  if (!(await visible("#listMore"))) await tap("#more");
  assert.ok(await b.until(`document.getElementById('listMore').getClientRects().length > 0`), "more open");
};
const face = async (pid) => { await openList(); if (D.people.find((p) => p.id === pid).x) await openMore(); await tap(`#list .face[data-pid="${pid}"]`); };
const NO_HINTS = /together|\bany\b|tap|narrow|separate|overlap/i;
// no hint anywhere in the panel (the empty state's one plain sentence is checked on its own)
const noHints = async () => assert.doesNotMatch(await b.evalJs(`document.getElementById('panel').textContent`), NO_HINTS);
// "N people · M photos" for the files `idx`: M of them, N distinct people in them
const stats = (idx) => { const n = new Set(idx.flatMap((i) => D.files[i].p)).size; return `${n} ${n === 1 ? "person" : "people"} · ${idx.length} photo${idx.length === 1 ? "" : "s"}`; };
const NO_TEXT = `(() => { const out = []; const w = document.createTreeWalker(document.getElementById('bar'), NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { if (!n.textContent.trim()) continue; const r = document.createRange(), box = n.parentElement.getBoundingClientRect(); r.selectNodeContents(n);
      if (box.width > 1 && box.height > 1 && [...r.getClientRects()].some((x) => x.width > 1 && x.height > 1)) out.push(n.textContent.trim()); } return out; })()`;
const filesWith = (pred) => D.files.map((f, i) => [f, i]).filter(([f]) => pred(f.p)).map(([, i]) => i);

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ROOT, "test", "fixture")], { stdio: "ignore" });
  D = JSON.parse(readFileSync(join(ROOT, "test", "fixture", "data.json"), "utf8"));
  srv = await serve();
  b = await launch(srv.url);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});
after(async () => { await b?.close(); await srv?.close(); });

test("phone: one held, together, any, the empty state, letting go, clearing", async () => {
  await b.load(390, 844, true, "/example/", READY);
  assert.equal(await visible("#pair"), false);

  // one held
  await face(1);
  assert.equal(await hash(), "#p=1");
  const with1 = filesWith((p) => p.includes(1));
  assert.deepEqual(await shown(), with1);
  assert.equal(await visible("#pair"), true);
  assert.equal(await text("peopleLabel"), `${with1.length} photos`);
  // the header follows the wall: the files shown, and the people in them
  assert.equal(await text("stats"), stats(with1), "the header counts the held files");
  assert.equal(await text("stats"), "11 people · 30 photos");
  assert.equal(await b.evalJs(`document.getElementById('people').getAttribute('aria-label')`), `People filter, 1 held, ${with1.length} photos`);
  assert.deepEqual(await b.evalJs(NO_TEXT), [], "the pill shows no words");
  await noHints();
  assert.equal(await b.evalJs(`document.querySelector('#list .face[data-pid="1"]').getAttribute('aria-pressed')`), "true");
  assert.equal(await b.evalJs(`document.querySelector('#list .face[data-pid="1"]').classList.contains('held')`), true);
  // every count is the count if tapped
  assert.equal(await count(2), "9");
  assert.equal(await count(12), "0");
  assert.equal(await b.evalJs(`document.querySelector('.face[data-pid="12"]').classList.contains('dim')`), true);
  for (const p of D.people) assert.equal(await count(p.id), String(filesWith((q) => q.includes(1) && q.includes(p.id)).length), `count beside ${p.id}`);
  assert.equal(await b.evalJs(`document.querySelector('#pair .face img').getBoundingClientRect().width`), 36);

  // two held: together, the default
  await face(2);
  assert.equal(await hash(), "#p=1.2");
  assert.deepEqual(await shown(), filesWith((p) => p.includes(1) && p.includes(2)));
  assert.equal(await text("peopleLabel"), "9 photos");
  assert.equal(await text("stats"), stats(filesWith((p) => p.includes(1) && p.includes(2))), "the header: together");
  assert.deepEqual(await b.evalJs(NO_TEXT), [], "the pill shows no words");
  await noHints();
  assert.equal(await b.evalJs(`document.getElementById('pair').classList.contains('tight')`), true);
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 2);
  assert.equal(await b.evalJs(`document.getElementById('pair').getAttribute('aria-label')`), "Held: Person 1, Person 2");

  // tap the pair: any, unannounced; only the count says so
  await tap("#pair");
  const any12 = filesWith((p) => p.includes(1) || p.includes(2));
  assert.equal(await text("peopleLabel"), `${any12.length} photos`);
  assert.equal(await text("stats"), stats(any12), "the header: any");
  await noHints();
  assert.equal(await hash(), "#p=1.2&any");
  assert.deepEqual(await shown(), any12);
  assert.equal(await b.evalJs(`document.getElementById('pair').classList.contains('apart')`), true);
  for (const p of D.people) assert.equal(await count(p.id), String(filesWith((q) => q.includes(1) || q.includes(2) || q.includes(p.id)).length), `any count beside ${p.id}`);

  // back to together, then a face with no photo together with 1 and 2: a quiet empty state
  await tap("#pair");
  assert.equal(await text("peopleLabel"), "9 photos");
  assert.equal(await count(12), "0");
  await face(12);
  assert.equal(await hash(), "#p=1.2.12");
  assert.deepEqual(await shown(), []);
  assert.equal(await visible("#empty"), true);
  assert.equal(await b.evalJs(`document.querySelector('#empty p').textContent`), "No photos of them together");
  assert.equal(await b.evalJs(`document.querySelector('#empty button').textContent`), "clear");
  assert.equal(await text("peopleLabel"), "0 photos");
  assert.equal(await text("stats"), "0 people · 0 photos");
  await noHints();
  await tap("#empty button");
  assert.equal(await hash(), "");
  assert.equal((await shown()).length, 60);
  assert.equal(await visible("#empty"), false);

  // a held face in the list lets go
  await face(1); await face(2);
  await face(1);
  assert.equal(await hash(), "#p=2");
  assert.equal(await b.evalJs(`document.querySelector('#list .face[data-pid="1"]').getAttribute('aria-pressed')`), "false");

  // × clears everything; the pill is the people again
  await tap("#clear");
  assert.equal(await hash(), "");
  assert.equal((await shown()).length, 60);
  assert.equal(await visible("#pair"), false);
  assert.equal(await visible("#clear"), false);
  assert.equal(await text("peopleLabel"), "10 people");
  assert.equal(await text("stats"), "12 people · 60 photos", "cleared: the whole collection again");
  for (const p of D.people) assert.equal(await count(p.id), String(p.n));
});

test("collapsed with someone held: one pill bottom-left with the faces, the count and ×", async () => {
  for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
    await b.load(w, h, m, "/example/#p=1.2", READY);
    assert.equal(await visible("#list"), false);
    const r = await b.evalJs(`(() => { const g = (id) => document.getElementById(id).getBoundingClientRect(); const bar = g('bar');
      const inside = (e) => e.left >= bar.left - 0.5 && e.right <= bar.right + 0.5 && e.top >= bar.top - 0.5 && e.bottom <= bar.bottom + 0.5;
      return { left: bar.left, bottom: bar.bottom, height: bar.height, pair: inside(g('pair')), people: inside(g('people')), clear: inside(g('clear')),
        clearW: g('clear').width, faces: document.querySelectorAll('#bar #pair .face').length }; })()`);
    assert.ok(r.left <= 24 && h - r.bottom <= 24, `${w}: pill at ${r.left},${r.bottom}`);
    assert.ok(r.height >= 50 && r.height <= 54, `${w}: ${r.height}px tall`);
    assert.deepEqual([r.pair, r.people, r.clear, r.faces], [true, true, true, 2], `${w}: all inside the one pill`);
    assert.equal(r.clearW, 44);
    assert.equal(await text("peopleLabel"), "9 photos");
    assert.equal(await b.evalJs(`document.querySelectorAll('.panel .hold, #hold, .hint').length`), 0, "no separate hold card");
    await noHints();
  }
});

test("the URL: a shared hold loads; unknown and malformed ids are dropped", async () => {
  await b.load(390, 844, true, "/example/#p=1.999.abc", READY);
  assert.deepEqual(await b.evalJs(`armful.state.picked`), [1]);
  assert.equal(await b.evalJs(`armful.state.any`), false);
  assert.deepEqual(await shown(), filesWith((p) => p.includes(1)));
  await b.load(390, 844, true, "/example/#p=1.2&any", READY);
  assert.deepEqual(await b.evalJs(`armful.state.picked`), [1, 2]);
  assert.equal(await b.evalJs(`armful.state.any`), true);
  assert.equal(await text("peopleLabel"), `${filesWith((p) => p.includes(1) || p.includes(2)).length} photos`);
  for (const h of ["#p=", "#p=999", "#zzz", "#p=..&&any"]) {
    await b.load(390, 844, true, "/example/" + h, READY);
    assert.deepEqual(await b.evalJs(`armful.state.picked`), [], h);
    assert.equal((await shown()).length, 60, h);
    assert.equal(await visible("#pair"), false, h);
  }
});

test("beyond four held: four faces and +N, still one pill on screen", async () => {
  await b.load(390, 844, true, "/example/", READY);
  for (const pid of [1, 2, 3, 4]) await face(pid);
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 4);
  assert.equal(await b.evalJs(`document.querySelector('#pair .more')`), null);
  await face(5); await face(6);
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 4);
  assert.equal(await b.evalJs(`document.querySelector('#pair .more').textContent`), "+2");
  assert.ok(await b.evalJs(`document.getElementById('bar').getBoundingClientRect().right <= innerWidth`), "the pill fits the phone");
  assert.equal(await hash(), "#p=1.2.3.4.5.6");
});

test("motion: a tapped face flies to the pill on an arc; reduced motion skips it", async () => {
  await b.load(390, 844, true, "/example/", READY);
  await face(3);
  assert.equal(await b.evalJs(`document.querySelectorAll('.arc').length`), 1, "the arc runs");
  assert.ok(await b.until(`document.querySelectorAll('.arc').length === 0`, 2000), "and cleans up after itself");
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await b.load(390, 844, true, "/example/", READY);
  await face(3);
  assert.equal(await b.evalJs(`document.querySelectorAll('.arc').length`), 0);
  assert.equal(await b.evalJs(`[...document.querySelectorAll('body *')].some((e) => e.getAnimations().length > 0 || getComputedStyle(e).offsetPath !== 'none')`), false);
  assert.equal(await hash(), "#p=3");
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});

test("nothing threw", () => assert.deepEqual(errors, []));
