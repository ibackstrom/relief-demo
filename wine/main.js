// immersive-g.com home bas-relief reveal — 1:1 ver1.
// Every shader and constant below is ported verbatim from the production bundle
// (see ../REPLICATION-SPEC.md and ../reference/shaders_extracted.txt).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- config (site values)
// The reveal brush is stamped in SCREEN space, so by default zooming in magnifies
// the wall under a brush that stays the same size on screen — the revealed patch
// shrinks against the plate as you zoom. With this on, the screen-space radius is
// scaled by camera.zoom, which is exactly the magnification, so the brush covers a
// constant patch OF THE WALL at any zoom. Set false for the site's own behaviour.
const BRUSH_TRACKS_ZOOM = true;

const CONFIG = {
  flowmap: { mouseEase: 0.4, dissipation: 0.953, falloff: 0.38, alpha: 1 },
  extrude: { textureStrength: 1, gradientStrength: 0.17 },
  camera:  { fov: 30, distance: 15, fastModeZoom: 0.6, slowModeZoom: 1, near: 5, far: 20 },
};
const ROW_SPACING = 9.995;          // Ei
const FOV_FIT = 1.33;               // $o  → worldHeight = 1.33 * (Ei - .1) / aspect
const BRIGHTNESS_FACTOR = 0.6;      // desktop (mobile: .5)
const BRIGHTNESS_OFFSET = 0.4;      // desktop (mobile: .6)
// scroll → zoom (decomposed from aurora-botanique.com):
// fixed full-screen visual; scroll progress smoothed by a spring
// (stiffness 80, damping 22, mass .7) drives scale 1 → 1.35 from screen center.
const ZOOM = {
  max: 1.6,                                     // scroll-in target (was 2.4)
  screens: 6,                                   // scroll distance for full zoom, in viewport heights (aurora: ~17)
  spring: { stiffness: 80, damping: 22, mass: 0.7 },
};

// how far the relief physically pops out of the wall at full reveal, as a
// fraction of the model's baked depth. 1 = the geometry's own depth (what the
// bakes were lit at), 0.5 = half. Applied to the vertex displacement AND to the
// normal squash that shades it, so lighting follows the flattened shape.
const DISPLACEMENT = 0.5;

// FAST-SCROLL MODE — the site's second reveal, the one that isn't the cursor.
// Scroll quickly on immersive-g.com and the wall stops following the pointer and
// starts extruding from an animated noise field instead: relief surfaces in
// organic patches all over the screen at once, drifting as you keep scrolling,
// and the whole image grades brighter and flatter while it lasts.
//
// The mechanism was already ported verbatim and has been sitting dormant in the
// shaders since the first commit — getFastScrollNoise (two counter-drifting noise
// fetches dotted against a rotating color triple, per SCROLL_EXTRUDE_*), the
// `mix(extrude, fastScrollExtrude, uFastScroll)` in both stages, and the
// ContrastSaturationBrightness(2, 1, .08) + .3 grade in the fragment. Nothing
// ever drove uFastScroll, so it stayed 0. This block is that driver.
//
// One thing cannot be 1:1: on the site scrolling TRAVELS the wall, and the noise
// field is anchored to the wall through uScreenScroll (scene.position.y scaled by
// fastModeZoom). Here scrolling zooms instead — the wall never moves — so
// uScreenScroll is fed from accumulated scroll distance directly. Same drift, same
// direction, driven by the same input.
// AMBIENT REVEAL — relief surfacing on its own, away from the cursor.
//
// This rides the flow-map's SECOND stamp, which has been in the shader from the
// start and which nothing drove (the spec notes it as "unused on home"). It is not
// a copy of the cursor stamp: `stamp2.rg *= 0.0` throws away the flow velocity and
// keeps only the extrude channels, at 3x weight, modulated by the slower of the two
// noise fields. In other words it is a "reveal a blob HERE" stamp with no direction
// and no pointer attached — exactly what an ambient reveal needs, which is why it
// exists. Blobs then live and melt on the flow-map's own dissipation, so they decay
// identically to cursor reveals; nothing here touches the wall shader.
// Values below are read straight out of the live bundle's `triggerRandomMouseMovement`
// / `loopRandomMouseMovement` (assets/default.*.js), not invented here. The shape of it:
//   velocity2 is pinned to (1,1) — |v|*50 saturates `magnitude`, so every stamp is
//   full strength — and mouse2 is TWEENED across the screen in 1-3 segments, each
//   0.7-1.0s, between points on a circle of radius .7-.9 in [-1,1] space (so it
//   works the outer part of the frame, not the middle). Each axis is tweened
//   separately with GSAP's rough() ease, which is what makes it quiver instead of
//   gliding. Then mouse2 parks at (-1,-1) — far outside the falloff, so it stops
//   stamping without needing to touch velocity2 — and after 1-3s it goes again.
const AMBIENT = {
  enabled: true,
  pause: [6, 14],             // seconds of stillness between passes (site: lerp(1,3) —
                              //   that ran a pass roughly half the time, which read as
                              //   constant activity; this makes it an occasional event)
  segments: [1, 3],           // site: floor(random*3)+1
  durMid: [0.8, 1.0],         // site: lerp(.8,1) for a segment that is followed by more
  durLast: [0.7, 0.8],        // site: lerp(.7,.8) for the closing segment
  radius: [0.7, 0.9],         // site: lerp(.7,.9), in [-1,1] space → uv = v/2 + .5
  // The site's own roughness is 3 / 2 with 12 sample points per second, which reads
  // as a hard jitter. Toned down here on request: smaller deviations, fewer of them,
  // and the jittered curve is mixed back toward the clean travel so what is left is
  // a drift rather than a shake. Set roughBlend to 1 with 3 / 2 / 12 to get the
  // site's exact nervousness back.
  roughMid: 1.0,              // site: 3   (rough strength, mid-pass segments)
  roughLast: 0.7,             // site: 2   (closing segment)
  roughPoints: 5,             // site: 12  (sample points per second of travel)
  roughBlend: 0.35,           // 0 = perfectly smooth travel, 1 = the full rough curve
  chroma: true,               // let the pass take the red mask too (false = reveal only)
};

// index.html?fast pins fast-scroll mode on; ?amb runs the ambient reveal back to back
// with no pause and reports each pass in the tab title, so it can be judged without
// waiting out a 6-14s gap
const FORCE_FAST = new URLSearchParams(location.search).has('fast');
const FORCE_AMBIENT = new URLSearchParams(location.search).has('amb');
const FAST = {
  enabled: true,
  // Speeds are px of scroll per 60fps frame. These have to sit ABOVE ordinary
  // scrolling or the mode fires constantly: one wheel notch is ~100-120px, and a
  // normal continuous scroll runs 100-400px per frame. Only a deliberate flick
  // clears 700. (First pass used 8/45 — every touch of the wheel slammed it to
  // full, which is what made the view lurch.)
  onSpeed: 250,      // where the noise reveal starts appearing
  fullSpeed: 700,    // ... and where it fully replaces the cursor reveal
  attack: 0.14,      // rise rate per frame (fast: it should feel immediate)
  release: 0.035,    // fall rate per frame (slow: the site eases back out, not a cut)
  zoom: 0.6,         // site's camera.fastModeZoom (1 = no pull-back). slowModeZoom = 1
  drift: 0.6,        // how far the noise field travels per screen of scroll
};

