// TRANSITION 12 — transition11's reveal (the footage's own alpha, sharp, with inertia) plus
// grains with VOLUME coming off its edge - see "the grains" below.
//
// TRANSITION 11 (rev 4) — the client's notes: particles "soapy", "like noise", a pause/freeze,
// no inertia, the last frames melting into a fade. So:
//   SHARP     the mask is 2560 wide (area-scaled from the 4K master), the speckle only lightly
//             merged (clean 0.6), and NO frame blending - blending two frames ghosted every grain
//   PLAIN     the sand is image 1 itself, white - no grain light, no tint (both read as noise)
//   NO PAUSE  the clip is trimmed to the motion, and the start fade is 0.15 s
//   INERTIA   playback eases in over CONFIG.accel and slows into the end (CONFIG.settle) instead of
//             starting and stopping dead
//   NO MELT   the closing fade to image 2 is the last 2%, not 7%
//
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
  speed: num('speed', 2.0),
  // transition12: the grains
  cell: num('cell', 3.0),        // css px per grain cell
  windAngle: 18,                 // degrees: the way the clip's sand blows (up and to the right)
  wind: 0.45,                    // screen heights per second
  kick: 0.30,                    // the throw as a grain comes loose
  liftZ: 0.35,                   // how fast a grain rises off the picture (was 0.55)
  airDrag: 1.6,                  // how quickly the air takes a grain over (per second)
  gravity: 0.25,                 // a little fall
  turbulence: 0.06,              // PTSVer30's field, roughening the paths
  turbSize: 3.0,                 // its eddies: higher = smaller
  life: 0.5,                     // s a loose grain lasts - short, so the sand dissolves off the edge (was 1.6)
  grainSize: 0.6,                // x the cell: small sand (was 1.0)
  bigGrains: 0.0,                // no large foreground grains - small sand only (was 0.04)
  perspective: 0.25,             // grains barely grow as they rise (was 1.2 - they became spheres)
  grainShadowA: 0.45,            // the grain's shadow on image 2
  shadowDistance: 0.10,          // how far the shadow falls per unit of height      // playback rate (2 = the 6.4 s clip in 3.2 s)
  cover: [0.30, 0.62],           // alpha where image 1 starts to show, and where it is solid
  // the shadows on image 2. Offsets in mask pixels (1920 wide), down and to the right
  grainShadow: 0.10,             // each grain's own tight shadow
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
  endFade: [0.98, 1.0],          // rev 4: the last 2% only - the sand clears itself, no melting fade
  startFade: 0.15,               // s the effect takes to come in from clean image 1 (rev 4: was 0.6 - a pause)
  accel: 0.5,                    // s playback takes to reach full speed - inertia instead of a jump start
  settle: 0.55,                  // the speed it slows to over the last quarter (share of full speed)
  // transition5
  steady: 0.0,
  sandLight: 0.0,                // the grains' own light and shade, as filmed (1)
  sandColor: 0.0,               // 0 = image 1's colours on the sand, 1 = the clip's golden sand
  alphaGamma: 1.0,
  clean: 0.6,                    // how far the speckle is merged into clumps (blur level; 0 = raw)
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
const MASK_W = 2560, MASK_H = 1440;   // rev 4: assets/mask11.json
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
      float now = texture(tVideo, vUv).r;   // rev 4: the whole frame is the alpha
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

