"""Turn the sand clip (sand on black) into the transition's mask files.

  python tools/make_mask.py path/to/clip.mp4

Writes to assets/:
  mask.mp4       the moving part of the clip, greyscale (luma is all the page reads)
  mask-rev.mp4   the same, backwards - played when the visitor scrolls back up
  mask-ref.png   the first frame of mask.mp4 exactly as a decoder returns it. The page
                 divides by it, so the picture is untouched until the sand actually moves
  mask.json      frame count, fps, size

The trim is found from the clip itself: it starts a few frames before the sand first moves
and ends once the frame has gone dark. Drop in another clip (e.g. the licensed one, without
the watermark) and run this again - nothing else changes.
"""
import json, os, subprocess, sys
import cv2
import numpy as np

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'assets')

cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS) or 25
frames = []
while True:
    ok, f = cap.read()
    if not ok:
        break
    frames.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255)
F = np.array(frames)
change = np.abs(np.diff(F, axis=0)).mean(axis=(1, 2))
level = F.mean(axis=(1, 2))
start = max(0, int(np.argmax(change > 0.004)) - 3)
dark = np.where(level < 0.006)[0]
end = int(dark[dark > start][0]) + 3 if len(dark[dark > start]) else len(F) - 1
end = min(end, len(F) - 1)
n = end - start + 1
print(f'{len(F)} frames at {fps:g} fps; using {start}..{end} ({n} frames, {n / fps:.2f} s)')

common = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p',
          '-g', '12', '-an', '-movflags', '+faststart']
trim = f'trim=start_frame={start}:end_frame={end + 1},setpts=PTS-STARTPTS,format=gray'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', trim + ',format=yuv420p',
                *common, os.path.join(out, 'mask.mp4')], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', trim + ',reverse,format=yuv420p',
                *common, os.path.join(out, 'mask-rev.mp4')], check=True)

# the reference: the ENCODED first frame, so it matches what the page will sample
cap = cv2.VideoCapture(os.path.join(out, 'mask.mp4'))
ok, f0 = cap.read()
w, h = f0.shape[1], f0.shape[0]
cv2.imwrite(os.path.join(out, 'mask-ref.png'), cv2.cvtColor(f0, cv2.COLOR_BGR2GRAY))
json.dump({'frames': n, 'fps': fps, 'width': w, 'height': h, 'duration': n / fps},
          open(os.path.join(out, 'mask.json'), 'w'))
for f in ('mask.mp4', 'mask-rev.mp4', 'mask-ref.png'):
    print(f, os.path.getsize(os.path.join(out, f)) // 1024, 'KB')
