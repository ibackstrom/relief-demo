// immersive-g.com home bas-relief reveal — ver12.
// ver11's background wash, made RADIAL. ver11 built the haze out of the dye, so it came
// out shaped like the dye: a streak lying along the path the cursor had taken. The
// customer's sketch is a round blob centred under the cursor, fading outward in every
// direction, and that is what they were asking for — the fade itself was already right,
// measured at 34 px from 80% to 20% of peak against the sketch's 30 px at the same scale.
// So in ver12 the shape and the falloff come from distance to the cursor (baseRadius,
// baseGamma) and the dye is demoted to a presence test. Strength is untouched: the peak
// is still half the sketch's, which is what they asked for in ver11.
// Three sizes, as before — see ?bg.
//   REVEAL_ZONE  the grey patch — the relief that comes out of the wall. 1, full size.
//   COLOR_ZONE   the red inside it, as a fraction of the reveal. 0.35.
//   base/?bg     the haze on the wall inside that red.
// ver9's other change is kept: no "active / neon glow on the very tops of the relief"
// — the fresnel rim, which ver7 and ver8 inherited from the site at opacity 0.98, sits
// at CHROMATIC.fresnelOpacity 0.40, so the contour is drawn but does not glow.
// Every shader and constant below is ported verbatim from the production bundle
// (see ../REPLICATION-SPEC.md and ../reference/shaders_extracted.txt).
//
// ver7 = ver6's engine with the mask restarted from the site's own, because that is
// the variant the customer picked as closest. Where ver6 tuned its way to a red that
// covered a lot of the trail, ver7 keeps the original's restraint and changes only
// what was asked for: no secondary shades, gradation kept, colour reaching a little
// past the contour. Three changes, all marked OURS in CHROMATIC below:
//   1. hue pinned to red — the site's rotation runs the whole wheel and produces the
//      cyan and magenta the customer wants gone;
//   2. S and V still read off the normal, but remapped into a band, so the gradation
//      survives without the grey and near-black the raw values give here;
//   3. a narrow, low-opacity crease term for the colour just beyond the line.
// Undo all three and this is a verbatim port; each is one line in CHROMATIC.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const PARAMS = new URLSearchParams(location.search);

// ---------------------------------------------------------------- the two radii
// There are two circles under the cursor and ver10 sizes them separately.
//
//   REVEAL_ZONE  the GREY one: how much relief the cursor pulls out of the wall. This
//                is the reveal brush, CONFIG.flowmap.falloff, a uv radius. 1 = ver8's.
//                  ?zone=0.5  ver9's halved patch
//   COLOR_ZONE   the RED one, as a fraction of the grey: how much of the revealed
//                relief takes colour. This is the dye splat the fluid paints, and the
//                mask only opens where that dye is dense, so the dye IS the red's reach.
//                  ?red=1     ver9's behaviour — red out to the edge of the reveal
//                  ?red=0.35  a tighter red core
//
// Until ver10 these were one number: FLUID.splatRadius was sized to the reveal brush
// (0.38 -> ~0.19 uv) precisely so the two discs would coincide, because when the red
// disc came out SMALLER than the grey one every stroke kept a permanent grey rim that
// no tuning of the mask could fix. ver10 asks for that rim on purpose — grey relief
// around a smaller red core — so the sizing is now deliberate rather than matched.
//
// ?mask=site keeps the site's own brush and its own dye unless asked otherwise: that
// switch exists to show the untouched original, and both radii here are ours.
const REVEAL_ZONE = PARAMS.get('zone') === 'full' ? 1
                  : parseFloat(PARAMS.get('zone')) > 0 ? parseFloat(PARAMS.get('zone'))
                  : 1;
const COLOR_ZONE = parseFloat(PARAMS.get('red')) > 0 ? parseFloat(PARAMS.get('red'))
                 : PARAMS.get('mask') === 'site' ? 1
                 : 0.35;   // ver11's base: ver10/?red=0.35, the one the customer kept
