"""transition11 (rev 4)'s mask: the sand clip's alpha ONLY, sharp, tightly trimmed.

  python tools/make_mask11.py path/to/clip.mov [width]

  - 2560 wide by default (area-scaled from the 4K master), so a grain is still a grain on large
    and high-density screens - at 1920 it was stretched there and read as soap
  - no sand light, no colour: the client found the light layer read as noise
  - trimmed to the motion: from the first frame where the sheet visibly breaks to the first where
    almost nothing is left - the still frames at either end read as a pause / freeze
Greyscale H.264 (crf 26), forwards and backwards.
"""
import json, os, subprocess, sys
import numpy as np

src = sys.argv[1]
W = int(sys.argv[2]) if len(sys.argv) > 2 else 2560
H = round(W * 9 / 16 / 2) * 2
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(out, exist_ok=True)
CRF = os.environ.get('CRF', '26')

dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf',
                      f'format=yuva444p,alphaextract,scale={W}:{H}:flags=area,format=gray',
                      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True, check=True)
A = np.frombuffer(dec.stdout, np.uint8).reshape(-1, H, W)
mean = A.reshape(len(A), -1).mean(1) / 255
start = int(np.argmax(mean < 0.998))                     # the sheet starts to break
gone = np.where(mean < 0.01)[0]
end = int(gone[gone > start][0]) + 1 if len(gone[gone > start]) else len(A) - 1
frames = A[start:end + 1]
print(f'{len(A)} frames; using {start}..{end} ({len(frames)} frames, {len(frames) / 25:.2f} s), {W}x{H}')


def encode(seq, name):
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
                          '-s', f'{W}x{H}', '-r', '25', '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryslow', '-crf', CRF,
                          '-x264-params', 'deblock=-1,-1', '-pix_fmt', 'yuv420p',
                          '-g', '25', '-an', '-movflags', '+faststart', os.path.join(out, name)],
                         stdin=subprocess.PIPE)
    for f in seq:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    print(name, os.path.getsize(os.path.join(out, name)) // 1024, 'KB')


encode(frames, 'mask11.mp4')
encode(frames[::-1], 'mask11-rev.mp4')
json.dump({'frames': len(frames), 'fps': 25, 'duration': len(frames) / 25, 'size': [W, H], 'trim': [start, end]},
          open(os.path.join(out, 'mask11.json'), 'w'))
