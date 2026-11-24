// The door: the password page for one collection, served by the gate middleware.
// Self-contained (inline CSS and wordmark, no fonts, one small inline script: the in-place
// submit below, the hash carry-over and photo fallback) so it renders with nothing else loaded. No words on it except
// the field's "password" placeholder (beside a lock glyph), aria-labels and the screen-reader
// alert after a wrong try. The form has a fixed height, so a slow, streamed first paint (the
// mark before the field) moves nothing.
const NOINDEX = "noindex, nofollow, noarchive, noimageindex";

// the heap wordmark, outlined (logo/heap-wordmark.svg), filled paper
const MARK = `<svg class="mark" viewBox="0 0 2987 802" width="88" height="24" role="img" aria-label="armful"><path fill="#FBFAF7" d="M919 471V748H1063V567Q1063 486 1077.5 435Q1092 384 1116 360.5Q1140 337 1169 337Q1192 337 1207 350.5Q1222 364 1229.5 391Q1237 418 1237 461V748H1378V567Q1378 491 1392 440Q1406 389 1430 363Q1454 337 1485 337Q1508 337 1523 350.5Q1538 364 1545 393Q1552 422 1552 465V748H1696V452Q1696 390 1686 344.5Q1676 299 1656 269Q1636 239 1606 224Q1576 209 1535 209Q1484 209 1448 233Q1412 257 1390 309Q1368 361 1362 445H1353Q1356 364 1341.5 312Q1327 260 1295.5 234.5Q1264 209 1214 209Q1165 209 1130 232.5Q1095 256 1074.5 308Q1054 360 1047 445H1039L1042 223H918ZM120.5 747.5Q156 762 197 762Q251 762 293 738.5Q335 715 361 676Q387 637 392 590H398Q398 632 397 671Q396 710 395 748H522Q522 714 521.5 679.5Q521 645 521 610.5V447Q521 370 496 317Q471 264 421.5 236.5Q372 209 298 209Q257 209 215 219Q173 229 138 252Q103 275 82.5 314.5Q62 354 62 414L191 425Q191 386 206.5 364Q222 342 246 333.5Q270 325 293 325Q332 325 356 342.5Q380 360 380 394Q380 409 371 417.5Q362 426 335.5 431.5Q309 437 256 447Q217 454 179 464Q141 474 109 492Q77 510 58.5 540.5Q40 571 40 619Q40 671 62.5 702Q85 733 120.5 747.5ZM2079 422.5C2079 609.4 2230.6 761 2417.5 761C2489 761 2555.3 738.8 2610 701V748H2756V223H2610V370.1Q2618.7 376.4 2626.4 384.1Q2644.4 402.1 2654.3 425.4Q2664.5 449.6 2664.5 476Q2664.5 502.4 2654.3 526.6Q2644.4 549.9 2626.4 567.9Q2608.4 585.9 2585.1 595.8Q2560.9 606 2534.5 606Q2519 606 2504.2 602.5C2478.1 616.2 2448.7 624 2417.5 624C2386.3 624 2356.9 616.2 2330.8 602.5Q2316 606 2300.5 606Q2274.1 606 2249.9 595.8Q2226.6 585.9 2208.6 567.9Q2190.6 549.9 2180.7 526.6Q2170.5 502.4 2170.5 476Q2170.5 449.6 2180.7 425.4Q2190.6 402.1 2208.6 384.1Q2216.3 376.4 2225 370.1V223H2079ZM1788 418V748H1930V418H2047V306H1949Q1920 306 1901 297Q1882 288 1873 273Q1864 258 1864 240Q1864 210 1883.5 194.5Q1903 179 1935 179Q1962 179 1987 189.5Q2012 200 2040 221L2052 88Q2024 64 1989.5 52Q1955 40 1911 40Q1858 40 1816.5 58Q1775 76 1752 109Q1729 142 1729 186Q1729 211 1740 238.5Q1751 266 1780.5 287Q1810 308 1866 315V323L1712 313V418ZM563 472V748H706V548Q706 490 718.5 449.5Q731 409 755 388Q779 367 813 367Q830 367 850 372.5Q870 378 890 389L898 230Q879 220 860.5 215.5Q842 211 825 211Q790 211 762.5 233Q735 255 717 305.5Q699 356 693 441H685L688 223H562ZM2947 748V53H2803V748ZM2521.5 273.4C2521.5 215.9 2474.9 169.4 2417.5 169.4C2360.1 169.4 2313.5 215.9 2313.5 273.4C2313.5 330.8 2360.1 377.4 2417.5 377.4C2474.9 377.4 2521.5 330.8 2521.5 273.4ZM2404.5 476C2404.5 418.6 2357.9 372 2300.5 372C2243.1 372 2196.5 418.6 2196.5 476C2196.5 533.4 2243.1 580 2300.5 580C2357.9 580 2404.5 533.4 2404.5 476ZM2638.5 476C2638.5 418.6 2591.9 372 2534.5 372C2477.1 372 2430.5 418.6 2430.5 476C2430.5 533.4 2477.1 580 2534.5 580C2591.9 580 2638.5 533.4 2638.5 476ZM295.5 646.5Q273 655 253 655Q223 655 204 639.5Q185 624 185 596Q185 571 198.5 556.5Q212 542 234 534Q256 526 282 521Q308 516 333 511.5Q358 507 378.5 499Q379.4 498.6 380.3 498.3L380 505Q380 546 368 574.5Q356 603 337 620.5Q318 638 295.5 646.5Z"/></svg>`;

