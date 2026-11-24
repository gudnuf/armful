// The hold: tap faces to hold them; two or more read "together" (photos with all of them) or
// "any" (photos with any of them), the pair toggles between the two; every list count is the
// count you would get by tapping that face; the URL keeps the hold.
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
  assert.equal(await visible("#hold"), false);

  // one held
  await face(1);
  assert.equal(await hash(), "#p=1");
  const with1 = filesWith((p) => p.includes(1));
  assert.deepEqual(await shown(), with1);
  assert.equal(await visible("#hold"), true);
  const v1 = with1.filter((i) => D.files[i].v).length;
  assert.equal(await text("holdText"), `${with1.length - v1} photos` + (v1 ? ` · ${v1} video${v1 > 1 ? "s" : ""}` : ""));
  assert.match(await text("holdText"), /^\d+ photos/);
  assert.equal(await text("holdHint"), "tap another face to narrow");
  assert.equal(await text("slug"), `example · ${with1.length} photos`);
  assert.equal(await text("peopleLabel"), "10 people");
  assert.equal(await b.evalJs(`document.querySelector('#list .face[data-pid="1"]').getAttribute('aria-pressed')`), "true");
  assert.equal(await b.evalJs(`document.querySelector('#list .face[data-pid="1"]').classList.contains('held')`), true);
  // every count is the count if tapped
  assert.equal(await count(2), "9");
  assert.equal(await count(12), "0");
  assert.equal(await b.evalJs(`document.querySelector('.face[data-pid="12"]').classList.contains('dim')`), true);
  for (const p of D.people) assert.equal(await count(p.id), String(filesWith((q) => q.includes(1) && q.includes(p.id)).length), `count beside ${p.id}`);
  assert.equal(await b.evalJs(`document.querySelector('#pair .face img').getBoundingClientRect().width`), 48);

  // two held: together
  await face(2);
  assert.equal(await hash(), "#p=1.2");
  assert.equal((await shown()).length, 9);
  assert.deepEqual(await shown(), filesWith((p) => p.includes(1) && p.includes(2)));
  assert.equal(await text("holdText"), "together · 9 photos");
  const any12 = filesWith((p) => p.includes(1) || p.includes(2));
  assert.equal(await text("holdHint"), `tap the pair to separate → any · ${any12.length}`);
  assert.equal(await b.evalJs(`document.getElementById('pair').classList.contains('tight')`), true);
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 2);

  // tap the pair: any
  await tap("#pair");
  assert.match(await text("holdText"), /^any · /);
  assert.equal(await text("holdText"), `any · ${any12.length} photos`);
  assert.equal(await text("holdHint"), "tap the pair to overlap → together · 9");
  assert.ok((await hash()).endsWith("&any"));
  assert.equal(await hash(), "#p=1.2&any");
  assert.deepEqual(await shown(), any12);
  assert.equal(await b.evalJs(`document.getElementById('pair').classList.contains('apart')`), true);
  for (const p of D.people) assert.equal(await count(p.id), String(filesWith((q) => q.includes(1) || q.includes(2) || q.includes(p.id)).length), `any count beside ${p.id}`);

  // back to together, then a face with no photo together with 1 and 2
  await tap("#pair");
  assert.equal(await text("holdText"), "together · 9 photos");
  assert.equal(await count(12), "0");
  await face(12);
  assert.equal(await hash(), "#p=1.2.12");
  assert.deepEqual(await shown(), []);
  assert.equal(await visible("#empty"), true);
  const anyAll = filesWith((p) => p.includes(1) || p.includes(2) || p.includes(12));
  assert.equal(await b.evalJs(`document.querySelector('#empty button').textContent`), `any · ${anyAll.length}`);
  assert.match(await b.evalJs(`document.querySelector('#empty button').textContent`), /^any · \d+$/);
  await tap("#empty button");
  assert.equal(await hash(), "#p=1.2.12&any");
  assert.deepEqual(await shown(), anyAll);
  assert.equal(await visible("#empty"), false);

  // a held face in the list lets go
  await face(1);
  assert.equal(await hash(), "#p=2.12&any");
  assert.equal(await b.evalJs(`document.querySelector('#list .face[data-pid="1"]').getAttribute('aria-pressed')`), "false");

  // × clears everything
  await tap("#clear");
  assert.equal(await hash(), "");
  assert.equal((await shown()).length, 60);
  assert.equal(await visible("#hold"), false);
  assert.equal(await text("slug"), "example · 60");
  for (const p of D.people) assert.equal(await count(p.id), String(p.n));
});

test("the URL: a shared hold loads; unknown and malformed ids are dropped", async () => {
  await b.load(390, 844, true, "/example/#p=1.999.abc", READY);
  assert.deepEqual(await b.evalJs(`armful.state.picked`), [1]);
  assert.equal(await b.evalJs(`armful.state.any`), false);
  assert.deepEqual(await shown(), filesWith((p) => p.includes(1)));
  await b.load(390, 844, true, "/example/#p=1.2&any", READY);
  assert.deepEqual(await b.evalJs(`armful.state.picked`), [1, 2]);
  assert.equal(await b.evalJs(`armful.state.any`), true);
  assert.equal(await text("holdText"), `any · ${filesWith((p) => p.includes(1) || p.includes(2)).length} photos`);
  for (const h of ["#p=", "#p=999", "#zzz", "#p=..&&any"]) {
    await b.load(390, 844, true, "/example/" + h, READY);
    assert.deepEqual(await b.evalJs(`armful.state.picked`), [], h);
    assert.equal((await shown()).length, 60, h);
    assert.equal(await visible("#hold"), false, h);
  }
});

test("beyond five held: four faces and +N", async () => {
  await b.load(390, 844, true, "/example/", READY);
  for (const pid of [1, 2, 3, 4, 5]) await face(pid);
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 5);
  assert.equal(await b.evalJs(`document.querySelector('#pair .more')`), null);
  await face(6);
  assert.equal(await b.evalJs(`document.querySelectorAll('#pair .face').length`), 4);
  assert.equal(await b.evalJs(`document.querySelector('#pair .more').textContent`), "+2");
  assert.equal(await hash(), "#p=1.2.3.4.5.6");
});

test("desktop: the hold sits in the panel above the pill", async () => {
  await b.load(1440, 900, false, "/example/#p=1.2", READY);
  const r = await b.evalJs(`[document.getElementById('hold'), document.getElementById('people')].map((e) => e.getBoundingClientRect().top)`);
  assert.ok(r[0] < r[1], "hold above the pill");
  assert.equal(await text("holdText"), "together · 9 photos");
});

test("motion: a tapped face flies to the hold on an arc; reduced motion skips it", async () => {
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
