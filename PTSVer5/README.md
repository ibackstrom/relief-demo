# PTSVer5 — corner particle cloud, seated on a model

A volume of drifting, curling lit spheres wedged into the top-right corner. It opens a hole
around the cursor and blooms outward when the pointer reaches it.

Where ver4 grew its shape out of noise, ver5 takes it from `Corner.fbx` — and takes the
**method** from the reference too, which turned out not to be what it looked like.

Serve over HTTP — it will not run from `file://`:

```
python -m http.server 8000     # then open http://localhost:8000/
```

`index.html` + `main.js` is still the whole thing — the model ships inside `main.js` as a
quantised triangle soup, so there are no textures, no assets and nothing to fetch. The
canvas is transparent and draws no background of its own, so it drops over an existing page
as an overlay; the grey here is only a stand-in.

## Controls

Three bars, top-left, and nothing else. Each prints the `CONFIG` value it writes so a look
found here transfers to the build by typing it in. `?ui=0` hides the panel.

| bar | writes | default |
|---|---|---|
| colour | `colorOverlayR/G/B` | `0.850 0.050 0.060` |
| quantity | `particleCount` | 30 000, range 14 000–30 000 |
| size | `particleSize` | 0.4, range 0.1–0.7 |

Colour is **one** bar rather than three because the material only ever varies in hue: the
spheres are shaded in greyscale and tinted, so saturation and value belong to the lighting
rig, not to the choice of colour. The bar drives hue, holds S and V at the shipped red's,
and prints the RGB triple to paste back. Quantity re-seeds the whole population, so a drag
is coalesced into one rebuild rather than one per input event.

## `?original` — the reference's palette

`?original` swaps the client's red for the colours the reference site actually uses, page
ground included. It is a preset over `CONFIG`, not a second build.

Where its blue comes from is worth stating, because it is not in the particles. Theirs are
drawn **untinted** (`colorOverlayStrength: 0`) from a source already desaturated to
greyscale — so what is on screen is white motes. The blue is two things around them:

| | reference | in `?original` |
|---|---|---|
| background | `rgb(2,34,69)` to `rgb(0,0,0)` left to right, plus an `rgb(0,42,110)` light rising from the bottom centre | the same, as CSS on the demo page |
| frame overlay | `rgb(0,114,255)` at 0.71, overlay blend | the same numbers, applied to the motes |
| bloom | strength 0.62, radius 0.15 | the same |

That is the "white flow on dark blue": the flow is the motes' own value showing through a
partial tint, and the blue is the room they are in.

Two departures, both forced:

- **The overlay goes on the motes, not over the page.** The canvas is transparent and has no
  business tinting what sits behind it — as an overlay on someone else's page, a full-frame
  post tint would colour their content too.
- **The bloom drops back to the reference's own numbers.** Ours are raised to fight a light
  page; against black, added light is all there is and the pass needs no help.

`deepen` also drops to 0.25. Crowding deepens toward a *darker* body colour, which reads as
density on a light page and as holes punched in the mass on a dark one. The reference has no
equivalent to it at all.

## The motes are spheres

Each mote is a **sphere impostor**. The quad stays a camera-facing billboard, but the
surface normal is reconstructed per pixel from the quad's own coordinates: the unit disc is
the silhouette of a unit sphere, so `z = sqrt(1 - x² - y²)` gives the front hemisphere
exactly. That is a real, per-pixel-lit sphere for the cost of two triangles.

Instanced sphere *geometry* was the alternative and is the worse trade. For a sphere the
impostor is visually identical — the silhouette is analytically round at any size, where
geometry has a faceted edge and needs subdivision to hide it — and transparent geometry
brings per-triangle ordering problems on top of the per-mote ones. The impostor also keeps
the billboard structure the rest of the system already assumes.

The material is a small lighting rig rather than a flat tint:

- **key light**, wrapped past the terminator. A hard Lambert term leaves half of every
  sphere black, which on a light page reads as a hole punched in it.
- **fill light** from the opposite quarter in a cooler tone. One light gives a sphere that
  is correct and lifeless; the warm/cool contrast across the form is most of the difference
  between a lit ball and a good-looking one.
