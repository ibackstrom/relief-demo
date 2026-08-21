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
//               specular, then the overlay/sat/contrast chain, and finally a blend to the
//               colour of the ground for the motes that stand alone at the fringe
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
  particleCount: 50000,     // far fewer than ver6's 60000, and the model is why: this one
                            //   covers under a third of its own box, so the same count
                            //   lands three times as densely and the ribbons fill in
                            //   solid. The drawing only reads while its motes are still
                            //   separable
  // Sized so the MEAN grain lands just above minPx, not below it. "Very small" has a floor
  // here and it is a hard one: a mote under the sub-pixel guard is inflated back up to
  // minPx and has its alpha divided by the SQUARE of that inflation, so pushing the size
  // down past about a pixel does not make finer grains, it makes invisible ones. At 0.62
  // with sizeMax 3.2 the whole population went sub-pixel and the drawn pixels fell a
  // hundredfold — the cloud read as a speck.
  particleSize: 2.05,        // sphere diameter, world units, before the per-mote multiplier

  // Size comes from a HEAVY-TAILED draw rather than a +/- spread around the base:
  // mult = sizeMin + (sizeMax - sizeMin) * rand^sizeBias.
  //
  // A symmetric spread has to raise its MEAN to widen its RANGE, so the whole cloud gets
  // heavier as the big motes get bigger and there is a limit to how far it can be pushed.
  // A biased tail decouples the two: most motes stay small while a few reach right out to
  // sizeMax. That is what puts small and large side by side rather than sorting them.
  sizeMin: 0.55,
  // The tail is what was making gravel. At 4.0 the largest grains landed near six pixels
  // before the stretch widened them again, and a scatter of six-pixel discs reads as
  // confetti however fine the mean is. 2.4 puts the mean near 0.9 px and the tail at 3.
  sizeMax: 1.60,
  sizeBias: 2.0,            // 1 is uniform; each step up crowds the population toward
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

  // Where the density peaks, in plane widths and heights, measured from the CENTRE OF THE
  // MASS. The cloud is going under a "BOOK NOW" label, and the label is what the eye goes
  // to — so the motes have to be thickest there and thin out from it, rather than thickest
  // wherever the model happens to be densest. 0,0 is the middle of the drawing; negative x
  // moves the peak left, negative y down.
  focusX: 0.0,
  focusY: 0.0,

  // Denser toward that focus. The model's own sampling is even across its projected area,
  // so density follows the SILHOUETTE rather than the corner — measured on the last build
  // the coverage fell to 0.55 forty pixels out and rose again to 0.80 further along, which
  // is the lens shape talking, not a gradient. This weights the draw by distance from the
  // corner itself, on top of everything the model decides.
  //
  // 0 leaves the model's even coverage alone. Each step up crowds the population cornerward
  // and, since the count is fixed, thins the far side by exactly as much. It is a power on
  // the radius of the throw, so it has no ceiling to fall off.
  // Pulled right down to open the mass out. This is the single biggest reason the cloud read
  // as a tight lump: it is a power on the radius of every throw, so at 2.4 almost the whole
  // population was landing within a fraction of the focus and no amount of field travel could
  // separate them afterwards. The filaments need room before they need anything else.
  focusDensity: 0.5,        // ver8 raises this again: the label wants a clear peak under
                            //   it and a proportional fall away from it. Too high and the
                            //   drawing vanishes under a single hot spot

  // How clumpy the sheet is. Seats are rejection-sampled against a low-frequency noise
  // field, so motes gather in some places and thin out in others instead of covering
  // evenly. Held over from the previous versions and lowered — the reference has no
  // equivalent, its unevenness comes from the photograph it samples, and ours has to be
  // put in by hand. Past ~0.8 the voids read as holes rather than as texture.
  // ------------------------------------------------------------ the corner cloud
  // The seed, and it is deliberately the simplest thing in the file: a quarter-disc of
  // points spilling out of the screen corner, dense at the corner and thinning outward.
  // Everything that gives the cloud its look happens downstream of this, in the flow.
  cornerSeed: true,         // false falls back to the model-and-mask seeding below
  // A third of what it was. Note that particleSize came down by the same third rather than
  // staying put, and that pairing is what keeps the look identical instead of merely smaller:
  // shrinking the mass alone cuts its area to a ninth and makes the same population nine
  // times denser, while shrinking the grain alone cuts each mote's coverage to a ninth. Doing
  // both at once cancels exactly, so the density that was tuned on the large version is the
  // density that arrives on the small one, with no change to the count.
  cornerRadius: 0.14,       // how far the cloud reaches, in viewport heights. This is the
                            //   size dial — it is measured against the FRAME, so it does
                            //   not have to be re-derived when anything else moves
  cornerBias: 0.42,         // spread of the Gaussian, in units of cornerRadius. It is no
                            //   longer a power on a bounded radius — that gave the cloud a
                            //   last radius, which is a circle
  cornerSpill: 0.55,        // radians of overspill past the visible quarter, so the two
                            //   straight edges do not read as a cut. Small: most of the
                            //   overspill goes up and right, which is off the screen, so it
                            //   is paid for out of the population without being seen
  cornerDepth: 0.45,        // thickness front to back, as a fraction of the radius

  // ------------------------------------------------------------ the silhouette
  // The mass is one elongated STREAK, not a blob: roughly three to one, dense and wide at
  // the corner end and tapering into thin trailing wisps away from it. It reads as thrown
  // and dragged, so everything about it is anisotropic — the throw, the noise the mask is
  // cut from, and the grains themselves are all long along the throw axis and compressed
  // across it. A field that is isotropic anywhere in that chain pulls the shape back toward
  // a circle, which is what a blob is.
  flowAngle: 196,           // degrees, the throw axis: which way the pigment was dragged.
                            //   196 runs left and slightly down from the corner
  silhouette: 3.4,          // long-to-across ratio of the streak. 1 is a circle
  streakTaper: 0.95,        // how fast the trailing end thins out, in plane widths. Small
                            //   is an abrupt stub, large is a long dissolving tail
  streakHead: 0.10,         // how far the dense end reaches PAST the focus toward the
                            //   corner, so the mass stays anchored there rather than
                            //   floating off it

  // ------------------------------------------------------------ the spawn mask
  // Where a grain is allowed to exist. A domain-warped fBm density field, thresholded hard:
  // six octaves, lacunarity 2, gain 0.5 (fixed, up by FBM_OCTAVES). The threshold is what
  // fragments the edge into separate specks instead of fading it out.
  fbmScale: 5.5,            // features per plane width. Higher is a finer break-up
  fbmWarp: 0.55,            // how far the domain is dragged before the field is read. 0 is
                            //   plain fBm and gives round blobs with round holes; this is
                            //   what makes the survivors stringy and hooked
  fbmThreshold: 0.36,       // kill below this. The single dial for how much of the mass
                            //   survives — raise it and the cloud goes to lace. Read it
                            //   against the field's real spread, which is narrow: the warped
                            //   fBm runs 0.21 to 0.73 with a median of 0.50 and a standard
                            //   deviation of only 0.10, so a tenth on this is a large move
  // Marbling. The interior must not be solid: even the densest pigment is veined and gappy.
  // Subtracting a second, finer, lower-amplitude noise from the warped field puts holes
  // through the middle of the mass instead of only round its edge.
  veinScale: 2.7,           // frequency of that subtracted layer, relative to fbmScale
  veinAmount: 0.30,         // how deep it cuts. Past ~0.5 the mass stops being one thing

  // The dissolve, and this is what makes three bands out of one field rather than a single
  // fading edge. A high-frequency noise is thresholded, and THE THRESHOLD TRACKS THE MACRO
  // DENSITY: where the macro density is high the threshold is near zero and almost every
  // grain passes, so the core is near solid; where it is low the threshold is near one and
  // only the noise peaks pass, so the mass shatters into clusters and then into isolated
  // specks. The dot spacing widens smoothly with distance because the threshold does.
  dissolveScale: 9.0,       // frequency of the deciding noise, relative to fbmScale. This is
                            //   the size of the speckle in the halo
  dissolveGain: 1.10,       // how quickly the threshold relaxes as the macro density rises.
                            //   High makes the core solid and the transition narrow

  fbmRadial: 0.30,          // how much the radial falloff multiplies into the field before
                            //   the threshold. At 0 the holes are spread evenly through the
                            //   mass; at 1 the core is solid and only the edge fragments.
                            //   Low, and this is the trap in it: the throw is ALREADY
                            //   crowded toward the focus by focusDensity, so a strong radial
                            //   term here is a second concentration on top of the first. At
                            //   0.85 it did not fray the edge, it deleted it — the mass came
                            //   out a third of its radius with a twentieth of the grains
  // Sized to the streak, not far outside it. This is the denominator the macro density is
  // measured against, and the macro density is what the dissolve threshold tracks — leave it
  // large and the macro reads as 1 everywhere, the threshold never rises, and there is no
  // transition band and no speckle halo at all, just a hard-edged lump.
  // These three are one shape and have to be read together, in map units. The streak's ACROSS
  // half-width is fbmReach / silhouette, and its ALONG half-length is streakTaper. Set the
  // taper to anything near the across-width and the mass comes out square however high the
  // silhouette ratio is — which is exactly what happened at taper 0.38 against an across-width
  // of 0.22: a 3.4:1 stretch that measured 1.7:1 on screen.
  fbmReach: 1.10,           // radius of that falloff, in plane widths. It has to sit well
                            //   OUTSIDE the mass, not on it: the seats' own median radius is
                            //   about 0.39 plane widths, and at 0.62 the falloff was already
                            //   down to a third there, so the threshold was killing the body
                            //   of the cloud rather than fraying its edge. Only 12% of throws
                            //   survived and what was left was a speck

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
  strandFraction: 0.0,     // share of motes belonging to strands. The rest stay loose, and
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
  strayFraction: 0.0,
  strayReach: 0.25,

  // Motes shrink with distance from the corner. The size draw is otherwise uniform across
  // the mass, so the fine spray and the big motes are equally likely anywhere — and a big
  // mote out at the edge reads as a stray blob rather than as the mass thinning out. This
  // keeps the weight where the mass is and lets the outside break into fine particles.
  sizeEdge: 0.72,           // size multiplier at the far edge, against 1 at the corner.
                            //   Gentler than ver6's 0.42: the drawn shape reaches well
                            //   out from the corner and a hard shrink erases its far end
  sizeEdgeScale: 0.75,      // distance over which it falls away, in plane widths


  // A single multiplier over the box and everything measured against it. The panel drives
  // this rather than the three box numbers, because the box is never the only thing that has
  // to move: the hover plateau has to keep covering the resting cloud, and the crowding
  // neighbourhood has to keep matching its density. Those travel with it here so the bar
  // cannot leave them behind.
  //
  // The population is deliberately NOT scaled by it. Motes per projected area is what sets
  // how the drawing reads, so shrinking with the count held makes the cloud denser — which
  // is sometimes what you want. The quantity bar is next to it.
  // Bigger, because spreading alone could not show the pattern: the plane is centred on the
  // screen corner, so most of a small cloud's expansion goes off-frame and what is left on
  // screen only gets thinner. Size and placement have to move together with the spread.
  scale: 5.20,

  // How far the drawing sits from the corner, in plane widths and heights. The plane is
  // centred on the group's origin and the origin is the screen corner, so 0 puts three
  // quarters of the model off-screen; larger values walk it into the frame.
  // Back to where it was before the label pushed it around: the cloud belongs in the corner,
  // and it is the SIGN that moves to sit over it, not the other way about.
  // Far enough in that the plane is mostly ON screen. The plane is centred on the group
  // origin and the origin is the screen corner, so at 0.15 roughly three quarters of it sat
  // outside the frame and every grain the field carried outward was carried out of sight.
  position: 0.300,

  // ------------------------------------------------------------ the box the model fits
  // The rasterised plane is scaled to fit inside this box, keeping the model's
  // proportions, in units of the viewport HEIGHT at the cloud's depth — so the cloud keeps
  // its share of the frame at every window size. Only the tightest axis touches its wall.
  boxWidth: 0.144,
  boxHeight: 0.126,
  boxDepth: 0.144,

  // ------------------------------------------------------------ placement
  // Viewport halves from centre: 1 is exactly the right/top edge. Past 1 the centre of
  // mass goes off-screen, the bloom grows out of frame, and the open state falls short.
  // Which corner the cloud grows out of: 'tr', 'tl', 'br', 'bl'. Everything that has to
  // agree with it — the anchor, the seed's quadrant and the origin the hover blooms about —
  // is derived from this one string rather than set three times.
  corner: 'tr',

  // Where the mass actually sits, and how big it is on screen. All three are applied to the
  // GROUP, so they are instant — no seats are re-thrown — and they scale the motion with the
  // mass, which is what keeps the look identical at any size.
  //
  // They exist as offsets rather than as a corrected anchor because the anchor is not what
  // was wrong: the seeds sit exactly on the corner and it is DIFFUSION that carries the
  // visible mass inward off it. Nudging the group back out is the honest correction for
  // that, and it is easier to set by eye than to derive.
  offsetX: 0.315,            // viewport heights, positive toward the corner's own side
  offsetY: 0.375,
  massScale: 1.90,          // on-screen size of the whole thing, motion included

  anchorX: 1.00,
  anchorY: 0.97,
  anchorZ: 0.0,

  // How fast the motes do everything they do on their own — the swirl, the travel along
  // their threads, the birth-to-death. One dial rather than four, because it scales the
  // CLOCK the motes are read from rather than any one of their speeds, so their motion stays
  // in proportion however fast it runs. The cloud's own sway is deliberately not included:
  // that is the camera's relationship to the volume, not the particles' own life.
  speed: 0.55,              // The pace lives in simSpeed now — this scales the clock the
                            //   simulation is stepped with, and 1 means one second of the
                            //   cloud's life per second of the page's. Under 1 here because
                            //   the motion was asked for slower: it scales the whole clock,
                            //   so the drift, the bloom and the birth-to-death all slow
                            //   together and the character of the motion survives it.

  // ------------------------------------------------------------ parallax
  // A slow sway of the whole volume. With a fixed camera this is the only thing that
  // makes near motes travel further across the frame than far ones, and motion parallax
  // is the strongest depth cue available — stronger than size or shading. Kept slow and
  // small enough that it reads as the cloud breathing rather than as a turntable.
  parallaxAmount: 0.08,     // radians of yaw at the extremes. Cut hard: the sway is a rigid
                            //   translation of the whole mass, it scales with the cloud's
                            //   distance from the origin, and at 0.30 it was the largest
                            //   velocity in the frame — the cloud read as being carried
                            //   about rather than as moving under its own weather. The
                            //   reference has no camera move in it at all
  parallaxTilt: 0.03,       // radians of pitch, at a different period so it never loops
  parallaxSeconds: 19.0,    // period of the yaw. The tilt runs at 0.63x this.

  // ------------------------------------------------------------ depth shading
  // Aerial perspective: motes at the back of the volume are dimmed and thinned. Without
  // it every mote is equally present and the volume collapses back into a decal however
  // correct the geometry is.
  depthFade: 0.20,          // alpha lost across the full depth of the box, 0 = flat
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
  curlFrequency: 9.0,       // spatial scale of the swirl. Higher = tighter eddies; the
                            //   noise is scaled by amplitude/frequency internally, so
                            //   raising this does not also raise the displacement.
                            //   Set from the reference: its velocity field decorrelates
                            //   over 13-20% of the mass radius, where this cloud's ran to
                            //   45% — eddies larger than the cloud they were supposed to
                            //   be curling, which is why nothing in it ever folded
  curlAmplitude: 0.20,      // how far a mote is carried off its seat. This is the main
                            //   "how alive is it" dial.
  curlSpeed: 18.0,          // how fast the field itself evolves. The field translates in
                            //   its own z with time, so motes do not retrace a path.
  curlDivergence: 1.00,     // how much of a purely SPREADING field is mixed into the swirl,
                            //   0 = curl only. 1 puts divergence and vorticity at the same
                            //   rms, which is what the reference measures right through its
                            //   run. Without it the cloud can only ever churn in place
  curlAffectedParticles: 0.85,  // fraction of the stationary motes that take curl at all;
                                //   the remainder are dead still and give the cloud grain.

  // ------------------------------------------------------------ the simulation
  // Position is STATE here, not a formula. Every particle's place is carried in a float
  // texture and advanced once per frame, p += velocity(p, t) * dt, so what is on screen is
  // the particle's whole history through the field rather than a displacement from a seat
  // it never really leaves.
  //
  // That distinction is the whole of this version, and it is not a refinement of the last
  // one. A filament IS a history: the flow stretches a patch of particles into a sheet and
  // folds it, and the fold exists only because the particles went around the eddy instead
  // of being offset by it. A cloud whose position is a pure function of the clock has no
  // history to fold, so no setting of it can produce one — which is what the previous
  // version established by failing to.
  //
  // It also gives the sequence the reference has. Every particle starts at its seat with
  // age zero, so the first seconds after load ARE the unfurl; deaths are staggered by a
  // per-particle lifespan, so within a cycle or two the population is mixed and the cloud
  // settles into an endless churn inside a fixed envelope. Measured on the reference: the
  // mass spreads 27% over four seconds, and its radius is then flat to within half a
  // percent for the remaining four.
  //
  // What is stored is the OFFSET from the seat, not the absolute position. Offsets are
  // small numbers, so the buffer keeps its precision where it is needed — and on a device
  // that will only give us half floats, an absolute position's smallest representable step
  // is larger than one frame's movement and the cloud would simply never start.
  simSpeed: 0.064,          // the field's strength, as a fraction of the mass radius per
                            //   second, so a resize does not change the pace. The reference
                            //   carries its motes at 3.0-3.5% of the mass radius per second;
                            //   this sits above that because the curl's own magnitude is
                            //   folded in on top, and because at a third of the reference's
                            //   size its exact rate reads as a still picture
  // Also the leash. The seeds sit AT the corner, but a particle wanders further the longer
  // it lives, and it can only wander one way — inward, because the corner is a boundary and
  // there is nothing on the other side of it to wander into. So a long life does not just
  // trace a longer path, it walks the whole centre of mass off the corner and leaves a gap.
  // At 26 seconds the gap was about a fifth of the frame.
  simLife: 9.0,             // seconds from birth at the seat to death. With simSpeed this
                            //   sets how far the cloud spreads before it stops, because the
                            //   envelope is as far as a particle gets in one life
  simLifeSpread: 0.85,      // +/- fraction on that lifespan, drawn per particle. Without it
                            //   every particle born at load dies at the same instant and
                            //   the whole cloud blinks; this is what turns one coherent
                            //   unfurl into a steady churn.
                            //   It has to be WIDE, and that is measurable rather than a
                            //   matter of taste: at 0.45 the first cohort's deaths all fall
                            //   inside one four-second window, and the cloud measurably
                            //   thins once, seven seconds after load — radius 42 to 36 and
                            //   a quarter of the drawn pixels gone. At 0.85 the same deaths
                            //   are smeared over twelve seconds and there is nothing to see
  simFrequency: 1.2,        // eddy size, as 1/frequency in world units. LOW on purpose: this
                            //   octave is the macro swirl and the x3.1 one below carries the
                            //   filament detail. From the reference:
                            //   its field decorrelates over 13-20% of the mass radius
  simFieldSpeed: 0.53,      // how fast the field itself changes, from the reference's
                            //   1.5-second coherence. Too high and the filaments never get
                            //   long enough to fold before the field that drew them is gone
  simDivergence: 0.75,      // the spreading half of the field — see curlNoise. Held under 1
                            //   so the field turns more than it spreads: the first clip's
                            //   look is curling ink, not a burst opening out
  simFine: 0.70,            // weight of a second octave at 3.1x the frequency. The large
                            //   octave makes the lobes, this one the hairs inside them
  simGravity: 0.0,          // world units per second, straight down, always. Off here: a
                            //   flow field has no down, and the drift it added only pulled
                            //   the mass off the corner

  // ------------------------------------------------------------ inertia
  // How much of its own motion a particle keeps. These two are the difference between a
  // cloud that answers the pointer and one that REMEMBERS it.
  //
  // settle is the rate at which a particle gives up its velocity for the field's. At 1 it
  // keeps nothing, snaps to the field every frame, and the cursor's effect exists only where
  // the cursor is — which is the plastic feel. Low, it is heavy: a shove takes seconds to
  // bleed away, so a push on the left is still travelling while you push on the right, and
  // the two are in the cloud together.
  // ONE dial across the whole feel: 0 is the old hover, 1 is the new one.
  //
  // settle and drag are not independent tastes, they are two ends of a single axis, so they
  // move together here. At 0 a particle keeps none of its own motion and the leak is fast —
  // which reproduces the memoryless push exactly, because a particle that snaps to the field
  // every frame cannot carry anything the pointer did. At 1 it is heavy and the cloud holds
  // several pushes at once.
  // Defaulting to 0, which is the hover from ver7-ver10 exactly. The inertial version is on
  // the bar rather than shipped, because the two are different behaviours and the old one is
  // the one that has been confirmed to feel right.
  hoverFeel: 0.10,

  // The two ends the dial runs between. settle interpolates GEOMETRICALLY — it is a rate, so
  // the halfway point that matters is the geometric mean, not the arithmetic one.
  hoverOldSettle: 1.0,
  hoverNewSettle: 0.045,
  hoverOldDrag: 0.900,
  hoverNewDrag: 0.992,

  // Strength, given as the SPEED the cursor drives particles at — a fraction of the mass
  // radius per second, the same units simSpeed is in — with the force worked back out of it.
  //
  // Stating it as a force does not survive the dial. A force that accumulates over many
  // frames produces far more velocity than the same force that does not, by 1/(1 - drag *
  // (1 - settle)): about 19 at the heavy end and 1 at the light one. So the same number means
  // two very different pushes, and dividing a force by that gain is worse still, which is
  // what emptied the effect out — the value had been tuned WITH the accumulation and then had
  // it removed as well, leaving the push six times weaker than the ambient flow and invisible.
  //
  // Solving for the force instead, F = speed / (dt * gain), makes the number mean one thing
  // at every setting of the dial.
  hoverPush: 0.35,          // of the mass radius per second

  // The bloom, all three numbers read off the reference and all given per unit of the mass
  // radius so a resize does not have to re-derive them.
  // Almost off. The origin story is powder THROWN across a surface, not a charge going off
  // in the middle of it, so the initial impulse is directional and this symmetric radial
  // term is only here to stop the very centre packing solid.
  launchBurst: 0.0,        // outward from the cloud's centre, per second, at birth. This is
                            //   the dial that sets how far the cloud opens: the reference's
                            //   radius doubles, growing 36% of itself per second at half a
                            //   second and asymptotically slower after.
                            //   It cannot simply be raised to match that. Past about 0.8 the
                            //   cloud HOLLOWS: every particle is leaving the centre at once
                            //   and they pile up against the decaying impulse at a front, so
                            //   the mass becomes a ring with a hole where the ink should be
                            //   thickest. The centre is refilled by newborns, which is why
                            //   this is set together with simLife
  launchSpeed: 0.0,        // the throw itself, same units, same decay
  launchDecay: 2.00,        // seconds. Both terms e-fold away over this, which puts the
                            //   growth rate at a tenth of its opening value by five seconds
                            //   — the reference is at a hundredth of it by seven
  bloomRadius: 1.90,        // how much bigger the settled cloud is than the seats it grew
                            //   from. It has to be raised whenever the spread is — it is the
                            //   denominator of the ramp that drives ALPHA, so a cloud that
                            //   outgrows it has its outer grains discarded rather than drawn
                            //   faint, and spreading the mass would delete the very filaments
                            //   the spreading was for.
                            //   from, measured on a render. It is not cosmetic: the radial
                            //   crowding ramp is expressed against it, and while it was left
                            //   at the seats' own radius the whole bloomed mass sat outside
                            //   the ramp, counted as fringe, and blended into the wall —
                            //   thick ink came out RGB(153, 90, 91) against the reference's
                            //   (135, 69, 71) and no amount of opacity fixed it

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
  mouseRadius: 0.075,       // radius of the tube that opens. Raised because the reach is
                            //   now correctly divided by the group's scale — the old number
                            //   was reaching 1.9x further than it said
  mouseStrength: 0.075,     // how far a mote at the centre of it is pushed. Raised well past
                            //   ver7-ver10's 0.055: it had been cut to 0.022 when the note
                            //   was that hover felt too FAST, and that turned out to be the
                            //   growth rather than the push — so the push had been quietly
                            //   carrying a fix for something else
  falloffPower: 3.0,        // 1 = linear, 2 = soft outer edge with a firm core
  mouseSmoothing: 0.12,     // lag on the cursor the motes actually see, per frame. Low
                            //   values make the cloud trail the pointer.
  mouseFadeSeconds: 0.45,   // fade in/out of the whole response when the pointer arrives
                            //   or leaves, so nothing snaps.
  // How hard the cursor's edge is blurred. The push is bounded by a radius, and with one
  // radius for every mote that boundary is exact: motes stop being pushed at precisely that
  // distance and pile up just outside it, which draws a clean circle on the page. No falloff
  // curve can soften it, because the curve only sets how HARD each mote is pushed, never
  // WHICH motes are in the set.
  //
  // Giving every mote its own radius removes the shared boundary altogether. At 0.6 a mote's
  // radius runs from 0.4x to 1.6x the nominal one, so the rim becomes a band as wide as that
  // spread rather than a line. 0 is the old hard circle.
  mouseEdgeBlur: 0.6,
  // How ragged the hole's rim is, and at what scale. The amount is a fraction of the radius,
  // so 0.3 means the rim wanders by about a third of it. Keep it modest: past ~0.5 the hole
  // stops reading as one opening and starts breaking into separate bites.
  mouseNoise: 0.42,
  mouseNoiseScale: 9.0,     // features per world unit along the rim. Read it against
                            //   mouseRadius: this wants to give several lobes ACROSS the
                            //   opening, not one

  mouseCurlBoost: 0.0,      // extra curl inside the push, as a multiple of the falloff.
                            //   Zero: this and expandCurlBoost between them made the cloud
                            //   visibly change PACE under the pointer, which reads as the
                            //   effect being startled. The cursor may open a hole and grow
                            //   the mass; it may not run the clock faster.
                            //   Keep it low — it scatters motes back into the hole the
                            //   push just made, and over ~3 it closes it completely.

  // ------------------------------------------------------------ sphere shading
  // Each mote is a lit sphere, reconstructed per pixel on its billboard. These are the
  // material: the light it sits under, how glossy it is, and how hollow.
  lightDirX: -0.45,         // in VIEW space — x right, y up, z toward the camera. Keep z
  lightDirY: 0.72,          //   positive or the highlight falls behind the spheres and
  lightDirZ: 0.52,          //   they go flat.
  wrap: 0.38,               // how far light wraps past the terminator. 0 = hard Lambert,
                            //   which leaves half of every sphere black and reads as a
                            //   hole punched in a light page. Above ~0.7 it goes flat.
  shininess: 40.0,          // specular exponent. High = a small tight glint, low = a broad
                            //   sheen. Small and tight is what reads as glass.
  // The sphere rig is dialled almost out for this reference, and that is a look decision
  // rather than a tuning one. Fill, rim and specular all ADD light after the colour
  // pipeline, which is what makes a mote read as a lit glass bead — and it also puts a
  // floor under how dark the mass can ever get. Measured: with the rig at its old settings
  // the densest pixels bottomed out at RGB(172, 125, 125) however much colour and opacity
  // went in, against the reference's (77, 22, 25). Its grains are matte pigment in water,
  // not beads under a studio light.
  specular: 0.04,           // highlight strength. Low on purpose: on motes this small
                            //   a hot glint is the first thing that aliases, and it reads
                            //   as glitter rather than as gloss.
  grainStretch: 1.00,       // how far a grain is drawn out along the throw axis. 1 is a
                            //   circle. This is motion blur standing in for a shutter, so
                            //   it wants to be small — past ~2 they read as dashes
  minPx: 0.55,              // smallest footprint a mote is drawn at, in device pixels.
                            //   Lowered with the grain. The guard inflates anything under it
                            //   and pays for the extra area out of ALPHA, so leaving it high
                            //   while the grain came down would have quietly undone the
                            //   scaling and dimmed the cloud instead of shrinking it.
                            //   Lowered with the grain: the guard inflates anything under
                            //   it, so leaving it at 1.3 would have quietly undone the size
                            //   reduction and taken the alpha with it.
                            //   Under 1 they blink; much over 2 the fine spray blurs.
  specMinPx: 3.0,           // below this on-screen diameter the highlight is switched off
  specFullPx: 9.0,          //   and above it runs at full strength. A tight glint on a
                            //   mote a couple of pixels across cannot be resolved — it
                            //   falls between samples and flickers as the mote drifts,
                            //   which is what reads as sparkle.
  specOpacity: 0.2,         // how much of the highlight survives into ALPHA. The glint has
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
  blob: 0.0,

  fresnelPower: 4.2,        // rim tightness. Low spreads the rim over the whole sphere.
  rim: 0.03,                // rim strength
  fillDirX: 0.55,           // the bounce light, opposite the key and below it
  fillDirY: -0.55,
  fillDirZ: 0.30,
  fill: 0.04,               // strength. Past ~0.5 it starts to read as a second key and
                            //   the form goes ambiguous.
  fillColorR: 0.42,         // cool, to sit against the warm key — the contrast between
  fillColorG: 0.52,         //   the two is doing the work, not either one alone
  fillColorB: 0.72,
  rimColorR: 1.00,          // the rim is the light behind the bubble, so it is close to
  rimColorG: 0.72,          //   white with a warm lean rather than the body colour
  rimColorB: 0.68,
  coreAlpha: 0.60,          // opacity through the middle of a sphere. Low is what makes
                            //   them hollow shells; at 1 they are solid beads. High here
                            //   because the reference's mass is very nearly opaque in its
                            //   folds — its darkest pixels are RGB(77, 22, 25), where a
                            //   cloud of shells over a light wall bottoms out around (188,
                            //   159, 159) however much colour is put into it
  edgeSoftness: 0.06,       // silhouette antialias, in radii. Low: a grain has an edge, and
                            //   a soft one reads as smoke. Too low and the discs step;
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
  // Off. A bloom is a soft glow around the mass, which is exactly the billowing this must
  // not have — and it is seven reduced-resolution fullscreen passes, so it was also a good
  // part of the load and frame cost.
  bloom: false,
  bloomThreshold: 0.011,
  bloomStrength: 0.04,      // above the reference's 0.62 on purpose: theirs glows against
                            //   black, where added light is all there is. Against a light
                            //   page there is nothing to add light TO, so the pass has to
                            //   work by spreading colour instead, and that costs more.
  bloomRadius: 0.32,        // blur spread, in half-res texels per step
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
  densityRadius: 0.013,     // neighbourhood size, as a fraction of viewport height
  deepen: 0.42,             // how far the most crowded motes are taken toward the deep
                            //   colour. 0 is off; 1 makes the core nearly black.
  deepenBias: 0.85,         // curve on the normalised count. Under 1 spreads the effect
                            //   into the mid-densities, over 1 keeps it to the very core.
  deepenSat: 1.25,          // saturation boost as it deepens, so the core goes richer
                            //   rather than merely darker — plain darkening reads as grey

  // ------------------------------------------------------------ colour
  // The spheres are shaded in greyscale and take their colour here, so this is the body
  // colour of the material. Blend modes: 0 multiply, 1 add, 2 overlay, 3 screen.
  // Read off the reference: its thick ink lands on RGB(135, 69, 62) and its deepest folds
  // on RGB(78, 19, 13) — a brick, not a signal red, and warm, with green consistently above
  // blue. The build's own red was a pure hue at high saturation, which came out pink where
  // the reference is earthy.
  // The FIRST reference's palette: thick ink on RGB(135, 69, 62), deepest folds on
  // RGB(78, 19, 13). Warm — green a shade above blue, which is what makes it a terracotta
  // rather than the second clip's wine red. The colour bar rotates the HUE of this and
  // leaves its saturation and value alone.
  colorOverlayR: 0.66,
  colorOverlayG: 0.200,
  colorOverlayB: 0.145,
  colorOverlayBlendMode: 0,
  colorOverlayStrength: 1.0,
  // The three stops of the density ramp. Given as colours rather than as a darkening of one
  // colour because the middle is a different HUE, not a lighter version of the core: pigment
  // scatters warmer as it thins. The hue bar rotates all three together, so the ramp keeps
  // its shape whatever colour the ink is set to.
  // Fringe first, core last. These multiply the shading, so they are the pigment's own
  // colour rather than what lands on screen — thin them over a cream page and the peach end
  // is almost nothing.
  // Lifted and desaturated across the whole ramp. The target is a thin dusting of pigment
  // on cream paper with the engraving showing through it, so even the packed core is a
  // muted brick rather than a signal red — at [0.34, 0.03, 0.02] the core came out pure
  // scarlet the moment the grains overlapped at all.
  ramp: [
    [0.954, 0.366, 0.366],
    [0.954, 0.366, 0.366],
    [0.954, 0.366, 0.366],
    [0.954, 0.366, 0.366],
    [0.954, 0.366, 0.366],
  ],
  rampFringe: 0.16,         // density below which alpha ramps to zero. This is the dial for
                            //   how far the scattered specks reach before they vanish
  alphaGain: 2.60,          // overall presence against the page, applied last. The bloom used
                            //   to provide this as a side effect of lifting the canvas alpha

  saturation: 1.35,
  contrast: 1.10,
  brightness: 0.94,
  minBrightness: 0.0,
  opacity: 0.50,            // overall alpha of the field. Up from 0.72 with the bloom: the
                            //   same motes spread over twice the area stack less deeply, so
                            //   the mass came out a good deal paler than the reference's —
                            //   thick ink at RGB(150, 87, 87) against its (135, 69, 71)

  // How much of the cloud's transparency is spent on FEWER motes rather than on paler ones.
  //
  // Every mote's alpha is built from its shading, its place in its own life and its depth in
  // the volume, so most of the population is drawn part-way transparent — which is what makes
  // the cloud read as washed out rather than as a lot of small solid things. At 1 that alpha
  // stops tinting the mote and starts deciding whether it is there at all: a mote whose alpha
  // would have been 0.3 is drawn at FULL strength three times in ten and not drawn at all the
  // rest, so the cloud thins by losing motes instead of by fading every one of them.
  //
  // The draw is per mote and fixed, so a mote does not flicker — it fades in over its life
  // until it crosses its own threshold, appears at full colour, and goes again on the way
  // down. 0 is the ordinary blended cloud.
  // Tried at 0.65 to force the mass toward the reference's near-opaque core, and reverted:
  // fully opaque grains at this count and size fill in solid, and the folded filaments that
  // are the whole point of the simulation disappear under a flat slab. The core's density is
  // still short of the reference and it is not this that will close it.
  solidity: 0.0,

  // ------------------------------------------------------------ ground blend
  // Where the cloud thins out, its motes take the colour of the surface behind them.
  //
  // The mass is a saturated red standing on a near-neutral wall, and at its edge it breaks
  // into isolated motes — a scatter of high-chroma dots on a low-chroma ground. That
  // contrast is what makes the cloud read as something laid ON the page rather than as
  // part of it, and it is strongest exactly where the cloud is weakest, on the few motes
  // that have nothing around them to belong to. Taking those to the ground colour removes
  // the contrast where it is worst while leaving the packed middle at its own colour. The
  // middle does soften a little, and that is overdraw rather than a leak: the cloud is a
  // translucent stack tens of motes deep, so a neutralised mote drawn in front of a red one
  // dilutes it.
  //
  // The driver is the mote's own crowding, the same number the deepening runs on, so the
  // whole colour ramp is one continuous reading of how much company a mote has: the ground
  // where it stands alone, the body colour where it has some, the deep colour in the packed
  // middle. Crowding is fixed per mote at build time, so none of this flickers as the cloud
  // turns and none of it costs anything per frame.
  //
  // The ground colour is LINEAR, not what a colour picker reads off a screenshot: the
  // renderer encodes to sRGB on output, so the wall that measures 224/255 in a render is
  // 0.748 in the shader. Measured on the wall behind the cloud's own corner, which comes
  // out neutral to three decimals.
  groundR: 0.748,
  groundG: 0.748,
  groundB: 0.748,
  // Off. The ramp's own fringe does this job now, and does it better: it runs the grains out
  // by ALPHA at their own colour, where this took them to the wall's colour first and left a
  // grey scatter behind. Kept as a constant because it is still the right idea on a cloud
  // without a density ramp.
  ground: 0.0,              // how far the loneliest motes are taken toward it. 0 is ver8's
                            //   cloud exactly; 1 makes them the wall and they disappear.
                            //   Low now, and the reason is that the bloom changed what this
                            //   number means: on the tight cloud only the outlying scatter
                            //   was ever counted as fringe, where a bloomed mass has most of
                            //   itself out there. At 0.55 the whole cloud was being taken
                            //   most of the way to the wall and read as a white veil laid
                            //   over the ink rather than as an edge that dissolves
  groundBias: 2.5,          // curve on (1 - crowding), and it needs to be well above 1.
                            //   The crowding histogram is bimodal — half the population
                            //   sits under 0.15 and a quarter is at 0.94 or more — so at a
                            //   gentle curve the median mote still blends most of the way
                            //   and the whole mass goes to a smudge with its grain gone.
                            //   Each step up pulls the blend back onto the outliers
  groundFade: 0.06,         // alpha those same motes also lose. Colour alone leaves the
                            //   fringe as pale but still solid discs, which reads as a
                            //   second, grey cloud around the red one — this is what turns
                            //   the edge into a fade rather than a change of paint. Small:
                            //   past ~0.3 the scatter stops being individual motes

  // ------------------------------------------------------------ the shadow
  // The cloud darkening the wall it floats over. There is no shadow MAP here and there could
  // not be: the wall belongs to another app on another canvas, with its own scene and no
  // depth buffer we can read. This works the only way it can from outside — our canvas
  // composites over theirs, so drawing a blurred, offset, darkened copy of the cloud's own
  // coverage underneath the particles darkens the wall precisely where the cloud covers it.
  //
  // It costs one extra render target and three small fullscreen passes. The particles are
  // still rendered ONCE: the shadow and the cloud are two composites of the same target.
  shadow: true,             // ?shadow=0 turns it off
  shadowOnly: false,        // ?shadowonly=1 — the shadow with the cloud held back, for
                            //   telling "not there" apart from "too faint"
  shadowStrength: 0.55,     // how dark the shadow gets where the cloud is solid
  shadowColor: [0.30, 0.20, 0.19],  // warm, not neutral. A grey shadow on a warm plaster
                                    //   wall reads as dirt; a shadow keeps the surface's hue
  shadowBlur: 2.6,          // spread, in texels of the half-resolution target
  shadowOffsetX: 0.012,     // where the light throws it, in fractions of the frame. The
  shadowOffsetY: -0.016,    //   wall's own key light is overhead, so the cloud throws down
  shadowScale: 0.5,         // resolution of the shadow chain against the canvas. A shadow is
                            //   all low frequency, so half is free quality

  // ------------------------------------------------------------ the wall behind
  // ver20's own numbers, so the two builds show the same surface.
  background: false,        // ver20 draws the wall now; this is the fallback for running
                            //   this page on its own, and ?bg=1 brings it back
  bgTextureStrength: 1.0,   // how much of the plaster shows through the flat base
  bgGradientStrength: 0.17, // the off-centre lift
  bgBrightness: 1.1,        // ver20's whole-scene multiply

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
  // Halved from 0.667. The pairing with the box still holds — the box is a fraction of the
  // size the cloud reaches when open, and this is the trip back — but the fraction is now
  // 0.75 rather than 0.6, so the cloud grows half as far off its resting size.
  expandAmount: 0.34,
  // How near the pointer must come, as fractions of viewport height measured from the
  // cloud's centre. FULL strength anywhere inside expandHoverInner, then fading to
  // nothing at expandHoverRadius.
  //
  // The inner plateau is not a nicety. With the cloud wedged into the corner its centre
  // is the corner, so the pointer can only ever approach from inside the frame and can
  // never get near zero: against a bare falloff from the centre, hovering the particles
  // themselves reached 0.66 of full and the cloud opened to two thirds of where it
  // should. The plateau has to cover the resting cloud's own extent.
  expandHoverInner: 0.063,
  expandHoverRadius: 0.120,
  // Slow, because the complaint about hover was pace rather than reach. The growth is the
  // thing the eye reads as speed — it moves every mote at once — so easing it over nearly
  // three seconds and asking for a third less of it takes the jolt out without taking the
  // response away.
  expandSeconds: 2.80,      // ease in/out. Slower than the ray push on purpose: the
                            //   growth is the slow gesture, the hole is the quick one.
  expandCurlBoost: 0.0,     // extra curl while expanded, as a multiple of curlAmplitude.
                            //   Without it the cloud grows but goes strangely still.
};

