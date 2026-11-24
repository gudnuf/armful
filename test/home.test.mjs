// Home page: the "Recent" row is progressive enhancement. It reads
// localStorage["armful:recent"] (shape documented in home/index.html), draws nothing when
// it is empty or unusable, validates every field, and renders titles as text.
// Builds dist/ in a temp dir (synthetic fixture), serves it on loopback; Drive thumbnail
// requests are answered locally (no request leaves the machine). Run:
//   node --test test/home.test.mjs (bin/check.sh serialises the Chrome suites when ARMFUL_CHROME_LOCK is set)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
const DOOR = "DOOR_PHOTO_ID_0123456789";
const KEY = "armful:recent";
let WORK, srv, base, b;
const errors = [], drive = [];

before(async () => {
  WORK = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-home-"));
  const fx = join(WORK, "fixture"), col = join(WORK, "collections", "example");
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), fx], { stdio: "ignore" });
  mkdirSync(join(col, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "collections", "example", "collection.json"), join(col, "collection.json"));
  copyFileSync(join(fx, "data.json"), join(col, "dist", "data.json"));
  execFileSync(process.execPath, [join(ROOT, "bin", "build-dist.mjs"), "--collection", col, "--out", join(WORK, "dist")], { cwd: WORK, stdio: "ignore" });
  const dist = join(WORK, "dist");
  srv = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const rel = normalize(p === "/" ? "index.html" : p.slice(1));
    if (rel.startsWith("..") || rel.includes(sep + "..")) return res.writeHead(404).end();
    let body;
    try { body = readFileSync(join(dist, rel)); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" }).end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  b = await launch(base);
  b.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  // Drive thumbnails: answered here with the touch icon, never fetched from Google
  const png = readFileSync(join(ROOT, "home", "og", "apple-touch-icon.png")).toString("base64");
  b.on("Fetch.requestPaused", (p) => {
    drive.push(p.request.url);
    b.cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: png }).catch(() => {});
  });
  await b.cdp("Fetch.enable", { patterns: [{ urlPattern: "*drive.google.com*" }, { urlPattern: "*googleusercontent.com*" }] });
}, { timeout: 60000 });

after(async () => {
  await b?.close();
  await new Promise((r) => (srv ? srv.close(r) : r()));
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

const scheme = (value) => b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
// open the home page with this value in storage (undefined: storage cleared)
async function open(value, { w = 390, h = 844, mobile = true } = {}) {
  await b.load(w, h, mobile, "/");
  await b.evalJs(`localStorage.clear(); ${value === undefined ? "" : `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(value)})`}`);
  errors.length = 0; drive.length = 0;
  await b.load(w, h, mobile, "/", "document.readyState === 'complete'");
}
const cards = () => b.evalJs(`[...document.querySelectorAll('.recent .card')].map((a) => ({
  href: a.getAttribute('href'), name: a.querySelector('.name').textContent,
  nameHtml: a.querySelector('.name').innerHTML, imgs: a.querySelectorAll('img').length,
  src: a.querySelector('img')?.getAttribute('src') || null, lazy: a.querySelector('img')?.loading || null }))`);
const valid = (over = {}) => ({ slug: "example-weekend", title: "Example Weekend", door: DOOR, t: 1764000000000, ...over });

test("empty, missing or unusable storage: no Recent section at all", { timeout: 60000 }, async () => {
  await scheme("light");
  for (const v of [undefined, "[]", "", "null", "{}", "not json", "{\"slug\":\"example-weekend\"}", "[null,1,\"x\",[]]",
    JSON.stringify([{ slug: "AB", title: "x", door: null, t: 1 }])]) {
    await open(v);
    assert.equal(await b.evalJs("document.querySelectorAll('.recent, .card').length"), 0, String(v));
    assert.equal(await b.evalJs("document.body.innerText.includes('Recent')"), false, String(v));
    assert.deepEqual(drive, [], `no thumbnail request for ${v}`);
    assert.deepEqual(errors, [], String(v));
  }
  // the page itself is unchanged: the copy, the footer
  assert.equal(await b.evalJs("document.querySelector('.title').textContent"), "Armfuls of photos, finally findable.");
});

test("one valid and one hostile entry: exactly one card, a link to /<slug>/, the title as text", { timeout: 60000 }, async () => {
  await scheme("light");
  const hostile = { slug: "../evil\"><script>", title: "<img src=x onerror=\"window.__pwned=1\">", door: "bad id\"><img src=x>", t: 2 };
  await open(JSON.stringify([hostile, valid()]));
  const c = await cards();
  assert.equal(c.length, 1, JSON.stringify(c));
  assert.equal(c[0].href, "/example-weekend/");
  assert.equal(c[0].name, "Example Weekend");
  assert.equal(c[0].src, `https://drive.google.com/thumbnail?id=${DOOR}&sz=w400`);
  assert.equal(c[0].lazy, "lazy");
  assert.equal(await b.evalJs("document.querySelector('.recent .lbl').textContent"), "Recent");
  assert.equal(await b.evalJs("document.querySelectorAll('.recent').length"), 1);
  assert.equal(await b.evalJs("window.__pwned === undefined"), true);
  // the box is a 3:2, 14px-rounded cream placeholder before (and under) the image
  const box = await b.evalJs(`(() => { const t = document.querySelector('.card .thumb'), r = t.getBoundingClientRect(), s = getComputedStyle(t);
    return { ratio: r.width / r.height, radius: s.borderTopLeftRadius, bg: s.backgroundColor }; })()`);
  assert.ok(Math.abs(box.ratio - 1.5) < 0.02, `ratio ${box.ratio}`);
  assert.equal(box.radius, "14px");
  assert.equal(box.bg, "rgb(242, 239, 232)");
  assert.equal(await b.until("document.querySelector('.card img')?.complete && document.querySelector('.card img').naturalWidth > 0"), true);
  assert.deepEqual(errors, []);
});

