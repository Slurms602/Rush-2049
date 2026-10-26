#!/usr/bin/env python3
"""Add lockstep-netplay exports to the patched flycast libretro.cpp (idempotent).

fly_set_lockstep(1): exactly one emu.render() per retro_run, no wall-clock pacing
  (the page decides when each frame runs).
fly_state_hash(): xxHash of main RAM, VRAM, sound RAM and the SH4 context, for
  cheap desync checks.
"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
if "fly_set_lockstep" in src:
    print("already applied")
    sys.exit(0)

anchor = "\t\tif (settings.input.fastForwardMode) {\n\t\t\tfly_frames_to_run = 1;"
assert src.count(anchor) == 1, "pacer anchor not found"
src = src.replace(anchor, "\t\tif (settings.input.fastForwardMode || fly_lockstep) {\n\t\t\tfly_frames_to_run = 1;")

include_anchor = '#include "hw/sh4/sh4_mem.h"\n'
assert src.count(include_anchor) == 1
src = src.replace(include_anchor, include_anchor + '''#ifdef __EMSCRIPTEN__
#include <xxhash.h>
#include "hw/pvr/pvr_mem.h"
#include "hw/aica/aica_if.h"
#include "hw/sh4/sh4_if.h"

// Lockstep netplay: when set, retro_run runs exactly one emu.render() and ignores
// the wall clock, so every machine advances identically per call.
static bool fly_lockstep = false;
extern "C" EMSCRIPTEN_KEEPALIVE void fly_set_lockstep(int on) { fly_lockstep = on != 0; }

// Desync check: hash of guest-visible memory and CPU state.
extern "C" EMSCRIPTEN_KEEPALIVE double fly_state_hash()
{
	XXH64_state_t* st = XXH64_createState();
	XXH64_reset(st, 0);
	XXH64_update(st, &mem_b[0], RAM_SIZE);
	XXH64_update(st, &vram[0], VRAM_SIZE);
	XXH64_update(st, &aica::aica_ram[0], ARAM_SIZE);
	// Guest registers only: jdyn onward holds dynarec/scheduler bookkeeping.
	const Sh4Context& c = p_sh4rcb->cntx;
	XXH64_update(st, &c, offsetof(Sh4Context, jdyn));
	XXH64_update(st, &c.sr, sizeof(c.sr));
	XXH64_update(st, &c.fpscr, sizeof(c.fpscr));
	u64 h = XXH64_digest(st);
	XXH64_freeState(st);
	return (double)(h >> 12);   // 52 bits survive the trip to JS exactly
}
#endif
''')
open(path, "w", encoding="utf-8").write(src)
print("applied")