// ?p=<n> particle count, ?curl=<n> amplitude, ?push=<n> cursor strength — quick overrides
const numParam = (k, lo, hi) => {
  const v = parseFloat(PARAMS.get(k));
  return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
};
if (numParam('p', 1, 120000) !== null) CONFIG.particleCount = Math.round(numParam('p', 1, 120000));
if (numParam('curl', 0, 5) !== null) CONFIG.curlAmplitude = numParam('curl', 0, 5);
if (numParam('div', 0, 3) !== null) CONFIG.curlDivergence = numParam('div', 0, 3);
if (numParam('px', 0, 1) !== null) { CONFIG.parallaxAmount = numParam('px', 0, 1); CONFIG.parallaxTilt = numParam('px', 0, 1) * 0.4; }
if (numParam('sfs', 0.5, 60) !== null) CONFIG.strandFlowScale = numParam('sfs', 0.5, 60);
if (numParam('ss', 0, 2) !== null) CONFIG.simSpeed = numParam('ss', 0, 2);
if (numParam('sl', 0.2, 120) !== null) CONFIG.simLife = numParam('sl', 0.2, 120);
if (numParam('sfq', 0.5, 60) !== null) CONFIG.simFrequency = numParam('sfq', 0.5, 60);
if (numParam('sfd', 0, 4) !== null) CONFIG.simFieldSpeed = numParam('sfd', 0, 4);
if (numParam('sdv', 0, 3) !== null) CONFIG.simDivergence = numParam('sdv', 0, 3);
if (numParam('sfn', 0, 3) !== null) CONFIG.simFine = numParam('sfn', 0, 3);
if (numParam('slen', 8, 4000) !== null) CONFIG.strandLength = Math.round(numParam('slen', 8, 4000));
if (numParam('sstep', 0.0005, 0.2) !== null) CONFIG.strandStep = numParam('sstep', 0.0005, 0.2);
if (numParam('cf', 0.2, 40) !== null) CONFIG.curlFrequency = numParam('cf', 0.2, 40);
if (numParam('cs', 0, 20) !== null) CONFIG.curlSpeed = numParam('cs', 0, 20);
if (numParam('drift', 0, 3) !== null) CONFIG.lifeDrift = numParam('drift', 0, 3);
if (numParam('lsec', 0.2, 40) !== null) CONFIG.lifeSeconds = numParam('lsec', 0.2, 40);
if (numParam('push', 0, 5) !== null) CONFIG.mouseStrength = numParam('push', 0, 5);
if (numParam('noise', 0, 1) !== null) CONFIG.shapeNoise = numParam('noise', 0, 1);
if (numParam('blob', 0, 1) !== null) CONFIG.blob = numParam('blob', 0, 1);
if (numParam('life', 0, 1) !== null) CONFIG.lifeFraction = numParam('life', 0, 1);
if (numParam('speed', 0, 3) !== null) CONFIG.speed = numParam('speed', 0, 3);
if (numParam('gs', 0.02, 0.8) !== null) CONFIG.bloomRadius = numParam('gs', 0.02, 0.8);
if (numParam('scale', 0.1, 4) !== null) CONFIG.massScale = numParam('scale', 0.1, 4);
if (numParam('x', -0.8, 1.2) !== null) CONFIG.offsetX = numParam('x', -0.8, 1.2);
if (numParam('y', -0.8, 1.2) !== null) CONFIG.offsetY = numParam('y', -0.8, 1.2);
if (numParam('pos', 0, 1) !== null) CONFIG.position = numParam('pos', 0, 1);
if (numParam('react', 0, 2) !== null) CONFIG.expandAmount = numParam('react', 0, 2);
if (numParam('blur', 0, 1) !== null) CONFIG.mouseEdgeBlur = numParam('blur', 0, 1);
if (numParam('op', 0, 1) !== null) CONFIG.opacity = numParam('op', 0, 1);
if (numParam('solid', 0, 1) !== null) CONFIG.solidity = numParam('solid', 0, 1);
if (numParam('ground', 0, 1) !== null) CONFIG.ground = numParam('ground', 0, 1);
if (numParam('gfade', 0, 1) !== null) CONFIG.groundFade = numParam('gfade', 0, 1);
if (PARAMS.get('bg') === '1') {
  CONFIG.background = true;
  // The shadow is the scene's ALPHA, and our own wall quad is opaque across the whole frame.
  // Left on together, the "shadow" would be a full-screen slab. The wall this ships over is
  // ver20's, on its own canvas, which is exactly why the alpha trick works at all.
  CONFIG.shadow = false;
}
if (numParam('strand', 0, 1) !== null) CONFIG.strandFraction = numParam('strand', 0, 1);
if (PARAMS.get('bloom') === '0') CONFIG.bloom = false;
if (PARAMS.get('shadow') === '0') CONFIG.shadow = false;
// ?shadowonly=1 draws the shadow WITHOUT the cloud over it, which is the quickest way to
// settle whether a shadow that cannot be seen is absent or merely too faint.
if (PARAMS.get('shadowonly') === '1') CONFIG.shadowOnly = true;
if (numParam('sh', 0, 3) !== null) CONFIG.shadowStrength = numParam('sh', 0, 3);
if (numParam('hover', 0, 1) !== null) CONFIG.hoverFeel = numParam('hover', 0, 1);
if (numParam('push', 0, 1) !== null) CONFIG.mouseStrength = numParam('push', 0, 1);
if (numParam('reach', 0.005, 0.6) !== null) CONFIG.mouseRadius = numParam('reach', 0.005, 0.6);
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

  // The ground the fringe blends into is the page's, so it moves with the page. The cloud
  // sits in the upper-right corner, which on this ground is the black end of the left-to-
  // right gradient — the blue light rises from the bottom centre and never reaches it.
  CONFIG.groundR = 0.003;
  CONFIG.groundG = 0.010;
  CONFIG.groundB = 0.020;

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
vec3 curlNoise(vec3 position, float frequency, float time, float amplitude, float divergence){
  vec3 sp = position * frequency + vec3(0.0, 0.0, time);

  vec3 gA1 = snoise3dDeriv(sp).xyz;
  vec3 gA2 = snoise3dDeriv(sp + vec3( 17.0, 59.0, 113.0)).xyz;
  vec3 gA3 = snoise3dDeriv(sp + vec3(101.0,  7.0,  23.0)).xyz;

  vec3 curl = vec3(gA3.y - gA2.z,
                   gA1.z - gA3.x,
                   gA2.x - gA1.y);

  // A curl alone can only swirl. It is divergence-free by construction, so the volume it
  // carries is conserved: the field can shear, fold and braid, but no patch of it ever
  // spreads. An ink plume does spread, and the amount is not a detail — measured on the
  // reference, the field's divergence and its vorticity are the same size right through
  // the clip. That is a field which expands as much as it turns, and no amount of curl
  // reaches it.
  //
  // The partner is the GRADIENT of a fourth, decorrelated noise. A gradient is curl-free
  // and purely divergent, so it is the clean complement: at 0 this is the old field, at 1
  // the two are equal and the mix has the reference's balance.
  //
  // The 0.707 is what makes "equal" true. A curl component is the difference of two
  // independent derivative components and so carries twice their variance; a gradient
  // component is one of them. Scaling by 1/sqrt(2) puts the two terms at the same rms.
  vec3 grad = snoise3dDeriv(sp + vec3(41.0, 149.0, 71.0)).xyz;

  // divide by frequency so raising the detail does not also raise the displacement
  return (curl + grad * (divergence * 0.70711)) * (amplitude / max(frequency, 1e-6));
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

// ---------------------------------------------------------------- GLSL: the simulation
// One texel per particle. xyz is its OFFSET from its seat, w is its age in seconds; the
// pass reads that, advances it by one frame of the field, and writes it back to the other
// half of a ping-pong pair. Nothing else in the build holds a position.
//
// The velocity is two octaves of the same curl-plus-gradient field the previous version
// used as a displacement. curlNoise divides by frequency, so the finer octave is
// proportionally slower — which is what turbulence does, and is why the two read as one
// fluid rather than as a coarse motion with a fine one painted over it.
//
// Forward Euler, one step per frame. Higher-order integration buys nothing here: the field
// is smooth and slow, and the eye is judging whether the filaments look like filaments, not
// whether a trajectory closes on itself.
const SIM_FRAG = 'precision highp float;' + GLSL_SNOISE + /* glsl */`
uniform sampler2D tPos;
uniform sampler2D tSeed;      // xyz seat, w this particle's own lifespan in seconds
uniform float uDt;
uniform float uTime;
uniform float uSpeed;
uniform float uFrequency;
uniform float uFieldSpeed;
uniform float uDivergence;
uniform float uFine;
uniform vec3  uLaunchDir;
uniform float uLaunchSpeed;
uniform float uLaunchDecay;
uniform float uBurst;
uniform float uGravity;
uniform vec3  uCloudCentre;
uniform sampler2D tVel;
uniform vec3  uMouseRayOrigin;
uniform vec3  uMouseRayDir;
uniform float uMouseRadius;
uniform float uPush;
uniform float uFalloffPower;
uniform float uMouseEdgeBlur;
uniform float uMouseNoise;
uniform float uMouseNoiseScale;
uniform float uSettle;
uniform float uDrag;
varying vec2 vUv;

vec3 fieldVelocity(vec3 p){
  float t = uTime * uFieldSpeed;
  vec3 v  = curlNoise(p, uFrequency,       t,       1.0,   uDivergence);
  v      += curlNoise(p, uFrequency * 3.1, t * 1.7, uFine, uDivergence);

  // curlNoise divides by frequency so that raising the detail does not also raise the
  // displacement — which is right when it is used as a displacement, and has to be undone
  // here where it is a velocity: multiplying the base frequency back in leaves uSpeed
  // meaning world units per second, and leaves the FINE octave still divided by its own
  // higher frequency, which is the scaling turbulence actually has.
  return v * (uSpeed * uFrequency);
}

// The bloom, and it is the whole of this effect. Measured on the reference: the mass's
// radius DOUBLES over six seconds, fast at first and asymptotically slower — 32 px/s of
// growth at half a second, 8.9 at three, 0.4 at seven — while the whole thing also slides
// left and down. What is left afterwards barely moves at all: the field's own speed falls
// from 2.1% of the mass radius per second to 0.7% and is still falling.
//
// It is keyed off the particle's OWN AGE, not the page clock, and that is the decision that
// makes the effect work rather than merely start well. On the page clock the burst is a
// one-off: it happens, the cloud reaches its size, and then every particle that respawns
// afterwards crawls out on the field alone and the envelope collapses back to whatever the
// field can reach within a lifespan. On the age clock every particle gets its own bloom
// when it is born, so the large envelope is a STEADY STATE — and because the population all
// starts at age zero, the very same mechanism produces one coherent arrival at load.
//
// Radial from the cloud's own centre, plus a constant lean, both decaying together.
vec3 birthImpulse(vec3 p, float age){
  vec3 away = p - uCloudCentre;
  float l = length(away.xy);
  vec3 radial = l > 1e-5 ? vec3(away.xy / l, 0.0) : vec3(0.0);
  return (radial * uBurst + uLaunchDir * uLaunchSpeed) * exp(-age / max(0.05, uLaunchDecay));
}

// The cursor, as a force rather than as a displacement. What it returns is an acceleration
// the velocity then CARRIES, which is the whole difference: a displacement exists only where
// the pointer is and vanishes the instant it leaves, where a force leaves momentum behind.
// Push from the left and then from the right and both are still in the cloud at once,
// because the cloud is holding them in its velocities and not in the pointer's position.
vec3 cursorForce(vec3 p, float shape){
  float rayLen = length(uMouseRayDir);
  if (rayLen < 0.001 || uPush < 0.001) return vec3(0.0);
  vec3 rayDir = uMouseRayDir / rayLen;
  vec3 toP = p - uMouseRayOrigin;
  vec3 delta = toP - rayDir * dot(toP, rayDir);
  float d = length(delta);

  // the ragged rim, in two octaves, so the opening is not a circle
  vec3 np = p * uMouseNoiseScale + vec3(0.0, 0.0, uTime * 0.15);
  float wob = snoise3dDeriv(np).w
            + snoise3dDeriv(np * 2.7 + vec3(31.0, 7.0, 19.0)).w * 0.5;
  float mr = uMouseRadius
           * max(0.05, 1.0 + (shape - 0.5) * 2.0 * uMouseEdgeBlur + wob * uMouseNoise);
  if (d >= mr) return vec3(0.0);

  // same three: radius above, then strength and direction
  float fall = pow(1.0 - d / mr, uFalloffPower);
  fall *= max(0.0, 1.0 + snoise3dDeriv(np * 1.7 + vec3(5.0, 61.0, 13.0)).w * uMouseNoise);
  float bend = snoise3dDeriv(np * 1.3 + vec3(47.0, 3.0, 29.0)).w * uMouseNoise * 1.6;
  float cb = cos(bend), sb = sin(bend);
  vec3 turned = vec3(delta.x * cb - delta.y * sb, delta.x * sb + delta.y * cb, delta.z);
  return (turned / (length(turned) + 1e-4)) * fall * uPush;
}

void main(){
  vec4 seed  = texture2D(tSeed, vUv);
  vec4 state = texture2D(tPos,  vUv);
  vec3 offset = state.xyz;
  float age = state.w + uDt;

  // read the field at the particle's real position, not at its seat, or every particle in
  // a filament would be pushed by the field where it STARTED and the filament would move
  // rigidly instead of stretching
  vec3 here = seed.xyz + offset;
  // Gravity is a constant VELOCITY, not an acceleration. Near zero by design — enough that
  // the mass drifts down and settles instead of hanging in a vacuum — and as a velocity it
  // cannot run away over a long life the way an accumulating one would.
  // Position is the integral of the CARRIED velocity now, not of the field read fresh. That
  // one indirection is what the smoothness is made of.
  offset += texture2D(tVel, vUv).xyz * uDt;

  // Dead: back to the seat, age zero. The seat is the source, so the model's silhouette is
  // what the cloud is continuously fed from rather than what it looks like.
  if (age >= seed.w) { offset = vec3(0.0); age = 0.0; }

  gl_FragColor = vec4(offset, age);
}`;

// The velocity pass. Same preamble as the position pass — the field, the birth impulse and
// the cursor force are all shared — but what it writes is momentum.
//
// Two constants carry the feel. uSettle is how quickly a particle gives up its own velocity
// for the field's: at 1 it has no memory at all and snaps to the field every frame, which is
// what a stateless push feels like and is why it read as plastic. Low values make it heavy,
// so a shove takes seconds to bleed away and the cloud keeps moving after the pointer has
// gone. uDrag is the slow leak that stops shoves accumulating forever.
const SIM_VEL_FRAG = SIM_FRAG.replace('void main(){', 'void mainPos(){').replace(/* glsl */`
  gl_FragColor = vec4(offset, age);
}`, /* glsl */`
  gl_FragColor = vec4(offset, age);
}

void main(){
  vec4 seed  = texture2D(tSeed, vUv);
  vec4 state = texture2D(tPos,  vUv);
  float age  = state.w + uDt;
  vec3 here  = seed.xyz + state.xyz;
  vec3 v     = texture2D(tVel, vUv).xyz;

  vec3 target = fieldVelocity(here) + birthImpulse(here, age) + vec3(0.0, -uGravity, 0.0);
  v += (target - v) * clamp(uSettle, 0.0, 1.0);
  v += cursorForce(here, fract(seed.w * 7.31)) * uDt;
  v *= uDrag;

  // a reborn particle starts still, or it would arrive at its seat carrying whatever it was
  // doing when it died and the seed would visibly squirt
  if (age >= seed.w) v = vec3(0.0);

  gl_FragColor = vec4(v, 0.0);
}`);

// Boot: everything at its seat, age zero, so the first seconds after load are one coherent
// unfurl rather than a cloud that is already halfway through its own churn.
const SIM_INIT_FRAG = /* glsl */`
precision highp float;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); }`;

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
attribute vec2  aSimUv;          // this particle's own texel in the simulation buffer
attribute float aLifeSpan;       // its own birth-to-death, seconds — matches tSeed.w
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
uniform float uMouseEdgeBlur;
uniform float uMouseNoise;
uniform float uMouseNoiseScale;
uniform float uMouseStrength;    // already scaled by the fade
uniform float uFalloffPower;
uniform float uMouseCurlBoost;
uniform float uCurlDivergence;
uniform sampler2D tSimPos;       // xyz offset from the seat, w age in seconds
uniform vec3  uCloudCentre;      // the seat cloud's own centre, for the radial ramp below
uniform float uCloudRadius;
uniform float uParticleSize;
uniform float uViewportPx;       // drawing-buffer height, for on-screen size
uniform float uMinPx;            // smallest footprint a mote may be drawn at
uniform vec2  uGrainAxis;        // the throw axis in screen space, unit length
uniform float uGrainStretch;
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
  // ---- 0. read this particle out of the simulation ---------------------------
  // Its position is not computed here. The sim pass advanced it this frame and every frame
  // before it, and what comes back is where the field has actually carried it since it was
  // born at its seat — the history, which is the only thing a filament can be made of.
  vec4 simState = texture2D(tSimPos, aSimUv);
  vec3 simPos = aInitPos + simState.xyz;

  // Age runs 0 to 1 over this particle's OWN lifespan. Not a shared cycle: a common period
  // makes the whole population die together, and the cloud blinks once per life.
  float lifePhase = clamp(simState.w / max(0.0001, aLifeSpan), 0.0, 1.0);

  // Swell in, hold, shrink away. The hold in the middle is deliberate and is most of the
  // cycle: with grow and fade meeting in the middle every mote is always on its way
  // somewhere and the cloud reads as twinkle rather than as a thing with a body.
  float envelope = smoothstep(0.0, uLifeGrow, lifePhase)
                 * (1.0 - smoothstep(uLifeFadeStart, 1.0, lifePhase));

  // Travel ALONG THE FLOW as it lives, which is the whole correction of this pass. Measured
  // on Ref1, 97.8% of the motion runs along the filaments rather than across them: a crease
  // is a streamline, so its motes stream down it while the line itself stays exactly where
  // it is. Moving them across the thread — which looked like the safe choice, on the theory
  // that moving along would drag the thread with them — is what a fluid never does.
  //
  vec3 pos = simPos;

  // ---- 1b. bloom out of the corner on hover ---------------------------------
  // Applied to the resting seat, before curl and push, so the two cursor responses
  // compose: the cloud grows AND the pointer still opens a hole inside the grown cloud.
  //
  // Scale about the CORNER, not the cloud's own centre — about the centre the near edge
  // advances on the corner and crosses it, which reads as sliding, not spilling.
  float expand = uExpand * uExpandAmount;
  pos = uExpandOrigin + (pos - uExpandOrigin) * (1.0 + expand);

  vFade = envelope;

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
    // this mote's own radius. aShape is already a per-mote random and already travels
    // through the depth sort, so it doubles as the seed; its other use is the outline in the
    // fragment shader, and a mote's outline correlating with its push radius is not
    // something an eye can find.
    // The hole's edge, roughened. The per-mote jitter alone only BLURS it, and a blurred
    // circle is still a circle: every mote decides independently how far it is willing to be
    // pushed, so the boundary stays round on average and the eye finds it. A noise read at
    // the mote's own POSITION makes neighbours agree with each other instead, and that
    // agreement is what turns a fuzzy edge into a ragged one. Drifting in its own z so the
    // ragged edge crawls rather than sitting still.
    // TWO octaves, and the frequency matters more than the amount. At one feature across
    // the whole opening the noise does not roughen the rim, it just makes the circle
    // lopsided — still plainly a circle, only off-centre. The rim needs several lobes around
    // it before the eye stops completing the shape, and a finer octave on top of those to
    // break the lobes themselves.
    // Three things are noised, not one, and that is the difference between a ragged circle
    // and a shape that is not a circle at all:
    //   the RADIUS, so the rim is uneven;
    //   the STRENGTH, so some of the rim is barely pushed and some is shoved hard;
    //   the DIRECTION, bent off radial, so the push is not a star out of one point.
    // Radius alone can only ever give a wobbly circle — every push still points straight
    // out from the same place, and the eye reads that arrangement as round however the
    // boundary is shaped.
    vec3 np = pos * uMouseNoiseScale + vec3(0.0, 0.0, uTime * 0.15);
    float wob = snoise3dDeriv(np).w
              + snoise3dDeriv(np * 2.7 + vec3(31.0, 7.0, 19.0)).w * 0.5;
    float mr = uMouseRadius
             * max(0.05, 1.0 + (aShape - 0.5) * 2.0 * uMouseEdgeBlur + wob * uMouseNoise);
    if (distToRay < mr) {
      pushFalloff = pow(1.0 - distToRay / mr, uFalloffPower);
      pushFalloff *= max(0.0,
        1.0 + snoise3dDeriv(np * 1.7 + vec3(5.0, 61.0, 13.0)).w * uMouseNoise);
      float bend = snoise3dDeriv(np * 1.3 + vec3(47.0, 3.0, 29.0)).w * uMouseNoise * 1.6;
      float cb = cos(bend), sb = sin(bend);
      vec3 turned = vec3(delta.x * cb - delta.y * sb, delta.x * sb + delta.y * cb, delta.z);
      pushDir = turned / (length(turned) + 1e-4);
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

  // The field itself is the simulation's job now. What is left here is the extra churn the
  // cursor and the bloom ask for — a local agitation on top of the carried position, which
  // has to be instantaneous to answer the pointer and so cannot come from the buffer.
  float curlInfluence = aCurlResp * step(0.001, amplification - 1.0);
  if (curlInfluence > 0.0) {
    float ct = uTime * uCurlSpeed * 0.01;
    vec3 curlOffset = curlNoise(vec3(pos.x, pos.y, ct), uCurlFrequency, ct, effectiveCurl,
                                uCurlDivergence);
    pos.x += curlOffset.x * curlInfluence;
    pos.y += curlOffset.y * curlInfluence;
    pos.z += curlOffset.z * 0.1 * curlInfluence;
  }

  // The OLD hover, kept, because it is one end of the dial and cannot be imitated by the
  // new one. This is a bounded DISPLACEMENT: the hole appears the instant the pointer
  // arrives, at a fixed size, and holds. The force in the simulation integrates instead, so
  // its hole keeps opening for as long as you hover and eases shut afterwards — a different
  // behaviour, not a slower version of the same one.
  //
  // uMouseStrength carries (1 - hoverFeel), so at 0 this is the whole effect and the
  // simulation's force is off; at 1 it is silent and the force has it all.
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
  // Constant, and that is the point. This used to be a radial measure, which drove both the
  // colour ramp and the fringe alpha — so the cloud carried a circular gradient and a
  // circular fade no matter what the field was doing underneath, and that reads as a mask
  // laid over the effect.
  //
  // In a flow field there is nothing radial to measure. Every particle is the same colour at
  // the same low opacity, and ALL of the tone comes from how many of them happen to overlap:
  // dense where paths converge, pale where they thin. That is the whole shading model, and
  // it is the one that leaves no contour behind.
  vDensity = 1.0;

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
  // Grains are slightly elongated ALONG the throw axis — the smear a moving particle leaves
  // in a photograph. Area-preserving: one axis is multiplied and the other divided, so
  // stretching a grain does not also make it heavier.
  vec2 q = position.xy;
  float alongQ = dot(q, uGrainAxis);
  vec2 qs = uGrainAxis * (alongQ * uGrainStretch)
          + (q - uGrainAxis * alongQ) / max(0.2, uGrainStretch);
  mv.xy += qs * worldSize;
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
uniform vec3  uRamp0;            // faint peach, the last thing before nothing
uniform vec3  uRamp1;            // dusty salmon
uniform vec3  uRamp2;            // coral
uniform vec3  uRamp3;            // terracotta
uniform vec3  uRamp4;            // dark brick, the packed core
uniform float uRampFringe;
uniform float uAlphaGain;
uniform float uColorOverlayBlendMode;
uniform float uColorOverlayStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uBrightness;
uniform float uMinBrightness;
uniform float uOpacity;
uniform float uSolidity;
uniform vec3  uGroundColor;
uniform float uGround;
uniform float uGroundBias;
uniform float uGroundFade;

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

  // Density to colour, five stops. Hue and value BOTH shift with concentration, which is
  // the point: the deepest zones are a dark brick, and stepping outward they go terracotta,
  // coral, dusty salmon, faint peach, then nothing. The core is redder and darker, the
  // fringe pinker and lighter. Tie this to lifetime instead of density and the fringe never
  // pinkens, because a young grain in the core and an old one at the edge share an age.
  //
  // The last step out is carried by ALPHA rather than by a paler colour: a grain drawn pale
  // on a light wall is a GREY grain, and a scatter of grey specks reads as dirt on the page.
  float dens = pow(clamp(vDensity, 0.0, 1.0), uDeepenBias);
  float t = clamp(dens, 0.0, 1.0) * 4.0;
  vec3 body = mix(uRamp0, uRamp1, clamp(t, 0.0, 1.0));
  body = mix(body, uRamp2, clamp(t - 1.0, 0.0, 1.0));
  body = mix(body, uRamp3, clamp(t - 2.0, 0.0, 1.0));
  body = mix(body, uRamp4, clamp(t - 3.0, 0.0, 1.0));

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

  // How alone this mote is: 1 out in the scatter, 0 in the packed middle.
  float lone = pow(clamp(1.0 - vDensity, 0.0, 1.0), uGroundBias);

  // Ground blend, applied to the FINISHED colour rather than to the body colour, and the
  // difference is the whole point. Mixed into the body it is a tint that the rim and the
  // highlight are then added on top of, so a fringe mote comes out a pale bead wearing a
  // bright outline — more conspicuous against the wall than the red one was. Mixed in last
  // it takes the mote entire, shading included, and the mote goes to the wall as an object.
  mixed = mix(mixed, uGroundColor, lone * uGround);

  // Hollow shell: thin through the middle, dense at the rim. The smoothstep is the
  // antialias on the silhouette — with no texture there is no filtering doing it for us,
  // and without it the discs have visibly stepped edges.
  float shell = mix(uCoreAlpha, 1.0, fres);
  float edge = smoothstep(1.0, 1.0 - uEdgeSoftness, r);
  float alpha = shell * edge * vBrightness * vFade * uOpacity * vAlphaScale
              * (1.0 - uDepthFade * vDepth);
  alpha = min(1.0, alpha + spec * uSpecOpacity);   // the highlight carries its own opacity
  alpha *= 1.0 - lone * uGroundFade;               // the fringe thins as it neutralises
  alpha *= smoothstep(0.0, uRampFringe, dens);     // and the ramp's own fringe runs out

  // Overall presence against the page. This exists because the bloom used to supply it as a
  // side effect: its composite lifted the canvas's own ALPHA, not just its colour, and with
  // the pass turned off the cloud went almost invisible — a hundredfold drop in drawn pixels
  // from a change that was supposed to be about softness. Better to state the gain than to
  // keep a seven-pass blur running for something it was never named after.
  alpha = min(1.0, alpha * uAlphaGain);

  // Spend that transparency on the population instead of on the paint. The threshold is the
  // mote's OWN number, decorrelated from the seed its outline uses so the two do not agree,
  // and it does not change from frame to frame — so a mote crosses it once on the way up and
  // once on the way down rather than flickering across it.
  if (uSolidity > 0.0) {
    float draw = step(fract(vShape * 91.7), alpha);
    alpha = mix(alpha, draw, uSolidity);
  }
  if (alpha < 0.004) discard;                      // nothing left to blend

  gl_FragColor = vec4(mixed, alpha);
}
`;

// ---------------------------------------------------------------- the wall
// The background from immersiveg/ver20, carried over so the cloud can be judged against the
// surface it will actually sit on rather than against a flat swatch. Verbatim: the same flat
// base, the same plaster texture on the green channel, the same off-centre gradient and the
// same 0.6/0.4 lift at the end.
//
// It is a full-screen quad drawn before everything with depth off, not a page background,
// because it has to be inside the frame the bloom composites — a wall painted underneath the
// canvas by CSS would sit under the glow instead of behind it.
//
// This is the one thing that makes the build stop being a transparent overlay. ?bg=0 turns it
// off and hands the page back its own background.
const BG_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`;

const BG_FRAG = /* glsl */`
precision highp float;
#define PI 3.141592653589793
varying vec2 vUv;
uniform float uGradientStrength;
uniform sampler2D tPlaster;
uniform float uTextureStrength;
uniform float uBgBrightness;
highp float rand(const in vec2 uv){
  const highp float a = 12.9898, b = 78.233, c = 43758.5453;
  highp float dt = dot(uv.xy, vec2(a, b)), sn = mod(dt, PI);
  return fract(sin(sn) * c);
}
void main(){
  vec3 color = vec3(0.54504);
  float plaster = texture2D(tPlaster, vUv).g;
  color = mix(color, color * plaster, uTextureStrength);
  // the noise on the lookup is what keeps the gradient from banding on a flat wall
  vec2 uv = vUv + rand(vUv) * 0.01;
  float gradient = mix(1.0, 0.5, length(uv - vec2(0.0, 0.8)));
  color += gradient * 0.7 * uGradientStrength;
  color = (color * 0.6 + 0.4) * uBgBrightness;
  gl_FragColor = vec4(color, 1.0);
}`;

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

if (CONFIG.background) {
  const tPlaster = new THREE.TextureLoader().load('./assets/plaster.jpg');
  tPlaster.wrapS = tPlaster.wrapT = THREE.RepeatWrapping;
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      uniforms: {
        tPlaster: { value: tPlaster },
        uTextureStrength: { value: CONFIG.bgTextureStrength },
        uGradientStrength: { value: CONFIG.bgGradientStrength },
        uBgBrightness: { value: CONFIG.bgBrightness },
      },
      depthWrite: false,
      depthTest: false,
    })
  );
  wall.renderOrder = -1;         // before the motes, and it writes no depth
  wall.frustumCulled = false;
  scene.add(wall);
}

