# PTSVer2 — corner particle cloud

A volume of drifting, curling lit spheres wedged into the top-right corner. It opens a hole
around the cursor and blooms outward when the pointer reaches it.

Serve over HTTP — it will not run from `file://`:

```
python -m http.server 8000     # then open http://localhost:8000/
```

`index.html` + `main.js` is the whole thing — no textures, no assets, nothing to fetch. The
canvas is transparent and draws no background of its own, so it drops over an existing page
as an overlay; the grey here is only a stand-in.

## Controls

Three bars, top-left, and nothing else. Each prints the `CONFIG` value it writes so a look
found here transfers to the build by typing it in. `?ui=0` hides the panel.

| bar | writes | default |
|---|---|---|
| colour | `colorOverlayR/G/B` | `0.850 0.050 0.060` |
| quantity | `particleCount` | 4200 |
| size | `particleSize` | 2.5 |

Colour is **one** bar rather than three because the material only ever varies in hue: the
spheres are shaded in greyscale and tinted, so saturation and value belong to the lighting
rig, not to the choice of colour. The bar drives hue, holds S and V at the shipped red's,
and prints the RGB triple to paste back. Quantity re-seeds the whole population, so a drag
is coalesced into one rebuild rather than one per input event.

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

## What makes it read as a volume

Four things, in rough order of how much they matter. Any one of them missing and the cloud
flattens into a decal however correct the others are.

**Few and large, not many and small.** At 15–40 px you read the shading and the sphere
becomes an object sitting at a distance; at 4 px it is a dot, and a field of dots is flat no
matter how deep the box is. `sizeVariation` is deliberately wide (4.0) so
near and far motes differ several times over in apparent size — that spread *is* the depth
cue. Under about 2 the cloud goes flat.

**The box is a cube.** Depth is the same order as width. A shallow box puts every mote at
nearly the same distance from the camera, so perspective never separates them and no amount
of size variation or parallax recovers the volume.

**Parallax.** The whole volume sways slowly in yaw and pitch, on two different periods so
the pair never repeats. With a fixed camera this is the only thing that makes near motes
travel further across the frame than far ones, and motion parallax is a stronger depth cue
than either size or shading.

**Aerial perspective.** Motes toward the back are thinned and dimmed against the front.
Depth is measured in view space against the volume's own centre, so the ramp stays put
while the cloud yaws — measured in local space it would swing round with the rotation, and
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
z. Inside the radius a mote is driven straight off the ray on a `pow(1 - d/r, falloffPower)`
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
