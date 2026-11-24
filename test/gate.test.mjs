// Gate test: functions/_middleware.js under `wrangler pages dev`, on a real dist/
// built by bin/build-dist.mjs in a temp dir from the synthetic fixture. Gates only collection
// prefixes, fails closed (503 with no or a weak secret, 401 with no cookie, 400
// for any odd path shape), never serves data.json without the cookie.
// No real data: the door photo id is a placeholder.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { door, SCRIPT, SCRIPT_HASH } from "../functions/_door.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = "wrangler@4.167.0"; // pinned: same version every run, cached after the first
const SLUG = "bnf-ytt-spain-2026";
const OTHER = "other-coll"; // a second collection: the SAME password, no door.json
const WEAK = "weak-coll"; // a third collection whose secret is too short
const key = (slug) => "COLLECTION_" + "PASSWORD_" + slug.toUpperCase().replace(/-/g, "_");
const PASS = ["correct", "horse", "battery", "staple"].join(" ");
const PAGE_MARK = '<script src="app.'; // only the real collection page has it, never the door
const DATA_CANARY = "DATACANARYFILEID0123"; // a file id only data.json carries: never on the door
const TITLE = "Example Weekend";
let ASSET, ASSET_HEAD; // the collection's fingerprinted app.js, and its first bytes
const T = { timeout: 60000 }; // per test
const REQ_MS = 15000; // per request

let WORK; // temp project dir: functions -> repo functions, dist/, .dev.vars
let server = null;

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

function killNow() { // sync, for process exit
  if (!server) return;
  try { process.kill(-server.proc.pid, "SIGKILL"); } catch {}
  try { server.proc.kill("SIGKILL"); } catch {}
}
process.on("exit", killNow);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killNow(); process.exit(1); });

// kill the whole wrangler process group and wait until it has exited
async function stop() {
  if (!server) return;
  const { proc } = server;
  const gone = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
  killNow();
  server = null;
  await gone;
  // workerd children are in the same group; give the kernel a beat to reap them
  for (let i = 0; i < 20; i++) {
    try { process.kill(-proc.pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// start wrangler with these secrets ({} = none configured)
async function start(secrets) {
  await stop();
  rmSync(join(WORK, ".dev.vars"), { force: true });
  // values reach wrangler only through this temp file, never a tracked file
  const lines = Object.entries(secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  if (lines.length) writeFileSync(join(WORK, ".dev.vars"), lines.join("\n") + "\n");
  const port = await freePort();
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("COLLECTION_" + "PASSWORD_")) delete env[k];
  const proc = spawn("npx", ["--yes", WRANGLER, "pages", "dev", "dist", "--port", String(port), "--ip", "127.0.0.1",
    "--compatibility-date=2026-01-01", "--show-interactive-dev-session=false"],
    { cwd: WORK, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  server = { proc, base: `http://127.0.0.1:${port}` };
  let log = "";
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("wrangler did not start:\n" + log)), 150000);
    const on = (d) => {
      log += d;
      if (/Ready on http:\/\/127\.0\.0\.1:\d+/.test(log)) { clearTimeout(timer); res(); }
    };
    proc.stdout.on("data", on);
    proc.stderr.on("data", on);
    proc.once("exit", () => { clearTimeout(timer); rej(new Error("wrangler exited:\n" + log)); });
  });
}

const get = (path, headers = {}, method = "GET") =>
  fetch(server.base + path, { method, redirect: "manual", headers, signal: AbortSignal.timeout(REQ_MS) });
// raw HTTP, so the path reaches the server byte for byte (fetch would normalise it)
const raw = (path, method = "GET", headers = {}, body = null) => new Promise((res, rej) => {
  const u = new URL(server.base);
  const req = httpRequest({ host: u.hostname, port: u.port, path, method, headers, timeout: REQ_MS }, (r) => {
    let b = ""; r.setEncoding("utf8"); r.on("data", (d) => { b += d; });
    r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: b }));
  });
  req.on("timeout", () => req.destroy(new Error(`timeout: ${method} ${path}`)));
  req.on("error", rej);
  req.end(body);
});
const post = (slug, fields) => fetch(server.base + `/${slug}/__gate`, {
  method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQ_MS),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const gate = (p, to = "") => post(SLUG, { p, to });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
const notJson = (body) => { try { JSON.parse(body); return false; } catch { return true; } };

before(() => {
  WORK = mkdtempSync(join(tmpdir(), "armful-gate-"));
  symlinkSync(join(ROOT, "functions"), join(WORK, "functions"));
  const fx = join(WORK, "fixture");
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), fx]);
  const cols = [[SLUG, { title: TITLE, door_photo: "PLACEHOLDER_DOOR_ID", door_position: "center 30%" }], [OTHER, {}], [WEAK, {}]];
  const args = [join(ROOT, "bin", "build-dist.mjs"), "--out", join(WORK, "dist")];
  for (const [slug, extra] of cols) {
    const col = join(WORK, "collections", slug);
    mkdirSync(join(col, "dist"), { recursive: true });
    writeFileSync(join(col, "collection.json"), JSON.stringify({ slug, ...extra }));
    const data = JSON.parse(readFileSync(join(fx, "data.json"), "utf8"));
    if (slug === SLUG) data.files[0].i = DATA_CANARY;
    writeFileSync(join(col, "dist", "data.json"), JSON.stringify(data));
    args.push("--collection", col);
  }
  execFileSync(process.execPath, args, { cwd: WORK, stdio: "ignore" });
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
});

describe("with secrets set", () => {
  before(() => start({ [key(SLUG)]: PASS, [key(OTHER)]: PASS, [key(WEAK)]: "x".repeat(15) }), { timeout: 180000 });
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
    assert.equal(JSON.parse(await data.text()).files.length, 60);
    assert.equal(data.headers.get("cache-control"), "private, no-cache");
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

  test("a secret shorter than 16 characters fails closed like a missing one", T, async () => {
    for (const r of [await get(`/${WEAK}/`), await post(WEAK, { p: "x".repeat(15) })]) {
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