test("a hostile title on a valid slug is rendered as text, never as markup", { timeout: 60000 }, async () => {
  await scheme("light");
  const title = "<img src=x onerror=\"window.__pwned=1\">";
  await open(JSON.stringify([valid({ title, door: null })]));
  const c = await cards();
  assert.equal(c.length, 1);
  assert.equal(c[0].name, title);
  assert.equal(c[0].nameHtml, title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  assert.equal(c[0].imgs, 0, "door null: the placeholder only");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await b.evalJs("window.__pwned === undefined"), true);
  assert.deepEqual(drive, []);
});

test("each field is checked: bad doors, long titles, reserved and duplicate slugs are skipped; at most 6", { timeout: 60000 }, async () => {
  await scheme("light");
  const list = [
    valid({ slug: "static", title: "reserved" }),
    valid({ slug: "one-coll", title: "x".repeat(81) }),
    valid({ slug: "two-coll", door: "short" }),
    valid({ slug: "three-coll", t: "yesterday" }),
    valid({ slug: "four-coll", title: 42 }),
    ...["aaaaaa", "bbbbbb", "aaaaaa", "cccccc", "dddddd", "eeeeee", "ffffff", "gggggg"].map((slug, i) => valid({ slug, title: `T${i}` })),
  ];
  await open(JSON.stringify(list), { w: 1280, h: 800, mobile: false });
  const c = await cards();
  assert.deepEqual(c.map((x) => x.href), ["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee", "ffffff"].map((s) => `/${s}/`));
  assert.deepEqual(errors, []);
});

// WCAG contrast of the computed text colour on the page ground
const CONTRAST = `(() => {
  const rgb = (s) => s.match(/[\\d.]+/g).map(Number);
  const mix = (fg, bg) => fg.length > 3 && fg[3] < 1 ? fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])) : fg.slice(0, 3);
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ground = rgb(getComputedStyle(document.body).backgroundColor);
  const ratio = (el) => { const a = lum(mix(rgb(getComputedStyle(el).color), ground)), z = lum(ground); return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05); };
  return { ground: getComputedStyle(document.body).backgroundColor, name: ratio(document.querySelector('.card .name')),
    lbl: ratio(document.querySelector('.recent .lbl')), box: getComputedStyle(document.querySelector('.card .thumb')).backgroundColor };
})()`;

test("light and dark: the titles and the label are legible on the ground", { timeout: 60000 }, async () => {
  for (const [mode, ground] of [["light", "rgb(251, 250, 247)"], ["dark", "rgb(13, 15, 14)"]]) {
    await scheme(mode);
    await open(JSON.stringify([valid({ door: null })]));
    const c = await b.evalJs(CONTRAST);
    assert.equal(c.ground, ground, mode);
    assert.ok(c.name >= 7, `${mode}: title contrast ${c.name}`);
    assert.ok(c.lbl >= 4.5, `${mode}: label contrast ${c.lbl}`);
    if (mode === "dark") assert.notEqual(c.box, "rgb(242, 239, 232)", "dark: the placeholder is not a bright cream slab");
  }
  await scheme("light");
});

// one rendered pixel of a page, [r, g, b]: a 1x1 PNG (with no neighbours every scanline filter is the identity)
async function pixel(x, y) {
  const buf = Buffer.from((await b.cdp("Page.captureScreenshot", { format: "png", clip: { x, y, width: 1, height: 1, scale: 1 } })).data, "base64");
  let o = 8, idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8);
    if (type === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

test("the favicon follows the tab: ink on light, paper on dark (home, 404 and collection share it)", { timeout: 60000 }, async () => {
  const href = await (async () => { await b.load(390, 844, true, "/"); return b.evalJs("document.querySelector('link[rel=icon]').getAttribute('href')"); })();
  assert.match(href, /^\/static\/favicon\.[0-9a-f]{10}\.svg$/);
  await b.load(390, 844, true, "/404.html");
  assert.equal(await b.evalJs("document.querySelector('link[rel=icon]').getAttribute('href')"), href);
  for (const [mode, rgb] of [["light", [0x16, 0x23, 0x1f]], ["dark", [0xf2, 0xef, 0xe8]]]) {
    await scheme(mode);
    await b.load(512, 512, false, href);
    const px = await pixel(80, 150); // inside the symbol's left column
    assert.ok(px.every((c, i) => Math.abs(c - rgb[i]) <= 3), `${mode}: ${px} should be ${rgb}`);
  }
  await scheme("light");
});