// metallic layer, ported 1:1 from week.wild.plus/athens-26: a cursor-following
// point light Blinn-Phongs the baked normals; the metal zone darkens to ambient
// and base-tinted highlights sweep with the cursor. Values = their defaults.
// chromatic sheen (the original site's yellow/red iridescent hues along revealed
// relief edges where the cursor has passed). The shading is the site's verbatim
// applyFluidEffect (hueShift -0.52 → yellow/orange on flats, red on slopes); we
// feed it a slow-fading cursor trail instead of their full Navier-Stokes fluid sim.
// The site derives this color per-facet from the surface normal (their hueShift
// -0.52 → a yellow that tips through orange into red). That was ported here and
// rejected in review: red sits at the hue wheel's wrap point, so the same swing
// that keeps yellow inside "yellow-ish" throws red out into magenta on the steep
// ribbon strands and yellow on the shallow ones. This is a flat CHROMA.color
// instead — one red, no hue variation.
const CHROMA = {
  enabled: true,         // ← master switch for the chromatic layer
  color: 0xff3300,       // the mask color (fixed red)
  saturation: 0.6,       // pulls that color toward its own gray. 1 = the raw hex,
                         //   0 = no color at all. Luminance-preserving, so lowering it
                         //   softens the red without making it darker or lighter.
  ground: 0.25,          // how much the flat ground takes the color (0 = relief only)
  falloff: 0.55,         // trail width (screen fraction ×0.5)
  dissipation: 0.975,    // trail lifetime (a touch longer than the reveal)
  boost: 8,              // HDR accumulation cap — drives the site's fluid.b * 0.15 range
};

const METAL = {
  enabled: false,        // ← master switch for the whole metallic layer
  strength: 0.85,        // wild: metallic
  lightIntensity: 0.4,   // wild: lightIntensity
  lightRadius: 1.5,      // wild: lightRadius (aspect-corrected screen units)
  ambient: 0.25,         // wild: ambientLight .06 + cursorAmbient .19
  lightColor: 0xffffff,  // wild: lightColor
};

// CHROMA.color desaturated toward its own luminance (Rec.709 weights, in the linear
// working space three converts the hex into) — so only the colorfulness changes and
// the mask keeps the same weight against the plaster.
const chromaColor = () => {
  const c = new THREE.Color(CHROMA.color);
  const lum = c.r * 0.2125 + c.g * 0.7154 + c.b * 0.0721;
  return c.lerp(new THREE.Color(lum, lum, lum), 1 - CHROMA.saturation);
};

const ASSETS = './assets/';
// meta.json is fetched uncached and its bake timestamp versions every asset URL,
// so a rebake busts the browser cache on its own — no hard reload needed
const BAKE_VERSION = Date.now();

// DEFAULT = the user's model (ver1/bakes/* produced by scripts/bake_levels.py).
// Open ver1/index.html?site to see the original immersive-g wall for comparison.
const USE_CUSTOM = true; // packaged build: custom model only
const CUSTOM = {
  model: './bakes/model.glb',   // welded copy written by scripts/bake_levels.py — NOT output.gltf
  bake1: './bakes/bake1.webp',
  bake2: './bakes/bake2.webp',
  meta: './bakes/meta.json',    // depthMult etc. — written by the bake, no manual sync
  depthMult: 6.25,              // fallback if meta.json is missing
};

// ---------------------------------------------------------------- shared GLSL chunks
const GLSL_FAST_SCROLL_NOISE = /* glsl */`
float circularIn(float t){ return 1.0 - sqrt(1.0 - t * t); }
vec2 getFastScrollNoise(float time, vec2 screenUv, sampler2D noiseTexture, vec4 params){
  float speed = params.x; float noiseSize = params.y; vec2 mask = params.zw;
  float t = time * speed;
  vec2 uvFastScrollNoise  = screenUv / noiseSize + t * 0.007;
  vec2 uvFastScrollNoise2 = screenUv / noiseSize - t * 0.007;
  vec3 fastScrollNoise  = texture2D(noiseTexture, uvFastScrollNoise).rgb;
  vec3 fastScrollNoise2 = texture2D(noiseTexture, uvFastScrollNoise2).rgb;
  fastScrollNoise = (fastScrollNoise + fastScrollNoise2) / 2.;
  vec3 colorDot = vec3(sin(vec3(t, t + 1.047, t + 2.094)));
  float colorAvg = (abs(colorDot.r) + abs(colorDot.g) + abs(colorDot.b)) / 3.;
  colorDot /= colorAvg;
  vec3 colorDot2 = vec3(sin(vec3(t + 1.047, t + 2.094, t)));
  float colorAvg2 = (abs(colorDot2.r) + abs(colorDot2.g) + abs(colorDot2.b)) / 3.;
  colorDot2 /= colorAvg2;
  float fastScrollExtrude  = smoothstep(mask.x, mask.y, dot(normalize(fastScrollNoise - 0.5), colorDot));
  float fastScrollExtrude2 = smoothstep(mask.x, mask.y, dot(normalize(fastScrollNoise - 0.5), colorDot2));
  return vec2(circularIn(fastScrollExtrude), circularIn(fastScrollExtrude2));
}`;

// defines from home config: scrollExtrude { noiseSize 7.77, speed 2, mask [-1,1], strength 1.02 }
const GLSL_SCROLL_EXTRUDE_DEFINES = /* glsl */`
#define SCROLL_EXTRUDE_SPEED 2.0
#define SCROLL_EXTRUDE_NOISE_SIZE 7.77
#define SCROLL_EXTRUDE_MASK vec2(-1.0, 1.0)
#define SCROLL_EXTRUDE_STRENGTH 1.02
`;

// ---------------------------------------------------------------- flow-map pass (the mask)
const FLOWMAP_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tMap;
uniform float uFalloff;
uniform float uAlpha;
uniform float uDissipation;
uniform float uDeltaMult;
uniform float uOffset;
uniform float uAspect;
uniform vec2 uMouse;
uniform vec2 uVelocity;
uniform vec2 uMouse2;
uniform vec2 uVelocity2;
uniform float uClampMax;
uniform sampler2D tNoise;
uniform float uTime;
varying vec2 vUv;
vec4 getStamp(vec2 velocity, vec2 mouse){
  vec2 cursor = vUv - mouse;
  cursor.x *= uAspect;
  velocity *= 50.0;
  float magnitude = 1.0 - pow(1.0 - min(1.0, length(velocity)), 2.0);
  vec4 stamp = vec4(velocity, magnitude, 1.0);
  float falloff = smoothstep(uFalloff, 0.0, length(cursor)) * uAlpha;
  return stamp * falloff;
}
void main(){
  vec2 uv = vUv;
  uv.y += uOffset;
  vec4 data = texture2D(tMap, uv);
  float friction = (1.0 / uDissipation) - 1.0;
  float dissipation = 1.0 / (1.0 + (uDeltaMult * friction));
  data *= dissipation;
  float noise  = 0.00 + 1.00 * smoothstep(0.4, 1.0, texture2D(tNoise, (vUv * vec2(uAspect, 1.0)) * 0.35 + vec2(0.01, 0.01) * uTime).g);
  float noise2 = 0.15 + 0.85 * smoothstep(0.4, 1.0, texture2D(tNoise, (vUv * vec2(uAspect, 1.0)) * 0.8  + vec2(0.01, 0.01) * uTime).g);
  vec4 stamp = getStamp(uVelocity, uMouse);
  data += stamp * noise2 * uDeltaMult;
  vec4 stamp2 = getStamp(uVelocity2, uMouse2) * 3.;
  stamp2.a = stamp2.b;
  stamp2.rg *= 0.0;
  data += stamp2 * noise * uDeltaMult;
  data = min(data, vec4(uClampMax));
  data.rgb = max(data.rgb, vec3(-1));
  gl_FragColor = data;
}`;

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`;

