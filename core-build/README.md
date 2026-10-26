# Building the lockstep core

`ejs/data/cores/flycast-wasm.data` is [flycast-wasm](https://github.com/nasomers/flycast-wasm)
(Flycast + an SH4→WebAssembly JIT) rebuilt for online play. Lockstep netplay needs every
player's emulator to produce exactly the same game state from the same inputs, on fast and
slow machines alike. The stock v1.0 build doesn't: it decides when to compile code and how
many frames to run per tick from the wall clock. The changes:

- `deterministic_jit.py` (on `core/rec-wasm/rec_wasm.cpp`): the JIT keeps its batching and
  chains but makes every scheduling decision by count instead of elapsed time, and compiles
  chains synchronously so they go live on the same frame everywhere. Details in the script.
- `speed_patches.py` (on the source root): removes JavaScript round trips from the hot
  path. Compiled blocks were being called through Emscripten's JS exception trampolines
  (the dispatch loop got inlined into a try/catch), and their memory helpers through
  Asyncify's JS export wrappers; together ~40% of race time. Now plain wasm calls.
- `lockstep.py` (on `shell/libretro/libretro.cpp`): `fly_set_lockstep(1)` runs exactly one
  frame per `retro_run` with no wall-clock pacing (the page paces frames),
  `fly_state_hash()` hashes RAM, VRAM, sound RAM and the CPU registers for desync checks,
  and `fly_render_count()` counts emulated frames for the fps readout.
- `build-prod.sh`: adds those and `fly_jit_helper_ptrs` to `EXPORTED_FUNCTIONS`.

Verified: two instances, one CPU-throttled 3x, loaded the same state and ran 2,400 frames
of scripted input into a race with identical state hashes at every 60-frame checkpoint.
The stock core diverged within 60 frames under the same test. CPU time per frame (sandbox,
software rendering, same race): stock 31.2 ms, this build 30.5 ms; worst hitch 177 vs 75 ms.

## Recipe (Linux, Emscripten SDK 3.1.74)

```bash
R=/path/to/Rush-2049          # this repository
mkdir build && cd build
git clone https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install 3.1.74 && emsdk/emsdk activate 3.1.74
git clone https://github.com/nasomers/flycast-wasm.git
git clone --depth 1 --branch v1.22.2 https://github.com/EmulatorJS/RetroArch.git EJS-RetroArch
git clone https://github.com/flyinghead/flycast.git source
cd source && git checkout 2c48c01 && git submodule update --init --recursive
sed -i 's/\r$//' shell/libretro/audiostream.cpp
git apply ../flycast-wasm/patches/wasm-jit-phase1-modified.patch
mkdir -p core/rec-wasm
cp ../flycast-wasm/patches/{rec_wasm.cpp,wasm_emit.h,wasm_module_builder.h,fly_instrument.h} core/rec-wasm/
python3 $R/core-build/deterministic_jit.py core/rec-wasm/rec_wasm.cpp
python3 $R/core-build/speed_patches.py .
python3 $R/core-build/lockstep.py shell/libretro/libretro.cpp
cd .. && bash $R/core-build/build-all.sh     # output in out/
```

Then copy `out/flycast_libretro.js` and `out/flycast_libretro.wasm` to the repo root and run
`python3 tools/package-core.py` to produce `ejs/data/cores/flycast-wasm.data`.

`build-ejs-ra.sh` and the base of `build-prod.sh` come from
[LokiCode404's build recipe](https://github.com/nasomers/flycast-wasm/pull/4) for flycast-wasm.
License: GPLv2 (Flycast), see `LICENSE-flycast.txt`.
