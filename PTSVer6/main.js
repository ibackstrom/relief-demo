// Corner particle cloud. Instanced billboards carrying analytic lit spheres, with the
// motion solved entirely in the vertex shader.
//
// The motes are seated on a MODEL. Its triangles are embedded below, rasterised at load
// into a depth map and a normal map, and the seats are then thrown at those maps and kept
// where they land on something — the reference's own scatter, working off maps baked from
// a photograph where these are baked from geometry. The cloud takes the model's silhouette
// and its relief instead of the noise-carved ellipsoid the earlier versions grew.
// Everything after the seat is unchanged: the shape is the only thing the model decides.
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
  particleCount: 60000,
  particleSize: 0.6,        // sphere diameter, world units, before the per-mote multiplier

  // Size comes from a HEAVY-TAILED draw rather than a +/- spread around the base:
  // mult = sizeMin + (sizeMax - sizeMin) * rand^sizeBias.
  //
  // A symmetric spread has to raise its MEAN to widen its RANGE, so the whole cloud gets
  // heavier as the big motes get bigger and there is a limit to how far it can be pushed.
  // A biased tail decouples the two: most motes stay small while a few reach right out to
  // sizeMax. That is what puts small and large side by side rather than sorting them.
  sizeMin: 0.30,
  sizeMax: 12.0,
  sizeBias: 4.0,            // 1 is uniform; each step up crowds the population toward
                            //   sizeMin while leaving the top of the range where it is

  // ------------------------------------------------------------ the scatter
  // Seats come from MAPS, not from the geometry: a depth map, a mask and a surface normal,
  // rasterised once from the embedded mesh at load. Sampling is then two-dimensional —
  // throw a point at the frame, keep it if the maps say something is there, and read its
  // depth out of the map. It is worth being clear that this is the shape of the thing
  // rather than a shortcut around it: what the cloud describes is one SURFACE seen from
  // the front, so the motes cover what faces the camera and nothing lines the back.
  //
  // Orientation, in degrees, applied before the mesh is rasterised. The model is a
  // flattened lens — thin on its own Y — so the default lays that thin axis into DEPTH and
  // turns the broad face toward camera, which is the silhouette worth showing.
  modelRotX: -90,
  modelRotY: 0,
  modelRotZ: 0,

  // Resolution of the rasterised maps. This is the grain of the silhouette, and of the
  // depth the motes are lifted by. 256 puts the step well under a mote at this size; going
  // higher costs load time and buys nothing the eye can find.
  mapResolution: 256,

  // A seat is kept only where the maps clear both thresholds, and the draw is retried a
  // bounded number of times. depthThreshold is doing the real work — the background of the
  // depth map is zero, so this is what cuts the silhouette out.
  depthThreshold: 0.30,
  brightnessThreshold: 0.02,
  sampleAttempts: 10,       // retries before a seat is taken wherever it landed

  // How far the depth map lifts a mote, in units of the plane's own width: the map's 0..1
  // becomes -0.5..+0.5 of this. The relief is deliberately shallow against the width of
  // the mass — it is a face turned toward the camera, not a solid. This is the reference's
  // own ratio, its 0.27 of displacement over a 0.9-wide plane, and it is the first dial to
  // reach for if the cloud wants more body.
  depthDisplacement: 0.30,

  // How much the surface normal drives mote SIZE. Where the surface turns away from the
  // camera the motes swell, so the rim of the mass carries the big ones and the flat of it
  // stays fine — this is most of why the silhouette reads as a rolling edge rather than a
  // cut-out.
  //
  // The normal's z is stored the usual way, (n + 1) / 2, so it runs 1 facing the camera
  // down to 0.5 edge-on and the multiplier at the rim is 1 + 0.25 * this. The reference
  // uses 30, i.e. 8.5x at the rim, on a size draw that tops out at 2.
  //
  // Cut to 0.6 here, and the reason is worth keeping: swelling the motes where the surface
  // turns away from the camera puts the BIGGEST ones around the outside of the silhouette,
  // which is where they are least wanted — the mass should gather at the corner and break
  // up as it leaves. Faithful to the reference, wrong for this composition.
  normalInfluence: 0.6,

  // Denser toward the corner. The model's own sampling is even across its projected area,
  // so density follows the SILHOUETTE rather than the corner — measured on the last build
  // the coverage fell to 0.55 forty pixels out and rose again to 0.80 further along, which
  // is the lens shape talking, not a gradient. This weights the draw by distance from the
  // corner itself, on top of everything the model decides.
  //
  // 0 leaves the model's even coverage alone. Each step up crowds the population cornerward
  // and, since the count is fixed, thins the far side by exactly as much. It is a power on
  // the radius of the throw, so it has no ceiling to fall off.
  cornerDensity: 1.4,

  // How clumpy the sheet is. Seats are rejection-sampled against a low-frequency noise
  // field, so motes gather in some places and thin out in others instead of covering
  // evenly. Held over from the previous versions and lowered — the reference has no
  // equivalent, its unevenness comes from the photograph it samples, and ours has to be
  // put in by hand. Past ~0.8 the voids read as holes rather than as texture.
  shapeNoise: 0.35,
  shapeNoiseScale: 3.4,     // features per plane width. Higher is finer, grainier clumping.

  // ------------------------------------------------------------ strands
  // What the reference clips are actually showing. Their motes are not spread through a
  // volume — they gather along thin curved SHEETS and threads, with a loose scatter
  // between, and the creases where the sheets fold are the darkest thing in frame. An even
  // scatter cannot produce that however it is tuned, because the structure is not a density
  // gradient: it is a set of lines.
  //
  // So a share of the population is laid along flow lines. A strand starts at an ordinary
  // seat and walks the curl of a static noise field, dropping a mote at every step; motes
  // that start near each other and follow the same flow end up threaded along the same
  // curve. Folding comes for free — a curl field folds material lines all by itself, which
  // is exactly the mechanism that puts the creases in the reference.
  //
  // The cost is at BUILD time only. Nothing here runs per frame; the walk happens once, and
  // what reaches the shader is the same seat array as before.
  strandFraction: 0.55,     // share of motes belonging to strands. The rest stay loose, and
                            //   they matter — the reference has scatter between its threads
  strandLength: 150,        // motes per strand — which is to say how FEW threads there
                            //   are: at 30000 motes this is about sixty of them. The first
                            //   pass used 34, and five hundred threads laid over one small
                            //   mass cancel out into scatter. Long and few, not short and
                            //   many
  strandStep: 0.006,        // distance between motes along a strand, in plane widths. This
                            //   is thread LENGTH per mote: raise it and threads reach
                            //   further but go dotty
  strandJitter: 0.004,      // lateral scatter around the path, same units — a thread's
                            //   THICKNESS. Measured on Ref2 a filament is about an eighth
                            //   as thick as the gap to its neighbour; ours were a single
                            //   mote wide, nearer a two-hundredth, which is a drawn wire
                            //   rather than a rope of particles
  // Measured on Ref2: the filaments hold a common diagonal, concentration 0.44 — a broad
  // band of one direction rather than parallel lines or no preference at all. 0 is an
  // isotropic tangle, 1 is a comb.
  strandBias: 0.22,
  strandBiasAngle: 40,      // degrees, counter-clockwise from the +x axis. Set so the
                            //   structure measures the same lean the reference's does

  strandFlowScale: 5.6,     // features per plane width in the field the strands walk.
                            //   Raised from 4.2: at a coarse feature size every strand in
                            //   the corner sees nearly the same heading and they converge
                            //   onto one line however far apart they start. Smaller
                            //   features let them part company — which is what makes four
                            //   of them read as four. There is a ceiling, found the hard
                            //   way: at 8.0 the field turns so tightly that a strand coils
                            //   in place instead of travelling, and four sweeping lines
                            //   became four compact clumps. Most of the convergence was the
                            //   shared LEAN anyway — see strandBias, which came down with
                            //   this

  // ------------------------------------------------------------ life
  // In the reference the motes are not permanent fixtures. They swell out of the threads,
  // travel a little way off them and vanish, and others take their place — which is what
  // makes the mass churn while its outline stays put. A cloud of permanent motes can only
  // ever slide its motes around; it cannot do that.
  //
  // Each mote runs its own birth-to-death on a loop, phased off its own seed so the
  // population is spread across the cycle. There is no spawner and nothing is allocated:
  // a mote's life is a function of the clock, exactly like everything else here.
  lifeSeconds: 3.2,         // one full birth-to-death. Long enough that a mote is a thing
                            //   that lived rather than a flicker
  lifeGrow: 0.12,           // fraction of the life spent swelling in from nothing
  lifeFadeStart: 0.68,      // where it starts shrinking away again. Between grow and this
                            //   the mote is at full size, which is where the cloud gets
                            //   its body — bring the two together and it reads as twinkle
  lifeDrift: 0.150,         // how far a mote travels over one life, in plane widths, ALONG
                            //   the flow. Measured on Ref1 the motes cover about 39% of the
                            //   mass radius per second; this is 4.7% of the plane width per
                            //   second, well under that, and the reason is legibility rather
                            //   than fidelity — at the reference's rate the threads read as
                            //   a smear at this size. It is the first dial to raise if the
                            //   customer wants the streaming faster

  // Share of motes that live and die at all. This used to have to stay low to keep the
  // threads from dissolving, back when a mote's travel was a straight line off its seat.
  // Travelling ALONG the flow removes that trade completely: a mote leaving a point on a
  // thread is replaced by the one behind it arriving, so the thread is preserved BY the
  // motion rather than in spite of it. That is what a streamline is, and it is why the
  // reference can move everything at once and still hold its shape.
  lifeFraction: 1.0,

  // ------------------------------------------------------------ corner strands
  // A few threads that are not the model's. The ones above all start from seats inside the
  // silhouette, so they read as the mass's own grain; these are seeded at random out in the
  // corner and kept there, which puts a line or two in the open space where nothing else is
  // happening. They walk the same field, so they belong to the same weather.
  //
  // Their position re-rolls on every load. That is the point of them — the mass is fixed by
  // the model, and this is the part that is different each time.
  extraStrands: 4,
  extraStrandLength: 2200,  // motes each. Far more than a model strand gets: these have to
                            //   read as ONE line against a mass of thirty thousand, and at
                            //   the model strands' budget they simply joined the texture
  extraStrandStep: 0.0012,  // and packed closer along the path than the model's threads —
                            //   under a pixel apart at this size, so the line is continuous
                            //   rather than a row of dots
  extraStrandReach: 0.60,   // the corner box they are seeded in and held to, in plane widths
                            //   measured from the screen corner itself. Cut back from 1.2:
                            //   a box that reaches well past the mass lets a thread wander
                            //   out into open page on its own, which reads as a stray line
                            //   rather than as part of the effect
  extraStrandBunch: 1.8,    // how hard their seeds crowd toward the corner. 1 scatters them
                            //   evenly through the box; each step up pulls the population
                            //   nearer the corner while leaving the box where it is
  extraStrandInner: 0.40,   // and how far out they START, as a share of the box. Without a
                            //   floor here the crowding piles all three on the same spot by
                            //   the corner, where they overlap and read as ONE gathering —
                            //   which is exactly what happened
  extraStrandHome: 0.28,    // where a thread turns back TO, in box widths from the corner.
                            //   Not the corner itself — aimed dead at it, a thread reaching
                            //   the wall slides along the screen edge and draws a rim
  extraStrandSize: 1.4,     // and drawn heavier than the mass around them. They are
                            //   deliberate features rather than part of the fade, so they
                            //   are also exempt from the edge shrink above — shrunk with
                            //   distance like everything else, the one thing meant to be
                            //   READ as a line is the first thing to disappear
  extraStrandJitter: 0.010, // lateral spread, in plane widths — wider than the model
                            //   threads use. These are meant to be seen as gatherings of
                            //   particles rather than as drawn lines, and the spread is
                            //   affordable here because the packing along the path is more
                            //   than twice as tight

  // The loose motes that ignore the maps, and how far they spread. The share is the
  // reference's own ratio — 8000 unmasked against 40000 masked. The reach is a standard
  // deviation in plane widths, set to land the dissolve where the previous version's
  // Gaussian had it, which is the part of that version the customer signed off on.
  strayFraction: 0.17,
  strayReach: 0.25,

  // Motes shrink with distance from the corner. The size draw is otherwise uniform across
  // the mass, so the fine spray and the big motes are equally likely anywhere — and a big
  // mote out at the edge reads as a stray blob rather than as the mass thinning out. This
  // keeps the weight where the mass is and lets the outside break into fine particles.
  sizeEdge: 0.42,           // size multiplier at the far edge, against 1 at the corner
  sizeEdgeScale: 0.75,      // distance over which it falls away, in plane widths

  // ------------------------------------------------------------ the box the model fits
  // The rasterised plane is scaled to fit inside this box, keeping the model's
  // proportions, in units of the viewport HEIGHT at the cloud's depth — so the cloud keeps
  // its share of the frame at every window size. Only the tightest axis touches its wall.
  boxWidth: 0.680,
  boxHeight: 0.600,
  boxDepth: 0.680,

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
  mouseRadius: 0.050,       // radius of the tube that opens
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
  specular: 0.38,           // highlight strength. Low on purpose: on motes this small
                            //   a hot glint is the first thing that aliases, and it reads
                            //   as glitter rather than as gloss.
  minPx: 1.3,               // smallest footprint a mote is drawn at, in device pixels.
                            //   Under 1 they blink; much over 2 the fine spray blurs.
  specMinPx: 3.0,           // below this on-screen diameter the highlight is switched off
  specFullPx: 9.0,          //   and above it runs at full strength. A tight glint on a
                            //   mote a couple of pixels across cannot be resolved — it
                            //   falls between samples and flickers as the mote drifts,
                            //   which is what reads as sparkle.
  specOpacity: 0.9,         // how much of the highlight survives into ALPHA. The glint has
                            //   to be opaque or it vanishes on the thin part of the shell.
  // How far each mote's outline departs from a perfect circle. The silhouette radius is
  // rolled in and out by two low harmonics of the angle, with the phases taken from the
  // mote's own seed, so every mote gets a different lumpy round shape and none of them
  // gains a corner — the perturbation is smooth in angle, so there is nothing to square
  // off. The shading normal is remapped onto the new outline, so a blob is lit as the shape
  // it is rather than as a circle with a bite out of it.
  //
  // 0 is the exact sphere. 1 takes a third off the radius at the deepest dent, which is
  // about as far as it can go before the motes stop reading as one family of objects.
  // ?blob=<0..1> previews it live.
  blob: 1.0,

  fresnelPower: 4.2,        // rim tightness. Low spreads the rim over the whole sphere.
  rim: 0.18,                // rim strength
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
  coreAlpha: 0.78,          // opacity through the middle of a sphere. Low is what makes
                            //   them hollow shells; at 1 they are solid beads.
  edgeSoftness: 0.16,       // silhouette antialias, in radii. Too low and the discs step;
                            //   too high and they turn back into soft blobs.

  // ------------------------------------------------------------ bloom
  // The glow is a POST pass over the whole frame, not something each mote draws for
  // itself. The scene goes into a half-float target, the bright part is extracted,
  // blurred at a few scales and added back. That is where the reference look comes from:
  // its particles are plain, and everything luminous about them happens afterwards.
  //
  // The threshold is deliberately almost zero, so it is not really a "bright pass" at
  // all — every lit pixel blooms, and the pass reads as a soft light around the mass
  // rather than as highlights picked out of it.
  bloom: true,
  bloomThreshold: 0.011,
  bloomStrength: 1.55,      // above the reference's 0.62 on purpose: theirs glows against
                            //   black, where added light is all there is. Against a light
                            //   page there is nothing to add light TO, so the pass has to
                            //   work by spreading colour instead, and that costs more.
  bloomRadius: 0.22,        // blur spread, in half-res texels per step
  bloomAlpha: 1.70,         // how much the glow raises the canvas's own alpha. The page
                            //   behind is light, so without this the glow has nothing to
                            //   show up against and simply disappears into it.

  // ------------------------------------------------------------ crowding
  // The denser a mote's neighbourhood, the deeper its colour. Each mote's neighbours are
  // counted once, when the population is built, and the count travels with it as an
  // attribute — so this is a property of the MOTE, not of what happens to be drawn on top
  // of it. That distinction matters: doing it with a blend mode instead makes the whole
  // cloud translucent and the spheres stop reading as solid.
  //
  // Because it is fixed per mote it also cannot flicker as the cloud turns, and it costs
  // nothing per frame.
  densityRadius: 0.058,     // neighbourhood size, as a fraction of viewport height
  deepen: 0.62,             // how far the most crowded motes are taken toward the deep
                            //   colour. 0 is off; 1 makes the core nearly black.
  deepenBias: 0.85,         // curve on the normalised count. Under 1 spreads the effect
                            //   into the mid-densities, over 1 keeps it to the very core.
  deepenSat: 1.25,          // saturation boost as it deepens, so the core goes richer
                            //   rather than merely darker — plain darkening reads as grey

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
  expandHoverInner: 0.300,
  expandHoverRadius: 0.560,
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
if (numParam('p', 1, 120000) !== null) CONFIG.particleCount = Math.round(numParam('p', 1, 120000));
if (numParam('curl', 0, 5) !== null) CONFIG.curlAmplitude = numParam('curl', 0, 5);
if (numParam('push', 0, 5) !== null) CONFIG.mouseStrength = numParam('push', 0, 5);
if (numParam('noise', 0, 1) !== null) CONFIG.shapeNoise = numParam('noise', 0, 1);
if (numParam('blob', 0, 1) !== null) CONFIG.blob = numParam('blob', 0, 1);
if (numParam('life', 0, 1) !== null) CONFIG.lifeFraction = numParam('life', 0, 1);
if (numParam('strand', 0, 1) !== null) CONFIG.strandFraction = numParam('strand', 0, 1);
if (PARAMS.get('bloom') === '0') CONFIG.bloom = false;
if (numParam('bs', 0, 6) !== null) CONFIG.bloomStrength = numParam('bs', 0, 6);

