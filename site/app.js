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
  // write only what changed (a same-value write is free, but this keeps render() honest)
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setVar = (el, k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
  let D;
  let tiles = []; // one <a class="tile"> per file, in D.files order
  let tilesOf = new Map(); // person id -> indexes of the files they are in

  // ---- the state, and what is on screen ----
  // phase: skeleton (the static first paint) | ready | error. picked / any: the hold (the URL's
  // hash mirrors them). railOpen / moreOpen: the faces rail and its "+N more". lb: the previewer's
  // place in lbSet (the files the wall showed when it opened), -1 when closed.
  const state = { phase: "skeleton", picked: [], any: false, railOpen: false, moreOpen: false, lb: -1 };
  let lbSet = [];
  const drawn = { phase: "skeleton", filter: "", rail: false, more: false, lb: -1, lbSet: null };

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
  function layout() {
    const n = cols(), shown = tiles.filter((t) => !t.hidden);
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
    addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (innerHeight !== h) { h = innerHeight; watch(); } }); });
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
    const was = animate ? nearby(tiles.filter((t) => !t.hidden)) : null;
    let shown = 0;
    tiles.forEach((t, i) => { if (t.hidden !== !ok[i]) t.hidden = !ok[i]; if (ok[i]) shown++; });
    layout();
    $("empty").hidden = shown > 0;
    if (!animate) return;
    const now = nearby(tiles.filter((t) => !t.hidden)); // one layout, then only reads
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
  let peopleN = 0; // people shown in the list (not the +N more)
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
    for (const ol of [$("listMain"), $("listMore")]) {
      const want = [...ol.children].sort((a, c) => (zero.has(+a.dataset.pid) - zero.has(+c.dataset.pid)) || a.dataset.k - c.dataset.k);
      if (want.some((li, k) => ol.children[k] !== li)) ol.append(...want);
    }
  }
  // the rail: open or folded (a public helper for the tests and the pill)
  function panelOpen(open) { state.railOpen = !!open; render(); }
  function drawRail() {
    const open = state.railOpen;
    $("list").hidden = !open;
    setAttr($("people"), "aria-expanded", String(open));
    document.body.classList.toggle("panelOpen", open);
  }
  function drawMore() {
    $("listMore").hidden = !state.moreOpen;
    setAttr($("more"), "aria-expanded", String(state.moreOpen));
  }
  function buildPeople() {
    byId = new Map(D.people.map((p) => [p.id, p]));
    const main = D.people.filter((p) => !p.x), rest = D.people.filter((p) => p.x);
    // faces in the list load only once it is open, a little ahead of the scroll inside it
    faceIo = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { faceIo.unobserve(e.target); paintFace(e.target.firstChild, byId.get(+e.target.dataset.pid)); }
    }, { root: $("list"), rootMargin: "200px 0px" });
    const fillList = (ol, ps) => ol.append(...ps.map((p, k) => { const li = faceEl(p); li.dataset.pid = p.id; li.dataset.k = k; return li; }));
    fillList($("listMain"), main);
    fillList($("listMore"), rest);
    $("more").hidden = !rest.length;
    $("more").textContent = `+${nf(rest.length)} more`;
    peopleN = main.length;
    // the collapsed pill's three faces load with the page, in the places of the skeleton's discs
    $("people").querySelector(".stack").replaceChildren(...[...main].sort((a, c) => c.n - a.n).slice(0, 3).map((p) => { const i = faceImg(); paintFace(i, p); return i; }));

    $("people").onclick = () => panelOpen(!state.railOpen);
    $("more").onclick = () => { state.moreOpen = !state.moreOpen; render(); };
    // the rail stays open while the wall scrolls and taps through; only the pill or Esc folds it
    // (an Esc the previewer already took is not ours)
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || !state.railOpen || state.lb >= 0) return;
      e.preventDefault();
      panelOpen(false);
      $("people").focus();
    });
  }
  // ---- the hold: who is held, and whether the wall shows photos with all of them (together, the
  // default) or with any of them (any: a tap on the held faces, unannounced). The URL keeps it:
  // #p=3.7 / #p=3.7&any ----
  const plural = (n, w) => `${nf(n)} ${w}${n === 1 ? "" : "s"}`;
  // which files have everyone in `sel` (together) or anyone in it (any); nobody held: every file
  function matches(sel, any) {
    if (!sel.size) return D.files.map(() => true);
    return D.files.map((f) => (any ? f.p.some((p) => sel.has(p)) : [...sel].every((p) => f.p.includes(p))));
  }
  // the number beside a face: the count you would get by tapping it (one pass over the shown files)
  let shownN = 0, tally = new Map();
  function countFor(pid) {
    const n = (tilesOf.get(pid) || []).length, t = tally.get(pid) || 0;
    if (!state.picked.length) return n;
    return state.any ? shownN + n - t : t; // any: shown ∪ theirs; together: shown ∩ theirs
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
  // the wall, the counts and the pill for the hold in `state`
  function drawFilter(animate) {
    const sel = new Set(state.picked), ok = matches(sel, state.any), k = state.picked.length;
    shownN = 0; tally = new Map();
    ok.forEach((y, i) => {
      if (!y) return;
      shownN++;
      for (const p of new Set(D.files[i].p)) tally.set(p, (tally.get(p) || 0) + 1);
    });
    setShown(ok, animate);
    updateCounts(countFor);
    for (const [pid, e] of faceEls) {
      const h = sel.has(pid);
      if (e.btn.classList.contains("held") !== h) e.btn.classList.toggle("held", h);
      setAttr(e.btn, "aria-pressed", String(h));
    }
    // the pill: nobody held, three faces and the people; someone held, their faces, the count and ×
    $("bar").classList.toggle("held", k > 0);
    $("pair").hidden = $("clear").hidden = !k;
    setText($("peopleLabel"), k ? plural(shownN, "photo") : `${nf(peopleN)} people`);
    const pair = $("pair");
    renderPair(pair);
    pair.classList.toggle("tight", !state.any);
    pair.classList.toggle("apart", state.any);
    setAttr(pair, "aria-label", "Held: " + state.picked.map((p) => `Person ${p}`).join(", "));
    // nothing together: say so, and offer to let go
    setText($("empty").querySelector("p"), k >= 2 && !state.any ? "No photos of them together" : "No photos");
    $("empty").querySelector("button").hidden = !k;
  }
  const filterKey = () => `${state.picked.join(".")}|${state.any ? 1 : 0}`;
  function save() {
    const h = state.picked.length ? `#p=${state.picked.join(".")}${state.any ? "&any" : ""}` : "";
    if (h !== location.hash) history.replaceState(history.state, "", h || location.pathname + location.search);
  }
  // the hold from the URL: unknown, hidden or malformed ids are dropped silently
  function load() {
    const m = location.hash.match(/^#p=([^&]*)/);
    state.picked = m ? [...new Set(m[1].split(".").filter((x) => /^\d{1,9}$/.test(x)).map(Number))].filter((p) => byId.has(p)) : [];
    state.any = state.picked.length > 0 && /&any(&|$)/.test(location.hash);
  }
  function toggle(pid) {
    const k = state.picked.indexOf(pid);
    if (k >= 0) state.picked.splice(k, 1); else state.picked.push(pid);
    if (!state.picked.length) state.any = false;
    render(); save();
  }
  function setAny(any) { state.any = any; render(); save(); }
  function clear() { state.picked = []; state.any = false; render(); save(); }
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
    for (const ol of [$("listMain"), $("listMore")]) ol.addEventListener("click", (e) => {
      const btn = e.target.closest(".face");
      if (!btn) return;
      const pid = +btn.dataset.pid, adding = !state.picked.includes(pid);
      toggle(pid);
      if (adding) fly(btn, pid);
    });
    // the held faces: two or more toggle together / any; one held, they open the rail like the pill
    $("pair").onclick = () => { if (state.picked.length >= 2) setAny(!state.any); else panelOpen(!state.railOpen); };
    $("clear").onclick = clear;
    $("empty").querySelector("button").onclick = clear;
    addEventListener("hashchange", () => { load(); render(); });
  }
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
    tiles.forEach((t, j) => { if (!t.hidden) set.push(j); });
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
    // the hold, small at the bottom: the held faces only (nothing when no one is held)
    const k = state.picked.length;
    $("lbHold").hidden = !k;
    if (k) {
      renderPair($("lbPair"));
      $("lbPair").className = `pair ${state.any ? "apart" : "tight"}`;
    } else $("lbPair").replaceChildren();
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
    if (state.moreOpen !== drawn.more) { drawn.more = state.moreOpen; drawMore(); }
    if (state.railOpen !== drawn.rail) { drawn.rail = state.railOpen; drawRail(); }
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
  // filtered by the URL's hold) and each tile on screen grows out of the block in its place on
  // the spring; tiles past the blocks just appear. One read, one write, one read.
  function mount() {
    const skel = $("skel");
    const from = skel && !motion.matches ? [...skel.children].map((b) => b.getBoundingClientRect()).filter(onScreen) : [];
    $("wall").append(...tiles);
    drawn.filter = filterKey();
    drawFilter(false);
    setText($("stats"), `${nf(peopleN)} people · ${plural(D.files.length, "photo")}`);
    loading.hidden = true;
    foot.inert = false;
    $("panel").inert = false;
    skel?.remove();
    watch();
    if (!from.length) return;
    let k = 0;
    for (const [t, r] of nearby(tiles.filter((x) => !x.hidden))) {
      if (!onScreen(r)) continue;
      const b = from[k++];
      if (!b) break;
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
    state, render, matches, countFor, toggle, setAny, clear, renderPair,
    get D() { return D; }, get tiles() { return tiles; }, get tilesOf() { return tilesOf; } };
})();
