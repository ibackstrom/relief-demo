// Corner particle cloud. Instanced sprite quads, solved entirely in the vertex shader.
//
// Per frame each mote goes through:
//   1. drift    a fraction of them travel along one direction on a 5s recycle, fading
//               out over the last 30% so the wrap is invisible
//   2. bloom    the whole field scales away from the screen corner while hovered
//   3. cursor   motes near the pointer ray are pushed off it
//   4. curl     divergence-free curl noise, so the field swirls without clumping
//   5. colour   one of 7 sprite frames, then the overlay/sat/contrast chain
//
// Canvas is transparent — this is an overlay, it does not draw its own background.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);

// ---------------------------------------------------------------- CONFIG
const CONFIG = {
  // ------------------------------------------------------------ population
  // Few and large, not many and small. A mote is a shaded sphere, and at 15-40 px you
  // read the shading and it becomes an object at a distance; at 4 px it is a dot and the
  // cloud flattens into a spray however deep the box is. This is the single biggest
  // lever on whether the thing looks volumetric.
  particleCount: 1500,
  particleSize: 4.6,        // sprite edge, world units, before the per-mote multiplier
  sizeVariation: 4.0,       // size = abs(1 + (rand*2-1) * this). Deliberately large: the
                            //   spread of apparent sizes IS the depth cue, and it wants
                            //   to be wide enough that near and far motes differ several
                            //   times over. Under ~2 the cloud reads flat.

  // ------------------------------------------------------------ the box the motes fill
  // Distribution volume, in units of the viewport HEIGHT at the cloud's depth, so the
  // cloud keeps its proportion of the frame at every window size.
  //
  // Depth is the same order as width — a cube, not a slab. A shallow box gives every
  // mote nearly the same distance to camera, so perspective never separates them and no
  // amount of size variation or parallax recovers the volume.
  boxWidth: 0.340,
  boxHeight: 0.300,
  boxDepth: 0.340,

  // ------------------------------------------------------------ placement
  // Viewport halves from centre: 1 is exactly the right/top edge. Past 1 the centre of
  // mass goes off-screen, the bloom grows out of frame, and the open state falls short.
  anchorX: 1.00,
  anchorY: 0.97,
  anchorZ: 0.0,

  // ------------------------------------------------------------ parallax
  // A slow sway of the whole volume. With a fixed camera this is the only thing that
  // makes near motes travel further across the frame than far ones, and motion parallax
  // is the strongest depth cue available — stronger than size or shading. Kept slow and
  // small enough that it reads as the cloud breathing rather than as a turntable.
  parallaxAmount: 0.30,     // radians of yaw at the extremes
  parallaxTilt: 0.12,       // radians of pitch, at a different period so it never loops
  parallaxSeconds: 19.0,    // period of the yaw. The tilt runs at 0.63x this.

  // ------------------------------------------------------------ depth shading
  // Aerial perspective: motes at the back of the volume are dimmed and thinned. Without
  // it every mote is equally present and the volume collapses back into a decal however
  // correct the geometry is.
  depthFade: 0.45,          // alpha lost across the full depth of the box, 0 = flat
  depthDarken: 0.22,        // brightness lost across the same span

  // ------------------------------------------------------------ drift
  floatingParticles: 0.16,  // fraction that travel. Travel and curl are exclusive — a
                            //   moving mote's curl is multiplied out — so this is really
                            //   the split between risers and shimmer.
  floatingSpeed: 0.17,      // clock rate for the 5-second travel-and-recycle cycle
  floatingDirectionX: 0.10, // the travel direction, normalised
  floatingDirectionY: 1.0,
  floatingDirectionZ: 0.0,
  floatingDirectionRandomness: 0.25,  // per-mote jitter on that direction, so the risers
                                      //   fan out instead of moving as a sheet

  // ------------------------------------------------------------ curl noise
  curlFrequency: 3.0,       // spatial scale of the swirl. Higher = tighter eddies; the
                            //   noise is scaled by amplitude/frequency internally, so
                            //   raising this does not also raise the displacement.
  curlAmplitude: 0.08,      // how far a mote is carried off its seat. This is the main
                            //   "how alive is it" dial.
  curlSpeed: 1.00,          // how fast the field itself evolves. The field translates in
                            //   its own z with time, so motes do not retrace a path.
  curlAffectedParticles: 0.85,  // fraction of the stationary motes that take curl at all;
                                //   the remainder are dead still and give the cloud grain.

  // ------------------------------------------------------------ influence point
  // A fixed calm spot: within influenceRadius the curl is scaled down, so the cloud has a
  // still core and a moving edge. Radius is in world units. intensity 1 = fully calm at
  // the centre, 0 = the point does nothing.
  influencePointX: 0.0,
  influencePointY: 0.0,
  influencePointZ: 0.0,
  influenceRadius: 0.30,
  influenceIntensity: 0.0,

  // ------------------------------------------------------------ cursor
  // Each mote is measured against its distance to the pointer RAY, not to a point on a
  // plane, so the cloud opens as a tube through its whole depth instead of at one z only.
  //
  // Radius and push are fractions of viewport HEIGHT, not world units, so the opening
  // holds its size on screen at any window. Don't put world units here.
  mouseRadius: 0.155,       // radius of the tube that opens
  mouseStrength: 0.055,     // how far a mote at the centre of it is pushed
  falloffPower: 2.0,        // 1 = linear, 2 = soft outer edge with a firm core
  mouseSmoothing: 0.12,     // lag on the cursor the motes actually see, per frame. Low
                            //   values make the cloud trail the pointer.
  mouseFadeSeconds: 0.45,   // fade in/out of the whole response when the pointer arrives
                            //   or leaves, so nothing snaps.
  mouseCurlBoost: 1.4,      // extra curl inside the push, as a multiple of the falloff.
                            //   Keep it low — it scatters motes back into the hole the
                            //   push just made, and over ~3 it closes it completely.

  // ------------------------------------------------------------ colour
  // The sprite sheet is greyscale, so the overlay is the only thing giving the cloud a
  // colour. Blend modes: 0 multiply, 1 add, 2 overlay, 3 screen.
  colorOverlayR: 0.85,
  colorOverlayG: 0.05,
  colorOverlayB: 0.06,
  colorOverlayBlendMode: 0,
  colorOverlayStrength: 1.0,
  saturation: 1.60,
  contrast: 1.10,
  brightness: 1.15,
  minBrightness: 0.0,
  opacity: 0.62,            // overall alpha of the field

  // ------------------------------------------------------------ scan
  // A band that sweeps the cloud and tints what it crosses; drive uProgress off scroll
  // to use it as a reveal. Off by default — the glow colour fights a warm overlay.
  scanSize: 0.175,
  scanDirection: 0,         // 0 = the band runs along Y, 1 = along X
  scanStrength: 0.0,
  scanGlow: [0.15, 0.70, 1.00],

  // ------------------------------------------------------------ bloom on hover
  // A second way to answer the cursor, independent of the ray push above. Where the push
  // opens a hole wherever the pointer is, this grows the WHOLE cloud outward from the
  // screen corner when the pointer comes near it — the cloud stays small until noticed,
  // then spills further onto the page.
  //
  // Every mote is pushed along its own direction away from the corner, so the shape is
  // preserved and only its reach changes. The motes nearest the corner barely move and
  // the outer edge travels furthest, which is what makes it read as spilling out of the
  // corner rather than as the whole patch sliding inward.
  // The box is 60% of the size the cloud reaches when open and this is the trip back:
  // 1/0.6 - 1 = 0.667. THE TWO ARE A PAIR — resize the box and the open size moves with
  // it unless this moves too.
  expandAmount: 0.667,
  // How near the pointer must come, as fractions of viewport height measured from the
  // cloud's centre. FULL strength anywhere inside expandHoverInner, then fading to
  // nothing at expandHoverRadius.
  //
  // The inner plateau is not a nicety. With the cloud wedged into the corner its centre
  // is the corner, so the pointer can only ever approach from inside the frame and can
  // never get near zero: against a bare falloff from the centre, hovering the particles
  // themselves reached 0.66 of full and the cloud opened to two thirds of where it
  // should. The plateau has to cover the resting cloud's own extent.
  expandHoverInner: 0.150,
  expandHoverRadius: 0.320,
  expandSeconds: 0.55,      // ease in/out. Slower than the ray push on purpose: the
                            //   growth is the slow gesture, the hole is the quick one.
  expandCurlBoost: 0.8,     // extra curl while expanded, as a multiple of curlAmplitude.
                            //   Without it the cloud grows but goes strangely still.
};