// ?original — the reference's own palette instead of the client's red.
//
// Worth being exact about where its colour comes from, because it is not in the particles:
// they are drawn UNTINTED (colorOverlayStrength 0) from a source that has been desaturated
// to greyscale first, so what is actually on screen is white motes. The blue is two things
// behind and over them — a background that runs from a dark blue on the left to black on
// the right with a blue light rising from the bottom centre, and a blue overlay across the
// whole frame at 0.71 in overlay blend. That is the "white flow over dark blue": the flow
// is the motes' own value, the blue is the room they are in.
//
// The overlay is reproduced here on the motes rather than as a post pass over the page,
// because this canvas is transparent and has no business tinting what sits behind it.
if (PARAMS.has('original')) {
  CONFIG.colorOverlayR = 0.00;          // their overlayColor, rgb(0, 114, 255)
  CONFIG.colorOverlayG = 0.449;
  CONFIG.colorOverlayB = 1.00;
  CONFIG.colorOverlayBlendMode = 2;     // overlay, as theirs is
  CONFIG.colorOverlayStrength = 0.71;   // their overlayOpacity. Under 1 on purpose: what is
                                        //   left of the greyscale shading is the white.
  CONFIG.saturation = 1.00;             // ours are pushed for the red; theirs sit at unity
  CONFIG.contrast = 1.00;
  CONFIG.brightness = 1.00;
  CONFIG.rimColorR = 1.00;              // a white rim rather than the warm one — the light
  CONFIG.rimColorG = 1.00;              //   in their scene is blue-white, not tungsten
  CONFIG.rimColorB = 1.00;

  // Their bloom numbers, which only work on their ground: against black, added light is all
  // there is, so the pass needs no help. Ours are raised to fight a light page.
  CONFIG.bloomStrength = 0.62;
  CONFIG.bloomRadius = 0.15;
  CONFIG.bloomAlpha = 0.85;

  // Crowding deepens toward a DARKER body colour, which on a light page reads as density
  // and on a dark one reads as holes punched in the mass. Dialled back rather than off, so
  // the core still gains something. The reference has no equivalent at all.
  CONFIG.deepen = 0.25;

  // Tell the page to wear the reference's ground. This is the demo page dressing itself up,
  // not the effect: the build is still a transparent overlay that paints no background.
  document.documentElement.dataset.original = '1';
}

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

// ---------------------------------------------------------------- GLSL: the flow field
// The GLSL half of FLOW. These constants are duplicated from the JS object on purpose and
// have to be edited together: the strands are laid out by that one and travelled along by
// this one, and if they disagree the motes stream off their own threads.
const GLSL_FLOW = /* glsl */`
uniform float uFlowScale;        // features per plane width, over world units
uniform float uFlowBias;         // how hard the field leans on one direction
uniform vec2  uFlowBiasDir;      // that direction

vec3 flowDir(vec3 p) {
  vec3 q = p * uFlowScale;
  float th = 1.60 * sin(dot(q, vec3( 0.90,  1.30,  0.70)) + 0.70)
           + 0.90 * sin(dot(q, vec3(-1.70,  0.80,  1.10)) + 2.30)
           + 0.50 * sin(dot(q, vec3( 1.10, -1.90,  0.50)) + 4.10);
  float ph = 0.55 * sin(dot(q, vec3( 1.30,  0.70, -1.10)) + 1.90);
  float cp = cos(ph);
  vec3 d = vec3(cos(th) * cp, sin(th) * cp, sin(ph) * 0.35);
  d.xy += uFlowBiasDir * uFlowBias;
  return normalize(d);
}

// Follow the field for a given distance, in a few straight hops. Fixed iteration count so
// this compiles everywhere, and few of them because each is two sines: at six the path
// tracks a thread over the distance a mote covers in one life, which is all it has to do.
// Integrating from the SEAT every frame rather than from last frame's position is what lets
// this work with no simulation state at all — the position is a pure function of the clock.
vec3 advect(vec3 p, float dist) {
  float dt = dist / 6.0;
  for (int i = 0; i < 6; i++) p += flowDir(p) * dt;
  return p;
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
const VERT = GLSL_FLOW + /* glsl */`
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
attribute float aDensity;        // 0..1, how crowded this mote's neighbourhood is
attribute float aShape;          // 0..1, the seed for this mote's outline
attribute float aLife;           // 1 if it lives and dies, 0 if it is permanent

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
uniform float uViewportPx;       // drawing-buffer height, for on-screen size
uniform float uMinPx;            // smallest footprint a mote may be drawn at
uniform float uHalfDepth;        // half the volume's depth
uniform float uLifeSeconds;      // one birth-to-death
uniform float uLifeGrow;         // share of it spent swelling in
uniform float uLifeFadeStart;    // where it starts shrinking away
uniform float uLifeDrift;        // how far it travels off its seat, world units
uniform float uCentreViewZ;      // view-space z of the volume's own centre
uniform vec3  uExpandOrigin;     // the screen corner, in this object's local space
uniform float uExpand;           // 0..1, eased hover state
uniform float uExpandAmount;
uniform float uExpandCurlBoost;

varying vec2  vUv;
varying float vBrightness;
varying float vDensity;
varying float vPx;              // this mote's TRUE diameter on screen, in pixels
varying float vAlphaScale;      // <1 when a mote was grown off sub-pixel size
varying float vFade;
varying vec3  vPos;
varying float vShape;           // this mote's own outline seed
varying float vDepth;           // 0 at the front of the volume, 1 at the back

const float CYCLE = 5.0;

void main(){
  // ---- 0. life: swell out of the thread, travel, vanish ----------------------
  // The phase comes from the mote's own seed, so the population is spread right across the
  // cycle and there is never a frame where the whole cloud is young or the whole cloud is
  // dying. aTimeOffset is already a random 0..5, which is exactly one cycle's worth of
  // spread once divided down.
  float lifePhase = fract(uTime / max(0.0001, uLifeSeconds) + aTimeOffset * 0.2);

  // Swell in, hold, shrink away. The hold in the middle is deliberate and is most of the
  // cycle: with grow and fade meeting in the middle every mote is always on its way
  // somewhere and the cloud reads as twinkle rather than as a thing with a body.
  float envelope = smoothstep(0.0, uLifeGrow, lifePhase)
                 * (1.0 - smoothstep(uLifeFadeStart, 1.0, lifePhase));
  envelope = mix(1.0, envelope, aLife);

  // Travel ALONG THE FLOW as it lives, which is the whole correction of this pass. Measured
  // on Ref1, 97.8% of the motion runs along the filaments rather than across them: a crease
  // is a streamline, so its motes stream down it while the line itself stays exactly where
  // it is. Moving them across the thread — which looked like the safe choice, on the theory
  // that moving along would drag the thread with them — is what a fluid never does.
  //
  // Linear in the phase, so a mote is still moving when it goes; easing it to a stop first
  // reads as the mote parking and then being switched off.
  vec3 pos = advect(aInitPos, uLifeDrift * lifePhase * aLife);

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
  vFade = mix(1.0, driftFade, hasVelocity) * envelope;

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
  vShape = aShape;
  vBrightness = aBrightness;
  vDensity = aDensity;

  // ---- 4. billboard ----------------------------------------------------------
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float worldSize = uParticleSize * aSize * 0.01 * envelope;
  // (the billboard offset is applied below, after any sub-pixel growth)

  // How big this mote lands on screen. NDC spans 2 over the viewport height, so the
  // projected size is worldSize * P[1][1] / -z, and half of that times the height is
  // pixels. The specular needs it: a tight highlight on a mote only a couple of pixels
  // across falls between samples and flickers on and off as the mote drifts — which is
  // the sparkle. It has to be faded out down there rather than left to alias.
  vPx = worldSize * projectionMatrix[1][1] / max(1e-4, -mv.z) * 0.5 * uViewportPx;

  // Sub-pixel motes cannot be drawn honestly: a quad smaller than a pixel lands on the
  // sample grid or misses it, so it blinks as it drifts. Grow anything below uMinPx up to
  // it and pay for the extra area in alpha — the mote keeps the same total presence, so
  // the cloud's weight is unchanged, but it now has a stable footprint to be sampled on.
  // vPx stays the TRUE size, because the specular fade has to judge the real one.
  float grow = max(1.0, uMinPx / max(vPx, 1e-4));
  worldSize *= grow;
  vAlphaScale = 1.0 / (grow * grow);
  mv.xy += position.xy * worldSize;
  gl_Position = projectionMatrix * mv;
}
`;

// ---------------------------------------------------------------- GLSL: fragment
const FRAG = /* glsl */`
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
varying float vBrightness;
varying float vDensity;
varying float vPx;              // this mote's TRUE diameter on screen, in pixels
varying float vAlphaScale;      // <1 when a mote was grown off sub-pixel size
varying float vFade;
varying vec3  vPos;
varying float vShape;
varying float vDepth;

uniform float uSpecMinPx;
uniform float uSpecFullPx;
uniform float uDepthFade;
uniform float uDepthDarken;

uniform vec3  uLightDir;
uniform float uWrap;
uniform float uShininess;
uniform float uSpecular;
uniform float uSpecOpacity;
uniform float uFresnelPower;
uniform float uRim;
uniform vec3  uRimColor;
uniform vec3  uFillDir;
uniform float uFill;
uniform vec3  uFillColor;
uniform float uCoreAlpha;
uniform float uEdgeSoftness;
uniform float uBlob;
uniform float uDeepen;
uniform float uDeepenBias;
uniform float uDeepenSat;

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

