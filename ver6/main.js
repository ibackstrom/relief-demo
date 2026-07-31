// immersive-g.com home bas-relief reveal — ver6.
// Every shader and constant below is ported verbatim from the production bundle
// (see ../REPLICATION-SPEC.md and ../reference/shaders_extracted.txt).
//
// ver6 = ver4 (customer geometry, zoom, idle pass, brightness) with the chromatic
// sheen rebuilt on the site's own machinery: a real fluid simulation feeding the
// site's waveMask and applyFluidEffect. ver5's invented knobs are gone — no
// tiltRange, no width, no revealGate, no baked normal map.
//
// Two deliberate departures from the site, both marked OURS in CHROMATIC below:
//   1. the hue is squeezed into a red band (the site's hue is dictated by the
//      surface normal and swings the whole wheel — it cannot hold one colour);
//   2. the crease term is re-ranged onto this bake's tonal span, which is what puts
//      colour BESIDE the lines instead of only on them.
// Undo both and this is a verbatim port; each is one line in CHROMATIC.

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

// ---------------------------------------------------------------- chromatic sheen
// The original's iridescent layer. Two halves:
//
//   1. A real GPU fluid simulation (FLUID below) paints a dye trail behind the
//      cursor — advected, curling, dying away. Not a stamped blob.
//   2. Where that dye is dense AND the mask opens, the wall takes a colour GENERATED
//      FROM ITS OWN NORMAL: normal -> rgb -> hsv, hue rotated, back to rgb. Nothing is
//      painted with a flat colour — the shimmer IS the relief's normal read as colour.
//
// The mask has two terms and they do very different jobs:
//
//   * the FRESNEL RIM — a hairline exactly on surfaces turned edge-on to the camera.
//     This is the thin bright contour.
//   * the CREASE term — colour in whatever the relief has thrown into shade. This is
//     the colour BESIDE the lines, and it is what carries the original's look: the
//     site's gold lives in its hollows, not on its rims.
//
// Everything here is the site's except two deliberate changes, both marked OURS:
// the hue is squeezed into a red band, and the crease term is re-ranged onto this
// bake's actual tonal span (the site's own numbers land outside it and do nothing).
const CHROMATIC = {
  enabled: true,
  fresnelSharpness: 35,     // rim exponent. Note how brutal it is: the mask only
                            //   opens where the surface is within a fraction of a
                            //   degree of edge-on. Lower = a wider contour line;
                            //   this is the LINE width, not the spread beside it.
  fresnelOpacity: 0.98,

  // OURS, AND THE MAIN CONTROL. Tonal band of the shading counted as "crease" — this
  // is the colour BESIDE the lines, the thing the customer asked for. The site uses
  // [0.2, 0.42], which is dead on this bake: the shading spans 0.208-0.576 against a
  // 0.545 flat wall, so only 4% of the plate is even below 0.42 and none of it
  // reaches 0.2 — the site's own numbers paint nothing here.
  //
  // .y is the outer edge of the halo and does the work. Measured on this bake:
  //   0.470 -> colour in the darkest  7% of the plate: a tight line
  //   0.535 -> 12%: soft halo, colour clearly outside the line   (softer end)
  //   0.542 -> 13%: the full shaded band goes red                (bolder end)
  // Keep .y under 0.545 or flat wall starts taking colour too.
  shadowRange: [0.44, 0.538],
  shadowOpacity: 0.72,      // how much colour the shaded areas take. Site: 0.25, but
                            //   that is against creases far darker than this relief's.
                            //   Bolder end that was rendered and compared: 0.9 with
                            //   .y 0.542 and spread 7 — reads as thick red strokes.

  // OURS. A floor under the whole revealed patch, so the trail reads as red rather
  // than as grey relief with red edges. The site has no such term and does not need
  // one: its mask is rim + crease only, which on a deep relief already covers most of
  // what you see. On this shallow one those two terms reach under half the revealed
  // area, and the rest — lit slopes and flat tops — stayed bare grey.
  // Gated by the reveal, so bare wall never takes it however long the dye lingers.
  // Keep it low — this is a hint that the patch is warm, not a wash. At 0.12 the
  // trail read as a flat pink disc sitting on the wall.
  base: 0.045,

  amplitude: 0.57,          // master opacity of the fill
  fluidMagnitude: 0.15,     // dye density -> colour ramp; saturates around density 7
  colorRange: 2.0,          // z exaggeration before the normal is read as colour

  // OURS. The site takes the normal's hue straight, so the colour swings the whole
  // wheel with the surface: gold facing the camera, cyan and magenta on the walls.
  // We keep that swing but squeeze it around one hue, so the shimmer survives and
  // the family stays red. Set hueRange 1.0 and color 0x26ffff (hue 0.1467) to get
  // the site's own palette back exactly.
  color: 0x650003,          // only its HUE is used
  hueRange: 0.05,           // width of the swing. 0 = one flat red, 1 = the full site
                            //   wheel. Keep it small: the swing is widest exactly on
                            //   the edge-on walls the fresnel rim picks out, so at
                            //   0.14 the rim ran to hue 0.065 and drew a bright ORANGE
                            //   hairline along every contour. 0.05 spans 349-7deg.
  // OURS. Absolute S and V, not multipliers on what the normal produces. The site
  // reads all three off the normal, which on this geometry desaturated to grey and
  // dropped to near black on the pixels where the derivative normal is noisy — the
  // flickering grey mask. Fixing them here is what makes it "just red".
  saturation: 0.9,
  value: 0.86,

  // OURS. How far past the edge of the shadow the colour reaches, as a mip bias on
  // the bake: each +1 roughly doubles the blur, so the shaded region grows outward
  // along its own contour and the spill keeps the shape of the form. 0 = colour stops
  // exactly where the shadow does; 3+ smears it into a general glow. One extra
  // texture fetch, and smooth by construction — see deepShadingAt.
  spread: 1.8,
};