// ?p=<n> particle count, ?curl=<n> amplitude, ?push=<n> cursor strength — quick overrides
const numParam = (k, lo, hi) => {
  const v = parseFloat(PARAMS.get(k));
  return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
};
if (numParam('p', 1, 20000) !== null) CONFIG.particleCount = Math.round(numParam('p', 1, 20000));
if (numParam('curl', 0, 5) !== null) CONFIG.curlAmplitude = numParam('curl', 0, 5);
if (numParam('push', 0, 5) !== null) CONFIG.mouseStrength = numParam('push', 0, 5);

// ---------------------------------------------------------------- GLSL: curl noise
// 3D simplex noise returning its ANALYTIC gradient alongside its value (xyz = gradient,
// w = value). The gradient is what makes the curl cheap: a curl needs derivatives, and
// taking them by finite differences would cost six more noise evaluations per axis.
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
vec3 curlNoise(vec3 position, float frequency, float time, float amplitude){
  vec3 sp = position * frequency + vec3(0.0, 0.0, time);

  vec3 gA1 = snoise3dDeriv(sp).xyz;
  vec3 gA2 = snoise3dDeriv(sp + vec3( 17.0, 59.0, 113.0)).xyz;
  vec3 gA3 = snoise3dDeriv(sp + vec3(101.0,  7.0,  23.0)).xyz;

  vec3 curl = vec3(gA3.y - gA2.z,
                   gA1.z - gA3.x,
                   gA2.x - gA1.y);

  // divide by frequency so raising the detail does not also raise the displacement
  return curl * (amplitude / max(frequency, 1e-6));
}
`;

// ---------------------------------------------------------------- GLSL: vertex
// Instanced camera-facing quads. Sizing is in WORLD units (not gl_PointSize), so motes
// grow and shrink with perspective and there is no driver cap on how large one can get.
//
// The motion is solved per VERTEX, so each mote's position (and its three noise taps) is
// computed six times over, once per corner. Consistent, so the quad never tears, but it
// is 6x the arithmetic. Fine at a few thousand motes; past ~20k move the solve to a
// ping-pong pass and read the result back as an instance attribute.
const VERT = /* glsl */`
${GLSL_SNOISE}

