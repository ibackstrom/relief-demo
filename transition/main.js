// TRANSITION v4 — the "sand reveal": image 1 is a sheet of sand that a sweep front crosses.
// Ahead of the front it lies flat; inside the fold band it lifts into long curling folds,
// shaded by the light; past the band it tears into grains that the wind blows off, and
// image 2 is underneath.
//
// Ported from the client's "Sand reveal" page, with its defaults. What changed:
//  - the sheet is IMAGE 1 (its folds shade the picture) and the grains carry image 1's
//    colours; behind is IMAGE 2 instead of the gradient
//  - image 2 lies in the folded sheet's shadow just behind the tear
//  - driven by scroll: down plays it, up plays it backwards (the sand builds back in). Every
//    frame is computed from the timeline value alone, so backwards is exact
//  - no panel; the panel's values are CONFIG below
// (v3, the ver20-mask openings with falling sand, is in git history / main_v3.js.bak)

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);
// a page can preset values before loading this module (the preview does)
const PRESET = window.TRANSITION_CONFIG || {};
const pre = (k, d) => (k in PRESET ? PRESET[k] : d);

const CONFIG = {
  duration: num('dur', pre('duration', 6)),   // s, the whole sweep
  sweepAngle: num('ang', pre('sweepAngle', 225)), // deg, direction the front travels (225: from top right)
  foldBand: 0.30,           // width of the fold band (sweep units)
  foldHeight: 0.08,         // how high the folds lift
  foldContrast: 1.4,        // how strongly the folds are shaded
  edgeBreakup: 0.25,        // noise on the front
  flySpeed: 4.0,            // how fast grains fly off once released
  grainSize: 1.4,           // px
  grains: num('grains', pre('grains', 700000)),
  speckle: 0.36,            // grain texture on the sheet inside the fold band
  shadow: 0.35,             // image 2 in the folded sheet's shadow just behind the tear
  shadowLength: 0.15,       // how far behind the tear that shadow reaches (sweep units)
};

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setClearColor(0x000000, 1);
document.body.appendChild(renderer.domElement);

const FOV = 20;
const camDist = 0.5 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10);
camera.position.set(0, 0, camDist);
const scene = new THREE.Scene();

