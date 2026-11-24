// Veil tokens: the colours, the self-hosted fonts, the dark ground.
// Run: node --test test/tokens.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPRING = "420ms linear(0, 0.1895, 0.3445, 0.4713, 0.5751, 0.66, 0.7295, 0.7863, 0.8328, 0.8708, 0.902, 0.9274, 0.9483, 0.9653, 0.9793, 0.9907, 1)";
const READY = `document.querySelectorAll('.wall a').length > 0`; // the fixture's data.json has rendered
const FONTS = `Promise.all(['700 20px "Bricolage Grotesque"', '400 16px Inter', '500 16px Inter', '600 16px Inter']
  .map((f) => document.fonts.load(f))).then(() => document.fonts.ready).then(() => true)`;
let srv, b;
const requests = [];
const errors = [];
const prop = (name) => b.evalJs(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
const scheme = (value) => b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });

before(async () => {
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ROOT, "test", "fixture")], { stdio: "ignore" });
  srv = await serve();
  b = await launch(srv.url);
  b.on("Network.requestWillBeSent", (p) => requests.push({ url: p.request.url, type: p.type }));
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await b.cdp("Network.enable");
  await scheme("light"); // headless Chrome otherwise follows the Mac's appearance
  await b.load(390, 844, true, "/example/", READY);
  await b.evalJs(FONTS);
});
after(async () => { await b?.close(); await srv?.close(); });

test("light tokens (phone)", async () => {
  const want = {
    "--ink": "#16231F", "--paper": "#FBFAF7", "--cream": "#F2EFE8", "--body": "#4A5754", "--stone": "#6B7975",
    "--ground": "#FBFAF7", "--text": "#16231F", "--veil": "rgba(255, 255, 255, .75)", "--veil-blur": "20px",
    "--spring": SPRING, "--fade": "250ms cubic-bezier(.2, 0, 0, 1)", "--press": ".94", "--face-s": "44px", "--gutter": "2px",
  };
  for (const [k, v] of Object.entries(want)) assert.equal(await prop(k), v, k);
  for (const t of ["--sl", "--sr", "--st", "--sb"]) assert.equal(await prop(t), "0px", t); // env() resolves; no insets headless
  assert.equal(await b.evalJs(`getComputedStyle(document.body).backgroundColor`), "rgb(251, 250, 247)");
});

test("self-hosted fonts are loaded", async () => {
  // (the metric-matched local fallbacks may also be in use: the first paint can come before the webfonts)
  assert.equal(await b.evalJs(`document.fonts.check('700 20px "Bricolage Grotesque"')`), true);
  assert.equal(await b.evalJs(`document.fonts.check('400 16px Inter')`), true);
  const loaded = await b.evalJs(`[...document.fonts].filter((f) => f.status === 'loaded' && !/Fallback/.test(f.family)).map((f) => f.family.replace(/["']/g, '') + ' ' + f.weight).sort()`);
  assert.deepEqual(loaded, ["Bricolage Grotesque 700", "Inter 400", "Inter 500", "Inter 600"]);
  assert.equal(await b.evalJs(`getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g, '').trim()`), "Inter");
});

test("dark tokens, painted", async () => {
  await scheme("dark");
  await b.load(390, 844, true, "/example/", READY);
  await b.evalJs(FONTS);
  assert.equal(await prop("--ground"), "#0D0F0E");
  assert.equal(await prop("--text"), "#F2EFE8");
  assert.equal(await prop("--veil"), "rgba(13, 15, 14, .72)");
  assert.equal(await prop("--ink"), "#16231F", "named colours do not change in dark");
  assert.equal(await b.evalJs(`getComputedStyle(document.body).backgroundColor`), "rgb(13, 15, 14)");
  assert.equal(await b.evalJs(`getComputedStyle(document.body).color`), "rgb(242, 239, 232)");
  await scheme("light");
});

test("desktop face size", async () => {
  await b.load(1280, 800, false, "/example/", READY);
  assert.equal(await prop("--face-s"), "56px");
});

// last, so the log covers both themes and both viewports
test("no stylesheet or font comes from another host", () => {
  const assets = requests.filter((r) => r.type === "Stylesheet" || r.type === "Font");
  assert.ok(assets.filter((r) => r.type === "Font").length >= 4, "fonts were requested");
  const foreign = assets.filter((r) => !["127.0.0.1", "localhost"].includes(new URL(r.url).hostname));
  assert.deepEqual(foreign, []);
});

test("nothing threw", () => assert.deepEqual(errors, []));