// the heap symbol, the same file as site/favicon.svg (test/gate.test.mjs compares them), inlined as
// the tab icon so the door needs no asset; ink on a light tab, paper on a dark one
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><style>path{fill:#16231F}@media (prefers-color-scheme:dark){path{fill:#F2EFE8}}</style><path fill="#16231F" d="M35.3 228.2C35.3 350.1 134.1 448.9 256 448.9C302.6 448.9 345.9 434.4 381.5 409.7V440.4H476.7V98.1H381.5V194Q387.2 198.1 392.2 203.1Q403.9 214.8 410.4 230.1Q417 245.8 417 263.1Q417 280.3 410.4 296.1Q403.9 311.3 392.2 323Q380.5 334.7 365.3 341.1Q349.5 347.8 332.3 347.8Q322.1 347.8 312.5 345.5C295.5 354.5 276.3 359.5 256 359.5C235.7 359.5 216.5 354.5 199.5 345.5Q189.9 347.8 179.7 347.8Q162.5 347.8 146.7 341.1Q131.5 334.7 119.8 323Q108.1 311.3 101.6 296.1Q95 280.3 95 263.1Q95 245.8 101.6 230.1Q108.1 214.8 119.8 203.1Q124.8 198.1 130.5 194V98.1H35.3ZM323.8 130.9C323.8 93.5 293.4 63.1 256 63.1C218.6 63.1 188.2 93.5 188.2 130.9C188.2 168.4 218.6 198.7 256 198.7C293.4 198.7 323.8 168.4 323.8 130.9ZM400.1 263.1C400.1 225.6 369.7 195.3 332.3 195.3C294.8 195.3 264.5 225.6 264.5 263.1C264.5 300.5 294.8 330.9 332.3 330.9C369.7 330.9 400.1 300.5 400.1 263.1ZM247.5 263.1C247.5 225.6 217.2 195.3 179.7 195.3C142.3 195.3 111.9 225.6 111.9 263.1C111.9 300.5 142.3 330.9 179.7 330.9C217.2 330.9 247.5 300.5 247.5 263.1Z"/></svg>`;
const FAVICON = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);

