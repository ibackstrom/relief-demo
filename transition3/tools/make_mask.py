"""Turn the sand clip (ProRes 4444 with alpha) into transition3's packed mask video.

  python tools/make_mask.py path/to/clip.mov

One greyscale video, each frame 1280 x 1080:
  top    1280 x 720   COVERAGE - the clip's own alpha, area-averaged down from 4K, so single
                      grains become sand density instead of flickering dots
  bottom  640 x 360   FOLDS - the sand's brightness against its first frame (0.5 = unchanged),
                      blurred to the scale of the folds; image 1 is shaded and bent by it
Every frame is averaged with its neighbours (1-2-1), which takes the grain's frame-to-frame
flicker out without smearing the motion. Greyscale is the cheapest thing a video can carry and
plays in every browser, so there is no alpha codec to depend on.

Writes assets/mask.mp4, assets/mask-rev.mp4 (backwards, for scrolling up), assets/mask.json.
"""
import json, os, subprocess, sys
import cv2
import numpy as np

src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(out, exist_ok=True)
W, H = 3840, 2160
AW, AH = 1280, 720
SW, SH = 640, 360
CRF = os.environ.get('CRF', '26')

# ---- read every frame once, keep only what is needed at the working sizes -----------------
dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                       stdout=subprocess.PIPE, bufsize=W * H * 4)
alphas, lumas = [], []
while True:
    buf = dec.stdout.read(W * H * 4)
    if len(buf) < W * H * 4:
        break
    f = np.frombuffer(buf, np.uint8).reshape(H, W, 4)
    a = f[:, :, 3].astype(np.float32) / 255
    # kept as 8-bit: 250 frames at this size as floats would take a gigabyte
    alphas.append((cv2.resize(a, (AW, AH), interpolation=cv2.INTER_AREA) * 255 + 0.5).astype(np.uint8))
    rgb = f[:, :, :3].astype(np.float32) / 255
    lum = rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114
    # brightness of the SAND, weighted by how much sand there is, so empty space counts for nothing
    num = cv2.resize(lum * a, (SW, SH), interpolation=cv2.INTER_AREA)
    den = cv2.resize(a, (SW, SH), interpolation=cv2.INTER_AREA)
    lumas.append((num, den))
dec.wait()
n = len(alphas)
print(n, 'frames read')

# ---- the trim: from just before the sheet first breaks to just after it is gone ------------
mean = np.array([a.mean() / 255 for a in alphas])
# the start is read from the FOLDS, not the alpha: the sheet lifts and folds for a couple of
# seconds while it is still whole, and that is the best part of it
def _l(i):
    num, den = lumas[i]
    return num / np.maximum(den, 1e-3)
l0 = _l(0)
moved = np.array([np.abs(_l(i) - l0).mean() for i in range(n)])
start = max(0, int(np.argmax(moved > 0.004)) - 2)
gone = np.where(mean < 0.002)[0]
end = min(n - 1, int(gone[gone > start][0]) + 3) if len(gone[gone > start]) else n - 1
print(f'using {start}..{end} ({end - start + 1} frames)')

# ---- folds: sand brightness relative to the first frame, blurred to fold scale -----------------
def sand_lum(i):
    num, den = lumas[i]
    num = cv2.GaussianBlur(num, (0, 0), 2.0)
    den = cv2.GaussianBlur(den, (0, 0), 2.0)
    return num / np.maximum(den, 1e-3), den

ref, _ = sand_lum(start)
frames = []
for i in range(start, end + 1):
    lo, hi = max(start, i - 1), min(end, i + 1)
    a = (0.25 * alphas[lo] + 0.5 * alphas[i] + 0.25 * alphas[hi]) / 255  # 1-2-1 in time
    l, den = sand_lum(i)
    ratio = np.where(den > 0.05, l / np.maximum(ref, 1e-3), 1.0)
    fold = np.clip(ratio * 0.5, 0, 1)                                    # 0.5 = unchanged
    frame = np.zeros((AH + SH, AW), np.float32)
    frame[:AH] = a
    frame[AH:, :SW] = fold
    frame[AH:, SW:] = 0.5
    frames.append((np.clip(frame, 0, 1) * 255 + 0.5).astype(np.uint8))

# ---- encode: forwards and backwards ------------------------------------------------------------
def encode(seq, name):
    args = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', f'{AW}x{AH + SH}',
            '-r', '25', '-i', '-', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', CRF,
            '-pix_fmt', 'yuv420p', '-g', '25', '-an', '-movflags', '+faststart', os.path.join(out, name)]
    p = subprocess.Popen(args, stdin=subprocess.PIPE)
    for f in seq:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    print(name, os.path.getsize(os.path.join(out, name)) // 1024, 'KB')

encode(frames, 'mask.mp4')
encode(frames[::-1], 'mask-rev.mp4')
json.dump({'frames': len(frames), 'fps': 25, 'duration': len(frames) / 25,
           'cover': [AW, AH], 'fold': [SW, SH], 'size': [AW, AH + SH]},
          open(os.path.join(out, 'mask.json'), 'w'))
