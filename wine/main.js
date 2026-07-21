// immersive-g.com home bas-relief reveal — 1:1 ver1.
// Every shader and constant below is ported verbatim from the production bundle
// (see ../REPLICATION-SPEC.md and ../reference/shaders_extracted.txt).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- config (site values)
const CONFIG = {
  flowmap: { mouseEase: 0.4, dissipation: 0.953, falloff: 0.38, alpha: 1 },
  extrude: { textureStrength: 1, gradientStrength: 0.17 },
  camera:  { fov: 30, distance: 15, fastModeZoom: 0.6, slowModeZoom: 1, near: 5, far: 20 },
};
const ROW_SPACING = 9.995;          // Ei
const FOV_FIT = 1.33;               // $o  → worldHeight = 1.33 * (Ei - .1) / aspect
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const BRIGHTNESS_FACTOR = IS_MOBILE ? 0.5 : 0.6;   // site: mobile .5 / desktop .6
const BRIGHTNESS_OFFSET = IS_MOBILE ? 0.6 : 0.4;   // site: mobile .6 / desktop .4
// scroll → zoom (decomposed from aurora-botanique.com):
// fixed full-screen visual; scroll progress smoothed by a spring
// (stiffness 80, damping 22, mass .7) drives scale 1 → 1.35 from screen center.
const ZOOM = {
  max: 2.4,                                     // 4× the aurora zoom amount (aurora: 1.35)
  screens: 6,                                   // scroll distance for full zoom, in viewport heights (aurora: ~17)
  spring: { stiffness: 80, damping: 22, mass: 0.7 },
};

// metallic layer, ported 1:1 from week.wild.plus/athens-26: a cursor-following
// point light Blinn-Phongs the baked normals; the metal zone darkens to ambient
// and base-tinted highlights sweep with the cursor. Values = their defaults.
// chromatic sheen (the original site's yellow/red iridescent hues along revealed
// relief edges where the cursor has passed). The shading is the site's verbatim
// applyFluidEffect; we feed it a slow-fading cursor trail instead of their full
// Navier-Stokes fluid sim.
const CHROMA = {
  enabled: false,        // ← master switch for the chromatic layer
  color: 0xff3300,       // the mask color (fixed red)
  ground: 0.25,          // how much the flat ground takes the color (0 = relief only)
  falloff: 0.55,         // trail width (screen fraction ×0.5)
  dissipation: 0.975,    // trail lifetime (a touch longer than the reveal)
  boost: 8,              // HDR accumulation cap — drives the site's fluid.b * 0.15 range
};

// ver2 WINE material (per spec):
// — body = PURE hue, never washed out by light: shading only modulates value
//   around 1.0 (ambient floor 0.55 → 1.0 via a fixed directional light)
// — semi-matte finish with a light metallic sheen: metallic 0.34
//   (0 = matte ink, 1 = steel glint) drives Blinn-Phong exponent 48 → 14
//   and the highlight color (lightened wine → white)
// — the highlight is a cursor-bound point light, radius ~0.6 screen, intensity 1
const WINE = {
  enabled: true,
  blend: 0.5,                    // 0 = pure ver1 plaster look … 1 = full wine material
  color: 0x650003,               // Wine
  metallic: 0.34,                // 0 = матовые чернила … 1 = стальной блик (tints the highlight hue)
  roughness: 0.7,                // 0 = mirror-smooth … 1 = fully matte (shapes/dims the highlight itself)
  normalStrength: 1.6,           // amplifies the baked normal's xy before lighting — a second, roughness-
                                  // independent lever for how visible the relief-driven shading reads
  lightDir: [0.35, 0.55, 0.75],  // fixed directional light: top-right-front
  ambient: 0.55,                 // shadow floor (нижний порог тени)
  lightRadius: 0.6,              // cursor highlight falloff (screens)
  intensity: 1.3,                // cursor highlight strength
  grooveGray: [0.02, 0.12],      // smoothstep range on relief slope: below = flat wall (wine red shows),
                                  // above = the carved relief itself (stays gray — its own baked shading
                                  // + the metallic specular ride on top, unpainted so the relief detail reads)
};

