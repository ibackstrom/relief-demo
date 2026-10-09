// TRANSITION 17 — depth.
//
// Image 1 comes apart into a real 3D volume and is carried off by a curl-noise wind, revealing
// image 2 underneath. What makes it read as volume, not as a flat dissolve:
//
//  - a perspective camera: the picture is the plane z = 0, filling the screen exactly; the pieces
//    lift off it toward the viewer, so they grow, and they move with true parallax (near pieces
//    sweep faster than far ones)
//  - the flow is 3D and divergence-free (the cross product of two noise gradients - "bitangent
//    noise", atyuwen) so the cloud swirls in depth without clumping or thinning out
//  - depth of field: the focus sits on the picture; the higher a piece flies the softer and wider
//    it gets, with its light spread out (energy kept), like a lens
//  - every piece is a little flake that tumbles: it narrows as it turns edge-on, darkens as it
//    turns from the light and catches a glint as it faces it
//  - the flakes cast soft shadows on the picture under them that widen and fade with height, and
//    the remaining sheet of image 1 casts a thin contact shadow on image 2 with a lit torn edge
//
// It is all a function of the progress: each piece's flight is integrated in its vertex shader
// from the moment it let go, so scrolling back plays it exactly in reverse. At the moment a piece
// lets go it is a square of exactly its cell's pixels - the hole and the piece are one event, no
// seam - and every piece is gone (shrunk, faded, or out of the frame) before the end: the sweep is
// timed so the last one lets go a full life before p = 1. Nothing floats after the reveal.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  duration: num('dur', 3.2),     // s, the transition at full speed
  accel: 0.4,                    // s to reach full speed (inertia); it eases into the end too
  // the sweep (* = re-times the pieces)
  angle: 18,                     // degrees, the way the front travels (0 = left to right)
  band: 0.30,                    // how deep the breaking band is (share of the sweep)
  lobes: 0.10,                   // how curved / lobed the front is
  clumpScale: 4.0,               // size of the clumps that go together (higher = smaller)
  grain: 0.35,                   // how much single pieces go on their own (0 = only in clumps)
  cell: num('cell', 2.5),        // css px per piece (rebuilds)
  // the flight (screen half-heights over a piece's life)
  life: 1.15,                    // s a piece flies
  wind: 1.1,                     // carried along the sweep
  rise: 0.25,                    // and up
  lift: 0.75,                    // toward the viewer (depth)
  curl: 0.55,                    // the swirl
  curlScale: 1.3,                // its size (lower = larger eddies)
  depthSwirl: 1.0,               // how much the swirl moves in depth
  spin: 1.2,                     // flake tumbles over its life
  // the look
  fov: 45,                       // degrees: wider = stronger perspective
  dof: 26,                       // px of blur per unit of height (0 = all sharp)
  maxBlur: 18,                   // px, the most blur
  flake: 1.25,                   // flake size (x the cell)
  shade: 0.35,                   // how much a turning flake darkens
  glint: 0.5,                    // its glint facing the light
  fadeFrom: 0.5,                 // share of its life after which a piece shrinks and fades
  tail: 0.45,                    // share of a life the last pieces get before the end (shorter = no still frames)
  shadow: 0.45,                  // the flakes' shadows on the picture
  penumbra: 22,                  // px a shadow widens per unit of height
  sheetShadow: 0.30,             // the remaining sheet's contact shadow on image 2
  sheetThickness: 0.012,         // its height (screen half-heights)
  edgeLight: 0.18,               // the lit torn edge
};

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);
const gl = renderer.getContext();
const FLOAT_OK = !!gl.getExtension('EXT_color_buffer_float');
const RT_TYPE = FLOAT_OK ? THREE.FloatType : THREE.HalfFloatType;

const loader = new THREE.TextureLoader();
function img(url) {
  const t = loader.load(url);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  return t;
}
const tImg1 = img('./assets/img1.jpg');
const tImg2 = img('./assets/img2.jpg');
const IMG1_ASPECT = 1512 / 900, IMG2_ASPECT = 2560 / 1663;

