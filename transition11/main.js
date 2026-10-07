// TRANSITION 11 (rev 3) — clean and crisp, in image 1's own colours. The client: still noisy.
// The edge of the clip is fine random speckle; shown as filmed it scattered single pixels of both
// pictures along the whole edge, and the grains' light added more speckle on top. Now the sand's
// transparency is merged slightly first (CONFIG.clean - a blur level), so the speckle joins into
// clumps and shapes, and then cut at CONFIG.edge with a one-pixel antialiased step: clean sand
// shapes that still move exactly as the footage does. No tint, no grain light: image 1's colours.
//
// TRANSITION 11 (rev 2) — clean. Three things read as glitchy and are gone:
//   FRAME PACING  the clip is 25 frames a second (50 at speed 2), screens refresh at 60, so the
//                 sand stood still for one refresh and then two in turn - a stutter. Each new
//                 frame of the sand now blends in over the time until the next is due.
//   COLOUR LAYER  the sand stored in colour kept a quarter of its colour resolution, which put
//                 blocky colour fringes on the grains. The sand is stored grey again (its light,
//                 as transition9, faded smoothly to neutral - no seam) and its warm colour is a
//                 smooth tint applied here.
//   QUALITY       grey compresses better, so the clip is encoded finer (crf 27).
//
// TRANSITION 11 — the edge IS the footage. Every earlier version rebuilt the sand edge itself: the
// alpha cut at a hard threshold (a pixel dissolve), lighting and shadows computed by us. The clip
// already shows exactly how sand blows away, so here the edge is the clip: its transparency used
// as filmed (thin sand is partly see-through, grains fade and overlap), and the sand's own colour
// and light where the sheet breaks - tools/make_mask11.py packs both. The intact sheet stays pure
// image 1; no added shadows, blur or relief.
//   sandColor 0 = image 1 made of this sand (the grains' light on image 1's colours)
//             1 = the clip's own golden sand
//
// TRANSITION 9 — the sand's REAL light. The client found transitions 3-8 plastic: every bit of
// depth was computed from the mask's outline - offset copies for shadows, a blurred mask for a
// rounded edge - and that smooth, even shading is what reads as plastic. The 4K master holds
// the real thing: every grain and clump in it was filmed lit, with its own highlight and shade.
// tools/make_mask9.py keeps that light (the sand's brightness against its local average, so the
// big waves that read as caustics are divided out) next to the alpha, and ONLY where the sheet
// is breaking. Here it lights image 1 where image 1 turns to sand, the brightest grains glint,
// and the shadow is a tight contact shadow plus a faint soft one instead of a floating slab.
// The computed rounded edge is off. Everything else - loading, the panel - is transition5's.
//
// TRANSITION 5 — transition4's sand and shadows, softened and given FOCUS.
//   STEADY  each frame of the mask is blended with the one before, so single grains stop
//           flickering frame to frame; the sand itself stays sharp
//   SOFT    the breaking edge mixes the sharp mask with a lightly blurred copy, so it reads as
//           sand dissolving rather than as hard pixels
//   FOCUS   image 1 goes out of focus in a band along its breaking edge, as if the sand lifting
//           off were leaving the focal plane; image 2 is soft where sand has only just left it
//           and comes sharp as the sand clears - a focus pull on the reveal
//
// TRANSITION 4 — transition3's high-resolution sand, with depth.
//
// The mask is the sand clip's own alpha at 1920 x 1080 (tools/make_mask.py): where there is
// sand, image 1; where it has blown away, image 2. On top of that, shadows, all of them read
// from blurred copies of the same mask, so they belong to the sand and move with it:
//   GRAIN SHADOW  every grain casts a small, tight shadow down-right onto image 2, so the grains
//                 stand up off the picture instead of lying in it
//   SHEET SHADOW  a wide soft shadow of the whole sheet, as if it floats a little above image 2
//   AMBIENT       image 2 is darker close under the sand, where the sheet blocks the light
//   THICKNESS     at the sheet's edges only, image 1 is lit on the side facing the light and
//                 darker on the far side, so the sheet has a rounded edge. Inside it, image 1
//                 is untouched - no waves, no folds.
// The mask is copied each frame into a texture with mipmaps, so any blur is one lookup at the
// right level. Scroll down plays it at speed 2, scroll up plays it back.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  speed: num('speed', 2.0),      // playback rate (2 = the 6.4 s clip in 3.2 s)
  cover: [0.30, 0.62],           // alpha where image 1 starts to show, and where it is solid
  // the shadows on image 2. Offsets in mask pixels (1920 wide), down and to the right
  grainShadow: 0.12,             // each grain's own tight shadow
  grainOffset: [2, -3],
  grainBlur: 0.7,                // mip level: 1 = two pixels soft
  sheetShadow: 0.0,             // the whole sheet's wide shadow
  sheetOffset: [8, -11],
  sheetBlur: 3.5,                // mip level: 5 = about thirty pixels soft
  ambient: 0.0,                 // darkening close under the sand
  ambientBlur: 6.5,
  // the sheet's thickness, on image 1 at its edges
  relief: 0.0,                  // how strongly the rounded edge is lit and shaded
  reliefBlur: 3.0,               // how wide the rounded edge is (mip level)
  edgeDarken: 0.0,              // thin sand at the very edge is a little darker
  endFade: [0.93, 1.0],          // over this last part the mask fades to clean image 2
  startFade: 0.6,                // s the whole effect takes to fade in from clean image 1 (and back out)
  // transition5
  steady: 0.0,
  sandLight: 0.0,                // the grains' own light and shade, as filmed (1)
  sandColor: 0.0,               // 0 = image 1's colours on the sand, 1 = the clip's golden sand
  alphaGamma: 1.0,
  clean: 1.6,                    // how far the speckle is merged into clumps (blur level; 0 = raw)
  edge: 0.5,                     // where the sand's edge is cut (lower = more sand)
  crisp: 1.0,                    // edge width in screen pixels (1 = one-pixel antialiased edge)               // the edge's transparency as filmed (1); higher = thinner sand                // how strongly the sand's filmed light shades image 1 (1 = as filmed)
  glint: 0.0,                   // the brightest grains catch the light                  // share of the previous frame kept in the mask (0 = none)
  soft: 0.0,                    // how much of the blurred mask is mixed into the edge
  softBlur: 1.3,                 //   and how blurred that copy is (mip level)
  edgeBlur: 0.0,                 // image 1's blur at its breaking edge (mip levels of the image)
  focusBlur: 0.0,                // image 2's blur where sand has only just left it
};
if (PARAMS.get('depth') === '0') CONFIG.grainShadow = CONFIG.sheetShadow = CONFIG.ambient = CONFIG.relief = CONFIG.edgeDarken = 0;

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
// capped at 1.5: the sand mask is 1920 wide and the pictures smaller, so rendering at 2x on a
// high-density screen doubled the work for nothing the eye can see
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const loader = new THREE.TextureLoader();
function raw(t) {
  t.colorSpace = THREE.NoColorSpace;   // raw pass-through: the shaders output what they read
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
// the two pictures carry mipmaps: any blur of them is one lookup at the right level
function mip(t) {
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}
const tImg1 = mip(loader.load('./assets/img1.jpg'));
const tImg2 = mip(loader.load('./assets/img2.jpg'));
const IMG1_ASPECT = 1512 / 900;
const IMG2_ASPECT = 2560 / 1663;
const MASK_W = 1920, MASK_H = 1080;
const MASK_ASPECT = MASK_W / MASK_H;

const fwd = document.getElementById('fwd');
const rev = document.getElementById('rev');

// ---- the videos are downloaded IN FULL before they may play -------------------------------
// Streamed, a 7.7 MB clip played at speed 2 outruns most connections and stops part-way to
// buffer - the transition stuck at one point. Fetched whole into memory it can only play
// smoothly, and seeking (for the reverse) is instant. The forward clip comes first; the
// reverse follows in the background so the two never compete for the connection.
const ready = { fwd: false, rev: false };
let pendingDir = 0;                          // a scroll that came before the clip was ready
const hintEl = document.getElementById('hint');
const hintText = 'scroll ↓';   // the page shows 'loading…' until the clip is in
async function fetchWhole(url, onProgress) {
  const res = await fetch(url);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return URL.createObjectURL(await res.blob());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got / total);
  }
  return URL.createObjectURL(new Blob(parts, { type: 'video/mp4' }));
}
function attach(video, url) {
  return new Promise((resolve) => {
    video.addEventListener('canplaythrough', resolve, { once: true });
    video.src = url;
    video.load();
  });
}
(async () => {
  const fwdUrl = await fetchWhole(fwd.dataset.src, (f) => {
    if (hintEl) hintEl.textContent = 'loading ' + Math.round(f * 100) + '%';
  });
  await attach(fwd, fwdUrl);
  ready.fwd = true;
  if (hintEl) hintEl.textContent = hintText;
  // a scroll made before this script had even loaded, recorded by the page itself
  if (window.__earlyScroll > 0) pendingDir = 1;
  if (pendingDir > 0) { pendingDir = 0; run(1); }
  const revUrl = await fetchWhole(rev.dataset.src, () => {});
  await attach(rev, revUrl);
  ready.rev = true;
  if (pendingDir < 0) { pendingDir = 0; run(-1); }
})();
const tFwd = raw(new THREE.VideoTexture(fwd));
const tRev = raw(new THREE.VideoTexture(rev));