// A sphere IMPOSTOR. The quad stays a camera-facing billboard, but the surface normal is
// reconstructed per pixel from the quad's own coordinates: the unit disc is the silhouette
// of a unit sphere, so z = sqrt(1 - x^2 - y^2) gives the front hemisphere exactly. The
// result is a real, per-pixel-lit sphere for the cost of two triangles — no geometry, and
// the silhouette stays analytically round at every size instead of pixelating.
//
// Lit in VIEW space with a fixed light, so every mote catches its highlight in the same
// place. That consistency is what makes them read as objects under one light rather than
// as decorated discs, and it is why the light is not jittered per mote.
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);

  // The outline. A mote is a unit disc; uBlob rolls that circle in and out with two low
  // harmonics of the angle, phased off the mote's own seed, so each one gets a different
  // lumpy round shape. Smooth in angle by construction, so it can dent and swell but can
  // never acquire a corner — the thing asked for was less perfect, not less round.
  //
  // The perturbation only ever REMOVES radius. The quad is sized for a unit disc, so a
  // shape allowed to grow past 1 would be sliced off square by the quad's own edge — which
  // is the one failure mode that would put corners back.
  float rad = 1.0;
  if (uBlob > 0.0) {
    float a = atan(p.y, p.x);
    float ph = vShape * 6.2831853;
    float wob = sin(a * 3.0 + ph) * 0.62 + sin(a * 5.0 - ph * 2.3) * 0.38;
    rad = 1.0 - uBlob * 0.30 * (0.5 + 0.5 * wob);
  }
  if (r2 > rad * rad) discard;           // outside the silhouette
  float r = sqrt(r2) / rad;              // 0 at the centre, 1 at the outline, whatever its shape
  // The normal is the sphere's, remapped onto the outline this mote actually has, so a
  // dented mote is lit as a dented ball rather than as a circle with a piece missing —
  // the highlight and the rim both follow the dent instead of ignoring it.
  vec3 n = vec3(p / rad, sqrt(max(0.0, 1.0 - r * r)));

  vec3 L = normalize(uLightDir);
  vec3 V = vec3(0.0, 0.0, 1.0);          // billboards face the camera, so view is +z
  vec3 H = normalize(L + V);

  // Wrapped diffuse. A hard Lambert term leaves half the sphere black, which on a light
  // page reads as a hole; wrapping lifts the terminator so the dark side keeps a colour.
  float ndl = dot(n, L);
  float diffuse = mix(uWrap, 1.0, clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0));

  // Fill from the opposite quarter, in a cooler tone. One light gives a sphere that is
  // correct and lifeless; a cool bounce on the shadow side is what stops the dark half
  // going to dead colour and is most of the difference between a lit ball and a nice one.
  float fill = max(dot(n, normalize(uFillDir)), 0.0) * uFill;

  // Specular — the strongest "this is a ball" cue. A small bright spot sitting at a fixed
  // point on every sphere, which the eye reads as a light source reflected in each one.
  // Faded out on motes too small to resolve a highlight — see vPx in the vertex shader.
  float specAtten = smoothstep(uSpecMinPx, uSpecFullPx, vPx);
  float spec = pow(max(dot(n, H), 0.0), uShininess) * uSpecular * specAtten;

  // Fresnel: grazing angles sit at the silhouette, so this is the rim. Bubbles are dense
  // at the rim and thin through the middle, and driving ALPHA with it — not just colour —
  // is what makes them read as hollow shells rather than solid beads.
  float fres = pow(1.0 - n.z, uFresnelPower);

  // the sweeping band, keyed off the mote's own position along one axis
  float scanPosition = uProgress * 2.0 - 1.0;
  float axis = mix(vPos.y, vPos.x, uScanDirection);
  float scanMask = smoothstep(uScanSize, 0.0, abs(axis - scanPosition));

  // aerial perspective: the back of the volume is dimmer and thinner than the front
  vec3 col = vec3(diffuse);
  col = mix(col, uScanGlow, scanMask * 0.6 * uScanStrength);
  col *= vBrightness * (1.0 - uDepthDarken * vDepth);

  // Crowding deepens the body colour: darker and a little richer where motes are packed.
  vec3 deep = clamp(uColorOverlay * (1.0 - uDeepen), 0.0, 1.0);
  deep = adjustSaturation(deep, uDeepenSat);
  vec3 body = mix(uColorOverlay, deep, pow(clamp(vDensity, 0.0, 1.0), uDeepenBias));

  vec3 mixed = col;
  mixed = applyColorOverlay(mixed, body, uColorOverlayBlendMode, uColorOverlayStrength);
  mixed = adjustSaturation(mixed, uSaturation);
  mixed = adjustContrast(mixed, uContrast);
  mixed = mixed * uBrightness;

  // Rim and highlight go on AFTER the colour pipeline, so saturation and contrast cannot
  // tint them — they are light ON the surface, not part of the surface's own colour.
  mixed += uFillColor * fill;
  mixed += uRimColor * fres * uRim;
  mixed += vec3(spec);
  mixed = applyMinBrightness(mixed, uMinBrightness);
  mixed = clamp(mixed, 0.0, 1.0);

  // Hollow shell: thin through the middle, dense at the rim. The smoothstep is the
  // antialias on the silhouette — with no texture there is no filtering doing it for us,
  // and without it the discs have visibly stepped edges.
  float shell = mix(uCoreAlpha, 1.0, fres);
  float edge = smoothstep(1.0, 1.0 - uEdgeSoftness, r);
  float alpha = shell * edge * vBrightness * vFade * uOpacity * vAlphaScale
              * (1.0 - uDepthFade * vDepth);
  alpha = min(1.0, alpha + spec * uSpecOpacity);   // the highlight carries its own opacity

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

// ---------------------------------------------------------------- shape noise
// A small 3D value noise, used only on the CPU when seats are drawn. It does not need the
// quality of the simplex noise in the shader — it is sampled a few times per mote at
// startup and never again, and all it has to do is vary smoothly.
const hash3 = (x, y, z) => {
  const t = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return t - Math.floor(t);
};
const smoothT = (t) => t * t * (3 - 2 * t);
// Box-Muller, two at a time, with the spare kept for the next call.
let gaussSpare = null;
function gauss1() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  const r = Math.sqrt(-2 * Math.log(1 - Math.random()));
  const t = 2 * Math.PI * Math.random();
  gaussSpare = r * Math.sin(t);
  return r * Math.cos(t);
}

function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smoothT(x - xi), v = smoothT(y - yi), w = smoothT(z - zi);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return L(
    L(L(c(0,0,0), c(1,0,0), u), L(c(0,1,0), c(1,1,0), u), v),
    L(L(c(0,0,1), c(1,0,1), u), L(c(0,1,1), c(1,1,1), u), v),
    w);
}

// ---------------------------------------------------------------- the flow field
// One field, written twice: here for laying the strands out, and again in GLSL so the motes
// can travel along the very threads they were laid on. The two MUST agree, and that is what
// dictates the form of it.
//
// A hashed value noise cannot be used for this. Its hash is fract(sin(dot(p,k)) * 43758.5),
// and multiplying by forty-three thousand before taking a fraction turns the last bit of a
// double on the CPU into a completely different value on a GPU float. The strands would be
// laid along one field and the motes would travel along another.
//
// A sum of sines has no such cliff. Every term is a sine of a moderate argument, both sides
// agree to about a millionth, and the field is smooth so a millionth stays a millionth. It
// is periodic, which a hash is not, but over the few features a corner cloud spans that is
// invisible.
//
// The heading is the angle itself, never a vector to be normalised: a vector field's length
// passes through zero along whole surfaces, and a normalised direction is meaningless where
// it does — the walk turns to noise, reverses into itself and stops dead, dropping every
// remaining mote of that strand on one spot. An angle cannot degenerate.
const FLOW = {
  f1: [ 0.90,  1.30,  0.70], a1: 1.60, p1: 0.70,
  f2: [-1.70,  0.80,  1.10], a2: 0.90, p2: 2.30,
  f3: [ 1.10, -1.90,  0.50], a3: 0.50, p3: 4.10,
  g1: [ 1.30,  0.70, -1.10], b1: 0.55, q1: 1.90,
};

function flowAt(x, y, z, s, out) {
  const X = x * s, Y = y * s, Z = z * s;
  const F = FLOW;
  const th = F.a1 * Math.sin(F.f1[0]*X + F.f1[1]*Y + F.f1[2]*Z + F.p1)
           + F.a2 * Math.sin(F.f2[0]*X + F.f2[1]*Y + F.f2[2]*Z + F.p2)
           + F.a3 * Math.sin(F.f3[0]*X + F.f3[1]*Y + F.f3[2]*Z + F.p3);
  const ph = F.b1 * Math.sin(F.g1[0]*X + F.g1[1]*Y + F.g1[2]*Z + F.q1);
  const cp = Math.cos(ph);
  // Damped in z, because the shape the threads live in is a shallow relief: a walk free to
  // climb spends most of its length outside the mass, where nothing can see it.
  let dx = Math.cos(th) * cp, dy = Math.sin(th) * cp, dz = Math.sin(ph) * 0.35;

  // A shared lean. Measured on Ref2, the filaments are neither parallel nor arbitrary: they
  // hold a common diagonal with a concentration of 0.44, meaning most of the structure lies
  // within a broad band of one direction. Adding a constant vector before normalising is
  // what produces that — pull it to 1 and every thread is parallel, drop it to 0 and the
  // field has no grain at all.
  const b = CONFIG.strandBias;
  if (b > 0) {
    const a = THREE.MathUtils.degToRad(CONFIG.strandBiasAngle);
    dx += Math.cos(a) * b; dy += Math.sin(a) * b;
  }
  const l = Math.hypot(dx, dy, dz) || 1;
  out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
}

