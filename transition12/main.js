// TRANSITION 12 — transition (v4)'s sand reveal, with the released grains moving the way
// PTSVer30's particles do: simulated, carried by a swirling field with momentum, drawn as lit
// spheres. See the grains section below. Everything about the sheet is transition v4's.
//
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
  grains: num('grains', pre('grains', 409600)),   // transition12: simulated, so 640 x 640
  speckle: 0.36,            // grain texture on the sheet inside the fold band
  shadow: 0.35,             // image 2 in the folded sheet's shadow just behind the tear
  shadowLength: 0.15,       // how far behind the tear that shadow reaches (sweep units)
  // transition12: the released grains' motion, PTSVer30's field
  fieldFreq: 2.6,           // swirl size: higher = smaller eddies (per screen height)
  fieldGain: 0.22,          // how fast the field carries a grain (screen heights per second)
  fieldSpeed: 0.45,         // how fast the field itself changes
  fieldFine: 0.70,          // weight of the finer octave
  fieldDivergence: 0.75,    // the spreading part of the field (PTSVer30's)
  wind: 0.18,               // steady drift off the sheet (screen heights per second)
  kick: 0.30,               // how hard a grain is thrown as it comes loose
  lift: 0.10,               // and how far up off the page
  settle: 0.06,             // how quickly a grain gives up its own motion for the field's (per frame)
  drag: 0.985,              // and how much of its speed it keeps each frame
  life: 3.2,                // s a loose grain lives before it has faded
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

// ---- grains: ride the sheet, then fly through PTSVer30's field ------------------------------
// transition12. In transition (v4) a released grain followed a scripted path - a straight wind
// drift plus jitter. Here it is SIMULATED the way PTSVer30's motes are: its position and
// velocity are state, kept in float textures and stepped every frame; the velocity settles
// toward a swirling field (divergent curl noise, two octaves, slowly changing - PTSVer30's
// fieldVelocity) plus a light wind, and keeps its own momentum, so the released sand curls,
// braids into filaments and drifts on instead of streaming off in a line. While a grain is
// still on the sheet it rides the sheet exactly as before. Scrolling back puts grains whose
// part of the sheet has re-formed back on it.
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

const SIM = Math.round(Math.sqrt(CONFIG.grains));          // particles = SIM x SIM
const SIM_COMMON = COMMON + GLSL_SNOISE + /* glsl */`
  uniform sampler2D tSeed, tPos, tVel;
  uniform float uTime, uDt;
  uniform float uFieldSpeed, uFieldFreq, uFieldGain, uFine, uDivergence;
  uniform float uWind, uKick, uSettle, uDrag, uLift;
  varying vec2 vUv;
  vec3 fieldVelocity(vec3 p) {
    float t = uTime * uFieldSpeed;
    vec3 v  = curlNoise(p, uFieldFreq,       t,       1.0,   uDivergence);
    v      += curlNoise(p, uFieldFreq * 3.1, t * 1.7, uFine, uDivergence);
    return v * (uFieldGain * uFieldFreq);
  }
  vec2 windDir() {
    vec2 perp = vec2(-uDir.y, uDir.x);
    return normalize(-uDir + perp * 0.25);
  }
  // where this grain lives on the sheet, and whether the sheet has let it go
  vec2 homeOf(vec4 seed) { return (seed.xy - 0.5) * 2.0 * uExt * 1.04; }
  bool releasedAt(vec2 p, float r, out float t) {
    t = localT(p);
    return t > uFoldW + (r - 0.5) * 0.05;
  }
`;
const SIM_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const simVelMat = new THREE.ShaderMaterial({
  uniforms: U, vertexShader: SIM_VERT, depthTest: false, depthWrite: false,
  fragmentShader: SIM_COMMON + /* glsl */`
    void main() {
      vec4 seed = texture2D(tSeed, vUv);
      vec4 pos = texture2D(tPos, vUv);
      vec3 v = texture2D(tVel, vUv).xyz;
      vec2 p0 = homeOf(seed);
      float t;
      if (!releasedAt(p0, seed.z, t)) { gl_FragColor = vec4(0.0); return; }
      if (pos.w < 0.0) {
        // the moment it comes loose: thrown off with the wind, a little up off the page, and a
        // little of its own
        vec2 jit = vec2(fract(seed.w * 37.1) - 0.5, fract(seed.w * 71.3) - 0.5);
        v = vec3(windDir() * uKick + jit * uKick * 0.8, uLift * (0.5 + seed.z));
      } else {
        // PTSVer30: the velocity settles toward the field (plus the wind) and keeps the rest of
        // what it had, so it carries momentum through the swirl instead of snapping to it
        vec3 target = fieldVelocity(pos.xyz) + vec3(windDir() * uWind, 0.0);
        v += (target - v) * clamp(uSettle * uDt * 60.0, 0.0, 1.0);
        v *= pow(uDrag, uDt * 60.0);
      }
      gl_FragColor = vec4(v, 1.0);
    }`,
});
const simPosMat = new THREE.ShaderMaterial({
  uniforms: U, vertexShader: SIM_VERT, depthTest: false, depthWrite: false,
  fragmentShader: SIM_COMMON + /* glsl */`
    void main() {
      vec4 seed = texture2D(tSeed, vUv);
      vec4 pos = texture2D(tPos, vUv);
      vec3 v = texture2D(tVel, vUv).xyz;
      vec2 p0 = homeOf(seed);
      float t;
      if (!releasedAt(p0, seed.z, t)) {
        // on the sheet: exactly where the sheet holds it; age -1 means "not loose"
        float h;
        gl_FragColor = vec4(t > 0.0 ? sheetPos(p0, t, h) : vec3(p0, 0.0), -1.0);
        return;
      }
      if (pos.w < 0.0) {
        float h;
        gl_FragColor = vec4(sheetPos(p0, t, h), 0.0);       // comes loose from the sheet
        return;
      }
      gl_FragColor = vec4(pos.xyz + v * uDt, pos.w + uDt);
    }`,
});

