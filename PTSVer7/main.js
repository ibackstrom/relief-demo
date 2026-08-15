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
  particleCount: 24000,     // far fewer than ver6's 60000, and the model is why: this one
                            //   covers under a third of its own box, so the same count
                            //   lands three times as densely and the ribbons fill in
                            //   solid. The drawing only reads while its motes are still
                            //   separable
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
  cornerDensity: 0.6,       // much lower in ver7. Crowding the population at the corner
                            //   made sense when the model was a blob and the corner was
                            //   its densest part; against a drawn shape it piles motes
                            //   where the drawing ISN'T, and buries it

  // How clumpy the sheet is. Seats are rejection-sampled against a low-frequency noise
  // field, so motes gather in some places and thin out in others instead of covering
  // evenly. Held over from the previous versions and lowered — the reference has no
  // equivalent, its unevenness comes from the photograph it samples, and ours has to be
  // put in by hand. Past ~0.8 the voids read as holes rather than as texture.
  shapeNoise: 0.35,
  shapeNoiseScale: 3.4,     // features per plane width. Higher is finer, grainier clumping.

  // ------------------------------------------------------------ strands
  // Much reduced in ver7, and the reason is the model. Corner_1.fbx is not a mass with a
  // silhouette — it is three drawn strands converted to tubes, covering under a third of
  // its own box. The threads no longer have to be invented inside a blob, because the
  // shape being scattered on IS the threads. What is left of this mechanism gives the
  // sheet its grain along them.
  //
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
  strandFraction: 0.22,     // share of motes belonging to strands. The rest stay loose, and
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
  extraStrands: 0,          // stood down in ver7: the model supplies the strands, and
                            //   rays walked out of the corner on top of drawn ones read
                            //   as a second, disagreeing set
  extraStrandLength: 520,   // motes each, which at extraStrandStep is about one run from
                            //   the corner to the edge of their box — so one strand is
                            //   one ray. Far more than a model strand gets: these have to
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
  extraStrandInner: 0.06,   // and how far out they START, as a share of the box. Now that
                            //   they travel outward they begin AT the corner; the floor is
                            //   only there to keep them off the exact point, where an
                            //   outward direction is undefined
  extraStrandOutward: 1.60, // how hard they are pushed away from the corner as they walk.
                            //   0 leaves them wandering the flow like any other thread; up
                            //   here the flow only curves a path that is leaving the corner,
                            //   so each one reads as a ray thrown out of it rather than as
                            //   a thread that happens to be nearby
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
  strayFraction: 0.08,
  strayReach: 0.25,

  // Motes shrink with distance from the corner. The size draw is otherwise uniform across
  // the mass, so the fine spray and the big motes are equally likely anywhere — and a big
  // mote out at the edge reads as a stray blob rather than as the mass thinning out. This
  // keeps the weight where the mass is and lets the outside break into fine particles.
  sizeEdge: 0.72,           // size multiplier at the far edge, against 1 at the corner.
                            //   Gentler than ver6's 0.42: the drawn shape reaches well
                            //   out from the corner and a hard shrink erases its far end
  sizeEdgeScale: 0.75,      // distance over which it falls away, in plane widths

  // Where the model sits relative to the corner, in plane widths and heights. The plane is
  // centred on the group's origin and the group's origin is the screen corner, so a model
  // left at zero has three quarters of itself off-screen past the corner. That was fine for
  // a blob — any quarter of a blob is a blob — but Corner_1 is a DRAWING, and the quarter
  // that happened to be on screen was its dense middle with every loop outside the frame.
  //
  // At -0.46 the shape sits almost entirely in the visible quadrant while still running off
  // the corner, so the cloud spills from the corner as before and the drawing can be read.
  modelOffsetX: -0.46,
  modelOffsetY: -0.46,

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

  // How fast the motes do everything they do on their own — the swirl, the travel along
  // their threads, the birth-to-death. One dial rather than four, because it scales the
  // CLOCK the motes are read from rather than any one of their speeds, so their motion stays
  // in proportion however fast it runs. The cloud's own sway is deliberately not included:
  // that is the camera's relationship to the volume, not the particles' own life.
  speed: 1.0,

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
  bloomStrength: 1.15,      // above the reference's 0.62 on purpose: theirs glows against
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
if (numParam('speed', 0, 3) !== null) CONFIG.speed = numParam('speed', 0, 3);
if (numParam('gs', 0.02, 0.8) !== null) CONFIG.bloomRadius = numParam('gs', 0.02, 0.8);
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
vec3 advect(vec3 p, float dist, float outward) {
  float dt = dist / 6.0;
  for (int i = 0; i < 6; i++) {
    vec3 d = flowDir(p);
    // The corner rays were LAID with a push away from the corner, so they have to be
    // travelled with it too — the same field walked two different ways is two different
    // threads, and the motes would leave theirs within one life.
    float l = length(p.xy);
    if (outward > 0.0 && l > 1e-6) d = normalize(d + vec3(p.xy / l, 0.0) * outward);
    p += d * dt;
  }
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
attribute float aOutward;        // 1 on a corner ray, 0 on everything else

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
uniform float uOutward;          // the corner rays' push away from the corner
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
  vec3 pos = advect(aInitPos, uLifeDrift * lifePhase * aLife, aOutward * uOutward);

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
  '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' +
  's8YUNe/oFr7lNUfp+K/6NiblnqdfN9XgC6zLNsXeAbZ1NlzfvMDeNTTihMfbNe3lycZyNsXoXL5lN0XpN7BcOBflC6hDONHg' +
  'OqxfN7PeHLYVN07f48CqNiXifcf2NsflysbON43ojr7ZOBTpobCtOf3kkKguOcjgbqwLOJbeMbbQNzffBsGPNwzifscdOJrl' +
  'y8YqOUzor75EOrjoN7HtOt3kAqklOrjgo6zPOG7eP7ajOBXfKcGKOOfhmMdQOWjl18aJOgXoxL6rO2ronLExPLjkT6ksO6Dg' +
  '0KyrOTreRLaPOebeTcGaOb3hf8eUOjTl7cbuO6/nxb4NPRzo6rF4PYzkjalCPIDg8KyfOvndPbaROq7ea8HAOo3hW8fnO+3k' +
  'usZYPWDnx753PtDnHrLJPljkzqlnPVTg+KyqO7PdMrauO3DefcH+O1fhHMdMPZLkMMbEPgrnvL7nP37nSLIiQCDk7KmgPh7g' +
  '5qzMPHvdMrbvPDHee8FWPRzhu8bCPjTkpsU7QKjmoL5dQS/nW7KMQePj7antP+Xf7qwKPkndNrZTPvndV8HOPt/gK8ZNQMTj' +
  'ycS4QTnmc77bQszme7L9QqPjwKlRQaTf4axgPzHdT7bkP8fdE8FlQJzgicXsQVXjC8RIQ7jlMb5jRG3mgLKHRGHjT6nNQl3f' +
  '2azSQPvcSraHQZndssAbQlXgwsShQ+XiXsPuRC/l4r38RQbmfrIkRhzjvqhiRA7fvaxfQsrcR7ZQQ2DdTcDrQwbgBcRtRXHi' +
  'scKqRp/kiL2pR4vlibLSR7XiLakLRr7ew6wPRKXcSrZBRS7dx7/eRa/fUMNTR/fh+8GASAfkI71vSfvkorKVSUDi0KnSR2fe' +
  'v6zeRYLcTLZZRwvdDr/6R1Hfh8JVSXnhTcFzSmTjrrxOS1Tky7JuS8fhR6q6SRTe9azWR0HcLbaGSdTcYr4uSurew8F2S/bg' +
  'osCHTMLiN7xSTarj37JrTVLhL6rHS7ndI63ySevb+LXPS5Hcrr2ETHve98C3TWzg9r+9TiDivLt7TwvjyLKUT+HgnKn6TVbd' +
  'TK0yTJrbxLVGTjbcCb32TgPeH8AcUNXfHr8SUXPhM7vIUWril7LnUU7g56lQUOPcQq2UTjjbfbXeUMnbZryKUYLdOb+nUjXf' +
  'Q76QU8TgpbpBVKbhhLJXVKvfWarPUmncO60fUcbaJrWdU03bu7tFVPfcNr5aVYreXr01VgLgA7rfVsvgdrLrVv3euKp5Vdzb' +
  '9qzMU0TavbSEVsja/roqV1vcUr03WNjdjbwLWUDfX7mwWQDgKrK6WTreTqtPWGzbqa3MVqvZPbSQWT3aJbo/WrDbYrw/Wxvd' +
  'wLsQXGjepbiqXBHf8rGsXG7dqqtUW9favq3kWRPZvrPUXLDZJrmJXfXabrt1XlHc+bpGX4Xd4bfVXx/elbHUX5rcoauIXi3a' +
  'ra0mXXfYPbNRYAfZJrj8YCnaV7rZYXPbFbqqYp3cGrc6YxvdJbEtY6jb9avrYXTZma2aYMXXqrL9Y0nYF7eeZEbZSLlsZYDa' +
  'Jbk+Zo3bMLbCZv/bq7CzZqja86t/ZaDYUa03ZPjWAbLWZ2XXDbZoaEXYXrguaXDZAbj7aWzaOrV9atbaCrBvapjZmatCabDX' +
  '4KwAaAzWQrHaa2HW+rRcbCXXj7ccbU/YDLfybVDZTrSAbrnZEK9ybnjYwao1baPWRazya/fUZLAEcELVzrN/cPjVBrY4cR7X' +
  'YLYocjLYabPMcnzYBK6jckDXjKlWcW3VUqsEcLXTZ69PdPvTmLLIdJXUK7V8ddbV6bWadhrXlbJtd1/XZqwwd+vVFKihdQ/U' +
  'Jao2dFXSXK7IeHnSc7EneQzTObTleVLU27Qbe83VnrEyfE7WTaoVfJLUJaUaepnSN6mgeK/QIq1LfcDQULCefVHRfrNufr/S' +
  'd7Trf0HUgLAUgf/UMKghge/SUaO0fvfQK6gqfcHOuqvMgdDOK68ngmXPw7IUg+TQZrO7hKfSba9GhoXT46VkhkHR2J92gwnP' +
  'OKahgYPMIqo+hp3MEq61hknNyLHRh+nO57LPicnQOa6Vi2LRVqRoi0fPJZ1SiN3M4aMahuHJTqh8ihHKMq0ri/XKrLCfjLHM' +
  'U7L8jtvOHq1HkQTPq6KIkN7MZJw3jYzKDaLGivfGX6agjjrHbKyPj0DI+LBskUDKDrJVlH/MzavnlmTM56C9lTPKkpsqku7H' +
  'rp9cj8fDYqSqkhPEyqvUkzzFxbExlpzHibLzmejJharDnMfJWJ5pm4THnJdDl+TEBJyak+K/7qHNlTXAVKxYl+fBE7Pnmq3E' +
  'ULOyn0LHgqk2oxnHB5uRoZzEUpJ2nGnB5pZjlxq71Z5ulzi7W68ymRu+urZon4XBU7XPpevDMqguqSzEO5cWqHDBm4vFoWS9' +
  'fI9imiq395z+mv+2AbBVnB26crnUo7m96rQhqwHAvqa6rgHAupU2rYy9D4nYpn65CIx0nl6zu5uEn4Gztq1SoS628rZ0qIK5' +
  '+bMhsOO7oaWetMm7WJPhshu5L4mpq421x4too1yv1ZpcpKivc6tVpt+xGbXsrOG0fbK8tOW2HqQTudW2TZKjt2i03IdxsE+x' +
  'f4yFqCarYpqdqWqrb6k7q0GtTLM8sdqvMbDHuH6xuKLovIGxw5EBvEKv9YjatLaslo2LrUCmwpmcrXamVanNrkWoJbQetdiq' +
  'K7GFvY2soaKxwg+sApGCwO2pcYgwuZ+nB427sWKgn5hNr5+gHqxjsOKirLliuP+lGrYbw6OnJqOEyAyniY4xxpikVISUveah' +
  'qIhStGia6pcdsu6ahqwltFadNrtQvOOgrbj7x/Gi2qNxzmaieItLzFyfQH8VwhOcJIVXt6eUjZegtkaVzqsSucqXQ7gdwVmb' +
  'M7f7yzKd46IW0c6c04xPz/GZ4IA3xpWWhYUMvKeP4pejvQ2QKamDvzeSLLVBxouVm7PGz2WXwqFX1EWXWY0f04iUnIG9ylSR' +
  '74fKwZaKrZdXxAKL3KVfxtCMp67oy3GPMa0W0z2R/Z8+10qR4o5U1vOONoVDzxGMZ4mOx92EJJb7yFOFyKR8yzmHK6xO0ZGJ' +
  'F6l110iLKp4422GLWo852o6JT4RJ1JCGQodczP1+2pO5zDR/A6VMz0qBq65I1v+Dtag83YmFPZwk4NWFtI1P30mEqoBz2QiB' +
  'SYOV0G15Z5Gx0HR5v6OB03x78a02201+6Kfk4vN/LZrd5ZiA3Ilo5QV/g3t73pl7QX+c1KBzQo4l04Rz86Kt1jt1BLJj35h4' +
  'yKlR6UF60peZ6+16aYaa6nJ5tnj04jp2HXyc2MRuIoxY2CxusZ/S2uxvnqjY40lyj5/f6pRzsJMF7Yt0cIVJ7dFzoHbR5vdw' +
  'lXli3B9qwokP3Y9pEZrG35xqp6Jc549sPJqN7bhtA5CK74huBIRZ71luy3Xl6Qds0XhE4K5lQIeU4SBlRJQZ5Lxl75pI6i5n' +
  'RZW87yRoEowP8bNoFINB8KtotXkW7EBncXqt5ExhaoQ95cNg2Y6H5yZha5Oa7CRiAZA28QljTYjJ8ptjFID28atjQngI7pdi' +
  'jXmu5+lcDIH55lJc/Ypj6Ypcf49E7mxdMozU8mde3IRH9R9fhXtH9BpfInWe7y1en3Zy6cNYmH0O6PtXLogw6i9YQIyO7wxZ' +
  'qogu9P9ZKIE29u9aSncO9hhbvW/88BRauHJ46tFU4Hmc5/1TP4Xl6h9UsYmU8AFVRoa/9SNW+315+DRX53LJ94pX8Wki8mhW' +
  'VG2P6lpRqnaq6GxQQIKb64BQI4d28XJRW4PX9qhS0Xrn+RFUrG0T+mBUI2Qn8xNTPmid6jSQmPmvtRyQoe/3tUuRxuY8tPeT' +
  'DuIfsHSWc+khrPCWIPYzq/yU5f8frjGS//98su6N1/hFsdmNpu+NseOOF+cOsGqR3OIgrM2Tn+k7qByUpfWKp1mS8v4rqsCP' +
  'o/5JrtaLwffwrI6LeO+YrYuMC+c0rPyOKuNYqCqR3+mmpISRQPXMo9OPSP5RpmKNLv1Mqr6Jz/b5qDuJEu8XqjuKYua8qMaM' +
  'qeGxpPGOOenWoC2P6PQKoFuNQv3FoheL9PuQpqyH/PVipRKHn+7AphGIzeV7pYOKo+J7oZCMK+mynamMLfQBnQCLMfxxn+WI' +
  'tvoVo62FJfUeokKFSO5Ioy2GSeYuolyIpeOInjCKSOn7mjeKSfNMmrKIh/qAnM2Gi/nen9mDDvQMn4WDyO0roGyEy+Ycn1GG' +
  'iuTam9GHkOm1mOWHR/LXl4aG5/jImdKERvjtnBSCA/NgnMGBAO2onb2CweZznGmE/+RumZiFnOmolqOFFvHBlYCEf/c9l+iC' +
  'dfdNmmyA3/EJmgeAAeyxmx6B8eVQmquCquRHl7GD7+iLlLCD9u+Jk4+CvvUMlS2BnvXvl9N+xPAfmIV+/ervmZ1/y+SbmBeB' +
  'rONslf2B0OeMku+BzO5VkbqADfQak4V/8PPnlUp9tu+qlh191+mwmEF+YuNXl6V/WOLlk2yAWObAkD6Ad+1ZjwF/xPJDke59' +
  'dfI4lNx7nO6Yldd7nej2lxF90+GBllt+jOC2kvJ+leQzj4N+1evajVF9UfG4j198P/HikpF6Zu3clMh6ceeIlw98VOACljF9' +
  'k97gkYZ9g+Lrjdl8BOptjKV7m++Jjt967e/nkWB5NuyDlO55X+Y8lz174N7XlR98n9xfkRx8N+AAjSh75OdEi/p5se23jWt5' +
  'he5IkVB46eptlDh5W+Uml4t6td3NlSN7q9ouka56zt2NjGp5aOVtilB4m+tHjQd47uwJkVl3h+mYlJh4XeROl/B5lNzxlTZ6' +
  'tthIkT95ZtukjKZ3leI5iql2W+lBjbZ2H+sqkXN2BOj9lAN4WOOql1l5bNs/lk15zdaskeR3sNgPje11jN+gihF18Oa0jXF1' +
  'VOmokZJ1kOa3lW53O+I+mMd4DdrSlnZ4j9Rbkp12rtXJjUp0adx5i4dzguSGjjV0oed9krd0HeW9ltZ2/eAUmUB4bti6l5d3' +
  'aNJWk2d1kNLdjsByPtmyjBtyA+LCjwhz6OWik+FzpuMMmEB2rt9FmqF3wdbTmMN2AtCflD50ms9akGpxUdaEjtdwet9ekfBx' +
  'FeQPlQ1zP+KomYh1Ct6Cm9x2DtUemg52DM0zliRzqMwkkk1wvdPSkKVvCN05k+NwROK/ljxy6+CMm8V0QNwLnTt2CdPkmzV1' +
  'msoYmBNywsk2lDhvL9E0k5RumtpelehvTeCrmGlxad+jnfxzZdrqnpF189D0nVp0GshImgpxYMeuljNuwc7HlZVtO9i9l/hu' +
  'St7RmpBwVd3TnzZzkdglodt00s5PoHhznsXCnAZwScVwmUltlsymmJ1s8tVPmgRuX9wynbBvbNtSom1yx9a1o+tz0czUon9y' +
  'bsODnwBv9cJVnEFsQsqFm5prxtMLnQNtqdrMn8luytkjpZZx9tSKpgNzvMqzpZNx4sCHouxtnr8znxhryMdynmtqzdHfnwFs' +
  '59ifottt4NhbqMxwXtPFqTpygsj5qL1ww73NpcpsDbxAorNp9cRVoSZp7s/fostq5teqpeRsntjuqx9wJtJ7rVtxTsaCrJ5v' +
  'qrtSqZpriLiJpWZoe8KXpLdnN879pWJpmdfpqNZr3teir2lvB9F+sW5wGMRUsF9u17kRrVtqTrUWqeRmw7/gpwtms8wuqRlo' +
  'gtZfrKNq2NVYsyhuAc9FtW9v3MFutBJt87cHsRhpeLMVrVNlHL1aq6lk7MrNrN9mzNQRsGJp7tR/t91sHs1luQNu47+NuLRr' +
  '67UztbxnT7EtsfZjELtMr2RjAcm8sINlQNP2s+ln/9GHu1prAcunvUBsFb65vFFqbrOVuUBmgK5NtYdiE7los91hOce1tC1k' +
  'D9EVuE5mJM/Iv6Fpt8gOwo5qDbxBwahom7EYvrdkG63NuVph0rcPuIdgKcUMubxivc5hvJhka81rxPln1MbwxsBo5bkBxttm' +
  'sK+/whdjjKyMvqlfvLVSvNZeRcNKvRJhuczKwLBiccsoyeNlX8Swy+dmfbcLyx9lbqyXxzZhyKn2wnZd17IZwJVcv8ErweVe' +
  'acwmxZBgV8n3zXdjkcFd0HdkULXTz9ZizKpdzC9fgKd6xyRb76/LwztaJ8ABxcNc6sqYySpehMao0pxgQL691LZhELOO1GRg' +
  'lKgq0e1cr6TZyxtZ7q0JyIBXzr5kyFNa5cnszX5b5sNV15tdIbs82axeqrA32Zldgabd1YBaFKST0DJXmqzBzMdVBLwJzRJY' +
  'bsZZ0ntYI8HS24laibgh3lpbDa7J3XpaOqRl2r1Xu6IC1QRVQatx0b5TI7mJ0XpVI8OQ1hZVcL9U4CZXE7b24s1XNqst4gtX' +
  'x6GW3p5UnaAB2RBS1qgN1e9QmrZi1WFSRMCK2nRRp7xP5LdT0bPw52VUqqe15pRTmp5p4lhRY51o3MFOt6XQ115NvrTv1wJP' +
  'Ub043qdNOboJ6PdPDbFV7LNQ+qO46gBQwZrp5e9Nq5lc34JL6KK/2idK47EI21JLY7tW4apJl7dU68xLeK2M75xMbKDw7RRM' +
  'mJfo6E5KYpdi4g1IzJ8i3dpGrq773aNHOrgw5IRFprPZ7XNH16lg8l5IkJzt8NpH3JRr63BGT5Tj5HpE9pzC3zZDpqtC4NtD' +
  'ULS95h1BDLKl8PtCfaY29epDpZiG88VDAo8F7l1Cpo+i5oVAiplj4Vk/eqhJ4rQ/prG+6HU8SLKf81k+PKPA93E/F5SB9l8/' +
  'u4k38CI+0oh05zY8dZXF4Qg7CKY54xw7SrEW6so3p6909aw5xqAU+746048B+a06YoUH8ow5E4Xw6KI3AZE94U82lKTz4ks2' +
  '37EL6yQzlqpQ9sg0g52N/Mk1d4yO+tE1UYGj88g04oAY6gQz+Y234tUxS6GX5AMytqvp7E4udqZL96EvTJrH/agwzoh8/BAx' +
  '7Xmz9e8vWH6E65IueYwW5rAtf5z756It16Wo7gUpE6Q7+N8p7pf//xMrv4RU/rwr/3gv9mIr+XyF7HwqI4p25ngpcppu6O0o' +
  'HaQ/73gjNqHJ98MjIpT6/i4lzIA6/owmPXhT9QknFHyQ7KQme4gd53kljpid5yokrKKT7qAdIqHy9pgdyZAV/lIffnui/aIh' +
  '6XSm89siK3kQ684iBIbd5XshpZWH5n8fmKDV7G0YQp3X8z4YSIyi+fwZHHkf+e8cjXAG8QEfyHQ+6Gsf34J+4r4d85Nj4/Ma' +
  'JaDU6fQTd5c475gTx4fp81QVgnc084kY82t87d0bWG4b5B0dK3/J3L8aepT23cMWGp4z5qQPfZND6vcO6oO67usQNHTo7XwU' +
  '72j06LcYhGoa4G0aknwM2ZYXw5GO2g4Tu5hR4mYMZI0f5C8LAYBT6EINvXGK5/EQ/mXR4wEWCGe62z8XlHpt1kYUBY3j19MP' +
  'oJEL3qkJIoi03aAIG3zH4CsKHm/q4O4NPGQV3vwSwWal11QUlXhR01wRnohq1AUNs4z72LcGroUy1/EFmXi02ZwHRGwJ2nwL' +
  'zWTM1x8Qqmd00wYSo3a3zwMP1YRE0LEKq4lB03oEEoPwz68CAnXE0lEFjWdJ098JmWKs0UYOKWfUzg0QtXQTzMQNp4JRywoJ' +
  'H4jyzCUDR4AvyMAADnGxykcDp2BmzBoJ2lzGy6sNqWTWyTcPl3Kqx3wNi4H/xSIIroc4xmUCJX4YwAAAC20swg0D1VyAxPgI' +
  'x1lNxfUNOWGqxAsPVXDDwmENJH+2wOwH5Ycyv9ICAHsMuC8AHmmNuTsD5leivHwJCVazvpcOMV4nv14P7G1hvZcN43sVu3MI' +
  'qYOXuJEETnaOsGAC1WWFsacEJVWvtJYKi1EEuB8PlFzduMMPN2tet1YOjngHtZYJyH0TsrAGKHIkqYcElGKTqbYG+FLjrCYM' +
  'dk/nsLQQjlm0spYR1mh2sbIPnnWurjEL8Hkwq7MIlW9LoXwGKF9eoXMIwk0CpTsO9UofqowSAldMrH4TW2ZMq7AReHNIqDYN' +
  'JngJpOAK420wmVUIgVu5mGUL0kuLnaEQx0rionkUXlWFpZEV1WP7pCEUrnH8oaIPUHfenCsOkWoykn0MPFkcktAOhUp4lmsT' +
  'GUr2m9YWsFPznhYYf2HqntQWsG/em3ESX3bzlTESc2Y3jGUQ01ZhiyYSYUd8j6cWskQQlrEZwFHpmKQaHV/NmDcZx2qPlcYV' +
  'pm1ykIcWh2LfhgkVC1XThdcW1En+if0ZMElJj2EcX1FhkiMdj1x1ktsbZGVoj2QZq2Yvi1cbIV7FgkIa81OygaUbVEw/ha8d' +
  '7kpyiVkfXVETjA8gNlqPjOseXmCliT8dbGIdhu0fU1t7fkQfzFLKfRwg3EuQgLghD0m+hAQjVlAchzwj4FfWhoIinFyUhF8h' +
  'h16igRolG1dSfKUkVFJ8e90kYEzNfPAl9EoqgN0m4E9jgtYmulWpgVgmZljlf8IlCFkTft0pJVVFeWgp/1AJeKAp30t7eWYq' +
  'mUtzfAUrbU9XfvEq9lN/faAqklUbfFEqfFXxepouN1QjdjEuiE/NdEMuwUggdgsvnUj5eYovU06Se34vt1K0ekAvMVRPeQQv' +
  'wlQUeFwzD1TfcscyNU2hcOgypkQfc7wzJERbeFk06EuZeko0yFEUeRY031Nld9YzgFS8dSM4MFR0b2s3nErObG43CT8pcGA4' +
  'YD8ndzA5qEicei851FA8ePs4llPxdbo4T1WMc+Q8U1QMbNY7CkcBaOY78Dm8bd883zlddt49rkV4ehQ+8U9DeOQ96lMJdZw9' +
  'c1aRcZZBklN7aW1AiUTfZWtACTiJbDBBujWTdV9CUEK9ethC6k66eMpCRVW8dG9C41e3bxtG91GrZ8hE+UFIZHREjzPiakVF' +
  'gjLIdJ1GET/WemVHiE08eYlHRlaYdA1HhFdLblxKo09wZvJIzT8AZDlIFjC6aQhJSy8adIxKcjwwerBLzUvGeSFMNVemdH5L' +
  'UFfrbExOck3eZJRMvDyhYptLsSzFaHdMpCxncyhODjkveqtPkkkSelZQ+lVLdMNPf1d9a+ZRjkrQY+ZPyTnuYXVOayizZ3NP' +
  'GintcmlRmjUbekJTqkbBeR1U/1Kdc45Ti1Sjai1VMUj5YbFSMTZjYDlReCZhZxVS7SVvck5UHjLuebNWDESPevVXGlKpczxX' +
  'IVN6aShYPkZ+X+tU/zHiXXVTPCPGZn5UmyPMcdpWMC4ieqpZkUA9ekZbKk9Ac6xam1FNaNlamUSSXAtXei7FXGpV6B8wZqhW' +
  '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' +
  'gbd/Zyv02rxGaOT28r1ZaVb5g7h0avj5Hq7vap72e6V8b7fyc6SObQXwPq0bbPzw6rdzbCnzw712bfT1fL7Xbjj4rLgKcKv4' +
  '065jcHz1f6XmdKbxrqSdcpvvRa5dcUTwnre7cQXy+73BctT0H79sdCD3AbnQdXv39K4Odib0JaVjel7wvqS+d5Hula6Mdv/u' +
  'jrfndr3wb70peIPz+L8cejb2xLn1e4b2VK4afJbyiqTwf+Pu6aT4fBjtbK6ue2ntbLcUfBzvhr2Mfe/xisDef7n04rkAgiz1' +
  'q60qgs7wiaONhSPtoKQ6glfrBK7WgIvrKbdDgTPtr73zgiDwKcG2hULzPrpjiOzzU6ygiOruTqFLi/DqFqJAh/vo16ymhVTp' +
  '27ZfhvzqF75WiPjtvsB+ixLxsblojr/xmquTjqvspZ/6kJXoDqBbjEvmSatMiufmT7aFi5Do/r3GjanrNcFzkezuaLnHlHrv' +
  'caqvlELqJ524lhbmyp6ekcTjJ6pnjz7kjbWtkOvlfb0+kw3pAsFcl2jsubgMmzrtp6gcm5nnkZpwnDvjtpuYlt3gkahPlC3h' +
  '17SdleTi272VmFfmXMKWnWPqGblqoofq6qZMobrkqpckohfgZJdWm+vcR6XclxPdMLVrmV/fAcCxnV7jb8PUo8nnrrhjqTXo' +
  'AKRFqLvh4ZPjp+rc/JR0oHTYHqGimrPYg7X6nKjbzcHKohHg68LNqYzkT7e1r0flaaG/rkfeyJFmrX3ZqJFqpc7Va6DdoI7U' +
  'BrUAoc3X88Lop6HcS8P8r/PgabWvtbjhSZ+VtGnaK5G1sh3WNpJDq8vSSJ/2pnTRTLLZplLUor95rcHYdb9EtefczbIUu/3c' +
  'n57YuGTW+I8MuFjSmY96sJrOEJwbq67NMrD2q8LQUbsbs4/UgbjOua/XBq5HvqfY2pzlvfPRU5AwvW/OCI77tSbLjJo6se7J' +
  'la1osRLNbLbCuDjQe7FEvhTSmKi2wP3SCJ3wwJ/N/Y2dwkvKOox1uxXHHph3tpDGxanctyvJlrFcvuHL2q14w2rNS6V0xXnO' +
  't5opxiPJ4YoZyODFUImmwKHCPZUtu53ClKajvePEC669w1TH/6mQyMjIcKKxyqXJg5gtyx3ELYozzTzBiobHxUa+ApODwGC+' +
  'iKMsw0zATKvoyK/CVqlTzgLEz58b0MXE6JV60IW/PoP30ka8noEqyk+56Y91xG65raFnxy+7gKt7zcO9TqjR05e/sp441+3A' +
  'UZCe2Cu6XYD01xi3kHwpzhG0lYx/xwi0zaBuyhm2z6n80Yy426bk2IC69ZxB3Ue7Do5X3Vu0dH873OSxm30x052v6YtWzUiv' +
  'IJ77zuGwn6cf1hCzzqWW3fy0P5vE4li16Yur4WeuzH0H4GCs3Xwk14uqcIpK0fep/Zyb0Tar7any2IGtXKnF4levSJpm6Fev' +
  'h4nc5XuoDX0H4+KmoXsj2k6ljIgy0+ukRpyd0w6mlKmB2+GnI6S95Pio/5b86DepgIh66OOiL3xQ5YGh6nkU3A6gK4dW1MOf' +
  'G5wK1f6ggKUx3lOiR6Au5iGjUJUH6myjIYhF6pidrXpv50Wc63fN3eKaWIaR1qma+JlH2K6bBaKw4NecJZ9A6Med5pQU7RCe' +
  'xYa07D6YyHvl6C6XGXqI4AmWmYak2r2V+JYH3GuW/Z7l4miXqZzZ6UmYP5No7peYPIbY7R2TLXqV6iiSxXl04h2RxoUz3bKQ' +
  'DZUv3jOR3Jy05BaSDpi66sOShpA07kOTL4UV7x2OF3gW7EGN8ngU5EeMhIQ039+LVZK74DuMapih5ueMoJUF7ImNk45b7xKO' +
  'vINE8CGJv3cE7X6IK3dA5YiHqYJS4ACHmpDB4UuHyZX259yH7pIK7XGIaYxC8PqIRYL68HaEZHQp7veDsHJ25eSCvH+03zKC' +
  'do+04V6CH5Wq6PGCOpEi7oKDHIoA8ROES4DC8Q2AYG9P769/M20q5Xd+PnwT3nN9Y48f4Gt9/5ao6Bl+/pBw78J+TIiX8oN/' +
  'jXz38+l7Amls8IB7J2pe5Ul6oHnd3QR5QI5P3814P5bU6HN5m4828Ch6P4bL8wh7M3lc9Xx3kWkn8Gt3ZGjF5Ud2Y3dE3uF0' +
  '74tx3450vJI96SJ1wIsW8MJ1cYOk87V2JXYg9m5z3mcV8Gxz5Wdn5mxyaXUd3+twz4kl311wWZEc6fNweYlC8JpxoYBg84hy' +
  'B3Sx9ZFvzWbI775v4WV65tZuhnJA3jJtJoc933JsVI/z6Alt1YYz8Lhtx33o8pVur3JU9Pdr6GVe70Fse2Sm5mdrZnC03tdp' +
  'ToJ64SFp54hz6YFpCoO07yJq9npd8vpqsHCZ88No2mMe7xZplGKd5itonW6436tmZH674vdlU4SY6T9mpH9D79RmbHgu8rJn' +
  'm2758uxlhGHs7kdmLGBn5jZlsmxp4LxjC3tv4w1jb4Cg6TljMn0T79FjMHZp8sxk/Wv98otjPV7w7q5j0F5/5otiw2r/4Ahh' +
  'inhW41Ng1H156XhgPnsI7ydhAHSP8kBijWn68lth5lyz7nVhIV2D5ihg6mit4ZZeM3Yo489dD3w76fxdwnkp785eLnI58x5g' +
  '7WZi86tfuVq27o1fnFuc5hNe7mYR4nFceHN/451b1nkn6c9bWnhd79Jcl3AW9GBermSv819e/FjF7vFdYVrY5kFc5GRn4nha' +
  'G3GC45hZA3gc6etZE3eu70hbvW4u9Apd32Lk84hdclft7r1cnlj45qpalmJ94pxYwG5646VXq3Yb6U5Y23Ug8CJaQ22J9Ctc' +
  'eGEn9CRdi1YR79tb11Yj5zZZ9F+Y4stWCGyn46tVWXVH6fpWknSx8GxZLWzp9MlbtGBc9PhcBlZ67kRbCFVa58xXoFzP4uxU' +
  'kWg85NRTyXL+6fRVGXNc8RVZvmsV9Xpbi2AT9FxcslcE7edaMFOl521WSliN4/FS+mNv5RRSVG9x6yxV73FK8glZ4mu79O5b' +
  'P2I583xcQVjK7KZallE96GdVqFOO5QJRJF6V529QqGvI7bRU2HBS8zVZiGxj9Fxc8WNp8n9ceFie7I5a1k8k6fVUTk886OBP' +
  'Lljp6jlQQWeX8IhUwG9R9EVZK23084NcX2Vy8Z5dLlnZ7JtaQU586gdV8EsQ675Ps1OD7ipQYWRK849Us25Q9WtZqm3k859c' +
  'VGbF8OZdg1nN7d9akkwc7GxVyknP7TRQ6FCz8UZQdWK79cNUem1Z9ohZNG089M5cJmYx8SFek1gv70pb8UrP7dFV8Efy78hQ' +
  'c08G9MZQ+mCh9x9VEWy598BZMWxr9QddUGVb8ggACQABAAgAAQAAAAkACgACAAkAAgABAAoACwADAAoAAwACAAsADAAEAAsA' +
  'BAADAAwADQAFAAwABQAEAA0ADgAGAA0ABgAFAA4ADwAHAA4ABwAGAA8ACAAAAA8AAAAHABAAEQAJABAACQAIABEAEgAKABEA' +
  'CgAJABIAEwALABIACwAKABMAFAAMABMADAALABQAFQANABQADQAMABUAFgAOABUADgANABYAFwAPABYADwAOABcAEAAIABcA' +
  'CAAPABgAGQARABgAEQAQABkAGgASABkAEgARABoAGwATABoAEwASABsAHAAUABsAFAATABwAHQAVABwAFQAUAB0AHgAWAB0A' +
  'FgAVAB4AHwAXAB4AFwAWAB8AGAAQAB8AEAAXACAAIQAZACAAGQAYACEAIgAaACEAGgAZACIAIwAbACIAGwAaACMAJAAcACMA' +
  'HAAbACQAJQAdACQAHQAcACUAJgAeACUAHgAdACYAJwAfACYAHwAeACcAIAAYACcAGAAfACgAKQAhACgAIQAgACkAKgAiACkA' +
  'IgAhACoAKwAjACoAIwAiACsALAAkACsAJAAjACwALQAlACwAJQAkAC0ALgAmAC0AJgAlAC4ALwAnAC4AJwAmAC8AKAAgAC8A' +
  'IAAnADAAMQApADAAKQAoADEAMgAqADEAKgApADIAMwArADIAKwAqADMANAAsADMALAArADQANQAtADQALQAsADUANgAuADUA' +
  'LgAtADYANwAvADYALwAuADcAMAAoADcAKAAvADgAOQAxADgAMQAwADkAOgAyADkAMgAxADoAOwAzADoAMwAyADsAPAA0ADsA' +
  'NAAzADwAPQA1ADwANQA0AD0APgA2AD0ANgA1AD4APwA3AD4ANwA2AD8AOAAwAD8AMAA3AEAAQQA5AEAAOQA4AEEAQgA6AEEA' +
  'OgA5AEIAQwA7AEIAOwA6AEMARAA8AEMAPAA7AEQARQA9AEQAPQA8AEUARgA+AEUAPgA9AEYARwA/AEYAPwA+AEcAQAA4AEcA' +
  'OAA/AEgASQBBAEgAQQBAAEkASgBCAEkAQgBBAEoASwBDAEoAQwBCAEsATABEAEsARABDAEwATQBFAEwARQBEAE0ATgBGAE0A' +
  'RgBFAE4ATwBHAE4ARwBGAE8ASABAAE8AQABHAFAAUQBJAFAASQBIAFEAUgBKAFEASgBJAFIAUwBLAFIASwBKAFMAVABMAFMA' +
  'TABLAFQAVQBNAFQATQBMAFUAVgBOAFUATgBNAFYAVwBPAFYATwBOAFcAUABIAFcASABPAFgAWQBRAFgAUQBQAFkAWgBSAFkA' +
  'UgBRAFoAWwBTAFoAUwBSAFsAXABUAFsAVABTAFwAXQBVAFwAVQBUAF0AXgBWAF0AVgBVAF4AXwBXAF4AVwBWAF8AWABQAF8A' +
  'UABXAGAAYQBZAGAAWQBYAGEAYgBaAGEAWgBZAGIAYwBbAGIAWwBaAGMAZABcAGMAXABbAGQAZQBdAGQAXQBcAGUAZgBeAGUA' +
  'XgBdAGYAZwBfAGYAXwBeAGcAYABYAGcAWABfAGgAaQBhAGgAYQBgAGkAagBiAGkAYgBhAGoAawBjAGoAYwBiAGsAbABkAGsA' +
  'ZABjAGwAbQBlAGwAZQBkAG0AbgBmAG0AZgBlAG4AbwBnAG4AZwBmAG8AaABgAG8AYABnAHAAcQBpAHAAaQBoAHEAcgBqAHEA' +
  'agBpAHIAcwBrAHIAawBqAHMAdABsAHMAbABrAHQAdQBtAHQAbQBsAHUAdgBuAHUAbgBtAHYAdwBvAHYAbwBuAHcAcABoAHcA' +
  'aABvAHgAeQBxAHgAcQBwAHkAegByAHkAcgBxAHoAewBzAHoAcwByAHsAfAB0AHsAdABzAHwAfQB1AHwAdQB0AH0AfgB2AH0A' +
  'dgB1AH4AfwB3AH4AdwB2AH8AeABwAH8AcAB3AIAAgQB5AIAAeQB4AIEAggB6AIEAegB5AIIAgwB7AIIAewB6AIMAhAB8AIMA' +
  'fAB7AIQAhQB9AIQAfQB8AIUAhgB+AIUAfgB9AIYAhwB/AIYAfwB+AIcAgAB4AIcAeAB/AIgAiQCBAIgAgQCAAIkAigCCAIkA' +
  'ggCBAIoAiwCDAIoAgwCCAIsAjACEAIsAhACDAIwAjQCFAIwAhQCEAI0AjgCGAI0AhgCFAI4AjwCHAI4AhwCGAI8AiACAAI8A' +
  'gACHAJAAkQCJAJAAiQCIAJEAkgCKAJEAigCJAJIAkwCLAJIAiwCKAJMAlACMAJMAjACLAJQAlQCNAJQAjQCMAJUAlgCOAJUA' +
  'jgCNAJYAlwCPAJYAjwCOAJcAkACIAJcAiACPAJgAmQCRAJgAkQCQAJkAmgCSAJkAkgCRAJoAmwCTAJoAkwCSAJsAnACUAJsA' +
  'lACTAJwAnQCVAJwAlQCUAJ0AngCWAJ0AlgCVAJ4AnwCXAJ4AlwCWAJ8AmACQAJ8AkACXAKAAoQCZAKAAmQCYAKEAogCaAKEA' +
  'mgCZAKIAowCbAKIAmwCaAKMApACcAKMAnACbAKQApQCdAKQAnQCcAKUApgCeAKUAngCdAKYApwCfAKYAnwCeAKcAoACYAKcA' +
  'mACfAKgAqQChAKgAoQCgAKkAqgCiAKkAogChAKoAqwCjAKoAowCiAKsArACkAKsApACjAKwArQClAKwApQCkAK0ArgCmAK0A' +
  'pgClAK4ArwCnAK4ApwCmAK8AqACgAK8AoACnALAAsQCpALAAqQCoALEAsgCqALEAqgCpALIAswCrALIAqwCqALMAtACsALMA' +
  'rACrALQAtQCtALQArQCsALUAtgCuALUArgCtALYAtwCvALYArwCuALcAsACoALcAqACvALgAuQCxALgAsQCwALkAugCyALkA' +
  'sgCxALoAuwCzALoAswCyALsAvAC0ALsAtACzALwAvQC1ALwAtQC0AL0AvgC2AL0AtgC1AL4AvwC3AL4AtwC2AL8AuACwAL8A' +
  'sAC3AMAAwQC5AMAAuQC4AMEAwgC6AMEAugC5AMIAwwC7AMIAuwC6AMMAxAC8AMMAvAC7AMQAxQC9AMQAvQC8AMUAxgC+AMUA' +
  'vgC9AMYAxwC/AMYAvwC+AMcAwAC4AMcAuAC/AMgAyQDBAMgAwQDAAMkAygDCAMkAwgDBAMoAywDDAMoAwwDCAMsAzADEAMsA' +
  'xADDAMwAzQDFAMwAxQDEAM0AzgDGAM0AxgDFAM4AzwDHAM4AxwDGAM8AyADAAM8AwADHANAA0QDJANAAyQDIANEA0gDKANEA' +
  'ygDJANIA0wDLANIAywDKANMA1ADMANMAzADLANQA1QDNANQAzQDMANUA1gDOANUAzgDNANYA1wDPANYAzwDOANcA0ADIANcA' +
  'yADPANgA2QDRANgA0QDQANkA2gDSANkA0gDRANoA2wDTANoA0wDSANsA3ADUANsA1ADTANwA3QDVANwA1QDUAN0A3gDWAN0A' +
  '1gDVAN4A3wDXAN4A1wDWAN8A2ADQAN8A0ADXAOAA4QDZAOAA2QDYAOEA4gDaAOEA2gDZAOIA4wDbAOIA2wDaAOMA5ADcAOMA' +
  '3ADbAOQA5QDdAOQA3QDcAOUA5gDeAOUA3gDdAOYA5wDfAOYA3wDeAOcA4ADYAOcA2ADfAOgA6QDhAOgA4QDgAOkA6gDiAOkA' +
  '4gDhAOoA6wDjAOoA4wDiAOsA7ADkAOsA5ADjAOwA7QDlAOwA5QDkAO0A7gDmAO0A5gDlAO4A7wDnAO4A5wDmAO8A6ADgAO8A' +
  '4ADnAPAA8QDpAPAA6QDoAPEA8gDqAPEA6gDpAPIA8wDrAPIA6wDqAPMA9ADsAPMA7ADrAPQA9QDtAPQA7QDsAPUA9gDuAPUA' +
  '7gDtAPYA9wDvAPYA7wDuAPcA8ADoAPcA6ADvAPgA+QDxAPgA8QDwAPkA+gDyAPkA8gDxAPoA+wDzAPoA8wDyAPsA/AD0APsA' +
  '9ADzAPwA/QD1APwA9QD0AP0A/gD2AP0A9gD1AP4A/wD3AP4A9wD2AP8A+ADwAP8A8AD3AAABAQH5AAAB+QD4AAEBAgH6AAEB' +
  '+gD5AAIBAwH7AAIB+wD6AAMBBAH8AAMB/AD7AAQBBQH9AAQB/QD8AAUBBgH+AAUB/gD9AAYBBwH/AAYB/wD+AAcBAAH4AAcB' +
  '+AD/AAgBCQEBAQgBAQEAAQkBCgECAQkBAgEBAQoBCwEDAQoBAwECAQsBDAEEAQsBBAEDAQwBDQEFAQwBBQEEAQ0BDgEGAQ0B' +
  'BgEFAQ4BDwEHAQ4BBwEGAQ8BCAEAAQ8BAAEHARABEQEJARABCQEIAREBEgEKAREBCgEJARIBEwELARIBCwEKARMBFAEMARMB' +
  'DAELARQBFQENARQBDQEMARUBFgEOARUBDgENARYBFwEPARYBDwEOARcBEAEIARcBCAEPARgBGQERARgBEQEQARkBGgESARkB' +
  'EgERARoBGwETARoBEwESARsBHAEUARsBFAETARwBHQEVARwBFQEUAR0BHgEWAR0BFgEVAR4BHwEXAR4BFwEWAR8BGAEQAR8B' +
  'EAEXASABIQEZASABGQEYASEBIgEaASEBGgEZASIBIwEbASIBGwEaASMBJAEcASMBHAEbASQBJQEdASQBHQEcASUBJgEeASUB' +
  'HgEdASYBJwEfASYBHwEeAScBIAEYAScBGAEfASgBKQEhASgBIQEgASkBKgEiASkBIgEhASoBKwEjASoBIwEiASsBLAEkASsB' +
  'JAEjASwBLQElASwBJQEkAS0BLgEmAS0BJgElAS4BLwEnAS4BJwEmAS8BKAEgAS8BIAEnATABMQEpATABKQEoATEBMgEqATEB' +
  'KgEpATIBMwErATIBKwEqATMBNAEsATMBLAErATQBNQEtATQBLQEsATUBNgEuATUBLgEtATYBNwEvATYBLwEuATcBMAEoATcB' +
  'KAEvATgBOQExATgBMQEwATkBOgEyATkBMgExAToBOwEzAToBMwEyATsBPAE0ATsBNAEzATwBPQE1ATwBNQE0AT0BPgE2AT0B' +
  'NgE1AT4BPwE3AT4BNwE2AT8BOAEwAT8BMAE3AUABQQE5AUABOQE4AUEBQgE6AUEBOgE5AUIBQwE7AUIBOwE6AUMBRAE8AUMB' +
  'PAE7AUQBRQE9AUQBPQE8AUUBRgE+AUUBPgE9AUYBRwE/AUYBPwE+AUcBQAE4AUcBOAE/AUgBSQFBAUgBQQFAAUkBSgFCAUkB' +
  'QgFBAUoBSwFDAUoBQwFCAUsBTAFEAUsBRAFDAUwBTQFFAUwBRQFEAU0BTgFGAU0BRgFFAU4BTwFHAU4BRwFGAU8BSAFAAU8B' +
  'QAFHAVABUQFJAVABSQFIAVEBUgFKAVEBSgFJAVIBUwFLAVIBSwFKAVMBVAFMAVMBTAFLAVQBVQFNAVQBTQFMAVUBVgFOAVUB' +
  'TgFNAVYBVwFPAVYBTwFOAVcBUAFIAVcBSAFPAVgBWQFRAVgBUQFQAVkBWgFSAVkBUgFRAVoBWwFTAVoBUwFSAVsBXAFUAVsB' +
  'VAFTAVwBXQFVAVwBVQFUAV0BXgFWAV0BVgFVAV4BXwFXAV4BVwFWAV8BWAFQAV8BUAFXAWABYQFZAWABWQFYAWEBYgFaAWEB' +
  'WgFZAWIBYwFbAWIBWwFaAWMBZAFcAWMBXAFbAWQBZQFdAWQBXQFcAWUBZgFeAWUBXgFdAWYBZwFfAWYBXwFeAWcBYAFYAWcB' +
  'WAFfAWgBaQFhAWgBYQFgAWkBagFiAWkBYgFhAWoBawFjAWoBYwFiAWsBbAFkAWsBZAFjAWwBbQFlAWwBZQFkAW0BbgFmAW0B' +
  'ZgFlAW4BbwFnAW4BZwFmAW8BaAFgAW8BYAFnAXABcQFpAXABaQFoAXEBcgFqAXEBagFpAXIBcwFrAXIBawFqAXMBdAFsAXMB' +
  'bAFrAXQBdQFtAXQBbQFsAXUBdgFuAXUBbgFtAXYBdwFvAXYBbwFuAXcBcAFoAXcBaAFvAXgBeQFxAXgBcQFwAXkBegFyAXkB' +
  'cgFxAXoBewFzAXoBcwFyAXsBfAF0AXsBdAFzAXwBfQF1AXwBdQF0AX0BfgF2AX0BdgF1AX4BfwF3AX4BdwF2AX8BeAFwAX8B' +
  'cAF3AYABgQF5AYABeQF4AYEBggF6AYEBegF5AYIBgwF7AYIBewF6AYMBhAF8AYMBfAF7AYQBhQF9AYQBfQF8AYUBhgF+AYUB' +
  'fgF9AYYBhwF/AYYBfwF+AYcBgAF4AYcBeAF/AYgBiQGBAYgBgQGAAYkBigGCAYkBggGBAYoBiwGDAYoBgwGCAYsBjAGEAYsB' +
  'hAGDAYwBjQGFAYwBhQGEAY0BjgGGAY0BhgGFAY4BjwGHAY4BhwGGAY8BiAGAAY8BgAGHAZABkQGJAZABiQGIAZEBkgGKAZEB' +
  'igGJAZIBkwGLAZIBiwGKAZMBlAGMAZMBjAGLAZQBlQGNAZQBjQGMAZUBlgGOAZUBjgGNAZYBlwGPAZYBjwGOAZcBkAGIAZcB' +
  'iAGPAZgBmQGRAZgBkQGQAZkBmgGSAZkBkgGRAZoBmwGTAZoBkwGSAZsBnAGUAZsBlAGTAZwBnQGVAZwBlQGUAZ0BngGWAZ0B' +
  'lgGVAZ4BnwGXAZ4BlwGWAZ8BmAGQAZ8BkAGXAaABoQGZAaABmQGYAaEBogGaAaEBmgGZAaIBowGbAaIBmwGaAaMBpAGcAaMB' +
  'nAGbAaQBpQGdAaQBnQGcAaUBpgGeAaUBngGdAaYBpwGfAaYBnwGeAacBoAGYAacBmAGfAagBqQGhAagBoQGgAakBqgGiAakB' +
  'ogGhAaoBqwGjAaoBowGiAasBrAGkAasBpAGjAawBrQGlAawBpQGkAa0BrgGmAa0BpgGlAa4BrwGnAa4BpwGmAa8BqAGgAa8B' +
  'oAGnAbABsQGpAbABqQGoAbEBsgGqAbEBqgGpAbIBswGrAbIBqwGqAbMBtAGsAbMBrAGrAbQBtQGtAbQBrQGsAbUBtgGuAbUB' +
  'rgGtAbYBtwGvAbYBrwGuAbcBsAGoAbcBqAGvAbgBuQGxAbgBsQGwAbkBugGyAbkBsgGxAboBuwGzAboBswGyAbsBvAG0AbsB' +
  'tAGzAbwBvQG1AbwBtQG0Ab0BvgG2Ab0BtgG1Ab4BvwG3Ab4BtwG2Ab8BuAGwAb8BsAG3AcABwQG5AcABuQG4AcEBwgG6AcEB' +
  'ugG5AcIBwwG7AcIBuwG6AcMBxAG8AcMBvAG7AcQBxQG9AcQBvQG8AcUBxgG+AcUBvgG9AcYBxwG/AcYBvwG+AccBwAG4AccB' +
  'uAG/AcgByQHBAcgBwQHAAckBygHCAckBwgHBAcoBywHDAcoBwwHCAcsBzAHEAcsBxAHDAcwBzQHFAcwBxQHEAc0BzgHGAc0B' +
  'xgHFAc4BzwHHAc4BxwHGAc8ByAHAAc8BwAHHAdAB0QHJAdAByQHIAdEB0gHKAdEBygHJAdIB0wHLAdIBywHKAdMB1AHMAdMB' +
  'zAHLAdQB1QHNAdQBzQHMAdUB1gHOAdUBzgHNAdYB1wHPAdYBzwHOAdcB0AHIAdcByAHPAdgB2QHRAdgB0QHQAdkB2gHSAdkB' +
  '0gHRAdoB2wHTAdoB0wHSAdsB3AHUAdsB1AHTAdwB3QHVAdwB1QHUAd0B3gHWAd0B1gHVAd4B3wHXAd4B1wHWAd8B2AHQAd8B' +
  '0AHXAeAB4QHZAeAB2QHYAeEB4gHaAeEB2gHZAeIB4wHbAeIB2wHaAeMB5AHcAeMB3AHbAeQB5QHdAeQB3QHcAeUB5gHeAeUB' +
  '3gHdAeYB5wHfAeYB3wHeAecB4AHYAecB2AHfAegB6QHhAegB4QHgAekB6gHiAekB4gHhAeoB6wHjAeoB4wHiAesB7AHkAesB' +
  '5AHjAewB7QHlAewB5QHkAe0B7gHmAe0B5gHlAe4B7wHnAe4B5wHmAe8B6AHgAe8B4AHnAfAB8QHpAfAB6QHoAfEB8gHqAfEB' +
  '6gHpAfIB8wHrAfIB6wHqAfMB9AHsAfMB7AHrAfQB9QHtAfQB7QHsAfUB9gHuAfUB7gHtAfYB9wHvAfYB7wHuAfcB8AHoAfcB' +
  '6AHvAfgB+QHxAfgB8QHwAfkB+gHyAfkB8gHxAfoB+wHzAfoB8wHyAfsB/AH0AfsB9AHzAfwB/QH1AfwB9QH0Af0B/gH2Af0B' +
  '9gH1Af4B/wH3Af4B9wH2Af8B+AHwAf8B8AH3AQACAQL5AQAC+QH4AQECAgL6AQEC+gH5AQICAwL7AQIC+wH6AQMCBAL8AQMC' +
  '/AH7AQQCBQL9AQQC/QH8AQUCBgL+AQUC/gH9AQYCBwL/AQYC/wH+AQcCAAL4AQcC+AH/AQgCCQIBAggCAQIAAgkCCgICAgkC' +
  'AgIBAgoCCwIDAgoCAwICAgsCDAIEAgsCBAIDAgwCDQIFAgwCBQIEAg0CDgIGAg0CBgIFAg4CDwIHAg4CBwIGAg8CCAIAAg8C' +
  'AAIHAhACEQIJAhACCQIIAhECEgIKAhECCgIJAhICEwILAhICCwIKAhMCFAIMAhMCDAILAhQCFQINAhQCDQIMAhUCFgIOAhUC' +
  'DgINAhYCFwIPAhYCDwIOAhcCEAIIAhcCCAIPAhgCGQIRAhgCEQIQAhkCGgISAhkCEgIRAhoCGwITAhoCEwISAhsCHAIUAhsC' +
  'FAITAhwCHQIVAhwCFQIUAh0CHgIWAh0CFgIVAh4CHwIXAh4CFwIWAh8CGAIQAh8CEAIXAiACIQIZAiACGQIYAiECIgIaAiEC' +
  'GgIZAiICIwIbAiICGwIaAiMCJAIcAiMCHAIbAiQCJQIdAiQCHQIcAiUCJgIeAiUCHgIdAiYCJwIfAiYCHwIeAicCIAIYAicC' +
  'GAIfAigCKQIhAigCIQIgAikCKgIiAikCIgIhAioCKwIjAioCIwIiAisCLAIkAisCJAIjAiwCLQIlAiwCJQIkAi0CLgImAi0C' +
  'JgIlAi4CLwInAi4CJwImAi8CKAIgAi8CIAInAjACMQIpAjACKQIoAjECMgIqAjECKgIpAjICMwIrAjICKwIqAjMCNAIsAjMC' +
  'LAIrAjQCNQItAjQCLQIsAjUCNgIuAjUCLgItAjYCNwIvAjYCLwIuAjcCMAIoAjcCKAIvAjgCOQIxAjgCMQIwAjkCOgIyAjkC' +
  'MgIxAjoCOwIzAjoCMwIyAjsCPAI0AjsCNAIzAjwCPQI1AjwCNQI0Aj0CPgI2Aj0CNgI1Aj4CPwI3Aj4CNwI2Aj8COAIwAj8C' +
  'MAI3AkACQQI5AkACOQI4AkECQgI6AkECOgI5AkICQwI7AkICOwI6AkMCRAI8AkMCPAI7AkQCRQI9AkQCPQI8AkUCRgI+AkUC' +
  'PgI9AkYCRwI/AkYCPwI+AkcCQAI4AkcCOAI/AkgCSQJBAkgCQQJAAkkCSgJCAkkCQgJBAkoCSwJDAkoCQwJCAksCTAJEAksC' +
  'RAJDAkwCTQJFAkwCRQJEAk0CTgJGAk0CRgJFAk4CTwJHAk4CRwJGAk8CSAJAAk8CQAJHAlACUQJJAlACSQJIAlECUgJKAlEC' +
  'SgJJAlICUwJLAlICSwJKAlMCVAJMAlMCTAJLAlQCVQJNAlQCTQJMAlUCVgJOAlUCTgJNAlYCVwJPAlYCTwJOAlcCUAJIAlcC' +
  'SAJPAlgCWQJRAlgCUQJQAlkCWgJSAlkCUgJRAloCWwJTAloCUwJSAlsCXAJUAlsCVAJTAlwCXQJVAlwCVQJUAl0CXgJWAl0C' +
  'VgJVAl4CXwJXAl4CVwJWAl8CWAJQAl8CUAJXAmACYQJZAmACWQJYAmECYgJaAmECWgJZAmICYwJbAmICWwJaAmMCZAJcAmMC' +
  'XAJbAmQCZQJdAmQCXQJcAmUCZgJeAmUCXgJdAmYCZwJfAmYCXwJeAmcCYAJYAmcCWAJfAmgCaQJhAmgCYQJgAmkCagJiAmkC' +
  'YgJhAmoCawJjAmoCYwJiAmsCbAJkAmsCZAJjAmwCbQJlAmwCZQJkAm0CbgJmAm0CZgJlAm4CbwJnAm4CZwJmAm8CaAJgAm8C' +
  'YAJnAnACcQJpAnACaQJoAnECcgJqAnECagJpAnICcwJrAnICawJqAnMCdAJsAnMCbAJrAnQCdQJtAnQCbQJsAnUCdgJuAnUC' +
  'bgJtAnYCdwJvAnYCbwJuAncCcAJoAncCaAJvAngCeQJxAngCcQJwAnkCegJyAnkCcgJxAnoCewJzAnoCcwJyAnsCfAJ0AnsC' +
  'dAJzAnwCfQJ1AnwCdQJ0An0CfgJ2An0CdgJ1An4CfwJ3An4CdwJ2An8CeAJwAn8CcAJ3AoACgQJ5AoACeQJ4AoECggJ6AoEC' +
  'egJ5AoICgwJ7AoICewJ6AoMChAJ8AoMCfAJ7AoQChQJ9AoQCfQJ8AoUChgJ+AoUCfgJ9AoYChwJ/AoYCfwJ+AocCgAJ4AocC' +
  'eAJ/AogCiQKBAogCgQKAAokCigKCAokCggKBAooCiwKDAooCgwKCAosCjAKEAosChAKDAowCjQKFAowChQKEAo0CjgKGAo0C' +
  'hgKFAo4CjwKHAo4ChwKGAo8CiAKAAo8CgAKHApACkQKJApACiQKIApECkgKKApECigKJApICkwKLApICiwKKApMClAKMApMC' +
  'jAKLApQClQKNApQCjQKMApUClgKOApUCjgKNApYClwKPApYCjwKOApcCkAKIApcCiAKPApgCmQKRApgCkQKQApkCmgKSApkC' +
  'kgKRApoCmwKTApoCkwKSApsCnAKUApsClAKTApwCnQKVApwClQKUAp0CngKWAp0ClgKVAp4CnwKXAp4ClwKWAp8CmAKQAp8C' +
  'kAKXAqACoQKZAqACmQKYAqECogKaAqECmgKZAqICowKbAqICmwKaAqMCpAKcAqMCnAKbAqQCpQKdAqQCnQKcAqUCpgKeAqUC' +
  'ngKdAqYCpwKfAqYCnwKeAqcCoAKYAqcCmAKfAqgCqQKhAqgCoQKgAqkCqgKiAqkCogKhAqoCqwKjAqoCowKiAqsCrAKkAqsC' +
  'pAKjAqwCrQKlAqwCpQKkAq0CrgKmAq0CpgKlAq4CrwKnAq4CpwKmAq8CqAKgAq8CoAKnArACsQKpArACqQKoArECsgKqArEC' +
  'qgKpArICswKrArICqwKqArMCtAKsArMCrAKrArQCtQKtArQCrQKsArUCtgKuArUCrgKtArYCtwKvArYCrwKuArcCsAKoArcC' +
  'qAKvArgCuQKxArgCsQKwArkCugKyArkCsgKxAroCuwKzAroCswKyArsCvAK0ArsCtAKzArwCvQK1ArwCtQK0Ar0CvgK2Ar0C' +
  'tgK1Ar4CvwK3Ar4CtwK2Ar8CuAKwAr8CsAK3AsACwQK5AsACuQK4AsECwgK6AsECugK5AsICwwK7AsICuwK6AsMCxAK8AsMC' +
  'vAK7AsQCxQK9AsQCvQK8AsUCxgK+AsUCvgK9AsYCxwK/AsYCvwK+AscCwAK4AscCuAK/AsgCyQLBAsgCwQLAAskCygLCAskC' +
  'wgLBAsoCywLDAsoCwwLCAssCzALEAssCxALDAswCzQLFAswCxQLEAs0CzgLGAs0CxgLFAs4CzwLHAs4CxwLGAs8CyALAAs8C' +
  'wALHAtAC0QLJAtACyQLIAtEC0gLKAtECygLJAtIC0wLLAtICywLKAtMC1ALMAtMCzALLAtQC1QLNAtQCzQLMAtUC1gLOAtUC' +
  'zgLNAtYC1wLPAtYCzwLOAtcC0ALIAtcCyALPAtgC2QLRAtgC0QLQAtkC2gLSAtkC0gLRAtoC2wLTAtoC0wLSAtsC3ALUAtsC' +
  '1ALTAtwC3QLVAtwC1QLUAt0C3gLWAt0C1gLVAt4C3wLXAt4C1wLWAt8C2ALQAt8C0ALXAuAC4QLZAuAC2QLYAuEC4gLaAuEC' +
  '2gLZAuIC4wLbAuIC2wLaAuMC5ALcAuMC3ALbAuQC5QLdAuQC3QLcAuUC5gLeAuUC3gLdAuYC5wLfAuYC3wLeAucC4ALYAucC' +
  '2ALfAugC6QLhAugC4QLgAukC6gLiAukC4gLhAuoC6wLjAuoC4wLiAusC7ALkAusC5ALjAuwC7QLlAuwC5QLkAu0C7gLmAu0C' +
  '5gLlAu4C7wLnAu4C5wLmAu8C6ALgAu8C4ALnAvAC8QLpAvAC6QLoAvEC8gLqAvEC6gLpAvIC8wLrAvIC6wLqAvMC9ALsAvMC' +
  '7ALrAvQC9QLtAvQC7QLsAvUC9gLuAvUC7gLtAvYC9wLvAvYC7wLuAvcC8ALoAvcC6ALvAvgC+QLxAvgC8QLwAvkC+gLyAvkC' +
  '8gLxAvoC+wLzAvoC8wLyAvsC/AL0AvsC9ALzAvwC/QL1AvwC9QL0Av0C/gL2Av0C9gL1Av4C/wL3Av4C9wL2Av8C+ALwAv8C' +
  '8AL3AgADAQP5AgAD+QL4AgEDAgP6AgED+gL5AgIDAwP7AgID+wL6AgMDBAP8AgMD/AL7AgQDBQP9AgQD/QL8AgUDBgP+AgUD' +
  '/gL9AgYDBwP/AgYD/wL+AgcDAAP4AgcD+AL/AggDCQMBAwgDAQMAAwkDCgMCAwkDAgMBAwoDCwMDAwoDAwMCAwsDDAMEAwsD' +
  'BAMDAwwDDQMFAwwDBQMEAw0DDgMGAw0DBgMFAw4DDwMHAw4DBwMGAw8DCAMAAw8DAAMHAxADEQMJAxADCQMIAxEDEgMKAxED' +
  'CgMJAxIDEwMLAxIDCwMKAxMDFAMMAxMDDAMLAxQDFQMNAxQDDQMMAxUDFgMOAxUDDgMNAxYDFwMPAxYDDwMOAxcDEAMIAxcD' +
  'CAMPAxgDGQMRAxgDEQMQAxkDGgMSAxkDEgMRAxoDGwMTAxoDEwMSAxsDHAMUAxsDFAMTAxwDHQMVAxwDFQMUAx0DHgMWAx0D' +
  'FgMVAx4DHwMXAx4DFwMWAx8DGAMQAx8DEAMXAyADIQMZAyADGQMYAyEDIgMaAyEDGgMZAyIDIwMbAyIDGwMaAyMDJAMcAyMD' +
  'HAMbAyQDJQMdAyQDHQMcAyUDJgMeAyUDHgMdAyYDJwMfAyYDHwMeAycDIAMYAycDGAMfAygDKQMhAygDIQMgAykDKgMiAykD' +
  'IgMhAyoDKwMjAyoDIwMiAysDLAMkAysDJAMjAywDLQMlAywDJQMkAy0DLgMmAy0DJgMlAy4DLwMnAy4DJwMmAy8DKAMgAy8D' +
  'IAMnAzADMQMpAzADKQMoAzEDMgMqAzEDKgMpAzIDMwMrAzIDKwMqAzMDNAMsAzMDLAMrAzQDNQMtAzQDLQMsAzUDNgMuAzUD' +
  'LgMtAzYDNwMvAzYDLwMuAzcDMAMoAzcDKAMvAzgDOQMxAzgDMQMwAzkDOgMyAzkDMgMxAzoDOwMzAzoDMwMyAzsDPAM0AzsD' +
  'NAMzAzwDPQM1AzwDNQM0Az0DPgM2Az0DNgM1Az4DPwM3Az4DNwM2Az8DOAMwAz8DMAM3A0ADQQM5A0ADOQM4A0EDQgM6A0ED' +
  'OgM5A0IDQwM7A0IDOwM6A0MDRAM8A0MDPAM7A0QDRQM9A0QDPQM8A0UDRgM+A0UDPgM9A0YDRwM/A0YDPwM+A0cDQAM4A0cD' +
  'OAM/A0gDSQNBA0gDQQNAA0kDSgNCA0kDQgNBA0oDSwNDA0oDQwNCA0sDTANEA0sDRANDA0wDTQNFA0wDRQNEA00DTgNGA00D' +
  'RgNFA04DTwNHA04DRwNGA08DSANAA08DQANHA1ADUQNJA1ADSQNIA1EDUgNKA1EDSgNJA1IDUwNLA1IDSwNKA1MDVANMA1MD' +
  'TANLA1QDVQNNA1QDTQNMA1UDVgNOA1UDTgNNA1YDVwNPA1YDTwNOA1cDUANIA1cDSANPA1gDWQNRA1gDUQNQA1kDWgNSA1kD' +
  'UgNRA1oDWwNTA1oDUwNSA1sDXANUA1sDVANTA1wDXQNVA1wDVQNUA10DXgNWA10DVgNVA14DXwNXA14DVwNWA18DWANQA18D' +
  'UANXA2ADYQNZA2ADWQNYA2EDYgNaA2EDWgNZA2IDYwNbA2IDWwNaA2MDZANcA2MDXANbA2QDZQNdA2QDXQNcA2UDZgNeA2UD' +
  'XgNdA2YDZwNfA2YDXwNeA2cDYANYA2cDWANfA2gDaQNhA2gDYQNgA2kDagNiA2kDYgNhA2oDawNjA2oDYwNiA2sDbANkA2sD' +
  'ZANjA2wDbQNlA2wDZQNkA20DbgNmA20DZgNlA24DbwNnA24DZwNmA28DaANgA28DYANnA3ADcQNpA3ADaQNoA3EDcgNqA3ED' +
  'agNpA3IDcwNrA3IDawNqA3MDdANsA3MDbANrA3QDdQNtA3QDbQNsA3UDdgNuA3UDbgNtA3YDdwNvA3YDbwNuA3cDcANoA3cD' +
  'aANvA3gDeQNxA3gDcQNwA3kDegNyA3kDcgNxA3oDewNzA3oDcwNyA3sDfAN0A3sDdANzA3wDfQN1A3wDdQN0A30DfgN2A30D' +
  'dgN1A34DfwN3A34DdwN2A38DeANwA38DcAN3A4ADgQN5A4ADeQN4A4EDggN6A4EDegN5A4IDgwN7A4IDewN6A4MDhAN8A4MD' +
  'fAN7A4QDhQN9A4QDfQN8A4UDhgN+A4UDfgN9A4YDhwN/A4YDfwN+A4cDgAN4A4cDeAN/A5ADkQOJA5ADiQOIA5EDkgOKA5ED' +
  'igOJA5IDkwOLA5IDiwOKA5MDlAOMA5MDjAOLA5QDlQONA5QDjQOMA5UDlgOOA5UDjgONA5YDlwOPA5YDjwOOA5cDkAOIA5cD' +
  'iAOPA5gDmQORA5gDkQOQA5kDmgOSA5kDkgORA5oDmwOTA5oDkwOSA5sDnAOUA5sDlAOTA5wDnQOVA5wDlQOUA50DngOWA50D' +
  'lgOVA54DnwOXA54DlwOWA58DmAOQA58DkAOXA6ADoQOZA6ADmQOYA6EDogOaA6EDmgOZA6IDowObA6IDmwOaA6MDpAOcA6MD' +
  'nAObA6QDpQOdA6QDnQOcA6UDpgOeA6UDngOdA6YDpwOfA6YDnwOeA6cDoAOYA6cDmAOfA6gDqQOhA6gDoQOgA6kDqgOiA6kD' +
  'ogOhA6oDqwOjA6oDowOiA6sDrAOkA6sDpAOjA6wDrQOlA6wDpQOkA60DrgOmA60DpgOlA64DrwOnA64DpwOmA68DqAOgA68D' +
  'oAOnA7ADsQOpA7ADqQOoA7EDsgOqA7EDqgOpA7IDswOrA7IDqwOqA7MDtAOsA7MDrAOrA7QDtQOtA7QDrQOsA7UDtgOuA7UD' +
  'rgOtA7YDtwOvA7YDrwOuA7cDsAOoA7cDqAOvA7gDuQOxA7gDsQOwA7kDugOyA7kDsgOxA7oDuwOzA7oDswOyA7sDvAO0A7sD' +
  'tAOzA7wDvQO1A7wDtQO0A70DvgO2A70DtgO1A74DvwO3A74DtwO2A78DuAOwA78DsAO3A8ADwQO5A8ADuQO4A8EDwgO6A8ED' +
  'ugO5A8IDwwO7A8IDuwO6A8MDxAO8A8MDvAO7A8QDxQO9A8QDvQO8A8UDxgO+A8UDvgO9A8YDxwO/A8YDvwO+A8cDwAO4A8cD' +
  'uAO/A8gDyQPBA8gDwQPAA8kDygPCA8kDwgPBA8oDywPDA8oDwwPCA8sDzAPEA8sDxAPDA8wDzQPFA8wDxQPEA80DzgPGA80D' +
  'xgPFA84DzwPHA84DxwPGA88DyAPAA88DwAPHA9AD0QPJA9ADyQPIA9ED0gPKA9EDygPJA9ID0wPLA9IDywPKA9MD1APMA9MD' +
  'zAPLA9QD1QPNA9QDzQPMA9UD1gPOA9UDzgPNA9YD1wPPA9YDzwPOA9cD0APIA9cDyAPPA9gD2QPRA9gD0QPQA9kD2gPSA9kD' +
  '0gPRA9oD2wPTA9oD0wPSA9sD3APUA9sD1APTA9wD3QPVA9wD1QPUA90D3gPWA90D1gPVA94D3wPXA94D1wPWA98D2APQA98D' +
  '0APXA+AD4QPZA+AD2QPYA+ED4gPaA+ED2gPZA+ID4wPbA+ID2wPaA+MD5APcA+MD3APbA+QD5QPdA+QD3QPcA+UD5gPeA+UD' +
  '3gPdA+YD5wPfA+YD3wPeA+cD4APYA+cD2APfA+gD6QPhA+gD4QPgA+kD6gPiA+kD4gPhA+oD6wPjA+oD4wPiA+sD7APkA+sD' +
  '5APjA+wD7QPlA+wD5QPkA+0D7gPmA+0D5gPlA+4D7wPnA+4D5wPmA+8D6APgA+8D4APnA/AD8QPpA/AD6QPoA/ED8gPqA/ED' +
  '6gPpA/ID8wPrA/ID6wPqA/MD9APsA/MD7APrA/QD9QPtA/QD7QPsA/UD9gPuA/UD7gPtA/YD9wPvA/YD7wPuA/cD8APoA/cD' +
  '6APvA/gD+QPxA/gD8QPwA/kD+gPyA/kD8gPxA/oD+wPzA/oD8wPyA/sD/AP0A/sD9APzA/wD/QP1A/wD9QP0A/0D/gP2A/0D' +
  '9gP1A/4D/wP3A/4D9wP2A/8D+APwA/8D8AP3AwAEAQT5AwAE+QP4AwEEAgT6AwEE+gP5AwIEAwT7AwIE+wP6AwMEBAT8AwME' +
  '/AP7AwQEBQT9AwQE/QP8AwUEBgT+AwUE/gP9AwYEBwT/AwYE/wP+AwcEAAT4AwcE+AP/AwgECQQBBAgEAQQABAkECgQCBAkE' +
  'AgQBBAoECwQDBAoEAwQCBAsEDAQEBAsEBAQDBAwEDQQFBAwEBQQEBA0EDgQGBA0EBgQFBA4EDwQHBA4EBwQGBA8ECAQABA8E' +
  'AAQHBBAEEQQJBBAECQQIBBEEEgQKBBEECgQJBBIEEwQLBBIECwQKBBMEFAQMBBMEDAQLBBQEFQQNBBQEDQQMBBUEFgQOBBUE' +
  'DgQNBBYEFwQPBBYEDwQOBBcEEAQIBBcECAQPBBgEGQQRBBgEEQQQBBkEGgQSBBkEEgQRBBoEGwQTBBoEEwQSBBsEHAQUBBsE' +
  'FAQTBBwEHQQVBBwEFQQUBB0EHgQWBB0EFgQVBB4EHwQXBB4EFwQWBB8EGAQQBB8EEAQXBCAEIQQZBCAEGQQYBCEEIgQaBCEE' +
  'GgQZBCIEIwQbBCIEGwQaBCMEJAQcBCMEHAQbBCQEJQQdBCQEHQQcBCUEJgQeBCUEHgQdBCYEJwQfBCYEHwQeBCcEIAQYBCcE' +
  'GAQfBCgEKQQhBCgEIQQgBCkEKgQiBCkEIgQhBCoEKwQjBCoEIwQiBCsELAQkBCsEJAQjBCwELQQlBCwEJQQkBC0ELgQmBC0E' +
  'JgQlBC4ELwQnBC4EJwQmBC8EKAQgBC8EIAQnBDAEMQQpBDAEKQQoBDEEMgQqBDEEKgQpBDIEMwQrBDIEKwQqBDMENAQsBDME' +
  'LAQrBDQENQQtBDQELQQsBDUENgQuBDUELgQtBDYENwQvBDYELwQuBDcEMAQoBDcEKAQvBDgEOQQxBDgEMQQwBDkEOgQyBDkE' +
  'MgQxBDoEOwQzBDoEMwQyBDsEPAQ0BDsENAQzBDwEPQQ1BDwENQQ0BD0EPgQ2BD0ENgQ1BD4EPwQ3BD4ENwQ2BD8EOAQwBD8E' +
  'MAQ3BEAEQQQ5BEAEOQQ4BEEEQgQ6BEEEOgQ5BEIEQwQ7BEIEOwQ6BEMERAQ8BEMEPAQ7BEQERQQ9BEQEPQQ8BEUERgQ+BEUE' +
  'PgQ9BEYERwQ/BEYEPwQ+BEcEQAQ4BEcEOAQ/BEgESQRBBEgEQQRABEkESgRCBEkEQgRBBEoESwRDBEoEQwRCBEsETAREBEsE' +
  'RARDBEwETQRFBEwERQREBE0ETgRGBE0ERgRFBE4ETwRHBE4ERwRGBE8ESARABE8EQARHBFAEUQRJBFAESQRIBFEEUgRKBFEE' +
  'SgRJBFIEUwRLBFIESwRKBFMEVARMBFMETARLBFQEVQRNBFQETQRMBFUEVgROBFUETgRNBFYEVwRPBFYETwROBFcEUARIBFcE' +
  'SARPBFgEWQRRBFgEUQRQBFkEWgRSBFkEUgRRBFoEWwRTBFoEUwRSBFsEXARUBFsEVARTBFwEXQRVBFwEVQRUBF0EXgRWBF0E' +
  'VgRVBF4EXwRXBF4EVwRWBF8EWARQBF8EUARXBGAEYQRZBGAEWQRYBGEEYgRaBGEEWgRZBGIEYwRbBGIEWwRaBGMEZARcBGME' +
  'XARbBGQEZQRdBGQEXQRcBGUEZgReBGUEXgRdBGYEZwRfBGYEXwReBGcEYARYBGcEWARfBGgEaQRhBGgEYQRgBGkEagRiBGkE' +
  'YgRhBGoEawRjBGoEYwRiBGsEbARkBGsEZARjBGwEbQRlBGwEZQRkBG0EbgRmBG0EZgRlBG4EbwRnBG4EZwRmBG8EaARgBG8E' +
  'YARnBHAEcQRpBHAEaQRoBHEEcgRqBHEEagRpBHIEcwRrBHIEawRqBHMEdARsBHMEbARrBHQEdQRtBHQEbQRsBHUEdgRuBHUE' +
  'bgRtBHYEdwRvBHYEbwRuBHcEcARoBHcEaARvBHgEeQRxBHgEcQRwBHkEegRyBHkEcgRxBHoEewRzBHoEcwRyBHsEfAR0BHsE' +
  'dARzBHwEfQR1BHwEdQR0BH0EfgR2BH0EdgR1BH4EfwR3BH4EdwR2BH8EeARwBH8EcAR3BIAEgQR5BIAEeQR4BIEEggR6BIEE' +
  'egR5BIIEgwR7BIIEewR6BIMEhAR8BIMEfAR7BIQEhQR9BIQEfQR8BIUEhgR+BIUEfgR9BIYEhwR/BIYEfwR+BIcEgAR4BIcE' +
  'eAR/BIgEiQSBBIgEgQSABIkEigSCBIkEggSBBIoEiwSDBIoEgwSCBIsEjASEBIsEhASDBIwEjQSFBIwEhQSEBI0EjgSGBI0E' +
  'hgSFBI4EjwSHBI4EhwSGBI8EiASABI8EgASHBJAEkQSJBJAEiQSIBJEEkgSKBJEEigSJBJIEkwSLBJIEiwSKBJMElASMBJME' +
  'jASLBJQElQSNBJQEjQSMBJUElgSOBJUEjgSNBJYElwSPBJYEjwSOBJcEkASIBJcEiASPBJgEmQSRBJgEkQSQBJkEmgSSBJkE' +
  'kgSRBJoEmwSTBJoEkwSSBJsEnASUBJsElASTBJwEnQSVBJwElQSUBJ0EngSWBJ0ElgSVBJ4EnwSXBJ4ElwSWBJ8EmASQBJ8E' +
  'kASXBKAEoQSZBKAEmQSYBKEEogSaBKEEmgSZBKIEowSbBKIEmwSaBKMEpAScBKMEnASbBKQEpQSdBKQEnQScBKUEpgSeBKUE' +
  'ngSdBKYEpwSfBKYEnwSeBKcEoASYBKcEmASfBKgEqQShBKgEoQSgBKkEqgSiBKkEogShBKoEqwSjBKoEowSiBKsErASkBKsE' +
  'pASjBKwErQSlBKwEpQSkBK0ErgSmBK0EpgSlBK4ErwSnBK4EpwSmBK8EqASgBK8EoASnBLAEsQSpBLAEqQSoBLEEsgSqBLEE' +
  'qgSpBLIEswSrBLIEqwSqBLMEtASsBLMErASrBLQEtQStBLQErQSsBLUEtgSuBLUErgStBLYEtwSvBLYErwSuBLcEsASoBLcE' +
  'qASvBLgEuQSxBLgEsQSwBLkEugSyBLkEsgSxBLoEuwSzBLoEswSyBLsEvAS0BLsEtASzBLwEvQS1BLwEtQS0BL0EvgS2BL0E' +
  'tgS1BL4EvwS3BL4EtwS2BL8EuASwBL8EsAS3BMAEwQS5BMAEuQS4BMEEwgS6BMEEugS5BMIEwwS7BMIEuwS6BMMExAS8BMME' +
  'vAS7BMQExQS9BMQEvQS8BMUExgS+BMUEvgS9BMYExwS/BMYEvwS+BMcEwAS4BMcEuAS/BMgEyQTBBMgEwQTABMkEygTCBMkE' +
  'wgTBBMoEywTDBMoEwwTCBMsEzATEBMsExATDBMwEzQTFBMwExQTEBM0EzgTGBM0ExgTFBM4EzwTHBM4ExwTGBM8EyATABM8E' +
  'wATHBNAE0QTJBNAEyQTIBNEE0gTKBNEEygTJBNIE0wTLBNIEywTKBNME1ATMBNMEzATLBNQE1QTNBNQEzQTMBNUE1gTOBNUE' +
  'zgTNBNYE1wTPBNYEzwTOBNcE0ATIBNcEyATPBNgE2QTRBNgE0QTQBNkE2gTSBNkE0gTRBNoE2wTTBNoE0wTSBNsE3ATUBNsE' +
  '1ATTBNwE3QTVBNwE1QTUBN0E3gTWBN0E1gTVBN4E3wTXBN4E1wTWBN8E2ATQBN8E0ATXBOAE4QTZBOAE2QTYBOEE4gTaBOEE' +
  '2gTZBOIE4wTbBOIE2wTaBOME5ATcBOME3ATbBOQE5QTdBOQE3QTcBOUE5gTeBOUE3gTdBOYE5wTfBOYE3wTeBOcE4ATYBOcE' +
  '2ATfBOgE6QThBOgE4QTgBOkE6gTiBOkE4gThBOoE6wTjBOoE4wTiBOsE7ATkBOsE5ATjBOwE7QTlBOwE5QTkBO0E7gTmBO0E' +
  '5gTlBO4E7wTnBO4E5wTmBO8E6ATgBO8E4ATnBPAE8QTpBPAE6QToBPEE8gTqBPEE6gTpBPIE8wTrBPIE6wTqBPME9ATsBPME' +
  '7ATrBPQE9QTtBPQE7QTsBPUE9gTuBPUE7gTtBPYE9wTvBPYE7wTuBPcE8AToBPcE6ATvBPgE+QTxBPgE8QTwBPkE+gTyBPkE' +
  '8gTxBPoE+wTzBPoE8wTyBPsE/AT0BPsE9ATzBPwE/QT1BPwE9QT0BP0E/gT2BP0E9gT1BP4E/wT3BP4E9wT2BP8E+ATwBP8E' +
  '8AT3BAAFAQX5BAAF+QT4BAEFAgX6BAEF+gT5BAIFAwX7BAIF+wT6BAMFBAX8BAMF/AT7BAQFBQX9BAQF/QT8BAUFBgX+BAUF' +
  '/gT9BAYFBwX/BAYF/wT+BAcFAAX4BAcF+AT/BAgFCQUBBQgFAQUABQkFCgUCBQkFAgUBBQoFCwUDBQoFAwUCBQsFDAUEBQsF' +
  'BAUDBQwFDQUFBQwFBQUEBQ0FDgUGBQ0FBgUFBQ4FDwUHBQ4FBwUGBQ8FCAUABQ8FAAUHBRAFEQUJBRAFCQUIBREFEgUKBREF' +
  'CgUJBRIFEwULBRIFCwUKBRMFFAUMBRMFDAULBRQFFQUNBRQFDQUMBRUFFgUOBRUFDgUNBRYFFwUPBRYFDwUOBRcFEAUIBRcF' +
  'CAUPBRgFGQURBRgFEQUQBRkFGgUSBRkFEgURBRoFGwUTBRoFEwUSBRsFHAUUBRsFFAUTBRwFHQUVBRwFFQUUBR0FHgUWBR0F' +
  'FgUVBR4FHwUXBR4FFwUWBR8FGAUQBR8FEAUXBSAFIQUZBSAFGQUYBSEFIgUaBSEFGgUZBSIFIwUbBSIFGwUaBSMFJAUcBSMF' +
  'HAUbBSQFJQUdBSQFHQUcBSUFJgUeBSUFHgUdBSYFJwUfBSYFHwUeBScFIAUYBScFGAUfBSgFKQUhBSgFIQUgBSkFKgUiBSkF' +
  'IgUhBSoFKwUjBSoFIwUiBSsFLAUkBSsFJAUjBSwFLQUlBSwFJQUkBS0FLgUmBS0FJgUlBS4FLwUnBS4FJwUmBS8FKAUgBS8F' +
  'IAUnBTAFMQUpBTAFKQUoBTEFMgUqBTEFKgUpBTIFMwUrBTIFKwUqBTMFNAUsBTMFLAUrBTQFNQUtBTQFLQUsBTUFNgUuBTUF' +
  'LgUtBTYFNwUvBTYFLwUuBTcFMAUoBTcFKAUvBTgFOQUxBTgFMQUwBTkFOgUyBTkFMgUxBToFOwUzBToFMwUyBTsFPAU0BTsF' +
  'NAUzBTwFPQU1BTwFNQU0BT0FPgU2BT0FNgU1BT4FPwU3BT4FNwU2BT8FOAUwBT8FMAU3BUAFQQU5BUAFOQU4BUEFQgU6BUEF' +
  'OgU5BUIFQwU7BUIFOwU6BUMFRAU8BUMFPAU7BUQFRQU9BUQFPQU8BUUFRgU+BUUFPgU9BUYFRwU/BUYFPwU+BUcFQAU4BUcF' +
  'OAU/BUgFSQVBBUgFQQVABUkFSgVCBUkFQgVBBUoFSwVDBUoFQwVCBUsFTAVEBUsFRAVDBUwFTQVFBUwFRQVEBU0FTgVGBU0F' +
  'RgVFBU4FTwVHBU4FRwVGBU8FSAVABU8FQAVHBVAFUQVJBVAFSQVIBVEFUgVKBVEFSgVJBVIFUwVLBVIFSwVKBVMFVAVMBVMF' +
  'TAVLBVQFVQVNBVQFTQVMBVUFVgVOBVUFTgVNBVYFVwVPBVYFTwVOBVcFUAVIBVcFSAVPBVgFWQVRBVgFUQVQBVkFWgVSBVkF' +
  'UgVRBVoFWwVTBVoFUwVSBVsFXAVUBVsFVAVTBVwFXQVVBVwFVQVUBV0FXgVWBV0FVgVVBV4FXwVXBV4FVwVWBV8FWAVQBV8F' +
  'UAVXBWAFYQVZBWAFWQVYBWEFYgVaBWEFWgVZBWIFYwVbBWIFWwVaBWMFZAVcBWMFXAVbBWQFZQVdBWQFXQVcBWUFZgVeBWUF' +
  'XgVdBWYFZwVfBWYFXwVeBWcFYAVYBWcFWAVfBWgFaQVhBWgFYQVgBWkFagViBWkFYgVhBWoFawVjBWoFYwViBWsFbAVkBWsF' +
  'ZAVjBWwFbQVlBWwFZQVkBW0FbgVmBW0FZgVlBW4FbwVnBW4FZwVmBW8FaAVgBW8FYAVnBXAFcQVpBXAFaQVoBXEFcgVqBXEF' +
  'agVpBXIFcwVrBXIFawVqBXMFdAVsBXMFbAVrBXQFdQVtBXQFbQVsBXUFdgVuBXUFbgVtBXYFdwVvBXYFbwVuBXcFcAVoBXcF' +
  'aAVvBXgFeQVxBXgFcQVwBXkFegVyBXkFcgVxBXoFewVzBXoFcwVyBXsFfAV0BXsFdAVzBXwFfQV1BXwFdQV0BX0FfgV2BX0F' +
  'dgV1BX4FfwV3BX4FdwV2BX8FeAVwBX8FcAV3BYAFgQV5BYAFeQV4BYEFggV6BYEFegV5BYIFgwV7BYIFewV6BYMFhAV8BYMF' +
  'fAV7BYQFhQV9BYQFfQV8BYUFhgV+BYUFfgV9BYYFhwV/BYYFfwV+BYcFgAV4BYcFeAV/BYgFiQWBBYgFgQWABYkFigWCBYkF' +
  'ggWBBYoFiwWDBYoFgwWCBYsFjAWEBYsFhAWDBYwFjQWFBYwFhQWEBY0FjgWGBY0FhgWFBY4FjwWHBY4FhwWGBY8FiAWABY8F' +
  'gAWHBZAFkQWJBZAFiQWIBZEFkgWKBZEFigWJBZIFkwWLBZIFiwWKBZMFlAWMBZMFjAWLBZQFlQWNBZQFjQWMBZUFlgWOBZUF' +
  'jgWNBZYFlwWPBZYFjwWOBZcFkAWIBZcFiAWPBZgFmQWRBZgFkQWQBZkFmgWSBZkFkgWRBZoFmwWTBZoFkwWSBZsFnAWUBZsF' +
  'lAWTBZwFnQWVBZwFlQWUBZ0FngWWBZ0FlgWVBZ4FnwWXBZ4FlwWWBZ8FmAWQBZ8FkAWXBaAFoQWZBaAFmQWYBaEFogWaBaEF' +
  'mgWZBaIFowWbBaIFmwWaBaMFpAWcBaMFnAWbBaQFpQWdBaQFnQWcBaUFpgWeBaUFngWdBaYFpwWfBaYFnwWeBacFoAWYBacF' +
  'mAWfBagFqQWhBagFoQWgBakFqgWiBakFogWhBaoFqwWjBaoFowWiBasFrAWkBasFpAWjBawFrQWlBawFpQWkBa0FrgWmBa0F' +
  'pgWlBa4FrwWnBa4FpwWmBa8FqAWgBa8FoAWnBbAFsQWpBbAFqQWoBbEFsgWqBbEFqgWpBbIFswWrBbIFqwWqBbMFtAWsBbMF' +
  'rAWrBbQFtQWtBbQFrQWsBbUFtgWuBbUFrgWtBbYFtwWvBbYFrwWuBbcFsAWoBbcFqAWvBbgFuQWxBbgFsQWwBbkFugWyBbkF' +
  'sgWxBboFuwWzBboFswWyBbsFvAW0BbsFtAWzBbwFvQW1BbwFtQW0Bb0FvgW2Bb0FtgW1Bb4FvwW3Bb4FtwW2Bb8FuAWwBb8F' +
  'sAW3BcAFwQW5BcAFuQW4BcEFwgW6BcEFugW5BcIFwwW7BcIFuwW6BcMFxAW8BcMFvAW7BcQFxQW9BcQFvQW8BcUFxgW+BcUF' +
  'vgW9BcYFxwW/BcYFvwW+BccFwAW4BccFuAW/BcgFyQXBBcgFwQXABckFygXCBckFwgXBBcoFywXDBcoFwwXCBcsFzAXEBcsF' +
  'xAXDBcwFzQXFBcwFxQXEBc0FzgXGBc0FxgXFBc4FzwXHBc4FxwXGBc8FyAXABc8FwAXHBdAF0QXJBdAFyQXIBdEF0gXKBdEF' +
  'ygXJBdIF0wXLBdIFywXKBdMF1AXMBdMFzAXLBdQF1QXNBdQFzQXMBdUF1gXOBdUFzgXNBdYF1wXPBdYFzwXOBdcF0AXIBdcF' +
  'yAXPBdgF2QXRBdgF0QXQBdkF2gXSBdkF0gXRBdoF2wXTBdoF0wXSBdsF3AXUBdsF1AXTBdwF3QXVBdwF1QXUBd0F3gXWBd0F' +
  '1gXVBd4F3wXXBd4F1wXWBd8F2AXQBd8F0AXXBeAF4QXZBeAF2QXYBeEF4gXaBeEF2gXZBeIF4wXbBeIF2wXaBeMF5AXcBeMF' +
  '3AXbBeQF5QXdBeQF3QXcBeUF5gXeBeUF3gXdBeYF5wXfBeYF3wXeBecF4AXYBecF2AXfBegF6QXhBegF4QXgBekF6gXiBekF' +
  '4gXhBeoF6wXjBeoF4wXiBesF7AXkBesF5AXjBewF7QXlBewF5QXkBe0F7gXmBe0F5gXlBe4F7wXnBe4F5wXmBe8F6AXgBe8F' +
  '4AXnBfAF8QXpBfAF6QXoBfEF8gXqBfEF6gXpBfIF8wXrBfIF6wXqBfMF9AXsBfMF7AXrBfQF9QXtBfQF7QXsBfUF9gXuBfUF' +
  '7gXtBfYF9wXvBfYF7wXuBfcF8AXoBfcF6AXvBfgF+QXxBfgF8QXwBfkF+gXyBfkF8gXxBfoF+wXzBfoF8wXyBfsF/AX0BfsF' +
  '9AXzBfwF/QX1BfwF9QX0Bf0F/gX2Bf0F9gX1Bf4F/wX3Bf4F9wX2Bf8F+AXwBf8F8AX3BQAGAQb5BQAG+QX4BQEGAgb6BQEG' +
  '+gX5BQIGAwb7BQIG+wX6BQMGBAb8BQMG/AX7BQQGBQb9BQQG/QX8BQUGBgb+BQUG/gX9BQYGBwb/BQYG/wX+BQcGAAb4BQcG' +
  '+AX/BQgGCQYBBggGAQYABgkGCgYCBgkGAgYBBgoGCwYDBgoGAwYCBgsGDAYEBgsGBAYDBgwGDQYFBgwGBQYEBg0GDgYGBg0G' +
  'BgYFBg4GDwYHBg4GBwYGBg8GCAYABg8GAAYHBhAGEQYJBhAGCQYIBhEGEgYKBhEGCgYJBhIGEwYLBhIGCwYKBhMGFAYMBhMG' +
  'DAYLBhQGFQYNBhQGDQYMBhUGFgYOBhUGDgYNBhYGFwYPBhYGDwYOBhcGEAYIBhcGCAYPBhgGGQYRBhgGEQYQBhkGGgYSBhkG' +
  'EgYRBhoGGwYTBhoGEwYSBhsGHAYUBhsGFAYTBhwGHQYVBhwGFQYUBh0GHgYWBh0GFgYVBh4GHwYXBh4GFwYWBh8GGAYQBh8G' +
  'EAYXBiAGIQYZBiAGGQYYBiEGIgYaBiEGGgYZBiIGIwYbBiIGGwYaBiMGJAYcBiMGHAYbBiQGJQYdBiQGHQYcBiUGJgYeBiUG' +
  'HgYdBiYGJwYfBiYGHwYeBicGIAYYBicGGAYfBigGKQYhBigGIQYgBikGKgYiBikGIgYhBioGKwYjBioGIwYiBisGLAYkBisG' +
  'JAYjBiwGLQYlBiwGJQYkBi0GLgYmBi0GJgYlBi4GLwYnBi4GJwYmBi8GKAYgBi8GIAYnBjAGMQYpBjAGKQYoBjEGMgYqBjEG' +
  'KgYpBjIGMwYrBjIGKwYqBjMGNAYsBjMGLAYrBjQGNQYtBjQGLQYsBjUGNgYuBjUGLgYtBjYGNwYvBjYGLwYuBjcGMAYoBjcG' +
  'KAYvBjgGOQYxBjgGMQYwBjkGOgYyBjkGMgYxBjoGOwYzBjoGMwYyBjsGPAY0BjsGNAYzBjwGPQY1BjwGNQY0Bj0GPgY2Bj0G' +
  'NgY1Bj4GPwY3Bj4GNwY2Bj8GOAYwBj8GMAY3BkAGQQY5BkAGOQY4BkEGQgY6BkEGOgY5BkIGQwY7BkIGOwY6BkMGRAY8BkMG' +
  'PAY7BkQGRQY9BkQGPQY8BkUGRgY+BkUGPgY9BkYGRwY/BkYGPwY+BkcGQAY4BkcGOAY/BkgGSQZBBkgGQQZABkkGSgZCBkkG' +
  'QgZBBkoGSwZDBkoGQwZCBksGTAZEBksGRAZDBkwGTQZFBkwGRQZEBk0GTgZGBk0GRgZFBk4GTwZHBk4GRwZGBk8GSAZABk8G' +
  'QAZHBlAGUQZJBlAGSQZIBlEGUgZKBlEGSgZJBlIGUwZLBlIGSwZKBlMGVAZMBlMGTAZLBlQGVQZNBlQGTQZMBlUGVgZOBlUG' +
  'TgZNBlYGVwZPBlYGTwZOBlcGUAZIBlcGSAZPBlgGWQZRBlgGUQZQBlkGWgZSBlkGUgZRBloGWwZTBloGUwZSBlsGXAZUBlsG' +
  'VAZTBlwGXQZVBlwGVQZUBl0GXgZWBl0GVgZVBl4GXwZXBl4GVwZWBl8GWAZQBl8GUAZXBmAGYQZZBmAGWQZYBmEGYgZaBmEG' +
  'WgZZBmIGYwZbBmIGWwZaBmMGZAZcBmMGXAZbBmQGZQZdBmQGXQZcBmUGZgZeBmUGXgZdBmYGZwZfBmYGXwZeBmcGYAZYBmcG' +
  'WAZfBmgGaQZhBmgGYQZgBmkGagZiBmkGYgZhBmoGawZjBmoGYwZiBmsGbAZkBmsGZAZjBmwGbQZlBmwGZQZkBm0GbgZmBm0G' +
  'ZgZlBm4GbwZnBm4GZwZmBm8GaAZgBm8GYAZnBnAGcQZpBnAGaQZoBnEGcgZqBnEGagZpBnIGcwZrBnIGawZqBnMGdAZsBnMG' +
  'bAZrBnQGdQZtBnQGbQZsBnUGdgZuBnUGbgZtBnYGdwZvBnYGbwZuBncGcAZoBncGaAZvBngGeQZxBngGcQZwBnkGegZyBnkG' +
  'cgZxBnoGewZzBnoGcwZyBnsGfAZ0BnsGdAZzBnwGfQZ1BnwGdQZ0Bn0GfgZ2Bn0GdgZ1Bn4GfwZ3Bn4GdwZ2Bn8GeAZwBn8G' +
  'cAZ3BoAGgQZ5BoAGeQZ4BoEGggZ6BoEGegZ5BoIGgwZ7BoIGewZ6BoMGhAZ8BoMGfAZ7BoQGhQZ9BoQGfQZ8BoUGhgZ+BoUG' +
  'fgZ9BoYGhwZ/BoYGfwZ+BocGgAZ4BocGeAZ/BogGiQaBBogGgQaABokGigaCBokGggaBBooGiwaDBooGgwaCBosGjAaEBosG' +
  'hAaDBowGjQaFBowGhQaEBo0GjgaGBo0GhgaFBo4GjwaHBo4GhwaGBo8GiAaABo8GgAaHBpAGkQaJBpAGiQaIBpEGkgaKBpEG' +
  'igaJBpIGkwaLBpIGiwaKBpMGlAaMBpMGjAaLBpQGlQaNBpQGjQaMBpUGlgaOBpUGjgaNBpYGlwaPBpYGjwaOBpcGkAaIBpcG' +
  'iAaPBpgGmQaRBpgGkQaQBpkGmgaSBpkGkgaRBpoGmwaTBpoGkwaSBpsGnAaUBpsGlAaTBpwGnQaVBpwGlQaUBp0GngaWBp0G' +
  'lgaVBp4GnwaXBp4GlwaWBp8GmAaQBp8GkAaXBqAGoQaZBqAGmQaYBqEGogaaBqEGmgaZBqIGowabBqIGmwaaBqMGpAacBqMG' +
  'nAabBqQGpQadBqQGnQacBqUGpgaeBqUGngadBqYGpwafBqYGnwaeBqcGoAaYBqcGmAafBqgGqQahBqgGoQagBqkGqgaiBqkG' +
  'ogahBqoGqwajBqoGowaiBqsGrAakBqsGpAajBqwGrQalBqwGpQakBq0GrgamBq0GpgalBq4GrwanBq4GpwamBq8GqAagBq8G' +
  'oAanBrAGsQapBrAGqQaoBrEGsgaqBrEGqgapBrIGswarBrIGqwaqBrMGtAasBrMGrAarBrQGtQatBrQGrQasBrUGtgauBrUG' +
  'rgatBrYGtwavBrYGrwauBrcGsAaoBrcGqAavBrgGuQaxBrgGsQawBrkGugayBrkGsgaxBroGuwazBroGswayBrsGvAa0BrsG' +
  'tAazBrwGvQa1BrwGtQa0Br0Gvga2Br0Gtga1Br4Gvwa3Br4Gtwa2Br8GuAawBr8GsAa3BsAGwQa5BsAGuQa4BsEGwga6BsEG' +
  'uga5BsIGwwa7BsIGuwa6BsMGxAa8BsMGvAa7BsQGxQa9BsQGvQa8BsUGxga+BsUGvga9BsYGxwa/BsYGvwa+BscGwAa4BscG' +
  'uAa/BsgGyQbBBsgGwQbABskGygbCBskGwgbBBsoGywbDBsoGwwbCBssGzAbEBssGxAbDBswGzQbFBswGxQbEBs0GzgbGBs0G' +
  'xgbFBs4GzwbHBs4GxwbGBs8GyAbABs8GwAbHBtAG0QbJBtAGyQbIBtEG0gbKBtEGygbJBtIG0wbLBtIGywbKBtMG1AbMBtMG' +
  'zAbLBtQG1QbNBtQGzQbMBtUG1gbOBtUGzgbNBtYG1wbPBtYGzwbOBtcG0AbIBtcGyAbPBtgG2QbRBtgG0QbQBtkG2gbSBtkG' +
  '0gbRBtoG2wbTBtoG0wbSBtsG3AbUBtsG1AbTBtwG3QbVBtwG1QbUBt0G3gbWBt0G1gbVBt4G3wbXBt4G1wbWBt8G2AbQBt8G' +
  '0AbXBuAG4QbZBuAG2QbYBuEG4gbaBuEG2gbZBuIG4wbbBuIG2wbaBuMG5AbcBuMG3AbbBuQG5QbdBuQG3QbcBuUG5gbeBuUG' +
  '3gbdBuYG5wbfBuYG3wbeBucG4AbYBucG2AbfBugG6QbhBugG4QbgBukG6gbiBukG4gbhBuoG6wbjBuoG4wbiBusG7AbkBusG' +
  '5AbjBuwG7QblBuwG5QbkBu0G7gbmBu0G5gblBu4G7wbnBu4G5wbmBu8G6AbgBu8G4AbnBvAG8QbpBvAG6QboBvEG8gbqBvEG' +
  '6gbpBvIG8wbrBvIG6wbqBvMG9AbsBvMG7AbrBvQG9QbtBvQG7QbsBvUG9gbuBvUG7gbtBvYG9wbvBvYG7wbuBvcG8AboBvcG' +
  '6AbvBvgG+QbxBvgG8QbwBvkG+gbyBvkG8gbxBvoG+wbzBvoG8wbyBvsG/Ab0BvsG9AbzBvwG/Qb1BvwG9Qb0Bv0G/gb2Bv0G' +
  '9gb1Bv4G/wb3Bv4G9wb2Bv8G+AbwBv8G8Ab3BgAHAQf5BgAH+Qb4BgEHAgf6BgEH+gb5BgIHAwf7BgIH+wb6BgMHBAf8BgMH' +
  '/Ab7BgQHBQf9BgQH/Qb8BgUHBgf+BgUH/gb9BgYHBwf/BgYH/wb+BgcHAAf4BgcH+Ab/BggHCQcBBwgHAQcABwkHCgcCBwkH' +
  'AgcBBwoHCwcDBwoHAwcCBwsHDAcEBwsHBAcDBwwHDQcFBwwHBQcEBw0HDgcGBw0HBgcFBw4HDwcHBw4HBwcGBw8HCAcABw8H' +
  'AAcHBxgHGQcRBxgHEQcQBxkHGgcSBxkHEgcRBxoHGwcTBxoHEwcSBxsHHAcUBxsHFAcTBxwHHQcVBxwHFQcUBx0HHgcWBx0H' +
  'FgcVBx4HHwcXBx4HFwcWBx8HGAcQBx8HEAcXByAHIQcZByAHGQcYByEHIgcaByEHGgcZByIHIwcbByIHGwcaByMHJAccByMH' +
  'HAcbByQHJQcdByQHHQccByUHJgceByUHHgcdByYHJwcfByYHHwceBycHIAcYBycHGAcfBygHKQchBygHIQcgBykHKgciBykH' +
  'IgchByoHKwcjByoHIwciBysHLAckBysHJAcjBywHLQclBywHJQckBy0HLgcmBy0HJgclBy4HLwcnBy4HJwcmBy8HKAcgBy8H' +
  'IAcnBzAHMQcpBzAHKQcoBzEHMgcqBzEHKgcpBzIHMwcrBzIHKwcqBzMHNAcsBzMHLAcrBzQHNQctBzQHLQcsBzUHNgcuBzUH' +
  'LgctBzYHNwcvBzYHLwcuBzcHMAcoBzcHKAcvBzgHOQcxBzgHMQcwBzkHOgcyBzkHMgcxBzoHOwczBzoHMwcyBzsHPAc0BzsH' +
  'NAczBzwHPQc1BzwHNQc0Bz0HPgc2Bz0HNgc1Bz4HPwc3Bz4HNwc2Bz8HOAcwBz8HMAc3B0AHQQc5B0AHOQc4B0EHQgc6B0EH' +
  'Ogc5B0IHQwc7B0IHOwc6B0MHRAc8B0MHPAc7B0QHRQc9B0QHPQc8B0UHRgc+B0UHPgc9B0YHRwc/B0YHPwc+B0cHQAc4B0cH' +
  'OAc/B0gHSQdBB0gHQQdAB0kHSgdCB0kHQgdBB0oHSwdDB0oHQwdCB0sHTAdEB0sHRAdDB0wHTQdFB0wHRQdEB00HTgdGB00H' +
  'RgdFB04HTwdHB04HRwdGB08HSAdAB08HQAdHB1AHUQdJB1AHSQdIB1EHUgdKB1EHSgdJB1IHUwdLB1IHSwdKB1MHVAdMB1MH' +
  'TAdLB1QHVQdNB1QHTQdMB1UHVgdOB1UHTgdNB1YHVwdPB1YHTwdOB1cHUAdIB1cHSAdPB1gHWQdRB1gHUQdQB1kHWgdSB1kH' +
  'UgdRB1oHWwdTB1oHUwdSB1sHXAdUB1sHVAdTB1wHXQdVB1wHVQdUB10HXgdWB10HVgdVB14HXwdXB14HVwdWB18HWAdQB18H' +
  'UAdXB2AHYQdZB2AHWQdYB2EHYgdaB2EHWgdZB2IHYwdbB2IHWwdaB2MHZAdcB2MHXAdbB2QHZQddB2QHXQdcB2UHZgdeB2UH' +
  'XgddB2YHZwdfB2YHXwdeB2cHYAdYB2cHWAdfB2gHaQdhB2gHYQdgB2kHagdiB2kHYgdhB2oHawdjB2oHYwdiB2sHbAdkB2sH' +
  'ZAdjB2wHbQdlB2wHZQdkB20HbgdmB20HZgdlB24HbwdnB24HZwdmB28HaAdgB28HYAdnB3AHcQdpB3AHaQdoB3EHcgdqB3EH' +
  'agdpB3IHcwdrB3IHawdqB3MHdAdsB3MHbAdrB3QHdQdtB3QHbQdsB3UHdgduB3UHbgdtB3YHdwdvB3YHbwduB3cHcAdoB3cH' +
  'aAdvB3gHeQdxB3gHcQdwB3kHegdyB3kHcgdxB3oHewdzB3oHcwdyB3sHfAd0B3sHdAdzB3wHfQd1B3wHdQd0B30Hfgd2B30H' +
  'dgd1B34Hfwd3B34Hdwd2B38HeAdwB38HcAd3B4AHgQd5B4AHeQd4B4EHggd6B4EHegd5B4IHgwd7B4IHewd6B4MHhAd8B4MH' +
  'fAd7B4QHhQd9B4QHfQd8B4UHhgd+B4UHfgd9B4YHhwd/B4YHfwd+B4cHgAd4B4cHeAd/B4gHiQeBB4gHgQeAB4kHigeCB4kH' +
  'ggeBB4oHiweDB4oHgweCB4sHjAeEB4sHhAeDB4wHjQeFB4wHhQeEB40HjgeGB40HhgeFB44HjweHB44HhweGB48HiAeAB48H' +
  'gAeHB5AHkQeJB5AHiQeIB5EHkgeKB5EHigeJB5IHkweLB5IHiweKB5MHlAeMB5MHjAeLB5QHlQeNB5QHjQeMB5UHlgeOB5UH' +
  'jgeNB5YHlwePB5YHjweOB5cHkAeIB5cHiAePB5gHmQeRB5gHkQeQB5kHmgeSB5kHkgeRB5oHmweTB5oHkweSB5sHnAeUB5sH' +
  'lAeTB5wHnQeVB5wHlQeUB50HngeWB50HlgeVB54HnweXB54HlweWB58HmAeQB58HkAeXB6AHoQeZB6AHmQeYB6EHogeaB6EH' +
  'mgeZB6IHowebB6IHmweaB6MHpAecB6MHnAebB6QHpQedB6QHnQecB6UHpgeeB6UHngedB6YHpwefB6YHnweeB6cHoAeYB6cH' +
  'mAefB6gHqQehB6gHoQegB6kHqgeiB6kHogehB6oHqwejB6oHoweiB6sHrAekB6sHpAejB6wHrQelB6wHpQekB60HrgemB60H' +
  'pgelB64HrwenB64HpwemB68HqAegB68HoAenB7AHsQepB7AHqQeoB7EHsgeqB7EHqgepB7IHswerB7IHqweqB7MHtAesB7MH' +
  'rAerB7QHtQetB7QHrQesB7UHtgeuB7UHrgetB7YHtwevB7YHrweuB7cHsAeoB7cHqAevB7gHuQexB7gHsQewB7kHugeyB7kH' +
  'sgexB7oHuwezB7oHsweyB7sHvAe0B7sHtAezB7wHvQe1B7wHtQe0B70Hvge2B70Htge1B74Hvwe3B74Htwe2B78HuAewB78H' +
  'sAe3B8AHwQe5B8AHuQe4B8EHwge6B8EHuge5B8IHwwe7B8IHuwe6B8MHxAe8B8MHvAe7B8QHxQe9B8QHvQe8B8UHxge+B8UH' +
  'vge9B8YHxwe/B8YHvwe+B8cHwAe4B8cHuAe/B8gHyQfBB8gHwQfAB8kHygfCB8kHwgfBB8oHywfDB8oHwwfCB8sHzAfEB8sH' +
  'xAfDB8wHzQfFB8wHxQfEB80HzgfGB80HxgfFB84HzwfHB84HxwfGB88HyAfAB88HwAfHB9AH0QfJB9AHyQfIB9EH0gfKB9EH' +
  'ygfJB9IH0wfLB9IHywfKB9MH1AfMB9MHzAfLB9QH1QfNB9QHzQfMB9UH1gfOB9UHzgfNB9YH1wfPB9YHzwfOB9cH0AfIB9cH' +
  'yAfPB9gH2QfRB9gH0QfQB9kH2gfSB9kH0gfRB9oH2wfTB9oH0wfSB9sH3AfUB9sH1AfTB9wH3QfVB9wH1QfUB90H3gfWB90H' +
  '1gfVB94H3wfXB94H1wfWB98H2AfQB98H0AfXB+AH4QfZB+AH2QfYB+EH4gfaB+EH2gfZB+IH4wfbB+IH2wfaB+MH5AfcB+MH' +
  '3AfbB+QH5QfdB+QH3QfcB+UH5gfeB+UH3gfdB+YH5wffB+YH3wfeB+cH4AfYB+cH2AffB+gH6QfhB+gH4QfgB+kH6gfiB+kH' +
  '4gfhB+oH6wfjB+oH4wfiB+sH7AfkB+sH5AfjB+wH7QflB+wH5QfkB+0H7gfmB+0H5gflB+4H7wfnB+4H5wfmB+8H6AfgB+8H' +
  '4AfnB/AH8QfpB/AH6QfoB/EH8gfqB/EH6gfpB/IH8wfrB/IH6wfqB/MH9AfsB/MH7AfrB/QH9QftB/QH7QfsB/UH9gfuB/UH' +
  '7gftB/YH9wfvB/YH7wfuB/cH8AfoB/cH6AfvB/gH+QfxB/gH8QfwB/kH+gfyB/kH8gfxB/oH+wfzB/oH8wfyB/sH/Af0B/sH' +
  '9AfzB/wH/Qf1B/wH9Qf0B/0H/gf2B/0H9gf1B/4H/wf3B/4H9wf2B/8H+AfwB/8H8Af3BwAIAQj5BwAI+Qf4BwEIAgj6BwEI' +
  '+gf5BwIIAwj7BwII+wf6BwMIBAj8BwMI/Af7BwQIBQj9BwQI/Qf8BwUIBgj+BwUI/gf9BwYIBwj/BwYI/wf+BwcIAAj4BwcI' +
  '+Af/BwgICQgBCAgIAQgACAkICggCCAkIAggBCAoICwgDCAoIAwgCCAsIDAgECAsIBAgDCAwIDQgFCAwIBQgECA0IDggGCA0I' +
  'BggFCA4IDwgHCA4IBwgGCA8ICAgACA8IAAgHCBAIEQgJCBAICQgICBEIEggKCBEICggJCBIIEwgLCBIICwgKCBMIFAgMCBMI' +
  'DAgLCBQIFQgNCBQIDQgMCBUIFggOCBUIDggNCBYIFwgPCBYIDwgOCBcIEAgICBcICAgPCBgIGQgRCBgIEQgQCBkIGggSCBkI' +
  'EggRCBoIGwgTCBoIEwgSCBsIHAgUCBsIFAgTCBwIHQgVCBwIFQgUCB0IHggWCB0IFggVCB4IHwgXCB4IFwgWCB8IGAgQCB8I' +
  'EAgXCCAIIQgZCCAIGQgYCCEIIggaCCEIGggZCCIIIwgbCCIIGwgaCCMIJAgcCCMIHAgbCCQIJQgdCCQIHQgcCCUIJggeCCUI' +
  'HggdCCYIJwgfCCYIHwgeCCcIIAgYCCcIGAgfCCgIKQghCCgIIQggCCkIKggiCCkIIgghCCoIKwgjCCoIIwgiCCsILAgkCCsI' +
  'JAgjCCwILQglCCwIJQgkCC0ILggmCC0IJgglCC4ILwgnCC4IJwgmCC8IKAggCC8IIAgnCDAIMQgpCDAIKQgoCDEIMggqCDEI' +
  'KggpCDIIMwgrCDIIKwgqCDMINAgsCDMILAgrCDQINQgtCDQILQgsCDUINgguCDUILggtCDYINwgvCDYILwguCDcIMAgoCDcI' +
  'KAgvCDgIOQgxCDgIMQgwCDkIOggyCDkIMggxCDoIOwgzCDoIMwgyCDsIPAg0CDsINAgzCDwIPQg1CDwINQg0CD0IPgg2CD0I' +
  'Ngg1CD4IPwg3CD4INwg2CD8IOAgwCD8IMAg3CEAIQQg5CEAIOQg4CEEIQgg6CEEIOgg5CEIIQwg7CEIIOwg6CEMIRAg8CEMI' +
  'PAg7CEQIRQg9CEQIPQg8CEUIRgg+CEUIPgg9CEYIRwg/CEYIPwg+CEcIQAg4CEcIOAg/CEgISQhBCEgIQQhACEkISghCCEkI' +
  'QghBCEoISwhDCEoIQwhCCEsITAhECEsIRAhDCEwITQhFCEwIRQhECE0ITghGCE0IRghFCE4ITwhHCE4IRwhGCE8ISAhACE8I' +
  'QAhHCFAIUQhJCFAISQhICFEIUghKCFEISghJCFIIUwhLCFIISwhKCFMIVAhMCFMITAhLCFQIVQhNCFQITQhMCFUIVghOCFUI' +
  'TghNCFYIVwhPCFYITwhOCFcIUAhICFcISAhPCFgIWQhRCFgIUQhQCFkIWghSCFkIUghRCFoIWwhTCFoIUwhSCFsIXAhUCFsI' +
  'VAhTCFwIXQhVCFwIVQhUCF0IXghWCF0IVghVCF4IXwhXCF4IVwhWCF8IWAhQCF8IUAhXCGAIYQhZCGAIWQhYCGEIYghaCGEI' +
  'WghZCGIIYwhbCGIIWwhaCGMIZAhcCGMIXAhbCGQIZQhdCGQIXQhcCGUIZgheCGUIXghdCGYIZwhfCGYIXwheCGcIYAhYCGcI' +
  'WAhfCGgIaQhhCGgIYQhgCGkIaghiCGkIYghhCGoIawhjCGoIYwhiCGsIbAhkCGsIZAhjCGwIbQhlCGwIZQhkCG0IbghmCG0I' +
  'ZghlCG4IbwhnCG4IZwhmCG8IaAhgCG8IYAhnCHAIcQhpCHAIaQhoCHEIcghqCHEIaghpCHIIcwhrCHIIawhqCHMIdAhsCHMI' +
  'bAhrCHQIdQhtCHQIbQhsCHUIdghuCHUIbghtCHYIdwhvCHYIbwhuCHcIcAhoCHcIaAhvCHgIeQhxCHgIcQhwCHkIeghyCHkI' +
  'cghxCHoIewhzCHoIcwhyCHsIfAh0CHsIdAhzCHwIfQh1CHwIdQh0CH0Ifgh2CH0Idgh1CH4Ifwh3CH4Idwh2CH8IeAhwCH8I' +
  'cAh3CIAIgQh5CIAIeQh4CIEIggh6CIEIegh5CIIIgwh7CIIIewh6CIMIhAh8CIMIfAh7CIQIhQh9CIQIfQh8CIUIhgh+CIUI' +
  'fgh9CIYIhwh/CIYIfwh+CIcIgAh4CIcIeAh/CIgIiQiBCIgIgQiACIkIigiCCIkIggiBCIoIiwiDCIoIgwiCCIsIjAiECIsI' +
  'hAiDCIwIjQiFCIwIhQiECI0IjgiGCI0IhgiFCI4IjwiHCI4IhwiGCI8IiAiACI8IgAiHCJAIkQiJCJAIiQiICJEIkgiKCJEI' +
  'igiJCJIIkwiLCJIIiwiKCJMIlAiMCJMIjAiLCJQIlQiNCJQIjQiMCJUIlgiOCJUIjgiNCJYIlwiPCJYIjwiOCJcIkAiICJcI' +
  'iAiPCJgImQiRCJgIkQiQCJkImgiSCJkIkgiRCJoImwiTCJoIkwiSCJsInAiUCJsIlAiTCJwInQiVCJwIlQiUCJ0IngiWCJ0I' +
  'lgiVCJ4InwiXCJ4IlwiWCJ8ImAiQCJ8IkAiXCKAIoQiZCKAImQiYCKEIogiaCKEImgiZCKIIowibCKIImwiaCKMIpAicCKMI' +
  'nAibCKQIpQidCKQInQicCKUIpgieCKUIngidCKYIpwifCKYInwieCKcIoAiYCKcImAifCKgIqQihCKgIoQigCKkIqgiiCKkI' +
  'ogihCKoIqwijCKoIowiiCKsIrAikCKsIpAijCKwIrQilCKwIpQikCK0IrgimCK0IpgilCK4IrwinCK4IpwimCK8IqAigCK8I' +
  'oAinCLAIsQipCLAIqQioCLEIsgiqCLEIqgipCLIIswirCLIIqwiqCLMItAisCLMIrAirCLQItQitCLQIrQisCLUItgiuCLUI' +
  'rgitCLYItwivCLYIrwiuCLcIsAioCLcIqAivCLgIuQixCLgIsQiwCLkIugiyCLkIsgixCLoIuwizCLoIswiyCLsIvAi0CLsI' +
  'tAizCLwIvQi1CLwItQi0CL0Ivgi2CL0Itgi1CL4Ivwi3CL4Itwi2CL8IuAiwCL8IsAi3CMAIwQi5CMAIuQi4CMEIwgi6CMEI' +
  'ugi5CMIIwwi7CMIIuwi6CMMIxAi8CMMIvAi7CMQIxQi9CMQIvQi8CMUIxgi+CMUIvgi9CMYIxwi/CMYIvwi+CMcIwAi4CMcI' +
  'uAi/CMgIyQjBCMgIwQjACMkIygjCCMkIwgjBCMoIywjDCMoIwwjCCMsIzAjECMsIxAjDCMwIzQjFCMwIxQjECM0IzgjGCM0I' +
  'xgjFCM4IzwjHCM4IxwjGCM8IyAjACM8IwAjHCNAI0QjJCNAIyQjICNEI0gjKCNEIygjJCNII0wjLCNIIywjKCNMI1AjMCNMI' +
  'zAjLCNQI1QjNCNQIzQjMCNUI1gjOCNUIzgjNCNYI1wjPCNYIzwjOCNcI0AjICNcIyAjPCNgI2QjRCNgI0QjQCNkI2gjSCNkI' +
  '0gjRCNoI2wjTCNoI0wjSCNsI3AjUCNsI1AjTCNwI3QjVCNwI1QjUCN0I3gjWCN0I1gjVCN4I3wjXCN4I1wjWCN8I2AjQCN8I' +
  '0AjXCOAI4QjZCOAI2QjYCOEI4gjaCOEI2gjZCOII4wjbCOII2wjaCOMI5AjcCOMI3AjbCOQI5QjdCOQI3QjcCOUI5gjeCOUI' +
  '3gjdCOYI5wjfCOYI3wjeCOcI4AjYCOcI2AjfCOgI6QjhCOgI4QjgCOkI6gjiCOkI4gjhCOoI6wjjCOoI4wjiCOsI7AjkCOsI' +
  '5AjjCOwI7QjlCOwI5QjkCO0I7gjmCO0I5gjlCO4I7wjnCO4I5wjmCO8I6AjgCO8I4AjnCPAI8QjpCPAI6QjoCPEI8gjqCPEI' +
  '6gjpCPII8wjrCPII6wjqCPMI9AjsCPMI7AjrCPQI9QjtCPQI7QjsCPUI9gjuCPUI7gjtCPYI9wjvCPYI7wjuCPcI8AjoCPcI' +
  '6AjvCPgI+QjxCPgI8QjwCPkI+gjyCPkI8gjxCPoI+wjzCPoI8wjyCPsI/Aj0CPsI9AjzCPwI/Qj1CPwI9Qj0CP0I/gj2CP0I' +
  '9gj1CP4I/wj3CP4I9wj2CP8I+AjwCP8I8Aj3CAAJAQn5CAAJ+Qj4CAEJAgn6CAEJ+gj5CAIJAwn7CAIJ+wj6CAMJBAn8CAMJ' +
  '/Aj7CAQJBQn9CAQJ/Qj8CAUJBgn+CAUJ/gj9CAYJBwn/CAYJ/wj+CAcJAAn4CAcJ+Aj/CAgJCQkBCQgJAQkACQkJCgkCCQkJ' +
  'AgkBCQoJCwkDCQoJAwkCCQsJDAkECQsJBAkDCQwJDQkFCQwJBQkECQ0JDgkGCQ0JBgkFCQ4JDwkHCQ4JBwkGCQ8JCAkACQ8J' +
  'AAkHCRAJEQkJCRAJCQkICREJEgkKCREJCgkJCRIJEwkLCRIJCwkKCRMJFAkMCRMJDAkLCRQJFQkNCRQJDQkMCRUJFgkOCRUJ' +
  'DgkNCRYJFwkPCRYJDwkOCRcJEAkICRcJCAkPCRgJGQkRCRgJEQkQCRkJGgkSCRkJEgkRCRoJGwkTCRoJEwkSCRsJHAkUCRsJ' +
  'FAkTCRwJHQkVCRwJFQkUCR0JHgkWCR0JFgkVCR4JHwkXCR4JFwkWCR8JGAkQCR8JEAkXCSAJIQkZCSAJGQkYCSEJIgkaCSEJ' +
  'GgkZCSIJIwkbCSIJGwkaCSMJJAkcCSMJHAkbCSQJJQkdCSQJHQkcCSUJJgkeCSUJHgkdCSYJJwkfCSYJHwkeCScJIAkYCScJ' +
  'GAkfCSgJKQkhCSgJIQkgCSkJKgkiCSkJIgkhCSoJKwkjCSoJIwkiCSsJLAkkCSsJJAkjCSwJLQklCSwJJQkkCS0JLgkmCS0J' +
  'JgklCS4JLwknCS4JJwkmCS8JKAkgCS8JIAknCTAJMQkpCTAJKQkoCTEJMgkqCTEJKgkpCTIJMwkrCTIJKwkqCTMJNAksCTMJ' +
  'LAkrCTQJNQktCTQJLQksCTUJNgkuCTUJLgktCTYJNwkvCTYJLwkuCTcJMAkoCTcJKAkvCTgJOQkxCTgJMQkwCTkJOgkyCTkJ' +
  'MgkxCToJOwkzCToJMwkyCTsJPAk0CTsJNAkzCTwJPQk1CTwJNQk0CT0JPgk2CT0JNgk1CT4JPwk3CT4JNwk2CT8JOAkwCT8J' +
  'MAk3CUAJQQk5CUAJOQk4CUEJQgk6CUEJOgk5CUIJQwk7CUIJOwk6CUMJRAk8CUMJPAk7CUQJRQk9CUQJPQk8CUUJRgk+CUUJ' +
  'Pgk9CUYJRwk/CUYJPwk+CUcJQAk4CUcJOAk/CUgJSQlBCUgJQQlACUkJSglCCUkJQglBCUoJSwlDCUoJQwlCCUsJTAlECUsJ' +
  'RAlDCUwJTQlFCUwJRQlECU0JTglGCU0JRglFCU4JTwlHCU4JRwlGCU8JSAlACU8JQAlHCVAJUQlJCVAJSQlICVEJUglKCVEJ' +
  'SglJCVIJUwlLCVIJSwlKCVMJVAlMCVMJTAlLCVQJVQlNCVQJTQlMCVUJVglOCVUJTglNCVYJVwlPCVYJTwlOCVcJUAlICVcJ' +
  'SAlPCVgJWQlRCVgJUQlQCVkJWglSCVkJUglRCVoJWwlTCVoJUwlSCVsJXAlUCVsJVAlTCVwJXQlVCVwJVQlUCV0JXglWCV0J' +
  'VglVCV4JXwlXCV4JVwlWCV8JWAlQCV8JUAlXCWAJYQlZCWAJWQlYCWEJYglaCWEJWglZCWIJYwlbCWIJWwlaCWMJZAlcCWMJ' +
  'XAlbCWQJZQldCWQJXQlcCWUJZgleCWUJXgldCWYJZwlfCWYJXwleCWcJYAlYCWcJWAlfCWgJaQlhCWgJYQlgCWkJagliCWkJ' +
  'YglhCWoJawljCWoJYwliCWsJbAlkCWsJZAljCWwJbQllCWwJZQlkCW0JbglmCW0JZgllCW4JbwlnCW4JZwlmCW8JaAlgCW8J' +
  'YAlnCXAJcQlpCXAJaQloCXEJcglqCXEJaglpCXIJcwlrCXIJawlqCXMJdAlsCXMJbAlrCXQJdQltCXQJbQlsCXUJdgluCXUJ' +
  'bgltCXYJdwlvCXYJbwluCXcJcAloCXcJaAlvCXgJeQlxCXgJcQlwCXkJeglyCXkJcglxCXoJewlzCXoJcwlyCXsJfAl0CXsJ' +
  'dAlzCXwJfQl1CXwJdQl0CX0Jfgl2CX0Jdgl1CX4Jfwl3CX4Jdwl2CX8JeAlwCX8JcAl3CYAJgQl5CYAJeQl4CYEJggl6CYEJ' +
  'egl5CYIJgwl7CYIJewl6CYMJhAl8CYMJfAl7CYQJhQl9CYQJfQl8CYUJhgl+CYUJfgl9CYYJhwl/CYYJfwl+CYcJgAl4CYcJ' +
  'eAl/CYgJiQmBCYgJgQmACYkJigmCCYkJggmBCYoJiwmDCYoJgwmCCYsJjAmECYsJhAmDCYwJjQmFCYwJhQmECY0JjgmGCY0J' +
  'hgmFCY4JjwmHCY4JhwmGCY8JiAmACY8JgAmHCZAJkQmJCZAJiQmICZEJkgmKCZEJigmJCZIJkwmLCZIJiwmKCZMJlAmMCZMJ' +
  'jAmLCZQJlQmNCZQJjQmMCZUJlgmOCZUJjgmNCZYJlwmPCZYJjwmOCZcJkAmICZcJiAmPCZgJmQmRCZgJkQmQCZkJmgmSCZkJ' +
  'kgmRCZoJmwmTCZoJkwmSCZsJnAmUCZsJlAmTCZwJnQmVCZwJlQmUCZ0JngmWCZ0JlgmVCZ4JnwmXCZ4JlwmWCZ8JmAmQCZ8J' +
  'kAmXCaAJoQmZCaAJmQmYCaEJogmaCaEJmgmZCaIJowmbCaIJmwmaCaMJpAmcCaMJnAmbCaQJpQmdCaQJnQmcCaUJpgmeCaUJ' +
  'ngmdCaYJpwmfCaYJnwmeCacJoAmYCacJmAmfCagJqQmhCagJoQmgCakJqgmiCakJogmhCaoJqwmjCaoJowmiCasJrAmkCasJ' +
  'pAmjCawJrQmlCawJpQmkCa0JrgmmCa0JpgmlCa4JrwmnCa4JpwmmCa8JqAmgCa8JoAmnCbAJsQmpCbAJqQmoCbEJsgmqCbEJ' +
  'qgmpCbIJswmrCbIJqwmqCbMJtAmsCbMJrAmrCbQJtQmtCbQJrQmsCbUJtgmuCbUJrgmtCbYJtwmvCbYJrwmuCbcJsAmoCbcJ' +
  'qAmvCbgJuQmxCbgJsQmwCbkJugmyCbkJsgmxCboJuwmzCboJswmyCbsJvAm0CbsJtAmzCbwJvQm1CbwJtQm0Cb0Jvgm2Cb0J' +
  'tgm1Cb4Jvwm3Cb4Jtwm2Cb8JuAmwCb8JsAm3CcAJwQm5CcAJuQm4CcEJwgm6CcEJugm5CcIJwwm7CcIJuwm6CcMJxAm8CcMJ' +
  'vAm7CcQJxQm9CcQJvQm8CcUJxgm+CcUJvgm9CcYJxwm/CcYJvwm+CccJwAm4CccJuAm/CcgJyQnBCcgJwQnACckJygnCCckJ' +
  'wgnBCcoJywnDCcoJwwnCCcsJzAnECcsJxAnDCcwJzQnFCcwJxQnECc0JzgnGCc0JxgnFCc4JzwnHCc4JxwnGCc8JyAnACc8J' +
  'wAnHCdAJ0QnJCdAJyQnICdEJ0gnKCdEJygnJCdIJ0wnLCdIJywnKCdMJ1AnMCdMJzAnLCdQJ1QnNCdQJzQnMCdUJ1gnOCdUJ' +
  'zgnNCdYJ1wnPCdYJzwnOCdcJ0AnICdcJyAnPCdgJ2QnRCdgJ0QnQCdkJ2gnSCdkJ0gnRCdoJ2wnTCdoJ0wnSCdsJ3AnUCdsJ' +
  '1AnTCdwJ3QnVCdwJ1QnUCd0J3gnWCd0J1gnVCd4J3wnXCd4J1wnWCd8J2AnQCd8J0AnXCeAJ4QnZCeAJ2QnYCeEJ4gnaCeEJ' +
  '2gnZCeIJ4wnbCeIJ2wnaCeMJ5AncCeMJ3AnbCeQJ5QndCeQJ3QncCeUJ5gneCeUJ3gndCeYJ5wnfCeYJ3wneCecJ4AnYCecJ' +
  '2AnfCegJ6QnhCegJ4QngCekJ6gniCekJ4gnhCeoJ6wnjCeoJ4wniCesJ7AnkCesJ5AnjCewJ7QnlCewJ5QnkCe0J7gnmCe0J' +
  '5gnlCe4J7wnnCe4J5wnmCe8J6AngCe8J4AnnCfAJ8QnpCfAJ6QnoCfEJ8gnqCfEJ6gnpCfIJ8wnrCfIJ6wnqCfMJ9AnsCfMJ' +
  '7AnrCfQJ9QntCfQJ7QnsCfUJ9gnuCfUJ7gntCfYJ9wnvCfYJ7wnuCfcJ8AnoCfcJ6AnvCfgJ+QnxCfgJ8QnwCfkJ+gnyCfkJ' +
  '8gnxCfoJ+wnzCfoJ8wnyCfsJ/An0CfsJ9AnzCfwJ/Qn1CfwJ9Qn0Cf0J/gn2Cf0J9gn1Cf4J/wn3Cf4J9wn2Cf8J+AnwCf8J' +
  '8An3CQAKAQr5CQAK+Qn4CQEKAgr6CQEK+gn5CQIKAwr7CQIK+wn6CQMKBAr8CQMK/An7CQQKBQr9CQQK/Qn8CQUKBgr+CQUK' +
  '/gn9CQYKBwr/CQYK/wn+CQcKAAr4CQcK+An/CQgKCQoBCggKAQoACgkKCgoCCgkKAgoBCgoKCwoDCgoKAwoCCgsKDAoECgsK' +
  'BAoDCgwKDQoFCgwKBQoECg0KDgoGCg0KBgoFCg4KDwoHCg4KBwoGCg8KCAoACg8KAAoHChAKEQoJChAKCQoIChEKEgoKChEK' +
  'CgoJChIKEwoLChIKCwoKChMKFAoMChMKDAoLChQKFQoNChQKDQoMChUKFgoOChUKDgoNChYKFwoPChYKDwoOChcKEAoIChcK' +
  'CAoPChgKGQoRChgKEQoQChkKGgoSChkKEgoRChoKGwoTChoKEwoSChsKHAoUChsKFAoTChwKHQoVChwKFQoUCh0KHgoWCh0K' +
  'FgoVCh4KHwoXCh4KFwoWCh8KGAoQCh8KEAoXCiAKIQoZCiAKGQoYCiEKIgoaCiEKGgoZCiIKIwobCiIKGwoaCiMKJAocCiMK' +
  'HAobCiQKJQodCiQKHQocCiUKJgoeCiUKHgodCiYKJwofCiYKHwoeCicKIAoYCicKGAofCigKKQohCigKIQogCikKKgoiCikK' +
  'IgohCioKKwojCioKIwoiCisKLAokCisKJAojCiwKLQolCiwKJQokCi0KLgomCi0KJgolCi4KLwonCi4KJwomCi8KKAogCi8K' +
  'IAonCjAKMQopCjAKKQooCjEKMgoqCjEKKgopCjIKMworCjIKKwoqCjMKNAosCjMKLAorCjQKNQotCjQKLQosCjUKNgouCjUK' +
  'LgotCjYKNwovCjYKLwouCjcKMAooCjcKKAovCjgKOQoxCjgKMQowCjkKOgoyCjkKMgoxCjoKOwozCjoKMwoyCjsKPAo0CjsK' +
  'NAozCjwKPQo1CjwKNQo0Cj0KPgo2Cj0KNgo1Cj4KPwo3Cj4KNwo2Cj8KOAowCj8KMAo3CkAKQQo5CkAKOQo4CkEKQgo6CkEK' +
  'Ogo5CkIKQwo7CkIKOwo6CkMKRAo8CkMKPAo7CkQKRQo9CkQKPQo8CkUKRgo+CkUKPgo9CkYKRwo/CkYKPwo+CkcKQAo4CkcK' +
  'OAo/CkgKSQpBCkgKQQpACkkKSgpCCkkKQgpBCkoKSwpDCkoKQwpCCksKTApECksKRApDCkwKTQpFCkwKRQpECk0KTgpGCk0K' +
  'RgpFCk4KTwpHCk4KRwpGCk8KSApACk8KQApHClAKUQpJClAKSQpIClEKUgpKClEKSgpJClIKUwpLClIKSwpKClMKVApMClMK' +
  'TApLClQKVQpNClQKTQpMClUKVgpOClUKTgpNClYKVwpPClYKTwpOClcKUApIClcKSApPClgKWQpRClgKUQpQClkKWgpSClkK' +
  'UgpRCloKWwpTCloKUwpSClsKXApUClsKVApTClwKXQpVClwKVQpUCl0KXgpWCl0KVgpVCl4KXwpXCl4KVwpWCl8KWApQCl8K' +
  'UApXCmAKYQpZCmAKWQpYCmEKYgpaCmEKWgpZCmIKYwpbCmIKWwpaCmMKZApcCmMKXApbCmQKZQpdCmQKXQpcCmUKZgpeCmUK' +
  'XgpdCmYKZwpfCmYKXwpeCmcKYApYCmcKWApfCmgKaQphCmgKYQpgCmkKagpiCmkKYgphCmoKawpjCmoKYwpiCmsKbApkCmsK' +
  'ZApjCmwKbQplCmwKZQpkCm0KbgpmCm0KZgplCm4KbwpnCm4KZwpmCm8KaApgCm8KYApnCnAKcQppCnAKaQpoCnEKcgpqCnEK' +
  'agppCnIKcwprCnIKawpqCnMKdApsCnMKbAprCnQKdQptCnQKbQpsCnUKdgpuCnUKbgptCnYKdwpvCnYKbwpuCncKcApoCncK' +
  'aApvCngKeQpxCngKcQpwCnkKegpyCnkKcgpxCnoKewpzCnoKcwpyCnsKfAp0CnsKdApzCnwKfQp1CnwKdQp0Cn0Kfgp2Cn0K' +
  'dgp1Cn4Kfwp3Cn4Kdwp2Cn8KeApwCn8KcAp3CoAKgQp5CoAKeQp4CoEKggp6CoEKegp5CoIKgwp7CoIKewp6CoMKhAp8CoMK' +
  'fAp7CoQKhQp9CoQKfQp8CoUKhgp+CoUKfgp9CoYKhwp/CoYKfwp+CocKgAp4CocKeAp/CogKiQqBCogKgQqACokKigqCCokK' +
  'ggqBCooKiwqDCooKgwqCCosKjAqECosKhAqDCowKjQqFCowKhQqECo0KjgqGCo0KhgqFCo4KjwqHCo4KhwqGCo8KiAqACo8K' +
  'gAqHCpAKkQqJCpAKiQqICpEKkgqKCpEKigqJCpIKkwqLCpIKiwqKCpMKlAqMCpMKjAqLCpQKlQqNCpQKjQqMCpUKlgqOCpUK' +
  'jgqNCpYKlwqPCpYKjwqOCpcKkAqICpcKiAqPCg==';
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
  const outward    = new Float32Array(count);

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
    rayReach = cornerReach * (0.55 + 0.45 * Math.random());
    flowAt(walk[0], walk[1], walk[2], strandScale, flow);
  };
  // A ray runs until it passes its OWN reach, drawn per strand. With one shared limit every
  // ray stopped at the same radius and their tips lined up into an arc — which reads as a
  // band around the corner, the opposite of rays thrown out of it.
  let rayReach = cornerReach;
  const inCorner = (x, y) =>
    x <= 0 && y <= 0 && Math.hypot(x, y) <= rayReach;

  // Flow plus a push straight away from the corner. Written as its own step because the
  // vertex shader has to reproduce it exactly: these motes travel along their thread, and a
  // thread built with an outward lean has to be travelled with the same lean or the motes
  // walk off it.
  const dir = [0, 0, 0];
  const cornerDir = (at, fl, out) => {
    const l = Math.hypot(at[0], at[1]);
    const k = CONFIG.extraStrandOutward;
    if (l > 1e-6 && k > 0) {
      out[0] = fl[0] + (at[0] / l) * k;
      out[1] = fl[1] + (at[1] / l) * k;
      out[2] = fl[2];
    } else {
      out[0] = fl[0]; out[1] = fl[1]; out[2] = fl[2];
    }
    const n = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= n; out[1] /= n; out[2] /= n;
  };

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
        cornerDir(walk, flow, dir);
        const nx = walk[0] + dir[0] * cornerStep;
        const ny = walk[1] + dir[1] * cornerStep;
        const nz = walk[2] + dir[2] * cornerStep;
        if (inCorner(nx, ny)) {
          walk[0] = nx; walk[1] = ny; walk[2] = nz;
        } else {
          // A ray that reaches the edge of its box is FINISHED, and the next one starts
          // back at the corner. Turning it back was right when these wandered; for a thread
          // that is meant to be leaving, a return trip reads as the ray folding over itself.
          startCornerStrand();
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

    // every seat, whatever produced it, moves with the model
    px += CONFIG.modelOffsetX * planeW;
    py += CONFIG.modelOffsetY * planeH;

    initPos[i3]     = px;
    initPos[i3 + 1] = py;
    initPos[i3 + 2] = pz;

    lives[i] = Math.random() < CONFIG.lifeFraction ? 1 : 0;
    outward[i] = isCorner ? 1 : 0;

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
  inst('aOutward', outward, 1);

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
    aLife: lives.slice(), aOutward: outward.slice(),
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
  uOutward: { value: CONFIG.extraStrandOutward },
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
  uniforms.uOutward.value = CONFIG.extraStrandOutward;
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
  // the motes' own clock, which the speed control scales. Accumulated rather than
  // multiplied at read time, so changing the pace never jumps their phase.
  uniforms.uTime.value += dt * CONFIG.speed;
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
// Six controls: colour, quantity, size, glow, glow size, speed. Each prints the CONFIG
// value it
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
    // The glow is a post pass, so its strength does not live in the particle material —
    // it is a uniform on the composite, reached through the bloom chain.
    { key: 'bloomStrength', name: 'glow', cst: 'CONFIG.bloomStrength',
      min: 0, max: 4, step: 0.01, value: CONFIG.bloomStrength,
      apply: (v) => { if (bloomChain) bloomChain.composite.uniforms.uStrength.value = v; } },
    // Read straight out of CONFIG by the blur pass every frame, so there is nothing to
    // push anywhere — the bar just writes the value.
    { key: 'bloomRadius', name: 'glow size', cst: 'CONFIG.bloomRadius',
      min: 0.05, max: 0.7, step: 0.005, value: CONFIG.bloomRadius },
    { key: 'speed', name: 'speed', cst: 'CONFIG.speed',
      min: 0, max: 3, step: 0.01, value: CONFIG.speed },
  ];

  const rgbAt = (h) => hsvToRgb(h, satFixed, valFixed);
  const text = (r, v) => {
    if (r.key === 'hue') return rgbAt(v).map((c) => c.toFixed(3)).join('  ');
    if (r.key === 'particleCount') return String(Math.round(v));
    if (r.key === 'bloomStrength' || r.key === 'bloomRadius' || r.key === 'speed') {
      return v.toFixed(2);
    }
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
      if (r.apply) r.apply(CONFIG[r.key]);
      if (r.rebuild) { clearTimeout(pending); pending = setTimeout(rebuild, 110); }
    });
  });
}
