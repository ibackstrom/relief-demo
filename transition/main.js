// TRANSITION — image 1 crumbles into image 2 like sand.
//
// Scroll down: the ver20 mask (immersiveg/Ver20Final, assets/mask-noise.webp, the same two
// scales and the same smoothstep(0.4, 1.0, g) as its flowmap stamp) opens at several points at
// once and every opening grows until they meet. Along each border image 1 breaks into grains
// and the grains fall. Scroll up: the openings close again (no sand on the way back).
//
// Both the page's dissolve and the grains read ONE field, F(x, e):
//   F = max over seeds ( e * a_i - b - |x - s_i| ) + N(x)
// where N is the ver20 mask noise and e is the eased progress. A pixel of image 1 goes when F
// passes its own grain threshold h * band; a grain is released at exactly that moment, so the
// hole in image 1 and the grain leaving it are the same event. F is linear in e for each seed,
// so a grain's release time is solved in closed form in the vertex shader - no simulation, no
// state, and it plays back identically every frame.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  duration: num('dur', 3.4),     // s, first opening to fully image 2
  reverseDuration: 2.0,          // s, back again on scroll up
  seeds: num('seeds', 7),        // openings, all starting together (max 12)
  seedMinDist: 0.28,             // how far apart the openings start (screen heights)
  seedSizeVar: 0.35,             // +- share by which one opening grows faster than another
  maskAmount: 0.13,              // how ragged the ver20 mask makes the border (screen heights)
  band: 0.035,                   // width of the crumbling border (screen heights)
  shadow: 0.30,                  // image 2 darkened just inside the border, for depth
  grainPx: 1.5,                  // css px per dissolve cell on the page
  grains: num('grains', 260000), // falling grains
  grainSize: [1.0, 2.4],         // css px
  gravity: 2.4,                  // screen heights / s^2
  grainLife: [1.3, 2.4],         // s
  grainSpread: 0.05,             // sideways drift (screen heights / s)
  grainShade: [0.78, 1.02],      // grain colour vs image 1, so some read against it
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
function tex(url, repeat) {
  const t = loader.load(url, () => { t.userData.ready = true; });
  t.colorSpace = THREE.NoColorSpace;   // raw pass-through: the shaders output what they read
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
const tImg1 = tex('./assets/img1.jpg');
const tImg2 = tex('./assets/img2.jpg');
const tNoise = tex('./assets/mask-noise.webp', true);
const IMG1_ASPECT = 1512 / 900;
const IMG2_ASPECT = 2560 / 1663;

// ------------------------------------------------------------- shared GLSL ----
const MAX_SEEDS = 12;
const FIELD_GLSL = /* glsl */`
uniform sampler2D tNoise;
uniform float uAspect;
uniform vec3  uSeeds[${MAX_SEEDS}];   // xy: centre (aspect space), z: growth a_i
uniform int   uSeedCount;
uniform float uB;
uniform float uA;
uniform vec2  uNoiseOff;
uniform float uBand;

// the ver20 mask: the same texture, channel, scales and curve as its flowmap stamp
float maskNoise(vec2 uv) {
  vec2 q = uv * vec2(uAspect, 1.0);
  float n1 = 0.00 + 1.00 * smoothstep(0.4, 1.0, texture2D(tNoise, q * 0.35 + uNoiseOff).g);
  float n2 = 0.15 + 0.85 * smoothstep(0.4, 1.0, texture2D(tNoise, q * 0.8 + uNoiseOff * 1.7).g);
  return uA * (0.65 * n1 + 0.35 * n2 - 0.5);
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
`;

// ------------------------------------------------------------------ the page ----
const pageMat = new THREE.ShaderMaterial({
  depthTest: false, depthWrite: false,
  uniforms: {
    tNoise: { value: tNoise }, tImg1: { value: tImg1 }, tImg2: { value: tImg2 },
    uAspect: { value: 1 }, uSeeds: { value: Array.from({ length: MAX_SEEDS }, () => new THREE.Vector3()) },
    uSeedCount: { value: 0 }, uB: { value: 0 }, uA: { value: CONFIG.maskAmount },
    uNoiseOff: { value: new THREE.Vector2() }, uBand: { value: CONFIG.band },
    uE: { value: 0 }, uFill: { value: 0 }, uCell: { value: 1.5 }, uShadow: { value: CONFIG.shadow },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    ${FIELD_GLSL}
    uniform sampler2D tImg1;
    uniform sampler2D tImg2;
    uniform float uE;
    uniform float uFill;
    uniform float uCell;
    uniform float uShadow;
    varying vec2 vUv;
    void main() {
      vec2 q = vUv * vec2(uAspect, 1.0);
      float F = -1e3;
      for (int i = 0; i < ${MAX_SEEDS}; i++) {
        if (i >= uSeedCount) break;
        F = max(F, uE * uSeeds[i].z - uB - length(q - uSeeds[i].xy));
      }
      F += maskNoise(vUv);
      float t = F / uBand;                               // 0..1 across the crumbling border
      float h = hash12(floor(gl_FragCoord.xy / uCell));  // this cell's grain threshold
      float m = max(t > h ? 1.0 : 0.0, uFill);

      vec3 c1 = texture2D(tImg1, cover(vUv, ${IMG1_ASPECT.toFixed(6)})).rgb;
      vec3 c2 = texture2D(tImg2, cover(vUv, ${IMG2_ASPECT.toFixed(6)})).rgb;
      // image 1 darkens a touch where it is about to crumble; image 2 lies in shadow under
      // the edge it has just come out from
      c1 *= 1.0 - 0.10 * smoothstep(-2.0, 0.0, t) * step(t, 0.0);
      c2 *= mix(1.0 - uShadow, 1.0, max(smoothstep(0.0, 2.5, t), uFill));
      gl_FragColor = vec4(mix(c1, c2, m), 1.0);
    }`,
});
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
    uG: { value: CONFIG.gravity }, uLife: { value: new THREE.Vector2(...CONFIG.grainLife) },
    uSize: { value: new THREE.Vector2(...CONFIG.grainSize) }, uSpread: { value: CONFIG.grainSpread },
    uShade: { value: new THREE.Vector2(...CONFIG.grainShade) },
  },
  vertexShader: /* glsl */`
    precision highp float;
    ${FIELD_GLSL}
    uniform sampler2D tImg1;
    uniform float uS, uDur, uVis, uPx, uG, uSpread;
    uniform vec2 uLife, uSize, uShade;
    attribute vec4 aRand;
    varying vec3 vCol;
    varying float vAlpha;
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
      if (eRel > 1.0) { hide(); return; }
      eRel = max(eRel, 0.0);
      float pRel = acos(1.0 - 2.0 * eRel) / 3.14159265;   // undo the sine ease
      float tau = (uS - pRel) * uDur;                       // seconds since it came loose
      float life = mix(uLife.x, uLife.y, aRand.x);
      if (tau < 0.0 || tau > life || uVis <= 0.0) { hide(); return; }

      float v0 = mix(-0.04, 0.05, aRand.y);                 // a few hop up before they drop
      vec2 p = home;
      p.y -= v0 * tau + 0.5 * uG * tau * tau;
      p.x += ((aRand.z - 0.5) * uSpread * tau
              + sin(tau * 4.0 + aRand.w * 6.2831853) * 0.003 * min(tau * 3.0, 1.0)) / uAspect;
      if (p.y < -0.02) { hide(); return; }

      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = mix(uSize.x, uSize.y, aRand.w * aRand.w) * uPx;
      vCol = texture2D(tImg1, cover(home, ${IMG1_ASPECT.toFixed(6)})).rgb * mix(uShade.x, uShade.y, aRand.y);
      vAlpha = uVis * (1.0 - smoothstep(0.55 * life, life, tau));
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec3 vCol;
    varying float vAlpha;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float a = vAlpha * smoothstep(0.5, 0.3, length(d));
      if (a < 0.01) discard;
      gl_FragColor = vec4(vCol, a);
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
// s runs 0 -> 1 over the duration and on past 1 while the last grains land; p = min(s, 1)
let s = 0;
let dir = 0;                 // +1 opening, -1 closing, 0 still
function forward() {
  if (dir === 1) return;
  if (s <= 0) placeSeeds();  // a fresh set of openings each time it starts from image 1
  s = Math.min(s, 1);
  dir = 1;
  hint.classList.add('off');
}
function backward() {
  if (dir === -1 || s <= 0) return;
  s = Math.min(s, 1);
  dir = -1;
}

const hint = document.getElementById('hint');
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
  if (seedUv.length) uploadSeeds(); else pageMat.uniforms.uAspect.value = innerWidth / innerHeight;
}
addEventListener('resize', resize);
resize();

let last = performance.now();
const tailEnd = 1 + (CONFIG.grainLife[1] + 0.2) / CONFIG.duration;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dir === 1) {
    s += dt / CONFIG.duration;
    if (s >= tailEnd) { s = tailEnd; }
  } else if (dir === -1) {
    s -= dt / CONFIG.reverseDuration;
    if (s <= 0) { s = 0; dir = 0; hint.classList.remove('off'); }
  }
  const p = Math.min(s, 1);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * p);
  const u = pageMat.uniforms;
  u.uE.value = e;
  u.uFill.value = THREE.MathUtils.smoothstep(p, 0.985, 1.0);
  const gu = grainMat.uniforms;
  gu.uS.value = s;
  gu.uVis.value = THREE.MathUtils.clamp(gu.uVis.value + (dir === 1 ? dt / 0.25 : -dt / 0.2), 0, 1);
  grains.visible = gu.uVis.value > 0 && s > 0 && s < tailEnd;
  renderer.render(scene, camera);
});