const canFloat = !!renderer.extensions.get('EXT_color_buffer_float');
const simType = canFloat ? THREE.FloatType : THREE.HalfFloatType;
const simRT = () => new THREE.WebGLRenderTarget(SIM, SIM, {
  type: simType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
});
let posA = simRT(), posB = simRT(), velA = simRT(), velB = simRT();
{
  const seed = new Float32Array(SIM * SIM * 4);
  for (let i = 0; i < SIM * SIM; i++) {
    seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random();
    seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = Math.random();
  }
  const tex = new THREE.DataTexture(seed, SIM, SIM, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  U.tSeed = { value: tex };
}
Object.assign(U, {
  tPos: { value: null }, tVel: { value: null }, uTime: { value: 0 }, uDt: { value: 1 / 60 },
  uFieldSpeed: { value: CONFIG.fieldSpeed }, uFieldFreq: { value: CONFIG.fieldFreq },
  uFieldGain: { value: CONFIG.fieldGain }, uFine: { value: CONFIG.fieldFine },
  uDivergence: { value: CONFIG.fieldDivergence }, uWind: { value: CONFIG.wind },
  uKick: { value: CONFIG.kick }, uSettle: { value: CONFIG.settle }, uDrag: { value: CONFIG.drag },
  uLift: { value: CONFIG.lift }, uLife: { value: CONFIG.life },
});
const simScene = new THREE.Scene();
const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simVelMat);
simScene.add(simQuad);
const simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
function stepSim(dt) {
  U.uDt.value = dt;
  U.tPos.value = posA.texture; U.tVel.value = velA.texture;
  simQuad.material = simVelMat;
  renderer.setRenderTarget(velB); renderer.render(simScene, simCam);
  U.tVel.value = velB.texture;
  simQuad.material = simPosMat;
  renderer.setRenderTarget(posB); renderer.render(simScene, simCam);
  renderer.setRenderTarget(null);
  [posA, posB] = [posB, posA];
  [velA, velB] = [velB, velA];
  U.tPos.value = posA.texture;
}