// ---------------------------------------------------------------- the model
// Corner.fbx, triangulated and quantised: a dequantisation box, then 16-bit positions and
// 16-bit indices, base64'd. It ships inside this file rather than beside it because it is
// small and because a second request is a second thing that can fail on a page that is not
// ours. 16 bits over a 3-unit model is a 46-micron step, far under the smallest mote.
const MESH_B64 =
  'ysl4v83MTL7Uzbm/7aIIQM3MzD5weEFAGgMwBoh0///teoh0AADterqBzv7telaBzv6aeLiAzv5adrx/zv4/dHZ+zv5UcuN8' +
  'zv6rcAp7zv5Sb/14zv5Ubsp2zv67bYh0zv6KbUZyzv6+bRZwzv5Ybgduzv5Ubypszv6qcIVqzv5NchZpzv4vdPdnzv5Kdlxn' +
  'zv6SeD1nzv7teo1nzv5EfTZozv6GfzRpzv6jgY5qzv6KgzBszv4thQtuzv6DhhZwzv6Bh0Zyzv4diIh0zv5TiMp2zv4fiPx4' +
  'zv6Ehwl7zv6Hhup8zv4zhZB+zv6Qg+t/zv6ogeOAzv6Hf5iBzv5GfWKOQPvter+NQPtVdsCMQPvZcRaLQPuZbb2IQPuxaYyF' +
  'QPtbZuSBQPuTY6p9QPuZYSF5QPt5YIh0QPsXYP1vQPugYKhrQPvrYZNnQPvkY7tjQPt5ZkhgQPuuaVldQPtvbd9aQPudcfJY' +
  'QPsldhRZQPvtendaQPuXf/xbQPsOhAteQPs9iH5gQPsYjKVjQPttj0NnQPs1klZrQPtVlN1vQPuNlYh0QPvVlR95QPtblYd9' +
  'QPsWlKSBQPsWkn6FQPt3jyKJQPtPjL2LQPttiGeNQPschFeOQPuRf2WaZvXteleZZvUtdIyYZvV7baGWZvUJZzmTZvUoYXmO' +
  'ZvUdXCyIZvWDWNOBZvXCVTx7ZvUXVIh0ZvWAU7xtZvXbUxtnZvWaVRVhZvWpWKhbZvWwXJ9WZvV0YfhRZvXrZmpNZvX5bOFL' +
  'ZvXfc/tLZvXtetNNZvXUgRtQZvVwiLtSZvW9jmNWZvV9lG5bZvVJmZlgZvWRnXlmZvUJoXttZvWlooh0ZvX6ol17ZvUXosmB' +
  'ZvULoAuIZvU+nduNZvVomUWTZvW3lECXZvX6joSaZvWxiLWaZvXJgV2lXe3teoukXe0fcnykXe07aQ2hXe35YPWcXe0rWSiW' +
  'Xe3bUh6OXe0RTuGFXe1wSml9Xe3vR4h0Xe1TR7drXe0ZSNxiXe0LSoVaXe29TQRTXe3qUkVNXe2cWf5HXe34YERDXe0EaXM/' +
  'Xe24cb8/Xe3tek1BXe39g6BEXe2djAxIXe3elNxMXe1mnGxTXe25okBaXe1TqKhhXe1MrSBrXe1Dr4h0Xe2yrjp9Xe10rf6F' +
  'Xe2Nq+uOXe1pqFWYXe0qpBCfXe16nc2jXe2YlYymXe31jHymXe3jg4GvSuPteqytSuNTcGGtSuOqZYuqSuNsW5qkSuNQUn+c' +
  'SuO5SsOTSuNSRD+KSuM9P29/SuOvPIh0SuPMPDtqSuM5PkBgSuMDQTBWSuMDRclMSuPXSsVFSuPOUtY8SuP8WkM5SuNEZVs0' +
  'SuPEb6Q0SuPtegE2SuP1he86SuNQkKk7SuMsm3tCSuNJpH9MSuMqq8JUSuP0sTZfSuMftgNqSuMuuIh0SuOmuL1+SuNlt7yI' +
  'SuO/tDmTSuMdsQufSuN/rJOpSuNrpfStSuNRm6exSuPkkAmzSuP0hYS4Xdftetu2XdejbjK3XdcqYtGxXdfFVkuqXdecTJaj' +
  'XdewQmuZXdchO+CNXdePNfiAXddUM4h0XdfyMn1oXddWNDxdXdcYOI9RXdefPA5EXdfuQTo+XddoTOcxXddiVcctXdd/Yfks' +
  'Xdc5bokrXdftejkuXdeIh9swXdfak7kxXdeEoOY6Xdezqn9GXdeesilRXdeLuUhdXde0vUxoXdcAwoh0Xdc1wxSAXddCwB6L' +
  'XdfjvDGXXdf+uA6lXdfzs2yxXdfuq3i4XdfQoNS9XdfGlEHAXdf2h1XB0MnternA0MkGbZ7B0MnUXpy60MkZUgyy0MmeRo+t' +
  '0MmwOeag0MkrMQWS0Mn1K1WC0MknK4h00MkJK5Rm0MnDKsJY0MkTLt1M0MnUNJs90MnROog00MmuReYl0MnhT+8k0MlrXhEn' +
  '0MnsbFEl0MntekQl0MkSiYEk0MmCl3In0MmTpWoy0Mn5sC5A0MmoubRN0MlfwGdZ0Mn6xshl0MkdzYh00MkhzbSB0MkayYSN' +
  '0MlVxLia0Mnfv72p0MkeulW60MldsmzC0MnIpTPK0MlumJjM0MnFifHI47rtemnM47pqa9jO47pRW1vG47oVTYC747qGQJe5' +
  '47o5MI+p47oCJ1uW47rmIj2E47ppIoh047qoI7Vl47qtJLlV47qhJlJH47obLdA247opNPon47pqPuQb47pQS9we47oUXG0h' +
  '47rLa4wg47rtegYc47p9ih0Z47q3mlAe47rpqVEq47qOtsk747oHvxlK47qVxpdU47qg0Ltj47o71oh047qi1buD47ol0ruQ' +
  '47oAzDig47qQxwmx47oLwWfD47pQuD7M47pNqtjX47oCnErV47okixHS3arteivV3aoyat/c3ar8V4LT3aonSGTF3arYOlPF' +
  '3aqbJ7Gw3arTHsab3apaGVCG3aolGoh03apnHLVk3aomH1xS3aqiH19B3araJdQu3aqPLcgX3apaNr0S3apsR+IV3aqTWZ0c' +
  '3arjapUb3artesoV3aqBi/IN3aqUnQsT3aparjAi3aqRu/w33apgw7VE3apmzWRO3aoj24lg3apd4Yh03aqp4GmG3ar328uU' +
  '3arc09Gm3apTzyq63apByMzN3aovvnzX3aq8rkTp3armn/fg3aqYjJDeCprtevndCpokaSTnCpqZVY/hCpp3QyDRCpoVNa/P' +
  'CppyICm6CpqfFY+kCpp/DFaJCppcEIh0CppjFm9jCprfGS5PCprAGeQ4CppvHQ8lCpq7JjwMCpqnMGgHCppxQ4oOCpqrV1YY' +
  'CpoxapkXCprtesQQCppDjDkHCppjn7UICpoSsmUaCprXv98zCpoox4o+CpoA1EZECpqj6S1cCpqV7oh0Cpog7XuICppM49iZ' +
  'CpoO3D6uCprp1hzECpovz2PWCprDwhThCppDssPzCppUorvvCpogjmrpvIjtenXnvIg0aNHtvIgkVFjrvIhkQDvbvIiTMOzb' +
  'vIgGGT7GvIg2C8StvIgAAFaMvIiSB4h0vIjOEFVivIgAFkpMvIgoFf8xvIgcF70YvIhHHwAAvIhUK90AvIg2QWoKvIiiVoUU' +
  'vIi2aXcVvIjterAMvIjEjKsDvIhToLgBvIhrtIkUvIi9wvAvvIgTyuk1vIit2+U7vIgb9QlXvIjo/Ih0vIgy+WWKvIhJ6Wae' +
  'vIi54uS1vIjT3Q7MvIhH1FXgvIg3xxLmvIgXtPL9vIhcpMP9vIhsjwvtQ3fteiHqQ3f+Z+7sQ3dKVLPsQ3cJQOreQ3ctL9vb' +
  'Q3cPGW3IQ3d/CeCqQ3eZA3yLQ3fDCYh0Q3eJEJFiQ3eaFpxNQ3fMFpozQ3ddGH4WQ3cQHscCQ3diLAYGQ3eOQjsJQ3dxVnoT' +
  'Q3ehac0VQ3fteuYNQ3erjDgGQ3fon5oGQ3cmsy0UQ3ffwuctQ3csy541Q3fo26U8Q3cr9NVVQ3f//4h0Q3eI+5uKQ3fT6fud' +
  'Q3c04mC1Q3ds3ZHKQ3d60yzjQ3dLyBfpQ3fgtDT+Q3dnpP//Q3eaj17n9WXtes3k9WWZaFDj9WU6Vhji9WVUQ2PV9WV4M0zQ' +
  '9WUeIOy+9WXmEXGh9WVeED+I9WUmE4h09WVEFtdj9WXoGmRR9WV/HOI69WX+Hr0d9WXLIvoR9WXTMk0Q9WXCRQEM9WVBV7AV' +
  '9WX8aXIY9WXtepET9WUKjJ8R9WWunSES9WWerwAa9WX9v3Av9WWKybA79WU61uhE9WXa6ANa9WUi9Ih09WW38i2J9WUV5USa' +
  '9WWU3A+u9WXE1h/A9WUJzWXZ9WXnw1Tj9WXZshTy9WUNohTz9WVkjljdIlXtemHcIlWgaRDYIlXGWLnTIlUZSDHMIlVGOO/E' +
  'IlXRJ82zIlVmHPOZIlWcG9mFIlVUG4h0IlW2HPNkIlXDH6JTIlU1ITVBIlW4JfwsIlWSLDQiIlVKOugaIlWMSYcRIlXcWGMZ' +
  'IlWiahUcIlXteisaIlUpi2AcIlU3m/4bIlUGrIggIlUyvEYyIlVxxmJAIlXG0AxMIlUJ3r5eIlXz5Yh0IlW7536HIlW73haX' +
  'IlWz1kimIlXozpS3IlXexmDMIlWmvafXIlXHrozjIlX2nuLiIlW/jHTSHEXtehDUHEXPaunOHEVOW2LIHEWOTInDHEV9Pby3' +
  'HEU4MfSoHEV7J8yUHEXTJCaEHEWjIoh0HEViIs5lHEXrJP9VHEX4JrNGHEWfLAk4HEXRNIAuHEXgQIsiHEUKTZIYHEUMW8Id' +
  'HEWBa6MgHEXtessgHEUcirQkHEXRmMUjHEV+qJQnHEWXt3k1HEVpwp5EHEXbymFSHEVb0zliHEUS2oh0HEXo3MeFHEVf1xqV' +
  'HEVo0aKhHEWqyCqxHEUcwQHGHEVMudvNHEW4qu3SHEU0m+baHEWWi6XKLzbtepXLLzYqbCXILzbCXe6/Lza3UKe3LzaBRBKs' +
  'LzZ8OmWfLzZXMsKQLzaELdmCLzbVKYh0LzaFKa1mLzYEK1VZLzbJLmdMLzZ4NBE/LzaZO8A2LzaFRgEpLzavUPsiLzYZXscj' +
  'LzaqbLAlLzbtejsoLzbWiKgrLzZWlj4sLzZUpHcxLzZUsX47LzYsvDpKLzYUw4RXLzZQyR5lLzbPzoh0LzYK0XSDLzaRzYKR' +
  'LzZFyc2dLzZGwmOsLzaKu/e4LzbYsUrDLzYCpnHGLzbRl2fMLzbBiUnDoijteiPAoijmbee8oig7Yc21oii8VRCuoigwS6mi' +
  'oigvQz2YoigMPNaMoijZNvGAoihlM4h0oigXMTNooiibM75coih8N4FRoiiTPA9GoigBQyE8oiieSzAvoiitVE8toihrYQQr' +
  'oigRblwsoijtej4woihfhzAzoih4kzg0oijfn/E7oihOqmlDoihFtFNPoij5ukZboiguwGpnoig/xIh0oihSxWeBoiiiw06O' +
  'oijSwNCboiiXvPinoiiDtVGxoijkq7a3oiidoDG9oiirlNDAoigCiPi2tRzteou0tRzHb+SvtRxAZR6rtRxFW6CltRztUUqc' +
  'tRzVSsWTtRxQRIWJtRwjQCp/tRxgPYh0tRzPO8ZptRwPPXdftRwLQIxVtRyDRPFLtRxkSsRBtRxMUUk7tRyVWvI3tRwNZTE0' +
  'tRzBb3A1tRztevU5tRykhfM8tRz7j0U/tRw9mgZFtRxUo0NMtRxLq+1TtRyasi9etRxktwNptRy8uoh0tRyIvNh/tRw4umSL' +
  'tRwHuAeXtRwTtMaftRzjrBqptRw9pQyttRwVm16xtRzYkIG0tRwShi2pohLtei6oohLVcTakohJHaaGfohJYYZmbohKuWYmV' +
  'ohIvUyyOohIGTuaFohJqSlx9ohIPSIh0ohLERkZrohL4RktiohJYSRBaohJhTedRohJRUsFLohIJWZJHohLcYMJBohLFaM4+' +
  'ohKrcTpAohLtes1CohLeg3NGohJQjM5JohJqlGlOohLRmx1TohLjouVZohKaqFZhohKwra9qohJjsIh0ohJQsSJ+ohLFr++G' +
  'ohK3rEKPohKsqJSXohLDo72eohJbnSCjohJrlQSnohIJjeCpohIohK6cmQrteo6amQoUdESYmQqHbdGVmQo/Z/KRmQqjYVKN' +
  'mQq7XACImQqmWPOBmQqbVW57mQqXU4h0mQrPUoBtmQpCU51mmQr+VONfmQq7V4tZmQqOW0ZVmQryYLJQmQqWZo9MmQrWbMpL' +
  'mQrdc19MmQrterFNmQrXgbFQmQpXiGhTmQqQjnhXmQoUlLpbmQogmVtgmQrBnXVmmQoOoVptmQr3ooh0mQqzo6Z7mQrRokmC' +
  'mQqqoLGImQq/nRuPmQoUmsiTmQrolB6YmQo0j06cmQr8iDCemQoQgouPvwTtemyOvwRHdqSMvwTecdWKvwSpbYGIvwTIaW2F' +
  'vwRsZsiBvwSpY8h9vwRzYUd5vwQZYIh0vwSfX79vvwQBYCBrvwRCYcRmvwRCY+divwQHZn9fvwRiaRFcvwQabV5ZvwRecWFZ' +
  'vwQtdmBZvwTtegZavwSgf9JbvwQVhPRdvwRDiO5gvwTuizlkvwQej7hnvwTZkZNrvwQJlOBvvwSElYh0vwT3lTR5vwSPldB9' +
  'vwRwlEWCvwSTknKGvwT6jxqKvwStjJiMvwSmiMmOvwRWhNSPvwSwf6iBMQHtelKBMQGaeKaAMQFddqV/MQFFdGF+MQFcctB8' +
  'MQG1cPx6MQFeb/h4MQFbbsl2MQG+bYh0MQGKbUZyMQG9bRNwMQFVbvttMQFLbwpsMQGZcERqMQE0ctVoMQEedM5nMQFDdgln' +
  'MQGMeAJnMQHtelhnMQFIfflnMQGQfxBpMQGtgX9qMQGQgyRsMQEzhQNuMQGJhhNwMQGGh0FyMQEoiIh0MQFhiNN2MQE0iBZ5' +
  'MQGmhz97MQGxhjh9MQFdhdd+MQGqgx+AMQG1gQ+BMQGPf5yBMQFGfQIAAwAAAAMABAAAAAQABQAAAAUABgAAAAYABwAAAAcA' +
  'CAAAAAgACQAAAAkACgAAAAoACwAAAAsADAAAAAwADQAAAA0ADgAAAA4ADwAAAA8AEAAAABAAEQAAABEAEgAAABIAEwAAABMA' +
  'FAAAABQAFQAAABUAFgAAABYAFwAAABcAGAAAABgAGQAAABkAGgAAABoAGwAAABsAHAAAABwAHQAAAB0AHgAAAB4AHwAAAB8A' +
  'IAAAACAAIQAAACEAIgAAACIAIwAAACMAJAAAACQAJQAAACUAAgAAACYAJwADACYAAwACACcAKAAEACcABAADACgAKQAFACgA' +
  'BQAEACkAKgAGACkABgAFACoAKwAHACoABwAGACsALAAIACsACAAHACwALQAJACwACQAIAC0ALgAKAC0ACgAJAC4ALwALAC4A' +
  'CwAKAC8AMAAMAC8ADAALADAAMQANADAADQAMADEAMgAOADEADgANADIAMwAPADIADwAOADMANAAQADMAEAAPADQANQARADQA' +
  'EQAQADUANgASADUAEgARADYANwATADYAEwASADcAOAAUADcAFAATADgAOQAVADgAFQAUADkAOgAWADkAFgAVADoAOwAXADoA' +
  'FwAWADsAPAAYADsAGAAXADwAPQAZADwAGQAYAD0APgAaAD0AGgAZAD4APwAbAD4AGwAaAD8AQAAcAD8AHAAbAEAAQQAdAEAA' +
  'HQAcAEEAQgAeAEEAHgAdAEIAQwAfAEIAHwAeAEMARAAgAEMAIAAfAEQARQAhAEQAIQAgAEUARgAiAEUAIgAhAEYARwAjAEYA' +
  'IwAiAEcASAAkAEcAJAAjAEgASQAlAEgAJQAkAEkAJgACAEkAAgAlAEoASwAnAEoAJwAmAEsATAAoAEsAKAAnAEwATQApAEwA' +
  'KQAoAE0ATgAqAE0AKgApAE4ATwArAE4AKwAqAE8AUAAsAE8ALAArAFAAUQAtAFAALQAsAFEAUgAuAFEALgAtAFIAUwAvAFIA' +
  'LwAuAFMAVAAwAFMAMAAvAFQAVQAxAFQAMQAwAFUAVgAyAFUAMgAxAFYAVwAzAFYAMwAyAFcAWAA0AFcANAAzAFgAWQA1AFgA' +
  'NQA0AFkAWgA2AFkANgA1AFoAWwA3AFoANwA2AFsAXAA4AFsAOAA3AFwAXQA5AFwAOQA4AF0AXgA6AF0AOgA5AF4AXwA7AF4A' +
  'OwA6AF8AYAA8AF8APAA7AGAAYQA9AGAAPQA8AGEAYgA+AGEAPgA9AGIAYwA/AGIAPwA+AGMAZABAAGMAQAA/AGQAZQBBAGQA' +
  'QQBAAGUAZgBCAGUAQgBBAGYAZwBDAGYAQwBCAGcAaABEAGcARABDAGgAaQBFAGgARQBEAGkAagBGAGkARgBFAGoAawBHAGoA' +
  'RwBGAGsAbABIAGsASABHAGwAbQBJAGwASQBIAG0ASgAmAG0AJgBJAG4AbwBLAG4ASwBKAG8AcABMAG8ATABLAHAAcQBNAHAA' +
  'TQBMAHEAcgBOAHEATgBNAHIAcwBPAHIATwBOAHMAdABQAHMAUABPAHQAdQBRAHQAUQBQAHUAdgBSAHUAUgBRAHYAdwBTAHYA' +
  'UwBSAHcAeABUAHcAVABTAHgAeQBVAHgAVQBUAHkAegBWAHkAVgBVAHoAewBXAHoAVwBWAHsAfABYAHsAWABXAHwAfQBZAHwA' +
  'WQBYAH0AfgBaAH0AWgBZAH4AfwBbAH4AWwBaAH8AgABcAH8AXABbAIAAgQBdAIAAXQBcAIEAggBeAIEAXgBdAIIAgwBfAIIA' +
  'XwBeAIMAhABgAIMAYABfAIQAhQBhAIQAYQBgAIUAhgBiAIUAYgBhAIYAhwBjAIYAYwBiAIcAiABkAIcAZABjAIgAiQBlAIgA' +
  'ZQBkAIkAigBmAIkAZgBlAIoAiwBnAIoAZwBmAIsAjABoAIsAaABnAIwAjQBpAIwAaQBoAI0AjgBqAI0AagBpAI4AjwBrAI4A' +
  'awBqAI8AkABsAI8AbABrAJAAkQBtAJAAbQBsAJEAbgBKAJEASgBtAJIAkwBvAJIAbwBuAJMAlABwAJMAcABvAJQAlQBxAJQA' +
  'cQBwAJUAlgByAJUAcgBxAJYAlwBzAJYAcwByAJcAmAB0AJcAdABzAJgAmQB1AJgAdQB0AJkAmgB2AJkAdgB1AJoAmwB3AJoA' +
  'dwB2AJsAnAB4AJsAeAB3AJwAnQB5AJwAeQB4AJ0AngB6AJ0AegB5AJ4AnwB7AJ4AewB6AJ8AoAB8AJ8AfAB7AKAAoQB9AKAA' +
  'fQB8AKEAogB+AKEAfgB9AKIAowB/AKIAfwB+AKMApACAAKMAgAB/AKQApQCBAKQAgQCAAKUApgCCAKUAggCBAKYApwCDAKYA' +
  'gwCCAKcAqACEAKcAhACDAKgAqQCFAKgAhQCEAKkAqgCGAKkAhgCFAKoAqwCHAKoAhwCGAKsArACIAKsAiACHAKwArQCJAKwA' +
  'iQCIAK0ArgCKAK0AigCJAK4ArwCLAK4AiwCKAK8AsACMAK8AjACLALAAsQCNALAAjQCMALEAsgCOALEAjgCNALIAswCPALIA' +
  'jwCOALMAtACQALMAkACPALQAtQCRALQAkQCQALUAkgBuALUAbgCRALYAtwCTALYAkwCSALcAuACUALcAlACTALgAuQCVALgA' +
  'lQCUALkAugCWALkAlgCVALoAuwCXALoAlwCWALsAvACYALsAmACXALwAvQCZALwAmQCYAL0AvgCaAL0AmgCZAL4AvwCbAL4A' +
  'mwCaAL8AwACcAL8AnACbAMAAwQCdAMAAnQCcAMEAwgCeAMEAngCdAMIAwwCfAMIAnwCeAMMAxACgAMMAoACfAMQAxQChAMQA' +
  'oQCgAMUAxgCiAMUAogChAMYAxwCjAMYAowCiAMcAyACkAMcApACjAMgAyQClAMgApQCkAMkAygCmAMkApgClAMoAywCnAMoA' +
  'pwCmAMsAzACoAMsAqACnAMwAzQCpAMwAqQCoAM0AzgCqAM0AqgCpAM4AzwCrAM4AqwCqAM8A0ACsAM8ArACrANAA0QCtANAA' +
  'rQCsANEA0gCuANEArgCtANIA0wCvANIArwCuANMA1ACwANMAsACvANQA1QCxANQAsQCwANUA1gCyANUAsgCxANYA1wCzANYA' +
  'swCyANcA2AC0ANcAtACzANgA2QC1ANgAtQC0ANkAtgCSANkAkgC1ANoA2wC3ANoAtwC2ANsA3AC4ANsAuAC3ANwA3QC5ANwA' +
  'uQC4AN0A3gC6AN0AugC5AN4A3wC7AN4AuwC6AN8A4AC8AN8AvAC7AOAA4QC9AOAAvQC8AOEA4gC+AOEAvgC9AOIA4wC/AOIA' +
  'vwC+AOMA5ADAAOMAwAC/AOQA5QDBAOQAwQDAAOUA5gDCAOUAwgDBAOYA5wDDAOYAwwDCAOcA6ADEAOcAxADDAOgA6QDFAOgA' +
  'xQDEAOkA6gDGAOkAxgDFAOoA6wDHAOoAxwDGAOsA7ADIAOsAyADHAOwA7QDJAOwAyQDIAO0A7gDKAO0AygDJAO4A7wDLAO4A' +
  'ywDKAO8A8ADMAO8AzADLAPAA8QDNAPAAzQDMAPEA8gDOAPEAzgDNAPIA8wDPAPIAzwDOAPMA9ADQAPMA0ADPAPQA9QDRAPQA' +
  '0QDQAPUA9gDSAPUA0gDRAPYA9wDTAPYA0wDSAPcA+ADUAPcA1ADTAPgA+QDVAPgA1QDUAPkA+gDWAPkA1gDVAPoA+wDXAPoA' +
  '1wDWAPsA/ADYAPsA2ADXAPwA/QDZAPwA2QDYAP0A2gC2AP0AtgDZAP4A/wDbAP4A2wDaAP8AAAHcAP8A3ADbAAABAQHdAAAB' +
  '3QDcAAEBAgHeAAEB3gDdAAIBAwHfAAIB3wDeAAMBBAHgAAMB4ADfAAQBBQHhAAQB4QDgAAUBBgHiAAUB4gDhAAYBBwHjAAYB' +
  '4wDiAAcBCAHkAAcB5ADjAAgBCQHlAAgB5QDkAAkBCgHmAAkB5gDlAAoBCwHnAAoB5wDmAAsBDAHoAAsB6ADnAAwBDQHpAAwB' +
  '6QDoAA0BDgHqAA0B6gDpAA4BDwHrAA4B6wDqAA8BEAHsAA8B7ADrABABEQHtABAB7QDsABEBEgHuABEB7gDtABIBEwHvABIB' +
  '7wDuABMBFAHwABMB8ADvABQBFQHxABQB8QDwABUBFgHyABUB8gDxABYBFwHzABYB8wDyABcBGAH0ABcB9ADzABgBGQH1ABgB' +
  '9QD0ABkBGgH2ABkB9gD1ABoBGwH3ABoB9wD2ABsBHAH4ABsB+AD3ABwBHQH5ABwB+QD4AB0BHgH6AB0B+gD5AB4BHwH7AB4B' +
  '+wD6AB8BIAH8AB8B/AD7ACABIQH9ACAB/QD8ACEB/gDaACEB2gD9ACIBIwH/ACIB/wD+ACMBJAEAASMBAAH/ACQBJQEBASQB' +
  'AQEAASUBJgECASUBAgEBASYBJwEDASYBAwECAScBKAEEAScBBAEDASgBKQEFASgBBQEEASkBKgEGASkBBgEFASoBKwEHASoB' +
  'BwEGASsBLAEIASsBCAEHASwBLQEJASwBCQEIAS0BLgEKAS0BCgEJAS4BLwELAS4BCwEKAS8BMAEMAS8BDAELATABMQENATAB' +
  'DQEMATEBMgEOATEBDgENATIBMwEPATIBDwEOATMBNAEQATMBEAEPATQBNQERATQBEQEQATUBNgESATUBEgERATYBNwETATYB' +
  'EwESATcBOAEUATcBFAETATgBOQEVATgBFQEUATkBOgEWATkBFgEVAToBOwEXAToBFwEWATsBPAEYATsBGAEXATwBPQEZATwB' +
  'GQEYAT0BPgEaAT0BGgEZAT4BPwEbAT4BGwEaAT8BQAEcAT8BHAEbAUABQQEdAUABHQEcAUEBQgEeAUEBHgEdAUIBQwEfAUIB' +
  'HwEeAUMBRAEgAUMBIAEfAUQBRQEhAUQBIQEgAUUBIgH+AEUB/gAhAUYBRwEjAUYBIwEiAUcBSAEkAUcBJAEjAUgBSQElAUgB' +
  'JQEkAUkBSgEmAUkBJgElAUoBSwEnAUoBJwEmAUsBTAEoAUsBKAEnAUwBTQEpAUwBKQEoAU0BTgEqAU0BKgEpAU4BTwErAU4B' +
  'KwEqAU8BUAEsAU8BLAErAVABUQEtAVABLQEsAVEBUgEuAVEBLgEtAVIBUwEvAVIBLwEuAVMBVAEwAVMBMAEvAVQBVQExAVQB' +
  'MQEwAVUBVgEyAVUBMgExAVYBVwEzAVYBMwEyAVcBWAE0AVcBNAEzAVgBWQE1AVgBNQE0AVkBWgE2AVkBNgE1AVoBWwE3AVoB' +
  'NwE2AVsBXAE4AVsBOAE3AVwBXQE5AVwBOQE4AV0BXgE6AV0BOgE5AV4BXwE7AV4BOwE6AV8BYAE8AV8BPAE7AWABYQE9AWAB' +
  'PQE8AWEBYgE+AWEBPgE9AWIBYwE/AWIBPwE+AWMBZAFAAWMBQAE/AWQBZQFBAWQBQQFAAWUBZgFCAWUBQgFBAWYBZwFDAWYB' +
  'QwFCAWcBaAFEAWcBRAFDAWgBaQFFAWgBRQFEAWkBRgEiAWkBIgFFAWoBawFHAWoBRwFGAWsBbAFIAWsBSAFHAWwBbQFJAWwB' +
  'SQFIAW0BbgFKAW0BSgFJAW4BbwFLAW4BSwFKAW8BcAFMAW8BTAFLAXABcQFNAXABTQFMAXEBcgFOAXEBTgFNAXIBcwFPAXIB' +
  'TwFOAXMBdAFQAXMBUAFPAXQBdQFRAXQBUQFQAXUBdgFSAXUBUgFRAXYBdwFTAXYBUwFSAXcBeAFUAXcBVAFTAXgBeQFVAXgB' +
  'VQFUAXkBegFWAXkBVgFVAXoBewFXAXoBVwFWAXsBfAFYAXsBWAFXAXwBfQFZAXwBWQFYAX0BfgFaAX0BWgFZAX4BfwFbAX4B' +
  'WwFaAX8BgAFcAX8BXAFbAYABgQFdAYABXQFcAYEBggFeAYEBXgFdAYIBgwFfAYIBXwFeAYMBhAFgAYMBYAFfAYQBhQFhAYQB' +
  'YQFgAYUBhgFiAYUBYgFhAYYBhwFjAYYBYwFiAYcBiAFkAYcBZAFjAYgBiQFlAYgBZQFkAYkBigFmAYkBZgFlAYoBiwFnAYoB' +
  'ZwFmAYsBjAFoAYsBaAFnAYwBjQFpAYwBaQFoAY0BagFGAY0BRgFpAY4BjwFrAY4BawFqAY8BkAFsAY8BbAFrAZABkQFtAZAB' +
  'bQFsAZEBkgFuAZEBbgFtAZIBkwFvAZIBbwFuAZMBlAFwAZMBcAFvAZQBlQFxAZQBcQFwAZUBlgFyAZUBcgFxAZYBlwFzAZYB' +
  'cwFyAZcBmAF0AZcBdAFzAZgBmQF1AZgBdQF0AZkBmgF2AZkBdgF1AZoBmwF3AZoBdwF2AZsBnAF4AZsBeAF3AZwBnQF5AZwB' +
  'eQF4AZ0BngF6AZ0BegF5AZ4BnwF7AZ4BewF6AZ8BoAF8AZ8BfAF7AaABoQF9AaABfQF8AaEBogF+AaEBfgF9AaIBowF/AaIB' +
  'fwF+AaMBpAGAAaMBgAF/AaQBpQGBAaQBgQGAAaUBpgGCAaUBggGBAaYBpwGDAaYBgwGCAacBqAGEAacBhAGDAagBqQGFAagB' +
  'hQGEAakBqgGGAakBhgGFAaoBqwGHAaoBhwGGAasBrAGIAasBiAGHAawBrQGJAawBiQGIAa0BrgGKAa0BigGJAa4BrwGLAa4B' +
  'iwGKAa8BsAGMAa8BjAGLAbABsQGNAbABjQGMAbEBjgFqAbEBagGNAbIBswGPAbIBjwGOAbMBtAGQAbMBkAGPAbQBtQGRAbQB' +
  'kQGQAbUBtgGSAbUBkgGRAbYBtwGTAbYBkwGSAbcBuAGUAbcBlAGTAbgBuQGVAbgBlQGUAbkBugGWAbkBlgGVAboBuwGXAboB' +
  'lwGWAbsBvAGYAbsBmAGXAbwBvQGZAbwBmQGYAb0BvgGaAb0BmgGZAb4BvwGbAb4BmwGaAb8BwAGcAb8BnAGbAcABwQGdAcAB' +
  'nQGcAcEBwgGeAcEBngGdAcIBwwGfAcIBnwGeAcMBxAGgAcMBoAGfAcQBxQGhAcQBoQGgAcUBxgGiAcUBogGhAcYBxwGjAcYB' +
  'owGiAccByAGkAccBpAGjAcgByQGlAcgBpQGkAckBygGmAckBpgGlAcoBywGnAcoBpwGmAcsBzAGoAcsBqAGnAcwBzQGpAcwB' +
  'qQGoAc0BzgGqAc0BqgGpAc4BzwGrAc4BqwGqAc8B0AGsAc8BrAGrAdAB0QGtAdABrQGsAdEB0gGuAdEBrgGtAdIB0wGvAdIB' +
  'rwGuAdMB1AGwAdMBsAGvAdQB1QGxAdQBsQGwAdUBsgGOAdUBjgGxAdYB1wGzAdYBswGyAdcB2AG0AdcBtAGzAdgB2QG1AdgB' +
  'tQG0AdkB2gG2AdkBtgG1AdoB2wG3AdoBtwG2AdsB3AG4AdsBuAG3AdwB3QG5AdwBuQG4Ad0B3gG6Ad0BugG5Ad4B3wG7Ad4B' +
  'uwG6Ad8B4AG8Ad8BvAG7AeAB4QG9AeABvQG8AeEB4gG+AeEBvgG9AeIB4wG/AeIBvwG+AeMB5AHAAeMBwAG/AeQB5QHBAeQB' +
  'wQHAAeUB5gHCAeUBwgHBAeYB5wHDAeYBwwHCAecB6AHEAecBxAHDAegB6QHFAegBxQHEAekB6gHGAekBxgHFAeoB6wHHAeoB' +
  'xwHGAesB7AHIAesByAHHAewB7QHJAewByQHIAe0B7gHKAe0BygHJAe4B7wHLAe4BywHKAe8B8AHMAe8BzAHLAfAB8QHNAfAB' +
  'zQHMAfEB8gHOAfEBzgHNAfIB8wHPAfIBzwHOAfMB9AHQAfMB0AHPAfQB9QHRAfQB0QHQAfUB9gHSAfUB0gHRAfYB9wHTAfYB' +
  '0wHSAfcB+AHUAfcB1AHTAfgB+QHVAfgB1QHUAfkB1gGyAfkBsgHVAfoB+wHXAfoB1wHWAfsB/AHYAfsB2AHXAfwB/QHZAfwB' +
  '2QHYAf0B/gHaAf0B2gHZAf4B/wHbAf4B2wHaAf8BAALcAf8B3AHbAQACAQLdAQAC3QHcAQECAgLeAQEC3gHdAQICAwLfAQIC' +
  '3wHeAQMCBALgAQMC4AHfAQQCBQLhAQQC4QHgAQUCBgLiAQUC4gHhAQYCBwLjAQYC4wHiAQcCCALkAQcC5AHjAQgCCQLlAQgC' +
  '5QHkAQkCCgLmAQkC5gHlAQoCCwLnAQoC5wHmAQsCDALoAQsC6AHnAQwCDQLpAQwC6QHoAQ0CDgLqAQ0C6gHpAQ4CDwLrAQ4C' +
  '6wHqAQ8CEALsAQ8C7AHrARACEQLtARAC7QHsARECEgLuAREC7gHtARICEwLvARIC7wHuARMCFALwARMC8AHvARQCFQLxARQC' +
  '8QHwARUCFgLyARUC8gHxARYCFwLzARYC8wHyARcCGAL0ARcC9AHzARgCGQL1ARgC9QH0ARkCGgL2ARkC9gH1ARoCGwL3ARoC' +
  '9wH2ARsCHAL4ARsC+AH3ARwCHQL5ARwC+QH4AR0C+gHWAR0C1gH5AR4CHwL7AR4C+wH6AR8CIAL8AR8C/AH7ASACIQL9ASAC' +
  '/QH8ASECIgL+ASEC/gH9ASICIwL/ASIC/wH+ASMCJAIAAiMCAAL/ASQCJQIBAiQCAQIAAiUCJgICAiUCAgIBAiYCJwIDAiYC' +
  'AwICAicCKAIEAicCBAIDAigCKQIFAigCBQIEAikCKgIGAikCBgIFAioCKwIHAioCBwIGAisCLAIIAisCCAIHAiwCLQIJAiwC' +
  'CQIIAi0CLgIKAi0CCgIJAi4CLwILAi4CCwIKAi8CMAIMAi8CDAILAjACMQINAjACDQIMAjECMgIOAjECDgINAjICMwIPAjIC' +
  'DwIOAjMCNAIQAjMCEAIPAjQCNQIRAjQCEQIQAjUCNgISAjUCEgIRAjYCNwITAjYCEwISAjcCOAIUAjcCFAITAjgCOQIVAjgC' +
  'FQIUAjkCOgIWAjkCFgIVAjoCOwIXAjoCFwIWAjsCPAIYAjsCGAIXAjwCPQIZAjwCGQIYAj0CPgIaAj0CGgIZAj4CPwIbAj4C' +
  'GwIaAj8CQAIcAj8CHAIbAkACQQIdAkACHQIcAkECHgL6AUEC+gEdAkICQwIfAkICHwIeAkMCRAIgAkMCIAIfAkQCRQIhAkQC' +
  'IQIgAkUCRgIiAkUCIgIhAkYCRwIjAkYCIwIiAkcCSAIkAkcCJAIjAkgCSQIlAkgCJQIkAkkCSgImAkkCJgIlAkoCSwInAkoC' +
  'JwImAksCTAIoAksCKAInAkwCTQIpAkwCKQIoAk0CTgIqAk0CKgIpAk4CTwIrAk4CKwIqAk8CUAIsAk8CLAIrAlACUQItAlAC' +
  'LQIsAlECUgIuAlECLgItAlICUwIvAlICLwIuAlMCVAIwAlMCMAIvAlQCVQIxAlQCMQIwAlUCVgIyAlUCMgIxAlYCVwIzAlYC' +
  'MwIyAlcCWAI0AlcCNAIzAlgCWQI1AlgCNQI0AlkCWgI2AlkCNgI1AloCWwI3AloCNwI2AlsCXAI4AlsCOAI3AlwCXQI5AlwC' +
  'OQI4Al0CXgI6Al0COgI5Al4CXwI7Al4COwI6Al8CYAI8Al8CPAI7AmACYQI9AmACPQI8AmECYgI+AmECPgI9AmICYwI/AmIC' +
  'PwI+AmMCZAJAAmMCQAI/AmQCZQJBAmQCQQJAAmUCQgIeAmUCHgJBAmYCZwJDAmYCQwJCAmcCaAJEAmcCRAJDAmgCaQJFAmgC' +
  'RQJEAmkCagJGAmkCRgJFAmoCawJHAmoCRwJGAmsCbAJIAmsCSAJHAmwCbQJJAmwCSQJIAm0CbgJKAm0CSgJJAm4CbwJLAm4C' +
  'SwJKAm8CcAJMAm8CTAJLAnACcQJNAnACTQJMAnECcgJOAnECTgJNAnICcwJPAnICTwJOAnMCdAJQAnMCUAJPAnQCdQJRAnQC' +
  'UQJQAnUCdgJSAnUCUgJRAnYCdwJTAnYCUwJSAncCeAJUAncCVAJTAngCeQJVAngCVQJUAnkCegJWAnkCVgJVAnoCewJXAnoC' +
  'VwJWAnsCfAJYAnsCWAJXAnwCfQJZAnwCWQJYAn0CfgJaAn0CWgJZAn4CfwJbAn4CWwJaAn8CgAJcAn8CXAJbAoACgQJdAoAC' +
  'XQJcAoECggJeAoECXgJdAoICgwJfAoICXwJeAoMChAJgAoMCYAJfAoQChQJhAoQCYQJgAoUChgJiAoUCYgJhAoYChwJjAoYC' +
  'YwJiAocCiAJkAocCZAJjAogCiQJlAogCZQJkAokCZgJCAokCQgJlAooCiwJnAooCZwJmAosCjAJoAosCaAJnAowCjQJpAowC' +
  'aQJoAo0CjgJqAo0CagJpAo4CjwJrAo4CawJqAo8CkAJsAo8CbAJrApACkQJtApACbQJsApECkgJuApECbgJtApICkwJvApIC' +
  'bwJuApMClAJwApMCcAJvApQClQJxApQCcQJwApUClgJyApUCcgJxApYClwJzApYCcwJyApcCmAJ0ApcCdAJzApgCmQJ1ApgC' +
  'dQJ0ApkCmgJ2ApkCdgJ1ApoCmwJ3ApoCdwJ2ApsCnAJ4ApsCeAJ3ApwCnQJ5ApwCeQJ4Ap0CngJ6Ap0CegJ5Ap4CnwJ7Ap4C' +
  'ewJ6Ap8CoAJ8Ap8CfAJ7AqACoQJ9AqACfQJ8AqECogJ+AqECfgJ9AqICowJ/AqICfwJ+AqMCpAKAAqMCgAJ/AqQCpQKBAqQC' +
  'gQKAAqUCpgKCAqUCggKBAqYCpwKDAqYCgwKCAqcCqAKEAqcChAKDAqgCqQKFAqgChQKEAqkCqgKGAqkChgKFAqoCqwKHAqoC' +
  'hwKGAqsCrAKIAqsCiAKHAqwCrQKJAqwCiQKIAq0CigJmAq0CZgKJAq4CrwKLAq4CiwKKAq8CsAKMAq8CjAKLArACsQKNArAC' +
  'jQKMArECsgKOArECjgKNArICswKPArICjwKOArMCtAKQArMCkAKPArQCtQKRArQCkQKQArUCtgKSArUCkgKRArYCtwKTArYC' +
  'kwKSArcCuAKUArcClAKTArgCuQKVArgClQKUArkCugKWArkClgKVAroCuwKXAroClwKWArsCvAKYArsCmAKXArwCvQKZArwC' +
  'mQKYAr0CvgKaAr0CmgKZAr4CvwKbAr4CmwKaAr8CwAKcAr8CnAKbAsACwQKdAsACnQKcAsECwgKeAsECngKdAsICwwKfAsIC' +
  'nwKeAsMCxAKgAsMCoAKfAsQCxQKhAsQCoQKgAsUCxgKiAsUCogKhAsYCxwKjAsYCowKiAscCyAKkAscCpAKjAsgCyQKlAsgC' +
  'pQKkAskCygKmAskCpgKlAsoCywKnAsoCpwKmAssCzAKoAssCqAKnAswCzQKpAswCqQKoAs0CzgKqAs0CqgKpAs4CzwKrAs4C' +
  'qwKqAs8C0AKsAs8CrAKrAtAC0QKtAtACrQKsAtECrgKKAtECigKtAtIC0wKvAtICrwKuAtMC1AKwAtMCsAKvAtQC1QKxAtQC' +
  'sQKwAtUC1gKyAtUCsgKxAtYC1wKzAtYCswKyAtcC2AK0AtcCtAKzAtgC2QK1AtgCtQK0AtkC2gK2AtkCtgK1AtoC2wK3AtoC' +
  'twK2AtsC3AK4AtsCuAK3AtwC3QK5AtwCuQK4At0C3gK6At0CugK5At4C3wK7At4CuwK6At8C4AK8At8CvAK7AuAC4QK9AuAC' +
  'vQK8AuEC4gK+AuECvgK9AuIC4wK/AuICvwK+AuMC5ALAAuMCwAK/AuQC5QLBAuQCwQLAAuUC5gLCAuUCwgLBAuYC5wLDAuYC' +
  'wwLCAucC6ALEAucCxALDAugC6QLFAugCxQLEAukC6gLGAukCxgLFAuoC6wLHAuoCxwLGAusC7ALIAusCyALHAuwC7QLJAuwC' +
  'yQLIAu0C7gLKAu0CygLJAu4C7wLLAu4CywLKAu8C8ALMAu8CzALLAvAC8QLNAvACzQLMAvEC8gLOAvECzgLNAvIC8wLPAvIC' +
  'zwLOAvMC9ALQAvMC0ALPAvQC9QLRAvQC0QLQAvUC0gKuAvUCrgLRAvYC9wLTAvYC0wLSAvcC+ALUAvcC1ALTAvgC+QLVAvgC' +
  '1QLUAvkC+gLWAvkC1gLVAvoC+wLXAvoC1wLWAvsC/ALYAvsC2ALXAvwC/QLZAvwC2QLYAv0C/gLaAv0C2gLZAv4C/wLbAv4C' +
  '2wLaAv8CAAPcAv8C3ALbAgADAQPdAgAD3QLcAgEDAgPeAgED3gLdAgIDAwPfAgID3wLeAgMDBAPgAgMD4ALfAgQDBQPhAgQD' +
  '4QLgAgUDBgPiAgUD4gLhAgYDBwPjAgYD4wLiAgcDCAPkAgcD5ALjAggDCQPlAggD5QLkAgkDCgPmAgkD5gLlAgoDCwPnAgoD' +
  '5wLmAgsDDAPoAgsD6ALnAgwDDQPpAgwD6QLoAg0DDgPqAg0D6gLpAg4DDwPrAg4D6wLqAg8DEAPsAg8D7ALrAhADEQPtAhAD' +
  '7QLsAhEDEgPuAhED7gLtAhIDEwPvAhID7wLuAhMDFAPwAhMD8ALvAhQDFQPxAhQD8QLwAhUDFgPyAhUD8gLxAhYDFwPzAhYD' +
  '8wLyAhcDGAP0AhcD9ALzAhgDGQP1AhgD9QL0AhkD9gLSAhkD0gL1AgEA9wL2AgEA+AL3AgEA+QL4AgEA+gL5AgEA+wL6AgEA' +
  '/AL7AgEA/QL8AgEA/gL9AgEA/wL+AgEAAAP/AgEAAQMAAwEAAgMBAwEAAwMCAwEABAMDAwEABQMEAwEABgMFAwEABwMGAwEA' +
  'CAMHAwEACQMIAwEACgMJAwEACwMKAwEADAMLAwEADQMMAwEADgMNAwEADwMOAwEAEAMPAwEAEQMQAwEAEgMRAwEAEwMSAwEA' +
  'FAMTAwEAFQMUAwEAFgMVAwEAFwMWAwEAGAMXAwEAGQMYAwEA9gIZAw==';
