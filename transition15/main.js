// TRANSITION 15 (rev 2) — smooth, and PARTICLES, not spheres: soft flat dots in image 1's own
// colours, small and fairly even; each piece of the picture fades out over a moment while its
// particle fades in (no hard switch); a broader, softer front; larger, slower swirls and longer,
// gentler fades.
//
// TRANSITION 15 — image 1 dissolves into PTSVer4's spheres.
//
// The reveal grows out of the top-right corner, the way the PTS cloud blooms out of its corner:
// an organic, lobed front that breaks the picture up in clumps. Each piece of image 1 that comes
// loose becomes a PTSVer4 mote - a sphere impostor lit by a wrapped key light and a cool fill,
// with a tight specular glint and a fresnel rim that also drives its alpha, so the motes read as
// shells rather than beads - carrying that piece's colour. Sizes follow PTSVer4's steep spread:
// mostly tiny, a few large bubbles. They drift out from the corner, float up, curl in a swirling
// field, fade with depth, and are gone within about a second; nothing is left at the end.
//
// The engine is transition13's: no video, everything computed from the progress alone (stable,
// exactly reversible), each piece's moment worked out once into the CELL texture.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  duration: num('dur', 3.2),     // s, the reveal at full speed
  accel: 0.35,                   // s to reach full speed (inertia); it eases into the end too
  band: 0.40,                    // how deep the dissolving band is - broad, so it is gradual
  streak: 0.60,                  // how much it breaks in clumps (softer than 0.85)
  dune: 0.06,                    // how lobed the front is
  cell: num('cell', 4.0),        // css px per piece of the picture
  gapLead: 0.012,
  handover: 0.035,               // share of the reveal over which a piece fades out as its particle fades in
  softness: 0.6,                 // particle edge softness (0 = crisp dot, 1 = very soft)
  // PTSVer4's motes
  sizeMin: 1.1,                  // px, the smallest particle
  sizeMax: 3.0,                  // px, the largest - small particles, no bubbles
  sizeBias: 1.6,                 // how strongly they lean small
  kick: 0.07,                    // drift out of the corner (screen heights per second)
  float: 0.08,                   // and up
  curlAmp: 0.08,                 // the swirl: how far it carries a particle
  curlFreq: 1.6,                 // its size: lower = larger, smoother eddies
  curlSpeed: 0.5,                // how fast it evolves - slow
  life: 1.5,                     // s a particle lives, fading softly
  grainSize: 1.0,                // x all sizes
  wrap: 0.45,                    // key light wrapped past the terminator
  fill: 0.30,                    // the cool fill
  specular: 0.38,                // the glint
  shininess: 40.0,
  rim: 0.18,                     // the fresnel rim
  coreAlpha: 0.78,               // opacity through the middle of a sphere - low reads as shells
  depthFade: 0.25,               // alpha lost toward the back
  depthDarken: 0.10,             // brightness lost toward the back
  // the page
  edgeShadow: 0.18,              // the breaking edge's shadow on image 2
  ripple: 0.0, rippleLength: 0.2, rippleFreq: 55, windAngle: 0, accelWind: 0, wobble: 0, lift: 0,
  motionStreak: 0, grainShadow: 0, shadowDistance: 0,
};

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const loader = new THREE.TextureLoader();
function img(url) {
  const t = loader.load(url);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}
const tImg1 = img('./assets/img1.jpg');
const tImg2 = img('./assets/img2.jpg');
const IMG1_ASPECT = 1512 / 900, IMG2_ASPECT = 2560 / 1663;

