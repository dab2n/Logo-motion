"use strict";
/* Logo Match Cut Studio — all client-side, no backend.
   State flows: video -> frames -> separated(logo w/ alpha) -> composite(bg+logo) -> export. */

const $ = (id) => document.getElementById(id);

const state = {
  frames: [],        // [{ canvas, time }] raw extracted frames
  separated: [],     // [canvas] logo with transparent bg, index-aligned with frames
  backgrounds: [],   // [ImageBitmap/HTMLImageElement]
  manualBg: [],      // [bgIndex|null] per frame, for manual assignment
  processed: [],     // [{name, img}] re-imported external frames
  staticLogo: null,  // single tint-ready logo canvas for the "static" mode
};

/* ---------- mode selection: show only the steps a given goal needs ---------- */
const MODE_STEPS = {
  full:   ["s1", "s3", "s4", "s5", "s6", "s7"], // 영상·추출→분리→배경→미리보기→내보내기
  logo:   ["s1", "s3", "s5", "s6"],             // 배경 없이 투명 로고 모션만
  static: ["s1b", "s4", "s5", "s6"],                  // 정적 로고 한 장 + 배경 전환
  seq:    ["s7"],                               // 분리 없이 이미지 여러 장 → 영상 (s7 재사용)
};
let mode = null;

function applyMode(m) {
  mode = m;
  const steps = MODE_STEPS[m];
  const seq = m === "seq"; // 같은 s7 패널을 '이미지 이어붙이기'용으로도 씀
  document.querySelectorAll(".step[data-go]").forEach((b) => {
    const i = steps.indexOf(b.dataset.go);
    b.hidden = i < 0;
    const label = seq && b.dataset.go === "s7" ? "이미지 이어붙이기" : b.dataset.label;
    if (i >= 0) b.textContent = `${i + 1} · ${label}`;
  });
  $("s7Title").textContent = seq ? "이미지 이어붙여 영상 만들기" : "외부 가공 프레임 재조합";
  $("procHold").value = seq ? 1 : 0; // 슬라이드쇼는 장당 1초, 재조합은 프레임당 1장
  $("steps").hidden = false;
  $("exportContent").value = m === "logo" ? "logo" : "composite"; // 배경제거 모드 기본값
  showStep(steps[0]);
  updateExportInfo();
}

function showLanding() {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".step").forEach((b) => b.classList.remove("active", "guide"));
  $("s0").classList.add("active");
  $("steps").hidden = true;
}

document.querySelectorAll(".modeCard").forEach((b) =>
  b.addEventListener("click", () => applyMode(b.dataset.mode)));
$("backToModes").addEventListener("click", showLanding);

/* ---------- step navigation ---------- */
document.querySelectorAll(".step[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => showStep(btn.dataset.go, btn));
});
function showStep(id, btn) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".step").forEach((b) => b.classList.remove("active"));
  $(id).classList.add("active");
  const tab = btn || document.querySelector(`[data-go="${id}"]`);
  tab.classList.add("active");
  tab.classList.remove("guide"); // visiting the tab clears its "go here next" hint
}

/* pulse the next tab so non-experts know where to go after finishing a step.
   if the requested step isn't in the current mode, guide to the next visible one. */
function guideTo(step) {
  document.querySelectorAll(".step.guide").forEach((s) => s.classList.remove("guide"));
  const steps = MODE_STEPS[mode] || [];
  let target = step;
  if (!steps.includes(target)) {
    const active = document.querySelector(".step.active")?.dataset.go;
    target = steps[steps.indexOf(active) + 1];
  }
  if (!target) return;
  const t = document.querySelector(`[data-go="${target}"]`);
  if (t && !t.classList.contains("active")) t.classList.add("guide");
}

/* drag & drop: forward dropped files to the same handler as the input */
function makeDrop(zoneId, handler) {
  const z = $(zoneId);
  ["dragover", "dragenter"].forEach((ev) =>
    z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.remove("over"); }));
  z.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) handler(e.dataTransfer.files);
  });
}

