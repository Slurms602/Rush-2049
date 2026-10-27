#!/usr/bin/env python3
"""Convert owner-supplied audio to native Sega Audio64 stereo PCM STR.

Requires FFmpeg. No original game stream is used to build the output.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import numpy as np

RATE = 44100
INTERLEAVE = 0x4000
# The game's selectable music streams. Redirect these only in the selected custom boot.
STREAMS = [n + '.STR' for n in ('BASSY','FLIER','GARAGE','HIDDEN','HIGH','MORNING',
    'NIGHT','NOON','ROBO','SPEED','STARSKY','STUNTED','SUNSET','THEROCK','TRANCEY',
    'VICE','WARRIOR','WINGEY')]


def encode_pcm(pcm):
    """Input: packed 44.1 kHz stereo signed little-endian PCM16."""
    if len(pcm) % 4 or not pcm:
        raise ValueError('Expected nonempty stereo PCM16 frames')
    samples = np.frombuffer(pcm, dtype='<i2').reshape(-1, 2)
    # Two lead-in blocks are required by the native stream buffering convention.
    samples = np.concatenate((np.zeros((INTERLEAVE, 2), dtype='<i2'), samples))
    frames = INTERLEAVE // 2
    blocks = (len(samples) + frames - 1) // frames
    padded = np.zeros((blocks * frames, 2), dtype='<i2')
    padded[:len(samples)] = samples
    header = bytearray(2048)
    struct.pack_into('<12I', header, 0, 1, RATE, 16, INTERLEAVE, blocks,
                     len(samples) * 4, 2, blocks, 0, 0, blocks, 0)
    label = b'Sega Stream - Rush 2049 custom soundtrack; stereo PCM16 / 44100 Hz'
    header[0xd5:0xd5+len(label)] = label
    payload = padded.reshape(blocks, frames, 2).transpose(0, 2, 1).tobytes()
    return bytes(header) + payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    args = parser.parse_args()
    pcm = subprocess.check_output([args.ffmpeg, '-v', 'error', '-i', str(args.source),
        '-vn', '-ar', str(RATE), '-ac', '2', '-c:a', 'pcm_s16le', '-f', 's16le', '-'])
    data = encode_pcm(pcm)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(data)
    metadata = dict(name='BASSY.STR', url=args.out.name, bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(), aliases=STREAMS[1:])
    args.out.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Native stereo soundtrack: {len(pcm)/4/RATE:.3f}s, {len(data)} bytes')

if __name__ == '__main__':
    main()