- **specular**, tight and bright — the single strongest "this is a ball" cue.
- **fresnel rim**, which drives *alpha* as well as colour, so the spheres are dense at the
  edge and thin through the middle and read as shells rather than beads.

Everything is lit in view space from a fixed direction, so every mote catches its highlight
in the same place. That consistency is what makes them read as objects under one light
rather than as separately decorated discs, and it is why the light is not jittered per mote.

## Size, small and large everywhere

Sizes come from a heavy-tailed draw, `sizeMin + (sizeMax − sizeMin) × rand^sizeBias`, rather
than a ± spread around the base. A symmetric spread has to raise its **mean** to widen its
**range**, so the whole cloud gets heavier as the big motes get bigger and there is a limit
to how far it can be pushed. A biased tail decouples the two: most motes stay small while a
few reach right out to `sizeMax`.

Seats are drawn **radially**, not per axis. Drawing each axis independently fills a *box*,
and the flat part of that draw runs right up to its walls — which is where the straight left
and bottom edges came from. Three independent normals give a 3D Gaussian cloud instead: the
direction falls out uniform for free, and the density falls off smoothly with **no boundary
anywhere**. Any draw with a fixed maximum radius ends in an edge; here there is none to hide.

On top of that, `edgeNoise` scales the radius by a noise field read in each mote's
**direction**, so neighbouring motes agree on where the edge is and the outline rolls in and
out. Read per mote instead, it would only fuzz an edge and never change its shape.

Measured as how far the left boundary wanders row to row, with its slow trend removed:

| | detrended wander |
|---|---|
| box draw | 14.1 px |
| radial, `edgeNoise` 0 | 29.6 px |
| radial + `edgeNoise` 0.50 | **33.0 px** |

Most of the gain is losing the box; the noise field adds the rest.

`radialSigma` is matched to the spread of the box draw it replaced. That draw was
triangular over the box — standard deviation 1/√6 = 0.41 of a half-extent — but a Gaussian
at the same number reads *wider*, because its tails run on where the triangle stopped dead,
and at 30 000 there are more motes out there to be seen. 0.31 lines the two up at the 90th
percentile, which is where the eye reads the size: 125.9 px against 121.3 px, within 4%.

Sampled over 200 000 motes, against the symmetric spread this replaced:

| | motes in the outer band | large motes there | largest there | mean size | 99th pct |
|---|---|---|---|---|---|
| symmetric spread | 38.0% | **0.00%** | 5.0 | 2.12 | 4.92 |
| heavy tail + `edgeShare` | 53.3% | **10.2%** | 14.0 | 2.58 | 13.32 |

The extremes grow nearly threefold while the mean barely moves — more variety without a
heavier cloud.

## The glow is a post pass

The luminous quality is **not** something each mote draws for itself. The scene is rendered
into a half-float target, the bright part is extracted, blurred at three halving scales and
added back. The particles themselves are plain.

The threshold is almost zero (0.011), so it is not really a bright pass: every lit pixel
blooms and the result reads as light around the whole mass rather than as highlights picked
out of it.

Three things had to differ from a textbook bloom, all because this is an overlay on a
**light** page rather than a scene on black:

- **Strength runs higher** — 1.55 against the reference's 0.62. Glowing against black is
  just adding light; against a light page there is nothing to add light *to*, so the pass
  has to work by spreading colour, which costs more.
- **The composite raises the canvas's own alpha**, not only its colour. A glow that adds
  only colour has nothing to show up against and disappears into the page. Lifting alpha is
  what lets it tint the page instead of sitting under it. Output is premultiplied for that
  reason.
- **Each level is prefiltered from the scene**, not chained off the level above. Chaining
  compounds the blur and the widest level ends up a featureless smear.

Measured against the same frame with `?bloom=0`:

| | tinted area | peak redness |
|---|---|---|
| off | 6389 px | 179.3 |
| on | 11 118 px | 246.0 |

`?bloom=0` disables it, `?bs=<n>` sets the strength.

## Crowding deepens the colour