// ---- the mask, copied into a mipmapped target each frame ----------------------------------
const maskOpts = {
  format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
  generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
};
// rev 2: the CURRENT and the PREVIOUS frame of the clip, so the page can blend between them
let maskRT = new THREE.WebGLRenderTarget(MASK_W, MASK_H, maskOpts);
let maskPrev = new THREE.WebGLRenderTarget(MASK_W, MASK_H, maskOpts);
// transition9: the video is 1920 x 2160 - coverage in the top half, the sand's light in the
// bottom - so each copy reads its own half. The light needs no mips and no blending.
const lightOpts = {
  format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
  generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
};
let lightRT = new THREE.WebGLRenderTarget(MASK_W, MASK_H, lightOpts);
let lightPrev = new THREE.WebGLRenderTarget(MASK_W, MASK_H, lightOpts);
const lightScene = new THREE.Scene();
const lightMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  uniforms: { tVideo: { value: tFwd } },
  vertexShader: /* glsl */`
    out vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tVideo;
    in vec2 vUv;
    out vec4 outColor;
    void main() { outColor = vec4(texture(tVideo, vec2(vUv.x, vUv.y * 0.5)).r, 0.0, 0.0, 1.0); }`,   // the sand's light
});
lightScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lightMat));
const copyScene = new THREE.Scene();
const copyMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  uniforms: { tVideo: { value: tFwd }, tPrev: { value: null }, uKeep: { value: 0 } },
  vertexShader: /* glsl */`
    out vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tVideo, tPrev;
    uniform float uKeep;
    in vec2 vUv;
    out vec4 outColor;
    void main() {
      float now = texture(tVideo, vec2(vUv.x, 0.5 + vUv.y * 0.5)).r;   // the top half: coverage
      outColor = vec4(now, 0.0, 0.0, 1.0);
    }`,
});
copyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMat));