// The world height the camera sees at the cloud's depth. Every size and placement below
// is expressed against this, so the cloud holds its share of the frame on any window.
const viewHeightAt = (z) =>
  2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.abs(camera.position.z - z);

// ---------------------------------------------------------------- shape noise
// A small 3D value noise, used only on the CPU when seats are drawn. It does not need the
// quality of the simplex noise in the shader — it is sampled a few times per mote at
// startup and never again, and all it has to do is vary smoothly.
// +1/-1 per axis for the chosen corner: x is +1 on the right, y is +1 at the top.
const cornerSigns = () => ({
  x: CONFIG.corner.indexOf('l') >= 0 ? -1 : 1,
  y: CONFIG.corner.indexOf('b') >= 0 ? -1 : 1,
});

const hash3 = (x, y, z) => {
  const t = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return t - Math.floor(t);
};
const smoothT = (t) => t * t * (3 - 2 * t);
const mix01 = (a, b, t) => a + (b - a) * t;

// The spawn field's shape, fixed rather than exposed: these are the standard fBm numbers and
// nothing here is improved by moving them. The dials that matter are scale, warp and the
// threshold, which are in CONFIG.
const FBM_OCTAVES = 6;
const FBM_LACUNARITY = 2.0;
const FBM_GAIN = 0.5;
// Box-Muller, two at a time, with the spare kept for the next call.
let gaussSpare = null;
function gauss1() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  const r = Math.sqrt(-2 * Math.log(1 - Math.random()));
  const t = 2 * Math.PI * Math.random();
  gaussSpare = r * Math.sin(t);
  return r * Math.cos(t);
}