// ------------------------------------------------------------- shared GLSL ----
const NOISE = /* glsl */`
  vec3 permute3(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * snoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;
const QUAD_VERT = /* glsl */`
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// shared uniforms
const U = {
  tImg1: { value: tImg1 }, tImg2: { value: tImg2 }, tCell: { value: null },
  uScreen: { value: new THREE.Vector2(innerWidth, innerHeight) }, uDpr: { value: 1 },
  uCell: { value: CONFIG.cell }, uP: { value: 0 }, uD: { value: CONFIG.duration },
  uWind: { value: new THREE.Vector2(1, 0) }, uU0: { value: 0 }, uU1: { value: 1 },
  uF0: { value: 0 }, uF1: { value: 1 },
  uBand: { value: CONFIG.band }, uStreak: { value: CONFIG.streak }, uDune: { value: CONFIG.dune },
  uGapLead: { value: CONFIG.gapLead }, uHandover: { value: CONFIG.handover }, uSoftness: { value: CONFIG.softness },
  uKick: { value: CONFIG.kick }, uAccelW: { value: CONFIG.accelWind }, uWob: { value: CONFIG.wobble },
  uFloat: { value: CONFIG.float }, uCurlAmp: { value: CONFIG.curlAmp }, uCurlFreq: { value: CONFIG.curlFreq },
  uCurlSpeed: { value: CONFIG.curlSpeed }, uSizeMin: { value: CONFIG.sizeMin }, uSizeMax: { value: CONFIG.sizeMax },
  uSizeBias: { value: CONFIG.sizeBias }, uDepthFade: { value: CONFIG.depthFade }, uDepthDarken: { value: CONFIG.depthDarken },
  uWrap: { value: CONFIG.wrap }, uFill: { value: CONFIG.fill }, uSpecular: { value: CONFIG.specular },
  uShininess: { value: CONFIG.shininess }, uRim: { value: CONFIG.rim }, uCoreAlpha: { value: CONFIG.coreAlpha },
  uLift: { value: CONFIG.lift }, uLife: { value: CONFIG.life }, uGrainSize: { value: CONFIG.grainSize },
  uMStreak: { value: CONFIG.motionStreak }, uGrainShadow: { value: CONFIG.grainShadow },
  uShadowDist: { value: CONFIG.shadowDistance },
  uRipple: { value: CONFIG.ripple }, uRippleLen: { value: CONFIG.rippleLength }, uRippleFreq: { value: CONFIG.rippleFreq },
  uEdgeShadow: { value: CONFIG.edgeShadow },
};
const COMMON = /* glsl */`
  uniform sampler2D tImg1, tImg2, tCell;
  uniform vec2 uScreen, uWind;
  uniform float uDpr, uCell, uP, uD, uU0, uU1, uF0, uF1, uBand, uStreak, uDune, uGapLead, uHandover, uSoftness;
  vec2 coverUv(vec2 uv, float ia) {
    float sa = uScreen.x / uScreen.y;
    vec2 s = sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0);
    return (uv - 0.5) * s + 0.5;
  }
  vec2 windPerp() { return vec2(-uWind.y, uWind.x); }
  // a css-px point in wind space: u along the wind, v across, both in screen heights
  vec2 windSpace(vec2 px) { vec2 X = px / uScreen.y; return vec2(dot(X, uWind), dot(X, windPerp())); }
`;