// Unpack to a float position array and a triangle index list.
function decodeMesh(b64) {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(buf);

  const lo = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true)];
  const span = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
  const nVerts = dv.getUint16(24, true);
  const nTris = dv.getUint16(26, true);

  const quant = new Uint16Array(buf, 28, nVerts * 3);
  const pos = new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) {
    for (let a = 0; a < 3; a++) {
      // back to model units, then centred on the box so rotation turns it about itself
      pos[i * 3 + a] = lo[a] + (quant[i * 3 + a] / 65535) * span[a] - (lo[a] + span[a] * 0.5);
    }
  }
  const idx = new Uint16Array(buf, 28 + nVerts * 6, nTris * 3);
  return { pos, idx, span };
}

// ---------------------------------------------------------------- the maps
// Rasterise the mesh into what the scatter actually reads: a depth map, and the z of the
// surface normal. This is a z-buffer over triangles — the job a GPU does, done on the CPU
// because it runs once over 1.5k triangles at load, and because reading a render target
// back would cost a stall and give the same answer.
//
// Depth comes out 0 OUTSIDE the model, which is what makes the mask: the reference cuts
// its portrait out of the frame with the same test, because the background of a depth map
// is zero there too. Nothing else is needed to find the silhouette.
function rasteriseMaps(res) {
  const { pos, idx } = decodeMesh(MESH_B64);
  const nVerts = pos.length / 3;

  // orientation, applied to the geometry rather than to the sampled points: the maps have
  // to be rasterised from the view the cloud is seen from
  const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(CONFIG.modelRotX),
    THREE.MathUtils.degToRad(CONFIG.modelRotY),
    THREE.MathUtils.degToRad(CONFIG.modelRotZ)
  ));
  const v = new THREE.Vector3();
  for (let i = 0; i < nVerts; i++) {
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(rot);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
  }

  // Smooth normals, accumulated from the faces. Per-FACE normals would band the size
  // response into 1584 flat patches, and at this triangle count the banding is visible as
  // facets in the rim motes.
  const nrm = new Float32Array(nVerts * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    // the cross product's length is twice the triangle's area, so leaving it unnormalised
    // weights each face by its size, which is what a smooth normal wants
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
  }
  for (let i = 0; i < nVerts; i++) {
    const o = i * 3;
    const l = Math.hypot(nrm[o], nrm[o + 1], nrm[o + 2]) || 1;
    nrm[o] /= l; nrm[o + 1] /= l; nrm[o + 2] /= l;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < nVerts; i++) {
    minX = Math.min(minX, pos[i * 3]); maxX = Math.max(maxX, pos[i * 3]);
    minY = Math.min(minY, pos[i * 3 + 1]); maxY = Math.max(maxY, pos[i * 3 + 1]);
    minZ = Math.min(minZ, pos[i * 3 + 2]); maxZ = Math.max(maxZ, pos[i * 3 + 2]);
  }
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const spanZ = Math.max(1e-9, maxZ - minZ);

  const depth = new Float32Array(res * res);      // 0 outside, 0..1 inside, 1 = nearest
  const normZ = new Float32Array(res * res);      // (n.z + 1) / 2

  // Orthographic on purpose. The cloud subtends a small angle and is fitted to the frame
  // by proportion, so a perspective rasterisation would differ by less than a map cell and
  // would need a camera the maps do not otherwise care about.
  const toPx = (x) => (x - minX) / spanX * (res - 1);
  const toPy = (y) => (maxY - y) / spanY * (res - 1);   // row 0 is the TOP, as in an image

  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
    const ax = toPx(pos[ia * 3]), ay = toPy(pos[ia * 3 + 1]);
    const bx = toPx(pos[ib * 3]), by = toPy(pos[ib * 3 + 1]);
    const cx = toPx(pos[ic * 3]), cy = toPy(pos[ic * 3 + 1]);

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;           // edge-on, contributes no pixels
    const inv = 1 / area;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(res - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(res - 1, Math.ceil(Math.max(ay, by, cy)));

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // barycentric at the pixel centre
        const qx = px + 0.5, qy = py + 0.5;
        const w0 = ((bx - qx) * (cy - qy) - (by - qy) * (cx - qx)) * inv;
        const w1 = ((cx - qx) * (ay - qy) - (cy - qy) * (ax - qx)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const z = w0 * pos[ia * 3 + 2] + w1 * pos[ib * 3 + 2] + w2 * pos[ic * 3 + 2];
        const d = (z - minZ) / spanZ;
        const o = py * res + px;
        // NEAREST wins, and the camera looks down -z, so that is the larger z. Keeping the
        // far surface instead would seat the motes on the back of the lens, where they
        // would be lit from behind and read as a hole.
        if (d + 1e-6 > depth[o]) {
          depth[o] = Math.max(d, 1e-4);            // inside but at the far wall is still inside
          const nz = w0 * nrm[ia * 3 + 2] + w1 * nrm[ib * 3 + 2] + w2 * nrm[ic * 3 + 2];
          normZ[o] = nz * 0.5 + 0.5;
        }
      }
    }
  }
  return { depth, normZ, res, aspect: spanX / spanY };
}