// ------------------------------------------------------------- shared GLSL ----
const NOISE2 = /* glsl */`
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
  vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
  }
`;
// 3D simplex noise with its analytic gradient (as in PTSVer30)
const NOISE3 = /* glsl */`
  vec3 mod289v3(vec3 x) { return x - floor(x / 289.0) * 289.0; }
  vec4 mod289v4(vec4 x) { return x - floor(x / 289.0) * 289.0; }
  vec4 permute4(vec4 x) { return mod289v4((x * 34.0 + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  vec3 snoiseGrad(vec3 p) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(p + dot(p, vec3(C.y)));
    vec3 x0 = p - i + dot(i, vec3(C.x));
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.x;
    vec3 x2 = x0 - i2 + C.y;
    vec3 x3 = x0 - D.yyy;
    i = mod289v3(i);
    vec4 pp = permute4(permute4(permute4(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
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
    vec4 norm = taylorInvSqrt(vec4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3)));
    g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    vec4 m2 = m * m;
    vec4 m3 = m2 * m;
    vec4 m4 = m2 * m2;
    vec4 gdotx = vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3));
    return 42.0 * (m4.x * g0 + m4.y * g1 + m4.z * g2 + m4.w * g3
      - 8.0 * (m3.x * gdotx.x * x0 + m3.y * gdotx.y * x1 + m3.z * gdotx.z * x2 + m3.w * gdotx.w * x3));
  }
  // divergence-free 3D flow: the cross product of two noise gradients (bitangent noise)
  vec3 flow(vec3 p) {
    return cross(snoiseGrad(p), snoiseGrad(p + vec3(31.416, -47.853, 12.793))) * 0.3;
  }
`;
const QUAD_VERT = /* glsl */`
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// shared uniforms
const U = {
  tImg1: { value: tImg1 }, tImg2: { value: tImg2 }, tRel: { value: null }, tShadow: { value: null },
  uScreen: { value: new THREE.Vector2(innerWidth, innerHeight) }, uDpr: { value: 1 },
  uGrid: { value: new THREE.Vector2(1, 1) }, uP: { value: 0 }, uLifeP: { value: 0.3 }, uRaw: { value: 0 }, uT0: { value: 0 }, uT1: { value: 1 }, uRelMax: { value: 0.7 },
  uDir: { value: new THREE.Vector2(1, 0) }, uS0: { value: 0 }, uS1: { value: 1 },
  uBand: { value: CONFIG.band }, uLobes: { value: CONFIG.lobes }, uClump: { value: CONFIG.clumpScale },
  uGrain: { value: CONFIG.grain },
  uWind: { value: CONFIG.wind }, uRise: { value: CONFIG.rise }, uLift: { value: CONFIG.lift },
  uCurl: { value: CONFIG.curl }, uCurlScale: { value: CONFIG.curlScale }, uDepthSwirl: { value: CONFIG.depthSwirl },
  uSpin: { value: CONFIG.spin }, uCamD: { value: 2.4 },
  uDof: { value: CONFIG.dof }, uMaxBlur: { value: CONFIG.maxBlur }, uFlake: { value: CONFIG.flake },
  uShade: { value: CONFIG.shade }, uGlint: { value: CONFIG.glint }, uFadeFrom: { value: CONFIG.fadeFrom },
  uShadow: { value: CONFIG.shadow }, uPenumbra: { value: CONFIG.penumbra },
  uSheetShadow: { value: CONFIG.sheetShadow }, uSheetThick: { value: CONFIG.sheetThickness },
  uEdgeLight: { value: CONFIG.edgeLight },
  uLightDir: { value: new THREE.Vector3(0.38, -0.5, -1).normalize() },
};
const COMMON = /* glsl */`
  uniform sampler2D tImg1, tImg2, tRel;
  uniform vec2 uScreen, uGrid, uDir;
  uniform vec3 uLightDir;
  uniform float uDpr, uP, uLifeP, uS0, uS1, uBand, uLobes, uClump, uGrain, uRaw, uT0, uT1, uRelMax;
  vec2 coverUv(vec2 uv, float ia) {
    float sa = uScreen.x / uScreen.y;
    vec2 s = sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0);
    return (uv - 0.5) * s + 0.5;
  }
  // when the piece in this cell lets go (progress)
  float relAt(ivec2 c) { return texelFetch(tRel, clamp(c, ivec2(0), ivec2(uGrid) - 1), 0).r; }
  ivec2 cellOf(vec2 uv) { return ivec2(floor(uv * uGrid)); }
