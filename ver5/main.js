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
const BRIGHTNESS = 1.1;             // whole-scene multiply, 1 = Original. No tone mapping:
                                    //   the flat wall sits at ~0.77, so >1.25 clips to white
const SCROLL_WHEEL_MULT = 0.00045;  // wheel px → rows (feel-tuned, site uses its own smooth-scroll rig)
const SCROLL_SMOOTH = 0.035;

// ---------------------------------------------------------------- zoom
// Scroll drives a spring-damped camera zoom instead of travelling the wall.
const SCROLL_TRAVELS = false;     // true = Original's infinite vertical travel instead
const BRUSH_TRACKS_ZOOM = true;   // brush radius scales with zoom, so the revealed
                                  //   patch stays a constant size on the wall.
                                  //   false = the site's own screen-space behaviour
const ZOOM = {
  max: 1.6,                                     // scroll-in target
  screens: 6,                                   // scroll distance for full zoom, in viewport heights
  spring: { stiffness: 80, damping: 22, mass: 0.7 },
};

// ---------------------------------------------------------------- ambient pass
// Idle motion: a second cursor wanders the wall on its own, stamping the flow-map's
// second channel (mouse2 → .a). ?amb runs passes back to back with a title counter.
// Values below are the tamed set; the site's own are 3 / 2 / 12 at blend 1, pause [1,3].
const AMBIENT = {
  enabled: true,
  pause: [6, 14],             // seconds of stillness between passes (site: [1, 3])
  segments: [1, 3],           // site: floor(random*3)+1
  durMid: [0.8, 1.0],         // site: lerp(.8,1) for a segment followed by more
  durLast: [0.7, 0.8],        // site: lerp(.7,.8) for the closing segment
  radius: [0.7, 0.9],         // site: lerp(.7,.9), in [-1,1] space → uv = v/2 + .5
  roughMid: 1.0,              // site: 3   (rough strength, mid-pass segments)
  roughLast: 0.7,             // site: 2   (closing segment)
  roughPoints: 5,             // site: 12  (sample points per second of travel)
  roughBlend: 0.35,           // 0 = perfectly smooth travel, 1 = the full rough curve
  chroma: false,              // let the pass take the red mask too (false = reveal only)
};
const FORCE_AMBIENT = new URLSearchParams(location.search).has('amb');