The denser a mote's neighbourhood, the deeper its colour. Neighbours are counted **once**,
when the population is built, and the count rides along as a per-mote attribute — so this is
a property of the mote, not of whatever happens to be drawn on top of it.

That distinction is the whole design. Doing it with a blend mode instead makes every mote a
filter, which turns the cloud translucent and stops the spheres reading as solid. Here the
blending is untouched: the spheres stay opaque and glossy, and only their body colour moves.
Being fixed per mote, it also cannot flicker as the cloud turns, and it costs nothing per
frame.

Counting is done through a uniform grid — bucket every mote by cell, then look only at the
27 cells around it. The naive version is a pairwise scan, 900 million comparisons at 30 000
motes; the grid is linear in the population and finishes in a few milliseconds at build
time. The counts are normalised against the **97th percentile** rather than the maximum, or
a single freak cluster would set the scale and flatten the effect everywhere else.

Measured by local coverage, against the same build without the term:

| | | R | G | B | luminance |
|---|---|---|---|---|---|
| sparse | without | 214.1 | 146.0 | 146.2 | 168.8 |
| | with | 213.6 | 149.7 | 149.8 | 171.0 |
| crowded | without | 200.1 | 60.4 | 64.0 | 108.2 |
| | **with** | **176.9** | 60.3 | 63.7 | **100.3** |

The sparse end is untouched and the crowded end drops 23 points in the red channel itself —
the effect lands where the motes are packed and nowhere else.

`deepen` is the amount, `deepenBias` the curve (under 1 spreads it into the mid-densities),
`deepenSat` keeps the core going richer rather than merely grey, and `densityRadius` sets
what counts as a neighbourhood.

## Where the motes sit

The reference does **not** sample a mesh. Its bundle carries three's `MeshSurfaceSampler`,
but nothing ever constructs one — it is a dead import. What it actually does is sample
**maps**:

- throw a uniform random `(x, y)` at the frame;
- read a **depth map** and the source image there, and reject the throw if either is under
  threshold (`depthThreshold` 0.3, `brightnessThreshold` 0.02), up to 10 attempts;
- after 10, keep the throw wherever it landed;
- lift the mote out of the plane by what the depth map said: `z = (depth - 0.5) *
  depthDisplacement`;
- size it from the **normal map**'s z, so the size response follows the surface.

So the cloud is one surface seen from the front — a relief, not a solid — and the mask that
cuts its silhouette out of the frame is just the depth map's zero background.

ver5 does exactly that, over maps **rasterised from `Corner.fbx` at load**. The mesh is
z-buffered into a depth map and a normal map (`mapResolution`, 256), the background stays
zero and becomes the mask for free, and the sampling loop above then runs unchanged. The
model is a flattened lens, so `modelRotX` lays its thin axis into depth and turns the broad
face toward the camera.

Two constants could not be copied as numbers:

- **`normalInfluence` is 3, not their 30.** The multiplier at the rim is `1 + 0.25 * this`.
  Theirs multiplies a size draw that tops out at 2x; ours multiplies a heavy tail that
  already reaches 12x. Copying 30 gives motes the size of the cloud.
- **`depthDisplacement` is 0.30, not their 0.27** — the same ratio, since theirs is 0.27 over
  a plane 0.9 wide and ours is expressed in plane widths.

**Why throw-and-test rather than walking the triangles.** Area-weighted sampling over the
surface is the obvious way to scatter on a mesh, and it is the wrong one here: it makes
density uniform per unit of SURFACE, so wherever the surface turns away from the camera the
motes crowd — and that is the rim, which is exactly where the eye reads the silhouette.
Throwing at the frame makes density uniform per unit of *projected* area, which is the area
being looked at.

### The loose motes

The reference runs a **second** particle system: 8000 motes alongside the portrait's 40 000,
with `depthThreshold: 0` and `brightnessThreshold: 0` — unmasked, drifting hard, displaced
deeper. Without them, the mask's edge is the edge of the effect, and a mask edge is a cut
line.

`strayFraction` (0.17, their ratio) is that second system folded into this one. Theirs are
spread flat across the frame, where a rectangle gives nothing away because it *is* the
frame; ours would show one, so the loose motes are drawn from a Gaussian about the centre of
the mass — density falls off smoothly forever, with no boundary to find. `strayReach` sets
the deviation, in plane widths.