`;

// the rel pass writes tRel, so it must not declare it
const COMMON_NOREL = COMMON.replace('tImg2, tRel;', 'tImg2;').split(String.fromCharCode(10)).filter((l) => !l.includes('relAt')).join(String.fromCharCode(10));

// ------------------------------------------------------------- the REL pass ----
// One texel per piece: the progress at which it lets go. Worked out once per resize / setting.
let GW = 1, GH = 1;
let relRT = null;
const relScene = new THREE.Scene();
const relMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
  precision highp float;
  ${COMMON_NOREL}
  ${NOISE2}
  out vec4 outColor;
  void main() {
    vec2 cell = floor(gl_FragCoord.xy);
    vec2 uv = (cell + 0.5) / uGrid;
    vec2 X = vec2(uv.x * uScreen.x / uScreen.y, uv.y);       // in screen heights
    float s = (dot(X, uDir) - uS0) / (uS1 - uS0);              // 0 .. 1 along the sweep
    vec2 side = vec2(-uDir.y, uDir.x);
    float g = s + uLobes * (0.65 * snoise(vec2(dot(X, side) * 2.1, 3.7)) + 0.35 * fbm(X * 1.7 + 5.3));
    float n = 0.5 + 0.5 * (0.75 * fbm(X * uClump) + 0.25 * snoise(X * uClump * 3.7));
    n = mix(clamp(n, 0.0, 1.0), hash12(cell + 11.7), uGrain);
    float thr = g + uBand * n;
    // the first piece goes just after the start, the last at uRelMax (the exact range is read back)
    float start = 0.01;
    float r = uRaw > 0.5 ? thr : start + clamp((thr - uT0) / (uT1 - uT0), 0.0, 1.0) * (uRelMax - start);
    outColor = vec4(r, 0.0, 0.0, 1.0);
  }`,
  depthTest: false, depthWrite: false,
});
relScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), relMat));
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function computeRel() {
  const a = innerWidth / innerHeight, th = CONFIG.angle * Math.PI / 180;
  const d = new THREE.Vector2(Math.cos(th), Math.sin(th));
  const proj = [[0, 0], [a, 0], [0, 1], [a, 1]].map(([x, y]) => x * d.x + y * d.y);
  U.uDir.value.copy(d);
  U.uS0.value = Math.min(...proj);
  U.uS1.value = Math.max(...proj);
  U.uLifeP.value = Math.min(0.6, CONFIG.life / CONFIG.duration);
  U.uRelMax.value = 1 - U.uLifeP.value * CONFIG.tail;
  // the front's exact range, so the sweep starts at once and runs to the end - no still frames
  U.uT0.value = -CONFIG.lobes; U.uT1.value = 1 + CONFIG.lobes + CONFIG.band;
  if (FLOAT_OK) {
    U.uRaw.value = 1;
    renderer.setRenderTarget(relRT);
    renderer.render(relScene, orthoCam);
    const buf = new Float32Array(GW * GH * 4);
    renderer.readRenderTargetPixels(relRT, 0, 0, GW, GH, buf);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < buf.length; i += 4) { if (buf[i] < lo) lo = buf[i]; if (buf[i] > hi) hi = buf[i]; }
    if (isFinite(lo) && hi > lo) { U.uT0.value = lo; U.uT1.value = hi; }
    U.uRaw.value = 0;
  }
  renderer.setRenderTarget(relRT);
  renderer.render(relScene, orthoCam);
  renderer.setRenderTarget(null);
}

// ------------------------------------------------------------- the shadows ----
let shadowRT = null;

