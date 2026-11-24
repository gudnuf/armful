#!/usr/bin/env node
// Post-deploy check in a real (headless) Chrome against a live armful site.
//   ARMFUL_PASSWORD=... node bin/smoke-browser.mjs <base-url> <slug>
// The password is read ONLY from $ARMFUL_PASSWORD (never an argument) and is typed into the
// door's form; it is never printed, nor are cookies, data.json content or photo ids (URLs are
// shown as their host only). With $ARMFUL_CHROME_LOCK set, the run holds that lockfile
// (lockf / flock) so only one headless Chrome runs at a time.
// At 390x844 (phone) and 1440x900 (desktop): home, door, log in, wall, first screen of
// thumbnails, the people list, a face filter + the hold, the previewer's large photo, close.
// Throughout: console errors, exceptions, failed loads, CSP violations, and the host of every
// request: anything other than the site itself, drive.google.com and *.googleusercontent.com
// fails. One `ok` / `FAIL` line per check; exit 1 if any failed, 2 if it could not run.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "../test/cdp.mjs";

const [baseArg, slugArg] = process.argv.slice(2);
if (!baseArg || !slugArg) { console.error("usage: node bin/smoke-browser.mjs <base-url> <slug>"); process.exit(2); }
const LOCK = process.env.ARMFUL_CHROME_LOCK || "";
if (LOCK && LOCK !== "none" && !process.env.ARMFUL_SMOKE_LOCKED) {
  const env = { ...process.env, ARMFUL_SMOKE_LOCKED: "1" };
  const args = [process.execPath, fileURLToPath(import.meta.url), baseArg, slugArg];
  let r = spawnSync("lockf", [LOCK, ...args], { stdio: "inherit", env });
  if (r.error?.code === "ENOENT") r = spawnSync("flock", [LOCK, ...args], { stdio: "inherit", env });
  if (r.error) { console.error(`smoke-browser: ARMFUL_CHROME_LOCK is set but neither lockf nor flock ran (${r.error.code})`); process.exit(2); }
  process.exit(r.status ?? 2);
}
const PASSWORD = process.env.ARMFUL_PASSWORD || "";
if (!PASSWORD) { console.error("smoke-browser: set ARMFUL_PASSWORD (read from the environment only)"); process.exit(2); }

