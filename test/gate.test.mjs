// Gate test: functions/_middleware.js under `wrangler pages dev`, on a real dist/
// built by bin/build-dist.mjs in a temp dir from the synthetic fixture. Gates only collection
// prefixes, fails closed (503 with no or a weak secret, 401 with no cookie, 400
// for any odd path shape), never serves data.json without the cookie.
// No real data: the door photo id is a placeholder.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, readdirSync, readFileSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { door, SCRIPT, SCRIPT_HASH, CSP, FAVICON_SVG } from "../functions/_door.js";
import { PAGE_CSP } from "../functions/_middleware.js";
import { makeWork, start as startPages, stop, key } from "./wrangler.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "bnf-ytt-spain-2026";
const OTHER = "other-coll"; // a second collection: the SAME password, no door.json
const WEAK = "weak-coll"; // a third collection whose secret is too short
const PASS = ["correct", "horse", "battery", "staple"].join(" ");
const PAGE_MARK = '<script src="app.'; // only the real collection page has it, never the door
const DATA_CANARY = "DATACANARYFILEID0123"; // a file id only data.json carries: never on the door
const TITLE = "Example Weekend";
let ASSET, ASSET_HEAD; // the collection's fingerprinted app.js, and its first bytes
const T = { timeout: 60000 }; // per test
const REQ_MS = 15000; // per request

let WORK; // temp project dir: functions -> repo functions, dist/, .dev.vars
let base; // the running wrangler
const start = async (secrets) => { base = await startPages(WORK, secrets); };

const get = (path, headers = {}, method = "GET") =>
  fetch(base + path, { method, redirect: "manual", headers, signal: AbortSignal.timeout(REQ_MS) });
