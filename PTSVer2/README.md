# PTSVer2 — corner particle cloud

A volume of drifting, curling bubble sprites wedged into the top-right corner. It opens a
hole around the cursor and blooms outward when the pointer reaches it.

Serve over HTTP — it will not run from `file://`:

```
python -m http.server 8000     # then open http://localhost:8000/
```

`index.html` + `main.js` + `assets/bubbles.png` is the whole thing. No controls, no
switches: the settings in `CONFIG` are the build. The canvas is transparent and draws no
background of its own, so it drops over an existing page as an overlay — the grey here is
only a stand-in.

## What makes it read as a volume

Four things, in rough order of how much they matter. Any one of them missing and the cloud
flattens into a decal however correct the others are.

**Few and large, not many and small.** A mote is a shaded sphere. At 15–40 px you read the
shading and it becomes an object sitting at a distance; at 4 px it is a dot, and a field of
dots is flat no matter how deep the box is. `sizeVariation` is deliberately wide (4.0) so
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

On top of those, motes are drawn **back to front**. Transparency is order-dependent, and
at this size they overlap constantly: drawn in creation order a far bubble composites over
a near one and the volume reads as a sheet of stickers. The sort runs on the seat positions
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
| resting | 10 771 | 13 312 px | 85 px |
| hovered | 13 470 | 20 336 px | 136 px |

Footprint is the screen area actually covered (4 px cells touched) — ×1.53 on hover.

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