const BASE = new URL(baseArg.replace(/\/+$/, "") + "/");
const SLUG = slugArg;
if (!/^[a-z0-9-]{6,}$/.test(SLUG)) { console.error("smoke-browser: bad slug"); process.exit(2); }
const COLL = new URL(`/${SLUG}/`, BASE).href;
const ALLOWED = (h) => h === BASE.hostname || h === "drive.google.com" || h.endsWith(".googleusercontent.com");
const js = (x) => JSON.stringify(x);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
// any URL in a message becomes its host: no photo ids, no query strings
// a URL to show: the host, plus the path for the site's own public files (never a collection's)
const where = (u) => { try { const x = new URL(u); return x.hostname === BASE.hostname && !x.pathname.startsWith(`/${SLUG}/`) ? x.hostname + x.pathname : x.hostname; } catch { return "url"; } };
const scrub = (s) => String(s || "").replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/g, (u) => `<${hostOf(u) || "url"}>`).replace(PASSWORD, "<password>").slice(0, 240);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok ${name}` : `FAIL ${name}${detail ? ": " + detail : ""}`);
  if (!ok) failed++;
  return ok;
};

async function viewport(b, ev, [w, h, mobile]) {
  const tag = `${w}x${h}`;
  const step = (name) => (ev.step = `${tag} ${name}`);
  const press = async (sel) => { // a real touch on the phone, a real click on the desktop
    const p = await b.evalJs(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null;
      e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!p) throw new Error(`no ${sel}`);
    if (mobile) await b.tap(...p); else await b.click(...p);
  };
  const metrics = async () => {
    await b.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile });
    await b.cdp("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  };
  await b.cdp("Network.clearBrowserCookies"); // each viewport is a first visit: no cookie, no recent armfuls
  await b.cdp("Storage.clearDataForOrigin", { origin: BASE.origin, storageTypes: "local_storage,session_storage,cache_storage,indexeddb,service_workers" });
  await metrics();

  // home
  try { await b.navigate("about:blank"); await sleep(300); } catch {}
  step("home");
  try {
    const before = ev.errors.length;
    await b.navigate(BASE.href, 20000);
    await sleep(1500);
    const st = await b.evalJs(`performance.getEntriesByType('navigation')[0]?.responseStatus || 0`);
    const hosts = [...new Set(ev.requests.filter((r) => r.step === ev.step).map((r) => r.host))];
    const foreign = hosts.filter((x) => x !== BASE.hostname);
    const errs = ev.errors.slice(before);
    check(`${tag} home: loads (HTTP ${st}), no console errors, only same-origin requests`, st === 200 && !errs.length && !foreign.length,
      [st !== 200 && `HTTP ${st}`, errs.length && `${errs.length} console error(s)`, foreign.length && `other hosts: ${foreign.join(", ")}`].filter(Boolean).join("; "));
  } catch (e) { check(`${tag} home: loads`, false, scrub(e.message)); }

  // door
  step("door");
  try {
    await b.navigate(COLL, 20000);
    const d = await b.evalJs(`(() => { const pw = document.querySelector('form input[type=password]'), c = document.querySelector('.cover');
      return { status: performance.getEntriesByType('navigation')[0]?.responseStatus || 0,
        pass: !!pw, ph: pw?.getAttribute('placeholder') || '', go: !!document.querySelector('form button[type=submit] svg'),
        action: document.querySelector('form')?.getAttribute('action') || '',
        cover: !!c, name: !!c?.querySelector('.name')?.textContent.trim(), dates: !!c?.querySelector('.dates')?.textContent.trim() }; })()`);
    check(`${tag} door: renders (HTTP ${d.status}), password field with placeholder "password", arrow present`,
      d.status === 401 && d.pass && d.ph === "password" && d.go && d.action === `/${SLUG}/__gate`,
      `status ${d.status}, password field ${d.pass}, placeholder ${js(d.ph)}, arrow ${d.go}`);
    // the name + dates cover appears only when door.json names the collection; if it is there it has a name
    check(`${tag} door: ${d.cover ? `cover with the name${d.dates ? " and dates" : ", no dates"}` : "no name/dates cover (door.json carries no name)"}`,
      !d.cover || d.name, "cover without a name");
  } catch (e) { check(`${tag} door: renders`, false, scrub(e.message)); return; }

  // log in: type the password, submit the form
  step("login");
  let N = -1;
  try {
    await b.evalJs(`document.querySelector('form input[type=password]').focus()`);
    for (const ch of PASSWORD) await b.cdp("Input.insertText", { text: ch });
    const typed = await b.evalJs(`document.querySelector('form input[type=password]').value.length`);
    await press("form button[type=submit]");
    const inside = await b.until(`location.pathname === ${js(`/${SLUG}/`)} && !document.querySelector('input[type=password]') && !!document.getElementById('wall')`, 20000);
    check(`${tag} login: typed and submitted, the collection page opens`, typed === PASSWORD.length && inside,
      inside ? "the field did not take every character" : `still at the door (${await b.evalJs("document.querySelector('form.wrong') ? 'wrong password' : 'no page'")})`);
    if (!inside) return;
  } catch (e) { check(`${tag} login`, false, scrub(e.message)); return; }

  // wall: one tile per data.json file
  step("wall");
  try {
    N = await b.evalJs(`fetch('data.json', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((d) => Array.isArray(d?.files) ? d.files.length : -1)`);
    const ok = N > 0 && await b.until(`document.querySelectorAll('#wall .tile').length === ${N} && document.getElementById('loading').hidden`, 20000);
    const n = await b.evalJs(`document.querySelectorAll('#wall .tile').length`);
    check(`${tag} wall: ${n} tiles = ${N} files in data.json`, ok, `${n} tiles, data.json files ${N}`);
    if (!ok) return;
  } catch (e) { check(`${tag} wall`, false, scrub(e.message)); return; }

  // the slim header: the wordmark and "N people · N photos"
  step("header");
  try {
    const h = await b.evalJs(`(() => { const m = document.querySelector('.masthead'); return { mark: !!m?.querySelector('.mark svg'),
      text: (document.getElementById('stats')?.textContent || '').trim() }; })()`);
    const m = h.text.match(/^([\d,.\s]+) (?:people|person) · ([\d,.\s]+) photos?$/);
    const photos = m ? +m[2].replace(/\D/g, "") : -1;
    check(`${tag} header: wordmark and "${h.text}"`, h.mark && !!m && +m[1].replace(/\D/g, "") > 0 && photos === N,
      `wordmark ${h.mark}, stats ${js(h.text)}, want ${N} photos`);
  } catch (e) { check(`${tag} header`, false, scrub(e.message)); }

  // the first screen of thumbnails
  step("tiles");
  try {
    const VIS = `[...document.querySelectorAll('#wall .tile')].filter((t) => { const r = t.getBoundingClientRect(); return !t.hidden && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }).map((t) => t.querySelector('img'))`;
    const end = Date.now() + 20000;
    let s;
    for (;;) {
      s = await b.evalJs(`(() => { const v = ${VIS}; return { n: v.length, bad: v.filter((i) => !(i && i.complete && i.naturalWidth > 0)).map((i) => i ? (i.currentSrc || i.getAttribute('src') || '') : '') }; })()`);
      if (!s.bad.length || Date.now() > end) break;
      await sleep(250);
    }
    const why = s.bad.map((u) => (u ? ev.statusOf(u) : "no src"));
    const tally = Object.entries(why.reduce((a, x) => ((a[x] = (a[x] || 0) + 1), a), {})).map(([k, v]) => `${v}x ${k}`).join(", ");
    check(`${tag} tiles: ${s.n - s.bad.length}/${s.n} visible thumbnails loaded within 20 s`, s.n > 0 && !s.bad.length, `${s.bad.length} failed (${tally || "none visible"})`);
  } catch (e) { check(`${tag} tiles`, false, scrub(e.message)); }

  // the people list
  step("panel");
  try {
    if (!(await b.evalJs(`document.getElementById('list').getClientRects().length > 0`))) await press("#people");
    const open = await b.until(`document.getElementById('list').getClientRects().length > 0 && document.querySelectorAll('#listMain .face').length > 0`, 5000);
    const FACES = `(() => { const L = document.getElementById('list').getBoundingClientRect();
      const v = [...document.querySelectorAll('#listMain .face img')].filter((i) => { const r = i.getBoundingClientRect();
        return r.width > 0 && r.bottom > Math.max(0, L.top) && r.top < Math.min(innerHeight, L.bottom) && r.right > Math.max(0, L.left) && r.left < Math.min(innerWidth, L.right); });
      return { n: v.length, bad: v.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.currentSrc || i.getAttribute('src') || '') }; })()`;
    let f = { n: 0, bad: [] };
    if (open) for (const end = Date.now() + 15000; ; await sleep(250)) { f = await b.evalJs(FACES); if ((f.n && !f.bad.length) || Date.now() > end) break; }
    const why = f.bad.map((u) => (u ? ev.statusOf(u) : "no src")).join(", ");
    check(`${tag} panel: list opens, ${f.n - f.bad.length}/${f.n} visible faces loaded`, open && f.n > 0 && !f.bad.length, open ? `${f.bad.length} failed (${why})` : "the list did not open");
  } catch (e) { check(`${tag} panel`, false, scrub(e.message)); }

  // a face filters the wall and shows the hold
  step("face");
  try {
    const pid = await b.evalJs(`document.querySelector('#listMain .face')?.dataset.pid || ''`);
    if (!pid) throw new Error("no face in the rail");
    await press(`#listMain .face[data-pid="${pid}"]`);
    const ST = `(() => { const t = [...document.querySelectorAll('#wall .tile')], shown = t.filter((x) => !x.hidden).length;
      const pair = document.getElementById('pair'), label = document.getElementById('peopleLabel').textContent.trim();
      return { shown, total: t.length, held: document.getElementById('bar').classList.contains('held') && !pair.hidden && !!pair.querySelector('.face[data-pid="${pid}"]'),
        x: !document.getElementById('clear').hidden, label, n: +(label.match(/^([\\d,.\\s]+) photos?$/)?.[1] || '').replace(/\\D/g, '') }; })()`;
    const ok = await b.until(`(() => { const s = ${ST}; return s.shown > 0 && s.shown < s.total && s.held && s.x && s.n === s.shown; })()`, 5000);
    const s = await b.evalJs(ST);
    check(`${tag} face: the wall filters (${s.shown} of ${N}), the pill holds the face, "${s.label}" and x`, ok,
      `shown ${s.shown} of ${s.total}, face in pill ${s.held}, x ${s.x}, label ${js(s.label)}`);
    // let go with the pill's x
    await press("#clear");
    const back = await b.until(`(() => { const s = ${ST}; return s.shown === s.total && !s.held && !s.x && /people$/.test(s.label); })()`, 5000);
    const c = await b.evalJs(ST);
    check(`${tag} face: the pill's x clears (${c.shown} of ${N}, "${c.label}")`, back, `shown ${c.shown} of ${c.total}, held ${c.held}, x ${c.x}, label ${js(c.label)}`);
  } catch (e) { check(`${tag} face`, false, scrub(e.message)); }

  // the previewer's large photo, then close
  step("previewer");
  try {
    if (await b.evalJs(`document.getElementById('list').getClientRects().length > 0`)) { await press("#people"); await sleep(300); } // fold the list away
    // the first photo tile on screen whose middle is not under the floating panel
    const sel = await b.evalJs(`(() => { const t = [...document.querySelectorAll('#wall .tile')].find((x) => { if (x.hidden || x.querySelector('.play')) return false;
      const r = x.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= innerHeight) return false;
      return x.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
      return t ? '.tile[data-n="' + t.dataset.n + '"]' : ''; })()`);
    if (!sel) throw new Error("no photo tile on the wall");
    await press(`#wall ${sel}`);
    const want = mobile ? 1 : 800;
    const ok = await b.until(`(() => { const i = document.querySelector('#lbStage img'); return !document.getElementById('lb').hidden && !!i && !i.classList.contains('soft') && i.naturalWidth >= ${want}; })()`, 20000);
    const nw = await b.evalJs(`document.querySelector('#lbStage img')?.naturalWidth || 0`);
    check(`${tag} previewer: the large photo loads (naturalWidth ${nw}${mobile ? "" : ", want >= 800"})`, ok, `naturalWidth ${nw}, open ${!(await b.evalJs("document.getElementById('lb').hidden"))}`);
    if (await b.evalJs(`document.getElementById('lb').hidden`)) check(`${tag} previewer: closes`, false, "it never opened");
    else { await b.key("Escape", 27); check(`${tag} previewer: closes`, await b.until(`document.getElementById('lb').hidden`, 5000)); }
  } catch (e) { check(`${tag} previewer`, false, scrub(e.message)); }
}