/* ---------- 1. video upload ---------- */
const video = $("video");
function loadVideoFile(file) {
  if (!file) return;
  video.src = URL.createObjectURL(file);
  video.onloadedmetadata = () => {
    $("videoMeta").textContent =
      `${video.videoWidth}×${video.videoHeight}px · ${video.duration.toFixed(2)}s`;
  };
  $("extractBtn").disabled = false; // 추출 버튼이 같은 단계 안에 있으므로 탭 안내 불필요
}
$("videoInput").addEventListener("change", (e) => loadVideoFile(e.target.files[0]));
makeDrop("videoDrop", (files) => loadVideoFile(files[0]));

/* ---------- 1b. static logo upload (static mode) ---------- */
function loadStaticLogo(file) {
  if (!file) return;
  loadImage(URL.createObjectURL(file)).then((img) => {
    state.staticLogo = prepareStaticLogo(img);
    drawInto($("staticLogoPreview"), state.staticLogo);
    $("logoImgMeta").textContent = `${img.width}×${img.height}px`;
    buildStaticFrames();
    guideTo("s4");
  });
}
$("logoImgInput").addEventListener("change", (e) => loadStaticLogo(e.target.files[0]));
makeDrop("logoImgDrop", (files) => loadStaticLogo(files[0]));

/* accept the image as-is if it already has transparency; otherwise strip its white bg */
function prepareStaticLogo(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return c; // already transparent
  return separate(c, { mode: "matte", threshold: 235, feather: 40, forceBlack: false });
}

/* static mode has no motion: fake N frames of the same logo so the compositor can
   sequence backgrounds. N = backgrounds × 전환 간격, so each bg lingers that long. */
function buildStaticFrames() {
  if (mode !== "static" || !state.staticLogo) return;
  const logo = state.staticLogo;
  const n = Math.max(1, state.backgrounds.length) * bgHold();
  state.frames = Array.from({ length: n }, () => ({ canvas: logo, time: 0 }));
  state.separated = state.frames.map(() => logo); // already tint-ready
  state.manualBg = [];
  ["playBtn", "saveFramesBtn", "exportVideoBtn", "exportGifBtn"].forEach((id) => { $(id).disabled = false; });
  syncScrub();
  cur = Math.min(cur, n - 1);
  drawPreview(cur);
}

/* frame-extraction mode: only the selected mode's value input is editable */
function syncExMode() {
  const mode = document.querySelector('input[name="exMode"]:checked').value;
  $("exFps").disabled = mode !== "fps";
  $("exInterval").disabled = mode !== "interval";
  $("exSrcFps").disabled = mode !== "all";
}
document.querySelectorAll('input[name="exMode"]').forEach((r) =>
  r.addEventListener("change", syncExMode));
syncExMode();

/* ---------- 2. frame extraction ---------- */
function seek(t) {
  return new Promise((res) => {
    const done = () => { video.removeEventListener("seeked", done); res(); };
    video.addEventListener("seeked", done);
    video.currentTime = Math.min(t, video.duration - 1e-3);
  });
}

/* some files report Infinity/NaN duration until seeked — force the browser to compute it */
async function ensureDuration() {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  return new Promise((res) => {
    const onChange = () => {
      if (isFinite(video.duration) && video.duration > 0) {
        video.removeEventListener("durationchange", onChange);
        video.currentTime = 0;
        res(video.duration);
      }
    };
    video.addEventListener("durationchange", onChange);
    video.currentTime = 1e101; // seek past end -> browser resolves real duration
    setTimeout(() => res(video.duration), 3000); // give up, let caller validate
  });
}

function extractionTimes(d) {
  const mode = document.querySelector('input[name="exMode"]:checked').value;
  let step;
  if (mode === "fps") step = 1 / Number($("exFps").value);
  else if (mode === "interval") step = Number($("exInterval").value);
  else step = 1 / Number($("exSrcFps").value); // "all" ≈ source fps
  const times = [];
  for (let t = 0; t < d; t += step) times.push(t);
  return times;
}

