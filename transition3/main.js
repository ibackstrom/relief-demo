// TRANSITION 3 — image 1 is a sheet of sand that lifts, folds and blows away; image 2 is under it.
//
// The mask is the sand clip's own ALPHA (the 4K ProRes master has a real one), packed with the
// sand's fold relief into one greyscale video by tools/make_mask.py:
//   top    COVERAGE - how much sand is here. Area-averaged from 4K and smoothed across
//          neighbouring frames, so the grain reads as sand density and does not flicker.
//   bottom FOLDS    - the sand's brightness against its first frame, 0.5 = unchanged.
//
// On the page:
//  - image 1 is SHADED by the folds and BENT by them - the picture lifts and creases with the
//    sand instead of being cut out of it
//  - where the sheet breaks up, image 1 goes to grains: the clip's own sand grains, which move
//    with the sand. (transition2 dithered on a fixed screen pattern the sand slid across - that
//    was the jiggle.)
//  - the broken edge catches a soft warm light
//  - image 2 lies in the sheet's shadow and settles in from a slight zoom as it is uncovered
//  - speed 2 by default: the 8.8 s clip plays in 4.4 s. Scroll down plays it, up plays it back.

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  speed: num('speed', 2.0),      // playback rate (2 = the 8.8 s clip in 4.4 s)
  cover: [0.06, 0.50],           // coverage from which image 1 starts to show, and is solid
  fold: 0.0,                     // how strongly the folds shade image 1 (0.85 before - the client
                                 //   wanted just the sand, not the wave/caustic look)
  foldRange: [0.45, 1.6],        // the most the folds may darken / lighten it
  warp: 0.0,                     // how far the folds bend image 1 (0.010 before)
  rim: 0.0,                      // warm light on the breaking edge (0.22 before)
  rimColor: [1.0, 0.93, 0.84],
  shadow: 0.42,                  // image 2 in the sheet's shadow
  shadowOffset: [7, -10],        // in mask pixels (1280 wide): down and to the right
  zoom: 0.06,                    // image 2 settles from this much larger to its place
  endFade: [0.93, 1.0],          // over this last part the mask fades to clean image 2
};