let b;
const ev = { step: "", errors: [], exceptions: [], failures: [], blocked: [], csp: [], requests: [], byUrl: new Map(), byId: new Map(), statusOf: null };
ev.statusOf = (u) => {
  const r = ev.byUrl.get(u);
  if (!r) return "never requested";
  return r.error ? r.error : r.status ? `HTTP ${r.status}` : "pending";
};
let code = 0;
try {
  b = await launch("", { timeout: 20000 });
  await b.cdp("Network.enable"); await b.cdp("Log.enable");
  await b.cdp("Runtime.addBinding", { name: "__armfulCsp" });
  await b.cdp("Page.addScriptToEvaluateOnNewDocument", { source:
    `document.addEventListener('securitypolicyviolation', (e) => { try { __armfulCsp(e.violatedDirective + ' ' + (e.blockedURI || '')); } catch {} }, true);` });
  b.on("Runtime.bindingCalled", (p) => { if (p.name === "__armfulCsp") ev.csp.push(`[${ev.step}] ${scrub(p.payload)}`); });
  b.on("Runtime.consoleAPICalled", (p) => {
    if (p.type !== "error" && p.type !== "assert") return;
    ev.errors.push(`[${ev.step}] console.${p.type}: ${scrub((p.args || []).map((a) => a.value ?? a.description ?? "").join(" "))}`);
  });
  b.on("Runtime.exceptionThrown", (p) => ev.exceptions.push(`[${ev.step}] ${scrub(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)}`));
  b.on("Log.entryAdded", ({ entry }) => {
    if (entry.level !== "error") return;
    // the door answers 401 by design: the browser logs that as a failed load of the door itself
    if (entry.source === "network" && /\b401\b/.test(entry.text) && entry.url && new URL(entry.url).pathname.startsWith(`/${SLUG}/`) && /door|login/.test(ev.step)) return;
    ev.errors.push(`[${ev.step}] ${entry.source}: ${scrub(entry.text)}${entry.url ? " <" + where(entry.url) + ">" : ""}`);
  });
  b.on("Network.requestWillBeSent", (p) => {
    const u = p.request.url;
    if (!/^(https?|wss?):/.test(u)) return;
    let r = ev.byId.get(p.requestId);
    if (!r || !p.redirectResponse) { r = { url: u, status: 0, error: "" }; ev.byId.set(p.requestId, r); ev.byUrl.set(u, r); }
    else ev.byUrl.set(u, r);
    if (p.redirectResponse) r.status = p.redirectResponse.status;
    ev.requests.push({ step: ev.step, host: hostOf(u) });
  });
  b.on("Network.responseReceived", (p) => { const r = ev.byId.get(p.requestId); if (r) r.status = p.response.status; });
  b.on("Network.loadingFailed", (p) => {
    const r = ev.byId.get(p.requestId); const host = r ? hostOf(r.url) : "?";
    if (r) r.error = p.errorText;
    if (p.errorText === "net::ERR_BLOCKED_BY_CLIENT" && !ALLOWED(host)) { ev.blocked.push(`[${ev.step}] ${host}`); return; }
    if (p.canceled || p.errorText === "net::ERR_ABORTED") return; // navigated away / superseded
    ev.failures.push(`[${ev.step}] ${p.errorText}${p.blockedReason ? " (" + p.blockedReason + ")" : ""} <${host}>`);
  });

  for (const vp of [[390, 844, true], [1440, 900, false]]) await viewport(b, ev, vp);
  ev.step = "end";

  const list = (xs) => xs.slice(0, 8).join("; ") + (xs.length > 8 ? `; +${xs.length - 8} more` : "");
  check("console: no errors", !ev.errors.length, `${ev.errors.length}: ${list(ev.errors)}`);
  check("page: no uncaught exceptions", !ev.exceptions.length, `${ev.exceptions.length}: ${list(ev.exceptions)}`);
  check("network: no failed loads", !ev.failures.length, `${ev.failures.length}: ${list(ev.failures)}`);
  check("csp: no violations", !ev.csp.length, `${ev.csp.length}: ${list(ev.csp)}`);
  const hosts = [...new Set(ev.requests.map((r) => r.host))].sort();
  const foreign = hosts.filter((h) => !ALLOWED(h));
  const attempted = [...new Set(ev.blocked.map((x) => x.replace(/^\[[^\]]*\] /, "")))];
  check(`hosts: only ${BASE.hostname}, drive.google.com, *.googleusercontent.com (saw ${hosts.join(", ")})`, !foreign.length,
    `third-party attempted: ${foreign.join(", ")}${attempted.length ? ` (blocked by the client: ${attempted.join(", ")})` : ""}`);
  if (attempted.length) console.log(`note third-party attempted, blocked by the client: ${attempted.join(", ")}`);
} catch (e) {
  console.log(`FAIL smoke-browser could not run: ${scrub(e.message)}`);
  code = 2;
} finally {
  await b?.close();
}
console.log(failed || code ? `smoke-browser: FAILED (${failed} check${failed === 1 ? "" : "s"})` : "smoke-browser: all ok");
process.exit(code || (failed ? 1 : 0));