$("extractBtn").addEventListener("click", async () => {
  if (!video.src) return alert("먼저 영상을 업로드하세요.");
  const d = await ensureDuration();
  if (!isFinite(d) || d <= 0 || !video.videoWidth) {
    return alert("영상 길이/해상도를 읽지 못했습니다. 영상이 완전히 로드된 뒤 다시 시도하거나 다른 파일을 사용하세요.");
  }
  const times = extractionTimes(d);
  if (times.length > 600 &&
      !confirm(`${times.length}개 프레임을 추출합니다. 메모리를 많이 쓸 수 있어요. 계속?`)) return;
  const btn = $("extractBtn"); btn.disabled = true;
  state.frames = []; state.separated = []; state.manualBg = [];
  video.pause();
  for (let i = 0; i < times.length; i++) {
    await seek(times[i]);
    const c = document.createElement("canvas");
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    state.frames.push({ canvas: c, time: times[i] });
    $("extractStatus").textContent = `추출 중… ${i + 1}/${times.length}`;
  }
  btn.disabled = false;
  $("extractStatus").textContent = `${state.frames.length}개 프레임 추출 완료`;
  renderStrip();
  loadSepPreview(0);
  buildManualAssign();
  syncScrub();
  if (state.frames.length) {
    ["saveRawBtn", "applySepBtn", "playBtn", "saveFramesBtn", "exportVideoBtn", "exportGifBtn"]
      .forEach((id) => { $(id).disabled = false; });
    guideTo("s3");
  }
});

function renderStrip() {
  const strip = $("frameStrip"); strip.innerHTML = "";
  state.frames.forEach((f, i) => {
    const t = document.createElement("div"); t.className = "thumb";
    const th = thumbCanvas(f.canvas, 72);
    th.onclick = () => loadSepPreview(i);
    t.appendChild(th);
    const s = document.createElement("small"); s.textContent = i;
    t.appendChild(s);
    strip.appendChild(t);
  });
}

function thumbCanvas(src, h) {
  const c = document.createElement("canvas");
  const scale = h / src.height;
  c.width = src.width * scale; c.height = h;
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/* ---------- 3. logo separation ---------- */
["sepThreshold", "sepFeather"].forEach((id) => {
  $(id).addEventListener("input", () => {
    $(id + "Val").textContent = $(id).value;
    loadSepPreview(sepPreviewIndex);
  });
});
["sepMode", "sepForceBlack", "sepBackdrop"].forEach((id) =>
  $(id).addEventListener("input", () => loadSepPreview(sepPreviewIndex)));

let sepPreviewIndex = 0;
function loadSepPreview(i) {
  if (!state.frames[i]) return;
  sepPreviewIndex = i;
  const src = state.frames[i].canvas;
  const sep = separate(src, sepParams());
  drawInto($("sepBefore"), src);
  drawInto($("sepAfter"), sep);
  updateSepBackdrop(sep);
}

/* show the transparent logo against a chosen backdrop so it's actually visible */
function updateSepBackdrop(sep) {
  const wrap = $("sepAfterWrap");
  const mode = $("sepBackdrop").value;
  wrap.classList.toggle("checker", mode === "checker");
  if (mode === "checker") { wrap.style.background = ""; return; }
  if (mode === "white") wrap.style.background = "#fff";
  else if (mode === "black") wrap.style.background = "#000";
  else wrap.style.background = meanLuma(sep) < 128 ? "#ffffff" : "#141414"; // contrast
}

function meanLuma(c) {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 10) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  }
  return n ? sum / n : 255;
}

function sepParams() {
  return {
    mode: $("sepMode").value,
    threshold: Number($("sepThreshold").value),
    feather: Number($("sepFeather").value),
    forceBlack: $("sepForceBlack").checked,
  };
}

