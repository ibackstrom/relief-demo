// TRANSITION — image 1 crumbles into image 2 like sand.
//
// Scroll down: the ver20 mask (immersiveg/Ver20Final, assets/mask-noise.webp, the same two
// scales and the same smoothstep(0.4, 1.0, g) as its flowmap stamp) opens at several points at
// once and every opening grows until they meet. Along each border image 1 breaks into grains
// and the grains fall, gather in a heap along the bottom, and the heap drains away.
// Scroll up: the openings close again (no sand on the way back).
//
// Both the page's dissolve and the grains read ONE field, F(x, e):
//   F = max over seeds ( e * a_i - b - |x - s_i| ) + N(x)
// where N is the ver20 mask noise and e is the eased progress. A pixel of image 1 goes when F
// passes its own grain threshold h * band; a grain is released at exactly that moment, so the
// hole in image 1 and the grain leaving it are the same event. F is linear in e for each seed,
// so a grain's release time is solved in closed form in the vertex shader - no simulation, no
// state, and it plays back identically every frame.
//
// v2 - what makes it read as SAND rather than dots:
//  - the fall has air drag: each grain accelerates to its own terminal speed (bigger = faster),
//    so a stream stretches out and separates instead of dropping as one sheet
//  - grains come off in CLUMPS that share a push and then break apart as they fall
//  - every grain is a tiny lit sphere, stretched along its fall by motion blur; a few glint
//  - image 1 is a layer ON TOP of image 2: it casts a soft shadow into the openings, and its
//    broken edge is speckled and lit
//  - the sand lands in a heap along the bottom edge, which grows while it rains and then
//    drains away through the floor, leaving image 2 clean

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);
// a page can preset values before loading this module (the preview does: the slow template)
const PRESET = window.TRANSITION_CONFIG || {};
const pre = (k, d) => (k in PRESET ? PRESET[k] : d);

