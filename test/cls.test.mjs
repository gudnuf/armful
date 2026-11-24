// Layout stability: every page armful serves keeps CLS (cumulative layout shift, the sum
// of every layout-shift entry without recent input) under 0.01, on a cold load (cache
// disabled and cleared, the hard-refresh case), a hard reload and a warm reload, on a
// slightly throttled network so a late font swap cannot hide. Pages: the home page with
// empty and seeded "Recent" storage, the 404 page, the collection door (functions/_door.js)
// and the collection page itself (fixture data; measured until its images have loaded).
// 390x844 and 1440x900, light and dark. Prints one line per case.
// Builds dist/ in a temp dir from the synthetic fixture; Drive requests are answered
// locally (nothing leaves the machine). Run:
//   node --test test/cls.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { door } from "../functions/_door.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const LIMIT = 0.01;
const SEED = JSON.stringify([{ slug: "example", title: "Example Weekend", door: "DOOR_PHOTO_ID_0123456789", t: 1764000000000 }]);
// layout-shift entries, from the very start of each document
const OBSERVE = `window.__cls = 0; window.__shifts = [];
new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue; window.__cls += e.value;
  window.__shifts.push(e.value.toFixed(4) + "@" + Math.round(e.startTime) + "ms " + (e.sources || []).map((s) => s.node ?
    (s.node.id ? "#" + s.node.id : (typeof s.node.className === "string" && s.node.className ? "." + s.node.className.split(" ")[0] : s.node.nodeName)) : "?").join(",")); } })
  .observe({ type: "layout-shift", buffered: true });`;
const PAGES = {
  "home empty": { path: "/", store: null },
  "home seeded": { path: "/", store: SEED },
  "404": { path: "/404.html", store: null },
  "door": { path: "/door/", store: null },
  // settled: the wall is drawn and every image in view has loaded (or failed)
  "collection": { path: "/example/", store: null, settle: `document.querySelectorAll('#wall .tile').length === 60 && document.getElementById('loading').hidden
    && [...document.querySelectorAll('#wall img')].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete)` },
};
let WORK, srv, base, b;
const results = [];

before(async () => {
  WORK = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-cls-"));
  const fx = join(WORK, "fixture"), col = join(WORK, "collections", "example");
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), fx], { stdio: "ignore" });
  mkdirSync(join(col, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "collections", "example", "collection.json"), join(col, "collection.json"));
  copyFileSync(join(fx, "data.json"), join(col, "dist", "data.json"));
  execFileSync(process.execPath, [join(ROOT, "bin", "build-dist.mjs"), "--collection", col, "--out", join(WORK, "dist")], { cwd: WORK, stdio: "ignore" });
  const dist = join(WORK, "dist");
  // the door as the gate serves it: the built door.json (name, dates, font URLs), a placeholder photo id
  const dj = JSON.parse(readFileSync(join(dist, "example", "door.json"), "utf8"));
  const doorHtml = await door(200, false, { ...dj, slug: "example", photo: "DOOR_PHOTO_ID_0123456789" }).text();
  srv = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/door/") return res.writeHead(200, { "content-type": TYPES[".html"] }).end(doorHtml);
    // the fixture's thumbnails (data.json's thumbs templates name fx/...)
    const [root, rel] = p.startsWith("/example/fx/") ? [fx, normalize(p.slice("/example/".length))]
      : [dist, normalize(p === "/" ? "index.html" : p.endsWith("/") ? p.slice(1) + "index.html" : p.slice(1))];
    if (rel.startsWith("..") || rel.includes(sep + "..")) return res.writeHead(404).end();
    let body;
    try { body = readFileSync(join(root, rel)); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" }).end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  b = await launch(base, { timeout: 20000 });
  // Drive thumbnails (the door photo, the Recent card): answered here, a little late
  const png = readFileSync(join(ROOT, "home", "og", "og.png")).toString("base64");
  b.on("Fetch.requestPaused", (p) => setTimeout(() => b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: png }).catch(() => {}), 300));
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*drive.google.com*" }, { urlPattern: "*googleusercontent.com*" }] });
  await b.cdp("Network.enable");
  // a slow-ish connection: 1.5 Mbps down, 150 ms round trip
  await b.cdp("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.5e6 / 8, uploadThroughput: 750e3 / 8 });
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVE });
}, { timeout: 90000 });

after(async () => {
  for (const r of results) console.log(r);
  await b?.close();
  await new Promise((r) => (srv ? srv.close(r) : r()));
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

// wait for the next load event (after a Page.reload)
const nextLoad = () => new Promise((res) => { const off = b.on("Page.loadEventFired", () => { off(); res(); }); });
async function measure(name, settle) {
  if (settle && !(await b.until(settle, 15000))) throw new Error(`${name}: did not settle`);
  await sleep(1200); // a late font swap or image still has time to move something
  const { cls, shifts } = await b.evalJs("({ cls: window.__cls, shifts: window.__shifts })");
  results.push(`cls ${cls.toFixed(4)}  ${name}${shifts.length ? "  " + shifts.join(" | ") : ""}`);
  return { cls, shifts };
}

for (const [w, h, mobile] of [[390, 844, true], [1440, 900, false]]) for (const scheme of ["light", "dark"]) for (const [page, o] of Object.entries(PAGES)) {
  test(`${page} at ${w}x${h} ${scheme}: CLS < ${LIMIT} cold, hard reload and warm reload`, { timeout: 120000 }, async () => {
    await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await b.load(w, h, mobile, "/404.html");
    await b.evalJs(`localStorage.clear(); ${o.store ? `localStorage.setItem("armful:recent", ${JSON.stringify(o.store)})` : ""}`);
    const tag = `${page} ${w}x${h} ${scheme}`;
    const got = [];
    // cold: nothing cached
    await b.cdp("Network.clearBrowserCache");
    await b.cdp("Network.setCacheDisabled", { cacheDisabled: true });
    await b.load(w, h, mobile, o.path, "document.readyState === 'complete'", 20000);
    got.push(["cold", await measure(`${tag} cold`, o.settle)]);
    // hard reload: the cache bypassed
    let loaded = nextLoad();
    await b.cdp("Page.reload", { ignoreCache: true }); await loaded;
    got.push(["hard reload", await measure(`${tag} hard reload`, o.settle)]);
    // warm reload: the cache on
    await b.cdp("Network.setCacheDisabled", { cacheDisabled: false });
    loaded = nextLoad();
    await b.cdp("Page.reload", {}); await loaded;
    got.push(["warm reload", await measure(`${tag} warm reload`, o.settle)]);
    for (const [kind, { cls, shifts }] of got) assert.ok(cls < LIMIT, `${tag} ${kind}: CLS ${cls.toFixed(4)} ${shifts.join(" | ")}`);
  });
}