// ---------------------------------------------------------------- red mask
// The cursor drags a coloured trail (its own flow-map) that only paints where the
// relief's walls and creases open the mask up.
const CHROMA = {
  enabled: true,
  // The colour is GENERATED from the surface normal, as the site does it: the normal
  // is encoded as a colour, converted to HSV and its hue rotated. That is what makes
  // it shimmer across the relief instead of reading as flat paint. Only the HUE of
  // `color` is used — brightness comes from the normal, which is why it stays visible
  // on a near-white wall where a dark hex could not.
  color: 0x650003,          // hue source (its own darkness is irrelevant here)
  hueRange: 0.15,           // width of the hue swing across the surface. 1 = the site's
                            //   full swing, which sends side walls right round to green
                            //   and blue; 0.35 reaches orange and magenta; 0.15 stays
                            //   red throughout (340-16deg); 0 = one flat colour
  colorRange: 2.0,          // site value: z exaggeration before the normal is recoloured
  saturation: 1.0,          // multiplies the generated saturation
  value: 1.0,               // multiplies the generated brightness
  normalMap: 1.0,           // how much the BAKED normal map drives where the colour
                            //   lands and how it is shaded. 0 = geometry normals only,
                            //   which only see the mesh's own vertical walls.
  ground: 0.08,             // how much the flat ground takes the colour (0 = relief only)

  // WHERE the colour lands. Site values throughout — a crisp saturated rim on the
  // steep walls, plus the shadowed creases.
  // The site keys the rim off a fresnel exponent, which needs surfaces that go nearly
  // edge-on. This relief is 1% of plate width deep, so it never gets there: measured
  // on the bake, the most tilted 1% of the frame is only |nz| 0.73, where the exponent
  // wants below 0.02 — the rim was landing on ~0% of the frame at any sharpness.
  // So the rim ramps directly over the tilt instead, calibrated to these normals:
  // 0.02-0.20 covers the 12.5% of the frame that is genuinely sloped.
  width: -2.0,              // THE THICKNESS CONTROL, in bake texels (2048 across the
                            //   plate). Negative erodes the band — thinner; positive
                            //   dilates — thicker; 0 leaves it as the geometry gives it.
                            //   A real width: independent of how steep the relief is,
                            //   so it keeps working where tiltRange would collapse.
  tiltRange: [0.12, 0.28],  // which slopes count as rim at all. Measured on this bake:
                            //   [0.02,0.20] paints 12.5% of the frame, [0.12,0.28] 6.8%,
                            //   [0.16,0.32] 4.0%, and past ~[0.20,0.36] it collapses to
                            //   0.1% — the relief has no steeper surface left to catch.
                            //   Use `width` for thickness; leave this as the selector.
  edgeOpacity: 0.98,        // how hard the rim reaches full colour
  revealGate: [0.30, 0.80], // extrude range over which the colour is allowed in, so it
                            //   stays inside the revealed contour. Raise the pair to
                            //   keep it further inside and thinner; [0, 0] = no gate.
                            //   Unlike tiltRange this thins by reveal depth, not by
                            //   surface slope, so it does not hit the relief's limit.
  shadowRange: [0.2, 0.42], // tonal band of the bake counted as "crease"
  shadowOpacity: 0.25,      // how much colour the creases take (ver3 used 0.4)
  relief: 0,                // OFF: this reads the height mask from normal.webp's alpha,
                            //   and the bake cannot currently produce one — the height
                            //   pass returns a constant z, so the mask came out uniform
                            //   and the map now ships as RGB. With no mask, alpha reads
                            //   as 1 and any value here would flood the whole revealed
                            //   patch, floor included. Re-enable once the bake's height
                            //   pass is fixed. The rim (tiltRange) carries the relief
                            //   for now.

  // HOW STRONG. Both were hardcoded in the shader; site values kept.
  amplitude: 0.57,          // master opacity of the whole fill
  fluidMagnitude: 0.15,     // how fast the trail saturates to full colour

  falloff: 0.35,            // trail width (screen fraction ×0.5), against the reveal's
                            //   own 0.38. Do NOT shrink this to thin the colour down:
                            //   a narrow trail accumulates less density, so the effect
                            //   comes out smaller AND weaker. Thin it with tiltRange.
  dissipation: 0.975,       // trail lifetime
  boost: 8,                 // HDR accumulation cap
};