const CONFIG = {
  duration: num('dur', pre('duration', 3.4)),   // s, first opening to fully image 2
  reverseDuration: 2.0,          // s, back again on scroll up
  seeds: num('seeds', pre('seeds', 7)),         // openings, all starting together (max 12)
  seedMinDist: 0.28,             // how far apart the openings start (screen heights)
  seedSizeVar: 0.35,             // +- share by which one opening grows faster than another
  maskAmount: 0.13,              // how ragged the ver20 mask makes the border (screen heights)
  band: 0.035,                   // width of the crumbling border (screen heights)
  grainPx: 1.5,                  // css px per dissolve cell on the page

  // the layer: image 1 lying on top of image 2
  shadow: 0.45,                  // darkness of the shadow image 1 casts into the openings
  shadowOffset: [-0.004, 0.011], // light from above-left (screen heights)
  shadowSoft: 1.6,               // shadow softness, in border widths
  edgeSpeckle: 0.22,             // image 1 breaks up into grain texture just before it goes
  edgeLight: 0.10,               // its broken edge lit from above

  // the grains
  grains: num('grains', pre('grains', 300000)),
  grainSize: [0.7, 3.0],         // css px; most are small, a few coarse
  gravity: 2.6,                  // screen heights / s^2
  terminal: 1.05,                // terminal fall speed (screen heights / s), +-25% by size
  clump: 0.011,                  // size of the clumps that come off together (screen heights)
  spread: 0.10,                  // sideways push off the edge (screen heights / s)
  scatter: 0.012,                // how far a clump breaks apart in its first second
  blur: 1.0,                     // motion streak length, 1 = one frame's travel
  shade: [0.80, 1.08],           // brightness range of grains vs image 1
  darkSpecks: 0.07,              // share of dark grains
  glints: 0.18,                  // share of grains that catch the light as they tumble
  maxLife: 7.0,                  // s, safety cap

  // the heap
  pileHeight: num('pile', pre('pileHeight', 0.055)),   // screen heights at its fullest; 0 = none
  pileDrain: 1.8,                // s it takes to drain after the last grains land
};

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const loader = new THREE.TextureLoader();
const asset = (f) => new URL('./assets/' + f, import.meta.url).href;
function tex(file, repeat) {
  const t = loader.load(asset(file));
  t.colorSpace = THREE.NoColorSpace;   // raw pass-through: the shaders output what they read
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
const tImg1 = tex('img1.jpg');
const tImg2 = tex('img2.jpg');
const tNoise = tex('mask-noise.webp', true);
const IMG1_ASPECT = 1512 / 900;
const IMG2_ASPECT = 2560 / 1663;

// ------------------------------------------------------------- shared GLSL ----
const MAX_SEEDS = 12;
const FIELD_GLSL = /* glsl */`
uniform sampler2D tNoise;
uniform sampler2D tImg1;
uniform float uAspect;
uniform vec3  uSeeds[${MAX_SEEDS}];   // xy: centre (aspect space), z: growth a_i
uniform int   uSeedCount;
uniform float uB;
uniform float uA;
uniform vec2  uNoiseOff;
uniform float uBand;
uniform float uPile;                  // the heap's height right now (screen heights)

// the ver20 mask: the same texture, channel, scales and curve as its flowmap stamp
float maskNoise(vec2 uv) {
  vec2 q = uv * vec2(uAspect, 1.0);
  float n1 = 0.00 + 1.00 * smoothstep(0.4, 1.0, texture2D(tNoise, q * 0.35 + uNoiseOff).g);
  float n2 = 0.15 + 0.85 * smoothstep(0.4, 1.0, texture2D(tNoise, q * 0.8 + uNoiseOff * 1.7).g);
  return uA * (0.65 * n1 + 0.35 * n2 - 0.5);
}

// the field without the noise, at progress e
float seedField(vec2 q, float e) {
  float F = -1e3;
  for (int i = 0; i < ${MAX_SEEDS}; i++) {
    if (i >= uSeedCount) break;
    F = max(F, e * uSeeds[i].z - uB - length(q - uSeeds[i].xy));
  }
  return F;
}

vec2 cover(vec2 uv, float imgAspect) {
  vec2 s = uAspect > imgAspect ? vec2(1.0, imgAspect / uAspect) : vec2(uAspect / imgAspect, 1.0);
  return (uv - 0.5) * s + 0.5;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// the heap's surface at x: gentle dunes from the same mask texture, at a very low frequency
float pileSurface(float x) {
  float xa = x * uAspect;
  float d = 0.55 * texture2D(tNoise, vec2(xa * 0.11, 0.31) + uNoiseOff).g
          + 0.45 * texture2D(tNoise, vec2(xa * 0.27, 0.73) + uNoiseOff * 0.5).g;
  return uPile * (0.55 + 0.6 * d);
}

// what the sand in the heap under x is made of: image 1's column above it, averaged
vec3 columnColour(float x) {
  return (texture2D(tImg1, cover(vec2(x, 0.2), ${IMG1_ASPECT.toFixed(6)})).rgb
        + texture2D(tImg1, cover(vec2(x, 0.5), ${IMG1_ASPECT.toFixed(6)})).rgb
        + texture2D(tImg1, cover(vec2(x, 0.8), ${IMG1_ASPECT.toFixed(6)})).rgb) / 3.0;
}
`;

// ------------------------------------------------------------------ the page ----
const pageMat = new THREE.ShaderMaterial({
  depthTest: false, depthWrite: false,
  uniforms: {
    tNoise: { value: tNoise }, tImg1: { value: tImg1 }, tImg2: { value: tImg2 },
    uAspect: { value: 1 }, uSeeds: { value: Array.from({ length: MAX_SEEDS }, () => new THREE.Vector3()) },
    uSeedCount: { value: 0 }, uB: { value: 0 }, uA: { value: CONFIG.maskAmount },
    uNoiseOff: { value: new THREE.Vector2() }, uBand: { value: CONFIG.band }, uPile: { value: 0 },
    uE: { value: 0 }, uFill: { value: 0 }, uCell: { value: 1.5 },
    uShadow: { value: CONFIG.shadow }, uShadowOff: { value: new THREE.Vector2(...CONFIG.shadowOffset) },
    uShadowSoft: { value: CONFIG.shadowSoft }, uSpeckle: { value: CONFIG.edgeSpeckle },
    uEdgeLight: { value: CONFIG.edgeLight },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    ${FIELD_GLSL}
    uniform sampler2D tImg2;
    uniform float uE, uFill, uCell, uShadow, uShadowSoft, uSpeckle, uEdgeLight;
    uniform vec2 uShadowOff;
    varying vec2 vUv;
    void main() {
      vec2 q = vUv * vec2(uAspect, 1.0);
      float F = seedField(q, uE) + maskNoise(vUv);
      float t = F / uBand;                               // 0..1 across the crumbling border
      vec2 cell = floor(gl_FragCoord.xy / uCell);
      float h = hash12(cell);                            // this cell's grain threshold
      float m = max(t > h ? 1.0 : 0.0, uFill);

      vec3 c1 = texture2D(tImg1, cover(vUv, ${IMG1_ASPECT.toFixed(6)})).rgb;
      vec3 c2 = texture2D(tImg2, cover(vUv, ${IMG2_ASPECT.toFixed(6)})).rgb;

      // image 1 about to go: its surface loosens into grain, and the broken edge catches the
      // light where it faces up
      float zone = smoothstep(-2.5, 0.0, t) * step(t, 0.0);
      float g2 = hash12(cell + 71.3);
      c1 *= 1.0 - zone * uSpeckle * (g2 - 0.35);
      vec2 grad = vec2(dFdx(F), dFdy(F));
      vec2 n = grad / max(length(grad), 1e-6);          // points into the opening
      float rim = smoothstep(-1.2, 0.0, t) * step(t, 0.0);
      c1 *= 1.0 + uEdgeLight * rim * (-n.y);

      // image 1 lies ON image 2: the light comes from above-left, so the layer's shadow falls
      // into each opening just below and right of its upper edges
      vec2 so = vUv + uShadowOff * vec2(1.0 / uAspect, 1.0);
      float Fs = seedField(so * vec2(uAspect, 1.0), uE) + maskNoise(so);
      float sh = uShadow * (1.0 - smoothstep(-uShadowSoft * uBand * 0.5, uShadowSoft * uBand, Fs));
      c2 *= 1.0 - sh * (1.0 - uFill);

      vec3 col = mix(c1, c2, m);

      // the heap along the bottom
      float ph = pileSurface(vUv.x);
      float grainEdge = (hash12(cell + 13.1) - 0.5) * 0.004;
      if (uPile > 0.0005 && vUv.y + grainEdge < ph) {
        float depth = clamp((ph - vUv.y) / max(ph, 1e-4), 0.0, 1.0);
        vec3 sand = columnColour(vUv.x) * (0.80 + 0.32 * hash12(cell + 5.7));
        sand *= mix(1.08, 0.72, sqrt(depth));            // lit on top, darker inside
        float slope = (pileSurface(vUv.x + 0.004) - pileSurface(vUv.x - 0.004)) / 0.008;
        sand *= 1.0 + 0.8 * slope * (1.0 - depth);        // slopes facing the light (left) lit
        col = sand;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
});
pageMat.extensions = { derivatives: true };
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pageMat));

// ---------------------------------------------------------------- the grains ----
function buildGrains(n) {
  const pos = new Float32Array(n * 3);
  const rnd = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = Math.random();
    pos[i * 3 + 1] = Math.random();
    pos[i * 3 + 2] = Math.random();          // its threshold h, same law as the page's cells
    for (let k = 0; k < 4; k++) rnd[i * 4 + k] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
  return g;
}

const grainMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false,
  uniforms: {
    ...pageMat.uniforms,
    uS: { value: 0 }, uDur: { value: CONFIG.duration }, uVis: { value: 0 }, uPx: { value: 1 },
    uHpx: { value: 900 }, uG: { value: CONFIG.gravity }, uVt: { value: CONFIG.terminal },
    uSize: { value: new THREE.Vector2(...CONFIG.grainSize) }, uClump: { value: CONFIG.clump },
    uSpread: { value: CONFIG.spread }, uScatter: { value: CONFIG.scatter }, uBlur: { value: CONFIG.blur },
    uShade: { value: new THREE.Vector2(...CONFIG.shade) }, uDark: { value: CONFIG.darkSpecks },
    uGlints: { value: CONFIG.glints }, uMaxLife: { value: CONFIG.maxLife },
    uPileOn: { value: CONFIG.pileHeight > 0 ? 1 : 0 }, uPileK: { value: 0 },
  },
  vertexShader: /* glsl */`
    precision highp float;
    ${FIELD_GLSL}
    uniform float uS, uDur, uVis, uPx, uHpx, uG, uVt, uClump, uSpread, uScatter, uBlur;
    uniform float uDark, uGlints, uMaxLife, uPileOn, uPileK;
    uniform vec2 uSize, uShade;
    attribute vec4 aRand;
    varying vec3 vCol;
    varying float vAlpha;
    varying float vStretch;
    varying float vGlint;
    void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
    void main() {
      vec2 home = position.xy;
      vec2 q = home * vec2(uAspect, 1.0);
      // when does F reach this grain's threshold? each seed's term is linear in e, so the
      // earliest e over the seeds is the answer - exact, no search
      float target = position.z * uBand - maskNoise(home) + uB;
      float eRel = 1e9;
      for (int i = 0; i < ${MAX_SEEDS}; i++) {
        if (i >= uSeedCount) break;
        eRel = min(eRel, (target + length(q - uSeeds[i].xy)) / uSeeds[i].z);
      }
      if (eRel > 1.0 || uVis <= 0.0) { hide(); return; }
      eRel = max(eRel, 0.0);
      float pRel = acos(1.0 - 2.0 * eRel) / 3.14159265;   // undo the sine ease
      float tau = (uS - pRel) * uDur;                       // seconds since it came loose
      if (tau < 0.0 || tau > uMaxLife) { hide(); return; }

      // its clump: neighbours that came off together share their push
      vec2 cq = floor(q / uClump);
      float c1 = hash12(cq), c2 = hash12(cq + 17.31), c3 = hash12(cq + 41.7);
      float size = mix(uSize.x, uSize.y, pow(aRand.w, 2.2));
      float sizeK = (size - uSize.x) / max(uSize.y - uSize.x, 1e-3);

      // the fall, with air drag: speed approaches this grain's terminal speed
      float vt = uVt * mix(0.75, 1.25, 0.5 * sizeK + 0.5 * mix(c1, aRand.y, 0.5));
      float kk = vt / uG;                                   // time constant of the drag
      float ex = exp(-tau / kk);
      float v0 = mix(-0.05, 0.03, mix(c2, aRand.y, 0.35)); // negative: a small hop up first
      float dist = vt * (tau - kk * (1.0 - ex)) + v0 * kk * (1.0 - ex);
      float vel = vt * (1.0 - ex) + v0 * ex;
      // sideways: the clump's push, damped by the air, plus the clump coming apart
      float vx = ((c3 - 0.5) * 0.7 + (aRand.z - 0.5) * 0.3) * uSpread;
      float xOff = vx * kk * (1.0 - ex) + (aRand.z - 0.5) * uScatter * min(tau, 1.0);
      vec2 p = home + vec2(xOff / uAspect, -dist);

      // the heap: a grain that reaches the surface rests in it, somewhere below the top
      bool landed = false;
      float alpha = uVis;
      if (uPileOn > 0.5) {
        float ys = pileSurface(p.x) * mix(0.2, 1.0, sqrt(aRand.x));
        if (p.y <= ys) { p.y = ys; landed = true; vel = 0.0; alpha *= smoothstep(0.0, 0.35, uPileK); }
      }
      if (p.y < -0.01 || alpha <= 0.0) { hide(); return; }

      float px = size * uPx;
      // motion blur: stretched along the fall by one frame's travel
      float streak = vel * uHpx / 60.0 * uBlur;
      vStretch = 1.0 + min(streak / px, 5.0);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = px * vStretch;

      vec3 col = texture2D(tImg1, cover(home, ${IMG1_ASPECT.toFixed(6)})).rgb;
      col *= mix(uShade.x, uShade.y, aRand.y);
      if (fract(aRand.x * 7.13) < uDark) col *= 0.55;       // the odd dark grain
      vCol = col;
      // tumbling: a glinting grain flashes as a facet turns to the light
      float tumble = pow(max(sin(tau * (14.0 + 10.0 * aRand.z) + aRand.w * 40.0), 0.0), 24.0);
      vGlint = landed ? 0.0 : tumble * step(1.0 - uGlints, fract(aRand.y * 13.7)) * 0.6;
      vAlpha = alpha;
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec3 vCol;
    varying float vAlpha;
    varying float vStretch;
    varying float vGlint;
    void main() {
      vec2 d = gl_PointCoord * 2.0 - 1.0;
      d.x *= vStretch;                          // the grain is 1/stretch as wide as it is long
      float r = length(d);
      if (r > 1.0) discard;
      // a tiny sphere, lit from above-left
      vec3 n = vec3(d.x, -d.y / vStretch, sqrt(max(1.0 - r * r, 0.0)));
      float diff = 0.45 + 0.75 * max(dot(normalize(n), normalize(vec3(-0.45, 0.7, 0.6))), 0.0);
      vec3 col = vCol * diff + vGlint;
      float a = vAlpha * smoothstep(1.0, 0.65, r) * mix(1.0, 0.55, (vStretch - 1.0) / 5.0);
      gl_FragColor = vec4(col, a);
    }`,
});
const grains = new THREE.Points(buildGrains(CONFIG.grains), grainMat);
grains.frustumCulled = false;
grains.visible = false;
scene.add(grains);