// only the hue of CHROMATIC.color is taken; S and V are set above
const chromaHue = () => {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(CHROMATIC.color).getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.h;
};

// ---------------------------------------------------------------- fluid simulation
// The classic WebGL-Fluid-Simulation the site runs: advect -> curl -> vorticity ->
// divergence -> pressure Jacobi -> gradient subtract. The shaders are verbatim from
// the reference dump (shaders 0-9). The rates are the library's defaults — the dump
// carries the GLSL but not the JS that drives it.
// These are tuned to keep the dye ON the reveal rather than running off it. The
// library's own defaults (splatForce 6000, curl 30, radius 0.0025) are built for a
// full-screen fluid toy where the point IS the racing motion. Here the dye is only a
// mask for the colour, and if it outruns the reveal you get exactly what it gave us
// before: a small red patch shooting ahead of a large patch of bare grey relief.
const FLUID = {
  simRes: 128,              // velocity/pressure grid
  dyeRes: 512,              // dye grid — this is what the wall samples
  densityDissipation: 0.962,// per-step dye decay. Matched to the reveal flow-map's own
                            //   0.953 so colour and relief fade together; much above
                            //   that and the colour outlives the shape it sits on.
  velocityDissipation: 0.90,// kill the motion quickly: the dye should settle where it
                            //   was laid, drifting a little, not streaming away
  pressureDissipation: 0.8,
  pressureIterations: 20,
  curl: 8,                  // vorticity confinement — the swirl. Library default 30
                            //   whips the trail into fast curls; this is a slow eddy.
  splatRadius: 0.020,       // dye blob size, in the sim's squared-distance units.
                            //   Sized to the REVEAL brush (CONFIG.flowmap.falloff
                            //   0.38 -> ~0.19 uv): at the library's 0.0025 the red
                            //   disc was a third of the grey one, so every stroke had
                            //   a permanent grey rim no tuning of the mask could fix.
  splatForce: 800,          // cursor speed -> velocity injected. Library default 6000.
  dyeAmount: 3.2,           // dye per splat, against fluidMagnitude's 0.15 ramp, which
                            //   saturates at density 6.7 — so the core reddens in two
                            //   frames while the skirt of the splat takes many. That
                            //   gap IS the soft edge of the haze: raise this and the
                            //   whole splat saturates at once and the trail gets a
                            //   hard pink border. Library default is 1.5.
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

// ---------------------------------------------------------------- fluid simulation
// Shaders 0-8 of the reference dump, verbatim. This is a real Navier-Stokes solver,
// not a stamped trail: the cursor injects velocity and dye, the velocity field is
// made swirl (vorticity confinement) and divergence-free (pressure Jacobi), and the
// dye is advected along it. That advection is what gives the site's sheen its drift
// and curl — a flow-map blob cannot produce it at any radius.
const FLUID_VERT = /* glsl */`
varying vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main(){
  vUv = uv;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FLUID_CLEAR_FRAG = /* glsl */`
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv;
uniform sampler2D uTexture;
uniform float value;
void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }`;

const FLUID_SPLAT_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main(){
  vec2 p = vUv - point.xy;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  vec3 base = texture2D(uTarget, vUv).xyz;
  gl_FragColor = vec4(base + splat, 1.0);
}`;