// athens-26 metallic sheen (week.wild.plus/athens-26), layered ON TOP of the wine
// above: a cursor-following point light Blinn-Phongs the baked normals, the metal
// zone settles toward ambient and base-tinted highlights sweep with the cursor.
// Because it runs after the wine mix, `metalBase = color * tint` picks up the wine
// red as its body — a red metal, not a chrome overlay. That's why `tint` is
// neutral here where ver1 (whose base is grey plaster) has to tint it red itself.
// Note WINE already carries its own cursor highlight (metallic/roughness/intensity);
// the two stack. If the highlight reads too hot, lower WINE.intensity first — it's
// the softer of the two — before touching lightIntensity here.
const METAL = {
  enabled: true,         // ← master switch for the metallic layer
  tint: 0xffffff,        // neutral: keep the wine hue underneath (ver1 uses 0xd42a10)
  strength: 0.85,        // wild: metallic — also the layer's blend weight
  roughness: 0.55,       // 0 = mirror-tight glint … 1 = broad satin sheen. Shapes and
                          // dims the highlight independently of `strength`; 0.55 matches
                          // the site's fixed spec exponent of 16, so it is the neutral value
  lightIntensity: 0.4,   // wild: lightIntensity
  lightRadius: 1.5,      // wild: lightRadius (aspect-corrected screen units)
  ambient: 0.75,         // wild used .25 against grey plaster; raised here so the
                          // layer doesn't crush the wine (which has its own .55 floor)
  lightColor: 0xffffff,  // wild: lightColor
};

// Where the wine color is allowed to show is no longer guessed from the baked
// normals (reliefWeight/raisedWeight) — it's read straight from the original
// vector artwork (../../Pattern filled (4).svg), rasterized onto the plate's UV
// space (pattern-mask.png, white = inside the pattern). Registered against
// normal.png's actual slope/edge signal (the real geometry's groove outline —
// normal.png has no alpha channel, so heightMask was always a no-op; this is
// ground truth instead) by maximizing normalized cross-correlation between the
// pattern's fill boundary and that groove outline — needed both a scale and an
// offset correction, not just translation.
// That correction is now baked directly INTO pattern-mask.png (a one-time affine
// resample), not applied at sample time: doing it as a runtime repeat/offset
// pushed sampled UV outside [0,1] near the plate's left edge, and this texture
// isn't tileable (its own left/right edges don't match — solid black vs solid
// white), so RepeatWrapping there drew a hard seam right across the plate. The
// baked version reads at a plain 1:1 UV with a clean, stable background fill for
// the sliver the source raster didn't cover, so no wrap mode has to do anything
// clever, and ClampToEdge is safe again.
const PATTERN_MASK = {
  enabled: true,
  offset: [0, 0],
  repeat: [1, 1],
  softness: 0.06,          // antialiasing width across the mask edge, in mask-value units
};

const ASSETS = './assets/';