Measured at the same frame, with the pointer away: footprint **410 → 545** four-pixel cells
with the loose layer in, against ver4's unbounded draw at 795. Tighter than ver4 by design —
the mass now has an outline — while keeping the dissolve at its edge.

### Clumping

Seats are still rejection-sampled against a low-frequency value-noise field, so motes gather
in some places and thin out in others. The reference has no equivalent: its unevenness comes
from the photograph it samples, and ours has to be put in by hand. `shapeNoise` is the
amount (0.35, lowered from ver4's 0.62 now that the model supplies the shape),
`shapeNoiseScale` the feature size, `?noise=<0..1>` the override.

### Re-baking the model

`MESH_B64` is `Corner.fbx` triangulated and quantised to 16 bits per axis — a 46-micron step
over a 3-unit model, far under the smallest mote. To swap the model, re-run the bake and
paste the new constant; nothing else in the file knows which model it is.

## What makes it read as a volume

Four things, in rough order of how much they matter. Any one of them missing and the cloud
flattens into a decal however correct the others are.

**Few and large, not many and small.** At 15–40 px you read the shading and the sphere
becomes an object sitting at a distance; at 4 px it is a dot, and a field of dots is flat no
matter how deep the box is. `sizeVariation` is deliberately wide (4.0) so
near and far motes differ several times over in apparent size — that spread *is* the depth
cue. Under about 2 the cloud goes flat.

**Depth.** ver4 filled a cube, and could rely on it. ver5 seats its motes on a relief that
is shallow by construction, so the depth cues lean harder on `depthDisplacement`, on the
loose motes (drawn in all three axes, so they carry real depth around the mass) and on the
sway. If the cloud starts reading as a decal, `depthDisplacement` is the dial — the
reference's own ratio is the floor, not a ceiling.

**Parallax.** The whole volume sways slowly in yaw and pitch, on two different periods so
the pair never repeats. With a fixed camera this is the only thing that makes near motes
travel further across the frame than far ones, and motion parallax is a stronger depth cue
than either size or shading.

**Aerial perspective.** Motes toward the back are thinned and dimmed against the front.
Depth is measured in view space against the volume's own centre, so the ramp stays put
while the cloud yaws. The span it normalises against is the depth the seats actually came
out occupying, taken at the 97th percentile — the box's own depth would leave the whole
masked mass sitting in the first tenth of the ramp, and the raw maximum would let one stray
in the Gaussian's tail set the scale — measured in local space it would swing round with the rotation, and
against raw view z every mote is ~10 units from the camera, the ratio saturates and the
whole cloud gets the same value.

On top of those, motes are drawn **back to front**. Transparency is order-dependent, and at
this size they overlap constantly: drawn in creation order a far sphere composites over a
near one and the volume reads as a sheet of stickers. The sort runs on the seat positions
(the final ones only exist in the vertex shader) every fourth frame, which is ample for how
slowly the volume turns.

## Movement

Everything is solved in the vertex shader on instanced quads — no simulation buffer and no
per-frame CPU work beyond the pointer ray and the sort.

**Curl noise** drives it. The velocity field is the curl of a vector potential, and since
`div(curl A) = 0` it cannot compress or thin the cloud: motes swirl indefinitely without
clumping or leaving bald patches. Simplex noise with analytic derivatives, which is what
makes it affordable — a curl needs gradients, and finite differences would cost six extra
noise evaluations per sample.

**Travel and curl are exclusive.** A mote either drifts or swirls, never both — a moving
mote's curl is multiplied out. `floatingParticles` is the split: some rise and recycle on a
5-second loop, fading over the last 30% so the wrap is invisible; the rest sit and shimmer.

## The cursor

Two responses, composed rather than competing.

**The push** measures each mote against its distance to the *ray* from the camera through
the pointer, so the cloud opens as a tube through its whole depth rather than at a single
z. `mouseRadius` is 0.050, down from 0.155: the cleared core measures about 12 px where it
was about 45 px. Inside the radius a mote is driven straight off the ray on a `pow(1 - d/r, falloffPower)`
falloff, with its curl amplified so the opening boils instead of sliding apart.

**The bloom** grows the whole volume out of the screen corner while the pointer is near it.
It scales about the *corner*, not the cloud's own centre — about the centre the near edge
advances on the corner and crosses it, which reads as the patch sliding rather than
spilling. It is applied to the resting seat before curl and push, so the cloud grows *and*
the pointer still opens a hole inside the grown cloud.

Measured, pointer held on the cloud versus absent:

| | motes | footprint | median reach from corner |
|---|---|---|---|
| resting | 9261 | 11 648 px | — |
| hovered | 12 834 | 19 216 px | — |

Footprint is the screen area actually covered (4 px cells touched) — ×1.65 on hover.

## Gotchas

- **`mouseRadius`, `mouseStrength` and the box are fractions of viewport height**, not world
  units, so everything holds its size on screen at any window.
- **`mouseCurlBoost` fights the push.** It scatters motes back into the hole the push just
  made; over about 3 it closes the opening completely.
- **`expandHoverInner` must cover the resting cloud's extent.** Hover strength is measured
  from the cloud's centre, and for a corner cloud that centre *is* the corner — the pointer
  can only approach from inside the frame and never gets near zero. Without the plateau,
  hovering the particles themselves reaches about two thirds of full.
- **Do not push the anchor past the corner.** Most of the cloud ends up off-screen, the
  bloom grows out of frame, and the open state lands about 30% short.
- **`boxDepth` and `expandAmount` are paired with the rest of the box.** The box is 60% of
  the size the cloud reaches open, and `expandAmount` (0.667) is the trip back. Resize one
  without the other and the open size moves.
- **At `particleSize` under about 2 the sphere shading stops paying for itself.** A mote
  is then 1–4 px and the key/fill/rim/specular rig is below what the eye can resolve — the
  cloud is a fine spray, which is a fine look, but it is not the lighting doing the work.
  The shading starts to read again around 2.5.
- **30 000 motes is the top of the range and it is not free.** In the software-rendered
  harness it averages 395 ms a frame against 151 ms at 14 000 — still linear, still not
  representative of a real GPU, but it does mean quantity is the control that decides
  whether this runs well. Check it on real hardware before shipping.
- **Cost is linear in `particleCount`**, with no fixed overhead worth speaking of: measured
  26 / 79 / 151 ms per frame at 2000 / 7000 / 14 000. Those numbers come from a headless
  SwiftShader context, which rasterises on the CPU, so they are not what real hardware
  does — but the SHAPE is, and it means quantity is the one control that can make this
  expensive. The work is per mote and mostly per fragment: branching the curl noise around
  the third of motes that discard it saved only 1.5%.
- **`fresnelPower` and `rim` are easy to overdo.** At a low power the rim spreads over most
  of the disc, washes the body out and leaves a small saturated core — the spheres read as
  pale rings with a coloured eye rather than as balls. Keep the rim on the actual edge.
- **Resizing is a square-root job.** Coverage is an area, so covering twice the ground is
  ×1.414 on every length, not ×2. `particleCount` tracks the same square — motes per
  *projected* area — so scaling it by the volume comes out thicker as well as bigger.
  `particleSize` is the exception and must not scale, or it reads as a zoom.

## Dev-only

`_shot.html` and `scripts/shot_server.py` are the headless render harness. Chrome's
`--screenshot` never fires on a page whose rAF loop does not end, so the harness serves the
folder, drives a synthetic cursor and POSTs `canvas.toDataURL()` back:

```
python scripts/shot_server.py "_shot.html?cursor=0.955,0.07" --out _shots/x --at 300 --port 8099
```

Neither ships. Note the cloud is seeded with unseeded `Math.random()`, so no two loads are
identical — measure distributions, not frame diffs.

When editing the GLSL by string replacement, anchor on text unique to one shader. The
vertex and fragment sources share whole blocks verbatim, and a replacement that matches both
will happily give the fragment a new varying without its uniforms — which WebGL reports only
as `VALIDATE_STATUS false`, with no line and no name.