// ---------------------------------------------------------------- the grains ----
// transition12: the reveal is transition11's - the footage's own alpha - and grains come off its
// edge WITH VOLUME. The screen is a grid of cells (CONFIG.cell px); a cell's grain is released in
// the frame the footage's sand leaves that cell, by the very test the reveal uses, so grains peel
// off exactly where the clip's edge passes (and go back when scrolling up). Once loose a grain is
// simulated: blown the way the clip's sand blows, roughened by PTSVer30's field, lifted off the
// picture toward the viewer. The volume is in three things: it grows as it rises (perspective),
// its shadow on image 2 moves away and softens with its height - the strongest depth cue - and it
// is drawn as a lit sphere with a highlight, in a range of sizes with a few large foreground ones.
// PTSVer30's 3D simplex noise with derivatives, and its divergent curl
const GLSL_SNOISE = /* glsl */`
vec3 mod289v3(vec3 x){ return x - floor(x / 289.0) * 289.0; }
vec4 mod289v4(vec4 x){ return x - floor(x / 289.0) * 289.0; }
vec4 permute(vec4 x){ return mod289v4((x * 34.0 + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

vec4 snoise3dDeriv(vec3 p){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(p + dot(p, vec3(C.y)));
  vec3 x0 = p - i + dot(i, vec3(C.x));

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.x;
  vec3 x2 = x0 - i2 + C.y;
  vec3 x3 = x0 - D.yyy;

  i = mod289v3(i);
  vec4 pp = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  // gradients on a 7x7 grid over an octahedron
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = pp - 49.0 * floor(pp * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 g0 = vec3(a0.xy, h.x);
  vec3 g1 = vec3(a0.zw, h.y);
  vec3 g2 = vec3(a1.xy, h.z);
  vec3 g3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(g0,g0), dot(g1,g1), dot(g2,g2), dot(g3,g3)));
  g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m3 = m2 * m;
  vec4 m4 = m2 * m2;

  vec4 gdotx = vec4(dot(g0,x0), dot(g1,x1), dot(g2,x2), dot(g3,x3));

  float value = 42.0 * dot(m4, gdotx);

  // d/dx [ m^4 * dot(g,x) ] = m^4 * g  -  8 * m^3 * dot(g,x) * x, summed over the corners
  vec3 grad = 42.0 * (
      m4.x * g0 + m4.y * g1 + m4.z * g2 + m4.w * g3
    - 8.0 * ( m3.x * gdotx.x * x0 + m3.y * gdotx.y * x1
            + m3.z * gdotx.z * x2 + m3.w * gdotx.w * x3 ));

  return vec4(grad, value);
}

// Divergence-free flow: the curl of a vector potential built from three independent
// noise fields. Because div(curl A) == 0, motes advected through it never compress or
// spread — the cloud keeps its density wherever the field takes it, which is the whole
// reason this is used instead of plain noise offsets.
vec3 curlNoise(vec3 position, float frequency, float time, float amplitude, float divergence){
  vec3 sp = position * frequency + vec3(0.0, 0.0, time);

  vec3 gA1 = snoise3dDeriv(sp).xyz;
  vec3 gA2 = snoise3dDeriv(sp + vec3( 17.0, 59.0, 113.0)).xyz;
  vec3 gA3 = snoise3dDeriv(sp + vec3(101.0,  7.0,  23.0)).xyz;

  vec3 curl = vec3(gA3.y - gA2.z,
                   gA1.z - gA3.x,
                   gA2.x - gA1.y);

  // A curl alone can only swirl. It is divergence-free by construction, so the volume it
  // carries is conserved: the field can shear, fold and braid, but no patch of it ever
  // spreads. An ink plume does spread, and the amount is not a detail — measured on the
  // reference, the field's divergence and its vorticity are the same size right through
  // the clip. That is a field which expands as much as it turns, and no amount of curl
  // reaches it.
  //
  // The partner is the GRADIENT of a fourth, decorrelated noise. A gradient is curl-free
  // and purely divergent, so it is the clean complement: at 0 this is the old field, at 1
  // the two are equal and the mix has the reference's balance.
  //
  // The 0.707 is what makes "equal" true. A curl component is the difference of two
  // independent derivative components and so carries twice their variance; a gradient
  // component is one of them. Scaling by 1/sqrt(2) puts the two terms at the same rms.
  vec3 grad = snoise3dDeriv(sp + vec3(41.0, 149.0, 71.0)).xyz;

  // divide by frequency so raising the detail does not also raise the displacement
  return (curl + grad * (divergence * 0.70711)) * (amplitude / max(frequency, 1e-6));
}
`;

