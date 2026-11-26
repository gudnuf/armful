// Per-collection password gate (Cloudflare Pages Functions middleware).
// Runs before every request. Only paths under a collection prefix are gated:
// the first path segment is a slug (lowercase [a-z0-9-], 6+ chars) that is not
// reserved. Everything else (the home page, its assets) passes through untouched.
//
// Each collection has its own secret, COLLECTION_PASSWORD_<SLUG> (slug upper-cased,
// "-" -> "_"), an encrypted env var of the Pages project. Without it the collection
// fails closed (503). The cookie armful_<slug> holds HMAC(password, "armful-<slug>-v1"),
// scoped to Path=/<slug>, so changing a password logs everyone out of that one
// collection and a cookie for one collection never opens another.
import { door } from "./_door.js";

const DAYS = 30;
const NOINDEX = "noindex, nofollow, noarchive, noimageindex";
const SLUG_PATH = /^\/([a-z0-9-]{6,})(\/|$)/;
const RESERVED = ["app", "api", "a", "c", "about", "login", "new", "open", "static", "_"];
const enc = new TextEncoder();

async function token(secret, label) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(label));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) { // constant-time for equal lengths
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// every value of the cookie `name` (a sibling domain may plant a decoy beside the real one)
function cookies(request, name) {
  const out = [];
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) out.push(v.join("="));
  }
  return out;
}

const MIN_SECRET = 6; // a shorter secret is treated as unset: fail closed
const MAX_BODY = 4096; // login bodies over this are refused before parsing
const MAX_TO = 200;    // longer redirect hashes are dropped

// the request body as text, or null if it is longer than max bytes
async function readCapped(request, max) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch {} return null; }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(buf);
}

// the collection slug a path is under, or "" if the path is not gated
export function slugOf(pathname) {
  const m = SLUG_PATH.exec(pathname);
  return m && !RESERVED.includes(m[1]) ? m[1] : "";
}

export const secretName = (slug) => "COLLECTION_PASSWORD_" + slug.toUpperCase().replace(/-/g, "_");

// door.json is written by the build next to the collection's index.html:
// {"photo":"<drive id>","position":"center 30%","title":"<slug>","name":"<display name>",
// "dates":"<date range>","fonts":{"display","label","text": "/static/fonts/<name>.<hash>.woff2"}}.
// Read straight from the static assets (not through this middleware). Missing or broken = no
// photo, and the slug stands in for the title. Only these fields reach the door, which checks each.
async function doorOpts(env, request, slug) {
  try {
    const r = await env.ASSETS.fetch(new URL(`/${slug}/door.json`, request.url));
    if (!r.ok) return { slug };
    const j = await r.json();
    const f = j.fonts && typeof j.fonts === "object" ? j.fonts : {};
    return { slug, photo: String(j.photo || ""), position: String(j.position || ""), title: String(j.title || ""),
      name: typeof j.name === "string" ? j.name : "", dates: typeof j.dates === "string" ? j.dates : "",
      fonts: { display: String(f.display || ""), label: String(f.label || ""), text: String(f.text || "") } };
  } catch {
    return { slug };
  }
}

