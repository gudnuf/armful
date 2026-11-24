// The screenshot set, on the synthetic fixture only (never real data).
//   node bin/shoot.mjs [--out shots] [--only door,home]
//   (on a shared machine, optionally under lockf/flock "$ARMFUL_CHROME_LOCK")
// Screens: door, arrive, one, together, any, previewer, home; widths 375, 390, 768, 1440;
// light and dark. Files: <out>/<screen>-<width>-<scheme>.png (shots/ is git-ignored).
//   door       the password door (functions/_door.js), no photo: the ink ground
//   arrive     the collection page as it first loads
//   one        the panel open, one face held
//   together   two faces held (person 1 and 2: 9 photos together in the fixture)
//   any        the pair tapped apart: any
//   previewer  the first visible photo (not a video) open in the previewer
//   home       dist/index.html built by bin/build-dist.mjs from the example collection
// A screen whose controls are not on the page yet (the panel or the hold still being
// built) is skipped with a note, not a failure. Exits 1 only if a screen breaks.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../test/serve.mjs";
import { launch, sleep } from "../test/cdp.mjs";
import { door } from "../functions/_door.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg("--out", join(ROOT, "shots")));
const ONLY = arg("--only", "")?.split(",").filter(Boolean);
const WIDTHS = [[375, 812], [390, 844], [768, 1024], [1440, 900]];
const SCHEMES = ["light", "dark"];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain" };

class Skip extends Error {}
const temps = [];
const temp = (p) => { const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), p)); temps.push(d); return d; };

// the fixture, then dist/ from the example collection in a temp workspace (as test/build.test.mjs)
const FIX = join(ROOT, "test", "fixture");
execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), FIX], { stdio: "ignore" });
const ws = temp("armful-shoot-");
const col = join(ws, "collections", "example");
mkdirSync(join(col, "dist"), { recursive: true });
cpSync(join(ROOT, "collections", "example", "collection.json"), join(col, "collection.json"));
cpSync(join(FIX, "data.json"), join(col, "dist", "data.json"));
execFileSync(process.execPath, [join(ROOT, "bin", "build-dist.mjs"), "--site", join(ROOT, "site"), "--home", join(ROOT, "home"),
  "--collection", col, "--out", join(ws, "dist")], { cwd: ws, stdio: "ignore" });
const DIST = join(ws, "dist");

// home and door: dist/ as static files, plus /__door rendered by door()
const doorHtml = await door(401, false, { slug: "example" }).text();
const other = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/__door") { res.writeHead(401, { "content-type": TYPES[".html"] }).end(doorHtml); return; }
  let rel = normalize(decodeURIComponent(path)).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith(sep)) rel += "index.html";
  const file = join(DIST, rel);
  try {
    if (!file.startsWith(DIST + sep) || !statSync(file).isFile()) throw 0;
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => other.listen(0, "127.0.0.1", r));
const OTHER = `http://127.0.0.1:${other.address().port}`;
const srv = await serve();
const COL = srv.url + "/example/";

const READY = `document.querySelectorAll('#wall .tile').length > 0 && document.getElementById('loading').hidden`;
let b;
const has = (sel) => b.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const need = async (sel, what) => { if (!(await has(sel))) throw new Skip(`${what}: no ${sel} on the page yet`); };
const clickEl = async (sel) => {
  const ok = await b.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "nearest" }); e.click(); return true; })()`);
  if (!ok) throw new Skip(`no ${sel} to tap`);
  await sleep(500); // past the 420ms spring
};
const settle = () => b.evalJs(`document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 700))).then(() => true)`);
const openPanel = async () => {
  await need("#people", "the panel");
  if ((await b.evalJs(`document.getElementById('people').getAttribute('aria-expanded')`)) !== "true") await clickEl("#people");
};
const hold = async (...pids) => {
  await openPanel();
  for (const p of pids) { await need(`#listMain .face[data-pid="${p}"]`, `face ${p} in the list`); await clickEl(`#listMain .face[data-pid="${p}"]`); }
};

const SCREENS = {
  door: async (w, h, m) => { await b.load(w, h, m, OTHER + "/__door", "!!document.querySelector('form.door')").catch(async (e) => {
    if (!/HTTP 401/.test(e.message)) throw e; }); }, // the door is a 401 by design
  arrive: async (w, h, m) => { await b.load(w, h, m, COL, READY); },
  one: async (w, h, m) => { await b.load(w, h, m, COL, READY); await hold(1); },
  together: async (w, h, m) => { await b.load(w, h, m, COL, READY); await hold(1, 2); },
  any: async (w, h, m) => {
    await b.load(w, h, m, COL, READY); await hold(1, 2);
    await need("#pair", "the hold"); await clickEl("#pair");
  },
  previewer: async (w, h, m) => {
    await b.load(w, h, m, COL, READY);
    await clickEl("#wall .tile:not([hidden]):not(:has(.play))"); // a photo: a video embeds Drive's player
    if (!(await b.until(`!document.getElementById('lb').hidden`, 4000))) throw new Error("previewer did not open");
  },
  home: async (w, h, m) => { await b.load(w, h, m, OTHER + "/", "!!document.querySelector('.mark')"); },
};

mkdirSync(OUT, { recursive: true });
const made = [], skipped = new Map(), broke = [];
try {
  b = await launch();
  for (const [name, go] of Object.entries(SCREENS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    sizes: for (const [w, h] of WIDTHS) for (const scheme of SCHEMES) {
      const file = join(OUT, `${name}-${w}-${scheme}.png`);
      try {
        await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await go(w, h, w < 1000);
        await settle();
        await b.png(file);
        made.push(file);
      } catch (e) {
        if (e instanceof Skip) { skipped.set(name, e.message); break sizes; }
        broke.push(`${name} ${w} ${scheme}: ${e.message}`);
      }
    }
  }
} finally {
  await b?.close(); await srv.close(); await new Promise((r) => other.close(r));
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
for (const f of made) console.log("shot " + relative(process.cwd(), f));
for (const [n, why] of skipped) console.log(`skip ${n}: ${why}`);
for (const x of broke) console.log("FAIL " + x);
console.log(`${made.length} shots in ${OUT}, ${skipped.size} screens skipped, ${broke.length} failed`);
process.exit(broke.length ? 1 : 0);