// the door's only script. Without it the form is a plain POST (303 in, or a 401 door that
// shakes). With it the same POST goes by fetch, asking for JSON: a wrong password shakes the
// field in place (no reload), selects it for retyping and fills the live region; a right one
// replaces this document with the collection (a cross-document view transition where the
// browser has them). Anything else (413, 503, a network error) falls back to the native POST.
// It also carries the URL hash into the form and drops the photo if it fails (the ink ground
// shows). Its hash pins it in the CSP; test/gate.test.mjs recomputes the hash from SCRIPT, so
// editing one without the other fails the test.
export const SCRIPT = `(function(){
var d=document,f=d.querySelector("form.door"),i=f.querySelector("input[type=password]"),t=d.getElementById("to"),
b=f.querySelector("button"),a=d.getElementById("wrong"),h=d.querySelector(".hero"),busy=false;
t.value=location.hash;
if(h){if(h.complete&&!h.naturalWidth)h.remove();else h.addEventListener("error",function(){h.remove()})}
if(!window.fetch||!window.URLSearchParams||!window.FormData)return;
function idle(){busy=false;b.disabled=false;f.removeAttribute("aria-busy")}
function wrong(){
f.classList.remove("wrong");void f.offsetWidth;f.classList.add("wrong");
i.setAttribute("aria-invalid","true");i.setAttribute("aria-describedby","wrong");
a.textContent="Wrong password. Try again.";i.focus();i.select()}
function go(to){
var u=new URL(to,location.href);if(u.origin!==location.origin)throw 0;
if(u.pathname+u.search===location.pathname+location.search)history.replaceState(history.state,"",location.pathname+"?");
location.replace(u.href)}
addEventListener("pageshow",idle);
i.addEventListener("input",function(){i.removeAttribute("aria-invalid")});
f.addEventListener("submit",function(e){
e.preventDefault();if(busy)return;
busy=true;b.disabled=true;f.setAttribute("aria-busy","true");a.textContent="";t.value=location.hash;
fetch(f.action,{method:"POST",body:new URLSearchParams(new FormData(f)),credentials:"same-origin",
redirect:"manual",cache:"no-store",headers:{Accept:"application/json"}}).then(function(r){
if(r.status===401){idle();wrong();return}
if(r.status!==200)throw 0;
return r.json().then(function(j){go(j.to)})
}).catch(function(){f.submit()})})
})()`;
export const SCRIPT_HASH = "sha256-k90lN+H5AvmL2DtRhyBDDJH+wy2NrCz1PC80NIAySY8=";
export const CSP = [
  "default-src 'none'",
  "img-src https://drive.google.com https://*.googleusercontent.com data:",
  "font-src 'self'",
  "style-src 'unsafe-inline'",
  `script-src '${SCRIPT_HASH}'`,
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

// plain text of at most max characters, or "" (absent, not a string, too long, control characters)
const text = (v, max) => {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t && t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : "";
};
// the self-hosted fonts the build names in door.json: /static/fonts/<name>.<hash>.woff2 only
const FONT_URL = /^\/static\/fonts\/[a-z0-9-]+\.[0-9a-f]{10}\.woff2$/;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// door(status, wrong, { slug, photo, position, title }) -> Response
// photo: a Drive file id; position: a CSS object-position. Both are checked
// here; anything unexpected drops the photo (the ink ground shows instead).
// title (door.json, else the slug) only names the link preview: crawlers never get
// past the door, so its <head> carries the Open Graph card (title, one line, the door
// photo cropped to 1200x630 by Google's image server). Nothing from data.json, ever.
export function door(status, wrong, opts = {}) {
  const slug = String(opts.slug || "");
  const photo = /^[A-Za-z0-9_-]{10,200}$/.test(opts.photo || "") ? opts.photo : "";
  const title = text(opts.name, 60) || String(opts.title || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || slug;
  const og = [
    ["og:type", "website"], ["og:site_name", "armful"], ["og:title", `${title} on armful`],
    ["og:description", "Find your friends in the photos."],
    ...(photo ? [["og:image", `https://lh3.googleusercontent.com/d/${photo}=w1200-h630-c`], ["og:image:width", "1200"], ["og:image:height", "630"]] : []),
  ].map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join("")
    + `<meta name="twitter:card" content="${photo ? "summary_large_image" : "summary"}">`
    + `<meta name="twitter:title" content="${esc(title)} on armful"><meta name="twitter:description" content="Find your friends in the photos.">`;
  const name = text(opts.name, 60), dates = text(opts.dates, 40);
  const fonts = opts.fonts && typeof opts.fonts === "object" ? opts.fonts : {};
  const font = (k) => (typeof fonts[k] === "string" && FONT_URL.test(fonts[k]) ? fonts[k] : "");
  const fDisplay = name ? font("display") : "", fLabel = dates ? font("label") : "", fText = font("text");
  const faces = [[fDisplay, "Bricolage Grotesque", 700], [fLabel, "Inter", 600], [fText, "Inter", 500]].filter(([u]) => u);
  const fontCss = faces.map(([u, fam, w]) => `@font-face{font-family:"${fam}";font-style:normal;font-weight:${w};font-display:swap;src:url(${u}) format("woff2")}`).join("\n");
  const preload = faces.map(([u]) => `<link rel="preload" href="${u}" as="font" type="font/woff2" crossorigin>`).join("");
  const cover = name
    ? `<div class="cover"><h1 class="name">${esc(name)}</h1>${dates ? `<p class="dates">${esc(dates)}</p>` : ""}</div>`
    : "";
  const pos = /^[a-z0-9 %.-]{1,40}$/i.test(opts.position || "") ? opts.position : "center";
  const img = photo
    ? `<img class="hero" src="https://drive.google.com/thumbnail?id=${esc(photo)}&amp;sz=w1600" alt="" referrerpolicy="no-referrer" decoding="async" fetchpriority="high" style="object-position: ${esc(pos)}">`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="${NOINDEX}"><meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#16231F">
<title>armful</title>
${og}
<link rel="icon" href="${FAVICON}" type="image/svg+xml">
${preload}${photo ? '<link rel="preconnect" href="https://drive.google.com">' : ""}
<style>
${fontCss}
@font-face{font-family:"Bricolage Fallback";font-style:normal;font-weight:700;src:local("Arial Bold"),local("Arial-BoldMT"),local("Helvetica Bold"),local("Helvetica-Bold");size-adjust:99.65%;ascent-override:93.3%;descent-override:27.1%;line-gap-override:0%}
@font-face{font-family:"Inter Fallback";font-style:normal;font-weight:400 500;src:local("Arial"),local("ArialMT"),local("Helvetica");size-adjust:107.2%;ascent-override:90.4%;descent-override:22.5%;line-gap-override:0%}
@font-face{font-family:"Inter Fallback";font-style:normal;font-weight:600 700;src:local("Arial Bold"),local("Arial-BoldMT"),local("Helvetica Bold"),local("Helvetica-Bold");size-adjust:100.8%;ascent-override:96.1%;descent-override:23.9%;line-gap-override:0%}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{min-height:100dvh;background:#16231F;color:#16231F;overflow:hidden;
  font:16px/24px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;
  --pb:max(54px,calc(env(safe-area-inset-bottom) + 24px));--pl:max(22px,env(safe-area-inset-left));--pr:max(22px,env(safe-area-inset-right))}
.hero{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.shade{position:fixed;inset:0;pointer-events:none;background:linear-gradient(to top,rgba(13,15,14,.62),rgba(13,15,14,.34) 24%,rgba(13,15,14,0) 48%),
  linear-gradient(to bottom,rgba(13,15,14,.22),rgba(13,15,14,0) 120px)}
.mark{position:fixed;top:max(22px,calc(env(safe-area-inset-top) + 12px));left:var(--pl);display:block;width:88px;height:auto;
  filter:drop-shadow(0 1px 8px rgba(0,0,0,.3))}
/* the cover: the collection's name and dates, bottom-anchored just above the pill, so it never moves the pill */
.cover{position:fixed;left:0;bottom:calc(var(--pb) + 56px + 24px);width:100%;max-width:640px;padding:0 var(--pr) 0 var(--pl);color:#FBFAF7}
.name{margin:0;font:700 clamp(36px,10vw,64px)/1.05 "Bricolage Grotesque","Bricolage Fallback",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  letter-spacing:-.03em;text-wrap:balance;text-shadow:0 1px 18px rgba(13,15,14,.3)}
.dates{margin:12px 0 0;font:600 clamp(11px,3vw,13px)/16px "Inter","Inter Fallback",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  letter-spacing:.14em;text-transform:uppercase;color:rgba(251,250,247,.8)}
/* fixed height: the pill and its padding, so a slow, streamed first paint moves nothing */
form{position:fixed;left:0;bottom:0;width:100%;max-width:440px;display:flex;flex-direction:column;
  padding:0 var(--pr) var(--pb) var(--pl);height:calc(56px + var(--pb))}
.field{display:flex;align-items:center;gap:10px;height:56px;padding:0 6px 0 20px;border-radius:999px;
  background:rgba(255,255,255,.75);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  box-shadow:0 8px 28px rgba(13,15,14,.18)}
.field:focus-within{outline:2.5px solid #FBFAF7;outline-offset:2px}
input[type=password]{all:unset;flex:1;min-width:0;height:44px;color:#16231F;caret-color:#16231F;font-size:18px;letter-spacing:.18em}
input[type=password]::placeholder{color:#566360;opacity:1;font:500 16px/24px "Inter","Inter Fallback",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em}
.lock{flex:none;display:block;width:16px;height:16px;color:#16231F}
button{all:unset;box-sizing:border-box;flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
  background:#16231F;color:#FBFAF7;cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:transform 120ms cubic-bezier(.2,0,0,1)}
button:active{transform:scale(.94)}
button:focus-visible{outline:2.5px solid #16231F;outline-offset:2px}
button:disabled{cursor:default}
.wrong .field{animation:shake .4s cubic-bezier(.2,0,0,1)}
/* in flight (the script's fetch, the server's 800 ms on a wrong try): the arrow dims and breathes */
.door[aria-busy=true] button{opacity:.7;animation:pulse 1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45;transform:scale(.92)}}
/* same-origin navigations cross-fade (into the collection, when it opts in too) */
@view-transition{navigation:auto}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes shake{20%{transform:translateX(-8px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
@media (min-width:1000px){body{--pb:64px;--pl:max(48px,env(safe-area-inset-left))}form{max-width:480px}.mark{top:40px}.cover{bottom:calc(var(--pb) + 56px + 28px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
${img}<div class="shade"></div>
${MARK}
${cover}
<form method="post" action="/${esc(slug)}/__gate" class="door${wrong ? " wrong" : ""}">
  <div class="field">
    <svg class="lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
    <input type="password" name="p" autocomplete="current-password" aria-label="Password" placeholder="password" ${wrong ? 'aria-invalid="true" aria-describedby="wrong" ' : ""}autofocus required>
    <input type="hidden" name="to" id="to">
    <button type="submit" aria-label="Enter"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
  </div>
  <p class="sr" id="wrong" role="alert">${wrong ? "Wrong password. Try again." : ""}</p>
</form>
<script>${SCRIPT}</script>
</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Vary": "Cookie",
      "X-Robots-Tag": NOINDEX,
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": CSP,
      "X-Frame-Options": "DENY",
    },
  });
}
