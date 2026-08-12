// Corner particle cloud. Instanced billboards carrying analytic lit spheres, with the
// motion solved entirely in the vertex shader.
//
// Per frame each mote goes through:
//   1. drift    a fraction of them travel along one direction on a 5s recycle, fading
//               out over the last 30% so the wrap is invisible
//   2. bloom    the whole field scales away from the screen corner while hovered
//   3. cursor   motes near the pointer ray are pushed off it
//   4. curl     divergence-free curl noise, so the field swirls without clumping
//   5. shading  a sphere reconstructed per pixel on the billboard, key + fill + rim +
//               specular, then the overlay/sat/contrast chain
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
  particleCount: 14000,
  particleSize: 0.9,        // sphere diameter, world units, before the per-mote multiplier

  // Size is drawn from a HEAVY-TAILED distribution rather than a +/- spread around the
  // base: mult = sizeMin + (sizeMax - sizeMin) * rand^sizeBias. A symmetric spread has to
  // raise its mean to widen its range, so the whole cloud gets heavier as the big motes
  // get bigger. A biased tail decouples the two — most motes stay small while a few reach
  // right out to sizeMax, which is what puts small and large side by side everywhere.
  //
  // sizeBias is the shape: 1 is uniform, and each step up pushes more of the population
  // toward sizeMin while leaving the top of the range where it is. At 5 the median mote
  // is about a twentieth of the way up the range and the mean about a sixth.
  sizeMin: 0.30,
  sizeMax: 14.0,
  sizeBias: 5.0,

  // Share of motes seated by a UNIFORM draw instead of the centre-biased one. The
  // centre-biased draw is what rounds the cloud off, but on its own it leaves the outer
  // reaches thin, so the few large motes almost never land there and the edge reads as
  // fine dust only. This fraction is spread flat across the box and populates the rim.
  edgeShare: 0.45,

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
  mouseRadius: 0.078,       // radius of the tube that opens
  mouseStrength: 0.055,     // how far a mote at the centre of it is pushed
  falloffPower: 2.0,        // 1 = linear, 2 = soft outer edge with a firm core
  mouseSmoothing: 0.12,     // lag on the cursor the motes actually see, per frame. Low
                            //   values make the cloud trail the pointer.
  mouseFadeSeconds: 0.45,   // fade in/out of the whole response when the pointer arrives
                            //   or leaves, so nothing snaps.
  mouseCurlBoost: 1.4,      // extra curl inside the push, as a multiple of the falloff.
                            //   Keep it low — it scatters motes back into the hole the
                            //   push just made, and over ~3 it closes it completely.

  // ------------------------------------------------------------ sphere shading
  // Each mote is a lit sphere, reconstructed per pixel on its billboard. These are the
  // material: the light it sits under, how glossy it is, and how hollow.
  lightDirX: -0.45,         // in VIEW space — x right, y up, z toward the camera. Keep z
  lightDirY: 0.72,          //   positive or the highlight falls behind the spheres and
  lightDirZ: 0.52,          //   they go flat.
  wrap: 0.45,               // how far light wraps past the terminator. 0 = hard Lambert,
                            //   which leaves half of every sphere black and reads as a
                            //   hole punched in a light page. Above ~0.7 it goes flat.
  shininess: 40.0,          // specular exponent. High = a small tight glint, low = a broad
                            //   sheen. Small and tight is what reads as glass.
  specular: 0.85,           // highlight strength
  fresnelPower: 4.2,        // rim tightness. Low spreads the rim over the whole sphere.
  rim: 0.22,                // rim strength: extra pigment at the silhouette
  lightLift: 0.72,          // how far the key and fill THIN the pigment. 0 = flat colour
                            //   with no form at all; near 1 the lit side disappears.
  fillDirX: 0.55,           // the bounce light, opposite the key and below it
  fillDirY: -0.55,
  fillDirZ: 0.30,
  fill: 0.30,               // strength. Past ~0.5 it starts to read as a second key and
                            //   the form goes ambiguous.
  fillColorR: 0.42,         // cool, to sit against the warm key — the contrast between
  fillColorG: 0.52,         //   the two is doing the work, not either one alone
  fillColorB: 0.72,
  rimColorR: 1.00,          // the rim is the light behind the bubble, so it is close to
  rimColorG: 0.72,          //   white with a warm lean rather than the body colour
  rimColorB: 0.68,
  edgeSoftness: 0.16,       // silhouette antialias, in radii. Too low and the discs step;
                            //   too high and they turn back into soft blobs.

  // ------------------------------------------------------------ colour
  // The spheres are shaded in greyscale and take their colour here, so this is the body
  // colour of the material. Blend modes: 0 multiply, 1 add, 2 overlay, 3 screen.
  colorOverlayR: 0.85,
  colorOverlayG: 0.05,
  colorOverlayB: 0.06,
  colorOverlayBlendMode: 0,
  colorOverlayStrength: 1.0,
  saturation: 1.45,
  contrast: 1.10,
  brightness: 0.98,
  minBrightness: 0.0,
  opacity: 0.72,            // overall alpha of the field

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
if (numParam('p', 1, 40000) !== null) CONFIG.particleCount = Math.round(numParam('p', 1, 40000));
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

  // A mote that travels does not curl, and vice versa. Roughly a third of the population
  // is one or the other, and the curl is three simplex-with-derivative evaluations, so it
  // is worth branching around rather than computing and multiplying by zero. The test is
  // per instance, so a whole quad takes the same path and the branch stays coherent.
  float curlInfluence = mix(aCurlResp, 0.0, hasVelocity);
  if (curlInfluence > 0.0) {
    float ct = uTime * uCurlSpeed * 0.01;
    vec3 curlOffset = curlNoise(vec3(pos.x, pos.y, ct), uCurlFrequency, ct, effectiveCurl);
    pos.x += curlOffset.x * curlInfluence;
    pos.y += curlOffset.y * curlInfluence;
    pos.z += curlOffset.z * 0.1 * curlInfluence;
  }

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
  vBrightness = aBrightness;

  // ---- 4. billboard ----------------------------------------------------------
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  mv.xy += position.xy * (uParticleSize * aSize * 0.01);
  gl_Position = projectionMatrix * mv;
}
`;

// ---------------------------------------------------------------- GLSL: fragment
const FRAG = /* glsl */`
uniform vec3  uColorOverlay;
uniform float uColorOverlayBlendMode;
uniform float uColorOverlayStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uBrightness;
uniform float uMinBrightness;
uniform float uOpacity;