// The attribute named position is the quad corner, -0.5..0.5 in xy with z unused. It
// carries that name because three sizes the draw call off attributes.position, and it is
// the one attribute here that is per-vertex rather than per-instance.
attribute vec3 aInitPos;
attribute vec3 aDriftDir;        // per-mote travel direction (already jittered)
attribute float aDriftSpeed;     // 0 for a stationary mote
attribute float aSize;
attribute float aTimeOffset;
attribute float aSprite;         // 0..6
attribute float aBrightness;
attribute float aCurlResp;       // 0 or 1

uniform float uTime;
uniform float uFloatingSpeed;
uniform float uCurlFrequency;
uniform float uCurlAmplitude;
uniform float uCurlSpeed;
uniform vec3  uInfluencePoint;
uniform float uInfluenceRadius;
uniform float uInfluenceIntensity;
uniform vec3  uMouseRayOrigin;   // in this object's local space
uniform vec3  uMouseRayDir;
uniform float uMouseRadius;
uniform float uMouseStrength;    // already scaled by the fade
uniform float uFalloffPower;
uniform float uMouseCurlBoost;
uniform float uParticleSize;
uniform float uHalfDepth;        // half the volume's depth
uniform float uCentreViewZ;      // view-space z of the volume's own centre
uniform vec3  uExpandOrigin;     // the screen corner, in this object's local space
uniform float uExpand;           // 0..1, eased hover state
uniform float uExpandAmount;
uniform float uExpandCurlBoost;

varying vec2  vUv;
varying float vSprite;
varying float vBrightness;
varying float vFade;
varying vec3  vPos;
varying float vDepth;           // 0 at the front of the volume, 1 at the back

const float CYCLE = 5.0;

