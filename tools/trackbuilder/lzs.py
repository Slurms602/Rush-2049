# Rush 2049 (Dreamcast) .LZS: LZ77 with flag bytes (LSB first, 1 = literal byte); a
# reference is 2 bytes: length = (b0 & 15) + 2, distance back = b1 | (b0 >> 4) << 8.
import sys
def decode(src):
    out = bytearray(); i = 0; flags = 0
    while i < len(src):
        flags >>= 1
        if not flags & 0x100:
            flags = src[i] | 0xff00; i += 1
            if i >= len(src): break
        if flags & 1:
            out.append(src[i]); i += 1
        else:
            if i + 1 >= len(src): break
            b0, b1 = src[i], src[i + 1]; i += 2
            dist = b1 | (b0 >> 4) << 8; l = (b0 & 15) + 2
            if dist == 0: break   # end of stream
            for k in range(l): out.append(out[-dist] if dist <= len(out) else 0)
    return bytes(out)
def encode(data, max_chain=2048):
    """Compress to the same format: hash-chain match search (distance 1..4095, length 2..17) with
    lazy matching (a match is deferred if the next byte starts a longer one), ending with a
    distance-0 reference like the game's files. Output is slightly smaller than the originals."""
    n = len(data); head = {}; prev = [-1] * n
    def insert(k):
        if k + 1 < n:
            h = data[k] | data[k + 1] << 8
            prev[k] = head.get(h, -1); head[h] = k
    def longest(i):
        best_len = best_dist = 0
        if i + 1 >= n: return 0, 0
        j = head.get(data[i] | data[i + 1] << 8, -1); chain = 0; limit = min(17, n - i)
        while j >= 0 and i - j <= 4095 and chain < max_chain:
            if data[j + best_len] == data[i + best_len] if best_len < limit else False:
                l = 0
                while l < limit and data[j + l] == data[i + l]: l += 1
                if l > best_len:
                    best_len, best_dist = l, i - j
                    if l == limit: break
            j = prev[j]; chain += 1
        return best_len, best_dist
    out = bytearray(); flag_pos = -1; bit = 8
    def put(is_lit, payload):
        nonlocal flag_pos, bit
        if bit == 8:
            flag_pos = len(out); out.append(0); bit = 0
        if is_lit: out[flag_pos] |= 1 << bit
        bit += 1
        out.extend(payload)
    i = 0
    cur = None
    while i < n:
        if cur is None: cur = longest(i)
        l, dist = cur
        if l >= 2:
            insert(i)
            nxt = longest(i + 1) if i + 1 < n else (0, 0)
            if nxt[0] > l:                      # a longer match starts at the next byte
                put(True, data[i:i + 1]); i += 1; cur = nxt; continue
            put(False, bytes([(dist >> 8) << 4 | (l - 2), dist & 0xff]))
            for k in range(i + 1, i + l): insert(k)
            i += l
        else:
            put(True, data[i:i + 1]); insert(i); i += 1
        cur = None
    put(False, b"\0\0")
    return bytes(out)

if __name__ == "__main__":
    for path in sys.argv[1:]:
        d = decode(open(path, "rb").read())
        open(path[:-4] + ".bin", "wb").write(d)
        print(path, len(d))
