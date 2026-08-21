# PTSVer11 — corner particle cloud, under a label

A volume of drifting, curling lit spheres wedged into the top-right corner. It opens a hole
around the cursor and blooms outward when the pointer reaches it.

ver9 settles the cloud onto the wall it stands on: at the fringe, where the mass breaks into
isolated motes, each one takes the colour of the ground behind it. See
[The cloud meets the wall](#the-cloud-meets-the-wall).

ver10 rebuilt the weather from measurements of the client's ink clip. ver11 rebuilds what
the weather acts *on*: position is simulation state now, carried in a float texture and
advanced once per frame, which is the only way a filament can exist. See
[Position is state](#position-is-state) and
[The field, measured against the reference](#the-field-measured-against-the-reference).

Where ver4 grew its shape out of noise, ver5 took it from `Corner.fbx` and its sampling
method from the reference site. ver6 adds the two things the client clips asked for: the
motes gather along **threads** instead of spreading evenly, and each one carries its own
slightly irregular outline instead of being a perfect circle.

Serve over HTTP — it will not run from `file://`:

```
python -m http.server 8000     # then open http://localhost:8000/
```

### The wall behind it

The background is `immersiveg/ver20`'s, carried over so the cloud can be judged against the
surface it will actually sit on rather than against a flat swatch. The shader is verbatim: the
same flat base, the same plaster texture read off the green channel, the same off-centre
gradient with noise on the lookup to stop it banding, and the same 0.6/0.4 lift at the end,
under ver20's own constants — texture 1.0, gradient 0.17, brightness 1.1.

It is a full-screen quad drawn before the motes with depth off, **not** a page background,
because it has to be inside the frame the bloom composites: a wall painted underneath the
canvas by CSS would sit under the glow rather than behind it.

This is the one thing that stops the build being a transparent overlay — the canvas is now
opaque. `?bg=0` turns the wall off and hands the page back its own background, which is the
mode to ship in when this drops onto the real site. The wall costs one texture,
`assets/plaster.jpg`, so this version is three files rather than two.

`index.html` + `main.js` is still the whole thing — the model ships inside `main.js` as a
quantised triangle soup, so there are no textures, no assets and nothing to fetch. The
canvas is transparent and draws no background of its own, so it drops over an existing page
as an overlay; the grey here is only a stand-in.

## The cloud meets the wall

The mass is a saturated red standing on a near-neutral wall, and at its edge it breaks into
isolated motes. Those two facts together are what made ver8 read as something laid **on** the
page rather than as part of it: a scatter of high-chroma dots on a low-chroma ground, at its
most conspicuous exactly where the cloud is weakest — on the few motes that have nothing
around them to belong to.

So at the fringe a mote takes the colour of the ground behind it.

The driver is the mote's **own crowding**, the same number the deepening runs on. That puts
the whole colour ramp on one reading of how much company a mote has: the ground where it
stands alone, the body colour where it has some, the deep colour in the packed middle.
Crowding is counted once at build time and travels with the mote as an attribute, so nothing
here flickers as the cloud turns and nothing costs anything per frame.

| | writes | default |
|---|---|---|
| ground blend | `CONFIG.ground` | 0.70 — how far the loneliest motes go toward the wall |
| ground fade | `CONFIG.groundFade` | 0.15 — alpha those same motes also lose |
| — | `CONFIG.groundBias` | 2.5 — the curve that decides which motes count as lonely |
| — | `CONFIG.groundR/G/B` | 0.748 neutral — the wall itself |

`?ground=` and `?gfade=` set the first two without the panel. `ground` at 0 is ver8 exactly.

Measured on the same cursor path, in `R - max(G, B)` and banded by distance from the corner:

| band | px over 25, ver8 | ver9 | mean redness, ver8 | ver9 |
|---|---|---|---|---|
| core, 0–60 px | 2598 | 2123 | 110.9 | 58.2 |
| body, 60–120 px | 6278 | 5211 | 91.5 | 49.7 |
| **fringe, 120–260 px** | **829** | **122** | **55.4** | **17.4** |

The fringe loses 85% of its red pixels while the core keeps a peak of 142 — which is the
shape of the change that was wanted. The core softens too, and that is overdraw rather than a
miss: the cloud is a translucent stack tens of motes deep, so a neutralised mote drawn in
front of a red one dilutes it.

### Three things about it that are not obvious

**The ground colour is linear.** The renderer encodes to sRGB on output, so the wall that
measures 224/255 in a render is 0.748 in the shader — a colour picked off a screenshot and
pasted in would come out a full stop too bright. Measured on the wall behind the cloud's own
corner, where it comes out neutral to three decimals.

**The blend goes on the finished colour, not on the body colour.** Mixed into the body it is
a tint that the rim and the highlight are then added on top of, so a fringe mote comes out a
pale bead wearing a bright outline — *more* conspicuous against the wall than the red one
was. Mixed in last it takes the mote entire, shading included, and the mote goes to the wall
as an object.

**`groundBias` has to be well above 1.** The crowding histogram is bimodal — half the
population sits under 0.15 and a quarter is at 0.94 or more — so on a gentle curve the median
mote still blends most of the way, and the result is a smudge with the grain gone out of it.
At 1.5 and strength 0.8 the individual motes stopped being visible at all; 2.5 pulls the blend
back onto the outliers, which is where the problem was.

`groundFade` is small for the same reason. Colour alone leaves the fringe as pale but still
solid discs, which reads as a second, grey cloud around the red one — but past about 0.3 the
scatter stops being made of individual motes.

## Position is state

Every version up to ver10 solved a particle's place as a pure function of the clock: take
the seat, add a displacement read out of a noise field, draw. Nothing was remembered between
frames. That is a real virtue — no simulation to go wrong, no state to reset, the position of
any particle at any time computable from scratch — and it is also why none of those versions
could look like the reference however they were tuned.

**A filament is a history.** The flow stretches a patch of particles into a sheet and then
folds the sheet, and the fold is there only because the particles went *around* the eddy
rather than being offset by it. A cloud with no memory has no history to fold. ver10 matched
the reference's field statistics — eddy size, divergence, coherence, pace — and still came out
a mottled patch, because matching the field is not the same as integrating along it.

So ver11 keeps a **simulation buffer**: one texel per particle in a float render target,
ping-ponged, holding the particle's offset from its seat and its age. Once a frame:

```
offset += fieldVelocity(seat + offset) * dt
age    += dt
if (age >= lifespan) { offset = 0; age = 0; }
```

Three details in that are worth stating, because each was a decision:

**The field is read at the particle's real position, not at its seat.** At the seat, every
particle in a filament is pushed by the field where it *started*, so the filament translates
rigidly instead of stretching — and stretching is the entire effect.

**What is stored is the offset, not the absolute position.** Offsets are small numbers, so the
buffer spends its precision where the precision is needed. It also means the fallback works: on
a device that will only give half-float targets, an absolute position's smallest representable
step near the cloud's own coordinates is larger than one frame's movement at this pace, and the
cloud would simply never start.

**Death returns a particle to its seat.** The seats still come from the model, so the
silhouette is what the cloud is continuously *fed from* rather than what it looks like. That is
what holds the envelope still while everything inside it moves.

### The bloom

The second reference clip is a far bigger event than the first: its radius **doubles** over six
seconds, 73.7 px to 147.7, growing 32 px/s at half a second and 0.4 px/s by seven, while the
whole mass slides 125 px left and 72 px down. What is left afterwards barely moves — the
field's own speed falls from 2.1% of the mass radius per second to 0.7% and is still falling.

Every particle starts at its seat with age zero, so the seconds after load **are** the bloom.
There is no separate intro animation; it is the simulation running from its initial condition.

**The impulse is keyed to a particle's own age, not to the page clock, and that is the decision
that makes it work rather than merely start well.** On the page clock the burst is a one-off:
it happens, the cloud reaches its size, and every particle that respawns afterwards crawls out
on the field alone, so the envelope collapses back to whatever the field can reach in a
lifespan. On the age clock every particle blooms when it is born, which makes the large
envelope a **steady state** — and because the whole population starts at age zero, the same
mechanism still produces one coherent arrival at load.

Lifespans are drawn per particle (`simLifeSpread`), and the spread has to be wide. At 0.45 the
first cohort's deaths all fall inside one four-second window and the cloud measurably thins
once, seven seconds after load. At 0.85 they are smeared over twelve seconds and there is
nothing to see.

**`launchBurst` cannot simply be raised to match the reference's doubling.** Past about 0.8 the
cloud **hollows**: every particle is leaving the centre at once and they pile up against the
decaying impulse at a front, so the mass becomes a ring with a hole where the ink should be
thickest. Measured as the ratio of ink inside 0.4 of the radius to ink in the 0.6–1.0 annulus,
the reference sits at 1.34; at burst 1.20 this build fell to 0.62. It is set together with
`simLife`, because what refills the centre is newborns.

### What this cost

The depth sort is gone — it ranked motes by their seat, which was a fair stand-in while a mote
never left it, and now says only where a particle was born. Crowding moved with it: `vDensity`
is a radial measure taken on the carried position rather than a neighbour count taken on the
seat, because after a few seconds of travel the seat's count is the wrong answer for both the
deepening and the blend into the wall.

## The field, measured against the reference

The client's clip is a granular ink plume — a dense clump that unfurls, spreads and then
settles into a slow churn. Everything below was measured off it with dense optical flow over
193 frames, and every constant it names was set from those numbers rather than by eye.

Four quantities describe the reference's weather, all normalised by the mass's own radius so
they transfer to a cloud of any size:

| | reference | ver9 | **ver10** |
|---|---|---|---|
| eddy size, as % of mass radius | 13–20 | 45 | **25** |
| speed, mean, % of mass radius per second | 3.0–3.5 | 11.8 | **5.4** |
| speed, 90th percentile | 7.7–9.7 | 17.9 | **9.7** |
| vorticity ÷ divergence | 0.76–0.99 | — | **0.79** |

### The field has to spread, not only swirl

A curl noise is divergence-free by construction: the volume it carries is conserved, so the
field can shear, fold and braid but no patch of it ever spreads. Measured on the reference,
divergence and vorticity are the same size right through the clip — it expands as much as it
turns, which is the difference between ink and a whirlpool, and no amount of curl reaches it.

`CONFIG.curlDivergence` mixes in the **gradient** of a fourth, decorrelated noise. A gradient
is curl-free and purely divergent, so it is the clean complement: 0 is the old field, 1 puts
the two at equal rms. The 0.707 inside `curlNoise` is what makes "equal" true — a curl
component is the difference of two independent derivative components and carries twice their
variance, where a gradient component is one of them.

### The eddies were bigger than the cloud

`curlFrequency` was 3.0, which put the field's correlation length at 45% of the mass radius —
eddies larger than the thing they were supposed to be curling, so nothing in the cloud ever
folded. The reference runs at 13–20%. Now 9.0.

### The camera sway was the largest velocity in the frame

`parallaxAmount` was 0.30 radians of yaw on a 19-second period. The sway is a rigid
translation of the whole mass and it scales with the cloud's distance from the origin, so at
that amplitude it moved the cloud faster than the cloud moved itself: the mass read as being
carried about rather than as moving under its own weather, and the reference has no camera
move in it at all. Now 0.08, with the tilt cut to match. It is still the depth cue — that is
why it is not zero.

### Pace

`CONFIG.speed` 0.81 → 0.15. It scales the clock the motes are read from rather than any one
of their speeds, so it is the right dial for a uniform slow-down: the character of the motion
survives it. `?speed=` overrides live if the ink wants to be livelier than the reference.

### Palette

Read off the reference's own pixels rather than picked. The second clip's thick ink lands on
RGB(135, 69, 71) and its deepest folds on RGB(74, 20, 23) — a **wine red, and not a warm one**:
blue sits a shade above green all the way through, where the first clip had it a shade below.
That single difference is most of what separates this crimson from a terracotta.

**The core's density is the one thing still short of it.** The reference is very nearly opaque
in its folds; a cloud of shaded, part-transparent spheres over a light wall bottoms out around
RGB(150, 120, 120) however much colour, opacity or count goes in, because fill, rim and
specular all add light after the colour pipeline and put a floor under it. Three attempts at
closing it are recorded in the constants: flattening the sphere rig desaturates the mass to
grey, and `solidity` at 0.65 fills the cloud in as a flat slab and destroys the filaments that
are the whole point of the simulation. Closing it properly means a different compositing path —
accumulating density into a buffer and colour-mapping it, the way these dye renders are
actually made — rather than stacking lit sprites.

### What is still not the reference

The reference's mass is built out of long curling **filaments**, and ver10's is not — it is a
finer, slower, warmer version of the same mottled patch. The cause is structural rather than a
setting: in the clip the shape **is** the flow's history, filaments being streaklines laid
down over many seconds of advection, where here the shape comes from the model silhouette and
a mote only ever takes a short excursion from its seat. Three attempts to reach it by turning
up the existing strand system are recorded in the constants' own comments; the honest summary
is that few-and-long threads coil into blobs at this flow scale, and many-and-short ones fill
in solid.

The reference plume is also about twice this cloud's size relative to the frame — mass radius
11.6% of the viewport height against 5.8% here — and its stateliness is partly that size.
`?scale=` reaches it, but the framing needs work to go with it: at 3.6 most of the mass falls
off the corner.

### Measuring any of this

`?tstep=<seconds>` replaces the wall clock with a fixed frame step. Under a software renderer
a frame takes about a second of real time, so two captured frames are a second of *motion*
apart and any flow measured between them is meaningless; with this set, captured frame N is at
exactly N × tstep whatever the machine is doing. Every number in this section was taken with
`?tstep=0.0416667` and frames 2 apart, matching the reference's own 1/12 s pairing.

`?cf=` `?div=` `?cs=` `?px=` `?speed=` `?drift=` `?lsec=` `?sfs=` reach the field's constants
without an edit.

## Controls

None. The panel is gone and every value is a `CONFIG` default; the query switches below still
reach the ones worth sweeping without it.

Everything else is settled and lives in `CONFIG`, the field's overall `opacity` included —
`?op=` still reaches it without the panel.

**Solidity** is what the cloud's transparency is spent on. Every mote's alpha is built from its shading, its
place in its own life and its depth in the volume, so most of the population is drawn part-way
transparent — which is what makes the cloud read as washed out rather than as a lot of small
solid things. At 1 that alpha stops tinting the mote and starts deciding whether it is drawn
at all: a mote whose alpha would have been 0.3 is drawn at **full strength** three times in
ten, and not at all the rest. The cloud thins by losing motes instead of by fading every one
of them.

Measured on the same frame:

| | lit pixels | mean alpha | part-transparent px | fully opaque px |
|---|---|---|---|---|
| `solidity` 0 | 8021 | 155 | 4772 | 1289 |
| `solidity` 1 | 4768 | **255** | **0** | 4768 |

At 1 there is no semi-transparency left anywhere in the frame — every drawn pixel is at full
colour, and roughly four in ten motes are simply gone.

The threshold is the mote's **own** number, decorrelated from the seed its outline uses so
the two do not agree, and it does not change from frame to frame. That is what stops it
flickering: a mote fades in over its life until it crosses its own threshold, appears at full
colour, and goes again on the way down.

Nothing rebuilds — all three are uniforms, so they are smooth to drag. `?op=`, `?solid=`,
`?ground=` and `?gfade=` set them without the panel; `?ui=0` hides it.

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

The ground the fringe blends into moves with the page, so `groundR/G/B` goes to a near-black
with a blue lean: the cloud sits in the upper-right corner, which on this ground is the black
end of the left-to-right gradient — the blue light rises from the bottom centre and never
reaches it.

## Threads

`Ref1.mov` and `Ref2.mov` are not showing an even scatter. Their motes gather along thin
curved sheets, with loose scatter between, and the creases where those sheets fold are the
darkest thing in frame. No amount of tuning an even distribution produces that, because the
structure is not a density gradient — it is a set of lines.

Measured off `Ref1.mov`, the envelope is genuinely **stationary**: after it forms at ~8 s the
centroid holds at 1005 ± 10 px and the spread at 252 ± 8 px on a 1920-wide frame, while ~31%
of the ink changes between frames sampled 10 apart. Fixed outside, churning inside.

So a share of the population is laid along flow lines: a strand starts at an ordinary seat
and walks a static noise field, dropping a mote at every step. Motes that start near each
other follow the same curve and end up threaded along it, and the field folds those threads
past one another on its own. All of it happens at **build time** — what reaches the shader is
the same seat array as before, and nothing here costs a frame.

| | |
|---|---|
| `strandFraction` | share of motes belonging to threads (0.55) |
| `strandLength` | motes per strand (150) — i.e. how FEW threads there are |
| `strandStep` | spacing along a thread, in plane widths |
| `strandJitter` | lateral scatter, which is what gives a thread thickness |
| `strandFlowScale` | features per plane width in the field they walk |

`?strand=<0..1>` overrides the share; `?strand=0` is ver5's scatter exactly.

### Where the threads lie

Measured on Ref2, the filaments are neither parallel nor arbitrary: they hold a common
diagonal, concentration **R = 0.54** on a scale where 0 is an isotropic tangle and 1 is a
comb. `strandBias` and `strandBiasAngle` add a constant vector to the field's own direction
before it is normalised, which is what produces a broad band of one heading.

Ref2 also sets the thread's build: at a matched scale its filaments run about **14 px thick
against 66 px of gap**, a ratio near 5. Ours were a single mote wide — nearer a two-hundredth
of the gap, a drawn wire rather than a rope of particles — so `strandJitter` went up.

It cannot go up on its own, and that is the trap here: lateral spread has to be paid for with
motes per unit length, or the thread stops being a line and becomes a vague cloud. At
`strandJitter` 0.012 with the spacing unchanged the structure dissolved outright. Thickness
and `strandStep` move together, and the real ceiling is the population: 16 500 strand motes
over ~110 threads is 150 each, where the reference has orders of magnitude more. Ropes as
solid as Ref1's want a higher `particleCount`, not a wider jitter.

### The field is a sum of sines, in two languages

The strands are laid out on the CPU and travelled along in the vertex shader, so both halves
must agree on the field exactly. A hashed value noise cannot do that: its hash multiplies by
43 758 before taking a fraction, so the last bit of a double on the CPU becomes a completely
different value in a GPU float, and the motes would stream off the threads they were laid on.
A sum of sines has no such cliff — every term is a sine of a moderate argument, both sides
agree to about a millionth, and the field is smooth so a millionth stays a millionth.

The shader integrates from the SEAT every frame, in six fixed hops, rather than from last
frame's position. That is what lets a mote follow a curving thread with no simulation state
at all: its position stays a pure function of the clock.

### Five rays thrown out of the corner

The threads above all start from seats inside the silhouette and wander wherever the field
takes them. `extraStrands` adds five more that do something different: they start **at** the
corner and travel away from it, so each reads as a ray thrown out of the corner rather than a
thread that happens to be near it. `extraStrandOutward` is how hard they lean away as they
walk — 0 leaves them wandering like any other thread, and at 1.6 the flow only curves a path
that is already leaving.

Three details each fixed a way this failed to read:

- **A ray that reaches the end is finished**, and the next starts back at the corner. Turning
  it back was right when these wandered; for a thread that is meant to be leaving, a return
  trip reads as the ray folding over itself.
- **Each ray gets its own reach.** With one shared limit every ray stopped at the same radius
  and their tips lined up into an arc around the corner — a band, which is the opposite of
  rays thrown out of one.
- **The shader travels the same leaned path.** These motes advect along their own thread, and
  a thread built with an outward push has to be travelled with the same push, or the motes
  walk off it inside one life. The push is carried to the vertex shader as an attribute, so
  only the rays get it.

### Two or three of them are not the model's

The threads above all start from seats inside the silhouette, so they read as the mass's own
grain. `extraStrands` adds a few more — three by default — seeded at random out in the corner
and held to a box there rather than to the model. They walk the same field, so they belong to
the same weather, but their placement **re-rolls on every load**: the mass is fixed by the
model, and this is the part that is different each time.

They needed their own build, and it took three passes:

- **Their own budget.** At a model strand's 150 motes they simply joined the texture — one
  line in thirty thousand motes is not a line, it is noise. They get 900 each, packed at
  `extraStrandStep`, about half a pixel apart, so each reads as a gathering rather than a
  row of dots. `extraStrandJitter` spreads them sideways into a rope; the tight packing along
  the path is what pays for that spread.
- **Their own box.** At 0.7 plane widths the box was shorter than the path a strand walks, so
  each doubled back inside it and came out a clump.
- **But not a box wider than the effect.** Opening it to 1.2 fixed the clumping and created a
  worse problem: a thread could wander well past the mass and sit alone on the page, reading
  as a stray line rather than as part of the cloud. At **0.60** the box is inside the cloud's
  own footprint — measured, the strands reach 175 px from the corner at the 99th percentile
  where the whole cloud reaches 180 px.

There are **four** of them now, and getting them to read as four took two corrections.

Finer noise features let strands part company instead of converging — but there is a ceiling,
found the hard way: at `strandFlowScale` 8.0 the field turns so tightly that a strand coils
in place instead of travelling, and four sweeping lines became four compact clumps. 5.6 is
the working value.

Most of the convergence was not the feature size at all, it was the shared **lean**:
`strandBias` came down from 0.45 to 0.22, which lets each thread take its own heading while
the mass keeps a grain. Between that and `extraStrandSize`, three or four now read as
separate arcs at any moment.

**Each strand takes its own slice of the corner.** Seeding all three from the same crowded
draw is what left only one of them visible: three threads starting within a few pixels of
each other, walking the same field from nearly the same place, draw nearly the same line on
top of each other. Each now gets its own share of the quarter turn around the corner
(`extraStrands` divides it), with `extraStrandInner` keeping the seed off the corner itself,
so the count asked for is the count seen.

Two settings put the particles where they belong rather than merely inside the box.
`extraStrandBunch` is a power on the seed draw, crowding the threads toward the corner while
leaving the box where it is; `extraStrandHome` is the point a thread turns back toward when
it meets a wall — deliberately *near* the corner rather than on it, because a thread aimed
dead at the corner slides along the screen edge and draws a rim.

### The mass had to grow to show them

A thread needs room to be read as a thread. The box doubles on every length against ver5,
which is **four times the coverage**, and the mote size goes 0.4 → 0.6.

The population is now **60 000**, doubled to give the corner strands enough motes to read as
separate gatherings while the mass keeps its body.

That is not free, and the cost is worth knowing: under the software rasteriser the headless
harness uses, one frame goes from **0.58 s at 30 000 to 1.00 s at 60 000** — the drawing cost
tracks the population almost directly, so this is not a rounding error hiding behind the
bloom passes. A real GPU is a different regime and 60 000 instanced quads is routine there,
but that has not been measured here, only reasoned about. If it stutters on the target
machine, `?p=<n>` changes it without a rebuild and the quantity bar runs down to 14 000.

Two constants travel with the box and are not free to stay behind:

- **`expandHoverInner`** doubles with it. The plateau has to cover the resting cloud's own
  extent, because hover strength is measured from the cloud's centre and for a corner cloud
  that centre is the corner — left at ver5's value the pointer could never get inside a mass
  this size, and the bloom would top out part way, which is the ver1 failure exactly.
- **`densityRadius`** scales too. Crowding is counted in a neighbourhood; hold the
  neighbourhood fixed while the mass spreads and the count inside it collapses, taking the
  colour deepening with it.

**Three things had to be got wrong first**, and each one is a lesson worth keeping:

- **The direction field cannot be a normalised curl.** A curl is the right instinct — it
  swirls, and unlike a gradient it has no sinks for every strand to drain into. But its
  magnitude passes through zero along whole surfaces, and a normalised direction is
  meaningless where the magnitude vanishes: the walk turns to noise, reverses into itself
  and stops, dumping its remaining motes on one spot. The render came out as scatter with a
  dozen hard blobs in it. An **angle field** — noise read as a heading and a tilt — is unit
  length everywhere by construction and cannot degenerate.
- **Long and few, not short and many.** The first pass used 34 motes per strand, which is
  about 550 threads over one small mass; they cancel out into exactly the scatter they were
  meant to replace.
- **A strand must turn back at the silhouette, not end there.** A walk leaves this shape
  within a few dozen steps, so ending it there killed every strand young. Turning back keeps
  it alive for its whole length and folds it against the boundary — which is where the
  reference's creases are densest too. The turn has to clear the boundary by two steps: one
  leaves the walk sitting on the edge, exiting again every step, laying the rest of its
  motes along the rim.

## Motes live and die

In the reference the motes are not permanent fixtures. They swell out of the threads, travel
a little way off them and vanish, and others take their place — which is what lets the mass
churn while its outline stays put. A cloud of permanent motes can only slide its motes
around; it cannot do that.

Each mote runs its own birth-to-death on a loop, phased off its own seed, so the population
is spread right across the cycle and there is never a frame where all of it is young or all
of it is dying. There is no spawner and nothing is allocated: a mote's life is a function of
the clock, like everything else here.

| | |
|---|---|
| `lifeSeconds` | one full birth-to-death (6.0) |
| `lifeGrow` | share of the life spent swelling in (0.12) |
| `lifeFadeStart` | where it starts shrinking away (0.68) |
| `lifeDrift` | how far it travels along the flow over one life, in plane widths |
| `lifeFraction` | share of motes that cycle at all (1.0) |

`?life=0` turns the turnover off and returns every mote to permanent.

**The envelope has to drive alpha as well as size.** On size alone a dying mote shrinks
below `minPx`, at which point the sub-pixel guard inflates it back up and holds it on screen
at full opacity — so it would never actually go away.

**Motes travel ALONG their thread.** This was got backwards first, on the theory that moving
along a thread would drag the thread with it, so the first pass moved them across it. Dense
optical flow on Ref1 settles it: **97.8% of the motion runs along the filaments**, mean |cos|
0.974 over 27 000 samples. A crease is a *streamline* — motes stream down it while the line
itself stays exactly where it is, because the mote leaving a point is replaced by the one
behind it arriving. Nothing has to be held still for the structure to persist.

That also removed a trade the previous pass was stuck with. Travel across the thread had to
be kept tiny and most of the population left permanent, or the motes drawing the line
wandered off it and the structure dissolved. Travelling along the flow, `lifeFraction` goes to
**1.0** — every mote lives, dies and moves — and the threads still hold.

### Measured, ours against theirs

| | ours | reference |
|---|---|---|
| motion along the filament | 0.999, 100% of samples | 0.974, 97.8% (Ref1) |
| speed | 4.7% of the plane width per second | ~39% of the mass radius per second (Ref1) |
| flow field steadiness | steady, evolving only with the sway | 0.71 direction correlation over 1.6 s (Ref1) |

Ours is deliberately slower. At the reference's rate the threads read as a smear at this
size — `lifeDrift` is the dial if the customer wants it faster.

The orientation of our own structure could not be measured the same way: a structure tensor
needs continuous ink, and a field of discrete motes leaves it with a few dozen usable
samples, at which point it reports whatever it likes. The reference numbers are solid
(n = 27 000); ours is set against them by eye.

## Motes are not perfect circles

`blob` rolls each mote's outline in and out with two low harmonics of the angle, phased off
the mote's own seed, so every one gets a different lumpy round shape. It is smooth in angle
by construction, so a mote can dent and swell but can never acquire a corner — the ask was
less perfect, not less round.

The shading normal is remapped onto the outline the mote actually has, so a dented mote is
lit as a dented ball rather than as a circle with a piece missing: the highlight and the rim
both follow the dent.

The perturbation only ever **removes** radius. The quad is sized for a unit disc, so a shape
allowed to grow past 1 would be sliced off square by the quad's own edge — which is the one
failure mode that would put corners back.

`?blob=<0..1>` previews it live. **The shipped default is 1**, the far end of the range:
0 is the exact sphere, and anything past 1 stops reading as one family of objects.

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

### Small at the edges, heavy at the corner

Two things were putting the biggest motes on the OUTSIDE, which is exactly where they are
least wanted.

`normalInfluence` swells a mote where the surface turns away from the camera — and for this
model that is the rim of the silhouette. It is the reference's own behaviour and it is
faithful, but it is wrong for this composition, so it drops from 3.0 to 0.6.

On top of that, `sizeEdge` takes the size down with distance from the corner, so the mass
carries its weight where it is dense and breaks into fine particles as it leaves. Measured on
the mass alone, the average mote area went from **1.52x** the near-corner size out at the
edges to **0.42x** — an inversion, not a nudge.

The corner strands are exempt and drawn heavier (`extraStrandSize`), because they are
deliberate features rather than part of the fade: shrunk with distance like everything else,
the one thing meant to be read as a line is the first thing to disappear. Counting everything
together the figure comes to 1.20 rather than 0.42, and that difference is entirely those
four threads.

### The label, and the mass under it

**BOOK NOW**, white, Arial bold caps, **pinned to the upper-right corner in CSS** — right 44,
top 64. That is where it has to be, so it is the fixed thing, and the cloud gathers to *it*.

That is the reverse of the first attempt, which placed the label on the focus and then had to
drag the whole mass inward to give the sign room; the cloud ended up off its corner to suit
the type. Now `buildParticles` reads the label's own bounding box, converts its centre into
the cloud's space and puts the density focus there, before a single seat is drawn.

Measured on the same frame, with and without the label present:

| | densest patch → label | alpha behind the text |
|---|---|---|
| focus left at the mass centre | 102 px | 12.8% |
| focus read from the label | **14 px** | **20.7%** |

The centroid stays about 50 px away, and that is correct rather than a miss: the drawing
extends down and left, so its *average* is not its *peak*. What sits under the sign is the
peak.

`_shot.html` carries a copy of the label for this reason — a harness without it measures a
cloud with nowhere to gather, which is exactly the wrong answer this measurement gave first
time round.

### The density peaks under the label

A **BOOK NOW** label goes over this cloud, so the motes have to be thickest where the label
is and thin out proportionally from there — not thickest wherever the model happens to be
densest.

`focusX` / `focusY` place that peak, in plane widths and heights measured from the centre of
the mass; 0,0 is the middle of the drawing, which is where the label is assumed to sit.
`focusDensity` (1.5) is how hard the population crowds toward it. The mechanism is the one
from ver6, with the peak moved off the corner and onto the focus: the *throw* is weighted, not
the accept test, because weighting the accept test spends bounded attempts and a throw that
runs out is kept wherever it last fell — past a certain strength that scatters the cloud
instead of concentrating it.

Move the label and `focusX/focusY` follow it. The whole point of them being a coordinate
rather than a switch is that nobody has to rebuild anything when the layout changes.

### The cursor's edge has no circle in it

The push is bounded by a radius, and with one radius for every mote that boundary is exact:
motes stop being pushed at precisely that distance and pile up just outside it, which draws a
clean circle on the page. No falloff curve can soften it — `falloffPower` only sets how *hard*
each mote is pushed, never *which* motes are in the set. That is why there was no config for
it to find.

`mouseEdgeBlur` gives every mote its own radius instead, seeded from the per-mote random the
outline already uses. At 0.6 a mote's radius runs from 0.4x to 1.6x the nominal one, so the
rim becomes a band as wide as that spread rather than a line.

Measured on the same frame, coverage in 8-pixel rings out from the pointer:

| | 0–8 | 8–16 | 16–24 | 24–32 | 32–40 |
|---|---|---|---|---|---|
| `mouseEdgeBlur` 0 | 0.00 | 0.00 | 0.00 | 0.03 | 0.05 |
| `mouseEdgeBlur` 0.6 | 0.00 | 0.02 | 0.01 | 0.04 | 0.03 |

The old version leaves the first 24 px *completely* empty — that emptiness, with a hard start,
is the circle people see. With the blur, motes appear from 8 px out and the density ramps, so
there is no radius at which anything changes all at once. `?blur=<0..1>` compares them live.

### The model is a drawing now

ver7 scatters on **`Corner_1.fbx`** — 2712 vertices, 5376 triangles, and unlike `Corner.fbx`
it is not a blob with a silhouette. It is three drawn strands converted to tubes, covering
**under a third** of its own bounding box. The shipped bake is the revised geometry:
2.46 x 1.13 x 2.61, near enough square seen face-on, where the first version of it was 4.50
wide and read as a landscape band. Everything below is tuned around that difference,
and three settings had to move a long way:

- **`particleCount` 60 000 → 24 000.** A shape covering a third of its box takes the same
  count three times as densely: the ribbons filled in solid and the drawing read as one red
  mass. It only reads while its motes are still separable.
- **`modelOffsetX/Y` −0.46.** The plane is centred on the group's origin and the origin is
  the screen corner, so a model left at zero has three quarters of itself off-screen. That
  was harmless for a blob — any quarter of a blob is a blob — but the quarter of *this* model
  that happened to be on screen was its dense middle, with every loop outside the frame. At
  −0.46 the drawing sits in the visible quadrant while still running off the corner.
- **Smaller, three times over.** First to 0.48 x 0.42 x 0.48 with `modelOffset` −0.32, pulling the
  drawing back toward the corner rather than sitting it out in the frame; then **40% off
  every length again**, to 0.288 x 0.252 x 0.288. Measured across the two steps: footprint
  **3565 → 2221 → 862 → 246** four-pixel cells, median distance from the corner **196 → 119 → 72 → 40
  px**. The second step is 0.60 on every length exactly, which is 0.36 of the area — worth
  keeping straight, because coverage is an area and halving what you see is a square-root
  job on the constants.
- **`particleCount` follows the area, not the request.** 24 000 → 9 000 → 3 000, because what sets
  how the drawing reads is motes per *projected area*: hold the count while the mass shrinks
  to a third and the ribbons fill in solid, which is the failure this version already had
  once. `?p=` overrides it if the mass wants more weight.
- **The hover growth, halved twice.** `expandAmount` 0.667 → 0.333 → 0.167. Measured at each step, the
  cloud's 90th-percentile reach goes 126 → 165 px when hovered, a growth of **x1.31** against
  the x1.67 the old value predicts. The pairing with the box still holds — the box is a
  fraction of the size the cloud reaches when open, and this is the trip back — but that
  fraction is now 0.75 rather than 0.6.
  `expandHoverInner`, `expandHoverRadius` and `densityRadius` all scale with the box, as they
  must: the hover plateau has to cover the resting cloud, or the pointer can never get inside
  it, and the crowding neighbourhood has to match the cloud's density or the deepening flattens.
- **`cornerDensity` 2.4 → 0.6.** Crowding motes at the corner made sense when the corner was
  the mass's own densest part. Against a drawn shape it piles them where the drawing is
  *not*, and buries it.

`strandFraction` drops to 0.22 and `extraStrands` to 0 for the same reason: both mechanisms
exist to invent threads inside a blob, and this model already is the threads. Rays walked out
of the corner on top of drawn ones read as a second, disagreeing set.

### Denser toward the corner

The model's sampler is even across its projected area, so density follows the **silhouette**
rather than the corner. Measured on the build before this one, coverage ran 0.86 in the first
forty pixels, fell to **0.55** by eighty, and rose again to 0.80 further out — that dip is
the lens shape talking, not a gradient.

`cornerDensity` crowds the population toward the corner, and **how** it does that matters.

The first version weighted the accept test — throw evenly, then reject what lands far out.
That fails in a way worth recording. Every rejected throw still costs an attempt, the
attempts are bounded, and a throw that runs out is kept wherever it last fell, which is
uniform. Past a certain strength almost every mote ran out, so turning the dial up stopped
concentrating the cloud and started scattering it: corner coverage fell from 0.98 to 0.39
while the setting was supposedly raising it.

Weighting the **throw** has no such cliff — every throw lands where it is wanted and the
strength is simply a power on the radius. Motes per 1000 px², by distance from the corner:

| | 0–40 | 40–80 | 80–120 | 120–160 | 160–200 |
|---|---|---|---|---|---|
| before | 32.6 | 30.8 | 26.4 | 20.5 | 10.3 |
| after | 33.4 | 30.5 | 29.4 | 20.2 | **6.2** |

Read it as a redistribution rather than a gain: the count is fixed, so the steeper falloff at
the outside is what pays for the weight at the corner. Note that *coverage* is a misleading
measure here — it fell while density rose, because the motes out there are now much smaller.

**This dial has less leverage than it looks like it should, and the reason is the framing.**
The concentration is radial about the corner, but the corner is the middle of the model's
plane and only the one quadrant is on screen — so three quarters of everything gathered at
the corner is gathered off-screen. Measured across `cornerDensity` 1.4, 2.2 and 3.6, the share
of drawn mass inside 80 px of the corner sat at 23.6%, 26.2% and 26.0%: the differences are
inside the run-to-run variance, since the cloud re-seeds on every load. Past about 2.4 the
setting is paying for motes nobody sees. The lever that would actually move it is the anchor —
bringing the mass in off the corner, which is a framing decision rather than a constant.

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