// ---------------------------------------------------------------- geometry
// One quad, instanced. Per-mote values are generated once on the CPU: seat on the model,
// size multiplier, brightness, and which of the two roles it takes.
let seatHalfDepth = 0;    // half the depth the seats came out occupying, in world units
let seatPlaneW = 0;       // world width of the plane the model was fitted to
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
  const shapes     = new Float32Array(count);
  const lives      = new Float32Array(count);

  const vh = viewHeightAt(CONFIG.anchorZ);
  const halfW = CONFIG.boxWidth  * vh * 0.5;
  const halfH = CONFIG.boxHeight * vh * 0.5;
  const halfD = CONFIG.boxDepth  * vh * 0.5;

  // The maps, and the plane they cover. The model is fitted to the box on its TIGHTEST
  // axis so its proportions survive — stretching it to fill the box would make the shape
  // depend on the box, and the shape is the one thing that now comes from the model.
  const maps = rasteriseMaps(CONFIG.mapResolution);
  const fit = Math.min((halfW * 2) / maps.aspect, halfH * 2);
  const planeH = fit;
  const planeW = fit * maps.aspect;
  const depthSpan = CONFIG.depthDisplacement * planeW;
  seatPlaneW = planeW;
  const mapAt = (arr, x, y) => {
    // nearest cell. Bilinear would only smooth a map whose resolution is already finer
    // than the motes it seats, and the depth map has a hard edge at the silhouette that
    // interpolation would drag outward into the background.
    const px = Math.min(maps.res - 1, Math.max(0, Math.floor(x * maps.res)));
    const py = Math.min(maps.res - 1, Math.max(0, Math.floor(y * maps.res)));
    return arr[py * maps.res + px];
  };

  const baseDir = new THREE.Vector3(
    CONFIG.floatingDirectionX, CONFIG.floatingDirectionY, CONFIG.floatingDirectionZ
  );
  if (baseDir.lengthSq() === 0) baseDir.set(0, 1, 0);
  baseDir.normalize();

  // THROW AND TEST, in two dimensions. A point is thrown at the frame, the maps are read
  // where it lands, and it is kept if there is surface under it — no walk over the
  // geometry, no per-triangle bookkeeping. What makes this correct rather than merely cheap
  // is that the throw is uniform over the frame and the test is a plain accept: whatever
  // survives is uniformly dense over the model's PROJECTED area, which is the area the
  // viewer sees. A scatter weighted by surface area instead would crowd the motes wherever
  // the surface turns away from the camera, which is the rim — and the rim is exactly where
  // the eye reads the silhouette.
  //
  // The retry count is bounded and the last throw is taken wherever it fell. A mote
  // stranded in the background is one mote in thirty thousand, and insisting on a hit makes
  // the cost unbounded as the mask gets tighter.
  //
  // Lifted out of the loop because the strands need it too: a strand begins at an ordinary
  // seat and walks away from it.
  const seat = { x: 0, y: 0, z: 0, nz01: 1 };
  function sampleSeat() {
    let u = 0, w = 0, mapDepth = 0, nz01 = 1;
    for (let tries = 0; tries < CONFIG.sampleAttempts; tries++) {
      if (CONFIG.cornerDensity > 0) {
        // THROW crowded toward the corner, rather than throwing evenly and rejecting what
        // lands far out. Rejection was the first attempt and it fails in a way worth
        // recording: every rejected throw still costs an attempt, the attempts are bounded,
        // and a throw that runs out is kept wherever it last fell — which is uniform. Past
        // a certain strength almost every mote ran out, so turning the dial up stopped
        // concentrating the cloud and started scattering it. Coverage at the corner fell
        // from 0.98 to 0.39 while it was supposedly being made denser.
        //
        // Weighting the draw has no such cliff: every throw lands where it is wanted, and
        // the strength is just a power on the radius.
        // Redrawn until it lands on the plane, inside this attempt rather than by spending
        // one. Spending an attempt was the bug: the draw is radial and the plane is a
        // rectangle, so a good share of throws fall outside it, and a mote that ran out of
        // attempts kept the last REJECTED values — which put it far outside the mass. The
        // cloud came out thinner everywhere while the dial was supposedly raising density.
        let ok = false;
        for (let t2 = 0; t2 < 12 && !ok; t2++) {
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.pow(Math.random(), 1 + CONFIG.cornerDensity)
                    * 0.5 * Math.hypot(planeW, planeH);
          u = (Math.cos(ang) * rad) / planeW + 0.5;
          w = 0.5 - (Math.sin(ang) * rad) / planeH;
          ok = u >= 0 && u <= 1 && w >= 0 && w <= 1;
        }
        if (!ok) { u = Math.random(); w = Math.random(); }
      } else {
        u = Math.random();
        w = Math.random();
      }
      mapDepth = mapAt(maps.depth, u, w);
      nz01 = mapAt(maps.normZ, u, w);
      // Coverage stands in for the reference's brightness test. It samples a photograph
      // and rejects the dark background around the head; there is no photograph here, so
      // the same test is simply whether the model covers the cell.
      const covered = mapDepth > 0 ? 1 : 0;
      if (covered < CONFIG.brightnessThreshold || mapDepth < CONFIG.depthThreshold) continue;

      // Then carve: rejection against a low-frequency noise field so motes clump and thin
      // instead of covering evenly. The reference gets this from the photograph it
      // samples; ours has to be put in by hand.
      const k = CONFIG.shapeNoiseScale;
      const d = valueNoise3(u * k + 11.3, w * k + 4.7, mapDepth * k + 19.1);
      const accept = 1 - CONFIG.shapeNoise + CONFIG.shapeNoise * d * 2;
      if (Math.random() < accept) break;
    }
    // The map is an image: u runs left to right, w runs DOWN from the top, so the sign on
    // w is what puts the model the right way up in the world.
    seat.x = (u - 0.5) * planeW;
    seat.y = -(w - 0.5) * planeH;
    seat.z = (mapDepth - 0.5) * depthSpan;
    seat.nz01 = nz01;
    return seat;
  }

  // Is a point still over the model? A strand stops at the silhouette rather than wandering
  // out through it: the mask IS the shape, and a thread that leaves takes the shape with it.
  const overModel = (x, y) =>
    mapAt(maps.depth, x / planeW + 0.5, 0.5 - y / planeH) >= CONFIG.depthThreshold;

  const flow = [0, 0, 0];
  const strandScale = CONFIG.strandFlowScale / Math.max(1e-6, planeW);
  const strandStep = CONFIG.strandStep * planeW;
  const strandJit = CONFIG.strandJitter * planeW;
  const walk = [0, 0, 0];           // where the strand being laid has got to
  let strandLeft = 0;               // motes still to lay along it
  let strandNz = 1;                 // the normal at its origin, kept for the size draw

  // The corner strands: how many motes they take off the top, and the box they live in.
  // The group's origin sits ON the screen corner, so the visible quadrant is the negative
  // one — seeding into positive x or y would put the thread off-screen past the corner.
  const cornerReach = CONFIG.extraStrandReach * planeW;
  const cornerStep = CONFIG.extraStrandStep * planeW;
  const extraCount = Math.min(count,
    Math.max(0, Math.round(CONFIG.extraStrands)) * CONFIG.extraStrandLength);
  let cornerIndex = 0;
  const startCornerStrand = () => {
    // Each strand gets its OWN slice of the quarter turn around the corner. Seeding all of
    // them from the same crowded draw is what left only one visible: three threads started
    // within a few pixels of each other, walked the same field from nearly the same place,
    // and drew nearly the same line on top of each other. Fanning them guarantees the count
    // asked for is the count seen.
    const seg = Math.max(1, Math.round(CONFIG.extraStrands));
    const slice = (cornerIndex++ % seg + Math.random()) / seg;
    const ang = slice * Math.PI * 0.5;          // 0 = straight in from the corner, 90 = down

    // Crowded toward the corner along that direction, but with a floor: a power draw alone
    // puts every seed on the corner itself.
    const bunch = Math.max(1, CONFIG.extraStrandBunch);
    const t = CONFIG.extraStrandInner
            + (1 - CONFIG.extraStrandInner) * Math.pow(Math.random(), bunch);
    const r = t * cornerReach;
    walk[0] = -Math.cos(ang) * r;
    walk[1] = -Math.sin(ang) * r;
    walk[2] = (Math.random() - 0.5) * depthSpan;
    strandNz = 1;
    strandLeft = CONFIG.extraStrandLength;
    flowAt(walk[0], walk[1], walk[2], strandScale, flow);
  };
  const inCorner = (x, y) => x <= 0 && y <= 0 && x >= -cornerReach && y >= -cornerReach;

  const startStrand = () => {
    const s = sampleSeat();
    walk[0] = s.x; walk[1] = s.y; walk[2] = s.z;
    strandNz = s.nz01;
    strandLeft = CONFIG.strandLength;
    // Read the flow at the new head before laying anything: the first mote of a strand
    // takes its growth direction across the thread, and without this it would be measured
    // against the PREVIOUS strand's tangent, which points somewhere else entirely.
    flowAt(walk[0], walk[1], walk[2], strandScale, flow);
  };

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    // the corner strands are laid first and finish together; whatever walk they left behind
    // must not be picked up by the first model strand
    if (i === extraCount) strandLeft = 0;

    // Each mote takes one of three roles, drawn from a single roll so the shares are
    // exclusive and read off the config directly. What is left over after the loose motes
    // and the strands is plain scatter — and it is not a remainder, it is the haze between
    // the threads that the reference clips have as much of as they have thread.
    const roll = Math.random();
    const isCorner = i < extraCount;
    const isStray = !isCorner && roll < CONFIG.strayFraction;
    const isStrand = !isCorner && !isStray
                  && roll < CONFIG.strayFraction + CONFIG.strandFraction;

    let px, py, pz, nz01;

    if (isCorner) {
      // Same walk as the model's strands, held to the corner box instead of to the
      // silhouette. Turning back rather than ending keeps a thread whole; ending it here
      // would spend the budget on stubs, and out in the open a stub is just a smudge.
      if (strandLeft <= 0) {
        startCornerStrand();
      } else {
        flowAt(walk[0], walk[1], walk[2], strandScale, flow);
        const nx = walk[0] + flow[0] * cornerStep;
        const ny = walk[1] + flow[1] * cornerStep;
        const nz = walk[2] + flow[2] * cornerStep;
        if (inCorner(nx, ny)) {
          walk[0] = nx; walk[1] = ny; walk[2] = nz;
        } else {
          // back toward a point NEAR the corner, clear of the wall it just met. Aimed at
          // the corner itself a thread would end up sliding along the screen edge.
          const home = CONFIG.extraStrandHome * cornerReach;
          const cx = -home, cy = -home;
          const dx = cx - walk[0], dy = cy - walk[1];
          const l = Math.hypot(dx, dy) || 1;
          walk[0] += (dx / l) * cornerStep * 2.0;
          walk[1] += (dy / l) * cornerStep * 2.0;
          walk[2] += flow[2] * cornerStep * 0.5;
        }
      }
      strandLeft--;
      const j = CONFIG.extraStrandJitter * planeW;
      px = walk[0] + gauss1() * j;
      py = walk[1] + gauss1() * j;
      pz = walk[2] + gauss1() * j;
      nz01 = strandNz;
    } else if (isStray) {
      // A share of the motes ignores the maps completely. This is the reference site's
      // SECOND particle system: alongside the 40000 it masks to the portrait it runs 8000
      // more with both thresholds at zero, which is to say unmasked, drifting hard and
      // displaced deeper. Without them the mask's edge is the edge of the effect, and a
      // mask edge is a cut line.
      //
      // Theirs are spread flat across the frame, where a rectangle has nothing to give
      // away because it IS the frame. Ours would show one, so the loose motes are drawn
      // from a Gaussian about the centre of the mass instead: density falls off smoothly
      // forever and there is no boundary anywhere to find.
      const s = CONFIG.strayReach * planeW;
      px = gauss1() * s;
      py = gauss1() * s;
      pz = gauss1() * s;
      nz01 = 1;
    } else if (isStrand) {
      // Walk the flow, dropping this mote where the walk has got to. Motes that start
      // near one another follow the same curve and end up threaded along it; the field
      // folds those threads past each other on its own, and the folds are the creases.
      if (strandLeft <= 0) {
        startStrand();
      } else {
        flowAt(walk[0], walk[1], walk[2], strandScale, flow);
        const nx = walk[0] + flow[0] * strandStep;
        const ny = walk[1] + flow[1] * strandStep;
        const nz = walk[2] + flow[2] * strandStep;
        if (overModel(nx, ny)) {
          walk[0] = nx; walk[1] = ny; walk[2] = nz;
        } else {
          // TURN BACK at the silhouette rather than ending the strand there. Ending it
          // was the first thing tried and it is what kept the threads from reading: a walk
          // leaves this shape within a few dozen steps, so every strand died young, the
          // population was spent on hundreds of stubs, and hundreds of stubs laid over each
          // other are indistinguishable from scatter. Turning back keeps a strand alive for
          // its whole length, so the count falls, each thread grows long enough to follow
          // by eye, and it folds against the boundary — which is where the reference's
          // creases are densest too.
          // Pushed a clear two steps back inside, not one. Nudging by a single step
          // leaves the walk sitting on the boundary, where it exits again on the very next
          // step and every step after — so it slides along the edge laying every remaining
          // mote on the same arc, which is a rim, not a thread.
          const l = Math.hypot(walk[0], walk[1]) || 1;
          walk[0] -= (walk[0] / l) * strandStep * 2.0;
          walk[1] -= (walk[1] / l) * strandStep * 2.0;
          walk[2] += flow[2] * strandStep * 0.5;
        }
      }
      strandLeft--;
      // Lateral scatter about the path. Without it a strand is a one-mote wire, which
      // reads as a drawn line rather than as particles that happen to agree.
      px = walk[0] + gauss1() * strandJit;
      py = walk[1] + gauss1() * strandJit;
      pz = walk[2] + gauss1() * strandJit;
      nz01 = strandNz;
    } else {
      const s = sampleSeat();
      px = s.x; py = s.y; pz = s.z; nz01 = s.nz01;
    }

    initPos[i3]     = px;
    initPos[i3 + 1] = py;
    initPos[i3 + 2] = pz;

    lives[i] = Math.random() < CONFIG.lifeFraction ? 1 : 0;

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
    let mult = CONFIG.sizeMin
             + (CONFIG.sizeMax - CONFIG.sizeMin) * Math.pow(Math.random(), CONFIG.sizeBias);

    // then swollen where the surface turns away from the camera, so the rim carries the
    // big motes and the face of the mass stays fine
    const normalScale = 0.5 + nz01 * 0.5;
    mult *= 1 - (normalScale - 1) * CONFIG.normalInfluence;

    if (isCorner) mult *= CONFIG.extraStrandSize;

    // then taken down with distance from the corner, so the mass carries its weight where
    // it is dense and breaks into fine particles as it goes
    if (!isCorner && CONFIG.sizeEdge < 1) {
      const rr = Math.min(1, Math.hypot(px, py)
                 / Math.max(1e-6, CONFIG.sizeEdgeScale * planeW));
      mult *= 1 + (CONFIG.sizeEdge - 1) * rr;
    }
    sizes[i] = mult;

    timeOffs[i] = Math.random() * 5.0;
    brights[i]  = 0.8 + Math.random() * 0.2;
    curlResp[i] = Math.random() < CONFIG.curlAffectedParticles ? 1.0 : 0.0;
    // the seed the fragment shader turns into this mote's own outline
    shapes[i]   = Math.random();
  }

  // The depth fade and the sort are measured against the depth the seats ACTUALLY occupy,
  // not the box's. The model is far thinner than the box that contains it, and normalising
  // against the box would leave every mote at the same point of the ramp and flatten the
  // fade to nothing.
  // Taken at the 97th percentile rather than the maximum: the loose motes are drawn from a
  // Gaussian whose tail runs four deviations out, and letting one of them set the scale
  // would leave the whole masked mass sitting in the first tenth of the ramp.
  const absZ = new Float32Array(count);
  for (let i = 0; i < count; i++) absZ[i] = Math.abs(initPos[i * 3 + 2]);
  absZ.sort();
  seatHalfDepth = Math.max(1e-3, absZ[Math.floor(count * 0.97)]);

  // ---- crowding ------------------------------------------------------------
  // Each mote's neighbours within densityRadius, counted through a uniform grid: bucket
  // every mote by cell, then look only at the 27 cells around it. Naively this is a
  // pairwise scan — 900 million comparisons at 30k motes — where the grid makes it linear
  // in the population and finishes in a few milliseconds, once, at build time.
  const density = new Float32Array(count);
  {
    const R = CONFIG.densityRadius * viewHeightAt(CONFIG.anchorZ);
    const R2 = R * R;
    const buckets = new Map();
    const cellOf = (v) => Math.floor(v / R);
    const keyOf = (a, b, c) => a + ':' + b + ':' + c;
    for (let i = 0; i < count; i++) {
      const k = keyOf(cellOf(initPos[i * 3]), cellOf(initPos[i * 3 + 1]), cellOf(initPos[i * 3 + 2]));
      const b = buckets.get(k);
      if (b) b.push(i); else buckets.set(k, [i]);
    }
    const raw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = initPos[i * 3], y = initPos[i * 3 + 1], z = initPos[i * 3 + 2];
      const gx = cellOf(x), gy = cellOf(y), gz = cellOf(z);
      let n = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const list = buckets.get(keyOf(gx + a, gy + b, gz + c));
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const o = list[j] * 3;
          const dx = initPos[o] - x, dy = initPos[o + 1] - y, dz = initPos[o + 2] - z;
          if (dx * dx + dy * dy + dz * dz < R2) n++;
        }
      }
      raw[i] = n - 1;                       // a mote is not its own neighbour
    }
    // Normalise against the 97th percentile rather than the maximum: one freak cluster
    // would otherwise set the scale and flatten the effect everywhere else.
    const sorted = Float32Array.from(raw).sort();
    const ref = Math.max(1, sorted[Math.floor(count * 0.97)]);
    for (let i = 0; i < count; i++) density[i] = Math.min(1, raw[i] / ref);
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
  inst('aDensity', density, 1);
  inst('aShape', shapes, 1);
  inst('aLife', lives, 1);

  // the cloud moves in the shader, so nothing can be culled off its rest bounds
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(halfW, halfH, halfD) * 4);

  // pristine copies, kept so the depth sort can permute from a fixed source rather than
  // repeatedly permuting an already-permuted buffer
  // EVERY per-mote attribute has to be listed here, not just the ones the sort reads.
  // Whatever is left out keeps its creation order while the rest are permuted, so a mote
  // ends up drawn with another mote's value — and because the sort reruns every fourth
  // frame, the mismatch changes as the cloud turns. aDensity and aShape are here for that
  // reason, not because the sort has any interest in them.
  geo.userData.src = {
    aInitPos: initPos.slice(), aDriftDir: driftDir.slice(),
    aDriftSpeed: driftSpeed.slice(), aSize: sizes.slice(),
    aTimeOffset: timeOffs.slice(),
    aBrightness: brights.slice(), aCurlResp: curlResp.slice(),
    aDensity: density.slice(), aShape: shapes.slice(),
    aLife: lives.slice(),
  };
  geo.userData.order = new Int32Array(count).map((_, i) => i);
  geo.userData.key = new Float32Array(count);
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
  uSpecMinPx: { value: CONFIG.specMinPx },
  uSpecFullPx: { value: CONFIG.specFullPx },
  uViewportPx: { value: 1 },
  uMinPx: { value: CONFIG.minPx },
  uSpecOpacity: { value: CONFIG.specOpacity },
  uFresnelPower: { value: CONFIG.fresnelPower },
  uRim: { value: CONFIG.rim },
  uRimColor: { value: new THREE.Vector3(
    CONFIG.rimColorR, CONFIG.rimColorG, CONFIG.rimColorB) },
  uFillDir: { value: new THREE.Vector3(
    CONFIG.fillDirX, CONFIG.fillDirY, CONFIG.fillDirZ) },
  uFill: { value: CONFIG.fill },
  uFillColor: { value: new THREE.Vector3(
    CONFIG.fillColorR, CONFIG.fillColorG, CONFIG.fillColorB) },
  uCoreAlpha: { value: CONFIG.coreAlpha },
  uEdgeSoftness: { value: CONFIG.edgeSoftness },
  uBlob: { value: CONFIG.blob },
  uLifeSeconds: { value: CONFIG.lifeSeconds },
  uLifeGrow: { value: CONFIG.lifeGrow },
  uLifeFadeStart: { value: CONFIG.lifeFadeStart },
  uLifeDrift: { value: 0 },          // set in place(), where the plane's world size is known
  uFlowScale: { value: 1 },          // likewise: it is given per plane width
  uFlowBias: { value: CONFIG.strandBias },
  uFlowBiasDir: { value: new THREE.Vector2(1, 0) },
  uDeepen: { value: CONFIG.deepen },
  uDeepenBias: { value: CONFIG.deepenBias },
  uDeepenSat: { value: CONFIG.deepenSat },
  uExpandOrigin: { value: new THREE.Vector3() },
  uExpand: { value: 0 },
  uExpandAmount: { value: CONFIG.expandAmount },
  uExpandCurlBoost: { value: CONFIG.expandCurlBoost },

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
// Below this on-screen diameter the sort is switched off. Ordering only matters while a
// mote is big enough that you can see one in front of another; at a couple of pixels the
// overlap is a blend either way, and the sort is pure cost — and it is exactly at small
// sizes that the population tends to be large, so it is the worst case that pays most.
const SORT_MIN_PX = 4.0;
const SORT_EVERY = 4;
let sortTick = 0;
let sortWorthwhile = true;
const _v = new THREE.Vector3();
const _mv = new THREE.Matrix4();