// ---------------------------------------------------------------- the seeds ----
// Openings in screen space (0..1), kept apart so they start at different places. Each gets
// its own growth rate, then all rates are scaled together so that at the end the openings
// have just covered the whole screen, ragged border included.
let seedUv = [];
function placeSeeds() {
  seedUv = [];
  const n = Math.min(MAX_SEEDS, Math.max(1, Math.round(CONFIG.seeds)));
  const aspect = innerWidth / innerHeight;
  for (let tries = 0; seedUv.length < n && tries < 4000; tries++) {
    const s = { x: 0.06 + Math.random() * 0.88, y: 0.08 + Math.random() * 0.84,
                r: 1 + (Math.random() * 2 - 1) * CONFIG.seedSizeVar };
    const ok = seedUv.every(o => Math.hypot((o.x - s.x) * aspect, o.y - s.y) >
                                 CONFIG.seedMinDist * (tries < 3000 ? 1 : 0.5));
    if (ok) seedUv.push(s);
  }
  uploadSeeds();
  pageMat.uniforms.uNoiseOff.value.set(Math.random(), Math.random());
}
function uploadSeeds() {
  const aspect = innerWidth / innerHeight;
  // how far the openings must reach: the farthest point from them, weighted by their rates
  let need = 0;
  for (let gy = 0; gy <= 40; gy++) for (let gx = 0; gx <= 40; gx++) {
    const x = gx / 40 * aspect, y = gy / 40;
    let best = 1e9;
    for (const s of seedUv) best = Math.min(best, Math.hypot(x - s.x * aspect, y - s.y) / s.r);
    need = Math.max(need, best);
  }
  const A = CONFIG.maskAmount;
  const u = pageMat.uniforms;
  u.uB.value = 0.6 * A;              // below zero at e = 0 however the noise falls
  seedUv.forEach((s, i) => u.uSeeds.value[i].set(s.x * aspect, s.y, s.r * need * 1.04 + 1.2 * A + CONFIG.band));
  u.uSeedCount.value = seedUv.length;
  u.uAspect.value = aspect;
}

