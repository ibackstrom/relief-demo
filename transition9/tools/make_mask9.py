"""transition9's mask: the sand clip's ALPHA plus the sand's own LIGHT, packed in one video.

  python tools/make_mask9.py path/to/clip.mov

Each frame is 1920 x 2160, greyscale:
  top    1920 x 1080  COVERAGE - the clip's alpha, area-scaled from 4K (as transition3-8)
  bottom 1920 x 1080  SAND LIGHT - the real sand's brightness against its own local average
                      (0.5 = average): the light and shade of each grain and clump as it was
                      filmed. Large-scale waves are divided out (that read as caustics), and it
                      is kept only in the band where the sheet is breaking - inside the intact
                      sheet and in empty space it is flat 0.5, which also costs no bits.
"""
import json, os, subprocess, sys
import cv2
import numpy as np

src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(out, exist_ok=True)
W4, H4 = 3840, 2160
W, H = 1920, 1080
CRF = os.environ.get('CRF', '28')
SIGMA = float(os.environ.get('SIGMA', '9'))      # px at 1920: the scale divided out

# trim from the alpha, as transition3
dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf',
                      f'format=yuva444p,alphaextract,scale={W // 8}:{H // 8}:flags=area,format=gray',
                      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True, check=True)
small = np.frombuffer(dec.stdout, np.uint8).reshape(-1, H // 8, W // 8)
mean = small.reshape(len(small), -1).mean(1) / 255
start = max(0, int(np.argmax(mean < 0.995)) - 3)
gone = np.where(mean < 0.005)[0]
end = min(len(small) - 1, int(gone[gone > start][0]) + 3) if len(gone[gone > start]) else len(small) - 1
print(f'{len(small)} frames; using {start}..{end}')

dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', src, '-vf',
                        f"select='between(n\\,{start}\\,{end})',premultiply=inplace=1,scale={W}:{H}:flags=area",
                        '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                       stdout=subprocess.PIPE, bufsize=W * H * 4)
frames = []
while True:
    buf = dec.stdout.read(W * H * 4)
    if len(buf) < W * H * 4:
        break
    f = np.frombuffer(buf, np.uint8).reshape(H, W, 4).astype(np.float32) / 255
    a = f[:, :, 3]
    # premultiplied before the scale (so the black round each grain does not bleed into it),
    # divided back out here: the brightness of the sand itself
    lum_p = f[:, :, 0] * 0.299 + f[:, :, 1] * 0.587 + f[:, :, 2] * 0.114
    lum = lum_p / np.maximum(a, 1e-3)
    # the sand's brightness against its local average, both weighted by how much sand there is,
    # so empty space neither lights nor darkens what is next to it
    num = cv2.GaussianBlur(lum * a, (0, 0), SIGMA)
    den = cv2.GaussianBlur(a, (0, 0), SIGMA)
    local = num / np.maximum(den, 1e-3)
    detail = np.clip(lum / np.maximum(local, 1e-3), 0.0, 2.0)
    # only where there is enough sand to have a light of its own; gaps between grains are
    # neutral, or they would read as dark sand and ring every grain with a halo
    detail = 1.0 + (detail - 1.0) * np.clip((a - 0.15) / 0.35, 0, 1)
    # only where the sheet is breaking: not inside it, not in empty space
    ab = cv2.GaussianBlur(a, (0, 0), 6)
    band = np.clip((ab - 0.01) / 0.08, 0, 1) * np.clip((0.985 - ab) / 0.06, 0, 1)
    light = 0.5 + (detail * 0.5 - 0.5) * band
    frame = np.empty((H * 2, W), np.uint8)
    frame[:H] = (a * 255 + 0.5).astype(np.uint8)
    frame[H:] = (np.clip(light, 0, 1) * 255 + 0.5).astype(np.uint8)
    frames.append(frame)
dec.wait()
print(len(frames), 'frames packed')


def encode(seq, name):
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
                          '-s', f'{W}x{H * 2}', '-r', '25', '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryslow', '-crf', CRF, '-pix_fmt', 'yuv420p',
                          '-g', '25', '-an', '-movflags', '+faststart', os.path.join(out, name)],
                         stdin=subprocess.PIPE)
    for f in seq:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    print(name, os.path.getsize(os.path.join(out, name)) // 1024, 'KB')


encode(frames, 'mask9.mp4')
encode(frames[::-1], 'mask9-rev.mp4')
json.dump({'frames': len(frames), 'fps': 25, 'duration': len(frames) / 25, 'size': [W, H * 2]},
          open(os.path.join(out, 'mask9.json'), 'w'))