// fBm at the spec's numbers: six octaves, lacunarity 2, gain 0.5. Normalised by the sum of
// the amplitudes so the result stays 0..1 whatever the octave count.
function fbm3(x, y, z, octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq);
    norm += amp;
    freq *= FBM_LACUNARITY;
    amp *= FBM_GAIN;
  }
  return sum / norm;
}

// The domain warp is what stops the field looking like noise. Displacing the lookup by
// another fBm before reading it drags the level sets into torn, stringy, hooked shapes —
// which is what a powder actually breaks into. Without it the same threshold gives round
// blobs with round holes, and the edge fragments into dots rather than into specks and
// filaments.
function warpedFbm(x, y, z, warp) {
  const wx = fbm3(x + 17.1, y + 3.7, z + 8.9, 4) - 0.5;
  const wy = fbm3(x + 5.2, y + 41.3, z + 2.4, 4) - 0.5;
  const wz = fbm3(x + 29.6, y + 13.8, z + 33.1, 4) - 0.5;
  return fbm3(x + wx * warp, y + wy * warp, z + wz * warp, FBM_OCTAVES);
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
  '/4OWv36OE78+w6W/GbQdQKOAkD+JGSdAmAoAFQ/Sq+2zCszNZ+B+CovJaNYWDpzIxtgyFP/K0eS0GaHQ3PQ9GATUJ/tuE67U' +
  'rfgnDkHVkebmCrHQ4tjMCjbMvM15DhfLf84/FcPOVdwCGkvUR+wUGeDXEvRJFJjYqfJsDtvXluC3CuXSd9KdCjfOxsVzDgDO' +
  'TcaUFWfShdMEGtzX6uJIGYHbiey5FMbbU+x9DinaH9tQCtjUjsw/CqfQJsCADunQXL95FZ7VW8vAGdHa2NmsGEfeNeSdFG3e' +
  '8+VlDivc7tXvCZzWI8fMCbDSULpIDoPT5rgrFVrYecOrGX7d/tErGHrgDtwxFBXgAN5+Dvbd+tCTCVzYTsKMCbXUQLUBDsbV' +
  'xrLDFM7aarxTGfffIsvMF1bintSfE8HhN9dVDoffxMuTCfrZw703CW/WR7CYDevXmK02FAbdebabGC/iBMVnFzPkfM4VE3vj' +
  'q9H2DfzgzsaJCXzbgbnXCMrXN6sODX3Z16fRE/neV7HLFzvknr8ZF+/lLcmNEvzkccyRDVjiH8J0CfHci7WFCAjZlKaCDLPa' +
  'B6KCE5/gLKxwFyrm4br2FoPngcQHEivmFcdBDZ/j2b1FCV7e1rFICHja6qIWDMfb0ZwxExHijqceF9nnrLbFFuroUcCHEU7n' +
  'XsLnDM3ko7k0CdzfaK5ECKvbRJ+iC63c95fuElPjd6PbFkPp9bJ/FiTqh7wOEWvoTb6FDOvlwbUYCSDhFasHCIrcZJsfC6Td' +
  'NpSbEmTkr5/JFnDqu68zFkbrOrmlEHrprbomDPrmRbLkCEPi4Ke0B4bdHpi4ClXea5BqEk/lxJyQFoXrCa0WFmLsfrZVEGfq' +
  'LrfYCwDoH6+fCEvjwKRSB6LeZ5VuCibfzY0nEg/mTJpxFn3s3qojFlLt+LMPEE/rFrSPCwDpPaxLCEzkrqH4BoHfdJIgCuDf' +
  'pYvxEaTmSphqFh7tEan7FTzu7rHhDzrsa7FKC/7pfqn3Bz7lk56UBlngoI/hCXLgsYnREQ3nwZZ7FoTtqKfDFQnvLLDCDynt' +
  'G68KCwDr1aagByvmWpsqBjHh8Iy1Cdjg7IfIEUvnzJWPFsztuaapFcPvvq62Dwbu06zfChXsRqQyBz/nN5gSBufhAYqOCULh' +
  '04a7EWXnfJWNFvXtS6aqFV3whK20D9/uqqrDCj7tlaHPBl/oEZUjBqriN4eCCaXhOIauEVXnoZWTFvbtUKauFdPwbay5D5zv' +
  'YKjFCk/ue57qBnrprpEwBlnjNYSGCe7h0oWpEWPmJZPnFbXuCagfFTfxmqvJD1HwI6beCknvTptYB5XqAI5CBhzkZ4GvCRXi' +
  'gYWtEQLmYpBjEl/vWqhiEoHx4KrbD/jw76MQC0jwRpjRB7brAYpkBtjkmn71CS7iVYWyEQbmc5BlElTvX6hiEr3xTqryD6Dx' +
  '6qFVC17xX5VACNvsIYbKBpjlC3xgCjziM4W4EQLmlpBiEj7vdqheEvTx4akQEE/yIKCsC2fyoZLXCPHtMYOnB2Dm9HnxClbi' +
  'I4W9EQHmvJBgEijviqhYEiryjak1EAHzj54UDEfzMpCgCe3uQ4CHCB3nMXidC3/iEYXHEQPmxZBhEhrvjqhVEl/yPqliELrz' +
  'PZ2MDAz0EY5/CtbvNH1gCc7nzXZdDK7i5YTgEYrkyJigFA/tPqwIFJDyz6iYEG70GZwUDcH0MoxkC57w3XpkCmjok3UnDd7i' +
  'l4QNEgLldpwAFQrsj6tbFMDySqjcEBT1FJutDWz1iIpNDDzxaHmKC+3odHT6DRTjOIRPEvLknJztFALst6tWFPzy76c1EcL1' +
  'RZpQDvD1LolHDcTxH3iqDG7ptXPYDmXj5YOkEurkn5z7FAXsz6tvFEXzzKekEYn2upn6DpD20YczDkXyrXa8Ddjp3XK5D7jj' +
  'iIMQE+Pkj5wrFRDs7KuoFJLzuqclEhf3Dpm7DyP3mYYoD7nyVHXODjHq+XGhEAXkHoOUE/nkUZxxFR3sJKwAFePzw6e4Es73' +
  'rJiAEK33f4UlECnz6nPfD3rqAnGQEVHksoIuFBTlB5zUFSbsnKx5FUj0QKhhE0H4GphaES74gIQqEZLzkXL0ELrqDHCIEoXk' +
  'L4LfFDblsZtSFhns0a0ZFqX0oKgaFKv4lJdBErL4i4M2EubztHEYEvfqL2+KE6DkmIGnFVLlYpvsFhnssK7EFuL0T6jeFAL5' +
  'DZc1E0P5kIJHEzj01HBBEz3rq26YFN7kLIF9FnPlDpudF0fsMK5rF0X15qi5FYD5wZYxFMz5qoFkFIz0zW9tFI3rjG6yFSHl' +
  'y4BlF67lnppgGGTsP64zGJ/1WKmkFj36xJYyFTv67oCSFcb0f2+tFcfrAm7WFqHlsoBXGOrlMJo5GaPsVa0CGf/186mfFwL7' +
  '3JZCFo/6W4DOFgn15G7wFvDrM20EGBTmkYBdGTDmuJkmGtfsyqztGWL2s6qrGEz7gJZrF/L6vH8TGFL1Cm47GCns02xAGZDm' +
  'gYByGoTmNJkkGwntUaztGpz2jKrGGXb7DZakGHL7AH9hGaX122yNGV7sdmyIGurmVoCbGwjneJgwHGLtvKr2G8j2GKrwGsD7' +
  'xZXoGff7Q367GvX1xGvtGojs5mvdGz7nK4DUHHDn45dUHZLtW6ofHdT2+KgsHA38ipU7G3T8lX0lHEL2uGpaHJXsvGo+HXHn' +
  '5n8gHqHnl5eQHs3tqalYHsf2SKd4HWT8YJWbHBb9vXyZHZL2iGnTHbLsAmqtHmvnbX9+H53nkJfkH+vtyKmpH+D2h6bXHsX8' +
  'SZULHp/9CXwfH+T2R2haH87sVWkqIBjnrX7xIFPn45dOIfztTKoOIRf3iKZIIEn9XZWIHxX+bnu3ID73v2buILvsome1IRjm' +
  'QX17Ijjn/5fCIg/utaqDIlj3zqbJIRf+w5URIZP+zHpdIov3jWWUIo/scGVNI8HlinwIJAvnM5hHJCju6KoHJKD3TadcI4j+' +
  '0JWxIm7/tnkOJOj31GNFJEvsvWL0JKblF3yfJY7mzZjgJVfubqqZJc/3SqcAJQn/9ZViJNr/LXnZJWP4NGEDJins6GCpJnPl' +
  'kXtFJxHmZpmGJ3fuVao9JwH4a6e1Jrv/UpYiJv//+ni4J3v4TWHdJ97rOF5rKF7lMXv4KFjmCpkuKZ/u7KnxKBb496Z7KP//' +
  'RZb5J6z/XXmvKYH41GHHKVLsF2A9KjPlwnq5Kr7mhpjkKubuiqizKhL4BqZTKq7/qJXnKZ//ZXmxK3n4p2LBK6HsNGEcLPPk' +
  'Q3qHLGjm6ZizLOTuJ6mNLAj4DaU9LET/+JTmK5n/X3nELXj4HWPJLaDslmAKLjvlVnpgLj/mEpmNLiLvxqdxLvj3D6Q3LgH/' +
  'eZT0LX3/b3npL4P4FmPgL67sdWAGMNrkxnlJMGblEZp4MCvvxadqMPP3eaNEMJ/+4pMUMFT/iXkfMnD4t2MIMjztcmMUMjXl' +
  '/Hk+MivlRJpsMhfvb6h1MvD3HKNjMnb+jZNFMqX/AHlnNGr4wGM/NETth2MuNEDl6HlBNBflPpptNBHveKiPNOv34KKUNH7+' +
  'c5OJNGn/HnnCNmb4dGOINsjsvWBSNvjljnpWNhnlEpp7NiTvjqe4Ns73SqLXNkb+IpPfNvT+dHkuOWD48GLhOA/ts2KNOFHm' +
  '23p6OKPm8ZehOEvvw6XzOIb39KApORP+45JIOSf+KnqpO873FWZLO8TteGfiOsrmVXuwOvrnAJbeOnzvWqM/Oxb38p6LO5r9' +
  'ZpLBOz798XoxPj73ymjFPSLuhmpFPafnP3z/PL/otpQtPa/vhqCfPan2V53/PYn8X5FDPon8YXvMQMP2e2pOQHjuvW28P5Po' +
  'Rn1lPzPpvZONP63vxp4RQE/2e5yGQOH7z5DcQM37w3t4Q0H23mvnQpDu3G9BQnTpT37jQYjp15IAQpLvSp2UQvP1ApwhQzv7' +
  'UpCHQyj77Xs4RqT1d22QRVjuinDSRHXphH5iRLPpDJKERETvt5woRXT1IZvMRZP64o9FRlj6L3wHSe30NW9JSAnuI3FyRzXp' +
  'in7uRiXqyZAnR+HuLpzNR+r0d5qJSJv5NY8MSRb53nzaS1H0fm8WS3vtwHAdSh3pyX6TSRjqCJDTSXbuJ5uFSi30KZlTS4D4' +
  'd47hSyT4A33KTs3zTW76Td7sknDZTPXoDX9NTK3pmY+ITPvt4ZlPTV7z/ZcvTon39I3OTqv3X3zlUUPzZ2zzUCTsVXCkT3Po' +
  'Cn8OT+rodo9DT0DtppknUIzybZciUb32to3ZUU73Y3sjVbTys2kFVB7r9W5zUnvnpn7OUeznco8IUljszJkOU6rxMpcqVNb1' +
  'do34VE72A3tfWIvxeWoXVyfqrm5eVUDmFX6SVArnG4/pVFnrp5kHVrDwNZdHV4z07owcWJv0VHuKWz/wKWs5WtnoEW1HWF7k' +
  '8Xw9V5zlSI+/V0/qs5gWWafvwZd/WijzZ4xRW27yCnyqXoruwm1eXZrnv2xQWynjnXwsWn3k0I7CWivpS5c6XDruzZa2XZXx' +
  '0YuVXk/waXzjYdLsJW+ZYD/msmxvXvfhbXw5XY7j043yXfHnOpV1X1Lsz5PdYJjv7orTYRjuonwsZfLqU3DjY97kmG2vYUng' +
  '23s8YHHiyYw4YZXmtpLGYj/qx5AOZD3tyYkJZcXrsXyGaN/ogHE8Z6zj9XAzZdDfvnzcYwLh3ouKZAHlTJApZhHoN45TZ8Xq' +
  'q4hNaFzpiXz1a5Lm1HKgaiviqnPFaGLf332/Z83fQ4odaBXj8o6UaeTl8oy9anbo4IfAaw7n2XuTbwLkiHQMbkPgHHVWbBfe' +
  'QH5+a1beoYjIa+vgvY0ObZTjKYxBbgHmGIdIb1HkZnsnc07hhHWMcfzdgnXmb/Pb330Lb8HcuIacb8TeeYqtcPrg04rIcZDj' +
  'hIb8cq/hWnrwdoveAXUmdWzbhnV/c4HZWH2ickzaqYU6cy7cvYhMdCbeb4lcdaHgkIWadrjeW3m7et7boHHueFLYNnPwdt/V' +
  'oHu5dTjXGoW1djbZIYjqdxjbB4j9eKHduoRdel3bf3h8ftzY5G66fM7UXm9Eei3SAHrseLLTy4QdevXVxoeRewfYV4jYfIfa' +
  '94NCfqfYFXbOgrvV9mqegPrQu2qIfT/OQ3ggfLzPuYRsfTrSUokpf8XUBonNgCnXF4MwgvnVCXNih8fSO2O7hCDNh2f7gBrK' +
  'bXZYf3rLsIS0gDHOX4vCgonR7YsRhdXUsoMWh1/TRG9BjAjPMmCjiBvJrmSAhOPFq3Sugs3G5YTcg8rJe45ShirO1o+GibzS' +
  '14R6jBrQC2zpkAbLWF2MjAPF72IuiHrB0nIMhpTBmIXHhhXFNZLeiYvK2JMSjgnQeYW9kX7Lq2rLlMrGi1p1kMTApWHzi0S9' +
  'X3HDiei83oQ3iizAs5VvjZXG7JaRkujLcoQXliLHYGj+mD3CwFhQlCy81F6Oj3m4TG8tjci3fIR3jVS7ppYjkdfBo5Rulu3G' +
  'boLjmbzBjmeCnFS9f1gTmHi3e1w9kyuzoWxGkGqyGISrkJG2DZX4lPO8dZJRmnDBzX9UnUa8fWYLoEi4DljUm4iyJ1nOlvit' +
  'KGqZk/usY4Pvk5Gx85PGmLW3Ao7onfu7Pn3hoC63YWTro2Sz+FSwn1GtEFQkmmyoPGezllynoIIpl5GsbpGknH2y2YqqobO2' +
  '6nqopJqy9GBDqJ2u80+eoyWoOVClnRmjnGQemoOi/n8bmwWniJJQoI+tuIv8pa+x63jAqMqtt11urNqpJEqMp++in0wxoced' +
  '8mGgnWSccX8ZnqihAZEcpKiow41/qo6tGnjMrYqoG1s8sBylxEN4q5KdpEeMpHWYNF81oUqXlXz/oUqcxI7sp5ujxY7irk2o' +
  'mHW4scGjbldktJ+fgkMRr3yYFUZrqIyShFs4pCeSgnnqpRKXxorPq+6daog1su6iw3J+tQ+eY1XCt1maU0G7soqTX0aXrH2N' +
  '4VgqqMKMrXaoqfKRu4W6r2SYWIO3tTSdO2/XuNWXRFSmuj+UuEUbtpiOg0bJsM+ImFaJrNiHtnLPrUCMN4Vysw2TLICGuW+X' +
  'aWsTvHOSclEuvuWOHUS9uYCJWkSutPOD2FO6sFSCuW99seqGxoFLt8aNCH1dvRyS+me3vyKOnEx8wk2KAj2WvR+Ekz3nt6J+' +
  'NFBstCh98GtytYOBAH8hu4SIJXkewSmNzWSrwwyLlUWdxwaGKTR7wZR+dDOouv13bUq8tp92g2piuOx7yn3vvoGDc3dBxUSJ' +
  '02KhyOKGoUDSy/OBlSpixVV5FizjvWBy1kUgupJwCmi6uyp27n28wrN+Sneuyb6Eql/UzDCBZT7fzkp92yUjyUt0PSZrwX5t' +
  '/EE+vi9rSGSTv49xWnbRxsZ55nOozXV/Hlso0Oh7bjsy0k147CPWzLZvcCXQxeVn0zydwX5o81s5xV9tq2z3yoJ0/mmp0AV6' +
  'D1ZH0+R29zez1SJzdCOP0GBriSaVypRkgjocxzpkcVavyT9pjmMXz3tvjGHy0yZ1fFHm1stxcjRA2dVtuCNb1MdmiCKZzv1g' +
  'hjcmzCBhUE+4zhtljVsp06pqklqA18Rv+ksR2m5sGDHH3P5ohiBN2Fti9yAE03ZdkDQc0Tpdtkkc05BgmFYg1+VlHFQn2+1q' +
  'N0fc3RNngC1u4F9kNxtQ3Nxd9B5U1xlZhTA21QtZrUQ+17NcOE0j2wFhwUyk3i5lUEHo4EBhbyrg49BeCBsx4ElZdh2n23VV' +
  'sy0A2mJVyD6u20lY5EYF3wlcKUYy4s1fMTxv5K9c0iRb6MZZ5xUm5ERUJxhB31lQMClU3flP3jvd3jpTBUS14hhX+kIz5ilb' +
  'jTjt6ApZsxzq7dpUjg0o6OpOvBGE4lpK4yOo3zlKqjms4ZxNEUQm5hNSCkOY6kZXrzat7ntTRBdi8kZP3gYG7EdJAgyw5axE' +
  'pR9T4hZFLTbz5OtHRkNu6a5MPkPZ7mhSWDTx8+VMHxNJ9iFJ4QC+7xlD0wM36Eo/oxyR5ZQ/GDMA6JhCxDzK7JVGIz8q8gtL' +
  'RS949qpEoBJ2+NlB4gHk8gY9tAUt7Hw5CxrG6Nk5sC8t6588zDfw7+U/lDjI9JtDECsJ+f48WBHe+qI6sQHS9Zs2CQfL7/oz' +
  '8xgE7Ro0hCu27i429DTO8hk56zNn9xU8SSct++Y1Sw+P/a4zAACa+NEvAwIK8gotxxWo7pstyikZ8agvwTNg9YcyoDJH+g41' +
  'miSk/YguZA8r/5IsUwPO+kYpGwGw9LImMRRV8eomzygj8wgpuDO29/ArwTDD/EQujSL//+ZaXOxxYhpeW9wjYuthgNZLXrJj' +
  'hNwxWmpjGeiJVxFhv/b/Vg5d//84WmdaV/syX8ZXaehMYQ5bodfyYOJeHdLWXJ1gPti1WFhg0+MLVgFeQfKnVStaSPvaWGJX' +
  'qvfaXXdUz+R9YPJXF9PKX9hbhMyDW5FdMtMXV11dZ98wVN9ade4PVP5WsPhYVyhU8vS0XINRBeEYX9tUq88+XqpYa8czWt9a' +
  'gMw5VZxaytrVUbBXdestUqBTz/bOVfRQ2/GEW4dONN2eXahRI8zQXGtVO8LzWP1XCMZsU29XY9bqT15UeuhTUCNQ/PRMVJNN' +
  'Cu9oWoBLVNkQXGhO/chHW+tR476ZVyRUE8NEUqpTZtLSTtlQm+ToTqBMP/LpUhlKNexUWTRIk9XTWghLUsUHWlZO0btIVk5Q' +
  '878lUZ1Pps4qTjRNY+CxTRBJ6O6dUdhGA+gQWLpE5NHTWZZHZ8HxWNdKlbcjVZpMKLz4T8VLsMosTWpJKNv9TMdF2OezUKZD' +
  'DeO3VjdBIs7YWB1Eg73kV0VH3LMEVLxI+rj6TtJHy8ZnTJpFFdZCTD5CdOKtTwNAk9+wVa49SMrmV5xAHbkfV/VD2q0sU7lE' +
  'eLYvTtVD6MLJS8xBUNFsS5k+kt2oTl88xNurVBs6XcYUVx89grR/VoZAP6lFUiNBIbInTQpAwL7pSgY+Es1aStg6PtmhTck4' +
  'adejU2k2gMKZVrA5zq/zVT09/6OBUbw9Iq0ZTGs8U7rXSUg6Zsn+SMw2EtdvTPk02tPUUrsyib4+VlY2MKtjVQ86r57QUIU6' +
  'p6cNS/U4p7WmSJM2/MV5R6QyZNU4S/QwCdE9UkAvMrqiVRUzyaa2VPE215klUJs3ZaH0Sa81ubBUR+kyUsIIRpcuq9IiSjUt' +
  '5cyDUf4rbrW8VPQvr6FoVB80F5SiT+c0/ZrqSKoygKvSRVYvSb69RNEqGM5DSZ0pFcjCUO0oTLCrU/Us4JzsU7UxMY1ST4wy' +
  'KZTgRxwwxaW9Q+IrX7pSQ3Und8ekSJEmPMG9Tz0mkKoRUhcqTpg/Uw0v+ojATkAwPY4LR1gtrKC5QqQoTrV/QhEks8HvR8wj' +
  'ubmtTocj3KTfUFknHpRCUlUsBIYNTsEtGoqQRtYqppvPQaAlQLClQRAgbr/HRqEg8bP7TdUgH58BUL4kB5AUUW8piYQlTaYr' +
  'xIUORpko1JYMQeoi0qoFQZEdyLZlRh4ec6wETX4e/pjQTkoiDYyrT8gmhoJETCcpcoPnRXsmeZLBQJ0gRaQdQRwcYatmRvQb' +
  'kqT9S18cs5KaTRog+4a8TpgkU39/S9EmUoHCRVAkn44dQaEeRZ71QDcaTaPuRcoZSZ0LS3MaR4xrTB0eLoJxTeIiQXvMSvkk' +
  'tH56RX0i6IpYQQUdM5j0QIkYxZtTRfIX2JUASr0YtoU1S2gc13w+TGUhSXcCSpwj3nsURVMhcYcNQcAbXpLpQGsX1pO6RHoW' +
  'To7TSDsX9H70SQAb5nYaSzwgJHMnSaoiDXmXRHYgbYS9QMoaIY2jQHMWz4zlQ5sVoYZzRwcWA3iESO0ZmnDYSTkfVW8aSA4i' +
  'Z3YLRNQfxoFpQB0agIghQLgVaYbYQugUgn/5RTIV/nDZRjoZAWpsSKYeK2v3Rqgh53NsQ3gfbn/0P7UZTIRvP0kVf4CWQTQU' +
  '8nhaRMQUBmrwRPUYomOwRkweOmeYRWAhYXGsQkUfGX1hP40ZdYCDPjcV9HoiQMwTsXJ/Qq0UDGPTQiMZK13NREYeVmMARFch' +
  'qG60QU0frXqUPqoZ+HxOPWQVBHZoPuATzGxnQJUVyV1PQMoZhVkyQq8eYl84Qo4htGt0QGsfmHeLPRIal3nWO+oVdHFzPKUU' +
  'bWclPvcWYVmuPdUaslZ0P3IfoVsvQAAihWjdPuAfPnQmPNMaOXYYOuIWD21POusVoGLBO+wYPFbxOj4cWlSdPC4g5VidPagi' +
  'IGXhPMAgznBiOvQbyHIUODQYCWnqN20XNV4oOR0bN1MhOAYeK1KxOVAhW1bJOogjiWF7OisiwW1IOH8doW/ANdkZc2U6NTkZ' +
  'FFpXNn0d3U8uNTEgvk+yNv0iwVPRNzMlO17pN+QjPmrgNXkffGwsM84bUmI9MlobNFZNMx8gNkwPMsQiEE2cMzIlIVG5NPwm' +
  'v1rpNAYmlmYwM+MheGlbMCgefl8CL7cdblL7LykjxkjKLsMlKUpuMPInc06MMXEpklfJMdIoCGRQMLUkpmc5LdUgIV19K4Ag' +
  '3U55LIsmOEVfKy8p0kYyLUErrEtaLpss0VSnLs4rY2AvLfonkWX4KdsjKVu5J7ojhUvRKD8qZUHSJwgtIkPsKSovp0hAK28w' +
  'hlKWK5Avt14MKrYromKzJkMngFnHI/km7UfBJDMu3jwiJFUx2z3IJoYzp0UvKN80s1CnKM0z2V3mJrsvjmIVI3ErSFcVIKQq' +
  'ekSTIDoylDY+IPw1xjiiI6o40EGdJYk59k6pJRg4ZVuWI0g0FF/MH+Yve1VBHJ8uDkFAHDY3PTS4HPI67DOHIBA+KT4iI34+' +
  'a028IoM8vFcpID857Fm6HH41DFJXGXg0yT9NGRs8fC8HGRpAqzBhHcNC3TywH+ZC7UoeHyVBklO7HF8+1FdzGdk6+E/3FdQ5' +
  'tz3IFbFBJi7PFV1FzS8pGnVHTjwRHNdHAUnnGypGglCCGbhDH1ZIFv0/OU8fEkI/jzs2EjRHBSuREsFK3i8MF2JM1TukGK9M' +
  'x0aFGGhL6k19FlxJuFGXE29GxUv+D1BFRjpWD4hNLS5BEDtQlDAdFL9RrjrfFd1RBUWSFddQDEy/EwdPa0/tEKRMSkmzDbNL' +
  'nTkKDV1T4SywDdlVGS+tEVJXKjmoE2dXAUROE15WuUpMEcJUJU2IDuRS60a8C+RRuzi6CixZYCtdC4hbSSvKD/xcZTf4Ec5c' +
  '5kIhEdNbzkgID4Fai0p6DBFZzEQLCgBY4DecCP5egSpnCQZh0CvDDV5iZzY7EGJikEK6D1RhFEgxDThgVkfPCi1fvUK+CFNe' +
  '4jdcB/Nk+iwtCGpm5iz/C6hndTXdDpNntUEcDrlmXEelC8tlwkVMCQ5lMkGRB2tk5DdRBrpqqC9NB7Rr3C2TCq1sQjVvDb9s' +
  'bUEkDf5r+EZuCjprVUX/B61qT0BrBkNq0jduBTRwtTCGBtxwQy6KCYVxbzUmDKdx+kA7DBlxq0aGCYVwtkQNByFwrD+JBQlw' +
  'mDhwBXd1NDH5Bdl1YC/ACD52nTU+C1J2TEBRCwp2LkcECaR1F0VUBmt1ID8FBV11djjtBIZ6OjGoBat67i9XCNB61zWtCtx6' +
  'KkAHC8J6kUfFCJh6lkXqBX96Wj9pBHp6FzhqBGR/aTLLBU5/MzEqCDd//zWGCi1/dEBCC0J/W0jaCF9/E0e2BXd/10BgA25/' +
  'NziDBAmEgDMyBsODgzJICHCDYTaTCkmDWkBVC4WDgEk+CfyDW0m7BVCEEUGSA0KEyzdaBHaIdTTZBgSI2zLMCHaHrzYDCzmH' +
  'XECpC5iHekm3CWWIW0lOBvKIG0FIBMiIgjhPBbOM9TSyBxCMzzKjCT6L0zbgC9WKBUGpDGyLg0qRCpuMgEknB2SNcUEvBRmN' +
  'IDldBr2QjTXQCOiPwjK9CsOO5DYUDUmOjEGyDR2Pn0qGC5uQaUlPCJaRu0F4Bl6RWTlIB6qUUzUSCpGTNDMMDCOSTzdZDniR' +
  'T0IOD5WSVEvGDHKUnEqYCbSVnUK/B4mVkzllCHCYATWRCwqX5jOSDW2VGjirD6yUvUJOEOKVCkw9Dh6YSUwXC8GZ6kMgCaiZ' +
  'wTmrCQycxDRPDVKaiDRXD4eY4zhEEa6XXEPYEe2YfU3+D6eb7U6/DPKdC0ZqCtydujkAC4qfOTRCD2KdpzRhEYGb1jkJE3ya' +
  'JESmE8SbHU/0EQaf2FGgDgiiSEgFDMyhDjrNDMmiSzR/EUOg/jSbEzOelTokFR2dBUWqFVieVVEnFEuiAFahEMqlMkofDmel' +
  'ujoJD9+lSTTxE/KiOjULFragXDtyF6Wf5UXUF+Ogp1JzFmilWVrcEnCpTUxxEOCoazt7EeuofTOIFmqlLjWvGAKjHzz0Gd6h' +
  '/kZIGiqjk1T4GCqoGVyIFYmsyE1JE3is2zv7E5qrvzNmGbqnpzV2GyGl6DyiHNqjMkjwHEald1anG7uq5F1lGNCvAlAYFquv' +
  'lzzbFgSubzR4HOCpdzZgHhmnxj10H7+lWEm0H0WnDVh6HgWtu16CG6Sy1FFEGWuymz0QGiiwgzW4H9+rtTdrIeaorD5rIpGn' +
  'bUqVIhCpyll3IR2vn1/HHgG1PVPAHKG07D6RHfuxGTciI6yt6zicJJmqtD99JSipj0uiJdKq0FqRJAWxz2AuIpy2wlOaIJi2' +
  'PUA2IcCz5jemJkqvMDruJyesyECvKJyqp0zNKFusB1zTJ7ay1WG6JTi4qVRzJI64WkHqJHq14TdEKrKwOjtjK4yt4kEALP2r' +
  'pE0TLO+tGFwuKxy06mFzKc654VVWKAu6oULPKOi2PDgDLuSxKTz1Lq+u10J0Ly2tm053L0avaVytLka1tmFKLSC7/VZYLGW7' +
  'x0PILNq3zDniMdeykDylMnmvgUMKMwGupk//Mn6wT1xJMja2ZmE4Mem7jleCMCe9ZUTBMLq4kzrUNXqzxDt0NtSvu0O8NmGu' +
  '0VCjNjqxfV0DNvu2mmE2Ncy8lViuNNi9kUX1NMW5fTnaOdqzaTpVOrWvc0OCOiauMVJcOnex51/SOdW3BWUwOaS911npOOq9' +
  '60ZAOci6ZTf5PeOzojdHPg2vjkJQPhit51MePmmxmWKuPUy4qWZOPf69l1o/Pdm+YUeHPQq7nDcnQsazhjU6QkuuukEXQhSs' +
  'VFXVQS6x+WSVQWC4fmaFQSy+WVujQX+/xEfnQUm7rzZnRp2zMTUsRtGtlUHZRWeskFWURcKwHmeGRVe4mWfEReO9olsURkK/' +
  'e0hWRnW6eDmeSnqzXDckSuCtjEKnSS+s61VgSSWw9WiAST+4jWoPSqq9SlyPSn2+QEnGSoe5dTvbTjaziDorTsWtfUOGTbWr' +
  'LVY0TdmvLGiRTa638WppToK9WF0eT9u9m0lCT3u4sjweU5GyCTw9UrGtukR/UYir8VUkUW2vs2awUcG2C2rGUom8V12oUya9' +
  'rUnJU+y2Bz9VV7exyD1aVhitXUV+Vf6qp1UeVcuu8WTbVYe1dmghV2y7YV05WKe79kk9WHq1fT+cW5mwQD9+WhSsjkV9WR6q' +
  'SlUeWZ2tbmT+WRG06mZ7W8C5wVy7XNS5H0qoXNqzbT/mXx6vMj+eXvKq0EWMXTGpoVQzXYCsRGI1XleyHmXPX8m36VszYTK4' +
  'ykkoYVKygj1EZDet+DyrYhKpDkV5YTWnZlQVYfGq0mBlYmOwemMgZPq1nVvGZdS24UjPZaSw2zqqaPWqIDmgZommYkM4ZfCk' +
  'C1TsZNSoomCBZkWu3GJ4aIizflozal+1okeMam2uSzn8bMioNzm8ar+kT0NVaXejuFIhaRym/GF+ag6sQWTobPOxOlsSbzCz' +
  'hEYmb7qrnzg4cV6mezndbmOif0JRbQShxVEVbYajTmGRbnGp3GNBceiuolltcxqwtEV5c8SoxzdsdZ6jgTjscmyf2UAcceWd' +
  '/lDScLCgY2CgcpWmmGOZdVOrUleRd/6sgkTZd/ulhTTAeW2gmzTHdjWcAz/bdPqarE++dLKdyF6xdmGjD2LYedeoaldsfPup' +
  '0UJcfDyjcS8ufuucPC98eoeYjzxqeJ+XVk6LeNOZNGB9eiOgD2RSfpelZ1b/gDGnekAfgVqgXCmqgi+ZwykjfhmU4ziKe8CT' +
  'FE0mfJyWulycflCcw2Bkgtyh0lRphXekmD0ahsOcTyX0hlyV8yb1gb6QuTePf2uP4kuRfyySMV5Jgm2Y4GCxhkqe9lMfiomh' +
  'YDoui4aYDyMNi0CRdiOzhXSMATUHg+2KeUr3grCNb17+hU2Ur2EJiyqaZFKbjmmc0zgAjw6UVyAij9uMax9eiZ2IrTMUhw+H' +
  'B0jvhpuJ4Fr3iauPmV3tjk2VsE+oklOX1zbwknOPkxxDk1WIth5QjRSEUTG+ir+CnEXDiiCF4VfXjeWKQ1wEky6RKk+il+2S' +
  'qzONl36JzR7HlpWD8R9ukYt/gS+rjll+00K+jm+AU1S2kcOF8VjglqeLBEx+myiNjjFGm3yDlB9amo5+piKvlRh7ky4Ik7F5' +
  '3T++khp7vlJVlWqAulfimruFhEgon/6GfS/Qnpx9mR0eng15gSGJmRh2FC0ql4l0Bj2QlrR1s08Imax671OVnph/KkXUoheB' +
  'qCzMord2ECBZoTxzgCF2nbpwiCtGm5hvWjnrmndwZkkBnZx0DlAzolZ5SUKrpqZ5ait6pc1vnSCupBFtLiJmoQRrFCpon+Vp' +
  'JjbbnpxqtETBoCpuiEqQpX1yxT4bqp5yNinEqAJp0R1GqG9mBCD2pHdkYCfTolFjsTMmojtkAkFRpHBn5EcgqUJrMDtira9r' +
  'WCZ8rJxhnxyXq2xfxx6EqKNdDiVSpppc5zCjpVddRz6tp01gk0SBrPRjnDgLsQxkBSS2r4lZ4x17rgRYkh4NrIFWMyPrqWNV' +
  'WC7kqAlWuDvnqrxYAkCbr0xbEjPcsgRbsCNNsWdRfRyIsSJQjxw7r9ZOJiE0rQtOTCt7rLZOpDVtrrRQRTlNsrZSBy84tYRS' +
  '7SHwsw9JGhmqtMhH3RgIsn5GVx7GrwBG5iiBr5NG9TJisUlIXTT9tMBJIitWt+VJwh/WtmxALxTOt/c+jhNrtJY9JBvGseM8' +
  'RCgPscs9tTLZs4c/vDPktxRBIirLum9BWxytutg3qgwbu/k15QtOtjE0ZRZ0snkznCjMsYU0uTdtta42/TS9uiY41CiwvbU4' +
  'bBkevqIuJgxIvQUtPQqQuHcrAhW/tOEq9iYhtAgssTIduLAt4zC8vAEvISfrv2wvHxg6wJElWwmMvxgklgvZujQjrxZ8uP8i' +
  '6yJsuJgj/yvUurokPS+xviQmdifwwlkmURbBwlMc4QkgwR0brAl2vFwajRX9uXIaViG9utsaUSqkvNMb2S+SwCAdhCdGxT8d' +
  '0RQQxS4T8gs/wkoS1g1lvscRqRZdvMgRXyChvBQSPSkovusSLC/7wQwUGSe+xvwTDRUAxkAKZQ1Rw4EJMBABwBIJORdCvt0I' +
  'ayCevR4Jcisgvw4KaTGXwy4LPidkyB4LfRSBx5EBEgoExa4A4g0jwTIAJRZDvwAAByDHvjsA4StPwCgByi2XxBcCsSR4yGUC' +
  'gBMpyXuXMukgI5uUDOncJmqWiulaK7ybWOqELauhAusCLIykGOs1J4ShceqoIh+ctOm3IVSXLePyIouUpePiJnOWZONwK9+b' +
  'kuJoLa2hqOHtK62kJuFCJ9ChjOGXIkCcZuJ+IfOWFN/PIlOUpODfJjWW695nK26bAts2Ld+gNte5KzWj5tUzJwah1de5It2b' +
  'q9s+IViWANu4ItaTm93WJpeVoNphK3qaBdQkLUKfG85RKx2hXcwSJ6af8M6+IgCbQ9XLIGOV1taZIvySedrGJqKUYtZWKxiZ' +
  'm80FLXKdzsUnKzefYMPqJvedq8aIIrOZLM9oIBuUe9KBIsWRN9exJkGTUdJaK1mXtcf8LGWbHb4jK1udXbq+JhKcw74WIgCY' +
  'askbIH6SAM5wIk6QlNOZJm2Rrc6BK0qVQsIFLUyZTLZ2Kzibw7GQJriZzbfCIfSVAMTvH4aQrclTIo+Oos99JlePIsuhK/mS' +
  'Nr0YLbqWzq+CK4mYt6pjJgGX5LGYIZ2T5r4tIEaOgcU0InWM5ctgJieNLMeIK2+QgLhDLdSTmKpPK4+V3qQ3JiqUeqxmIRCR' +
  'K7pIINmLR8EmIjKK0MdBJteK3sJCK76NI7QULaSQ6qbIKnCS5J8OJiaR3adRIV2Oy7UiIEmJ/rwqIqKHTsQhJjqIJL8lK+qK' +
  'CLDvLIGNH6NvKvmODJ3pJfmNK6RrIYyLsrEfIJKGFrkbIhmF77/9JYeFQ7vsKv6HKKy3LGWKUJ8xKrqLiZnBJbqKLKGiIauI' +
  '4K3zH7KDBLbTIY+CAbvVJeuCgbZWKgiFh6ghLEqHrJv6KXiIm5aYJaOHx52YIcaFT6qaH9eAybKgIQmAmLWmJUqAlbGiKRGC' +
  'GKVQKzKETJi6KWaFGJNqJbCEGZpbIeKC7KZjHyR+iK7CIYN9GrBxJa59lKzXKB1/y6GcKkKBLJS9KWmCt483JaqBZZdfIQGA' +
  'oqOlH4F7IarwIep6Vas1JQl7BqgkKDV8mp74KSh+MpIeKVB/440AJal+PJV9IT19kaBsH+J4R6bxIVd45qbxJGd43aOCJ2V5' +
  'i5srKR97wJBYKFV8P4zAJM57DpOFIYp6kZ2IH1F286LHIc118KKiJM91GqDzJrR2mZhCKDp4ZY+LJ5R5J4p2JCF5xpBwIep3' +
  'lpr1H/tzn57hIVxzOZ9HJFdzaZxWJiF0spWBJ4Z1v43QJtl2DYkjJKF2go5HIW51uJcyIMlxYJrtIQNx4ZvgIwlxxJirJb5x' +
  '6ZKSJv5yIYwNJlp0lYfEI0F0iowmIRVz55RuILVvp5bIIfluxpdoI+luMJXwJIZvKpC1Ja9wIYpdJR9yuoVXIyZyXIrcIOFw' +
  'HpKiIMltXZN5IQptO5TiIuts5pE7JHVta43zJJluzYe6JDBwcoPdIjhwYIiQIOVudI+RIAxsZpAHIUFrCJFMIhNrz46EI4pr' +
  'o4pGJLhshYUIJIFuIYFWIo1uX4YtICpt8Iw/IIJqs413IKNpHY6jIXBpzIu+Ithp5od+IxBrIoNQI/tsQ3/EITttPYSmH7Br' +
  'jorHHzBpMovPHzNoYYvnIP5n4YjrIU5oF4W8IqNppYCPIsJrOH0oIRpsYoImH3tqV4gwHxlo3IgSH/Rm0YgUIJNmQIYfIfhm' +
  'PYLlIXJoG37CIc9qKXuFIENrooCbHoVpRIaOHj1np4ZFHuBleYYpH2Zlh4MxIOVlan/qIH9nWnvwIBdqQXnbH6dqD38PHsxo' +
  'V4TiHZxmkIRpHQ1lGIQlHoZkuoAeH/NkWHzwH8tmO3ggIJ1pZ3cuHz5qpX2DHUpojYIxHTZmmoJ+HHZkzIEIHbVjAn76HUFk' +
  'NHnYHlZmS3UzH1JprHV6Hv9pWXz2HPln34B3HAdmuoCGGwZk13/LG7diRHu3HNpjE3ahHSJmPHI7Hjhp+HO/HeRpGXtgHNhn' +
  'Sn+yGw9m+H5+GuRj1X19GjFiZnhDG5ZjlnJjHC9m9G5AHUxpSXL3HO1p1nm7G+ZnxH3fGk1mU31pGRJk03soGWRir3XAGXNj' +
  'rG4VG3pmFmwoHJVpjXAlHB9qingCGyRoTnz6Gb9m1XtGGIFk6XnMF0NjX3NSGN1joWulGQFnDGkTGw1q2W5DG35qN3czGpVo' +
  '7noGGWRnlXoTFyxlHHhsFiBkM3HiFsdkqGksGLtnI2fQGcZqC21fGhFr5XVTGTlponkDGDdokXnUFTBmJnYoFUBlSm9/Fepl' +
  'DWi+FqtoZmStGK5rSGtzGdxroHRmGA5qbnj1FjlplXiTFE1nfnTVE5JmmG0oFEBnzGZbFchpD2J9F7Nstml0GOhseXN5FxBr' +
  'V3fgFWZqS3dcE5ho73KHEghoEmzZEqxoeGUAFANrqGETFuFtNWhvFwpuU3J8FkFsbHbHFLprMHYiEihqP3FdEZ1psmqSERtq' +
  'tGOlEmhsYmDNFDJv0WZlFklvNnF0FZltqHWtEzhtMXQIEelriG9OEENrZ2lLELNrPWJSEfFtu16bE6FwiWVZFaJwInBkFP1u' +
  'h3SNEtduLHL1D8Bt+W1FDwttR2gSD11tq2AEEJ5vh1yEEiFyeGRBFA5yE29LE3pwXXNtEY1wlHDfDp1vrWw0Du9uUWfpDThv' +
  'z1/KDlVx5VtJEaVzrGMVE6xzPG5KEhRyWHJSEFVyd2/GDYxxf2suDcdwTWaxDCNxB1+dDRhzClwFEEd16WL4EU11YW0/Ebxz' +
  'L3E4Dyx0mG6zDHpzkmogDLByZGWECwVzsV1sDPF0qFvgDvZ2SGLfEPd2j2wzEHt1O3ArDhB23W2sC2t11WkUC7p0vWR+Cuh0' +
  'Blw+C9t23FrXDaV432G9D6B4umsfD0h3ZG8oDfx3RG2yCmB3PWkQCqt28mNdCfd2mls8Cs948lnkDGx6bmG7DlJ69GoTDiB5' +
  'tG40DOt5C22/CVJ51GgNCbx4dWNvCAh5OFtICb566lnqC0N89WDZDSV8dmo1DQF7M25RC9p7+WzaCDp7pWgGCKZ6t2JWBw57' +
  'c1pZCLx8ulgkCyZ+c2AaDQZ+LWp8DOx8JW6ICst9w2wMCCN9jmgNB4l8+WE8BiN9eFqQB7h+mVdxCgmA/F9zDPF/GWrrC9d+' +
  'Tm7UCbR/6WxJBwp/jWglBol+lWFjBS1/VVrSBqWAb1e2CeKBpV/WC9uBLmp6C76AvW44CZKBhW2MBuqArGhHBXuAJ2GHBB2B' +
  'NFkGBpSCiVYlCb6DNl9mC8SDeWo1C6SCyG++CGSDa27aBcqCzWiFBIeCL2EDBAKDoVc8BWyE2VaFCHyFFF/jCpOFv2rzCnmE' +
  'xnBVCC2FUW89BaWE82jdA3mEFmFsA/KEZ1eqBECGflYNCDmH0l6QClWHLmvXCjyGwnH7B+uGPHCzBHmGI2lMA2SGHmHzAuKG' +
  'M1hLBAKIr1aZB+aIml5TCvSIeWupCuyHw3KzB5uIQHE5BD+Id2m/Aj+IIGF9Ar6IkVjvA72JM1ZLB4CKaF4tCn6K0muNCoSJ' +
  'V3NtBz2KPHLSA/KJCGokAgmKFmECAouKTVmvA1yL4VbvBvaLmV7cCeWL/mtWCgqLNXRAB86Ll3N0A52Lp2qaAcOL7GB1AUaM' +
  'sFl0A+iM+FeZBliN6F6PCTyNUWxGCnqMBXUgB06NFHUiA0CNXmsaAXiNzmD3APKNzlk/A2OOCFlVBqeORl9MCXqOoWw7CtWN' +
  'mXUGB8WOEnbxAtqOL2yiACqP82CzAI6P8FkaA9SPbVk2BuePjl8sCZ2PymwbChmPOHb7BiqQTXfJAnGQ3mxbANOQRGGYAByR' +
  'QVoLAzWRlVktBhSRvV8uCayQ/WwKCkeQBHcCB4ORI3i8AgCSk20pAHCSj2GAAJmSm1oLA4OSxVkzBiuSCmAsCaWRRG0QCl2R' +
  '2HcXB82SEnm8AoeTJm4mAP+T/WGNAAeU/1obA7+T+VlGBiyTP2BHCYaSkG0iClmS0ng7BwWUQnrDAgSV6W4cAIeVXWKWAG2V' +
  'BlstA+mUFFpqBheUg2BkCVCT3m0+CjuT5nlsBzGVOnvfAn6W4m8JAAyXrmKaAMiWAVtLAwCWLlqaBu2U0mCCCQKULm5jCgiU' +
  'ynqfB0+WDHwNA/aX+XAAAJGY+WKhABuY1FpyAwOXdlrRBq6VG2GtCZyUfm6PCsuUK3vIB16XGH1DA2uZFnIPABSaTmO5AGaZ' +
  'n1qoA/SXrVoUB1mWW2HiCSGVzG6/CneVtnv9B16YdX5+A92aQ3MyAJmbqGPgAKOakFryA9OYxFplB/CWmWEcCpCVFW/xChOW' +
  'J3w1CFGZ4n/FA0ycgXRqACed/GMNAdebbFpIBKGZ0Vq/B3SX0WFbCvKVUm8eC5qWtHx1CDmaGIEgBMSd+nWkAMueQmQ5AQmd' +
  'HlqqBFya01ojCOaXA2KdCkSWim9MCxOXOH25CBObgoKDBE6fv3fcAGugoGSJATaes1kaBQeby1qOCEiYMmLiCoqWv296C4CX' +
  's30ACeCbRYMGBbSgMXlfAQmiDWX3AUyfh1mhBaGbtloBCZ2YXWIpC8OW82+qC96XOH5MCaCcN4SQBR6i1XrsAbOjeGV3AlCg' +
  'bVk6Biuco1p6CeeYhWJxC/KWJXDdCyyY1n6fCVGdboUiBoSjknyQAhmlHGY+A0ehS1niBqeck1r3CSiZrGK8CxyXVXARDHKY' +
  'bn/1CfWdmIbBBtSkQ35XA2+mwmYcBCGiV1mbBxWdplp3CmCZz2IKDEOXhHBHDL+Yw39NCoqen4dwByCmE4AvBK2namcSBeKi' +
  'flliCHidxlr7CpKZ8GJdDGWXtXCEDP6YPICvCg2fT4gwCOKm2IBiBb+oGWgjBpCjoFkzCc+d31qFC7yZDWO3DIOX6HDJDEOZ' +
  'hYAWC4Cf7Yj7CJynvIGSBqqpxmhHByykvFkMChye9FoWDOGZK2MXDZiXIHEXDXyZ5ICJC+afq4nOCSioaYLRB5KqYGlvCLmk' +
  'wlnsCl6eDlutDACaRWOADamXWnFvDbaZLYEFDD2gcoqoCp2oD4MSCTOrAmqqCTSlylnUC5aeLFtLDRmaXmPyDbSXlnHSDeeZ' +
  'f4GNDISgD4uOC/iooINVCs+rj2rmCqmlo1nBDMWeQ1vxDS2adWNtDrWX1nFBDg2a4oEhDbygfIt9DEKpLoSYC0OsFGspDP2l' +
  'tFm1DeueUFufDj2akWPyDruXE3K6DiWaV4LBDeag1YtzDYKpxITaDJmsj2tuDUumoFmuDgefTVtWD0WapmODD7GXU3JADzWa' +
  'yoJtDgOhKoxxDpupHIUgDsisA2y1DpumU1mtDxqfS1sVEEOasWMgEJiXlHLUDzSaWYMkDxahk4x1D4ypNYVoD+esaGz8D7Om' +
  'jlmwECWfPlveEDqau2PIEGeX2XJ0ECGaBITnDyGhZY1+EG2pOoWvEO2sxGxDEeCmUlm6ESefNluwESqawmN8EQ6XJHMgEQia' +
  'ooS1EB6h5I2SEUmpR4X1EfusDG2LEuama1nIEiGfQluLEhOaxWM9EsuWYnPWEfOZDoWQEQ+hNo6uEiupcIU8E7msXG3RE7im' +
  'CFrYExSfeFtwE/aZyWMKE6eWkXOcEsmZn4V2Evmg4I7REyWp24WHFFOsp20WFWym41rrFAKf+ltfFNyZ3mPlE16WxHNtE4GZ' +
  'coZmE+SgnpD8FCCpWIbZFf6r4G1fFvWlJ1wBFumeqlxbFdaZLmTPFBmW7XNNFD2ZDodjFL6glZE0Fgmpt4YyF4qrE26oF32l' +
  'Q10fF8iecF1jFtGZj2TKFeKVC3Q9FQGZbYdvFYCgCZF3F4+oRIaHGAGrQG7zGPqkYl5FGJ6eG155F8mZ9WTVFu+VDHRHFseY' +
  'noeKFjWgCZDCGDOoHIbmGUqqbW4+Gn+kPl92GWmep16cGLOZSGXvFwOWAnRjF6aYVIe3F+SfNo8WGpWna4VEG6GpiW6SGw+k' +
  'zF+1GiyeG1/OGZeZmmUaGfuV9nOOGI6YxIb1GIifLo51G9+mi4SlHNaopG7oHJyjQmAAHOWdlF8OG26Z3WVVGvqV3HPMGWOY' +
  'ToZAGiSfHo3eHDam0YMRHgWos25IHhejzWBWHZWd3V9cHDOZAmaeGwKWtXMfGzOYv4WaG7SetotRHmSlwYKAH2Onqm66H5Ki' +
  'MGG7HjqdD2C5Hd+Y/WX0HNKVk3N7HP6XG4UEHTyeT4rRH56k2IH9IIympG4wIQuicGEvINWcHmAmH3GYxmVXHmWVdXPeHcmX' +
  'S4R+Hr6dLIlfIduj/4CIIqWllm6xInahuGGwIWecGGCiIO2XaGXHH/mUSnNUH3CXyoMFIDmdaIj9IhGjIYAgJN2kcm5HJNeg' +
  '9mFBI+2b6F8vIoSXWGVQIbSUCHPlIDKXxoKhIaucmoeqJFaicX/LJS6kOm7zJT2g92HlJGmbh1/LIwmXKWXqIoOUs3KOIt2W' +
  '4YFMIxicZ4drJrihEH+RJ2uj+m2sJ66fo2GeJtma9l55JXmW12SSJP+TaHI7JGuWMYEGJXabk4Y6KDyhDH9zKbGiqm17KTef' +
  'z2BvKDyaJF43J8aVQWRHJiWTKHLoJcuV7oDLJs2aL4YeKvegmn98KxyiQW1oK7GeAWBSKpCZwFwEKf6UimMLKFuS1XGuJ/6U' +
  'FoGdKB6ai4YbLFqgaH+CLa2hvWx0LTOe3l5MLNSYpFrgKiGUsWLfKUSRinF3KS6UFIGDKmiZo4cxLuSfp3+tLyKhMWyRL6Wd' +
  'u11bLhmYNFrbLBCTbmG6K2+QHXFmKx+TtYF0LKKYTYhaMGmf6n/wMaKgkWvJMTGdBlyFMEqX1FjkLt6R71+hLWqPrnBgLRWS' +
  'DIJ7Ls+XGomZMvaeWIBSNDag2mohNJeclVrBMmiWt1b8MKyQgl6gL96NV3BOL5+Qm4OFMO+WHoryNCWe/n+xNoGfJmqCNueb' +
  'MFkSNXiVoFQqM4CPOl25MQ6MBXA/MQKPcoWeMgSW4ItnN0ednH8nOdaeXGkBORSb+1d2N3eUJVJpNbuO/VwQNIqLPW+jM3CN' +
  '5IbRNPuUy4vlOR2dBoH+O0OedmikO3SazlUAOm6T71DLN7uNS1xuNqaKgG4HNkeMqIYvN9STzIloPESc7IC2PoKeOWelPpqZ' +
  'F1SZPFmSd1BKOr+MwVvqOD6KiG2rODKMZYLfOaWSVYkQPyqbWIB3QTCdYmZSQW6YJ1M/PzaRv1DoPMSLVVuEO8KJgWxoO72L' +
  'H3+XPGORQInUQaqZ834xRHeblGX8QzKXFFL+QfqPZFCYP7OK2Fo2PsCIjmsZPtGKHH1SPwKQYoeZRByYiH31RmuZz2SbRpqV' +
  '8FG+RKOOdU9eQnyJK1oCQYyHj2rkQJyJsHseQggACQABAAgAAQAAAAkACgACAAkAAgABAAoACwADAAoAAwACAAsADAAEAAsA' +
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
let seatAspect = 1;       // and its aspect, so the height can be recovered in place()
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
  const halfW = CONFIG.boxWidth  * CONFIG.scale * vh * 0.5;
  const halfH = CONFIG.boxHeight * CONFIG.scale * vh * 0.5;
  const halfD = CONFIG.boxDepth  * CONFIG.scale * vh * 0.5;

  // The maps, and the plane they cover. The model is fitted to the box on its TIGHTEST
  // axis so its proportions survive — stretching it to fill the box would make the shape
  // depend on the box, and the shape is the one thing that now comes from the model.
  const maps = rasteriseMaps(CONFIG.mapResolution);
  const fit = Math.min((halfW * 2) / maps.aspect, halfH * 2);
  const planeH = fit;
  const planeW = fit * maps.aspect;
  const depthSpan = CONFIG.depthDisplacement * planeW;
  seatPlaneW = planeW;

  // Put the density peak under the label. The label is pinned to the upper-right corner in
  // CSS because that is where it has to be, so it is the fixed thing and the cloud gathers to
  // it — the reverse of the first attempt, which placed the label on the focus and then had
  // to drag the whole mass inward to give the sign room. Read here rather than in place()
  // because it has to be known before a single seat is drawn.
  {
    const el = document.getElementById('booknow');
    if (el) {
      const r = el.getBoundingClientRect();
      const ppw = innerHeight / vh;                 // pixels per world unit at the cloud's depth
      const wx = (r.left + r.width / 2 - innerWidth / 2) / ppw;
      const wy = (innerHeight / 2 - (r.top + r.height / 2)) / ppw;
      // the group sits on the screen corner, so take that off to get the cloud's own space,
      // then undo the offset every seat gets, landing in the same units as focusX/focusY
      const cornerX = CONFIG.anchorX * vh * camera.aspect * 0.5;
      const cornerY = CONFIG.anchorY * vh * 0.5;
      // Clamped into the map, and this is not defensive tidying. These are offsets in MAP
      // space, where the throw is drawn as u = ox / planeW + 0.5 + focusX and u must land in
      // 0..1 — so a focus past about 0.45 puts the whole draw off the map, every throw fails
      // its placement retry, and the population falls back to a uniform scatter that the mask
      // then rejects. The visible result is a cloud that gets SMALLER as the scale is raised,
      // which is what sent this round of tuning in the wrong direction twice.
      const lim = 0.42;
      CONFIG.focusX = THREE.MathUtils.clamp(
        (wx - cornerX) / planeW + CONFIG.position, -lim, lim);
      CONFIG.focusY = THREE.MathUtils.clamp(
        (wy - cornerY) / planeH + CONFIG.position, -lim, lim);
    }
  }
  seatAspect = maps.aspect;
  const cornerRadiusWorld = CONFIG.cornerRadius * vh;
  const flowRad = THREE.MathUtils.degToRad(CONFIG.flowAngle);
  const flowCos = Math.cos(flowRad), flowSin = Math.sin(flowRad);
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
    // ---- the corner cloud -------------------------------------------------
    // A smooth quarter-disc of seats spilling out of the screen corner, and nothing else:
    // no model silhouette, no fBm threshold, no dissolve bands, no streak taper.
    //
    // That is the whole rethink. Every one of those was an attempt to put STRUCTURE into
    // the seats, and structure carved into a seed is the one kind this effect cannot use —
    // a threshold makes holes, and holes in a cloud read as debris. The structure has to
    // come from the FLOW: the simulation stretches and folds a smooth seed into filaments
    // by carrying it, which is what ink actually does and what the curl was there for all
    // along. Give it a clean mass to work on and it does the work.
    if (CONFIG.cornerSeed) {
      // Into the frame from the corner. The group's origin IS the screen corner, so the
      // quarter running to -x and -y is the visible one; the spill either side of it is
      // what stops the two straight edges reading as a cut.
      // The quarter that runs INTO the frame from whichever corner is in force, which is
      // the direction opposite the corner's own signs.
      const cs = cornerSigns();
      const base = Math.atan2(-cs.y, -cs.x);
      const ang = base - Math.PI * 0.25 + Math.random() * (Math.PI * 0.5)
                + (Math.random() - 0.5) * CONFIG.cornerSpill;
      // A GAUSSIAN falloff, not a disc. A bounded radius puts a hard rim on the cloud, and
      // a hard rim on a radial draw is a circle — which is visible as a mask edge however
      // the inside is shaded. A Gaussian has no last radius: it just runs out, so there is
      // no contour anywhere for the eye to find.
      const rad = Math.abs(gauss1()) * cornerRadiusWorld * CONFIG.cornerBias;
      seat.x = Math.cos(ang) * rad;
      seat.y = Math.sin(ang) * rad;
      seat.z = (Math.random() - 0.5) * cornerRadiusWorld * CONFIG.cornerDepth;
      seat.nz01 = 1;
      return seat;
    }

    let u = 0, w = 0, mapDepth = 0, nz01 = 1;
    for (let tries = 0; tries < CONFIG.sampleAttempts; tries++) {
      if (CONFIG.focusDensity > 0) {
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
          // The budget is the ACROSS-axis half-extent, and the stretch is spent from it, so
          // the streak's long axis lands inside the plane instead of overshooting it. That
          // overshoot was not a near miss: a throw off the plane failed the placement retry,
          // fell back to a uniform draw, and scattered grains over the whole frame while the
          // middle stayed a lump.
          const spanA = (0.5 * planeH) / CONFIG.silhouette;
          const rad = Math.pow(Math.random(), 1 + CONFIG.focusDensity) * spanA;
          // about the focus, not about the middle of the plane
          // stretched along the throw axis before it is placed, so the throws already
          // have the streak's proportions and the mask is trimming a shape rather than
          // carving one out of a disc
          const ax = Math.cos(ang) * rad * CONFIG.silhouette;
          const ay = Math.sin(ang) * rad;
          const ox = ax * flowCos - ay * flowSin;
          const oy = ax * flowSin + ay * flowCos;
          u = ox / planeW + 0.5 + CONFIG.focusX;
          w = 0.5 - oy / planeH - CONFIG.focusY;
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

      // Then the spawn mask, and it is a HARD threshold rather than a probability. That is
      // the whole difference between a cloud that thins at its edge and one that fragments:
      // a probabilistic accept keeps a few motes everywhere and the edge stays a gradient,
      // where a threshold cuts the field along a contour and what survives outside the core
      // is whatever isolated pockets of the field happen to clear it — discrete specks.
      //
      // The field is a domain-warped fBm multiplied by a radial falloff, so the threshold
      // bites hardest where the falloff has already taken the density down. That is what
      // makes it a dense clumped core dissolving into grains rather than holes punched
      // evenly through the whole mass.
      const k = CONFIG.fbmScale;

      // Where this throw sits in the STREAK'S own frame: along the throw axis and across
      // it. Dividing the along-axis distance by the stretch is what makes the shape long —
      // the same falloff then reaches three times as far up the axis as across it.
      // w runs DOWN the map while the world's y runs up, so the sign has to be undone here
      // or the mask's frame is mirrored against the one the throw, the launch direction and
      // the grain stretch all share — and the streak tapers away from the axis it is being
      // thrown along.
      const rx = (u - 0.5 - CONFIG.focusX), ry = -(w - 0.5 + CONFIG.focusY);
      const alongReal = rx * flowCos + ry * flowSin;
      const along = alongReal / CONFIG.silhouette;
      const across = (-rx * flowSin + ry * flowCos) * CONFIG.silhouette;

      // The macro density: the streak's envelope. Asymmetric on purpose — full toward the
      // corner end and tapering away down the axis, which is what "thrown from there and
      // dragged" looks like and what keeps the mass attached to the corner.
      const rr = Math.hypot(along, across);
      // Measured in REAL distance along the axis, not in the compressed frame the ellipse
      // uses. Taking it from the divided coordinate stretched the taper by the silhouette
      // ratio as well, so it decayed over three times the intended length — which is to say
      // it never engaged inside the mass at all, and the streak had no tail.
      const taper = 1 - smoothT(Math.min(1, Math.max(0, alongReal - CONFIG.streakHead)
                                           / CONFIG.streakTaper));
      const macro = (1 - smoothT(Math.min(1, rr / CONFIG.fbmReach))) * taper;

      // The field the mass is cut from, sampled in the same stretched frame so its features
      // are long the same way the silhouette is, then veined by a finer subtracted layer.
      const sx = (along * 2 + 0.5) * k + 11.3;
      const sy = (across * 2 + 0.5) * k + 4.7;
      const sz = mapDepth * k + 19.1;
      const vs = CONFIG.veinScale;
      const field = warpedFbm(sx, sy, sz, CONFIG.fbmWarp)
                  - CONFIG.veinAmount * fbm3(sx * vs + 61.7, sy * vs + 12.9, sz * vs + 5.3, 4);

      // The dissolve: a high-frequency noise against a threshold that tracks the macro.
      const ds = CONFIG.dissolveScale;
      const speck = valueNoise3(sx * ds + 3.1, sy * ds + 27.4, sz * ds + 8.6);
      const need = 1 - Math.min(1, macro * CONFIG.dissolveGain);

      if (field * mix01(1, macro, CONFIG.fbmRadial) >= CONFIG.fbmThreshold
          && speck >= need) break;
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
    px -= CONFIG.position * planeW;
    py -= CONFIG.position * planeH;

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

  // The per-mote neighbour count that used to live here is gone. It was an O(n) grid scan
  // over the whole population at load, and it was the slowest thing the build ever did — but
  // once positions became simulation state nothing read it: crowding is measured radially on
  // the CARRIED position now, in the vertex shader, because a seat's neighbour count says
  // only where a particle started.

  const inst = (name, arr, size) =>
    geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  inst('aInitPos', initPos, 3);
  inst('aDriftDir', driftDir, 3);
  inst('aDriftSpeed', driftSpeed, 1);
  inst('aSize', sizes, 1);
  inst('aTimeOffset', timeOffs, 1);
  inst('aBrightness', brights, 1);
  inst('aCurlResp', curlResp, 1);
  inst('aShape', shapes, 1);
  inst('aLife', lives, 1);
  inst('aOutward', outward, 1);

  // ---- the simulation's own data ------------------------------------------
  // One texel per particle. The texture is as wide as SIM_W and as tall as it needs to be;
  // the tail of the last row is unused, and never read, because aSimUv only ever addresses
  // the first `count` texels.
  const simW = 256;
  const simH = Math.ceil(count / simW);
  const simUv = new Float32Array(count * 2);
  const lifeSpan = new Float32Array(count);
  const seedData = new Float32Array(simW * simH * 4);
  for (let i = 0; i < count; i++) {
    const x = i % simW, y = (i / simW) | 0;
    simUv[i * 2] = (x + 0.5) / simW;
    simUv[i * 2 + 1] = (y + 0.5) / simH;
    // Drawn once, here, and written into BOTH the attribute and the texture, so the shader
    // that fades a particle out and the pass that kills it agree to the frame. Computing
    // the same spread twice, once per language, is how they come to disagree.
    const span = CONFIG.simLife
      * (1 - CONFIG.simLifeSpread + Math.random() * 2 * CONFIG.simLifeSpread);
    lifeSpan[i] = span;
    seedData[i * 4] = initPos[i * 3];
    seedData[i * 4 + 1] = initPos[i * 3 + 1];
    seedData[i * 4 + 2] = initPos[i * 3 + 2];
    seedData[i * 4 + 3] = span;
  }
  inst('aSimUv', simUv, 2);
  inst('aLifeSpan', lifeSpan, 1);

  // Where the seat cloud sits and how big it is, for the radial crowding ramp.
  //
  // The NINETIETH percentile, not the median, and the difference is not cosmetic: this
  // number is the denominator of a ramp that now drives ALPHA, and the throw is crowded
  // toward the focus, so the median radius sits well inside the mass. Against the median,
  // everything past about half the cloud's real extent fell outside the ramp, took zero
  // alpha and was discarded — the visible cloud collapsed to a scatter of a few hundred
  // grains while the population was untouched.
  let cx = 0, cy = 0;
  for (let i = 0; i < count; i++) { cx += initPos[i * 3]; cy += initPos[i * 3 + 1]; }
  cx /= count; cy /= count;
  const radii = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const dx = initPos[i * 3] - cx, dy = initPos[i * 3 + 1] - cy;
    radii[i] = Math.sqrt(dx * dx + dy * dy);
  }
  radii.sort();
  geo.userData.sim = {
    w: simW, h: simH, seedData,
    centre: new THREE.Vector3(cx, cy, 0),
    radius: Math.max(1e-4, radii[Math.floor(count * 0.9)]),
  };

  // the cloud moves in the shader, so nothing can be culled off its rest bounds
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(halfW, halfH, halfD) * 4);

  // pristine copies, kept so the depth sort can permute from a fixed source rather than
  // repeatedly permuting an already-permuted buffer
  // EVERY per-mote attribute has to be listed here, not just the ones the sort reads.
  // Whatever is left out keeps its creation order while the rest are permuted, so a mote
  // ends up drawn with another mote's value — and because the sort reruns every fourth
  // frame, the mismatch changes as the cloud turns. aShape is here for that reason, not
  // because the sort has any interest in it.
  geo.userData.src = {
    aInitPos: initPos.slice(), aDriftDir: driftDir.slice(),
    aDriftSpeed: driftSpeed.slice(), aSize: sizes.slice(),
    aTimeOffset: timeOffs.slice(),
    aBrightness: brights.slice(), aCurlResp: curlResp.slice(),
    aShape: shapes.slice(),
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
  uCurlDivergence: { value: CONFIG.curlDivergence },
  uInfluencePoint: { value: new THREE.Vector3(
    CONFIG.influencePointX, CONFIG.influencePointY, CONFIG.influencePointZ) },
  uInfluenceRadius: { value: CONFIG.influenceRadius },
  uInfluenceIntensity: { value: CONFIG.influenceIntensity },
  uMouseRayOrigin: { value: new THREE.Vector3(-9999, -9999, -9999) },
  uMouseRayDir: { value: new THREE.Vector3(0, 0, 0) },
  uMouseRadius: { value: CONFIG.mouseRadius },
  uMouseEdgeBlur: { value: CONFIG.mouseEdgeBlur },
  uMouseNoise: { value: CONFIG.mouseNoise },
  uMouseNoiseScale: { value: CONFIG.mouseNoiseScale },
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
  uGrainAxis: { value: new THREE.Vector2(1, 0) },
  uGrainStretch: { value: CONFIG.grainStretch },
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
  uRamp0: { value: new THREE.Vector3(...CONFIG.ramp[0]) },
  uRamp1: { value: new THREE.Vector3(...CONFIG.ramp[1]) },
  uRamp2: { value: new THREE.Vector3(...CONFIG.ramp[2]) },
  uRamp3: { value: new THREE.Vector3(...CONFIG.ramp[3]) },
  uRamp4: { value: new THREE.Vector3(...CONFIG.ramp[4]) },
  uRampFringe: { value: CONFIG.rampFringe },
  uAlphaGain: { value: CONFIG.alphaGain },
  uColorOverlayBlendMode: { value: CONFIG.colorOverlayBlendMode },
  uColorOverlayStrength: { value: CONFIG.colorOverlayStrength },
  uSaturation: { value: CONFIG.saturation },
  uContrast: { value: CONFIG.contrast },
  uBrightness: { value: CONFIG.brightness },
  uMinBrightness: { value: CONFIG.minBrightness },
  uOpacity: { value: CONFIG.opacity },
  uSolidity: { value: CONFIG.solidity },
  uGroundColor: { value: new THREE.Vector3(
    CONFIG.groundR, CONFIG.groundG, CONFIG.groundB) },
  uGround: { value: CONFIG.ground },
  uGroundBias: { value: CONFIG.groundBias },
  uGroundFade: { value: CONFIG.groundFade },
  tSimPos: { value: null },
  uCloudCentre: { value: new THREE.Vector3() },
  uCloudRadius: { value: 1 },
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

// ---------------------------------------------------------------- the simulation
// A ping-pong pair of float targets, one texel per particle, plus the seed texture the pass
// reads a particle's seat and lifespan out of. Everything here is particle-space: none of it
// resizes with the window, and none of it is touched by place().
//
// FLOAT, not half float, wherever the device will give it. What is stored is an offset from
// the seat, which keeps the numbers small, but a half float's smallest step near even a
// small offset is close to one frame's movement at this pace — the cloud would advance in
// visible jerks or, at the slow end, not at all.
function makeSim() {
  const d = mesh.geometry.userData.sim;
  const canFloat = !!renderer.extensions.get('EXT_color_buffer_float');
  const type = canFloat ? THREE.FloatType : THREE.HalfFloatType;
  if (!canFloat) console.warn('no float render targets; the simulation will step coarsely');

  const rt = () => new THREE.WebGLRenderTarget(d.w, d.h, {
    type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });

  const seed = new THREE.DataTexture(d.seedData, d.w, d.h, THREE.RGBAFormat, THREE.FloatType);
  seed.minFilter = seed.magFilter = THREE.NearestFilter;
  seed.needsUpdate = true;

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  const fsScene = new THREE.Scene().add(quad);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const step = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tPos: { value: null }, tSeed: { value: seed },
      uDt: { value: 0 }, uTime: { value: 0 },
      uSpeed: { value: CONFIG.simSpeed * d.radius },
      uFrequency: { value: CONFIG.simFrequency },
      uFieldSpeed: { value: CONFIG.simFieldSpeed },
      uDivergence: { value: CONFIG.simDivergence },
      uFine: { value: CONFIG.simFine },
      uLaunchDir: { value: (() => {
        const fa = THREE.MathUtils.degToRad(CONFIG.flowAngle);
        return new THREE.Vector3(Math.cos(fa), Math.sin(fa), 0);
      })() },
      uLaunchSpeed: { value: CONFIG.launchSpeed * d.radius },
      uLaunchDecay: { value: CONFIG.launchDecay },
      uBurst: { value: CONFIG.launchBurst * d.radius },
      uGravity: { value: CONFIG.simGravity },
      uCloudCentre: { value: d.centre.clone() },
      // shared with the velocity pass; the cursor terms are only read there
      tVel: { value: null },
      uMouseRayOrigin: { value: new THREE.Vector3(-9999, -9999, -9999) },
      uMouseRayDir: { value: new THREE.Vector3() },
      uMouseRadius: { value: 1 },
      uPush: { value: 0 },
      uFalloffPower: { value: CONFIG.falloffPower },
      uMouseEdgeBlur: { value: CONFIG.mouseEdgeBlur },
      uMouseNoise: { value: CONFIG.mouseNoise },
      uMouseNoiseScale: { value: CONFIG.mouseNoiseScale },
      uSettle: { value: CONFIG.settle },
      uDrag: { value: CONFIG.drag },
    },
  });

  // The velocity pass runs the SAME uniforms — it is the same shader with a second entry
  // point — so there is one set to keep in step rather than two that can drift apart.
  const vel = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: SIM_VEL_FRAG, depthTest: false, depthWrite: false,
    uniforms: step.uniforms,
  });
  const init = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: SIM_INIT_FRAG,
    depthTest: false, depthWrite: false, uniforms: {},
  });

  const sim = { a: rt(), b: rt(), va: rt(), vb: rt(),
                step, vel, init, quad, fsScene, fsCam, radius: d.radius,
                draw(material, target) {
                  this.quad.material = material;
                  renderer.setRenderTarget(target);
                  renderer.render(this.fsScene, this.fsCam);
                  renderer.setRenderTarget(null);
                } };

  // Both halves start at the seat so the very first step reads a clean buffer whichever way
  // the ping-pong happens to land.
  sim.draw(init, sim.a);
  sim.draw(init, sim.b);
  sim.draw(init, sim.va);     // starts still
  sim.draw(init, sim.vb);
  uniforms.tSimPos.value = sim.a.texture;
  uniforms.uCloudCentre.value.copy(d.centre);
  uniforms.uCloudRadius.value = d.radius * CONFIG.bloomRadius;
  return sim;
}
let sim = null;

