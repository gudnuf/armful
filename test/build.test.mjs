// Build test: bin/build-dist.mjs turns site/ + home/ + a collection's built data.json
// into the deployable dist/ tree. Everything happens in temp workspaces (copies of
// site/ and home/, the synthetic fixture, the example collection): nothing in the
// checkout is written. No Chrome.
//   node --test test/build.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, cpSync, symlinkSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "bin", "build-dist.mjs");
const H = "[0-9a-f]{10}";
const FONTS = ["bricolage-grotesque-700", "inter-400", "inter-500", "inter-600"];
const temps = [];
let WS, OUT; // the main workspace, built once with canaries in place

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const walk = (dir, base = dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split("\\").join("/")];
});
const manifest = (out) => Object.fromEntries(walk(out).sort().map((f) => [f, sha(readFileSync(join(out, f)))]));
const unsafe = (url) => /[%\\]/.test(url) || url.includes("//") ||
  url.split("/").some((s) => s === "." || s === "..") || /[A-Z]/.test(url.split("/").filter(Boolean)[0] ?? "");

function workspace() {
  const ws = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-build-"));
  temps.push(ws);
  cpSync(join(ROOT, "site"), join(ws, "site"), { recursive: true });
  cpSync(join(ROOT, "home"), join(ws, "home"), { recursive: true });
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), join(ws, "fixture")], { stdio: "ignore" });
  const col = join(ws, "collections", "example");
  mkdirSync(join(col, "dist"), { recursive: true });
  cpSync(join(ROOT, "collections", "example", "collection.json"), join(col, "collection.json"));
  cpSync(join(ws, "fixture", "data.json"), join(col, "dist", "data.json"));
  return ws;
}
const build = (ws, over = {}) => {
  const o = { site: join(ws, "site"), home: join(ws, "home"), collection: join(ws, "collections", "example"), out: join(ws, "dist"), ...over };
  const args = [BUILD, "--site", o.site, "--home", o.home, "--collection", o.collection, "--out", o.out];
  return spawnSync(process.execPath, args, { cwd: ws, encoding: "utf8" });
};
const ok = (r) => assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
const refused = (r, re) => { assert.equal(r.status, 1, `expected a refusal:\n${r.stdout}\n${r.stderr}`); if (re) assert.match(r.stderr, re); };
const read = (p) => readFileSync(join(OUT, p), "utf8");

before(() => {
  WS = workspace();
  OUT = join(WS, "dist");
  // canaries: none of these may ship, anywhere
  writeFileSync(join(WS, "site", "fonts", "hidden.json"), "[1,2,3]");
  mkdirSync(join(WS, "site", "state"));
  writeFileSync(join(WS, "site", "state", "local.env"), "SCAN_ROOT=/nowhere");
  writeFileSync(join(WS, "site", "x.jpg"), "not really a photo");
  writeFileSync(join(WS, "site", "notes.txt"), "scratch");
  mkdirSync(OUT);
  writeFileSync(join(OUT, "stale.txt"), "left over from an old build");
  ok(build(WS));
});
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

test("the complete dist file list: an explicit manifest, canaries never ship", () => {
  const want = [
    /^_headers$/, /^_redirects$/, /^index\.html$/, /^404\.html$/,
    /^robots\.txt$/, /^sitemap\.xml$/, /^apple-touch-icon\.png$/, new RegExp(`^static/og\\.${H}\\.png$`), new RegExp(`^static/favicon\\.${H}\\.svg$`),
    new RegExp(`^static/style\\.${H}\\.css$`), new RegExp(`^static/home\\.${H}\\.css$`), /^static\/fonts\/OFL\.txt$/,
    ...FONTS.map((f) => new RegExp(`^static/fonts/${f}\\.${H}\\.woff2$`)),
    /^example\/index\.html$/, new RegExp(`^example/app\\.${H}\\.js$`), new RegExp(`^example/style\\.${H}\\.css$`),
    /^example\/data\.json$/, /^example\/door\.json$/, /^example\/fonts\/OFL\.txt$/,
    ...["favicon", "icon", "mark", "symbol"].map((n) => new RegExp(`^example/${n}\\.svg$`)),
    ...FONTS.map((f) => new RegExp(`^example/fonts/${f}\\.${H}\\.woff2$`)),
  ];
  const files = walk(OUT).sort();
  assert.equal(files.length, want.length, files.join("\n"));
  for (const re of want) assert.equal(files.filter((f) => re.test(f)).length, 1, `${re} in\n${files.join("\n")}`);
  for (const f of files) assert.doesNotMatch(f, /hidden|local\.env|x\.jpg|notes|state|stale|README|collection\.json/, f);
});

