// armful: shared photos. The wall is every file as a whole photo in justified rows; pictures
// stay in Drive (thumbnails by URL, kept only by the browser's own HTTP cache). A tap on a photo
// opens it large on the page; Drive itself is one small link away.
//
// One state object and one render path. Every change (data arriving, a face held or let go, the
// rail opening, the previewer stepping, the URL's hash) writes `state` and calls render(), which
// compares it with what is on screen (`drawn`) and touches only what differs: nodes are made once
// and then shown, hidden, moved or relabelled, never rebuilt, so nothing on screen flashes.
// The page arrives as a skeleton (static HTML: the header, the pill and a wall of blocks); when
// data.json lands the blocks grow into the real tiles.
//
// The query: the hold (people), plus three filters, AND across them, one value each: how many
// faces a file has (every face the scan found, named people or not), the day of the trip (and the
// part of that day) and the media (videos / photos, portrait / landscape). The URL's hash keeps it:
// #p=3.7&any&n=4&d=3e&m=v&s=p (the old #p=3.7 / #p=3.7&any links read the same).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const nf = (n) => n.toLocaleString("en");
  const drive = (id, sz) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${sz}`;
  const view = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
  // Google-side face crop of the Drive image (FIFE fcrop64: left,top,right,bottom as 0..ffff fractions)
  const h4 = (v) => Math.min(65535, Math.max(0, Math.round(v * 65535))).toString(16).padStart(4, "0");
  const fill = (tpl, k, v) => tpl.replaceAll(`{${k}}`, encodeURIComponent(v));
  const ar = (f) => (f.w && f.h ? f.w / f.h : 16 / 9);
  const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const SPRING = "linear(0, 0.1895, 0.3445, 0.4713, 0.5751, 0.66, 0.7295, 0.7863, 0.8328, 0.8708, 0.902, 0.9274, 0.9483, 0.9653, 0.9793, 0.9907, 1)";
  const EASE = CSS.supports("transition-timing-function", SPRING) ? SPRING : "cubic-bezier(.2, .8, .2, 1)";
  const FADE = "cubic-bezier(.2, 0, 0, 1)";
  // write only what changed (a same-value write is free, but this keeps render() honest)
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setVar = (el, k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
  let D;
  let tiles = []; // one <a class="tile"> per file, in D.files order
  let tilesOf = new Map(); // person id -> indexes of the files they are in
  let wallTiles = []; // the tiles in wall (DOM) order: by day, then time
  let shownTiles = []; // the shown ones, in wall order
  const sections = []; // one per day in wall order, the undated last: { day, el, tag, tick, tiles }

  // ---- the state, and what is on screen ----
  // phase: skeleton (the static first paint) | ready | error. picked / any: the hold. n: a faces
  // band (0 no one, 1, 2 = 2-3, 4 = 4+, 8 = 8+); d: a day of the trip, part: m / a / e within it;
  // m: v videos / f photos; s: p portrait / l landscape (null: any). The URL's hash mirrors them.
  // railOpen: the panel above the pill is open; view: which of its two views (faces | filters).
  // lb: the previewer's place in lbSet (the files the wall showed when it opened), -1 when closed.
  const state = { phase: "skeleton", picked: [], any: false, n: null, d: null, part: null, m: null, s: null,
    railOpen: false, view: "faces", lb: -1 };
  let lbSet = [];
  const drawn = { phase: "skeleton", filter: "", panel: "0|faces", was: { open: false, view: "faces" }, lb: -1, lbSet: null };

  // ---- picture URLs: data.json's `thumbs` templates win (the test fixture, other hosts) ----
  // a wall thumbnail `width` wide
  function thumbUrl(f, width) { return D?.thumbs?.wall ? fill(D.thumbs.wall, "i", f.i) : drive(f.i, width); }
  // a person's round face: Google's 192px server crop of their representative photo
  function faceUrl(p) {
    if (D?.thumbs?.face) return fill(D.thumbs.face, "pid", p.id);
    if (!p.rep) return "";
    const f = D.files[p.rep.f], [x, y, s] = p.rep.box;
    return `https://lh3.googleusercontent.com/d/${encodeURIComponent(f.i)}=w192-h192-fcrop64=1,${h4(x / f.w)}${h4(y / f.h)}${h4((x + s) / f.w)}${h4((y + s) / f.h)}`;
  }
  // the previewer's photo: the largest Drive width the screen can use
  const LB_SIZES = [800, 1200, 1600, 2000, 2600];
  function bigUrl(f) {
    if (D?.thumbs?.big) return fill(D.thumbs.big, "i", f.i);
    const need = Math.min(innerWidth, innerHeight * ar(f)) * dpr();
    return drive(f.i, LB_SIZES.find((z) => z >= need) || LB_SIZES[LB_SIZES.length - 1]);
  }
  // a fresh attempt: r=1, 2, 3… set as a real query parameter (a template's #fragment stays a fragment)
  function retryUrl(u, n) {
    const x = new URL(u, location.href);
    x.searchParams.set("r", n);
    return x.href;
  }

  // ---- time: each file's day of the trip (a day runs 04:00 to 04:00 in the collection's time
  // zone, data.json's tz, UTC without one; day 1 is the first day with a dated file), its part of
  // that day (morning 04-12, afternoon 12-18, evening 18-04), its shape and its faces. A file
  // without a capture time is day 0: the undated section after the last day, in no day filter ----
  const PARTS = { m: "morning", a: "afternoon", e: "evening" };
  let dayOf = [], partOf = [], shapeOf = [], facesOf = [], nDays = 0;
  function clock(tz) {
    const o = { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23" };
    try { return new Intl.DateTimeFormat("en-US", o); } catch { return new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }); }
  }
  function timeline() {
    const fmt = clock(typeof D.tz === "string" && D.tz ? D.tz : "UTC");
    const at = D.files.map((f) => {
      if (typeof f.t !== "number" || !Number.isFinite(f.t)) return null;
      try {
        const p = {};
        for (const x of fmt.formatToParts(new Date(f.t * 1000))) p[x.type] = x.value;
        const h = +p.hour % 24;
        return [Date.UTC(+p.year, +p.month - 1, +p.day) / 864e5 - (h < 4 ? 1 : 0), h];
      } catch { return null; } // a time no date can hold
    });
    let first = Infinity;
    for (const a of at) if (a && a[0] < first) first = a[0];
    dayOf = at.map((a) => (a ? a[0] - first + 1 : 0));
    partOf = at.map((a) => (!a ? "" : a[1] >= 4 && a[1] < 12 ? "m" : a[1] >= 12 && a[1] < 18 ? "a" : "e"));
    shapeOf = D.files.map((f) => (f.h > f.w ? "p" : f.w > f.h ? "l" : ""));
    // every face found, named or not (nf); a build without nf: the people named on it
    facesOf = D.files.map((f) => (Number.isInteger(f.nf) && f.nf >= 0 ? Math.max(f.nf, f.p.length) : f.p.length));
    nDays = dayOf.reduce((a, d) => Math.max(a, d), 0);
  }

  // ---- the wall ----
  const cols = () => (innerWidth >= 1600 ? 5 : innerWidth >= 1000 ? 4 : 2);
  const SIZES = [400, 600, 800, 1000, 1200]; // Drive widths a wall tile may ask for
  const bucket = (px) => SIZES.find((z) => z >= px) || SIZES[SIZES.length - 1];
  // a typical tile's width at the device's pixel ratio, rounded up (the previewer's stand-in size)
  function wallSize() { return bucket((innerWidth / cols()) * dpr()); }
  // this tile's thumbnail width: its rendered width now, at the pixel ratio now, rounded up
  const tileSize = (a) => { const w = a.getBoundingClientRect().width; return w > 0 ? bucket(w * dpr()) : wallSize(); };
  const tileAr = (f) => Math.min(2.4, Math.max(0.62, ar(f))); // panoramas and tall shots crop a little
  const label = (i) => `${D.files[i].v ? "Video" : "Photo"} ${nf(i + 1)} of ${nf(D.files.length)}`;

  // pack the shown tiles into rows of cols(): each tile learns its row's aspect sum (--S), size (--n),
  // whether it may grow (--g) and its fade delay (--d, 12ms per place in the row). Full rows reach
  // both edges; a short last row is ragged (natural height, left-aligned), never stretched.
  // Each day packs its own rows: a day always starts a new row.
  function layout() {
    const n = cols();
    for (const sec of sections) {
      const shown = sec.tiles.filter((t) => !t.hidden);
      for (let k = 0; k < shown.length; k += n) {
        const row = shown.slice(k, k + n), full = row.length === n;
        let S = row.reduce((a, t) => a + +t.style.getPropertyValue("--ar"), 0);
        if (!full) S += (n - row.length) * 1.5;
        row.forEach((t, j) => {
          setVar(t, "--S", S.toFixed(3));
          setVar(t, "--n", String(n));
          setVar(t, "--g", full ? "1" : "0");
          setVar(t, "--d", `${j * 12}ms`);
        });
      }
    }
  }

  // load a tile's thumbnail one viewport (in px: % margins resolve against width) before it scrolls in
  let near = null;
  function watch() {
    near?.disconnect();
    near = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { near.unobserve(e.target); start(e.target); }
    }, { rootMargin: `${Math.round(innerHeight)}px 0px` });
    for (const a of tiles) if (!a.querySelector("img").getAttribute("src")) near.observe(a);
  }
  function start(a) {
    const img = a.querySelector("img");
    if (!img.getAttribute("src")) img.src = thumbUrl(D.files[+a.dataset.n], tileSize(a));
  }
  // a failed thumbnail: the tile keeps its box, shows a hairline and a retry glyph; the link itself
  // retries on click / Enter (and keeps focus), until the picture arrives
  function failed(a) {
    a.classList.add("failed");
    a.setAttribute("aria-label", "Try again");
    if (!a.querySelector(".retry")) a.insertAdjacentHTML("beforeend", '<span class="retry" aria-hidden="true"><svg><use href="#i-retry"/></svg></span>');
  }
  function recovered(a) {
    a.classList.remove("failed");
    a.querySelector(".retry")?.remove();
    setAttr(a, "aria-label", label(+a.dataset.n));
  }
  function retry(a) {
    const img = a.querySelector("img"), n = (+a.dataset.r || 0) + 1;
    a.dataset.r = n;
    img.src = retryUrl(thumbUrl(D.files[+a.dataset.n], tileSize(a)), n);
  }

  // the tiles, made once (not yet in the page: mount() puts them in)
  function buildWall() {
    tiles = D.files.map((f, i) => {
      const a = document.createElement("a");
      a.className = "tile"; a.dataset.n = i;
      a.href = view(f.i); a.target = "_blank"; a.rel = "noopener noreferrer";
      a.style.setProperty("--ar", tileAr(f).toFixed(3));
      a.setAttribute("aria-label", label(i));
      const img = new Image();
      img.loading = "lazy"; img.decoding = "async"; img.alt = ""; img.referrerPolicy = "no-referrer";
      img.onload = () => { recovered(a); img.classList.add("ok"); };
      img.onerror = () => { a.dataset.err = (+a.dataset.err || 0) + 1; failed(a); };
      a.append(img);
      if (f.v) a.insertAdjacentHTML("beforeend", '<span class="play"><svg aria-hidden="true"><use href="#i-play"/></svg></span>');
      return a;
    });
    // the days: a section each (made once; mount() puts them in), the undated last
    timeline();
    const seq = D.files.map((_, i) => i).sort((a, c) => (!dayOf[a]) - (!dayOf[c]) || (dayOf[a] ? D.files[a].t - D.files[c].t : 0) || a - c);
    const byDay = new Map();
    for (const i of seq) { if (!byDay.has(dayOf[i])) byDay.set(dayOf[i], []); byDay.get(dayOf[i]).push(tiles[i]); }
    for (const day of [...byDay.keys()].sort((a, c) => (!a) - (!c) || a - c)) {
      const el = document.createElement("section"), rows = document.createElement("div");
      el.className = "day"; el.dataset.day = day;
      el.setAttribute("aria-label", day ? `Day ${day}` : "Undated");
      rows.className = "rows";
      rows.append(...byDay.get(day));
      let tag = null;
      if (nDays) { // a collection without capture times has no days to name
        const t = document.createElement("div");
        t.className = "tag"; t.setAttribute("aria-hidden", "true");
        tag = document.createElement("span");
        tag.textContent = day ? `Day ${day}` : "Undated";
        t.append(tag);
        el.append(t);
      }
      el.append(rows);
      sections.push({ day, el, tag, tick: null, tiles: byDay.get(day) });
    }
    wallTiles = sections.flatMap((x) => x.tiles);
    // a plain click opens the previewer (a failed tile retries instead); the href stays for
    // new-tab clicks and as the no-script fallback
    $("wall").addEventListener("click", (e) => {
      const a = e.target.closest(".tile");
      if (!a) return;
      if (a.classList.contains("failed")) { e.preventDefault(); retry(a); return; }
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      lbOpen(+a.dataset.n);
    });
    tilesOf = new Map();
    D.files.forEach((f, i) => f.p.forEach((pid) => { if (!tilesOf.has(pid)) tilesOf.set(pid, []); tilesOf.get(pid).push(i); }));
    for (const q of [matchMedia("(min-width: 1000px)"), matchMedia("(min-width: 1600px)")]) q.addEventListener("change", layout);
    let raf = 0, h = innerHeight;
    addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (innerHeight !== h) { h = innerHeight; watch(); } placeTicks(); dayTag(); }); });
  }

  // tiles within a viewport above / below the screen, found by binary search over `list` (in DOM
  // order, so their tops only grow): a few rect reads, never the whole wall
  function nearby(list) {
    const lo = -innerHeight, hi = 2 * innerHeight;
    let a = 0, b = list.length;
    while (a < b) { const m = (a + b) >> 1; if (list[m].getBoundingClientRect().bottom > lo) b = m; else a = m + 1; }
    const out = new Map();
    for (let k = a; k < list.length; k++) { const r = list[k].getBoundingClientRect(); if (r.top >= hi) break; out.set(list[k], r); }
    return out;
  }
  const flipFrom = (b, r) => `translate(${b.left - r.left}px, ${b.top - r.top}px) scale(${b.width / r.width}, ${b.height / r.height})`;
  // show exactly the files with ok[i]; tiles near the screen travel to their new places on the
  // spring (FLIP), the rest just snap. Reads first, then writes; reduced motion reads nothing.
  function setShown(ok, animate = !motion.matches) {
    const was = animate ? nearby(shownTiles) : null;
    tiles.forEach((t, i) => { if (t.hidden !== !ok[i]) t.hidden = !ok[i]; });
    shownTiles = wallTiles.filter((t) => !t.hidden);
    for (const sec of sections) { const h = !sec.tiles.some((t) => !t.hidden); if (sec.el.hidden !== h) sec.el.hidden = h; }
    layout();
    $("empty").hidden = shownTiles.length > 0;
    if (!animate) return;
    const now = nearby(shownTiles); // one layout, then only reads
    const moves = [];
    for (const [t, r] of now) {
      const b = was.get(t);
      if (!b) { moves.push([t, null]); continue; } // newly near: fades in where it lands
      const dx = b.left - r.left, dy = b.top - r.top, sx = b.width / r.width, sy = b.height / r.height;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || Math.abs(sx - 1) >= 0.01 || Math.abs(sy - 1) >= 0.01)
        moves.push([t, flipFrom(b, r)]);
    }
    if (!moves.length) return;
    for (const [t, tf] of moves) { t.style.transition = "none"; if (tf) t.style.transform = tf; else t.style.opacity = "0"; }
    void document.body.offsetWidth; // commit the starting positions
    for (const [t] of moves) { t.style.transition = ""; t.style.transform = ""; t.style.opacity = ""; }
  }

  // ---- people: one pill bottom-left; it opens a narrow rail of faces up the left edge ----
  const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  let byId = new Map();
  let peopleN = 0; // people in the list: everyone data.json names
  const faceEls = new Map(); // person id -> { btn, b, li } in the list
  let faceIo = null;
  // a face picture: Google's server crop, or for a rotated photo (Google crops the raw, unrotated
  // pixels) a CSS crop of Drive's upright thumbnail; a person without a face to show stays a cream disc
  function paintFace(img, p) {
    if (!p || img.getAttribute("src")) return;
    if (D.thumbs?.face || (p.rep && !p.rep.c)) { const u = faceUrl(p); if (u) img.src = u; return; }
    if (!p.rep || !D.files[p.rep.f]) return;
    const f = D.files[p.rep.f], [x, y, s] = p.rep.box;
    img.src = BLANK;
    img.style.backgroundImage = `url("${thumbUrl(f, p.rep.sz || 400)}")`;
    img.style.backgroundSize = `${(f.w / s) * 100}% auto`;
    img.style.backgroundPosition = `${f.w > s ? (x / (f.w - s)) * 100 : 0}% ${f.h > s ? (y / (f.h - s)) * 100 : 0}%`;
  }
  function faceImg() {
    const img = new Image();
    img.alt = ""; img.decoding = "async"; img.referrerPolicy = "no-referrer"; img.draggable = false;
    return img;
  }
  function faceEl(p) {
    const li = document.createElement("li"), btn = document.createElement("button"), b = document.createElement("b");
    btn.type = "button"; btn.className = "face"; btn.dataset.pid = p.id;
    btn.setAttribute("aria-pressed", "false");
    btn.append(faceImg());
    b.className = "count"; b.dataset.pid = p.id; b.setAttribute("aria-hidden", "true");
    li.append(btn, b);
    faceEls.set(p.id, { btn, b, li });
    faceIo.observe(btn);
    return li;
  }
  // the number beside every face, and the zeros faded and moved last (the rest keep their order,
  // so the list stays still under the thumb)
  function updateCounts(countFor) {
    const zero = new Set();
    for (const [pid, e] of faceEls) {
      const n = countFor(pid);
      setText(e.b, nf(n));
      if (e.btn.classList.contains("dim") !== (n === 0)) e.btn.classList.toggle("dim", n === 0);
      setAttr(e.btn, "aria-label", `Person ${pid}, ${nf(n)} photos`);
      if (n === 0) zero.add(pid);
    }
    const ol = $("listMain");
    const want = [...ol.children].sort((a, c) => (zero.has(+a.dataset.pid) - zero.has(+c.dataset.pid)) || a.dataset.k - c.dataset.k);
    if (want.some((li, k) => ol.children[k] !== li)) ol.append(...want);
  }
  // ---- the panel above the pill: open or folded, and which view (faces | filters). The filter icon
  // swaps the two in one motion: the view on screen folds away into the pill and the other opens
  // in its place ----
  // open or folded, in the view it had (a public helper for the tests and the pill)
  function panelOpen(open) { state.railOpen = !!open; render(); }
  function openView(view) { state.railOpen = true; state.view = view; render(); }
  const panelKey = () => `${state.railOpen ? 1 : 0}|${state.view}`;
  function drawPanel() {
    const was = drawn.was, open = state.railOpen, view = state.view, list = $("list"), filt = $("filters");
    drawn.was = { open, view };
    setAttr($("chev"), "aria-expanded", String(open));
    setAttr($("chev"), "aria-label", open ? "Fold" : "Open");
    setAttr($("people"), "aria-expanded", String(open && view === "faces"));
    setAttr($("fbtn"), "aria-expanded", String(open && view === "filters"));
    document.body.classList.toggle("panelOpen", open);
    for (const el of [list, filt]) for (const an of el.getAnimations({ subtree: true })) if (!(an instanceof CSSTransition)) an.finish();
    if (!open) { list.hidden = true; filt.hidden = true; return; }
    const inEl = view === "faces" ? list : filt, outEl = view === "faces" ? filt : list;
    const swap = was.open && was.view !== view && !motion.matches;
    if (swap) { $("panel").classList.add("swap"); foldAway(outEl); } else outEl.hidden = true;
    inEl.hidden = false;
    if (swap) { unfold(inEl, 90); requestAnimationFrame(() => requestAnimationFrame(() => $("panel").classList.remove("swap"))); }
  }
  // the panel's pieces that travel: the faces, or the filters' labels and rows
  function pieces(el) {
    const box = el.getBoundingClientRect();
    const kids = el.classList.contains("list") ? [...el.querySelectorAll("li")] : [...el.querySelectorAll(".frow:not([hidden]) > .lbl, .frow:not([hidden]) > .opts, .partsWrap.on")];
    return kids.filter((k) => { const r = k.getBoundingClientRect(); return r.height > 0 && r.bottom > box.top && r.top < box.bottom; });
  }
  // the outgoing view, frozen as a copy where it is, closes down into the pill (the far end first)
  function foldAway(el) {
    const r = el.getBoundingClientRect(), scroll = el.scrollTop;
    const ghost = el.cloneNode(true);
    ghost.removeAttribute("id"); ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    ghost.setAttribute("aria-hidden", "true"); ghost.inert = true; ghost.hidden = false;
    Object.assign(ghost.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      margin: 0, bottom: "auto", maxHeight: "none", zIndex: 11, pointerEvents: "none", transition: "none" });
    el.hidden = true;
    document.body.append(ghost);
    ghost.scrollTop = scroll;
    const kids = pieces(ghost);
    kids.forEach((k, j) => k.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(22px) scale(.55)", opacity: 0 }],
      { duration: 260, delay: j * 14, easing: FADE, fill: "forwards" }));
    const an = ghost.animate([{ clipPath: "inset(0 0 0 0 round 24px)" }, { clipPath: "inset(100% 0 0 0 round 24px)" }],
      { duration: 300 + kids.length * 8, easing: FADE, fill: "forwards" });
    const done = () => ghost.remove();
    an.onfinish = done; an.oncancel = done;
    setTimeout(done, 1200);
  }
  // the incoming view opens up from the pill, its pieces rising one after another (the near end first)
  function unfold(el, delay) {
    el.animate([{ clipPath: "inset(100% 0 0 0 round 24px)" }, { clipPath: "inset(0 0 0 0 round 0px)" }], { duration: 420, delay, easing: EASE, fill: "backwards" });
    const faces = el.classList.contains("list");
    [...pieces(el)].reverse().forEach((k, j) => k.animate([{ transform: `translateY(18px) scale(${faces ? 0.6 : 0.96})`, opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 420, delay: delay + j * (faces ? 16 : 32), easing: EASE, fill: "backwards" }));
  }
  function buildPeople() {
    byId = new Map(D.people.map((p) => [p.id, p]));
    const main = D.people;
    // faces in the list load only once it is open, a little ahead of the scroll inside it
    faceIo = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { faceIo.unobserve(e.target); paintFace(e.target.firstChild, byId.get(+e.target.dataset.pid)); }
    }, { root: $("list"), rootMargin: "200px 0px" });
    const fillList = (ol, ps) => ol.append(...ps.map((p, k) => { const li = faceEl(p); li.dataset.pid = p.id; li.dataset.k = k; return li; }));
    fillList($("listMain"), main);
    peopleN = main.length;
    // the collapsed pill's three faces load with the page, in the places of the skeleton's discs
    $("people").querySelector(".stack").replaceChildren(...[...main].sort((a, c) => c.n - a.n).slice(0, 3).map((p) => { const i = faceImg(); paintFace(i, p); return i; }));

    // the faces: open them (or swap to them); on screen already: fold
    $("people").onclick = () => (state.railOpen && state.view === "faces" ? panelOpen(false) : openView("faces"));
    // the filter icon: open the filters, or swap between the two views
    $("fbtn").onclick = () => openView(state.railOpen && state.view === "filters" ? "faces" : "filters");
    // the chevron: open (to the view it had) or fold
    $("chev").onclick = () => panelOpen(!state.railOpen);
    // the panel stays open while the wall scrolls and taps through; only the pill or Esc folds it
    // (an Esc the previewer already took is not ours)
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || !state.railOpen || state.lb >= 0) return;
      e.preventDefault();
      panelOpen(false);
      $("chev").focus();
    });
  }

  // ---- the filters: three rows of options, made once; drawFilter() relabels them ----
  const BANDS = [[0, "no one"], [1, "1"], [2, "2–3"], [4, "4+"], [8, "8+"]];
  const inBand = (b, k) => (b === 0 ? k === 0 : b === 1 ? k === 1 : b === 2 ? k >= 2 && k <= 3 : k >= b);
  const opts = []; // { el, c, label, get: counts -> n, on: () => bool, patch, unpatch }
  function opt(parent, html, label, get, on, patch, unpatch) {
    const el = document.createElement("button");
    el.type = "button"; el.className = "opt";
    el.innerHTML = `<span class="v">${html}</span><span class="c"></span>`;
    parent.append(el);
    const o = { el, c: el.lastChild, label, get, on, patch, unpatch };
    // a tap chooses it; a tap on the chosen one clears it; a zero takes no tap
    el.addEventListener("click", () => {
      if (el.classList.contains("zero")) return;
      setQuery(o.on() ? o.unpatch : o.patch);
    });
    opts.push(o);
  }
  function buildFilters() {
    for (const [b, w] of BANDS) opt($("optN"), w, b === 0 ? "No one" : `${w} ${b === 1 ? "face" : "faces"}`, (c) => c.n[b], () => state.n === b, { n: b }, { n: null });
    $("rowD").hidden = !nDays;
    $("optD").style.setProperty("--cols", String(nDays <= 6 ? Math.max(1, nDays) : nDays <= 12 ? 6 : 7)); // past 12 days: a week a row
    for (let d = 1; d <= nDays; d++) opt($("optD"), String(d), `Day ${d}`, (c) => c.d[d], () => state.d === d, { d, part: null }, { d: null, part: null });
    for (const [k, w] of Object.entries(PARTS)) opt($("optP"), w, w[0].toUpperCase() + w.slice(1), (c) => c.part[k], () => state.part === k, { part: k }, { part: null });
    opt($("optM"), "all", "All media", (c) => c.m.all, () => state.m == null, { m: null }, { m: null });
    opt($("optM"), "videos", "Videos", (c) => c.m.v, () => state.m === "v", { m: "v" }, { m: null });
    opt($("optM"), "photos", "Photos", (c) => c.m.f, () => state.m === "f", { m: "f" }, { m: null });
    opt($("optS"), '<svg aria-hidden="true"><use href="#i-port"/></svg>portrait', "Portrait", (c) => c.s.p, () => state.s === "p", { s: "p" }, { s: null });
    opt($("optS"), '<svg aria-hidden="true"><use href="#i-land"/></svg>landscape', "Landscape", (c) => c.s.l, () => state.s === "l", { s: "l" }, { s: null });
  }
  function setQuery(patch) { Object.assign(state, patch); render(); save(); }
  // one pass over the files for the query in `q`: which files show (ok), which pass the filters
  // apart from the hold (F), and for every option the files tapping it would give, the other rows
  // as they are (c)
  function evaluate(q = state) {
    const sel = new Set(q.picked), N = D.files.length, ok = new Array(N), F = new Array(N);
    const c = { n: { 0: 0, 1: 0, 2: 0, 4: 0, 8: 0 }, d: new Array(nDays + 1).fill(0), part: { m: 0, a: 0, e: 0 }, m: { all: 0, v: 0, f: 0 }, s: { p: 0, l: 0 } };
    let shown = 0;
    for (let i = 0; i < N; i++) {
      const f = D.files[i], k = facesOf[i];
      const pp = !sel.size || (q.any ? f.p.some((p) => sel.has(p)) : q.picked.every((p) => f.p.includes(p)));
      const pn = q.n == null || inBand(q.n, k);
      const pd = q.d == null || (dayOf[i] === q.d && (!q.part || partOf[i] === q.part));
      const pm = !q.m || (q.m === "v") === !!f.v;
      const ps = !q.s || shapeOf[i] === q.s;
      if (pp && pd && pm && ps) for (const [b] of BANDS) if (inBand(b, k)) c.n[b]++;
      if (pp && pn && pm && ps && dayOf[i]) { c.d[dayOf[i]]++; if (dayOf[i] === q.d) c.part[partOf[i]]++; }
      if (pp && pn && pd && ps) { c.m.all++; c.m[f.v ? "v" : "f"]++; }
      if (pp && pn && pd && pm && shapeOf[i]) c.s[shapeOf[i]]++;
      F[i] = pn && pd && pm && ps;
      ok[i] = pp && F[i];
      if (ok[i]) shown++;
    }
    return { ok, F, shown, c };
  }
  const filtering = () => state.n != null || state.d != null || state.m != null || state.s != null;
  const active = () => state.picked.length > 0 || filtering();
  // what is chosen, in a few words: together / any (two or more held), then the filters
  function terms() {
    const t = [];
    if (state.picked.length >= 2) t.push(state.any ? "any" : "together");
    if (state.n != null) t.push(state.n === 0 ? "no one" : state.n === 1 ? "solo" : BANDS.find(([b]) => b === state.n)[1]);
    if (state.d != null) t.push(`Day ${state.d}${state.part ? " " + PARTS[state.part] : ""}`);
    if (state.m) t.push(state.m === "v" ? "videos" : "photos");
    if (state.s) t.push(state.s === "p" ? "portrait" : "landscape");
    return t;
  }
  // every option's count: the files you would get by tapping it; the chosen one shows what the
  // wall shows (tapping it again clears it). Zeros fade and take no tap.
  function drawOptions(ev) {
    for (const o of opts) {
      const on = o.on(), n = on ? ev.shown : o.get(ev.c), zero = n === 0 && !on;
      setText(o.c, nf(n));
      setAttr(o.el, "aria-pressed", String(on));
      if (o.el.classList.contains("zero") !== zero) o.el.classList.toggle("zero", zero);
      setAttr(o.el, "aria-disabled", String(zero));
      setAttr(o.el, "aria-label", `${o.label}, ${plural(n, "file")}`);
    }
    const parts = $("partsWrap"), on = state.d != null;
    if (parts.classList.contains("on") !== on) { parts.classList.toggle("on", on); parts.inert = !on; }
  }

  // ---- the hold: who is held, and whether the wall shows photos with all of them (together, the
  // default) or with any of them (any: a tap on the held faces, unannounced) ----
  const plural = (n, w) => `${nf(n)} ${w}${n === 1 ? "" : "s"}`;
  // the header's count cells: a small icon (person, photo, play) and the number
  const statIcon = {
    p: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="3.6" r="2.3"/><path d="M1.6 11.2c0-2.6 2-4.3 4.4-4.3s4.4 1.7 4.4 4.3z"/></svg>',
    f: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill-rule="evenodd" d="M1 2.2h10v7.6H1zM2.2 8.6h7.6L7.4 5.2 5.6 7.4 4.4 6.2z"/></svg>',
    v: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8l7.2 4.2L3 10.2z"/></svg>' };
  const statCell = (k, n) => `<span class="st st-${k}" aria-hidden="true">${statIcon[k]}${nf(n)}</span>`;
  // which files have everyone in `sel` (together) or anyone in it (any); nobody held: every file
  function matches(sel, any) {
    if (!sel.size) return D.files.map(() => true);
    return D.files.map((f) => (any ? f.p.some((p) => sel.has(p)) : [...sel].every((p) => f.p.includes(p))));
  }
  // the number beside a face: the count you would get by tapping it, the filters as they are (one
  // pass over the files: tally counts each person over the shown files, beyond over the files the
  // filters pass that the hold does not show)
  let shownN = 0, tally = new Map(), beyond = new Map();
  function countFor(pid) {
    const t = tally.get(pid) || 0;
    if (!state.picked.length || !state.any) return t; // nobody held: theirs; together: shown ∩ theirs
    return shownN + (beyond.get(pid) || 0); // any: shown ∪ theirs
  }
  // the held faces, small, into `el` (the pill; the previewer reuses it): at most four, then +N.
  // Faces already there stay (their pictures never reload); only the difference is added or removed.
  function renderPair(el, picked = state.picked) {
    const have = new Map([...el.querySelectorAll(":scope > .face")].map((s) => [+s.dataset.pid, s]));
    const kids = picked.slice(0, 4).map((pid) => {
      if (have.has(pid)) return have.get(pid);
      const s = document.createElement("span"), img = faceImg();
      s.className = "face held"; s.dataset.pid = pid;
      paintFace(img, byId.get(pid));
      s.append(img);
      return s;
    });
    if (picked.length > 4) {
      const m = el.querySelector(":scope > .more") || Object.assign(document.createElement("span"), { className: "more" });
      setText(m, `+${nf(picked.length - 4)}`);
      kids.push(m);
    }
    for (const c of [...el.children]) if (!kids.includes(c)) c.remove();
    kids.forEach((c, j) => { if (el.children[j] !== c) el.insertBefore(c, el.children[j] || null); });
  }
  // the wall, the counts, the options and the pill for the query in `state`
  function drawFilter(animate) {
    const sel = new Set(state.picked), ev = evaluate(), { ok, F } = ev, k = state.picked.length;
    shownN = ev.shown; tally = new Map(); beyond = new Map();
    ok.forEach((y, i) => {
      if (!y && !F[i]) return;
      const m = y ? tally : beyond;
      for (const p of new Set(D.files[i].p)) m.set(p, (m.get(p) || 0) + 1);
    });
    setShown(ok, animate);
    updateCounts(countFor);
    for (const [pid, e] of faceEls) {
      const h = sel.has(pid);
      if (e.btn.classList.contains("held") !== h) e.btn.classList.toggle("held", h);
      setAttr(e.btn, "aria-pressed", String(h));
    }
    drawOptions(ev);
    // the pill: the held faces (or the three), the filter icon with the words of what is chosen,
    // and × while anything is; no count (the header has it)
    const words = terms();
    $("bar").classList.toggle("held", k > 0);
    $("pair").hidden = !k;
    $("clear").hidden = !active();
    $("terms").hidden = !words.length;
    setText($("terms"), words.join(" · "));
    setAttr($("fbtn"), "aria-label", words.length ? `Filters: ${words.join(", ")}` : "Filters");
    // for screen readers: the pill's label and the live line say the numbers
    setText($("peopleLabel"), active() ? plural(shownN, "photo") : `${nf(peopleN)} people`);
    setAttr($("people"), "aria-label", k ? `People filter, ${nf(k)} held, ${plural(shownN, "photo")}` : `People filter, ${nf(peopleN)} people`);
    // the header follows the wall: the files shown, and everyone in the list who is in them
    let inShown = 0;
    for (const pid of tally.keys()) if (byId.has(pid)) inShown++;
    // icons instead of words, so long counts never clip; the words go on aria-label
    let vids = 0;
    ok.forEach((y, i) => { if (y && D.files[i].v) vids++; });
    const pics = shownN - vids, st = $("stats");
    const said = `${nf(inShown)} ${inShown === 1 ? "person" : "people"} · ${plural(pics, "photo")}` + (vids ? ` · ${plural(vids, "video")}` : "");
    const html = statCell("p", inShown) + statCell("f", pics) + (vids ? statCell("v", vids) : "");
    if (st.dataset.h !== html) { st.innerHTML = html; st.dataset.h = html; }
    setAttr(st, "aria-label", said);
    const pair = $("pair");
    renderPair(pair);
    pair.classList.toggle("tight", !state.any);
    pair.classList.toggle("apart", state.any);
    setAttr(pair, "aria-label", "Held: " + state.picked.map((p) => `Person ${p}`).join(", "));
    // nothing together: say so, and offer to let go
    setText($("empty").querySelector("p"), k >= 2 && !state.any && !filtering() ? "No photos of them together" : "No photos");
    $("empty").querySelector("button").hidden = !active();
    requestAnimationFrame(() => { placeTicks(); dayTag(); });
  }
  const filterKey = () => JSON.stringify([state.picked, state.any, state.n, state.d, state.part, state.m, state.s]);
  // the URL keeps the query: #p=3.7&any&n=4&d=3e&m=v&s=p (each part only when chosen)
  function save() {
    const h = [];
    if (state.picked.length) h.push(`p=${state.picked.join(".")}`, ...(state.any ? ["any"] : []));
    if (state.n != null) h.push(`n=${state.n}`);
    if (state.d != null) h.push(`d=${state.d}${state.part || ""}`);
    if (state.m) h.push(`m=${state.m}`);
    if (state.s) h.push(`s=${state.s}`);
    const s = h.length ? "#" + h.join("&") : "";
    if (s !== location.hash) history.replaceState(history.state, "", s || location.pathname + location.search);
  }
  // the query from the URL: unknown, hidden or malformed parts are dropped silently
  function load() {
    const kv = new Map();
    for (const x of location.hash.replace(/^#/, "").split("&")) {
      if (!x) continue;
      const j = x.indexOf("="), key = j < 0 ? x : x.slice(0, j);
      if (!kv.has(key)) kv.set(key, j < 0 ? "" : x.slice(j + 1));
    }
    state.picked = [...new Set((kv.get("p") || "").split(".").filter((x) => /^\d{1,9}$/.test(x)).map(Number))].filter((p) => byId.has(p));
    state.any = state.picked.length > 0 && kv.has("any");
    state.n = /^[01248]$/.test(kv.get("n") || "") ? +kv.get("n") : null;
    const dm = /^(\d{1,4})([mae])?$/.exec(kv.get("d") || "");
    state.d = dm && +dm[1] >= 1 && +dm[1] <= nDays ? +dm[1] : null;
    state.part = state.d != null && dm[2] ? dm[2] : null;
    state.m = ["v", "f"].includes(kv.get("m")) ? kv.get("m") : null;
    state.s = ["p", "l"].includes(kv.get("s")) ? kv.get("s") : null;
  }
  function toggle(pid) {
    const k = state.picked.indexOf(pid);
    if (k >= 0) state.picked.splice(k, 1); else state.picked.push(pid);
    if (!state.picked.length) state.any = false;
    render(); save();
  }
  function setAny(any) { state.any = any; render(); save(); }
  function clear() { setQuery({ picked: [], any: false, n: null, d: null, part: null, m: null, s: null }); }
  // a tapped face springs along an arc from the list into the hold (a copy flies; the real one
  // waits hidden until it lands); reduced motion: it is simply there
  function fly(from, pid) {
    if (motion.matches) return;
    const src = from.querySelector("img"), to = $("pair").querySelector(`.face[data-pid="${pid}"] img`) || $("pair");
    const a = src.getBoundingClientRect(), z = to.getBoundingClientRect();
    if (!a.width || !z.width) return;
    const c = src.cloneNode();
    c.className = "arc"; c.alt = "";
    Object.assign(c.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
    document.body.append(c);
    to.style.visibility = "hidden";
    // a quadratic curve whose control point lifts it above the straight line
    const dx = z.left - a.left, dy = z.top - a.top, s = z.width / a.width, cx = dx * 0.5 + 40, cy = Math.min(0, dy) - 70;
    const frames = [];
    for (let j = 0; j <= 12; j++) {
      const t = j / 12, u = 1 - t;
      frames.push({ offset: t, transform: `translate(${2 * u * t * cx + t * t * dx}px, ${2 * u * t * cy + t * t * dy}px) scale(${1 + (s - 1) * t})` });
    }
    const an = c.animate(frames, { duration: 420, easing: EASE });
    const done = () => { c.remove(); to.style.visibility = ""; };
    an.onfinish = done; an.oncancel = done;
  }
  function buildHold() {
    $("listMain").addEventListener("click", (e) => {
      const btn = e.target.closest(".face");
      if (!btn) return;
      const pid = +btn.dataset.pid, adding = !state.picked.includes(pid);
      toggle(pid);
      if (adding) fly(btn, pid);
    });
    // the held faces: two or more toggle together / any; one held, they are the faces button
    $("pair").onclick = () => { if (state.picked.length >= 2) setAny(!state.any); else $("people").onclick(); };
    $("clear").onclick = clear;
    $("empty").querySelector("button").onclick = clear;
    addEventListener("hashchange", () => { load(); render(); });
  }

  // ---- the day labels: each names its day and the part of the day of the row under it ----
  function dayTag() {
    if (!nDays || !shownTiles.length) return null;
    const y = 30; // the middle of a stuck label
    let a = 0, b = shownTiles.length;
    while (a < b) { const m = (a + b) >> 1; if (shownTiles[m].getBoundingClientRect().bottom > y) b = m; else a = m + 1; }
    const top = +shownTiles[Math.min(a, shownTiles.length - 1)].dataset.n;
    for (const sec of sections) {
      if (sec.el.hidden || !sec.tag) continue;
      if (!sec.day) { setText(sec.tag, "Undated"); continue; }
      const i = sec.day === dayOf[top] ? top : +sec.tiles.find((t) => !t.hidden).dataset.n;
      setText(sec.tag, `Day ${sec.day} · ${PARTS[partOf[i]]}`);
    }
    return top;
  }

  // ---- the day scrubber: a tick per day (its length: the day's files in the query), a thumb for
  // the screen; drag or tap to go there. It never filters ----
  const scrub = $("scrub");
  let hideT = 0, dragging = false, docH = 1;
  function placeTicks() {
    if (!nDays || state.phase !== "ready") return;
    docH = document.documentElement.scrollHeight;
    const H = scrub.clientHeight, per = new Map();
    for (const t of shownTiles) { const d = dayOf[+t.dataset.n]; if (d) per.set(d, (per.get(d) || 0) + 1); }
    let max = 1;
    for (const v of per.values()) max = Math.max(max, v);
    for (const sec of sections) {
      if (!sec.day) continue;
      if (!sec.tick) { sec.tick = document.createElement("i"); sec.tick.className = "tk"; $("ticks").append(sec.tick); }
      const n = per.get(sec.day) || 0;
      if (sec.tick.hidden !== !n) sec.tick.hidden = !n;
      if (!n) continue;
      const y = ((sec.el.getBoundingClientRect().top + scrollY) / docH) * H;
      sec.tick.style.transform = `translateY(${y.toFixed(1)}px) scaleX(${((5 + (11 * n) / max) / 16).toFixed(3)})`;
    }
    placeThumb();
  }
  function placeThumb() {
    const H = scrub.clientHeight, th = $("thumb");
    th.style.transform = `translateY(${((scrollY / docH) * H).toFixed(1)}px)`; // a transform: scrolling never shifts layout
    const h = `${Math.max(20, (innerHeight / docH) * H).toFixed(1)}px`;
    if (th.style.height !== h) th.style.height = h;
  }
  const scrubbable = () => nDays > 0 && docH > 3 * innerHeight && state.lb < 0;
  function wake() {
    if (!scrubbable()) { scrub.classList.remove("on"); return; }
    scrub.classList.add("on");
    clearTimeout(hideT);
    if (!dragging) hideT = setTimeout(() => scrub.classList.remove("on"), 1200);
  }
  function jump(clientY) {
    const r = scrub.getBoundingClientRect(), f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    scrollTo(0, Math.min(f * docH, docH - innerHeight));
    const top = dayTag();
    $("bubble").style.transform = `translateY(${(f * r.height).toFixed(1)}px) translateY(-50%)`;
    if (top != null) setText($("bubble"), dayOf[top] ? `Day ${dayOf[top]} · ${PARTS[partOf[top]]}` : "Undated");
  }
  scrub.addEventListener("pointerdown", (e) => {
    if (!scrub.classList.contains("on")) return;
    e.preventDefault();
    dragging = true; scrub.setPointerCapture(e.pointerId); scrub.classList.add("drag");
    jump(e.clientY); wake();
  });
  scrub.addEventListener("pointermove", (e) => { if (dragging) jump(e.clientY); });
  const endDrag = () => { if (!dragging) return; dragging = false; scrub.classList.remove("drag"); wake(); };
  scrub.addEventListener("pointerup", endDrag);
  scrub.addEventListener("pointercancel", endDrag);
  let scrollRaf = 0;
  addEventListener("scroll", () => {
    if (state.phase !== "ready") return;
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => { placeThumb(); dayTag(); });
    wake();
  }, { passive: true });
  const slug = decodeURIComponent(location.pathname.split("/")[1] || "") || "armful";

  // ---- previewer (lightbox): the photo large on the page, stepping through what the wall shows ----
  const lbx = { from: null, token: 0, entry: false };
  function preload(i) {
    const f = D.files[i];
    if (!f || f.v) return;
    const im = new Image(); im.referrerPolicy = "no-referrer"; im.src = bigUrl(f);
  }
  // the photo (or video) at state.lb into the stage; the old one goes in the same frame
  function lbShow() {
    const k = state.lb, i = lbSet[k], f = D.files[i], stage = $("lbStage"), token = ++lbx.token;
    stage.style.setProperty("--ar", ar(f));
    $("lbDrive").href = view(f.i);
    $("lbPrev").disabled = k === 0;
    $("lbNext").disabled = k === lbSet.length - 1;
    $("lb").setAttribute("aria-label", f.v ? "Video" : "Photo");
    $("lbCount").textContent = `${nf(k + 1)} / ${nf(lbSet.length)}`; // files, in wall order
    stage.className = "lbStage"; stage.style.transform = ""; stage.style.opacity = "";
    const thumb = tiles[i]?.querySelector("img")?.currentSrc || thumbUrl(f, wallSize()); // the wall's own thumbnail: already here
    if (f.v) { // Drive's own player: plays inline, with controls, without leaving the page
      // until it has loaded (and settled), the wall's thumbnail stands in, dimmed, with the
      // loading mark; then the player fades in over it. Never a bare black frame.
      const box = document.createElement("div"), poster = new Image(), fr = document.createElement("iframe");
      box.className = "vid";
      poster.className = "poster"; poster.alt = ""; poster.referrerPolicy = "no-referrer"; poster.draggable = false;
      poster.decoding = "sync"; poster.src = thumb;
      const mark = $("markTpl").content.firstElementChild.cloneNode(true);
      fr.allow = "autoplay; fullscreen"; fr.allowFullscreen = true; fr.referrerPolicy = "no-referrer"; fr.title = "Video";
      fr.addEventListener("load", () => setTimeout(() => {
        if (token !== lbx.token) return;
        box.classList.add("ready");
        setTimeout(() => mark.remove(), 300);
      }, 300), { once: true });
      fr.src = `https://drive.google.com/file/d/${encodeURIComponent(f.i)}/preview`;
      box.append(poster, mark, fr);
      stage.replaceChildren(box);
    } else {
      const img = new Image();
      img.alt = ""; img.referrerPolicy = "no-referrer"; img.draggable = false;
      // decoded in the frame it is shown: the stand-in never paints as an empty box
      img.decoding = "sync"; img.className = "soft"; img.src = thumb;
      stage.replaceChildren(img);
      const big = new Image();
      big.alt = ""; big.referrerPolicy = "no-referrer"; big.draggable = false;
      // decoded: the same element takes the large picture (no second entrance animation)
      big.onload = () => (big.decode ? big.decode() : Promise.resolve()).catch(() => {}).then(() => {
        if (token === lbx.token) { img.src = big.src; img.classList.remove("soft"); }
      });
      big.onerror = () => { if (token === lbx.token && !big.dataset.retry) { big.dataset.retry = 1; setTimeout(() => (big.src = retryUrl(bigUrl(f), 1)), 1200); } };
      big.src = bigUrl(f);
    }
    preload(lbSet[k + 1]); preload(lbSet[k - 1]);
  }
  const onScreen = (r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  function lbOpen(i) {
    const set = []; // what the wall shows, in order
    for (const t of shownTiles) set.push(+t.dataset.n);
    const k = set.indexOf(i);
    if (k < 0) return;
    lbSet = set; state.lb = k; lbx.from = tiles[i];
    render();
  }
  function lbClose() { if (state.lb >= 0) { state.lb = -1; render(); } }
  function lbStep(d) {
    const k = state.lb + d;
    if (state.lb < 0 || k < 0 || k >= lbSet.length) return;
    state.lb = k; render();
  }
  function drawLb() {
    const was = drawn.lb, now = state.lb, sameSet = drawn.lbSet === lbSet;
    drawn.lb = now; drawn.lbSet = lbSet;
    if (now < 0) { if (was >= 0) lbHide(); return; }
    if (was < 0 || !sameSet) { lbReveal(); return; }
    lbShow();
    $("lbStage").classList.add(now > was ? "in-next" : "in-prev");
  }
  function lbReveal() {
    // the query, small at the bottom: the held faces (no words for them, as before) and the
    // filters' words (nothing when nothing is chosen)
    const k = state.picked.length;
    $("lbHold").hidden = !active();
    $("lbPair").hidden = !k;
    if (k) {
      renderPair($("lbPair"));
      $("lbPair").className = `pair ${state.any ? "apart" : "tight"}`;
    } else $("lbPair").replaceChildren();
    setText($("lbLine"), terms().filter((w) => w !== "together" && w !== "any").join(" · "));
    const from = !motion.matches && lbx.from ? lbx.from.getBoundingClientRect() : null;
    $("lb").hidden = false;
    document.body.classList.add("lbOpen");
    lbShow();
    $("lbClose").focus();
    // the photo grows out of its tile on the spring (the dark fades in under it)
    const el = $("lbStage").firstElementChild;
    if (from && el && onScreen(from)) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) el.animate([{ transformOrigin: "0 0", transform: flipFrom(from, r) }, { transformOrigin: "0 0", transform: "none" }], { duration: 420, easing: EASE });
    }
    // the phone's Back button closes the previewer instead of leaving the page (one extra history entry, reused)
    if (!lbx.entry) { history.pushState({ lb: 1 }, ""); lbx.entry = true; }
  }
  function lbHide() {
    if ($("lb").hidden) return;
    lbx.token++;
    const el = $("lbStage").firstElementChild, pic = el?.tagName === "IMG" ? el : el?.querySelector(".poster");
    const r = pic && !motion.matches ? el.getBoundingClientRect() : null;
    $("lb").hidden = true;
    $("lbStage").replaceChildren(); // also stops a playing video
    document.body.classList.remove("lbOpen");
    const t = tiles[lbSet[lastK]] || lbx.from; // back to the tile last looked at
    if (!t) return;
    t.focus({ preventScroll: true }); t.scrollIntoView({ block: "nearest" });
    // the photo travels back into its tile while the dark fades
    const to = t.getBoundingClientRect();
    if (!r || !r.width || !onScreen(to)) return;
    const g = pic.cloneNode(), ground = document.createElement("div");
    g.className = "ghost"; g.decoding = "sync"; g.removeAttribute("style");
    Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    ground.className = "ghostGround";
    document.body.append(ground, g);
    const a = g.animate([{ transform: "none" }, { transform: `translate(${to.left - r.left}px, ${to.top - r.top}px) scale(${to.width / r.width}, ${to.height / r.height})` }], { duration: 420, easing: EASE });
    ground.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: "cubic-bezier(.2, 0, 0, 1)", fill: "forwards" });
    const done = () => { g.remove(); ground.remove(); };
    a.onfinish = done; a.oncancel = done;
  }
  let lastK = -1; // the previewer's last place, for the tile focus goes back to
  addEventListener("popstate", () => {
    lbx.entry = false;
    if (state.lb >= 0) lbClose();
  });
  $("lbPrev").onclick = () => lbStep(-1);
  $("lbNext").onclick = () => lbStep(1);
  $("lbClose").onclick = lbClose;
  $("lb").addEventListener("click", (e) => { if (e.target === $("lb") || e.target === $("lbStage")) lbClose(); });
  addEventListener("keydown", (e) => {
    if (state.lb < 0) return;
    if (e.key === "Escape") { e.preventDefault(); lbClose(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); lbStep(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); lbStep(1); }
    else if (e.key === "Tab") { // keep focus inside the dialog
      const els = [...$("lb").querySelectorAll("button:not([disabled]), a[href]")];
      const at = els.indexOf(document.activeElement);
      e.preventDefault();
      els[(at + (e.shiftKey ? -1 : 1) + els.length) % els.length].focus();
    }
  });
  { // touch: the photo follows the finger; swipe left / right to step, swipe down to close
    let x0 = null, y0 = 0, axis = "";
    const stage = $("lbStage"), zoomed = () => (window.visualViewport ? visualViewport.scale > 1.05 : false);
    $("lb").addEventListener("touchstart", (e) => {
      x0 = e.touches.length === 1 && !zoomed() ? e.touches[0].clientX : null; y0 = e.touches[0].clientY; axis = "";
      stage.classList.remove("back", "in-next", "in-prev");
    }, { passive: true });
    $("lb").addEventListener("touchmove", (e) => {
      if (x0 == null) return;
      if (e.touches.length > 1) { x0 = null; stage.style.transform = ""; stage.style.opacity = ""; return; } // a pinch
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dx) > Math.abs(dy) ? "x" : dy > 0 ? "y" : "-";
      if (axis === "x") { // resist at the two ends
        const end = (dx > 0 && state.lb === 0) || (dx < 0 && state.lb === lbSet.length - 1);
        stage.style.transform = `translateX(${end ? dx / 4 : dx}px)`;
      } else if (axis === "y" && dy > 0) { stage.style.transform = `translateY(${dy}px)`; stage.style.opacity = String(Math.max(0.3, 1 - dy / 500)); }
    }, { passive: true });
    const end = (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0], dx = t ? t.clientX - x0 : 0, dy = t ? t.clientY - y0 : 0;
      x0 = null;
      const k = state.lb;
      if (e.type === "touchend" && Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) lbStep(dx < 0 ? 1 : -1);
      else if (e.type === "touchend" && axis === "y" && dy > 110 && dy > 1.5 * Math.abs(dx)) return lbClose();
      if (state.lb === k) { stage.classList.add("back"); stage.style.transform = ""; stage.style.opacity = ""; } // not far enough: settle back
    };
    $("lb").addEventListener("touchend", end, { passive: true });
    $("lb").addEventListener("touchcancel", end, { passive: true });
  }

  // ---- the one render path ----
  function render() {
    if (state.phase !== drawn.phase) drawPhase();
    if (state.phase !== "ready") return;
    const f = filterKey();
    if (f !== drawn.filter) { drawn.filter = f; drawFilter(); }
    const p = panelKey();
    if (p !== drawn.panel) { drawn.panel = p; drawPanel(); }
    if (state.lb >= 0) lastK = state.lb;
    if (state.lb !== drawn.lb || (state.lb >= 0 && lbSet !== drawn.lbSet)) drawLb();
  }
  function drawPhase() {
    drawn.phase = state.phase;
    document.body.dataset.phase = state.phase;
    if (state.phase === "ready") mount();
    else if (state.phase === "error") { // say so, in the blocks' place, and offer another go
      $("skel")?.remove();
      const p = loading.querySelector("p");
      p.textContent = "The photos didn’t load.";
      p.classList.remove("sr");
      loading.classList.add("failed");
      tryAgain.hidden = false;
    }
  }
  // the skeleton becomes the wall: the blocks on screen are measured, the tiles go in (already
  // filtered by the URL's hold) and each tile on screen takes the block's place. The build writes
  // the blocks from this collection's data, so a tile normally has its block's box exactly and
  // nothing moves; only where they differ (a hold in the URL, an unbuilt page) does a tile grow out
  // of its block on the spring. Tiles past the blocks just appear. One read, one write, one read.
  function mount() {
    const skel = $("skel");
    const from = skel && !motion.matches ? [...skel.querySelectorAll("i")].map((b) => b.getBoundingClientRect()).filter(onScreen) : [];
    $("wall").append(...sections.map((x) => x.el));
    drawn.filter = filterKey();
    drawFilter(false);
    loading.hidden = true;
    foot.inert = false;
    $("panel").inert = false;
    skel?.remove();
    watch();
    if (!from.length) return;
    let k = 0;
    for (const [t, r] of nearby(shownTiles)) {
      if (!onScreen(r)) continue;
      const b = from[k++];
      if (!b) break;
      if (Math.abs(b.left - r.left) < 0.5 && Math.abs(b.top - r.top) < 0.5 && Math.abs(b.width - r.width) < 0.5 && Math.abs(b.height - r.height) < 0.5) continue;
      t.animate([{ transform: flipFrom(b, r) }, { transform: "none" }], { duration: 420, easing: EASE });
    }
  }

  const loading = $("loading");
  const tryAgain = loading.querySelector("button");
  tryAgain.onclick = () => location.reload();
  // the fields the wall reads, checked before anything is published or mounted. The shape itself
  // (an object, a files list, string thumbs templates, a people list) must hold or nothing loads; a
  // single malformed file or person is dropped instead, so one bad entry never hides the rest.
  const num = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
  const okFile = (f) => !!f && typeof f === "object" && typeof f.i === "string" && f.i !== "" &&
    num(f.w) && num(f.h) && Array.isArray(f.p) && (f.v == null || typeof f.v === "number" || typeof f.v === "boolean");
  const okPerson = (p) => !!p && typeof p === "object" && Number.isInteger(p.id);
  // the data the page can use, or null; files are filtered before anything indexes them, and a
  // person's rep (an index into files) follows its file or, if that file was dropped, goes
  function usable(d) {
    if (!d || typeof d !== "object" || !Array.isArray(d.files)) return null;
    if (d.thumbs != null && (typeof d.thumbs !== "object" ||
        ["wall", "face", "big"].some((k) => d.thumbs[k] != null && typeof d.thumbs[k] !== "string"))) return null;
    if (d.people != null && !Array.isArray(d.people)) return null;
    const at = new Map(), files = [];
    d.files.forEach((f, k) => { if (okFile(f)) { at.set(k, files.length); files.push(f); } });
    const people = (d.people || []).filter(okPerson);
    const skipped = d.files.length - files.length + (d.people || []).length - people.length;
    // uncertain people (x, kept only by a debugging build) are not shown, counted or filtered on
    const unsure = new Set(people.filter((p) => p.x).map((p) => p.id));
    if (unsure.size) {
      for (const f of files) f.p = f.p.filter((i) => !unsure.has(i));
      people.splice(0, people.length, ...people.filter((p) => !unsure.has(p.id)));
    }
    if (!files.length) return null;
    for (const p of people) {
      if (p.rep == null) continue;
      if (typeof p.rep === "object" && at.has(p.rep.f)) p.rep.f = at.get(p.rep.f);
      else delete p.rep;
    }
    if (skipped) console.warn(`armful: skipped ${skipped} malformed entries`);
    return Object.assign(d, { files, people });
  }
  // recent armfuls, for the home page's Recent row (home/index.html documents the shape):
  // newest first, at most 6, one per slug, only { slug, title, door, t }. Never blocks the page.
  const SLUG = /^[a-z0-9-]{6,}$/, DOOR_ID = /^[A-Za-z0-9_-]{10,200}$/;
  const RESERVED = ["app", "api", "a", "c", "about", "login", "new", "open", "static", "_"];
  const okSlug = (x) => typeof x === "string" && SLUG.test(x) && !RESERVED.includes(x);
  const okTitle = (x) => typeof x === "string" && x.trim() !== "" && x.trim().length <= 80;
  function clean(r) {
    if (!r || typeof r !== "object" || !okSlug(r.slug)) return null;
    return { slug: r.slug, title: okTitle(r.title) ? r.title.trim() : r.slug,
      door: typeof r.door === "string" && DOOR_ID.test(r.door) ? r.door : null,
      t: typeof r.t === "number" && Number.isFinite(r.t) ? r.t : 0 };
  }
  function remember(door) {
    try {
      if (!okSlug(slug)) return;
      let old = [];
      try { old = JSON.parse(localStorage.getItem("armful:recent") || "[]"); } catch {}
      if (!Array.isArray(old)) old = [];
      const out = [clean({ slug, title: D.title, door, t: Date.now() })];
      for (const r of old) { const c = clean(r); if (c && !out.some((o) => o.slug === c.slug)) out.push(c); }
      localStorage.setItem("armful:recent", JSON.stringify(out.slice(0, 6)));
    } catch {} // private mode, quota, storage off
  }
  function rememberLater() {
    try {
      fetch("door.json", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && typeof j.photo === "string" ? j.photo : null), () => null)
        .then(remember, () => remember(null));
    } catch {}
  }
  const foot = document.querySelector("footer");
  fetch("data.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => {
    const u = usable(d);
    if (!u) throw new Error("data.json: unexpected shape");
    D = u;
    buildWall();
    buildPeople();
    buildFilters();
    buildHold();
    load();
    state.phase = "ready";
    render();
    rememberLater();
  }).catch((e) => {
    if (state.phase === "ready") throw e; // a bug after mounting is not a failed download
    state.phase = "error";
    render();
  });

  // for the panel, the hold and the tests
  window.armful = { thumbUrl, faceUrl, bigUrl, wallSize, setShown, layout, updateCounts, panelOpen,
    state, render, matches, countFor, toggle, setAny, clear, renderPair, openView, setQuery, evaluate, terms,
    get D() { return D; }, get tiles() { return tiles; }, get tilesOf() { return tilesOf; },
    get wallTiles() { return wallTiles; }, get days() { return { dayOf, partOf, shapeOf, facesOf, nDays }; } };
})();
