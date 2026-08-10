# PTSVer1 — corner particle cloud

A drifting, curling field of sprite motes wedged into the top-right corner. It opens a
hole around the cursor, and blooms outward when the pointer reaches it.

Serve it over HTTP — it will not run from `file://`:

```
python -m http.server 8000     # then open http://localhost:8000/
```

`index.html` + `main.js` + `assets/bubbles.png` is the whole thing. The canvas is
transparent and draws no background of its own, so it drops straight over an existing
page as an overlay; the grey background here is only a stand-in.

## The two clouds

| | | resting | on hover |
|---|---|---|---|
| **`?fx=2`** | default | a patch in the corner | the whole cloud blooms out of the corner |
| `?fx=1` | | a wide corner field | the pointer opens a hole wherever it goes |

Both carry the ray push; `fx=2` runs it softer, since at its resting size a full-strength
push pulls the patch apart.

## How it works

Everything is solved in the vertex shader on instanced quads — there is no simulation
buffer and no per-frame CPU work beyond the pointer ray.

**Curl noise** drives the movement. The velocity field is built as the curl of a vector
potential, and since `div(curl A) = 0` it cannot compress or thin the cloud: motes swirl
indefinitely without clumping or leaving bald patches. It uses simplex noise with
analytic derivatives, which is what makes it affordable — a curl needs gradients, and
finite differences would cost six extra noise evaluations per sample.

**Travel and curl are exclusive.** A mote either drifts or swirls, never both — a moving
mote's curl is multiplied out. `floatingParticles` is the split: some rise and recycle on
a 5-second loop, fading over the last 30% so the wrap is invisible; the rest sit and
shimmer.

**The cursor is a ray, not a point.** Motes are measured against their distance to the ray
from the camera through the pointer, so the cloud opens as a tube through its whole depth
rather than at a single z. Inside the radius a mote is pushed straight off the ray with a
`pow(1 - d/r, falloffPower)` falloff, and its curl is amplified so the opening boils
rather than sliding apart.

**The bloom scales about the screen corner.** Not about the cloud's own centre — about the
centre the near edge advances on the corner and crosses it, which reads as the patch
sliding rather than spilling.

## Numbers

Footprint is the screen area the motes actually cover (4 px cells touched); reach is how
far they get from the corner. Default preset:

| | motes | footprint | median reach |
|---|---|---|---|
| resting | 2757 | 5936 px | 51 px |
| hovered | 2481 | 9232 px | 99 px |

And the ray push on `fx=1`, counting motes in rings around the pointer:

| ring | idle | cursor | |
|---|---|---|---|
| core, 0–60 px | 2383 | 131 | **−95%** |
| 60–120 px | 5491 | 7031 | +28% |
| whole frame | 10857 | 10599 | conserved |

A hole with a densified rim and the population conserved — a push, not a fade-out.

## Gotchas

Four things that are easy to get wrong, all of them found the hard way:

- **`mouseRadius` and `mouseStrength` are fractions of viewport height**, not world units,
  so the opening holds its size on screen at any window. Put world units in and you get a
  40 px tube that is invisible in a cloud this size.
- **`mouseCurlBoost` fights the push.** It scatters motes back into the hole the push has
  just made; over about 3 it closes the opening completely.
- **`expandHoverInner` must cover the resting cloud's extent.** Hover strength is measured
  from the cloud's centre, and for a corner cloud that centre *is* the corner — the pointer
  can only approach from inside the frame and never gets near zero. Without the plateau,
  hovering the particles themselves reaches ~0.66 of full and the cloud opens two thirds
  of the way.
- **Do not push the anchor past the corner** to get it "tighter in". Most of the patch ends
  up off-screen, the growth happens out of frame, and the open state lands about 30% short.

**Resizing is a square-root job.** Coverage is an area, so covering twice the ground is
×1.414 on every length, not ×2. `particleCount` tracks the same square — motes per
*projected* area — so scaling it by the volume comes out thicker as well as bigger.
`particleSize` is the exception and must not scale, or it reads as a zoom.

## Tuning

The panel, top-left, has a row per `CONFIG` key printing the value to type back in.
`?ui=0` hides it. Quick overrides: `?p=<count>`, `?curl=<amplitude>`, `?push=<strength>`.

## Dev-only

`_shot.html` and `scripts/shot_server.py` are the headless render harness. Chrome's
`--screenshot` never fires on a page whose rAF loop does not end, so the harness serves
the folder, drives a synthetic cursor and POSTs `canvas.toDataURL()` back:

```
python scripts/shot_server.py "_shot.html?cursor=0.95,0.07" --out _shots/x --at 300 --port 8099
```

Neither ships. `_shots/` holds the frames the tables above were measured from.
