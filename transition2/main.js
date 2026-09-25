// TRANSITION 2 — the sand clip is the mask.
//
// The clip (sand on black) plays over the page: where its sand is, image 1 shows; where it
// has blown away to black, image 2 shows. Scroll down plays it, scroll up plays it backwards.
//
// How the clip becomes a mask (assets/, made by tools/make_mask.py):
//  - only its brightness is used. Each frame is divided by the clip's own first frame
//    (mask-ref.png), so while the sand has not moved the ratio is exactly 1 and image 1 is
//    untouched - no sand texture printed over the picture
//  - COVERAGE = ratio / cover: sand at `cover` of its starting brightness or more is solid;
//    thinner sand is partly see-through
//  - the partial coverage is dithered per screen pixel, so the clip's soft 700px edges break
//    into crisp single grains at screen resolution instead of a blur
//  - FOLDS: where the sand has moved, the ratio above or below 1 is its light and shade, and
//    it shades image 1 - the picture takes the relief of the sand as it lifts
//  - image 2 lies in the sand's shadow, cast down and to the right
//  - at the very end the mask fades out so the last frame is clean image 2

import * as THREE from 'three';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  speed: num('speed', 1.0),      // playback rate of the clip (1 = its own 8.5 s)
  cover: 0.45,                   // sand at this share of its starting brightness counts as solid
  dither: 0.85,                  // 0 = soft edges from the clip, 1 = fully grainy edges
  grainPx: 1.25,                 // css px per dither cell
  fold: 0.9,                     // how much the sand's light and shade marks image 1
  foldGate: [0.05, 0.18],        // change from the start below which no shading is applied
                                 //   (hides the clip's compression noise on still sand)
  shadow: 0.35,                  // darkness of the sand's shadow on image 2
  shadowOffset: [3.0, -4.0],     // in clip pixels: down and right
  endFade: [0.92, 1.0],          // over this part of the clip the mask fades to clean image 2
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
  t.generateMipmaps = false;
  return t;
}
const tImg1 = raw(loader.load('./assets/img1.jpg'));
const tImg2 = raw(loader.load('./assets/img2.jpg'));
const tRef = raw(loader.load('./assets/mask-ref.png'));
const IMG1_ASPECT = 1512 / 900;
const IMG2_ASPECT = 2560 / 1663;
const MASK_W = 700, MASK_H = 394;

const fwd = document.getElementById('fwd');
const rev = document.getElementById('rev');
const tFwd = raw(new THREE.VideoTexture(fwd));
const tRev = raw(new THREE.VideoTexture(rev));

// ------------------------------------------------------------------ the page ----
const U = {
  tImg1: { value: tImg1 }, tImg2: { value: tImg2 }, tRef: { value: tRef }, tMask: { value: tFwd },
  uAspect: { value: 1 }, uCover: { value: CONFIG.cover }, uDither: { value: CONFIG.dither },
  uCell: { value: 1 }, uFold: { value: CONFIG.fold }, uFoldGate: { value: new THREE.Vector2(...CONFIG.foldGate) },
  uShadow: { value: CONFIG.shadow },
  uShadowOff: { value: new THREE.Vector2(CONFIG.shadowOffset[0] / MASK_W, CONFIG.shadowOffset[1] / MASK_H) },
  uOn: { value: 0 }, uEnd: { value: 0 },
};
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: U, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tImg1, tImg2, tRef, tMask;
    uniform float uAspect, uCover, uDither, uCell, uFold, uShadow, uOn, uEnd;
    uniform vec2 uFoldGate, uShadowOff;
    varying vec2 vUv;

    vec2 cover(vec2 uv, float ia) {
      vec2 s = uAspect > ia ? vec2(1.0, ia / uAspect) : vec2(uAspect / ia, 1.0);
      return (uv - 0.5) * s + 0.5;
    }
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    // the sand's brightness here, relative to where it started
    float ratioAt(vec2 m) {
      return texture2D(tMask, m).r / max(texture2D(tRef, m).r, 0.04);
    }
    float coverageAt(vec2 m) { return clamp(ratioAt(m) / uCover, 0.0, 1.0); }

    void main() {
      vec2 m = cover(vUv, ${(MASK_W / MASK_H).toFixed(6)});
      float ratio = ratioAt(m);
      float c = clamp(ratio / uCover, 0.0, 1.0);
      c = mix(1.0, c * (1.0 - uEnd), uOn);

      // partial sand breaks into single grains at screen resolution
      float h = hash12(floor(gl_FragCoord.xy / uCell));
      float k = mix(c, step(h, c) * step(0.001, c), uDither);

      // image 1 takes the sand's relief where the sand has moved
      float g = smoothstep(uFoldGate.x, uFoldGate.y, abs(ratio - 1.0)) * uOn * (1.0 - uEnd);
      float shade = mix(1.0, clamp(ratio, 0.35, 1.7), g * uFold);
      vec3 c1 = texture2D(tImg1, cover(vUv, ${IMG1_ASPECT.toFixed(6)})).rgb * shade;

      // image 2 in the shadow of the sand, cast down and to the right
      vec2 so = m - uShadowOff;
      float cs = 0.25 * (coverageAt(so) + coverageAt(so + uShadowOff * 0.6)
                       + coverageAt(so + vec2(uShadowOff.x, -uShadowOff.y) * 0.5)
                       + coverageAt(so - vec2(uShadowOff.x, -uShadowOff.y) * 0.5));
      vec3 c2 = texture2D(tImg2, cover(vUv, ${IMG2_ASPECT.toFixed(6)})).rgb;
      c2 *= 1.0 - uShadow * cs * uOn * (1.0 - uEnd);

      gl_FragColor = vec4(mix(c2, c1, k), 1.0);
    }`,
})));

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  U.uAspect.value = innerWidth / innerHeight;
  U.uCell.value = CONFIG.grainPx * renderer.getPixelRatio();
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

const dur = (v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 8.48);
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
  U.uEnd.value = THREE.MathUtils.smoothstep(pos, CONFIG.endFade[0], CONFIG.endFade[1]);
  renderer.render(scene, camera);
});