let GCELL = CONFIG.cell;
while (Math.ceil(innerWidth / GCELL) * Math.ceil(innerHeight / GCELL) > 500000) GCELL *= 1.1;
const GW = Math.ceil(innerWidth / GCELL), GH = Math.ceil(innerHeight / GCELL);
const G = {
  tMask: U.tMask, uAspect: U.uAspect, uClean: U.uClean, uSand: U.uSand, uOn: U.uOn, uEnd: U.uEnd,
  tImg1: U.tImg1,
  tSeed: { value: null }, tPos: { value: null }, tVel: { value: null },
  uTime: { value: 0 }, uDt: { value: 1 / 60 },
  uWindDir: { value: new THREE.Vector2(1, 0) }, uWind: { value: 0 }, uGrav: { value: 0 },
  uKick: { value: 0 }, uLiftZ: { value: 0 }, uAirDrag: { value: 1 }, uTurb: { value: 0 },
  uTurbFreq: { value: 3 }, uLife: { value: 1.5 }, uSize: { value: 1 }, uBig: { value: 0.04 },
  uPersp: { value: 0.8 }, uShadowA: { value: 0.4 }, uShadowDist: { value: 0.08 },
  uCellPx: { value: GCELL }, uDpr: { value: 1 },
};
const G_COMMON = /* glsl */`
  uniform sampler2D tMask, tSeed, tPos, tVel;
  uniform float uAspect, uOn, uEnd, uTime, uDt;
  uniform vec3 uClean, uSand;
  vec2 coverM(vec2 uv) {
    float ia = ${MASK_ASPECT.toFixed(6)};
    vec2 s = uAspect > ia ? vec2(1.0, ia / uAspect) : vec2(uAspect / ia, 1.0);
    return (uv - 0.5) * s + 0.5;
  }
  // the same test the reveal makes: is the footage's sand still on this point?
  bool covered(vec2 uv) {
    if (uOn < 0.5) return true;
    float a = pow(clamp(textureLod(tMask, clamp(coverM(uv), 0.0, 1.0), uClean.x).r, 0.0, 1.0), uSand.y);
    return a >= uClean.y;
  }
`;
const G_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const G_SIM = /* glsl */`
  precision highp float;
  ${G_COMMON}
  ${GLSL_SNOISE}
  uniform vec2 uWindDir;
  uniform float uWind, uGrav, uKick, uLiftZ, uAirDrag, uTurb, uTurbFreq;
  varying vec2 vUv;
  vec3 turbulence(vec3 p) {
    float t = uTime * 0.45;
    vec3 v  = curlNoise(p, uTurbFreq,       t,       1.0, 0.75);
    v      += curlNoise(p, uTurbFreq * 3.1, t * 1.7, 0.7, 0.75);
    return v * uTurbFreq;
  }
`;
const gVelMat = new THREE.ShaderMaterial({
  uniforms: G, vertexShader: G_VERT, depthTest: false, depthWrite: false,
  fragmentShader: G_SIM + /* glsl */`
    void main() {
      vec4 seed = texture2D(tSeed, vUv);
      vec4 pos = texture2D(tPos, vUv);
      vec3 v = texture2D(tVel, vUv).xyz;
      if (covered(seed.xy)) { gl_FragColor = vec4(0.0); return; }
      if (pos.w < 0.0) {
        // comes loose: thrown the way the sand blows, each a little its own way, and lifted
        // off the picture toward the viewer
        float ang = (seed.z - 0.5) * 0.9;
        vec2 kd = vec2(uWindDir.x * cos(ang) - uWindDir.y * sin(ang), uWindDir.x * sin(ang) + uWindDir.y * cos(ang));
        v = vec3(kd * uKick * (0.5 + seed.w), uLiftZ * (0.3 + 1.4 * fract(seed.w * 7.3)));
      } else {
        vec3 air = vec3(uWindDir * uWind, 0.0) + turbulence(vec3(pos.xy, pos.z + 3.0 * seed.z)) * uTurb;
        v += (air - v) * clamp(uAirDrag * (0.7 + 0.6 * seed.w) * uDt, 0.0, 1.0);
        v.y -= uGrav * uDt;
      }
      gl_FragColor = vec4(v, 1.0);
    }`,
});
const gPosMat = new THREE.ShaderMaterial({
  uniforms: G, vertexShader: G_VERT, depthTest: false, depthWrite: false,
  fragmentShader: G_SIM + /* glsl */`
    void main() {
      vec4 seed = texture2D(tSeed, vUv);
      vec4 pos = texture2D(tPos, vUv);
      vec3 v = texture2D(tVel, vUv).xyz;
      vec3 home = vec3(seed.x * uAspect, seed.y, 0.0);
      if (covered(seed.xy)) { gl_FragColor = vec4(home, -1.0); return; }
      if (pos.w < 0.0) { gl_FragColor = vec4(home, 0.0); return; }
      gl_FragColor = vec4(pos.xyz + v * uDt, pos.w + uDt);
    }`,
});
const gType = renderer.extensions.get('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
const gRT = () => new THREE.WebGLRenderTarget(GW, GH, {
  type: gType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
});
let gPosA = gRT(), gPosB = gRT(), gVelA = gRT(), gVelB = gRT();
{
  const seed = new Float32Array(GW * GH * 4);
  for (let i = 0; i < GW * GH; i++) {
    seed[i * 4] = ((i % GW) + 0.5) / GW;
    seed[i * 4 + 1] = (Math.floor(i / GW) + 0.5) / GH;
    seed[i * 4 + 2] = Math.random();
    seed[i * 4 + 3] = Math.random();
  }
  const t = new THREE.DataTexture(seed, GW, GH, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  G.tSeed.value = t;
}
const gScene = new THREE.Scene();
const gQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gVelMat);
gScene.add(gQuad);
function stepGrains(dt) {
  G.uDt.value = dt;
  G.uTime.value += dt;
  G.tPos.value = gPosA.texture; G.tVel.value = gVelA.texture;
  gQuad.material = gVelMat;
  renderer.setRenderTarget(gVelB); renderer.render(gScene, camera);
  G.tVel.value = gVelB.texture;
  gQuad.material = gPosMat;
  renderer.setRenderTarget(gPosB); renderer.render(gScene, camera);
  renderer.setRenderTarget(null);
  [gPosA, gPosB] = [gPosB, gPosA];
  [gVelA, gVelB] = [gVelB, gVelA];
  G.tPos.value = gPosA.texture; G.tVel.value = gVelA.texture;
}

// drawing: the grain as a lit sphere; its shadow, in a pass of its own under the grains, moved
// away and softened by the grain's height
const gDrawVert = (shadow) => /* glsl */`
  uniform sampler2D tSeed, tPos, tImg1;
  uniform float uAspect, uEnd, uLife, uSize, uBig, uPersp, uShadowA, uShadowDist, uCellPx, uDpr;
  attribute vec2 aRef;
  varying vec3 vCol; varying float vAlpha; varying float vSoft;
  void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
  vec2 coverI(vec2 uv) {
    float ia = ${IMG1_ASPECT.toFixed(6)};
    vec2 s = uAspect > ia ? vec2(1.0, ia / uAspect) : vec2(uAspect / ia, 1.0);
    return (uv - 0.5) * s + 0.5;
  }
  void main() {
    vec4 seed = texture2D(tSeed, aRef);
    vec4 st = texture2D(tPos, aRef);
    if (st.w < 0.0) { hide(); return; }                 // still part of the picture
    float life = uLife * (0.6 + 0.8 * fract(seed.w * 5.3));
    float a = (1.0 - smoothstep(life * 0.15, life, st.w)) * (1.0 - uEnd);
    if (a <= 0.002) { hide(); return; }
    float z = max(st.z, 0.0);
    // sizes: most about a cell, a few large foreground grains
    float big = step(1.0 - uBig, fract(seed.z * 17.3));
    float size = uCellPx * uSize * (0.75 + 0.6 * fract(seed.z * 7.3)) * mix(1.0, 2.6, big);
    float grow = 1.0 + z * uPersp;                       // nearer the viewer, larger
    vec2 xy = st.xy;
    ${shadow
      ? 'xy += vec2(0.55, -1.0) * z * uShadowDist; size *= 1.0 + z * 1.0; vSoft = clamp(z * 4.0, 0.0, 1.0); a *= uShadowA * (1.0 - 0.6 * clamp(z * 2.5, 0.0, 1.0));'
      : 'size *= grow; vSoft = 0.0;'}
    if (xy.x < -0.05 || xy.x > uAspect + 0.05 || xy.y < -0.05 || xy.y > 1.05) { hide(); return; }
    vCol = texture2D(tImg1, coverI(seed.xy)).rgb * (0.92 + 0.16 * fract(seed.w * 13.1));
    vAlpha = a;
    gl_Position = vec4(xy.x / uAspect * 2.0 - 1.0, xy.y * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = max(size * uDpr, 1.0);
  }`;
const gDrawFrag = (shadow) => /* glsl */`
  varying vec3 vCol; varying float vAlpha; varying float vSoft;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    d.y = -d.y;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard;
    ${shadow ? `
    float a = vAlpha * (1.0 - smoothstep(mix(0.3, 0.0, vSoft), 1.0, r2));
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);` : `
    // a sphere: lit from the upper left, with a highlight and a darker underside
    vec3 n = vec3(d, sqrt(1.0 - r2));
    vec3 L = normalize(vec3(-0.45, 0.6, 0.66));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
    vec3 col = vCol * (0.42 + 0.72 * diff) + spec * 0.28;
    float a = vAlpha * smoothstep(1.0, 0.8, r2);
    gl_FragColor = vec4(col * a, a);`}
  }`;
