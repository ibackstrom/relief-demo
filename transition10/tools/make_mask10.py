"""transition10's mask: alpha + the sand's real light + WHERE EACH BIT OF SAND CAME FROM.

  python tools/make_mask10.py path/to/clip.mov

Every version before this used the sand as a stencil: image 1 stood still and the sand only
covered or uncovered it, so the picture never travelled with the sand. This adds the sand's
motion, measured from the footage with optical flow and chained frame to frame into a single
field per frame: for every point, how far it is from where its sand was in the first frame.
The page samples image 1 at that origin, so the picture rides on the sand - lifting and bending
with the sheet, and carried off in the flying grains.

Each frame is 1920 x 2432, greyscale:
  rows    0-1079  COVERAGE    the clip's alpha, 1920 x 1080 (as transitions 3-9)
  rows 1080-2159  SAND LIGHT  the sand's filmed light, as transition9 (0.5 = average)
  rows 2160-2429  ORIGIN      480 x 270 each, x offset at columns 0-479, y offset at 480-959,
                              in 1920-pixel units, stored as 0.5 + sign * sqrt(|d| / RANGE) / 2
                              so small, slow movements keep their precision
"""
import json, os, subprocess, sys
import cv2
import numpy as np

src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(out, exist_ok=True)
W, H = 1920, 1080
FW, FH = 480, 270          # where the flow is measured (and stored)
SW, SH = 480, 270          # how it is stored
RANGE = 1920.0             # the largest offset that can be stored, in 1920-px units
STRIP = 272                # rows for the origin strip (keeps the height a multiple of 16)
CRF = os.environ.get('CRF', '30')
SIGMA = 9.0

# ---- trim from the alpha ------------------------------------------------------------------
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

gx, gy = np.meshgrid(np.arange(FW, dtype=np.float32), np.arange(FH, dtype=np.float32))
D = np.zeros((FH, FW, 2), np.float32)      # origin offset, in flow-grid pixels
prev_g = None
frames = []
maxd = 0.0
while True:
    buf = dec.stdout.read(W * H * 4)
    if len(buf) < W * H * 4:
        break
    f = np.frombuffer(buf, np.uint8).reshape(H, W, 4).astype(np.float32) / 255
    a = f[:, :, 3]
    lum_p = f[:, :, 0] * 0.299 + f[:, :, 1] * 0.587 + f[:, :, 2] * 0.114

    # ---- the sand's light (as transition9) ----
    lum = lum_p / np.maximum(a, 1e-3)
    num = cv2.GaussianBlur(lum * a, (0, 0), SIGMA)
    den = cv2.GaussianBlur(a, (0, 0), SIGMA)
    local = num / np.maximum(den, 1e-3)
    detail = np.clip(lum / np.maximum(local, 1e-3), 0.0, 2.0)
    detail = 1.0 + (detail - 1.0) * np.clip((a - 0.15) / 0.35, 0, 1)
    ab = cv2.GaussianBlur(a, (0, 0), 6)
    band = np.clip((ab - 0.01) / 0.08, 0, 1) * np.clip((0.985 - ab) / 0.06, 0, 1)
    light = 0.5 + (detail * 0.5 - 0.5) * band

    # ---- the motion: backward flow to the last frame, chained into an origin offset ----
    # measured on the BLURRED sand: the grains change from frame to frame (tracked, they gave
    # noise), the folds and clumps do not. A smooth wide-window flow (Farneback) follows those.
    g = cv2.GaussianBlur(cv2.resize(lum_p, (FW, FH), interpolation=cv2.INTER_AREA), (0, 0), 2.5)
    g = (np.clip(g, 0, 1) * 255).astype(np.uint8)
    if prev_g is not None:
        flow = cv2.calcOpticalFlowFarneback(g, prev_g, None, 0.5, 4, 31, 5, 7, 1.5, 0)   # now -> last
        Dprev = cv2.remap(D, gx + flow[:, :, 0], gy + flow[:, :, 1], cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        D = flow + Dprev
    prev_g = g
    Ds = D * (W / FW)                                       # -> 1920-px units
    maxd = max(maxd, float(np.abs(Ds).max()))
    enc = 0.5 + np.sign(Ds) * np.sqrt(np.clip(np.abs(Ds) / RANGE, 0, 1)) * 0.5

    frame = np.full((H * 2 + STRIP, W), 128, np.uint8)
    frame[:H] = (a * 255 + 0.5).astype(np.uint8)
    frame[H:2 * H] = (np.clip(light, 0, 1) * 255 + 0.5).astype(np.uint8)
    frame[2 * H:2 * H + SH, :SW] = (enc[:, :, 0] * 255 + 0.5).astype(np.uint8)
    frame[2 * H:2 * H + SH, SW:2 * SW] = (enc[:, :, 1] * 255 + 0.5).astype(np.uint8)
    frames.append(frame)
dec.wait()
print(len(frames), 'frames packed; largest origin offset', round(maxd), 'px')


def encode(seq, name):
    # a lighter deblocking filter than x264's default, which smooths exactly the grain we keep.
    # (-tune grain kept it sharper still, but doubled the file to 17 MB)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
                          '-s', f'{W}x{H * 2 + STRIP}', '-r', '25', '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryslow', '-crf', CRF,
                          '-x264-params', 'deblock=-1,-1', '-pix_fmt', 'yuv420p',
                          '-g', '25', '-an', '-movflags', '+faststart', os.path.join(out, name)],
                         stdin=subprocess.PIPE)
    for f in seq:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    print(name, os.path.getsize(os.path.join(out, name)) // 1024, 'KB')


encode(frames, 'mask10.mp4')
encode(frames[::-1], 'mask10-rev.mp4')
json.dump({'frames': len(frames), 'fps': 25, 'duration': len(frames) / 25, 'size': [W, H * 2 + STRIP],
           'origin': {'size': [SW, SH], 'range': RANGE}},
          open(os.path.join(out, 'mask10.json'), 'w'))