/* core matte: turns white bg transparent, keeps dark logo. */
function separate(src, p) {
  const w = src.width, h = src.height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let a;
    if (p.mode === "hard") a = lum >= p.threshold ? 0 : 255;
    else if (p.mode === "soft")
      a = clamp255((p.threshold - lum) / Math.max(1, p.feather) * 255);
    else a = 255 - lum; // matte: brightness -> transparency (Multiply-equivalent)
    if (p.forceBlack) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; }
    d[i + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
const clamp255 = (v) => Math.max(0, Math.min(255, v));

$("applySepBtn").addEventListener("click", () => {
  if (!state.frames.length) return alert("먼저 프레임을 추출하세요.");
  const p = sepParams();
  state.separated = state.frames.map((f) => separate(f.canvas, p));
  $("sepStatus").textContent = `${state.separated.length}개 프레임 분리 완료`;
  $("saveSepBtn").disabled = false;
  syncScrub();
  guideTo("s4");
});

function drawInto(canvas, src) {
  canvas.width = src.width; canvas.height = src.height;
  canvas.getContext("2d").clearRect(0, 0, src.width, src.height);
  canvas.getContext("2d").drawImage(src, 0, 0);
}

/* ---------- 4. backgrounds ---------- */
async function addBackgrounds(files) {
  for (const file of files) {
    const img = await loadImage(URL.createObjectURL(file));
    state.backgrounds.push({ img, name: file.name });
  }
  renderBgList();
  buildManualAssign();
  buildStaticFrames();
  if (state.backgrounds.length) guideTo("s5");
}

function removeBackground(k) {
  state.backgrounds.splice(k, 1);
  // keep manual assignments pointing at the right images after the shift
  state.manualBg = state.manualBg.map((v) =>
    v == null ? null : v === k ? null : v > k ? v - 1 : v);
  renderBgList();
  buildManualAssign();
  buildStaticFrames();
  if (state.frames.length) drawPreview(cur);
}
$("bgInput").addEventListener("change", (e) => addBackgrounds(e.target.files));
makeDrop("bgDrop", addBackgrounds);

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img); img.onerror = rej; img.src = url;
  });
}

function renderBgList() {
  const list = $("bgList"); list.innerHTML = "";
  state.backgrounds.forEach((b, i) => {
    const t = document.createElement("div"); t.className = "thumb";
    t.appendChild(thumbCanvas(b.img, 72));
    const del = document.createElement("button");
    del.className = "delbtn"; del.textContent = "×"; del.title = "삭제";
    del.onclick = () => removeBackground(i);
    t.appendChild(del);
    const s = document.createElement("small"); s.textContent = b.name || ("bg " + i);
    t.appendChild(s);
    list.appendChild(t);
  });
  const n = state.backgrounds.length;
  $("bgCount").textContent = n ? `배경 ${n}장 로드됨` : "아직 배경이 없습니다.";
}

$("bgMode").addEventListener("change", () => {
  $("manualAssign").hidden = $("bgMode").value !== "manual";
  if (state.frames.length) drawPreview(cur);
});

function buildManualAssign() {
  const wrap = $("manualAssign"); wrap.innerHTML = "";
  state.frames.forEach((f, i) => {
    const t = document.createElement("div"); t.className = "thumb";
    t.appendChild(thumbCanvas(f.canvas, 60));
    const sel = document.createElement("select");
    sel.innerHTML = '<option value="">-</option>' +
      state.backgrounds.map((_, bi) => `<option value="${bi}">bg ${bi}</option>`).join("");
    sel.value = state.manualBg[i] ?? "";
    sel.onchange = () => {
      state.manualBg[i] = sel.value === "" ? null : Number(sel.value);
      if (state.frames.length) drawPreview(cur);
    };
    t.appendChild(sel);
    wrap.appendChild(t);
  });
}

function bgHold() { return Math.max(1, Number($("bgSwitch").value) || 1); }

/* which background image applies to frame i */
function bgForFrame(i) {
  if (!state.backgrounds.length) return null;
  if ($("bgMode").value === "manual") {
    const idx = state.manualBg[i];
    return idx == null ? null : state.backgrounds[idx].img;
  }
  // sequential auto: hold each background for N frames (배경 전환 간격, step 5)
  return state.backgrounds[Math.floor(i / bgHold()) % state.backgrounds.length].img;
}

/* ---------- compositing ---------- */
function logoFor(i) {
  return state.separated[i] || state.frames[i]?.canvas;
}

