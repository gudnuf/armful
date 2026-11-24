#!/usr/bin/env node
// build-dist: assemble the deployable tree that wrangler uploads (Cloudflare Pages).
//
//   node bin/build-dist.mjs --collection collections/<slug> [--collection ...] [--out dist]
//                           [--site site] [--home home]
//
// Needs each collection's page data first: python -I pipeline/gallery/build_site.py
// --collection collections/<slug> writes collections/<slug>/dist/data.json. Without it
// this refuses to run. Every input is checked before --out (default dist/, git-ignored)
// is wiped and rewritten. What ships is an explicit manifest, never a folder copy:
//
//   index.html, 404.html       the home page and the not-found page (home/), public
//   robots.txt, sitemap.xml    generated here: allow everything, list only the home page
//   apple-touch-icon.png       home/og/apple-touch-icon.png (iOS asks for this path)
//   static/                    style.<h>.css (site tokens), home.<h>.css, fonts/<name>.<h>.woff2, fonts/OFL.txt,
//                              og.<h>.png (home/og/og.png, the link-preview card; the home page's
//                              og:image / twitter:image name it by absolute URL)
//                              ("static" is a reserved first segment, so the gate passes it)
//   <slug>/                    index.html, app.<h>.js, style.<h>.css, the named SVGs, fonts/ as above,
//                              data.json (the collection build output), door.json (from collection.json)
//   _headers, _redirects       from site/, at the root only
//
// Fonts are exactly the url()s style.css names (each must be a real woff2); their
// URLs are fingerprinted in the stylesheet before it is hashed itself. <h> = first 10
// hex of the file's sha256. Inputs must be regular files inside their roots (no
// symlinks anywhere on the way). Every emitted path is URL-safe and one the gate
// accepts; every local reference in the emitted HTML resolves to an emitted file.
// Node only, no dependencies.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESERVED = new Set(["app", "api", "a", "c", "about", "login", "new", "open", "static", "_"]);
const SVGS = ["favicon.svg", "icon.svg", "mark.svg", "symbol.svg"]; // shipped with a collection if present
const FONT_LICENCE = "OFL.txt";
const WOFF2_MAGIC = Buffer.from("wOF2");
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/; // every emitted path segment: no encoding ever needed
const ORIGIN = "https://armful.photos";
const OG_URL = `${ORIGIN}/static/og.png`; // as written in home/index.html; the build hashes it
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class BuildError extends Error {}
const fail = (msg) => { throw new BuildError(msg); };
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);
const hashed = (name, buf) => name.replace(/(\.[a-z0-9]+)$/i, `.${hash(buf)}$1`);

