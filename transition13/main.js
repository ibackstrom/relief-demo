// TRANSITION 13 — wind over the dune.
//
// No video. Every earlier sand version leaned on the stock clip, and its edge re-randomises its
// grain every frame: shown sharp it boils, smoothed it goes soapy. Here every grain's behaviour is
// computed from the transition's progress alone - stable, exactly reversible, nothing to load.
//
// The picture: a gently curved dune front sweeps across with the wind. At the front, image 1
// does not open in blobs - it is blown off in thin streaks ALONG the wind, the way sand streams
// off a ridge. Image 1 is cut into round grains (CONFIG.cell px); each grain leaves the picture
// in the very frame its particle is blown off, carrying that spot's colour, streaks a little
// downwind and is gone a third of a second later. Behind the front image 2 lies under a settling
// layer of sand: fine ripples across the wind that fade as the front moves on. The eroding edge
// throws a slight contact shadow; lifting grains throw small shadows.
//
// When each grain lets go is worked out once into a texture (the CELL pass), so the page and the
// grains both just read it. The timeline is designed so every grain has finished by the end.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  duration: num('dur', 2.6),     // s, the sweep at full speed
  accel: 0.35,                   // s to reach full speed (inertia), and it eases into the end
  windAngle: 12,                 // degrees: the way the wind blows (0 = to the right, up is +)
  band: 0.28,                    // how wide the eroding band is (share of the screen across the wind)
  streak: 0.85,                  // how much the erosion runs in streaks along the wind (0 = none)
  dune: 0.07,                    // how curved the dune front is
  cell: num('cell', 2.5),        // css px per grain
  gapLead: 0.012,                // the gaps between grains go a moment before the grains
  // the grains in flight (screen heights, seconds)
  kick: 0.55,                    // speed as a grain is blown off
  accelWind: 1.6,                // and the wind keeps pushing it
  wobble: 0.05,                  // sideways wander
  lift: 0.6,                     // how fast it rises off the picture (for its shadow and size)
  life: 0.32,                    // s a grain flies before it is gone
  grainSize: 1.0,                // x the cell
  motionStreak: 1.0,             // streak along the wind, 1 = one frame's travel
  grainShadow: 0.35,             // the flying grain's shadow
  shadowDistance: 0.08,          // how far it falls per unit of lift
  // image 2 under the settling sand
  ripple: 0.10,                  // strength of the sand ripples behind the front
  rippleLength: 0.22,            // how far behind the front they last (share of the sweep)
  rippleFreq: 55,                // ripples per screen height
  edgeShadow: 0.22,              // the eroding edge's contact shadow on image 2
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
  uGapLead: { value: CONFIG.gapLead },
  uKick: { value: CONFIG.kick }, uAccelW: { value: CONFIG.accelWind }, uWob: { value: CONFIG.wobble },
  uLift: { value: CONFIG.lift }, uLife: { value: CONFIG.life }, uGrainSize: { value: CONFIG.grainSize },
  uMStreak: { value: CONFIG.motionStreak }, uGrainShadow: { value: CONFIG.grainShadow },
  uShadowDist: { value: CONFIG.shadowDistance },
  uRipple: { value: CONFIG.ripple }, uRippleLen: { value: CONFIG.rippleLength }, uRippleFreq: { value: CONFIG.rippleFreq },
  uEdgeShadow: { value: CONFIG.edgeShadow },
};
const COMMON = /* glsl */`
  uniform sampler2D tImg1, tImg2, tCell;
  uniform vec2 uScreen, uWind;
  uniform float uDpr, uCell, uP, uD, uU0, uU1, uF0, uF1, uBand, uStreak, uDune, uGapLead;
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
      vec2 w = windSpace(cpx);
      float s = (w.x - uU0) / (uU1 - uU0);
      // the dune front's gentle curve, across the wind
      float dune = uDune * (0.6 * sin(w.y * 2.3 + 1.1) + 0.4 * fbm(vec2(w.y * 1.7, 3.3)));
      // streaks along the wind: slow along it, fine across it
      float streak = 0.5 + 0.5 * (0.75 * snoise(vec2(w.x * 1.2, w.y * 38.0))
                                + 0.25 * snoise(vec2(w.x * 3.1, w.y * 95.0)));
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
  const lastShare = Math.max(0.2, 1 - CONFIG.life / CONFIG.duration);
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
      return inGrain * step(uP, cd.r) + (1.0 - inGrain) * step(uP, cd.r - uGapLead);
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
      vec2 w = windSpace(px);
      float phase = w.x * uRippleFreq + 0.6 * snoise(vec2(w.x * 1.5, w.y * 2.0));
      float fade = smoothstep(0.0, 0.006, since) * (1.0 - smoothstep(0.0, uRippleLen, since));
      c2 *= 1.0 + uRipple * cos(phase * 6.2831853) * fade;
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
  uniform float uKick, uAccelW, uWob, uLift, uLife, uGrainSize, uMStreak, uGrainShadow, uShadowDist;
  in vec2 aCell;
  out vec3 vCol; out float vAlpha; out float vK;
  void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
  void main() {
    vec4 cd = texelFetch(tCell, ivec2(aCell), 0);
    float tau = (uP - cd.r) * uD;                     // seconds since it was blown off
    if (tau <= 0.0 || tau >= uLife) { hide(); return; }
    float r1 = cd.g, r2 = cd.b;
    vec2 cpx = (aCell + 0.5) * uCell;
    float speed0 = uKick * (0.6 + 0.8 * r1);
    float along = speed0 * tau + 0.5 * uAccelW * tau * tau;
    float across = uWob * snoise(vec2(r2 * 31.0, tau * 1.7)) * tau * 3.0;
    float z = uLift * tau * (0.5 + r2);
    vec2 pos = cpx + (uWind * along + windPerp() * across) * uScreen.y;
    ${shadow ? 'pos += vec2(0.55, -1.0) * z * uShadowDist * uScreen.y;' : ''}
    float size = uCell * (0.8 + 0.35 * r2) * uGrainSize * (1.0 + z * 0.4);
    ${shadow ? 'size *= 1.0 + z;' : ''}
    float a = 1.0 - smoothstep(uLife * 0.35, uLife, tau);
    vAlpha = a * ${shadow ? 'uGrainShadow * (1.0 - 0.5 * clamp(z * 3.0, 0.0, 1.0))' : '1.0'};
    vCol = texture(tImg1, coverUv(cpx / uScreen, ${IMG1_ASPECT.toFixed(6)})).rgb * (0.94 + 0.12 * r1);
    // streak along the wind: one frame's travel
    float speedPx = (speed0 + uAccelW * tau) * uScreen.y / 60.0 * uMStreak;
    vK = 1.0 + min(speedPx / max(size, 0.5), 4.0);
    gl_Position = vec4(pos / uScreen * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = max(size * uDpr * vK, 1.0);
  }`;
