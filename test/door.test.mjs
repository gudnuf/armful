// The door in a real browser, served by functions/_middleware.js under `wrangler pages dev`
// (test/wrangler.mjs, as test/gate.test.mjs does). With script: a wrong password stays on the
// same document (a window marker survives), shakes the field, selects it, fills the live region,
// and shows the pending arrow while the server's delay runs; the right one then lands on the
// collection page, hash kept. Without script: the plain form POST still works (401 door, 303 in).
// No CSP violation on the door either way. Synthetic fixture only.
// Run: node --test test/door.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./cdp.mjs";
import { makeWork, start, stop, key } from "./wrangler.mjs";

const SLUG = "door-test-coll";
const PASS = ["correct", "horse", "battery", "staple"].join(" ");
const T = { timeout: 60000 };
let WORK, base, b;

before(async () => {
  WORK = makeWork([[SLUG, { title: "Example Weekend" }]]);
  base = await start(WORK, { [key(SLUG)]: PASS });
  b = await launch(base, { timeout: 15000 });
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI), true);` });
  await b.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
}, { timeout: 180000 });

after(async () => {
  await b?.close();
  await stop();
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

// evalJs, but a navigation in flight (the old context gone) reads as "not yet"
const safe = async (expr) => { try { return await b.evalJs(expr); } catch { return undefined; } };
const until = async (expr, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await safe(expr)) return true; return false; };
const type = async (text) => { await b.evalJs(`document.querySelector('input[type=password]').focus()`); await b.cdp("Input.insertText", { text }); };
const enter = async () => { for (const t of ["keyDown", "keyUp"]) await b.cdp("Input.dispatchKeyEvent", { type: t, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(t === "keyDown" ? { text: "\r" } : {}) }); };
const clickArrow = async () => {
  const [x, y] = await b.evalJs(`(() => { const r = document.querySelector('form.door button').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await b.click(x, y);
};
const ON_COLLECTION = `location.pathname === '/${SLUG}/' && !!document.querySelector('script[src^="app."]') && !document.querySelector('form.door')`;

test("with script: a wrong password shakes in place, the right one lands on the collection", T, async () => {
  await b.cdp("Network.clearBrowserCookies");
  await b.navigate("about:blank");
  await b.navigate(`${base}/${SLUG}/#p=3`);
  assert.ok(await until(`!!document.querySelector('form.door')`), "the door");
  await b.evalJs(`window.__marker = 'same document';
    document.querySelector('.field').addEventListener('animationstart', (e) => { window.__shook = (window.__shook || 0) + (e.animationName === 'shake'); });`);

  for (let n = 1; n <= 2; n++) { // twice: the shake and the announcement repeat
    await type(n === 1 ? "not the password" : "still not it");
    const t0 = Date.now();
    await (n === 1 ? clickArrow() : enter());
    assert.ok(await until(`document.querySelector('form.door').getAttribute('aria-busy') === 'true' && document.querySelector('form.door button').disabled`, 600),
      "pending: busy, arrow disabled");
    assert.equal(await b.evalJs(`getComputedStyle(document.querySelector('form.door button')).animationName`), "pulse");
    assert.ok(await until(`document.getElementById('wrong').textContent === 'Wrong password. Try again.'`), `live region (try ${n})`);
    assert.ok(Date.now() - t0 >= 700, `the server's delay still applies (${Date.now() - t0}ms)`);
    const s = await b.evalJs(`(() => { const i = document.querySelector('input[type=password]'), f = document.querySelector('form.door');
      return { marker: window.__marker, href: location.href, shook: window.__shook || 0, wrong: f.classList.contains('wrong'),
        busy: f.hasAttribute('aria-busy'), disabled: f.querySelector('button').disabled, focused: document.activeElement === i,
        selected: i.value.length > 0 && i.selectionStart === 0 && i.selectionEnd === i.value.length,
        invalid: i.getAttribute('aria-invalid'), described: i.getAttribute('aria-describedby'),
        navs: performance.getEntriesByType('navigation').length }; })()`);
    assert.deepEqual(s, { marker: "same document", href: `${base}/${SLUG}/#p=3`, shook: n, wrong: true, busy: false, disabled: false,
      focused: true, selected: true, invalid: "true", described: "wrong", navs: 1 }, `try ${n}`);
    assert.deepEqual((await b.cdp("Network.getCookies", { urls: [base + `/${SLUG}/`] })).cookies, [], "no cookie after a wrong try");
  }

  await type(PASS); // replaces the selected wrong value
  await enter();
  assert.ok(await until(ON_COLLECTION, 15000), "lands on the collection page");
  assert.equal(await b.evalJs(`window.__marker`), undefined, "a new document");
  assert.equal(await b.evalJs(`location.href`), `${base}/${SLUG}/#p=3`, "the hash is kept, no stray '?'");
  assert.equal(await b.evalJs(`performance.getEntriesByType('navigation')[0].responseStatus`), 200);
  assert.ok(await until(`document.querySelectorAll('#wall .tile').length > 0`, 15000), "the wall draws");
  // the door is gone from history: back does not return to it
  assert.equal(await b.evalJs(`history.length`), 2, "about:blank, then the collection (the door replaced)");
});

test("a shared view's link survives the door: the query and the open photo land as they were sent", T, async () => {
  const D = JSON.parse(readFileSync(join(WORK, "dist", SLUG, "data.json"), "utf8"));
  const i = D.files.findIndex((f, k) => k > 0 && !f.v && f.w > 0 && f.p.includes(1) && f.p.includes(2));
  const shared = `#p=1.2&m=f&o=${D.files[i].i}`;
  for (const script of [true, false]) { // the door's script posts by fetch; without it, the plain form (the hash rides in "to")
    await b.cdp("Network.clearBrowserCookies");
    await b.navigate("about:blank");
    await b.navigate(`${base}/${SLUG}/${shared}`);
    assert.ok(await until(`!!document.querySelector('form.door')`), "the door");
    if (!script) await b.evalJs(`document.querySelector('form.door').onsubmit = null; document.querySelector('form.door').addEventListener('submit', (e) => e.stopImmediatePropagation(), true)`);
    await type(PASS);
    await enter();
    assert.ok(await until(ON_COLLECTION, 15000), `lands on the collection (${script ? "fetch" : "form"})`);
    assert.ok(await until(`!document.getElementById('lb').hidden`, 15000), "the shared photo opens");
    const s = await b.evalJs(`({ hash: location.hash, picked: armful.state.picked, m: armful.state.m,
      open: armful.D.files[[...document.querySelectorAll('#wall .tile')].filter((t) => !t.hidden).map((t) => +t.dataset.n)[armful.state.lb]].i })`);
    assert.deepEqual(s, { hash: "#p=1.2&m=f", picked: [1, 2], m: "f", open: D.files[i].i }, script ? "fetch" : "form");
  }
});

test("without script: the plain form POST still works (401 door with .wrong, then 303 to the collection)", T, async () => {
  await b.cdp("Network.clearBrowserCookies");
  await b.cdp("Emulation.setScriptExecutionDisabled", { value: true });
  try {
    await b.navigate("about:blank");
    await b.navigate(`${base}/${SLUG}/`);
    await type("not the password");
    await enter();
    assert.ok(await until(`performance.getEntriesByType('navigation')[0].name.endsWith('/__gate')
      && document.querySelector('form.door').classList.contains('wrong')`), "the 401 door, reloaded with .wrong");
    assert.equal(await b.evalJs(`performance.getEntriesByType('navigation')[0].responseStatus`), 401);
    assert.equal(await b.evalJs(`document.getElementById('wrong').textContent`), "Wrong password. Try again.");
    await type(PASS);
    await enter();
    assert.ok(await until(ON_COLLECTION, 15000), "303 into the collection page");
  } finally {
    await b.cdp("Emulation.setScriptExecutionDisabled", { value: false });
  }
});

test("the door raises no CSP violation (inline script by hash, fetch by connect-src)", T, async () => {
  await b.cdp("Network.clearBrowserCookies");
  await b.navigate("about:blank");
  await b.navigate(`${base}/${SLUG}/`);
  await type("nope nope");
  await enter();
  assert.ok(await until(`document.getElementById('wrong').textContent !== ''`), "the fetch ran");
  assert.deepEqual(await b.evalJs(`window.__csp`), []);
});