function sortByDepth() {
  if (!sortWorthwhile) return;
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


// ---------------------------------------------------------------- bloom
// Scene -> half-float target -> soft-threshold prefilter -> separable blur at three
// halving scales -> added back. Written out rather than pulled from a composer so the
// final composite can control ALPHA: this canvas is an overlay, and a glow that only
// adds colour has nothing to show up against on a light page.
const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Soft knee, so the pass fades in over a range instead of switching on at a hard edge —
// a hard cut crawls along the boundary as motes drift across it.
const PREFILTER_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform float uThreshold;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tSrc, vUv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) * c.a;
  float knee = uThreshold * 0.5 + 1e-5;
  float w = clamp((l - uThreshold + knee) / (2.0 * knee), 0.0, 1.0);
  w = w * w * (l > uThreshold ? 1.0 : w);
  gl_FragColor = vec4(c.rgb * c.a * w, 1.0);
}
`;

// Nine taps on a Gaussian, run once per axis. Separable, so a 9x9 kernel costs 18 samples
// instead of 81.
const BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;            // texel step, already scaled by the radius
varying vec2 vUv;
void main(){
  float w[5];
  w[0] = 0.2270270270; w[1] = 0.1945945946; w[2] = 0.1216216216;
  w[3] = 0.0540540541; w[4] = 0.0162162162;
  vec3 sum = texture2D(tSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i);
    sum += texture2D(tSrc, vUv + o).rgb * w[i];
    sum += texture2D(tSrc, vUv - o).rgb * w[i];
  }
  gl_FragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float uStrength;
uniform float uAlpha;
varying vec2 vUv;
void main(){
  vec4 base = texture2D(tScene, vUv);
  // The three scales carry progressively wider, weaker light — a single blur gives either
  // a tight rim or a flat wash, never both.
  vec3 b = texture2D(tBloom0, vUv).rgb * 1.00
         + texture2D(tBloom1, vUv).rgb * 0.60
         + texture2D(tBloom2, vUv).rgb * 0.35;
  b *= uStrength;

  // Output PREMULTIPLIED. The glow has to lift the canvas's own alpha or there is nothing
  // for it to be seen against: the page behind is light, and colour alone would vanish
  // into it. Raising alpha is what lets the glow tint the page rather than sit under it.
  float a = clamp(base.a + dot(b, vec3(0.333)) * uAlpha, 0.0, 1.0);
  gl_FragColor = vec4(base.rgb * base.a + b, a);
}
`;