// ---------------------------------------------------------------- the shadow chain
// One target the size of the canvas for the particles, and a ping-pong pair at half that for
// the blur. Nothing here depends on the simulation or on the seats, so it survives a rebuild.
function makeShadow() {
  const opts = { depthBuffer: false, stencilBuffer: false,
                 minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const rt = (w, h, depth) => new THREE.WebGLRenderTarget(
    Math.max(1, w | 0), Math.max(1, h | 0), depth ? { ...opts, depthBuffer: true } : opts);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  const fsScene = new THREE.Scene().add(quad);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = (frag, uniforms, blend) => new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false,
    transparent: !!blend,
    blending: blend ? THREE.CustomBlending : THREE.NoBlending,
    // Premultiplied compositing, which is how the renderer stored the particles into the
    // target in the first place. Ordinary SRC_ALPHA blending here would double-count the
    // alpha and leave a dark halo around every mote.
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });

  return {
    scene: null, a: null, b: null, quad, fsScene, fsCam,
    alpha: mat(SHADOW_ALPHA_FRAG, { tSrc: { value: null } }),
    blur: mat(SHADOW_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }),
    draw: mat(SHADOW_DRAW_FRAG, {
      tSrc: { value: null }, uOffset: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Vector3(...CONFIG.shadowColor) },
      uStrength: { value: CONFIG.shadowStrength } }, true),
    blit: mat(SHADOW_BLIT_FRAG, { tSrc: { value: null } }, true),
    resize(w, h) {
      const sw = Math.max(1, (w * CONFIG.shadowScale) | 0);
      const sh = Math.max(1, (h * CONFIG.shadowScale) | 0);
      if (this.scene) { this.scene.dispose(); this.a.dispose(); this.b.dispose(); }
      this.scene = rt(w, h, true);
      this.a = rt(sw, sh);
      this.b = rt(sw, sh);
      this.sw = sw; this.sh = sh;
    },
  };
}
let shadowChain = null;

