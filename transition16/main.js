// TRANSITION 16 — memory signal.
//
// The particle effect is shuhari04's "Memory Signal" (github.com/shuhari04/memory-signal-threejs,
// MIT, Copyright (c) 2025 shuhari04 - see assets/MEMORY-SIGNAL-LICENSE.txt): a picture turned into
// one glowing particle per pixel, its brightness lifting it into relief, breathing on a slow wave,
// drifting on 3D curl noise, its EDGES tearing away into a cool fog - additive, with bloom.
//
// Here it carries one picture to the next. Image 1 starts as the sharp photo and crossfades into
// its particles; a noisy front sweeps across, and where it passes, image 1's particles get the
// edge treatment - the noise power ramps up, they tear off into glowing fog, cool to blue and
// fade - while image 2's particles condense out of that fog into place, the same process run
// backwards. Bloom swells and the field turns a little in 3D while it happens, both zero at the
// ends, and image 2's particles hand over to the sharp photo. Scroll down plays it, up reverses it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const PARAMS = new URLSearchParams(location.search);
const num = (k, d) => (PARAMS.has(k) && isFinite(+PARAMS.get(k)) ? +PARAMS.get(k) : d);

const CONFIG = {
  duration: num('dur', 3.6),     // s, the transition at full speed
  accel: 0.35,                   // s to reach full speed (inertia); it eases into the end too
  grid: num('grid', 360),        // particles across the screen (Memory Signal works at ~300)
  band: 0.35,                    // width of the passing front
  frontNoise: 0.25,              // how ragged the front is
  // Memory Signal's own parameters
  particleSize: 1.0,
  zRelief: 60.0,                 // brightness -> depth
  noiseStrength: 1.0,            // curl-noise displacement
  tear: 150.0,                   // how far the torn particles are thrown
  coolEdge: 0.8,                 // how far torn particles go toward the cool blue
  bloomStrength: 0.9,            // at the height of the transition (zero at both ends). Memory
                                 //   Signal's 1.5 at threshold 0.1 is for a subject on black: on a light
                                 //   picture it blooms the whole screen to white
  bloomRadius: 0.4,
  bloomThreshold: 0.8,           // only the brightest dots and the torn fog glow
  turn: 0.12,                    // radians the field turns at the height of the transition
  photoFade: 0.10,               // share of the transition over which the photos hand over
};

// ---------------------------------------------------------------- scene ----
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const PLANE_H = 600;                                  // world units across the screen height
const FOV = 45;
const camDist = (PLANE_H / 2) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 1, 5000);
camera.position.set(0, 0, camDist);
const field = new THREE.Group();                      // the particles, which turn a little
scene.add(field);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0, CONFIG.bloomRadius, CONFIG.bloomThreshold);
composer.addPass(bloom);