const loader = new THREE.TextureLoader();
const asset = (f) => new URL('./assets/' + f, import.meta.url).href;
function tex(file) {
  const t = loader.load(asset(file));
  t.colorSpace = THREE.NoColorSpace;   // raw pass-through: the shaders output what they read
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
const IMG1_ASPECT = 1512 / 900;
const IMG2_ASPECT = 2560 / 1663;

// ---------------------------------------------------------------------------
// Shared GLSL: sweep front, fold height field, shading.
// Plane coords p: x in [-aspect/2, aspect/2], y in [-0.5, 0.5], y up.
// ---------------------------------------------------------------------------
const COMMON = /* glsl */`
  uniform float uF;       // sweep front position
  uniform vec2  uDir;     // travel direction of the reveal edge
  uniform vec2  uExt;     // half extents of the screen in plane units
  uniform float uFoldW;   // width of the fold band (in sweep units)
  uniform float uFoldH;   // fold height
  uniform float uEdgeN;   // noise on the front
  uniform float uShadeK;  // normal exaggeration
  uniform sampler2D tImg1;

  vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
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

  // 0 at the start corner, 1 at the far corner
  float sweepS(vec2 p) {
    float m = dot(abs(uDir), uExt);
    return (dot(p, uDir) + m) / (2.0 * m);
  }
  // how far past the front this point is (<0 untouched)
  float localT(vec2 p) { return uF - sweepS(p) + fbm(p * 2.2 + 3.7) * uEdgeN; }

  // long curling folds running across the sweep direction
  float foldNoise(vec2 p) {
    vec2 perp = vec2(-uDir.y, uDir.x);
    vec2 q = vec2(dot(p, perp), dot(p, uDir));
    vec2 w = vec2(fbm(q * 1.2), fbm(q * 1.2 + 9.2));
    return fbm(vec2(q.x * 1.3, q.y * 3.2) + w * 0.9 + vec2(0.0, uF * 1.2));
  }
  float heightAt(vec2 p, out float n) {
    float d = smoothstep(0.0, uFoldW, localT(p));
    n = foldNoise(p);
    float r = 1.0 - abs(n);
    r *= r;
    return d * d * uFoldH * (0.35 + r);
  }
  vec3 sheetPos(vec2 p, float t, out float h) {
    float n;
    h = heightAt(p, n);
    float d = smoothstep(0.0, uFoldW, t);
    vec2 perp = vec2(-uDir.y, uDir.x);
    vec2 off = -uDir * d * d * 0.04 + perp * n * d * 0.02;
    return vec3(p + off, h);
  }
  vec3 sheetNormal(vec2 p, float h) {
    float e = 0.004, n;
    float hx = heightAt(p + vec2(e, 0.0), n);
    float hy = heightAt(p + vec2(0.0, e), n);
    return normalize(vec3(-(hx - h) / e * uShadeK, -(hy - h) / e * uShadeK, 1.0));
  }
  float shade(vec3 n) {
    vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
    return 0.42 + 0.72 * max(dot(n, L), 0.0);
  }
  // shading relative to a flat sheet, so image 1 at rest looks exactly like image 1
  float relShade(vec3 n) { return shade(n) / shade(vec3(0.0, 0.0, 1.0)); }

  // image 1 at plane point p, fitted like background-size: cover
  vec3 img1At(vec2 p) {
    vec2 uv = p / (2.0 * uExt) + 0.5;
    float sa = uExt.x / uExt.y, ia = ${IMG1_ASPECT.toFixed(6)};
    vec2 s = sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0);
    return texture2D(tImg1, clamp((uv - 0.5) * s + 0.5, 0.0, 1.0)).rgb;
  }
`;

const U = {
  uF: { value: 0 },
  uDir: { value: new THREE.Vector2() },
  uExt: { value: new THREE.Vector2(0.889, 0.5) },
  uFoldW: { value: CONFIG.foldBand },
  uFoldH: { value: CONFIG.foldHeight },
  uEdgeN: { value: CONFIG.edgeBreakup },
  uShadeK: { value: CONFIG.foldContrast },
  uGrainRes: { value: 700 },
  uSize: { value: CONFIG.grainSize },
  uDpr: { value: 1 },
  uAgeK: { value: CONFIG.flySpeed },
  uCamDist: { value: camDist },
  uSpeckle: { value: CONFIG.speckle },
  uShadow: { value: CONFIG.shadow },
  uShadowLen: { value: CONFIG.shadowLength },
  tImg1: { value: tex('img1.jpg') },
  tImg2: { value: tex('img2.jpg') },
};
{
  const a = THREE.MathUtils.degToRad(CONFIG.sweepAngle);
  U.uDir.value.set(Math.cos(a), Math.sin(a));
}

// ---- image 2, underneath: a screen quad drawn first --------------------------------------
const under = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: COMMON + /* glsl */`
    uniform sampler2D tImg2;
    uniform float uShadow, uShadowLen;
    varying vec2 vUv;
    void main() {
      float sa = uExt.x / uExt.y, ia = ${IMG2_ASPECT.toFixed(6)};
      vec2 s = sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0);
      vec3 c = texture2D(tImg2, (vUv - 0.5) * s + 0.5).rgb;
      // the folded sheet stands up just ahead of here: its shadow, fading with distance
      vec2 p = (vUv - 0.5) * 2.0 * uExt;
      float t = localT(p) - uFoldW;
      c *= 1.0 - uShadow * (1.0 - smoothstep(0.0, uShadowLen, t));
      gl_FragColor = vec4(c, 1.0);
    }`,
}));
under.frustumCulled = false;
under.renderOrder = -1;
scene.add(under);