// what the dye's radius ends up being, against ver8's — the red is a fraction of the grey
const DYE_ZONE = REVEAL_ZONE * COLOR_ZONE;

// Shrinking either brush also makes what it paints WEAKER, which is not what is being
// asked for and is easy to miss: both the flow-map and the dye accumulate frame by
// frame, so what a point ends up with is (strength x how many frames it spent under the
// brush). Halve a radius at the same cursor speed and every point spends half as long
// under it — the relief comes out half as deep, and the dye half as dense.
// Measured in ver9: halving the reveal with no compensation took the coloured area from
// 1.37% of frame to 0.09%, a 15x drop where the area alone accounts for 4x, because the
// colour needs extrude past ~0.4 before the deep bake levels mix in at all.
// So each deposit rate is scaled by 1/its own radius: the patches change SIZE and
// nothing else. ?ga=<n> and ?dg=<n> override them.
const ZONE_GAIN = parseFloat(PARAMS.get('ga')) > 0 ? parseFloat(PARAMS.get('ga'))
                                                   : 1 / REVEAL_ZONE;
const DYE_GAIN  = parseFloat(PARAMS.get('dg')) > 0 ? parseFloat(PARAMS.get('dg'))
                                                   : 1 / DYE_ZONE;

// ---------------------------------------------------------------- config (site values)
const CONFIG = {
  flowmap: { mouseEase: 0.4, dissipation: 0.953, falloff: 0.38 * REVEAL_ZONE,
             alpha: 1 * ZONE_GAIN },
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

// ---------------------------------------------------------------- A/B switches
// Both default to the shipped build; add the query string to compare.
//
//   ?model=site   immersive-g's own relief GLB, with the bakes that ride inside its
//                 materials, instead of the customer's model and our bakes
//   ?mask=site    the sheen exactly as the site has it, instead of our tuned red
//
// The two are independent on purpose: the mask is identical across both models, so
// ?model=site alone answers "is our replication 1:1?" without the colour changing
// under you, and ?model=site&mask=site is the genuine article, end to end.
const USE_CUSTOM = PARAMS.get('model') !== 'site';
const SITE_MASK = PARAMS.get('mask') === 'site';
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
// ver7 starts from the site's own mask, not from ver6's red, because that is the one
// the customer picked as closest. Three changes on top, all marked OURS, and nothing
// else touched — the delicacy of the original is the thing being preserved:
//
//   1. the hue is PINNED to red, so no secondary shades
//   2. S and V still come from the normal, but remapped into a band, so the red keeps
//      its gradation without ever reaching grey or black
//   3. a narrow, low-opacity crease term puts colour just beyond the contour
const CHROMATIC = {
  enabled: true,
  fresnelSharpness: 35,     // site. The rim exponent: the mask only opens where the
                            //   surface is within a fraction of a degree of edge-on,
                            //   which is what keeps the contour a hairline.
  // OURS (ver9). "Remove the active / neon glow on the very tops of the relief." That
  // glow is this term. The rim opens to ~0.98 where the crease band opens to 0.30, so
  // the hairline on the ridge edge came out over three times the strength of the halo
  // around it: a saturated red at value 0.95 against a near-white wall, which is what
  // reads as neon. It also flickers, because the normal it is built from is a
  // screen-space derivative computed per 2x2 pixel quad.
  //   0.98 -> the site's, ver7/ver8's: a bright glowing line          (?rim=0.98)
  //   0.40 -> the contour is still drawn, at the halo's own weight    <- here
  //   0.00 -> no rim at all; only the crease halo remains
  // ?rim=<0..1> overrides it live, so this can be settled by looking.
  fresnelOpacity: 0.40,

  // OURS (1 of 3). "Slightly beyond the contours." The site's [0.2, 0.42] is inert on
  // this bake — the shading spans 0.208-0.576 against a 0.545 flat wall, so nothing
  // reaches 0.2 and only 4% of the plate is even below 0.42. This is a NARROW band
  // just under the flat value at LOW opacity: a thin halo hugging the line, not the
  // heavy flood ver6 used ([0.44, 0.538] at 0.72), which is what made ver6 read as
  // thick red strokes rather than as the site's restrained sheen.
  //   .y 0.500 -> the darkest 9% of the plate: barely past the line
  //   .y 0.535 -> 12%: a clear halo                              <- here
  //   .y 0.542 -> 13%: the whole shaded band. Keep .y under 0.545
  //                    or flat wall starts taking colour.
  shadowRange: [0.46, 0.535],
  shadowOpacity: 0.30,      // site is 0.25, against creases far deeper than this
                            //   relief's. Raise for more colour beside the line.

  // OURS (ver11). The BACKGROUND WASH — "the red under the cursor should touch not just
  // the contours but slightly the backdrop too". The rim and crease terms only ever open
  // on the relief's own lines and shadows, so the wall between them stays bare no matter
  // how they are tuned; this is a floor under the whole revealed patch, which is the only
  // way the flat wall takes any colour at all.
  //
  // The site has no such term. ver6 had one and the trail read as a solid pink disc, so
  // ver7 removed it; what makes it work here is that it is gated by extrude (baseGate)
  // and rides the dye, so it is a soft haze that hugs the cursor rather than a flood.
  //
  // Strength is set against the customer's own painted sketch (_shots/customer-sketch.jpg,
  // measured with the thin contour lines median-filtered out so only the haze is left):
  // the sketch peaks at 48 in R-max(G,B), and they asked for "literally 50% of that".
  // A background pixel blends toward rgb(242,55,55), so redness = 187 * base * gate *
  // dye * amplitude(0.57) — which puts the target of 24 at base 0.22.
  base: 0.22,
  // Where the haze is allowed to appear: a band on extrude, so it only lands on relief
  // the cursor has actually raised and never on bare wall. It does NOT shape the blob —
  // baseRadius does that.
  baseGate: [0.10, 0.45],
  // The dye density at which the presence test saturates, in raw dye units. In ver11 this
  // was a level and it shaped the haze into a streak along the trail; in ver12 it is only
  // a "is the trail here at all" test, so it is small enough to saturate immediately and
  // leave the shape to the radial term. Raise it and the streak comes back.
  baseFull: 3.0,
  // ver12. The falloff the customer asked to enlarge: how much of baseRadius is spent
  // fading rather than sitting at full strength. 1 = a linear ramp from the cursor to the
  // rim; 1.6 puts the strength mostly in the middle and a long fade around it, which is
  // what the painted sketch looks like. Below 1 it flattens into a disc with an edge.
  baseGamma: 1.6,

  amplitude: 0.57,          // site
  fluidMagnitude: 0.15,     // site
  colorRange: 2.0,          // site

  // OURS (2 of 3). The site rotates the normal's hue and leaves it there, so the
  // colour runs the whole wheel as the surface turns: gold facing the camera, cyan and
  // magenta on the walls. Those are the "secondary shades". hueRange 0 pins the hue
  // outright — every pixel is the same red, and the variation comes from S and V below.
  color: 0x650003,          // only its HUE is used
  hueRange: 0,              // 0 = one hue, no secondary shades. 1 = the site's full
                            //   wheel. 0.05 is a hair of drift if it reads too flat.

  // OURS (3 of 3). The gradation. S and V still come from the normal exactly as the
  // site takes them — this is what makes the red shift with the surface instead of
  // lying flat — but each is remapped into a band with a floor. Unmapped, the site's
  // S reaches 0 (grey) and its V reaches 0.5 (near black against this wall), and the
  // normal is a screen-space derivative, so it is noisy per 2x2 pixel quad and those
  // extremes flicker. [0, 1] on both is the site verbatim.
  //   S from the normal spans 0..1; V spans 0.5..1, so valRange uses its upper half.
  satRange: [0.55, 1.0],
  valRange: [0.50, 0.95],

  // OURS. How far past the edge of the shadow the colour reaches, as a mip bias on the
  // bake: each +1 roughly doubles the blur, so the shaded region grows outward along
  // its own contour and the spill keeps the shape of the form. Kept small here — the
  // crease band is already narrow and this is meant to soften its outer edge, not to
  // push the colour out on its own.
  spread: 1.2,
};

// ---------------------------------------------------------------- ?feather
// Three sizes of the soft edge that carries the colour beyond the contour, so the
// size can be chosen by looking rather than by argument:
//
//   ?feather=s   tight  — colour barely leaves the line
//   ?feather=m   medium — ver7's, the default
//   ?feather=l   wide   — the halo reads as a soft glow around the form
//
// ONLY the feather differs between them. shadowOpacity, the hue, the S/V band and the
// fluid are identical in all three, so what changes is width and softness and nothing
// else. Two knobs make up a size:
//   shadowRange.y  how far out the colour reaches, in bake shading values. The flat
//                  wall sits at 0.545, so .y is always just under it; the closer, the
//                  wider the reach. Past 0.545 bare wall starts taking colour.
//   spread         mip bias on the bake: how blurred the outer edge of that reach is.
// Measured on this bake straight from the shading, with no fluid involved, so these
// are the sizes themselves and not a lucky frame. "Beyond the line" is how much of the
// plate takes colour that the same band with no spread would not reach:
//
//        area with any colour    beyond the line    mean mask strength
//   s          10.6%                  +0.4%               0.098
//   m          13.5%                  +2.2%               0.098
//   l          25.1%                 +12.9%               0.099
//
// Mean strength is flat across all three by design: between sizes the colour does not
// get stronger or weaker, it only reaches further out and fades more gradually. The
// first pass at these was too closely spaced (+0.6 / +2.2 / +8.6) and the three were
// hard to tell apart on screen, because what you mostly see is the sharp fresnel rim.
const FEATHER = {
  s: { shadowRange: [0.500, 0.5150], spread: 0.3 },
  m: { shadowRange: [0.460, 0.5350], spread: 1.2 },
  l: { shadowRange: [0.420, 0.5440], spread: 3.0 },
};
// ver9 ships the WIDE one as the default — that is the size the customer chose
// (ver8/?feather=l). s and m are still reachable for comparison.
const FEATHER_SIZE = ['s', 'm', 'l'].includes(PARAMS.get('feather')) ? PARAMS.get('feather') : 'l';

// ---------------------------------------------------------------- ?bg
// Three sizes of the BACKGROUND WASH — the haze on the flat wall, asked for in three
// sizes so it can be picked by looking:
//
//   ?bg=s   a tight blob right under the cursor
//   ?bg=m   the default, about ver11's reach
//   ?bg=l   a wide halo around the cursor
//   ?bg=0   no wash at all — ver10
//
// The size is the RADIUS of the blob, in screen uv — 0.15 is 15% of the viewport height
// out from the cursor in every direction. Nothing else differs: CHROMATIC.base is shared,
// so the haze is the same colour at its densest, and baseGamma gives all three the same
// shape of fade; only how far it reaches changes. ?bgr=<uv> sets it directly.
//
// The sizes are spaced 1 : 1.7 : 2.7 in radius. ver11's first attempt at three sizes was
// spaced 1 : 1.4 : 2.0 in AREA — barely a third of that in radius — and the three were
// nearly impossible to tell apart, the same trap as ver8's first set of feathers.
const BG = {
  s: { baseRadius: 0.09 },
  m: { baseRadius: 0.15 },
  l: { baseRadius: 0.24 },
};
const BG_SIZE = ['s', 'm', 'l'].includes(PARAMS.get('bg')) ? PARAMS.get('bg') : 'm';
const BG_OFF = PARAMS.get('bg') === '0' || PARAMS.get('bg') === 'off';

// ---------------------------------------------------------------- ?mask=site
// Every OURS above, undone. This is the sheen exactly as immersive-g has it, with no
// value of ours left anywhere in it — the reference to judge the replication against.
//
// hueRange 1.0 with this hue reproduces the site's single rotation exactly: our
// formula is fract(hue + (h - 0.6667)) which, at hue = fract(0.6667 + hueShift),
// collapses to the site's own fract(h + hueShift) with hueShift = -0.52.
const CHROMATIC_SITE = {
  shadowRange: [0.2, 0.42],
  shadowOpacity: 0.25,
  base: 0,                  // no floor: rim and crease only, as the site has it
  spread: 0,                // colour stops where the shadow does
  hueRange: 1.0,            // the full wheel — gold facing the camera, cyan and
                            //   magenta on the walls
  hue: 0.1467,              // = fract(0.6667 + hueShift), hueShift being the site's
                            //   -0.52. Given as a number, not a hex: eyeballing a hex
                            //   for a hue is how this preset first came out cyan.
  satRange: [0, 1],         // identity: S and V straight off the normal again,
  valRange: [0, 1],         //   speckle and all
};

// the mask actually in force
const MASK = SITE_MASK ? { ...CHROMATIC, ...CHROMATIC_SITE }
                       : { ...CHROMATIC, ...FEATHER[FEATHER_SIZE], ...BG[BG_SIZE] };
// ?rim=<0..1> — the rim's strength, live. See CHROMATIC.fresnelOpacity.
if (!SITE_MASK && PARAMS.has('rim')) {
  const r = parseFloat(PARAMS.get('rim'));
  if (r >= 0 && r <= 1) MASK.fresnelOpacity = r;
}
// ?base=<0..1> — the wash's strength, live; ?bg=0 turns it off. See CHROMATIC.base.
// ?bgr=<uv> — the wash's radius, live. See BG above.
if (!SITE_MASK) {
  if (BG_OFF) MASK.base = 0;
  else if (PARAMS.has('base')) {
    const b = parseFloat(PARAMS.get('base'));
    if (b >= 0 && b <= 1) MASK.base = b;
  }
  if (parseFloat(PARAMS.get('bgr')) >= 0) MASK.baseRadius = parseFloat(PARAMS.get('bgr'));
}

// The hue in force: MASK.hue outright if given, else the hue of MASK.color. Only the
// hue is taken from the colour; S and V come from satRange/valRange.
const chromaHue = () => {
  if (MASK.hue !== undefined) return MASK.hue;
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(MASK.color).getHSL(hsl, THREE.SRGBColorSpace);
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
  splatRadius: 0.020 * DYE_ZONE * DYE_ZONE,
                            // dye blob size, in the sim's SQUARED-distance units, and
                            //   the thing that decides how wide the RED is. 0.020 is
                            //   the reveal brush's own size (falloff 0.38 -> ~0.19 uv);
                            //   DYE_ZONE 0.5 is the customer's "red half as wide".
                            //   Squared units are why DYE_ZONE enters twice: a
                            //   half-width patch is a quarter of this number.
  splatForce: 800,          // cursor speed -> velocity injected. Library default 6000.
  dyeAmount: 3.2 * DYE_GAIN,
                            // dye per splat, against fluidMagnitude's 0.15 ramp, which
                            //   saturates at density 6.7 — so the core reddens in two
                            //   frames while the skirt of the splat takes many. That
                            //   gap IS the soft edge of the haze: raise this and the
                            //   whole splat saturates at once and the trail gets a
                            //   hard pink border. Library default is 1.5.
};

// ---------------------------------------------------------------- ?mask=site
// The fluid untuned, back to WebGL-Fluid-Simulation's own defaults. This belongs to
// the mask switch, not the model switch: the dye field is half of what the effect is,
// so a "verbatim mask" running our tamed fluid would not be verbatim at all.
//
// Honest about provenance: the reference dump carries the site's fluid SHADERS
// verbatim but not the JS that drives them, so these are the library's published
// defaults, which the site is built on — not numbers read off immersive-g itself.
const FLUID_SITE = {
  densityDissipation: 0.985,
  velocityDissipation: 0.99,
  curl: 30,
  splatRadius: 0.0025,
  splatForce: 6000,
  dyeAmount: 1.5,
};
const FLUID_ACTIVE = SITE_MASK ? { ...FLUID, ...FLUID_SITE } : FLUID;

const ASSETS = './assets/';

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
uniform vec2 uChromaSatRange;
uniform vec2 uChromaValRange;
uniform float uChromaCreaseFull;
uniform float uChromaSpread;
uniform float uChromaBase;
uniform vec2 uChromaBaseGate;
uniform float uChromaBaseRadius;
uniform vec2 uChromaBaseCursor;
uniform float uChromaBaseFull;
uniform float uChromaBaseGamma;
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
float shadingAt(vec2 uv, float extrude, out float level5){
  vec3 b1 = sRGB_OETF(texture2D(tBake1, uv)).rgb;
  vec3 b2 = sRGB_OETF(texture2D(tBake2, uv)).rgb;
  level5 = b1.r;               // the shading at full extrusion — what the site's crease term reads
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
// OURS (ver11). The background wash comes in as its own term rather than through mask,
// because mask is multiplied by the dye here and the wash has to be able to reach PAST
// the dye — that reach is what ?bg sizes. Taking the max keeps the contours as they are:
// the wash is a floor, and where rim or crease is stronger it changes nothing.
vec3 applyFluidEffect(vec3 color, vec4 fluid, float mask, float wash, vec3 normal){
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
  // OURS. S and V keep coming from the normal, as the site takes them — that is what
  // makes the red shift with the surface instead of lying flat — but each is remapped
  // into a band with a floor. Unmapped, S reaches 0 (grey) and V reaches 0.5 (near
  // black against this wall), and since the normal is a screen-space derivative,
  // computed per 2x2 pixel quad, those extremes flicker as the relief moves. Ranges of
  // [0, 1] make this an identity and the behaviour verbatim.
  hsv.y = mix(uChromaSatRange.x, uChromaSatRange.y, clamp(hsv.y, 0.0, 1.0));
  hsv.z = mix(uChromaValRange.x, uChromaValRange.y, clamp(hsv.z, 0.0, 1.0));
  vec3 effectColor = hsv2rgb(hsv);
  return mix(color, effectColor, max(mask * fluidEdges, wash) * uChromaAmplitude);
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
  float level5;
  float o = shadingAt(vUv, extrude, level5);
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
    smoothstep(uChromaShadowRange.y, uChromaShadowRange.x,
               mix(shade, level5, uChromaCreaseFull)) * uChromaShadowOpacity
  );
  waveMask *= uOpacity;
  vec4 fluid = texture2D(tFluidFlowmap, uvScreen);
  fluid += mix(0., fastScrollNoise.g * 2., uFastScroll);
  // OURS (ver11, reshaped in ver12). The background wash: colour on the flat wall between
  // the lines, which no other term can put there.
  //
  // ver11 built it out of the dye, so it took the dye's shape: a streak lying along the
  // path the cursor had taken, with roughly parallel sides. The customer's sketch is a
  // ROUND blob centred where the cursor is, fading outward in every direction — hence
  // "more radial falloff, same radius". So the shape now comes from distance to the
  // cursor, and the fields only say where it is allowed to appear:
  //
  //   radial   the shape and the falloff. uChromaBaseRadius wide, and the gamma decides
  //            how much of that radius is spent fading rather than sitting at full
  //            strength — this IS the falloff the customer asked to enlarge.
  //   dye      a presence test only: no haze where the trail is not. Saturates almost at
  //            once (uChromaBaseFull is small), so it does not shape the blob or cut its
  //            reach — reading it as a level instead is what made ver11 a streak.
  //   extrude  keeps the haze on relief the cursor has actually raised, so it never lands
  //            on bare wall.
  //
  // Worth knowing before tuning: it is measurably NOT a softness problem. The distance
  // over which ver11's haze fell from 80% to 20% of its peak was 34 px against the
  // sketch's 30 px at the same scale — already as gradual. Chasing softness with a
  // steeper cone and a gamma made it 24 px, i.e. sharper, and shrank the blob. The
  // difference the customer was pointing at is the SHAPE.
  float washDye = fluid.b;
  vec2 dCursor = uvScreen - uChromaBaseCursor;
  dCursor.x *= uResolution.x / uResolution.y;      // a circle on screen, not in uv
  float radial = 1.0 - smoothstep(0.0, uChromaBaseRadius, length(dCursor));
  float wash = uChromaBase
             * pow(radial, uChromaBaseGamma)
             * smoothstep(0.0, uChromaBaseFull, washDye)
             * smoothstep(uChromaBaseGate.x, uChromaBaseGate.y, extrude)
             * uOpacity;
  color = applyFluidEffect(color, fluid, waveMask, wash, normal);
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
const fluid = MASK.enabled ? new FluidSim(renderer, FLUID_ACTIVE) : null;

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
      uChromaFresnelSharpness: { value: MASK.fresnelSharpness },
      uChromaFresnelOpacity: { value: MASK.fresnelOpacity },
      uChromaShadowRange: { value: new THREE.Vector2(...MASK.shadowRange) },
      uChromaShadowOpacity: { value: MASK.shadowOpacity },
      uChromaAmplitude: { value: MASK.amplitude },
      uChromaFluidMag: { value: MASK.fluidMagnitude },
      uChromaColorRange: { value: MASK.colorRange },
      uChromaHue: { value: chromaHue() },
      uChromaHueRange: { value: MASK.hueRange },
      uChromaSatRange: { value: new THREE.Vector2(...MASK.satRange) },
      uChromaValRange: { value: new THREE.Vector2(...MASK.valRange) },
      uChromaSpread: { value: MASK.spread },
      uChromaBase: { value: MASK.base },
      uChromaBaseGate: { value: new THREE.Vector2(...(MASK.baseGate || [0.05, 0.45])) },
      uChromaBaseRadius: { value: MASK.baseRadius || 0.14 },
      uChromaBaseCursor: { value: flowmap.mouse },   // live reference: the eased cursor, in screen uv
      uChromaBaseFull: { value: MASK.baseFull || 50 },
      uChromaBaseGamma: { value: MASK.baseGamma || 1 },
      uChromaCreaseFull: { value: SITE_MASK ? 1 : 0 },
      uBrightnessFactor: { value: BRIGHTNESS_FACTOR * BRIGHTNESS },
      uBrightnessOffset: { value: BRIGHTNESS_OFFSET * BRIGHTNESS },
    },
  });
}

let rowSpacing = ROW_SPACING;   // custom mode overrides with its own panel height

const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);

// label the build so a screenshot of it is self-identifying
if (!SITE_MASK) {
  const sizeName = { s: 'tight', m: 'medium', l: 'wide' }[FEATHER_SIZE];
  const bgName = MASK.base > 0 ? { s: 'small', m: 'medium', l: 'large' }[BG_SIZE] : 'off';
  document.title = 'ver12 — background wash: ' + bgName
                 + ' (red: ' + COLOR_ZONE + ', feather: ' + sizeName + ')';
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = 'background wash: ' + bgName + '  —  ?bg=s / m / l / 0';
}

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
    // the site lets its idle pass paint; we hold it back at the customer's request,
    // so ?mask=site restores that too — otherwise the comparison is not the site's
    if ((AMBIENT.chroma || SITE_MASK) && flowmap.mouse2.x >= 0) {
      fluid.splat(flowmap.mouse2.x, flowmap.mouse2.y, ambientVel.x, ambientVel.y);
    }
    fluid.update(Math.min(delta, 1 / 60));
  }
  uScrollSpeed.value += (scrollDelta * 5 - uScrollSpeed.value) * 0.04;

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