const gDrawMat = (shadow) => new THREE.ShaderMaterial({
  uniforms: G, transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  vertexShader: gDrawVert(shadow), fragmentShader: gDrawFrag(shadow),
});
{
  const n = GW * GH;
  const ref = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    ref[i * 2] = ((i % GW) + 0.5) / GW;
    ref[i * 2 + 1] = (Math.floor(i / GW) + 0.5) / GH;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aRef', new THREE.BufferAttribute(ref, 2));
  const shadows = new THREE.Points(g, gDrawMat(true));
  shadows.frustumCulled = false; shadows.renderOrder = 1;
  scene.add(shadows);
  const grains = new THREE.Points(g, gDrawMat(false));
  grains.frustumCulled = false; grains.renderOrder = 2;
  scene.add(grains);
}
function syncGrains() {
  const a = THREE.MathUtils.degToRad(CONFIG.windAngle);
  G.uWindDir.value.set(Math.cos(a), Math.sin(a));
  G.uWind.value = CONFIG.wind; G.uGrav.value = CONFIG.gravity; G.uKick.value = CONFIG.kick;
  G.uLiftZ.value = CONFIG.liftZ; G.uAirDrag.value = CONFIG.airDrag; G.uTurb.value = CONFIG.turbulence;
  G.uTurbFreq.value = CONFIG.turbSize; G.uLife.value = CONFIG.life; G.uSize.value = CONFIG.grainSize;
  G.uBig.value = CONFIG.bigGrains; G.uPersp.value = CONFIG.perspective;
  G.uShadowA.value = CONFIG.grainShadowA; G.uShadowDist.value = CONFIG.shadowDistance;
  G.uDpr.value = renderer.getPixelRatio();
}
if (PARAMS.get('debug') === '1') window.__t12 = { renderer, get pos() { return gPosA; }, W: GW, H: GH };

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