// ------------------------------------------------------------------ the page ----
const px = (a) => new THREE.Vector2(a[0] / MASK_W, a[1] / MASK_H);
const U = {
  tImg1: { value: tImg1 }, tImg2: { value: tImg2 }, tMask: { value: maskRT.texture },
  tMaskPrev: { value: maskPrev.texture }, tLightPrev: { value: lightPrev.texture }, uBlend: { value: 1 },
  uAspect: { value: 1 },
  uCover: { value: new THREE.Vector2(...CONFIG.cover) },
  uGrain: { value: new THREE.Vector3(CONFIG.grainShadow, CONFIG.grainBlur, 0) },
  uGrainOff: { value: px(CONFIG.grainOffset) },
  uSheet: { value: new THREE.Vector3(CONFIG.sheetShadow, CONFIG.sheetBlur, 0) },
  uSheetOff: { value: px(CONFIG.sheetOffset) },
  uAmbient: { value: new THREE.Vector2(CONFIG.ambient, CONFIG.ambientBlur) },
  uRelief: { value: new THREE.Vector3(CONFIG.relief, CONFIG.reliefBlur, CONFIG.edgeDarken) },
  uOn: { value: 0 }, uEnd: { value: 0 },
  uSoft: { value: new THREE.Vector2(CONFIG.soft, CONFIG.softBlur) },
  uFocus: { value: new THREE.Vector2(CONFIG.edgeBlur, CONFIG.focusBlur) },
  tLight: { value: lightRT.texture },
  uSandLight: { value: new THREE.Vector2(CONFIG.sandLight, CONFIG.glint) },
  uSand: { value: new THREE.Vector3(CONFIG.sandColor, CONFIG.alphaGamma, 0) },
  uClean: { value: new THREE.Vector3(CONFIG.clean, CONFIG.edge, CONFIG.crisp) },
  uMeanSand: { value: new THREE.Vector3(0.6759, 0.4942, 0.2409) },   // mask11.json mean_sand
};
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`
    out vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tImg1, tImg2, tMask, tLight, tMaskPrev, tLightPrev;
    uniform float uBlend;              // 0 = the previous frame of the clip, 1 = the current one
    uniform float uAspect, uOn, uEnd;
    uniform vec2 uSoft, uFocus, uSandLight;
    uniform vec3 uSand, uMeanSand, uClean;
    uniform vec2 uCover, uGrainOff, uSheetOff, uAmbient;
    uniform vec3 uGrain, uSheet, uRelief;
    in vec2 vUv;
    out vec4 outColor;

    vec2 cover(vec2 uv, float ia) {
      vec2 s = uAspect > ia ? vec2(1.0, ia / uAspect) : vec2(uAspect / ia, 1.0);
      return (uv - 0.5) * s + 0.5;
    }
    // the clip between its last two frames, so the sand moves smoothly at any refresh rate
    float sandAt(vec2 m, float lod) {
      m = clamp(m, 0.0, 1.0);
      return mix(textureLod(tMaskPrev, m, lod).r, textureLod(tMask, m, lod).r, uBlend);
    }
    float lightAt(vec2 m) {
      m = clamp(m, 0.0, 1.0);
      return mix(texture(tLightPrev, m).r, texture(tLight, m).r, uBlend);
    }

    void main() {
      vec2 m = cover(vUv, ${MASK_ASPECT.toFixed(6)});
      float live = uOn * (1.0 - uEnd);

      // the clip's transparency AS FILMED - no threshold: thin sand is partly see-through
      // the sand merged into clumps, then cut cleanly with a one-pixel antialiased edge
      float Ac = pow(clamp(sandAt(m, uClean.x), 0.0, 1.0), uSand.y);
      float aa = max(fwidth(Ac) * uClean.z, 1e-4);
      float cov = smoothstep(uClean.y - aa, uClean.y + aa, Ac);
      float k = mix(1.0, cov * (1.0 - uEnd), uOn);
      // where the sheet is breaking or flying (0 inside the intact sheet, which stays image 1)
      float Ab = sandAt(m, 3.0);
      float w = (1.0 - smoothstep(0.90, 0.99, Ab)) * live;

      vec3 img1 = texture(tImg1, cover(vUv, ${IMG1_ASPECT.toFixed(6)})).rgb;
      // the grains' own filmed light (1 = the sand's local average, flat 1 away from the edge)
      float L = lightAt(m) * 2.0;
      vec3 c1 = img1 * mix(1.0, L, uSandLight.x * live);
      // and the sand's warm colour as a smooth tint where the sheet breaks - its hue, at the
      // picture's own brightness
      const vec3 LUMA = vec3(0.299, 0.587, 0.114);
      vec3 tint = uMeanSand / max(dot(uMeanSand, LUMA), 1e-3);
      c1 *= mix(vec3(1.0), tint, uSand.x * w);

      // image 2, with only a faint contact shadow (the clip itself has none)
      vec3 c2 = texture(tImg2, cover(vUv, ${IMG2_ASPECT.toFixed(6)})).rgb;
      c2 *= 1.0 - uGrain.x * sandAt(m - uGrainOff, uGrain.y) * live;

      outColor = vec4(mix(c2, c1, k), 1.0);
    }`,
})));

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  U.uAspect.value = innerWidth / innerHeight;
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the clip ----
// Forwards is mask.mp4, backwards is mask-rev.mp4 (the same frames reversed) - seeking a
// video backwards frame by frame is not smooth anywhere, playing one is. Switching direction
// seeks the other file to the mirrored moment and swaps over only once that frame is on
// the texture, so the picture holds still for the moment it takes instead of flashing.
let active = fwd;
let want = 0;              // +1 forwards, -1 backwards, 0 still
let pos = 0;               // 0..1 along the forward clip
let swapping = false;
const hint = document.getElementById('hint');
fwd.playbackRate = rev.playbackRate = CONFIG.speed;
fwd.defaultPlaybackRate = rev.defaultPlaybackRate = CONFIG.speed;

