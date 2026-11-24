// The door: the password page for one collection, served by the gate middleware.
// Self-contained (inline CSS and wordmark, no fonts, no script beyond the hash
// carry-over and photo fallback) so it renders with nothing else loaded. No words on it except
// aria-labels and the screen-reader alert after a wrong try.
const NOINDEX = "noindex, nofollow, noarchive, noimageindex";

// the heap wordmark, outlined (logo/heap-wordmark.svg), filled paper
const MARK = `<svg class="mark" viewBox="0 0 2987 802" role="img" aria-label="armful"><path fill="#FBFAF7" d="M919 471V748H1063V567Q1063 486 1077.5 435Q1092 384 1116 360.5Q1140 337 1169 337Q1192 337 1207 350.5Q1222 364 1229.5 391Q1237 418 1237 461V748H1378V567Q1378 491 1392 440Q1406 389 1430 363Q1454 337 1485 337Q1508 337 1523 350.5Q1538 364 1545 393Q1552 422 1552 465V748H1696V452Q1696 390 1686 344.5Q1676 299 1656 269Q1636 239 1606 224Q1576 209 1535 209Q1484 209 1448 233Q1412 257 1390 309Q1368 361 1362 445H1353Q1356 364 1341.5 312Q1327 260 1295.5 234.5Q1264 209 1214 209Q1165 209 1130 232.5Q1095 256 1074.5 308Q1054 360 1047 445H1039L1042 223H918ZM120.5 747.5Q156 762 197 762Q251 762 293 738.5Q335 715 361 676Q387 637 392 590H398Q398 632 397 671Q396 710 395 748H522Q522 714 521.5 679.5Q521 645 521 610.5V447Q521 370 496 317Q471 264 421.5 236.5Q372 209 298 209Q257 209 215 219Q173 229 138 252Q103 275 82.5 314.5Q62 354 62 414L191 425Q191 386 206.5 364Q222 342 246 333.5Q270 325 293 325Q332 325 356 342.5Q380 360 380 394Q380 409 371 417.5Q362 426 335.5 431.5Q309 437 256 447Q217 454 179 464Q141 474 109 492Q77 510 58.5 540.5Q40 571 40 619Q40 671 62.5 702Q85 733 120.5 747.5ZM2079 422.5C2079 609.4 2230.6 761 2417.5 761C2489 761 2555.3 738.8 2610 701V748H2756V223H2610V370.1Q2618.7 376.4 2626.4 384.1Q2644.4 402.1 2654.3 425.4Q2664.5 449.6 2664.5 476Q2664.5 502.4 2654.3 526.6Q2644.4 549.9 2626.4 567.9Q2608.4 585.9 2585.1 595.8Q2560.9 606 2534.5 606Q2519 606 2504.2 602.5C2478.1 616.2 2448.7 624 2417.5 624C2386.3 624 2356.9 616.2 2330.8 602.5Q2316 606 2300.5 606Q2274.1 606 2249.9 595.8Q2226.6 585.9 2208.6 567.9Q2190.6 549.9 2180.7 526.6Q2170.5 502.4 2170.5 476Q2170.5 449.6 2180.7 425.4Q2190.6 402.1 2208.6 384.1Q2216.3 376.4 2225 370.1V223H2079ZM1788 418V748H1930V418H2047V306H1949Q1920 306 1901 297Q1882 288 1873 273Q1864 258 1864 240Q1864 210 1883.5 194.5Q1903 179 1935 179Q1962 179 1987 189.5Q2012 200 2040 221L2052 88Q2024 64 1989.5 52Q1955 40 1911 40Q1858 40 1816.5 58Q1775 76 1752 109Q1729 142 1729 186Q1729 211 1740 238.5Q1751 266 1780.5 287Q1810 308 1866 315V323L1712 313V418ZM563 472V748H706V548Q706 490 718.5 449.5Q731 409 755 388Q779 367 813 367Q830 367 850 372.5Q870 378 890 389L898 230Q879 220 860.5 215.5Q842 211 825 211Q790 211 762.5 233Q735 255 717 305.5Q699 356 693 441H685L688 223H562ZM2947 748V53H2803V748ZM2521.5 273.4C2521.5 215.9 2474.9 169.4 2417.5 169.4C2360.1 169.4 2313.5 215.9 2313.5 273.4C2313.5 330.8 2360.1 377.4 2417.5 377.4C2474.9 377.4 2521.5 330.8 2521.5 273.4ZM2404.5 476C2404.5 418.6 2357.9 372 2300.5 372C2243.1 372 2196.5 418.6 2196.5 476C2196.5 533.4 2243.1 580 2300.5 580C2357.9 580 2404.5 533.4 2404.5 476ZM2638.5 476C2638.5 418.6 2591.9 372 2534.5 372C2477.1 372 2430.5 418.6 2430.5 476C2430.5 533.4 2477.1 580 2534.5 580C2591.9 580 2638.5 533.4 2638.5 476ZM295.5 646.5Q273 655 253 655Q223 655 204 639.5Q185 624 185 596Q185 571 198.5 556.5Q212 542 234 534Q256 526 282 521Q308 516 333 511.5Q358 507 378.5 499Q379.4 498.6 380.3 498.3L380 505Q380 546 368 574.5Q356 603 337 620.5Q318 638 295.5 646.5Z"/></svg>`;