// ---------------------------------------------------------------- the photos ----
// Sharp at the two ends; each hands over to (or takes over from) its particles.
function photo(url, aspect) {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = THREE.NoColorSpace;   // raw in, raw out - as the particles and the bloom path are
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { tMap: { value: tex }, uOpacity: { value: 1 }, uScreenAspect: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tMap; uniform float uOpacity, uScreenAspect;
      varying vec2 vUv;
      void main() {
        float ia = ${aspect.toFixed(6)};
        vec2 s = uScreenAspect > ia ? vec2(1.0, ia / uScreenAspect) : vec2(uScreenAspect / ia, 1.0);
        gl_FragColor = vec4(texture2D(tMap, (vUv - 0.5) * s + 0.5).rgb, uOpacity);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  scene.add(mesh);
  return { mesh, mat, img: tex };
}
const IMG1_ASPECT = 1512 / 900, IMG2_ASPECT = 2560 / 1663;
const photo1 = photo('./assets/img1.jpg', IMG1_ASPECT);
const photo2 = photo('./assets/img2.jpg', IMG2_ASPECT);
photo2.mesh.renderOrder = 1;

// ---------------------------------------------------------------- the particles ----
// Memory Signal's vertex shader, with the transition put into its "edge factor": a particle is
// calm (relief, breathing, a little flow) until the front reaches it, and then torn away. Image 2
// runs the same thing backwards, condensing as the front passes.
const vertexShader = /* glsl */`
uniform float uTime, uP, uBand, uFrontNoise, uParticleSize, uZRelief, uNoiseStrength, uTear, uCool, uMode, uFade, uPx;
attribute float brightness;
attribute float random;
attribute float sweep;                 // where it sits along the front's path, 0..1
attribute vec3 customColor;
varying vec3 vColor;
varying float vAlpha;
varying float vEdge;

// Simplex 3D noise (Memory Signal's)
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx) ;
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );
  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0 );
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
  float n_ = 1.0/7.0;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}
vec3 curlNoise( vec3 p ){
  const float e = 0.1;
  vec3 dx = vec3( e, 0.0, 0.0 ), dy = vec3( 0.0, e, 0.0 ), dz = vec3( 0.0, 0.0, e );
  vec3 p_x0 = vec3( snoise(p - dx), snoise(p - dx + vec3(100.)), snoise(p - dx + vec3(200.)) );
  vec3 p_x1 = vec3( snoise(p + dx), snoise(p + dx + vec3(100.)), snoise(p + dx + vec3(200.)) );
  vec3 p_y0 = vec3( snoise(p - dy), snoise(p - dy + vec3(100.)), snoise(p - dy + vec3(200.)) );
  vec3 p_y1 = vec3( snoise(p + dy), snoise(p + dy + vec3(100.)), snoise(p + dy + vec3(200.)) );
  vec3 p_z0 = vec3( snoise(p - dz), snoise(p - dz + vec3(100.)), snoise(p - dz + vec3(200.)) );
  vec3 p_z1 = vec3( snoise(p + dz), snoise(p + dz + vec3(100.)), snoise(p + dz + vec3(200.)) );
  float x = p_y1.z - p_y0.z - p_z1.y + p_z0.y;
  float y = p_z1.x - p_z0.x - p_x1.z + p_x0.z;
  float z = p_x1.y - p_x0.y - p_y1.x + p_y0.x;
  return normalize( vec3( x , y , z ) );
}

void main() {
  vec3 pos = position;
  // the front: where it has reached this particle, 0 (not yet) .. 1 (well past)
  float ragged = snoise(vec3(pos.xy * 0.004, 7.0)) * uFrontNoise;
  float reach = uP * (1.0 + 2.0 * uBand + uFrontNoise) - uBand - 0.5 * uFrontNoise;
  float passed = smoothstep(0.0, uBand, reach - sweep + ragged);
  // image 1 is torn away as the front passes; image 2 condenses as it passes (torn before, calm after)
  float edgeFactor = uMode < 0.5 ? passed : 1.0 - passed;
  vEdge = edgeFactor;
  vColor = customColor;

  // 1. brightness lifts it into relief
  float zReliefValue = brightness * uZRelief;
  // 2. a slow breathing wave
  float wave = sin(uTime * 1.5 + pos.x * 0.01 + pos.y * 0.01 + random * 6.28) * 5.0 * (1.0 + brightness);
  // 3. curl-noise flow, calm in the picture and chaotic where it tears
  vec3 cnoise = curlNoise(pos * 0.005 + vec3(0.0, uTime * 0.1, uTime * 0.05));
  float noisePower = mix(2.0, 100.0, smoothstep(0.0, 1.0, edgeFactor));
  noisePower += random * 30.0 * edgeFactor;
  vec3 flowOffset = cnoise * noisePower * uNoiseStrength;
  pos.z += zReliefValue + wave;
  pos += flowOffset;
  // torn particles are thrown off into the fog, and cool toward blue
  if (edgeFactor > 0.02) {
    float tearForce = (snoise(vec3(pos.xy * 0.01, uTime * 0.5)) * 0.5 + 0.5) * edgeFactor;
    pos += cnoise * tearForce * uTear;
    vColor = mix(vColor, vec3(0.5, 0.8, 1.0), edgeFactor * uCool);
  }

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  float pSize = mix(1.0, 4.0, brightness) + random * 2.0;
  pSize *= mix(1.0, 2.0, edgeFactor);
  pSize *= uParticleSize;
  gl_PointSize = pSize * uPx * (${camDist.toFixed(2)} / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;

  // alpha: Memory Signal's edge decay, and the torn fog fades right out; plus the hand-over
  // with the photos at the two ends
  vAlpha = mix(0.9, 0.1, edgeFactor) * (1.0 - smoothstep(0.75, 1.0, edgeFactor)) * uFade;
}
`;
const fragmentShader = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
varying float vEdge;
void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;
  float alpha = smoothstep(0.5, 0.1, dist) * vAlpha;
  vec3 finalColor = vColor + vec3(0.1, 0.3, 0.5) * vEdge;
  gl_FragColor = vec4(finalColor * alpha, alpha);    // additive: premultiplied by its alpha
}
`;

const shared = {
  uTime: { value: 0 }, uP: { value: 0 }, uBand: { value: CONFIG.band }, uFrontNoise: { value: CONFIG.frontNoise },
  uParticleSize: { value: CONFIG.particleSize }, uZRelief: { value: CONFIG.zRelief },
  uNoiseStrength: { value: CONFIG.noiseStrength }, uTear: { value: CONFIG.tear }, uCool: { value: CONFIG.coolEdge },
  uPx: { value: 1 },
};
function particleField(url, mode) {
  const mat = new THREE.ShaderMaterial({
    vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,   // additive
    uniforms: { ...shared, uMode: { value: mode }, uFade: { value: 0 } },
  });
  const points = new THREE.Points(new THREE.BufferGeometry(), mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  field.add(points);
  const imgEl = new Image();
  imgEl.onload = () => { points.userData.img = imgEl; build(points); };
  imgEl.src = url;
  return points;
}
// one particle per grid cell over the screen, coloured by the picture as it covers the screen
function build(points) {
  const img = points.userData.img;
  if (!img) return;
  const aspect = innerWidth / innerHeight;
  const gw = Math.round(CONFIG.grid), gh = Math.round(CONFIG.grid / aspect);
  const c = document.createElement('canvas');
  c.width = gw; c.height = gh;
  const g = c.getContext('2d');
  const ia = img.width / img.height;
  let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (aspect > ia) { sh = img.width / aspect; sy = (img.height - sh) / 2; } else { sw = img.height * aspect; sx = (img.width - sw) / 2; }
  g.drawImage(img, sx, sy, sw, sh, 0, 0, gw, gh);
  const data = g.getImageData(0, 0, gw, gh).data;
  const n = gw * gh;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const bri = new Float32Array(n), rnd = new Float32Array(n), swp = new Float32Array(n);
  const W = PLANE_H * aspect;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x, k = i * 4;
    const r = data[k] / 255, gg = data[k + 1] / 255, b = data[k + 2] / 255;
    pos[i * 3] = ((x + 0.5) / gw - 0.5) * W;
    pos[i * 3 + 1] = -((y + 0.5) / gh - 0.5) * PLANE_H;
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
    bri[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    rnd[i] = Math.random();
    // the front travels from the upper left to the lower right
    swp[i] = 0.62 * (x + 0.5) / gw + 0.38 * (y + 0.5) / gh;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('customColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('brightness', new THREE.BufferAttribute(bri, 1));
  geo.setAttribute('random', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('sweep', new THREE.BufferAttribute(swp, 1));
  points.geometry.dispose();
  points.geometry = geo;
}
const field1 = particleField('./assets/img1.jpg', 0);
const field2 = particleField('./assets/img2.jpg', 1);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const aspect = innerWidth / innerHeight;
  for (const ph of [photo1, photo2]) {
    ph.mesh.scale.set(PLANE_H * aspect, PLANE_H, 1);
    ph.mat.uniforms.uScreenAspect.value = aspect;
  }
  // the particle sizes, as Memory Signal has them: an average particle (size ~2.5) covers about 60%
  // of the gap to its neighbour, so the picture reads as glowing dots with dark between them
  shared.uPx.value = (innerWidth / CONFIG.grid) * 0.25 * renderer.getPixelRatio();
  build(field1); build(field2);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the timeline ----
let p = 0, vel = 0, dir = 0;
const hint = document.getElementById('hint');
const forward = () => { dir = 1; if (hint) hint.classList.add('off'); };
const backward = () => { if (p > 0) dir = -1; };
const inPanel = (e) => !!(e.target && e.target.closest && e.target.closest('#pui'));
addEventListener('wheel', (e) => { if (inPanel(e)) return; if (e.deltaY > 2) forward(); else if (e.deltaY < -2) backward(); }, { passive: true });
let touchY = null;
addEventListener('touchstart', (e) => { touchY = inPanel(e) ? null : e.touches[0].clientY; }, { passive: true });
addEventListener('touchmove', (e) => {
  if (touchY === null) return;
  const dy = touchY - e.touches[0].clientY;
  if (dy > 20) { forward(); touchY = null; } else if (dy < -20) { backward(); touchY = null; }
}, { passive: true });
addEventListener('keydown', (e) => {
  if (['ArrowDown', 'PageDown', ' ', 'End'].includes(e.key)) forward();
  if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) backward();
});
window.transitionControl = { forward, backward, get progress() { return p; } };

const clock = new THREE.Clock();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const left = dir > 0 ? 1 - p : p;
  const kk = Math.min(1, left / 0.2);
  const target = dir === 0 ? 0 : dir / CONFIG.duration * (0.3 + 0.7 * kk * kk * (3 - 2 * kk));
  vel += (target - vel) * (1 - Math.exp(-dt / Math.max(0.02, CONFIG.accel / 3)));
  p += vel * dt;
  if (p >= 1) { p = 1; vel = 0; dir = 0; }
  if (p <= 0) { p = 0; vel = 0; if (dir < 0) { dir = 0; if (hint) hint.classList.remove('off'); } }

  shared.uTime.value = clock.getElapsedTime();
  shared.uP.value = p;
  shared.uBand.value = CONFIG.band; shared.uFrontNoise.value = CONFIG.frontNoise;
  shared.uParticleSize.value = CONFIG.particleSize; shared.uZRelief.value = CONFIG.zRelief;
  shared.uNoiseStrength.value = CONFIG.noiseStrength; shared.uTear.value = CONFIG.tear; shared.uCool.value = CONFIG.coolEdge;
  // the photos hand over to the particles just after the start and take over just before the end
  const f = CONFIG.photoFade;
  const in1 = THREE.MathUtils.smoothstep(p, 0, f);           // 0 = photo 1, 1 = particles
  const out2 = THREE.MathUtils.smoothstep(p, 1 - f, 1);      // 1 = photo 2
  photo1.mat.uniforms.uOpacity.value = 1 - in1;
  photo1.mesh.visible = in1 < 1;
  photo2.mat.uniforms.uOpacity.value = out2;
  photo2.mesh.visible = out2 > 0;
  field1.material.uniforms.uFade.value = in1;
  field2.material.uniforms.uFade.value = 1 - out2;
  field1.visible = p > 0 && p < 1; field2.visible = p > 0 && p < 1;
  // bloom and the 3D turn swell through the middle and are zero at the ends
  const mid = Math.sin(Math.PI * p);
  bloom.strength = CONFIG.bloomStrength * mid;
  bloom.radius = CONFIG.bloomRadius; bloom.threshold = CONFIG.bloomThreshold;
  field.rotation.y = Math.sin(shared.uTime.value * 0.2) * CONFIG.turn * mid;
  field.rotation.x = Math.sin(shared.uTime.value * 0.15) * CONFIG.turn * 0.5 * mid;
  if (p > 0 && p < 1) composer.render(); else renderer.render(scene, camera);
});

// ---------------------------------------------------------------- the panel ----
const uiEl = document.getElementById('pui');
if (uiEl && PARAMS.get('ui') === '0') uiEl.remove();
else if (uiEl) {
  const ROWS = [
    ['the transition'],
    ['duration', 'duration (s)', 1, 10, 0.1], ['accel', 'inertia (s)', 0, 1.5, 0.05],
    ['band', 'front width', 0.05, 1, 0.01], ['frontNoise', 'ragged front', 0, 0.8, 0.01],
    ['photoFade', 'photo hand-over', 0.02, 0.3, 0.01],
    ['memory signal'],
    ['particleSize', 'particle size', 0.1, 5, 0.05], ['zRelief', 'z relief', 0, 200, 1],
    ['noiseStrength', 'noise strength', 0, 5, 0.05], ['tear', 'tear away', 0, 400, 1],
    ['coolEdge', 'cool edges', 0, 1, 0.01], ['turn', '3D turn', 0, 0.5, 0.01],
    ['bloom'],
    ['bloomStrength', 'bloom strength', 0, 5, 0.05], ['bloomRadius', 'bloom radius', 0, 2, 0.01],
    ['bloomThreshold', 'bloom threshold', 0, 1, 0.01],
  ];
  uiEl.innerHTML = '<div class="btns"><button type="button" id="pPlay">play ▶</button>'
    + '<button type="button" id="pBack">◀ back</button></div>'
    + ROWS.map((r, i) => r.length === 1 ? '<h2>' + r[0] + '</h2>'
      : '<div class="row"><div class="lbl"><span class="name">' + r[1] + '</span><span class="val" id="pv' + i + '">'
        + CONFIG[r[0]] + '</span></div><input type="range" id="pr' + i + '" min="' + r[2] + '" max="' + r[3]
        + '" step="' + r[4] + '" value="' + CONFIG[r[0]] + '"></div>').join('')
    + '<div class="foot">particle effect: shuhari04 / Memory Signal (MIT) &middot; ?ui=0 removes this panel</div>';
  ROWS.forEach((r, i) => {
    if (r.length === 1) return;
    const el = document.getElementById('pr' + i);
    el.addEventListener('input', () => { CONFIG[r[0]] = parseFloat(el.value); document.getElementById('pv' + i).textContent = el.value; });
  });
  document.getElementById('pPlay').addEventListener('click', () => { p = 0; vel = 0; forward(); });
  document.getElementById('pBack').addEventListener('click', backward);
}
