#!/bin/bash
# Full core build: EJS RetroArch objects + flycast (LLVM bitcode, -flto link).
# Run from the folder holding source/ (patched flycast), EJS-RetroArch/ and emsdk/
# (or set the variables below). Output: out/flycast_libretro.js + .wasm
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ROOT:-$(pwd)}"
FLYCAST_WASM="${FLYCAST_WASM:-$ROOT/flycast-wasm}"   # clone of nasomers/flycast-wasm (build/ stubs)
source "${EMSDK:-$ROOT/emsdk}/emsdk_env.sh" > /dev/null
export EMCC_CFLAGS="-flto"
export JOBS="${JOBS:-$(nproc)}"
export EJS_RA="$ROOT/EJS-RetroArch"
export SOURCE_DIR="$ROOT/source"
export BUILD_DIR="$ROOT/source/build-wasm-prod"
export STUBS="$FLYCAST_WASM/build/flycast_stubs.o"
export GL_OVERRIDE="$FLYCAST_WASM/build/gl_override.js"
export OUT_DIR="$ROOT/out"
if [ ! -f "$EJS_RA/obj-emscripten/retroarch.o" ]; then bash "$HERE/build-ejs-ra.sh"; fi
bash "$HERE/build-prod.sh"
echo BUILD-ALL-DONE