function composite(ctx, i, W, H) {
  ctx.clearRect(0, 0, W, H);
  const bg = bgForFrame(i);
  if (bg) drawCover(ctx, bg, W, H);
  else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); }
  drawLogoOn(ctx, i, W, H);
}

/* place the logo with the chosen size, alignment (9-point) + fine nudge */
const align = { h: "center", v: "middle" };
const AX = { left: 0, center: 0.5, right: 1 };
const AY = { top: 0, middle: 0.5, bottom: 1 };

function drawLogoOn(ctx, i, W, H) {
  const logo = logoFor(i);
  if (!logo) return;
  const s = (Number($("logoScale").value) || 100) / 100;
  const base = Math.min(W / logo.width, H / logo.height);
  const lw = logo.width * base * s, lh = logo.height * base * s;
  const x = AX[align.h] * (W - lw) + (Number($("logoX").value) || 0) / 100 * W;
  const y = AY[align.v] * (H - lh) + (Number($("logoY").value) || 0) / 100 * H;
  ctx.save(); // 투명도 · 합성 효과(overlay/screen 등)는 로고에만 적용
  ctx.globalAlpha = (Number($("logoOpacity").value) || 0) / 100;
  ctx.globalCompositeOperation = $("logoBlend").value;
  ctx.drawImage(paintLogo(logo, i), x, y, lw, lh);
  ctx.restore();
}

/* recolor the separated logo (alpha matte) to the chosen or auto-contrast color */
function paintLogo(logo, i) {
  if (!state.separated[i]) return logo; // needs an alpha matte to recolor
  return tintedLogo(logo, logoColor(i));
}
function tintedLogo(src, color) {
  const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
  const x = c.getContext("2d");
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = "source-in"; // keep alpha, replace color
  x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  return c;
}
function logoColor(i) {
  const m = $("logoColorMode").value;
  if (m === "black") return "#000";
  if (m === "white") return "#fff";
  if (m === "custom") return $("logoColorPick").value;
  const bg = bgForFrame(i); // auto: pick black/white for contrast with the background
  if (!bg) return "#000";
  return bgMeanLuma(bg) < 128 ? "#fff" : "#000";
}
const lumaCache = new Map();
function bgMeanLuma(img) {
  if (lumaCache.has(img)) return lumaCache.get(img);
  const s = Math.min(1, 64 / Math.max(img.width, img.height)); // downscale for speed
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const v = meanLuma(c); lumaCache.set(img, v); return v;
}