// ---------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const loader = new THREE.TextureLoader();
function raw(t) {
  t.colorSpace = THREE.NoColorSpace;   // raw pass-through: the shaders output what they read
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
const tImg1 = raw(loader.load('./assets/img1.jpg'));
const tImg2 = raw(loader.load('./assets/img2.jpg'));
const IMG1_ASPECT = 1512 / 900;
const IMG2_ASPECT = 2560 / 1663;
const MASK_ASPECT = 1280 / 720;
const MASK_W = 1280, MASK_H = 720;

const fwd = document.getElementById('fwd');
const rev = document.getElementById('rev');
const tFwd = raw(new THREE.VideoTexture(fwd));
const tRev = raw(new THREE.VideoTexture(rev));

// ------------------------------------------------------------------ the page ----
const U = {
  tImg1: { value: tImg1 }, tImg2: { value: tImg2 }, tMask: { value: tFwd },
  uAspect: { value: 1 },
  uCover: { value: new THREE.Vector2(...CONFIG.cover) },
  uFold: { value: CONFIG.fold }, uFoldRange: { value: new THREE.Vector2(...CONFIG.foldRange) },
  uWarp: { value: CONFIG.warp },
  uRim: { value: CONFIG.rim }, uRimColor: { value: new THREE.Vector3(...CONFIG.rimColor) },
  uShadow: { value: CONFIG.shadow },
  uShadowOff: { value: new THREE.Vector2(CONFIG.shadowOffset[0] / MASK_W, CONFIG.shadowOffset[1] / MASK_H) },
  uZoom: { value: CONFIG.zoom },
  uPos: { value: 0 }, uOn: { value: 0 }, uEnd: { value: 0 },
};
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tImg1, tImg2, tMask;
    uniform float uAspect, uFold, uWarp, uRim, uShadow, uZoom, uPos, uOn, uEnd;
    uniform vec2 uCover, uFoldRange, uShadowOff;
    uniform vec3 uRimColor;
    varying vec2 vUv;

    vec2 cover(vec2 uv, float ia) {
      vec2 s = uAspect > ia ? vec2(1.0, ia / uAspect) : vec2(uAspect / ia, 1.0);
      return (uv - 0.5) * s + 0.5;
    }
    // The packed frame (1280 x 1080, texture v runs bottom-up): coverage fills the top 720
    // rows, the folds the left half of the bottom 360. Each is read inside its own region,
    // half a texel in from its edges, so linear filtering never mixes the two.
    float coverageAt(vec2 m) {
      m = clamp(m, vec2(0.5 / 1280.0, 0.5 / 720.0), vec2(1.0 - 0.5 / 1280.0, 1.0 - 0.5 / 720.0));
      return texture2D(tMask, vec2(m.x, (360.0 + m.y * 720.0) / 1080.0)).r;
    }
    float foldAt(vec2 m) {
      m = clamp(m, vec2(0.5 / 640.0, 0.5 / 360.0), vec2(1.0 - 0.5 / 640.0, 1.0 - 0.5 / 360.0));
      return texture2D(tMask, vec2(m.x * 0.5, m.y * 360.0 / 1080.0)).r * 2.0;   // 1 = unchanged
    }

    void main() {
      vec2 m = cover(vUv, ${MASK_ASPECT.toFixed(6)});
      float live = uOn * (1.0 - uEnd);

      // ---- the folds: shade and bend image 1 ----
      float S = foldAt(m);
      vec2 e = vec2(1.5 / 640.0, 1.5 / 360.0);
      vec2 grad = vec2(foldAt(m + vec2(e.x, 0.0)) - foldAt(m - vec2(e.x, 0.0)),
                       foldAt(m + vec2(0.0, e.y)) - foldAt(m - vec2(0.0, e.y)));
      vec2 uv1 = vUv - grad * uWarp * live;
      float shade = mix(1.0, clamp(S, uFoldRange.x, uFoldRange.y), uFold * live);
      vec3 c1 = texture2D(tImg1, cover(uv1, ${IMG1_ASPECT.toFixed(6)})).rgb * shade;

      // ---- coverage: where the sheet still is ----
      float A = coverageAt(m);
      float k = mix(1.0, smoothstep(uCover.x, uCover.y, A) * (1.0 - uEnd), uOn);
      // the breaking edge - thin sand, part covered - catches a warm light
      float edge = smoothstep(0.02, uCover.y, A) * (1.0 - smoothstep(uCover.y, 0.95, A));
      c1 += uRimColor * (uRim * edge * live);

      // ---- image 2: in the sheet's shadow, settling in from a slight zoom ----
      vec2 so = m - uShadowOff;
      float cs = 0.2 * (coverageAt(so) + coverageAt(so + uShadowOff * 0.5)
                      + coverageAt(so - uShadowOff * 0.5)
                      + coverageAt(so + vec2(uShadowOff.y, uShadowOff.x) * 0.6)
                      + coverageAt(so - vec2(uShadowOff.y, uShadowOff.x) * 0.6));
      float z = 1.0 + uZoom * (1.0 - smoothstep(0.0, 1.0, uPos));
      vec3 c2 = texture2D(tImg2, cover((vUv - 0.5) / z + 0.5, ${IMG2_ASPECT.toFixed(6)})).rgb;
      c2 *= 1.0 - uShadow * smoothstep(0.0, 0.8, cs) * live;

      gl_FragColor = vec4(mix(c2, c1, k), 1.0);
    }`,
})));

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  U.uAspect.value = innerWidth / innerHeight;
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the clip ----
// Forwards is mask.mp4, backwards is mask-rev.mp4 (the same frames reversed) - seeking a
// video backwards frame by frame is not smooth anywhere, playing one is. Switching direction
// seeks the other file to the mirrored moment and swaps over only once that frame is on
// the texture, so the picture holds still for the moment it takes instead of flashing.
let active = fwd;
let want = 0;              // +1 forwards, -1 backwards, 0 still
let pos = 0;               // 0..1 along the forward clip
let swapping = false;
const hint = document.getElementById('hint');
fwd.playbackRate = rev.playbackRate = CONFIG.speed;
fwd.defaultPlaybackRate = rev.defaultPlaybackRate = CONFIG.speed;

const dur = (v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 8.8);
const posOf = (v) => (v === fwd ? v.currentTime / dur(v) : 1 - v.currentTime / dur(v));

// run fn once the video has put its current frame on screen (and so on the texture); a
// timeout backs it up for browsers without the callback or that skip it for a paused video
function onFrame(v, fn) {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(once);
  setTimeout(once, 150);
}

function run(dir) {
  want = dir;
  const target = dir > 0 ? fwd : rev;
  if (dir > 0 && hint) hint.classList.add('off');
  if (dir > 0 && rev.preload === 'none') { rev.preload = 'auto'; rev.load(); }
  if (active === target) {
    if (target.ended || (dir > 0 && pos >= 1) || (dir < 0 && pos <= 0)) return;
    target.playbackRate = CONFIG.speed;
    target.play().catch(() => {});
    return;
  }
  if (swapping) return;
  // the other file, at the mirrored moment
  swapping = true;
  active.pause();
  const p = posOf(active);
  const go = () => {
    const q = target === fwd ? p : 1 - p;    // the same moment, counted along that file
    target.currentTime = Math.min(Math.max(q, 0), 1) * dur(target);
    target.addEventListener('seeked', () => {
      onFrame(target, () => {
        active = target;
        U.tMask.value = target === fwd ? tFwd : tRev;
        swapping = false;
        if (want === dir) { target.playbackRate = CONFIG.speed; target.play().catch(() => {}); }
        else run(want);
      });
    }, { once: true });
  };
  if (target.readyState >= 1) go(); else target.addEventListener('loadedmetadata', go, { once: true });
}
const forward = () => { if (pos < 1 || active !== fwd) run(1); };
const backward = () => { if (pos > 0) run(-1); };

fwd.addEventListener('ended', () => { pos = 1; });
rev.addEventListener('ended', () => { pos = 0; if (hint) hint.classList.remove('off'); });

addEventListener('wheel', (e) => { if (e.deltaY > 2) forward(); else if (e.deltaY < -2) backward(); }, { passive: true });
let touchY = null;
addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
addEventListener('touchmove', (e) => {
  if (touchY === null) return;
  const dy = touchY - e.touches[0].clientY;
  if (dy > 20) { forward(); touchY = null; } else if (dy < -20) { backward(); touchY = null; }
}, { passive: true });
addEventListener('keydown', (e) => {
  if (['ArrowDown', 'PageDown', ' ', 'End'].includes(e.key)) forward();
  if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) backward();
});

renderer.setAnimationLoop(() => {
  if (!swapping && active.readyState >= 2) pos = Math.min(Math.max(posOf(active), 0), 1);
  // the mask is on once the clip has shown a frame past its start; before that (and back at
  // the start after scrolling up) the page is image 1 exactly
  U.uOn.value = pos > 0.0005 ? 1 : 0;
  U.uPos.value = pos;
  U.uEnd.value = THREE.MathUtils.smoothstep(pos, CONFIG.endFade[0], CONFIG.endFade[1]);
  renderer.render(scene, camera);
});