const grainFrag = (shadow) => /* glsl */`
  precision highp float;
  uniform vec2 uWind;
  in vec3 vCol; in float vAlpha; in float vK;
  out vec4 outColor;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    d.y = -d.y;
    float along = dot(d, uWind), across = dot(d, vec2(-uWind.y, uWind.x)) * vK;
    float r2 = along * along + across * across;
    if (r2 > 1.0) discard;
    ${shadow ? 'float a = vAlpha * (1.0 - smoothstep(0.1, 1.0, r2)); outColor = vec4(0.0, 0.0, 0.0, a);' : `
    vec3 n = vec3(along, across / vK, sqrt(max(1.0 - r2, 0.0)));
    float lit = 0.8 + 0.3 * max(dot(normalize(n), normalize(vec3(-0.45, 0.6, 0.66))), 0.0);
    float a = vAlpha * smoothstep(1.0, 0.75, r2);
    outColor = vec4(vCol * lit * a, a);`}
  }`;
const grainMat = (shadow) => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  vertexShader: grainVert(shadow), fragmentShader: grainFrag(shadow),
});
const shadowPoints = new THREE.Points(new THREE.BufferGeometry(), grainMat(true));
const grainPoints = new THREE.Points(new THREE.BufferGeometry(), grainMat(false));
for (const [o, r] of [[shadowPoints, 1], [grainPoints, 2]]) { o.frustumCulled = false; o.renderOrder = r; scene.add(o); }
function buildGrainGeometry() {
  const n = GW * GH;
  const cells = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { cells[i * 2] = i % GW; cells[i * 2 + 1] = Math.floor(i / GW); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aCell', new THREE.BufferAttribute(cells, 2));
  for (const o of [shadowPoints, grainPoints]) { o.geometry.dispose(); o.geometry = g; }
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
    ['the sweep'],
    ['duration', 'duration (s)', 0.8, 8, 0.1, (v) => { CONFIG.duration = v; computeCells(); }],
    ['accel', 'inertia (s)', 0, 1.5, 0.05, (v) => { CONFIG.accel = v; }],
    ['windAngle', 'wind direction *', -180, 180, 1, recompute('windAngle')],
    ['band', 'eroding band *', 0.02, 0.8, 0.01, recompute('band')],
    ['streak', 'wind streaks *', 0, 1.5, 0.01, recompute('streak')],
    ['dune', 'dune curve *', 0, 0.3, 0.005, recompute('dune')],
    ['the grains'],
    ['kick', 'blown-off speed', 0, 2, 0.01, live('kick', 'uKick')],
    ['accelWind', 'wind push', 0, 5, 0.05, live('accelWind', 'uAccelW')],
    ['wobble', 'wander', 0, 0.3, 0.005, live('wobble', 'uWob')],
    ['lift', 'lift', 0, 2, 0.01, live('lift', 'uLift')],
    ['life', 'life (s) *', 0.08, 1.2, 0.01, (v) => { CONFIG.life = v; U.uLife.value = v; computeCells(); }],
    ['grainSize', 'grain size', 0.4, 2.5, 0.05, live('grainSize', 'uGrainSize')],
    ['motionStreak', 'motion streak', 0, 3, 0.05, live('motionStreak', 'uMStreak')],
    ['grainShadow', 'grain shadow', 0, 1, 0.01, live('grainShadow', 'uGrainShadow')],
    ['under the sand'],
    ['ripple', 'ripples', 0, 0.5, 0.005, live('ripple', 'uRipple')],
    ['rippleLength', 'ripples last', 0.01, 0.8, 0.01, live('rippleLength', 'uRippleLen')],
    ['rippleFreq', 'ripple fineness', 10, 140, 1, live('rippleFreq', 'uRippleFreq')],
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
if (PARAMS.get('debug') === '1') window.__t13 = { renderer, U, CONFIG, get p() { return p; } };
