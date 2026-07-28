// immersive-g.com home bas-relief reveal — 1:1 ver1.
// Every shader and constant below is ported verbatim from the production bundle
// (see ../REPLICATION-SPEC.md and ../reference/shaders_extracted.txt).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ---------------------------------------------------------------- config (site values)
const CONFIG = {
  flowmap: { mouseEase: 0.4, dissipation: 0.953, falloff: 0.38, alpha: 1 },
  extrude: { textureStrength: 1, gradientStrength: 0.17 },
  camera:  { fov: 30, distance: 15, fastModeZoom: 0.6, slowModeZoom: 1, near: 5, far: 20 },
};
const ROW_SPACING = 9.995;          // Ei
const FOV_FIT = 1.33;               // $o  → worldHeight = 1.33 * (Ei - .1) / aspect
const BRIGHTNESS_FACTOR = 0.6;      // desktop (mobile: .5)
const BRIGHTNESS_OFFSET = 0.4;      // desktop (mobile: .6)
// Whole-scene brightness. 1 = Original. Applied as a final multiply on both the wall
// and the background, so it scales everything uniformly: (color*FACTOR + OFFSET) * B.
// There is no tone mapping, so anything over 1.0 clips flat to white — the flat wall
// lands near 0.77 at B=1, which means B≈1.30 puts it at the ceiling and highlights
// start blowing out. Below ~1.25 is safe; above that, lower BRIGHTNESS_FACTOR too.
const BRIGHTNESS = 1.1;
const SCROLL_WHEEL_MULT = 0.00045;  // wheel px → rows (feel-tuned, site uses its own smooth-scroll rig)
const SCROLL_SMOOTH = 0.035;

// ---------------------------------------------------------------- zoom (ported from ver3)
// Scroll drives a spring-damped camera zoom: raw scroll pixels are clamped to
// ZOOM.screens viewport heights, normalised to 0..1, and chased by a spring so the
// zoom settles rather than tracking the wheel frame-for-frame.
// Matching ver3: the wheel ONLY zooms, it does not travel the wall. ver3 never moves
// wallGroup, so with this false the whole travel path idles — scroll stays 0, the wall
// sits still, uScreenScroll stays 0 and the flow-map gets no scroll offset, which is
// exactly ver3's `flowmap.update(0)`. Set true for Original's infinite vertical travel.
const SCROLL_TRAVELS = false;
const BRUSH_TRACKS_ZOOM = true;   // brush radius scales with zoom, so the revealed
                                  //   patch stays a constant size on the wall.
                                  //   false = the site's own screen-space behaviour
const ZOOM = {
  max: 1.6,                                     // scroll-in target
  screens: 6,                                   // scroll distance for full zoom, in viewport heights
  spring: { stiffness: 80, damping: 22, mass: 0.7 },
};

const ASSETS = './assets/';

// custom-model mode: open ver1/index.html?custom to use ../output.gltf with the
// bakes produced by scripts/bake_levels.py (ver1/bakes/bake1.webp + bake2.webp).
// DEPTH_MULT must match the --depth-mult used for the bake.
const USE_CUSTOM = true; // packaged build: custom model only
const CUSTOM = {
  model: './bakes/model.glb',   // welded copy written by scripts/bake_levels.py — NOT output.gltf
  bake1: './bakes/bake1.webp',
  bake2: './bakes/bake2.webp',
  meta: './bakes/meta.json',    // depthMult etc. — written by the bake, no manual sync
  depthMult: 6.25,              // fallback if meta.json is missing
  // Original's ground drifts toward the camera as the relief reveals. That is not a
  // shader effect — it falls out of where the flat plate sits in the mesh. The reveal
  // is `pos.z *= mix(0.05, 1.0, extrude)` (WALL_VERT), which scales about z=0, so a
  // plate lying AT z=0 is pinned and cannot move. Original's plate covers 100% of the
  // plate area at z=0.75 of the relief depth (relief elements sit both below it at
  // 0.067/0.25/0.50 and above it at 0.933/1.0), so it travels 0.95*0.75*depth on a
  // full reveal. This mesh is flat-bottomed — plate at z=0.00, ribbons at z=1.00 — so
  // it is lifted here to restore the same travel. 0 = plate pinned (no ground shift).
  // Travel on a full reveal = 0.95 * groundLift * (depthMult * reliefDepth). Because
  // it scales with depth, the two depth halvings (ratio 0.03 -> 0.0075) cut the
  // background's motion to a quarter, so matching Original's ABSOLUTE travel needs
  // 3.0 — but that was tried and read as the wall swimming toward the camera: the
  // scale is multiplicative about z=0, so the sheet's motion (0.95*L*depth) grows
  // while the relief's pop above it (0.95*depth) does not. At 3.0 the sheet moves 3x
  // more than the relief pops. Known points: 0.75 (Original's own geometric ratio)
  // reads clean, 1.5 reads "a bit disconnected", 3.0 swims badly. 1.1 is the midpoint
  // of the clean/bad bracket. Raise the relief itself with -DepthRatio, not this.
  groundLift: 1.1,
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
  data = min(data, vec4(1));
  data.rgb = max(data.rgb, vec3(-1));
  gl_FragColor = data;
}`;

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`;