class Flowmap {
  constructor(renderer, { size = 256, falloff = 0.5, alpha = 0.3, dissipation = 0.98, clampMax = 1, tNoise, uTime }) {
    this.renderer = renderer;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.uniform = { value: null };
    const opts = {
      type: /(iPad|iPhone|iPod)/g.test(navigator.userAgent) ? THREE.FloatType : THREE.HalfFloatType,
      depthBuffer: false,
    };
    this.read = new THREE.WebGLRenderTarget(size, size, opts);
    this.write = new THREE.WebGLRenderTarget(size, size, opts);
    this.swap();
    this.aspect = 1;
    this.mouse = new THREE.Vector2();
    this.velocity = new THREE.Vector2();
    this.mouse2 = new THREE.Vector2();
    this.velocity2 = new THREE.Vector2();
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FLOWMAP_FRAG,
      uniforms: {
        tMap: this.uniform,
        uFalloff: { value: falloff * 0.5 },
        uAlpha: { value: alpha },
        uDissipation: { value: dissipation },
        uClampMax: { value: clampMax },
        uDeltaMult: { value: 1 },
        tNoise,
        uTime,
        uAspect: { value: 1 },
        uMouse: { value: this.mouse },
        uVelocity: { value: this.velocity },
        uMouse2: { value: this.mouse2 },
        uVelocity2: { value: this.velocity2 },
        uOffset: { value: 0 },
      },
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }
  swap() {
    const t = this.read; this.read = this.write; this.write = t;
    this.uniform.value = this.read.texture;
  }
  setDeltaMult(v) { this.material.uniforms.uDeltaMult.value = v; }
  update(offset = 0) {
    this.material.uniforms.uAspect.value = this.aspect;
    this.material.uniforms.uOffset.value = offset;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.write);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    this.swap();
  }
}

// ---------------------------------------------------------------- wall material (verbatim port)
const WALL_VERT = GLSL_SCROLL_EXTRUDE_DEFINES + GLSL_FAST_SCROLL_NOISE + /* glsl */`
uniform sampler2D tFlow;
uniform sampler2D tMaskNoise;
uniform float uTime;
uniform float uScreenScroll;
uniform float uScrollSpeed;
uniform float uFastScroll;
uniform float uOpacity;
uniform float uDisplacement;     // global scale on how far the relief pops out
varying vec2 vUv;
varying vec3 vPos;
varying vec3 vEye;
void main(){
  vUv = uv;
  vPos = position;
  vec4 pos = vec4(position, 1.0);
  vec4 ndc = projectionMatrix * modelViewMatrix * pos;
  vec2 uvScreen = (ndc.xy / ndc.w + 1.0) / 2.0;
  vec4 flow = texture2D(tFlow, uvScreen);
  float extrude = mix(flow.b, flow.a, 0.5);
  vec2 fastScrollNoise = getFastScrollNoise(uTime, uvScreen + vec2(0., -uScreenScroll), tMaskNoise,
    vec4(SCROLL_EXTRUDE_SPEED, SCROLL_EXTRUDE_NOISE_SIZE, SCROLL_EXTRUDE_MASK));
  float fastScrollExtrude = fastScrollNoise.r * SCROLL_EXTRUDE_STRENGTH;
  extrude = mix(extrude, fastScrollExtrude, uFastScroll) * uOpacity;
  pos.z *= mix(0.05, 1.0, extrude) * uDisplacement;
  pos.xy *= 1.004;
  vec4 mPos = modelMatrix * pos;
  vec4 mvPos = viewMatrix * mPos;
  vEye = (modelMatrix * vec4(position, 1.)).xyz - cameraPosition;
  gl_Position = projectionMatrix * mvPos;
}`;