// the grains drawn as PTSVer30's are: tiny lit spheres
const grainMat = new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  vertexShader: COMMON + /* glsl */`
    uniform sampler2D tSeed, tPos;
    uniform float uSize, uDpr, uCamDist, uLife;
    attribute vec2 aRef;
    varying vec3 vCol; varying float vAlpha;
    void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
    void main() {
      vec4 seed = texture2D(tSeed, aRef);
      vec4 st = texture2D(tPos, aRef);
      vec2 p0 = (seed.xy - 0.5) * 2.0 * uExt * 1.04;
      float t = localT(p0);
      if (t <= 0.0) { hide(); return; }      // untouched: the flat picture needs no grains
      float r = seed.z;
      vec3 pos = st.xyz;
      float age = st.w;
      // riding the sheet they fade in with the sand texture; loose, they fade over their life
      float a = smoothstep(0.0, uFoldW * 0.5, t);
      vec3 base = img1At(p0) * (0.9 + 0.2 * fract(r * 13.1));
      float sh = 1.0;
      if (age < 0.0) {
        float h, n0;
        h = heightAt(p0, n0);
        sh = relShade(sheetNormal(p0, h));
      } else {
        float life = uLife * (0.6 + 0.8 * fract(seed.w * 5.3));
        a *= 1.0 - smoothstep(life * 0.45, life, age);
      }
      if (a <= 0.001) { hide(); return; }
      vCol = base * sh;
      vAlpha = a;
      vec4 mv = modelViewMatrix * vec4(pos + vec3(0.0, 0.0, 0.0015), 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = uSize * uDpr * (0.7 + 0.6 * fract(r * 7.3)) * (uCamDist / -mv.z);
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vCol; varying float vAlpha;
    void main() {
      // a lit sphere, light from the upper left - PTSVer30's grain
      vec2 d = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(d, d);
      if (r2 > 1.0) discard;
      vec3 n = vec3(d.x, -d.y, sqrt(1.0 - r2));
      float lit = 0.62 + 0.5 * max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
      float a = vAlpha * smoothstep(1.0, 0.7, r2);
      gl_FragColor = vec4(vCol * lit * a, a);
    }`,
});
{
  const n = SIM * SIM;
  const ref = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    ref[i * 2] = ((i % SIM) + 0.5) / SIM;
    ref[i * 2 + 1] = (Math.floor(i / SIM) + 0.5) / SIM;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aRef', new THREE.BufferAttribute(ref, 2));
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
  // the grains' simulation: every frame, on the wall clock (capped so a stalled frame cannot
  // throw them), whether or not the sweep is moving - loose sand keeps drifting
  U.uTime.value += dt;
  stepSim(Math.min(dt, 1 / 30));
  syncSim();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- the panel ----
// transition12: the grains' motion. ?ui=0 removes it.
function syncSim() {
  U.uFieldFreq.value = CONFIG.fieldFreq; U.uFieldGain.value = CONFIG.fieldGain;
  U.uFieldSpeed.value = CONFIG.fieldSpeed; U.uFine.value = CONFIG.fieldFine;
  U.uWind.value = CONFIG.wind; U.uKick.value = CONFIG.kick; U.uLift.value = CONFIG.lift;
  U.uSettle.value = CONFIG.settle; U.uDrag.value = CONFIG.drag; U.uLife.value = CONFIG.life;
  U.uSize.value = CONFIG.grainSize;
}
const uiEl = document.getElementById('pui');
if (uiEl && PARAMS.get('ui') === '0') uiEl.remove();
else if (uiEl) {
  const rows = [
    ['fieldGain', 'swirl strength', 0, 1, 0.01], ['fieldFreq', 'swirl size (fine)', 0.5, 8, 0.1],
    ['fieldSpeed', 'swirl change', 0, 2, 0.01], ['wind', 'wind', 0, 1, 0.01],
    ['kick', 'throw', 0, 1.5, 0.01], ['lift', 'lift', 0, 0.5, 0.01],
    ['settle', 'follow the swirl', 0.005, 0.3, 0.005], ['drag', 'keep speed', 0.9, 1, 0.001],
    ['life', 'life (s)', 0.5, 8, 0.1], ['grainSize', 'grain size', 0.5, 4, 0.05],
    ['duration', 'sweep time (s)', 2, 14, 0.5],
  ];
  uiEl.innerHTML = '<div class="btns"><button type="button" id="pPlay">play ▶</button>'
    + '<button type="button" id="pBack">◀ back</button></div><h2>the sand motion</h2>'
    + rows.map(([k, name, mn, mx, st], i) => '<div class="row"><div class="lbl"><span class="name">' + name
      + '</span><span class="val" id="pv' + i + '">' + CONFIG[k] + '</span></div><input type="range" id="pr' + i
      + '" min="' + mn + '" max="' + mx + '" step="' + st + '" value="' + CONFIG[k] + '"></div>').join('')
    + '<div class="foot">?ui=0 removes this panel</div>';
  rows.forEach(([k], i) => {
    const el = document.getElementById('pr' + i);
    el.addEventListener('input', () => { CONFIG[k] = parseFloat(el.value); document.getElementById('pv' + i).textContent = el.value; });
  });
  document.getElementById('pPlay').addEventListener('click', () => { p = 0; forward(); });
  document.getElementById('pBack').addEventListener('click', backward);
  for (const ev of ['wheel', 'touchstart']) uiEl.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
}
// ?debug=1: expose the simulation for headless checks
if (PARAMS.get('debug') === '1') window.__t12 = { renderer, get pos() { return posA; }, SIM };