const FLUID_ADVECTION_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main(){
  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
  gl_FragColor = dissipation * texture2D(uSource, coord);
  gl_FragColor.a = 1.0;
}`;

const FLUID_DIVERGENCE_FRAG = /* glsl */`
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
void main(){
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const FLUID_CURL_FRAG = /* glsl */`
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
void main(){
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`;

const FLUID_VORTICITY_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main(){
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 vel = texture2D(uVelocity, vUv).xy;
  gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
}`;

const FLUID_PRESSURE_FRAG = /* glsl */`
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main(){
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float divergence = texture2D(uDivergence, vUv).x;
  gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

const FLUID_GRADIENT_FRAG = /* glsl */`
precision mediump float;
precision mediump sampler2D;
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main(){
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;

const FLUID_RT_OPTS = {
  type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
};

// grid sized so its cells stay square on any window
const fluidGrid = (res, aspect) => (aspect > 1
  ? [Math.round(res * aspect), res]
  : [res, Math.round(res / aspect)]);

class DoubleFBO {
  constructor(w, h) {
    this.read = new THREE.WebGLRenderTarget(w, h, FLUID_RT_OPTS);
    this.write = new THREE.WebGLRenderTarget(w, h, FLUID_RT_OPTS);
  }
  swap() { const t = this.read; this.read = this.write; this.write = t; }
  dispose() { this.read.dispose(); this.write.dispose(); }
}

class FluidSim {
  constructor(renderer, cfg) {
    this.renderer = renderer;
    this.cfg = cfg;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.uniform = { value: null };        // dye texture, handed to the wall material
    this.texelSize = { value: new THREE.Vector2() };   // velocity grid, shared by all passes
    this.aspect = 1;

    const pass = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
      vertexShader: FLUID_VERT, fragmentShader,
      uniforms: { texelSize: this.texelSize, ...uniforms },
      depthTest: false, depthWrite: false,
    });
    this.mClear = pass(FLUID_CLEAR_FRAG, { uTexture: { value: null }, value: { value: cfg.pressureDissipation } });
    this.mSplat = pass(FLUID_SPLAT_FRAG, {
      uTarget: { value: null }, aspectRatio: { value: 1 },
      color: { value: new THREE.Vector3() }, point: { value: new THREE.Vector2() },
      radius: { value: cfg.splatRadius },
    });
    this.mAdvect = pass(FLUID_ADVECTION_FRAG, {
      uVelocity: { value: null }, uSource: { value: null },
      dt: { value: 0 }, dissipation: { value: 1 },
    });
    this.mDivergence = pass(FLUID_DIVERGENCE_FRAG, { uVelocity: { value: null } });
    this.mCurl = pass(FLUID_CURL_FRAG, { uVelocity: { value: null } });
    this.mVorticity = pass(FLUID_VORTICITY_FRAG, {
      uVelocity: { value: null }, uCurl: { value: null },
      curl: { value: cfg.curl }, dt: { value: 0 },
    });
    this.mPressure = pass(FLUID_PRESSURE_FRAG, { uPressure: { value: null }, uDivergence: { value: null } });
    this.mGradient = pass(FLUID_GRADIENT_FRAG, { uPressure: { value: null }, uVelocity: { value: null } });

    this.resize(1);
  }

  resize(aspect) {
    this.aspect = aspect;
    this.mSplat.uniforms.aspectRatio.value = aspect;
    const [sw, sh] = fluidGrid(this.cfg.simRes, aspect);
    const [dw, dh] = fluidGrid(this.cfg.dyeRes, aspect);
    if (this.simW === sw && this.dyeW === dw) return;
    this.simW = sw; this.dyeW = dw;
    for (const fbo of [this.velocity, this.pressure, this.dye]) fbo?.dispose();
    this.curlRT?.dispose(); this.divergenceRT?.dispose();
    this.velocity = new DoubleFBO(sw, sh);
    this.pressure = new DoubleFBO(sw, sh);
    this.dye = new DoubleFBO(dw, dh);
    this.curlRT = new THREE.WebGLRenderTarget(sw, sh, FLUID_RT_OPTS);
    this.divergenceRT = new THREE.WebGLRenderTarget(sw, sh, FLUID_RT_OPTS);
    this.texelSize.value.set(1 / sw, 1 / sh);
    this.uniform.value = this.dye.read.texture;
  }

  blit(material, target) {
    this.quad.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  // one cursor stamp: velocity from how fast it moved, dye at a fixed rate
  splat(x, y, dx, dy) {
    const { splatForce, dyeAmount } = this.cfg;
    this.mSplat.uniforms.point.value.set(x, y);
    this.mSplat.uniforms.uTarget.value = this.velocity.read.texture;
    this.mSplat.uniforms.color.value.set(dx * splatForce, dy * splatForce, 0);
    this.blit(this.mSplat, this.velocity.write);
    this.velocity.swap();
    this.mSplat.uniforms.uTarget.value = this.dye.read.texture;
    this.mSplat.uniforms.color.value.set(dyeAmount, dyeAmount, dyeAmount);
    this.blit(this.mSplat, this.dye.write);
    this.dye.swap();
  }

  update(dt) {
    const c = this.cfg;
    this.mCurl.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(this.mCurl, this.curlRT);

    this.mVorticity.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mVorticity.uniforms.uCurl.value = this.curlRT.texture;
    this.mVorticity.uniforms.dt.value = dt;
    this.blit(this.mVorticity, this.velocity.write);
    this.velocity.swap();

    this.mDivergence.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(this.mDivergence, this.divergenceRT);

    this.mClear.uniforms.uTexture.value = this.pressure.read.texture;
    this.blit(this.mClear, this.pressure.write);
    this.pressure.swap();

    this.mPressure.uniforms.uDivergence.value = this.divergenceRT.texture;
    for (let i = 0; i < c.pressureIterations; i++) {
      this.mPressure.uniforms.uPressure.value = this.pressure.read.texture;
      this.blit(this.mPressure, this.pressure.write);
      this.pressure.swap();
    }

    this.mGradient.uniforms.uPressure.value = this.pressure.read.texture;
    this.mGradient.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(this.mGradient, this.velocity.write);
    this.velocity.swap();

    this.mAdvect.uniforms.dt.value = dt;
    this.mAdvect.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mAdvect.uniforms.uSource.value = this.velocity.read.texture;
    this.mAdvect.uniforms.dissipation.value = c.velocityDissipation;
    this.blit(this.mAdvect, this.velocity.write);
    this.velocity.swap();

    this.mAdvect.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mAdvect.uniforms.uSource.value = this.dye.read.texture;
    this.mAdvect.uniforms.dissipation.value = c.densityDissipation;
    this.blit(this.mAdvect, this.dye.write);
    this.dye.swap();

    this.uniform.value = this.dye.read.texture;
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
uniform float uChromaFresnelSharpness;
uniform float uChromaFresnelOpacity;
uniform vec2 uChromaShadowRange;
uniform float uChromaShadowOpacity;
uniform float uChromaAmplitude;
uniform float uChromaFluidMag;
uniform float uChromaColorRange;
uniform float uChromaHue;
uniform float uChromaHueRange;
uniform float uChromaSaturation;
uniform float uChromaValue;
uniform float uChromaSpread;
uniform float uChromaBase;
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
// The wall's shading at a point, at the current reveal — the site's own six-level
// mix, pulled out of main() so the crease mask can also sample it at neighbouring
// texels (that is what CHROMATIC.spread does).
float shadingAt(vec2 uv, float extrude){
  vec3 b1 = sRGB_OETF(texture2D(tBake1, uv)).rgb;
  vec3 b2 = sRGB_OETF(texture2D(tBake2, uv)).rgb;
  float s = 0.54504;
  s = mix(s, b2.g, smoothstep(0.0, 0.2, extrude));
  s = mix(s, b2.r, smoothstep(0.2, 0.4, extrude));
  s = mix(s, b1.b, smoothstep(0.4, 0.6, extrude));
  s = mix(s, b1.g, smoothstep(0.6, 0.8, extrude));
  s = mix(s, b1.r, smoothstep(0.8, 1.0, extrude));
  return s;
}
// The same shading from the top three levels only, read at an explicit mip level.
// One fetch, and the hardware's trilinear filtering does the spreading: bias 0 is the
// shading as baked, higher biases are progressively blurred copies of it.
//
// This replaces sampling a ring of neighbours and taking the darkest. Any finite set
// of taps dilates a thin stroke into that many faintly offset copies of itself, and
// on this relief — where every feature IS a thin stroke — the copies read as a comb
// of parallel lines along each one. A mip is smooth by construction.
float deepShadingAt(vec2 uv, float extrude, float bias){
  vec3 b1 = sRGB_OETF(texture2D(tBake1, uv, bias)).rgb;
  float s = 0.54504;
  s = mix(s, b1.b, smoothstep(0.4, 0.6, extrude));
  s = mix(s, b1.g, smoothstep(0.6, 0.8, extrude));
  s = mix(s, b1.r, smoothstep(0.8, 1.0, extrude));
  return s;
}
// applyFluidEffect, the site's own. Two of its terms are dropped as dead weight, not
// as a change: a "lines" stripe pattern it multiplies in at strength 0.0, and an
// "aberrationColor" it computes from the fluid velocity and never uses.
//
// The colour is not chosen anywhere. The surface normal is packed into 0..1 as if it
// were rgb, read back as hsv, and only its HUE is rotated. So value and saturation
// come from the geometry: a wall facing one way is a different colour from a wall
// facing another, and that is the whole shimmer.
vec3 applyFluidEffect(vec3 color, vec4 fluid, float mask, vec3 normal){
  float fluidEdges = smoothstep(0.0, 1.0, fluid.b * uChromaFluidMag);
  vec3 normalVector = normal;
  normalVector.z *= uChromaColorRange;
  normalVector = normalize(normalVector);
  vec3 normalColor = (normalVector + 1.0) / 2.0;
  vec3 hsv = rgb2hsv(normalColor);
  // OURS. The site does hsv.x = fract(hsv.x + hueShift) — one rotation, so the
  // colour runs the whole wheel as the surface turns. We keep the swing but squeeze
  // it around uChromaHue: 0.6667 is the hue a camera-facing normal produces, so it
  // is the pivot the swing opens around, and the distance from it is measured the
  // short way round (a plain subtraction sends hues past the wrap point backwards).
  float dHue = fract(hsv.x - 0.6667 + 0.5) - 0.5;
  hsv.x = fract(uChromaHue + dHue * uChromaHueRange);
  // S and V are OURS and are CONSTANT, where the site takes both from the normal.
  // Taking them from the normal is what produced the grey speckle: this normal comes
  // from screen-space derivatives, so it is computed per 2x2 pixel quad and is noisy
  // on thin geometry. Wherever its three components land near equal, the generated
  // colour desaturates to grey; where they land low, it goes near black. Both flicker
  // as the relief moves. The hue still comes from the normal — noise inside a 0.14
  // hue band is invisible — so the shimmer survives without the speckle.
  hsv.y = uChromaSaturation;
  hsv.z = uChromaValue;
  vec3 effectColor = hsv2rgb(hsv);
  return mix(color, effectColor, mask * fluidEdges * uChromaAmplitude);
}
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
  float o = shadingAt(vUv, extrude);
  color += vec3(o);
  vec2 uvPlaster = vPos.xy / uPlasterScale;
  float plaster = texture2D(tPlaster, uvPlaster).g;
  color = mix(color, color * plaster, uTextureStrength);
  color += gradient * 0.7 * uGradientStrength;
  color = color * uBrightnessFactor + uBrightnessOffset;
  // --- chromatic sheen, shader 36 verbatim ---------------------------------
  // The normal is the SCREEN-SPACE geometric one, taken from the derivatives of the
  // eye-space position — no normal map. It therefore sees exactly what the camera
  // sees: a face turned edge-on reads fresnelFactor 0, a face pointing at the lens
  // reads 1.
  vec3 dFdxPos = dFdx(vEye);
  vec3 dFdyPos = dFdy(vEye);
  vec3 normal = normalize(cross(dFdxPos, dFdyPos));
  float fresnelFactor = abs(dot(normal, vec3(0., 0., 1.)));
  float inversefresnelFactor = 1.0 - fresnelFactor;
  inversefresnelFactor = 1. - pow(inversefresnelFactor, uChromaFresnelSharpness);
  // The crease term reads o, the shading as it stands this frame, where the site
  // reads level5, the shading at FULL extrusion. Same quantity, same range — but o
  // is 0.545 flat everywhere the relief has not come out yet, so the colour cannot
  // appear ahead of the reveal or outlive it. The site gets that for free because
  // its reveal and its dye are one and the same trail; ours are two, and the dye
  // lingers longer, which is exactly how red used to end up on bare wall.
  //
  // Spread: also read the shading from a blurred mip, and take whichever is darker.
  // In the shadow's core the sharp value wins and the crease keeps its depth; outside
  // it the blurred value is darker than the flat wall, so the shaded region grows
  // outward along its own contour and the colour reaches past the edge.
  float shade = o;
  if (uChromaSpread > 0.001) {
    shade = min(shade, deepShadingAt(vUv, extrude, uChromaSpread));
  }
  float waveMask = max(
    smoothstep(1., 0.1, mix(inversefresnelFactor, 1., 1. - uChromaFresnelOpacity)),
    smoothstep(uChromaShadowRange.y, uChromaShadowRange.x, shade) * uChromaShadowOpacity
  );
  // the base tint, over whatever the reveal has actually brought out
  waveMask = max(waveMask, uChromaBase * smoothstep(0.05, 0.45, extrude));
  waveMask *= uOpacity;
  vec4 fluid = texture2D(tFluidFlowmap, uvScreen);
  fluid += mix(0., fastScrollNoise.g * 2., uFastScroll);
  color = applyFluidEffect(color, fluid, waveMask, normal);
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
tFluidBlack.needsUpdate = true;   // stand-in when the sheen is switched off

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

// the sheen rides a real fluid sim, as on the site
const fluid = CHROMATIC.enabled ? new FluidSim(renderer, FLUID) : null;

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
      tFluidFlowmap: fluid ? fluid.uniform : { value: tFluidBlack },
      uChromaFresnelSharpness: { value: CHROMATIC.fresnelSharpness },
      uChromaFresnelOpacity: { value: CHROMATIC.fresnelOpacity },
      uChromaShadowRange: { value: new THREE.Vector2(...CHROMATIC.shadowRange) },
      uChromaShadowOpacity: { value: CHROMATIC.shadowOpacity },
      uChromaAmplitude: { value: CHROMATIC.amplitude },
      uChromaFluidMag: { value: CHROMATIC.fluidMagnitude },
      uChromaColorRange: { value: CHROMATIC.colorRange },
      uChromaHue: { value: chromaHue() },
      uChromaHueRange: { value: CHROMATIC.hueRange },
      uChromaSaturation: { value: CHROMATIC.saturation },
      uChromaValue: { value: CHROMATIC.value },
      uChromaSpread: { value: CHROMATIC.spread },
      uChromaBase: { value: CHROMATIC.base },
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
  // (bakes/normal.png is not loaded here: the site's sheen reads the screen-space
  //  geometric normal, never a baked one)
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
  fluid?.resize(aspect);
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
// how fast the idle cursor moved this frame, in uv/frame — only used if the idle
// pass is allowed to feed the fluid sim (AMBIENT.chroma)
const ambientVel = new THREE.Vector2();
const ambientPrev = new THREE.Vector2(-1, -1);
let ambientWait = FORCE_AMBIENT ? 0 : rnd(AMBIENT.pause[0], AMBIENT.pause[1]);

function updateAmbient(delta) {
  if (!AMBIENT.enabled) return;
  flowmap.velocity2.set(1, 1);
  if (ambientPrev.x >= 0 && flowmap.mouse2.x >= 0) {
    ambientVel.subVectors(flowmap.mouse2, ambientPrev);
  } else {
    ambientVel.set(0, 0);
  }
  ambientPrev.copy(flowmap.mouse2);
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
  // fluid sim: splat where the cursor is, then step the solver. The splat uses the
  // raw pointer, not the eased flow-map cursor — the solver does its own smoothing.
  if (fluid) {
    const v = tracker.velocity;
    if (v.lengthSq() > 1e-8) {
      fluid.splat(tracker.normalFlip.x, tracker.normalFlip.y, v.x, v.y);
    }
    if (AMBIENT.chroma && flowmap.mouse2.x >= 0) {   // let the idle pass paint too
      fluid.splat(flowmap.mouse2.x, flowmap.mouse2.y, ambientVel.x, ambientVel.y);
    }
    fluid.update(Math.min(delta, 1 / 60));
  }
  uScrollSpeed.value += (scrollDelta * 5 - uScrollSpeed.value) * 0.04;

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