const WALL_FRAG = GLSL_SCROLL_EXTRUDE_DEFINES + /* glsl */`
#define CHROMATIC_FRESNEL_SHARPNESS 35.0
#define CHROMATIC_FRESNEL_OPACITY 0.98
#define CHROMATIC_SHADOW_RANGE vec2(0.2, 0.42)
#define CHROMATIC_SHADOW_OPACITY 0.25
uniform float uTime;
uniform vec2 uResolution;
uniform sampler2D tMaskNoise;
uniform sampler2D tFlow;
uniform sampler2D tBake1;
uniform sampler2D tBake2;
uniform sampler2D tPlaster;
uniform vec2 uPlasterScale;
uniform sampler2D tNormalMap;    // camera-space normals + height mask (bake)
uniform vec2 uNormalMapTexel;    // 1/width, 1/height of the bake passes
uniform float uNormalBlurRadius; // bake blur radius in texels, 0 = off
uniform float uWallUvOffset;     // texels to step side walls off the outline sliver
uniform float uDisplacement;     // must match the vertex shader's
uniform float uMetalness;        // 0 = plaster only, 1 = full metal on revealed relief
uniform vec2 uCursorPos;         // eased cursor, uv space y-up (drives the metal light)
uniform float uLightRadius;      // wild.plus: 1.5
uniform float uLightIntensity;   // wild.plus: 0.4
uniform float uMetalAmbient;     // wild.plus: ambient .06 + cursorAmbient .19
uniform vec3 uLightColor;
uniform float uScreenScroll;
uniform float uTextureStrength;
uniform float uGradientStrength;
uniform float uOpacity;
uniform float uSwitchColorTransition;
uniform float uFastScroll;
uniform sampler2D tFluidFlowmap;
uniform vec3 uChromaColor;       // the mask color, painted flat
uniform float uChromaGround;     // how much flat ground takes the color
uniform float uBrightnessFactor;
uniform float uBrightnessOffset;
varying vec2 vUv;
varying vec3 vPos;
varying vec3 vEye;
// (three r152+ injects its own sRGBTransferOETF into the prolog — same curve, reuse it)
vec4 sRGB_OETF(in vec4 value){
  return vec4(mix(pow(value.rgb, vec3(0.41666)) * 1.055 - vec3(0.055), value.rgb * 12.92,
    vec3(lessThanEqual(value.rgb, vec3(0.0031308)))), value.a);
}
` + GLSL_FAST_SCROLL_NOISE + /* glsl */`
struct FluidEffectConfig {
  float amplitude; float shadowStrength; float fluidMagnitude;
  float fluidRedCoef; float fluidGreenCoef; float fluidBlueCoef;
  float linesSpeed; float linesScale; float linesStrength; float linesWaveLength;
  vec3 baseColor; float baseThreshold; float hueShift; float colorRange;
};
float cremap(float value, float start1, float stop1, float start2, float stop2){
  float r = start2 + (stop2 - start2) * ((value - start1) / (stop1 - start1));
  return clamp(r, min(start2, stop2), max(start2, stop2));
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 applyFluidEffect(FluidEffectConfig config, vec3 color, vec4 fluid, vec2 uv, float time, float mask, vec3 normal){
  float fluidEdges = smoothstep(0.0, 1.0, fluid.b * config.fluidMagnitude);
  vec2 uvLines = uv + time * 0.01 * config.linesSpeed;
  uvLines.x = uvLines.x * 1000.0 / config.linesScale;
  uvLines.y = sin(uvLines.y * 50.0 * config.linesWaveLength) * 20.0 / config.linesScale;
  float lines = smoothstep(-1.0, 0.5, sin(uvLines.x + uvLines.y));
  lines = mix(1.0, lines, config.linesStrength);
  // The site derives the hue from the normal itself (hueShift -0.52 → a yellow
  // that tips through orange into red across facets). That was tried here and
  // rejected: aimed at red, red sits at the wheel's wrap point, so the same swing
  // fell out into magenta and yellow instead of reading as one red. So this paints
  // CHROMA.color flat, exactly as the approved build did — only a slight
  // normal-driven shade is kept so the relief still models under the paint.
  vec3 normalVector = normal;
  normalVector.z *= config.colorRange;
  normalVector = normalize(normalVector);
  float shade = 0.85 + 0.3 * normalVector.x;      // subtle relief modulation
  vec3 effectColor = uChromaColor * shade;
  color = mix(color, effectColor, mask * fluidEdges * lines * config.amplitude);
  return color;
}
const FluidEffectConfig effectConfig = FluidEffectConfig(
  0.57, 0.3, 0.15,
  2.0, 1.0, 1.5,
  2.0, 4.0, 0.0, 0.15,
  vec3(0.4784, 0.7490, 0.7725), 1.0, -0.52, 2.0);
vec3 ContrastSaturationBrightness(vec3 color, float brt, float sat, float con){
  const vec3 LumCoeff = vec3(0.2125, 0.7154, 0.0721);
  vec3 AvgLumin = vec3(0.5);
  vec3 brtColor = color * brt;
  vec3 intensity = vec3(dot(brtColor, LumCoeff));
  vec3 satColor = mix(intensity, brtColor, sat);
  vec3 conColor = mix(AvgLumin, satColor, con);
  return conColor;
}
// The thin, sparsely-tessellated ribbon pieces bake visible per-facet banding
// into every Cycles pass (levels and normals alike). A 3x3 tent filter across
// neighbouring texels softens that at runtime without a rebake.
// center 4, edge 2, corner 1 (sum 16).
vec4 blurTex(sampler2D tex, vec2 uv, vec2 texel){
  vec4 s = texture2D(tex, uv) * 4.0;
  s += texture2D(tex, uv + vec2(texel.x, 0.0)) * 2.0;
  s += texture2D(tex, uv - vec2(texel.x, 0.0)) * 2.0;
  s += texture2D(tex, uv + vec2(0.0, texel.y)) * 2.0;
  s += texture2D(tex, uv - vec2(0.0, texel.y)) * 2.0;
  s += texture2D(tex, uv + texel) * 1.0;
  s += texture2D(tex, uv - texel) * 1.0;
  s += texture2D(tex, uv + vec2(texel.x, -texel.y)) * 1.0;
  s += texture2D(tex, uv + vec2(-texel.x, texel.y)) * 1.0;
  return s / 16.0;
}
void main(){
  vec3 color = vec3(0);
  float alpha = 1.0;
  vec2 uvScreen = gl_FragCoord.xy / uResolution;
  vec4 flow = texture2D(tFlow, uvScreen) * 2.;
  float extrude = mix(flow.b, flow.a, 0.5);
  vec2 fastScrollNoise = getFastScrollNoise(uTime, uvScreen + vec2(0., -uScreenScroll), tMaskNoise,
    vec4(SCROLL_EXTRUDE_SPEED, SCROLL_EXTRUDE_NOISE_SIZE, SCROLL_EXTRUDE_MASK));
  float fastScrollExtrude = fastScrollNoise.r * SCROLL_EXTRUDE_STRENGTH;
  extrude = mix(extrude, fastScrollExtrude, uFastScroll) * uOpacity;
  float gradient = mix(1.0, 0.5, length(uvScreen - vec2(0.0, 0.8)));

  // ---- side-wall UV rescue --------------------------------------------------
  // The bakes are FRONTAL projections sampled through a planar UV built from base
  // X,Y. The relief's side walls are extruded straight along +Z from the outline,
  // so a wall's top and bottom vertices share IDENTICAL X,Y — their UV area is
  // exactly zero (measured: half the triangles, ~50% of the surface). Every
  // fragment down a wall therefore samples the same 1-D sliver: the outline, which
  // is the highest-contrast line in the bake (lit top face meeting cast shadow).
  // Smeared down the wall, that reads as the vertical stripes.
  //
  // Fix: for wall fragments, step the sample point a few texels back along the
  // wall's own outward normal, into the top face the wall belongs to, so the wall
  // inherits that face's tone instead of the boundary sliver. vEye is built from
  // the UNdisplaced position, so this normal describes the fully-extruded shape
  // and stays stable as the reveal animates.
  vec3 gNormal = normalize(cross(dFdx(vEye), dFdy(vEye)));
  if (dot(gNormal, vEye) > 0.0) gNormal = -gNormal;        // resolve winding: face the camera
  float wallness = 1.0 - clamp(abs(gNormal.z), 0.0, 1.0);  // 0 = top face, 1 = edge-on wall
  vec2 wallDir = length(gNormal.xy) > 1e-4 ? normalize(gNormal.xy) : vec2(0.0);
  vec2 uvSurface = vUv - wallDir * uNormalMapTexel * uWallUvOffset * wallness;

  vec2 bakeTexel = uNormalMapTexel * uNormalBlurRadius;   // all bake passes share one resolution
  vec3 bake1 = sRGB_OETF(blurTex(tBake1, uvSurface, bakeTexel)).rgb;
  vec3 bake2 = sRGB_OETF(blurTex(tBake2, uvSurface, bakeTexel)).rgb;
  float level0 = bake2.b;
  float level1 = bake2.g;
  float level2 = bake2.r;
  float level3 = bake1.b;
  float level4 = bake1.g;
  float level5 = bake1.r;
  float o = level0;
  o = 0.54504;
  o = mix(o, level1, smoothstep(0.0, 0.2, extrude));
  o = mix(o, level2, smoothstep(0.2, 0.4, extrude));
  o = mix(o, level3, smoothstep(0.4, 0.6, extrude));
  o = mix(o, level4, smoothstep(0.6, 0.8, extrude));
  o = mix(o, level5, smoothstep(0.8, 1.0, extrude));
  color += vec3(o);
  vec2 uvPlaster = vPos.xy / uPlasterScale;
  float plaster = texture2D(tPlaster, uvPlaster).g;
  color = mix(color, color * plaster, uTextureStrength);
  color += gradient * 0.7 * uGradientStrength;
  color = color * uBrightnessFactor + uBrightnessOffset;

  // --- metallic layer: matcap on the revealed relief, using baked normals ---
  // baked normal is at FULL extrusion; the normal for the current squash follows
  // from scaling the height field: n' ∝ (s·nx/nz, s·ny/nz, 1)
  // metallic shading ported from week.wild.plus/athens-26: a point light that
  // follows the cursor does Blinn-Phong on the baked normals — the base darkens
  // to ambient inside the metal zone and broad base-tinted speculars sweep over
  // it as the cursor moves. (Their values: metallic .85, intensity .4, radius 1.5,
  // spec pow 16 ×2, highlight 75% tinted by base, ambient .06 + cursorAmbient .19.)
  vec4 nSample = blurTex(tNormalMap, uvSurface, bakeTexel);
  vec3 nFull = nSample.xyz * 2.0 - 1.0;
  float heightMask = nSample.a;                                   // 0 = wall plate, 1 = raised element
  float squash = mix(0.05, 1.0, extrude) * uDisplacement;         // matches the vertex displacement
  vec3 nRel = normalize(vec3(nFull.xy * (squash / max(nFull.z, 0.15)), 1.0));
  vec2 arVec = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 lightDelta = uCursorPos * arVec - uvScreen * arVec;
  float lightDist = length(lightDelta);
  vec3 lightDir = normalize(vec3(lightDelta, 0.4));
  vec3 halfVec = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float cursorDiff = max(dot(nRel, lightDir), 0.0);
  float cursorSpecMtl = pow(max(dot(nRel, halfVec), 0.0), 16.0);
  float cursorAtten = 1.0 - smoothstep(0.0, uLightRadius, lightDist);
  float effMetalSpec = cursorSpecMtl * uLightIntensity * 2.0 * cursorAtten;
  float effMetalDiff = cursorDiff * uLightIntensity * 0.25 * cursorAtten;
  vec3 metalHighlight = mix(uLightColor * effMetalSpec, color * effMetalSpec, 0.75);
  vec3 metallicColor = color * (uMetalAmbient + effMetalDiff) + metalHighlight;
  float reliefWeight = smoothstep(0.02, 0.18, 1.0 - nFull.z);     // sloped surfaces
  float raisedWeight = smoothstep(0.15, 0.6, heightMask);         // whole raised elements (ribbons)
  float metalMask = clamp(extrude, 0.0, 1.0) * max(reliefWeight, raisedWeight) * uMetalness;
  color = mix(color, clamp(metallicColor, 0.0, 1.0), metalMask);

  vec3 normal = gNormal;
  float fresnelFactor = abs(dot(normal, vec3(0., 0., 1.)));
  float inversefresnelFactor = 1.0 - fresnelFactor;
  inversefresnelFactor = 1. - pow(inversefresnelFactor, CHROMATIC_FRESNEL_SHARPNESS);
  float waveMask = max(
    smoothstep(1., 0.1, mix(inversefresnelFactor, 1., 1. - CHROMATIC_FRESNEL_OPACITY)),
    smoothstep(CHROMATIC_SHADOW_RANGE.y, CHROMATIC_SHADOW_RANGE.x, level5) * CHROMATIC_SHADOW_OPACITY) * uOpacity;
  waveMask = max(waveMask, uChromaGround * uOpacity);   // let the flat ground take some color too
  vec4 fluid = texture2D(tFluidFlowmap, uvScreen);
  fluid += mix(0., fastScrollNoise.g * 2., uFastScroll);
  color = applyFluidEffect(effectConfig, color, fluid, vUv, uTime, waveMask, normal);
  vec3 fastModeColor = ContrastSaturationBrightness(color, 2., 1., 0.08);
  fastModeColor += 0.3;
  vec3 whiteRender = mix(color, fastModeColor, uFastScroll);
  float blackFluid = pow(o * (length(fluid) * 0.0003) + o, 5.5);
  vec3 blackRender = vec3(blackFluid);
  color = mix(whiteRender, blackRender, uSwitchColorTransition);
  gl_FragColor.rgb = color;
  gl_FragColor.a = alpha;
}`;