const dur = (v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 6.36);
const posOf = (v) => (v === fwd ? v.currentTime / dur(v) : 1 - v.currentTime / dur(v));

// run fn once the video has put its current frame on screen (and so on the texture); a
// timeout backs it up for browsers without the callback or that skip it for a paused video
function onFrame(v, fn) {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(once);
  setTimeout(once, 150);
}

// transition5: the mask may only switch on once the video has actually put a frame on the
// texture since playback began. Switched on at the moment play() is called, it read an empty
// texture for a frame or two - a flash of image 2 over the whole screen at the start.
let framesShown = 0, framesAtStart = 0;
let lastFrameAt = 0, copiedFrame = -1;
const hasVFC = 'requestVideoFrameCallback' in fwd;
for (const v of [fwd, rev]) {
  if (!hasVFC) break;
  const count = () => {
    if (!v.paused) { framesShown++; lastFrameAt = performance.now(); }
    v.requestVideoFrameCallback(count);
  };
  v.requestVideoFrameCallback(count);
}

function run(dir) {
  // not downloaded yet: remember the request and start it the moment the clip is ready
  if ((dir > 0 && !ready.fwd) || (dir < 0 && !ready.rev && active !== rev)) {
    pendingDir = dir;              // (the hint stays up: it is showing the download)
    return;
  }
  if (pos <= 0.0005) framesAtStart = framesShown;
  want = dir;
  const target = dir > 0 ? fwd : rev;
  if (dir > 0 && hint) hint.classList.add('off');
  if (active === target) {
    if (target.ended || (dir > 0 && pos >= 1) || (dir < 0 && pos <= 0)) return;
    target.playbackRate = CONFIG.speed;
    target.play().catch(() => {});
    return;
  }
  if (swapping) return;
  // the other file, at the mirrored moment
  swapping = true;
  active.pause();
  const p = posOf(active);
  const go = () => {
    const q = target === fwd ? p : 1 - p;    // the same moment, counted along that file
    target.currentTime = Math.min(Math.max(q, 0), 1) * dur(target);
    target.addEventListener('seeked', () => {
      onFrame(target, () => {
        active = target;
        copyMat.uniforms.tVideo.value = target === fwd ? tFwd : tRev;
        lightMat.uniforms.tVideo.value = target === fwd ? tFwd : tRev;
        swapping = false;
        if (want === dir) { target.playbackRate = CONFIG.speed; target.play().catch(() => {}); }
        else run(want);
      });
    }, { once: true });
  };
  if (target.readyState >= 1) go(); else target.addEventListener('loadedmetadata', go, { once: true });
}
const forward = () => { if (pos < 1 || active !== fwd) run(1); };
const backward = () => { if (pos > 0) run(-1); };