test("fingerprints: names carry the content hash, the stylesheet names the hashed fonts", () => {
  const files = walk(OUT);
  for (const f of files.filter((f) => new RegExp(`\\.${H}\\.[a-z0-9]+$`).test(f)))
    assert.equal(f.split(".").at(-2), sha(readFileSync(join(OUT, f))).slice(0, 10), f);
  for (const prefix of ["static", "example"]) {
    const css = read(files.find((f) => new RegExp(`^${prefix}/style\\.`).test(f)));
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    assert.equal(urls.length, FONTS.length);
    for (const u of urls) {
      assert.match(u, new RegExp(`^fonts/[a-z0-9-]+\\.${H}\\.woff2$`));
      assert.ok(files.includes(`${prefix}/${u}`), u);
    }
    // fonts are byte-identical to the sources
    for (const f of FONTS) {
      const out = files.find((x) => new RegExp(`^${prefix}/fonts/${f}\\.`).test(x));
      assert.ok(readFileSync(join(OUT, out)).equals(readFileSync(join(ROOT, "site", "fonts", `${f}.woff2`))), out);
    }
  }
  assert.ok(readFileSync(join(OUT, "example", "data.json")).equals(readFileSync(join(WS, "fixture", "data.json"))));
  const dj = JSON.parse(read("example/door.json"));
  assert.deepEqual(Object.keys(dj).sort(), ["dates", "fonts", "name", "photo", "position", "title"]);
  assert.deepEqual({ ...dj, fonts: undefined }, { title: "example", photo: "DRIVE_FILE_ID", position: "center 30%",
    name: "Example Weekend", dates: "1 – 3 May 2026", fonts: undefined });
  // the door's faces: public, hashed, shipped, and the very bytes of site/fonts
  assert.deepEqual(Object.keys(dj.fonts).sort(), ["display", "label", "text"]);
  for (const [k, f] of [["display", "bricolage-grotesque-700"], ["label", "inter-600"], ["text", "inter-500"]]) {
    assert.match(dj.fonts[k], new RegExp(`^/static/fonts/${f}\\.${H}\\.woff2$`), k);
    assert.ok(readFileSync(join(OUT, dj.fonts[k].slice(1))).equals(readFileSync(join(ROOT, "site", "fonts", `${f}.woff2`))), k);
  }
});

test("the collection page references only hashed or shipped files", () => {
  const html = read("example/index.html");
  const files = walk(OUT);
  const js = files.find((f) => /^example\/app\./.test(f)).slice(8);
  const css = files.find((f) => /^example\/style\./.test(f)).slice(8);
  assert.match(html, new RegExp(`src="${js}"`));
  assert.match(html, new RegExp(`href="${css}"`));
  assert.doesNotMatch(html, /(^|[^\w.-])(app\.js|style\.css)/);
});

test("reference rewriting: whole attribute values, any quoting, query and fragment kept", () => {
  const ws = workspace();
  const p = join(ws, "site", "index.html");
  const src = readFileSync(p, "utf8").replace("</body>",
    `<script src='./app.js?v=1#x'></script><link rel=stylesheet href=style.css><img data-src="x.png" alt=""></body>`);
  writeFileSync(p, src);
  ok(build(ws));
  const out = readFileSync(join(ws, "dist", "example", "index.html"), "utf8");
  const js = walk(join(ws, "dist")).find((f) => /^example\/app\./.test(f)).slice(8);
  assert.equal(out.split(`src="${js}"`).length - 1, 1);
  assert.match(out, new RegExp(`src="${js}\\?v=1#x"`));
  assert.match(out, /href="style\.[0-9a-f]{10}\.css"><img/);
  assert.match(out, /data-src="x\.png"/); // unrelated attribute left alone
  assert.doesNotMatch(out, /(^|[^\w.-])(app\.js|style\.css)/);

  // an unhashed name the build cannot rewrite, or a local file it does not ship, stops it
  for (const extra of [`<img data-src="app.js">`, `<link href="secret.txt">`, `<script src="./other.js"></script>`]) {
    writeFileSync(p, src.replace("</body>", extra + "</body>"));
    refused(build(ws), /still names app\.js|not something the build ships/);
  }
});