function drawCover(ctx, img, W, H) {
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

/* output size from aspect ratio (step 5) + target resolution (step 6). Even dims for encoders. */
function frameSize() {
  const f = state.frames[0]?.canvas;
  const bw = f ? f.width : 1280, bh = f ? f.height : 720;
  const a = $("aspect") ? $("aspect").value : "orig";
  const ratio = a === "orig" ? bw / bh : (() => { const [rw, rh] = a.split(":").map(Number); return rw / rh; })();
  const res = $("exportRes") ? $("exportRes").value : "orig";
  // A1(594×841mm) @150dpi: 짧은 변 3508 / 긴 변 4967. 세로·가로 방향에 맞춰 높이를 고름
  const H = res === "orig" ? bh : res === "a1" ? (ratio > 1 ? 3508 : 4967) : Number(res);
  const even = (n) => 2 * Math.round(n / 2);
  return { W: even(H * ratio), H: even(H) };
}

/* ---------- 5. preview playback ---------- */
const pv = $("previewCanvas");
let playTimer = null;
let cur = 0;

function drawPreview(i) {
  const { W, H } = frameSize();
  pv.width = W; pv.height = H;
  composite(pv.getContext("2d"), i, W, H);
  $("frameCounter").textContent = `${i + 1}/${state.frames.length}`;
  $("scrub").value = i;
}

function syncScrub() {
  $("scrub").max = Math.max(0, state.frames.length - 1);
  if (state.frames.length) drawPreview(Math.min(cur, state.frames.length - 1));
}

$("scrub").addEventListener("input", () => { cur = Number($("scrub").value); drawPreview(cur); });

$("playBtn").addEventListener("click", () => {
  if (playTimer) { stopPlay(); return; }
  if (!state.frames.length) return alert("먼저 프레임을 추출하세요.");
  const fps = Number($("playFps").value);
  $("playBtn").textContent = "⏸ 정지";
  playTimer = setInterval(() => {
    drawPreview(cur);
    cur = (cur + 1) % state.frames.length;
  }, 1000 / fps);
});
function stopPlay() { clearInterval(playTimer); playTimer = null; $("playBtn").textContent = "▶ 재생"; }

/* ---------- 6. export ---------- */
function pad(n, width) { return String(n).padStart(width, "0"); }

function renderFrameToCanvas(i, content) {
  const { W, H } = frameSize();
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (content === "logo") drawLogoOn(ctx, i, W, H); // transparent bg + placed logo
  else composite(ctx, i, W, H);
  return c;
}

/* bundle N canvases into one ordered ZIP (used by steps 2, 3, 6) */
async function saveZip(count, getCanvas, prefix, statusEl) {
  if (!count) return alert("먼저 프레임을 준비하세요.");
  const width = String(count).length;
  const zip = new JSZip();
  for (let i = 0; i < count; i++) {
    const c = getCanvas(i);
    if (!c) continue;
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    zip.file(`${prefix}_${pad(i + 1, width)}.png`, blob);
    statusEl.textContent = `압축 중… ${i + 1}/${count}`;
  }
  const out = await zip.generateAsync({ type: "blob" });
  downloadBlob(out, `${prefix}.zip`);
  statusEl.textContent = `${prefix}.zip 저장 완료`;
}

// step 2: raw extracted frames
$("saveRawBtn").addEventListener("click", () =>
  saveZip(state.frames.length, (i) => state.frames[i].canvas, "frame", $("extractStatus")));

// step 3: separated logos (apply first if needed)
$("saveSepBtn").addEventListener("click", () => {
  if (!state.separated.length) return alert('먼저 "모든 프레임에 적용"을 실행하세요.');
  saveZip(state.separated.length, (i) => state.separated[i], "logo", $("sepStatus"));
});

// step 6: composite or logo-only
$("saveFramesBtn").addEventListener("click", () => {
  const content = $("exportContent").value;
  saveZip(state.frames.length, (i) => renderFrameToCanvas(i, content),
    content === "logo" ? "logo" : "composite", $("exportStatus"));
});

const BITRATE = { std: 8e6, high: 16e6, max: 32e6 };

$("exportVideoBtn").addEventListener("click", () => {
  if (!state.frames.length) return alert("먼저 프레임을 추출하세요.");
  const content = $("exportContent").value;
  const fps = Number($("playFps").value);
  const total = state.frames.length;
  const dur = Number($("exportDuration").value) || 0;
  const count = dur > 0 ? Math.round(dur * fps) : total; // loop to fill / cut to fit
  recordFrames(count, fps, (ctx, j, W, H) => {
    const i = j % total;
    if (content === "logo") { ctx.clearRect(0, 0, W, H); drawLogoOn(ctx, i, W, H); }
    else composite(ctx, i, W, H);
  }, frameSize(), $("exportStatus"), "logo-match-cut.webm", BITRATE[$("exportQuality").value]);
});

/* ---------- transparent GIF export (Figma/web-safe alpha) ----------
   Video (WebM/MP4) can't carry alpha — Figma renders transparent pixels black.
   GIF has real (binary) transparency, so it's the reliable animated format there. */
const GIF_WORKER = "assets/gif.worker.js"; // self-hosted: same-origin Worker, no CORS
const GIF_KEY = 0xff00ff; // magenta transparency key, unlikely to clash with a logo

/* GIF is heavy; cap the long side so files/encode stay sane. ponytail: fixed 720 cap. */
function gifSize() {
  const { W, H } = frameSize();
  const cap = 720, m = Math.max(W, H);
  if (m <= cap) return { W, H };
  const even = (n) => 2 * Math.round(n / 2), s = cap / m;
  return { W: even(W * s), H: even(H * s) };
}

$("exportGifBtn").addEventListener("click", () => {
  if (!state.frames.length) return alert("먼저 프레임을 준비하세요.");
  if (typeof GIF === "undefined") return alert("GIF 인코더를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
  const fps = Number($("playFps").value) || 12;
  const total = state.frames.length;
  const dur = Number($("exportDuration").value) || 0;
  const count = dur > 0 ? Math.round(dur * fps) : total; // same loop/cut rule as WebM
  exportGif(count, fps);
});

function exportGif(count, fps) {
  const content = $("exportContent").value;
  const transparent = content === "logo";
  const { W, H } = gifSize();
  const gif = new GIF({
    workers: 2, quality: 10, width: W, height: H, repeat: 0,
    workerScript: GIF_WORKER, transparent: transparent ? GIF_KEY : null,
  });
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  for (let j = 0; j < count; j++) {
    const i = j % state.frames.length;
    ctx.clearRect(0, 0, W, H);
    if (transparent) {
      drawLogoOn(ctx, i, W, H);
      keyOutAlpha(ctx, W, H); // hard-threshold alpha to the magenta key (no fringe)
    } else composite(ctx, i, W, H);
    gif.addFrame(ctx, { copy: true, delay: 1000 / fps });
    $("exportStatus").textContent = `GIF 프레임 준비… ${j + 1}/${count}`;
  }
  gif.on("progress", (p) =>
    $("exportStatus").textContent = `GIF 인코딩… ${Math.round(p * 100)}%`);
  gif.on("finished", (blob) => {
    downloadBlob(blob, "logo-motion.gif");
    $("exportStatus").textContent = `GIF 저장 완료 (${(blob.size / 1e6).toFixed(1)}MB)`;
  });
  gif.render();
}

/* GIF transparency is binary: paint semi/fully transparent pixels the key color
   (opaque) so the encoder maps exactly that color to transparent, no colored halo. */
function keyOutAlpha(ctx, W, H) {
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const r = (GIF_KEY >> 16) & 255, g = (GIF_KEY >> 8) & 255, b = GIF_KEY & 255;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] < 128) { d[p] = r; d[p + 1] = g; d[p + 2] = b; }
    d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* record a canvas animation to webm via MediaRecorder (native) */
async function recordFrames(count, fps, drawFn, size, statusEl, filename, bitrate) {
  const { W, H } = size;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const stream = c.captureStream(fps);
  const chunks = [];
  const rec = new MediaRecorder(stream, {
    mimeType: "video/webm",
    videoBitsPerSecond: bitrate || 16e6,
  });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  for (let i = 0; i < count; i++) {
    drawFn(ctx, i, W, H);
    statusEl.textContent = `녹화 중… ${i + 1}/${count}`;
    await delay(1000 / fps);
  }
  rec.stop();
  rec.onstop = () => {
    downloadBlob(new Blob(chunks, { type: "video/webm" }), filename);
    statusEl.textContent = "영상 저장 완료 (WebM)";
  };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 7. re-import processed frames ---------- */
async function loadProcessed(fileList) {
  const files = [...fileList].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }));
  state.processed = [];
  for (const file of files) {
    const img = await loadImage(URL.createObjectURL(file));
    state.processed.push({ name: file.name, img });
  }
  const strip = $("processedStrip"); strip.innerHTML = "";
  state.processed.forEach((p) => {
    const t = document.createElement("div"); t.className = "thumb";
    t.appendChild(thumbCanvas(p.img, 72));
    const s = document.createElement("small"); s.textContent = p.name;
    t.appendChild(s);
    strip.appendChild(t);
  });
  $("procStatus").textContent = `${state.processed.length}개 프레임 정렬 완료`;
  if (state.processed[0]) {
    drawProcessed(0);
    $("playProcessedBtn").disabled = false;
    $("exportProcessedBtn").disabled = false;
  }
}
$("processedInput").addEventListener("change", (e) => loadProcessed(e.target.files));
makeDrop("processedDrop", loadProcessed);