class Flowmap {
  constructor(renderer, { size = 256, falloff = 0.5, alpha = 0.3, dissipation = 0.98, tNoise, uTime }) {
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
  pos.z *= mix(0.05, 1.0, extrude);
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
uniform float uScreenScroll;
uniform float uTextureStrength;
uniform float uGradientStrength;
uniform float uOpacity;
uniform float uSwitchColorTransition;
uniform float uFastScroll;
uniform sampler2D tFluidFlowmap;
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
  vec3 normalVector = normal;
  normalVector.z *= config.colorRange;
  normalVector = normalize(normalVector);
  vec3 normalColor = (normalVector + 1.) / 2.;
  normalColor = rgb2hsv(normalColor);
  normalColor.r = fract(normalColor.r + config.hueShift);
  normalColor = hsv2rgb(normalColor);
  vec3 effectColor = normalColor;
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
  vec3 bake1 = sRGB_OETF(texture2D(tBake1, vUv)).rgb;
  vec3 bake2 = sRGB_OETF(texture2D(tBake2, vUv)).rgb;
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
  vec3 dFdxPos = dFdx(vEye);
  vec3 dFdyPos = dFdy(vEye);
  vec3 normal = normalize(cross(dFdxPos, dFdyPos));
  float fresnelFactor = abs(dot(normal, vec3(0., 0., 1.)));
  float inversefresnelFactor = 1.0 - fresnelFactor;
  inversefresnelFactor = 1. - pow(inversefresnelFactor, CHROMATIC_FRESNEL_SHARPNESS);
  float waveMask = max(
    smoothstep(1., 0.1, mix(inversefresnelFactor, 1., 1. - CHROMATIC_FRESNEL_OPACITY)),
    smoothstep(CHROMATIC_SHADOW_RANGE.y, CHROMATIC_SHADOW_RANGE.x, level5) * CHROMATIC_SHADOW_OPACITY) * uOpacity;
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
uniform float uBrightness;
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
  color = (color * 0.6 + 0.4) * uBrightness;   // same 0.6/0.4 as the wall, + BRIGHTNESS
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
// Original's own plaster: the shared ../reference/plaster.jpg was swapped for ver3's
// 4K marble, so ver4 names the untouched copy explicitly (byte-identical to
// Original/reference/plaster.jpg) — ver4 must look like Original, geometry aside.
const tPlaster = loadTex(ASSETS + 'plaster_orig_backup.webp', true);
const tMaskNoiseWall = loadTex(ASSETS + 'rgb-attenuation-0,9.webp', true);  // fast-scroll noise
const tFlowNoise = loadTex(ASSETS + 'mask-noise.webp', true);               // flowmap stamp noise
const tFluidBlack = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
tFluidBlack.needsUpdate = true;

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

// background
const bg = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: BG_FRAG,
    uniforms: { uGradientStrength, tPlaster: { value: tPlaster }, uTextureStrength,
                uBrightness: { value: BRIGHTNESS } },
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
    uniforms: {
      uTime,
      uResolution,
      tMaskNoise: { value: tMaskNoiseWall },
      tFlow: flowmap.uniform,
      tBake1: { value: bake1 },
      tBake2: { value: bake2 },
      tPlaster: { value: tPlaster },
      uPlasterScale: { value: new THREE.Vector2(10, 10) },   // site value; custom mode overrides
      uScreenScroll,
      uScrollSpeed,
      uTextureStrength,
      uGradientStrength,
      uOpacity,
      uSwitchColorTransition,
      uFastScroll,
      tFluidFlowmap: { value: tFluidBlack },
      // both scaled by BRIGHTNESS: (color*F + O) * B  ==  color*(F*B) + O*B
      uBrightnessFactor: { value: BRIGHTNESS_FACTOR * BRIGHTNESS },
      uBrightnessOffset: { value: BRIGHTNESS_OFFSET * BRIGHTNESS },
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
  const bake1 = loadTex(CUSTOM.bake1);
  const bake2 = loadTex(CUSTOM.bake2);
  for (const t of [bake1, bake2]) {
    t.colorSpace = THREE.SRGBColorSpace;     // same decode chain as the GLB bakes
    t.wrapT = THREE.RepeatWrapping;          // bake is vertically periodic → filtering
    t.wrapS = THREE.ClampToEdgeWrapping;     //   at the seam samples the neighbor
  }
  const metaPromise = fetch(CUSTOM.meta).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  metaPromise.then((meta) => {
  const depthMult = meta.depthMult || CUSTOM.depthMult;
  gltfLoader.load(CUSTOM.model, (gltf) => {
    let geometry = null;
    gltf.scene.traverse((o) => { if (o.geometry && !geometry) geometry = o.geometry; });
    if (!geometry) return failLoading(new Error('no mesh in custom model'));
    // source: plate in XZ, relief depth on +Y → rotate depth onto +Z (toward camera),
    // then amplify to the bake's depth ratio (meta.json keeps them in sync)
    geometry.rotateX(Math.PI / 2);
    geometry.scale(1, 1, depthMult);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    // z: seat the plate at CUSTOM.groundLift of the relief depth above the scale
    // origin, so the reveal carries the ground with it the way Original's did
    const reliefDepth = bb.max.z - bb.min.z;
    geometry.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2,
                       -bb.min.z + CUSTOM.groundLift * reliefDepth);
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

// ---------------------------------------------------------------- scroll
let scrollTarget = 0;
let scroll = 0;
// zoom input (ver3): raw scroll pixels, clamped to the zoom range. Kept separate from
// the travel input above so either can be tuned or switched off on its own.
let scrollPx = 0;
const zoomSpring = { x: 0, v: 0 };
const addZoomScroll = (dy) => {
  scrollPx = Math.max(0, Math.min(ZOOM.screens * innerHeight, scrollPx + dy));
};
addEventListener('wheel', (e) => {
  if (SCROLL_TRAVELS) scrollTarget += e.deltaY * SCROLL_WHEEL_MULT;
  addZoomScroll(e.deltaY);
}, { passive: true });
let dragY = null;
addEventListener('pointerdown', (e) => { dragY = e.clientY; });
addEventListener('pointerup', () => { dragY = null; });
addEventListener('pointermove', (e) => {
  if (dragY !== null && e.pointerType !== 'mouse') {
    if (SCROLL_TRAVELS) scrollTarget += (dragY - e.clientY) * 0.004;
    addZoomScroll((dragY - e.clientY) * 2);   // ver3's touch-drag factor
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

// ---------------------------------------------------------------- frame loop (site order)
const tracker = new MouseTracker();
let scrollLast = 0;
let lastT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const deltaMs = now - lastT;
  lastT = now;
  const delta = deltaMs / 1000;
  const dt60 = deltaMs / 16.666;

  uTime.value += delta;
  tracker.tick(deltaMs);

  // zoom spring (ver3): scroll position → camera.zoom. dtS is clamped so a stalled
  // frame cannot blow the integrator up.
  {
    const progressTarget = Math.max(0, Math.min(1, scrollPx / (ZOOM.screens * innerHeight)));
    const { stiffness, damping, mass } = ZOOM.spring;
    const dtS = Math.min(delta, 0.05);
    const accel = (-stiffness * (zoomSpring.x - progressTarget) - damping * zoomSpring.v) / mass;
    zoomSpring.v += accel * dtS;
    zoomSpring.x += zoomSpring.v * dtS;
  }
  camera.zoom = Math.max(1, 1 + (ZOOM.max - 1) * zoomSpring.x);
  camera.updateProjectionMatrix();
  if (BRUSH_TRACKS_ZOOM) {
    // matches what the Flowmap constructor stored (falloff * 0.5) at zoom 1
    flowmap.material.uniforms.uFalloff.value = CONFIG.flowmap.falloff * 0.5 * camera.zoom;
  }

  // scroll smoothing
  scroll += (scrollTarget - scroll) * Math.min(1, SCROLL_SMOOTH * dt60 * 2);
  wallGroup.position.y = -scroll * rowSpacing;
  uScreenScroll.value = wallGroup.position.y * CONFIG.camera.fastModeZoom / viewportHeight;

  // wrap sections
  const total = (sections.length / sectionsPerLine) * rowSpacing;
  const half = total * 0.5;
  for (const mesh of sections) {
    const y = mesh.position.y + wallGroup.position.y;
    if (y < -half) mesh.position.y += total;
    if (y > half) mesh.position.y -= total;
  }

  // flow-map feed (exact site order & factors)
  let scrollDelta = uScreenScroll.value - scrollLast;
  scrollDelta = Math.min(0.2, Math.abs(scrollDelta)) * Math.sign(scrollDelta);
  scrollLast = uScreenScroll.value;
  flowmap.mouse.lerp(tracker.normalFlip, CONFIG.flowmap.mouseEase);
  flowmap.velocity.lerp(tracker.velocity, tracker.velocity.length() ? 0.1 : 0.04);
  flowmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
  flowmap.update(-scrollDelta);
  uScrollSpeed.value += (scrollDelta * 5 - uScrollSpeed.value) * 0.04;

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
