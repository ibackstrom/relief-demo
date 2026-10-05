"""Turn the sand clip (ProRes 4444 with alpha) into transition3's mask video.

  python tools/make_mask.py path/to/clip.mov [width]

The mask is the clip's own ALPHA and nothing else, at 1920 wide (area-scaled from 4K, so a
grain of sand is still a grain), with no smoothing across frames: the grains stay sharp and
move with the sand. Greyscale H.264 - the smallest of the codecs tried on this grain, and it
plays in every browser.

Writes assets/mask.mp4, assets/mask-rev.mp4 (backwards, for scrolling up), assets/mask.json.
The trim runs from just before the sheet starts to break to just after it is gone.
"""
import json, os, subprocess, sys
import numpy as np

src = sys.argv[1]
width = int(sys.argv[2]) if len(sys.argv) > 2 else 1920
height = round(width * 9 / 16 / 2) * 2
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(out, exist_ok=True)
CRF = os.environ.get('CRF', '28')

# the alpha, scaled once
dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf',
                      f'format=yuva444p,alphaextract,scale={width}:{height}:flags=area,format=gray',
                      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True, check=True)
A = np.frombuffer(dec.stdout, np.uint8).reshape(-1, height, width)
mean = A.reshape(len(A), -1).mean(1) / 255
start = max(0, int(np.argmax(mean < 0.995)) - 3)
gone = np.where(mean < 0.002)[0]
end = min(len(A) - 1, int(gone[gone > start][0]) + 3) if len(gone[gone > start]) else len(A) - 1
frames = A[start:end + 1]
print(f'{len(A)} frames; using {start}..{end} ({len(frames)} frames), {width}x{height}')


def encode(seq, name):
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
                          '-s', f'{width}x{height}', '-r', '25', '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryslow', '-crf', CRF, '-pix_fmt', 'yuv420p',
                          '-g', '25', '-an', '-movflags', '+faststart', os.path.join(out, name)],
                         stdin=subprocess.PIPE)
    for f in seq:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    print(name, os.path.getsize(os.path.join(out, name)) // 1024, 'KB')


encode(frames, 'mask.mp4')
encode(frames[::-1], 'mask-rev.mp4')
json.dump({'frames': len(frames), 'fps': 25, 'duration': len(frames) / 25, 'size': [width, height]},
          open(os.path.join(out, 'mask.json'), 'w'))