// ---- the sheet: image 1, which folds and then tears --------------------------------------
const sheet = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1, 480, 270),
  new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: COMMON + /* glsl */`
      varying vec2 vP; varying vec3 vN; varying float vT;
      void main() {
        vec2 p = (uv - 0.5) * 2.0 * uExt * 1.04;
        float t = localT(p);
        vec3 pos = vec3(p, 0.0);
        vec3 n = vec3(0.0, 0.0, 1.0);
        if (t > 0.0) {
          float h;
          pos = sheetPos(p, t, h);
          n = sheetNormal(p, h);
        }
        vP = p; vN = n; vT = t;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: COMMON + /* glsl */`
      uniform float uGrainRes, uSpeckle;
      varying vec2 vP; varying vec3 vN; varying float vT;
      void main() {
        vec2 cell = floor(vP * uGrainRes);
        float g = hash12(cell);
        float speck = hash12(cell + 17.0);
        // the sheet goes speckled, then disappears just before the grains fly
        if (vT > uFoldW + 0.03 - speck * 0.06) discard;
        // the picture turns to sand texture as it enters the fold band
        float loose = smoothstep(0.0, uFoldW * 0.5, vT);
        vec3 base = img1At(vP) * (1.0 + loose * uSpeckle * (g - 0.5));
        gl_FragColor = vec4(base * relShade(vN), 1.0);
      }`,
  }),
);
sheet.frustumCulled = false;
scene.add(sheet);

// ---- grains: ride the sheet, then get released and blown away ------------------------------
const grainMat = new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  vertexShader: COMMON + /* glsl */`
    uniform float uSize, uDpr, uAgeK, uCamDist;
    varying vec3 vCol; varying float vAlpha;
    void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
    void main() {
      vec2 p = (position.xy - 0.5) * 2.0 * uExt * 1.04;
      float r = position.z;
      float t = localT(p);
      // untouched: the flat picture needs no grains on top of it
      if (t <= 0.0) { hide(); return; }
      vec3 n = vec3(0.0, 0.0, 1.0);
      float h;
      vec3 pos = sheetPos(p, t, h);
      float rel = uFoldW + (r - 0.5) * 0.05;
      float a = max(t - rel, 0.0) * uAgeK;
      if (a <= 0.0) {
        n = sheetNormal(p, h);
      } else {
        vec2 perp = vec2(-uDir.y, uDir.x);
        vec2 wind = normalize(-uDir + perp * 0.25);
        vec2 jit = vec2(snoise(p * 6.0 + r * 10.0), snoise(p * 6.0 + 31.0 + r * 10.0));
        pos.xy += wind * (a * 0.15 + a * a * 0.35) + jit * a * 0.06;
        pos.z += a * 0.12 + a * a * 0.1;
      }
      vAlpha = 1.0 - smoothstep(0.25, 0.9, a + r * 0.25);
      // riding the sheet they fade in with the sand texture, so the picture does not dim
      vAlpha *= smoothstep(0.0, uFoldW * 0.5, t);
      if (vAlpha <= 0.001) { hide(); return; }
      vec3 base = img1At(p) * (0.9 + 0.2 * fract(r * 13.1));
      float sh = a > 0.0 ? 0.95 : relShade(n);
      vCol = base * sh;
      vec4 mv = modelViewMatrix * vec4(pos + vec3(0.0, 0.0, 0.0015), 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = uSize * uDpr * (0.7 + 0.6 * fract(r * 7.3)) * (uCamDist / -mv.z);
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vCol; varying float vAlpha;
    void main() { gl_FragColor = vec4(vCol * vAlpha, vAlpha); }`,
});
{
  const n = Math.round(CONFIG.grains);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < arr.length; i++) arr[i] = Math.random();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const grains = new THREE.Points(g, grainMat);
  grains.frustumCulled = false;
  grains.renderOrder = 1;
  scene.add(grains);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  U.uExt.value.set(0.5 * w / h, 0.5);
  U.uDpr.value = dpr;
  U.uGrainRes.value = h / 1.4;
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the timeline ----
// p runs 0..1; scroll down plays towards 1, scroll up back towards 0
let p = 0;
let dir = 0;
const hint = document.getElementById('hint');
function forward() { dir = 1; if (hint) hint.classList.add('off'); }
function backward() { if (p > 0) dir = -1; }

function frontFromProgress(q) {
  let e = Math.min(Math.max(q, 0), 1);
  e = 0.5 * e + 0.5 * e * e * (3 - 2 * e);
  const fw = U.uFoldW.value, en = U.uEdgeN.value, ak = U.uAgeK.value;
  const fStart = -0.75 * en - 0.02;
  const fEnd = 1 + fw + 0.1 + 0.75 * en + 1.6 / ak;
  return fStart + (fEnd - fStart) * e;
}

addEventListener('wheel', (e) => { if (e.deltaY > 2) forward(); else if (e.deltaY < -2) backward(); }, { passive: true });
let touchY = null;
addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
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
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (dir !== 0) {
    p += dir * dt / CONFIG.duration;
    if (p >= 1) { p = 1; dir = 0; }
    if (p <= 0) { p = 0; dir = 0; if (hint) hint.classList.remove('off'); }
  }
  U.uF.value = frontFromProgress(p);
  renderer.render(scene, camera);
});
