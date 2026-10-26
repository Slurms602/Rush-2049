/*
 * Read-only libzip subset for the flycast-wasm core.
 *
 * The v1.0 core was linked without libzip, so every zip_* call hit an Emscripten
 * "missing function" stub and aborted. Flycast keeps its HLE BIOS font and default
 * flash images in zip archives embedded in the binary, so the HLE BIOS couldn't
 * start. package-core.py prepends this file to the core's JS and routes the stubs
 * here. Only the calls core/archive/ZipArchive.cpp makes are implemented, for
 * in-memory archives with stored or deflated entries.
 *
 * Inflate: tiny-inflate 1.0.3, (c) Devon Govett, MIT license.
 */
var DCLibzip = (function () {
  var TINF_OK = 0;
  var TINF_DATA_ERROR = -3;
  
  function Tree() {
    this.table = new Uint16Array(16);   /* table of code length counts */
    this.trans = new Uint16Array(288);  /* code -> symbol translation table */
  }
  
  function Data(source, dest) {
    this.source = source;
    this.sourceIndex = 0;
    this.tag = 0;
    this.bitcount = 0;
    
    this.dest = dest;
    this.destLen = 0;
    
    this.ltree = new Tree();  /* dynamic length/symbol tree */
    this.dtree = new Tree();  /* dynamic distance tree */
  }
  
  /* --------------------------------------------------- *
   * -- uninitialized global data (static structures) -- *
   * --------------------------------------------------- */
  
  var sltree = new Tree();
  var sdtree = new Tree();
  
  /* extra bits and base tables for length codes */
  var length_bits = new Uint8Array(30);
  var length_base = new Uint16Array(30);
  
  /* extra bits and base tables for distance codes */
  var dist_bits = new Uint8Array(30);
  var dist_base = new Uint16Array(30);
  
  /* special ordering of code length codes */
  var clcidx = new Uint8Array([
    16, 17, 18, 0, 8, 7, 9, 6,
    10, 5, 11, 4, 12, 3, 13, 2,
    14, 1, 15
  ]);
  
  /* used by tinf_decode_trees, avoids allocations every call */
  var code_tree = new Tree();
  var lengths = new Uint8Array(288 + 32);
  
  /* ----------------------- *
   * -- utility functions -- *
   * ----------------------- */
  
  /* build extra bits and base tables */
  function tinf_build_bits_base(bits, base, delta, first) {
    var i, sum;
  
    /* build bits table */
    for (i = 0; i < delta; ++i) bits[i] = 0;
    for (i = 0; i < 30 - delta; ++i) bits[i + delta] = i / delta | 0;
  
    /* build base table */
    for (sum = first, i = 0; i < 30; ++i) {
      base[i] = sum;
      sum += 1 << bits[i];
    }
  }
  
  /* build the fixed huffman trees */
  function tinf_build_fixed_trees(lt, dt) {
    var i;
  
    /* build fixed length tree */
    for (i = 0; i < 7; ++i) lt.table[i] = 0;
  
    lt.table[7] = 24;
    lt.table[8] = 152;
    lt.table[9] = 112;
  
    for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
    for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
    for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
    for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;
  
    /* build fixed distance tree */
    for (i = 0; i < 5; ++i) dt.table[i] = 0;
  
    dt.table[5] = 32;
  
    for (i = 0; i < 32; ++i) dt.trans[i] = i;
  }
  
  /* given an array of code lengths, build a tree */
  var offs = new Uint16Array(16);
  
  function tinf_build_tree(t, lengths, off, num) {
    var i, sum;
  
    /* clear code length count table */
    for (i = 0; i < 16; ++i) t.table[i] = 0;
  
    /* scan symbol lengths, and sum code length counts */
    for (i = 0; i < num; ++i) t.table[lengths[off + i]]++;
  
    t.table[0] = 0;
  
    /* compute offset table for distribution sort */
    for (sum = 0, i = 0; i < 16; ++i) {
      offs[i] = sum;
      sum += t.table[i];
    }
  
    /* create code->symbol translation table (symbols sorted by code) */
    for (i = 0; i < num; ++i) {
      if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
    }
  }
  
  /* ---------------------- *
   * -- decode functions -- *
   * ---------------------- */
  
  /* get one bit from source stream */
  function tinf_getbit(d) {
    /* check if tag is empty */
    if (!d.bitcount--) {
      /* load next tag */
      d.tag = d.source[d.sourceIndex++];
      d.bitcount = 7;
    }
  
    /* shift bit out of tag */
    var bit = d.tag & 1;
    d.tag >>>= 1;
  
    return bit;
  }
  
  /* read a num bit value from a stream and add base */
  function tinf_read_bits(d, num, base) {
    if (!num)
      return base;
  
    while (d.bitcount < 24) {
      d.tag |= d.source[d.sourceIndex++] << d.bitcount;
      d.bitcount += 8;
    }
  
    var val = d.tag & (0xffff >>> (16 - num));
    d.tag >>>= num;
    d.bitcount -= num;
    return val + base;
  }
  
  /* given a data stream and a tree, decode a symbol */
  function tinf_decode_symbol(d, t) {
    while (d.bitcount < 24) {
      d.tag |= d.source[d.sourceIndex++] << d.bitcount;
      d.bitcount += 8;
    }
    
    var sum = 0, cur = 0, len = 0;
    var tag = d.tag;
  
    /* get more bits while code value is above sum */
    do {
      cur = 2 * cur + (tag & 1);
      tag >>>= 1;
      ++len;
  
      sum += t.table[len];
      cur -= t.table[len];
    } while (cur >= 0);
    
    d.tag = tag;
    d.bitcount -= len;
  
    return t.trans[sum + cur];
  }
  
  /* given a data stream, decode dynamic trees from it */
  function tinf_decode_trees(d, lt, dt) {
    var hlit, hdist, hclen;
    var i, num, length;
  
    /* get 5 bits HLIT (257-286) */
    hlit = tinf_read_bits(d, 5, 257);
  
    /* get 5 bits HDIST (1-32) */
    hdist = tinf_read_bits(d, 5, 1);
  
    /* get 4 bits HCLEN (4-19) */
    hclen = tinf_read_bits(d, 4, 4);
  
    for (i = 0; i < 19; ++i) lengths[i] = 0;
  
    /* read code lengths for code length alphabet */
    for (i = 0; i < hclen; ++i) {
      /* get 3 bits code length (0-7) */
      var clen = tinf_read_bits(d, 3, 0);
      lengths[clcidx[i]] = clen;
    }
  
    /* build code length tree */
    tinf_build_tree(code_tree, lengths, 0, 19);
  
    /* decode code lengths for the dynamic trees */
    for (num = 0; num < hlit + hdist;) {
      var sym = tinf_decode_symbol(d, code_tree);
  
      switch (sym) {
        case 16:
          /* copy previous code length 3-6 times (read 2 bits) */
          var prev = lengths[num - 1];
          for (length = tinf_read_bits(d, 2, 3); length; --length) {
            lengths[num++] = prev;
          }
          break;
        case 17:
          /* repeat code length 0 for 3-10 times (read 3 bits) */
          for (length = tinf_read_bits(d, 3, 3); length; --length) {
            lengths[num++] = 0;
          }
          break;
        case 18:
          /* repeat code length 0 for 11-138 times (read 7 bits) */
          for (length = tinf_read_bits(d, 7, 11); length; --length) {
            lengths[num++] = 0;
          }
          break;
        default:
          /* values 0-15 represent the actual code lengths */
          lengths[num++] = sym;
          break;
      }
    }
  
    /* build dynamic trees */
    tinf_build_tree(lt, lengths, 0, hlit);
    tinf_build_tree(dt, lengths, hlit, hdist);
  }
  
  /* ----------------------------- *
   * -- block inflate functions -- *
   * ----------------------------- */
  
  /* given a stream and two trees, inflate a block of data */
  function tinf_inflate_block_data(d, lt, dt) {
    while (1) {
      var sym = tinf_decode_symbol(d, lt);
  
      /* check for end of block */
      if (sym === 256) {
        return TINF_OK;
      }
  
      if (sym < 256) {
        d.dest[d.destLen++] = sym;
      } else {
        var length, dist, offs;
        var i;
  
        sym -= 257;
  
        /* possibly get more bits from length code */
        length = tinf_read_bits(d, length_bits[sym], length_base[sym]);
  
        dist = tinf_decode_symbol(d, dt);
  
        /* possibly get more bits from distance code */
        offs = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);
  
        /* copy match */
        for (i = offs; i < offs + length; ++i) {
          d.dest[d.destLen++] = d.dest[i];
        }
      }
    }
  }
  
  /* inflate an uncompressed block of data */
  function tinf_inflate_uncompressed_block(d) {
    var length, invlength;
    var i;
    
    /* unread from bitbuffer */
    while (d.bitcount > 8) {
      d.sourceIndex--;
      d.bitcount -= 8;
    }
  
    /* get length */
    length = d.source[d.sourceIndex + 1];
    length = 256 * length + d.source[d.sourceIndex];
  
    /* get one's complement of length */
    invlength = d.source[d.sourceIndex + 3];
    invlength = 256 * invlength + d.source[d.sourceIndex + 2];
  
    /* check length */
    if (length !== (~invlength & 0x0000ffff))
      return TINF_DATA_ERROR;
  
    d.sourceIndex += 4;
  
    /* copy block */
    for (i = length; i; --i)
      d.dest[d.destLen++] = d.source[d.sourceIndex++];
  
    /* make sure we start next block on a byte boundary */
    d.bitcount = 0;
  
    return TINF_OK;
  }
  
  /* inflate stream from source to dest */
  function tinf_uncompress(source, dest) {
    var d = new Data(source, dest);
    var bfinal, btype, res;
  
    do {
      /* read final block flag */
      bfinal = tinf_getbit(d);
  
      /* read block type (2 bits) */
      btype = tinf_read_bits(d, 2, 0);
  
      /* decompress block */
      switch (btype) {
        case 0:
          /* decompress uncompressed block */
          res = tinf_inflate_uncompressed_block(d);
          break;
        case 1:
          /* decompress block with fixed huffman trees */
          res = tinf_inflate_block_data(d, sltree, sdtree);
          break;
        case 2:
          /* decompress block with dynamic huffman trees */
          tinf_decode_trees(d, d.ltree, d.dtree);
          res = tinf_inflate_block_data(d, d.ltree, d.dtree);
          break;
        default:
          res = TINF_DATA_ERROR;
      }
  
      if (res !== TINF_OK)
        throw new Error('Data error');
  
    } while (!bfinal);
  
    if (d.destLen < d.dest.length) {
      if (typeof d.dest.slice === 'function')
        return d.dest.slice(0, d.destLen);
      else
        return d.dest.subarray(0, d.destLen);
    }
    
    return d.dest;
  }
  
  /* -------------------- *
   * -- initialization -- *
   * -------------------- */
  
  /* build fixed huffman trees */
  tinf_build_fixed_trees(sltree, sdtree);
  
  /* build extra bits and base tables */
  tinf_build_bits_base(length_bits, length_base, 4, 3);
  tinf_build_bits_base(dist_bits, dist_base, 2, 1);
  
  /* fix a special case */
  length_bits[28] = 0;
  length_base[28] = 258;
  

  // Called from inside the core's module scope. heap() returns the current HEAPU8
  // (it's replaced when memory grows), malloc() is the core's allocator.
  function create(heap, malloc) {
    const handles = new Map();
    let nextHandle = 1;
    const put = (obj) => { handles.set(nextHandle, obj); return nextHandle++; };
    const cstr = (ptr) => {
      const h = heap();
      let end = ptr;
      while (h[end]) end++;
      return new TextDecoder().decode(h.subarray(ptr, end));
    };

    // Archive = its bytes plus the central directory entries.
    function parse(bytes) {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let eocd = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        // Accept an end record only if its central directory offset really points at one.
        if (v.getUint32(i, true) === 0x06054b50) {
          const cd = v.getUint32(i + 16, true);
          if (cd + 4 <= bytes.length && v.getUint32(cd, true) === 0x02014b50) { eocd = i; break; }
        }
      }
      if (eocd < 0) return null;
      const entries = [];
      let p = v.getUint32(eocd + 16, true);
      for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
        if (v.getUint32(p, true) !== 0x02014b50) return null;
        const nameLen = v.getUint16(p + 28, true);
        entries.push({
          method: v.getUint16(p + 10, true),
          crc: v.getUint32(p + 16, true),
          compSize: v.getUint32(p + 20, true),
          size: v.getUint32(p + 24, true),
          localHeader: v.getUint32(p + 42, true),
          name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)),
          namePtr: 0,
          data: null
        });
        p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
      }
      return { bytes, entries };
    }

    function contents(zip, e) {
      if (!e.data) {
        const v = new DataView(zip.bytes.buffer, zip.bytes.byteOffset, zip.bytes.byteLength);
        const start = e.localHeader + 30 + v.getUint16(e.localHeader + 26, true) + v.getUint16(e.localHeader + 28, true);
        const raw = zip.bytes.subarray(start, start + e.compSize);
        if (e.method === 0) e.data = raw.slice();
        else if (e.method === 8) e.data = tinf_uncompress(raw, new Uint8Array(e.size));
        else return null;
      }
      return e.data;
    }

    // struct zip_stat on wasm32 with 64-bit time_t: valid@0 name@8 index@16 size@24
    // comp_size@32 mtime@40 crc@48 comp_method@52 encryption_method@54 flags@56, 64 bytes.
    function writeStat(zip, index, sb) {
      const e = zip.entries[index];
      if (!e.namePtr) {
        const name = new TextEncoder().encode(e.name);
        e.namePtr = malloc(name.length + 1);
        heap().set(name, e.namePtr);
        heap()[e.namePtr + name.length] = 0;
      }
      heap().fill(0, sb, sb + 64);
      const v = new DataView(heap().buffer);
      v.setBigUint64(sb, 0x6fn, true);  // NAME | INDEX | SIZE | COMP_SIZE | CRC | COMP_METHOD
      v.setUint32(sb + 8, e.namePtr, true);
      v.setBigUint64(sb + 16, BigInt(index), true);
      v.setBigUint64(sb + 24, BigInt(e.size), true);
      v.setBigUint64(sb + 32, BigInt(e.compSize), true);
      v.setUint32(sb + 48, e.crc, true);
      v.setUint16(sb + 52, e.method, true);
      return 0;
    }

    const archive = (h) => handles.get(h).zip;
    const indexOf = (zip, namePtr) => zip.entries.findIndex(e => e.name === cstr(namePtr));
    const open = (zip, i) => {
      const data = i >= 0 && i < zip.entries.length ? contents(zip, zip.entries[i]) : null;
      return data ? put({ data, pos: 0 }) : 0;
    };

    return {
      source_buffer_create: (data, len) => put({ src: heap().slice(data, data + Number(len)) }),
      source_filep_create: () => 0,  // on-disk zips aren't needed: EmulatorJS extracts them first
      source_free: (h) => { handles.delete(h); },
      open_from_source: (h) => {
        const src = handles.get(h);
        const zip = src && src.src && parse(src.src);
        if (!zip) return 0;
        handles.delete(h);  // libzip: the archive takes ownership of the source on success
        return put({ zip });
      },
      close: (h) => { handles.delete(h); return 0; },
      get_num_entries: (h) => BigInt(archive(h).entries.length),
      stat_index: (h, index, flags, sb) => {
        const zip = archive(h), i = Number(index);
        return i < zip.entries.length ? writeStat(zip, i, sb) : -1;
      },
      stat: (h, name, flags, sb) => {
        const zip = archive(h), i = indexOf(zip, name);
        return i >= 0 ? writeStat(zip, i, sb) : -1;
      },
      fopen_index: (h, index) => open(archive(h), Number(index)),
      fopen: (h, name) => open(archive(h), indexOf(archive(h), name)),
      fread: (h, buf, n) => {
        const f = handles.get(h);
        const count = Math.min(Number(n), f.data.length - f.pos);
        heap().set(f.data.subarray(f.pos, f.pos + count), buf);
        f.pos += count;
        return BigInt(count);
      },
      fclose: (h) => { handles.delete(h); return 0; }
    };
  }

  return { create };
})();
