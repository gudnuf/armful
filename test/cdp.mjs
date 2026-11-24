// Headless Chrome over the DevTools protocol, for the page tests.
// To keep one headless Chrome at a time on a shared machine, set ARMFUL_CHROME_LOCK to a
// lockfile path: bin/check.sh then runs the Chrome suites under lockf / flock on it.
// launch() starts Chrome with a throwaway profile. close() kills it, waits for it to be
// gone, removes the profile and detaches the process handlers; a failed launch does the
// same before it throws, and process exit / SIGINT (130) / SIGTERM (143) kill it too.
// Every step has a deadline: startup, the socket, each CDP call, each page load.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CH = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: timed out after ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
};

// cdp(method, params) resolves with the protocol result; protocol errors, timeouts and
// a lost connection reject. evalJs throws on a page exception.
export async function launch(base = "", { timeout = 10000 } = {}) {
  const prof = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "armful-cdp-"));
  let chrome, ws, closed = false, exited = Promise.resolve();
  let seq = 0; const pending = new Map(); const handlers = new Map();
  const failAll = (err) => { for (const p of pending.values()) { clearTimeout(p.t); p.rej(err); } pending.clear(); };
  const alive = () => chrome?.pid && chrome.exitCode === null && chrome.signalCode === null;
  const rmProf = () => { try { rmSync(prof, { recursive: true, force: true }); } catch {} };
  const killNow = () => { if (alive()) try { chrome.kill("SIGKILL"); } catch {} };
  const onExit = () => { killNow(); rmProf(); };
  const onInt = () => { onExit(); process.exit(130); };
  const onTerm = () => { onExit(); process.exit(143); };
  process.on("exit", onExit); process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);

  const close = async () => {
    if (closed) return; closed = true;
    failAll(new Error("cdp: closed"));
    try { ws?.close(); } catch {}
    killNow();
    await Promise.race([exited, sleep(5000)]); // Chrome writes into the profile until it is gone
    rmProf();
    process.off("exit", onExit); process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  };

  const cdp = (method, params = {}) => {
    if (closed || ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`cdp ${method}: not connected`));
    return new Promise((res, rej) => {
      const id = ++seq;
      const t = setTimeout(() => { pending.delete(id); rej(new Error(`cdp ${method}: timed out after ${timeout}ms`)); }, timeout);
      pending.set(id, { res, rej, t, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const on = (method, fn) => { handlers.set(method, [...(handlers.get(method) || []), fn]); return () => handlers.set(method, handlers.get(method).filter((f) => f !== fn)); };

  try {
    chrome = spawn(CH, ["--headless=new", `--user-data-dir=${prof}`, "--remote-debugging-port=0",
      "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"] });
    exited = new Promise((r) => { chrome.once("exit", r); chrome.once("error", r); });
    const wsUrl = await deadline(new Promise((res, rej) => {
      let buf = "";
      chrome.once("error", (e) => rej(new Error(`chrome: could not start ${CH}: ${e.message}`)));
      chrome.once("exit", (c, s) => rej(new Error(`chrome: exited before DevTools was up (${c ?? s})`)));
      chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    }), 15000, "chrome: DevTools url");
    chrome.on("exit", (c, s) => failAll(new Error(`chrome exited (${c ?? s})`)));
    const list = await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`, { signal: AbortSignal.timeout(timeout) });
    const page = (await list.json()).find((t) => t.type === "page");
    if (!page) throw new Error("chrome: no page target");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await deadline(new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp: socket failed to open")); }), timeout, "cdp: socket open");
    ws.onerror = () => failAll(new Error("cdp: socket error"));
    ws.onclose = () => failAll(new Error("cdp: socket closed"));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
        if (m.error) p.rej(new Error(`cdp ${p.method}: ${m.error.message}${m.error.data ? " (" + m.error.data + ")" : ""}`));
        else p.res(m.result);
      } else if (m.method) for (const fn of handlers.get(m.method) || []) fn(m.params);
    };
    await cdp("Page.enable"); await cdp("Runtime.enable");
    await cdp("Page.setLifecycleEventsEnabled", { enabled: true });
  } catch (e) { await close(); throw e; }

  const evalJs = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("evalJs: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  const until = async (expr, ms = 9000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await evalJs(expr)) return true; return false; };
  const key = async (k, code) => { for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code }); };
  const click = async (x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };
  const tap = async (x, y) => { await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
  const png = async (file) => writeFileSync(file, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // navigate and wait for the load event of THIS navigation (matched by loaderId, so the
  // previous document can't satisfy it); fails with the URL and reason
  const loads = new Set();
  on("Page.lifecycleEvent", (p) => { if (p.name === "load") loads.add(p.loaderId); });
  const navigate = async (url, ms = 15000) => {
    const r = await cdp("Page.navigate", { url });
    if (r.errorText) throw new Error(`load ${url}: ${r.errorText}`);
    if (!r.loaderId) throw new Error(`load ${url}: same-document navigation, no new document`);
    const end = Date.now() + ms;
    while (!loads.has(r.loaderId)) { if (Date.now() > end) throw new Error(`load ${url}: no load event within ${ms}ms`); await sleep(50); }
    loads.delete(r.loaderId);
  };
  const load = async (w, h, mobile, path = "", ready = "true", ms = 9000) => {
    const url = base + path;
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    await navigate("about:blank"); // a fresh document even when only the hash differs
    await navigate(url);
    const status = await evalJs(`performance.getEntriesByType('navigation')[0]?.responseStatus || 0`);
    if (status >= 400) throw new Error(`load ${url}: HTTP ${status}`);
    if (!(await until(ready, ms))) throw new Error(`load ${url}: not ready within ${ms}ms: ${ready} (at ${await evalJs("location.href")})`);
  };
  return { cdp, on, evalJs, until, key, click, tap, png, navigate, load, close };
}