// ---------------------------------------------------------------- background wall (shader 38 verbatim)
const BG_FRAG = /* glsl */`
precision highp float;
#define PI 3.141592653589793
varying vec2 vUv;
uniform float uGradientStrength;
uniform sampler2D tPlaster;
uniform float uTextureStrength;
highp float rand(const in vec2 uv){
  const highp float a = 12.9898, b = 78.233, c = 43758.5453;
  highp float dt = dot(uv.xy, vec2(a, b)), sn = mod(dt, PI);
  return fract(sin(sn) * c);
}
void main(){
  vec3 color = vec3(0);
  float alpha = 1.0;
  color += vec3(0.54504);
  vec2 uvPlaster = vUv / 1.0;
  float plaster = texture2D(tPlaster, uvPlaster).g;
  color = mix(color, color * plaster, uTextureStrength);
  vec2 uv = vUv + rand(vUv) * 0.01;
  float gradient = mix(1.0, 0.5, length(uv - vec2(0.0, 0.8)));
  color += gradient * 0.7 * uGradientStrength;
  color = color * 0.6 + 0.4;
  gl_FragColor.rgb = color;
  gl_FragColor.a = alpha;
}`;

// ---------------------------------------------------------------- mouse tracker (exact port of site's `cu`)
class MouseTracker {
  constructor() {
    this.normalFlip = new THREE.Vector2(-1, -1);
    this.lastNormalFlip = new THREE.Vector2(-1, -1);
    this.velocity = new THREE.Vector2();
    this.width = innerWidth; this.height = innerHeight;
    const update = (e) => {
      const x = e.changedTouches?.length ? e.changedTouches[0].pageX : e.pageX;
      const y = e.changedTouches?.length ? e.changedTouches[0].pageY : e.pageY;
      this.normalFlip.set(x / this.width, 1 - y / this.height);
    };
    addEventListener('pointermove', update);
    addEventListener('pointerdown', update);
    addEventListener('resize', () => { this.width = innerWidth; this.height = innerHeight; });
  }
  tick(deltaMs) {
    if (this.lastNormalFlip.x === -1) this.lastNormalFlip.copy(this.normalFlip);
    const dx = this.normalFlip.x - this.lastNormalFlip.x;
    const dy = this.normalFlip.y - this.lastNormalFlip.y;
    this.lastNormalFlip.copy(this.normalFlip);
    const m = Math.min(32, deltaMs) / 16;
    this.velocity.set(dx * m, dy * m);
  }
}

// ---------------------------------------------------------------- app
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const wallGroup = new THREE.Group();
scene.add(wallGroup);
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
camera.position.z = CONFIG.camera.distance;

const texLoader = new THREE.TextureLoader();
const loadTex = (url, wrap) => {
  const t = texLoader.load(url);
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};
const tPlaster = loadTex(ASSETS + 'plaster.webp', true);
const tMaskNoiseWall = loadTex(ASSETS + 'rgb-attenuation-0,9.webp', true);  // fast-scroll noise
const tFlowNoise = loadTex(ASSETS + 'mask-noise.webp', true);               // flowmap stamp noise
const tFluidBlack = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
tFluidBlack.needsUpdate = true;
const tFlatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
tFlatNormal.needsUpdate = true;   // flat "up" normal → metal layer is a no-op until bound