fwd.addEventListener('ended', () => { pos = 1; });
rev.addEventListener('ended', () => { pos = 0; if (hint) hint.classList.remove('off'); });

const inPanel = (e) => !!(e.target && e.target.closest && e.target.closest('#pui'));
addEventListener('wheel', (e) => { if (inPanel(e)) return; if (e.deltaY > 2) forward(); else if (e.deltaY < -2) backward(); }, { passive: true });
let touchY = null;
addEventListener('touchstart', (e) => { touchY = inPanel(e) ? null : e.touches[0].clientY; }, { passive: true });
addEventListener('touchmove', (e) => {
  if (touchY === null) return;
  const dy = touchY - e.touches[0].clientY;
  if (dy > 20) { forward(); touchY = null; } else if (dy < -20) { backward(); touchY = null; }
}, { passive: true });
addEventListener('keydown', (e) => {
  if (['ArrowDown', 'PageDown', ' ', 'End'].includes(e.key)) forward();
  if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) backward();
});

function syncUniforms() {
  U.uCover.value.set(CONFIG.cover[0], CONFIG.cover[1]);
  U.uGrain.value.x = CONFIG.grainShadow;
  U.uSheet.value.x = CONFIG.sheetShadow;
  U.uAmbient.value.x = CONFIG.ambient;
  U.uRelief.value.set(CONFIG.relief, CONFIG.reliefBlur, CONFIG.edgeDarken);
  U.uSoft.value.set(CONFIG.soft, CONFIG.softBlur);
  U.uFocus.value.set(CONFIG.edgeBlur, CONFIG.focusBlur);
  U.uSandLight.value.set(CONFIG.sandLight, CONFIG.glint);
  U.uSand.value.set(CONFIG.sandColor, CONFIG.alphaGamma, 0);
  U.uClean.value.set(CONFIG.clean, CONFIG.edge, CONFIG.crisp);
}