// ------------------------------------------------------------- the CELL pass ----
// One texel per grain: when it lets go (progress), two randoms, and its threshold.
// Its release: the front f(p) = f0 + (f1 - f0) p reaches it when f - s + dune = threshold,
// where s is how far along the wind it sits (0 at the upwind edge, 1 at the downwind one).
let GW = 1, GH = 1;
let cellRT = null;
const cellScene = new THREE.Scene();
const cellMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${COMMON}
    ${NOISE}
    in vec2 vUv;
    out vec4 outColor;
    void main() {
      vec2 cell = floor(gl_FragCoord.xy);
      vec2 cpx = (cell + 0.5) * uCell;
      vec2 X = cpx / uScreen.y;
      vec2 corner = vec2(uScreen.x / uScreen.y, 1.0);
      vec2 rel = X - corner;
      // out of the top-right corner: s is the distance from it, 0..1 over the screen
      float s = length(rel) / length(corner);
      // a lobed front - broad bulges round the corner and a finer ruffle
      float ang = atan(rel.y, rel.x);
      float dune = uDune * (0.6 * snoise(vec2(ang * 2.2, 1.7)) + 0.4 * fbm(X * 2.0));
      // it breaks in CLUMPS, not lines
      float streak = 0.5 + 0.5 * (0.8 * fbm(X * 3.5) + 0.2 * snoise(X * 11.0));
      float grain = hash12(cell);
      float thr = uBand * (0.5 + uStreak * (streak - 0.5) + 0.25 * (grain - 0.5));
      float pr = (thr + s - dune - uF0) / (uF1 - uF0);
      outColor = vec4(pr, hash12(cell + 5.1), hash12(cell + 9.7), thr);
    }`,
});
cellScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cellMat));

function windSetup() {
  const a = THREE.MathUtils.degToRad(CONFIG.windAngle);
  const W = new THREE.Vector2(Math.cos(a), Math.sin(a));
  U.uWind.value.copy(W);
  // u over the screen's corners, in screen heights
  const asp = innerWidth / innerHeight;
  const us = [[0, 0], [asp, 0], [0, 1], [asp, 1]].map(([x, y]) => x * W.x + y * W.y);
  U.uU0.value = Math.min(...us); U.uU1.value = Math.max(...us);
  // the front starts just short of the first grain, and is timed so the LAST grain lets go
  // early enough to finish its flight by the end
  const thrMax = CONFIG.band * (0.5 + 0.5 * CONFIG.streak + 0.125);
  const f0 = -CONFIG.dune - 0.02;
  const lastShare = Math.max(0.2, 1 - CONFIG.life / CONFIG.duration);   // the last motes live out their life by the end
  U.uF0.value = f0;
  U.uF1.value = f0 + (thrMax + 1 + CONFIG.dune - f0) / lastShare;
}
function buildCells() {
  GW = Math.ceil(innerWidth / CONFIG.cell);
  GH = Math.ceil(innerHeight / CONFIG.cell);
  if (cellRT) cellRT.dispose();
  cellRT = new THREE.WebGLRenderTarget(GW, GH, {
    type: renderer.extensions.get('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType,
    format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  U.tCell.value = cellRT.texture;
  computeCells();
  buildGrainGeometry();
}
function computeCells() {
  windSetup();
  U.uBand.value = CONFIG.band; U.uStreak.value = CONFIG.streak; U.uDune.value = CONFIG.dune;
  U.uCell.value = CONFIG.cell;
  renderer.setRenderTarget(cellRT);
  renderer.render(cellScene, camera);
  renderer.setRenderTarget(null);
}

// ------------------------------------------------------------------ the page ----
const pageMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${COMMON}
    ${NOISE}
    uniform float uRipple, uRippleLen, uRippleFreq, uEdgeShadow;
    in vec2 vUv;
    out vec4 outColor;
    ivec2 cellAt(vec2 px) { return ivec2(clamp(floor(px / uCell), vec2(0.0), vec2(textureSize(tCell, 0) - 1))); }
    // how much of this pixel's grain is still on the picture: a round grain inside its cell, the
    // corners between grains going a moment earlier, the round edge antialiased
    float onPicture(vec2 px) {
      vec4 cd = texelFetch(tCell, cellAt(px), 0);
      vec2 local = fract(px / uCell) - 0.5;
      float d = length(local);
      float aa = 0.7 / (uCell * uDpr);
      float inGrain = 1.0 - smoothstep(0.5 - aa, 0.5 + aa, d);
      // rev 2: a piece fades out over the hand-over window, as its particle fades in
      float on = 1.0 - smoothstep(cd.r - uHandover, cd.r, uP);
      float onGap = 1.0 - smoothstep(cd.r - uGapLead - uHandover, cd.r - uGapLead, uP);
      return inGrain * on + (1.0 - inGrain) * onGap;
    }
    void main() {
      vec2 px = gl_FragCoord.xy / uDpr;
      float k = onPicture(px);
      vec3 c1 = texture(tImg1, coverUv(vUv, ${IMG1_ASPECT.toFixed(6)})).rgb;
      vec3 c2 = texture(tImg2, coverUv(vUv, ${IMG2_ASPECT.toFixed(6)})).rgb;

      // image 2 under the settling sand: fine ripples across the wind just behind the front,
      // fading as it moves on
      vec4 cd = texelFetch(tCell, cellAt(px), 0);
      float since = uP - cd.r;

      // the eroding edge's contact shadow, thrown downwind and down
      vec2 off = vec2(3.0, -4.0);
      c2 *= 1.0 - uEdgeShadow * onPicture(px - off) * (1.0 - k);

      outColor = vec4(mix(c2, c1, k), 1.0);
    }`,
});
const pageMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pageMat);
pageMesh.frustumCulled = false;
scene.add(pageMesh);