// only the hue is taken from CHROMA.color; the effect generates its own S and V
const chromaHue = () => {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(CHROMA.color).getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.h;
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
  normal: './bakes/normal.webp', // camera-space normals + height mask in alpha
  meta: './bakes/meta.json',    // depthMult etc. — written by the bake, no manual sync
  depthMult: 6.25,              // fallback if meta.json is missing
  // How far the flat plate sits above the reveal's scale origin, as a fraction of
  // relief depth — the reveal scales z about 0, so a plate at 0 is pinned and cannot
  // drift. Travel = 0.95 * groundLift * depthMult * reliefDepth.
  // 0 = pinned, 0.75 = Original's own ratio, 1.5+ starts reading as the wall swimming.
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
        uDeltaMult: { value: 1 },
        tNoise,
        uTime,
        uAspect: { value: 1 },
        uMouse: { value: this.mouse },
        uVelocity: { value: this.velocity },
        uMouse2: { value: this.mouse2 },
        uVelocity2: { value: this.velocity2 },
        uClampMax: { value: clampMax },
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
uniform sampler2D tNormalMap;
uniform float uChromaHue;
uniform float uChromaHueRange;
uniform float uChromaColorRange;
uniform float uChromaSaturation;
uniform float uChromaValue;
uniform float uChromaNormalMap;
uniform float uChromaGround;
uniform vec2 uChromaTiltRange;
uniform vec2 uChromaRevealGate;
uniform vec2 uNormalMapTexel;
uniform float uChromaWidth;
uniform float uChromaEdgeOpacity;
uniform vec2 uChromaShadowRange;
uniform float uChromaShadowOpacity;
uniform float uChromaRelief;
uniform float uChromaAmplitude;
uniform float uChromaFluidMag;
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
// the rim mask at one point: how sloped the relief is there, at the current reveal
float chromaRim(vec2 uv, float squash){
  vec3 nF = texture2D(tNormalMap, uv).xyz * 2.0 - 1.0;
  vec3 nR = normalize(vec3(nF.xy * (squash / max(nF.z, 0.15)), 1.0));
  return smoothstep(uChromaTiltRange.x, uChromaTiltRange.y, 1.0 - abs(nR.z));
}
vec3 applyFluidEffect(FluidEffectConfig config, vec3 color, vec4 fluid, vec2 uv, float time, float mask, vec3 normal){
  float fluidEdges = smoothstep(0.0, 1.0, fluid.b * uChromaFluidMag);
  vec2 uvLines = uv + time * 0.01 * config.linesSpeed;
  uvLines.x = uvLines.x * 1000.0 / config.linesScale;
  uvLines.y = sin(uvLines.y * 50.0 * config.linesWaveLength) * 20.0 / config.linesScale;
  float lines = smoothstep(-1.0, 0.5, sin(uvLines.x + uvLines.y));
  lines = mix(1.0, lines, config.linesStrength);
  vec3 normalVector = normal;
  normalVector.z *= uChromaColorRange;
  normalVector = normalize(normalVector);
  vec3 normalColor = (normalVector + 1.) / 2.;
  vec3 hsv = rgb2hsv(normalColor);
  // The site rotates this hue to a gold band. Here the band is re-centred on the
  // chosen hue and its width scaled: 0.6667 is the hue a camera-facing normal
  // produces, so it is the pivot the swing opens around. The distance from the pivot
  // is measured the short way round the wheel — a plain subtraction sends hues past
  // the wrap point off in the wrong direction.
  float dHue = fract(hsv.x - 0.6667 + 0.5) - 0.5;
  hsv.x = fract(uChromaHue + dHue * uChromaHueRange);
  hsv.y = clamp(hsv.y * uChromaSaturation, 0.0, 1.0);
  hsv.z = clamp(hsv.z * uChromaValue, 0.0, 1.0);
  vec3 effectColor = hsv2rgb(hsv);
  color = mix(color, effectColor, mask * fluidEdges * lines * uChromaAmplitude);
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
  // The geometry normal only knows the mesh's own vertical walls, so the colour can
  // only catch there. The baked normal map carries the relief's real surface — on the
  // raised shapes AND on the floor — but it is baked at full extrusion, so squash its
  // xy by the current reveal before use (same analytic squash the bake assumes).
  vec4 nSample = texture2D(tNormalMap, vUv);
  vec3 nFull = nSample.xyz * 2.0 - 1.0;
  float squash = mix(0.05, 1.0, extrude);
  vec3 nRel = normalize(vec3(nFull.xy * (squash / max(nFull.z, 0.15)), 1.0));
  vec3 chromaNormal = normalize(mix(normal, nRel, uChromaNormalMap));
  float rimHere = chromaRim(vUv, squash);
  // Thickness, in bake texels: erode the band to thin it, dilate to widen it. Unlike
  // the tilt thresholds this is a real width — it does not depend on how steep the
  // relief gets, so it keeps working where raising tiltRange would collapse the band.
  float rw = abs(uChromaWidth);
  if (rw > 0.001) {
    vec2 tx = uNormalMapTexel * rw;
    float s1 = chromaRim(vUv + vec2( tx.x, 0.0), squash);
    float s2 = chromaRim(vUv + vec2(-tx.x, 0.0), squash);
    float s3 = chromaRim(vUv + vec2(0.0,  tx.y), squash);
    float s4 = chromaRim(vUv + vec2(0.0, -tx.y), squash);
    if (uChromaWidth < 0.0) {
      rimHere = min(rimHere, min(min(s1, s2), min(s3, s4)));   // erode → thinner
    } else {
      rimHere = max(rimHere, max(max(s1, s2), max(s3, s4)));   // dilate → thicker
    }
  }
  float rim = rimHere * uChromaEdgeOpacity;
  float waveMask = max(rim,
    smoothstep(uChromaShadowRange.y, uChromaShadowRange.x, level5) * uChromaShadowOpacity) * uOpacity;
  // the raised shapes themselves, from the height mask baked into normal.webp's alpha,
  // faded in with the reveal so flat wall stays clean
  float raised = smoothstep(0.15, 0.6, nSample.a) * clamp(extrude, 0.0, 1.0);
  waveMask = max(waveMask, raised * uChromaRelief * uOpacity);
  waveMask = max(waveMask, uChromaGround * uOpacity);
  // Confine the colour to the revealed contour. The crease term reads the full-
  // extrusion bake and the ground term is constant, so neither knows whether the
  // relief is actually out — without this gate the red spreads wherever the trail
  // has been, including flat wall, and the red trail outlives the reveal trail.
  waveMask *= smoothstep(uChromaRevealGate.x, uChromaRevealGate.y, extrude);
  vec4 fluid = texture2D(tFluidFlowmap, uvScreen);
  fluid += mix(0., fastScrollNoise.g * 2., uFastScroll);
  color = applyFluidEffect(effectConfig, color, fluid, vUv, uTime, waveMask, chromaNormal);
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
// Original's plaster — the shared plaster.jpg is ver3's 4K marble, a different look
const tPlaster = loadTex(ASSETS + 'plaster_orig_backup.webp', true);
const tMaskNoiseWall = loadTex(ASSETS + 'rgb-attenuation-0,9.webp', true);  // fast-scroll noise
const tFlowNoise = loadTex(ASSETS + 'mask-noise.webp', true);               // flowmap stamp noise
const tFluidBlack = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
tFluidBlack.needsUpdate = true;
// stand-in until bakes/normal.webp loads: (0,0,1) facing the camera, height 0
const tFlatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 0]), 1, 1);
tFlatNormal.needsUpdate = true;

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

