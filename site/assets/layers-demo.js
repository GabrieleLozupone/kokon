// The Layers lab demo (kokon.app home + /image-to-layers/): the Halloween poster from the 0.12 video
// and the real layers Kokon made from it (cut-outs + the background it painted behind them). Split
// opens the stack in 3D, then each object can be dragged, hidden or shown. Positions are percent of
// the 1328 px square poster; the spider layer is wider than the frame (it was completed with Expand).
(() => {
  const root = document.querySelector("[data-layers-demo]");
  if (!root) return;
  const SRC = "/assets/img/layers/";
  // Bottom to top, as in the app's layer list.
  const LAYERS = [
    { id: "text", name: "Text", x: 19.8, y: 2.11, w: 59.94, h: 20.18 },
    { id: "bats", name: "Bats", x: 15.29, y: 4.14, w: 69.65, h: 32.98 },
    { id: "ghosts", name: "Ghosts", x: 8.36, y: 38.1, w: 79.67, h: 20.56 },
    { id: "spider", name: "Spider", x: 62.88, y: 75.83, w: 46.99, h: 24.17 },
    { id: "girl", name: "Girl", x: 28.09, y: 23.49, w: 41.64, h: 69.73 },
  ];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const eye = (on) =>
    on
      ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.5 9.5 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  root.innerHTML = `
    <div class="ld-stage">
      <div class="ld-scene clip" aria-label="A Halloween poster that can be split into layers">
        <img class="ld-layer bg" src="${SRC}background.webp" alt="" style="--z:0" draggable="false">
        ${LAYERS.map((l, i) => `<img class="ld-layer" data-id="${l.id}" src="${SRC}${l.id}.webp" alt="" draggable="false" style="--z:${i + 1};left:${l.x}%;top:${l.y}%;width:${l.w}%;height:${l.h}%">`).join("")}
        <img class="ld-photo" src="${SRC}photo.webp" alt="A Halloween poster: a girl with a pumpkin, ghosts, bats, a spider and the words Happy Halloween" draggable="false">
      </div>
      <div class="ld-flash"></div>
      <div class="ld-hint" role="status"></div>
      <button class="btn primary small ld-go" type="button">Split into layers</button>
    </div>
    <div class="ld-side">
      <div class="ld-panel">
        <h3>Layers <small>Experimental</small></h3>
        <div class="ld-rows"><div class="ld-empty">One image. Press Split into layers.</div></div>
      </div>
      <div class="ld-export">
        <h3>Export to PSD</h3>
        <p>Every layer in a PSD for Photoshop, GIMP or Photopea.</p>
        <button class="btn ghost small ld-psd" type="button" disabled>Export PSD</button>
      </div>
    </div>`;
  const scene = root.querySelector(".ld-scene");
  const go = root.querySelector(".ld-go");
  const hint = root.querySelector(".ld-hint");
  const rows = root.querySelector(".ld-rows");
  const flash = root.querySelector(".ld-flash");
  const psd = root.querySelector(".ld-psd");
  psd.addEventListener("click", () => say("In Kokon this saves a PSD with these six layers"));
  const el = Object.fromEntries(LAYERS.map((l) => [l.id, scene.querySelector(`[data-id="${l.id}"]`)]));
  const state = Object.fromEntries(LAYERS.map((l) => [l.id, { x: l.x, y: l.y, hidden: false }]));
  let selected = null;
  let split = false;

  // Alpha masks (small) to pick the object under the pointer, not its bounding box.
  const masks = {};
  LAYERS.forEach((l) => {
    const im = new Image();
    im.src = SRC + l.id + ".webp";
    im.decode().then(() => {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = Math.max(1, Math.round((160 * im.naturalHeight) / im.naturalWidth));
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(im, 0, 0, c.width, c.height);
      masks[l.id] = { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
    }, () => {});
  });
  const hit = (px, py) => {
    for (let i = LAYERS.length - 1; i >= 0; i--) {
      const l = LAYERS[i], s = state[l.id], m = masks[l.id];
      if (s.hidden) continue;
      const u = (px - s.x) / l.w, v = (py - s.y) / l.h;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
      if (!m) return l.id;
      if (m.data[(Math.floor(v * m.h) * m.w + Math.floor(u * m.w)) * 4 + 3] > 40) return l.id;
    }
    return null;
  };

  const place = (id) => { el[id].style.left = state[id].x + "%"; el[id].style.top = state[id].y + "%"; el[id].classList.toggle("hidden", state[id].hidden); };
  const select = (id) => {
    selected = id;
    LAYERS.forEach((l) => el[l.id].classList.toggle("sel", l.id === id));
    rows.querySelectorAll(".ld-row").forEach((r) => r.classList.toggle("sel", r.dataset.id === id));
  };
  const say = (text) => { hint.textContent = text; hint.classList.toggle("on", !!text); };

  function drawRows() {
    rows.innerHTML =
      [...LAYERS].reverse().map((l) => `<div class="ld-row" data-id="${l.id}"><img src="${SRC}${l.id}.webp" alt=""><span>${l.name}</span><button class="ld-eye" type="button" aria-label="Hide ${l.name}">${eye(true)}</button></div>`).join("") +
      `<div class="ld-row"><img src="${SRC}background.webp" alt=""><span>Background</span></div><button class="btn ghost small ld-reset" type="button">Back to the photo</button>`;
    rows.querySelectorAll(".ld-row[data-id]").forEach((r) => {
      const id = r.dataset.id;
      r.addEventListener("click", () => select(id));
      r.querySelector(".ld-eye").addEventListener("click", (e) => {
        e.stopPropagation();
        state[id].hidden = !state[id].hidden;
        place(id);
        e.currentTarget.innerHTML = eye(!state[id].hidden);
        e.currentTarget.setAttribute("aria-label", `${state[id].hidden ? "Show" : "Hide"} ${LAYERS.find((l) => l.id === id).name}`);
      });
    });
    rows.querySelector(".ld-reset").addEventListener("click", reset);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
  async function doSplit() {
    if (split) return;
    split = true;
    go.remove();
    scene.classList.add("split");
    drawRows();
    if (!reduced) {
      say("Each object on its own layer, the background painted in behind");
      // The photo fades out while the picture is still flat; only then does it open in 3D.
      await wait(550);
      scene.classList.remove("clip");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      scene.classList.add("open");
      await wait(2400);
      say("");
      scene.classList.add("landing");
      scene.classList.remove("open");
      await wait(1900);
      scene.classList.remove("landing");
      scene.classList.add("clip");
      flash.classList.remove("on");
      void flash.offsetWidth;
      flash.classList.add("on");
      await wait(500);
    }
    psd.disabled = false;
    scene.classList.add("ready");
    // Show once what a move does: the spider slides in from the edge, whole (completed with Expand).
    say("Drag anything: the street behind it is already there");
    select("spider");
    const from = state.spider.x, to = 26, t0 = performance.now(), dur = reduced ? 1 : 1400;
    await new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        state.spider.x = from + (to - from) * e;
        place("spider");
        t < 1 ? requestAnimationFrame(step) : done();
      };
      requestAnimationFrame(step);
    });
    await wait(2600);
    say("");
  }
  async function reset() {
    scene.classList.remove("ready");
    select(null);
    say("");
    LAYERS.forEach((l) => { el[l.id].style.transition = "left 0.7s cubic-bezier(0.65, 0, 0.35, 1), top 0.7s cubic-bezier(0.65, 0, 0.35, 1), opacity 0.4s"; state[l.id] = { x: l.x, y: l.y, hidden: false }; place(l.id); });
    await wait(750);
    LAYERS.forEach((l) => (el[l.id].style.transition = ""));
    split = false;
    psd.disabled = true;
    scene.classList.remove("split", "open");
    rows.innerHTML = '<div class="ld-empty">One image. Press Split into layers.</div>';
    root.querySelector(".ld-stage").appendChild(go);
  }
  go.addEventListener("click", doSplit);

  // Drag: pointer position in percent of the poster.
  let drag = null;
  const pct = (e) => { const r = scene.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100]; };
  scene.addEventListener("pointerdown", (e) => {
    if (!scene.classList.contains("ready") || e.target.closest("button")) return;
    const [px, py] = pct(e);
    const id = hit(px, py);
    select(id);
    if (!id) return;
    say("");
    drag = { id, px, py, x: state[id].x, y: state[id].y };
    scene.classList.add("dragging");
    scene.setPointerCapture(e.pointerId);
  });
  scene.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [px, py] = pct(e), l = LAYERS.find((q) => q.id === drag.id);
    // Keep at least a fifth of the object inside the frame.
    state[drag.id].x = Math.max(-l.w * 0.8, Math.min(100 - l.w * 0.2, drag.x + px - drag.px));
    state[drag.id].y = Math.max(-l.h * 0.8, Math.min(100 - l.h * 0.2, drag.y + py - drag.py));
    place(drag.id);
  });
  const end = () => { drag = null; scene.classList.remove("dragging"); };
  scene.addEventListener("pointerup", end);
  scene.addEventListener("pointercancel", end);

  // Split by itself the first time it comes into view; after that it is the visitor's.
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { io.disconnect(); setTimeout(doSplit, 900); } }, { threshold: 0.6 });
  io.observe(scene);
})();