varying vec2  vUv;
varying float vBrightness;
varying float vFade;
varying vec3  vPos;
varying float vDepth;

uniform float uDepthFade;
uniform float uDepthDarken;

uniform vec3  uLightDir;
uniform float uWrap;
uniform float uShininess;
uniform float uSpecular;
uniform float uFresnelPower;
uniform float uLightLift;
uniform float uRim;
uniform vec3  uRimColor;
uniform vec3  uFillDir;
uniform float uFill;
uniform vec3  uFillColor;
uniform float uEdgeSoftness;

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

// A sphere IMPOSTOR, shaded as PIGMENT rather than as an emitter.
//
// The quad stays a camera-facing billboard, but the surface normal is reconstructed per
// pixel from the quad's own coordinates: the unit disc is the silhouette of a unit sphere,
// so z = sqrt(1 - x^2 - y^2) gives the front hemisphere exactly. A real per-pixel-lit
// sphere for two triangles, round at any size.
//
// What each mote outputs is a TRANSMITTANCE — how much of the page it lets through per
// channel — not a colour to paint on top. 1 passes everything and is invisible; the body
// colour absorbs its complement. The blend is a multiply, so two motes over the same pixel
// multiply their filters together and the colour deepens instead of settling on the first
// one's value. Density is what the lighting drives: lit faces hold less pigment, the rim
// holds more, and the specular clears it to nothing.
//
// A useful consequence: multiplication commutes, so the result no longer depends on the
// order the motes are drawn in.
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;                 // outside the silhouette
  float r = sqrt(r2);
  vec3 n = vec3(p, sqrt(max(0.0, 1.0 - r2)));

  vec3 L = normalize(uLightDir);
  vec3 V = vec3(0.0, 0.0, 1.0);          // billboards face the camera, so view is +z
  vec3 H = normalize(L + V);

  // Wrapped diffuse. A hard Lambert term drives half of every sphere to full density,
  // which under a multiply reads as a solid blot rather than as a lit form.
  float ndl = dot(n, L);
  float diffuse = mix(uWrap, 1.0, clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0));

  // Fill from the opposite quarter. One light gives a sphere that is correct and
  // lifeless; a second, weaker one across the form is most of the difference.
  float fill = max(dot(n, normalize(uFillDir)), 0.0) * uFill;

  // Specular — the strongest "this is a ball" cue. Under a multiply it is not added light
  // but an absence of pigment: the page shows through cleanly and reads as a glint.
  float spec = pow(max(dot(n, H), 0.0), uShininess) * uSpecular;

  // Fresnel: grazing angles sit at the silhouette, so this is the rim. Denser there,
  // which is what a shell looks like edge-on.
  float fres = pow(1.0 - n.z, uFresnelPower);

  float dens = 1.0 - clamp(diffuse + fill, 0.0, 1.0) * uLightLift;
  dens += fres * uRim;
  dens -= spec;
  dens *= 1.0 - uDepthDarken * vDepth;    // aerial perspective: the back is paler
  dens = clamp(dens, 0.0, 1.0);

  // The filter itself. The colour pipeline runs on the body colour once, not per pixel of
  // shading, because under a multiply the shading is a density and not a colour.
  vec3 body = uColorOverlay;
  body = adjustSaturation(body, uSaturation);
  body = adjustContrast(body, uContrast);
  body = clamp(body * uBrightness, 0.0, 1.0);
  body = applyMinBrightness(body, uMinBrightness);

  vec3 trans = mix(vec3(1.0), body, dens);

  // Coverage. The smoothstep is the antialias on the silhouette — with no texture there
  // is no filtering doing it for us, and without it the discs have stepped edges.
  float edge = smoothstep(1.0, 1.0 - uEdgeSoftness, r);
  float a = edge * vBrightness * vFade * uOpacity * (1.0 - uDepthFade * vDepth);

  // Premultiplied, because the blend is out = dst * (1 - a * (1 - trans)): the source
  // colour arrives already scaled by its coverage. Emitting it unpremultiplied would
  // BRIGHTEN the backdrop wherever a mote is partly transparent.
  gl_FragColor = vec4(trans * a, a);
}
`;

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// White and opaque, because the motes are filters: white is "absorbs nothing". The canvas
// then multiplies onto the page in CSS, so untouched areas leave the page exactly as it is
// and the cloud tints whatever it lies over rather than painting on top of it.
renderer.setClearColor(0xffffff, 1);
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
// size multiplier, brightness, and which of the two roles it takes.
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

    // A plain uniform box gives a rectangle with visible corners; biasing each axis
    // toward its centre with the mean of two samples rounds the mass off. Neither alone
    // is right, so the population is split: most motes take the rounded draw, and
    // edgeShare of them take the flat one and reach the walls of the box.
    const flat = Math.random() < CONFIG.edgeShare;
    const draw = flat
      ? () => (Math.random() * 2 - 1)
      : () => ((Math.random() + Math.random()) - 1.0);
    initPos[i3]     = draw() * halfW;
    initPos[i3 + 1] = draw() * halfH;
    initPos[i3 + 2] = draw() * halfD;

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

    // heavy-tailed: most motes near sizeMin, a few all the way out to sizeMax
    sizes[i] = CONFIG.sizeMin
             + (CONFIG.sizeMax - CONFIG.sizeMin) * Math.pow(Math.random(), CONFIG.sizeBias);

    timeOffs[i] = Math.random() * 5.0;
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
  inst('aBrightness', brights, 1);
  inst('aCurlResp', curlResp, 1);

  // the cloud moves in the shader, so nothing can be culled off its rest bounds
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(halfW, halfH, halfD) * 4);

  return geo;
}

// Nothing to load — the motes are shaded analytically, there is no texture. The overlay
// is dismissed on the first painted frame instead of on an asset callback.
let firstFrame = true;
function dismissLoading() {
  const el = document.getElementById('loading');
  if (!el) return;
  el.style.opacity = 0;
  setTimeout(() => el.remove(), 700);
}

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
  uLightDir: { value: new THREE.Vector3(
    CONFIG.lightDirX, CONFIG.lightDirY, CONFIG.lightDirZ) },
  uWrap: { value: CONFIG.wrap },
  uShininess: { value: CONFIG.shininess },
  uSpecular: { value: CONFIG.specular },
  uFresnelPower: { value: CONFIG.fresnelPower },
  uRim: { value: CONFIG.rim },
  uLightLift: { value: CONFIG.lightLift },
  uRimColor: { value: new THREE.Vector3(
    CONFIG.rimColorR, CONFIG.rimColorG, CONFIG.rimColorB) },
  uFillDir: { value: new THREE.Vector3(
    CONFIG.fillDirX, CONFIG.fillDirY, CONFIG.fillDirZ) },
  uFill: { value: CONFIG.fill },
  uFillColor: { value: new THREE.Vector3(
    CONFIG.fillColorR, CONFIG.fillColorG, CONFIG.fillColorB) },
  uEdgeSoftness: { value: CONFIG.edgeSoftness },
  uExpandOrigin: { value: new THREE.Vector3() },
  uExpand: { value: 0 },
  uExpandAmount: { value: CONFIG.expandAmount },
  uExpandCurlBoost: { value: CONFIG.expandCurlBoost },

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
  // out.rgb = src.rgb * dst.rgb + dst.rgb * (1 - src.a), and the shader emits src.rgb
  // premultiplied, so this resolves to dst * (1 - a * (1 - trans)): a filter laid over
  // whatever is behind, and two of them multiply. That is the whole "overlap deepens"
  // behaviour, and it is why the motes no longer need sorting — multiplication commutes.
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.DstColorFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendEquationAlpha: THREE.AddEquation,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
});

let mesh = new THREE.Mesh(buildParticles(CONFIG.particleCount), material);
mesh.frustumCulled = false;
group.add(mesh);

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
const _v = new THREE.Vector3();
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
  updateCursor(dt);
  renderer.render(scene, camera);
  if (firstFrame) { firstFrame = false; dismissLoading(); }
}
tick();

// ---------------------------------------------------------------- panel
// Three controls and no more: colour, quantity, size. Each prints the CONFIG value it
// writes, so a look found here transfers to the build by typing. Nothing is persisted —
// a reload is the shipped build again. ?ui=0 hides the panel.
//
// Colour is one bar rather than three because the material only ever varies in HUE: the
// spheres are shaded in greyscale and tinted, so saturation and value belong to the
// shading rig, not to the choice of colour. The bar drives the hue and holds S and V at
// the shipped red's, and the readout is the RGB triple to paste back.
const uiEl = document.getElementById('ui');
if (uiEl && PARAMS.get('ui') === '0') {
  uiEl.remove();
} else if (uiEl) {
  const hsvToRgb = (h, s, v) => {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  };
  // S and V of the shipped colour, held constant so the bar only moves hue
  const base = [CONFIG.colorOverlayR, CONFIG.colorOverlayG, CONFIG.colorOverlayB];
  const vMax = Math.max(...base), vMin = Math.min(...base);
  const satFixed = vMax > 0 ? (vMax - vMin) / vMax : 0;
  const valFixed = vMax;
  const hueOf = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    return h < 0 ? h + 1 : h;
  };

  const ROWS = [
    { key: 'hue', name: 'colour', cst: 'CONFIG.colorOverlayRGB',
      min: 0, max: 1, step: 0.001, value: hueOf(...base) },
    { key: 'particleCount', name: 'quantity', cst: 'CONFIG.particleCount',
      min: 14000, max: 30000, step: 100, value: CONFIG.particleCount, rebuild: true },
    { key: 'particleSize', name: 'size', cst: 'CONFIG.particleSize',
      min: 0.6, max: 12, step: 0.1, value: CONFIG.particleSize, uni: 'uParticleSize' },
  ];

  const rgbAt = (h) => hsvToRgb(h, satFixed, valFixed);
  const text = (r, v) => {
    if (r.key === 'hue') return rgbAt(v).map((c) => c.toFixed(3)).join('  ');
    if (r.key === 'particleCount') return String(Math.round(v));
    return v.toFixed(1);
  };

  uiEl.innerHTML = '<h2>particle cloud</h2>' + ROWS.map((r, i) =>
    '<div class="row"><div class="lbl">'
    + '<span class="name">' + r.name + '</span>'
    + (r.key === 'hue' ? '<span class="sw" id="psw"></span>' : '')
    + '<span class="val" id="pv' + i + '">' + text(r, r.value) + '</span></div>'
    + '<span class="cst">' + r.cst + '</span>'
    + '<input type="range" id="pr' + i + '" min="' + r.min + '" max="' + r.max + '"'
    + ' step="' + r.step + '" value="' + r.value + '"></div>'
  ).join('') + '<div class="foot">?ui=0 hides this</div>';

  const swatch = document.getElementById('psw');
  const paintSwatch = (rgb) => {
    if (swatch) swatch.style.background =
      'rgb(' + rgb.map((c) => Math.round(c * 255)).join(',') + ')';
  };
  paintSwatch(rgbAt(ROWS[0].value));

  // Rebuilding allocates new buffers and re-seeds every mote, so a drag is coalesced into
  // one rebuild at the end rather than one per input event.
  let pending = null;
  const rebuild = () => {
    const old = mesh;
    mesh = new THREE.Mesh(buildParticles(CONFIG.particleCount), material);
    mesh.frustumCulled = false;
    group.add(mesh);
    group.remove(old);
    old.geometry.dispose();
  };

  ROWS.forEach((r, i) => {
    const slider = document.getElementById('pr' + i);
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      document.getElementById('pv' + i).textContent = text(r, v);
      if (r.key === 'hue') {
        const rgb = rgbAt(v);
        CONFIG.colorOverlayR = rgb[0];
        CONFIG.colorOverlayG = rgb[1];
        CONFIG.colorOverlayB = rgb[2];
        uniforms.uColorOverlay.value.set(rgb[0], rgb[1], rgb[2]);
        paintSwatch(rgb);
        return;
      }
      CONFIG[r.key] = r.key === 'particleCount' ? Math.round(v) : v;
      if (r.uni) uniforms[r.uni].value = CONFIG[r.key];
      if (r.rebuild) { clearTimeout(pending); pending = setTimeout(rebuild, 110); }
    });
  });
}