let bloomChain = null;
function makeBloom() {
  const opts = { type: THREE.HalfFloatType, depthBuffer: false,
                 minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const rt = (w, h, depth) => new THREE.WebGLRenderTarget(
    Math.max(1, w | 0), Math.max(1, h | 0),
    depth ? { ...opts, depthBuffer: true } : opts);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  const fsScene = new THREE.Scene().add(quad);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = (frag, uniforms) => new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false,
    depthWrite: false, transparent: false,
  });

  const chain = {
    scene: null, levels: [], quad, fsScene, fsCam,
    prefilter: mat(PREFILTER_FRAG, {
      tSrc: { value: null }, uThreshold: { value: CONFIG.bloomThreshold } }),
    blur: mat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }),
    composite: mat(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom0: { value: null }, tBloom1: { value: null },
      tBloom2: { value: null }, uStrength: { value: CONFIG.bloomStrength },
      uAlpha: { value: CONFIG.bloomAlpha } }),
    resize(w, h) {
      if (this.scene) this.scene.dispose();
      this.levels.forEach((l) => { l.a.dispose(); l.b.dispose(); });
      this.scene = rt(w, h, true);
      this.levels = [];
      for (let i = 0; i < 3; i++) {
        const d = 2 << i;                       // half, quarter, eighth
        this.levels.push({ a: rt(w / d, h / d), b: rt(w / d, h / d), w: w / d, h: h / d });
      }
    },
  };
  return chain;
}

function renderBloom() {
  const c = bloomChain;
  renderer.setRenderTarget(c.scene);
  renderer.clear();
  renderer.render(scene, camera);

  const draw = (material, target) => {
    c.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(c.fsScene, c.fsCam);
  };

  // Each level is prefiltered from the SCENE, not chained off the level above: chaining
  // compounds the blur and the widest level ends up a featureless smear.
  for (const lv of c.levels) {
    c.prefilter.uniforms.tSrc.value = c.scene.texture;
    draw(c.prefilter, lv.a);
    const r = CONFIG.bloomRadius * 8.0;
    c.blur.uniforms.tSrc.value = lv.a.texture;
    c.blur.uniforms.uDir.value.set(r / lv.w, 0);
    draw(c.blur, lv.b);
    c.blur.uniforms.tSrc.value = lv.b.texture;
    c.blur.uniforms.uDir.value.set(0, r / lv.h);
    draw(c.blur, lv.a);
  }

  c.composite.uniforms.tScene.value = c.scene.texture;
  c.composite.uniforms.tBloom0.value = c.levels[0].a.texture;
  c.composite.uniforms.tBloom1.value = c.levels[1].a.texture;
  c.composite.uniforms.tBloom2.value = c.levels[2].a.texture;
  draw(c.composite, null);
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

  uniforms.uHalfDepth.value = seatHalfDepth || Math.max(1e-3, CONFIG.boxDepth * vh * 0.5);
  // lifeDrift is given in plane widths, like every other distance the model decides
  uniforms.uLifeDrift.value = CONFIG.lifeDrift * seatPlaneW;
  // The shader has to read the field at the same scale the strands were laid at, or the
  // motes travel along a coarser or finer field than the one under them.
  uniforms.uFlowScale.value = CONFIG.strandFlowScale / Math.max(1e-6, seatPlaneW);
  uniforms.uFlowBias.value = CONFIG.strandBias;
  const ba = THREE.MathUtils.degToRad(CONFIG.strandBiasAngle);
  uniforms.uFlowBiasDir.value.set(Math.cos(ba), Math.sin(ba));
  hoverRadiusWorld = CONFIG.expandHoverRadius * vh;

  // Typical mote diameter in device pixels. The mean of the size draw is
  // sizeMin + (sizeMax - sizeMin) / (sizeBias + 1) — for a heavy tail that sits far below
  // the middle of the range, because the largest motes are rare.
  const meanMult = CONFIG.sizeMin
    + (CONFIG.sizeMax - CONFIG.sizeMin) / (CONFIG.sizeBias + 1);
  // CSS pixels, not device pixels. domElement.height is the drawing buffer, so on a 2x
  // display it reads double and the guard lets the sort run on motes that are far too
  // small to need it — at this population that is a re-sort and a full attribute rewrite
  // every fourth frame, which shows up as a stutter and pops the blend order with it.
  const typicalPx = (CONFIG.particleSize * meanMult * 0.01) / vh * innerHeight;
  sortWorthwhile = typicalPx >= SORT_MIN_PX;
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
  uniforms.uViewportPx.value = renderer.domElement.height;
  if (CONFIG.bloom) {
    if (!bloomChain) bloomChain = makeBloom();
    const dpr = renderer.getPixelRatio();
    bloomChain.resize(innerWidth * dpr, innerHeight * dpr);
  }
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
  if (CONFIG.bloom && bloomChain) renderBloom();
  else renderer.render(scene, camera);
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
      min: 14000, max: 90000, step: 500, value: CONFIG.particleCount, rebuild: true },
    { key: 'particleSize', name: 'size', cst: 'CONFIG.particleSize',
      min: 0.1, max: 0.7, step: 0.01, value: CONFIG.particleSize, uni: 'uParticleSize' },
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
