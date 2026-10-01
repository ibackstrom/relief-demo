# PTSBottomVer1

Customer-preview page based on `PTSBottom/Sketch.pdf`, using the WebGL particle engine from `PTSVer30`.

## Run locally

From `C:\WebArt`:

```powershell
python -m http.server 8031 --bind 127.0.0.1
```

Open http://127.0.0.1:8031/PTSBottomVer1/ (ES modules require HTTP, not a double-clicked file).

## Behavior

- All five bottom categories are clickable; arrow keys also change selection when a category has focus.
- A broad particle layer rests along the whole bottom, with a soft mountain-like peak reaching the selected menu item.
- The emitter is anchored across the bottom menu; the particles themselves migrate to the selected category through the simulation — each grain on its own clock, through the noise field, so switching reads as an organic roll rather than the shape being moved. Reversing direction mid-travel works the same way, with no particles recreated and no simulation reset.
- The mound's silhouette is never static: coherent noise folds travel through it, each grain's ridge width and private bob are phased off its own seed, and the curl field churns the population underneath.
- Hovering disturbs the cloud exactly as in the original PTSVer30 system: the pointer's trail is a force in the simulation, so the wake has momentum and swirl, keeps travelling after the pointer has gone, and settles back into the ambient flow.
- The band sinks organically below the frame toward the sides (no hard vertical cut), measured from the peak so every category dissolves the same way; the CROP dial in the `?ui=1` panel sets how far that reaches. The mobile layout relaxes the crop automatically.
- The red cloud and hard-coded menu in the PDF's background image have been removed; the bottom menu is live HTML. The remaining page is a visual background, not a working booking/navigation site.
- Desktop preserves the sketch composition. Portrait uses a central crop with the complete headline and a viewport-width menu.
- Reduced-motion preference disables the travelling transition.
- Three.js and the font are local assets; no CDN is needed.

## Verification

Checked in Chrome at 1440 × 900 and 390 × 844: gradual travel, target settlement, unchanged particle geometry, rapid category changes, keyboard selection, resize, reduced-motion selection, and no JavaScript or shader errors. Captured and inspected `preview-cosmetology.jpg`, `preview-stylists.jpg`, and `preview-mobile.jpg`.

## Deployment

Static hosting requires `index.html`, `main.js`, and `assets/`. Never include token files.
