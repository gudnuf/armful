// functions/_middleware.js under a real `wrangler pages dev`, for the gate suites
// (test/gate.test.mjs, test/door.test.mjs). makeWork() builds a temp project from the synthetic
// fixture: functions -> the repo's functions, dist/ from bin/build-dist.mjs, one collection per
// entry. start() runs wrangler on it with the given secrets, which reach it only through a temp
// .dev.vars, never a tracked file; stop() kills the whole process group and waits for it.
// No real data: photo ids are placeholders.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = "wrangler@4.167.0"; // pinned: same version every run, cached after the first
export const key = (slug) => "COLLECTION_" + "PASSWORD_" + slug.toUpperCase().replace(/-/g, "_");

// cols: [[slug, collection.json extras, (data) => data]...] -> the temp project dir
export function makeWork(cols) {
  const work = mkdtempSync(join(tmpdir(), "armful-gate-"));
  symlinkSync(join(ROOT, "functions"), join(work, "functions"));
  const fx = join(work, "fixture");
  execFileSync("python3", ["-I", join(ROOT, "bin", "make-fixture.py"), fx]);
  const args = [join(ROOT, "bin", "build-dist.mjs"), "--out", join(work, "dist")];
  for (const [slug, extra = {}, edit = (d) => d] of cols) {
    const col = join(work, "collections", slug);
    mkdirSync(join(col, "dist"), { recursive: true });
    writeFileSync(join(col, "collection.json"), JSON.stringify({ slug, ...extra }));
    writeFileSync(join(col, "dist", "data.json"), JSON.stringify(edit(JSON.parse(readFileSync(join(fx, "data.json"), "utf8")))));
    args.push("--collection", col);
  }
  execFileSync(process.execPath, args, { cwd: work, stdio: "ignore" });
  return work;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

let server = null;
function killNow() { // sync, for process exit
  if (!server) return;
  try { process.kill(-server.proc.pid, "SIGKILL"); } catch {}
  try { server.proc.kill("SIGKILL"); } catch {}
}
process.on("exit", killNow);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killNow(); process.exit(1); });

// kill the whole wrangler process group and wait until it has exited
export async function stop() {
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

// start wrangler on work/dist with these secrets ({} = none configured) -> its base URL
export async function start(work, secrets) {
  await stop();
  rmSync(join(work, ".dev.vars"), { force: true });
  const lines = Object.entries(secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  if (lines.length) writeFileSync(join(work, ".dev.vars"), lines.join("\n") + "\n");
  const port = await freePort();
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("COLLECTION_" + "PASSWORD_")) delete env[k];
  const proc = spawn("npx", ["--yes", WRANGLER, "pages", "dev", "dist", "--port", String(port), "--ip", "127.0.0.1",
    "--compatibility-date=2026-01-01", "--show-interactive-dev-session=false"],
    { cwd: work, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
  return server.base;
}