// ---------------------------------------------------------------- the clock ----
// s runs 0 -> 1 over the duration and on past 1 while the last grains land and the heap
// drains; p = min(s, 1)
let s = 0;
let dir = 0;                 // +1 opening, -1 closing, 0 still
const hint = document.getElementById('hint');
function forward() {
  if (dir === 1) return;
  if (s <= 0) placeSeeds();  // a fresh set of openings each time it starts from image 1
  s = Math.min(s, 1);
  dir = 1;
  if (hint) hint.classList.add('off');
}
function backward() {
  if (dir === -1 || s <= 0) return;
  s = Math.min(s, 1);
  dir = -1;
}

addEventListener('wheel', e => { if (e.deltaY > 2) forward(); else if (e.deltaY < -2) backward(); }, { passive: true });
let touchY = null;
addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
addEventListener('touchmove', e => {
  if (touchY === null) return;
  const dy = touchY - e.touches[0].clientY;
  if (dy > 20) { forward(); touchY = null; } else if (dy < -20) { backward(); touchY = null; }
}, { passive: true });
addEventListener('keydown', e => {
  if (['ArrowDown', 'PageDown', ' ', 'End'].includes(e.key)) forward();
  if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) backward();
});

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  const dpr = renderer.getPixelRatio();
  pageMat.uniforms.uCell.value = CONFIG.grainPx * dpr;
  grainMat.uniforms.uPx.value = dpr;
  grainMat.uniforms.uHpx.value = innerHeight * dpr;
  if (seedUv.length) uploadSeeds(); else pageMat.uniforms.uAspect.value = innerWidth / innerHeight;
}
addEventListener('resize', resize);
resize();