function args(argv) {
  const o = { cols: [], out: join(ROOT, "dist"), site: join(ROOT, "site"), home: join(ROOT, "home") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${a}: missing value\nusage: node bin/build-dist.mjs --collection collections/<slug> [--out dist]`);
    if (a === "--collection") o.cols.push(resolve(v));
    else if (a === "--out") o.out = resolve(v);
    else if (a === "--site") o.site = resolve(v);
    else if (a === "--home") o.home = resolve(v);
    else fail(`unknown argument: ${a}`);
    i++;
  }
  if (!o.cols.length) fail("give at least one --collection collections/<slug>");
  return o;
}

// root/rel must be a regular file, with no symlink on the way from root; returns its bytes
function input(root, rel) {
  let p = root;
  for (const seg of rel.split("/")) {
    if (!seg || seg === "." || seg === "..") fail(`bad input path: ${rel}`);
    p = join(p, seg);
    let st;
    try { st = lstatSync(p); } catch { fail(`missing: ${p}`); }
    if (st.isSymbolicLink()) fail(`refusing a symlink: ${p}`);
  }
  if (!lstatSync(p).isFile()) fail(`not a regular file: ${p}`);
  return readFileSync(p);
}
const dir = (p, what) => {
  let st;
  try { st = lstatSync(p); } catch { fail(`${what} is missing: ${p}`); }
  if (!st.isDirectory()) fail(`${what} must be a real directory (not a symlink): ${p}`);
  return realpathSync(p);
};

function collection(colDir) {
  const root = dir(colDir, "collection");
  let cfg;
  try { cfg = JSON.parse(input(root, "collection.json").toString("utf8")); } catch (e) {
    fail(e instanceof BuildError ? e.message : `${join(colDir, "collection.json")}: ${e.message}`);
  }
  const { slug, title, door_photo, door_position } = cfg;
  if (typeof slug !== "string" || !/^[a-z0-9-]{6,}$/.test(slug) || RESERVED.has(slug))
    fail(`${colDir}/collection.json: slug must be lowercase [a-z0-9-], at least 6 characters, and not reserved: ${JSON.stringify(slug)}`);
  for (const [k, v] of [["title", title], ["door_photo", door_photo], ["door_position", door_position]])
    if (v !== undefined && (typeof v !== "string" || !v)) fail(`${colDir}/collection.json: ${k} must be a non-empty string when given`);
  if (!existsSync(join(root, "dist", "data.json")))
    fail(`${join(colDir, "dist", "data.json")} is missing: run python -I pipeline/gallery/build_site.py --collection ${relative(process.cwd(), colDir) || colDir} first`);
  const data = input(root, "dist/data.json");
  const door = { title: title ?? slug };
  if (door_photo) door.photo = door_photo;
  if (door_position) door.position = door_position;
  return { slug, root, data, door };
}

// the real path of p, resolving symlinked ancestors even when p itself does not exist yet
function realish(p) {
  const rest = [];
  for (let q = p; ; q = dirname(q)) {
    if (existsSync(q)) return join(realpathSync(q), ...rest.reverse());
    if (dirname(q) === q) return p;
    rest.push(basename(q));
  }
}
const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

// Rewrite every whole src/href attribute value. Local values (optionally "./", with
// ?query/#fragment kept) must be in `map` (old -> new) or `keep` (served as is);
// anything else stops the build. External (scheme: or //) and "#..." are left alone.
function rewriteRefs(html, map, keep, where) {
  const out = html.replace(/(\s(?:src|href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (all, pre, dq, sq, bare) => {
    const v = dq ?? sq ?? bare;
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v)) return all;
    const m = v.match(/^(?:\.\/)?([^?#]*)(.*)$/);
    const path = m[1], tail = m[2];
    let to;
    if (path in map) to = map[path];
    else if (keep.has(path)) to = path;
    else fail(`${where}: reference to ${JSON.stringify(v)} is not something the build ships`);
    if ((to + tail).includes('"')) fail(`${where}: cannot requote ${JSON.stringify(v)}`);
    return `${pre}"${to}${tail}"`;
  });
  for (const old of Object.keys(map)) {
    const name = old.split("/").pop();
    if (new RegExp(`(^|[^\\w.-])${name.replace(/\./g, "\\.")}(?![\\w-])`).test(out))
      fail(`${where}: still names ${name} after rewriting (an attribute the build does not rewrite?)`);
  }
  return out;
}

// the stylesheet with its font url()s fingerprinted; returns { css, fonts: [[newName, bytes]] }
function styleWithFonts(siteRoot) {
  const css = input(siteRoot, "style.css").toString("utf8");
  if (/@import/i.test(css)) fail("site/style.css: @import is not allowed");
  const fonts = new Map();
  const out = css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (all, q, u) => {
    if (u.startsWith("data:")) return all;
    const m = u.match(/^(?:\.\/)?fonts\/([^/?#]+\.woff2)$/);
    if (!m) fail(`site/style.css: url(${u}) is not fonts/<name>.woff2`);
    const name = m[1];
    if (!NAME.test(name)) fail(`site/style.css: font file name needs URL encoding: ${JSON.stringify(name)}`);
    if (!fonts.has(name)) {
      const buf = input(siteRoot, `fonts/${name}`);
      if (!buf.subarray(0, 4).equals(WOFF2_MAGIC)) fail(`site/fonts/${name} is not a woff2 file`);
      fonts.set(name, [hashed(name, buf), buf]);
    }
    return `url(fonts/${fonts.get(name)[0]})`;
  });
  return { css: out, fonts: [...fonts.values()], licence: input(siteRoot, `fonts/${FONT_LICENCE}`) };
}

function homeCss(homeRoot) {
  const css = input(homeRoot, "home.css").toString("utf8");
  if (/@import|url\(/i.test(css)) fail("home/home.css: no @import or url() allowed");
  return css;
}

// home/og/<name>: a real PNG of exactly w x h (read from IHDR)
function png(homeRoot, name, w, h) {
  const buf = input(homeRoot, `og/${name}`);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC) || buf.toString("latin1", 12, 16) !== "IHDR")
    fail(`home/og/${name} is not a png (run bin/make-og.mjs)`);
  if (buf.readUInt32BE(16) !== w || buf.readUInt32BE(20) !== h)
    fail(`home/og/${name} must be ${w}x${h}, is ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
  return buf;
}

const ROBOTS = `# armful.photos: the home page is for everyone. Collections answer with a
# password door and an X-Robots-Tag: noindex header, so they are never indexed.
User-agent: *
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/</loc></url>
</urlset>
`;

// the heap wordmark, inline, in the text colour (so it follows light/dark)
function inlineMark(siteRoot) {
  const svg = input(siteRoot, "mark.svg").toString("utf8").trim();
  const out = svg
    .replace(/^<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} class="mark" role="img" aria-label="armful">`)
    .replace(/fill="#16231F"/gi, 'fill="currentColor"');
  if (!/class="mark"/.test(out) || !/currentColor/.test(out) || /#16231F/i.test(out)) fail("site/mark.svg: unexpected shape, cannot inline it");
  if (/(href|src)\s*=|url\(|<image|<script/i.test(out)) fail("site/mark.svg: must not reference anything");
  return out;
}

function main() {
  const o = args(process.argv.slice(2));
  const siteRoot = dir(o.site, "--site"), homeRoot = dir(o.home, "--home");
  const built = o.cols.map(collection);
  const slugs = built.map((c) => c.slug);
  if (new Set(slugs).size !== slugs.length) fail(`two collections share a slug: ${slugs.join(", ")}`);

  // refuse to wipe anything that is not plainly a build folder, or that holds an input
  const out = realish(o.out);
  if (basename(out) !== "dist") fail(`--out must be a folder named dist: ${o.out}`);
  for (const [what, p] of [["the repo", realpathSync(ROOT)], ["--site", siteRoot], ["--home", homeRoot], ...built.map((c) => [`collection ${c.slug}`, c.root])])
    if (overlaps(out, p) && !(what === "the repo" && out.startsWith(p + sep))) fail(`--out ${o.out} overlaps ${what} (${p})`);
  if (existsSync(out) && existsSync(join(out, ".git"))) fail(`--out holds a .git: ${o.out}`);

  // read and transform everything before anything is written
  const { css: styleCss, fonts, licence } = styleWithFonts(siteRoot);
  const styleName = hashed("style.css", Buffer.from(styleCss));
  const hCss = homeCss(homeRoot);
  const homeName = hashed("home.css", Buffer.from(hCss));
  const mark = inlineMark(siteRoot);
  const og = png(homeRoot, "og.png", 1200, 630);
  const ogName = hashed("og.png", og);
  const touch = png(homeRoot, "apple-touch-icon.png", 180, 180);
  const files = new Map(); // dist-relative path -> bytes
  const put = (p, buf) => { if (files.has(p)) fail(`emitted twice: ${p}`); files.set(p, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); };

  const putFonts = (prefix) => {
    for (const [name, buf] of fonts) put(`${prefix}/fonts/${name}`, buf);
    put(`${prefix}/fonts/${FONT_LICENCE}`, licence);
  };
  put(`static/${styleName}`, styleCss);
  put(`static/${homeName}`, hCss);
  putFonts("static");
  put(`static/${ogName}`, og);
  put("apple-touch-icon.png", touch);
  put("robots.txt", ROBOTS);
  put("sitemap.xml", SITEMAP);
  const homeMap = { "/static/style.css": `/static/${styleName}`, "/static/home.css": `/static/${homeName}` };
  for (const page of ["index.html", "404.html"]) {
    let html = input(homeRoot, page).toString("utf8");
    if (!html.includes("<!-- mark -->")) fail(`home/${page} has no <!-- mark --> placeholder`);
    if (page === "index.html") {
      if (!html.includes(OG_URL)) fail(`home/index.html does not name ${OG_URL}`);
      html = html.split(OG_URL).join(`${ORIGIN}/static/${ogName}`);
    }
    html = rewriteRefs(html.replace("<!-- mark -->", mark), homeMap, new Set(["/", "/apple-touch-icon.png"]), `home/${page}`);
    put(page, html);
  }

  const app = input(siteRoot, "app.js");
  const appName = hashed("app.js", app);
  const svgs = SVGS.filter((n) => { try { lstatSync(join(siteRoot, n)); return true; } catch { return false; } })
    .map((n) => [n, input(siteRoot, n)]);
  const siteHtml = input(siteRoot, "index.html").toString("utf8");
  const colHtml = rewriteRefs(siteHtml, { "app.js": appName, "style.css": styleName },
    new Set([...svgs.map(([n]) => n), "data.json", "/"]), "site/index.html");
  for (const [ref, name] of [["app.js", appName], ["style.css", styleName]])
    if (!colHtml.includes(`"${name}`)) fail(`site/index.html does not reference ${ref}`);
  for (const c of built) {
    put(`${c.slug}/index.html`, colHtml);
    put(`${c.slug}/${appName}`, app);
    put(`${c.slug}/${styleName}`, styleCss);
    for (const [n, buf] of svgs) put(`${c.slug}/${n}`, buf);
    putFonts(c.slug);
    put(`${c.slug}/data.json`, c.data);
    put(`${c.slug}/door.json`, JSON.stringify(c.door) + "\n");
  }
  put("_headers", input(siteRoot, "_headers"));
  put("_redirects", input(siteRoot, "_redirects"));

  for (const p of files.keys()) {
    const segs = p.split("/");
    if (!segs.every((s) => NAME.test(s)) || /[A-Z]/.test(segs[0])) fail(`emitted path is not URL-safe for the gate: /${p}`);
  }

  rmSync(out, { recursive: true, force: true });
  for (const [p, buf] of files) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), buf);
  }
  process.stdout.write(`build-dist: ${relative(process.cwd(), out) || out} <- home + ${slugs.join(", ")} (${files.size} files)\n`);
}

try { main(); } catch (e) {
  if (!(e instanceof BuildError)) throw e;
  process.stderr.write(`build-dist: ${e.message}\n`);
  process.exit(1);
}