// shared uniforms
const uTime = { value: 0 };
const uResolution = { value: new THREE.Vector2() };
const uScreenScroll = { value: 0 };
const uScrollSpeed = { value: 0 };
const uFastScroll = { value: 0 };
const uOpacity = { value: 1 };
const uSwitchColorTransition = { value: 0 };
const uTextureStrength = { value: CONFIG.extrude.textureStrength };
const uGradientStrength = { value: CONFIG.extrude.gradientStrength };

const flowmap = new Flowmap(renderer, {
  falloff: CONFIG.flowmap.falloff,
  alpha: CONFIG.flowmap.alpha,
  dissipation: CONFIG.flowmap.dissipation,
  tNoise: { value: tFlowNoise },
  uTime,
});

// second, slower trail feeding the chromatic sheen (site: a GPU fluid sim's dye)
const fluidmap = CHROMA.enabled ? new Flowmap(renderer, {
  falloff: CHROMA.falloff,
  alpha: 1,
  dissipation: CHROMA.dissipation,
  clampMax: CHROMA.boost,
  tNoise: { value: tFlowNoise },
  uTime,
}) : null;

// background
const bg = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: BG_FRAG,
    uniforms: { uGradientStrength, tPlaster: { value: tPlaster }, uTextureStrength },
    depthWrite: false,
    depthTest: false,
  })
);
bg.renderOrder = -1;
bg.frustumCulled = false;
scene.add(bg);

// wall sections
const sections = [];
let sectionsPerLine = 1;

function makeWallMaterial(bake1, bake2) {
  return new THREE.ShaderMaterial({
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    // the source SVG's ring winding is normalized, so FrontSide cleanly culls the
    // few inverted pieces instead of rendering them to z-fight the real front wall
    // (which was its own vertical-stripe artifact at full extrusion)
    side: THREE.FrontSide,
    uniforms: {
      uTime,
      uResolution,
      tMaskNoise: { value: tMaskNoiseWall },
      tFlow: flowmap.uniform,
      tBake1: { value: bake1 },
      tBake2: { value: bake2 },
      tPlaster: { value: tPlaster },
      uPlasterScale: { value: new THREE.Vector2(10, 10) },   // site value; custom mode overrides
      tNormalMap: { value: tFlatNormal },                    // custom mode binds the baked normal map
      uNormalMapTexel: { value: new THREE.Vector2(1, 1) },   // real value bound once the bake loads
      uNormalBlurRadius: { value: 2.5 },
      // ~6 texels clears the outline's antialiased boundary and lands on solid top
      // face. Larger overshoots the thinner ribbon strands entirely and washes them
      // out, so this wants to sit just past the edge, not deep in.
      uWallUvOffset: { value: 6.0 },
      uDisplacement: { value: DISPLACEMENT },
      uMetalness: { value: 0 },                              // metal off unless custom mode enables it
      uCursorPos: { value: flowmap.mouse },                  // shared, eased — updates live
      uLightRadius: { value: METAL.lightRadius },
      uLightIntensity: { value: METAL.lightIntensity },
      uMetalAmbient: { value: METAL.ambient },
      uLightColor: { value: new THREE.Color(METAL.lightColor) },
      uScreenScroll,
      uScrollSpeed,
      uTextureStrength,
      uGradientStrength,
      uOpacity,
      uSwitchColorTransition,
      uFastScroll,
      tFluidFlowmap: fluidmap ? fluidmap.uniform : { value: tFluidBlack },
      uChromaColor: { value: chromaColor() },
      uChromaGround: { value: CHROMA.ground },
      uBrightnessFactor: { value: BRIGHTNESS_FACTOR },
      uBrightnessOffset: { value: BRIGHTNESS_OFFSET },
    },
  });
}

let rowSpacing = ROW_SPACING;   // custom mode overrides with its own panel height

const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);

const loadingEl = document.getElementById('loading');
const hideLoading = () => {
  loadingEl.style.opacity = 0;
  setTimeout(() => loadingEl.remove(), 700);
};
const failLoading = (err) => {
  loadingEl.textContent = 'failed to load — serve over http (Live Server) and check console';
  console.error(err);
};