void main(){
  vec3 pos = aInitPos;

  // ---- 1. drift, on a 5-second recycle -------------------------------------
  // Age is the mote's own phase, so the population is spread across the cycle instead
  // of every mote restarting together.
  float age = mod(uTime * uFloatingSpeed * 0.5 + aTimeOffset, CYCLE);
  pos += aDriftDir * aDriftSpeed * age;

  // ---- 1b. bloom out of the corner on hover ---------------------------------
  // Applied to the resting seat, before curl and push, so the two cursor responses
  // compose: the cloud grows AND the pointer still opens a hole inside the grown cloud.
  //
  // Scale about the CORNER, not the cloud's own centre — about the centre the near edge
  // advances on the corner and crosses it, which reads as sliding, not spilling.
  float expand = uExpand * uExpandAmount;
  pos = uExpandOrigin + (pos - uExpandOrigin) * (1.0 + expand);

  // Travelling motes fade out over the last 30% of the cycle so the recycle is invisible.
  // Stationary motes never fade. One age drives both the move and the fade — compute the
  // fade at a different rate and the wrap becomes visible as a pop.
  float hasVelocity = step(1e-6, aDriftSpeed);
  float driftFade = 1.0 - smoothstep(CYCLE * 0.7, CYCLE, age);
  vFade = mix(1.0, driftFade, hasVelocity);

  // ---- 2. cursor: distance to the pointer RAY -------------------------------
  float pushFalloff = 0.0;
  vec3  pushDir = vec3(0.0);
  float rayLen = length(uMouseRayDir);
  if (rayLen > 0.001 && uMouseStrength > 0.001) {
    vec3 rayDir = uMouseRayDir / rayLen;
    vec3 toParticle = pos - uMouseRayOrigin;
    float t = dot(toParticle, rayDir);
    vec3 closest = uMouseRayOrigin + rayDir * t;
    vec3 delta = pos - closest;
    float distToRay = length(delta);
    if (distToRay < uMouseRadius) {
      pushFalloff = pow(1.0 - distToRay / uMouseRadius, uFalloffPower);
      pushDir = delta / (distToRay + 1e-4);
    }
  }

  // ---- 3. curl ---------------------------------------------------------------
  // The influence point calms the field near it; the cursor does the opposite, boosting
  // it where it pushes, so the opening churns rather than sliding open.
  float distToInfluence = length(pos - uInfluencePoint);
  float influenceFactor = 1.0 - smoothstep(0.0, uInfluenceRadius, distToInfluence);
  float curlReduction = 1.0 - influenceFactor * uInfluenceIntensity;
  // The push churns locally; the bloom lifts the whole field, or the grown cloud sits
  // oddly still at the moment it has just become most visible. Keyed off the expand term
  // above — the eased hover TIMES the amount — not off the raw hover, so a cloud with
  // expandAmount 0 is left completely alone by this whole mechanism.
  float amplification = 1.0 + pushFalloff * uMouseCurlBoost + expand * uExpandCurlBoost;
  float effectiveCurl = uCurlAmplitude * curlReduction * amplification;

  float ct = uTime * uCurlSpeed * 0.01;
  vec3 curlOffset = curlNoise(vec3(pos.x, pos.y, ct), uCurlFrequency, ct, effectiveCurl);

  // a mote that travels does not curl, and vice versa
  float curlInfluence = mix(aCurlResp, 0.0, hasVelocity);
  pos.x += curlOffset.x * curlInfluence;
  pos.y += curlOffset.y * curlInfluence;
  pos.z += curlOffset.z * 0.1 * curlInfluence;

  // the push is applied after the curl so it is never swallowed by it
  pos += pushDir * pushFalloff * uMouseStrength;

  vPos = pos;
  // Depth is taken in VIEW space so it stays correct while the volume yaws — a local z
  // would swing from front to back as the cloud turns and the ramp would rotate with it.
  // Measured against the volume's OWN centre: against raw view z every mote is ~10 units
  // from the camera, the ratio saturates, and the whole cloud gets the same value.
  float viewZ = (modelViewMatrix * vec4(pos, 1.0)).z;
  vDepth = clamp(0.5 - (viewZ - uCentreViewZ) / (2.0 * uHalfDepth), 0.0, 1.0);
  vUv = position.xy + 0.5;
  vSprite = aSprite;
  vBrightness = aBrightness;

  // ---- 4. billboard ----------------------------------------------------------
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  mv.xy += position.xy * (uParticleSize * aSize * 0.01);
  gl_Position = projectionMatrix * mv;
}
`;

// ---------------------------------------------------------------- GLSL: fragment
const FRAG = /* glsl */`
uniform sampler2D tSprite;
uniform float uProgress;
uniform float uScanSize;
uniform float uScanDirection;
uniform float uScanStrength;
uniform vec3  uScanGlow;
uniform vec3  uColorOverlay;
uniform float uColorOverlayBlendMode;
uniform float uColorOverlayStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uBrightness;
uniform float uMinBrightness;
uniform float uOpacity;

varying vec2  vUv;
varying float vSprite;
varying float vBrightness;
varying float vFade;
varying vec3  vPos;
varying float vDepth;

uniform float uDepthFade;
uniform float uDepthDarken;