// raw HTTP, so the path reaches the server byte for byte (fetch would normalise it)
const raw = (path, method = "GET", headers = {}, body = null) => new Promise((res, rej) => {
  const u = new URL(base);
  const req = httpRequest({ host: u.hostname, port: u.port, path, method, headers, timeout: REQ_MS }, (r) => {
    let b = ""; r.setEncoding("utf8"); r.on("data", (d) => { b += d; });
    r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: b }));
  });
  req.on("timeout", () => req.destroy(new Error(`timeout: ${method} ${path}`)));
  req.on("error", rej);
  req.end(body);
});
const post = (slug, fields) => fetch(base + `/${slug}/__gate`, {
  method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQ_MS),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const gate = (p, to = "") => post(SLUG, { p, to });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
const notJson = (body) => { try { JSON.parse(body); return false; } catch { return true; } };

// __file/<id>: a local stand-in for Drive's download host (the middleware honours a loopback
// ARMFUL_FILE_UPSTREAM only). It records every request; VID_OK streams a QuickTime header, waits,
// then the rest; VID_HTML answers an HTML page; anything else is a 500.
const VID_OK = "VIDEOFILEID22abcdef", VID_HTML = "VIDEOFILEID26abcdef", PHOTO_ID = "PHOTOFILEID01abcdef";
const HEAD = Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypqt  "), 0, 0, 0, 0]);
const TAIL = Buffer.alloc(200000, 7);
let upstream, UPSTREAM_URL;
const upstreamLog = [];
before(async () => {
  upstream = createServer((req, res) => {
    upstreamLog.push({ url: req.url, range: req.headers.range || null, cookie: req.headers.cookie || null });
    const id = new URL(req.url, "http://x").searchParams.get("id");
    if (id === VID_OK) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(HEAD.length + TAIL.length) });
      res.write(HEAD);
      setTimeout(() => res.end(TAIL), 1500);
    } else if (id === VID_HTML) res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<html>virus scan</html>");
    else res.writeHead(500).end();
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}`;
});
after(() => new Promise((r) => (upstream ? upstream.close(r) : r())));

before(() => {
  WORK = makeWork([[SLUG, { title: TITLE, door_photo: "PLACEHOLDER_DOOR_ID", door_position: "center 30%" },
    (data) => { data.files[0].i = DATA_CANARY; data.files[22].i = VID_OK; data.files[26].i = VID_HTML; data.files[1].i = PHOTO_ID; return data; }], [OTHER], [WEAK]]);
  const app = readdirSync(join(WORK, "dist", SLUG)).find((n) => /^app\.[0-9a-f]{10}\.js$/.test(n));
  ASSET = `/${SLUG}/${app}`;
  ASSET_HEAD = readFileSync(join(WORK, "dist", SLUG, app), "utf8").slice(0, 120);
});

after(async () => {
  await stop();
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

describe("door() markup, no server", () => {
  test("the inline script matches the CSP hash", () => {
    assert.equal(SCRIPT_HASH, "sha256-" + createHash("sha256").update(SCRIPT).digest("base64"));
  });

  test("hostile door.json values never reach the markup", async () => {
    const hostile = ['"><script>alert(1)</script>', '"; onload=alert(1) x="', ";background:url(https://evil.example/x)",
      "abc\ndef", "</style><script>alert(1)</script>"];
    for (const photo of [...hostile, "OK_PHOTO_ID_123"]) {
      for (const position of [...hostile, "center 30%"]) {
        const html = await door(401, false, { slug: SLUG, photo, position }).text();
        assert.equal((html.match(/<script/g) || []).length, 1, `${photo} | ${position}`);
        assert.ok(!/onload|onerror|alert\(|evil\.example/.test(html), `${photo} | ${position}`);
        if (photo === "OK_PHOTO_ID_123") {
          assert.match(html, /thumbnail\?id=OK_PHOTO_ID_123&amp;sz=w1600/);
          assert.match(html, position === "center 30%" ? /object-position: center 30%/ : /object-position: center"/);
        } else {
          assert.ok(!html.includes("drive.google.com/thumbnail"), photo);
        }
      }
    }
    const evil = await door(401, false, { slug: '"><script>x</script>' }).text();
    assert.equal((evil.match(/<script/g) || []).length, 1);
  });

  test("link preview: Open Graph card from the title and the door photo, escaped, nothing else", async () => {
    const og = (html) => Object.fromEntries([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[a-z_:]+)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]));
    const a = og(await door(401, false, { slug: SLUG, photo: "OK_PHOTO_ID_123", title: "Example Weekend" }).text());
    assert.deepEqual(a, {
      "og:type": "website", "og:site_name": "armful", "og:title": "Example Weekend on armful",
      "og:description": "Find your friends in the photos.",
      "og:image": "https://lh3.googleusercontent.com/d/OK_PHOTO_ID_123=w1200-h630-c",
      "og:image:width": "1200", "og:image:height": "630", "twitter:card": "summary_large_image",
      "twitter:title": "Example Weekend on armful", "twitter:description": "Find your friends in the photos.",
    });
    // no title: the slug; a bad photo id: no image tags at all
    const b = og(await door(401, false, { slug: SLUG, photo: '"><script>x</script>' }).text());
    assert.equal(b["og:title"], `${SLUG} on armful`);
    assert.ok(!("og:image" in b) && !("og:image:width" in b) && !("og:image:height" in b));
    // a hostile title is text in an attribute, cut to 80 characters
    const html = await door(401, false, { slug: SLUG, title: '"><script>alert(1)</script>\n<img src=x onerror=alert(1)>' + "x".repeat(200) }).text();
    assert.equal((html.match(/<script/g) || []).length, 1);
    assert.ok(!html.includes("<img src=x") && !html.includes("<script>alert"));
    const t = og(html)["og:title"].replace(/&(quot|lt|gt|amp|#39);/g, "_");
    assert.match(t, /^_+script_alert\(1\)_\/script_ _img src=x onerror=alert\(1\)_x+ on armful$/);
    assert.equal(t.length, 80 + " on armful".length);
    assert.match(html, /<meta name="robots" content="noindex/);
  });

  test("wrong door: alert is described by the input", async () => {
    const html = await door(401, true, { slug: SLUG }).text();
    assert.match(html, /<p class="sr" id="wrong" role="alert">Wrong password\. Try again\.<\/p>/);
    assert.match(html, /<input type="password"[^>]*aria-describedby="wrong"/);
  });

  test("live region always present (empty until a wrong try); fetch allowed by connect-src; view transition opt-in", async () => {
    const ok = await door(401, false, { slug: SLUG }).text();
    assert.match(ok, /<p class="sr" id="wrong" role="alert"><\/p>/);
    assert.doesNotMatch(ok.match(/<input type="password"[^>]*>/)[0], /aria-describedby|aria-invalid/);
    assert.match(ok, /@view-transition\{navigation:auto\}/);
    assert.match(ok, /\.door\[aria-busy=true\] button\{[^}]*animation:pulse/);
    assert.match(CSP, /(^|; )connect-src 'self'(;|$)/);
    assert.match(CSP, /(^|; )default-src 'none'(;|$)/);
  });

  test("the cover: name and dates as escaped text, og:title from the name; omitted when absent or unusable", async () => {
    const FONTS = { display: "/static/fonts/bricolage-grotesque-700.0123456789.woff2", label: "/static/fonts/inter-600.0123456789.woff2",
      text: "/static/fonts/inter-500.0123456789.woff2" };
    const html = await door(401, false, { slug: SLUG, title: TITLE, name: "BNF YTT Spain", dates: "15 Aug – 4 Sep 2026", fonts: FONTS }).text();
    assert.match(html, /<div class="cover"><h1 class="name">BNF YTT Spain<\/h1><p class="dates">15 Aug – 4 Sep 2026<\/p><\/div>/);
    assert.match(html, /<meta property="og:title" content="BNF YTT Spain on armful">/);
    for (const u of Object.values(FONTS)) {
      assert.ok(html.includes(`<link rel="preload" href="${u}" as="font" type="font/woff2" crossorigin>`), u);
      assert.ok(html.includes(`src:url(${u}) format("woff2")`), u);
    }
    const hostile = '<img src=x onerror="alert(1)">&';
    const h = await door(401, false, { slug: SLUG, name: hostile, dates: hostile }).text();
    const esc = hostile.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    assert.ok(h.includes(`<h1 class="name">${esc}</h1><p class="dates">${esc}</p>`));
    assert.doesNotMatch(h, /<img src=x/);
    // absent, too long, not text, control characters: no cover (and no fonts); dates alone never show
    for (const o of [{}, { name: "x".repeat(61) }, { name: 42 }, { name: "a\nb" }, { dates: "1 May" }, { name: "  " }]) {
      const d = await door(401, false, { slug: SLUG, fonts: { display: FONTS.display }, ...o }).text();
      assert.doesNotMatch(d, /class="cover"|class="dates"/, JSON.stringify(o));
      assert.doesNotMatch(d, /bricolage/, JSON.stringify(o));
    }
    // a too-long dates line is dropped, the name stays
    const d = await door(401, false, { slug: SLUG, name: "Ok", dates: "x".repeat(41) }).text();
    assert.match(d, /<div class="cover"><h1 class="name">Ok<\/h1><\/div>/);
    // font URLs other than /static/fonts/<name>.<hash>.woff2 are never named
    for (const bad of ["https://evil.example/f.woff2", "/static/fonts/x.woff2", "/x/fonts/a.0123456789.woff2", '/static/fonts/a.0123456789.woff2"><script>']) {
      const t = await door(401, false, { slug: SLUG, name: "Ok", dates: "May", fonts: { display: bad, label: bad, text: bad } }).text();
      assert.doesNotMatch(t, /rel="preload"|@font-face\{font-family:"(Bricolage Grotesque|Inter)"/, bad);
    }
  });

  test("the door's tab icon is the heap symbol, inline (site/favicon.svg), allowed by the CSP", async () => {
    const html = await door(401, false, { slug: SLUG }).text();
    const m = html.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)" type="image\/svg\+xml">/);
    assert.ok(m, "an inline favicon");
    assert.equal(decodeURIComponent(m[1]), readFileSync(join(ROOT, "site", "favicon.svg"), "utf8").trim());
    assert.equal(FAVICON_SVG, readFileSync(join(ROOT, "site", "favicon.svg"), "utf8").trim());
    assert.match(CSP, /img-src [^;]*data:/);
    assert.match(CSP, /font-src 'self'/);
  });

  test("the field says what it wants: a 'password' placeholder beside a lock glyph, still autofocused", async () => {
    for (const wrong of [false, true]) {
      const html = await door(401, wrong, { slug: SLUG }).text();
      const input = html.match(/<input type="password"[^>]*>/)[0];
      assert.match(input, /\splaceholder="password"/);
      assert.match(input, /\sautocomplete="current-password"/);
      assert.match(input, /\sautofocus/);
      // the lock: an aria-hidden inline svg, first in the pill, before the input
      const field = html.slice(html.indexOf('<div class="field">'), html.indexOf("</div>", html.indexOf('<div class="field">')));
      assert.match(field, /^<div class="field">\s*<svg class="lock" width="16" height="16"[^>]*aria-hidden="true">/);
      assert.ok(field.indexOf('class="lock"') < field.indexOf("<input"));
      assert.match(html, /::placeholder\{color:#[0-9A-F]{6};/i);
      assert.match(html, /caret-color:#16231F/);
    }
  });
});

describe("with secrets set", () => {
  before(() => start({ [key(SLUG)]: PASS, [key(OTHER)]: PASS, [key(WEAK)]: "x".repeat(5), ARMFUL_FILE_UPSTREAM: UPSTREAM_URL }), { timeout: 180000 });
  after(stop);

  test("home is not gated", T, async () => {
    const r = await get("/");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.match(await r.text(), /Armfuls of photos/);
  });

  test("collection page without cookie gets the door", T, async () => {
    for (const path of [`/${SLUG}/`]) {
      const r = await get(path);
      assert.equal(r.status, 401, path);
      assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
      assert.match(r.headers.get("cache-control") || "", /no-store/);
      assert.match(r.headers.get("cache-control") || "", /private/);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.match(r.headers.get("vary") || "", /Cookie/i);
      const csp = r.headers.get("content-security-policy") || "";
      for (const d of ["default-src 'none'", "img-src https://drive.google.com https://*.googleusercontent.com",
        "style-src 'unsafe-inline'", `script-src '${SCRIPT_HASH}'`, "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
        assert.ok(csp.includes(d), d);
      }
      const body = await r.text();
      assert.match(body, /<input type="password"/);
      assert.match(body, /autocomplete="current-password"/);
      assert.match(body, new RegExp(`action="/${SLUG}/__gate"`));
      assert.match(body, /drive\.google\.com\/thumbnail\?id=PLACEHOLDER_DOOR_ID&amp;sz=w1600/);
      assert.match(body, /object-position:\s*center 30%/);
      assert.match(body, /@keyframes shake/);
      assert.match(body, /prefers-reduced-motion/);
      assert.ok(!/onerror=/.test(body));
      assert.ok(body.includes(`<script>${SCRIPT}</script>`));
      assert.ok(!body.includes(PAGE_MARK));
    }
  });

  test("the door is a link preview: Open Graph tags, still 401 and noindex, nothing from data.json", T, async () => {
    const r = await get(`/${SLUG}/`, { "User-Agent": "facebookexternalhit/1.1" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
    const body = await r.text();
    assert.ok(body.includes('<meta property="og:title" content="Example Weekend on armful">'));
    assert.ok(body.includes('<meta property="og:description" content="Find your friends in the photos.">'));
    assert.ok(body.includes('<meta property="og:image" content="https://lh3.googleusercontent.com/d/PLACEHOLDER_DOOR_ID=w1200-h630-c">'));
    assert.ok(body.includes('<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'));
    assert.ok(body.includes('<meta property="og:type" content="website"><meta property="og:site_name" content="armful">'));
    assert.ok(body.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(body.includes('<meta name="twitter:description" content="Find your friends in the photos.">'));
    assert.match(body, /<meta name="robots" content="noindex/);
    // nothing from the page data: not its ids, keys, thumbnail templates or file count
    for (const x of [DATA_CANARY, '"files"', '"people"', '"thumbs"', "fx/p", "fx/f", '"built"']) assert.ok(!body.includes(x), x);
    // a collection without door.json: the slug names it, no image
    const other = await (await get(`/${OTHER}/`)).text();
    assert.ok(other.includes(`<meta property="og:title" content="${OTHER} on armful">`));
    assert.ok(!other.includes("og:image"));
  });

  test("the bare collection path redirects once to its slash, then the gate runs", T, async () => {
    for (const headers of [{}, { Cookie: cookieOf(await gate(PASS)) }]) {
      const r = await get(`/${SLUG}`, headers);
      assert.equal(r.status, 301);
      assert.equal(r.headers.get("location"), `/${SLUG}/`);
      assert.equal(r.headers.get("set-cookie"), null);
      assert.equal(await r.text(), "");
    }
    const next = await get(`/${SLUG}/`);
    assert.equal(next.status, 401);
    assert.match(await next.text(), /<input type="password"/);
  });

  test("unknown public paths are a plain 404, not the home page", T, async () => {
    for (const path of ["/foo.html", "/short/", "/static/nope.css"]) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
      const body = await r.text();
      assert.match(body, /noindex/, path);
      assert.ok(!body.includes("Armfuls of photos"), path);
    }
  });

  test("data.json, door.json and static files without cookie are the door, not the file", T, async () => {
    for (const path of [`/${SLUG}/data.json`, `/${SLUG}/door.json`, ASSET]) {
      const r = await get(path);
      assert.equal(r.status, 401, path);
      const body = await r.text();
      assert.ok(notJson(body), path);
      assert.ok(!body.includes('"files"') && !body.includes(ASSET_HEAD), path);
    }
  });

  test("forged cookies do not open the door", T, async () => {
    const wrong64 = "0123456789abcdef".repeat(4);
    for (const c of [`armful_${SLUG}=deadbeef`, `armful_${SLUG}=${wrong64}`, `armful_gate=${wrong64}`,
      `armful_${SLUG}="${wrong64}"`, `ARMFUL_${SLUG}=${wrong64}`]) {
      const r = await get(`/${SLUG}/data.json`, { Cookie: c });
      assert.equal(r.status, 401, c);
    }
  });

  test("a decoy cookie of the same name does not lock the visitor out", T, async () => {
    const c = cookieOf(await gate(PASS));
    const r = await get(`/${SLUG}/data.json`, { Cookie: `armful_${SLUG}=bad; ${c}` });
    assert.equal(r.status, 200);
  });

  test("wrong password is slow and shows the door with .wrong", T, async () => {
    const t0 = Date.now();
    const r = await gate("not the password");
    const ms = Date.now() - t0;
    assert.equal(r.status, 401);
    assert.ok(ms >= 700, `took ${ms}ms`);
    assert.equal(r.headers.get("set-cookie"), null);
    const body = await r.text();
    assert.match(body, /class="[^"]*\bwrong\b/);
    assert.match(body, /Wrong password\. Try again\./);
    assert.match(body, /aria-describedby="wrong"/);
  });

  test("right password sets the cookie; the cookie opens the page and data", T, async () => {
    const r = await gate(PASS, "#p=3");
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), `/${SLUG}/#p=3`);
    const sc = r.headers.get("set-cookie") || "";
    assert.match(sc, new RegExp(`^armful_${SLUG}=[0-9a-f]{64};`));
    assert.match(sc, new RegExp(`Path=/${SLUG}(;|$)`));
    assert.match(sc, /Max-Age=2592000/);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=Lax/);
    const c = sc.split(";")[0];

    const page = await get(`/${SLUG}/`, { Cookie: c });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(PAGE_MARK));
    assert.match(page.headers.get("x-robots-tag") || "", /noindex/);
    assert.equal(page.headers.get("cache-control"), "private, no-cache");

    const data = await get(`/${SLUG}/data.json`, { Cookie: c });
    assert.equal(data.status, 200);
    assert.equal(JSON.parse(await data.text()).files.length, 61); // the fixture: 60 files + 1 malformed
    assert.equal(data.headers.get("cache-control"), "private, no-cache");
  });

  // the door's script: the same POST with Accept: application/json, answered as data
  const gateJson = (p, to = "", accept = "application/json") => fetch(base + `/${SLUG}/__gate`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQ_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: accept },
    body: new URLSearchParams({ p, to }).toString(),
  });

  test("JSON variant, wrong password: still slow, 401 with a small JSON body, no cookie, no door", T, async () => {
    for (const accept of ["application/json", "application/json, text/plain;q=0.5"]) {
      const t0 = Date.now();
      const r = await gateJson("not the password", "#p=3", accept);
      assert.ok(Date.now() - t0 >= 700, `took ${Date.now() - t0}ms`);
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("set-cookie"), null);
      assert.match(r.headers.get("content-type") || "", /^application\/json/);
      assert.match(r.headers.get("cache-control") || "", /private, no-store/);
      assert.match(r.headers.get("vary") || "", /Cookie/);
      assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
      assert.equal(r.headers.get("location"), null);
      assert.deepEqual(JSON.parse(await r.text()), { ok: false });
    }
  });

  test("JSON variant, right password: 200 with the target and the same cookie, no redirect", T, async () => {
    const r = await gateJson(PASS, "#p=3");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("location"), null);
    assert.deepEqual(JSON.parse(await r.text()), { ok: true, to: `/${SLUG}/#p=3` });
    assert.match(r.headers.get("cache-control") || "", /private, no-store/);
    const sc = r.headers.get("set-cookie") || "";
    assert.equal(sc, (await gate(PASS)).headers.get("set-cookie"), "the same cookie as the form POST");
    assert.match(sc, /HttpOnly; Secure; SameSite=Lax/);
    assert.equal((await get(`/${SLUG}/data.json`, { Cookie: cookieOf(r) })).status, 200);
    // unsafe hashes are dropped the same way
    assert.equal(JSON.parse(await (await gateJson(PASS, "//evil.example")).text()).to, `/${SLUG}/`);
  });

  test("JSON variant keeps the limits: 413 over 4 KB, 503 without a secret, 405 on GET", T, async () => {
    const big = await fetch(base + `/${SLUG}/__gate`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQ_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ p: PASS, pad: "x".repeat(5000) }).toString() });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get("set-cookie"), null);
    const weak = await fetch(base + `/${WEAK}/__gate`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQ_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: "p=xxxxx" });
    assert.equal(weak.status, 503);
    assert.equal((await get(`/${SLUG}/__gate`, { Accept: "application/json" })).status, 405);
  });

  test("redirect hash: unsafe or over 200 chars is dropped", T, async () => {
    for (const to of ["//evil.example", "https://evil.example", "#a\r\nX-Inj: 1", "#p=" + "1".repeat(200)]) {
      const r = await gate(PASS, to);
      assert.equal(r.status, 303, to);
      assert.equal(r.headers.get("location"), `/${SLUG}/`, to);
    }
    const ok = "#p=" + "1".repeat(190);
    assert.equal((await gate(PASS, ok)).headers.get("location"), `/${SLUG}/${ok}`);
  });

  test("GET (or any non-POST) on __gate is 405, even with the cookie", T, async () => {
    const c = cookieOf(await gate(PASS));
    for (const [method, headers] of [["GET", {}], ["GET", { Cookie: c }], ["PUT", {}]]) {
      const r = await get(`/${SLUG}/__gate`, headers, method);
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get("allow"), "POST");
    }
  });

  test("login bodies over 4 KB are refused before parsing", T, async () => {
    const t0 = Date.now();
    const r = await post(SLUG, { p: PASS, to: "#", pad: "x".repeat(5000) });
    assert.equal(r.status, 413);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.ok(Date.now() - t0 < 700, "refused without the guess delay");
  });

  test("reserved and short first segments pass through", T, async () => {
    for (const path of ["/about/", "/static/x.js", "/api/collections", "/short/", "/index.html"]) {
      const r = await get(path);
      assert.ok(r.status !== 401 && r.status !== 503, `${path} -> ${r.status}`);
      assert.ok(!(await r.text()).includes('type="password"'), path);
    }
  });

  test("a collection without door.json still gets a door, on the ink ground", T, async () => {
    const r = await get(`/${OTHER}/`);
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.match(body, /<input type="password"/);
    assert.ok(!body.includes("drive.google.com/thumbnail"));
    assert.match(body, /background:#16231F/);
  });

  test("same password, two collections: one's cookie does not open the other", T, async () => {
    const c = cookieOf(await gate(PASS));
    const v = c.split("=")[1];
    const r = await get(`/${OTHER}/data.json`, { Cookie: `armful_${OTHER}=${v}` });
    assert.equal(r.status, 401);
    const own = cookieOf(await post(OTHER, { p: PASS }));
    assert.notEqual(own.split("=")[1], v);
    assert.equal((await get(`/${OTHER}/data.json`, { Cookie: own })).status, 200);
  });

  test("a secret shorter than 6 characters fails closed like a missing one", T, async () => {
    for (const r of [await get(`/${WEAK}/`), await post(WEAK, { p: "x".repeat(5) })]) {
      assert.equal(r.status, 503);
      assert.match(r.headers.get("cache-control") || "", /no-store/);
      assert.equal(r.headers.get("set-cookie"), null);
    }
  });

  test("odd path shapes: %, // and upper case are exactly 400; none ever serves the data", T, async () => {
    const exact400 = [
      `/%62nf-ytt-spain-2026/data.json`, `/${SLUG}%2Fdata.json`, `/bnf%2Dytt-spain-2026/data.json`,
      `//${SLUG}/data.json`, `/%2f${SLUG}/data.json`, `/%62nf-ytt-spain-2026/`, `/${SLUG}%2F`,
      `/${SLUG.toUpperCase()}/data.json`, `/Bnf-ytt-spain-2026/`, `/static/..%2F${SLUG}/data.json`,
      `/${SLUG}/fx/..%2Fdata.json`, `/bnf-ytt-spain-202%36/data.json`,
    ];
    for (const path of exact400) {
      const r = await raw(path);
      assert.equal(r.status, 400, path);
      assert.equal(r.headers["cache-control"], "no-store", path);
      assert.equal(r.body, "", path);
    }
    // the runtime may normalise these before the middleware: then they are gated (401)
    for (const path of [`/./${SLUG}/data.json`, `/x/../${SLUG}/data.json`, `/${SLUG}/./data.json`,
      `/${SLUG}\\data.json`, `/\\${SLUG}/data.json`]) {
      const r = await raw(path);
      assert.ok(r.status === 400 || r.status === 401, `${path} -> ${r.status}`);
      assert.ok(!r.body.includes('"files"') && notJson(r.body), path);
    }
  });

  test("HEAD and OPTIONS without a cookie do not reach the data", T, async () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const r = await raw(`/${SLUG}/data.json`, method);
      assert.notEqual(r.status, 200, method);
      assert.ok(!r.body.includes('"files"'), method);
      assert.ok(!(r.headers["content-type"] || "").includes("json"), method);
    }
  });

  test("gated responses vary on Cookie and are private, assets keep their max-age", T, async () => {
    const c = cookieOf(await gate(PASS));
    const asset = await get(ASSET, { Cookie: c });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("vary") || "", /Cookie/i);
    assert.equal(asset.headers.get("cache-control"), "private, max-age=31536000, immutable");
    for (const path of [`/${SLUG}/`, `/${SLUG}/data.json`]) {
      const r = await get(path, { Cookie: c });
      assert.match(r.headers.get("vary") || "", /Cookie/i, path);
      assert.match(r.headers.get("cache-control") || "", /private/, path);
    }
  });

  test("__file/<id> without the cookie (or with another collection's) is the door; Drive is never asked", T, async () => {
    upstreamLog.length = 0;
    const other = cookieOf(await post(OTHER, { p: PASS }));
    for (const headers of [{}, { Cookie: `armful_${SLUG}=${other.split("=")[1]}` }, { Cookie: other }]) {
      const r = await get(`/${SLUG}/__file/${VID_OK}`, headers);
      assert.equal(r.status, 401, JSON.stringify(headers));
      const body = await r.text();
      assert.match(body, /<input type="password"/);
      assert.ok(!body.includes("ftyp"));
    }
    assert.deepEqual(upstreamLog, []);
  });

  test("__file/<id> takes only a video id from this collection's data.json; no URL or host can be named", T, async () => {
    const c = cookieOf(await gate(PASS));
    upstreamLog.length = 0;
    // not in the collection, a photo (not a video), or not an id at all: 404, Drive never asked
    for (const id of ["NOTINTHECOLLECTION1", PHOTO_ID, "evil.example", "https:", "short", "x".repeat(201), `${VID_OK}/x`, ""]) {
      const r = await get(`/${SLUG}/__file/${id}`, { Cookie: c });
      assert.ok(r.status === 404 || r.status === 400, `${id} -> ${r.status}`);
      assert.equal(await r.text(), "", id);
    }
    // encoded URLs, slashes and dots are refused by shape before anything else
    for (const path of [`/${SLUG}/__file/https%3A%2F%2Fevil.example%2Fx`, `/${SLUG}/__file//evil.example/x`,
      `/${SLUG}/__file/https://evil.example/x`]) {
      const r = await raw(path, "GET", { Cookie: c });
      assert.ok([400, 404].includes(r.status), `${path} -> ${r.status}`);
      assert.ok(!r.body.includes('"files"'), path);
    }
    // another collection's video is not this one's (same password, its own cookie, its own data)
    const oc = cookieOf(await post(OTHER, { p: PASS }));
    assert.equal((await get(`/${OTHER}/__file/${VID_OK}`, { Cookie: oc })).status, 404);
    assert.deepEqual(upstreamLog, [], "Drive was never asked");
    // a query names nothing: the upstream URL is fixed, only the id goes in it, no cookie goes along
    const r = await get(`/${SLUG}/__file/${VID_OK}?url=https://evil.example/&id=${PHOTO_ID}`, { Cookie: c });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    assert.deepEqual(upstreamLog, [{ url: `/download?id=${VID_OK}&export=download&confirm=t`, range: null, cookie: null }]);
    // only GET and HEAD
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await get(`/${SLUG}/__file/${VID_OK}`, { Cookie: c }, method)).status, 405, method);
  });

  test("__file/<id> streams the video through (first bytes before Drive has finished), typed and named, private", T, async () => {
    const c = cookieOf(await gate(PASS));
    const t0 = Date.now();
    const r = await get(`/${SLUG}/__file/${VID_OK}`, { Cookie: c });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "video/quicktime");
    assert.equal(r.headers.get("content-disposition"), `attachment; filename="${SLUG}-0023.mov"`);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
    assert.equal(r.headers.get("set-cookie"), null);
    const rd = r.body.getReader(), parts = [];
    const first = await rd.read();
    const tFirst = Date.now() - t0;
    parts.push(first.value);
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); }
    const tAll = Date.now() - t0;
    assert.ok(tFirst < 1200 && tAll >= 1400, `streamed, not buffered: first bytes at ${tFirst}ms, the end at ${tAll}ms`);
    assert.ok(Buffer.concat(parts).equals(Buffer.concat([HEAD, TAIL])), "the bytes, unchanged");
    // a Drive error page or failure is a 502, never passed on
    for (const id of [VID_HTML, DATA_CANARY]) {
      const e = await get(`/${SLUG}/__file/${id}`, { Cookie: c });
      assert.equal(e.status, 502, id);
      assert.equal(await e.text(), "", id);
    }
  });

  test("the gated page carries the page CSP; data, assets, door and home do not", T, async () => {
    const c = cookieOf(await gate(PASS));
    const page = await get(`/${SLUG}/`, { Cookie: c });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-security-policy"), PAGE_CSP);
    for (const d of ["default-src 'self'", "script-src 'self'", "frame-src https://drive.google.com",
      "img-src 'self' https://drive.google.com https://*.googleusercontent.com data:", "base-uri 'none'", "frame-ancestors 'none'",
      "connect-src 'self' https://lh3.googleusercontent.com;"]) {
      assert.ok(PAGE_CSP.includes(d), d);
    }
    for (const path of [`/${SLUG}/data.json`, ASSET]) assert.equal((await get(path, { Cookie: c })).headers.get("content-security-policy"), null, path);
    assert.match((await get(`/${SLUG}/`)).headers.get("content-security-policy") || "", /default-src 'none'/); // the door's own
    assert.notEqual((await get("/")).headers.get("content-security-policy"), PAGE_CSP);
  });
});

describe("no secret configured", () => {
  before(() => start({}), { timeout: 180000 });
  after(stop);

  test("the collection fails closed with 503; home still serves", T, async () => {
    for (const path of [`/${SLUG}/`, `/${SLUG}/data.json`]) {
      const r = await get(path);
      assert.equal(r.status, 503, path);
      assert.match(r.headers.get("cache-control") || "", /no-store/);
      assert.match(r.headers.get("cache-control") || "", /private/);
      assert.equal((await r.text()).trim(), "Not configured.");
    }
    const g = await gate(PASS);
    assert.equal(g.status, 503);
    assert.equal(g.headers.get("set-cookie"), null);
    assert.equal((await get("/")).status, 200);
  });
});