// --------------------------------------------------------------- the page ----
const pageScene = new THREE.Scene();
const pageMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U, vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
  precision highp float;
  ${COMMON}
  uniform sampler2D tShadow;
  uniform float uShadow, uSheetShadow, uSheetThick, uEdgeLight;
  in vec2 vUv;
  out vec4 outColor;
  float covered(vec2 uv) { return uP < relAt(cellOf(uv)) ? 1.0 : 0.0; }
  void main() {
    vec3 c1 = texture(tImg1, coverUv(vUv, ${IMG1_ASPECT.toFixed(6)})).rgb;
    vec3 c2 = texture(tImg2, coverUv(vUv, ${IMG2_ASPECT.toFixed(6)})).rgb;
    float cov = covered(vUv);
    // where the light comes from, as a step on the screen per unit of height
    vec2 lstep = uLightDir.xy / -uLightDir.z * vec2(0.5 * uScreen.y / uScreen.x, 0.5);
    vec3 col;
    if (cov > 0.5) {
      // the remaining sheet: its torn edge facing the light catches it
      float open = 1.0 - covered(vUv - lstep * uSheetThick * 0.6);
      col = c1 * (1.0 + uEdgeLight * open);
    } else {
      // image 2 under the sheet's edge: a soft contact shadow
      float sh = 0.0;
      for (int k = 1; k <= 6; k++) sh += covered(vUv - lstep * uSheetThick * (float(k) / 6.0));
      col = c2 * (1.0 - uSheetShadow * sh / 6.0);
    }
    // the flying flakes' shadows
    float fs = texture(tShadow, vUv).r;
    col *= 1.0 - uShadow * (1.0 - exp(-fs));
    outColor = vec4(col, 1.0);
  }`,
  depthTest: false, depthWrite: false,
});
pageScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pageMat));

// -------------------------------------------------------------- the flakes ----
const STEPS = Math.round(num('steps', 8));
// Shared flight: every piece integrates its own path through the flow from the moment it let go.
const FLIGHT = /* glsl */`
  uniform float uWind, uRise, uLift, uCurl, uCurlScale, uDepthSwirl, uSpin, uCamD, uFadeFrom;
  in vec2 aCell;
  // world: the picture is z = 0, y in [-1, 1], x in [-aspect, aspect]
  vec3 homeOf(vec2 uv) { return vec3((uv.x * 2.0 - 1.0) * uScreen.x / uScreen.y, uv.y * 2.0 - 1.0, 0.0); }
  // tau: 0..1 over its life; returns its position
  vec3 fly(vec3 P, float tau, vec3 h) {
    vec3 dir = vec3(uDir, 0.0);
    float speed = 0.75 + 0.5 * h.x;                // pieces differ a little
    float lift = uLift * (0.45 + 1.1 * h.y);         // some rise high, some stay low
    const int N = ${STEPS};
    float dt = tau / float(N);
    for (int i = 0; i < N; i++) {
      float t = (float(i) + 0.5) * dt;
      vec3 f = flow(P * uCurlScale + vec3(0.0, 0.0, 1.7));
      f.z *= uDepthSwirl;
      float ease = smoothstep(0.0, 0.35, t);          // it eases off the picture
      vec3 v = dir * uWind * (0.35 + 1.3 * t) * speed
             + vec3(0.0, uRise, 0.0) * t
             + vec3(0.0, 0.0, lift * (1.2 - t))
             + f * uCurl * (0.3 + 0.7 * ease);
      P += v * dt * ease;
    }
    P.z = abs(P.z);                                    // never behind the picture
    P.z = min(P.z, uCamD * 0.55);
    return P;
  }
