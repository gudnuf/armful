// The collection page under its real Content-Security-Policy (PAGE_CSP, the header the gate
// middleware sets on gated HTML): opening the panel, holding two faces, opening and stepping
// the previewer through a photo and a video must raise no `securitypolicyviolation` and no
// CSP console error. The other page suites serve site/ without the header.
// Run: node --test test/csp.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";
import { PAGE_CSP } from "../functions/_middleware.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY = `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden`;
const js = (x) => JSON.stringify(x);
let srv, b, D;
const errors = [], csp = [];

const tap = async (sel) => {
  const [x, y] = await b.evalJs(`(() => { const e = document.querySelector(${js(sel)}); if (!e) throw new Error('no ' + ${js(sel)});
    e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await b.tap(x, y);
};
const violations = () => b.evalJs(`window.__csp || []`);

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ROOT, "test", "fixture")], { stdio: "ignore" });
  D = JSON.parse(readFileSync(join(ROOT, "test", "fixture", "data.json"), "utf8"));
  srv = await serve({ headers: (file) => (extname(file) === ".html" ? { "content-security-policy": PAGE_CSP } : {}) });
  b = await launch(srv.url);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  b.on("Log.entryAdded", ({ entry }) => { if (/content security policy/i.test(entry.text || "")) csp.push(entry.text); });
  b.on("Runtime.consoleAPICalled", (p) => { const t = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "); if (/content security policy/i.test(t)) csp.push(t); });
  await b.cdp("Log.enable");
  // listen before any page script runs (DevTools-injected scripts are exempt from the CSP)
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI), true);` });
  await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});
after(async () => { await b?.close(); await srv?.close(); });

test("the page under PAGE_CSP: panel, two held faces, previewer with a video, no violation", async () => {
  await b.load(390, 844, true, "/example/", READY);
  assert.equal(await b.evalJs(`performance.getEntriesByType('navigation')[0].name.endsWith('/example/')`), true);
  // the header really is on the document: an inline script is refused
  assert.equal(await b.evalJs(`(() => { const s = document.createElement('script'); s.textContent = 'window.__inl = 1'; document.head.append(s); return !!window.__inl; })()`), false, "inline script blocked: the CSP is live");
  assert.ok((await violations()).some((v) => /script-src/.test(v)), "the probe itself was reported");
  await b.evalJs(`window.__csp.length = 0`); csp.length = 0;

  // panel
  await tap("#people");
  assert.ok(await b.until(`document.getElementById('list').getClientRects().length > 0`), "list open");
  assert.ok(await b.until(`[...document.querySelectorAll('#listMain .face')].length >= 2`), "faces listed");
  // hold two faces
  const pids = await b.evalJs(`[...document.querySelectorAll('#listMain .face')].slice(0, 2).map((e) => e.dataset.pid)`);
  for (const pid of pids) await tap(`#list .face[data-pid="${pid}"]`);
  assert.ok(await b.until(`!document.getElementById('pair').hidden && document.querySelectorAll('#pair .face').length === 2`), "the held faces show in the pill");

  assert.deepEqual(await violations(), [], "securitypolicyviolation events (panel, hold)");

  // previewer: a video tile, then step both ways (photos and the video iframe)
  await b.load(1280, 900, false, "/example/", READY);
  const vid = D.files.findIndex((f) => f.v);
  assert.ok(vid >= 0, "the fixture has a video");
  await b.evalJs(`(() => { const t = document.querySelector('.tile[data-n="${vid}"]'); t.scrollIntoView({ block: 'center' }); t.click(); })()`);
  assert.ok(await b.until(`!document.getElementById('lb').hidden && !!document.querySelector('#lbStage iframe')`), "video iframe in the previewer");
  for (const [k, code] of [["ArrowRight", 39], ["ArrowRight", 39], ["ArrowLeft", 37], ["ArrowLeft", 37], ["ArrowLeft", 37]]) {
    await b.key(k, code);
    await b.until(`!!document.querySelector('#lbStage img, #lbStage iframe')`, 2000);
  }
  assert.ok(await b.until(`(() => { const i = document.querySelector('#lbStage img'); return !i || i.naturalWidth > 0; })()`, 3000));
  await b.key("Escape", 27);
  assert.ok(await b.until(`document.getElementById('lb').hidden`), "previewer closes");

  assert.deepEqual(await violations(), [], "securitypolicyviolation events (previewer)");
  assert.deepEqual(csp, [], "CSP console messages");
  assert.deepEqual(errors, []);
});