// The path as the client sent it (request.url before URL parsing normalises it),
// without query or fragment.
function rawPath(u) {
  const start = u.indexOf("/", u.indexOf("//") + 2);
  if (start < 0) return "/";
  const end = u.slice(start).search(/[?#]/);
  return end < 0 ? u.slice(start) : u.slice(start, start + end);
}

// Fail closed by shape, before any matching: the asset server decodes and
// normalises paths, so anything that could spell a collection prefix another
// way (percent-encoding, backslashes, doubled slashes, dot segments, upper
// case in the first segment) is refused outright instead of passed through.
export function badShape(path) {
  if (/[%\\]/.test(path) || path.includes("//")) return true;
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return true;
  return /[A-Z]/.test(path.split("/")[1] || "");
}

// "public, max-age=N, immutable" -> "private, max-age=N, immutable"; none -> "private, no-cache"
export function privateCache(cc) {
  const parts = String(cc || "").split(",").map((x) => x.trim()).filter((x) => x && !/^(public|private)$/i.test(x));
  return parts.length ? ["private", ...parts].join(", ") : "private, no-cache";
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  for (const path of [rawPath(request.url), url.pathname]) {
    if (badShape(path)) return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const slug = slugOf(url.pathname);
  if (!slug) return next();
  // the bare collection path gets its slash here: _redirects never sees a request this
  // middleware answers. Any slug-shaped path redirects, so this reveals nothing.
  if (url.pathname === `/${slug}`) {
    return new Response(null, { status: 301, headers: { Location: `/${slug}/`, "Cache-Control": "public, max-age=3600" } });
  }

  const secret = env[secretName(slug)];
  if (typeof secret !== "string" || secret.length < MIN_SECRET) {
    return new Response("Not configured.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Robots-Tag": NOINDEX },
    });
  }
  const name = `armful_${slug}`;
  const label = `armful-${slug}-v1`;
  const want = await token(secret, label);

  const plain = (status, extra = {}) => new Response(null, {
    status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Robots-Tag": NOINDEX, ...extra },
  });
  if (url.pathname === `/${slug}/__gate` && request.method !== "POST") return plain(405, { Allow: "POST" });

  if (url.pathname === `/${slug}/__gate`) {
    const body = await readCapped(request, MAX_BODY);
    if (body === null) return plain(413);
    // the door posts application/x-www-form-urlencoded; anything else reads as empty
    const type = request.headers.get("Content-Type") || "";
    const form = /^application\/x-www-form-urlencoded\b/i.test(type) ? new URLSearchParams(body) : new URLSearchParams();
    const p = form.get("p") || "";
    let to = form.get("to") || "";
    if (to.length > MAX_TO || !/^#[\w=.&,-]*$/.test(to)) to = "";
    // the door's script asks for JSON (Accept: application/json): the same checks, the same
    // cookie and the same delay, answered as data so the page can stay put on a wrong try
    const asJson = /\bapplication\/json\b/i.test(request.headers.get("Accept") || "");
    const base = { "Cache-Control": "private, no-store", "Vary": "Cookie, Accept", "X-Robots-Tag": NOINDEX, "Referrer-Policy": "no-referrer" };
    const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
      status, headers: { "Content-Type": "application/json; charset=utf-8", ...base, ...extra },
    });
    if (p && same(await token(p, label), want)) {
      const cookie = `${name}=${want}; Path=/${slug}; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
      if (asJson) return json(200, { ok: true, to: `/${slug}/` + to }, { "Set-Cookie": cookie });
      return new Response(null, { status: 303, headers: { Location: `/${slug}/` + to, "Set-Cookie": cookie, ...base, "Vary": "Cookie" } });
    }
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    if (asJson) return json(401, { ok: false });
    return door(401, true, await doorOpts(env, request, slug));
  }

  if (!cookies(request, name).some((v) => same(v, want))) return door(401, false, await doorOpts(env, request, slug));

  if (url.pathname.startsWith(`/${slug}/__file/`)) return fileProxy(request, env, slug, url.pathname.slice(`/${slug}/__file/`.length));

  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", NOINDEX);
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.append("Vary", "Cookie");
  // pages and data revalidate every time; static files keep their _headers max-age,
  // made private: nothing behind the gate may sit in a shared cache
  const type = out.headers.get("Content-Type") || "";
  if (/text\/html|application\/json/.test(type)) out.headers.set("Cache-Control", "private, no-cache");
  else out.headers.set("Cache-Control", privateCache(out.headers.get("Cache-Control")));
  if (/text\/html/.test(type)) out.headers.set("Content-Security-Policy", PAGE_CSP);
  return out;
}

// ---- __file/<id>: one of this collection's videos, streamed from Drive (behind the gate above) ----
// The page shares and saves the real file; photos it fetches from Google's image server directly
// (lh3 answers CORS), but Drive refuses a cross-site browser fetch of a video's bytes, so they come
// through here. Only GET / HEAD; only an id that is a video in this collection's own data.json
// (anything else is 404: there is no URL or host in the request, only the id); the upstream URL is
// fixed; the body is streamed through, never buffered; a Drive error or HTML page is a 502.
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const UPSTREAM = "https://drive.usercontent.google.com";
const VIDEOS_TTL = 60000;
const videos = new Map(); // slug -> { at, ids: Map(id -> position in data.json) }, per isolate
async function videoIds(env, request, slug) {
  const hit = videos.get(slug);
  if (hit && Date.now() - hit.at < VIDEOS_TTL) return hit.ids;
  const ids = new Map();
  try {
    const r = await env.ASSETS.fetch(new URL(`/${slug}/data.json`, request.url));
    if (r.ok) {
      const d = await r.json();
      (Array.isArray(d?.files) ? d.files : []).forEach((f, k) => {
        if (f && f.v && typeof f.i === "string" && FILE_ID.test(f.i)) ids.set(f.i, k);
      });
    }
  } catch {}
  videos.set(slug, { at: Date.now(), ids });
  return ids;
}
// tests point the upstream at a local stand-in; nothing but loopback is ever honoured
function upstreamOf(env) {
  const u = env.ARMFUL_FILE_UPSTREAM;
  return typeof u === "string" && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(u) ? u : UPSTREAM;
}
// the container's type from its first bytes (Drive says application/octet-stream)
function videoType(h) {
  const tag = (o) => String.fromCharCode(...h.slice(o, o + 4));
  if (h.length >= 12 && tag(4) === "ftyp") return tag(8) === "qt  " ? ["video/quicktime", "mov"] : ["video/mp4", "mp4"];
  if (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return ["video/webm", "webm"];
  return ["application/octet-stream", "bin"];
}
export async function fileProxy(request, env, slug, id) {
  const base = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Robots-Tag": NOINDEX, "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff" };
  const plain = (status, extra = {}) => new Response(null, { status, headers: { ...base, ...extra } });
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, { Allow: "GET, HEAD" });
  if (!FILE_ID.test(id)) return plain(404);
  const at = (await videoIds(env, request, slug)).get(id);
  if (at === undefined) return plain(404);
  const range = request.headers.get("Range") || "";
  const up = await fetch(`${upstreamOf(env)}/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, {
    headers: /^bytes=\d{0,15}-\d{0,15}$/.test(range) ? { Range: range } : {}, redirect: "follow",
  }).catch(() => null);
  if (!up || (up.status !== 200 && up.status !== 206) || /text\/html/i.test(up.headers.get("Content-Type") || "")) {
    try { await up?.body?.cancel(); } catch {}
    return plain(502);
  }
  const headers = { ...base, "Accept-Ranges": "bytes" };
  for (const k of ["Content-Length", "Content-Range"]) { const v = up.headers.get(k); if (v && /^[\w\s\/*-]+$/.test(v)) headers[k] = v; }
  // peek at the first chunk for the type and the name; then the rest flows straight through
  const reader = up.body ? up.body.getReader() : null;
  const first = reader ? await reader.read() : { done: true };
  const head = first.done ? new Uint8Array(0) : first.value;
  const [type, ext] = range && up.status === 206 && !/^bytes 0-/.test(headers["Content-Range"] || "") ? ["application/octet-stream", "bin"] : videoType(head);
  headers["Content-Type"] = type;
  headers["Content-Disposition"] = `attachment; filename="${slug}-${String(at + 1).padStart(4, "0")}.${ext}"`;
  if (request.method === "HEAD" || !reader) { try { await reader?.cancel(); } catch {} return new Response(null, { status: up.status, headers }); }
  const body = new ReadableStream({
    start(c) { if (!first.done) c.enqueue(first.value); },
    async pull(c) { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
    cancel(why) { return reader.cancel(why); },
  });
  return new Response(body, { status: up.status, headers });
}

// The collection page (behind the gate; the door sets its own): own scripts only, Drive
// thumbnails (drive.google.com redirects to *.googleusercontent.com) and the Drive video iframe.
export const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://drive.google.com https://*.googleusercontent.com data:", "font-src 'self'",
  // connect-src: the page fetches full-size photos from Google's image server to share or save them
  // (a video's bytes come through the gated __file/ on 'self')
  "connect-src 'self' https://lh3.googleusercontent.com", "frame-src https://drive.google.com",
  "media-src https://drive.google.com https://*.googleusercontent.com",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