// the red trail rides its own flow-map: wider, longer-lived, and allowed to
// accumulate past 1 so overlapping strokes deepen instead of flattening
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
      tFluidFlowmap: fluidmap ? fluidmap.uniform : { value: tFluidBlack },
      tNormalMap: { value: tFlatNormal },   // replaced with bakes/normal.webp on load
      uChromaHue: { value: chromaHue() },
      uChromaHueRange: { value: CHROMA.hueRange },
      uChromaColorRange: { value: CHROMA.colorRange },
      uChromaSaturation: { value: CHROMA.saturation },
      uChromaValue: { value: CHROMA.value },
      uChromaNormalMap: { value: CHROMA.normalMap },
      uChromaGround: { value: CHROMA.ground },
      uChromaTiltRange: { value: new THREE.Vector2(...CHROMA.tiltRange) },
      uChromaRevealGate: { value: new THREE.Vector2(...CHROMA.revealGate) },
      uChromaWidth: { value: CHROMA.width },
      uNormalMapTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1258) },  // set from meta.res
      uChromaEdgeOpacity: { value: CHROMA.edgeOpacity },
      uChromaShadowRange: { value: new THREE.Vector2(...CHROMA.shadowRange) },
      uChromaShadowOpacity: { value: CHROMA.shadowOpacity },
      uChromaRelief: { value: CHROMA.relief },
      uChromaAmplitude: { value: CHROMA.amplitude },
      uChromaFluidMag: { value: CHROMA.fluidMagnitude },
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
  // raw vectors, not colour — must not be sRGB-decoded
  const normalMap = loadTex(CUSTOM.normal);
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
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
    // z: seat the plate at CUSTOM.groundLift of the relief depth above the origin
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
      mesh.material.uniforms.tNormalMap.value = normalMap;
      // width is measured in bake texels, so it needs the bake's real resolution
      if (meta.res) mesh.material.uniforms.uNormalMapTexel.value.set(1 / meta.res[0], 1 / meta.res[1]);
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
// zoom input: raw scroll pixels, clamped to the zoom range
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
    addZoomScroll((dragY - e.clientY) * 2);   // touch-drag → zoom
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