const pc = $("processedCanvas");
let procTimer = null, procCur = 0;
function procSize() {
  const im = state.processed[0]?.img;
  return im ? { W: im.width, H: im.height } : { W: 1280, H: 720 };
}
function drawProcessed(i) {
  const { W, H } = procSize();
  pc.width = W; pc.height = H;
  drawCover(pc.getContext("2d"), state.processed[i].img, W, H); // 크기 제각각이어도 안 찌그러짐
}

/* 한 장을 몇 프레임 유지할지. 0초면 원본 그대로 프레임당 한 장 */
function procHold(fps) {
  const sec = Number($("procHold").value) || 0;
  return sec > 0 ? Math.max(1, Math.round(sec * fps)) : 1;
}

$("playProcessedBtn").addEventListener("click", () => {
  if (procTimer) {
    clearInterval(procTimer); procTimer = null;
    $("playProcessedBtn").textContent = "▶ 재생"; return;
  }
  if (!state.processed.length) return alert("먼저 가공 프레임을 업로드하세요.");
  const fps = Number($("procFps").value);
  const hold = procHold(fps), total = state.processed.length * hold;
  $("playProcessedBtn").textContent = "⏸ 정지";
  procCur = 0;
  procTimer = setInterval(() => {
    drawProcessed(Math.floor(procCur / hold));
    procCur = (procCur + 1) % total;
  }, 1000 / fps);
});

