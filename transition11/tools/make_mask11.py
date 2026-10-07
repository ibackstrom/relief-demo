"""transition11's mask: the sand clip itself at the edge - its alpha AS FILMED and its colour.

  python tools/make_mask11.py path/to/clip.mov

Each frame is 1920 x 2160, colour:
  top    1920 x 1080  ALPHA - the clip's transparency, area-scaled from 4K, grey
  bottom 1920 x 1080  SAND  - the sand's own colour (un-premultiplied), only where the sheet is
                      breaking or flying; inside the intact sheet and in empty space it is the
                      sand's average colour, which costs no bits and which the page ignores
mean_sand (written to mask11.json) is that average colour, so the page can read each grain's
brightness against it.
"""
import json, os, subprocess, sys
import cv2
import numpy as np

src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(out, exist_ok=True)
W, H = 1920, 1080
CRF = os.environ.get('CRF', '30')

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
mean_sand = None
while True:
    buf = dec.stdout.read(W * H * 4)
    if len(buf) < W * H * 4:
        break
    f = np.frombuffer(buf, np.uint8).reshape(H, W, 4).astype(np.float32) / 255
    a = f[:, :, 3]
    rgb = f[:, :, :3] / np.maximum(a, 1e-3)[:, :, None]          # the sand's own colour
    rgb = np.clip(rgb, 0, 1)
    if mean_sand is None:                                        # the intact sheet, first frame
        solid = a > 0.98
        mean_sand = rgb[solid].mean(0)
    # kept where the sheet is breaking or the sand is flying; flat elsewhere
    ab = cv2.GaussianBlur(a, (0, 0), 6)
    keep = (ab > 0.002) & (ab < 0.985) & (a > 0.01)
    sand = np.where(keep[:, :, None], rgb, mean_sand[None, None, :])
    frame = np.empty((H * 2, W, 3), np.uint8)
    frame[:H] = (a[:, :, None] * 255 + 0.5).astype(np.uint8)
    frame[H:] = (sand * 255 + 0.5).astype(np.uint8)
    frames.append(frame)
dec.wait()
print(len(frames), 'frames; mean sand colour', mean_sand.round(3))


def encode(seq, name):
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                          '-s', f'{W}x{H * 2}', '-r', '25', '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryslow', '-crf', CRF,
                          '-x264-params', 'deblock=-1,-1', '-pix_fmt', 'yuv420p',
                          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                          '-g', '25', '-an', '-movflags', '+faststart', os.path.join(out, name)],
                         stdin=subprocess.PIPE)
    for f in seq:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    print(name, os.path.getsize(os.path.join(out, name)) // 1024, 'KB')


encode(frames, 'mask11.mp4')
encode(frames[::-1], 'mask11-rev.mp4')
json.dump({'frames': len(frames), 'fps': 25, 'duration': len(frames) / 25, 'size': [W, H * 2],
           'mean_sand': [round(float(x), 4) for x in mean_sand]},
          open(os.path.join(out, 'mask11.json'), 'w'))