// ---------------------------------------------------------------- the grains ----
// Each grain: blown off at the moment its cell lets go, carried downwind (its own speed, the wind
// keeps pushing), wandering a little, lifting off the picture; streaked along its motion and
// gone after CONFIG.life. Its shadow is drawn first, under it, further off the higher it is.
const grainVert = (shadow) => /* glsl */`
  precision highp float;
  ${COMMON}
  ${NOISE}
  uniform float uKick, uFloat, uCurlAmp, uCurlFreq, uCurlSpeed, uLife, uGrainSize;
  uniform float uSizeMin, uSizeMax, uSizeBias, uDepthFade, uDepthDarken;
  in vec2 aCell;
  out vec3 vCol; out float vAlpha; out float vPx;
  void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
  // the swirl: the curl of a slowly changing noise potential - divergence-free, so the motes
  // curl and braid rather than spread or bunch
  vec2 curl(vec2 p, float t) {
    float e = 0.01;
    vec2 q = p * uCurlFreq + vec2(0.0, t * uCurlSpeed);
    float n1 = snoise(q + vec2(0.0, e)), n2 = snoise(q - vec2(0.0, e));
    float n3 = snoise(q + vec2(e, 0.0)), n4 = snoise(q - vec2(e, 0.0));
    return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
  }
  void main() {
    vec4 cd = texelFetch(tCell, ivec2(aCell), 0);
    float tau = (uP - (cd.r - uHandover)) * uD;       // seconds since its piece began to go
    if (tau <= 0.0 || tau >= uLife) { hide(); return; }
    float r1 = cd.g, r2 = cd.b;
    float r3 = fract(r1 * 37.7 + r2 * 11.3);          // its depth in the cloud, 0 front .. 1 back
    vec2 cpx = (aCell + 0.5) * uCell;
    vec2 X = cpx / uScreen.y;
    vec2 corner = vec2(uScreen.x / uScreen.y, 1.0);
    vec2 outward = normalize(X - corner + vec2(1e-4));
    // out of the corner, up, and swirled
    vec2 d = outward * uKick * tau + vec2(0.1, 1.0) * uFloat * tau
           + curl(X, tau + r2 * 3.0) * uCurlAmp * tau / uCurlFreq;
    vec2 pos = cpx + d * uScreen.y;
    // PTSVer4's sizes: a steep spread, mostly tiny, a few large bubbles; nearer is larger
    float size = mix(uSizeMin, uSizeMax, pow(fract(r2 * 7.3 + r1), uSizeBias)) * uGrainSize
               * (1.15 - 0.3 * r3);
    // fade in briefly, live, fade out; and fainter and darker toward the back
    float a = smoothstep(0.0, uHandover * uD, tau) * (1.0 - smoothstep(uLife * 0.3, uLife, tau));
    a *= 1.0 - uDepthFade * r3;
    vAlpha = a;
    vCol = texture(tImg1, coverUv(cpx / uScreen, ${IMG1_ASPECT.toFixed(6)})).rgb * (1.0 - uDepthDarken * r3);
    vPx = size * uDpr;
    gl_Position = vec4(pos / uScreen * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = max(vPx, 1.0);
  }`;
const grainFrag = (shadow) => /* glsl */`
  precision highp float;
  uniform float uSoftness;
  in vec3 vCol; in float vAlpha; in float vPx;
  out vec4 outColor;
  void main() {
    // a particle: a flat dot of its piece's colour with a soft edge - no sphere shading
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r = length(d);
    if (r > 1.0) discard;
    float a = vAlpha * (1.0 - smoothstep(1.0 - max(uSoftness, 0.05), 1.0, r));
    outColor = vec4(vCol * a, a);
  }`;