vec3 adjustSaturation(vec3 c, float s){
  float g = dot(c, vec3(0.299, 0.587, 0.114));
  return mix(vec3(g), c, s);
}
vec3 adjustContrast(vec3 c, float k){ return (c - 0.5) * k + 0.5; }
vec3 applyMinBrightness(vec3 c, float m){ return max(c, vec3(m)); }

vec3 blendOverlay(vec3 base, vec3 ov){
  return mix(2.0 * base * ov, 1.0 - 2.0 * (1.0 - base) * (1.0 - ov), step(0.5, base));
}
vec3 applyColorOverlay(vec3 base, vec3 ov, float mode, float strength){
  vec3 blended = base * ov;                                   // 0 multiply
  if (mode > 2.5)      blended = 1.0 - (1.0 - base) * (1.0 - ov);   // 3 screen
  else if (mode > 1.5) blended = blendOverlay(base, ov);            // 2 overlay
  else if (mode > 0.5) blended = base + ov;                         // 1 add
  return mix(base, blended, strength);
}

void main(){
  // pick one frame out of the 7-wide sheet
  float spriteWidth = 1.0 / 7.0;
  vec2 spriteUV = vec2(vUv.x * spriteWidth + vSprite * spriteWidth, vUv.y);
  vec4 texel = texture2D(tSprite, spriteUV);
  if (texel.a < 0.002) discard;

  // the sweeping band, keyed off the mote's own position along one axis
  float scanPosition = uProgress * 2.0 - 1.0;
  float axis = mix(vPos.y, vPos.x, uScanDirection);
  float scanMask = smoothstep(uScanSize, 0.0, abs(axis - scanPosition));

  // aerial perspective: the back of the volume is dimmer and thinner than the front
  vec3 col = vec3(1.0);
  col = mix(col, uScanGlow, scanMask * 0.6 * uScanStrength);
  col *= vBrightness * (1.0 - uDepthDarken * vDepth);

  vec3 mixed = col * texel.rgb;
  mixed = applyColorOverlay(mixed, uColorOverlay, uColorOverlayBlendMode, uColorOverlayStrength);
  mixed = adjustSaturation(mixed, uSaturation);
  mixed = adjustContrast(mixed, uContrast);
  mixed = mixed * uBrightness;
  mixed = applyMinBrightness(mixed, uMinBrightness);
  mixed = clamp(mixed, 0.0, 1.0);

  float alpha = texel.a * vBrightness * vFade * uOpacity * (1.0 - uDepthFade * vDepth);
  gl_FragColor = vec4(mixed, alpha);
}
`;

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 10);

const group = new THREE.Group();
scene.add(group);

// The world height the camera sees at the cloud's depth. Every size and placement below
// is expressed against this, so the cloud holds its share of the frame on any window.
const viewHeightAt = (z) =>
  2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.abs(camera.position.z - z);

// ---------------------------------------------------------------- geometry
// One quad, instanced. Per-mote values are generated once on the CPU: seat in the box,
// size multiplier, brightness, sprite frame, and which of the two roles it takes.
function buildParticles(count) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = count;

  const corners = new Float32Array([
    -0.5, -0.5, 0.0,   0.5, -0.5, 0.0,   0.5,  0.5, 0.0,
    -0.5, -0.5, 0.0,   0.5,  0.5, 0.0,  -0.5,  0.5, 0.0,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(corners, 3));

  const initPos    = new Float32Array(count * 3);
  const driftDir   = new Float32Array(count * 3);
  const driftSpeed = new Float32Array(count);
  const sizes      = new Float32Array(count);
  const timeOffs   = new Float32Array(count);
  const sprites    = new Float32Array(count);
  const brights    = new Float32Array(count);
  const curlResp   = new Float32Array(count);

  const vh = viewHeightAt(CONFIG.anchorZ);
  const halfW = CONFIG.boxWidth  * vh * 0.5;
  const halfH = CONFIG.boxHeight * vh * 0.5;
  const halfD = CONFIG.boxDepth  * vh * 0.5;

  const baseDir = new THREE.Vector3(
    CONFIG.floatingDirectionX, CONFIG.floatingDirectionY, CONFIG.floatingDirectionZ
  );
  if (baseDir.lengthSq() === 0) baseDir.set(0, 1, 0);
  baseDir.normalize();

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;

    // A plain uniform box gives a rectangle with visible corners. Biasing each axis
    // toward its centre with a mean of two samples rounds the mass off, so the cloud
    // reads as a blob whose edges thin out rather than as a filled crate.
    const soft = () => ((Math.random() + Math.random()) - 1.0);
    initPos[i3]     = soft() * halfW;
    initPos[i3 + 1] = soft() * halfH;
    initPos[i3 + 2] = soft() * halfD;

    const travels = Math.random() < CONFIG.floatingParticles;
    driftSpeed[i] = travels ? CONFIG.floatingSpeed * (0.6 + Math.random() * 0.8) : 0.0;

    // jitter the travel direction per mote so the risers fan instead of moving as a sheet
    const r = CONFIG.floatingDirectionRandomness;
    const d = new THREE.Vector3(
      baseDir.x + (Math.random() * 2 - 1) * r,
      baseDir.y + (Math.random() * 2 - 1) * r,
      baseDir.z + (Math.random() * 2 - 1) * r
    ).normalize();
    driftDir[i3] = d.x; driftDir[i3 + 1] = d.y; driftDir[i3 + 2] = d.z;

    // abs() because sizeVariation > 1 makes this negative, which mirrors the quad —
    // invisible on a round sprite, but the size then grows again as it goes more negative
    sizes[i] = Math.abs(1.0 + (Math.random() * 2 - 1) * CONFIG.sizeVariation);

    timeOffs[i] = Math.random() * 5.0;
    sprites[i]  = Math.floor(Math.random() * 7);
    brights[i]  = 0.8 + Math.random() * 0.2;
    curlResp[i] = Math.random() < CONFIG.curlAffectedParticles ? 1.0 : 0.0;
  }

  const inst = (name, arr, size) =>
    geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  inst('aInitPos', initPos, 3);
  inst('aDriftDir', driftDir, 3);
  inst('aDriftSpeed', driftSpeed, 1);
  inst('aSize', sizes, 1);
  inst('aTimeOffset', timeOffs, 1);
  inst('aSprite', sprites, 1);
  inst('aBrightness', brights, 1);
  inst('aCurlResp', curlResp, 1);

  // the cloud moves in the shader, so nothing can be culled off its rest bounds
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(halfW, halfH, halfD) * 4);

  // pristine copies, kept so the depth sort can permute from a fixed source rather than
  // repeatedly permuting an already-permuted buffer
  geo.userData.src = {
    aInitPos: initPos.slice(), aDriftDir: driftDir.slice(),
    aDriftSpeed: driftSpeed.slice(), aSize: sizes.slice(),
    aTimeOffset: timeOffs.slice(), aSprite: sprites.slice(),
    aBrightness: brights.slice(), aCurlResp: curlResp.slice(),
  };
  geo.userData.order = new Int32Array(count).map((_, i) => i);
  geo.userData.key = new Float32Array(count);
  return geo;
}

const loader = new THREE.TextureLoader();
const spriteSheet = loader.load('./assets/bubbles.png', () => {
  const el = document.getElementById('loading');
  el.style.opacity = 0;
  setTimeout(() => el.remove(), 700);
});
spriteSheet.colorSpace = THREE.LinearSRGBColorSpace;
spriteSheet.minFilter = THREE.LinearFilter;
spriteSheet.magFilter = THREE.LinearFilter;
spriteSheet.wrapS = spriteSheet.wrapT = THREE.ClampToEdgeWrapping;

const uniforms = {
  uTime: { value: 0 },
  uFloatingSpeed: { value: CONFIG.floatingSpeed },
  uCurlFrequency: { value: CONFIG.curlFrequency },
  uCurlAmplitude: { value: CONFIG.curlAmplitude },
  uCurlSpeed: { value: CONFIG.curlSpeed },
  uInfluencePoint: { value: new THREE.Vector3(
    CONFIG.influencePointX, CONFIG.influencePointY, CONFIG.influencePointZ) },
  uInfluenceRadius: { value: CONFIG.influenceRadius },
  uInfluenceIntensity: { value: CONFIG.influenceIntensity },
  uMouseRayOrigin: { value: new THREE.Vector3(-9999, -9999, -9999) },
  uMouseRayDir: { value: new THREE.Vector3(0, 0, 0) },
  uMouseRadius: { value: CONFIG.mouseRadius },
  uMouseStrength: { value: 0 },
  uFalloffPower: { value: CONFIG.falloffPower },
  uMouseCurlBoost: { value: CONFIG.mouseCurlBoost },
  uParticleSize: { value: CONFIG.particleSize },
  uHalfDepth: { value: 1 },
  uCentreViewZ: { value: 0 },
  uDepthFade: { value: CONFIG.depthFade },
  uDepthDarken: { value: CONFIG.depthDarken },
  uExpandOrigin: { value: new THREE.Vector3() },
  uExpand: { value: 0 },
  uExpandAmount: { value: CONFIG.expandAmount },
  uExpandCurlBoost: { value: CONFIG.expandCurlBoost },

  tSprite: { value: spriteSheet },
  uProgress: { value: 0.5 },
  uScanSize: { value: CONFIG.scanSize },
  uScanDirection: { value: CONFIG.scanDirection },
  uScanStrength: { value: CONFIG.scanStrength },
  uScanGlow: { value: new THREE.Vector3(...CONFIG.scanGlow) },
  uColorOverlay: { value: new THREE.Vector3(
    CONFIG.colorOverlayR, CONFIG.colorOverlayG, CONFIG.colorOverlayB) },
  uColorOverlayBlendMode: { value: CONFIG.colorOverlayBlendMode },
  uColorOverlayStrength: { value: CONFIG.colorOverlayStrength },
  uSaturation: { value: CONFIG.saturation },
  uContrast: { value: CONFIG.contrast },
  uBrightness: { value: CONFIG.brightness },
  uMinBrightness: { value: CONFIG.minBrightness },
  uOpacity: { value: CONFIG.opacity },
};

// ShaderMaterial rather than RawShaderMaterial: it declares projectionMatrix,
// modelViewMatrix and the position attribute for us, which this needs for the billboard.
const material = new THREE.ShaderMaterial({
  vertexShader: VERT,
  fragmentShader: FRAG,
  uniforms,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.NormalBlending,
});

let mesh = new THREE.Mesh(buildParticles(CONFIG.particleCount), material);
mesh.frustumCulled = false;
group.add(mesh);

// ---------------------------------------------------------------- depth sort
// Motes are large, soft and transparent, and transparency is order-dependent: drawn in
// creation order, a mote at the back can be composited over one at the front and the
// volume reads as a flat sheet of overlapping stickers. Sorting back to front is what
// lets near bubbles sit convincingly in front of far ones.
//
// Sorted on the SEAT position, not the final one — the curl displacement is a fraction of
// the spacing, so the order it would give is the same, and the seats are known on the CPU
// where the final positions are not (the whole solve lives in the vertex shader).
//
// Cheap at this population: a few hundred keys is well under a millisecond, and it is
// only redone every SORT_EVERY frames because the volume turns slowly.
const SORT_EVERY = 4;
let sortTick = 0;
const _v = new THREE.Vector3();
const _mv = new THREE.Matrix4();

function sortByDepth() {
  if (sortTick++ % SORT_EVERY !== 0) return;
  const geo = mesh.geometry;
  const src = geo.userData.src;
  if (!src) return;
  const n = geo.instanceCount;
  const order = geo.userData.order;
  const key = geo.userData.key;

  // view-space z of each seat: more negative is further from the camera
  const mv = _mv.multiplyMatrices(camera.matrixWorldInverse, group.matrixWorld);
  for (let i = 0; i < n; i++) {
    _v.set(src.aInitPos[i * 3], src.aInitPos[i * 3 + 1], src.aInitPos[i * 3 + 2])
      .applyMatrix4(mv);
    key[i] = _v.z;
  }
  order.sort((a, b) => key[a] - key[b]);      // ascending z = furthest first

  for (const name of Object.keys(src)) {
    const attr = geo.getAttribute(name);
    const size = attr.itemSize;
    const dst = attr.array;
    const from = src[name];
    for (let i = 0; i < n; i++) {
      const o = order[i] * size;
      const d = i * size;
      for (let c = 0; c < size; c++) dst[d + c] = from[o + c];
    }
    attr.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- placement
// The group is parked in a corner of the viewport. anchor 1 = the edge exactly, so the
// default sits the mass just inside the top-right and lets its tail run off the corner.
let worldPush = 0;          // mouseStrength converted from frame-fraction to world units
function place() {
  const vh = viewHeightAt(CONFIG.anchorZ);
  const vw = vh * camera.aspect;
  group.position.set(CONFIG.anchorX * vw * 0.5, CONFIG.anchorY * vh * 0.5, CONFIG.anchorZ);
  // the cursor's reach is given as a fraction of the frame; convert it here, where the
  // world height of the frame is known, so it survives a resize
  uniforms.uMouseRadius.value = CONFIG.mouseRadius * vh;
  worldPush = CONFIG.mouseStrength * vh;

  // The bloom grows the cloud away from the SCREEN CORNER, so the origin is that corner
  // expressed in the group's own space — not the group's origin, which is only wherever
  // the anchor happened to put the cloud's centre.
  uniforms.uExpandOrigin.value.set(vw * 0.5, vh * 0.5, CONFIG.anchorZ);
  group.worldToLocal(uniforms.uExpandOrigin.value);

  uniforms.uHalfDepth.value = Math.max(1e-3, CONFIG.boxDepth * vh * 0.5);
  hoverRadiusWorld = CONFIG.expandHoverRadius * vh;
  hoverInnerWorld = CONFIG.expandHoverInner * vh;
}

// ---------------------------------------------------------------- cursor
// The pointer becomes a ray, converted into the group's own space once per frame; the
// shader measures every mote against it.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2(0, 0);
const ndcSmoothed = new THREE.Vector2(0, 0);
let pointerInside = false;
let fade = 0;             // 0..1, eased toward pointerInside
let seenPointer = false;

addEventListener('pointermove', (e) => {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  if (!seenPointer) { ndcSmoothed.copy(ndc); seenPointer = true; }
  pointerInside = true;
}, { passive: true });

addEventListener('pointerleave', () => { pointerInside = false; });
addEventListener('blur', () => { pointerInside = false; });

const localOrigin = new THREE.Vector3();
const localDir = new THREE.Vector3();
const invGroup = new THREE.Matrix4();
let hoverRadiusWorld = 0;
let hoverInnerWorld = 0;
let expand = 0;           // 0..1, eased toward "the pointer is near the cloud"

function updateCursor(dt) {
  // ease the whole response in and out, so arriving and leaving never snap
  const rate = CONFIG.mouseFadeSeconds > 0 ? dt / CONFIG.mouseFadeSeconds : 1;
  fade += ((pointerInside ? 1 : 0) - fade) * Math.min(1, rate);

  // and lag the cursor the motes actually see, so the cloud trails the pointer
  ndcSmoothed.lerp(ndc, CONFIG.mouseSmoothing);

  raycaster.setFromCamera(ndcSmoothed, camera);
  localOrigin.copy(raycaster.ray.origin);
  localDir.copy(raycaster.ray.direction);
  group.worldToLocal(localOrigin);
  // direction: rotate only. The group is translation-only, so the direction is unchanged;
  // going through the matrix anyway keeps this correct if the group is ever rotated.
  invGroup.copy(group.matrixWorld).invert();
  localDir.transformDirection(invGroup);

  uniforms.uMouseRayOrigin.value.copy(localOrigin);
  uniforms.uMouseRayDir.value.copy(seenPointer ? localDir : new THREE.Vector3());
  uniforms.uMouseStrength.value = worldPush * fade;

  // ---- bloom: is the pointer NEAR the cloud? -------------------------------
  // Distance from the cloud's centre to the pointer ray, in local space — a proximity in
  // the scene, not in screen pixels.
  let near = 0;
  if (seenPointer && hoverRadiusWorld > hoverInnerWorld) {
    const t = -localOrigin.dot(localDir);              // group origin is (0,0,0) here
    const d = localOrigin.clone().addScaledVector(localDir, t).length();
    // 1 inside the plateau, easing to 0 at the outer radius
    let s = (d - hoverInnerWorld) / (hoverRadiusWorld - hoverInnerWorld);
    s = Math.max(0, Math.min(1, s));
    near = 1 - s * s * (3 - 2 * s);
  }
  const eRate = CONFIG.expandSeconds > 0 ? dt / CONFIG.expandSeconds : 1;
  expand += (near * (pointerInside ? 1 : 0) - expand) * Math.min(1, eRate);
  uniforms.uExpand.value = expand;
}

// ---------------------------------------------------------------- resize
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  place();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let elapsed = 0;

// Yaw and pitch on different periods so the pair never repeats. Everything downstream of
// the group transform already goes through it — the pointer ray is converted with the
// inverse matrix and the bloom origin with worldToLocal — so the volume can turn without
// the cursor or the corner anchor drifting out of register.
function parallax() {
  const w = (2 * Math.PI) / CONFIG.parallaxSeconds;
  group.rotation.y = Math.sin(elapsed * w) * CONFIG.parallaxAmount;
  group.rotation.x = Math.sin(elapsed * w * 0.63 + 1.7) * CONFIG.parallaxTilt;
  group.updateMatrixWorld();
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;
  uniforms.uTime.value += dt;
  parallax();
  uniforms.uCentreViewZ.value =
    _v.setFromMatrixPosition(group.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
  sortByDepth();
  updateCursor(dt);
  renderer.render(scene, camera);
}
tick();