test("the home page", () => {
  const html = read("index.html");
  assert.match(html, /<title>armful — armfuls of photos, finally findable<\/title>/);
  assert.match(html, /Armfuls of photos, finally findable\./);
  assert.ok(html.includes("Everyone's photos from the trip, the training, the weekend, in one place, searchable by who's in them. Open source."));
  assert.match(html, /<a class="lbl" href="https:\/\/github\.com\/gudnuf\/armful">GitHub<\/a>/);
  assert.doesNotMatch(html, /noindex/i);
  assert.match(html, /<svg[^>]*class="mark"[^>]*role="img"[^>]*aria-label="armful"/);
  assert.doesNotMatch(html, /<!-- mark -->|example/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  const refs = [...html.matchAll(/\s(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https:/.test(u));
  assert.ok(refs.length >= 2);
  for (const u of refs) assert.match(u, /^(\/static\/|\/apple-touch-icon\.png$)/, u);
});

test("the home and 404 pages name a hashed favicon; their font preloads name the hashed fonts", () => {
  for (const page of ["index.html", "404.html"]) {
    const m = read(page).match(new RegExp(`<link rel="icon" href="/static/(favicon\\.${H}\\.svg)" type="image/svg\\+xml">`));
    assert.ok(m, `${page}: a favicon link`);
    assert.ok(readFileSync(join(OUT, "static", m[1])).equals(readFileSync(join(ROOT, "site", "favicon.svg"))), `${page}: ${m[1]} is site/favicon.svg`);
    assert.doesNotMatch(read(page), /favicon\.svg"/);
  }
  for (const [page, prefix] of [["index.html", "/static/"], ["example/index.html", ""]]) {
    const pre = [...read(page).matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((x) => x[1]);
    assert.ok(pre.length >= 2, `${page}: font preloads`);
    for (const u of pre) {
      assert.match(u, new RegExp(`^${prefix.replace(/\//g, "\\/")}fonts/[a-z0-9-]+\\.${H}\\.woff2$`), u);
      assert.ok(existsSync(join(OUT, prefix ? u.slice(1) : join("example", u))), `${page}: ${u} is shipped`);
    }
  }
});

test("the home page and its files make no third-party request: GitHub is the only external link", () => {
  const ext = (text) => [...text.replace(/\sxmlns(:\w+)?="[^"]*"/g, "").matchAll(/(?:https?:)?\/\/[^\s"')<>]+/g)].map((m) => m[0]);
  // besides its own absolute URLs (canonical, og, JSON-LD) and schema.org / the licence in the JSON-LD,
  // the page names GitHub, and the Drive thumbnail the Recent row asks for only when this browser has recents
  const own = /^https:\/\/armful\.photos\//;
  const allowed = new Set(["https://github.com/gudnuf/armful", "https://schema.org", "https://opensource.org/licenses/MIT",
    "https://drive.google.com/thumbnail?id="]);
  for (const u of ext(read("index.html"))) assert.ok(own.test(u) || allowed.has(u), u);
  // nothing is fetched from a third party on load: no external src, stylesheet, preconnect or preload
  const html = read("index.html");
  for (const [tag] of html.matchAll(/<(?:link|script|img|iframe|source|video|audio)\b[^>]*>/g)) {
    if (/rel="canonical"/.test(tag)) continue; // a name for the page, never fetched
    assert.doesNotMatch(tag, /\s(?:src|href)="(?:https?:)?\/\//, tag);
  }
  for (const f of ["404.html", ...walk(OUT).filter((f) => /^static\/.*\.(css|svg)$/.test(f))]) assert.deepEqual(ext(read(f)), [], f);
});

test("the home page head: description, canonical, Open Graph, Twitter, icons, JSON-LD", () => {
  const html = read("index.html");
  const head = html.slice(0, html.indexOf("</head>"));
  const meta = (attr, key) => {
    const all = [...head.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)">`, "g"))];
    assert.equal(all.length, 1, `${attr}=${key} once`);
    return all[0][1];
  };
  const desc = meta("name", "description");
  assert.equal(desc, "Everyone's photos from the trip, the training, the weekend, in one place, searchable by who's in them. Open source.");
  assert.ok(desc.length <= 155, `description ${desc.length} chars`);
  assert.match(head, /<link rel="canonical" href="https:\/\/armful\.photos\/">/);
  assert.equal(meta("property", "og:type"), "website");
  assert.equal(meta("property", "og:site_name"), "armful");
  assert.equal(meta("property", "og:title"), "armful");
  const ogDesc = "Armfuls of photos, finally findable. Find your friends in the group's photos. Open source.";
  assert.equal(meta("property", "og:description"), ogDesc);
  assert.equal(meta("property", "og:url"), "https://armful.photos/");
  const img = meta("property", "og:image");
  assert.match(img, new RegExp(`^https://armful\\.photos/static/og\\.${H}\\.png$`), "absolute, hashed");
  assert.ok(existsSync(join(OUT, img.replace("https://armful.photos/", ""))), `${img} is shipped`);
  assert.equal(meta("property", "og:image:width"), "1200");
  assert.equal(meta("property", "og:image:height"), "630");
  assert.ok(meta("property", "og:image:alt").length > 10);
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  assert.equal(meta("name", "twitter:title"), "armful");
  assert.equal(meta("name", "twitter:description"), ogDesc);
  assert.equal(meta("name", "twitter:image"), img);
  assert.doesNotMatch(html, /static\/og\.png/);
  const themes = [...head.matchAll(/<meta name="theme-color" content="(#[0-9A-F]{6})" media="\(prefers-color-scheme: (light|dark)\)">/g)].map((m) => m[2] + m[1]);
  assert.deepEqual(themes.sort(), ["dark#0D0F0E", "light#FBFAF7"]);
  assert.match(head, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  const ld = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(ld.length, 1);
  const j = JSON.parse(ld[0][1]);
  assert.equal(j["@context"], "https://schema.org");
  assert.equal(j["@type"], "WebApplication");
  assert.equal(j.name, "armful");
  assert.equal(j.url, "https://armful.photos/");
  assert.equal(j.description, desc);
  assert.equal(j.applicationCategory, "PhotographyApplication");
  assert.equal(j.operatingSystem, "Web");
  assert.equal(j.isAccessibleForFree, true);
  assert.match(j.license, /MIT/);
  assert.deepEqual(j.sameAs, ["https://github.com/gudnuf/armful"]);
  assert.doesNotMatch(html, /noindex/i);
});

test("og card and touch icon: real PNGs of the right size, copied byte for byte, og hashed", () => {
  const files = walk(OUT);
  const og = files.find((f) => /^static\/og\./.test(f));
  const size = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  for (const [out, src, wh] of [[og, "og.png", [1200, 630]], ["apple-touch-icon.png", "apple-touch-icon.png", [180, 180]]]) {
    const buf = readFileSync(join(OUT, out));
    assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), out);
    assert.deepEqual(size(buf), wh, out);
    assert.ok(buf.equals(readFileSync(join(ROOT, "home", "og", src))), out);
  }
  assert.ok(statSync(join(OUT, og)).size < 150 * 1024, "og under 150 KB");
  // only the home page names them; a wrong-sized or fake card stops the build
  const ws = workspace();
  writeFileSync(join(ws, "home", "og", "og.png"), "not a png");
  refused(build(ws), /og\.png is not a png/);
  cpSync(join(ROOT, "home", "og", "apple-touch-icon.png"), join(ws, "home", "og", "og.png"));
  refused(build(ws), /og\.png must be 1200x630/);
});

test("robots.txt and sitemap.xml: everything allowed, only the home page listed", () => {
  const robots = read("robots.txt");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.doesNotMatch(robots, /^Disallow:/m);
  assert.match(robots, /^Sitemap: https:\/\/armful\.photos\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /example/);
  const sm = read("sitemap.xml");
  assert.match(sm, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sm, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.deepEqual([...sm.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]), ["https://armful.photos/"]);
  assert.doesNotMatch(sm, /example/);
});

test("the 404 page: wordmark only, not indexed", () => {
  const html = read("404.html");
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.match(html, /<svg[^>]*class="mark"/);
  assert.doesNotMatch(html, /Armfuls of photos|github/i);
  for (const m of html.matchAll(/\s(?:src|href)="([^"#]+)"/g)) assert.match(m[1], /^(\/static\/|\/$)/, m[1]);
});

test("_headers: immutable fingerprinted files, private revalidated data, no robots tag on the home page", () => {
  const h = read("_headers");
  const rule = (path) => {
    const m = h.match(new RegExp(`^${path.replace(/[*.]/g, "\\$&")}\\n((?:[ \\t]+.*\\n?)+)`, "m"));
    assert.ok(m, `rule ${path}`);
    return m[1];
  };
  const IMM = /Cache-Control: public, max-age=31536000, immutable/;
  for (const p of ["/:dir/*.js", "/:dir/*.css", "/:dir/fonts/*", "/static/*.png"]) assert.match(rule(p), IMM, p);
  assert.match(rule("/:dir/data.json"), /^\s+Cache-Control: private, no-cache$/m);
  const all = rule("/*");
  for (const x of [/Referrer-Policy: no-referrer/, /X-Content-Type-Options: nosniff/, /X-Frame-Options: DENY/]) assert.match(all, x);
  assert.doesNotMatch(all, /X-Robots-Tag/);
  assert.match(rule("https://armful.pages.dev/*"), /X-Robots-Tag: noindex/);
  assert.match(rule("https://:sub.armful.pages.dev/*"), /X-Robots-Tag: noindex/);
  for (const line of h.split("\n").filter((l) => /^(\/|https:)/.test(l))) assert.ok((line.match(/\*/g) || []).length <= 1, line);
});

test("_redirects: no rules (the bare collection path is redirected by the middleware)", () => {
  for (const line of read("_redirects").split("\n")) assert.ok(line === "" || line.startsWith("#"), line);
});

test("every file and every local reference is a URL the gate accepts", () => {
  const files = walk(OUT);
  for (const f of files) {
    assert.equal(unsafe("/" + f), false, `unsafe path: /${f}`);
    assert.match(f, /^[a-z0-9_][a-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, f);
  }
  for (const f of files.filter((f) => /\.(html|css)$/.test(f))) {
    const refs = [...read(f).matchAll(/\s(?:src|href)="([^"#]+)"|url\(([^)]+)\)/g)].map((m) => (m[1] || m[2]).replace(/^["']|["']$/g, ""))
      .filter((u) => !/^(https?:|data:|mailto:)/.test(u)).map((u) => u.replace(/[?#].*$/, ""));
    for (const u of refs) {
      const abs = u.startsWith("/") ? u : posix.join("/", posix.dirname(f), u);
      assert.equal(unsafe(abs), false, `${f}: unsafe ref ${u}`);
      assert.ok(existsSync(join(OUT, abs.slice(1))), `${f}: ${u} -> ${abs} missing`);
    }
  }
});

test("wipes dist/ before building", () => {
  assert.equal(existsSync(join(OUT, "stale.txt")), false);
});

test("reproducible; a changed input gets a new name and the old one is gone", () => {
  const ws = workspace();
  ok(build(ws));
  const a = manifest(join(ws, "dist"));
  ok(build(ws));
  assert.deepEqual(manifest(join(ws, "dist")), a);
  // same inputs as the main workspace (canaries aside): same output
  assert.deepEqual(a, manifest(OUT));

  const appOld = Object.keys(a).find((f) => /^example\/app\./.test(f));
  writeFileSync(join(ws, "site", "app.js"), readFileSync(join(ws, "site", "app.js"), "utf8") + "\n// changed\n");
  const fontPath = join(ws, "site", "fonts", "inter-400.woff2");
  writeFileSync(fontPath, Buffer.concat([readFileSync(fontPath), Buffer.from([0])]));
  ok(build(ws));
  const b = manifest(join(ws, "dist"));
  assert.ok(!(appOld in b), "old app.js gone");
  const appNew = Object.keys(b).find((f) => /^example\/app\./.test(f));
  assert.notEqual(appNew, appOld);
  for (const prefix of ["static", "example"]) {
    const font = (m) => Object.keys(m).find((f) => f.startsWith(`${prefix}/fonts/inter-400.`));
    const style = (m) => Object.keys(m).find((f) => f.startsWith(`${prefix}/style.`));
    assert.notEqual(font(b), font(a), `${prefix} font renamed`);
    assert.notEqual(style(b), style(a), `${prefix} stylesheet renamed with it`);
    assert.ok(!(font(a) in b) && !(style(a) in b));
  }
  assert.match(readFileSync(join(ws, "dist", "index.html"), "utf8"), new RegExp(Object.keys(b).find((f) => /^static\/style\./.test(f)).replace(/\./g, "\\.")));
});

test("door.json takes the collection's title when it has one", () => {
  const ws = workspace();
  const cfgPath = join(ws, "collections", "example", "collection.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, title: "Example Weekend" }));
  ok(build(ws));
  assert.equal(JSON.parse(readFileSync(join(ws, "dist", "example", "door.json"), "utf8")).title, "Example Weekend");
});

test("door.json: name and dates only when given; anything but short plain text refuses the build", () => {
  const ws = workspace();
  const cfgPath = join(ws, "collections", "example", "collection.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const { name, dates, ...bare } = cfg;
  writeFileSync(cfgPath, JSON.stringify(bare));
  ok(build(ws));
  const dj = JSON.parse(readFileSync(join(ws, "dist", "example", "door.json"), "utf8"));
  assert.equal("name" in dj || "dates" in dj, false);
  for (const bad of [{ name: "x".repeat(61) }, { dates: "x".repeat(41) }, { name: "two\nlines" }, { name: 42 }, { dates: "" }]) {
    writeFileSync(cfgPath, JSON.stringify({ ...bare, ...bad }));
    refused(build(ws), /collection\.json: (name|dates) must be/);
  }
});

test("refuses to run without the collection's built data.json, and touches nothing", () => {
  const ws = workspace();
  rmSync(join(ws, "collections", "example", "dist"), { recursive: true });
  mkdirSync(join(ws, "dist"));
  writeFileSync(join(ws, "dist", "keep.txt"), "x");
  refused(build(ws), /data\.json/);
  assert.ok(existsSync(join(ws, "dist", "keep.txt")), "out dir left alone");
});

test("refuses an --out that is not named dist or overlaps an input; the inputs survive", () => {
  const ws = workspace();
  const data = join(ws, "collections", "example", "dist", "data.json");
  const bytes = readFileSync(data);
  const siteBytes = manifest(join(ws, "site"));
  symlinkSync(join(ws, "collections"), join(ws, "cols-link"));
  symlinkSync(join(ws, "site"), join(ws, "site-link"));
  for (const out of [ws, join(ws, "collections", "example", "dist"), join(ws, "cols-link", "example", "dist"),
    join(ws, "site", "dist"), join(ws, "site-link", "dist"), join(ws, "home", "dist")]) {
    refused(build(ws, { out }), /--out/);
  }
  assert.ok(readFileSync(data).equals(bytes), "data.json survives");
  assert.deepEqual(manifest(join(ws, "site")), siteBytes, "site/ survives");
});

test("refuses symlinked inputs", () => {
  for (const make of [
    (ws) => { unlinkSync(join(ws, "site", "mark.svg")); symlinkSync(join(ws, "home", "home.css"), join(ws, "site", "mark.svg")); },
    (ws) => { const f = join(ws, "site", "fonts"); cpSync(f, join(ws, "fonts-real"), { recursive: true }); rmSync(f, { recursive: true }); symlinkSync(join(ws, "fonts-real"), f); },
    (ws) => { const d = join(ws, "collections", "example", "dist", "data.json"); cpSync(d, join(ws, "d.json")); unlinkSync(d); symlinkSync(join(ws, "d.json"), d); },
  ]) {
    const ws = workspace();
    make(ws);
    refused(build(ws), /symlink/);
  }
});

test("refuses file names that would need URL encoding, and fonts that are not woff2", () => {
  const ws = workspace();
  const css = join(ws, "site", "style.css");
  const src = readFileSync(css, "utf8");
  cpSync(join(ws, "site", "fonts", "inter-400.woff2"), join(ws, "site", "fonts", "inter 400.woff2"));
  writeFileSync(css, src.replace("url(fonts/inter-400.woff2)", 'url("fonts/inter 400.woff2")'));
  refused(build(ws), /URL encoding/);
  writeFileSync(join(ws, "site", "fonts", "fake.woff2"), "not a font");
  writeFileSync(css, src.replace("url(fonts/inter-400.woff2)", "url(fonts/fake.woff2)"));
  refused(build(ws), /not a woff2/);
  writeFileSync(css, src.replace("url(fonts/inter-400.woff2)", "url(https://fonts.example/x.woff2)"));
  refused(build(ws), /url\(/);
});