function renderShadowed() {
  const c = shadowChain;

  // autoClear OFF for the whole pass, and this is not housekeeping — it is the thing that
  // makes the shadow exist. render() clears its target first by default, so the second of the
  // two composites below wiped the canvas and took the shadow with it: the cloud was drawn
  // over a blank frame every time and the shadow was never on screen for a moment.
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  const pass = (material, target) => {
    c.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(c.fsScene, c.fsCam);
  };

  // the particles, once
  renderer.setRenderTarget(c.scene);
  renderer.clear();
  renderer.render(scene, camera);

  // coverage, then blurred across and down
  c.alpha.uniforms.tSrc.value = c.scene.texture;
  pass(c.alpha, c.a);
  c.blur.uniforms.tSrc.value = c.a.texture;
  c.blur.uniforms.uDir.value.set(CONFIG.shadowBlur / c.sw, 0);
  pass(c.blur, c.b);
  c.blur.uniforms.tSrc.value = c.b.texture;
  c.blur.uniforms.uDir.value.set(0, CONFIG.shadowBlur / c.sh);
  pass(c.blur, c.a);

  // shadow under, cloud over
  renderer.setRenderTarget(null);
  renderer.clear();
  c.draw.uniforms.tSrc.value = c.a.texture;
  c.draw.uniforms.uOffset.value.set(CONFIG.shadowOffsetX, CONFIG.shadowOffsetY);
  c.draw.uniforms.uColor.value.set(...CONFIG.shadowColor);
  c.draw.uniforms.uStrength.value = CONFIG.shadowStrength;
  c.quad.material = c.draw;
  renderer.render(c.fsScene, c.fsCam);
  if (!CONFIG.shadowOnly) {
    c.blit.uniforms.tSrc.value = c.scene.texture;
    c.quad.material = c.blit;
    renderer.render(c.fsScene, c.fsCam);
  }

  renderer.autoClear = prevAutoClear;
}