// the door's only script: carry the URL hash into the form, and drop the photo
// if it fails (the ink ground shows). Its hash pins it in the CSP; test/gate.test.mjs
// recomputes the hash from SCRIPT, so editing one without the other fails the test.
export const SCRIPT = 'document.getElementById("to").value=location.hash;var h=document.querySelector(".hero");if(h){if(h.complete&&!h.naturalWidth)h.remove();else h.addEventListener("error",function(){h.remove()})}';
export const SCRIPT_HASH = "sha256-9wlUc28uCxLW+iSa8y3ssiyLA46mVGiRxRkXJjSiops=";
export const CSP = [
  "default-src 'none'",
  "img-src https://drive.google.com https://*.googleusercontent.com",
  "style-src 'unsafe-inline'",
  `script-src '${SCRIPT_HASH}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

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
  const title = String(opts.title || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || slug;
  const og = [
    ["og:type", "website"], ["og:site_name", "armful"], ["og:title", `${title} on armful`],
    ["og:description", "Find your friends in the photos."],
    ...(photo ? [["og:image", `https://lh3.googleusercontent.com/d/${photo}=w1200-h630-c`], ["og:image:width", "1200"], ["og:image:height", "630"]] : []),
  ].map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join("")
    + `<meta name="twitter:card" content="${photo ? "summary_large_image" : "summary"}">`
    + `<meta name="twitter:title" content="${esc(title)} on armful"><meta name="twitter:description" content="Find your friends in the photos.">`;
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
${photo ? '<link rel="preconnect" href="https://drive.google.com">' : ""}
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{min-height:100dvh;background:#16231F;color:#16231F;overflow:hidden;
  font:16px/24px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.hero{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.shade{position:fixed;inset:0;pointer-events:none;background:linear-gradient(to top,rgba(13,15,14,.42),rgba(13,15,14,0) 42%)}
form{position:fixed;left:0;bottom:0;width:100%;max-width:440px;display:flex;flex-direction:column;gap:16px;
  padding:0 max(22px,env(safe-area-inset-right)) max(54px,calc(env(safe-area-inset-bottom) + 24px)) max(22px,env(safe-area-inset-left))}
.mark{display:block;height:40px;width:auto;align-self:flex-start;filter:drop-shadow(0 1px 10px rgba(0,0,0,.35))}
.field{display:flex;align-items:center;gap:8px;height:56px;padding:0 6px 0 22px;border-radius:999px;
  background:rgba(255,255,255,.75);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  box-shadow:0 8px 28px rgba(13,15,14,.18)}
.field:focus-within{outline:2.5px solid #FBFAF7;outline-offset:2px}
input[type=password]{all:unset;flex:1;min-width:0;height:44px;color:#16231F;caret-color:#16231F;font-size:18px;letter-spacing:.18em}
button{all:unset;box-sizing:border-box;flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
  background:#16231F;color:#FBFAF7;cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:transform 120ms cubic-bezier(.2,0,0,1)}
button:active{transform:scale(.94)}
button:focus-visible{outline:2.5px solid #16231F;outline-offset:2px}
.wrong .field{animation:shake .4s cubic-bezier(.2,0,0,1)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes shake{20%{transform:translateX(-8px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
@media (min-width:1000px){form{padding-left:max(48px,env(safe-area-inset-left));padding-bottom:64px;max-width:480px}.mark{height:56px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
${img}<div class="shade"></div>
<form method="post" action="/${esc(slug)}/__gate" class="door${wrong ? " wrong" : ""}">
  ${MARK}
  <div class="field">
    <input type="password" name="p" autocomplete="current-password" aria-label="Password" ${wrong ? 'aria-invalid="true" aria-describedby="wrong" ' : ""}autofocus required>
    <input type="hidden" name="to" id="to">
    <button type="submit" aria-label="Enter"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
  </div>
  ${wrong ? '<p class="sr" id="wrong" role="alert">Wrong password. Try again.</p>' : ""}
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