// the effect's fade in: 0 = clean image 1, 1 = the full effect. Eased, so it starts and settles
// softly instead of switching on in one frame
let onLevel = 0;
let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const nowT = performance.now();
  const dtF = Math.min(0.1, (nowT - lastT) / 1000);
  lastT = nowT;
  syncUniforms();
  if (!swapping && active.readyState >= 2) pos = Math.min(Math.max(posOf(active), 0), 1);
  // the mask is on once the clip has shown a frame past its start; before that (and back at
  // the start after scrolling up) the page is image 1 exactly
  const maskHasFrames = hasVFC ? framesShown - framesAtStart >= 2 : pos > 0.02;
  const want = pos > 0.0005 && maskHasFrames ? 1 : 0;
  const stepF = CONFIG.startFade > 0 ? dtF / CONFIG.startFade : 1;
  onLevel = want ? Math.min(1, onLevel + stepF) : Math.max(0, onLevel - stepF);
  U.uOn.value = onLevel * onLevel * (3 - 2 * onLevel);
  U.uEnd.value = THREE.MathUtils.smoothstep(pos, CONFIG.endFade[0], CONFIG.endFade[1]);
  // rev 2: a NEW frame of the clip is copied in once, the old current one becoming the
  // previous; between new frames the page blends from previous to current over the time the
  // next frame is due, so the sand never stands still for a refresh and then jumps. While the
  // clip is not playing (before, after, during a swap) both hold the same frame.
  const playing = hasVFC && !active.paused && !swapping;
  const copyInto = (mRT, lRT) => {
    renderer.setRenderTarget(mRT); renderer.render(copyScene, camera);
    renderer.setRenderTarget(lRT); renderer.render(lightScene, camera);
  };
  if (!playing) {
    copyInto(maskRT, lightRT); copyInto(maskPrev, lightPrev);
    copiedFrame = framesShown;
    U.uBlend.value = 1;
  } else {
    if (copiedFrame !== framesShown) {
      let t = maskRT; maskRT = maskPrev; maskPrev = t;
      t = lightRT; lightRT = lightPrev; lightPrev = t;
      copyInto(maskRT, lightRT);
      copiedFrame = framesShown;
    }
    const interval = 1000 / (25 * Math.max(0.05, CONFIG.speed));
    U.uBlend.value = Math.min(1, Math.max(0, (nowT - lastFrameAt) / interval));
  }
  renderer.setRenderTarget(null);
  U.tMask.value = maskRT.texture; U.tMaskPrev.value = maskPrev.texture;
  U.tLight.value = lightRT.texture; U.tLightPrev.value = lightPrev.texture;
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- the panel ----
// On by default - it is how the look is being chosen. ?ui=0 removes it. Every bar is live; the
// readout is the value to write into CONFIG once it is settled.
const uiEl = document.getElementById('pui');
if (uiEl && PARAMS.get('ui') === '0') uiEl.remove();
else if (uiEl) {
  const sec = (title) => ({ section: title });
  const row = (key, name, min, max, step, get, set, digits = 2) => ({ key, name, min, max, step, get, set, digits });
  const cfg = (k) => [() => CONFIG[k], (v) => { CONFIG[k] = v; }];
  const ROWS = [
    sec('playback'),
    row('startFade', 'start fade', 0, 2, 0.05, ...cfg('startFade')),
    row('speed', 'speed', 0.25, 4, 0.05, () => CONFIG.speed, (v) => {
      CONFIG.speed = v;
      for (const vid of [fwd, rev]) { vid.defaultPlaybackRate = v; if (!vid.paused) vid.playbackRate = v; }
    }),
    sec('the sand at the edge'),
    row('clean', 'clean (merge speckle)', 0, 4, 0.05, ...cfg('clean')),
    row('edge', 'edge position', 0.05, 0.95, 0.01, ...cfg('edge')),
    row('crisp', 'edge softness (px)', 0.5, 6, 0.1, ...cfg('crisp'), 1),
    row('sandColor', 'sand tint', 0, 1, 0.01, ...cfg('sandColor')),
    row('sandLight', 'grain light', 0, 2, 0.01, ...cfg('sandLight')),
    sec('shadow'),
    row('grainShadow', 'contact shadow', 0, 1, 0.01, ...cfg('grainShadow')),
  ];
  uiEl.innerHTML = '<div class="btns"><button type="button" id="pPlay">play ▶</button>'
    + '<button type="button" id="pBack">◀ back</button></div>'
    + ROWS.map((r, i) => r.section ? '<h2>' + r.section + '</h2>'
      : '<div class="row"><div class="lbl"><span class="name">' + r.name + '</span>'
        + '<span class="val" id="pv' + i + '">' + r.get().toFixed(r.digits) + '</span></div>'
        + '<input type="range" id="pr' + i + '" min="' + r.min + '" max="' + r.max + '" step="' + r.step
        + '" value="' + r.get() + '"></div>').join('')
    + '<div class="foot">?ui=0 removes this panel</div>';
  ROWS.forEach((r, i) => {
    if (r.section) return;
    const el = document.getElementById('pr' + i);
    el.addEventListener('input', () => {
      r.set(parseFloat(el.value));
      document.getElementById('pv' + i).textContent = r.get().toFixed(r.digits);
    });
  });
  document.getElementById('pPlay').addEventListener('click', forward);
  document.getElementById('pBack').addEventListener('click', backward);
}