// One Euler step, then swap. The dt is the motes' own clock, so CONFIG.speed still scales
// the whole thing, and it is clamped for the same reason the render loop clamps it: a tab
// coming back from the background hands over a delta of several seconds, which would move
// every particle a full life in one frame and tear the cloud apart.
let simPushGain = 1;
let hoverFade = 0;
function stepSim(dt) {
  if (!sim) return;
  const u = sim.step.uniforms;
  u.tPos.value = sim.a.texture;
  u.uDt.value = Math.min(dt, 0.05);
  u.uTime.value = uniforms.uTime.value;
  u.uSpeed.value = CONFIG.simSpeed * sim.radius;
  u.uFrequency.value = CONFIG.simFrequency;
  u.uFieldSpeed.value = CONFIG.simFieldSpeed;
  u.uDivergence.value = CONFIG.simDivergence;
  u.uFine.value = CONFIG.simFine;
  u.uLaunchSpeed.value = CONFIG.launchSpeed * sim.radius;
  u.uLaunchDecay.value = CONFIG.launchDecay;
  u.uBurst.value = CONFIG.launchBurst * sim.radius;
  u.uGravity.value = CONFIG.simGravity;
  {
    const t = THREE.MathUtils.clamp(CONFIG.hoverFeel, 0, 1);
    const settle = Math.pow(CONFIG.hoverOldSettle, 1 - t) * Math.pow(CONFIG.hoverNewSettle, t);
    const drag = CONFIG.hoverOldDrag + (CONFIG.hoverNewDrag - CONFIG.hoverOldDrag) * t;
    u.uSettle.value = settle;
    u.uDrag.value = drag;
    simPushGain = 1 / Math.max(1e-3, 1 - drag * (1 - settle));
  }
  u.uFalloffPower.value = CONFIG.falloffPower;
  u.uMouseEdgeBlur.value = CONFIG.mouseEdgeBlur;
  u.uMouseNoise.value = CONFIG.mouseNoise;
  u.uMouseNoiseScale.value = CONFIG.mouseNoiseScale;
  // the pointer ray is already converted into the cloud's own space for the vertex shader
  u.uMouseRayOrigin.value.copy(uniforms.uMouseRayOrigin.value);
  u.uMouseRayDir.value.copy(uniforms.uMouseRayDir.value);
  u.uMouseRadius.value = uniforms.uMouseRadius.value;
  // pushForce is a multiple of the mass radius per second squared, so it means the same
  // thing at any size. uMouseStrength is only read here to recover the hover FADE from it —
  // its own magnitude belonged to the displacement this replaced.
  // Read the fade directly rather than backing it out of uMouseStrength, which now carries
  // the crossfade as well and goes to zero at the far end of the dial.
  const dtc = Math.max(1e-4, Math.min(dt, 0.05));
  const feel = THREE.MathUtils.clamp(CONFIG.hoverFeel, 0, 1);
  u.uPush.value =
    (CONFIG.hoverPush * sim.radius) / (dtc * simPushGain) * hoverFade * feel;

  // velocity first, then the position that integrates it
  u.tVel.value = sim.va.texture;
  sim.draw(sim.vel, sim.vb);
  const tv = sim.va; sim.va = sim.vb; sim.vb = tv;

  u.tVel.value = sim.va.texture;
  sim.draw(sim.step, sim.b);
  const t = sim.a; sim.a = sim.b; sim.b = t;
  uniforms.tSimPos.value = sim.a.texture;
}

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
  // Never, in this version. The sort ranks motes by their SEAT, which was a fair stand-in
  // while a mote never left it; now a particle's seat is only where it was born and says
  // nothing about where it is. The order it would produce is worse than creation order, and
  // permuting the attributes would also break each particle's link to its own texel.
  return;
  // eslint-disable-next-line no-unreachable
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