// DEFAULT = the user's model (ver1/bakes/* produced by scripts/bake_levels.py).
// Open ver1/index.html?site to see the original immersive-g wall for comparison.
const USE_CUSTOM = true; // packaged build: custom model only
// ver2 has its own bakes — produced by .\rebake2.ps1
const CUSTOM = {
  model: './bakes/model.glb',
  bake1: './bakes/bake1.png',
  bake2: './bakes/bake2.png',
  meta: './bakes/meta.json',
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
      // HalfFloat everywhere: float textures are not linearly filterable on many
      // iOS GPUs — sampling them returns (0,0,0,1), which reads as "fully revealed"
      type: THREE.HalfFloatType,
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
uniform sampler2D tNormalMap;    // camera-space normals + height mask (bake)
uniform vec2 uNormalMapTexel;    // 1/width, 1/height of tNormalMap
uniform float uNormalBlurRadius; // blur radius in texels, 0 = off
uniform float uWallUvOffset;     // texels to step walls inward off the outline sliver
uniform float uReliefHeight;     // object-space height of the relief (vPos.z max)
uniform float uShadowFloor;      // cast-shadow darkness below this is haze, cut to nothing
uniform float uShadowStrength;   // overall darkness of the (cleaned) cast shadow
uniform float uMetalRoughness;   // 0 = mirror-tight metal glint, 1 = broad satin sheen
uniform float uMetalness;        // 0 = wine only, 1 = full athens-26 metal on the relief
uniform vec3 uMetalTint;         // metal body tint (white = keep the wine hue)
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform float uLightRadius;
uniform float uMetalAmbient;
uniform sampler2D tPatternMask;  // rasterized original SVG pattern, fit to plate UV
uniform vec2 uPatternOffset;
uniform vec2 uPatternRepeat;
uniform float uPatternSoftness;
uniform float uPatternMaskLoaded; // 0 until the mask image has actually loaded
uniform float uWineEnabled;      // 0 = plaster only, 1 = wine material on revealed relief
uniform float uWineBlend;        // 0 = pure ver1 plaster … 1 = full wine
uniform vec2 uCursorPos;         // eased cursor, uv space y-up (drives the highlight)
uniform vec3 uWineColor;         // #650003
uniform float uWineMetallic;     // 0.34: 0 = matte ink, 1 = steel glint (highlight hue)
uniform float uWineRoughness;    // 0.95: 0 = mirror-smooth, 1 = fully matte (highlight shape/strength)
uniform float uWineNormalStrength; // amplifies baked-normal xy before lighting
uniform vec2 uGrooveGrayRange;   // slope smoothstep: below = flat (red), above = relief (stays gray)
uniform vec3 uWineLightDir;      // fixed directional light (0.35, 0.55, 0.75)
uniform float uWineAmbient;      // 0.55 shadow floor
uniform float uWineLightRadius;  // 0.6 screens
uniform float uWineIntensity;    // 1.0
uniform float uScreenScroll;
uniform float uTextureStrength;
uniform float uGradientStrength;
uniform float uOpacity;
uniform float uSwitchColorTransition;
uniform float uFastScroll;
uniform sampler2D tFluidFlowmap;
uniform vec3 uChromaColor;       // fixed mask color (site derives hue from normals)
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
  // (site derives the hue from the normal — hueShift -0.52 → yellow/red family;
  //  we use a fixed color instead, with a hint of normal-based shading kept)
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
// thin, sparsely-tessellated swept ribbon pieces bake visible per-facet banding
// into EVERY Cycles render pass (color levels and normals alike) — a small
// tent-filter blur across neighboring bake texels softens that residual
// variation at runtime without needing a rebake. 3x3 tent: center 4, edge 2,
// corner 1 (sum 16).
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
  // The bakes and the pattern mask are FRONTAL projections, sampled through a
  // planar UV built from base X,Y. The relief's side walls are extruded straight
  // along +Z from the outline, so a wall's top and bottom vertices share
  // IDENTICAL X,Y — their UV area is exactly zero (measured: half the triangles,
  // ~50% of the surface). Every fragment down a wall therefore samples the same
  // 1-D sliver of texture: the outline itself, which is the highest-contrast
  // line in the bake (lit top face meeting cast shadow) and the red/grey
  // boundary in the mask. Smeared down the wall that reads as vertical stripes
  // and a grey/red mixture instead of one solid surface.
  //
  // Fix: for wall fragments, step the sample point a few texels back along the
  // wall's own outward normal, into the top face the wall belongs to, so the
  // wall inherits that face's tone and mask instead of the boundary sliver.
  // vEye is built from the UNdisplaced position, so this normal describes the
  // fully-extruded shape and stays stable as the reveal animates.
  vec3 gNormal = normalize(cross(dFdx(vEye), dFdy(vEye)));
  if (dot(gNormal, vEye) > 0.0) gNormal = -gNormal;      // resolve winding: face the camera
  float wallness = 1.0 - clamp(abs(gNormal.z), 0.0, 1.0); // 0 = top face, 1 = edge-on wall
  vec2 wallDir = length(gNormal.xy) > 1e-4 ? normalize(gNormal.xy) : vec2(0.0);
  vec2 uvSurface = vUv - wallDir * uNormalMapTexel * uWallUvOffset * wallness;

  // Purely geometric "is this fragment part of the raised relief, or the flat
  // base plate" — a wall (steep) or anything standing proud of the plate. Both
  // signals are registered by construction, unlike the pattern texture. Computed
  // once here because two very different things need it: keeping the plaster
  // clean (just below) and driving the wine/metal coverage (further down).
  float raisedGeo = smoothstep(0.12, 0.45, vPos.z / max(uReliefHeight, 1e-4));
  float reliefGeo = max(smoothstep(0.35, 0.7, wallness), raisedGeo);

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
  // The baked levels carry the relief's cast shadow onto the flat base plate.
  // The shadow itself is wanted — it's what sits the relief on the wall — but the
  // bake's soft sun (20 deg key + a very broad 60 deg fill) spreads a wide, faint,
  // low-contrast haze around the dark core, and the reveal's soft blob edge smears
  // that further. The haze is what reads as dirt, not the shadow.
  //
  // So SHAPE the shadow rather than removing it: measure how much darker than
  // clean plaster this fragment is, cut everything below a floor (that faint tail
  // IS the dirt), then rescale what survives back to full range. A gamma was
  // tried first and was wrong — it dims the mid-tones along with the haze, so the
  // shadow reads as washed out. Floor-and-rescale deletes the haze while the real
  // shadow keeps its strength. Only the flat plate is touched; the relief keeps
  // its full baked shading.
  float plateMask = 1.0 - clamp(reliefGeo, 0.0, 1.0);
  float plasterBase = 0.54504;                                   // what flat wall bakes to
  float shade = clamp((plasterBase - o) / plasterBase, 0.0, 1.0); // 0 = clean, 1 = black
  float shadeClean = clamp((shade - uShadowFloor) / max(1.0 - uShadowFloor, 1e-4), 0.0, 1.0);
  shadeClean *= uShadowStrength;
  o = mix(o, plasterBase * (1.0 - shadeClean), plateMask);
  color += vec3(o);
  vec2 uvPlaster = vPos.xy / uPlasterScale;
  float plaster = texture2D(tPlaster, uvPlaster).g;
  color = mix(color, color * plaster, uTextureStrength);
  color += gradient * 0.7 * uGradientStrength;
  color = color * uBrightnessFactor + uBrightnessOffset;

  // --- metallic layer: matcap on the revealed relief, using baked normals ---
  // baked normal is at FULL extrusion; the normal for the current squash follows
  // from scaling the height field: n' ∝ (s·nx/nz, s·ny/nz, 1)
  // --- WINE material (ver2 spec) ---------------------------------------------
  // body = pure hue, shading only modulates value (ambient floor → 1.0), so the
  // wine hue is never washed out by light
  vec4 nSample = blurTex(tNormalMap, uvSurface, bakeTexel);
  vec3 nFull = normalize(nSample.xyz * 2.0 - 1.0);
  float heightMask = nSample.a;                                   // 0 = wall plate, 1 = raised element
  float squash = mix(0.05, 1.0, extrude);
  // normalStrength exaggerates the bump before lighting — independent of roughness,
  // this is the second lever for how visible the relief-driven shading reads
  vec3 nRel = normalize(vec3(nFull.xy * uWineNormalStrength * (squash / max(nFull.z, 0.15)), 1.0));

  // slope signal, kept only as the geometric fallback mask further down (used
  // when the pattern texture hasn't loaded yet) — no longer excludes the carved
  // relief from the wine color: red is back across the whole revealed pattern,
  // raised groove included.
  float grooveWeight = smoothstep(uGrooveGrayRange.x, uGrooveGrayRange.y, 1.0 - nFull.z);

  // fixed directional light: diffuse light/shadow across the relief
  float wineDiff = max(dot(nRel, normalize(uWineLightDir)), 0.0);
  vec3 wineBody = uWineColor * mix(uWineAmbient, 1.0, wineDiff);

  // cursor-bound Blinn-Phong highlight. Two independent knobs, standard PBR split:
  // metallic tints the highlight hue (matte ink → warm steel), roughness shapes and
  // dims it (mirror-tight spike → wide, faint sheen) regardless of metallic. Not
  // gated by grooveWeight — the highlight rides over both the red fill and the
  // gray relief, since the relief is where the real normal variation (and so the
  // most visible sheen) actually lives.
  vec2 arVec = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 lightDelta = uCursorPos * arVec - uvScreen * arVec;
  float lightDist = length(lightDelta);
  vec3 lightDir = normalize(vec3(lightDelta, 0.4));
  vec3 halfVec = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float rough = clamp(uWineRoughness, 0.02, 1.0);
  float specExp = mix(96.0, 6.0, rough);              // smooth → tight spike; rough → broad, soft
  float specStrength = pow(1.0 - rough, 1.3);         // rough surfaces catch a dimmer, not absent, highlight
  float spec = pow(max(dot(nRel, halfVec), 0.0), specExp) * specStrength;
  float atten = 1.0 - smoothstep(0.0, uWineLightRadius, lightDist);
  vec3 lightenedWine = mix(uWineColor, vec3(1.0), 0.6);
  vec3 specColor = mix(lightenedWine, vec3(1.0), uWineMetallic);  // 0.34 → warm steel
  vec3 wineColor = wineBody + specColor * spec * uWineIntensity * atten;

  float reliefWeight = grooveWeight;                              // sloped surfaces (fallback)
  float raisedWeight = smoothstep(0.15, 0.6, heightMask);         // whole raised elements (fallback)
  // the pattern SVG is the ground truth for *where* wine shows — it's the original
  // vector artwork the OIT-baked relief was built from, so its silhouette is a much
  // cleaner stencil than guessing from normals/height. Geometric weight stays only
  // as a fallback so the layer degrades gracefully if the mask texture is missing.
  float patternRaw = texture2D(tPatternMask, uvSurface * uPatternRepeat + uPatternOffset).r;
  float patternMask = smoothstep(0.5 - uPatternSoftness, 0.5 + uPatternSoftness, patternRaw);
  float geoWeight = max(reliefWeight, raisedWeight);
  float placeWeight = mix(geoWeight, patternMask, uPatternMaskLoaded);
  // The pattern texture alone is not enough to say where the wine belongs. A side
  // wall's own UV is the degenerate outline sliver, and the inward step that
  // rescues it overshoots on thin strands, landing outside the shape again — the
  // wall then reads unmasked, i.e. grey. The mask is also registered to the
  // geometry only approximately, so at a silhouette it falls short of the real
  // edge and leaves a thin grey rim. reliefGeo answers both from the geometry
  // itself: a wall exists ONLY where a shape was extruded, and anything standing
  // proud of the plate is extruded pattern. The flat plate stays untouched.
  placeWeight = max(placeWeight, reliefGeo);
  float wineMask = clamp(extrude, 0.0, 1.0) * placeWeight * uWineEnabled;
  color = mix(color, clamp(wineColor, 0.0, 1.0), wineMask * uWineBlend);

  // --- athens-26 metallic sheen, layered on top of the wine ------------------
  // Runs AFTER the wine mix on purpose: metalBase reads the already-wine-coloured
  // color, so this reads as red metal rather than a chrome overlay. Reuses the
  // cursor light vectors the wine block already built (lightDir/halfVec/lightDist)
  // and the same placeWeight, so the sheen covers the displaced geometry exactly
  // as the wine does — walls, edges and caps included, no second coverage rule.
  // roughness shapes AND dims the metal highlight, independently of how metallic
  // it is — same split as the wine layer above. The site's fixed exponent of 16
  // sits around roughness 0.55, so that stays the neutral value here.
  float mRough = clamp(uMetalRoughness, 0.02, 1.0);
  float mSpecExp = mix(64.0, 6.0, mRough);        // smooth → tight glint, rough → broad sheen
  float mSpecStrength = pow(1.0 - mRough, 1.3);   // rough surfaces catch a dimmer, not absent, highlight
  float cursorDiff = max(dot(nRel, lightDir), 0.0);
  float cursorSpecMtl = pow(max(dot(nRel, halfVec), 0.0), mSpecExp) * mSpecStrength;
  float cursorAtten = 1.0 - smoothstep(0.0, uLightRadius, lightDist);
  float effMetalSpec = cursorSpecMtl * uLightIntensity * 2.0 * cursorAtten;
  float effMetalDiff = cursorDiff * uLightIntensity * 0.25 * cursorAtten;
  vec3 metalBase = color * uMetalTint;
  vec3 metalHighlight = mix(uLightColor * effMetalSpec, metalBase * effMetalSpec, 0.75);
  vec3 metallicColor = metalBase * (uMetalAmbient + effMetalDiff) + metalHighlight;
  float metalMask = clamp(extrude, 0.0, 1.0) * placeWeight * uMetalness;
  color = mix(color, clamp(metallicColor, 0.0, 1.0), metalMask);

  vec3 dFdxPos = dFdx(vEye);
  vec3 dFdyPos = dFdy(vEye);
  vec3 normal = normalize(cross(dFdxPos, dFdyPos));
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
const tPlaster = loadTex(ASSETS + 'plaster.jpg', true);
const tMaskNoiseWall = loadTex(ASSETS + 'rgb-attenuation-0,9.png', true);  // fast-scroll noise
const tFlowNoise = loadTex(ASSETS + 'mask-noise.png', true);               // flowmap stamp noise
const tFluidBlack = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
tFluidBlack.needsUpdate = true;
const tFlatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
tFlatNormal.needsUpdate = true;   // flat "up" normal → metal layer is a no-op until bound

// original pattern SVG (../Pattern filled (4).svg), rasterized 1:1 onto plate UV —
// see PATTERN_MASK above. uPatternMaskLoaded flips to 1 only once it's actually
// decoded, so every wall section falls back to the old geometric mask until then.
const uPatternMaskLoaded = { value: 0 };
const tPatternMask = texLoader.load('./pattern-mask.png', () => {
  if (PATTERN_MASK.enabled) uPatternMaskLoaded.value = 1;
});
tPatternMask.wrapT = THREE.RepeatWrapping;         // matches bake/normal: vertically periodic
// the registration offset/scale is now baked into the texture itself (see
// PATTERN_MASK above), sampled at a plain 1:1 UV — so, like bake1/bake2/
// normalMap, this is safe to clamp: it's the source raster's own edges we'd hit,
// not an out-of-[0,1] runtime transform, and the uncovered sliver was filled
// with a clean background value rather than mismatched wrapped content.
tPatternMask.wrapS = THREE.ClampToEdgeWrapping;
tPatternMask.colorSpace = THREE.NoColorSpace;      // raw mask value, not a color to decode

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
  size: 512,      // was the class default (256) — vertex-level displacement samples this
                   // directly, and at the plate's fine detail + up to 2.4x camera zoom, 256px
                   // texels were visible as blocky/jaggy steps in the revealed edge ("glitchy")
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
    // was DoubleSide: with mixed-winding source geometry, FrontSide culled
    // backward pieces and revealed the background through them (gray streaks).
    // DoubleSide fixed that but rendered the wrongly-facing "interior" pieces
    // too, which then z-fight the correct front wall at full extrusion —
    // vertical stripes that scale with reveal depth. Now that the SVG source
    // and sweep produce consistent winding, try FrontSide again: it should
    // just cull the (hopefully now rare/absent) bad pieces cleanly instead of
    // rendering-and-fighting them. If background gaps reappear, revert to
    // DoubleSide — that means winding is still inconsistent somewhere.
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
      uNormalMapTexel: { value: new THREE.Vector2(1, 1) },   // set once the real map loads
      uNormalBlurRadius: { value: 2.5 },
      // ~6 texels clears the outline's antialiased boundary and lands on solid
      // top face. Too large overshoots the thinner ribbon strands entirely and
      // washes them out, so this wants to stay just past the edge, not deep in.
      uWallUvOffset: { value: 6.0 },
      uReliefHeight: { value: 1.0 },   // real value bound once the model's bounds are known
      // cast shadow on the plaster. floor = where haze ends and shadow begins:
      // raise it if the plaster still looks grubby, lower it toward 0 for the raw
      // bake. strength scales what survives — push past 1 for a heavier shadow.
      uShadowFloor: { value: 0.07 },
      uShadowStrength: { value: 1.15 },
      uMetalRoughness: { value: METAL.roughness },
      uMetalness: { value: 0 },        // metal off unless custom mode enables it
      uMetalTint: { value: new THREE.Color().setHex(METAL.tint, THREE.LinearSRGBColorSpace) },
      uLightColor: { value: new THREE.Color().setHex(METAL.lightColor, THREE.LinearSRGBColorSpace) },
      uLightIntensity: { value: METAL.lightIntensity },
      uLightRadius: { value: METAL.lightRadius },
      uMetalAmbient: { value: METAL.ambient },
      tPatternMask: { value: tPatternMask },
      uPatternOffset: { value: new THREE.Vector2(...PATTERN_MASK.offset) },
      uPatternRepeat: { value: new THREE.Vector2(...PATTERN_MASK.repeat) },
      uPatternSoftness: { value: PATTERN_MASK.softness },
      uPatternMaskLoaded,
      uWineEnabled: { value: 0 },                            // wine off unless custom mode enables it
      uWineBlend: { value: WINE.blend },
      uCursorPos: { value: flowmap.mouse },                  // shared, eased — updates live
      // setHex with LinearSRGB = keep raw values: our shader works in display
      // space, and default color management would darken #650003 to near-black
      uWineColor: { value: new THREE.Color().setHex(WINE.color, THREE.LinearSRGBColorSpace) },
      uWineMetallic: { value: WINE.metallic },
      uWineRoughness: { value: WINE.roughness },
      uWineNormalStrength: { value: WINE.normalStrength },
      uGrooveGrayRange: { value: new THREE.Vector2(...WINE.grooveGray) },
      uWineLightDir: { value: new THREE.Vector3(...WINE.lightDir) },
      uWineAmbient: { value: WINE.ambient },
      uWineLightRadius: { value: WINE.lightRadius },
      uWineIntensity: { value: WINE.intensity },
      uScreenScroll,
      uScrollSpeed,
      uTextureStrength,
      uGradientStrength,
      uOpacity,
      uSwitchColorTransition,
      uFastScroll,
      tFluidFlowmap: fluidmap ? fluidmap.uniform : { value: tFluidBlack },
      uChromaColor: { value: new THREE.Color(CHROMA.color) },
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
  // meta.json is fetched uncached; its bake timestamp versions every asset URL, so
  // a rebake automatically busts the browser cache — no hard reload needed
  const metaPromise = fetch(CUSTOM.meta, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  metaPromise.then((meta) => {
  const v = '?v=' + encodeURIComponent(meta.baked || Date.now());
  const bake1 = loadTex(CUSTOM.bake1 + v);
  const bake2 = loadTex(CUSTOM.bake2 + v);
  for (const t of [bake1, bake2]) {
    t.colorSpace = THREE.SRGBColorSpace;     // same decode chain as the GLB bakes
    t.wrapT = THREE.RepeatWrapping;          // bake is vertically periodic → filtering
    t.wrapS = THREE.ClampToEdgeWrapping;     //   at the seam samples the neighbor
  }
  const normalMap = loadTex('./bakes/normal.png' + v);   // raw vectors — no color space
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
  const depthMult = meta.depthMult || CUSTOM.depthMult;
  gltfLoader.load(CUSTOM.model + v, (gltf) => {
    let geometry = null;
    gltf.scene.traverse((o) => { if (o.geometry && !geometry) geometry = o.geometry; });
    if (!geometry) return failLoading(new Error('no mesh in custom model'));
    // the export splits a vertex into duplicates (same position, different
    // normal/uv) at every hard-shaded edge — normal and glTF-standard, and
    // harmless for shading here (color comes from the baked 2D textures via a
    // planar UV we recompute below, never from vertex normals). But at full
    // relief extrusion a duplicate can sit a hair off from its twin and open a
    // visible crack — thin bright tears cutting across the red fill, background
    // showing through. Drop normal/uv (unused) and weld by position only so
    // adjacent triangles actually share vertices again.
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
      // geometry was translated to min.z = 0, so b.max.z IS the relief height —
      // lets the shader read vPos.z as a normalized "how raised is this fragment"
      mesh.material.uniforms.uReliefHeight.value = b.max.z;
      mesh.material.uniforms.uWineEnabled.value = WINE.enabled ? 1 : 0;
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

// ---------------------------------------------------------------- scroll → zoom
let scrollPx = 0;                       // accumulated scroll, clamped to the zoom range
const zoomSpring = { x: 0, v: 0 };      // sprung zoom progress 0..1
const clampScroll = () => {
  scrollPx = Math.max(0, Math.min(ZOOM.screens * innerHeight, scrollPx));
};
addEventListener('wheel', (e) => { scrollPx += e.deltaY; clampScroll(); }, { passive: true });
let dragY = null;
addEventListener('pointerdown', (e) => { dragY = e.clientY; });
addEventListener('pointerup', () => { dragY = null; });
addEventListener('pointermove', (e) => {
  if (dragY !== null && e.pointerType !== 'mouse') {
    scrollPx += (dragY - e.clientY) * 2;
    dragY = e.clientY;
    clampScroll();
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
  camera.zoom = 1 + (ZOOM.max - 1) * zoomSpring.x;
  camera.updateProjectionMatrix();

  // flow-map feed (exact site order & factors; wall no longer travels → no scroll offset)
  flowmap.mouse.lerp(tracker.normalFlip, CONFIG.flowmap.mouseEase);
  flowmap.velocity.lerp(tracker.velocity, tracker.velocity.length() ? 0.1 : 0.04);
  flowmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
  flowmap.update(0);
  if (fluidmap) {
    fluidmap.aspect = flowmap.aspect;
    fluidmap.mouse.copy(flowmap.mouse);
    fluidmap.velocity.copy(flowmap.velocity);
    fluidmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
    fluidmap.update(0);
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