const dur = (v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 6.16);
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

let playStartAt = 0;
function run(dir) {
  playStartAt = performance.now();
  rateNow = 0;              // the ease starts over
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
// rev 4: INERTIA - the playback rate eases up to speed after a start and slows into the end
let rateNow = 0;
function easeRate(nowT) {
  if (active.paused || swapping) return;
  const t = (nowT - playStartAt) / 1000;
  const up = CONFIG.accel > 0 ? Math.min(1, t / CONFIG.accel) : 1;
  const inF = 0.3 + 0.7 * up * up * (3 - 2 * up);
  const left = active === fwd ? 1 - pos : pos;              // share of the clip still to play
  // slows smoothly over the last quarter, down to CONFIG.settle of full speed at the very end
  const k = Math.min(1, left / 0.25);
  const outF = CONFIG.settle + (1 - CONFIG.settle) * k * k * (3 - 2 * k);
  const rate = Math.max(0.07, CONFIG.speed * inF * outF);
  if (Math.abs(rate - rateNow) > 0.015) { active.playbackRate = rate; rateNow = rate; }
}
renderer.setAnimationLoop(() => {
  const nowT = performance.now();
  easeRate(nowT);
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
    // rev 4: no blending between frames - it ghosted every grain into soap
    U.uBlend.value = 1;
  }
  renderer.setRenderTarget(null);
  U.tMask.value = maskRT.texture; U.tMaskPrev.value = maskPrev.texture;
  U.tLight.value = lightRT.texture; U.tLightPrev.value = lightPrev.texture;
  // transition12: the grains, stepped against this frame's mask
  syncGrains();
  // stepped by the real frame time, so a grain's life is real seconds even on a slow device
  stepGrains(dtF);
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
    row('accel', 'speed-up (s)', 0, 2, 0.05, ...cfg('accel')),
    row('settle', 'slow into end', 0.2, 1, 0.01, ...cfg('settle')),
    row('speed', 'speed', 0.25, 4, 0.05, () => CONFIG.speed, (v) => {
      CONFIG.speed = v;
      for (const vid of [fwd, rev]) { vid.defaultPlaybackRate = v; if (!vid.paused) vid.playbackRate = v; }
    }),
    sec('the sand at the edge'),
    row('clean', 'clean (merge speckle)', 0, 4, 0.05, ...cfg('clean')),
    row('edge', 'edge position', 0.05, 0.95, 0.01, ...cfg('edge')),
    row('crisp', 'edge softness (px)', 0.5, 6, 0.1, ...cfg('crisp'), 1),
    sec('grains'),
    row('wind', 'wind', 0, 1.5, 0.01, ...cfg('wind')),
    row('windAngle', 'wind direction (deg)', -180, 180, 1, ...cfg('windAngle'), 0),
    row('kick', 'throw', 0, 1.5, 0.01, ...cfg('kick')),
    row('liftZ', 'lift toward viewer', 0, 2, 0.01, ...cfg('liftZ')),
    row('airDrag', 'air drag', 0.2, 6, 0.1, ...cfg('airDrag'), 1),
    row('gravity', 'gravity', 0, 2, 0.01, ...cfg('gravity')),
    row('turbulence', 'turbulence', 0, 0.4, 0.005, ...cfg('turbulence'), 3),
    row('life', 'life (s)', 0.2, 5, 0.05, ...cfg('life')),
    row('grainSize', 'grain size', 0.3, 3, 0.05, ...cfg('grainSize')),
    row('bigGrains', 'big grains', 0, 0.3, 0.005, ...cfg('bigGrains'), 3),
    row('perspective', 'depth (grow when rising)', 0, 4, 0.05, ...cfg('perspective')),
    row('grainShadowA', 'grain shadow', 0, 1, 0.01, ...cfg('grainShadowA')),
    row('shadowDistance', 'shadow distance', 0, 0.4, 0.005, ...cfg('shadowDistance'), 3),
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