if (USE_CUSTOM) {
  // ---- user's model + baked levels from scripts/bake_levels.py
  const metaPromise = fetch(CUSTOM.meta, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  metaPromise.then((meta) => {
  // the bake's own timestamp versions every asset URL, so the assets stay
  // cacheable between visits but a rebake invalidates them on its own
  const v = '?v=' + encodeURIComponent(meta.baked || BAKE_VERSION);
  const bake1 = loadTex(CUSTOM.bake1 + v);
  const bake2 = loadTex(CUSTOM.bake2 + v);
  for (const t of [bake1, bake2]) {
    t.colorSpace = THREE.SRGBColorSpace;     // same decode chain as the GLB bakes
    t.wrapT = THREE.RepeatWrapping;          // bake is vertically periodic → filtering
    t.wrapS = THREE.ClampToEdgeWrapping;     //   at the seam samples the neighbor
  }
  const normalMap = loadTex('./bakes/normal.webp' + v);   // raw vectors — no color space
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
  const depthMult = meta.depthMult || CUSTOM.depthMult;
  gltfLoader.load(CUSTOM.model + v, (gltf) => {
    let geometry = null;
    gltf.scene.traverse((o) => { if (o.geometry && !geometry) geometry = o.geometry; });
    if (!geometry) return failLoading(new Error('no mesh in custom model'));
    // The export splits a vertex into duplicates (same position, different
    // normal/uv) at every hard-shaded edge — normal and glTF-standard, and harmless
    // for shading here (color comes from the baked 2D textures via the planar UV
    // recomputed below, never from vertex normals). But at full extrusion a
    // duplicate can sit a hair off from its twin and open a visible crack — thin
    // bright tears cutting across the fill. Drop normal/uv (unused) and weld by
    // position only, so adjacent triangles actually share vertices again.
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');
    geometry = mergeVertices(geometry, 1e-3);
    // source: plate in XZ, relief depth on +Y → rotate depth onto +Z (toward camera),
    // then amplify to the bake's depth ratio (meta.json keeps them in sync)
    geometry.rotateX(Math.PI / 2);
    geometry.scale(1, 1, depthMult);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    geometry.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
    // planar UVs over the plate bounds — the bakes are orthographic front renders
    geometry.computeBoundingBox();
    const b = geometry.boundingBox;
    const pos = geometry.attributes.position;
    const uvArr = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvArr[i * 2]     = (pos.getX(i) - b.min.x) / (b.max.x - b.min.x);
      uvArr[i * 2 + 1] = (pos.getY(i) - b.min.y) / (b.max.y - b.min.y);
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    const height = bb.max.y - bb.min.y;
    rowSpacing = height;
    sectionsPerLine = 1;
    for (let i = -1; i <= 1; i++) {           // 3 copies for the infinite vertical loop
      const mesh = new THREE.Mesh(geometry, makeWallMaterial(bake1, bake2));
      mesh.position.y = i * rowSpacing;
      mesh.frustumCulled = false;
      // the shader's pos.xy *= 1.004 makes neighbouring clones overlap at nearly
      // equal depth — offset each clone a hair so the seam can't z-fight
      mesh.material.polygonOffset = true;
      mesh.material.polygonOffsetFactor = 0;
      mesh.material.polygonOffsetUnits = (i + 1) * -2;
      mesh.renderOrder = i + 1;
      // exactly one plaster tile per panel → texture is continuous across seams
      mesh.material.uniforms.uPlasterScale.value.set(rowSpacing, rowSpacing);
      mesh.material.uniforms.tNormalMap.value = normalMap;
      if (meta.res) mesh.material.uniforms.uNormalMapTexel.value.set(1 / meta.res[0], 1 / meta.res[1]);
      mesh.material.uniforms.uMetalness.value = METAL.enabled ? METAL.strength : 0;
      sections.push(mesh);
      wallGroup.add(mesh);
    }
    hideLoading();
  }, undefined, failLoading);
  });
} else {
  gltfLoader.load(ASSETS + 'reliefs_high_compressed.glb', (gltf) => {
  const rows = {};
  const rowKeys = [];
  gltf.scene.children.forEach((child) => {
    if (!child.geometry) return;
    // bakes ride inside the GLB materials; loader tags them sRGB → GPU decodes to
    // linear → the shader's OETF re-encodes (same chain as the site)
    const bake1 = child.material.map;
    const bake2 = child.material.emissiveMap;
    const mesh = new THREE.Mesh(child.geometry, makeWallMaterial(bake1, bake2));
    mesh.position.copy(child.position);
    mesh.scale.copy(child.scale);
    mesh.frustumCulled = false;
    const rowKey = Math.round(child.position.y);
    rows[rowKey] = (rows[rowKey] || 0) + 1;
    if (rows[rowKey] > sectionsPerLine) sectionsPerLine = rows[rowKey];
    if (!rowKeys.includes(rowKey)) rowKeys.push(rowKey);
    mesh.renderOrder = rowKeys.indexOf(rowKey);
    sections.push(mesh);
    wallGroup.add(mesh);
  });
  hideLoading();
}, undefined, failLoading);
}

// ---------------------------------------------------------------- scroll → zoom + fast mode
let scrollPx = 0;                       // accumulated scroll, clamped to the zoom range
let scrollRaw = 0;                      // the same input UNclamped — see below
let scrollDelta = 0;                    // this frame's scroll, consumed by the frame loop
const zoomSpring = { x: 0, v: 0 };      // sprung zoom progress 0..1
// Zoom saturates after ZOOM.screens of scrolling, but fast mode is about the ACT of
// scrolling, not the position. Reading speed off the clamped value would kill the
// noise reveal exactly when someone is scrolling hardest at the end of the range, so
// speed and drift come off the raw accumulation instead.
const addScroll = (dy) => {
  scrollPx = Math.max(0, Math.min(ZOOM.screens * innerHeight, scrollPx + dy));
  scrollRaw += dy;
  scrollDelta += dy;
};
addEventListener('wheel', (e) => { addScroll(e.deltaY); }, { passive: true });
let dragY = null;
addEventListener('pointerdown', (e) => { dragY = e.clientY; });
addEventListener('pointerup', () => { dragY = null; });
addEventListener('pointermove', (e) => {
  if (dragY !== null && e.pointerType !== 'mouse') {
    addScroll((dragY - e.clientY) * 2);
    dragY = e.clientY;
  }
});

// ---------------------------------------------------------------- resize / camera fit
let viewportHeight = 1;
function resize() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  const dpr = renderer.getPixelRatio();
  renderer.setSize(w, h);
  uResolution.value.set(w * dpr, h * dpr);
  flowmap.aspect = aspect;
  camera.aspect = aspect;
  const fitHeight = FOV_FIT * (ROW_SPACING - 0.1) / aspect;
  const fitFov = 2 * Math.atan(fitHeight / (2 * CONFIG.camera.distance)) * (180 / Math.PI);
  camera.fov = Math.min(CONFIG.camera.fov, fitFov);
  camera.updateProjectionMatrix();
  viewportHeight = 2 * CONFIG.camera.distance * Math.tan(camera.fov * Math.PI / 360);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- ambient reveal
const rnd = (a, b) => a + Math.random() * (b - a);

// GSAP's rough() ease, reimplemented — the site tweens mouse2 with
// rough({strength, points: floor(duration*12), template, taper: none,
// randomize: true, clamp: true}), and that ease IS the movement's character: it
// scatters `points` random samples around the template curve, deviating by
// `strength`, then walks between them linearly. So the blob doesn't glide from A
// to B, it shivers along the way. Ported rather than smoothed over, because a
// plain ease here looks like a completely different effect.
const roughEase = (points, strength, template, blend) => {
  const base = template || ((t) => t);
  const pts = [];
  for (let i = 0; i < points; i++) {
    // GSAP randomizes the sample POSITIONS too (randomize: true). Two of them can
    // then land almost on top of each other with very different values, which is a
    // cliff — measured at up to a full path-length jump in one frame, and that is
    // the twitch rather than the deviation size. Evenly spaced samples bound the
    // slope at deviation/spacing while keeping the wander random.
    const x = (i + 1) / (points + 1);
    let y = base(x);
    y += Math.random() * strength - strength * 0.5;           // taper: none → gap = strength
    pts.push({ x, y: Math.max(0, Math.min(1, y)) });           // clamp: true
  }
  pts.push({ x: 0, y: 0 }, { x: 1, y: 1 });
  pts.sort((a, b) => a.x - b.x);
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let i = 1;
    while (i < pts.length - 1 && pts[i].x < t) i++;
    const a = pts[i - 1], b = pts[i];
    const span = b.x - a.x;
    // GSAP walks between the samples linearly, which corners at every one of them.
    // Smoothstep across the gap instead: same samples, no velocity discontinuity —
    // this is most of what takes the shake out.
    let k = span > 1e-6 ? (t - a.x) / span : 0;
    k = k * k * (3 - 2 * k);
    const rough = a.y + (b.y - a.y) * k;
    return base(t) + (rough - base(t)) * blend;               // mix back toward clean travel
  };
};
const power2Out = (t) => 1 - Math.pow(1 - t, 2);

// site: createRandomDirections — successive points sit on a circle of radius .7-.9,
// each at a random angle off the previous one (±0.8π), so a pass wanders rather than
// crossing straight over
function ambientDirections(prev) {
  const start = prev || { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2 };
  const angle = Math.atan2(start.y, start.x) + (Math.random() - 0.5) * 2 * Math.PI * 0.8;
  const len = rnd(AMBIENT.radius[0], AMBIENT.radius[1]);
  return { start, end: { x: Math.cos(angle) * len, y: Math.sin(angle) * len } };
}