`;
const flakeVert = (shadow) => /* glsl */`
  precision highp float;
  ${COMMON}
  ${NOISE2}
  ${NOISE3}
  ${FLIGHT}
  uniform float uDof, uMaxBlur, uFlake, uShade, uGlint, uPenumbra;
  out vec2 vHome; out vec2 vCellPx; out float vSprite, vCore, vMorph, vAlpha, vCos, vPsi, vSq, vBlur, vLight;
  void main() {
    ivec2 c = ivec2(aCell);
    float rel = relAt(c);
    float tau = (uP - rel) / uLifeP;
    float tauEnd = min(1.0, (1.0 - rel) / uLifeP);     // the last pieces get a shorter life
    if (tau <= 0.0 || tau >= tauEnd) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    vec2 uv = (aCell + 0.5) / uGrid;
    vec3 h = hash32(aCell + 3.1);
    vec3 P = fly(homeOf(uv), tau, h);
    float cellPx = uScreen.y * uDpr / uGrid.y;            // device px of one cell
    float morph = smoothstep(0.0, 0.18, tau);              // square of pixels -> flake
    float fade = smoothstep(uFadeFrom * tauEnd, tauEnd, tau);
    vMorph = morph;
    vHome = uv;
    vCellPx = vec2(uScreen.x * uDpr / uGrid.x, cellPx);
    // tumbling
    float phi = h.z * 6.2832 + tau * uSpin * (0.5 + h.x) * 6.2832 * sign(h.y - 0.5);
    vCos = cos(phi);
    vPsi = h.x * 6.2832 + tau * 2.0 * (h.z - 0.5);
    vSq = mix(1.0, max(abs(vCos), 0.22), morph);
    ${shadow ? /* glsl */`
    // its shadow: projected onto the picture along the light; softer and fainter with height
    vec3 S = P + uLightDir * (P.z / -uLightDir.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(S.xy, 0.0, 1.0);
    float pen = P.z * uPenumbra * uDpr;
    float core = cellPx * mix(1.0, uFlake, morph) * (1.0 - 0.6 * fade);
    gl_PointSize = core + 2.0 * pen + 2.0;
    vSprite = gl_PointSize; vCore = core; vBlur = pen;
    // a shadow's darkness spreads over its area; it comes in as the piece rises
    vAlpha = smoothstep(0.0, 0.04, P.z) * (1.0 - fade) * (core * core) / ((core + pen) * (core + pen));
    vLight = 0.0;
    ` : /* glsl */`
    vec4 mv = viewMatrix * vec4(P, 1.0);
    gl_Position = projectionMatrix * mv;
    float persp = uCamD / -mv.z;                              // 1 on the picture
    float core = cellPx * mix(1.0, uFlake, morph) * persp * (1.0 - 0.65 * fade);
    float blur = min(uDof * P.z * uDpr, uMaxBlur * uDpr);
    gl_PointSize = core + 2.0 * blur + 2.0;
    vSprite = gl_PointSize; vCore = core; vBlur = blur;
    // its light: turned from the light it darkens; facing it, a glint; a touch brighter nearer the lens
    float facing = abs(vCos);
    float lit = mix(1.0, (1.0 - uShade) + uShade * facing, morph) * (1.0 + 0.08 * P.z);
    vLight = lit;
    vAlpha = (1.0 - fade) * (core * core) / ((core + blur) * (core + blur));
    vAlpha = min(1.0, vAlpha * mix(1.0, 1.15, morph));
    `}
  }`;
const flakeFrag = (shadow) => /* glsl */`
  precision highp float;
  ${COMMON}
  uniform float uGlint;
  in vec2 vHome; in vec2 vCellPx; in float vSprite, vCore, vMorph, vAlpha, vCos, vPsi, vSq, vBlur, vLight;
  out vec4 outColor;
  void main() {
    vec2 q = (gl_PointCoord - 0.5) * vSprite;           // device px from its centre
    q.y = -q.y;
    // the square of pixels it was
    vec2 aq = abs(q) - vCore * 0.5;
    float square = 1.0 - smoothstep(-0.5 - vBlur, 0.5 + vBlur, max(aq.x, aq.y));
    // the flake it becomes: an ellipse that narrows as it turns edge-on
    float cs = cos(vPsi), sn = sin(vPsi);
    vec2 r = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
    r.y /= vSq;
    float R = vCore * 0.56;
    float flake = 1.0 - smoothstep(R - 0.6 - vBlur, R + 0.6 + vBlur, length(r));
    float m = mix(square, flake, vMorph) * vAlpha;
    if (m < 0.002) discard;
    ${shadow ? /* glsl */`
    outColor = vec4(m, 0.0, 0.0, 1.0);
    ` : /* glsl */`
    // its own pixels of image 1 while it is still a square, then its colour
    vec2 off = q / (uScreen * uDpr) * (1.0 - vMorph);
    vec3 col = texture(tImg1, coverUv(vHome + off, ${IMG1_ASPECT.toFixed(6)})).rgb * vLight;
    col += vec3(uGlint) * pow(max(vCos, 0.0), 24.0) * vMorph;
    outColor = vec4(col * m, m);
    `}
  }`;
const flakeMat = (shadow) => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, uniforms: U,
  vertexShader: flakeVert(shadow), fragmentShader: flakeFrag(shadow),
  depthTest: false, depthWrite: false, transparent: true,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: shadow ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
});
const shadowScene = new THREE.Scene();
const flakeScene = new THREE.Scene();
const shadowPoints = new THREE.Points(new THREE.BufferGeometry(), flakeMat(true));
const flakePoints = new THREE.Points(new THREE.BufferGeometry(), flakeMat(false));
shadowPoints.frustumCulled = flakePoints.frustumCulled = false;
shadowScene.add(shadowPoints);
flakeScene.add(flakePoints);
const camera = new THREE.PerspectiveCamera(CONFIG.fov, innerWidth / innerHeight, 0.01, 50);

function setCamera() {
  const D = 1 / Math.tan(CONFIG.fov * Math.PI / 360);   // the picture's height (2) fills the view at z = 0
  camera.fov = CONFIG.fov;
  camera.aspect = innerWidth / innerHeight;
  camera.position.set(0, 0, D);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  U.uCamD.value = D;
}

function build() {
  GW = Math.max(1, Math.ceil(innerWidth / CONFIG.cell));
  GH = Math.max(1, Math.ceil(innerHeight / CONFIG.cell));
  U.uGrid.value.set(GW, GH);
  if (relRT) relRT.dispose();
  relRT = new THREE.WebGLRenderTarget(GW, GH, {
    type: RT_TYPE, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
  U.tRel.value = relRT.texture;
  const n = GW * GH;
  const cells = new Float32Array(n * 2);
  for (let y = 0, i = 0; y < GH; y++) for (let x = 0; x < GW; x++, i++) { cells[i * 2] = x; cells[i * 2 + 1] = y; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aCell', new THREE.BufferAttribute(cells, 2));
  for (const o of [shadowPoints, flakePoints]) { o.geometry.dispose(); o.geometry = g; }
  computeRel();
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  U.uScreen.value.set(innerWidth, innerHeight);
  U.uDpr.value = renderer.getPixelRatio();
  if (shadowRT) shadowRT.dispose();
  shadowRT = new THREE.WebGLRenderTarget(Math.ceil(innerWidth / 2), Math.ceil(innerHeight / 2), {
    type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  U.tShadow.value = shadowRT.texture;
  setCamera();
  build();
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

const black = new THREE.Color(0, 0, 0);
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const left = dir > 0 ? 1 - p : p;
  const k = Math.min(1, left / 0.2);
  const target = dir === 0 ? 0 : dir / CONFIG.duration * (0.3 + 0.7 * k * k * (3 - 2 * k));
  vel += (target - vel) * (1 - Math.exp(-dt / Math.max(0.02, CONFIG.accel / 3)));
  p += vel * dt;
  if (p >= 1) { p = 1; vel = 0; dir = 0; }
  if (p <= 0) { p = 0; vel = 0; if (dir < 0) { dir = 0; if (hint) hint.classList.remove('off'); } }
  U.uP.value = p;
  const flying = p > 0 && p < 1;
  // 1. the flakes' shadows
  renderer.setRenderTarget(shadowRT);
  renderer.setClearColor(black, 0);
  renderer.clear(true, false, false);
  if (flying) renderer.render(shadowScene, camera);
  // 2. the page, 3. the flakes over it
  renderer.setRenderTarget(null);
  renderer.render(pageScene, orthoCam);
  if (flying) renderer.render(flakeScene, camera);
});

// ---------------------------------------------------------------- the panel ----
// ?ui=0 removes it. Bars marked * re-time when each piece lets go (instant).
const uiEl = document.getElementById('pui');
if (uiEl && PARAMS.get('ui') === '0') uiEl.remove();
else if (uiEl) {
  const live = (k, uni) => (v) => { CONFIG[k] = v; U[uni].value = v; };
  const recompute = (k, uni) => (v) => { CONFIG[k] = v; if (uni) U[uni].value = v; computeRel(); };
  const ROWS = [
    ['the sweep'],
    ['duration', 'duration (s) *', 1, 10, 0.1, recompute('duration')],
    ['accel', 'inertia (s)', 0, 1.5, 0.05, (v) => { CONFIG.accel = v; }],
    ['angle', 'direction *', -180, 180, 1, recompute('angle')],
    ['band', 'breaking band *', 0.02, 0.9, 0.01, recompute('band', 'uBand')],
    ['lobes', 'front curve *', 0, 0.4, 0.005, recompute('lobes', 'uLobes')],
    ['clumpScale', 'clump size *', 0.5, 14, 0.1, recompute('clumpScale', 'uClump')],
    ['grain', 'single pieces *', 0, 1, 0.01, recompute('grain', 'uGrain')],
    ['cell', 'piece size (px)', 1.5, 8, 0.25, (v) => { CONFIG.cell = v; build(); }],
    ['the flight'],
    ['life', 'life (s) *', 0.3, 3, 0.05, recompute('life')],
    ['wind', 'wind', 0, 3, 0.01, live('wind', 'uWind')],
    ['rise', 'rise', -1, 1.5, 0.01, live('rise', 'uRise')],
    ['lift', 'lift toward you', 0, 2.5, 0.01, live('lift', 'uLift')],
    ['curl', 'swirl', 0, 2, 0.01, live('curl', 'uCurl')],
    ['curlScale', 'swirl fineness', 0.2, 5, 0.05, live('curlScale', 'uCurlScale')],
    ['depthSwirl', 'swirl in depth', 0, 3, 0.05, live('depthSwirl', 'uDepthSwirl')],
    ['spin', 'tumble', 0, 4, 0.05, live('spin', 'uSpin')],
    ['the look'],
    ['fov', 'perspective (fov)', 15, 80, 1, (v) => { CONFIG.fov = v; setCamera(); }],
    ['dof', 'depth of field', 0, 80, 1, live('dof', 'uDof')],
    ['maxBlur', 'max blur (px)', 0, 40, 1, live('maxBlur', 'uMaxBlur')],
    ['flake', 'flake size', 0.5, 3, 0.05, live('flake', 'uFlake')],
    ['shade', 'flake shading', 0, 1, 0.01, live('shade', 'uShade')],
    ['glint', 'glint', 0, 1.5, 0.01, live('glint', 'uGlint')],
    ['fadeFrom', 'fade from (life)', 0, 0.95, 0.01, live('fadeFrom', 'uFadeFrom')],
    ['tail', 'end tail (life) *', 0.1, 1, 0.01, recompute('tail')],
    ['shadows'],
    ['shadow', 'flake shadows', 0, 1, 0.01, live('shadow', 'uShadow')],
    ['penumbra', 'shadow softness', 0, 80, 1, live('penumbra', 'uPenumbra')],
    ['sheetShadow', 'sheet shadow', 0, 1, 0.01, live('sheetShadow', 'uSheetShadow')],
    ['sheetThickness', 'sheet height', 0, 0.06, 0.001, live('sheetThickness', 'uSheetThick')],
    ['edgeLight', 'lit edge', 0, 0.6, 0.01, live('edgeLight', 'uEdgeLight')],
  ];
  uiEl.innerHTML = '<div class="btns"><button type="button" id="pPlay">play ▶</button>'
    + '<button type="button" id="pBack">◀ back</button></div>'
    + ROWS.map((r, i) => r.length === 1 ? '<h2>' + r[0] + '</h2>'
      : '<div class="row"><div class="lbl"><span class="name">' + r[1] + '</span><span class="val" id="pv' + i + '">'
        + CONFIG[r[0]] + '</span></div><input type="range" id="pr' + i + '" min="' + r[2] + '" max="' + r[3]
        + '" step="' + r[4] + '" value="' + CONFIG[r[0]] + '"></div>').join('')
    + '<div class="foot">* re-times the pieces (instant) &middot; ?ui=0 removes this panel</div>';
  ROWS.forEach((r, i) => {
    if (r.length === 1) return;
    const el = document.getElementById('pr' + i);
    el.addEventListener('input', () => { r[5](parseFloat(el.value)); document.getElementById('pv' + i).textContent = el.value; });
  });
  document.getElementById('pPlay').addEventListener('click', () => { p = 0; vel = 0; forward(); });
  document.getElementById('pBack').addEventListener('click', backward);
}
if (PARAMS.get('debug') === '1') window.__t17 = { renderer, U, CONFIG, get p() { return p; }, set p(v) { p = v; vel = 0; dir = 0; } };