window.transitionControl = { forward, backward, get progress() { return Math.min(s, 1); } };

// the heap's timeline, in seconds from the start: it fills while the sand rains down, and
// drains once the last grains (released at the end of the opening) have had time to land
const D = CONFIG.duration;
const fallTime = 1.0 / CONFIG.terminal + 0.4;          // top of the screen to the floor, roughly
const drainStart = D + fallTime;
const drainEnd = drainStart + CONFIG.pileDrain;
const tailEnd = CONFIG.pileHeight > 0 ? drainEnd / D + 0.05 : 1 + (fallTime + 0.5) / D;

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dir === 1) {
    s = Math.min(s + dt / D, tailEnd);
  } else if (dir === -1) {
    s -= dt / CONFIG.reverseDuration;
    if (s <= 0) { s = 0; dir = 0; if (hint) hint.classList.remove('off'); }
  }
  const p = Math.min(s, 1);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * p);
  const u = pageMat.uniforms;
  u.uE.value = e;
  u.uFill.value = THREE.MathUtils.smoothstep(p, 0.985, 1.0);
  const gu = grainMat.uniforms;
  gu.uS.value = s;
  gu.uVis.value = THREE.MathUtils.clamp(gu.uVis.value + (dir === 1 ? dt / 0.25 : -dt / 0.2), 0, 1);

  const T = s * D;
  const fill = THREE.MathUtils.smoothstep(T, 0.4, D + 0.6 * fallTime);
  const drain = 1 - THREE.MathUtils.smoothstep(T, drainStart, drainEnd);
  const k = fill * drain * gu.uVis.value;
  u.uPile.value = CONFIG.pileHeight * k;
  gu.uPileK.value = k;

  grains.visible = gu.uVis.value > 0 && s > 0 && s < tailEnd;
  renderer.render(scene, camera);
});