// ---------------------------------------------------------------- GLSL: the shadow
// The wall is drawn by a different app on a different canvas, so there is no geometry here
// to cast onto and no depth buffer shared between the two. What there IS, is that our canvas
// composites over theirs — so a darkened, offset, blurred copy of the cloud's own COVERAGE,
// drawn underneath the particles, darkens the wall exactly where the cloud would have
// shaded it. The shadow is the alpha channel, not the colour.
const SHADOW_ALPHA_FRAG = /* glsl */`
uniform sampler2D tSrc;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(tSrc, vUv).a); }
`;

// Separable blur on ALPHA alone. The bloom's blur carries rgb and writes alpha 1, which is
// the opposite of what a shadow needs.
const SHADOW_BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main(){
  float w[5];
  w[0] = 0.2270270270; w[1] = 0.1945945946; w[2] = 0.1216216216;
  w[3] = 0.0540540541; w[4] = 0.0162162162;
  float sum = texture2D(tSrc, vUv).a * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i);
    sum += texture2D(tSrc, vUv + o).a * w[i];
    sum += texture2D(tSrc, vUv - o).a * w[i];
  }
  gl_FragColor = vec4(0.0, 0.0, 0.0, sum);
}
`;

// Offset by the light's direction and multiplied down. Output is PREMULTIPLIED, because the
// pass that draws it blends with (ONE, ONE_MINUS_SRC_ALPHA) — the same convention the
// renderer stores into a target with.
const SHADOW_DRAW_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2  uOffset;
uniform vec3  uColor;
uniform float uStrength;
varying vec2 vUv;
void main(){
  float a = texture2D(tSrc, vUv - uOffset).a * uStrength;
  a = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(uColor * a, a);
}
`;

// The particles themselves, straight back out of the target they were rendered into.
const SHADOW_BLIT_FRAG = /* glsl */`
uniform sampler2D tSrc;
varying vec2 vUv;
void main(){ gl_FragColor = texture2D(tSrc, vUv); }
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
  const cs = cornerSigns();
  // Scale first: uExpandOrigin below is converted with worldToLocal, which reads it.
  group.scale.setScalar(CONFIG.massScale);
  group.position.set(
    cs.x * (Math.abs(CONFIG.anchorX) * vw * 0.5 + CONFIG.offsetX * vh),
    cs.y * (Math.abs(CONFIG.anchorY) * vh * 0.5 + CONFIG.offsetY * vh),
    CONFIG.anchorZ);
  group.updateMatrixWorld();
  // the cursor's reach is given as a fraction of the frame; convert it here, where the
  // world height of the frame is known, so it survives a resize
  // Divided by the group's scale, because the ray is converted into the group's LOCAL space
  // before the reach is compared against it — and the group is scaled. Left undivided, the
  // hover reached massScale times further than the number says, which it has been doing
  // quietly since the scale control was added.
  uniforms.uMouseRadius.value = (CONFIG.mouseRadius * vh) / Math.max(1e-6, CONFIG.massScale);
  worldPush = CONFIG.mouseStrength * vh;

  // The bloom grows the cloud away from the SCREEN CORNER, so the origin is that corner
  // expressed in the group's own space — not the group's origin, which is only wherever
  // the anchor happened to put the cloud's centre.
  uniforms.uExpandOrigin.value.set(cs.x * vw * 0.5, cs.y * vh * 0.5, CONFIG.anchorZ);
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
  hoverRadiusWorld = CONFIG.expandHoverRadius * CONFIG.scale * vh;

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
  hoverInnerWorld = CONFIG.expandHoverInner * CONFIG.scale * vh;

  // One axis for the whole effect. The mask cuts the streak along it, the throw pushes
  // along it and the grains are smeared along it; letting any of the three drift off the
  // others is what turns a streak back into a blob with a lean.
  const fa = THREE.MathUtils.degToRad(CONFIG.flowAngle);
  uniforms.uGrainAxis.value.set(Math.cos(fa), Math.sin(fa));
  uniforms.uGrainStretch.value = CONFIG.grainStretch;
  uniforms.uParticleSize.value = CONFIG.particleSize;
  if (sim) sim.step.uniforms.uLaunchDir.value.set(Math.cos(fa), Math.sin(fa), 0);

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
  hoverFade = fade;
  // the direct displacement is the hoverFeel=0 end, so it fades OUT as the dial goes up
  uniforms.uMouseStrength.value =
    worldPush * fade * (1 - THREE.MathUtils.clamp(CONFIG.hoverFeel, 0, 1));

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
  if (CONFIG.shadow) {
    if (!shadowChain) shadowChain = makeShadow();
    const dpr0 = renderer.getPixelRatio();
    shadowChain.resize(innerWidth * dpr0, innerHeight * dpr0);
  }
  if (CONFIG.bloom) {
    if (!bloomChain) bloomChain = makeBloom();
    const dpr = renderer.getPixelRatio();
    bloomChain.resize(innerWidth * dpr, innerHeight * dpr);
  }
  place();
}
addEventListener('resize', resize);
resize();

// The buffers are particle-space, so this is built once and never touched by a resize.
sim = makeSim();

// Re-throw the population at a new count. Everything downstream of the seats has to go with
// them: the geometry carries the seats, and the simulation's textures are one texel per
// particle, so neither survives a change of population.
function rebuildCloud(count) {
  CONFIG.particleCount = count;
  group.remove(mesh);
  mesh.geometry.dispose();
  if (sim) { sim.a.dispose(); sim.b.dispose(); sim.va.dispose(); sim.vb.dispose(); }
  mesh = new THREE.Mesh(buildParticles(count), material);
  mesh.frustumCulled = false;
  group.add(mesh);
  sim = makeSim();
  place();
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let elapsed = 0;

// A fixed frame step, in seconds, instead of the wall clock. Only for measuring: under a
// software renderer a frame takes about a second of real time, so two captured frames are a
// second of MOTION apart and any flow measured between them is meaningless. With this set,
// captured frame N is at exactly N * tstep whatever the machine is doing.
const TSTEP = numParam('tstep', 0.001, 1);

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
  const dt = TSTEP !== null ? TSTEP : Math.min(clock.getDelta(), 0.1);
  elapsed += dt;
  // the motes' own clock, which the speed control scales. Accumulated rather than
  // multiplied at read time, so changing the pace never jumps their phase.
  uniforms.uTime.value += dt * CONFIG.speed;
  stepSim(dt * CONFIG.speed);
  parallax();
  uniforms.uCentreViewZ.value =
    _v.setFromMatrixPosition(group.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
  sortByDepth();
  updateCursor(dt);
  if (CONFIG.bloom && bloomChain) renderBloom();
  else if (CONFIG.shadow && shadowChain) renderShadowed();
  else renderer.render(scene, camera);
  if (firstFrame) { firstFrame = false; dismissLoading(); }
}
tick();

// ---------------------------------------------------------------- panel
// Two controls, both for look-dev rather than for the shipped build: QUANTITY, and the ink's
// HUE. Each prints the value to write into CONFIG once it is settled. ?ui=0 hides the panel.
//
// Quantity rebuilds — the population is baked into the geometry and into the simulation's
// textures, so it cannot be a uniform. That makes it the one control with a cost, which is
// why it is a bar and not a live drag: the seats are re-thrown and the buffers re-made.
const uiEl = document.getElementById('pui');
// Hidden unless ?ui=1. It is a tuning rail, not part of the piece.
if (uiEl && PARAMS.get('ui') !== '1') {
  uiEl.remove();
} else if (uiEl) {
  // Colour. Every particle carries the same colour now — the tone in the picture is how many
  // of them overlap, not what any one of them is — so hue, saturation and lightness are one
  // colour rather than a ramp, and all five ramp stops are written from it. The readout is
  // the RGB triple to paste into CONFIG.ramp once it is settled.
  const inkHSL = { h: 0, s: 0, l: 0 };
  new THREE.Color(...CONFIG.ramp[4]).getHSL(inkHSL);
  const inkStops = ['uRamp0', 'uRamp1', 'uRamp2', 'uRamp3', 'uRamp4'];
  const applyInk = () => {
    const c = new THREE.Color().setHSL(inkHSL.h, inkHSL.s, inkHSL.l);
    for (let i = 0; i < inkStops.length; i++) {
      uniforms[inkStops[i]].value.set(c.r, c.g, c.b);
      CONFIG.ramp[i] = [c.r, c.g, c.b];
    }
    return c;
  };
  const inkText = () => {
    const c = CONFIG.ramp[4];
    return c.map((n) => n.toFixed(3)).join(', ');
  };

  const ROWS = [
    // Size, speed and turbulence. None of the three needs a rebuild: particleSize is a
    // uniform, and stepSim copies the other two out of CONFIG every frame.
    { key: 'particleSize', name: 'size', cst: 'CONFIG.particleSize',
      min: 0.2, max: 4, step: 0.05, value: CONFIG.particleSize,
      uni: 'uParticleSize', text: () => CONFIG.particleSize.toFixed(2) },
    { key: 'simSpeed', name: 'speed', cst: 'CONFIG.simSpeed',
      min: 0, max: 0.35, step: 0.002, value: CONFIG.simSpeed,
      text: () => CONFIG.simSpeed.toFixed(3) },
    { key: 'simFrequency', name: 'turbulence', cst: 'CONFIG.simFrequency',
      min: 1, max: 24, step: 0.2, value: CONFIG.simFrequency,
      text: () => CONFIG.simFrequency.toFixed(1) },
    { key: 'alphaGain', name: 'density', cst: 'CONFIG.alphaGain',
      min: 0.05, max: 3, step: 0.01, value: CONFIG.alphaGain,
      uni: 'uAlphaGain', text: () => CONFIG.alphaGain.toFixed(2) },
    { key: 'particleCount', name: 'quantity', cst: 'CONFIG.particleCount',
      min: 50000, max: 900000, step: 50000, value: CONFIG.particleCount,
      rebuild: true, round: true, text: () => String(CONFIG.particleCount) },
    { key: 'massScale', name: 'scale', cst: 'CONFIG.massScale',
      min: 0.2, max: 4, step: 0.02, value: CONFIG.massScale,
      place: true, text: () => CONFIG.massScale.toFixed(2) },
    { key: 'offsetX', name: 'x', cst: 'CONFIG.offsetX',
      min: -0.5, max: 0.8, step: 0.005, value: CONFIG.offsetX,
      place: true, text: () => CONFIG.offsetX.toFixed(3) },
    { key: 'offsetY', name: 'y', cst: 'CONFIG.offsetY',
      min: -0.5, max: 0.8, step: 0.005, value: CONFIG.offsetY,
      place: true, text: () => CONFIG.offsetY.toFixed(3) },
    { key: 'mouseStrength', name: 'push', cst: 'CONFIG.mouseStrength',
      min: 0, max: 0.4, step: 0.005, value: CONFIG.mouseStrength,
      place: true, text: () => CONFIG.mouseStrength.toFixed(3) },
    { key: 'mouseRadius', name: 'reach', cst: 'CONFIG.mouseRadius',
      min: 0.01, max: 0.35, step: 0.005, value: CONFIG.mouseRadius,
      place: true, text: () => CONFIG.mouseRadius.toFixed(3) },
    { key: 'mouseNoise', name: 'push noise', cst: 'CONFIG.mouseNoise',
      min: 0, max: 1.2, step: 0.01, value: CONFIG.mouseNoise,
      uni: 'uMouseNoise', text: () => CONFIG.mouseNoise.toFixed(2) },
    { key: 'shadowStrength', name: 'shadow', cst: 'CONFIG.shadowStrength',
      min: 0, max: 1.5, step: 0.01, value: CONFIG.shadowStrength,
      text: () => CONFIG.shadowStrength.toFixed(2) },
    { key: 'shadowBlur', name: 'shadow blur', cst: 'CONFIG.shadowBlur',
      min: 0, max: 10, step: 0.1, value: CONFIG.shadowBlur,
      text: () => CONFIG.shadowBlur.toFixed(1) },
    { key: 'shadowOffsetX', name: 'shadow x', cst: 'CONFIG.shadowOffsetX',
      min: -0.06, max: 0.06, step: 0.001, value: CONFIG.shadowOffsetX,
      text: () => CONFIG.shadowOffsetX.toFixed(3) },
    { key: 'shadowOffsetY', name: 'shadow y', cst: 'CONFIG.shadowOffsetY',
      min: -0.06, max: 0.06, step: 0.001, value: CONFIG.shadowOffsetY,
      text: () => CONFIG.shadowOffsetY.toFixed(3) },
    { key: 'hue', name: 'hue', cst: 'CONFIG.ramp',
      min: 0, max: 1, step: 0.002, value: inkHSL.h,
      apply(v) { inkHSL.h = v; applyInk(); }, text: inkText },
    { key: 'sat', name: 'saturation', cst: 'CONFIG.ramp',
      min: 0, max: 1, step: 0.005, value: inkHSL.s,
      apply(v) { inkHSL.s = v; applyInk(); }, text: inkText },
    { key: 'light', name: 'lightness', cst: 'CONFIG.ramp',
      min: 0, max: 1, step: 0.005, value: inkHSL.l,
      apply(v) { inkHSL.l = v; applyInk(); }, text: inkText },
  ];

  uiEl.innerHTML = '<h2>particle cloud</h2>' + ROWS.map((r, i) =>
    '<div class="row"><div class="lbl">'
    + '<span class="name">' + r.name + '</span>'
    + '<span class="val" id="pv' + i + '">' + r.text() + '</span></div>'
    + '<span class="cst">' + r.cst + '</span>'
    + '<input type="range" id="pr' + i + '" min="' + r.min + '" max="' + r.max + '"'
    + ' step="' + r.step + '" value="' + r.value + '"></div>'
  ).join('') + '<div class="foot">?ui=0 hides this</div>';

  ROWS.forEach((r, i) => {
    const slider = document.getElementById('pr' + i);
    // Rebuilds fire on release, not on every pixel of the drag: re-throwing a quarter of a
    // million seats per input event locks the page up.
    slider.addEventListener(r.rebuild ? 'change' : 'input', () => {
      const v = parseFloat(slider.value);
      if (r.apply) r.apply(v); else CONFIG[r.key] = r.round ? Math.round(v) : v;
      if (r.uni) uniforms[r.uni].value = CONFIG[r.key];
      // Placement and size are group transforms, so they only need place() re-run — the
      // seats and the simulation buffers are untouched.
      if (r.place) place();
      // Silhouette and flow are cut into the SEATS, so they need the population re-thrown
      // exactly as a change of quantity does.
      if (r.rebuild) rebuildCloud(CONFIG.particleCount);
      document.getElementById('pv' + i).textContent = r.text();
    });
  });
}