function buildAmbientPass() {
  const count = Math.floor(Math.random() * (AMBIENT.segments[1] - AMBIENT.segments[0] + 1)) + AMBIENT.segments[0];
  const segs = [];
  let prev = null;
  for (let i = 0; i < count; i++) {
    const more = i !== count - 1 && Math.random() < 0.7;      // site's own 0.7 coin flip
    const dur = more ? rnd(AMBIENT.durMid[0], AMBIENT.durMid[1]) : rnd(AMBIENT.durLast[0], AMBIENT.durLast[1]);
    const d = ambientDirections(prev);
    const pts = Math.max(2, Math.round(dur * AMBIENT.roughPoints));
    const strength = more ? AMBIENT.roughMid : AMBIENT.roughLast;
    const template = more ? power2Out : null;
    segs.push({
      dur, d,
      // x and y get separate ease instances on the site (two tween calls), so they
      // drift independently — that is what keeps it from reading as one moving line
      ex: roughEase(pts, strength, template, AMBIENT.roughBlend),
      ey: roughEase(pts, strength, template, AMBIENT.roughBlend),
    });
    prev = d.end;
  }
  return { segs, i: 0, t: 0 };
}

let ambientCount = 0;
let ambientPass = null;
let ambientWait = FORCE_AMBIENT ? 0 : rnd(AMBIENT.pause[0], AMBIENT.pause[1]);

function updateAmbient(delta) {
  if (!AMBIENT.enabled) return;
  // site pins this once and leaves it: |(1,1)|*50 saturates getStamp's magnitude
  flowmap.velocity2.set(1, 1);
  if (!ambientPass) {
    ambientWait -= delta;
    if (ambientWait > 0) { flowmap.mouse2.set(-1, -1); return; }   // parked, outside falloff
    ambientPass = buildAmbientPass();
    ambientCount++;
    if (FORCE_AMBIENT) document.title = 'ambient pass ' + ambientCount + ' — ' + ambientPass.segs.length + ' seg(s)';
  }
  const seg = ambientPass.segs[ambientPass.i];
  ambientPass.t += delta;
  const p = Math.min(1, ambientPass.t / seg.dur);
  // [-1,1] → uv, exactly as the site does it (x/2 + .5)
  flowmap.mouse2.set(
    (seg.d.start.x + (seg.d.end.x - seg.d.start.x) * seg.ex(p)) / 2 + 0.5,
    (seg.d.start.y + (seg.d.end.y - seg.d.start.y) * seg.ey(p)) / 2 + 0.5,
  );
  if (p >= 1) {
    ambientPass.i++;
    ambientPass.t = 0;
    if (ambientPass.i >= ambientPass.segs.length) {
      ambientPass = null;
      ambientWait = FORCE_AMBIENT ? 0 : rnd(AMBIENT.pause[0], AMBIENT.pause[1]);
      flowmap.mouse2.set(-1, -1);
    }
  }
}

// ---------------------------------------------------------------- frame loop (site order)
const tracker = new MouseTracker();
let lastT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const deltaMs = now - lastT;
  lastT = now;
  const delta = deltaMs / 1000;

  uTime.value += delta;
  tracker.tick(deltaMs);

  // scroll → sprung zoom (aurora-botanique mechanic: spring 80/22/0.7, scale 1→1.35)
  const progressTarget = Math.max(0, Math.min(1, scrollPx / (ZOOM.screens * innerHeight)));
  {
    const { stiffness, damping, mass } = ZOOM.spring;
    const dtS = Math.min(delta, 0.05);
    const accel = (-stiffness * (zoomSpring.x - progressTarget) - damping * zoomSpring.v) / mass;
    zoomSpring.v += accel * dtS;
    zoomSpring.x += zoomSpring.v * dtS;
  }
  // ---- fast-scroll mode -----------------------------------------------------
  // Scroll speed in px per 60fps-equivalent frame, so the thresholds mean the same
  // thing on a 144Hz screen as on a 60Hz one.
  const framesThis = Math.max(deltaMs, 1) / 16.667;
  const speed = Math.abs(scrollDelta) / framesThis;
  // site: uScrollSpeed += (scrollDelta * 5 - uScrollSpeed) * 0.04
  uScrollSpeed.value += (scrollDelta * 5 - uScrollSpeed.value) * 0.04;
  if (FORCE_FAST) {
    uFastScroll.value = 1;                       // ?fast — pins the mode on, to judge it
    uScreenScroll.value += delta * FAST.drift * 0.35;
  } else if (FAST.enabled) {
    const t = Math.max(0, Math.min(1, (speed - FAST.onSpeed) / (FAST.fullSpeed - FAST.onSpeed)));
    const target = t * t * (3 - 2 * t);                      // smoothstep
    const rate = target > uFastScroll.value ? FAST.attack : FAST.release;
    // rate*framesThis MUST stay ≤ 1: a long frame otherwise overshoots the target and
    // the value oscillates outside [0,1], which the shader reads as an extrapolation
    // of the fast-mode grade — the screen blows out to white, then to black.
    uFastScroll.value += (target - uFastScroll.value) * Math.min(1, rate * framesThis);
    uFastScroll.value = Math.max(0, Math.min(1, uFastScroll.value));
    // the noise field travels with the scroll, as it does on the site (there via the
    // wall's own translation); one screen of scrolling moves it FAST.drift of a screen
    uScreenScroll.value = (scrollRaw / innerHeight) * FAST.drift;
  }
  scrollDelta = 0;

  // The site's fast mode also pulls the camera back (fastModeZoom .6). It can afford
  // that because its wall tiles horizontally — ours is a single plate that only just
  // fills the frame at zoom 1, so an unclamped .6 pulls back past the plate's left and
  // right edges and shows background down both sides. Clamping at 1 keeps the pull-back
  // wherever the user has already zoomed in, and simply does nothing at rest.
  const fastZoom = 1 + (FAST.zoom - 1) * uFastScroll.value;
  camera.zoom = Math.max(1, (1 + (ZOOM.max - 1) * zoomSpring.x) * fastZoom);
  camera.updateProjectionMatrix();

  // brush radius follows the magnification, so the revealed patch stays the same
  // size ON THE WALL at any zoom (uFalloff is a screen-space radius; the material
  // pre-halves it, hence the same 0.5 the constructor applies)
  if (BRUSH_TRACKS_ZOOM) {
    flowmap.material.uniforms.uFalloff.value = CONFIG.flowmap.falloff * 0.5 * camera.zoom;
    if (fluidmap) fluidmap.material.uniforms.uFalloff.value = CHROMA.falloff * 0.5 * camera.zoom;
  }

  // flow-map feed (exact site order & factors; wall no longer travels → no scroll offset)
  flowmap.mouse.lerp(tracker.normalFlip, CONFIG.flowmap.mouseEase);
  flowmap.velocity.lerp(tracker.velocity, tracker.velocity.length() ? 0.1 : 0.04);
  updateAmbient(delta);
  flowmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
  flowmap.update(0);
  if (fluidmap) {
    fluidmap.aspect = flowmap.aspect;
    fluidmap.mouse.copy(flowmap.mouse);
    fluidmap.velocity.copy(flowmap.velocity);
    if (AMBIENT.chroma) {
      fluidmap.mouse2.copy(flowmap.mouse2);
      fluidmap.velocity2.copy(flowmap.velocity2);
    }
    fluidmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
    fluidmap.update(0);
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