const grainMat = (shadow) => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  vertexShader: grainVert(shadow), fragmentShader: grainFrag(shadow),
});
const grainPoints = new THREE.Points(new THREE.BufferGeometry(), grainMat(false));
grainPoints.frustumCulled = false; grainPoints.renderOrder = 2; scene.add(grainPoints);
function buildGrainGeometry() {
  const n = GW * GH;
  const cells = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { cells[i * 2] = i % GW; cells[i * 2 + 1] = Math.floor(i / GW); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aCell', new THREE.BufferAttribute(cells, 2));
  grainPoints.geometry.dispose(); grainPoints.geometry = g;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  U.uScreen.value.set(innerWidth, innerHeight);
  U.uDpr.value = renderer.getPixelRatio();
  buildCells();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the timeline ----
// Scroll down plays it, up plays it back. It has INERTIA: it speeds up over CONFIG.accel, and
// eases off over the last stretch, instead of starting and stopping dead.
let p = 0, vel = 0, dir = 0;
const hint = document.getElementById('hint');
const forward = () => { dir = 1; if (hint) hint.classList.add('off'); };
const backward = () => { if (p > 0) dir = -1; };
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
window.transitionControl = { forward, backward, get progress() { return p; } };

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // speed toward the target, eased in; slowing over the last 20% of the way it is going
  const left = dir > 0 ? 1 - p : p;
  const k = Math.min(1, left / 0.2);
  const target = dir === 0 ? 0 : dir / CONFIG.duration * (0.3 + 0.7 * k * k * (3 - 2 * k));
  vel += (target - vel) * (1 - Math.exp(-dt / Math.max(0.02, CONFIG.accel / 3)));
  p += vel * dt;
  if (p >= 1) { p = 1; vel = 0; dir = 0; }
  if (p <= 0) { p = 0; vel = 0; if (dir < 0) { dir = 0; if (hint) hint.classList.remove('off'); } }
  U.uP.value = p;
  U.uD.value = CONFIG.duration;
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- the panel ----
// ?ui=0 removes it. Bars marked * re-work when each grain lets go (instant).
const uiEl = document.getElementById('pui');
if (uiEl && PARAMS.get('ui') === '0') uiEl.remove();
else if (uiEl) {
  const live = (k, uni) => (v) => { CONFIG[k] = v; U[uni].value = v; };
  const recompute = (k) => (v) => { CONFIG[k] = v; computeCells(); };
  const ROWS = [
    ['the reveal'],
    ['duration', 'duration (s)', 0.8, 8, 0.1, (v) => { CONFIG.duration = v; computeCells(); }],
    ['accel', 'inertia (s)', 0, 1.5, 0.05, (v) => { CONFIG.accel = v; }],
    ['band', 'breaking band *', 0.02, 0.8, 0.01, recompute('band')],
    ['streak', 'clumps *', 0, 1.5, 0.01, recompute('streak')],
    ['dune', 'lobed front *', 0, 0.4, 0.005, recompute('dune')],
    ['the motes (PTSVer4)'],
    ['sizeMin', 'smallest (px)', 0.5, 6, 0.1, live('sizeMin', 'uSizeMin')],
    ['sizeMax', 'largest (px)', 2, 40, 0.5, live('sizeMax', 'uSizeMax')],
    ['sizeBias', 'mostly small', 1, 8, 0.1, live('sizeBias', 'uSizeBias')],
    ['kick', 'drift out', 0, 0.6, 0.005, live('kick', 'uKick')],
    ['float', 'float up', 0, 0.6, 0.005, live('float', 'uFloat')],
    ['curlAmp', 'swirl', 0, 0.5, 0.005, live('curlAmp', 'uCurlAmp')],
    ['curlFreq', 'swirl size (fine)', 0.5, 10, 0.1, live('curlFreq', 'uCurlFreq')],
    ['life', 'life (s) *', 0.2, 3, 0.05, (v) => { CONFIG.life = v; U.uLife.value = v; computeCells(); }],
    ['look'],
    ['softness', 'particle softness', 0, 1, 0.01, live('softness', 'uSoftness')],
    ['handover', 'hand-over (smooth)', 0.005, 0.15, 0.005, live('handover', 'uHandover')],
    ['depthFade', 'depth fade', 0, 1, 0.01, live('depthFade', 'uDepthFade')],
    ['edgeShadow', 'edge shadow', 0, 0.8, 0.01, live('edgeShadow', 'uEdgeShadow')],
  ];
  uiEl.innerHTML = '<div class="btns"><button type="button" id="pPlay">play ▶</button>'
    + '<button type="button" id="pBack">◀ back</button></div>'
    + ROWS.map((r, i) => r.length === 1 ? '<h2>' + r[0] + '</h2>'
      : '<div class="row"><div class="lbl"><span class="name">' + r[1] + '</span><span class="val" id="pv' + i + '">'
        + CONFIG[r[0]] + '</span></div><input type="range" id="pr' + i + '" min="' + r[2] + '" max="' + r[3]
        + '" step="' + r[4] + '" value="' + CONFIG[r[0]] + '"></div>').join('')
    + '<div class="foot">* re-times the grains (instant) &middot; ?ui=0 removes this panel</div>';
  ROWS.forEach((r, i) => {
    if (r.length === 1) return;
    const el = document.getElementById('pr' + i);
    el.addEventListener('input', () => { r[5](parseFloat(el.value)); document.getElementById('pv' + i).textContent = el.value; });
  });
  document.getElementById('pPlay').addEventListener('click', () => { p = 0; vel = 0; forward(); });
  document.getElementById('pBack').addEventListener('click', backward);
}
if (PARAMS.get('debug') === '1') window.__t15 = { renderer, U, CONFIG, get p() { return p; } };