// ---------------------------------------------------------------- ambient pass
const rnd = (a, b) => a + Math.random() * (b - a);

// Eased 0..1 curve with random wobble; blend mixes clean template vs rough curve
const roughEase = (points, strength, template, blend) => {
  const base = template || ((t) => t);
  const pts = [];
  for (let i = 0; i < points; i++) {
    const x = (i + 1) / (points + 1);
    let y = base(x);
    y += (Math.random() - 0.5) * strength * (4 * x * (1 - x));   // taper the wobble to 0 at both ends
    pts.push({ x, y: Math.max(0, Math.min(1, y)) });
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
    let k = span > 1e-6 ? (t - a.x) / span : 0;
    k = k * k * (3 - 2 * k);
    const rough = a.y + (b.y - a.y) * k;
    return base(t) + (rough - base(t)) * blend;
  };
};
const power2Out = (t) => 1 - Math.pow(1 - t, 2);

// Each segment starts where the last ended, turning by up to ±0.8π
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
    const isLast = i === count - 1;
    const more = !isLast && Math.random() < 0.7;             // site's own 0.7 coin flip
    const dur = more ? rnd(AMBIENT.durMid[0], AMBIENT.durMid[1]) : rnd(AMBIENT.durLast[0], AMBIENT.durLast[1]);
    const d = ambientDirections(prev);
    const pts = Math.max(2, Math.round(dur * AMBIENT.roughPoints));
    const strength = more ? AMBIENT.roughMid : AMBIENT.roughLast;
    const template = isLast ? power2Out : null;              // the closing segment decelerates
    segs.push({
      dur, d,
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
  flowmap.velocity2.set(1, 1);
  if (!ambientPass) {
    ambientWait -= delta;
    // park the second cursor off-screen while idle so it stamps nothing
    if (ambientWait > 0) { flowmap.mouse2.set(-1, -1); return; }
    ambientPass = buildAmbientPass();
    ambientCount++;
    if (FORCE_AMBIENT) document.title = 'ambient pass ' + ambientCount + ' — ' + ambientPass.segs.length + ' seg(s)';
  }
  const seg = ambientPass.segs[ambientPass.i];
  ambientPass.t += delta;
  const p = Math.min(1, ambientPass.t / seg.dur);
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

  // zoom spring: scroll position → camera.zoom (dtS clamped so a stalled frame
  // cannot blow the integrator up)
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
    flowmap.material.uniforms.uFalloff.value = CONFIG.flowmap.falloff * 0.5 * camera.zoom;
    if (fluidmap) fluidmap.material.uniforms.uFalloff.value = CHROMA.falloff * 0.5 * camera.zoom;
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
  updateAmbient(delta);                        // drives mouse2/velocity2
  flowmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
  flowmap.update(-scrollDelta);
  if (fluidmap) {
    fluidmap.aspect = flowmap.aspect;
    fluidmap.mouse.copy(flowmap.mouse);
    fluidmap.velocity.copy(flowmap.velocity);
    if (AMBIENT.chroma) {                      // let the idle pass paint too
      fluidmap.mouse2.copy(flowmap.mouse2);
      fluidmap.velocity2.copy(flowmap.velocity2);
    } else {
      fluidmap.mouse2.set(-1, -1);             // idle pass reveals, but leaves no red
    }
    fluidmap.setDeltaMult(Math.min(deltaMs, 32) / 16);
    fluidmap.update(-scrollDelta);
  }
  uScrollSpeed.value += (scrollDelta * 5 - uScrollSpeed.value) * 0.04;

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