$("exportProcessedBtn").addEventListener("click", () => {
  if (!state.processed.length) return alert("먼저 가공 프레임을 업로드하세요.");
  const fps = Number($("procFps").value);
  const hold = procHold(fps);
  recordFrames(state.processed.length * hold, fps,
    (ctx, j, W, H) => drawCover(ctx, state.processed[Math.floor(j / hold)].img, W, H),
    procSize(), $("procStatus"), "final-match-cut.webm", BITRATE[$("exportQuality").value]);
});

/* ---------- layout controls (aspect / logo size & position) ---------- */
["aspect", "logoScale", "logoX", "logoY", "logoOpacity", "logoBlend"].forEach((id) =>
  $(id).addEventListener("input", () => {
    $("logoScaleVal").textContent = $("logoScale").value + "%";
    $("logoOpacityVal").textContent = $("logoOpacity").value + "%";
    if (id === "aspect") updateExportInfo();
    if (state.frames.length) drawPreview(cur);
  }));

$("bgSwitch").addEventListener("input", () => {
  if (mode === "static") buildStaticFrames();
  else if (state.frames.length) drawPreview(cur);
});

/* 9-point alignment grid (Figma-style) */
$("alignGrid").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  align.h = b.dataset.h; align.v = b.dataset.v;
  $("alignGrid").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  if (state.frames.length) drawPreview(cur);
});

/* logo color tool */
$("logoColorMode").addEventListener("change", () => {
  $("logoColorPick").hidden = $("logoColorMode").value !== "custom";
  if (state.frames.length) drawPreview(cur);
});
$("logoColorPick").addEventListener("input", () => { if (state.frames.length) drawPreview(cur); });

/* ---------- export size/quality/duration info ---------- */
function updateExportInfo() {
  const { W, H } = frameSize();
  const mbps = { std: 8, high: 16, max: 32 }[$("exportQuality").value];
  const total = state.frames.length;
  const fps = Number($("playFps").value) || 12;
  const dur = Number($("exportDuration").value) || 0;
  const count = total ? (dur > 0 ? Math.round(dur * fps) : total) : 0;
  $("exportInfo").textContent =
    `출력 ${W}×${H}px · ${mbps}Mbps · ${count}프레임 · 약 ${(count / fps).toFixed(1)}초` +
    (H > 2400 ? " · ⚠ 인쇄용 대형 — 영상보다 프레임 ZIP(PNG) 권장" : "");
  $("transparentNote").hidden = $("exportContent").value !== "logo"; // WebM can't do alpha
}
["exportRes", "exportQuality", "exportDuration", "playFps", "exportContent"].forEach((id) => {
  $(id).addEventListener("input", updateExportInfo);
  $(id).addEventListener("change", updateExportInfo);
});
updateExportInfo();
